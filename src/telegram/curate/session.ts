import { randomBytes } from 'node:crypto';

import type { Mint } from '../../core/types.js';
import type { TierFolder } from '../../core/tiers.js';

/**
 * THE 64-BYTE WALL.
 *
 * `callback_data` is capped at 64 BYTES by Telegram. A Solana mint is 44 characters on its
 * own — so `"gallery:2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump:whale:3"` is 60-odd bytes
 * before you have added a verb, and it silently breaks the moment anything else needs to go
 * in. Telegram does not reject an over-long callback_data helpfully; the button just stops
 * working.
 *
 * So the mint NEVER travels in callback_data. What travels is an opaque 8-char token; the
 * mint, the tier and the index live here, server-side, keyed by that token. Everything a
 * button needs to say fits in `g:<token>:<verb>` — about 16 bytes, with room to spare
 * forever.
 *
 * It also closes a hole: an opaque token cannot be hand-crafted by a user poking at the
 * callback API to browse a mint they do not curate. The session records WHO it belongs to,
 * and the handler checks.
 */
export interface Board {
  readonly token: string;
  readonly userId: number;
  readonly mint: Mint;
  /** Null on the tier board; set once they are inside a gallery. */
  tier: TierFolder | null;
  index: number;
  /** The one message we keep editing. Never a new one — the curator is paging, not chatting. */
  messageId: number | null;
  createdAt: number;
}

/**
 * A board older than this answers "expired" rather than acting.
 *
 * The pool can change under a board — another curator adds art, a manifest run reclassifies
 * something, a meme is removed. Acting on a 40-minute-old index means removing whatever
 * happens to be at position 3 NOW, which is not what the person looking at the screenshot
 * thinks they are removing. Expiry is cheaper than being wrong about a deletion.
 */
export const BOARD_TTL_MS = 15 * 60_000;

/** How long the bot waits for forwarded memes after ➕ Add. */
export const AWAITING_TTL_MS = 10 * 60_000;

export interface Awaiting {
  readonly userId: number;
  readonly mint: Mint;
  readonly tier: TierFolder;
  /** A meme already in another tier, waiting on [Move] / [Keep]. */
  pendingMove?: { sha256: string; from: TierFolder } | undefined;
  expiresAt: number;
}

export class CurationSessions {
  readonly #boards = new Map<string, Board>();
  /** (user, mint, tier) awaiting-media state. PER USER — two curators do not collide. */
  readonly #awaiting = new Map<number, Awaiting>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  // --- boards -------------------------------------------------------------------------

  openBoard(userId: number, mint: Mint): Board {
    const board: Board = {
      token: randomBytes(6).toString('base64url'), // 8 chars
      userId,
      mint,
      tier: null,
      index: 0,
      messageId: null,
      createdAt: this.#now(),
    };
    this.#boards.set(board.token, board);
    return board;
  }

  /**
   * Look a board up, and CHECK IT BELONGS TO THIS USER.
   *
   * The user id is not decoration. Callback queries carry the presser's id, and without this
   * check anyone who saw a token (a forwarded screenshot, a shared device) could drive
   * someone else's board — including the 🗑 button.
   */
  board(token: string, userId: number): Board | 'expired' | null {
    const b = this.#boards.get(token);
    if (!b) return null;
    if (b.userId !== userId) return null;
    if (this.#now() - b.createdAt > BOARD_TTL_MS) {
      this.#boards.delete(token);
      return 'expired';
    }
    return b;
  }

  closeBoard(token: string): void {
    this.#boards.delete(token);
  }

  // --- awaiting media -----------------------------------------------------------------

  startAwaiting(userId: number, mint: Mint, tier: TierFolder): Awaiting {
    const a: Awaiting = { userId, mint, tier, expiresAt: this.#now() + AWAITING_TTL_MS };
    this.#awaiting.set(userId, a);
    return a;
  }

  awaiting(userId: number): Awaiting | null {
    const a = this.#awaiting.get(userId);
    if (!a) return null;
    if (a.expiresAt <= this.#now()) {
      this.#awaiting.delete(userId);
      return null;
    }
    return a;
  }

  /** Each accepted meme pushes the window out: a curator forwarding 30 files is not idle. */
  touch(userId: number): void {
    const a = this.#awaiting.get(userId);
    if (a) a.expiresAt = this.#now() + AWAITING_TTL_MS;
  }

  stopAwaiting(userId: number): boolean {
    return this.#awaiting.delete(userId);
  }

  get openBoards(): number {
    return this.#boards.size;
  }
}

/** `g:<token>:<verb>` — everything a button needs, in ~16 bytes. */
export const cb = (token: string, verb: string): string => `g:${token}:${verb}`;

export function parseCb(data: string): { token: string; verb: string } | null {
  const m = /^g:([\w-]{1,16}):(.+)$/.exec(data);
  if (!m) return null;
  return { token: m[1] as string, verb: m[2] as string };
}
