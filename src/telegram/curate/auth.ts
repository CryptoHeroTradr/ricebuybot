import type { Api } from 'grammy';

import type { Mint } from '../../core/types.js';
import type { Repo } from '../../db/index.js';

/**
 * WHICH MINTS MAY THIS USER CURATE?
 *
 * This is the entire security boundary of the DM flow, so it is worth being blunt about
 * what it is defending. A DM has no group around it: no other admins watching, no shared
 * context, no obvious blast radius. But a meme added here goes onto the buy card of EVERY
 * group tracking that mint, in front of everyone, and onto the onegrainofrice carousel.
 * A stranger who finds the bot must get nothing.
 *
 * A user may curate a mint iff EITHER:
 *
 *   1. they are a verified admin — `getChatMember`, ASKED NOW, never cached — of some chat
 *      configured for that mint; or
 *   2. they hold an explicit grant in `curators` (a community manager who is trusted to
 *      curate without being a Telegram admin); or
 *   3. they are the bot owner.
 *
 * NOTE WHAT IS NOT HERE: any notion of "they were an admin a minute ago". Admin status
 * changes, and the entire point of demoting someone is that they stop being able to act
 * IMMEDIATELY. A five-minute cache would give a freshly-removed admin five more minutes to
 * put whatever they like on the card of a group that just threw them out. See INVARIANT 8.
 *
 * The cost is one API call per configured chat, on a command a human typed. That is free.
 */
export interface AuthDeps {
  readonly repo: Repo;
  readonly api: Api;
  readonly ownerUserId?: number | undefined;
}

const ADMIN = new Set(['administrator', 'creator']);

/** Is this user, RIGHT NOW, an admin of any chat configured for this mint? */
export async function isAdminForMint(deps: AuthDeps, userId: number, mint: Mint): Promise<boolean> {
  for (const chatId of await deps.repo.chatsForMint(mint)) {
    try {
      const member = await deps.api.getChatMember(chatId, userId);
      if (ADMIN.has(member.status)) return true;
    } catch {
      // The bot may have been removed from that chat, or Telegram may be having a moment.
      // Either way this chat cannot vouch for them. Try the next one; never assume yes.
    }
  }
  return false;
}

/**
 * Every mint this user may curate. Re-derived on every call — this is not a cache and must
 * never become one.
 */
export async function curatableMints(deps: AuthDeps, userId: number): Promise<readonly Mint[]> {
  const all = await deps.repo.activeMints();
  const configured = new Set<Mint>(all);

  // Paused chats still have configs, and their admins can still curate — a group that is
  // temporarily quiet has not stopped owning its art.
  for (const mint of await deps.repo.grantedMints(userId)) configured.add(mint);

  // The owner curates everything, including before any group exists (the bootstrap case:
  // somebody has to be able to seed the pool for a mint nobody has configured yet).
  if (deps.ownerUserId !== undefined && userId === deps.ownerUserId) {
    return [...configured];
  }

  const granted = new Set(await deps.repo.grantedMints(userId));
  const out: Mint[] = [];

  for (const mint of configured) {
    if (granted.has(mint) || (await isAdminForMint(deps, userId, mint))) out.push(mint);
  }
  return out;
}

export type Resolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly mint: Mint }
  | { readonly kind: 'many'; readonly mints: readonly Mint[] };

/**
 * Skip the picker when there is nothing to pick.
 *
 * A curator who administers exactly one mint should never be asked "which token?" — they
 * have one, the bot knows it, and asking is a tax paid on every single /media.
 */
export async function resolveCurator(deps: AuthDeps, userId: number): Promise<Resolution> {
  const mints = await curatableMints(deps, userId);
  if (mints.length === 0) return { kind: 'none' };
  if (mints.length === 1) return { kind: 'one', mint: mints[0] as Mint };
  return { kind: 'many', mints };
}

export const NOT_A_CURATOR = "You're not an admin of any group I post in.";
