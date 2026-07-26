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
