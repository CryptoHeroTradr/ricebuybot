import type { Bot, Context } from 'grammy';

import type { Logger } from '../ops/logger.js';
import { AutotraderAccess, isOwner, type AutotraderAccessRepo } from '../trade/access.js';
import { Keystore, KeystoreError } from '../trade/keystore.js';
import { decodeBase58, looksLikeSecretKey } from '../trade/base58.js';
import { fetchInventory, exposureWarning, importValueWarning, renderWallet, shortPubkey, type WalletRpc } from '../trade/wallet.js';
import { unlockModeFor, type UnlockConfig } from '../trade/unlock.js';
import { InputArbiter } from './input-arbiter.js';

/**
 * THE AUTOTRADER'S TELEGRAM SURFACE.
 *
 * Two rules govern every handler in this file.
 *
 * 1. A NON-MEMBER GETS NO REPLY (INVARIANT 14). Not a refusal — nothing. `guard()` returns
 *    null and the handler returns. A refusal is an oracle: it confirms the autotrader exists
 *    and that there is a list, which is exactly what probing is for. Silence is what the bot
 *    already does for an unknown command, so the two are indistinguishable.
 *
 * 2. NOBODY SEES ANYONE ELSE'S WALLET. Every handler resolves its subject as `ctx.from.id` and
 *    there is no parameter anywhere that names a different user's wallet, balance, pubkey or
 *    key. The owner's `/trader` commands take a user id — but they administer MEMBERSHIP, and
 *    the only one that touches a key destroys it (`purge`) and says so to its owner.
 */

/** Passphrases and secret keys arrive as ordinary messages, so we must know what we asked for. */
type Pending =
  | { readonly kind: 'import-ack' }
  | { readonly kind: 'import-secret' }
  | { readonly kind: 'import-passphrase'; readonly secret: Buffer }
  | { readonly kind: 'unlock' }
  | { readonly kind: 'export-confirm' }
  | { readonly kind: 'export-passphrase' }
  | { readonly kind: 'generate-passphrase' }
  | { readonly kind: 'purge-confirm'; readonly target: number };

export interface TradeCommandDeps {
  readonly repo: AutotraderAccessRepo;
  readonly keystore: Keystore;
  readonly rpc: WalletRpc;
  readonly log: Logger;
  readonly unlockConfig: UnlockConfig;
  readonly primaryMint: string;
  readonly primarySymbol: string;
  /** Pause every schedule for one user. Phase 13 owns schedules; this is the hook. */
  readonly pauseSchedules: (userId: number) => Promise<void>;
  /**
   * The wallet CHANGED (a new key imported or generated). Phase 15: this HALTS the user's schedules
   * and requires an explicit resume — the wallet is what the money moves from, and a schedule must
   * never silently continue against a new one. Returns how many were halted (for the message).
   */
  readonly onWalletChanged?: (userId: number) => Promise<number>;
  /** The shared DM input arbiter — one awaiting state per user across all handlers. */
  readonly arbiter: InputArbiter;
}

const ACK_PHRASE = 'I UNDERSTAND';
const PURGE_PHRASE = 'DESTROY THIS KEY';

export function registerTradeCommands(bot: Bot, deps: TradeCommandDeps): void {
  const { repo, keystore, rpc, log, unlockConfig } = deps;
  const access = new AutotraderAccess(repo, log);

  /** userId -> what we are waiting for. In memory: a conversation, not a setting. */
  const pending = new Map<number, Pending>();

  // THE SINGLE INPUT SLOT. Every wallet awaiting-state is PROTECTED — while one is open (a key,
  // a passphrase, a typed confirmation is expected), no other DM handler may take the slot, so the
  // secret can never be claimed and echoed by the amount/curation handlers. setPending returns the
  // label of any curation/panel prompt it displaced, so the caller can say what was cancelled.
  const PENDING_TTL_MS = 10 * 60_000;
  const setPending = (uid: number, state: Pending): string | null => {
    pending.set(uid, state);
    const r = deps.arbiter.acquire(uid, 'wallet', { protected: true, ttlMs: PENDING_TTL_MS });
    return r.ok ? r.cancelled : null;
  };
  const clearPending = (uid: number): void => {
    pending.delete(uid);
    deps.arbiter.release(uid, 'wallet');
  };

  const userIdOf = (ctx: Context): number => ctx.from?.id ?? 0;
  const isDm = (ctx: Context): boolean => ctx.chat?.type === 'private';

  /**
   * THE GATE. Returns the user id, or null — and null means REPLY NOTHING.
   *
   * Also refuses outside a DM, silently. An autotrader command typed in a group would
   * otherwise confirm to the whole group that the person is a member.
   */
  async function guard(ctx: Context): Promise<number | null> {
    const userId = userIdOf(ctx);
    if (!isDm(ctx)) return null;
    const verdict = await access.check(userId);
    return verdict.allowed ? userId : null;
  }

  async function showWallet(ctx: Context, userId: number): Promise<void> {
    const pubkey = keystore.pubkeyOf(userId);
    if (pubkey === null) {
      await ctx.reply(
        ['No wallet yet.', '', '/wallet generate — a fresh one (lowest exposure)', '/wallet import — bring your own'].join('\n'),
      );
      return;
    }
    const inv = await fetchInventory(rpc, pubkey, deps.primaryMint, deps.primarySymbol);
    await ctx.reply(
      renderWallet(inv, { unlocked: keystore.isUnlocked(userId), mode: unlockModeFor(unlockConfig, userId) }),
    );
  }

  /**
   * Delete a message that contained a secret, and be LOUD if we cannot.
   *
   * A failed deletion is not a cosmetic problem: the key is sitting in Telegram's history, on
   * Telegram's servers, in that chat's backup. The only honest response is to tell the person
   * their key must now be treated as compromised — quietly succeeding-ish is how somebody ends
   * up trusting a key that is effectively public.
   */
  async function deleteSecretMessage(ctx: Context, what: string): Promise<boolean> {
    const messageId = ctx.message?.message_id;
    if (messageId === undefined) return false;
    try {
      await ctx.api.deleteMessage(ctx.chat?.id as number, messageId);
      return true;
    } catch (err) {
      log.error({ userId: userIdOf(ctx), err: (err as Error).message }, 'autotrader: could not delete a message containing a secret');
      await ctx.reply(
        [
          `🚨 I COULD NOT DELETE YOUR ${what}.`,
          '',
          "It is still in this chat's history, which means it is on Telegram's",
          'servers and outside my control. Treat that key as COMPROMISED:',
          'move the funds to a new wallet and import that one instead.',
          '',
          'Delete the message yourself as well — it does not undo the exposure,',
          'but it limits who else can read it.',
        ].join('\n'),
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------
  // /trader — OWNER ONLY. Membership administration, never anyone's money.
  // ---------------------------------------------------------------------------------------
  bot.command('trader', async (ctx) => {
    const userId = userIdOf(ctx);
    // A non-owner gets silence, same reasoning as a non-member.
    if (!isDm(ctx) || !isOwner(unlockConfig.ownerUserId, userId)) return;

    const [sub, arg, ...rest] = (ctx.match?.toString() ?? '').trim().split(/\s+/);
    const target = Number(arg);

    switch (sub) {
      case 'add': {
        if (!Number.isInteger(target) || target <= 0) {
          await ctx.reply('Usage: /trader add <user_id> <label>');
          return;
        }
        await access.add(target, rest.join(' ') || null, userId);
        await ctx.reply(`✅ ${target} added to the autotrader allowlist.`);
        return;
      }

      case 'remove': {
        if (!Number.isInteger(target) || target <= 0) {
          await ctx.reply('Usage: /trader remove <user_id>');
          return;
        }
        // REVOKE, not destroy (INVARIANT 14): pause, lock the live key, keep the file.
        await access.remove(target, userId);
        await deps.pauseSchedules(target);
        keystore.lock(target);
        await ctx.reply(
          [
            `✅ ${target} removed. Their schedules are paused and their wallet is locked.`,
            '',
            'Their keystore is NOT deleted — it is their key. Use',
            '/trader purge to destroy it, which is a separate decision.',
          ].join('\n'),
        );
        return;
      }

      case 'purge': {
        if (!Number.isInteger(target) || target <= 0) {
          await ctx.reply('Usage: /trader purge <user_id>');
          return;
        }
        {
        const cancelled = setPending(userId, { kind: 'purge-confirm', target });
        if (cancelled) await ctx.reply(`(cancelled the pending ${cancelled})`);
      }
        await ctx.reply(
          [
            `⚠️ This DESTROYS ${target}'s encrypted key. It cannot be recovered.`,
            '',
            'If they have funds in that wallet and no backup of the secret,',
            'those funds are gone permanently.',
            '',
            `Type exactly:  ${PURGE_PHRASE}`,
          ].join('\n'),
        );
        return;
      }

      case 'list': {
        const members = await access.list();
        if (members.length === 0) {
          await ctx.reply('Allowlist is empty.');
          return;
        }
        const lines = members.map((m) => {
          const has = keystore.has(m.userId) ? (keystore.isUnlocked(m.userId) ? 'unlocked' : 'locked') : 'no wallet';
          return `${m.locked ? '⛔' : '•'} ${m.userId}${m.label ? ` — ${m.label}` : ''}  (${has})`;
        });
        // Membership and wallet STATE only. No pubkeys, no balances: administering the list
        // is not a licence to look at what is in people's wallets.
        await ctx.reply(['Autotrader allowlist:', '', ...lines].join('\n'));
        return;
      }

      default:
        await ctx.reply('Usage: /trader add|remove|purge|list');
    }
  });

  // ---------------------------------------------------------------------------------------
  // /wallet
  // ---------------------------------------------------------------------------------------
  bot.command('wallet', async (ctx) => {
    const userId = await guard(ctx);
    if (userId === null) return; // SILENCE

    const sub = (ctx.match?.toString() ?? '').trim().split(/\s+/)[0] ?? '';

    switch (sub) {
      case '':
        await showWallet(ctx, userId);
        return;

      case 'import': {
        // The warning comes BEFORE the key, and an acknowledgement is required. A person who
        // has already pasted their secret has already taken the risk; asking afterwards is
        // theatre.
        {
        const cancelled = setPending(userId, { kind: 'import-ack' });
        if (cancelled) await ctx.reply(`(cancelled the pending ${cancelled})`);
      }
        await ctx.reply(
          [
            'Before you send a key, read this:',
            '',
            exposureWarning(),
            '',
            `If you accept that, reply exactly:  ${ACK_PHRASE}`,
          ].join('\n'),
        );
        return;
      }

      case 'generate': {
        if (keystore.has(userId)) {
          await ctx.reply('You already have a wallet. /wallet export it first if you want to keep it.');
          return;
        }
        {
        const cancelled = setPending(userId, { kind: 'generate-passphrase' });
        if (cancelled) await ctx.reply(`(cancelled the pending ${cancelled})`);
      }
        await ctx.reply('Send a passphrase for your new wallet. It encrypts your key and I never store it.');
        return;
      }

      case 'export': {
        if (!keystore.has(userId)) {
          await ctx.reply('No wallet to export.');
          return;
        }
        {
        const cancelled = setPending(userId, { kind: 'export-confirm' });
        if (cancelled) await ctx.reply(`(cancelled the pending ${cancelled})`);
      }
        await ctx.reply(
          ['⚠️ This reveals your secret key in this chat.', '', `Type exactly:  ${ACK_PHRASE}`].join('\n'),
        );
        return;
      }

      case 'lock': {
        keystore.lock(userId);
        await deps.pauseSchedules(userId);
        await ctx.reply('🔒 Wallet locked and your schedules are paused. /wallet unlock to resume.');
        return;
      }

      case 'unlock': {
        if (!keystore.has(userId)) {
          await ctx.reply('No wallet yet.');
          return;
        }
        {
          const cancelled = setPending(userId, { kind: 'unlock' });
          if (cancelled) await ctx.reply(`(cancelled the pending ${cancelled})`);
        }
        await ctx.reply('Send your passphrase. I will delete the message immediately.');
        return;
      }

      default:
        await ctx.reply('Usage: /wallet [import|generate|export|lock|unlock]');
    }
  });

  bot.command('unlock', async (ctx) => {
    const userId = await guard(ctx);
    if (userId === null) return;
    if (!keystore.has(userId)) return;
    {
      const cancelled = setPending(userId, { kind: 'unlock' });
      if (cancelled) await ctx.reply(`(cancelled the pending ${cancelled})`);
    }
    await ctx.reply('Send your passphrase. I will delete the message immediately.');
  });

  // ---------------------------------------------------------------------------------------
  // The reply handler: passphrases, secrets and typed confirmations all arrive here.
  // ---------------------------------------------------------------------------------------
  bot.on('message:text', async (ctx, next) => {
    const userId = userIdOf(ctx);
    const state = pending.get(userId);
    if (!state || !isDm(ctx)) return next();

    // Owner purge confirmation is the one flow not gated on membership — the owner is
    // administering, and the target may already have been removed.
    if (state.kind === 'purge-confirm') {
      clearPending(userId);
      if (!isOwner(unlockConfig.ownerUserId, userId)) return;
      if (ctx.message.text.trim() !== PURGE_PHRASE) {
        await ctx.reply('Not purged.');
        return;
      }
      const destroyed = keystore.purge(state.target);
      await access.purge(state.target, userId);
      await deps.pauseSchedules(state.target);
      await ctx.reply(destroyed ? `🗑 ${state.target}'s key destroyed.` : `${state.target} had no keystore.`);
      // The person whose key it was is TOLD. Destroying someone's key silently is not on.
      try {
        await ctx.api.sendMessage(
          state.target,
          'Your RiceBuybot autotrader key has been deleted by the operator and your schedules are stopped. If you hold funds in that wallet, you need your own backup of the secret to reach them.',
        );
      } catch {
        log.warn({ userId: state.target }, 'autotrader: could not notify user of purge');
      }
      return;
    }

    if (!(await access.check(userId)).allowed) return next(); // silence

    switch (state.kind) {
      case 'import-ack': {
        if (ctx.message.text.trim() !== ACK_PHRASE) {
          clearPending(userId);
          await ctx.reply('Not acknowledged — nothing imported.');
          return;
        }
        setPending(userId, { kind: 'import-secret' });
        await ctx.reply('Send your base58 secret key. I will delete the message the moment I read it.');
        return;
      }

      case 'import-secret': {
        const text = ctx.message.text.trim();
        const deleted = await deleteSecretMessage(ctx, 'SECRET KEY');

        if (!looksLikeSecretKey(text)) {
          clearPending(userId);
          // Never quote the input back — it may be a real key with a typo.
          await ctx.reply("That doesn't look like a base58 secret key. Nothing imported.");
          return;
        }
        setPending(userId, { kind: 'import-passphrase', secret: Buffer.from(decodeBase58(text)) });
        await ctx.reply(
          [
            deleted ? '✅ Key received and your message deleted.' : '⚠️ Key received.',
            '',
            'Now send a passphrase to encrypt it with. I never store the passphrase,',
            'so if you lose it the key is unrecoverable from this server.',
          ].join('\n'),
        );
        return;
      }

      case 'import-passphrase': {
        const passphrase = ctx.message.text;
        await deleteSecretMessage(ctx, 'PASSPHRASE');
        clearPending(userId);

        try {
          const pubkey = keystore.import(userId, state.secret, passphrase, { overwrite: true });
          keystore.unlock(userId, passphrase);

          const halted = (await deps.onWalletChanged?.(userId)) ?? 0;
          const inv = await fetchInventory(rpc, pubkey, deps.primaryMint, deps.primarySymbol);
          const extra = importValueWarning(inv);

          await ctx.reply(
            [
              `✅ Wallet imported — ${shortPubkey(pubkey)}`,
              ...(halted > 0 ? [`⚠️ ${halted} schedule(s) HALTED — the wallet changed. ▶️ Resume when ready.`] : []),
              '',
              renderWallet(inv, { unlocked: true, mode: unlockModeFor(unlockConfig, userId) }),
              ...(extra ? ['', extra] : []),
            ].join('\n'),
          );
          log.info({ userId }, 'autotrader: wallet imported');
        } catch (err) {
          await ctx.reply(`Import failed: ${err instanceof KeystoreError ? err.message : 'invalid key'}`);
        } finally {
          state.secret.fill(0); // the plaintext never outlives this handler
        }
        return;
      }

      case 'generate-passphrase': {
        const passphrase = ctx.message.text;
        await deleteSecretMessage(ctx, 'PASSPHRASE');
        clearPending(userId);

        const { pubkey, secretBase58 } = keystore.generate(userId, passphrase, { overwrite: false });
        keystore.unlock(userId, passphrase);
        const haltedGen = (await deps.onWalletChanged?.(userId)) ?? 0;

        // SHOWN EXACTLY ONCE. There is no command that will ever print it again except
        // /wallet export, which requires the passphrase.
        await ctx.reply(
          [
            `✅ New wallet — ${shortPubkey(pubkey)}`,
            ...(haltedGen > 0 ? [`⚠️ ${haltedGen} schedule(s) HALTED — the wallet changed. ▶️ Resume when ready.`] : []),
            '',
            'SAVE THIS SECRET KEY NOW. It will not be shown again:',
            '',
            secretBase58,
            '',
            'A fresh wallet is the low-exposure option: fund it with only what',
            "you'd accept losing, and nothing else is at risk here.",
          ].join('\n'),
        );
        log.info({ userId }, 'autotrader: wallet generated');
        return;
      }

      case 'export-confirm': {
        if (ctx.message.text.trim() !== ACK_PHRASE) {
          clearPending(userId);
          await ctx.reply('Not exported.');
          return;
        }
        setPending(userId, { kind: 'export-passphrase' });
        await ctx.reply('Send your passphrase.');
        return;
      }

      case 'export-passphrase': {
        const passphrase = ctx.message.text;
        await deleteSecretMessage(ctx, 'PASSPHRASE');
        clearPending(userId);

        try {
          const secret = keystore.exportSecret(userId, passphrase);
          // THAT it happened is logged; the key never is.
          log.warn({ userId }, 'autotrader: secret key EXPORTED by its owner');
          const sent = await ctx.reply(`${secret}\n\nDelete this message once you have saved it.`);
          // Best-effort self-delete. The user was told to delete it too, because a
          // self-deleting message that fails silently is a key left in a chat.
          setTimeout(() => {
            void ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {
              log.warn({ userId }, 'autotrader: exported-key message could not be auto-deleted');
            });
          }, 60_000).unref?.();
        } catch {
          await ctx.reply('Wrong passphrase.');
        }
        return;
      }

      case 'unlock': {
        const passphrase = ctx.message.text;
        await deleteSecretMessage(ctx, 'PASSPHRASE');
        clearPending(userId);

        try {
          keystore.unlock(userId, passphrase);
          await ctx.reply('🔓 Wallet unlocked. Schedules resume on their next tick.');
          log.info({ userId }, 'autotrader: wallet unlocked');
        } catch {
          // Same message whichever way it failed — do not tell a guesser what they got right.
          await ctx.reply('Wrong passphrase.');
        }
        return;
      }
    }
  });
}
