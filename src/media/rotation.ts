import { randomInt } from 'node:crypto';

/**
 * Fisher-Yates, with a CRYPTO RNG.
 *
 * Not because meme order is a secret, but because `Math.random()` is seeded per
 * process: every bot instance restarted at the same time, and every fresh chat, would
 * draw correlated orders. `randomInt` gives an unbiased index in [0, i] — note that
 * `Math.floor(Math.random() * n)` is *not* unbiased, and a bag is small enough that the
 * bias is visible as "that meme always seems to come up first".
 */
export function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * Should the bag be thrown away and rebuilt?
 *
 * A bag is a list of sha256s captured at refill time. It goes stale when the pool's
 * contents change underneath it — a meme was curated in, or an admin removed one.
 *
 * The check is SET-BASED, not length-based. A bag that has had three memes popped is
 * shorter than the live set and is perfectly valid — that is what a bag IS. What makes
 * it invalid is holding a sha that is no longer live (a removal), because that meme must
 * stop being posted immediately. New memes do not invalidate a bag: they simply join
 * the next refill, so a fresh meme waits at most one bag cycle rather than resetting the
 * rotation and re-showing memes people just saw.
 */
export function bagIsStale(bag: readonly string[], live: ReadonlySet<string>): boolean {
  return bag.some((sha) => !live.has(sha));
}

/**
 * Refill: every live sha for the tier, shuffled.
 *
 * `live` is what the caller decided is postable — which INCLUDES `missing` items (their
 * file_id still works) and EXCLUDES `removed` ones (an admin said no). That decision is
 * made in the query, not here; this function just shuffles what it is handed.
 */
export function refillBag(live: readonly string[]): string[] {
  return shuffle(live);
}

/**
 * Pop one, return the rest. Nothing repeats until the tier is exhausted, then it
 * reshuffles — which is the entire point of a bag over a random draw.
 *
 * The refill happens when the bag is EMPTY or STALE, and the popped item comes off the
 * freshly shuffled bag, so a caller never gets `null` while the tier has art.
 */
export function popFromBag(
  bag: readonly string[],
  live: readonly string[],
): { readonly sha256: string | null; readonly rest: readonly string[] } {
  const liveSet = new Set(live);
  const usable = bag.length > 0 && !bagIsStale(bag, liveSet) ? bag : refillBag(live);

  if (usable.length === 0) return { sha256: null, rest: [] };
  const [head, ...rest] = usable;
  return { sha256: head as string, rest };
}
