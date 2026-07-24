/**
 * THE SINGLE DM INPUT ARBITER.
 *
 * Three DM handlers await free-text input: /wallet import (a base58 SECRET KEY), meme curation (a
 * forwarded upload), and the trade panel (an amount/interval/etc. prompt). Before this, each kept
 * its OWN awaiting state, so two could be open at once — and then a pasted secret key could be
 * claimed by the WRONG handler, rejected as a bad amount, and ECHOED BACK in the error, persisting
 * a key in Telegram history. That defeats the whole deleteMessage discipline /wallet import rests on.
 *
 * This registry guarantees AT MOST ONE awaiting state per user, and it decides routing STRUCTURALLY
 * — by which owner holds the slot, never by handler registration order (the thing that breaks
 * silently when someone adds a fourth handler):
 *
 *   1. ONE STATE. `acquire` takes the slot and returns the label of any state it displaced, so the
 *      caller can tell the user what was cancelled. Never two open at once.
 *   2. PRECEDENCE. A PROTECTED slot (a secret is/will be awaited — the wallet flow) cannot be
 *      displaced by a different owner: their `acquire` is refused. While a key is awaited, no other
 *      handler can take the slot, so no other handler will ever process the key message.
 */

export type InputOwner = 'wallet' | 'curation' | 'panel';

const DEFAULT_LABEL: Record<InputOwner, string> = {
  wallet: 'wallet setup',
  curation: 'meme upload',
  panel: 'settings prompt',
};

interface Slot {
  owner: InputOwner;
  label: string;
  /** A protected slot awaits a secret (the wallet flow) and cannot be displaced by another owner. */
  protected: boolean;
  expiresAt: number;
}

export type AcquireResult =
  | { readonly ok: true; readonly cancelled: string | null }
  | { readonly ok: false; readonly heldBy: InputOwner; readonly heldLabel: string };

export class InputArbiter {
  readonly #slots = new Map<number, Slot>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #live(userId: number): Slot | null {
    const s = this.#slots.get(userId);
    if (!s) return null;
    if (s.expiresAt <= this.#now()) {
      this.#slots.delete(userId);
      return null;
    }
    return s;
  }

  /**
   * Take the single input slot for `owner`. Refused (structurally, order-independent) if a DIFFERENT
   * owner holds a PROTECTED slot — /wallet import takes precedence while a key is awaited. Otherwise
   * the slot is taken; any displaced DIFFERENT-owner state's label is returned so the caller can say
   * "cancelled the pending <label>". The SAME owner re-acquiring (advancing a multi-step flow) never
   * refuses and never reports a cancellation.
   */
  acquire(userId: number, owner: InputOwner, opts: { label?: string; protected?: boolean; ttlMs: number }): AcquireResult {
    const cur = this.#live(userId);
    if (cur && cur.owner !== owner && cur.protected) {
      return { ok: false, heldBy: cur.owner, heldLabel: cur.label };
    }
    const cancelled = cur && cur.owner !== owner ? cur.label : null;
    this.#slots.set(userId, {
      owner,
      label: opts.label ?? DEFAULT_LABEL[owner],
      protected: opts.protected ?? false,
      expiresAt: this.#now() + opts.ttlMs,
    });
    return { ok: true, cancelled };
  }

  /** THE ROUTING AUTHORITY: does `owner` hold the live slot? A handler processes a message iff true —
   *  so precedence does not depend on which handler grammY happens to run first. */
  owns(userId: number, owner: InputOwner): boolean {
    const s = this.#live(userId);
    return s !== null && s.owner === owner;
  }

  /** The live slot for anyone (for a "who holds it" message), or null. */
  peek(userId: number): { owner: InputOwner; label: string; protected: boolean } | null {
    const s = this.#live(userId);
    return s ? { owner: s.owner, label: s.label, protected: s.protected } : null;
  }

  /** Release the slot, but only if `owner` still holds it (never yank another owner's slot). */
  release(userId: number, owner: InputOwner): void {
    const s = this.#slots.get(userId);
    if (s && s.owner === owner) this.#slots.delete(userId);
  }

  get open(): number {
    return this.#slots.size;
  }
}
