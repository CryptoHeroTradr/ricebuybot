import type { BuyEvent, SellEvent, SwapEvent, TokenMeta } from '../core/types.js';
import type { Repo } from '../db/index.js';
import type { Logger } from '../ops/logger.js';
import type { PriceOutcome, Pricing } from '../pricing/index.js';
import { usd } from '../render/format.js';
import { positionLine } from '../render/position.js';
import { avgCostUsd } from './basis.js';
import type { Backfiller } from './backfill.js';

/**
 * ONE application path for a priced swap, whatever route it arrived by.
 *
 * A swap reaches us two ways: straight off the ingestor, or out of the hold queue
 * after the SOL feed came back. Those are two ARRIVAL paths, not two kinds of
 * event, and they must fold into the ledger identically — the same way the WS and
 * webhook ingestors both funnel into one `normalizeSwap()`.
 *
 * They did not. The flush callback used to dispatch only `kind === 'buy'`, so a
 * SOL-quoted SELL held during a feed outage was flushed straight into the bin: it
 * never reached `applySell`, and the ledger kept tokens the wallet no longer held
 * and cost it had already retired. Reconciliation caught it on the wallet's next
 * buy (drift != 0 -> reconciled = 0 -> no Position line), so it never became a
 * public lie — but the wallet's Position % then stayed dark until a backfill, and
 * its realized PnL was silently wrong in the meantime.
 *
 * Routing both arrival paths through this one function is what stops that class of
 * bug recurring: there is no second place to forget a case.
 */
export interface SwapApplierDeps {
  readonly repo: Repo;
  readonly log: Logger;
  readonly backfiller: Backfiller;
  /** cfg.BACKFILL_POSITIONS */
  readonly backfill: boolean;
}

export interface SwapApplier {
  onSwap(event: SwapEvent, outcome: PriceOutcome): Promise<void>;
}

export function makeSwapApplier(deps: SwapApplierDeps): SwapApplier {
  const { repo, log, backfiller, backfill } = deps;

  async function onBuy(e: BuyEvent, p: Pricing, token: TokenMeta): Promise<void> {
    await repo.recordBuy({
      signature: e.signature,
      mint: e.mint,
      buyer: e.buyer,
      quoteMint: e.quoteMint,
      quoteSymbol: e.quoteSymbol,
      quoteRaw: e.quoteRaw,
      tokensRaw: e.tokensRaw,
      usdIn: p.usdIn,
      priceUsd: p.priceUsd,
      slot: e.slot,
      blockTime: e.blockTime,
    });

    // Did the ledger know this wallet BEFORE this buy? Read it first — after
    // applyBuy the row always exists and the question is unanswerable.
    const prior = await repo.getPosition(e.mint, e.buyer);

    // EVERY BUY IS A RECONCILIATION CHECKPOINT. balanceAfterRaw is exact and free.
    //
    // This appends to the swap log and refolds the position (Phase 4.5). It does not
    // mutate a row, so a backfill walking this same wallet right now cannot clobber
    // it — its fold will simply include the row we are about to write.
    const pos = await repo.applyBuy(
      {
        signature: e.signature,
        mint: e.mint,
        buyer: e.buyer,
        quoteMint: e.quoteMint,
        quoteSymbol: e.quoteSymbol,
        quoteRaw: e.quoteRaw,
        tokensRaw: e.tokensRaw,
        usdIn: p.usdIn,
        priceUsd: p.priceUsd,
        slot: e.slot,
        blockTime: e.blockTime,
      },
      { balanceAfterRaw: e.balanceAfterRaw },
      token.decimals,
    );

    const line = positionLine({
      reconciled: pos.reconciled,
      tokensRaw: pos.tokensRaw,
      balanceBeforeRaw: e.balanceBeforeRaw,
      avgCostUsd: avgCostUsd(pos, token.decimals),
      priceUsd: p.priceUsd,
      hasPriorHistory: prior !== null,
    });

    log.info(
      {
        signature: e.signature,
        symbol: token.symbol,
        buyer: e.buyer,
        spent: usd(p.usdIn),
        marketCap: usd(p.marketCapUsd),
        // ALWAYS renders: it comes from the chain and is always exact.
        holdings: usd(p.holdingsUsd),
        // Renders ONLY from a reconciled ledger. null => we say nothing.
        position: line.text,
        reconciled: pos.reconciled,
        driftRaw: pos.driftRaw.toString(),
        quote: p.quoteSymbol,
      },
      'BUY',
    );

    // Backfill NEVER blocks a send: fire and forget, deliberately not awaited.
    // If it has not finished when the card renders, the card posts without the
    // Position line and moves on. The message is NOT edited afterwards.
    if (backfill && !pos.reconciled) {
      void backfiller.enqueue(e.mint, e.buyer, token.decimals).catch((err: unknown) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'backfill failed');
      });
    }
  }

  /** Sells feed cost basis ONLY. They are NEVER posted to Telegram. */
  async function onSell(e: SellEvent, p: Pricing, token: TokenMeta): Promise<void> {
    // A sell is a reconciliation checkpoint too: balanceAfterRaw is just as exact
    // here as it is on a buy, and a wallet that sells tells us as much about what
    // it holds as one that buys.
    const pos = await repo.applySell(
      {
        signature: e.signature,
        mint: e.mint,
        seller: e.seller,
        quoteMint: e.quoteMint,
        quoteSymbol: e.quoteSymbol,
        quoteRaw: e.quoteRaw,
        tokensRaw: e.tokensRaw,
        usdOut: p.usdIn, // for a sell, the quote leg is what they RECEIVED
        slot: e.slot,
        blockTime: e.blockTime,
      },
      token.decimals,
      { balanceAfterRaw: e.balanceAfterRaw },
    );

    log.debug(
      {
        signature: e.signature,
        seller: e.seller,
        usdOut: usd(p.usdIn),
        quote: p.quoteSymbol,
        reconciled: pos.reconciled,
        driftRaw: pos.driftRaw.toString(),
      },
      'sell applied to basis',
    );
  }

  return {
    async onSwap(event: SwapEvent, outcome: PriceOutcome): Promise<void> {
      if (outcome.status !== 'priced') {
        log.debug(
          { signature: event.signature, kind: event.kind, status: outcome.status, reason: outcome.reason },
          'swap not applied',
        );
        return;
      }

      if (event.kind === 'buy') await onBuy(event, outcome.pricing, outcome.token);
      else await onSell(event, outcome.pricing, outcome.token);
    },
  };
}
