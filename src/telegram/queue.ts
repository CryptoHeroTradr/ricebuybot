import type { Logger } from 'pino';

import type { ChatId, Signature } from '../core/types.js';
import type { Repo } from '../db/index.js';
import { classify } from './errors.js';
import type { Outbound, Sender } from './sender.js';

export interface QueueDeps {
  readonly repo: Repo;
  readonly sender: Sender;
  readonly log: Logger;
  /** Injected so tests do not sleep in real time. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly perChatMs?: number;
  readonly globalPerSec?: number;
  readonly staleMs?: number;
  readonly maxAttempts?: number;
}

export interface Job {
  readonly signature: Signature;
  readonly chatId: ChatId;
  readonly enqueuedAt: number;
  /**
   * Hold the card back this long before sending (Phase 11: the free plan posts 5s late).
   *
   * It is a DELAY, not a drop. The staleness rule is 120s, so a 5s hold is nowhere near it and
   * no free chat ever loses a buy to its own plan — which would be a cruel way to sell an
   * upgrade, and would also make the free tier look broken rather than slow.
   */
  readonly delayMs?: number;
  readonly build: () => Promise<Outbound>;
}

/** Telegram throttles a bot's posts to a group at roughly 20/min. 1 per 3s stays under it. */
const PER_CHAT_MS = 3_000;
/** Global cap across every chat. */
const GLOBAL_PER_SEC = 25;
/**
 * A buy older than this is not news.
 *
 * The price has moved, the chart has moved, and a card claiming "just now" about a
 * two-minute-old trade is worse than silence: it makes every OTHER card look untrustworthy
 * too. Dropping is the correct outcome, not a degraded one.
 */
const STALE_MS = 120_000;
const MAX_ATTEMPTS = 3;

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The delivery queue.
 *
 * INVARIANT 2 lives here. `claimSend(signature, chat_id)` is taken BEFORE the Bot API
 * call, and it is a single atomic INSERT — never a read-then-write. `false` is the NORMAL
 * case under a websocket replay or a restart: someone else owns this send. Do nothing with
 * it. Do not queue it, do not retry it, do not log an error.
 */
export class DeliveryQueue {
  readonly #repo: Repo;
  readonly #sender: Sender;
  readonly #log: Logger;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #perChatMs: number;
  readonly #globalPerSec: number;
  readonly #staleMs: number;
  readonly #maxAttempts: number;

  /** chatId -> when that chat may next be posted to. The per-chat token bucket. */
  readonly #nextSlot = new Map<ChatId, number>();
  /** Timestamps of recent sends, for the global cap. */
  #recent: number[] = [];

  #queue: Job[] = [];
  #draining = false;
  #stopped = false;

  constructor(deps: QueueDeps) {
    this.#repo = deps.repo;
    this.#sender = deps.sender;
    this.#log = deps.log.child({ mod: 'queue' });
    this.#sleep = deps.sleep ?? sleepReal;
    this.#now = deps.now ?? Date.now;
    this.#perChatMs = deps.perChatMs ?? PER_CHAT_MS;
    this.#globalPerSec = deps.globalPerSec ?? GLOBAL_PER_SEC;
    this.#staleMs = deps.staleMs ?? STALE_MS;
    this.#maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  }

  get depth(): number {
    return this.#queue.length;
  }

  enqueue(job: Job): void {
    if (this.#stopped) return;
    this.#queue.push(job);
    void this.#drain();
  }

  stop(): void {
    this.#stopped = true;
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0 && !this.#stopped) {
        const job = this.#queue.shift() as Job;

        // Stale check FIRST — before the claim, before the throttle wait. A queue that has
        // backed up behind a 429 is exactly where stale posts come from, and there is no
        // point buying a claim for a message we are about to throw away.
        const age = this.#now() - job.enqueuedAt;
        if (age > this.#staleMs) {
          this.#log.warn({ chatId: job.chatId, ageMs: age }, 'dropping a stale buy — a late post is worse than none');
          continue;
        }

        // The plan delay is applied BEFORE the claim and BEFORE the throttle, and it is
        // measured from when the buy was enqueued — so a queue that is already backed up does
        // not add the delay on top of a wait the chat has already served.
        const held = (job.delayMs ?? 0) - (this.#now() - job.enqueuedAt);
        if (held > 0) await this.#sleep(held);

        await this.#throttle(job.chatId);
        await this.#deliver(job);
      }
    } finally {
      this.#draining = false;
    }
  }

  /** Per-chat 1-per-3s, plus the global 25/s ceiling. */
  async #throttle(chatId: ChatId): Promise<void> {
    const now = this.#now();

    const chatWait = Math.max(0, (this.#nextSlot.get(chatId) ?? 0) - now);

    this.#recent = this.#recent.filter((t) => now - t < 1_000);
    const globalWait = this.#recent.length >= this.#globalPerSec ? 1_000 - (now - (this.#recent[0] as number)) : 0;

    const wait = Math.max(chatWait, globalWait);
    if (wait > 0) await this.#sleep(wait);

    const at = this.#now();
    this.#nextSlot.set(chatId, at + this.#perChatMs);
    this.#recent.push(at);
  }

  /**
   * Claim, send, record. The whole of INVARIANT 2 in one function.
   *
   * The claim is an atomic INSERT and it happens BEFORE the send. A "have I sent this?"
   * read-then-write double-posts: several callers all read "no" before any of them writes.
   */
  async #deliver(job: Job): Promise<void> {
    const owned = await this.#repo.claimSend(job.signature, job.chatId);
    if (!owned) {
      // The NORMAL case under a reconnect replay. Silence is the correct response.
      this.#log.debug({ chatId: job.chatId }, 'send already claimed — dropping');
      return;
    }

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      try {
        const messageId = await this.#sender.send(await job.build());
        await this.#repo.markSent(job.signature, job.chatId, messageId);
        return;
      } catch (err) {
        const verdict = classify(err);

        if (verdict.kind === 'rate_limit') {
          // Honour retry_after EXACTLY, and keep the claim: we still own this send.
          this.#log.warn(
            { chatId: job.chatId, retryAfterSec: verdict.retryAfterSec, attempt },
            '429 — backing off exactly as told',
          );
          await this.#sleep(verdict.retryAfterSec * 1_000);
          continue;
        }

        if (verdict.kind === 'permanent') {
          // A tombstone: never re-claimable, so we never try this chat with this buy again.
          await this.#repo.failSend(job.signature, job.chatId, verdict.reason);

          if (verdict.pauseChat) {
            // Kicked, blocked, chat gone. Stop asking. Self-healing — no manual cleanup.
            await this.#repo.setPaused(job.chatId, true);
            this.#log.warn({ chatId: job.chatId, reason: verdict.reason }, 'chat is unreachable — paused');
          } else {
            this.#log.error({ chatId: job.chatId, reason: verdict.reason }, 'permanent send failure');
          }
          return;
        }

        // Retryable. If we are out of attempts, RELEASE the claim (delete the row) so a
        // future attempt can take it — as opposed to failSend, which would tombstone it.
        if (attempt >= this.#maxAttempts) {
          await this.#repo.releaseSend(job.signature, job.chatId, verdict.reason);
          this.#log.error(
            { chatId: job.chatId, sig: job.signature, reason: verdict.reason, attempts: attempt },
            'DEAD LETTER — giving up on this send',
          );
          return;
        }
        this.#log.warn({ chatId: job.chatId, attempt, reason: verdict.reason }, 'retryable send failure');
      }
    }
  }
}
