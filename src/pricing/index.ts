import type { BuyEvent, SwapEvent, TokenMeta } from '../core/types.js';
import type { Logger } from '../ops/logger.js';
import { derivePricing, type Pricing, type WhaleBasis } from './derive.js';
import { HoldQueue } from './hold-queue.js';
import { SOL_QUOTE, quoteAssetFor, type QuoteAsset } from './quote.js';
import type { SolUsdFeed } from './sol-usd.js';
import type { TokenMetaCache } from './token-meta.js';

export * from './quote.js';
export * from './derive.js';
export * from './price-book.js';
export * from './hold-queue.js';
export * from './token-meta.js';
export { SolUsdFeed } from './sol-usd.js';

/** Legacy Phase 0 seam. Kept so callers can depend on the narrow thing. */
export interface PriceSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  solUsd(): number | null;
  ageMs(): number | null;
}

export type PriceOutcome =
  | { readonly status: 'priced'; readonly pricing: Pricing; readonly token: TokenMeta }
  | { readonly status: 'held'; readonly reason: 'sol-feed-stale' }
  | { readonly status: 'dropped'; readonly reason: 'no-token-metadata' | 'unknown-quote' | 'unpriceable' };

export interface PricerDeps {
  readonly feed: SolUsdFeed;
  readonly tokens: TokenMetaCache;
  readonly log: Logger;
  /** What a stablecoin is worth. Configurable; a depeg is not ours to paper over. */
  readonly stableUsd?: number;
  readonly whaleBasis?: WhaleBasis;
}

/**
 * Turns a BuyEvent into dollars.
 *
 * THE RULE THAT MATTERS: the SOL staleness guard applies ONLY to SOL-quoted buys.
 * A USDC-quoted buy does not need SOL to be priced, and must post even while the
 * SOL feed is face-down. One dead websocket must not hold back buys it has no
 * bearing on.
 */
export class Pricer {
  readonly #feed: SolUsdFeed;
  readonly #tokens: TokenMetaCache;
  readonly #log: Logger;
  readonly #stableUsd: number;
  readonly #whaleBasis: WhaleBasis;
  readonly #held: HoldQueue;

  constructor(deps: PricerDeps) {
    this.#feed = deps.feed;
    this.#tokens = deps.tokens;
    this.#log = deps.log;
    this.#stableUsd = deps.stableUsd ?? 1.0;
    this.#whaleBasis = deps.whaleBasis ?? 'post';
    this.#held = new HoldQueue(deps.log);
  }

  get heldCount(): number {
    return this.#held.size;
  }

  /**
   * The quote asset the normalizer resolved.
   *
   * Since Phase 2.5 the normalizer resolves the dominant quote leg from the
   * registry and stamps it on the event, so we simply look it up.
   */
  #quoteOf(event: SwapEvent): QuoteAsset | null {
    return quoteAssetFor(event.quoteMint);
  }

  async price(event: SwapEvent): Promise<PriceOutcome> {
    const quote = this.#quoteOf(event);
    if (!quote) {
      this.#log.debug({ signature: event.signature }, 'unknown quote asset; dropping');
      return { status: 'dropped', reason: 'unknown-quote' };
    }

    // The guard is scoped to the asset that actually needs the feed.
    const solUsd = this.#feed.solUsd();
    if (quote.kind === 'sol' && solUsd === null) {
      this.#held.hold(event);
      return { status: 'held', reason: 'sol-feed-stale' };
    }

    const token = await this.#tokens.get(event.mint);
    if (!token) return { status: 'dropped', reason: 'no-token-metadata' };

    const pricing = derivePricing(
      {
        quoteRaw: event.quoteRaw,
        quote,
        mint: event.mint,
        tokensRaw: event.tokensRaw,
        decimals: token.decimals,
        supplyRaw: token.supplyRaw,
        balanceBeforeRaw: event.balanceBeforeRaw,
        balanceAfterRaw: event.balanceAfterRaw,
      },
      { solUsd, stableUsd: this.#stableUsd },
      this.#whaleBasis,
    );

    if (!pricing) return { status: 'dropped', reason: 'unpriceable' };
    return { status: 'priced', pricing, token };
  }

  /**
   * Re-price everything that was held while the feed was down.
   *
   * Called when the feed recovers. Buys that STILL cannot be priced are not
   * re-queued — that would loop forever — they are dropped by `price()` returning
   * held again, so we guard by only flushing when the feed is actually back.
   */
  async flushHeld(onPriced: (event: SwapEvent, outcome: PriceOutcome, heldMs: number) => Promise<void>): Promise<number> {
    if (this.#feed.solUsd() === null) return 0; // still down; leave them queued

    const pending: Array<{ event: SwapEvent; heldMs: number }> = [];
    const n = this.#held.flush((event, heldMs) => pending.push({ event, heldMs }));

    for (const { event, heldMs } of pending) {
      const outcome = await this.price(event);
      await onPriced(event, outcome, heldMs);
    }
    return n;
  }
}
