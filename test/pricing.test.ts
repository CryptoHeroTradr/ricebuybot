import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { pct, tokens as fmtTokens, usd } from '../src/render/format.js';
import { PriceBook, DEAD_MS, PRIMARY_STALE_MS } from '../src/pricing/price-book.js';
import { parseBinanceBookTicker, parseCoinbaseTicker } from '../src/pricing/sol-usd.js';
import { HoldQueue } from '../src/pricing/hold-queue.js';
import { TokenMetaCache, fallbackSymbol, type SolanaRpc } from '../src/pricing/token-meta.js';
import { derivePricing } from '../src/pricing/derive.js';
import { Pricer } from '../src/pricing/index.js';
import { QUOTE_ASSETS, SOL_QUOTE, USDC_MINT } from '../src/pricing/quote.js';
import { WSOL_MINT } from '../src/core/quotes.js';
import { normalizeSwap } from '../src/ingest/normalize.js';
import { createLogger } from '../src/ops/logger.js';
import type { BuyEvent, Mint, TokenMeta } from '../src/core/types.js';
import type { Repo } from '../src/db/index.js';
import type { SolUsdFeed } from '../src/pricing/sol-usd.js';

const log = createLogger('silent' as 'info', false);

// ---------------------------------------------------------------------------
// format
// ---------------------------------------------------------------------------

describe('format.usd', () => {
  it('formats the documented ladder', () => {
    expect(usd(23.29)).toBe('$23.29');
    expect(usd(1_204)).toBe('$1,204');
    expect(usd(94_100)).toBe('$94.1K');
    expect(usd(1_240_000)).toBe('$1.24M');
  });

  it('handles zero and sub-cent without lying', () => {
    expect(usd(0)).toBe('$0.00');
    // A dust buy must NOT render as "$0.00" — that reads as free, and looks like a bug.
    expect(usd(0.004)).toBe('<$0.01');
    expect(usd(0.0000001)).toBe('<$0.01');
    expect(usd(0.01)).toBe('$0.01');
  });

  it('handles 1e12 and beyond', () => {
    expect(usd(1e12)).toBe('$1T');
    expect(usd(1.24e12)).toBe('$1.24T');
    expect(usd(1e9)).toBe('$1B');
    expect(usd(999.99)).toBe('$999.99');
  });

  it('handles boundaries exactly', () => {
    expect(usd(999)).toBe('$999.00');
    expect(usd(1_000)).toBe('$1,000');
    expect(usd(9_999)).toBe('$9,999');
    expect(usd(10_000)).toBe('$10K');
    // 999_999 scales to 999.999K, which would trim to a nonsense "$1000K".
    // It must promote to the next unit instead.
    expect(usd(999_999)).toBe('$1M');
    expect(usd(1_000_000)).toBe('$1M');
    expect(usd(999_999_999)).toBe('$1B');
    expect(usd(105_075.43)).toBe('$105K'); // the market cap from the integration test
  });

  it('survives junk instead of printing NaN', () => {
    expect(usd(Number.NaN)).toBe('$0.00');
    expect(usd(Number.POSITIVE_INFINITY)).toBe('$0.00');
  });

  it('handles negatives', () => {
    expect(usd(-23.29)).toBe('-$23.29');
  });
});

describe('format.tokens', () => {
  it('groups with commas', () => {
    expect(fmtTokens(242_531)).toBe('242,531');
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(1e12)).toBe('1,000,000,000,000');
    expect(fmtTokens(27_305.176)).toBe('27,305'); // whole tokens only
  });
});

describe('format.pct', () => {
  it('always shows the sign', () => {
    expect(pct(128)).toBe('+128%');
    expect(pct(-41)).toBe('-41%');
    expect(pct(0)).toBe('+0%');
    expect(pct(0.4)).toBe('+0%');
    expect(pct(-0.4)).toBe('+0%'); // rounds to -0 -> must not render "-0%"
  });
});

// ---------------------------------------------------------------------------
// staleness state machine
// ---------------------------------------------------------------------------

describe('PriceBook staleness', () => {
  let now = 1_000_000;
  const book = () => new PriceBook(() => now);

  it('prefers a fresh primary', () => {
    const b = book();
    b.set('binance', 100, now);
    b.set('coinbase', 200, now);
    expect(b.read()?.source).toBe('binance');
    expect(b.solUsd()).toBe(100);
  });

  it('fails over to secondary when primary goes >10s stale', () => {
    const b = book();
    const t0 = now;
    b.set('binance', 100, t0);
    b.set('coinbase', 200, t0);

    now = t0 + PRIMARY_STALE_MS + 1;
    b.set('coinbase', 201, now); // secondary still ticking

    expect(b.read()?.source).toBe('coinbase');
    expect(b.solUsd()).toBe(201);
  });

  it('returns null only when BOTH are >30s stale — never a guessed price', () => {
    const b = book();
    const t0 = now;
    b.set('binance', 100, t0);
    b.set('coinbase', 200, t0);

    now = t0 + DEAD_MS + 1;
    expect(b.read()).toBeNull();
    expect(b.solUsd()).toBeNull();
  });

  it('keeps a merely-stale primary rather than returning null', () => {
    const b = book();
    const t0 = now;
    b.set('binance', 100, t0); // primary only
    now = t0 + 20_000; // >10s (stale) but <30s (alive), and no secondary at all

    expect(b.solUsd()).toBe(100);
  });

  it('rejects junk ticks', () => {
    const b = book();
    b.set('binance', Number.NaN, now);
    b.set('binance', 0, now);
    b.set('binance', -5, now);
    expect(b.solUsd()).toBeNull();
  });
});

describe('SOL feed parsers', () => {
  /**
   * The primary reads Binance.US bookTicker, NOT the trade stream.
   *
   * Measured live: solusdt@trade emitted ZERO trades in 30s while
   * solusdt@bookTicker emitted 279 updates. On the trade stream the primary would
   * be permanently stale and every buy would silently ride the Coinbase failover.
   */
  it('takes the mid of the Binance book', () => {
    expect(parseBinanceBookTicker('{"b":"77.70","a":"77.80"}')).toBeCloseTo(77.75, 6);
  });

  it('rejects a crossed or absurdly wide book', () => {
    expect(parseBinanceBookTicker('{"b":"78.00","a":"77.00"}')).toBeNull(); // crossed
    expect(parseBinanceBookTicker('{"b":"70.00","a":"90.00"}')).toBeNull(); // >5% wide
    expect(parseBinanceBookTicker('{"b":"0","a":"77.80"}')).toBeNull();
    expect(parseBinanceBookTicker('not json')).toBeNull();
  });

  it('reads only ticker messages from Coinbase', () => {
    expect(parseCoinbaseTicker('{"type":"ticker","price":"77.88"}')).toBe(77.88);
    expect(parseCoinbaseTicker('{"type":"subscriptions"}')).toBeNull();
    expect(parseCoinbaseTicker('{"type":"heartbeat","price":"77.88"}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hold queue
// ---------------------------------------------------------------------------

const mkBuy = (sig: string, over: Partial<BuyEvent> = {}): BuyEvent => ({
  kind: 'buy',
  signature: sig,
  slot: 1,
  blockTime: null,
  mint: 'M',
  buyer: 'W',
  quoteMint: WSOL_MINT,
  quoteSymbol: 'SOL',
  quoteRaw: 1_000_000_000n,
  tokensRaw: 1_000_000n,
  balanceBeforeRaw: 0n,
  balanceAfterRaw: 1_000_000n,
  ...over,
});

describe('HoldQueue', () => {
  it('holds and flushes oldest-first', () => {
    const q = new HoldQueue(log, 200);
    q.hold(mkBuy('a'));
    q.hold(mkBuy('b'));

    const out: string[] = [];
    expect(q.flush((e) => out.push(e.signature))).toBe(2);
    expect(out).toEqual(['a', 'b']);
    expect(q.size).toBe(0);
  });

  it('is bounded at 200 and evicts the OLDEST on overflow', () => {
    const q = new HoldQueue(log, 200);
    for (let i = 0; i < 205; i++) q.hold(mkBuy(`s${i}`));

    expect(q.size).toBe(200);
    expect(q.dropped).toBe(5);

    const out: string[] = [];
    q.flush((e) => out.push(e.signature));
    // The five oldest are gone; the newest survived.
    expect(out[0]).toBe('s5');
    expect(out.at(-1)).toBe('s204');
  });

  it('reports how long each buy was held', () => {
    let now = 0;
    const q = new HoldQueue(log, 200, () => now);
    q.hold(mkBuy('a'));
    now = 5_000;

    const ages: number[] = [];
    q.flush((_e, heldMs) => ages.push(heldMs));
    expect(ages).toEqual([5_000]);
  });
});

// ---------------------------------------------------------------------------
// token metadata
// ---------------------------------------------------------------------------

const RICE = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';

function stubRepo(): Repo {
  const store = new Map<Mint, TokenMeta>();
  return {
    getToken: async (m: Mint) => store.get(m) ?? null,
    putToken: async (t: TokenMeta) => void store.set(t.mint, t),
  } as unknown as Repo;
}

describe('TokenMetaCache', () => {
  it('reads decimals and supply from the CHAIN, never a pump default', async () => {
    // RICE really is 6 decimals but 982,048,494.777792 supply — NOT the 1B that a
    // hardcoded "pump default" would assume. Market cap is computed from this.
    const rpc: SolanaRpc = {
      getTokenSupply: async () => ({ amount: 982_048_494_777_792n, decimals: 6 }),
      getAssetMeta: async () => ({ symbol: 'RICE', name: 'Rice' }),
    };
    const cache = new TokenMetaCache(rpc, stubRepo(), log);

    const meta = await cache.get(RICE);
    expect(meta?.decimals).toBe(6);
    expect(meta?.supplyRaw).toBe(982_048_494_777_792n);
    expect(meta?.supplyRaw).not.toBe(1_000_000_000_000_000n); // the 1B trap
  });

  it('falls back to the mint prefix when metadata is missing', async () => {
    const rpc: SolanaRpc = {
      getTokenSupply: async () => ({ amount: 1n, decimals: 6 }),
      getAssetMeta: async () => null,
    };
    const meta = await new TokenMetaCache(rpc, stubRepo(), log).get(RICE);

    expect(meta?.symbol).toBe('2wQq');
    expect(fallbackSymbol(RICE)).toBe('2wQq');
  });

  it('caches for 5 minutes, then refetches', async () => {
    let now = 0;
    const getTokenSupply = vi.fn(async () => ({ amount: 10n, decimals: 6 }));
    const rpc: SolanaRpc = { getTokenSupply, getAssetMeta: async () => null };
    const cache = new TokenMetaCache(rpc, stubRepo(), log, 5 * 60_000, () => now);

    await cache.get(RICE);
    await cache.get(RICE);
    expect(getTokenSupply).toHaveBeenCalledTimes(1); // second read served from cache

    now = 5 * 60_000 + 1;
    await cache.get(RICE);
    expect(getTokenSupply).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst of concurrent misses into ONE rpc call', async () => {
    const getTokenSupply = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { amount: 10n, decimals: 6 };
    });
    const cache = new TokenMetaCache({ getTokenSupply, getAssetMeta: async () => null }, stubRepo(), log);

    // Ten buys land in the same instant, as they do on a hot token.
    await Promise.all(Array.from({ length: 10 }, () => cache.get(RICE)));
    expect(getTokenSupply).toHaveBeenCalledTimes(1);
  });

  it('serves a STALE persisted value when the rpc dies, rather than dropping the buy', async () => {
    let now = 0;
    const repo = stubRepo();
    let fail = false;
    const rpc: SolanaRpc = {
      getTokenSupply: async () => {
        if (fail) throw new Error('rpc down');
        return { amount: 500n, decimals: 6 };
      },
      getAssetMeta: async () => null,
    };
    const cache = new TokenMetaCache(rpc, repo, log, 60_000, () => now);

    await cache.get(RICE); // warm + persist
    now = 10 * 60_000; // way past TTL
    fail = true;

    const meta = await cache.get(RICE);
    expect(meta?.supplyRaw).toBe(500n); // stale, but a stale supply beats no post
  });

  it('returns null when the rpc dies and nothing was ever persisted', async () => {
    const rpc: SolanaRpc = {
      getTokenSupply: async () => {
        throw new Error('rpc down');
      },
      getAssetMeta: async () => null,
    };
    expect(await new TokenMetaCache(rpc, stubRepo(), log).get(RICE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: a real historical buy reproduces the right USD and market cap
// ---------------------------------------------------------------------------

describe('integration: real buy reproduces correct USD and market cap (within 1%)', () => {
  /**
   * All three inputs are pinned from independent, real sources:
   *
   *   SOL/USD  $76.66   Binance.US SOLUSDT 1m kline at the fixture's blockTime
   *                     (1783898774), fetched from their public REST API.
   *   supply   982,048,494.777792  getTokenSupply on mainnet. NOTE: not 1B.
   *   the buy  test/fixtures/buy-pumpswap.json — a real PumpSwap RICE buy.
   *
   * The expected outputs were computed independently with Python's Decimal
   * (exact rational arithmetic, no float), NOT by running this code:
   *
   *   usdIn        $2.921549
   *   priceUsd     $0.000106996172
   *   marketCapUsd $105,075.43
   */
  const PINNED_SOL_USD = 76.66;
  const RICE_SUPPLY_RAW = 982_048_494_777_792n;
  const RICE_DECIMALS = 6;

  const EXPECT_USD_IN = 2.921549;
  const EXPECT_PRICE_USD = 0.000106996172;
  const EXPECT_MARKET_CAP = 105_075.43;

  const fx = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'buy-pumpswap.json'), 'utf8'),
  ) as { mint: string; tx: Parameters<typeof normalizeSwap>[0] };

  const within1pct = (actual: number, expected: number): void => {
    expect(Math.abs(actual - expected) / expected).toBeLessThan(0.01);
  };

  it('prices the fixture end-to-end from the raw transaction', () => {
    // Start from the RAW TRANSACTION, not a hand-made event: this exercises the
    // whole chain, normalizer included.
    const { event } = normalizeSwap(fx.tx, fx.mint);
    expect(event?.kind).toBe('buy');
    const buy = event as BuyEvent;

    const pricing = derivePricing(
      {
        quoteRaw: buy.quoteRaw,
        quote: SOL_QUOTE,
        mint: buy.mint,
        tokensRaw: buy.tokensRaw,
        decimals: RICE_DECIMALS,
        supplyRaw: RICE_SUPPLY_RAW,
        balanceBeforeRaw: buy.balanceBeforeRaw,
        balanceAfterRaw: buy.balanceAfterRaw,
      },
      { solUsd: PINNED_SOL_USD, stableUsd: 1 },
    );

    expect(pricing).not.toBeNull();
    within1pct(pricing!.usdIn, EXPECT_USD_IN);
    within1pct(pricing!.priceUsd, EXPECT_PRICE_USD);
    within1pct(pricing!.marketCapUsd, EXPECT_MARKET_CAP);
  });

  it('values holdings at the SAME trade-implied price as the buy', () => {
    const buy = normalizeSwap(fx.tx, fx.mint).event as BuyEvent;
    const pricing = derivePricing(
      {
        quoteRaw: buy.quoteRaw,
        quote: SOL_QUOTE,
        mint: buy.mint,
        tokensRaw: buy.tokensRaw,
        decimals: RICE_DECIMALS,
        supplyRaw: RICE_SUPPLY_RAW,
        balanceBeforeRaw: buy.balanceBeforeRaw,
        balanceAfterRaw: buy.balanceAfterRaw,
      },
      { solUsd: PINNED_SOL_USD, stableUsd: 1 },
    );

    // This buyer is a NEW holder: balanceAfter === tokens bought. So holdings must
    // equal usdIn exactly. If they ever diverge, a second price source has crept
    // in — which is precisely what makes a whale call look fabricated.
    expect(pricing!.holdingsUsd).toBeCloseTo(pricing!.usdIn, 9);
    within1pct(pricing!.holdingsUsd, EXPECT_USD_IN);
  });

  it('values a huge pre-existing stack from the chain, not the ledger', () => {
    // Synthetic: the fixture this used turned out to be a SELL. The property is that holdingsUsd
    // is derived from balanceBeforeRaw/AfterRaw (the CHAIN) — a tiny buy against an enormous bag.
    const pricing = derivePricing(
      {
        quoteRaw: 999_387n, // ~$0.077 at the pinned SOL price
        quote: SOL_QUOTE,
        mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Parameters<typeof derivePricing>[0]['mint'],
        tokensRaw: 1_941_584_805n,
        decimals: 5, // BONK
        supplyRaw: 88_000_000_000_000_000n,
        balanceBeforeRaw: 5_563_107_076_764_830n,
        balanceAfterRaw: 5_565_048_661_569_635n,
      },
      { solUsd: PINNED_SOL_USD, stableUsd: 1 },
    );

    expect(pricing!.usdIn).toBeLessThan(1); // the buy is cents
    expect(pricing!.holdingsUsd).toBeGreaterThan(100_000); // the bag, from the chain, is enormous
  });
});

// ---------------------------------------------------------------------------
// THE RULE: the SOL guard applies ONLY to SOL-quoted buys
// ---------------------------------------------------------------------------

describe('Pricer — SOL staleness guard is scoped to SOL-quoted buys', () => {
  const fakeFeed = (solUsd: number | null): SolUsdFeed =>
    ({ solUsd: () => solUsd, ageMs: () => null }) as unknown as SolUsdFeed;

  const cache = (): TokenMetaCache =>
    new TokenMetaCache(
      { getTokenSupply: async () => ({ amount: 1_000_000_000_000_000n, decimals: 6 }), getAssetMeta: async () => null },
      stubRepo(),
      log,
    );

  it('HOLDS a SOL-quoted buy when the feed is down', async () => {
    const pricer = new Pricer({ feed: fakeFeed(null), tokens: cache(), log });

    const out = await pricer.price(mkBuy('sol-buy', { mint: RICE }));
    expect(out.status).toBe('held');
    expect(pricer.heldCount).toBe(1);
  });

  it('POSTS a USDC-quoted buy while the SOL feed is down — the whole point', async () => {
    const pricer = new Pricer({ feed: fakeFeed(null), tokens: cache(), log });

    // Quote in USDC (6dp): 100 USDC. Needs no SOL price at all.
    const usdcBuy = mkBuy('usdc-buy', {
      mint: RICE,
      quoteMint: USDC_MINT,
      quoteSymbol: 'USDC',
      quoteRaw: 100_000_000n, // 100 USDC at 6dp
    });

    const out = await pricer.price(usdcBuy);

    expect(out.status).toBe('priced'); // NOT held
    expect(pricer.heldCount).toBe(0);
    if (out.status !== 'priced') throw new Error('unreachable');
    expect(out.pricing.usdIn).toBeCloseTo(100, 6);
    expect(out.pricing.quoteSymbol).toBe('USDC');
  });

  it('honours a configurable stable price (a depeg is not ours to hide)', async () => {
    const pricer = new Pricer({ feed: fakeFeed(null), tokens: cache(), log, stableUsd: 0.97 });
    const usdcBuy = mkBuy('depeg', {
      mint: RICE,
      quoteMint: USDC_MINT,
      quoteSymbol: 'USDC',
      quoteRaw: 100_000_000n,
    });

    const out = await pricer.price(usdcBuy);
    if (out.status !== 'priced') throw new Error('expected priced');
    expect(out.pricing.usdIn).toBeCloseTo(97, 6);
  });

  it('flushes held buys once the feed recovers', async () => {
    let sol: number | null = null;
    const feed = { solUsd: () => sol, ageMs: () => null } as unknown as SolUsdFeed;
    const pricer = new Pricer({ feed, tokens: cache(), log });

    await pricer.price(mkBuy('a', { mint: RICE }));
    await pricer.price(mkBuy('b', { mint: RICE }));
    expect(pricer.heldCount).toBe(2);

    // Nothing flushes while it is still down.
    expect(await pricer.flushHeld(async () => undefined)).toBe(0);

    sol = 76.66;
    const flushed: string[] = [];
    const n = await pricer.flushHeld(async (e, outcome) => {
      expect(outcome.status).toBe('priced');
      flushed.push(e.signature);
    });

    expect(n).toBe(2);
    expect(flushed).toEqual(['a', 'b']);
    expect(pricer.heldCount).toBe(0);
  });

  /**
   * END TO END on the real USDC fixture: raw mainnet transaction -> normalizer ->
   * Pricer -> dollars, with the SOL feed DOWN the entire time.
   *
   * This is the buy the old SOL-only rule ate. It must now post, and it must post
   * without SOL being priceable at all.
   */
  it('prices the real USDC fixture end-to-end while the SOL feed is DOWN', async () => {
    const fx = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'buy-usdc-quoted.json'), 'utf8'),
    ) as { mint: string; tx: Parameters<typeof normalizeSwap>[0] };

    const { event } = normalizeSwap(fx.tx, fx.mint);
    const buy = event as BuyEvent;
    expect(buy.quoteSymbol).toBe('USDC');

    // Target token: 6 decimals, 1B supply (stubbed via the cache below).
    const pricer = new Pricer({ feed: fakeFeed(null), tokens: cache(), log });
    const out = await pricer.price(buy);

    expect(out.status).toBe('priced'); // NOT held, despite solUsd() === null
    if (out.status !== 'priced') throw new Error('unreachable');

    // 20.000000 USDC at $1.00.
    expect(out.pricing.usdIn).toBeCloseTo(20, 6);

    // priceUsd = 20 / (29200568 / 1e6) = $0.000684918…
    expect(out.pricing.priceUsd).toBeCloseTo(20 / (29_200_568 / 1e6), 9);
    expect(pricer.heldCount).toBe(0);
  });

  it('does not price a buy of zero tokens (would divide by zero)', () => {
    const out = derivePricing(
      {
        quoteRaw: 1_000n,
        quote: QUOTE_ASSETS[SOL_QUOTE.mint]!,
        mint: RICE,
        tokensRaw: 0n,
        decimals: 6,
        supplyRaw: 1n,
        balanceBeforeRaw: 0n,
        balanceAfterRaw: 0n,
      },
      { solUsd: 76.66, stableUsd: 1 },
    );
    expect(out).toBeNull();
  });
});
