import type { Logger } from '../ops/logger.js';
import { DEFAULT_MODE, type TraderMode } from './mode.js';

/**
 * THE ALLOWLIST (INVARIANT 14).
 *
 * Membership is hand-entered and nothing widens it. There is no plan check in this file, no
 * `/grant` path into it, and no config flag — and that absence is the feature. Search this
 * module for `plan` and the answer must stay "not here".
 *
 * A NON-MEMBER GETS NO REPLY. Not "you are not authorised", not "unknown command" — nothing.
 * A refusal is an oracle: send /wallet to a bot, get a refusal, and you have learned the
 * autotrader exists and that there is a list to be on. Silence is the same response the bot
 * gives to a command it does not have, so probing distinguishes nothing. This is why every
 * handler returns `Silence` rather than a message.
 *
 * CHECKED AT ACTION TIME, NEVER CACHED — same reasoning as INVARIANT 8's admin gate. A cache
 * here is a revocation with a TTL, and the whole point of removing someone is that their
 * access stops NOW, not at the end of some window.
 */

export interface AutotraderMember {
  readonly userId: number;
  readonly label: string | null;
  readonly addedBy: number | null;
  readonly addedAt: number;
  /** Revoked but NOT destroyed. Off the allowlist; keystore file still on disk. */
  readonly locked: boolean;
  readonly lockedAt: number | null;
  /**
   * PHASE 7 — which half of the autotrader this member is in, and so whether the bot holds a key
   * that can spend their money. 'wallet' for every new member (migration 019). Never widened by a
   * plan, a flag or the owner: only the member themselves can move it, and only through /mode.
   */
  readonly mode: TraderMode;
}

export type AccessAction = 'add' | 'remove' | 'purge';

/**
 * The storage this module needs. Deliberately narrow: `access.ts` can see the allowlist and
 * nothing else — not chats, not positions, not media.
 */
export interface AutotraderAccessRepo {
  getAutotraderUser(userId: number): Promise<AutotraderMember | null>;
  listAutotraderUsers(): Promise<readonly AutotraderMember[]>;
  addAutotraderUser(userId: number, label: string | null, addedBy: number | null): Promise<void>;
  setAutotraderLocked(userId: number, locked: boolean): Promise<void>;
  /** PHASE 7. The ONLY writer of the mode column. Called by /mode and by nothing else. */
  setAutotraderMode(userId: number, mode: TraderMode): Promise<void>;
  deleteAutotraderUser(userId: number): Promise<void>;
  logAutotraderAccess(userId: number, action: AccessAction, actor: number | null, note?: string): Promise<void>;
}

/**
 * The result of a membership check.
 *
 * There are exactly two outcomes and neither of them is a message to a non-member. `allowed`
 * runs the handler; `silence` returns without replying at all.
 */
export type AccessVerdict = { readonly allowed: true; readonly member: AutotraderMember } | { readonly allowed: false };

export const SILENCE: AccessVerdict = Object.freeze({ allowed: false });

/**
 * THE gate. Every autotrader command goes through this one function.
 *
 * A locked member is NOT a member: revocation takes effect here, at action time, without any
 * other code needing to know it happened.
 */
export async function checkMember(repo: AutotraderAccessRepo, userId: number): Promise<AccessVerdict> {
  if (!Number.isInteger(userId) || userId <= 0) return SILENCE;

  const member = await repo.getAutotraderUser(userId);
  if (!member || member.locked) return SILENCE;
  return { allowed: true, member };
}

/**
 * Owner check for `/trader` administration.
 *
 * Note what the owner can and cannot do. Membership: yes. Anyone else's wallet, balance,
 * pubkey, passphrase or key: NO, and not by any code path in this module (INVARIANT 14).
 * Administering the list is not administering the money.
 *
 * A non-owner gets silence too — the same reasoning, one level up.
 */
export function isOwner(ownerUserId: number | undefined, userId: number): boolean {
  return ownerUserId !== undefined && ownerUserId === userId && userId > 0;
}

export class AutotraderAccess {
  readonly #repo: AutotraderAccessRepo;
  readonly #log: Logger;
  readonly #now: () => number;

  constructor(repo: AutotraderAccessRepo, log: Logger, now: () => number = Date.now) {
    this.#repo = repo;
    this.#log = log;
    this.#now = now;
  }

  check(userId: number): Promise<AccessVerdict> {
    return checkMember(this.#repo, userId);
  }

  list(): Promise<readonly AutotraderMember[]> {
    return this.#repo.listAutotraderUsers();
  }

  get(userId: number): Promise<AutotraderMember | null> {
    return this.#repo.getAutotraderUser(userId);
  }

  /**
   * PHASE 7 — the mode of a user, resolved for callers who have no member row in hand.
   *
   * A NON-MEMBER READS AS 'wallet'. That is not a courtesy default, it is the accurate answer to
   * the question this function is asked: "does the bot hold a key for this person and act on it?"
   * For someone who is not on the allowlist the answer is no, and every caller — the scheduler's
   * work list, the panel, the attribution set — wants exactly that reading. The alternative,
   * a null the callers each have to remember to treat as no-custody, is one forgotten branch away
   * from the bot ticking a schedule for someone it no longer serves.
   */
  async mode(userId: number): Promise<TraderMode> {
    const member = await this.#repo.getAutotraderUser(userId);
    if (!member || member.locked) return DEFAULT_MODE;
    return member.mode;
  }

  /**
   * Move a member between modes. The PRECONDITIONS ARE THE CALLER'S (see `checkModeSwitch` and the
   * /mode flow): this writes the column and the audit line, and deliberately holds no policy —
   * a guard that lives in two places is a guard with two different opinions.
   */
  async setMode(userId: number, mode: TraderMode): Promise<void> {
    await this.#repo.setAutotraderMode(userId, mode);
    // The mode is not a secret and the user id is not either. Whether the bot holds a key for
    // someone is precisely the kind of change that must be reconstructable from the logs.
    this.#log.warn({ userId, mode, at: this.#now() }, 'autotrader: trader MODE changed');
  }

  async add(userId: number, label: string | null, actor: number): Promise<void> {
    await this.#repo.addAutotraderUser(userId, label, actor);
    await this.#repo.logAutotraderAccess(userId, 'add', actor);
    // The user id is not a secret; the label might be a name. Log the id, not the label.
    this.#log.info({ userId, actor, at: this.#now() }, 'autotrader: member added');
  }

  /**
   * REVOKE — and revoke ONLY.
   *
   * Locks the member and pauses their schedules. It does NOT delete the keystore: that is
   * their key, and withdrawing access to a service is not authority to destroy someone's
   * property (INVARIANT 14). Destruction is `purge`, which is a separate, typed-confirmation
   * act by the owner, and which tells the user it happened.
   *
   * The caller pauses schedules and locks the in-memory key; this function owns the row.
   */
  async remove(userId: number, actor: number): Promise<void> {
    await this.#repo.setAutotraderLocked(userId, true);
    await this.#repo.logAutotraderAccess(userId, 'remove', actor, 'keystore retained');
    this.#log.info({ userId, actor }, 'autotrader: member removed (keystore RETAINED)');
  }

  /** Owner-only, typed confirmation, and the user is told. The row and the key both go. */
  async purge(userId: number, actor: number): Promise<void> {
    await this.#repo.logAutotraderAccess(userId, 'purge', actor, 'keystore destroyed');
    await this.#repo.deleteAutotraderUser(userId);
    this.#log.warn({ userId, actor }, 'autotrader: keystore PURGED — key destroyed');
  }
}
