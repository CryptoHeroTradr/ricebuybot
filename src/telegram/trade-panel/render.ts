import { lamportsToSol, rawAmount, toFloat } from '../../core/money.js';
import type { ExecutionRecord, Schedule } from '../../trade/scheduler.js';

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

export interface ScheduleView {
  readonly schedule: Schedule;
  readonly last: ExecutionRecord | null;
}

export interface PanelData {
  readonly tradeLive: boolean;
  readonly symbol: string;
  readonly mint: string;
  readonly pubkey: string | null;
  readonly walletUnlocked: boolean;
  readonly solBalance: bigint | null;
  readonly tokenBalance: bigint | null;
  readonly tokenDecimals: number;
  readonly schedules: readonly ScheduleView[];
  readonly spentTodayUsd: number;
  readonly caps: { readonly perExecUsd: number; readonly perDayUsd: number } | null;
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
export function renderPanel(data: PanelData, token: string): { text: string; keyboard: CallbackButton[][] } {
  const L: string[] = [];
  L.push(data.tradeLive ? LIVE_BANNER : DRY_BANNER); // RULE A — money-at-stake, first line, always
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

  // The button board. Amount and Interval get their own top row (the two settings that change most).
  const keyboard: CallbackButton[][] = [
    [{ text: '➕ New schedule', callback_data: cb(token, 'new') }],
    [{ text: '💰 Amount', callback_data: cb(token, 'amount') }, { text: '⏱ Interval', callback_data: cb(token, 'interval') }],
    [{ text: '⏸ Pause', callback_data: cb(token, 'pause') }, { text: '▶️ Resume', callback_data: cb(token, 'resume') }],
    [{ text: '🔑 Wallet', callback_data: cb(token, 'wallet') }, { text: '📄 Contract', callback_data: cb(token, 'contract') }],
    [{ text: '🎚 Slippage', callback_data: cb(token, 'slippage') }, { text: '🛡 Caps', callback_data: cb(token, 'caps') }],
    [{ text: '🛑 STOP ALL', callback_data: cb(token, 'stop') }],
  ];

  return { text: L.join('\n'), keyboard };
}

/** The verbs a button can carry — the single source of truth the handler and the equivalence test
 *  both read, so "every button has a typed-command equivalent" cannot silently drift. */
export const PANEL_VERBS = ['new', 'amount', 'interval', 'pause', 'resume', 'wallet', 'contract', 'slippage', 'caps', 'stop'] as const;
export type PanelVerb = (typeof PANEL_VERBS)[number];
