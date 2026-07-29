import type { Mint } from '../../core/types.js';
import type { AmountKind, Caps, ExecutionRecord, Schedule, Side } from '../../trade/scheduler.js';
import type { SettingChangeInput } from '../../trade/audit.js';
import { HARD_MIN_BUY_USD } from '../../trade/executor.js';

/**
 * PHASE 15 — the command layer behind BOTH the typed commands and the buttons. Everything here is:
 *   - USER-SCOPED: every write takes the acting userId and refuses to touch another user's rows.
 *   - VALIDATE-BEFORE-WRITE (RULE B): a command that takes an id verifies the id EXISTS and BELONGS
 *     to the caller before writing, and fails with a specific message otherwise. "/grant wrote a row
 *     for a chat the bot had never heard of and reported success" is the bug this closes.
 *
 * Each apply* returns a plain result; the caller re-renders the panel afterward. No apply* renders,
 * and none reaches into another user's data.
 */

export const PANEL_TTL_MS = 15 * 60_000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_SLIPPAGE_BPS = 1_000; // 10% HARD MAX (Phase 16). Above that you are donating, not trading.

/** The repo surface the panel needs. Concrete SqliteRepo satisfies it structurally. */
export interface PanelRepo {
  getSchedule(id: number): Promise<Schedule | null>;
  listSchedules(userId: number): Promise<readonly Schedule[]>;
  createSchedule(input: {
    userId: number; mint: Mint; side: Side; amountRaw: bigint; amountKind: AmountKind;
    intervalMinutes: number; slippageBps?: number; firstRunAt: number; state?: Schedule['state'];
  }): Promise<number>;
  setScheduleAmount(id: number, amountRaw: bigint, amountKind: AmountKind): Promise<void>;
  setScheduleInterval(id: number, intervalMinutes: number): Promise<void>;
  setScheduleSlippage(id: number, slippageBps: number): Promise<void>;
  pauseSchedule(id: number): Promise<void>;
  unhaltSchedule(id: number): Promise<void>;
  deleteScheduleById(id: number): Promise<void>;
  pauseUserSchedules(userId: number): Promise<number>;
  resumeUserSchedules(userId: number): Promise<number>;
  haltUserSchedules(userId: number, reason: string): Promise<number>;
  getCaps(userId: number, mint: Mint): Promise<Caps | null>;
  setCaps(input: { userId: number; mint: Mint; maxPerExecUsd: number; maxPerDayUsd: number; maxLifetimeUsd?: number | null; minSolReserveLamports?: bigint }): Promise<void>;
  getContract(userId: number): Promise<Mint | null>;
  setContract(userId: number, mint: Mint): Promise<void>;
  listExecutionsForUser(userId: number, limit: number): Promise<readonly ExecutionRecord[]>;
  /** Phase 16 (6): the what/from/to/when audit. Best-effort — a failed audit never fails the change. */
  recordSettingChange(entry: SettingChangeInput): Promise<void>;
}

export type ApplyResult = { readonly ok: boolean; readonly message: string };

/**
 * PHASE 7 — what a CUSTODIAL action is told when the caller is in wallet mode. It lives here, in
 * the shared command layer, because both surfaces that can attempt one (the Telegram panel and the
 * site bridge) have to refuse in the same words. A refusal that reads differently depending on
 * where you tapped is a refusal the user will read as two different rules.
 */
export const WALLET_MODE_REFUSAL =
  '🔐 You are in WALLET mode — I hold no key and run no schedule for you, so there is nothing here for me to change. ' +
  'Your DCA lives in your own wallet: open the Mini App from /trade. To hand me a key instead: /mode key.';

const ok = (message: string): ApplyResult => ({ ok: true, message });
const err = (message: string): ApplyResult => ({ ok: false, message });

/**
 * Record a setting change, best-effort. THE AUDIT MUST NEVER FAIL THE CHANGE: a full disk or a
 * locked DB on the trail table is not a reason to refuse a user their pause button. So this swallows,
 * and only after the write it is auditing has already succeeded.
 */
async function audit(repo: PanelRepo, entry: SettingChangeInput): Promise<void> {
  try {
    await repo.recordSettingChange(entry);
  } catch {
    /* the change already happened; a lost audit row is not worth failing it */
  }
}

/** Human-readable rendering of a schedule amount, for the audit trail (never for arithmetic). */
export function describeAmount(side: Side, amountRaw: bigint, kind: AmountKind): string {
  if (kind === 'percent_of_balance') return `${Number(amountRaw) / 100}%`; // stored as bps
  if (side === 'buy') return `${Number(amountRaw) / LAMPORTS_PER_SOL} SOL`;
  return `${amountRaw.toString()} tokens`;
}

/** VALIDATE-BEFORE-WRITE: resolve a schedule that both exists AND belongs to the caller, else a
 *  specific error. Every id-taking action goes through this first. */
async function ownedSchedule(repo: PanelRepo, userId: number, id: number): Promise<Schedule | ApplyResult> {
  // Never echo the raw token back (it may be a mistyped secret). `id` here is already Number()'d;
  // if it is not a clean positive integer, say what was expected instead of quoting anything.
  if (!Number.isInteger(id) || id <= 0) return err('That is not a schedule id. Your ids are shown on /trade.');
  const s = await repo.getSchedule(id);
  if (!s || s.userId !== userId) return err(`No schedule #${id} of yours. Your ids are shown on /trade.`);
  return s;
}
function isErr(x: Schedule | ApplyResult): x is ApplyResult {
  return (x as ApplyResult).ok === false;
}

// --- parsing (pure) --------------------------------------------------------------------------

export function parseSide(raw: string): Side | null {
  return raw === 'buy' || raw === 'sell' ? raw : null;
}

/**
 * Plain input, no units/flags: "0.05" (buy → SOL), "10%" (sell → percent), "5000" (sell → tokens).
 * A percent is a SELL concept; interpreting it depends on the side, which is why side is required.
 */
export function parseAmount(raw: string, side: Side): { amountRaw: bigint; amountKind: AmountKind } | { error: string } {
  const t = raw.trim();
  if (t.endsWith('%')) {
    if (side !== 'sell') return { error: 'a percent amount is only for sells' };
    const pct = Number(t.slice(0, -1));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { error: 'percent must be between 0 and 100, e.g. 10%' };
    return { amountRaw: BigInt(Math.round(pct * 100)), amountKind: 'percent_of_balance' }; // basis points
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { error: 'amount must be a positive number' };
  if (side === 'buy') return { amountRaw: BigInt(Math.round(n * LAMPORTS_PER_SOL)), amountKind: 'absolute' };
  if (!Number.isInteger(n)) return { error: 'a sell amount is whole tokens (e.g. 5000) or a percent (e.g. 10%)' };
  return { amountRaw: BigInt(n), amountKind: 'absolute' };
}

export function parseInterval(raw: string): number | { error: string } {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1) return { error: 'interval is whole minutes, at least 1 (e.g. 15)' };
  return n;
}

export function isPlausibleMint(mint: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint); // base58, Solana address length
}

// --- actions (each user-scoped, validate-before-write) ---------------------------------------

export async function applyNew(
  repo: PanelRepo, userId: number, contract: Mint, sideRaw: string, amountRaw: string, intervalRaw: string, now: number,
  solUsd: number | null = null,
): Promise<ApplyResult> {
  const side = parseSide(sideRaw);
  if (!side) return err('side must be buy or sell, e.g. /trade new buy 0.05 15');
  const amt = parseAmount(amountRaw, side);
  if ('error' in amt) return err(amt.error);
  const iv = parseInterval(intervalRaw);
  if (typeof iv !== 'number') return err(iv.error);
  // MIN BUY (hard limit): refuse a buy that resolves below $1 at creation, when it can be priced.
  // A percent buy is not priceable until execution (the scheduler skips it there); solUsd === null
  // means the feed is down, so don't block creation on a transient outage — the execution-time skip
  // is the backstop.
  if (side === 'buy' && amt.amountKind === 'absolute' && solUsd != null) {
    const usd = (Number(amt.amountRaw) / LAMPORTS_PER_SOL) * solUsd;
    if (usd < HARD_MIN_BUY_USD) return err(`that buy is about $${usd.toFixed(2)} — below the $${HARD_MIN_BUY_USD} minimum buy. Increase the amount.`);
  }
  const id = await repo.createSchedule({
    userId, mint: contract, side, amountRaw: amt.amountRaw, amountKind: amt.amountKind,
    intervalMinutes: iv, firstRunAt: now, state: 'active',
  });
  await audit(repo, {
    userId, action: 'schedule.create', scheduleId: id, field: null,
    fromValue: null, toValue: `${side} ${describeAmount(side, amt.amountRaw, amt.amountKind)} every ${iv} min`,
  });
  const caps = await repo.getCaps(userId, contract);
  const capNote = caps ? '' : ' — ⚠️ set caps (🛡 Caps) before it can trade safely';
  return ok(`Created schedule #${id}: ${side} every ${iv} min${capNote}.`);
}

export async function applyAmount(repo: PanelRepo, userId: number, id: number, amountRaw: string): Promise<ApplyResult> {
  const s = await ownedSchedule(repo, userId, id);
  if (isErr(s)) return s;
  const amt = parseAmount(amountRaw, s.side);
  if ('error' in amt) return err(amt.error);
  await repo.setScheduleAmount(id, amt.amountRaw, amt.amountKind);
  await audit(repo, {
    userId, action: 'schedule.amount', scheduleId: id, field: 'amount',
    fromValue: describeAmount(s.side, s.amountRaw, s.amountKind),
    toValue: describeAmount(s.side, amt.amountRaw, amt.amountKind),
  });
  return ok(`Schedule #${id} amount updated.`);
}

export async function applyInterval(repo: PanelRepo, userId: number, id: number, intervalRaw: string): Promise<ApplyResult> {
  const s = await ownedSchedule(repo, userId, id);
  if (isErr(s)) return s;
  const iv = parseInterval(intervalRaw);
  if (typeof iv !== 'number') return err(iv.error);
  await repo.setScheduleInterval(id, iv);
  await audit(repo, {
    userId, action: 'schedule.interval', scheduleId: id, field: 'interval_minutes',
    fromValue: String(s.intervalMinutes), toValue: String(iv),
  });
  return ok(`Schedule #${id} now runs every ${iv} min.`);
}

export async function applySlippage(repo: PanelRepo, userId: number, id: number, bpsRaw: string): Promise<ApplyResult> {
  const s = await ownedSchedule(repo, userId, id);
  if (isErr(s)) return s;
  const bps = Number(bpsRaw.trim());
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) return err(`slippage is basis points, 0–${MAX_SLIPPAGE_BPS} (100 = 1%)`);
  await repo.setScheduleSlippage(id, bps);
  await audit(repo, {
    userId, action: 'schedule.slippage', scheduleId: id, field: 'slippage_bps',
    fromValue: String(s.slippageBps), toValue: String(bps),
  });
  return ok(`Schedule #${id} slippage set to ${bps} bps.`);
}

export async function applyPause(repo: PanelRepo, userId: number, id: number): Promise<ApplyResult> {
  const s = await ownedSchedule(repo, userId, id);
  if (isErr(s)) return s;
  await repo.pauseSchedule(id);
  await audit(repo, { userId, action: 'schedule.pause', scheduleId: id, field: null, fromValue: s.state, toValue: 'paused' });
  return ok(`Schedule #${id} paused.`);
}

export async function applyResume(repo: PanelRepo, userId: number, id: number): Promise<ApplyResult> {
  const s = await ownedSchedule(repo, userId, id);
  if (isErr(s)) return s;
  await repo.unhaltSchedule(id); // active + clears any halt reason
  await audit(repo, { userId, action: 'schedule.resume', scheduleId: id, field: null, fromValue: s.state, toValue: 'active' });
  return ok(`Schedule #${id} resumed.`);
}

export async function applyDelete(repo: PanelRepo, userId: number, id: number): Promise<ApplyResult> {
  const s = await ownedSchedule(repo, userId, id);
  if (isErr(s)) return s;
  await repo.deleteScheduleById(id);
  await audit(repo, {
    userId, action: 'schedule.delete', scheduleId: id, field: null,
    fromValue: `${s.side} ${describeAmount(s.side, s.amountRaw, s.amountKind)} every ${s.intervalMinutes} min`,
    toValue: null,
  });
  return ok(`Schedule #${id} deleted.`);
}

/** 🛑 STOP ALL — pause every one of THIS user's active schedules. No confirmation (a confirmation on
 *  an emergency stop is a design error). Confirm on START, never on STOP. */
export async function applyStopAll(repo: PanelRepo, userId: number): Promise<ApplyResult> {
  const n = await repo.pauseUserSchedules(userId);
  if (n > 0) await audit(repo, { userId, action: 'stop_all', scheduleId: null, field: null, fromValue: null, toValue: `${n} paused` });
  return ok(n === 0 ? 'Nothing was running.' : `Stopped ${n} schedule(s). ▶️ Resume when ready.`);
}

/** ▶️ Resume all — bring every paused/halted schedule of this user back. The explicit resume a
 *  contract/wallet change requires. */
export async function applyResumeAll(repo: PanelRepo, userId: number): Promise<ApplyResult> {
  const n = await repo.resumeUserSchedules(userId);
  if (n > 0) await audit(repo, { userId, action: 'resume_all', scheduleId: null, field: null, fromValue: null, toValue: `${n} resumed` });
  return ok(n === 0 ? 'Nothing to resume.' : `Resumed ${n} schedule(s).`);
}

export async function applyCaps(
  repo: PanelRepo,
  userId: number,
  contract: Mint,
  perRaw: string,
  dayRaw: string,
  lifeRaw = '',
  maxPerDayUsdCeiling = Infinity,
  maxLifetimeUsdCeiling = Infinity,
): Promise<ApplyResult> {
  const per = Number(perRaw);
  const day = Number(dayRaw);
  if (!Number.isFinite(per) || per <= 0) return err('per-trade cap must be a positive dollar amount, e.g. 50');
  if (!Number.isFinite(day) || day <= 0) return err('daily cap must be a positive dollar amount, e.g. 200');
  if (day < per) return err(`daily cap ($${day}) is below the per-trade cap ($${per}) — it could never be reached`);
  // The env ceiling is the authority (the executor enforces it against the DB); refuse here too so
  // the user is told, rather than silently having a too-high cap clamped at execution.
  if (day > maxPerDayUsdCeiling) return err(`daily cap ($${day}) is above the $${maxPerDayUsdCeiling} platform ceiling — that is the most the autotrader will spend in a day.`);

  const prior = await repo.getCaps(userId, contract);

  // Lifetime cap (optional): omitted keeps the current value; "none"/"off"/"0" clears it; a positive
  // number sets it, refused above the env ceiling — the SAME reasoning as the daily ceiling.
  let maxLifetimeUsd: number | null;
  const life = lifeRaw.trim();
  if (life === '') {
    maxLifetimeUsd = prior?.maxLifetimeUsd ?? null;
  } else if (/^(none|off|0)$/i.test(life)) {
    maxLifetimeUsd = null;
  } else {
    const lifeN = Number(life);
    if (!Number.isFinite(lifeN) || lifeN <= 0) return err('lifetime cap must be a positive dollar amount, or "none" to clear it');
    if (lifeN < per) return err(`lifetime cap ($${lifeN}) is below the per-trade cap ($${per}) — it could never fit even one buy`);
    if (lifeN > maxLifetimeUsdCeiling) return err(`lifetime cap ($${lifeN}) is above the $${maxLifetimeUsdCeiling} platform ceiling — that is the most the autotrader will ever spend.`);
    maxLifetimeUsd = lifeN;
  }

  await repo.setCaps({ userId, mint: contract, maxPerExecUsd: per, maxPerDayUsd: day, maxLifetimeUsd });
  const lifeStr = (v: number | null): string => (v == null ? 'none' : `$${v}`);
  await audit(repo, {
    userId, action: 'caps', scheduleId: null, field: 'per/day/lifetime usd',
    fromValue: prior ? `$${prior.maxPerExecUsd}/$${prior.maxPerDayUsd}/${lifeStr(prior.maxLifetimeUsd)}` : null,
    toValue: `$${per}/$${day}/${lifeStr(maxLifetimeUsd)}`,
  });
  return ok(`Caps set: $${per} per trade, $${day} per day, lifetime ${lifeStr(maxLifetimeUsd)}.`);
}

/**
 * Change the CONTRACT. It halts every schedule and requires an explicit resume — the contract is
 * what the money buys/sells, and a schedule must never silently continue against a new target.
 */
export async function applySetContract(repo: PanelRepo, userId: number, mint: string): Promise<ApplyResult> {
  if (!isPlausibleMint(mint)) return err('That does not look like a mint address (base58, 32–44 chars).');
  const prior = await repo.getContract(userId);
  const halted = await repo.haltUserSchedules(userId, 'contract changed');
  await repo.setContract(userId, mint as Mint);
  await audit(repo, {
    userId, action: 'contract', scheduleId: null, field: 'mint',
    fromValue: prior, toValue: mint,
  });
  const note = halted > 0 ? ` ${halted} schedule(s) HALTED — ▶️ Resume to continue against the new contract.` : '';
  return ok(`Contract set.${note}`);
}

/** Called when the WALLET changes (from the wallet flow): halt schedules, explicit resume required. */
export async function haltForWalletChange(repo: PanelRepo, userId: number): Promise<number> {
  const halted = await repo.haltUserSchedules(userId, 'wallet changed');
  await audit(repo, {
    userId, action: 'wallet', scheduleId: null, field: null,
    fromValue: null, toValue: halted > 0 ? `changed — ${halted} halted` : 'changed',
  });
  return halted;
}

/**
 * THE ONE DISPATCHER behind every /trade subcommand AND every button prompt — so a button can never
 * do something its typed equivalent cannot, and vice versa. `tokens` is the args after `/trade`.
 */
export async function dispatchTradeCommand(
  repo: PanelRepo, userId: number, contract: Mint, tokens: readonly string[], now: number,
  maxPerDayUsdCeiling = Infinity, maxLifetimeUsdCeiling = Infinity, solUsd: number | null = null,
): Promise<ApplyResult> {
  const sub = tokens[0] ?? '';
  const a = (i: number): string => tokens[i] ?? '';
  switch (sub) {
    case 'new': return applyNew(repo, userId, contract, a(1), a(2), a(3), now, solUsd);
    case 'amount': return applyAmount(repo, userId, Number(a(1)), a(2));
    case 'interval': return applyInterval(repo, userId, Number(a(1)), a(2));
    case 'slippage': return applySlippage(repo, userId, Number(a(1)), a(2));
    case 'pause': return applyPause(repo, userId, Number(a(1)));
    case 'resume': return applyResume(repo, userId, Number(a(1)));
    case 'delete': return applyDelete(repo, userId, Number(a(1)));
    case 'stop': return applyStopAll(repo, userId);
    case 'caps': return applyCaps(repo, userId, contract, a(1), a(2), a(3), maxPerDayUsdCeiling, maxLifetimeUsdCeiling);
    default:
      return err('Try: new · amount <id> <amt> · interval <id> <min> · pause <id> · resume <id> · stop · slippage <id> <bps> · caps <per> <day> [lifetime] · delete <id>');
  }
}
