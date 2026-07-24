import { randomBytes } from 'node:crypto';

import { PANEL_TTL_MS } from './commands.js';
import type { PanelVerb } from './render.js';

/**
 * PHASE 15 session — the same lesson as Phase 8.5's curation boards.
 *
 * The mint and ids NEVER travel in callback_data (the 64-byte wall). What travels is an opaque
 * 8-char token; the panel it names lives here, server-side, keyed by that token and STAMPED WITH
 * THE OWNER. A token from someone's forwarded screenshot is not a key to their panel — the handler
 * checks the presser's id against the stored one.
 *
 * A panel older than 15 minutes is STALE: money commands must never act on a possibly-changed view,
 * so its buttons answer "send /trade again" instead of acting. Expiry is cheaper than being wrong.
 */
export interface Panel {
  readonly token: string;
  readonly userId: number;
  messageId: number | null;
  readonly createdAt: number;
}

/** What a button prompt is waiting for from the user's next message. Per user; one at a time. */
export interface Awaiting {
  readonly userId: number;
  readonly verb: PanelVerb;
  readonly token: string;
  expiresAt: number;
}

const AWAITING_TTL_MS = 10 * 60_000;

export class PanelSessions {
  readonly #panels = new Map<string, Panel>();
  readonly #awaiting = new Map<number, Awaiting>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  open(userId: number): Panel {
    const panel: Panel = { token: randomBytes(6).toString('base64url'), userId, messageId: null, createdAt: this.#now() };
    this.#panels.set(panel.token, panel);
    return panel;
  }

  /** Look up a panel, checking it belongs to this user and is not stale. */
  panel(token: string, userId: number): Panel | 'expired' | null {
    const p = this.#panels.get(token);
    if (!p) return null;
    if (p.userId !== userId) return null; // not theirs — same answer as "gone"
    if (this.#now() - p.createdAt > PANEL_TTL_MS) {
      this.#panels.delete(token);
      this.#awaiting.delete(userId);
      return 'expired';
    }
    return p;
  }

  setMessageId(token: string, messageId: number): void {
    const p = this.#panels.get(token);
    if (p) p.messageId = messageId;
  }

  startAwaiting(userId: number, verb: PanelVerb, token: string): void {
    this.#awaiting.set(userId, { userId, verb, token, expiresAt: this.#now() + AWAITING_TTL_MS });
  }

  /** Read AND clear the awaiting state (a reply is consumed once). Null if none or expired. */
  takeAwaiting(userId: number): Awaiting | null {
    const a = this.#awaiting.get(userId);
    if (!a) return null;
    this.#awaiting.delete(userId);
    if (a.expiresAt <= this.#now()) return null;
    return a;
  }

  clearAwaiting(userId: number): void {
    this.#awaiting.delete(userId);
  }

  get openPanels(): number {
    return this.#panels.size;
  }
}
