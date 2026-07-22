import type { Logger } from '../ops/logger.js';

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
