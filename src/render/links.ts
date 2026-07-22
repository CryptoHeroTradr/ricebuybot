import type { Mint, Signature, Wallet } from '../core/types.js';

export interface LinkContext {
  readonly mint: Mint;
  readonly buyer: Wallet;
  readonly signature: Signature;
}

export interface Button {
  readonly text: string;
  readonly url: string;
}

/** Substitute {mint} / {buyer} / {signature}. Templates come from links_json. */
export function template(url: string, ctx: LinkContext): string {
  return url
    .replaceAll('{mint}', ctx.mint)
    .replaceAll('{buyer}', ctx.buyer)
    .replaceAll('{signature}', ctx.signature);
}

/** Solscan, for the body anchors (not buttons — see the card). */
export const buyerUrl = (buyer: Wallet): string => `https://solscan.io/account/${buyer}`;
export const txUrl = (sig: Signature): string => `https://solscan.io/tx/${sig}`;

export { DEFAULT_LINKS, RICE_LINKS, RICE_MINT, defaultLinksFor } from '../core/links.js';
import { DEFAULT_LINKS as FALLBACK } from '../core/links.js';

const MAX_PER_ROW = 3;
const MAX_ROWS = 2;

/**
 * The inline keyboard.
 *
 * NEVER RENDER A DEAD BUTTON. A link absent from links_json is simply omitted — a button
 * that 404s is worse than no button, because someone has to tap it to find out.
 *
 * Order is stable (defaults first, then whatever the group added) so the keyboard does
 * not reshuffle between posts, and it is capped at 3 x 2. Past that the card stops being
 * a card and starts being a link farm; the overflow is dropped rather than silently
 * pushing the important buttons onto a third row nobody scrolls to.
 */
export function buildKeyboard(
  links: Readonly<Record<string, string>> | null,
  ctx: LinkContext,
): Button[][] {
  const source = links && Object.keys(links).length > 0 ? links : FALLBACK;

  const buttons: Button[] = [];
  for (const [text, url] of Object.entries(source)) {
    if (typeof url !== 'string' || url.length === 0) continue; // a dead entry is not a button
    buttons.push({ text, url: template(url, ctx) });
    if (buttons.length >= MAX_PER_ROW * MAX_ROWS) break;
  }

  const rows: Button[][] = [];
  for (let i = 0; i < buttons.length; i += MAX_PER_ROW) {
    rows.push(buttons.slice(i, i + MAX_PER_ROW));
  }
  return rows;
}
