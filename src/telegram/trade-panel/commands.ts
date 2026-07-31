import type { Mint } from '../../core/types.js';
import type { AmountKind, Caps, ExecutionRecord, Schedule, Side } from '../../trade/scheduler.js';
import type { SettingChangeInput } from '../../trade/audit.js';
import { HARD_MIN_BUY_SOL, meetsMinBuy } from '../../trade/executor.js';

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
  /**
   * INVARIANT 16 — this user's schedules held out of service by an execution whose outcome is
   * UNKNOWN, each with the oldest such execution. Read before any resume; see {@link applyResume}.
   */
  unresolvedUnknownExecutions(userId: number): Promise<readonly { readonly scheduleId: number; readonly executionId: number }[]>;
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

/** The one sentence for a sub-minimum buy, so creating one and editing into one read alike — and
 *  so the two surfaces cannot drift, since both reach it through the same apply*. It quotes SOL
 *  because SOL is what was typed: a refusal in a unit the person did not enter makes them do the
 *  conversion to find out what number would have worked. */
function belowMinBuy(amountRaw: bigint): string {
  return `that buy is ${Number(amountRaw) / LAMPORTS_PER_SOL} SOL — below the ${HARD_MIN_BUY_SOL} SOL minimum buy. Increase the amount.`;
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
): Promise<ApplyResult> {
  const side = parseSide(sideRaw);
  if (!side) return err('side must be buy or sell, e.g. /trade new buy 0.05 15');
  const amt = parseAmount(amountRaw, side);
  if ('error' in amt) return err(amt.error);
  const iv = parseInterval(intervalRaw);
  if (typeof iv !== 'number') return err(iv.error);
  // MIN BUY (hard limit): refuse a buy below 0.001 SOL at creation. The floor is on the lamports
  // just parsed, so — unlike the USD floor this replaced — it needs no price feed and holds while
  // the feed is down. A percent buy has no SOL amount at all; it is refused by `parseAmount` for a
  // buy and skipped by the scheduler if a legacy row still holds one.
  if (side === 'buy' && amt.amountKind === 'absolute' && !meetsMinBuy(amt)) {
    return err(belowMinBuy(amt.amountRaw));
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

/**
 * THE MINIMUM BUY APPLIES TO AN EDIT, NOT ONLY TO A CREATION.
 *
 * It used to be checked in `applyNew` and again at execution, and nowhere in between — so create at
 * 0.05 SOL, edit to 0.0001, and the floor was gone. From the panel, and (once the site could write)
 * over the bridge, since both reach this one function.
 *
 * The execution-time skip is not a substitute for refusing here. It advances the slot and logs a
 * reason, so the schedule sits there looking active and silently never trades, and the person who
 * set it is told nothing. A clean refusal at the moment they typed the number is the whole
 * difference between "that is below the 0.001 SOL minimum" and a DCA that mysteriously does nothing.
 *
 * The floor is SOL-denominated (`meetsMinBuy`), so this no longer takes — or needs — a live SOL/USD
 * price. That closed a hole rather than opening one: a null feed used to skip the check entirely,
 * which is why the parameter was once mandatory. The one case it still does not block is
 * `applyNew`'s, matched deliberately rather than reinvented: a PERCENT-OF-BALANCE amount is a sell
 * concept with no SOL figure to compare, and `parseAmount` already refuses one for a buy.
 */
export async function applyAmount(
  repo: PanelRepo,
  userId: number,
  id: number,
  amountRaw: string,
): Promise<ApplyResult> {
  const s = await ownedSchedule(repo, userId, id);
  if (isErr(s)) return s;
  const amt = parseAmount(amountRaw, s.side);
  if ('error' in amt) return err(amt.error);
  if (s.side === 'buy' && amt.amountKind === 'absolute' && !meetsMinBuy(amt)) {
    return err(belowMinBuy(amt.amountRaw));
  }
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

/**
 * RESUME IS NOT AN EXIT FROM AMBIGUITY (INVARIANT 16).
 *
 * An UNKNOWN outcome means a swap MAY have landed and may not have. The schedule is halted so it
 * cannot fire again on top of a trade nobody has confirmed, and `/resolve` is the only way out
 * precisely because it makes a human look at the chain and state the verdict. `unhaltSchedule`
 * clears any halt reason unconditionally — that is correct for its callers, which are the
 * executor's own resolution paths, and every one of them SETTLES THE EXECUTION FIRST. Resume does
 * not settle anything, so if it could unhalt an UNKNOWN it would be a back door around the whole
 * mechanism: the schedule would start trading again with the earlier trade still undetermined, and
 * the caps would still be counting a spend nobody has verified.
 *
 * That back door was real and open, on the panel, and reachable from the site the moment the write
 * bridge existed. The only thing that limited the damage was `quarantineUnresolvedOnBoot`, which
 * re-halts these schedules — but only at the NEXT RESTART, which may be days away. See the test
 * "an UNKNOWN execution keeps its schedule halted across a restart", whose own comment names the
 * hole ("e.g. a manual resume left the UNKNOWN unresolved").
 *
 * The discriminator is the execution's own `state`, not the halt's prose. The halt reason is
 * free text written for a human ("UNKNOWN outcome for execution 42 (sig…)"), and a guard that
 * pattern-matches English stops working the day someone rewords a sentence. `state = 'UNKNOWN'` is
 * a CHECK-constrained enum, it is indexed, it is what `quarantineUnresolvedOnBoot` keys on, and it
 * is EXACTLY the state `/resolve` accepts — so the thing this refuses and the thing that exit
 * clears are the same set by construction, and cannot drift into a deadlock where a schedule can
 * neither resume nor be resolved.
 *
 * Ordinary halts — a cap breach, a contract or wallet change, the dead-man kill switch, a manual
 * pause — carry no unresolved execution and still resume normally.
 */
export async function applyResume(repo: PanelRepo, userId: number, id: number): Promise<ApplyResult> {
  const s = await ownedSchedule(repo, userId, id);
  if (isErr(s)) return s;
  const blocked = (await repo.unresolvedUnknownExecutions(userId)).find((b) => b.scheduleId === id);
  if (blocked) return err(unknownRefusal(id, blocked.executionId));
  await repo.unhaltSchedule(id); // active + clears any ORDINARY halt reason
  await audit(repo, { userId, action: 'schedule.resume', scheduleId: id, field: null, fromValue: s.state, toValue: 'active' });
  return ok(`Schedule #${id} resumed.`);
}

/** The one refusal, so the panel and the site say the same thing and both name the exit. */
function unknownRefusal(scheduleId: number, executionId: number): string {
  return (
    `⚠️ Schedule #${scheduleId} is halted on an UNKNOWN outcome — execution ${executionId} may or may not have landed on-chain. ` +
    `Resume cannot clear that: check the transaction, then run /resolve ${executionId} confirmed|failed in the bot. ` +
    `That is the only exit, and it is the only way the schedule starts trading again.`
  );
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

/**
 * ▶️ Resume all — bring every paused/halted schedule of this user back. The explicit resume a
 * contract/wallet change requires.
 *
 * IT HAS THE SAME UNKNOWN GUARD AS {@link applyResume}, and it needs it more, not less: "resume
 * everything" is the shape of request that quietly sweeps up the one schedule that must not move.
 * A blocked schedule is REPORTED, not silently skipped — a bulk action that says "Resumed 3" while
 * leaving a fourth halted teaches the user their kill switch is flaky. The others still resume:
 * one undetermined trade is not a reason to keep the rest of an account frozen.
 */
export async function applyResumeAll(repo: PanelRepo, userId: number): Promise<ApplyResult> {
  const blocked = await repo.unresolvedUnknownExecutions(userId);
  const n = await repo.resumeUserSchedules(userId); // the SQL excludes them too — see the repo
  if (n > 0) await audit(repo, { userId, action: 'resume_all', scheduleId: null, field: null, fromValue: null, toValue: `${n} resumed` });
  if (blocked.length === 0) return ok(n === 0 ? 'Nothing to resume.' : `Resumed ${n} schedule(s).`);
  const held = blocked
    .map((b) => `#${b.scheduleId} (/resolve ${b.executionId} confirmed|failed)`)
    .join(', ');
  const resumed = n === 0 ? 'Nothing else to resume.' : `Resumed ${n} schedule(s).`;
  return ok(`${resumed}\n\n⚠️ Still halted on an UNKNOWN outcome, and resume cannot clear it: ${held}.`);
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
  maxPerDayUsdCeiling = Infinity, maxLifetimeUsdCeiling = Infinity,
): Promise<ApplyResult> {
  const sub = tokens[0] ?? '';
  const a = (i: number): string => tokens[i] ?? '';
  switch (sub) {
    case 'new': return applyNew(repo, userId, contract, a(1), a(2), a(3), now);
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
