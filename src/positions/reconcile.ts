/**
 * RECONCILIATION: check the ledger against the chain, on every buy.
 *
 * Without this, Position % is a confident public lie.
 *
 * The ledger's `tokensRaw` / `costUsd` are built ONLY from buys this bot happened
 * to observe. `holdingsUsd` comes from `balanceAfterRaw` — exact, on-chain. For any
 * wallet with prior history the bot never saw, those two describe DIFFERENT
 * QUANTITIES.
 *
 * Concretely: a wallet holding 10M tokens bought at $0.00001 last month buys 200K
 * more today. The card renders correct holdings from the chain AND "Position +2%"
 * from a cost basis made entirely of today's buy. The wallet is actually up ~900%.
 * The bot states a specific, confident, public number that is wrong by two orders
 * of magnitude.
 *
 * Transfers break it in both directions and are invisible to the normalizer (which
 * returns null on them, by design): an airdrop recipient's ledger under-counts, a
 * wallet that sent tokens out over-counts.
 *
 * The fix is free. `balanceAfterRaw` arrives on EVERY buy, so every buy is a
 * reconciliation checkpoint.
 */

/**
 * Dust tolerance, in RAW UNITS. One raw unit — the smallest indivisible amount of
 * any token — purely to absorb rounding.
 *
 * NOT a percentage. A percentage tolerance would silently accept a whale whose
 * ledger is off by 1% of an enormous bag, which is precisely the wallet whose
 * Position % must not be guessed at.
 */
export const DUST_TOLERANCE_RAW = 1n;

export interface Reconciliation {
  /** Last balanceAfterRaw seen from the chain. Exact. */
  readonly onchainRaw: bigint;
  /** onchain_raw - tokens_raw, SIGNED. Nonzero means we are missing history. */
  readonly driftRaw: bigint;
  /** True iff the ledger agrees with the chain to within dust. */
  readonly reconciled: boolean;
}

/**
 * Compare the ledger's token count against what the chain actually says the wallet
 * holds.
 *
 * Sign is meaningful:
 *   drift > 0  the chain holds MORE than the ledger knows (unseen buys, or an
 *              airdrop / incoming transfer)
 *   drift < 0  the ledger holds MORE than the chain (the wallet sent tokens out,
 *              or sold somewhere we did not observe)
 */
export function reconcile(ledgerTokensRaw: bigint, onchainRaw: bigint): Reconciliation {
  const driftRaw = onchainRaw - ledgerTokensRaw;
  const abs = driftRaw < 0n ? -driftRaw : driftRaw;
  return { onchainRaw, driftRaw, reconciled: abs <= DUST_TOLERANCE_RAW };
}
