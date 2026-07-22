import type { ChatId } from '../core/types.js';

/**
 * The /setup wizard's state. Per (chat, user), 5-minute TTL.
 *
 * PER USER, not per chat: two admins running /setup at once in a busy group must not
 * overwrite each other's half-finished answers. Keying on the chat alone means whoever
 * types second silently steals the first one's wizard.
 *
 * TTL, because an abandoned wizard is the common case — someone starts /setup, gets pulled
 * away, and comes back an hour later to a bot that is still waiting for a mint address and
 * will happily interpret their next unrelated message as one.
 *
 * IN MEMORY, not in the DB. A wizard is a conversation, and a conversation does not survive
 * a restart: the bot has forgotten what it asked, so the honest thing is to have forgotten
 * that it asked. Persisting it would mean answering a question nobody remembers being asked.
 */
export type Step = 'contract' | 'media' | 'minbuy' | 'emoji' | 'step' | 'done';

export interface WizardState {
  readonly chatId: ChatId;
  readonly userId: number;
  step: Step;
  /** Set once the contract step passes. */
  mint?: string;
  expiresAt: number;
}

export const WIZARD_TTL_MS = 5 * 60_000;

const key = (chatId: ChatId, userId: number): string => `${chatId}:${userId}`;

export class Wizards {
  readonly #open = new Map<string, WizardState>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Start (or RESTART) a wizard.
   *
   * Re-running /setup EDITS the existing config — it never creates a second one. The
   * chat_token is keyed (chat_id, mint) and every step is an UPDATE, so a group that runs
   * /setup twice ends up with one configuration, not two competing ones.
   */
  start(chatId: ChatId, userId: number): WizardState {
    const state: WizardState = {
      chatId,
      userId,
      step: 'contract',
      expiresAt: this.#now() + WIZARD_TTL_MS,
    };
    this.#open.set(key(chatId, userId), state);
    return state;
  }

  /** The live wizard for this user in this chat, or null if there is none (or it expired). */
  get(chatId: ChatId, userId: number): WizardState | null {
    const k = key(chatId, userId);
    const state = this.#open.get(k);
    if (!state) return null;

    if (state.expiresAt <= this.#now()) {
      this.#open.delete(k);
      return null;
    }
    return state;
  }

  /** Advance, and push the expiry out — the clock measures inactivity, not total time. */
  advance(state: WizardState, next: Step): void {
    state.step = next;
    state.expiresAt = this.#now() + WIZARD_TTL_MS;
    if (next === 'done') this.cancel(state.chatId, state.userId);
  }

  cancel(chatId: ChatId, userId: number): boolean {
    return this.#open.delete(key(chatId, userId));
  }

  get size(): number {
    return this.#open.size;
  }
}

/** What the wizard asks at each step. */
export const PROMPTS: Readonly<Record<Exclude<Step, 'done'>, string>> = Object.freeze({
  contract:
    "*1/5 — Which token?*\nPaste the mint address (the contract address).\n\nIt looks like `2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump`.\n\n/cancel to stop.",
  media:
    '*2/5 — Media*\nHow should buy cards look?\n\n`pool` — tiered memes from the shared pool (recommended)\n`static` — the same image every time\n`none` — text only\n\nReply with one word.',
  minbuy: "*3/5 — Minimum buy*\nHow big does a buy have to be before I post it?\n\nReply with a dollar amount, e.g. `10`.",
  emoji: '*4/5 — Emoji*\nWhich emoji should the ladder use?\n\nSend one emoji (a custom/premium one works too).',
  step: '*5/5 — Emoji step*\nOne emoji per how many dollars?\n\nReply with a dollar amount, e.g. `10` — so a $50 buy shows 5 emoji.',
});
