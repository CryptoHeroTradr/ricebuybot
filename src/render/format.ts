/**
 * Display formatting. PURE — no I/O, no clock, no config.
 *
 * INVARIANT 6: this is the render boundary. Numbers arrive here as floats that
 * were derived once, at the edge, from integer raw amounts. Nothing downstream
 * of this file does arithmetic.
 */

const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * Money, sized to how much precision a reader actually wants:
 *
 *   $0.00        zero
 *   <$0.01       positive but rounds to nothing — say so rather than print "$0.00",
 *                which reads as "free" and is how a dust buy gets mistaken for a bug
 *   $23.29       under $1k: cents matter
 *   $1,204       $1k–$10k: cents are noise, the exact dollar still reads
 *   $94.1K       $10k–$1M
 *   $1.24M       $1M–$1B
 *   $1.24B / $1.24T beyond
 */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';

  const negative = n < 0;
  const v = Math.abs(n);
  const sign = negative ? '-' : '';

  if (v === 0) return '$0.00';
  if (v < 0.01) return `${sign}<$0.01`;
  if (v < 1_000) return `${sign}$${v.toFixed(2)}`;
  if (v < 10_000) return `${sign}$${GROUPED.format(Math.round(v))}`;

  const SCALES = [
    [1_000, 'K'],
    [1_000_000, 'M'],
    [1_000_000_000, 'B'],
    [1_000_000_000_000, 'T'],
  ] as const;

  for (let i = 0; i < SCALES.length; i++) {
    const [scale, suffix] = SCALES[i] as readonly [number, string];
    const next = SCALES[i + 1];
    if (next && v >= next[0]) continue;

    const scaled = v / scale;
    const text = trim(scaled);

    // $999,999 scales to 999.999K, which trims to "1000K". Promote it to "$1M"
    // rather than print a number that is louder than the next unit down.
    if (next && Number(text) >= 1_000) {
      return `${sign}$${trim(v / next[0])}${next[1]}`;
    }
    return `${sign}$${text}${suffix}`;
  }

  return `${sign}$${trim(v / 1_000_000_000_000)}T`;
}

/**
 * 3 significant figures, without trailing zero noise: 94.1, 1.24, 105 — not
 * 94.10 or 1.240.
 */
function trim(v: number): string {
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return v.toFixed(digits).replace(/\.0+$/, '');
}

/** Whole tokens, grouped. 242531 -> "242,531". */
export function tokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return GROUPED.format(n);
}

/** Signed percentage. The sign is ALWAYS shown — "+128%", "-41%", "+0%". */
export function pct(n: number): string {
  if (!Number.isFinite(n)) return '+0%';
  const rounded = Math.round(n);
  // Object.is guards -0, which would otherwise render as "-0%".
  const sign = rounded > 0 || Object.is(rounded, 0) || rounded === 0 ? '+' : '';
  return `${sign}${rounded}%`;
}

/**
 * The token symbol, as a human should read it.
 *
 * On-chain metadata is whatever the deployer typed — $RICE's says `rice`. Uppercasing at the
 * render boundary (and ONLY here) means the chain stays the source of truth while the card
 * reads like every other ticker in crypto.
 *
 * The 4-char mint fallback is NOT uppercased: "2wQq" is a fragment of an address, not a
 * ticker, and "2WQQ" would look like a name we had invented.
 */
export function symbol(sym: string | null, mint: string): string {
  return sym ? sym.toUpperCase() : mint.slice(0, 4);
}
