import type { BuyEvent, Mint, SellEvent } from '../core/types.js';

export type BuyHandler = (e: BuyEvent) => void | Promise<void>;
export type SellHandler = (e: SellEvent) => void | Promise<void>;

/**
 * Source of swap events for a set of mints.
 *
 * INVARIANT 1: implementations detect swaps by BALANCE-DELTA parsing only. Both
 * adapters funnel into the SAME normalizer — the transport may vary, the
 * interpretation may not.
 */
export interface Ingestor {
  start(): Promise<void>;
  stop(): Promise<void>;

  onBuy(cb: BuyHandler): void;
  onSell(cb: SellHandler): void;

  /** Fired on every (re)connect. Phase 9 hangs gap recovery off this. */
  onReconnect(cb: () => void): void;
  /** Feed a transaction in from outside the transport (gap recovery). Same pipeline. */
  replay(tx: import('./solana-types.js').ConfirmedTx): Promise<void>;

  /** Idempotent. Mutates the live subscription set (Phase 8 adds mints at runtime). */
  subscribe(mint: Mint): Promise<void>;
  unsubscribe(mint: Mint): Promise<void>;

  readonly mints: readonly Mint[];
  readonly connected: boolean;
}
