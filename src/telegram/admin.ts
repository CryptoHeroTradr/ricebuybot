import type { Api } from 'grammy';

import type { ChatId } from '../core/types.js';
import type { Repo } from '../db/index.js';

/** Telegram's word for "may configure this bot". */
const ADMIN_STATUSES = new Set(['administrator', 'creator']);

export type Gate = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * INVARIANT 8. Verify admin status AT WRITE TIME, against the Bot API, on every mutating
 * command. NEVER cached, not even for a second.
 *
 * A cache here is a privilege escalation with a TTL. Admin status changes — someone is
 * demoted, someone leaves, someone is removed for cause — and the whole point of removing
 * an admin is that they stop being able to do admin things IMMEDIATELY. A five-minute
 * cache means a freshly-demoted admin has five more minutes to point the group's bot at a
 * mint they control and pump it to an audience that still trusts the bot.
 *
 * It costs one API call per mutating command. Commands are rare and typed by humans; buys
 * are frequent and typed by nobody. Spending a round trip here is free in every sense that
 * matters.
 */
export async function requireGroupAdmin(
  api: Api,
  chatId: ChatId,
  userId: number,
): Promise<Gate> {
  try {
    const member = await api.getChatMember(chatId, userId);
    if (ADMIN_STATUSES.has(member.status)) return { ok: true };
    return { ok: false, why: 'Only a group admin can change my settings.' };
  } catch {
    // We could not ASK. That is not permission — it is the absence of an answer, and the
    // safe reading of "I don't know if you're an admin" is "no".
    return { ok: false, why: "I couldn't verify your admin status just now. Try again in a moment." };
  }
}

/**
 * In a DM there is no chat to be an admin OF, so the group's `added_by` is the only person
 * who may configure it — the human who put the bot there in the first place.
 *
 * Note what this does NOT do: it does not fall back to "is this person an admin of the
 * group". That would let ANY admin of ANY group the bot is in configure it from a private
 * chat, where the rest of the group cannot see it happening. Configuration in the open is
 * a feature; keep the DM path narrow.
 */
export async function requireDmOwner(repo: Repo, chatId: ChatId, userId: number): Promise<Gate> {
  const chat = await repo.getChat(chatId);
  if (!chat) return { ok: false, why: "I don't know that group. Add me to it first." };
  if (chat.addedBy === null) {
    return { ok: false, why: 'That group has no recorded owner. Configure it from inside the group.' };
  }
  if (chat.addedBy !== userId) {
    return { ok: false, why: 'Only the person who added me to that group can configure it from a DM.' };
  }
  return { ok: true };
}
