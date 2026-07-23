import { normalizeSwap } from '../ingest/normalize.js';
import type { ConfirmedTx } from '../ingest/solana-types.js';
import type { Mint } from '../core/types.js';
import type { Logger } from '../ops/logger.js';
import { frameTransaction, encodeBase58 } from './signer.js';
import type { Caps, ExecutionOutcome, ExecutionRecord, PlannedTrade, Schedule } from './scheduler.js';

/**
 * PHASE 14 — execute the swaps the scheduler decided on, via Jupiter. The scheduler decides WHAT
 * and WHEN; this file only DOES it, and its entire design is about one failure mode: a swap whose
 * outcome we cannot determine. A blind retry there is a double-buy with real money.
 *
 * The order of operations is load-bearing (see the per-step comments):
 *   quote -> price-impact guard -> build -> SIGN (mint guard) -> simulate -> record submitted ->
 *   send -> confirm -> {confirmed | failed | UNKNOWN}.
 *
 * UNKNOWN is the important path. A confirm timeout does NOT mean the swap failed — it may confirm
 * seconds later. So on UNKNOWN we HALT the schedule, tell the owner, and try to resolve it
 * passively for 15 minutes. We NEVER auto-resume from ambiguity; a human runs /resolve.
 */

/** Jupiter denominates SOL as wSOL. This is also what the signer's guard permits alongside the mint. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface ExecutorConfig {
  /** Reject a quote whose price impact exceeds this FRACTION (0.03 = 3%). A slippage setting is
   *  not a price-impact guard: on a ~$105K-cap token a modest order moves the price itself. */
  readonly maxPriceImpactPct: number;
  /** Priority fee, lamports. A transaction that never lands is worse than one that costs a hair more. */
  readonly priorityFeeLamports: number;
  /** Bounded confirmation wait before an outcome becomes UNKNOWN. */
  readonly confirmTimeoutMs: number;
  readonly confirmPollMs: number;
  /** Passive-resolution window for an UNKNOWN before a human must decide. */
  readonly resolveTimeoutMs: number;
  readonly resolvePollMs: number;
  /** A null signature status this long after submit means the blockhash expired and it was DROPPED
   *  — definitively failed, because an expired blockhash can never be included. */
  readonly droppedAfterMs: number;
}

export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  maxPriceImpactPct: 0.03,
  priorityFeeLamports: 100_000, // 0.0001 SOL
  confirmTimeoutMs: 90_000,
  confirmPollMs: 2_000,
  resolveTimeoutMs: 15 * 60_000,
  resolvePollMs: 30_000,
  droppedAfterMs: 150_000,
};

// --- injected dependencies (all mockable; the real wiring lives in index.ts) -----------------

export interface JupiterQuote {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: bigint;
  readonly outAmount: bigint;
  /** Price impact as a FRACTION (0.05 = 5%). */
  readonly priceImpactPct: number;
  /** The full quote response, passed back verbatim to buildSwap. */
  readonly raw: unknown;
}

export interface Jupiter {
  quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<JupiterQuote>;
  buildSwap(p: { quote: JupiterQuote; userPublicKey: string; prioritizationFeeLamports: number }): Promise<{ swapTransaction: string }>;
}

/** The signer — Phase 12. Its guard IS the mint guard, and it fails BEFORE any signature exists. */
export interface TxSigner {
  sign(userId: number, allowedMints: readonly string[], txBase64: string): Promise<string>;
}

export interface SignatureStatus {
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  readonly err: unknown;
  readonly slot: number | null;
}

export interface ChainRpc {
  /** Pre-send simulation. `err === null` means the transaction will execute. Free; a bad send is not. */
  simulate(txBase64: string): Promise<{ err: unknown }>;
  /** Broadcast. Returns the signature the cluster acknowledges (equals the tx's own first signature). */
  send(txBase64: string): Promise<string>;
  signatureStatus(signature: string): Promise<SignatureStatus | null>;
  getTransaction(signature: string): Promise<ConfirmedTx | null>;
}

export interface BalanceReader {
  /** Balance of EXACTLY this mint on this wallet, raw units. Scoped by mint address — NEVER the
   *  largest balance, an index into the account list, or any heuristic (a mis-scope sells the
   *  wrong asset on a multi-token wallet). */
  mintBalance(owner: string, mint: string): Promise<bigint>;
}

export interface WalletResolver {
  /** The wallet address for a user, readable while the key is LOCKED. Null if none. */
  pubkeyOf(userId: number): string | null;
}

export interface Dm {
  send(userId: number, text: string): Promise<void>;
}

/** The slice of the repo the executor writes. Everything is user/execution-scoped by the caller. */
export interface ExecutorRepo {
  settleExecution(id: number, outcome: ExecutionOutcome): Promise<void>;
  getExecution(id: number): Promise<ExecutionRecord | null>;
  getSchedule(id: number): Promise<Schedule | null>;
  getCaps(userId: number, mint: Mint): Promise<Caps | null>;
  usdSpent24h(userId: number, mint: Mint, sinceMs: number): Promise<number>;
  haltSchedule(id: number, reason: string, at: number): Promise<void>;
  unhaltSchedule(id: number): Promise<void>;
  haltAllActiveSchedules(reason: string, at: number): Promise<number>;
}

export interface ExecutorDeps {
  readonly repo: ExecutorRepo;
  readonly jupiter: Jupiter;
  readonly signer: TxSigner;
  readonly chain: ChainRpc;
  readonly balances: BalanceReader;
  readonly wallets: WalletResolver;
  readonly dm: Dm;
  readonly log: Logger;
  /** Live SOL/USD, for valuing sells against caps and computing price_usd. Null if the feed is down. */
  readonly solUsd: () => number | null;
  /** Decimals for a mint (from token metadata), for price_usd. */
  readonly decimalsOf: (mint: string) => Promise<number | null>;
  /** Bot admin, DMed on the kill switch. */
  readonly ownerUserId?: number | undefined;
  readonly config?: Partial<ExecutorConfig>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** THE parser (INVARIANT 12) — normalizeSwap. Injectable ONLY so a test can supply a known
   *  ConfirmedTx→event mapping; production always uses the real one. Never a second parser. */
  readonly parseSwap?: typeof normalizeSwap;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_KILL_THRESHOLD = 3;

function solscan(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

/** The transaction's own signature: the first 64 signature bytes, base58. Known BEFORE sending —
 *  which is what lets us record it before the send and keep the outcome discoverable on a crash. */
export function signatureOf(signedTxBase64: string): string {
  const raw = Buffer.from(signedTxBase64, 'base64');
  const { sigOffset } = frameTransaction(raw);
  return encodeBase58(raw.subarray(sigOffset, sigOffset + 64));
}

export class Executor {
  readonly #d: ExecutorDeps;
  readonly #cfg: ExecutorConfig;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #parse: typeof normalizeSwap;

  /** Serialize: never two in-flight executions. Two concurrent swaps from one wallet fight over the
   *  same SOL balance and nonce. A promise chain is the whole mechanism. */
  #chain: Promise<unknown> = Promise.resolve();
  #consecutiveFailures = 0;
  #killed = false;

  /** The in-flight passive-resolution promise from the most recent UNKNOWN, or null. Exposed so a
   *  test can await it; production fires it and forgets it. */
  lastPassiveResolution: Promise<void> | null = null;

  constructor(deps: ExecutorDeps) {
    this.#d = deps;
    this.#cfg = { ...DEFAULT_EXECUTOR_CONFIG, ...deps.config };
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#parse = deps.parseSwap ?? normalizeSwap;
  }

  /** The scheduler's Executor function. Serialized so only one execution is ever in flight. */
  execute = (plan: PlannedTrade): Promise<ExecutionOutcome> => {
    const run = this.#chain.then(() => this.#execute(plan));
    // Keep the chain alive regardless of this run's outcome; swallow here so one throw does not
    // poison the queue for the next execution.
    this.#chain = run.catch(() => undefined);
    return run;
  };

  async #execute(plan: PlannedTrade): Promise<ExecutionOutcome> {
    const outcome = await this.#run(plan).catch((err): ExecutionOutcome => {
      this.#d.log.error({ scheduleId: plan.schedule.id, err: msg(err) }, 'autotrader executor: unexpected error');
      return { state: 'failed', usdValue: plan.usdValue, error: `executor error: ${msg(err)}` };
    });
    await this.#accountForOutcome(outcome, plan);
    return outcome;
  }

  /** Kill switch: three consecutive non-confirmed executions is a broken assumption, not bad luck. */
  async #accountForOutcome(outcome: ExecutionOutcome, plan: PlannedTrade): Promise<void> {
    if (outcome.state === 'confirmed') {
      this.#consecutiveFailures = 0;
      return;
    }
    // 'failed' and 'UNKNOWN' both count — a repeating UNKNOWN is as much a broken assumption as a repeating failure.
    this.#consecutiveFailures++;
    if (this.#consecutiveFailures >= FAILURE_KILL_THRESHOLD && !this.#killed) {
      this.#killed = true;
      const reason = `kill switch: ${FAILURE_KILL_THRESHOLD} consecutive executions did not confirm`;
      const halted = await this.#d.repo.haltAllActiveSchedules(reason, this.#now());
      this.#d.log.error({ halted, lastSchedule: plan.schedule.id }, `autotrader executor: KILL SWITCH — halted ${halted} schedule(s)`);
      if (this.#d.ownerUserId !== undefined) {
        await this.#d.dm
          .send(this.#d.ownerUserId, `🛑 Autotrader KILL SWITCH: ${FAILURE_KILL_THRESHOLD} executions in a row did not confirm. Halted ${halted} schedule(s). Investigate before resuming.`)
          .catch(() => undefined);
      }
    }
  }

  async #run(plan: PlannedTrade): Promise<ExecutionOutcome> {
    const { schedule } = plan;
    const pubkey = this.#d.wallets.pubkeyOf(schedule.userId);
    if (!pubkey) return { state: 'failed', usdValue: plan.usdValue, error: 'no wallet for user' };

    // --- amount + direction. The mint is the schedule's, ALWAYS explicit. ---
    let inputMint: string;
    let outputMint: string;
    let amount: bigint;
    if (schedule.side === 'buy') {
      // percent_of_balance is a SELL concept (a fraction of a token holding). A percent BUY has no
      // defined amount here and must not be mis-executed as `amountRaw` lamports.
      if (schedule.amountKind === 'percent_of_balance') {
        return { state: 'failed', usdValue: plan.usdValue, error: 'percent_of_balance is only supported for sells' };
      }
      inputMint = SOL_MINT;
      outputMint = schedule.mint;
      amount = schedule.amountRaw; // lamports of SOL
    } else {
      inputMint = schedule.mint;
      outputMint = SOL_MINT;
      if (schedule.amountKind === 'percent_of_balance') {
        // Read at EXECUTION time, scoped to THIS mint by address — not the balance at schedule
        // creation, not "the largest token", not an index. A different balance is a different trade.
        const balance = await this.#d.balances.mintBalance(pubkey, schedule.mint);
        amount = (balance * schedule.amountRaw) / 10_000n; // amountRaw is basis points for percent
        if (amount <= 0n) return { state: 'failed', usdValue: plan.usdValue, error: 'percent_of_balance resolved to zero — nothing to sell' };
      } else {
        amount = schedule.amountRaw; // raw token units
      }
    }

    // --- 1. QUOTE ---
    const quote = await this.#d.jupiter.quote({ inputMint, outputMint, amount, slippageBps: schedule.slippageBps });

    // --- Recompute USD for a sell and RE-CHECK caps against the recomputed value. A sell of 10% of
    //     a balance that has changed is a different trade than the one the caps were checked against. ---
    let tradeUsd = plan.usdValue;
    const solUsd = this.#d.solUsd();
    if (schedule.side === 'sell') {
      if (solUsd === null) return { state: 'failed', usdValue: plan.usdValue, error: 'SOL feed down — cannot value the sell against caps' };
      tradeUsd = (Number(quote.outAmount) / LAMPORTS_PER_SOL) * solUsd;
      const breach = await this.#capRecheck(schedule, tradeUsd);
      if (breach) {
        await this.#d.repo.haltSchedule(schedule.id, breach, this.#now());
        this.#d.log.warn({ scheduleId: schedule.id, breach }, 'autotrader executor: recomputed sell breaches caps — halted');
        return { state: 'failed', usdValue: tradeUsd, error: breach };
      }
    }

    // --- 2. PRICE-IMPACT GUARD, before we build or sign anything. ---
    if (quote.priceImpactPct > this.#cfg.maxPriceImpactPct) {
      const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
      return { state: 'failed', usdValue: tradeUsd, error: `price impact ${pct(quote.priceImpactPct)} exceeds max ${pct(this.#cfg.maxPriceImpactPct)}` };
    }

    // --- 3. BUILD (Jupiter swap tx, with a priority fee). ---
    const { swapTransaction } = await this.#d.jupiter.buildSwap({
      quote,
      userPublicKey: pubkey,
      prioritizationFeeLamports: this.#cfg.priorityFeeLamports,
    });

    // --- 4. SIGN. The signer's guard IS the mint guard: it simulates, diffs, and REJECTS any
    //     transaction touching a mint other than SOL/WSOL and this schedule's mint — BEFORE it
    //     produces a signature. allowedMints is the schedule's mint; the guard permits WSOL itself. ---
    let signed: string;
    try {
      signed = await this.#d.signer.sign(schedule.userId, [schedule.mint], swapTransaction);
    } catch (err) {
      // Rejected before signing — never reaches submit.
      return { state: 'failed', usdValue: tradeUsd, error: `signer/guard rejected: ${msg(err)}` };
    }

    // --- 5. SIMULATE the signed transaction before sending, every time. A failed simulation is
    //     free; a failed send costs a fee and a slot. This never reaches submit on failure. ---
    const sim = await this.#d.chain.simulate(signed);
    if (sim.err !== null && sim.err !== undefined) {
      return { state: 'failed', usdValue: tradeUsd, error: `simulation failed: ${jsonish(sim.err)}` };
    }

    // --- 6. SUBMIT. Record the signature and state='submitted' BEFORE sending. The signature is a
    //     property of the SIGNED bytes, so we know it without sending — record it, then send. If the
    //     process dies mid-send, the signature is on disk and the outcome is discoverable. ---
    const signature = signatureOf(signed);
    await this.#d.repo.settleExecution(plan.executionId, { state: 'submitted', signature, usdValue: tradeUsd });

    try {
      await this.#d.chain.send(signed);
    } catch (err) {
      // A send error is NOT proof of failure — the transaction may still have propagated. Fall through
      // to confirmation; if it never lands, the confirm timeout takes us to UNKNOWN, not to a blind failed.
      this.#d.log.warn({ scheduleId: schedule.id, signature, err: msg(err) }, 'autotrader executor: send errored; confirming anyway (may still land)');
    }

    // --- 7. CONFIRM, bounded. ---
    return this.#confirm(plan, signature, tradeUsd, pubkey);
  }

  /** Re-check the per-exec and rolling-24h caps against a (possibly recomputed) USD value. */
  async #capRecheck(schedule: Schedule, usd: number): Promise<string | null> {
    const caps = await this.#d.repo.getCaps(schedule.userId, schedule.mint);
    if (!caps) return null; // no caps configured -> nothing to re-check (the scheduler seeds them)
    if (usd > caps.maxPerExecUsd) return `per-exec cap: $${usd.toFixed(2)} > $${caps.maxPerExecUsd.toFixed(2)}`;
    const spent = await this.#d.repo.usdSpent24h(schedule.userId, schedule.mint, this.#now() - DAY_MS);
    if (spent + usd > caps.maxPerDayUsd) return `24h cap: $${(spent + usd).toFixed(2)} > $${caps.maxPerDayUsd.toFixed(2)}`;
    return null;
  }

  async #confirm(plan: PlannedTrade, signature: string, tradeUsd: number, pubkey: string): Promise<ExecutionOutcome> {
    const deadline = this.#now() + this.#cfg.confirmTimeoutMs;
    for (;;) {
      const status = await this.#d.chain.signatureStatus(signature).catch(() => null);
      if (status) {
        if (status.err !== null && status.err !== undefined) {
          return { state: 'failed', signature, usdValue: tradeUsd, error: `on-chain failure: ${jsonish(status.err)}` };
        }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return this.#recordConfirmed(plan.schedule, signature, tradeUsd, pubkey);
        }
      }
      if (this.#now() >= deadline) {
        // --- THE UNKNOWN PATH. A timeout is NOT a failure. Halt, tell the owner, resolve passively. ---
        return this.#onUnknown(plan, signature, tradeUsd, pubkey);
      }
      await this.#sleep(this.#cfg.confirmPollMs);
    }
  }

  /** Parse the REAL transaction through normalizeSwap — the chain is the truth; quoted amounts are
   *  estimates. Records in_raw/out_raw/price_usd from what actually happened. */
  async #recordConfirmed(schedule: Schedule, signature: string, tradeUsd: number, pubkey: string): Promise<ExecutionOutcome> {
    const tx = await this.#d.chain.getTransaction(signature).catch(() => null);
    const solUsd = this.#d.solUsd();
    let inRaw: bigint | null = null;
    let outRaw: bigint | null = null;
    let priceUsd: number | null = null;
    let usdValue: number | null = tradeUsd;

    if (tx) {
      const { event } = this.#parse(tx, schedule.mint as Mint, { wallet: pubkey as Mint, solUsd });
      if (event && (event.kind === 'buy' || event.kind === 'sell')) {
        // buy: paid quoteRaw (SOL), received tokensRaw (mint). sell: paid tokensRaw, received quoteRaw.
        if (event.kind === 'buy') {
          inRaw = event.quoteRaw;
          outRaw = event.tokensRaw;
        } else {
          inRaw = event.tokensRaw;
          outRaw = event.quoteRaw;
        }
        const dec = await this.#d.decimalsOf(schedule.mint);
        if (solUsd !== null && dec !== null && event.tokensRaw > 0n) {
          usdValue = (Number(event.quoteRaw) / LAMPORTS_PER_SOL) * solUsd;
          priceUsd = usdValue / (Number(event.tokensRaw) / 10 ** dec);
        }
      } else {
        this.#d.log.warn({ signature, mint: schedule.mint }, 'autotrader executor: confirmed tx did not parse as a buy/sell; recording confirmed without amounts');
      }
    }
    return { state: 'confirmed', signature, inRaw, outRaw, priceUsd, usdValue };
  }

  async #onUnknown(plan: PlannedTrade, signature: string, tradeUsd: number, pubkey: string): Promise<ExecutionOutcome> {
    const { schedule } = plan;
    await this.#d.repo.haltSchedule(schedule.id, `UNKNOWN outcome for execution ${plan.executionId} (${signature})`, this.#now());
    this.#d.log.error({ scheduleId: schedule.id, executionId: plan.executionId, signature }, 'autotrader executor: outcome UNKNOWN — schedule HALTED, resolving passively');
    await this.#d.dm
      .send(
        schedule.userId,
        `⚠️ Autotrader: a swap did not confirm in time and its outcome is UNKNOWN. Schedule #${schedule.id} is halted.\n` +
          `Signature: ${signature}\n${solscan(signature)}\n` +
          `I will keep checking for 15 minutes. If it stays ambiguous, run /resolve ${plan.executionId} confirmed|failed after checking the chain yourself.`,
      )
      .catch(() => undefined);

    // Fire-and-forget passive resolution. It runs OUTSIDE the execution mutex so it cannot block trading.
    this.lastPassiveResolution = this.#resolvePassively(plan.executionId, signature, schedule, pubkey, tradeUsd);

    return { state: 'UNKNOWN', signature, usdValue: tradeUsd, error: 'confirmation timed out — outcome unknown' };
  }

  /**
   * Poll getSignatureStatuses every 30s for 15 minutes.
   *   - confirms  -> record it and UNHALT.
   *   - explicit failure, or null past blockhash expiry (dropped) -> record failed and UNHALT.
   *   - still ambiguous after 15 minutes -> STAY HALTED; only /resolve exits. Never auto-resume from ambiguity.
   */
  async #resolvePassively(executionId: number, signature: string, schedule: Schedule, pubkey: string, tradeUsd: number): Promise<void> {
    const start = this.#now();
    const deadline = start + this.#cfg.resolveTimeoutMs;
    for (;;) {
      await this.#sleep(this.#cfg.resolvePollMs);
      const status = await this.#d.chain.signatureStatus(signature).catch(() => null);

      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') && (status.err === null || status.err === undefined)) {
        const outcome = await this.#recordConfirmed(schedule, signature, tradeUsd, pubkey);
        await this.#d.repo.settleExecution(executionId, outcome);
        await this.#d.repo.unhaltSchedule(schedule.id);
        await this.#dmResolved(schedule, executionId, 'confirmed late — schedule resumed');
        return;
      }
      if (status && status.err !== null && status.err !== undefined) {
        await this.#d.repo.settleExecution(executionId, { state: 'failed', signature, usdValue: tradeUsd, error: `on-chain failure (resolved): ${jsonish(status.err)}` });
        await this.#d.repo.unhaltSchedule(schedule.id);
        await this.#dmResolved(schedule, executionId, 'failed on-chain — schedule resumed');
        return;
      }
      // Not found AND past blockhash expiry: an expired blockhash can never be included, so this is
      // a definitive drop, not lag.
      if (status === null && this.#now() - start >= this.#cfg.droppedAfterMs) {
        await this.#d.repo.settleExecution(executionId, { state: 'failed', signature, usdValue: tradeUsd, error: 'dropped (blockhash expired, never landed)' });
        await this.#d.repo.unhaltSchedule(schedule.id);
        await this.#dmResolved(schedule, executionId, 'dropped (never landed) — schedule resumed');
        return;
      }
      if (this.#now() >= deadline) {
        this.#d.log.error({ scheduleId: schedule.id, executionId, signature }, 'autotrader executor: STILL ambiguous after 15m — staying halted, /resolve required');
        await this.#d.dm
          .send(schedule.userId, `⚠️ Autotrader: execution ${executionId} is STILL ambiguous after 15 minutes. Schedule #${schedule.id} stays halted. Check ${solscan(signature)} and run /resolve ${executionId} confirmed|failed.`)
          .catch(() => undefined);
        return; // stays halted; the row stays UNKNOWN
      }
    }
  }

  async #dmResolved(schedule: Schedule, executionId: number, what: string): Promise<void> {
    await this.#d.dm.send(schedule.userId, `Autotrader: execution ${executionId} ${what}.`).catch(() => undefined);
  }

  /**
   * /resolve <executionId> confirmed|failed — the human exit from ambiguity. Only acts on a still-
   * UNKNOWN execution; sets the verdict, and unhalts the schedule. 'confirmed' parses the real
   * transaction for amounts, same as an in-band confirmation.
   */
  async resolve(executionId: number, verdict: 'confirmed' | 'failed'): Promise<{ ok: boolean; message: string }> {
    const exec = await this.#d.repo.getExecution(executionId);
    if (!exec) return { ok: false, message: `no execution ${executionId}` };
    if (exec.state !== 'UNKNOWN') return { ok: false, message: `execution ${executionId} is '${exec.state}', not UNKNOWN — nothing to resolve` };
    const schedule = await this.#d.repo.getSchedule(exec.scheduleId);
    if (!schedule) return { ok: false, message: `execution ${executionId} has no schedule` };
    const pubkey = this.#d.wallets.pubkeyOf(exec.userId) ?? '';

    if (verdict === 'confirmed') {
      const outcome = exec.signature
        ? await this.#recordConfirmed(schedule, exec.signature, exec.usdValue ?? 0, pubkey)
        : ({ state: 'confirmed', usdValue: exec.usdValue } as ExecutionOutcome);
      await this.#d.repo.settleExecution(executionId, outcome);
    } else {
      await this.#d.repo.settleExecution(executionId, { state: 'failed', signature: exec.signature, usdValue: exec.usdValue, error: 'resolved: failed by operator' });
    }
    await this.#d.repo.unhaltSchedule(exec.scheduleId);
    // A manual resolution clears the consecutive-failure trail; the operator has looked and decided.
    this.#consecutiveFailures = 0;
    this.#killed = false;
    return { ok: true, message: `execution ${executionId} resolved ${verdict}; schedule #${exec.scheduleId} resumed` };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function jsonish(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
