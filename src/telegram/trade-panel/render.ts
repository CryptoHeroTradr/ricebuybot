import { lamportsToSol, rawAmount, toFloat } from '../../core/money.js';
import type { ExecutionRecord, Schedule } from '../../trade/scheduler.js';
import type { TraderMode } from '../../trade/mode.js';

/**
 * PHASE 15 — the control panel, rendered. PURE: (data, token) -> { text, keyboard }. No I/O, no
 * clock of its own — everything it shows is passed in, so it is exhaustively testable.
 *
 * RULE A (the one that has bitten): the FIRST line says whether money is at stake. TRADE_LIVE is
 * separate from DRY_RUN, so the panel must never make anyone INFER the mode from an absent warning
 * — absence of a warning is not a signal. 🔴 LIVE or 🟡 DRY RUN, unmissable, at the top.
 */

export interface CallbackButton {
  readonly text: string;
  readonly callback_data: string;
}

/**
 * The Mini App launcher (Phase 8) — a button that OPENS something instead of calling back.
 *
 * `web_app`, not `url`, and the difference is load-bearing: a `web_app` button opens the page
 * inside Telegram's own webview and hands it a signed `initData`, which is the only way the page
 * can prove to the bot which Telegram user is looking at it. A plain `url` button opens a browser
 * with no identity attached, and the Mini App would have no way to know whose orders to show.
 *
 * A separate type from CallbackButton rather than an optional field on it, so the callback handler
 * cannot be handed one by mistake: this button never produces a callback_query, and a button that
 * silently does nothing is the most confusing failure a panel can have.
 */
export interface MiniAppButton {
  readonly text: string;
  readonly web_app: { readonly url: string };
}

export type PanelButton = CallbackButton | MiniAppButton;

export interface ScheduleView {
  readonly schedule: Schedule;
  readonly last: ExecutionRecord | null;
}

/** PHASE 7 — what the wallet-mode panel shows instead of schedules, caps and buttons. */
export interface WalletModeData {
  /** The address the user PROVED they own (Phase 6 signature), or null if they have not linked. */
  readonly linkedWallet: string | null;
  /** Observed on-chain DCA fills for that wallet, newest first. NOT their open Jupiter orders. */
  readonly recentBuys: readonly { readonly tokensRaw: bigint; readonly usdIn: number; readonly at: number }[];
  /** Where the Mini App lives. Absent = no launch button (SITE_URL unset). */
  readonly miniAppUrl?: string | undefined;
}

export interface PanelData {
  readonly tradeLive: boolean;
  /**
   * PHASE 7 — WHO HOLDS THE KEY. Rendered on line two, under the LIVE/DRY banner, on every single
   * panel. Same rule as RULE A and for the same reason: a person must be able to SEE whether the
   * bot is holding a key for them, never infer it from which controls happen to be missing.
   */
  readonly mode: TraderMode;
  /** Present iff `mode === 'wallet'`. The read-only half of the panel. */
  readonly walletMode?: WalletModeData | undefined;
  readonly symbol: string;
  readonly mint: string;
  readonly pubkey: string | null;
  readonly walletUnlocked: boolean;
  readonly solBalance: bigint | null;
  readonly tokenBalance: bigint | null;
  readonly tokenDecimals: number;
  readonly schedules: readonly ScheduleView[];
  readonly spentTodayUsd: number;
  /** All-time confirmed+UNKNOWN spend for this (user, mint), for the lifetime line. */
  readonly spentLifetimeUsd: number;
  readonly caps: { readonly perExecUsd: number; readonly perDayUsd: number; readonly lifetimeUsd: number | null } | null;
  /** Now, for "next in …" — passed in, never read from the wall clock. */
  readonly now: number;
}

/** Callback tokens: `t:<token>:<verb>`. The mint/ids never travel in callback_data (the 64-byte
 *  wall, Phase 8.5). Everything a button needs is the opaque token + a short verb. */
export const cb = (token: string, verb: string): string => `t:${token}:${verb}`;

export function parseCb(data: string): { token: string; verb: string } | null {
  const m = /^t:([\w-]{1,16}):(.+)$/.exec(data);
  return m ? { token: m[1] as string, verb: m[2] as string } : null;
}

export const LIVE_BANNER = '🔴 LIVE — real swaps';
export const DRY_BANNER = '🟡 DRY RUN — logging only, wallet untouched';

/**
 * PHASE 7 — the custody line, and it states the KEY, not the feature.
 *
 * "Wallet mode" on its own is a product word that tells a reader nothing about their exposure. The
 * sentence after it is the whole message: whether there is a key on this server that can spend
 * their money. That is the fact the line exists to make unmissable.
 */
export const WALLET_MODE_BANNER = '🔐 WALLET mode — your wallet, your keys. I hold nothing.';
export const KEY_MODE_BANNER = '🔑 KEY mode — I hold an encrypted key and trade from it.';

export function modeBanner(mode: TraderMode): string {
  return mode === 'wallet' ? WALLET_MODE_BANNER : KEY_MODE_BANNER;
}

function short(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function num(n: number, maxFrac = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

function fmtSol(lamports: bigint): string {
  return `${num(lamportsToSol(lamports), 4)} SOL`;
}

function fmtToken(raw: bigint, decimals: number, symbol: string): string {
  return `${num(toFloat(rawAmount(raw, decimals)), 0)} ${symbol}`;
}

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16); // UTC HH:MM
}

function duration(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** "Buy 0.05 SOL" / "Sell 10% of balance" / "Sell 5,000 RICE" — the human form of amount+side. */
function describeAmount(s: Schedule, symbol: string): string {
  if (s.side === 'buy') return `Buy  ${fmtSol(s.amountRaw)}`;
  if (s.amountKind === 'percent_of_balance') return `Sell ${Number(s.amountRaw) / 100}% of balance`;
  return `Sell ${fmtToken(s.amountRaw, 0, symbol)}`; // absolute token units render raw
}

const STATE_ICON: Record<Schedule['state'], string> = { active: '▶️ ACTIVE', paused: '⏸ PAUSED', halted: '🛑 HALTED' };

function renderSchedule(v: ScheduleView, symbol: string, tokenDecimals: number, now: number): string[] {
  const s = v.schedule;
  const lines = [`${STATE_ICON[s.state]}   ${describeAmount(s, symbol)}  every ${s.intervalMinutes} min`];
  if (s.state === 'halted' && s.haltReason) {
    lines.push(`     ⚠️ halted: ${s.haltReason}`);
  } else if (s.state === 'active') {
    const detail: string[] = [`next in ${duration(s.nextRunAt - now)}`];
    if (v.last && v.last.inRaw != null && v.last.outRaw != null && v.last.state === 'confirmed') {
      const inS = s.side === 'buy' ? fmtSol(v.last.inRaw) : fmtToken(v.last.inRaw, tokenDecimals, symbol);
      const outS = s.side === 'buy' ? fmtToken(v.last.outRaw, tokenDecimals, symbol) : fmtSol(v.last.outRaw);
      detail.push(`last ${inS} → ${outS} at ${hhmm(v.last.plannedAt)}`);
    }
    lines.push(`     ${detail.join(' · ')}`);
  }
  return lines;
}

/**
 * The whole panel: current settings + the full button board, in one message. Every action edits
 * THIS message in place and re-renders all of it — the owner never has to remember what they set.
 */
export function renderPanel(data: PanelData, token: string): { text: string; keyboard: PanelButton[][] } {
  const L: string[] = [];
  L.push(data.tradeLive ? LIVE_BANNER : DRY_BANNER); // RULE A — money-at-stake, first line, always
  L.push(modeBanner(data.mode)); // PHASE 7 — who holds the key, right beside it, on every panel

  // PHASE 7 — WALLET MODE IS A DIFFERENT PANEL, not the custodial one with the buttons greyed out.
  //
  // There is no wallet to unlock, no cap to set, no schedule of ours to pause, and no key to
  // change. Rendering those rows disabled would be the panel describing machinery that is not
  // running, and every disabled control is an invitation to find out why it is disabled.
  if (data.mode === 'wallet') return renderWalletModePanel(data, L, token);

  L.push(`🤖 Autotrader — ${data.symbol}`);
  const wallet = data.pubkey ? `${short(data.pubkey)}   (${data.walletUnlocked ? 'unlocked' : 'locked'})` : '— none yet, /wallet to set one';
  L.push(`Wallet   ${wallet}`);
  const bal = data.pubkey
    ? `${data.solBalance != null ? fmtSol(data.solBalance) : '—'} · ${data.tokenBalance != null ? fmtToken(data.tokenBalance, data.tokenDecimals, data.symbol) : '—'}`
    : '—';
  L.push(`Balance  ${bal}`);
  L.push(`Contract ${short(data.mint)}`);
  L.push('');

  if (data.schedules.length === 0) {
    L.push('No schedules yet — ➕ New schedule to start.');
  } else {
    for (const v of data.schedules) L.push(...renderSchedule(v, data.symbol, data.tokenDecimals, data.now));
  }
  L.push('');

  const capLine = data.caps
    ? `Today  $${num(data.spentTodayUsd)} / $${num(data.caps.perDayUsd)} cap   ·   Per-trade cap $${num(data.caps.perExecUsd)}`
    : `Today  $${num(data.spentTodayUsd)} spent   ·   ⚠️ no caps set — 🛡 Caps`;
  L.push(capLine);
  if (data.caps?.lifetimeUsd != null) {
    L.push(`Lifetime  $${num(data.spentLifetimeUsd)} of $${num(data.caps.lifetimeUsd)}`);
  }

  // The button board. Amount and Interval get their own top row (the two settings that change most).
  const keyboard: PanelButton[][] = [
    [{ text: '➕ New schedule', callback_data: cb(token, 'new') }],
    [{ text: '💰 Amount', callback_data: cb(token, 'amount') }, { text: '⏱ Interval', callback_data: cb(token, 'interval') }],
    [{ text: '⏸ Pause', callback_data: cb(token, 'pause') }, { text: '▶️ Resume', callback_data: cb(token, 'resume') }],
    [{ text: '🔑 Wallet', callback_data: cb(token, 'wallet') }, { text: '📄 Contract', callback_data: cb(token, 'contract') }],
    [{ text: '🎚 Slippage', callback_data: cb(token, 'slippage') }, { text: '🛡 Caps', callback_data: cb(token, 'caps') }],
    [{ text: '🛑 STOP ALL', callback_data: cb(token, 'stop') }],
  ];

  return { text: L.join('\n'), keyboard };
}

/**
 * PHASE 7 — the wallet-mode panel: a LAUNCH POINT and a READ-ONLY VIEW, and nothing else.
 *
 * Two things it deliberately does not do.
 *
 * It shows no control that would change an order. The bot cannot create, edit or cancel a Jupiter
 * recurring order — that needs the user's signature, which lives in their wallet, which is the
 * whole point of the mode. A button here that opened a prompt the bot could not honour would be a
 * worse lie than having no button.
 *
 * And what it lists is FILLS WE OBSERVED, not open orders. The bot does not ask Jupiter anything on
 * anyone's behalf; these rows come from the same Helius stream that produces the buy cards, so this
 * view costs no outbound call and no new state. Live order state — how many are left, when the next
 * one is due, cancelling — belongs in the Mini App, which has their wallet connected. Saying that
 * plainly is better than showing a stale figure that looks authoritative.
 */
function renderWalletModePanel(data: PanelData, L: string[], token: string): { text: string; keyboard: PanelButton[][] } {
  const w = data.walletMode;
  L.push(`🌾 DCA — ${data.symbol}`);
  L.push(`Contract ${short(data.mint)}`);
  L.push('');

  if (!w || w.linkedWallet === null) {
    L.push('No wallet linked yet.');
    L.push('');
    L.push('/linksite gives you a one-time code. Enter it on the site with your');
    L.push('wallet connected and sign the message — that proves the wallet is');
    L.push('yours. Nothing secret is ever sent, here or there.');
  } else {
    L.push(`Wallet   ${short(w.linkedWallet)}   (linked, proven by signature)`);
    L.push('');
    if (w.recentBuys.length === 0) {
      L.push('No DCA buys seen yet from this wallet.');
    } else {
      L.push(`Recent DCA buys (${w.recentBuys.length}, newest first):`);
      for (const b of w.recentBuys) {
        L.push(`  ${hhmm(b.at)}  ${fmtToken(b.tokensRaw, data.tokenDecimals, data.symbol)}  ·  $${num(b.usdIn)}`);
      }
    }
    L.push('');
    // Say where the authority is. A reader who wants the number of orders left must not sit here
    // waiting for this panel to eventually show it.
    L.push('These are fills I saw on-chain. Your live orders — how many remain,');
    L.push('when the next one is due, cancelling — live in the Mini App.');
  }

  const keyboard: PanelButton[][] = [];
  if (w?.miniAppUrl) keyboard.push([{ text: '🌾 Open DCA Mini App', web_app: { url: w.miniAppUrl } }]);
  // The one control that still means something here: which token this view is about. It changes a
  // preference of ours, not an order of theirs.
  keyboard.push([{ text: '📄 Contract', callback_data: cb(token, 'contract') }]);
  return { text: L.join('\n'), keyboard };
}

/** The verbs a button can carry — the single source of truth the handler and the equivalence test
 *  both read, so "every button has a typed-command equivalent" cannot silently drift. */
export const PANEL_VERBS = ['new', 'amount', 'interval', 'pause', 'resume', 'wallet', 'contract', 'slippage', 'caps', 'stop'] as const;
export type PanelVerb = (typeof PANEL_VERBS)[number];
