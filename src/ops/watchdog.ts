import type { Logger } from './logger.js';

/**
 * FAIL LOUD, RESTART CLEAN. Phase 9.
 *
 * If the websocket has been down for two minutes, this process is not doing its job and is
 * not going to start doing it by sitting here. Exit non-zero and let systemd restart us.
 *
 * WHY EXIT RATHER THAN KEEP RETRYING FOREVER: the ingestor already reconnects with backoff,
 * so a two-minute outage means the retries are not working — a dead API key, a revoked plan,
 * a wedged socket, a DNS hole. None of those get better by waiting, and all of them look
 * IDENTICAL to a healthy bot from the outside: the process is up, /health answers, the logs
 * are quiet, and no buys are posted. That is the worst failure mode this bot has, because
 * nobody notices it. A crash loop is noisy and gets fixed.
 *
 * The restart is clean by construction: the boot sweep resolves orphaned claims (INVARIANT
 * 9), and gap recovery pulls back the buys from the outage window (up to the age cap).
 */
export const WS_DOWN_LIMIT_MS = 120_000;

export interface WatchdogDeps {
  readonly connected: () => boolean;
  readonly log: Logger;
  readonly limitMs?: number;
  readonly checkMs?: number;
  /** Injected so the test does not actually kill the test runner. */
  readonly exit?: (code: number) => void;
  readonly now?: () => number;
}

export class Watchdog {
  #downSince: number | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: WatchdogDeps) {}

  /** One evaluation. Exposed so a test can step it without waiting two real minutes. */
  tick(): void {
    const now = (this.deps.now ?? Date.now)();
    const limit = this.deps.limitMs ?? WS_DOWN_LIMIT_MS;

    if (this.deps.connected()) {
      if (this.#downSince !== null) {
        this.deps.log.info({ downMs: now - this.#downSince }, 'websocket recovered');
      }
      this.#downSince = null;
      return;
    }

    if (this.#downSince === null) {
      this.#downSince = now;
      return;
    }

    const downMs = now - this.#downSince;
    if (downMs >= limit) {
      this.deps.log.fatal(
        { downMs },
        'websocket down past the limit — exiting so systemd can restart us clean. A silently-dead bot is worse than a crash loop.',
      );
      (this.deps.exit ?? process.exit)(1);
    }
  }

  start(): void {
    this.#timer = setInterval(() => this.tick(), this.deps.checkMs ?? 10_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
