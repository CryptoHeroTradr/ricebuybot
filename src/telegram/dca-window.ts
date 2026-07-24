/**
 * PHASE 16 — the DCA window.
 *
 * WALL-CLOCK TUMBLING, ALIGNED TO THE HOUR. At the default 30 minutes the boundaries are :00 and
 * :30, every hour, forever. Not a rolling window that starts at the first buy: a rolling window
 * drifts, so nobody — not the group, not the operator, not a test — can say when the next card is
 * due. A tumbling window is a pure function of the clock, which is what makes it predictable AND
 * testable.
 */

export const DEFAULT_DCA_WINDOW_MINUTES = 30;
export const MIN_DCA_WINDOW_MINUTES = 1;
export const MAX_DCA_WINDOW_MINUTES = 1440; // a day; beyond that it is not a window, it is a report

/** The start of the window containing `nowMs`, aligned to the epoch (and so to the hour). */
export function windowStartFor(nowMs: number, minutes: number): number {
  const size = minutes * 60_000;
  return Math.floor(nowMs / size) * size;
}

/**
 * The most recent window that has CLOSED as of `nowMs` — the only one safe to flush. Flushing the
 * window still in progress would post a partial card and then have nothing left to say for the rest
 * of it.
 */
export function lastClosedWindowStart(nowMs: number, minutes: number): number {
  return windowStartFor(nowMs, minutes) - minutes * 60_000;
}

export function windowEnd(windowStart: number, minutes: number): number {
  return windowStart + minutes * 60_000;
}

/** Clamp an operator-supplied window to the hard bounds. Returns null if it is not a whole number. */
export function normalizeWindowMinutes(raw: number): number | null {
  if (!Number.isInteger(raw)) return null;
  if (raw < MIN_DCA_WINDOW_MINUTES || raw > MAX_DCA_WINDOW_MINUTES) return null;
  return raw;
}

/**
 * THE CLAIM KEY IS (chat_id, window_start), NOT A SIGNATURE — there are many signatures behind one
 * card. Everything else about claimSend/markSent/failSend is unchanged: this is just the string
 * that goes in the signature column, so a restart mid-flush cannot double-post a window.
 */
export function dcaClaimKey(mint: string, windowStart: number): string {
  return `dca:${mint}:${windowStart}`;
}
