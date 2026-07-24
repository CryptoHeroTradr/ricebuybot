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

import type { Bot, Context } from 'grammy';

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
  /** How to clear each owner's PAYLOAD when its slot is cancelled. The arbiter owns the slot; the
   *  handler owns its own state, so it registers once how to drop it. Without this, /cancel would
   *  free the slot and leave a half-finished import's pending state behind. */
  readonly #cleanups = new Map<InputOwner, (userId: number) => void>();
  /** Cancellable flows that are NOT arbiter slots (the group /setup wizard). Tried in order when no
   *  slot is open, so one /cancel means one thing everywhere. Returns a label if it cancelled. */
  readonly #fallbacks: Array<{ label: string; fn: (userId: number, chatId: number) => boolean }> = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Register how to clear `owner`'s payload when its slot is released by /cancel. */
  onCancel(owner: InputOwner, cleanup: (userId: number) => void): void {
    this.#cleanups.set(owner, cleanup);
  }

  /** Register a non-slot flow that /cancel should also be able to drop (the /setup wizard). */
  onFallbackCancel(label: string, fn: (userId: number, chatId: number) => boolean): void {
    this.#fallbacks.push({ label, fn });
  }

  /**
   * THE ONE /cancel. Drops whatever is open for this user — the slot AND its owner's payload — and
   * returns what was cancelled so the reply can name it. Falls back to the non-slot flows, and
   * returns null when there was nothing to cancel.
   *
   * `slotScoped` is false for group chats: a /cancel typed in a group must not reach into someone's
   * DM wallet flow; only the chat-scoped fallbacks apply there.
   */
  cancel(userId: number, chatId: number, slotScoped = true): string | null {
    if (slotScoped) {
      const cur = this.#live(userId);
      if (cur) {
        this.#slots.delete(userId);
        this.#cleanups.get(cur.owner)?.(userId); // drop the payload too, not just the slot
        return cur.label;
      }
    }
    for (const f of this.#fallbacks) {
      if (f.fn(userId, chatId)) return f.label;
    }
    return null;
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

/**
 * /cancel — THE exit, owned by the arbiter and registered ABOVE all three handlers.
 *
 * It must be registered FIRST, before the wallet's `message:text` handler. The wallet's slot is
 * protected precisely so no other handler sees the message — which includes this one. Registered
 * after, "/cancel" would be swallowed by the import flow and read as a passphrase, and the user
 * would be locked in for the full TTL with the bot telling them a door exists that they cannot open.
 *
 * There is exactly ONE implementation of this word. Other flows hook in via `onFallbackCancel`
 * rather than registering a second `/cancel`.
 */
export function registerCancelCommand(bot: Bot, arbiter: InputArbiter): void {
  bot.command('cancel', async (ctx: Context) => {
    const userId = ctx.from?.id ?? 0;
    const chatId = ctx.chat?.id ?? 0;
    // In a group only the chat-scoped flows are cancellable — a group message must never reach
    // into this user's DM wallet flow.
    const slotScoped = ctx.chat?.type === 'private';
    const cancelled = arbiter.cancel(userId, chatId, slotScoped);
    // Never a bare "ok": say what state they just left, or that there was none.
    await ctx.reply(cancelled ? `Cancelled the pending ${cancelled}.` : 'Nothing to cancel.');
  });
}
