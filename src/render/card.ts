import type { MediaItem, Mint, Signature, TokenMeta, Wallet } from '../core/types.js';
import { DEFAULT_HEADLINES, TIERS, renderHeadline, type TierFolder, type TierName } from '../core/tiers.js';
import { Caption, type MessageEntity } from './entities.js';
import { buildLadder } from './emoji.js';
import { buildKeyboard, buyerUrl, txUrl, type Button } from './links.js';
import { usd, tokens as fmtTokens, symbol as displaySymbol } from './format.js';
import { positionLine, type PositionView } from './position.js';

/** Telegram's hard ceiling for a media caption. */
export const CAPTION_MAX = 1024;
/**
 * Headroom left below the ceiling.
 *
 * Not paranoia: the caption is assembled from a group's own configurable strings (the
 * headline template, the token symbol), and a group can set a headline far longer than
 * "🐳 WHALE BUY!". The reserve means a chat with a chatty headline shortens its ladder
 * rather than having the Bot API reject the whole card.
 */
export const CAPTION_HEADROOM = 200;
export const CAPTION_BUDGET = CAPTION_MAX - CAPTION_HEADROOM;

export interface CardInput {
  readonly signature: Signature;
  readonly mint: Mint;
  readonly buyer: Wallet;
  readonly token: TokenMeta;

  /** The tier the BUY earned. The headline comes from this and nothing else. */
  readonly earnedTier: TierName;
  /** The folder the art actually came from. May differ; it changes NOTHING about the copy. */
  readonly usedTier: TierFolder | null;
  readonly media: MediaItem | null;

  readonly usdIn: number;
  /** Human amount of the quote asset actually spent — 0.3 (SOL), 25 (USDC). */
  readonly quoteAmount: number;
  readonly quoteSymbol: string;
  /** Whole tokens received. */
  readonly tokensOut: number;
  readonly marketCapUsd: number | null;
  /** Buyer's SOL+USDC wallet value. The reason a whale card fired. */
  readonly whaleValueUsd: number | null;

  readonly position: PositionView | null;

  // --- per-chat config ---
  readonly emoji: string;
  readonly emojiCustomId: string | null;
  readonly emojiStepUsd: number;
  readonly maxEmojis: number;
  readonly tierHeadlines: readonly string[];
  readonly links: Readonly<Record<string, string>> | null;
}

export interface Card {
  readonly text: string;
  readonly entities: readonly MessageEntity[];
  readonly keyboard: Button[][];
  readonly ladderCount: number;
  readonly ladderTruncated: boolean;
}

/**
 * The headline for the EARNED tier.
 *
 * A malformed `tier_headlines` falls back to the defaults rather than posting nothing. A
 * group that typed a broken JSON array into a config command should get a slightly
 * generic card, not silence — and certainly not a crash on every buy, forever, until
 * someone reads the logs.
 */
export function headlineFor(
  earned: TierName,
  headlines: readonly string[],
  symbol: string | null,
): string {
  const i = TIERS.findIndex((t) => t.name === earned);
  const raw = headlines[i];
  const template = typeof raw === 'string' && raw.length > 0 ? raw : (DEFAULT_HEADLINES[i] as string);
  return renderHeadline(template, symbol);
}

/**
 * Render the buy card. PURE — no I/O, no clock. DRY_RUN prints exactly this.
 *
 * The layout is fixed; only the ladder is elastic. See the truncation note below.
 */
export function renderCard(input: CardInput): Card {
  const symbol = displaySymbol(input.token.symbol, input.mint);
  const headline = headlineFor(input.earnedTier, input.tierHeadlines, symbol);

  // --- build the stats FIRST, so we know exactly what the ladder may spend ---------
  //
  // The ladder is the only elastic part of the card. Everything below is the message
  // itself: truncate a stat and the card is wrong; truncate the ladder and it is merely
  // shorter. So the stats are laid out first and the ladder gets what is left.
  const stats = new Caption();
  stats.nl();

  stats.add('🔀 Spent ').bold(usd(input.usdIn)).add(` (${trimQuote(input.quoteAmount)} ${input.quoteSymbol})`).nl();
  stats.add('🔀 Got ').bold(fmtTokens(input.tokensOut)).add(` ${symbol}`).nl();

  stats.add('👤 ').link('Buyer', buyerUrl(input.buyer)).add(' / ').link('TX', txUrl(input.signature)).nl();

  const line = input.position ? positionLine(input.position) : null;
  if (line && line.text !== null) {
    // INVARIANT 10: an unreconciled ledger renders NOTHING here. `positionLine` already
    // made that call; the renderer must not second-guess it into printing a number.
    stats.add(line.kind === 'position' ? '🪙 ' : '🪙 ').bold(line.text).nl();
  }

  // 💰 Wallet — ONLY on a whale card. It is the reason the card fired: the buyer holds this much
  // in liquid SOL + USDC. On any other tier it is noise, so it is omitted.
  if (input.earnedTier === 'Whale' && input.whaleValueUsd !== null) {
    stats.add('💰 Wallet ').bold(usd(input.whaleValueUsd)).add(' (SOL+USDC)').nl();
  }

  if (input.marketCapUsd !== null) {
    stats.add('💸 Market Cap ').bold(usd(input.marketCapUsd));
  }

  // --- now the caption, headline first ---------------------------------------------
  const cap = new Caption();
  cap.bold(headline).nl();

  const spent = cap.offset + stats.text.length;
  const ladder = buildLadder({
    usdIn: input.usdIn,
    stepUsd: input.emojiStepUsd,
    maxEmojis: input.maxEmojis,
    emoji: input.emoji,
    customEmojiId: input.emojiCustomId,
    budgetUtf16: Math.max(0, CAPTION_BUDGET - spent),
    offset: cap.offset, // UTF-16, and it is where the ladder text will actually land
  });

  cap.addWithEntities(ladder.text, ladder.entities);

  // Splice the pre-built stats on, shifting their offsets by where they now start.
  const shift = cap.offset;
  cap.addWithEntities(
    stats.text,
    stats.entities.map((e) => ({ ...e, offset: e.offset + shift })),
  );

  return {
    text: cap.text,
    entities: cap.entities,
    keyboard: buildKeyboard(input.links, {
      mint: input.mint,
      buyer: input.buyer,
      signature: input.signature,
    }),
    ladderCount: ladder.count,
    ladderTruncated: ladder.truncated,
  };
}

/** 0.3 SOL, 25 USDC, 1.25 SOL — never 0.30000000000000004. */
function trimQuote(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000) return Math.round(n).toLocaleString('en-US');
  const s = n.toFixed(n >= 100 ? 0 : n >= 1 ? 2 : 3);
  return s.replace(/\.?0+$/, '');
}
