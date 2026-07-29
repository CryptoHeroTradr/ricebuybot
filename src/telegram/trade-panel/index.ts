import type { Bot, Context } from 'grammy';

import type { Mint } from '../../core/types.js';
import { scrub, type Logger } from '../../ops/logger.js';
import { AutotraderAccess, type AutotraderAccessRepo } from '../../trade/access.js';
import type { Caps, ExecutionRecord, Schedule } from '../../trade/scheduler.js';
import {
  applyResumeAll,
  applyStopAll,
  applySetContract,
  applyAmount,
  applyInterval,
  applySlippage,
  applyPause,
  applyResume,
  applyCaps,
  applyNew,
  dispatchTradeCommand,
  WALLET_MODE_REFUSAL,
  type ApplyResult,
  type PanelRepo,
} from './commands.js';
import { renderPanel, parseCb, type PanelData, type PanelVerb, type ScheduleView } from './render.js';
import { PanelSessions } from './session.js';
import { InputArbiter } from '../input-arbiter.js';

/**
 * PHASE 15 — the control surface. DM-only, member-gated at action time, and every view and action
 * scoped to the CALLING user's own wallet and schedules. A non-member gets no reply at all.
 *
 * Every button leads to a prompt; every completed prompt (and every typed command) re-renders the
 * WHOLE panel in place. STOP ALL is the one exception to "leads to a prompt": it is one tap, no
 * confirmation — a confirmation on an emergency stop is a design error.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRED = 'Panel expired — send /trade again.';
/** How many observed DCA fills the wallet-mode panel lists. A panel, not a statement. */
const WALLET_MODE_BUY_ROWS = 5;

/** Everything the panel reads. Superset of PanelRepo with the read-only bits gather needs. */
export interface TradePanelRepo extends PanelRepo {
  lastExecutionForSchedule(scheduleId: number): Promise<ExecutionRecord | null>;
  // PHASE 7 — the wallet-mode half of the panel. All three are READS; there is deliberately no
  // method here that could change an on-chain order, because the bot cannot sign one.
  /** The proven wallet a member linked, or null. */
  walletForUser(userId: number): Promise<string | null>;
  /** Observed DCA fills for that wallet, newest first. */
  recentWalletDcaBuys(wallet: string, mint: Mint, limit: number): Promise<readonly { tokensRaw: bigint; usdIn: number; at: number }[]>;
  usdSpent24h(userId: number, mint: Mint, sinceMs: number): Promise<number>;
  usdSpentLifetime(userId: number, mint: Mint): Promise<number>;
  getCaps(userId: number, mint: Mint): Promise<Caps | null>;
  listSettingChanges(userId: number, limit: number): Promise<readonly import('../../trade/audit.js').SettingChange[]>;
}

export interface TradePanelDeps {
  readonly repo: TradePanelRepo;
  readonly access: AutotraderAccessRepo;
  readonly keystore: { pubkeyOf(userId: number): string | null; isUnlocked(userId: number): boolean };
  readonly rpc: { getBalance(pubkey: string): Promise<bigint | null>; getTokenBalances(owner: string, mints: readonly string[]): Promise<Map<string, bigint>> };
  readonly meta: (mint: string) => Promise<{ symbol: string | null; decimals: number } | null>;
  readonly tradeLive: boolean;
  readonly defaultMint: string;
  /** PHASE 7 — where the DCA Mini App lives (cfg.SITE_URL). Absent = no launch button. */
  readonly miniAppUrl?: string | undefined;
  /** Env daily-cap ceiling — /trade caps refuses above it (the executor enforces it too). */
  readonly maxPerDayUsdCeiling?: number;
  /** Env lifetime-cap ceiling — /trade caps refuses a lifetime budget above it. */
  readonly maxLifetimeUsdCeiling?: number;
  /** Live SOL/USD, to refuse a below-$1 buy at creation time. Null when the feed is down. */
  readonly solUsd?: () => number | null;
  readonly log: Logger;
  /** THE shared DM input arbiter — one awaiting state per user across all handlers. */
  readonly arbiter: InputArbiter;
  readonly sessions?: PanelSessions;
  readonly now?: () => number;
}

const AWAIT_TTL_MS = 10 * 60_000;

/** STOP ALL is the ONE button that acts on a single tap — a confirmation on an emergency stop is a
 *  design error. Every other button leads to a prompt. */
const IMMEDIATE = new Set<PanelVerb>(['stop']);

export function registerTradePanel(bot: Bot, deps: TradePanelDeps): void {
  const { repo, keystore, rpc, log, arbiter } = deps;
  const access = new AutotraderAccess(deps.access, log);
  const sessions = deps.sessions ?? new PanelSessions(deps.now);
  const now = deps.now ?? Date.now;
  // How to drop our payload when the arbiter's /cancel releases the slot.
  arbiter.onCancel('panel', (uid: number) => sessions.clearAwaiting(uid));

  const isDm = (ctx: Context): boolean => ctx.chat?.type === 'private';

  /** DM + member, checked at ACTION TIME. Returns the user id, or null = REPLY NOTHING. */
  async function gate(ctx: Context): Promise<number | null> {
    const userId = ctx.from?.id ?? 0;
    if (!isDm(ctx)) return null;
    return (await access.check(userId)).allowed ? userId : null;
  }

  /**
   * PHASE 7 — a custodial action attempted from wallet mode.
   *
   * Every one of these edits a SCHEDULE THE BOT WOULD SIGN FOR, and in wallet mode there is no such
   * thing. The panel does not offer them, but the typed commands still exist and a button from a
   * panel opened before a mode switch is still in someone's chat history — so the check lives at
   * action time, next to the write, exactly like the membership gate above it.
   *
   * `contract` is the exception and stays reachable: it selects which token this user's view is
   * about, and it is ours, not theirs.
   */
  const CUSTODIAL_VERBS = new Set<PanelVerb>(['new', 'amount', 'interval', 'pause', 'resume', 'slippage', 'caps', 'stop', 'wallet']);

  async function contractOf(userId: number): Promise<Mint> {
    return (await repo.getContract(userId)) ?? (deps.defaultMint as Mint);
  }

  async function gather(userId: number, token: string): Promise<{ text: string; keyboard: ReturnType<typeof renderPanel>['keyboard'] }> {
    const contract = await contractOf(userId);
    const m = await deps.meta(contract).catch(() => null);
    const symbol = m?.symbol ? `$${m.symbol}` : contract.slice(0, 4);
    const decimals = m?.decimals ?? 6;
    const mode = await access.mode(userId);

    // PHASE 7 — wallet mode gathers a DIFFERENT set of facts, and none of the custodial ones.
    //
    // It does not read the keystore, does not hit the RPC for a balance we have no business
    // showing, and does not list schedules the bot would never fire. Skipping those reads is not an
    // optimisation: a panel that quietly went and looked up a wallet-mode user's key material would
    // contradict the sentence printed at the top of it.
    if (mode === 'wallet') {
      const linkedWallet = await repo.walletForUser(userId).catch(() => null);
      const recentBuys = linkedWallet
        ? await repo.recentWalletDcaBuys(linkedWallet, contract, WALLET_MODE_BUY_ROWS).catch(() => [])
        : [];
      return renderPanel(
        {
          tradeLive: deps.tradeLive,
          mode,
          walletMode: { linkedWallet, recentBuys, miniAppUrl: deps.miniAppUrl },
          symbol,
          mint: contract,
          pubkey: null,
          walletUnlocked: false,
          solBalance: null,
          tokenBalance: null,
          tokenDecimals: decimals,
          schedules: [],
          spentTodayUsd: 0,
          spentLifetimeUsd: 0,
          caps: null,
          now: now(),
        },
        token,
      );
    }

    const pubkey = keystore.pubkeyOf(userId);
    const [solBalance, tokenMap, schedules, caps, spent, spentLifetime] = await Promise.all([
      pubkey ? rpc.getBalance(pubkey).catch(() => null) : Promise.resolve(null),
      pubkey ? rpc.getTokenBalances(pubkey, [contract]).catch(() => new Map<string, bigint>()) : Promise.resolve(new Map<string, bigint>()),
      repo.listSchedules(userId),
      repo.getCaps(userId, contract),
      repo.usdSpent24h(userId, contract, now() - DAY_MS),
      repo.usdSpentLifetime(userId, contract),
    ]);
    const views: ScheduleView[] = await Promise.all(
      schedules.map(async (s: Schedule) => ({ schedule: s, last: await repo.lastExecutionForSchedule(s.id) })),
    );
    const data: PanelData = {
      tradeLive: deps.tradeLive,
      mode,
      symbol,
      mint: contract,
      pubkey,
      walletUnlocked: pubkey ? keystore.isUnlocked(userId) : false,
      solBalance,
      tokenBalance: pubkey ? (tokenMap.get(contract) ?? 0n) : null,
      tokenDecimals: decimals,
      schedules: views,
      spentTodayUsd: spent,
      spentLifetimeUsd: spentLifetime,
      caps: caps
        ? { perExecUsd: caps.maxPerExecUsd, perDayUsd: caps.maxPerDayUsd, lifetimeUsd: caps.maxLifetimeUsd }
        : null,
      now: now(),
    };
    return renderPanel(data, token);
  }

  /** Open a fresh panel and SEND it as a new message. Used by /trade and every typed command. */
  async function sendPanel(ctx: Context, userId: number, note?: string): Promise<void> {
    const panel = sessions.open(userId);
    const { text, keyboard } = await gather(userId, panel.token);
    // scrub() is a BACKSTOP: apply* never echoes raw input, but a note is a place where anything
    // could one day end up, so a secret-shaped token would be redacted before it is ever sent.
    const body = note ? `${scrub(note)}\n\n${text}` : text;
    const sent = await ctx.reply(body, { reply_markup: { inline_keyboard: keyboard } });
    sessions.setMessageId(panel.token, sent.message_id);
  }

  /** Re-render an existing panel IN PLACE (editMessageText). The one-message rule. */
  async function editPanel(ctx: Context, token: string, userId: number, chatId: number, messageId: number, note?: string): Promise<void> {
    const { text, keyboard } = await gather(userId, token);
    const body = note ? `${scrub(note)}\n\n${text}` : text; // scrub() backstop — never echo a stray secret
    await ctx.api.editMessageText(chatId, messageId, body, { reply_markup: { inline_keyboard: keyboard } }).catch((e: unknown) => {
      // "message is not modified" and the like are non-fatal — the panel already shows current state.
      log.debug({ err: e instanceof Error ? e.message : String(e) }, 'panel edit skipped');
    });
  }

  /**
   * /stop IN A DM — the emergency brake. THE SAME halt as `/trade stop` and the STOP ALL button:
   * all three call `applyStopAll`, so they cannot diverge. No confirmation (confirm on START, never
   * on STOP), and the panel is re-rendered so the user SEES the halted state rather than being told.
   *
   * A non-member gets no reply at all — the same silence discipline as every other autotrader
   * surface; a refusal would confirm the autotrader exists.
   */
  arbiter.onDmStop(async (ctx: Context, userId: number) => {
    if (!(await access.check(userId)).allowed) return; // silence
    const active = (await repo.listSchedules(userId)).filter((s) => s.state === 'active').length;
    if (active === 0) {
      // Not silence and not a bare ok — someone typing this word is anxious and needs to know the
      // system heard them.
      await ctx.reply('No active schedules to stop.');
      return;
    }
    await applyStopAll(repo, userId);
    await sendPanel(ctx, userId, `🛑 Stopped ${active} schedule(s). ▶️ Resume when ready.`);
  });

  // ---------------------------------------------------------------------------
  // /trade — the panel, and every typed subcommand
  // ---------------------------------------------------------------------------
  bot.command('trade', async (ctx) => {
    const userId = await gate(ctx);
    if (userId === null) return; // silence
    const args = (ctx.match ?? '').toString().trim();
    if (args === '') return void sendPanel(ctx, userId);

    // A wallet-mode user gets the panel, not a scheduler edit. Checked before the dispatcher so no
    // custodial write is even attempted.
    if ((await access.mode(userId)) === 'wallet') {
      return void sendPanel(ctx, userId, WALLET_MODE_REFUSAL);
    }

    const tokens = args.split(/\s+/);
    // stop and the id-taking subcommands all funnel through the shared dispatcher, THEN re-render.
    const contract = await contractOf(userId);
    const r = await dispatchTradeCommand(repo, userId, contract, tokens, now(), deps.maxPerDayUsdCeiling ?? Infinity, deps.maxLifetimeUsdCeiling ?? Infinity, deps.solUsd?.() ?? null);
    await sendPanel(ctx, userId, r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`);
  });

  // /setca <mint> — change the contract: halts schedules, then re-renders the panel.
  bot.command('setca', async (ctx) => {
    const userId = await gate(ctx);
    if (userId === null) return;
    const mint = (ctx.match ?? '').toString().trim();
    const r = await applySetContract(repo, userId, mint);
    await sendPanel(ctx, userId, r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`);
  });

  // /history [n]            — YOUR last n executions, with signatures.
  // /history settings [n]   — YOUR last n setting changes (the audit trail: what/from/to/when).
  // User-scoped throughout; no other user's rows are ever readable.
  bot.command('history', async (ctx) => {
    const userId = await gate(ctx);
    if (userId === null) return;
    const arg = (ctx.match ?? '').toString().trim();
    const [head, ...rest] = arg.split(/\s+/);

    if (head === 'settings') {
      const n = Math.min(Math.max(Number(rest[0]) || 10, 1), 50);
      const changes = await repo.listSettingChanges(userId, n);
      if (changes.length === 0) return void ctx.reply('No setting changes recorded yet.');
      const lines = changes.map((c) => {
        const when = new Date(c.at).toISOString().replace('T', ' ').slice(0, 16);
        const target = c.scheduleId != null ? ` #${c.scheduleId}` : '';
        const move = c.fromValue != null && c.toValue != null ? `: ${c.fromValue} → ${c.toValue}`
          : c.toValue != null ? `: ${c.toValue}`
          : c.fromValue != null ? `: was ${c.fromValue}`
          : '';
        return `${when}  ${c.action}${target}${move}`;
      });
      return void ctx.reply([`Your last ${changes.length} setting changes:`, '', ...lines].join('\n'));
    }

    const n = Math.min(Math.max(Number(head) || 10, 1), 50);
    const rows = await repo.listExecutionsForUser(userId, n);
    if (rows.length === 0) return void ctx.reply('No executions yet.');
    const lines = rows.map((e) => {
      const when = new Date(e.plannedAt).toISOString().replace('T', ' ').slice(0, 16);
      const sig = e.signature ? `${e.signature.slice(0, 8)}…` : '—';
      const usd = e.usdValue != null ? ` $${e.usdValue.toFixed(2)}` : '';
      return `${when}  ${e.state}${usd}  ${sig}`;
    });
    await ctx.reply([`Your last ${rows.length} executions:`, '', ...lines].join('\n'));
  });

  // ---------------------------------------------------------------------------
  // buttons
  // ---------------------------------------------------------------------------
  bot.on('callback_query:data', async (ctx, next) => {
    const parsed = parseCb(ctx.callbackQuery.data);
    if (!parsed) return next(); // not a panel callback — let other handlers (curation) try

    const userId = ctx.from.id;
    const panel = sessions.panel(parsed.token, userId);
    if (panel === null) return void ctx.answerCallbackQuery({ text: EXPIRED });
    if (panel === 'expired') return void ctx.answerCallbackQuery({ text: EXPIRED, show_alert: true });
    // Re-check membership at action time — a revoked member's buttons go dead, silently.
    if (!(await access.check(userId)).allowed) return void ctx.answerCallbackQuery().catch(() => {});

    const verb = parsed.verb as PanelVerb;
    // A button tapped from a panel that was rendered BEFORE a switch to wallet mode. Refuse the
    // action and re-render, so the panel they are looking at stops being out of date.
    if (CUSTODIAL_VERBS.has(verb) && (await access.mode(userId)) === 'wallet') {
      await ctx.answerCallbackQuery({ text: 'Wallet mode — nothing here for me to change.', show_alert: true }).catch(() => {});
      const chat = ctx.chat?.id;
      const msg = panel.messageId ?? ctx.callbackQuery.message?.message_id ?? null;
      if (chat !== undefined && msg !== null) await editPanel(ctx, panel.token, userId, chat, msg, WALLET_MODE_REFUSAL);
      return;
    }
    const chatId = ctx.chat?.id;
    const messageId = panel.messageId ?? ctx.callbackQuery.message?.message_id ?? null;
    await ctx.answerCallbackQuery().catch(() => {});
    if (chatId === undefined || messageId === null) return;

    if (verb === 'stop') {
      // The one no-prompt action: halt everything in a single tap.
      await applyStopAll(repo, userId);
      return void editPanel(ctx, panel.token, userId, chatId, messageId, '🛑 Stopped all schedules.');
    }
    if (verb === 'wallet') {
      return void ctx.reply('Manage your wallet with /wallet (import, generate, lock, unlock). Changing it halts your schedules.');
    }

    // Everything else prompts for input. Take the ONE input slot first — refused if /wallet import
    // is mid-flow (a key is awaited), so a settings prompt can never intercept a secret key.
    const claim = arbiter.acquire(userId, 'panel', { ttlMs: AWAIT_TTL_MS });
    if (!claim.ok) {
      return void ctx.reply(`Finish your ${claim.heldLabel} first, or send /cancel to drop it — then tap again.`);
    }
    sessions.startAwaiting(userId, verb, panel.token);
    const prefix = claim.cancelled ? `(cancelled the pending ${claim.cancelled})\n` : '';
    await ctx.reply(prefix + (PROMPTS[verb] ?? 'Send the value:'));
  });

  // ---------------------------------------------------------------------------
  // awaiting-input replies (the completion of a button prompt)
  // ---------------------------------------------------------------------------
  bot.on('message:text', async (ctx, next) => {
    const userId = ctx.from?.id ?? 0;
    // ROUTING BY THE ARBITER, not by handler order: process only if WE hold the input slot. While a
    // /wallet key is awaited the slot is the wallet's, so this handler never sees the key message.
    if (!arbiter.owns(userId, 'panel')) return next();
    const awaiting = sessions.takeAwaiting(userId);
    arbiter.release(userId, 'panel');
    if (!awaiting) return next();
    if (!isDm(ctx) || !(await access.check(userId)).allowed) return; // silence
    const panel = sessions.panel(awaiting.token, userId);
    if (!panel || panel === 'expired' || panel.messageId === null) return void ctx.reply(EXPIRED);

    const text = ctx.message.text.trim();
    const contract = await contractOf(userId);
    const r = await completePrompt(repo, userId, awaiting.verb, text, contract, now(), deps.maxPerDayUsdCeiling ?? Infinity, deps.maxLifetimeUsdCeiling ?? Infinity, deps.solUsd?.() ?? null);

    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      await editPanel(ctx, awaiting.token, userId, chatId, panel.messageId, r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`);
    }
  });
}

const PROMPTS: Partial<Record<PanelVerb, string>> = {
  new: 'New schedule — send: <side> <amount> <interval>\ne.g.  buy 0.05 15   or   sell 10% 240',
  amount: 'Send the new amount (e.g. 0.05 or 10%). With more than one schedule: <id> <amount>.',
  interval: 'Send the new interval in minutes (e.g. 15). With more than one schedule: <id> <minutes>.',
  slippage: 'Send slippage in bps (e.g. 100 = 1%). With more than one schedule: <id> <bps>.',
  pause: "Send a schedule id to pause, or 'all'.",
  resume: "Send a schedule id to resume, or 'all'.",
  caps: 'Send caps: <per-trade $> <daily $>   e.g.  50 200',
  contract: 'Send the new contract mint address. This halts your schedules.',
};

/**
 * Turn a button prompt's reply into an action. Handles the single-schedule shorthand: with exactly
 * one schedule, `amount`/`interval`/`slippage`/`pause`/`resume` accept the bare value (no id). The
 * validate-before-write ownership check still happens inside every apply*.
 */
export async function completePrompt(
  repo: PanelRepo, userId: number, verb: PanelVerb, text: string, contract: Mint, now: number,
  maxPerDayUsdCeiling = Infinity, maxLifetimeUsdCeiling = Infinity, solUsd: number | null = null,
): Promise<ApplyResult> {
  const parts = text.split(/\s+/).filter(Boolean);
  const schedules = await repo.listSchedules(userId);
  const soleId = schedules.length === 1 ? schedules[0]!.id : null;

  // For per-schedule verbs, resolve <id> <value> — or, with one schedule, just <value>.
  const idAndValue = (): { id: number; value: string } => {
    if (parts.length >= 2) return { id: Number(parts[0]), value: parts.slice(1).join(' ') };
    return { id: soleId ?? NaN, value: parts[0] ?? '' };
  };

  switch (verb) {
    case 'new': {
      return applyNew(repo, userId, contract, parts[0] ?? '', parts[1] ?? '', parts[2] ?? '', now, solUsd);
    }
    case 'amount': {
      const { id, value } = idAndValue();
      return applyAmount(repo, userId, id, value);
    }
    case 'interval': {
      const { id, value } = idAndValue();
      return applyInterval(repo, userId, id, value);
    }
    case 'slippage': {
      const { id, value } = idAndValue();
      return applySlippage(repo, userId, id, value);
    }
    case 'pause': {
      if (parts[0] === 'all') return applyStopAll(repo, userId);
      return applyPause(repo, userId, Number(parts[0] ?? soleId ?? NaN));
    }
    case 'resume': {
      if (parts[0] === 'all') return applyResumeAll(repo, userId);
      return applyResume(repo, userId, Number(parts[0] ?? soleId ?? NaN));
    }
    case 'caps': {
      return applyCaps(repo, userId, contract, parts[0] ?? '', parts[1] ?? '', parts[2] ?? '', maxPerDayUsdCeiling, maxLifetimeUsdCeiling);
    }
    case 'contract': {
      return applySetContract(repo, userId, parts[0] ?? '');
    }
    default:
      return { ok: false, message: 'Nothing to do.' };
  }
}

// Re-exports so the boot wiring and tests import from one place.
export { PanelSessions } from './session.js';
export { renderPanel, parseCb, cb } from './render.js';
export * from './commands.js';
