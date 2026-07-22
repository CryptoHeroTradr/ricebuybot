import { describe, expect, it } from 'vitest';

import { renderCard, headlineFor, CAPTION_MAX, CAPTION_BUDGET, type CardInput } from '../src/render/card.js';
import { buildLadder, ladderCount, utf16Length } from '../src/render/emoji.js';
import { buildKeyboard, DEFAULT_LINKS, RICE_LINKS } from '../src/render/links.js';
import { DEFAULT_HEADLINES } from '../src/core/tiers.js';
import type { Mint, Signature, TokenMeta, Wallet } from '../src/core/types.js';

const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const BUYER = '9xQeWvG816bUx9EPa2rBBWiRrGCTPnEymEmZ1hLbYQCP' as Wallet;
const SIG = '5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7' as Signature;

const TOKEN: TokenMeta = {
  mint: MINT,
  symbol: 'RICE',
  name: 'One Grain of Rice',
  decimals: 6,
  supplyRaw: 982_048_494_780_000n,
  metaUpdatedAt: 1,
};

function card(over: Partial<CardInput> = {}) {
  const input: CardInput = {
    signature: SIG,
    mint: MINT,
    buyer: BUYER,
    token: TOKEN,
    earnedTier: 'Regular',
    usedTier: 'regular',
    media: null,
    usdIn: 23.29,
    quoteAmount: 0.3,
    quoteSymbol: 'SOL',
    tokensOut: 242_531,
    marketCapUsd: 94_110,
    whaleValueUsd: 52_400,
    position: null,
    emoji: '🍚',
    emojiCustomId: null,
    emojiStepUsd: 10,
    maxEmojis: 100,
    tierHeadlines: [...DEFAULT_HEADLINES],
    links: DEFAULT_LINKS,
    ...over,
  };
  return renderCard(input);
}

// =============================================================================
// THE EMOJI LADDER — the UTF-16 trap
// =============================================================================

describe('emoji ladder', () => {
  it('counts by step, floored, clamped to at least one', () => {
    expect(ladderCount(23.29, 10, 100)).toBe(2);
    expect(ladderCount(94, 10, 100)).toBe(9);
    expect(ladderCount(9.99, 10, 100)).toBe(1); // never zero: the feature must be visible
    expect(ladderCount(10_000, 10, 100)).toBe(100); // clamped to max_emojis
  });

  /**
   * THE TRAP, stated as a test. '🍚'.length === 2 in UTF-16 but is ONE code point. If
   * offsets are counted in code points (or characters), every entity after the first lands
   * on the wrong slice — and the failure is SILENT: the message sends, the custom emoji
   * just render over the wrong text.
   */
  it('offsets are UTF-16 code units, not code points', () => {
    expect(utf16Length('🍚')).toBe(2);
    expect([...'🍚'].length).toBe(1); // <- what a naive count would have given

    const ladder = buildLadder({
      usdIn: 40,
      stepUsd: 10,
      maxEmojis: 100,
      emoji: '🍚',
      customEmojiId: '5368324170671202286',
      budgetUtf16: 1000,
      offset: 0,
    });

    expect(ladder.count).toBe(4);
    expect(ladder.text).toBe('🍚🍚🍚🍚');
    // 2 units apart, NOT 1.
    expect(ladder.entities.map((e) => e.offset)).toEqual([0, 2, 4, 6]);
    expect(ladder.entities.every((e) => e.length === 2)).toBe(true);
  });

  it('a MULTI-CODEPOINT emoji (ZWJ family) still lands on exact boundaries', () => {
    // '👨‍👩‍👧' is 3 emoji joined by 2 ZWJs: 8 UTF-16 units, 5 code points, 1 grapheme.
    const family = '👨‍👩‍👧';
    expect(utf16Length(family)).toBe(8);

    const ladder = buildLadder({
      usdIn: 30,
      stepUsd: 10,
      maxEmojis: 100,
      emoji: family,
      customEmojiId: 'X',
      budgetUtf16: 1000,
      offset: 5, // start part-way in, as the real card does
    });

    expect(ladder.count).toBe(3);
    expect(ladder.entities.map((e) => e.offset)).toEqual([5, 13, 21]);
    expect(ladder.entities.every((e) => e.length === 8)).toBe(true);

    // Every entity slices exactly one whole family out of the real string.
    const text = ladder.text;
    for (const e of ladder.entities) {
      expect(text.slice(e.offset - 5, e.offset - 5 + e.length)).toBe(family);
    }
  });

  it('the UNICODE emoji is always the text — custom emoji only decorate it', () => {
    // So any client that cannot render the custom emoji (old app, notification, web
    // preview) shows a rice grain, not a placeholder dot.
    const ladder = buildLadder({
      usdIn: 20,
      stepUsd: 10,
      maxEmojis: 100,
      emoji: '🍚',
      customEmojiId: 'X',
      budgetUtf16: 100,
      offset: 0,
    });
    expect(ladder.text).toBe('🍚🍚');
  });

  it('emits NO entities when the chat has no custom emoji configured', () => {
    const ladder = buildLadder({
      usdIn: 50,
      stepUsd: 10,
      maxEmojis: 100,
      emoji: '🍚',
      customEmojiId: null,
      budgetUtf16: 100,
      offset: 0,
    });
    expect(ladder.entities).toEqual([]);
    expect(ladder.text).toBe('🍚🍚🍚🍚🍚');
  });
});

// =============================================================================
// CAPTION TRUNCATION
// =============================================================================

describe('caption truncation shortens the LADDER, never the stats', () => {
  it('a huge buy at a tiny step still fits, with every stat intact', () => {
    const c = card({ usdIn: 1_000_000, emojiStepUsd: 1, maxEmojis: 5000, marketCapUsd: 94_110 });

    expect(c.ladderTruncated).toBe(true);
    expect(c.text.length).toBeLessThanOrEqual(CAPTION_BUDGET);
    expect(c.text.length).toBeLessThanOrEqual(CAPTION_MAX);

    // The numbers are the message. Every one of them survived.
    expect(c.text).toContain('Spent');
    expect(c.text).toContain('Got');
    expect(c.text).toContain('Market Cap');
    expect(c.text).toContain('$94.1K');
  });

  it('leaves 200 chars of headroom below Telegram’s 1024 ceiling', () => {
    const c = card({ usdIn: 5_000_000, emojiStepUsd: 1, maxEmojis: 100_000 });
    expect(c.text.length).toBeLessThanOrEqual(CAPTION_MAX - 200);
  });

  it('a long custom headline eats into the ladder, not the card', () => {
    const long = '🐳 ' + 'W'.repeat(300) + ' BUY!';
    const c = card({ earnedTier: 'Whale', tierHeadlines: ['a', 'b', long, 'd'], usdIn: 10_000 });

    expect(c.text).toContain('Market Cap');
    expect(c.text.length).toBeLessThanOrEqual(CAPTION_BUDGET);
  });

  it('never renders a zero-length ladder', () => {
    const c = card({ usdIn: 1_000_000, emojiStepUsd: 0.01, maxEmojis: 100_000 });
    expect(c.ladderCount).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// THE CARD
// =============================================================================

describe('the card', () => {
  it('renders the target layout', () => {
    const c = card({ earnedTier: 'Whale', usedTier: 'whale' });
    expect(c.text).toContain('🐳 WHALE BUY!');
    expect(c.text).toContain('🔀 Spent $23.29 (0.3 SOL)');
    expect(c.text).toContain('🔀 Got 242,531 RICE');
    expect(c.text).toContain('👤 Buyer / TX');
    expect(c.text).toContain('💸 Market Cap $94.1K');
  });

  it('names the ACTUAL quote asset in the parenthetical', () => {
    expect(card({ quoteAmount: 0.3, quoteSymbol: 'SOL' }).text).toContain('(0.3 SOL)');
    expect(card({ quoteAmount: 25, quoteSymbol: 'USDC' }).text).toContain('(25 USDC)');
  });

  it('💰 Wallet renders ONLY on a whale card — it is the reason the card fired', () => {
    const whale = card({ earnedTier: 'Whale', whaleValueUsd: 52_400 });
    expect(whale.text).toContain('💰 Wallet $52.4K (SOL+USDC)');

    for (const tier of ['Regular', 'Big', 'Massive'] as const) {
      const other = card({ earnedTier: tier, whaleValueUsd: 52_400 });
      expect(other.text).not.toContain('Wallet');
    }
  });

  /**
   * THE ONE THAT MATTERS. The headline is a fact about the BUY; the art is decoration.
   * A whale that had to borrow a big/ meme is still a whale.
   */
  it('a WHALE buy on big/ art still says WHALE', () => {
    const c = card({ earnedTier: 'Whale', usedTier: 'big' });
    expect(c.text).toContain('🐳 WHALE BUY!');
    expect(c.text).not.toContain('BIG');
  });

  it('headline comes from the earned tier, with {SYM} substituted', () => {
    expect(headlineFor('Regular', DEFAULT_HEADLINES, 'RICE')).toBe('🍚 RICE Buy!');
    expect(headlineFor('Big', DEFAULT_HEADLINES, 'RICE')).toBe('🍚 BIG RICE Buy!');
    expect(headlineFor('Whale', DEFAULT_HEADLINES, 'RICE')).toBe('🐳 WHALE BUY!');
    expect(headlineFor('Massive', DEFAULT_HEADLINES, 'RICE')).toBe('💥 MASSIVE BUY!');
  });

  it('a MALFORMED tier_headlines falls back to defaults rather than posting nothing', () => {
    // A group that typed a broken config command gets a slightly generic card — not
    // silence, and not a crash on every buy forever.
    expect(headlineFor('Whale', [], 'RICE')).toBe('🐳 WHALE BUY!');
    expect(headlineFor('Big', ['', '', '', ''], 'RICE')).toBe('🍚 BIG RICE Buy!');
    expect(headlineFor('Regular', ['only-one'], 'RICE')).toBe('only-one');
  });

  it('bold and link entities point at exactly the text they claim to', () => {
    const c = card();
    for (const e of c.entities) {
      const slice = c.text.slice(e.offset, e.offset + e.length);
      expect(slice.length).toBe(e.length); // never runs off the end of the string
    }
    const links = c.entities.filter((e) => e.type === 'text_link');
    const texts = links.map((e) => c.text.slice(e.offset, e.offset + e.length));
    expect(texts).toEqual(['Buyer', 'TX']);
  });

  it('omits the Position line entirely when the ledger is unreconciled (INVARIANT 10)', () => {
    const c = card({
      position: {
        reconciled: false,
        tokensRaw: 1_000n,
        balanceBeforeRaw: 5_000n,
        avgCostUsd: 0.0001,
        priceUsd: 0.001,
        hasPriorHistory: true,
      },
    });
    expect(c.text).not.toContain('Position');
  });

  it('renders Position when reconciled', () => {
    const c = card({
      position: {
        reconciled: true,
        tokensRaw: 1_000n,
        balanceBeforeRaw: 5_000n,
        avgCostUsd: 1,
        priceUsd: 2.28,
        hasPriorHistory: true,
      },
    });
    expect(c.text).toContain('Position +128%');
  });
});

// =============================================================================
// LINKS
// =============================================================================

describe('inline keyboard', () => {
  const ctx = { mint: MINT, buyer: BUYER, signature: SIG };

  it('templates {mint} into the three defaults', () => {
    const rows = buildKeyboard(DEFAULT_LINKS, ctx);
    const flat = rows.flat();
    expect(flat.map((b) => b.text)).toEqual(['DexT', 'Screener', 'Buy']);
    expect(flat[0]?.url).toContain(MINT);
    expect(flat.every((b) => !b.url.includes('{'))).toBe(true); // nothing left unsubstituted
  });

  it('$RICE ships with both site links; everyone else gets the three defaults', () => {
    const rice = buildKeyboard(RICE_LINKS, ctx).flat().map((b) => b.text);
    expect(rice).toContain('RiceDAO');
    expect(rice).toContain('1 Grain of Rice');

    const other = buildKeyboard(DEFAULT_LINKS, ctx).flat().map((b) => b.text);
    expect(other).not.toContain('RiceDAO');
  });

  it('NEVER renders a dead button — an absent link is simply omitted', () => {
    const rows = buildKeyboard({ DexT: DEFAULT_LINKS.DexT as string, Broken: '' }, ctx);
    expect(rows.flat().map((b) => b.text)).toEqual(['DexT']);
  });

  it('caps at 3 per row and 2 rows', () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`L${i}`, 'https://x/{mint}']),
    );
    const rows = buildKeyboard(many, ctx);
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.every((r) => r.length <= 3)).toBe(true);
    expect(rows.flat().length).toBe(6);
  });
});
