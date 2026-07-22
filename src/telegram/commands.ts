import type { Bot, Context } from 'grammy';
import type { Logger } from 'pino';

import type { ChatId, ChatToken, MediaKind, Mint, Signature, Wallet } from '../core/types.js';
import { TIERS, isTierName, type TierName } from '../core/tiers.js';
import { symbol as displaySymbol } from '../render/format.js';
import type { Repo } from '../db/index.js';
import type { MediaPool } from '../media/index.js';
import { renderCard } from '../render/card.js';
import { requireDmOwner, requireGroupAdmin } from './admin.js';
import { capsOf, gate as capGate, gateMints, planOf } from './plan-gate.js';
import { capabilities, isPlan, UPSELL } from '../core/plans.js';
import { effective } from './plan-gate.js';
import { DEFAULT_LINKS } from '../core/links.js';
import { mediaStatsMessage, settingsMessage, floorsSentence, whaleSentence } from './settings.js';
import { PROMPTS, Wizards, type WizardState } from './wizard.js';
import type { Sender } from './sender.js';
import {
  validateFloors,
  validateInt,
  validateMintFormat,
  validateMintOnChain,
  validateUsd,
  type ChainCheck,
} from './validate.js';

export interface CommandDeps {
  readonly repo: Repo;
  /** Owner-only commands (/grant). Without it, nobody can change a plan from Telegram. */
  readonly ownerUserId?: number | undefined;
  readonly media: MediaPool;
  readonly sender: Sender;
  readonly log: Logger;
  readonly chain: ChainCheck;
  /** Subscribe/unsubscribe the live ingestor. A new mint must start streaming with no restart. */
  readonly subscribe: (mint: Mint) => Promise<void>;
  readonly unsubscribe: (mint: Mint) => Promise<void>;
  /** What the ingestor is subscribed to RIGHT NOW. Diffed against the DB, never assumed. */
  readonly currentMints: () => readonly Mint[];
  readonly wizards?: Wizards;
}

/** The keyboard labels a group may set, and what they are called on the card. */
const LINK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  dext: 'DexT',
  screener: 'Screener',
  buy: 'Buy',
  ricedao: 'RiceDAO',
  onegrain: '1 Grain of Rice',
  trending: 'Trending',
});

/** Which media message a user is currently being asked for (/setmedia). */
const awaitingMedia = new Map<string, { chatId: ChatId; mint: Mint }>();

/**
 * WHICH GROUP A DM COMMAND APPLIES TO.
 *
 * Every config command resolved its target as `ctx.chat.id` — which in a DM is the user's PRIVATE
 * chat with the bot, not a group. So `/setmin 25` in a DM looked for a chat_token on the DM
 * itself, found none, and replied "I'm not tracking a token here yet." There was a gate for DM
 * configuration and no way to ADDRESS a group: the whole path was dead.
 *
 * `/use` picks the group; everything afterwards applies to it. Per user, in memory — a
 * conversation, not a setting, so it does not survive a restart and should not.
 */
const dmTarget = new Map<number, ChatId>();

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  const { repo, media, log } = deps;
  const wizards = deps.wizards ?? new Wizards();

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  const chatIdOf = (ctx: Context): ChatId => ctx.chat?.id as ChatId;

  /**
   * The chat a command acts on: the group you are standing in, or — in a DM — the one you picked
   * with /use. Null in a DM with nothing picked.
   */
  const targetOf = (ctx: Context): ChatId | null => {
    if (isGroup(ctx)) return chatIdOf(ctx);
    return dmTarget.get(userIdOf(ctx)) ?? null;
  };
  const userIdOf = (ctx: Context): number => ctx.from?.id ?? 0;
  const isGroup = (ctx: Context): boolean => ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

  /**
   * INVARIANT 8. The gate, re-checked against the Bot API on EVERY mutating command.
   *
   * There is exactly one of these and every mutating handler goes through it. A second
   * gate is a second thing to forget to call.
   */
  async function gate(ctx: Context): Promise<boolean> {
    const userId = userIdOf(ctx);
    await ensureChat(ctx);

    const target = targetOf(ctx);
    if (target === null) {
      await ctx.reply('Which group? Send /use to pick one.');
      return false;
    }

    // INVARIANT 8, in both places. In a DM we check admin status of the TARGET group — asked
    // now, never cached — which is strictly stronger than the old `added_by` check: it survives
    // the group changing hands, and it dies the moment somebody is demoted.
    const verdict = await requireGroupAdmin(bot.api, target, userId);

    if (!verdict.ok) {
      await ctx.reply(verdict.why);
      return false;
    }
    return true;
  }

  /**
   * Make sure the `chats` row exists for the group we are standing in.
   *
   * The row is normally created by `my_chat_member` when the bot is ADDED. But that update is
   * only delivered if the bot is RUNNING at the time — and `bot.start({drop_pending_updates:
   * true})` throws away anything queued while it was down. Add the bot to a group while the
   * process is restarting (or crash-looping, or being deployed) and it comes up already in the
   * group with no memory of having joined.
   *
   * Every downstream write has a foreign key to `chats`, so the result was /setup dying with
   * "FOREIGN KEY constraint failed" halfway through, having already replied "Checking that
   * token on-chain…" — a silent hang from the user's point of view.
   *
   * So: never ASSUME the row. Ensure it, on every command, in the one place every command
   * already goes through.
   */
  async function ensureChat(ctx: Context): Promise<void> {
    if (!isGroup(ctx)) return;
    const chatId = chatIdOf(ctx);
    if (await repo.getChat(chatId)) return;

    await repo.upsertChat({
      chatId,
      title: ctx.chat?.title ?? null,
      // We did not see them add us, so we do not know who did. `added_by` gates DM config, and
      // guessing "whoever typed a command first" would be an invented fact about who owns this
      // group. Null is the honest answer.
      addedBy: null,
      paused: false,
    });
    log.info({ chatId }, 'created a chats row on first command — we never saw the join');
  }

  /** The token this chat is configured for. Null (with a nudge) when there isn't one. */
  async function currentToken(ctx: Context): Promise<ChatToken | null> {
    await ensureChat(ctx);

    const target = targetOf(ctx);
    if (target === null) {
      await ctx.reply('Which group? Send /use to pick one.');
      return null;
    }

    const tokens = await repo.listChatTokens(target);
    const ct = tokens[0] ?? null;
    if (!ct) await ctx.reply("I'm not tracking a token there yet. Run /setup in the group, or /setca <mint>.");
    return ct;
  }

  /**
   * /use — pick which group a DM applies to.
   *
   * It lists only groups you are an admin of RIGHT NOW (getChatMember, per group, at the moment
   * you ask). A group you were demoted from simply does not appear.
   */
  bot.command('use', async (ctx) => {
    if (isGroup(ctx)) return void ctx.reply('You are already in a group — commands here apply to it.');

    const userId = userIdOf(ctx);
    const rows: { text: string; callback_data: string }[][] = [];

    for (const chat of await repo.listChats()) {
      const verdict = await requireGroupAdmin(bot.api, chat.chatId, userId);
      if (!verdict.ok) continue;
      rows.push([{ text: chat.title ?? String(chat.chatId), callback_data: `use:${chat.chatId}` }]);
    }

    if (rows.length === 0) {
      return void ctx.reply("You're not an admin of any group I'm in.");
    }
    await ctx.reply('Which group are you configuring?', { reply_markup: { inline_keyboard: rows } });
  });

  bot.callbackQuery(/^use:(-?\d+)$/, async (ctx) => {
    const chatId = Number(ctx.match[1]) as ChatId;
    const userId = ctx.from.id;

    // Re-check on the TAP, not just when the list was drawn. A button is not a permission.
    const verdict = await requireGroupAdmin(bot.api, chatId, userId);
    if (!verdict.ok) {
      await ctx.answerCallbackQuery({ text: verdict.why, show_alert: true });
      return;
    }

    dmTarget.set(userId, chatId);
    const chat = await repo.getChat(chatId);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✅ Configuring *${chat?.title ?? chatId}*.\n\nEvery command here now applies to that group. /settings to see it.`,
      { parse_mode: 'Markdown' },
    );
  });

  async function symbolOf(mint: Mint): Promise<string> {
    const t = await repo.getToken(mint);
    return displaySymbol(t?.symbol ?? null, mint);
  }

  /** Every mutating command replies. `patch` + confirm, in one place. */
  async function apply(ctx: Context, ct: ChatToken, patch: Parameters<Repo['updateChatToken']>[2], msg: string): Promise<void> {
    await repo.updateChatToken(ct.chatId, ct.mint, patch);
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /**
   * Added to (or removed from) a group.
   *
   * On add: create the chats row and say ONE line. A bot that dumps a wall of setup
   * instructions into a group the moment it arrives is a bot that gets removed.
   * On remove: pause, and drop any mint nobody else is watching — self-healing, so a
   * dead group stops costing us a subscription forever.
   */
  bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const chatId = ctx.chat.id as ChatId;

    if (status === 'member' || status === 'administrator') {
      await repo.upsertChat({
        chatId,
        title: ctx.chat.title ?? null,
        addedBy: ctx.from?.id ?? null,
        paused: false,
      });
      await ctx.reply("👋 I'm in. An admin can run /setup to point me at a token.");
      return;
    }

    if (status === 'left' || status === 'kicked') {
      await repo.setPaused(chatId, true);
      await reconcileSubscriptions();
      log.info({ chatId }, 'removed from chat — paused and unsubscribed orphaned mints');
    }
  });

  /**
   * The subscription set is a FUNCTION of the DB, never a manual list.
   *
   * Anything else drifts: a chat pauses and its mint is left streaming forever, or two
   * chats share a mint and removing one kills the other's feed. Diffing what the ingestor
   * has against what the DB says is active makes both bugs unrepresentable.
   */
  async function reconcileSubscriptions(): Promise<void> {
    const want = new Set(await repo.activeMints());
    const have = new Set(deps.currentMints());

    for (const mint of want) if (!have.has(mint)) await deps.subscribe(mint);
    for (const mint of have) if (!want.has(mint)) await deps.unsubscribe(mint);
  }

  // -------------------------------------------------------------------------
  // /start, /setup
  // -------------------------------------------------------------------------

  bot.command('start', async (ctx) => {
    if (isGroup(ctx)) {
      await ctx.reply('👋 An admin can run /setup to point me at a token.');
      return;
    }
    await ctx.reply(
      "*RiceBuybot*\n\nI post a card in your group every time someone buys your token — with a meme, the buy size, the buyer's position and the market cap.\n\n*To use me:* add me to your group, make me an admin, and run `/setup` there.",
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('cancel', async (ctx) => {
    const had = wizards.cancel(chatIdOf(ctx), userIdOf(ctx));
    awaitingMedia.delete(`${chatIdOf(ctx)}:${userIdOf(ctx)}`);
    await ctx.reply(had ? 'Cancelled. Nothing was changed.' : 'Nothing to cancel.');
  });

  /**
   * /stop — abort the /setup wizard, or any in-progress capture, for THIS admin, here.
   *
   * The word people reach for when they want the bot to back off mid-flow. It is the same
   * effect as /cancel, and it is deliberately narrow: a wizard and a /setmedia capture are
   * both keyed per (chat, user), so /stop only ever touches the CALLER's own in-progress
   * process. One admin cannot stop another's half-finished setup, and it can never stop a
   * live buy feed — for that a group uses /pause.
   *
   * `targetOf` is cleared as well as `chatIdOf`: a DM /setmedia registers its capture under
   * the group it is aimed at (see /setmedia), not the DM's own chat id, so clearing only the
   * latter would leave a DM-initiated capture armed.
   */
  bot.command('stop', async (ctx) => {
    const userId = userIdOf(ctx);
    const hadWizard = wizards.cancel(chatIdOf(ctx), userId);
    const target = targetOf(ctx);
    const hadMedia =
      awaitingMedia.delete(`${chatIdOf(ctx)}:${userId}`) ||
      (target !== null && awaitingMedia.delete(`${target}:${userId}`));
    await ctx.reply(
      hadWizard || hadMedia ? '🛑 Stopped. Nothing was changed.' : 'Nothing in progress to stop.',
    );
  });

  /**
   * /whoami — your Telegram user id, and (in a group) that group's id.
   *
   * The fastest way to find the number OWNER_USER_ID wants, and the group id /approve takes.
   * Harmless to expose: Telegram already hands both to anyone who looks.
   */
  bot.command('whoami', async (ctx) => {
    const lines = [`Your user id: \`${userIdOf(ctx)}\``];
    if (isGroup(ctx)) lines.push(`This group id: \`${chatIdOf(ctx)}\``);
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('setup', async (ctx) => {
    if (!(await gate(ctx))) return;
    wizards.start(chatIdOf(ctx), userIdOf(ctx));
    await ctx.reply(PROMPTS.contract, { parse_mode: 'Markdown' });
  });

  // -------------------------------------------------------------------------
  // the settings
  // -------------------------------------------------------------------------

  bot.command('setca', async (ctx) => {
    if (!(await gate(ctx))) return;

    // The free plan tracks one token. Checked against what they ALREADY have, so a free chat
    // can always REPLACE its mint — it just cannot accumulate a second one.
    const caps = await capsOf(repo, targetOf(ctx) as ChatId);
    const existing = await repo.listChatTokens(targetOf(ctx) as ChatId);
    const replacing = ctx.match.trim().length > 0 && existing.length <= 1;

    if (!replacing) {
      const g = gateMints(caps, existing.length);
      if (!g.allowed) return void ctx.reply(g.why, { parse_mode: 'Markdown' });
    }

    await setContract(ctx, ctx.match.trim());
  });

  /**
   * /grant — OWNER ONLY. The only way a plan ever changes.
   *
   * Not gated on group admin: a group admin granting their own group a paid plan would be a
   * self-service upgrade button. Only the bot owner (OWNER_USER_ID) can do this, and it is
   * recorded with who and when.
   */
  bot.command('grant', async (ctx) => {
    const userId = userIdOf(ctx);
    if (deps.ownerUserId === undefined || userId !== deps.ownerUserId) {
      // Say nothing useful. A stranger probing for admin commands learns only that this one
      // does not exist for them.
      return;
    }

    const [target, planRaw] = ctx.match.trim().split(/\s+/);
    const plan = (planRaw ?? '').toLowerCase();

    if (!target || !isPlan(plan)) {
      return void ctx.reply('`/grant <chat_id> free|paid`', { parse_mode: 'Markdown' });
    }

    const chatId = Number(target) as ChatId;
    const chat = await repo.getChat(chatId);
    if (!chat) return void ctx.reply("I don't know that chat.");

    await repo.setPlan(chatId, plan, userId);
    const caps = capabilities(plan);

    await ctx.reply(
      `✅ *${chat.title ?? chatId}* is now on the **${plan}** plan.\n\n` +
        `Mints: ${caps.maxMints} · Pool media: ${caps.mediaPool ? 'yes' : 'no'} · ` +
        `Custom emoji: ${caps.customEmoji ? 'yes' : 'no'} · ` +
        `Posts: ${caps.postDelayMs === 0 ? 'instant' : `${caps.postDelayMs / 1000}s delayed`}`,
      { parse_mode: 'Markdown' },
    );

    // Tell the group, if it is not where the command was typed. A plan change is not something
    // to do to someone silently — in either direction.
    if (chatIdOf(ctx) !== chatId) {
      await ctx.api
        .sendMessage(
          chatId,
          plan === 'paid'
            ? '🎉 This group is now on the paid plan: the full meme pool, custom emoji, instant posts and custom buttons.'
            : 'This group is now on the free plan. Your settings are kept — buys still post, with one image and a 5s delay.',
        )
        .catch(() => {});
    }
  });

  /**
   * /approve — OWNER ONLY. Approve ANY group id for the full feature set, from a DM.
   *
   * This is the super-admin path the /grant guard deliberately does not offer: /grant refuses a
   * chat it has never seen ("I don't know that chat"), which is correct for a sale but wrong for
   * PRE-approval — the owner wants a partner group entitled the moment the bot lands in it, which
   * is before any my_chat_member row exists. So /approve creates the row if it is missing (never
   * clobbering an existing one's owner/title/pause) and records a paid grant.
   *
   * It is a DB grant, not the env whitelist: hot (no restart), works for an unknown id, revocable
   * with /unapprove, and recorded with who granted it and when. planOf reads it straight back.
   */
  bot.command('approve', async (ctx) => {
    const userId = userIdOf(ctx);
    // Silent to everyone but the owner — a stranger probing learns nothing. Same as /grant.
    if (deps.ownerUserId === undefined || userId !== deps.ownerUserId) return;

    const target = ctx.match.trim().split(/\s+/)[0] ?? '';
    const chatId = Number(target) as ChatId;
    if (!target || !Number.isInteger(chatId as unknown as number) || (chatId as unknown as number) === 0) {
      return void ctx.reply(
        '`/approve <chat_id>` — approves a group for **all features**.\n\nRun /whoami inside the group to get its id.',
        { parse_mode: 'Markdown' },
      );
    }

    // Create the row only when there is none — an upsert here would reset added_by/title/paused
    // on a group the bot is already in.
    if (!(await repo.getChat(chatId))) {
      await repo.upsertChat({ chatId, title: null, addedBy: null, paused: false });
    }
    await repo.setPlan(chatId, 'paid', userId);

    const chat = await repo.getChat(chatId);
    const caps = capabilities('paid');
    await ctx.reply(
      `✅ *${chat?.title ?? chatId}* is approved for **all features** (paid).\n\n` +
        `Mints: ${caps.maxMints} · Pool media: yes · Custom emoji: yes · Instant posts · Custom buttons.\n\n` +
        `It applies the moment I'm in the group. \`/unapprove ${chatId}\` to revoke.`,
      { parse_mode: 'Markdown' },
    );

    // If approved from somewhere other than the group itself, tell the group — but only if the
    // bot is actually in it. A pre-approval of a group it has not joined has nowhere to post.
    if (chatIdOf(ctx) !== chatId) {
      await ctx.api
        .sendMessage(
          chatId,
          '🎉 This group is approved for the full feature set: the meme pool, custom emoji, instant posts and custom buttons.',
        )
        .catch(() => {});
    }
  });

  /** /unapprove — OWNER ONLY. Revoke an /approve, back to the free plan. */
  bot.command('unapprove', async (ctx) => {
    const userId = userIdOf(ctx);
    if (deps.ownerUserId === undefined || userId !== deps.ownerUserId) return;

    const target = ctx.match.trim().split(/\s+/)[0] ?? '';
    const chatId = Number(target) as ChatId;
    if (!target || !Number.isInteger(chatId as unknown as number) || (chatId as unknown as number) === 0) {
      return void ctx.reply('`/unapprove <chat_id>`', { parse_mode: 'Markdown' });
    }
    if (!(await repo.getChat(chatId))) return void ctx.reply("I don't know that chat.");

    await repo.setPlan(chatId, 'free', userId);
    await ctx.reply(`✅ *${chatId}* is back on the free plan.`, { parse_mode: 'Markdown' });

    if (chatIdOf(ctx) !== chatId) {
      await ctx.api
        .sendMessage(
          chatId,
          'This group is now on the free plan. Your settings are kept — buys still post, with one image and a 5s delay.',
        )
        .catch(() => {});
    }
  });

  /**
   * Point a chat at a token. Validate the FORMAT, then validate that it EXISTS.
   *
   * The on-chain check is the one that earns its keep: a well-formed base58 key that is not
   * a mint configures perfectly, subscribes perfectly, and then posts nothing, forever,
   * with no error anywhere. The group concludes the bot is broken. One RPC call turns a
   * silent permanent failure into a sentence.
   */
  async function setContract(ctx: Context, raw: string): Promise<boolean> {
    const format = validateMintFormat(raw);
    if (!format.ok) {
      await ctx.reply(format.why, { parse_mode: 'Markdown' });
      return false;
    }

    const working = await ctx.reply('Checking that token on-chain…');
    const chain = await validateMintOnChain(format.value, deps.chain);
    if (!chain.ok) {
      await ctx.api.editMessageText(ctx.chat!.id, working.message_id, chain.why);
      return false;
    }

    const chatId = targetOf(ctx) as ChatId;
    const existing = await repo.listChatTokens(chatId);
    const old = existing[0];

    // Re-running /setup EDITS. It never creates a second config for the same chat.
    if (old && old.mint !== format.value) await repo.removeChatToken(chatId, old.mint);

    // Do NOT clobber the symbol.
    //
    // `chain.supplyOf` goes through TokenMetaCache, which has ALREADY read the symbol and name
    // off the chain and written the row. Overwriting it here with nulls threw that away, and
    // the card then fell back to the mint's first four characters — "Got 200,000 2wQq" instead
    // of "Got 200,000 RICE". Keep whatever metadata we have; only the supply is ours to refresh.
    const known = await repo.getToken(format.value);
    await repo.putToken({
      mint: format.value,
      symbol: known?.symbol ?? null,
      name: known?.name ?? null,
      decimals: chain.value.decimals,
      supplyRaw: chain.value.supplyRaw,
      fetchedAtMs: Date.now(),
    });
    await repo.addChatToken(chatId, format.value);

    // Live, with no restart: subscribe the new mint, and drop the old one iff nobody else
    // is watching it.
    await reconcileSubscriptions();

    await ctx.api.editMessageText(
      chatId,
      working.message_id,
      `✅ Tracking \`${format.value}\`.\nI'll post buys here as they land.`,
      { parse_mode: 'Markdown' },
    );
    return true;
  }

  bot.command('setmin', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    const v = validateUsd(ctx.match, { min: 0, max: 100_000, label: 'The minimum buy' });
    if (!v.ok) return void ctx.reply(v.why, { parse_mode: 'Markdown' });

    await apply(ctx, ct, { minBuyUsd: v.value }, `✅ I'll only post buys over **$${v.value.toLocaleString()}**.`);
  });

  bot.command('setfloors', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    const parts = ctx.match.trim().split(/\s+/);
    if (parts.length !== 3) {
      return void ctx.reply('Send three amounts: `/setfloors 10 250 1000` — Regular, Big, Massive.', {
        parse_mode: 'Markdown',
      });
    }

    const v = validateFloors(parts[0] as string, parts[1] as string, parts[2] as string);
    if (!v.ok) return void ctx.reply(v.why);

    const patch = { minBuyUsd: v.value.regular, buyFloorBig: v.value.big, buyFloorMassive: v.value.massive };
    await repo.updateChatToken(ct.chatId, ct.mint, patch);
    const updated = (await repo.getChatToken(ct.chatId, ct.mint)) as ChatToken;

    await ctx.reply(
      `✅ ${floorsSentence(updated)}\n\n_Whale is separate — it's about how much they HOLD. See /setwhale._`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('setwhale', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    const v = validateUsd(ctx.match, { min: 100, max: 100_000_000, label: 'The whale wallet-value threshold' });
    if (!v.ok) return void ctx.reply(v.why, { parse_mode: 'Markdown' });

    await repo.updateChatToken(ct.chatId, ct.mint, { whaleHoldingsUsd: v.value });
    const updated = (await repo.getChatToken(ct.chatId, ct.mint)) as ChatToken;
    await ctx.reply(`✅ ${whaleSentence(updated, await symbolOf(ct.mint))}`, { parse_mode: 'Markdown' });
  });

  bot.command('whalebasis', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    // The whale test is now SOL+USDC wallet value (read live), so pre/post no longer means
    // anything — it governed the TOKEN bag before/after the buy. Say so rather than silently
    // storing a setting that does nothing.
    await ctx.reply(
      "Whale is now decided by the buyer's SOL+USDC wallet value, so pre/post no longer applies. " +
        'Set the threshold with `/setwhale 10000`.',
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('setstep', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    const v = validateUsd(ctx.match, { min: 1, max: 100_000, label: 'The emoji step' });
    if (!v.ok) return void ctx.reply(v.why, { parse_mode: 'Markdown' });

    await apply(
      ctx,
      ct,
      { emojiStepUsd: v.value },
      `✅ One ${ct.emoji} per **$${v.value}** — so a $${(v.value * 5).toLocaleString()} buy shows 5.`,
    );
  });

  bot.command('setmaxemoji', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    const v = validateInt(ctx.match, { min: 1, max: 100, label: 'The emoji cap' });
    if (!v.ok) return void ctx.reply(v.why, { parse_mode: 'Markdown' });

    await apply(ctx, ct, { maxEmojis: v.value }, `✅ At most **${v.value}** ${ct.emoji} per card.`);
  });

  /**
   * /setemoji — unicode, a custom (premium) emoji, or a reply to one.
   *
   * The custom_emoji_id is NOT in the text. It lives in a message ENTITY, and the text is
   * only the fallback glyph. Reading the text alone gets you a plain emoji that renders
   * fine and is not the one they asked for — a bug nobody notices, because it looks right.
   */
  bot.command('setemoji', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    const msg = ctx.msg;
    const source = msg.reply_to_message ?? msg;
    const entities = (source.entities ?? source.caption_entities ?? []) as {
      type: string;
      offset: number;
      length: number;
      custom_emoji_id?: string;
    }[];
    const text = source.text ?? source.caption ?? '';

    const caps = await capsOf(repo, targetOf(ctx) as ChatId);

    const custom = entities.find((e) => e.type === 'custom_emoji' && e.custom_emoji_id);
    if (custom && !caps.customEmoji) {
      return void ctx.reply(UPSELL.customEmoji, { parse_mode: 'Markdown' });
    }
    if (custom) {
      const glyph = [...text.slice(custom.offset, custom.offset + custom.length)][0] ?? '🍚';
      await apply(
        ctx,
        ct,
        { emoji: glyph, emojiCustomId: custom.custom_emoji_id as string },
        `✅ Using your custom emoji. (Anyone without premium will see ${glyph}.)`,
      );
      return;
    }

    const arg = ctx.match.trim();
    const glyph = [...arg][0];
    if (!glyph || arg.length > 8) {
      return void ctx.reply('Send one emoji, like `/setemoji 🍚` — or reply to a custom emoji with /setemoji.', {
        parse_mode: 'Markdown',
      });
    }

    await apply(ctx, ct, { emoji: glyph, emojiCustomId: null }, `✅ Ladder emoji is now ${glyph}.`);
  });

  bot.command('setheadline', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    const [tierRaw, ...rest] = ctx.match.trim().split(/\s+/);
    const text = rest.join(' ');
    const tier = (tierRaw ?? '').replace(/^./, (c) => c.toUpperCase());

    if (!isTierName(tier) || text.length === 0) {
      return void ctx.reply(
        'Send a tier and the text:\n`/setheadline whale 🐳 A WHALE APPEARS`\n\nTiers: regular, big, whale, massive. `{SYM}` becomes the token symbol.',
        { parse_mode: 'Markdown' },
      );
    }

    const headlines = [...ct.tierHeadlines];
    headlines[TIERS.findIndex((t) => t.name === (tier as TierName))] = text;
    await apply(ctx, ct, { tierHeadlines: headlines }, `✅ ${tier} buys will say:\n\n${text.replaceAll('{SYM}', await symbolOf(ct.mint))}`);
  });

  bot.command('mediamode', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    const mode = ctx.match.trim().toLowerCase();
    if (mode !== 'pool' && mode !== 'static' && mode !== 'none') {
      return void ctx.reply('`/mediamode pool` · `/mediamode static` · `/mediamode none`', { parse_mode: 'Markdown' });
    }

    if (mode === 'pool') {
      const g = capGate(await capsOf(repo, targetOf(ctx) as ChatId), 'mediaPool');
      if (!g.allowed) return void ctx.reply(g.why, { parse_mode: 'Markdown' });
    }

    await apply(
      ctx,
      ct,
      { mediaMode: mode },
      mode === 'static' ? '✅ Static media. Now send /setmedia and give me the image.' : `✅ Media mode: **${mode}**.`,
    );
  });

  /** /setmedia — capture the file_id from the NEXT media message this user sends. */
  bot.command('setmedia', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    if (ct.mediaMode !== 'static') {
      return void ctx.reply('That only applies on static media. Run `/mediamode static` first.', {
        parse_mode: 'Markdown',
      });
    }

    awaitingMedia.set(`${targetOf(ctx)}:${userIdOf(ctx)}`, { chatId: targetOf(ctx) as ChatId, mint: ct.mint });
    await ctx.reply('Send me the photo, GIF or video you want on every card.');
  });

  bot.command('mediastats', async (ctx) => {
    const ct = await currentToken(ctx);
    if (!ct) return;

    // Report the EFFECTIVE mode, not the stored one. A free chat whose row still says
    // 'pool' is clamped to static/text by the plan gate (plan-gate.ts), and reading the
    // raw column here told that chat its pool was in use while every card went out as
    // text — the curator then blames the pool they just stocked. Same principle as the
    // gate itself: what the chat CAN DO is the plan, not the row.
    const caps = await capsOf(repo, ct.chatId);
    const eff = effective(ct, caps, DEFAULT_LINKS);
    const health = await media.health(ct.mint);
    await ctx.reply(
      mediaStatsMessage(
        await symbolOf(ct.mint),
        health,
        eff.mediaMode === 'pool',
        ct.mediaMode === 'pool' && !caps.mediaPool,
      ),
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('setlink', async (ctx) => {
    if (!(await gate(ctx))) return;
    const ct = await currentToken(ctx);
    if (!ct) return;

    const g = capGate(await capsOf(repo, targetOf(ctx) as ChatId), 'customLinks');
    if (!g.allowed) return void ctx.reply(g.why, { parse_mode: 'Markdown' });

    const [labelRaw, url] = ctx.match.trim().split(/\s+/, 2);
    const label = LINK_LABELS[(labelRaw ?? '').toLowerCase()];

    if (!label) {
      return void ctx.reply(
        `Which button? One of: ${Object.keys(LINK_LABELS).join(', ')}\n\n\`/setlink trending https://…\`\n\`/setlink trending\` (with no url) removes it.`,
        { parse_mode: 'Markdown' },
      );
    }

    const links = { ...(ct.links ?? {}) };
    if (!url) {
      delete links[label];
      await apply(ctx, ct, { links }, `✅ Removed the **${label}** button.`);
      return;
    }

    if (!/^https?:\/\//i.test(url)) {
      return void ctx.reply('That needs to be a full URL starting with `https://`.', { parse_mode: 'Markdown' });
    }

    links[label] = url;
    await apply(ctx, ct, { links }, `✅ **${label}** button set.`);
  });

  bot.command('settings', async (ctx) => {
    const ct = await currentToken(ctx);
    if (!ct) return;
    const chat = await repo.getChat(ct.chatId);
    await ctx.reply(
      settingsMessage(ct, await symbolOf(ct.mint), chat?.paused ?? false, await planOf(repo, ct.chatId)),
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('pause', async (ctx) => {
    if (!(await gate(ctx))) return;
    await repo.setPaused(targetOf(ctx) as ChatId, true);
    await reconcileSubscriptions();
    await ctx.reply('⏸ Paused. I keep your settings — /resume when you want me back.');
  });

  bot.command('resume', async (ctx) => {
    if (!(await gate(ctx))) return;
    await repo.setPaused(targetOf(ctx) as ChatId, false);
    await reconcileSubscriptions();
    await ctx.reply('▶️ Back on.');
  });

  /** /reset — confirm, THEN wipe. A destructive command that fires on one word is a trap. */
  const resetPending = new Set<string>();
  bot.command('reset', async (ctx) => {
    if (!(await gate(ctx))) return;
    const k = `${chatIdOf(ctx)}:${userIdOf(ctx)}`;

    if (resetPending.has(k)) {
      resetPending.delete(k);
      for (const ct of await repo.listChatTokens(targetOf(ctx) as ChatId)) {
        await repo.removeChatToken(targetOf(ctx) as ChatId, ct.mint);
      }
      await reconcileSubscriptions();
      await ctx.reply('🗑 Wiped. Run /setup to start again.');
      return;
    }

    resetPending.add(k);
    setTimeout(() => resetPending.delete(k), 60_000).unref?.();
    await ctx.reply('⚠️ This deletes this chat’s settings. Send /reset again within a minute to confirm.');
  });

  // -------------------------------------------------------------------------
  // /preview — the whale path, without waiting for a whale
  // -------------------------------------------------------------------------

  /**
   * Render a fake buy and post it here. Costs no chain data.
   *
   * The SECOND argument is the point of the whole command: holdings are what make a whale,
   * so `/preview 20 50000` is the only way to see a WHALE card without waiting for an
   * actual whale to show up. Without it, a group cannot test the tier they most care about.
   *
   * It goes through the REAL renderer and the REAL media pick — so it is a genuine
   * rehearsal, not a mock-up. It does NOT go through the queue: a preview is not a buy, it
   * must not take a send claim, and it must not be able to double-post a real signature.
   */
  bot.command('preview', async (ctx) => {
    const ct = await currentToken(ctx);
    if (!ct) return;

    const [usdRaw, heldRaw] = ctx.match.trim().split(/\s+/);
    const usdIn = Number(usdRaw ?? 50) || 50;
    const holdingsUsd = Number(heldRaw ?? 0) || 0;

    const token = await repo.getToken(ct.mint);
    if (!token) return void ctx.reply("I don't have that token's details yet. Try again in a moment.");

    const picked = await media.pick(ct.mint, ct.chatId, usdIn, holdingsUsd);
    if (!picked) {
      return void ctx.reply(`A $${usdIn} buy is below this chat's minimum ($${ct.minBuyUsd}), so I wouldn't post it.`);
    }

    // /preview must show what a REAL buy would show — including the plan clamp. Without this it
    // rendered pool art to a free chat, i.e. it previewed a card the group can never actually
    // receive. A preview that lies is worse than no preview.
    const caps = await capsOf(repo, ct.chatId); // consults PLAN_WHITELIST
    const eff = effective(ct, caps, DEFAULT_LINKS);

    const priceUsd = 0.0001;
    const card = renderCard({
      signature: 'preview' as Signature,
      mint: ct.mint,
      buyer: 'PreviewWa11etAddressPreviewWa11etAddress99' as Wallet,
      token,
      earnedTier: picked.earnedTier,
      usedTier: picked.usedTier,
      media: picked.item,
      usdIn,
      quoteAmount: usdIn / 150,
      quoteSymbol: 'SOL',
      tokensOut: usdIn / priceUsd,
      marketCapUsd: 1_000_000,
      whaleValueUsd: holdingsUsd,
      position: null,
      emoji: ct.emoji,
      emojiCustomId: eff.emojiCustomId,
      emojiStepUsd: ct.emojiStepUsd,
      maxEmojis: ct.maxEmojis,
      tierHeadlines: ct.tierHeadlines,
      links: eff.links,
    });

    const usePool = eff.mediaMode === 'pool' && picked.item;
    const fileId = usePool ? await media.fileIdFor(picked.item!) : ct.staticFileId;
    const kind: MediaKind | null = usePool ? picked.item!.kind : ct.staticKind;

    await deps.sender.send({
      chatId: ct.chatId,
      card,
      fileId: eff.mediaMode === 'none' ? null : fileId,
      kind: eff.mediaMode === 'none' ? null : kind,
    });
  });

  // -------------------------------------------------------------------------
  // free-text: the wizard, and /setmedia's capture
  // -------------------------------------------------------------------------

  bot.on('message', async (ctx, next) => {
    const chatId = chatIdOf(ctx);
    const userId = userIdOf(ctx);
    const k = `${chatId}:${userId}`;

    // --- /setmedia capture -----------------------------------------------------------
    const pending = awaitingMedia.get(k);
    if (pending) {
      const m = ctx.msg;
      const captured =
        m.photo?.[m.photo.length - 1]
          ? { fileId: m.photo[m.photo.length - 1]!.file_id, kind: 'photo' as MediaKind }
          : m.animation
            ? { fileId: m.animation.file_id, kind: 'animation' as MediaKind }
            : m.video
              ? { fileId: m.video.file_id, kind: 'video' as MediaKind }
              : null;

      if (!captured) return void ctx.reply('That wasn’t a photo, GIF or video. Send one, or /cancel.');

      awaitingMedia.delete(k);
      await repo.updateChatToken(pending.chatId, pending.mint, {
        staticFileId: captured.fileId,
        staticKind: captured.kind,
      });
      await ctx.reply('✅ Got it. Every buy card will use that.');
      return;
    }

    // --- the wizard ------------------------------------------------------------------
    const w = wizards.get(chatId, userId);
    if (!w) return next();

    await handleWizardStep(ctx, w);
  });

  async function handleWizardStep(ctx: Context, w: WizardState): Promise<void> {
    const text = (ctx.msg?.text ?? '').trim();
    if (text.startsWith('/')) return; // a command, not an answer

    const ct = async (): Promise<ChatToken | null> => {
      const tokens = await repo.listChatTokens(w.chatId);
      return tokens[0] ?? null;
    };

    switch (w.step) {
      case 'contract': {
        if (!(await setContract(ctx, text))) return; // stay on this step; it already explained why
        wizards.advance(w, 'media');
        await ctx.reply(PROMPTS.media, { parse_mode: 'Markdown' });
        return;
      }

      case 'media': {
        const mode = text.toLowerCase();
        if (mode !== 'pool' && mode !== 'static' && mode !== 'none') {
          return void ctx.reply('Reply with one of: `pool`, `static`, `none`.', { parse_mode: 'Markdown' });
        }
        // The wizard is a SECOND door to media_mode. Gating /mediamode and not this one would
        // make the gate theatre — a free chat would simply set the pool during setup.
        if (mode === 'pool') {
          const g = capGate(await capsOf(repo, w.chatId), 'mediaPool');
          if (!g.allowed) return void ctx.reply(g.why, { parse_mode: 'Markdown' });
        }
        const token = await ct();
        if (token) await repo.updateChatToken(token.chatId, token.mint, { mediaMode: mode });
        wizards.advance(w, 'minbuy');
        await ctx.reply(PROMPTS.minbuy, { parse_mode: 'Markdown' });
        return;
      }

      case 'minbuy': {
        const v = validateUsd(text, { min: 0, max: 100_000, label: 'The minimum buy' });
        if (!v.ok) return void ctx.reply(v.why, { parse_mode: 'Markdown' });
        const token = await ct();
        if (token) await repo.updateChatToken(token.chatId, token.mint, { minBuyUsd: v.value });
        wizards.advance(w, 'emoji');
        await ctx.reply(PROMPTS.emoji, { parse_mode: 'Markdown' });
        return;
      }

      case 'emoji': {
        const glyph = [...text][0];
        if (!glyph) return void ctx.reply('Send one emoji.');
        const token = await ct();
        const entity = (ctx.msg?.entities ?? []).find((e) => e.type === 'custom_emoji');
        if (token) {
          await repo.updateChatToken(token.chatId, token.mint, {
            emoji: glyph,
            emojiCustomId: (entity as { custom_emoji_id?: string } | undefined)?.custom_emoji_id ?? null,
          });
        }
        wizards.advance(w, 'step');
        await ctx.reply(PROMPTS.step, { parse_mode: 'Markdown' });
        return;
      }

      case 'step': {
        const v = validateUsd(text, { min: 1, max: 100_000, label: 'The emoji step' });
        if (!v.ok) return void ctx.reply(v.why, { parse_mode: 'Markdown' });
        const token = await ct();
        if (token) await repo.updateChatToken(token.chatId, token.mint, { emojiStepUsd: v.value });

        wizards.advance(w, 'done');
        const final = await ct();
        if (final) {
          await ctx.reply(
            `🎉 All set.\n\n${settingsMessage(final, await symbolOf(final.mint), false)}\n\nTry \`/preview 250\`.`,
            { parse_mode: 'Markdown' },
          );
        }
        return;
      }

      default:
        return;
    }
  }
}
