/**
 * In-memory LRU of recently-seen signatures.
 *
 * This is the FIRST of two dedup layers and it is only an optimisation: it stops
 * a reconnect replay from re-parsing and re-querying work we just did. It is NOT
 * a correctness boundary — it is per-process and vanishes on restart.
 *
 * The correctness boundary is the DB: the `buys` primary key, and above all the
 * atomic claim in `sends` (INVARIANT 2). Never rely on this cache to prevent a
 * double-post.
 */
export class SignatureLru {
  readonly #max: number;
  /** Map preserves insertion order, which is all an LRU needs. */
  #seen = new Map<string, true>();

  constructor(max = 5_000) {
    this.#max = max;
  }

  get size(): number {
    return this.#seen.size;
  }

  /** True if this signature was already seen. Marks it seen either way. */
  seen(signature: string): boolean {
    if (this.#seen.has(signature)) {
      // Refresh recency so a hot signature is not evicted mid-replay.
      this.#seen.delete(signature);
      this.#seen.set(signature, true);
      return true;
    }

    this.#seen.set(signature, true);
    if (this.#seen.size > this.#max) {
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return false;
  }

  clear(): void {
    this.#seen.clear();
  }
}
