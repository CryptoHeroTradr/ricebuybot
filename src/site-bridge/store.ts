import { randomBytes } from 'node:crypto';

type Now = () => number;

/**
 * One-time LINK codes: code -> telegram_user_id, short expiry, in-memory only. This is NOT the
 * mapping (that's the DB `site_links`) — it is the ephemeral handoff the user carries from the
 * Telegram DM to the site. Lost on restart, which is fine for a 10-minute code.
 *
 * Per-user replacement: issuing a new code invalidates that user's previous one, so only the
 * latest code ever links. Codes are single-use — consume() removes it.
 */
export class LinkCodeStore {
  readonly #codes = new Map<string, { userId: number; expiresAt: number }>();
  readonly #ttlMs: number;
  readonly #now: Now;

  constructor(ttlMs = 10 * 60_000, now: Now = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** Mint a fresh code for a user, replacing any prior code for that user. */
  issue(userId: number): string {
    this.#sweep();
    for (const [c, v] of this.#codes) if (v.userId === userId) this.#codes.delete(c);
    let code: string;
    do {
      code = randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    } while (this.#codes.has(code));
    this.#codes.set(code, { userId, expiresAt: this.#now() + this.#ttlMs });
    return code;
  }

  /** Consume a code -> userId (single use). Null if unknown or expired. */
  consume(code: string): number | null {
    const v = this.#codes.get(code);
    if (!v) return null;
    this.#codes.delete(code);
    return v.expiresAt >= this.#now() ? v.userId : null;
  }

  #sweep(): void {
    const t = this.#now();
    for (const [c, v] of this.#codes) if (v.expiresAt < t) this.#codes.delete(c);
  }
}

/**
 * Read-challenge NONCES: the bot mints freshness; the client never dates its own proof. Each nonce
 * is single-use — consume() removes it — so a replayed signed proof dies with its nonce.
 */
export class NonceStore {
  readonly #nonces = new Map<string, number>(); // nonce -> expiresAt
  readonly #ttlMs: number;
  readonly #now: Now;

  constructor(ttlMs = 5 * 60_000, now: Now = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  issue(): { nonce: string; expiresAt: number } {
    this.#sweep();
    const nonce = randomBytes(24).toString('base64url');
    const expiresAt = this.#now() + this.#ttlMs;
    this.#nonces.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  /** Single-use: true iff the nonce existed AND was still live. Deleted either way. */
  consume(nonce: string): boolean {
    const exp = this.#nonces.get(nonce);
    if (exp === undefined) return false; // unknown or already consumed (replay)
    this.#nonces.delete(nonce);
    return exp >= this.#now(); // false = stale
  }

  #sweep(): void {
    const t = this.#now();
    for (const [n, exp] of this.#nonces) if (exp < t) this.#nonces.delete(n);
  }
}
