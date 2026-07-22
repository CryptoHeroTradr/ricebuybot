import type { SwapEvent } from '../core/types.js';
import type { Logger } from '../ops/logger.js';

export const MAX_HELD = 200;

interface Held {
  readonly event: SwapEvent;
  readonly heldAtMs: number;
}

/**
 * Buys that could not be priced because the SOL feed was down.
 *
 * They are HELD, not dropped and not posted: posting with a guessed dollar figure
 * puts a buy in the wrong tier and pulls the wrong meme, which is worse than
 * posting it a few seconds late.
 *
 * ONLY SOL-quoted swaps ever land here. A USDC-quoted buy does not need the SOL
 * feed and must sail straight through — one dead websocket must not hold back
 * buys it has no bearing on.
 *
 * Bounded at 200. On overflow we evict the OLDEST, because if the feed has been
 * down long enough to queue 200 buys, the ones at the front are the least worth
 * posting when it recovers — and dropping the newest would mean that a long
 * outage silently loses every recent buy, which is the opposite of what you want.
 */
export class HoldQueue {
  readonly #items: Held[] = [];
  readonly #log: Logger;
  readonly #max: number;
  readonly #now: () => number;
  #dropped = 0;

  constructor(log: Logger, max: number = MAX_HELD, now: () => number = Date.now) {
    this.#log = log;
    this.#max = max;
    this.#now = now;
  }

  get size(): number {
    return this.#items.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  hold(event: SwapEvent): void {
    if (this.#items.length >= this.#max) {
      const evicted = this.#items.shift();
      this.#dropped++;
      this.#log.warn(
        {
          signature: evicted?.event.signature,
          held: this.#items.length,
          droppedTotal: this.#dropped,
        },
        'hold queue full; dropped the oldest held buy',
      );
    }

    this.#items.push({ event, heldAtMs: this.#now() });
    this.#log.debug({ signature: event.signature, held: this.#items.length }, 'buy held: SOL feed stale');
  }

  /**
   * Drain everything, oldest first, and hand each buy back to the caller.
   *
   * Held buys are handed back with the age they accumulated so the caller can
   * apply its own staleness rule — pricing does not get to decide that a buy is
   * too old to post.
   */
  flush(onEach: (event: SwapEvent, heldMs: number) => void): number {
    if (this.#items.length === 0) return 0;

    const now = this.#now();
    const batch = this.#items.splice(0, this.#items.length);
    this.#log.info({ count: batch.length }, 'SOL feed recovered; flushing held buys');

    for (const h of batch) onEach(h.event, now - h.heldAtMs);
    return batch.length;
  }
}
