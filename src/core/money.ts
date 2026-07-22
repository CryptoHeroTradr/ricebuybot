/**
 * INVARIANT 6: All money is integers (lamports / raw token units).
 * Floats only at the render boundary.
 *
 * Raw amounts are `bigint`. USD is the one exception — it is a derived,
 * display-oriented quantity and is carried as `number`, but it is only ever
 * produced by the helpers here, at the boundary, never accumulated in a loop.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Branded raw integer amount, paired with the decimals needed to interpret it. */
export interface RawAmount {
  /** Indivisible units: lamports for SOL, raw token units for an SPL mint. */
  readonly raw: bigint;
  readonly decimals: number;
}

export function rawAmount(raw: bigint, decimals: number): RawAmount {
  return { raw, decimals };
}

/**
 * Convert a raw integer amount to a float. RENDER BOUNDARY ONLY.
 * Never feed the result back into arithmetic that is later compared for equality.
 */
export function toFloat(a: RawAmount): number {
  const negative = a.raw < 0n;
  const abs = negative ? -a.raw : a.raw;
  const scale = 10n ** BigInt(a.decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  // Build via string to avoid precision loss on large `whole`.
  const s = a.decimals === 0 ? whole.toString() : `${whole}.${frac.toString().padStart(a.decimals, '0')}`;
  const n = Number(s);
  return negative ? -n : n;
}

export function lamportsToSol(lamports: bigint): number {
  return toFloat(rawAmount(lamports, 9));
}

/** USD value of a raw amount at a given unit price. Render boundary. */
export function usdValue(a: RawAmount, unitPriceUsd: number): number {
  return toFloat(a) * unitPriceUsd;
}

export function absBigInt(v: bigint): bigint {
  return v < 0n ? -v : v;
}
