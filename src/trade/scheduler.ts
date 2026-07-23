import type { Mint } from '../core/types.js';
import type { Logger } from '../ops/logger.js';

/**
 * PHASE 13 — the DCA scheduler. It decides WHAT should happen and WHEN, and logs it.
 * It does NOT execute a swap: execution is Phase 14. Every claimed slot in this phase ends
 * as `failed` with error `dry-run`, so a scheduling bug is found by reading logs, not by
 * spending real money.
 *
 * Three rules carry the money-safety of the whole surface, and each has a test that proves it:
 *
 *   1. ONE EXECUTION PER SLOT, EVER. The slot is claimed with the same atomic INSERT ...
 *      ON CONFLICT DO NOTHING as the sends ledger (INVARIANT 2). An overlapping tick or a
 *      restart replay resolves to exactly one winner in the storage engine.
 *
 *   2. MISSED SLOTS DO NOT BACKFILL. If the process was down for three hours on a five-minute
 *      schedule, it fires ZERO catch-up trades. It logs the gap and jumps to the next FUTURE
 *      slot. A downtime that ends in a burst of unattended market orders is how people lose
 *      money while asleep — this is the single most dangerous behaviour on the surface.
 *
 *   3. next_run_at ADVANCES FROM THE PLANNED TIME, never from `now`. Otherwise every tick's
 *      latency compounds and a five-minute schedule drifts to six.
 *
 * Everything is scoped by user_id. The cap sums are per user; one person's runaway schedule
 * can never consume another's headroom (INVARIANT 14, 17).
 */

export type Side = 'buy' | 'sell';
export type AmountKind = 'absolute' | 'percent_of_balance';
export type ScheduleState = 'active' | 'paused' | 'halted';
export type ExecutionState = 'claimed' | 'submitted' | 'confirmed' | 'failed' | 'UNKNOWN';

export interface Schedule {
  readonly id: number;
  readonly userId: number;
  readonly mint: Mint;
  readonly side: Side;
  /** buy: lamports of SOL to spend. sell: raw token units to sell. Integer, carried as bigint. */
  readonly amountRaw: bigint;
  readonly amountKind: AmountKind;
  readonly intervalMinutes: number;
  readonly slippageBps: number;
  readonly state: ScheduleState;
  readonly haltReason: string | null;
  readonly nextRunAt: number;
  readonly lastRunAt: number | null;
}

export interface Caps {
  readonly userId: number;
  readonly mint: Mint;
  readonly maxPerExecUsd: number;
  readonly maxPerDayUsd: number;
  readonly minSolReserveLamports: bigint;
}

/**
 * A trade the scheduler has decided to make. The unit the executor (Phase 14) will act on,
 * and — in this phase — the unit that is logged and marked `dry-run`.
 */
export interface PlannedTrade {
  readonly schedule: Schedule;
  readonly plannedAt: number;
  /** The trade's USD value at decision time, from the pricer. Used for the cap checks. */
  readonly usdValue: number;
}

export interface ExecutionOutcome {
  readonly state: ExecutionState;
  readonly signature?: string | null;
  readonly inRaw?: bigint | null;
  readonly outRaw?: bigint | null;
  readonly priceUsd?: number | null;
  readonly usdValue?: number | null;
  readonly error?: string | null;
}

/**
 * How a due slot resolved. Every branch is logged; the tests assert on these outcomes so the
 * scheduler's decisions are observable without reading the DB.
 */
export type SlotOutcome =
  | { readonly kind: 'fired'; readonly plannedAt: number; readonly outcome: ExecutionOutcome }
  | { readonly kind: 'claim-lost'; readonly plannedAt: number }
  | { readonly kind: 'gap-skipped'; readonly plannedAt: number; readonly slotsSkipped: number; readonly newNextRunAt: number }
  | { readonly kind: 'cap-halted'; readonly plannedAt: number; readonly reason: string }
  | { readonly kind: 'reserve-skipped'; readonly plannedAt: number }
  | { readonly kind: 'unpriceable-skipped'; readonly plannedAt: number };

/** Prices a planned trade, and reads the wallet SOL balance for the reserve check. */
export interface TradeValuer {
  /**
   * USD value of `schedule`'s next fire, or null if it cannot be priced right now (dead feed,
   * missing token metadata). Null is NOT zero — an unpriceable slot is skipped, never fired,
   * because a cap cannot be checked against a number we do not have.
   */
  usdValueOf(schedule: Schedule): Promise<number | null>;
  /**
   * The owner's current SOL balance in lamports, or null if it cannot be read. Buy side only;
   * null forces a skip, because a reserve breach we cannot rule out is one we assume.
   */
  solBalanceLamports(userId: number): Promise<bigint | null>;
}

/**
 * Executes a planned trade. Phase 14 supplies the real one; Phase 13 supplies {@link dryRunExecutor},
 * which spends nothing and marks the slot `failed`/`dry-run`. The seam is the phase boundary.
 */
export type Executor = (plan: PlannedTrade) => Promise<ExecutionOutcome>;

/** The narrow slice of the repo the scheduler needs. Everything here is user-scoped by contract. */
export interface SchedulerRepo {
  /** Active schedules whose next_run_at <= now. The tick's work list, across all users. */
  dueSchedules(now: number): Promise<readonly Schedule[]>;
  /** Every active schedule, for the boot log. */
  activeSchedules(): Promise<readonly Schedule[]>;

  getCaps(userId: number, mint: Mint): Promise<Caps | null>;

  /**
   * Sum of usd_value across this user's CONFIRMED + UNKNOWN executions for `mint` since
   * `sinceMs`. UNKNOWN counts because it MAY have spent (INVARIANT 16). Scoped by user_id.
   */
  usdSpent24h(userId: number, mint: Mint, sinceMs: number): Promise<number>;

  /** Move the scheduling pointer. Advances from the PLANNED time (rule 3), never from now. */
  advanceSchedule(id: number, nextRunAt: number, lastRunAt: number | null): Promise<void>;

  /** Stop a schedule and say why. The owner must be told; a halt is never silent. */
  haltSchedule(id: number, reason: string, at: number): Promise<void>;

  /**
   * Atomically claim (schedule_id, planned_at) as 'claimed'. Returns the new execution id, or
   * null if the slot was already claimed. THE idempotency chokepoint — same INSERT ... ON
   * CONFLICT DO NOTHING as claimSend, and false is the normal outcome of a losing race.
   */
  claimExecution(scheduleId: number, userId: number, plannedAt: number): Promise<number | null>;

  /** Record the outcome of a claimed execution. */
  settleExecution(id: number, outcome: ExecutionOutcome): Promise<void>;
}

export interface SchedulerDeps {
  readonly repo: SchedulerRepo;
  readonly valuer: TradeValuer;
  readonly execute: Executor;
  readonly log: Logger;
  readonly now?: () => number;
  /** How often the tick runs. Default 10s — the scheduler's resolution. */
  readonly tickMs?: number;
}

const DEFAULT_TICK_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The dry-run executor for Phase 13. Logs the intended trade and marks the slot failed/dry-run.
 * It reaches nothing on-chain — this is what lets the whole scheduler run for a day and be read
 * off the logs before an executor that spends money exists.
 */
export function dryRunExecutor(log: Logger): Executor {
  return async (plan: PlannedTrade): Promise<ExecutionOutcome> => {
    log.info(
      {
        scheduleId: plan.schedule.id,
        userId: plan.schedule.userId,
        mint: plan.schedule.mint,
        side: plan.schedule.side,
        amountRaw: plan.schedule.amountRaw.toString(),
        amountKind: plan.schedule.amountKind,
        slippageBps: plan.schedule.slippageBps,
        plannedAt: plan.plannedAt,
        usdValue: plan.usdValue,
      },
      'DRY-RUN intended trade — would submit in Phase 14; spending nothing',
    );
    return { state: 'failed', usdValue: plan.usdValue, error: 'dry-run' };
  };
}

export class Scheduler {
  readonly #repo: SchedulerRepo;
  readonly #valuer: TradeValuer;
  readonly #execute: Executor;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #tickMs: number;

  #timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard: a tick that runs long must not overlap the next. The atomic claim is
   *  the real defence, but not fighting our own previous tick is cheaper and clearer. */
  #ticking = false;

  constructor(deps: SchedulerDeps) {
    this.#repo = deps.repo;
    this.#valuer = deps.valuer;
    this.#execute = deps.execute;
    this.#log = deps.log.child({ mod: 'scheduler' });
    this.#now = deps.now ?? Date.now;
    this.#tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  }

  /** Log every active schedule and its next_run_at. Schedules survive restart; boot proves it. */
  async logActiveOnBoot(): Promise<void> {
    const active = await this.#repo.activeSchedules();
    this.#log.info({ count: active.length }, 'autotrader scheduler: active schedules restored');
    for (const s of active) {
      this.#log.info(
        {
          scheduleId: s.id,
          userId: s.userId,
          mint: s.mint,
          side: s.side,
          intervalMinutes: s.intervalMinutes,
          nextRunAt: s.nextRunAt,
        },
        'autotrader scheduler: schedule active',
      );
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    // Do not keep the process alive for the scheduler alone.
    this.#timer.unref?.();
    this.#log.info({ tickMs: this.#tickMs }, 'autotrader scheduler: tick loop started');
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * One pass. Processes every active schedule that is due. Returns the outcome of each due slot,
   * so a test can drive a tick and assert on decisions without inspecting the DB.
   *
   * Never throws out of the loop: one schedule's failure must not stop the others from being
   * evaluated — a thrown pricer must not wedge every user's tick.
   */
  async tick(): Promise<SlotOutcome[]> {
    if (this.#ticking) return [];
    this.#ticking = true;
    const outcomes: SlotOutcome[] = [];
    try {
      const now = this.#now();
      const due = await this.#repo.dueSchedules(now);
      for (const schedule of due) {
        try {
          outcomes.push(await this.#processDue(schedule, now));
        } catch (err) {
          // A single schedule blowing up is logged and isolated; the tick carries on.
          this.#log.error(
            { scheduleId: schedule.id, userId: schedule.userId, err: err instanceof Error ? err.message : String(err) },
            'autotrader scheduler: schedule tick failed — isolated, other schedules continue',
          );
        }
      }
    } finally {
      this.#ticking = false;
    }
    return outcomes;
  }

  async #processDue(schedule: Schedule, now: number): Promise<SlotOutcome> {
    const plannedAt = schedule.nextRunAt;
    const intervalMs = schedule.intervalMinutes * 60_000;

    // --- RULE 2: MISSED SLOTS DO NOT BACKFILL --------------------------------------------
    //
    // A slot's window is [plannedAt, plannedAt + interval). If `now` has already left it, this
    // slot AND every slot up to now expired while we were away. We fire NONE of them: jump to
    // the first slot strictly in the future and log the gap. Zero catch-up trades.
    if (now - plannedAt >= intervalMs) {
      const intervalsElapsed = Math.floor((now - plannedAt) / intervalMs);
      const newNextRunAt = plannedAt + (intervalsElapsed + 1) * intervalMs;
      const slotsSkipped = intervalsElapsed + 1; // every expired slot from plannedAt through now
      await this.#repo.advanceSchedule(schedule.id, newNextRunAt, schedule.lastRunAt);
      this.#log.warn(
        {
          scheduleId: schedule.id,
          userId: schedule.userId,
          plannedAt,
          now,
          slotsSkipped,
          newNextRunAt,
          gapMs: now - plannedAt,
        },
        'autotrader scheduler: MISSED SLOTS — firing ZERO catch-up trades, jumping to the next future slot',
      );
      return { kind: 'gap-skipped', plannedAt, slotsSkipped, newNextRunAt };
    }

    // --- CAP CHECKS run BEFORE the claim; both the per-exec and 24h caps must pass ---------
    const caps = await this.#repo.getCaps(schedule.userId, schedule.mint);

    const usdValue = await this.#valuer.usdValueOf(schedule);
    if (usdValue === null) {
      // Cannot price it, so cannot prove it is within cap. Skip the slot, advance, stay active
      // — an unpriceable feed is usually transient and a missed DCA slot is the safe failure.
      await this.#advanceOnly(schedule, plannedAt, intervalMs);
      this.#log.warn(
        { scheduleId: schedule.id, userId: schedule.userId, plannedAt },
        'autotrader scheduler: slot UNPRICEABLE — skipped, not fired (cannot verify caps)',
      );
      return { kind: 'unpriceable-skipped', plannedAt };
    }

    if (caps) {
      // Per-execution cap. A breach is a persistent misconfiguration, not a transient dip:
      // halt and make the owner act, rather than skip forever in silence.
      if (usdValue > caps.maxPerExecUsd) {
        const reason = `per-exec cap: $${usdValue.toFixed(2)} > $${caps.maxPerExecUsd.toFixed(2)}`;
        await this.#repo.haltSchedule(schedule.id, reason, now);
        this.#log.warn({ scheduleId: schedule.id, userId: schedule.userId, plannedAt, reason }, 'autotrader scheduler: HALTED on cap breach');
        return { kind: 'cap-halted', plannedAt, reason };
      }

      // Rolling 24h cap, per user, per mint. Confirmed + UNKNOWN count; this slot's value is
      // added on top before the comparison.
      const spent = await this.#repo.usdSpent24h(schedule.userId, schedule.mint, now - DAY_MS);
      if (spent + usdValue > caps.maxPerDayUsd) {
        const reason = `24h cap: $${(spent + usdValue).toFixed(2)} > $${caps.maxPerDayUsd.toFixed(2)}`;
        await this.#repo.haltSchedule(schedule.id, reason, now);
        this.#log.warn({ scheduleId: schedule.id, userId: schedule.userId, plannedAt, reason }, 'autotrader scheduler: HALTED on cap breach');
        return { kind: 'cap-halted', plannedAt, reason };
      }
    }

    // Buy-side reserve: never let a buy drop the wallet below the SOL it needs for fees. A wallet
    // with no gas is a wallet that cannot SELL. Transient (they may top up), so skip — do not halt.
    //
    // ONLY `absolute` buys are reserve-checked here, because only they have a fixed lamport spend
    // to subtract. A `percent_of_balance` buy's spend is not known until the balance is read at
    // execution time — so PHASE 14 MUST re-run this reserve check there, against the resolved
    // amount, before it signs. In this phase percent buys never reach the chain (the valuer returns
    // null for them -> unpriceable-skipped), so there is nothing to guard yet.
    if (schedule.side === 'buy' && schedule.amountKind === 'absolute' && caps) {
      const balance = await this.#valuer.solBalanceLamports(schedule.userId);
      if (balance === null || balance - schedule.amountRaw < caps.minSolReserveLamports) {
        await this.#advanceOnly(schedule, plannedAt, intervalMs);
        this.#log.warn(
          {
            scheduleId: schedule.id,
            userId: schedule.userId,
            plannedAt,
            balanceLamports: balance === null ? null : balance.toString(),
            spendLamports: schedule.amountRaw.toString(),
            reserveLamports: caps.minSolReserveLamports.toString(),
          },
          'autotrader scheduler: buy would breach SOL reserve — SKIPPED, not executed',
        );
        return { kind: 'reserve-skipped', plannedAt };
      }
    }

    // --- RULE 3: advance from the PLANNED time, before the claim, deterministically ---------
    //
    // Advancing here (not after the claim) keeps the scheduling pointer moving even if this tick
    // loses the claim to an overlapping one — the value is a pure function of plannedAt, so both
    // ticks write the same next_run_at. A crash after this and before the claim costs at most one
    // missed slot, which is the safe side of the line.
    const nextRunAt = plannedAt + intervalMs;
    await this.#repo.advanceSchedule(schedule.id, nextRunAt, now);

    // --- CLAIM THE SLOT. Exactly one winner across every overlapping tick and restart. --------
    const execId = await this.#repo.claimExecution(schedule.id, schedule.userId, plannedAt);
    if (execId === null) {
      // Another tick already owns this slot. Do nothing — do not queue, retry, or log an error.
      // This is the normal, expected outcome of a race, exactly like claimSend returning false.
      this.#log.debug({ scheduleId: schedule.id, plannedAt }, 'autotrader scheduler: slot already claimed by another tick');
      return { kind: 'claim-lost', plannedAt };
    }

    // --- EXECUTE. Phase 13: the dry-run executor logs and marks failed/dry-run. ---------------
    const plan: PlannedTrade = { schedule, plannedAt, usdValue };
    const outcome = await this.#execute(plan);
    await this.#repo.settleExecution(execId, outcome);
    return { kind: 'fired', plannedAt, outcome };
  }

  /** Advance the scheduling pointer to the next slot without firing. Used by transient skips. */
  #advanceOnly(schedule: Schedule, plannedAt: number, intervalMs: number): Promise<void> {
    return this.#repo.advanceSchedule(schedule.id, plannedAt + intervalMs, schedule.lastRunAt);
  }
}
