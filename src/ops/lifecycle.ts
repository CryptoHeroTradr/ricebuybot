/**
 * Graceful shutdown machinery.
 *
 * Every outbound Telegram send wraps itself in `inFlight.track(...)`. On SIGTERM
 * we stop accepting new work, then wait for the tracked sends to finish before
 * the process exits — a half-sent post that gets killed mid-flight is exactly the
 * situation INVARIANT 2 (idempotent sends) exists to survive, but we would still
 * rather not create it.
 */

export class InFlight {
  #count = 0;
  #closed = false;
  #idle: Array<() => void> = [];

  get count(): number {
    return this.#count;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Run `fn`, counting it as in-flight for its duration.
   * Throws once shutdown has begun — callers must stop producing work first.
   */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error('shutting down: refusing new work');
    this.#count++;
    try {
      return await fn();
    } finally {
      this.#count--;
      if (this.#count === 0) {
        const waiters = this.#idle;
        this.#idle = [];
        for (const w of waiters) w();
      }
    }
  }

  /**
   * Stop accepting work and wait for what is already running.
   * Resolves `true` if everything drained, `false` if the timeout hit first.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    this.#closed = true;
    if (this.#count === 0) return true;

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

export type ShutdownHook = () => void | Promise<void>;

/**
 * Runs shutdown hooks in REVERSE registration order, so teardown unwinds the way
 * boot wound up: the last thing started is the first thing stopped.
 */
export class Shutdown {
  #hooks: Array<{ name: string; fn: ShutdownHook }> = [];
  #running = false;

  register(name: string, fn: ShutdownHook): void {
    this.#hooks.push({ name, fn });
  }

  get started(): boolean {
    return this.#running;
  }

  /** Idempotent: a second SIGTERM while shutting down is ignored, not a double-teardown. */
  async run(onError: (name: string, err: unknown) => void): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    for (const hook of [...this.#hooks].reverse()) {
      try {
        await hook.fn();
      } catch (err) {
        onError(hook.name, err);
      }
    }
  }
}
