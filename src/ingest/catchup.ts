import type { Logger } from 'pino';

import type { Mint } from '../core/types.js';
import type { ConfirmedTx } from './solana-types.js';

/**
 * GAP RECOVERY. Phase 9.
 *
 * A websocket reconnect leaves a hole: the buys that landed while we were disconnected were
 * never delivered, and Helius does not replay them. Until now those buys were simply logged
 * as a slot gap and lost.
 *
 * THE RECOVERED BUYS GO THROUGH THE SAME PIPELINE. This module fetches transactions and
 * hands them to the caller — it does NOT classify them, does not price them, and does not
 * decide whether they are buys. `normalizeSwap` does that, exactly as it does for the live
 * socket. A second path that decided what a buy was would be a second classifier, and
 * INVARIANT 12 exists because that has already gone wrong once.
 *
 * Idempotency handles the overlap: the recovery window deliberately reaches back PAST the
 * last slot we saw, so it re-delivers a few transactions we already posted. That is fine
 * and it is the point — `claimSend` drops them silently (INVARIANT 2), and the `swaps` PK
 * drops the duplicate rows. Overlapping is safe; a gap is not.
 */

/** Never walk more than this, however long we were away. */
export const MAX_SIGNATURES = 500;

/**
 * A buy older than this is not news, and a flood of them is worse than silence.
 *
 * After a 40-minute outage, dumping every missed buy into the group at once posts prices
 * that are no longer true, in an order that no longer means anything, and rate-limits the
 * bot into the bargain. The 120s staleness rule in the queue would drop most of them
 * anyway — this just declines to spend the RPC calls and the wall-clock discovering that.
 *
 * We log the gap loudly instead. A missed window that somebody knows about is a fact; a
 * missed window that nobody knows about is a bug.
 */
export const MAX_CATCHUP_AGE_MS = 10 * 60_000;

export interface CatchupRpc {
  /** Newest-first, as the RPC returns them. */
  getSignaturesForAddress(
    mint: Mint,
    limit: number,
  ): Promise<readonly { signature: string; slot: number; blockTime: number | null }[]>;
  getTransaction(signature: string): Promise<ConfirmedTx | null>;
}

export interface CatchupDeps {
  readonly rpc: CatchupRpc;
  readonly log: Logger;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
  readonly maxSignatures?: number;
}

export interface CatchupResult {
  /** Transactions to feed through normalizeSwap, OLDEST FIRST. */
  readonly txs: readonly ConfirmedTx[];
  readonly scanned: number;
  readonly skippedTooOld: number;
  readonly truncated: boolean;
}

/**
 * Fetch everything that touched `mint` since `fromSlot`.
 *
 * Returns OLDEST FIRST. The RPC hands them back newest-first, and replaying a burst in
 * reverse would post a wallet's second buy before its first — which the cost-basis fold
 * would then have to unpick, and which reads as nonsense in the group.
 */
export async function catchUp(
  deps: CatchupDeps,
  mint: Mint,
  fromSlot: number,
  currentSlot: number,
): Promise<CatchupResult> {
  const now = deps.now ?? Date.now;
  const maxAge = deps.maxAgeMs ?? MAX_CATCHUP_AGE_MS;
  const limit = deps.maxSignatures ?? MAX_SIGNATURES;

  if (currentSlot <= fromSlot) return { txs: [], scanned: 0, skippedTooOld: 0, truncated: false };

  const sigs = await deps.rpc.getSignaturesForAddress(mint, limit);
  const truncated = sigs.length >= limit;

  const wanted: { signature: string; slot: number }[] = [];
  let skippedTooOld = 0;

  for (const s of sigs) {
    if (s.slot <= fromSlot) break; // newest-first: everything past here is already ours

    // blockTime is SECONDS. A null blockTime means the chain did not report one; treat it as
    // recent rather than silently dropping a buy we cannot date.
    const ageMs = s.blockTime === null ? 0 : now() - s.blockTime * 1000;
    if (ageMs > maxAge) {
      skippedTooOld++;
      continue;
    }
    wanted.push({ signature: s.signature, slot: s.slot });
  }

  if (skippedTooOld > 0) {
    deps.log.warn(
      { mint, skipped: skippedTooOld, maxAgeMin: Math.round(maxAge / 60_000) },
      'gap recovery: buys older than the age cap were NOT recovered — the window is gone, and it is gone on purpose',
    );
  }

  // Oldest first.
  wanted.reverse();

  const txs: ConfirmedTx[] = [];
  for (const { signature } of wanted) {
    try {
      const tx = await deps.rpc.getTransaction(signature);
      if (tx) txs.push(tx);
    } catch (err) {
      // One bad fetch must not abandon the rest of the window.
      deps.log.warn({ mint, signature, err: (err as Error).message }, 'gap recovery: could not fetch a transaction');
    }
  }

  if (txs.length > 0 || skippedTooOld > 0) {
    deps.log.info(
      { mint, fromSlot, currentSlot, recovered: txs.length, skippedTooOld, truncated },
      'gap recovery complete',
    );
  }

  return { txs, scanned: sigs.length, skippedTooOld, truncated };
}
