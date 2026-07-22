/**
 * What Telegram just told us, and what to do about it.
 *
 * The three outcomes map exactly onto the send ledger's state machine, and that is not a
 * coincidence — getting this classification wrong is how the ledger leaks:
 *
 *   rate_limit -> wait retry_after, try again. The row STAYS claimed.
 *   retryable  -> releaseSend (delete the row) so a later attempt can re-claim it.
 *   permanent  -> failSend (tombstone) and, for the access errors, pause the chat.
 *
 * Classifying a permanent error as retryable means we hammer a chat that has kicked us,
 * forever. Classifying a retryable one as permanent means a blip silently costs a post.
 */
export type Verdict =
  | { readonly kind: 'rate_limit'; readonly retryAfterSec: number }
  | { readonly kind: 'retryable'; readonly reason: string }
  | { readonly kind: 'permanent'; readonly reason: string; readonly pauseChat: boolean };

interface TelegramError {
  error_code: number | undefined;
  description: string | undefined;
  parameters: { retry_after?: number } | undefined;
}

function payloadOf(err: unknown): TelegramError {
  const e = err as { error_code?: number; description?: string; parameters?: { retry_after?: number } };
  return {
    error_code: e?.error_code,
    description: e?.description ?? String((err as Error)?.message ?? err),
    parameters: e?.parameters,
  };
}

/**
 * The bot cannot post here and never will until a human intervenes: kicked, blocked,
 * demoted, the group was deleted, or it was upgraded to a supergroup (which changes the
 * chat_id). Retrying any of these is pure noise, and the chat gets paused so we stop
 * asking. Self-healing: no manual cleanup list to maintain.
 */
const ACCESS_DENIED = [
  'bot was kicked',
  'bot is not a member',
  'chat not found',
  'have no rights to send',
  'not enough rights',
  'bot was blocked',
  'user is deactivated',
  'group chat was upgraded',
  'chat_write_forbidden',
];

/** Telegram's way of saying the custom emoji is not usable here. */
export function isCustomEmojiRejection(err: unknown): boolean {
  const d = (payloadOf(err).description ?? '').toLowerCase();
  return (
    d.includes('custom_emoji') ||
    d.includes('custom emoji') ||
    d.includes('emoji is not allowed') ||
    d.includes('sticker set is invalid')
  );
}

export function classify(err: unknown): Verdict {
  const { error_code, description, parameters } = payloadOf(err);
  const d = (description ?? '').toLowerCase();

  if (error_code === 429) {
    // Honour retry_after EXACTLY. Backing off less is how a 429 becomes a ban; backing
    // off more (a doubling ramp on top) just makes every buy in the queue stale.
    return { kind: 'rate_limit', retryAfterSec: Math.max(1, parameters?.retry_after ?? 1) };
  }

  if (error_code === 403 || ACCESS_DENIED.some((s) => d.includes(s))) {
    return { kind: 'permanent', reason: description ?? 'forbidden', pauseChat: true };
  }

  // 400s are our fault — a malformed caption, a bad file_id, an entity off the end of the
  // string. Retrying an identical bad request cannot help, so it is permanent for THIS
  // message, but the chat is fine and must not be paused.
  if (error_code === 400) {
    return { kind: 'permanent', reason: description ?? 'bad request', pauseChat: false };
  }

  // Everything else — 5xx, timeouts, socket resets — is the network being the network.
  return { kind: 'retryable', reason: description ?? 'unknown' };
}
