/**
 * Link policy. PURE data — no I/O.
 *
 * Lives in core/ (not render/) because the DB seeds it onto a new chat_token, and db/
 * must not import render/.
 */

/** The three every group gets. Templated with {mint}/{buyer}/{signature} at render time. */
export const DEFAULT_LINKS: Readonly<Record<string, string>> = Object.freeze({
  DexT: 'https://www.dextools.io/app/en/solana/pair-explorer/{mint}',
  Screener: 'https://dexscreener.com/solana/{mint}',
  Buy: 'https://jup.ag/swap/SOL-{mint}',
});

export const RICE_MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';

/** $RICE ships with both sites already wired. Every other group starts with the defaults. */
export const RICE_LINKS: Readonly<Record<string, string>> = Object.freeze({
  ...DEFAULT_LINKS,
  RiceDAO: 'https://game.1grainofrice.com/RiceDAO/',
  '1 Grain of Rice': 'https://1grainofrice.com/',
});

/** The links a chat_token starts life with. Seeded on INSERT, never re-applied. */
export function defaultLinksFor(mint: string): Readonly<Record<string, string>> {
  return mint === RICE_MINT ? RICE_LINKS : DEFAULT_LINKS;
}
