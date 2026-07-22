/**
 * Exponential backoff with full jitter, 1s -> 30s cap.
 *
 * Full jitter (random in [0, window]) rather than a fixed ramp: if Helius blips
 * and every bot on the platform reconnects on the same curve, they stampede the
 * endpoint in lockstep and knock it over again. Jitter smears the herd out.
 */
export class Backoff {
  readonly #baseMs: number;
  readonly #capMs: number;
  readonly #rand: () => number;
  #attempt = 0;

  constructor(baseMs = 1_000, capMs = 30_000, rand: () => number = Math.random) {
    this.#baseMs = baseMs;
    this.#capMs = capMs;
    this.#rand = rand;
  }

  get attempt(): number {
    return this.#attempt;
  }

  /** Next delay, in ms. Advances the attempt counter. */
  next(): number {
    const window = Math.min(this.#capMs, this.#baseMs * 2 ** this.#attempt);
    this.#attempt++;
    return Math.floor(this.#rand() * window);
  }

  /** Call after a connection stays up long enough to be considered healthy. */
  reset(): void {
    this.#attempt = 0;
  }
}
