import { toFloat, rawAmount } from '../core/money.js';
import { quoteDef, type QuoteAssetDef } from '../core/quotes.js';
import type { Mint, NormalizedEvent, Position, SwapRecord, Wallet } from '../core/types.js';
import type { Repo } from '../db/index.js';
import { normalizeSwap } from '../ingest/normalize.js';
import type { ConfirmedTx } from '../ingest/solana-types.js';
import type { Logger } from '../ops/logger.js';
import type { HistoricalSolUsd } from './history-price.js';

/** Hard cap. A wallet with more history than this cannot be reconciled from here. */
export const MAX_SIGNATURES = 1_000;
export const CONCURRENCY = 2;
export const WALLET_CACHE_MS = 24 * 60 * 60 * 1_000;

/** Signatures per JSON-RPC batch request. Raw txs are heavy; do not fetch them one by one. */
export const RAW_FETCH_BATCH = 100;
/** Batches in flight. Respects the rate limiter — this is a background job. */
export const RAW_FETCH_CONCURRENCY = 2;

/**
 * DISCOVERY ONLY.
 *
 * This tells us WHICH signatures touched a wallet, and hands back the RAW transaction
 * for each. It does not classify anything — `normalizeSwap` does, exactly as it does
 * for the live socket.
 */
export interface HistorySource {
  /** Signatures for an address, newest first, capped. */
  signaturesFor(wallet: Wallet, limit: number): Promise<Array<{ signature: string; slot: number }>>;
  getTransaction(signature: string): Promise<ConfirmedTx | null>;
  /** Batched form. Preferred when available; `getTransaction` is the fallback. */
  getTransactions?(signatures: readonly string[]): Promise<Array<ConfirmedTx | null>>;
}

export interface BackfillDeps {
  readonly repo: Repo;
  readonly history: HistorySource;
  readonly solHistory: HistoricalSolUsd;
  readonly log: Logger;
  readonly stableUsd?: number;
  readonly now?: () => number;
}

export type BackfillOutcome =
  | {
      readonly status: 'reconciled';
      readonly position: Position;
      readonly replayed: number;
      /** Rows the walk added to the log. Zero on a re-walk: the PK already held them. */
      readonly inserted: number;
    }
  /** History was walked but the ledger still does not match the chain. */
  | {
      readonly status: 'unreconciled';
      readonly reason: 'cap-hit' | 'drift-remains' | 'unpriceable';
      readonly driftRaw: bigint;
      readonly replayed: number;
      readonly inserted: number;
    }
  | { readonly status: 'skipped'; readonly reason: 'cached' | 'no-decimals' };

/**
 * One-shot per-wallet history replay.
 *
 * ITS JOB IS TO REACH reconciled=1, NOT MERELY TO RUN.
 *
 * If the replay finishes and drift is still outside dust — the 1000-signature cap
 * was hit, or a historical price could not be resolved, or the history is
 * otherwise incomplete — we leave `reconciled = 0` and STOP. We do NOT then show
 * an approximate percentage.
 *
 * "Approximate beats absent" is the wrong instinct for this field. A wrong number
 * is worse than no number: nobody screenshots a missing line.
 *
 * A backfill NEVER blocks a send. If it has not finished when the card renders,
 * the card posts without the Position line and moves on. The message is NOT
 * edited afterwards.
 */
export class Backfiller {
  readonly #repo: Repo;
  readonly #history: HistorySource;
  readonly #solHistory: HistoricalSolUsd;
  readonly #log: Logger;
  readonly #stableUsd: number;
  readonly #now: () => number;

  /** In-flight and recently-done wallets, so a burst of buys triggers ONE walk. */
  readonly #inflight = new Map<string, Promise<BackfillOutcome>>();
  #running = 0;
  readonly #queue: Array<() => void> = [];

  constructor(deps: BackfillDeps) {
    this.#repo = deps.repo;
    this.#history = deps.history;
    this.#solHistory = deps.solHistory;
    this.#log = deps.log;
    this.#stableUsd = deps.stableUsd ?? 1;
    this.#now = deps.now ?? Date.now;
  }

  get inflightCount(): number {
    return this.#inflight.size;
  }

  /** Concurrency 2. Excess work waits rather than stampeding the RPC. */
  async #slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#running >= CONCURRENCY) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#running++;
    try {
      return await fn();
    } finally {
      this.#running--;
      this.#queue.shift()?.();
    }
  }

  /**
   * Enqueue a backfill. Fire-and-forget from the caller's point of view — this is
   * deliberately NOT awaited on the send path.
   */
  enqueue(mint: Mint, wallet: Wallet, decimals: number): Promise<BackfillOutcome> {
    const key = `${mint}:${wallet}`;
    const existing = this.#inflight.get(key);
    if (existing) return existing;

    const task = this.#slot(() => this.#run(mint, wallet, decimals)).finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, task);
    return task;
  }

  async #run(mint: Mint, wallet: Wallet, decimals: number): Promise<BackfillOutcome> {
    const now = this.#now();

    const prior = await this.#repo.getPosition(mint, wallet);
    if (prior?.backfilledAt && now - prior.backfilledAt < WALLET_CACHE_MS) {
      return { status: 'skipped', reason: 'cached' };
    }

    const sigs = await this.#history.signaturesFor(wallet, MAX_SIGNATURES);
    const capHit = sigs.length >= MAX_SIGNATURES;

    // Oldest -> newest. The chain hands them back newest-first, and the fold orders
    // by slot anyway — but discovering them in order keeps the log's `source` and
    // the walk itself easy to reason about.
    const ordered = [...sigs].reverse();

    // Helius history is for DISCOVERY ONLY: it tells us WHICH signatures touched this
    // wallet. The classification itself goes through `normalizeSwap` — the same
    // function, on the same raw transaction shape, that the live socket uses.
    //
    // There is no second parser. A backfill that classified a transaction differently
    // from the live path would double-count it, and no amount of testing makes two
    // independent classifiers agree forever. So there is only one.
    const txs = await this.#fetchRaw(ordered.map((s) => s.signature));

    const discovered: SwapRecord[] = [];
    let unpriceable = false;

    for (const { signature } of ordered) {
      const tx = txs.get(signature);
      if (!tx) continue;

      // Scoped to THIS wallet: we are walking its history, so the question is "what
      // did this wallet do here", not "who was the buyer".
      const { event } = normalizeSwap(tx, mint, { wallet, log: this.#log });
      if (!event) continue;

      const rec = await this.#toSwap(event, mint, wallet);
      if (rec === null) {
        unpriceable = true; // a priced leg we could not value; the basis is now suspect
        continue;
      }
      discovered.push(rec);
    }

    // NOTHING IS OVERWRITTEN. We insert the facts we found and recompute the fold.
    //
    // A live buy that landed DURING this walk has already inserted its own row, so
    // the fold picks it up — its tokens and its cost survive. There is nothing to
    // clobber, so there is nothing to abort, so a hot wallet converges.
    //
    // INSERT OR IGNORE on (signature, mint, wallet, kind) makes the walk idempotent:
    // re-walking inserts zero rows and changes nothing.
    const { position, inserted } = await this.#repo.applySwaps(discovered, {
      mint,
      wallet,
      decimals,
      backfilled: true,
      backfilledAt: now,
      // We KNOW this history is incomplete. Drift may still read as zero (the missing
      // swaps happened to net out) while the cost basis is missing legs, so this
      // vetoes reconciliation outright rather than trusting the arithmetic.
      historyTruncated: capHit || unpriceable,
    });

    if (position.reconciled) {
      this.#log.info(
        { mint, wallet, replayed: discovered.length, inserted },
        'backfill reconciled the ledger against the chain',
      );
      return { status: 'reconciled', position, replayed: discovered.length, inserted };
    }

    const reason = capHit ? 'cap-hit' : unpriceable ? 'unpriceable' : 'drift-remains';
    this.#log.warn(
      {
        mint,
        wallet,
        replayed: discovered.length,
        inserted,
        capHit,
        driftRaw: position.driftRaw.toString(),
        reason,
      },
      'backfill did NOT reconcile; Position % stays hidden for this wallet',
    );
    return {
      status: 'unreconciled',
      reason,
      driftRaw: position.driftRaw,
      replayed: discovered.length,
      inserted,
    };
  }

  /**
   * Raw transactions for a batch of signatures.
   *
   * Raw is heavier than parsed history, so we batch (JSON-RPC batch requests) and cap
   * the number of batches in flight. That is the price of having ONE parser, and it
   * is worth paying: the alternative is a second classifier that can disagree with
   * the live path about what a transaction was.
   */
  async #fetchRaw(signatures: readonly string[]): Promise<Map<string, ConfirmedTx>> {
    const chunks: string[][] = [];
    for (let i = 0; i < signatures.length; i += RAW_FETCH_BATCH) {
      chunks.push(signatures.slice(i, i + RAW_FETCH_BATCH) as string[]);
    }

    const out = new Map<string, ConfirmedTx>();
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < chunks.length) {
        const chunk = chunks[next++] as string[];
        const txs = this.#history.getTransactions
          ? await this.#history.getTransactions(chunk)
          : await Promise.all(chunk.map((s) => this.#history.getTransaction(s)));

        chunk.forEach((sig, i) => {
          const tx = txs[i];
          if (tx) out.set(sig, tx);
        });
      }
    };

    await Promise.all(Array.from({ length: RAW_FETCH_CONCURRENCY }, worker));
    return out;
  }

  /**
   * One normalized event -> one durable fact. Null = a priced leg we could not value.
   *
   * Transfers get rows too, at usd_value 0: they were FREE. That is what makes an
   * airdrop reconcile to zero cost instead of phantom profit — and it is why an
   * unreconciled wallet MUST trigger a backfill. The LIVE path filters transfers out
   * (they are never posted), so this is the only path by which they enter the log.
   */
  async #toSwap(ev: NormalizedEvent, mint: Mint, wallet: Wallet): Promise<SwapRecord | null> {
    const base = {
      signature: ev.signature,
      mint,
      wallet,
      tokensRaw: ev.tokensRaw,
      balanceAfterRaw: ev.balanceAfterRaw,
      slot: ev.slot,
      blockTime: ev.blockTime,
      source: 'backfill' as const,
    };

    if (ev.kind === 'transfer') {
      return {
        ...base,
        kind: ev.direction === 'in' ? 'transfer_in' : 'transfer_out',
        quoteMint: null,
        quoteSymbol: null,
        quoteRaw: null,
        usdValue: 0,
        // The PARSER decided this, because the parser is the only place that had every
        // delta for the wallet in one hand. A free airdrop is `unpriced: false` and its
        // zero cost is the TRUTH; an arb against some unvaluable token is
        // `unpriced: true` and its zero cost would be a lie (Phase 4.7).
        unpriced: ev.unpriced,
      };
    }

    const def = quoteDef(ev.quoteMint);
    if (!def) return null; // a quote asset we cannot value

    const usd = await this.#usdOf(def, ev.quoteRaw, ev.blockTime);
    if (usd === null) return null;

    return {
      ...base,
      kind: ev.kind,
      quoteMint: ev.quoteMint,
      quoteSymbol: ev.quoteSymbol,
      quoteRaw: ev.quoteRaw,
      usdValue: usd,
      unpriced: false, // a registry quote asset is what made it a buy/sell at all
    };
  }

  /** USD value of a historical quote leg, AT THE TIME IT HAPPENED. */
  async #usdOf(def: QuoteAssetDef, raw: bigint, blockTime: number | null): Promise<number | null> {
    const amount = toFloat(rawAmount(raw, def.decimals));

    if (def.priceSource === 'stable') return amount * this.#stableUsd;

    // SOL-quoted: price it at the SOL/USD of its block time, not today's. Replaying a
    // three-week-old buy at today's SOL price puts the error into the Position %.
    if (blockTime === null) return null;
    const sol = await this.#solHistory.at(blockTime);
    if (sol === null) return null;
    return amount * sol;
  }
}
