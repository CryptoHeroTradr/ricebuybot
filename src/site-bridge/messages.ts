/**
 * The exact strings a wallet signs for the site bridge. Both sides (site + bot) MUST build the
 * message identically, so it lives in one place. The bot reconstructs the message from the code /
 * nonce it already holds — it never trusts a message string sent by the client.
 */

/** One-time LINK proof: proves the wallet AND ties it to the code the bot DMed. */
export function linkMessage(wallet: string, code: string): string {
  return `Link RICE site\nwallet:${wallet}\ncode:${code}`;
}

/** Per-read freshness proof: the bot mints the nonce; the wallet signs THIS message over it. */
export function challengeMessage(nonce: string): string {
  return `RICE bot schedules\nnonce:${nonce}`;
}

/**
 * PHASE 9 — the per-WRITE proof. A mutation's signed message NAMES THE MUTATION.
 *
 * The read challenge would have been enough for replay (the nonce dies when it is consumed either
 * way), and it would still have been the wrong message to reuse. A wallet shows the user the text
 * it is about to sign, so if "let me see my schedules" and "pause schedule 12" are the same string,
 * a page can obtain a signature for the first and spend it on the second — and the person who
 * approved it saw a read. Naming the action makes the popup the authorisation: you sign what you
 * are actually about to do, and a proof cannot be carried from one action to another.
 *
 * The bot builds this string on both sides — once when it mints the nonce for an intent, and again
 * from the write's own body before verifying — and never accepts a message text from a client.
 * Same one-place rule as the two above.
 */
export function writeMessage(
  action: string,
  scheduleId: number | null,
  args: readonly string[],
  nonce: string,
): string {
  return [
    'RICE bot change',
    `action:${action}`,
    `schedule:${scheduleId ?? 'all'}`,
    `value:${args.join(' ')}`,
    `nonce:${nonce}`,
  ].join('\n');
}
