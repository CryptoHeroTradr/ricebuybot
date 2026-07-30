import type { ChatToken } from '../core/types.js';
import { TIERS, type TierFolder, type TierName } from '../core/tiers.js';
import type { PoolHealth } from '../media/index.js';
import { capabilities, UPSELL, type Plan } from '../core/plans.js';
import { usd } from '../render/format.js';
// PHASE 9: the panel's own banner strings and mode vocabulary. Imported rather than restated so
// /settings and /trade cannot word the money-at-stake line differently — see dcaSectionMessage.
import { DRY_BANNER, LIVE_BANNER, modeBanner } from './trade-panel/render.js';
import type { TraderMode } from '../trade/mode.js';

/**
 * Human copy. PURE, so every sentence a group ever sees is testable without a bot.
 *
 * The rule for all of it: NEVER show an internal identifier, never show a stack trace,
 * never say "invalid". Say what was wrong and what to type instead. A group admin
 * configuring a bot is not a developer reading a log.
 */

/** "Regular $10+ · Big $250+ · Massive $1,000+" */
export function floorsSentence(ct: ChatToken): string {
  return `Regular ${usd(ct.minBuyUsd)}+ · Big ${usd(ct.buyFloorBig)}+ · Massive ${usd(ct.buyFloorMassive)}+`;
}

/**
 * The whale line, spelled out — because the whole feature is counter-intuitive and one
 * sentence prevents a support conversation.
 *
 * "no matter how small the buy" is doing the work: a group that reads "Whale = $10,000"
 * will assume it means a $10,000 BUY, which is exactly the ladder mental model this design
 * exists to break.
 */
export function whaleSentence(ct: ChatToken, _symbol: string): string {
  // The whale test is now the buyer's LIQUID WALLET VALUE — SOL + USDC — not their bag of this
  // token. See pricing/wallet-value.ts for why. whale_basis no longer applies (that governed the
  // token bag before/after the buy); the wallet value is read live from the chain.
  return (
    `Whale = any buyer whose wallet holds ${usd(ct.whaleHoldingsUsd)}+ in SOL and USDC, ` +
    `no matter how small the buy — measured from real market prices, not the token's own.`
  );
}

/**
 * /mediastats — the one place an operator actually looks at their pool.
 *
 * Two things here are not decoration:
 *
 * EMPTY TIERS ARE CALLED OUT. An empty massive/ does not fail — it silently borrows art
 * from whale/, so MASSIVE cards start showing whale memes and nobody ever finds out. The
 * card still says MASSIVE (the headline is the earned tier), so the degradation is
 * invisible from the outside. It has to be visible from in here.
 *
 * UNPUBLISHED FILES ARE CALLED OUT. The generator refuses any file whose name is not its
 * content hash and writes a warning to a systemd journal that nobody reads. Meanwhile the
 * curator who copied a meme in by hand is looking at their meme, in the folder, and
 * swearing the bot ignored it. It did. Say so, and say how to fix it.
 */
export function mediaStatsMessage(
  symbol: string,
  health: PoolHealth,
  poolMode: boolean,
  /** Stored mode IS 'pool', but the plan clamps it — say so instead of "switch to pool". */
  planGated = false,
): string {
  const lines: string[] = [];

  const counts = (['regular', 'big', 'whale', 'massive'] as TierFolder[])
    .map((t) => `${label(t)} ${health.perTier[t]}`)
    .join(' · ');

  lines.push(`🍚 *$${symbol} media pool*`);
  lines.push(`${counts} — ${health.uploaded}/${health.total} uploaded to Telegram`);

  if (!poolMode) {
    lines.push('');
    lines.push(
      planGated
        ? `_This chat is set to pool media, but it is on the **free plan** — so none of this is being used and buys post as text (or the static image, if one is set)._\n\n${UPSELL.mediaPool}`
        : '_This chat is not on pool media, so none of this is being used. `/mediamode pool` to switch._',
    );
  }

  if (health.total === 0) {
    lines.push('');
    lines.push("There's no art for this token yet, so buys will post as **text-only cards**. That works fine — nothing is broken — but the memes are the fun part.");
    return lines.join('\n');
  }

  if (health.emptyTiers.length > 0) {
    lines.push('');
    for (const t of health.emptyTiers) {
      lines.push(
        `⚠️ *${label(t)} is empty* — ${label(t)} buys will borrow art from another tier. ` +
          `The headline still says ${label(t).toUpperCase()}, so nobody will notice but you.`,
      );
    }
  }

  const pending = health.total - health.uploaded;
  if (pending > 0) {
    lines.push('');
    lines.push(`⏳ ${pending} not uploaded to Telegram yet. They'll upload in the background, or on first use.`);
  }

  if (health.unpublished !== null && health.unpublished > 0) {
    lines.push('');
    lines.push(
      `⚠️ *${health.unpublished} file${health.unpublished === 1 ? '' : 's'} unpublished* — ` +
        `${health.unpublished === 1 ? "it's" : "they're"} sitting in a tier folder but ` +
        `${health.unpublished === 1 ? "isn't" : "aren't"} content-addressed, so I can't see ` +
        `${health.unpublished === 1 ? 'it' : 'them'} at all.\n` +
        'Someone probably copied files in by hand. An operator can fix it with `tier fix` on the box.',
    );
  }

  return lines.join('\n');
}

function label(t: TierFolder): string {
  return (TIERS.find((x) => x.folder === t)?.name ?? t) as TierName;
}

/**
 * /settings — the whole config, in plain English, WITH THE COMMAND THAT CHANGES EACH LINE.
 *
 * The old version listed the config and then said "run /setup again" — which was not even true:
 * every line has its own command. They were simply invisible unless you already knew them, so
 * the only discoverable way to change one setting was to re-run the entire five-step wizard.
 *
 * A settings screen that shows state but hides the verbs is a settings screen that makes people
 * re-do work they have already done.
 */
export function settingsMessage(ct: ChatToken, symbol: string, paused: boolean, plan: Plan = 'free'): string {
  const caps = capabilities(plan);

  // What the plan ACTUALLY permits, not what the row happens to say. A downgraded chat still has
  // `media_mode = 'pool'` stored; showing "the shared meme pool" would be a lie about what is
  // going to happen on the next buy.
  const effectiveMedia = !caps.mediaPool && ct.mediaMode === 'pool' ? 'static' : ct.mediaMode;
  const mediaLine =
    effectiveMedia === 'pool'
      ? 'the shared meme pool'
      : effectiveMedia === 'static'
        ? ct.staticFileId
          ? 'one fixed image'
          : '⚠️ no image set yet'
        : 'no media (text-only cards)';

  const emoji = ct.emojiCustomId && caps.customEmoji ? `${ct.emoji} (custom)` : ct.emoji;
  const planLine = plan === 'paid' ? '⭐ paid' : `free${caps.postDelayMs > 0 ? ' — posts arrive 5s after the buy' : ''}`;

  return [
    // PHASE 9 — the section header. /settings now answers for two products (this one and the
    // per-user autotrader), and an unlabelled wall of commands is how a reader ends up trying
    // `/setmin` on their DCA. The CONTENT below is unchanged, deliberately: this is a heading, not
    // a rewrite, and a test pins the body byte for byte.
    '🍚 *BUY BOT* — what this group posts',
    '',
    `⚙️ *Settings for $${symbol}*${paused ? '  —  ⏸ *PAUSED*' : ''}`,
    `*Plan:* ${planLine}`,
    '',
    `*Token:* \`${ct.mint}\``,
    '`/setca <mint>` — track a different token',
    '',
    `*Post buys over:* ${usd(ct.minBuyUsd)}`,
    '`/setmin 25`',
    '',
    `*Tiers:* ${floorsSentence(ct)}`,
    '`/setfloors 10 250 1000` — Regular · Big · Massive (buy size)',
    '',
    whaleSentence(ct, symbol),
    '`/setwhale 10000` — the SOL+USDC wallet-value floor',
    '',
    `*Emoji:* ${emoji} — one per ${usd(ct.emojiStepUsd)}, up to ${ct.maxEmojis}`,
    '`/setemoji 🍚`  ·  `/setstep 10`  ·  `/setmaxemoji 100`',
    '',
    `*Media:* ${mediaLine}`,
    '`/mediamode pool|static|none`  ·  `/setmedia`  ·  `/mediastats`',
    '',
    `*Headlines:* \`/setheadline whale 🐳 A WHALE APPEARS\``,
    `*Buttons:* ${Object.keys(ct.links ?? {}).join(', ') || 'none'}`,
    '`/setlink trending https://…`  (empty url removes it)',
    '',
    '`/preview 20 50000` — see a whale card without waiting for a whale',
    '`/pause` · `/resume` · `/reset`',
  ].join('\n');
}

/**
 * PHASE 9 — the DCA BOT section of `/settings`.
 *
 * WHY IT EXISTS. The autotrader's commands were undiscoverable: every one of them is DM-only and
 * member-gated, and a member had no list to read. `/settings` was already the place people look for
 * "what can I type", so the two products are shown there together — labelled, because they have
 * different audiences and one of them spends money.
 *
 * WHO SEES IT IS NOT DECIDED HERE. This function renders; the caller decides whether to call it at
 * all, and calls it ONLY for a DM from an allowlisted member. That split matters: a section that
 * rendered itself with a "you may not use this" line would be exactly the oracle INVARIANT 14's
 * silence discipline exists to prevent — the absence of these lines is the refusal.
 *
 * IT LEADS WITH THE BANNERS, for the same reason the panel does (RULE A). Someone reading a command
 * list is about to type one of them; whether real money is at stake, and whether the bot is holding
 * a key that can spend it, are facts they need BEFORE the list, not after. Both strings are the
 * panel's own exports, so the two surfaces cannot word them differently.
 *
 * EVERY COMMAND HERE IS REGISTERED. Nothing is aspirational and nothing is renamed; the list is
 * pinned against the real handlers by test.
 */
export interface DcaSectionInput {
  /** TRADE_LIVE — whether a schedule firing spends real money. */
  readonly tradeLive: boolean;
  /** This user's custody mode: whether the bot holds a key for them. */
  readonly mode: TraderMode;
  /** Owner-only administration is listed, and labelled, only for the owner. */
  readonly isOwner: boolean;
}

export function dcaSectionMessage(input: DcaSectionInput): string {
  const lines: string[] = [
    '🤖 *DCA BOT* — your own autotrader, in this DM',
    input.tradeLive ? LIVE_BANNER : DRY_BANNER,
    modeBanner(input.mode),
    '',
  ];

  // WALLET MODE HAS NO KEY AND NO SCHEDULE OF OURS, so listing the custodial controls would be
  // listing things that will refuse. The panel makes the same split — a different panel, not the
  // custodial one with its buttons greyed out.
  if (input.mode === 'wallet') {
    lines.push(
      '*Your DCA runs in your own wallet.* I hold no key and schedule nothing for you.',
      '`/dca` — open the Mini App to create or cancel a recurring buy',
      '`/trade` — what I have seen your wallet do',
      '`/linksite` — one-time code to link this wallet to the website',
      '`/mode` — switch to key custody (I would then hold a key that can spend)',
    );
  } else {
    lines.push(
      '*Wallet*',
      '`/wallet` — show it  ·  `import` · `generate` · `export` · `lock`',
      '`/unlock` — unlock the key for this session',
      '`/mode` — who holds the key: your wallet, or mine',
      '',
      '*Schedules*',
      '`/trade` — the control panel (buttons for everything below)',
      '`/trade new buy 0.05 15` — buy 0.05 SOL every 15 min',
      '`/trade amount <id> 0.1`  ·  `/trade interval <id> 30`  ·  `/trade slippage <id> 100`',
      '`/trade caps 50 200` — per-trade and per-day dollar limits',
      '`/trade pause <id>`  ·  `/trade resume <id>`  ·  `/trade delete <id>`',
      '`/trade stop` — pause everything, now',
      '',
      '*After a trade*',
      '`/history` — recent executions  ·  `/history settings` — what you changed',
      '`/resolve <id> confirmed|failed` — the only exit from an UNKNOWN outcome',
      '',
      '*Elsewhere*',
      '`/dca` — open the Mini App',
      '`/linksite` — one-time code to link a wallet to the website',
    );
  }

  if (input.isOwner) {
    lines.push('', '`/trader add|remove|list|purge` — membership (owner only)');
  }

  return lines.join('\n');
}
