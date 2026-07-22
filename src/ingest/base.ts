import type { Mint } from '../core/types.js';
import type { Repo } from '../db/index.js';
import type { Logger } from '../ops/logger.js';
import { SignatureLru } from './dedup.js';
import type { BuyHandler, Ingestor, SellHandler } from './types.js';
import { normalizeSwap } from './normalize.js';
import type { ConfirmedTx } from './solana-types.js';

export interface IngestorDeps {
  readonly log: Logger;
  readonly repo: Repo;
  /** Test seam. Defaults to a 5k-signature LRU. */
  readonly lru?: SignatureLru;
  /**
   * Live SOL/USD, used ONLY to rank competing quote legs when a buyer pays with
   * more than one registry asset. It never prices a buy — pricing/ does that.
   * Optional: without it, ranking falls back to a reference price.
   */
  readonly solUsd?: () => number | null;
}

/**
 * Everything both adapters share: the subscription set, dedup, cursor tracking,
 * and the ONE normalizer path.
 *
 * The WS and webhook adapters differ only in how bytes arrive. They must not
 * differ in how a transaction is interpreted — a webhook fallback that classified
 * buys differently from the socket would be a silent, invisible bug.
 */
export abstract class BaseIngestor implements Ingestor {
  protected readonly log: Logger;
  protected readonly repo: Repo;

  readonly #lru: SignatureLru;
  readonly #solUsd: () => number | null;
  readonly #mints = new Set<Mint>();
  readonly #buyHandlers: BuyHandler[] = [];
  readonly #reconnectHandlers: (() => void)[] = [];
  readonly #sellHandlers: SellHandler[] = [];
  /** Highest slot seen per mint this process. Mirrors the `cursors` table. */
  readonly #lastSlot = new Map<Mint, number>();

  constructor(deps: IngestorDeps) {
    this.log = deps.log;
    this.repo = deps.repo;
    this.#lru = deps.lru ?? new SignatureLru(5_000);
    this.#solUsd = deps.solUsd ?? (() => null);
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  get connected(): boolean {
    return false;
  }

  get mints(): readonly Mint[] {
    return [...this.#mints];
  }

  /**
   * Fired on every (re)connection of the transport.
   *
   * Phase 9 hangs GAP RECOVERY off this: a reconnect means we were away, and being away
   * means we missed buys. The recovered transactions are fed back through `ingest()` — the
   * SAME entry point the live socket uses — so they meet the same parser, the same filters
   * and the same handlers. There is no second path, and so there is nothing to keep in sync.
   */
  onReconnect(cb: () => void): void {
    this.#reconnectHandlers.push(cb);
  }

  protected emitReconnect(): void {
    for (const cb of this.#reconnectHandlers) {
      try {
        cb();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'reconnect handler threw');
      }
    }
  }

  onBuy(cb: BuyHandler): void {
    this.#buyHandlers.push(cb);
  }

  onSell(cb: SellHandler): void {
    this.#sellHandlers.push(cb);
  }

  /** Idempotent — re-subscribing a tracked mint must not open a second stream. */
  async subscribe(mint: Mint): Promise<void> {
    if (this.#mints.has(mint)) return;
    this.#mints.add(mint);

    const cursor = await this.repo.getCursor(mint);
    if (cursor !== null) this.#lastSlot.set(mint, cursor);

    this.onSubscribe(mint);
  }

  async unsubscribe(mint: Mint): Promise<void> {
    if (!this.#mints.delete(mint)) return;
    this.onUnsubscribe(mint);
  }

  /** Adapters hook these to do their transport-specific wiring. */
  protected onSubscribe(_mint: Mint): void {}
  protected onUnsubscribe(_mint: Mint): void {}

  /**
   * The single entry point for a raw transaction, whatever delivered it.
   *
   * A transaction can touch several tracked mints (an aggregator route through
   * two of our tokens), so we classify it against each one independently.
   */
  /**
   * Feed a transaction in from OUTSIDE the transport — gap recovery, and nothing else.
   *
   * It is a thin wrapper over `ingest()` on purpose: the recovered buy meets the same
   * parser, the same transfer filter, the same dedup LRU and the same handlers as a live
   * one. The overlap with what we already posted is deliberate and safe (claimSend drops it
   * silently), because overlapping is cheap and a gap is not.
   */
  async replay(tx: ConfirmedTx): Promise<void> {
    await this.ingest(tx);
  }

  protected async ingest(tx: ConfirmedTx): Promise<void> {
    const signature = tx.transaction.signatures[0];
    if (!signature) return;

    // Cheap in-process gate against reconnect replay. NOT a correctness boundary
    // — the DB claim is (INVARIANT 2).
    if (this.#lru.seen(signature)) {
      this.log.debug({ signature }, 'duplicate signature; skipping');
      return;
    }

    for (const mint of this.#mints) {
      const { event, reason } = normalizeSwap(tx, mint, { log: this.log, solUsd: this.#solUsd() });

      if (!event) {
        if (reason && reason !== 'no-mint-movement') {
          this.log.debug({ signature, mint, reason }, 'not a swap');
        }
        continue;
      }

      // THE LIVE FILTER (Phase 4.6). `normalizeSwap` classifies transfers as
      // first-class events so the backfiller can reuse this exact parser — but a
      // transfer has no quote leg, cannot be priced, and is never posted. It reaches
      // the ledger only through a backfill.
      //
      // One parser, two filters. Never two parsers.
      if (event.kind === 'transfer') {
        this.log.debug({ signature, mint, direction: event.direction }, 'transfer; not a swap');
        continue;
      }

      this.#trackSlot(mint, tx.slot);

      try {
        if (event.kind === 'buy') {
          for (const cb of this.#buyHandlers) await cb(event);
        } else {
          // Sells feed cost basis. They are NEVER posted to Telegram.
          for (const cb of this.#sellHandlers) await cb(event);
        }
      } catch (err) {
        this.log.error(
          { signature, mint, err: err instanceof Error ? err.message : String(err) },
          'handler threw while processing swap',
        );
      }
    }
  }

  /**
   * Track the high-water slot per mint and persist it.
   *
   * Gaps are LOGGED, not backfilled — backfill is Phase 9. A gap means the socket
   * dropped and we missed buys; it is worth knowing about, but silently
   * re-emitting old buys hours later would be worse than the gap itself.
   *
   * Slots are not contiguous on Solana (empty/skipped slots are normal), so a
   * gap is only interesting when it is large.
   */
  #trackSlot(mint: Mint, slot: number): void {
    const prev = this.#lastSlot.get(mint);

    if (prev !== undefined && slot > prev) {
      const gap = slot - prev;
      if (gap > 1_000) {
        this.log.warn(
          { mint, previousSlot: prev, slot, gap },
          'slot gap; buys in this window were missed (no backfill until Phase 9)',
        );
      }
    }

    if (prev === undefined || slot > prev) {
      this.#lastSlot.set(mint, slot);
      // setCursor never rewinds (guarded in SQL), so an out-of-order notification
      // cannot walk the cursor backwards.
      void this.repo.setCursor(mint, slot);
    }
  }
}
