import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EMPTY_BASIS,
  applyBuy,
  applySell,
  applyTransferIn,
  applyTransferOut,
  avgCostUsd,
  toWhole,
  type BasisState,
} from '../src/positions/basis.js';
import { DUST_TOLERANCE_RAW, reconcile } from '../src/positions/reconcile.js';
import { Backfiller, WALLET_CACHE_MS, type HistorySource } from '../src/positions/backfill.js';
import { StaticHistoricalSolUsd } from '../src/positions/history-price.js';
import { makeSwapApplier } from '../src/positions/apply.js';
import { positionLine } from '../src/render/position.js';
import { normalizeSwap } from '../src/ingest/normalize.js';
import { Pricer } from '../src/pricing/index.js';
import { TokenMetaCache } from '../src/pricing/token-meta.js';
import type { SolUsdFeed } from '../src/pricing/sol-usd.js';
import { USDC_MINT } from '../src/core/quotes.js';
import { SqliteRepo } from '../src/db/sqlite.js';
import { createLogger } from '../src/ops/logger.js';
import type { BuyEvent, SellEvent } from '../src/core/types.js';
import type { ConfirmedTx } from '../src/ingest/solana-types.js';

const log = createLogger('silent' as 'info', false);

let dir: string;
let repo: SqliteRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rbb-pos-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
});

afterEach(async () => {
  await repo.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8')) as {
    mint: string;
    tx: ConfirmedTx;
  };

const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
const WALLET = 'WaLLeTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOL = 'So11111111111111111111111111111111111111112';

const buyRec = (over: Partial<Parameters<SqliteRepo['recordBuy']>[0]> = {}) => ({
  signature: `sig-${Math.random()}`,
  mint: MINT,
  buyer: WALLET,
  quoteMint: SOL,
  quoteSymbol: 'SOL',
  quoteRaw: 1_000_000_000n,
  tokensRaw: 1_000_000n,
  usdIn: 100,
  priceUsd: 1,
  slot: 1,
  blockTime: 1_700_000_000,
  ...over,
});

// ---------------------------------------------------------------------------
// PROPERTY TEST
// ---------------------------------------------------------------------------

describe('basis engine — property: random buy/sell sequences', () => {
  /** Deterministic PRNG, so a failure is reproducible from the seed. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1_664_525 + 1_013_904_223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  it('tokens_raw always equals the summed deltas, and cost_usd never goes negative', () => {
    const DECIMALS = 6;

    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      let state: BasisState = EMPTY_BASIS;
      let expectedTokens = 0n;

      for (let step = 0; step < 40; step++) {
        const isBuy = rand() < 0.55;

        if (isBuy) {
          const tokensRaw = BigInt(1 + Math.floor(rand() * 10_000_000));
          const usdIn = rand() * 500;

          state = applyBuy(state, { tokensRaw, usdIn });
          expectedTokens += tokensRaw;
        } else {
          // Deliberately allow oversized sells — the bot is routinely added
          // mid-life and sees sells of tokens it never saw bought.
          const soldRaw = BigInt(1 + Math.floor(rand() * 12_000_000));
          const usdOut = rand() * 500;

          state = applySell(state, { soldRaw, usdOut, decimals: DECIMALS });
          expectedTokens = expectedTokens - soldRaw;
          if (expectedTokens < 0n) expectedTokens = 0n; // the documented floor
        }

        // The invariants, checked at EVERY step, not just at the end.
        expect(state.tokensRaw).toBe(expectedTokens);
        expect(state.tokensRaw >= 0n).toBe(true);
        expect(state.costUsd).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(state.costUsd)).toBe(true);
        expect(Number.isFinite(state.realizedPnlUsd)).toBe(true);
      }
    }
  });

  it('a sell leaves the average basis of the remaining tokens unchanged', () => {
    let s = applyBuy(EMPTY_BASIS, { tokensRaw: 100_000_000n, usdIn: 100 }); // $1/token
    expect(avgCostUsd(s, 6)).toBeCloseTo(1, 9);

    s = applySell(s, { soldRaw: 40_000_000n, usdOut: 80, decimals: 6 }); // sold 40 @ $2
    expect(s.tokensRaw).toBe(60_000_000n);
    expect(avgCostUsd(s, 6)).toBeCloseTo(1, 9); // basis unmoved
    expect(s.realizedPnlUsd).toBeCloseTo(40, 6); // (2 - 1) * 40
  });

  it('converts raw units without float drift', () => {
    expect(toWhole(1_000_000n, 6)).toBe(1);
    expect(toWhole(5_565_048_661_569_635n, 5)).toBeCloseTo(55_650_486_615.69635, 4);
  });
});

// ---------------------------------------------------------------------------
// RECONCILIATION — the important one
// ---------------------------------------------------------------------------

describe('reconciliation', () => {
  it('flags drift when the chain holds more than the ledger knows', () => {
    const r = reconcile(/* ledger */ 200_000n, /* chain */ 10_200_000n);
    expect(r.driftRaw).toBe(10_000_000n);
    expect(r.reconciled).toBe(false);
  });

  it('flags drift when the ledger holds more than the chain (tokens sent out)', () => {
    const r = reconcile(10_000_000n, 4_000_000n);
    expect(r.driftRaw).toBe(-6_000_000n);
    expect(r.reconciled).toBe(false);
  });

  it('tolerates exactly one raw unit of dust, and no more', () => {
    expect(reconcile(1_000_000n, 1_000_001n).reconciled).toBe(true);
    expect(reconcile(1_000_000n, 999_999n).reconciled).toBe(true);
    expect(reconcile(1_000_000n, 1_000_002n).reconciled).toBe(false);
    expect(DUST_TOLERANCE_RAW).toBe(1n);
  });

  it('a dust tolerance is NOT a percentage — a whale off by 1% is not reconciled', () => {
    // 1% of an enormous bag is an enormous number of tokens. This is exactly the
    // wallet whose Position % must never be guessed at.
    const ledger = 5_565_048_661_569_635n;
    const chain = (ledger * 101n) / 100n;
    expect(reconcile(ledger, chain).reconciled).toBe(false);
  });

  /**
   * THE BONK WHALE, from the Phase 2 fixtures.
   *
   * This wallet's first buy the bot ever sees is tiny (~$0.08), but the chain says
   * they were already sitting on 5.565e15 raw BONK. The ledger's cost basis is made
   * entirely of that one small buy.
   *
   * Naively, "Position" would compute against a basis that describes 0.03% of what
   * they actually hold. That is the confident public lie.
   */
  it('the whale with a huge pre-existing bag: unreconciled, and NO Position % is rendered', async () => {
    // Synthetic on purpose: the fixture this once used turned out to be a SELL (see
    // normalize.test.ts). The property under test is the MATH — a tiny buy against an enormous
    // on-chain bag the ledger never saw — and that needs numbers we control, not a captured tx.
    const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Mint;
    const buyer = 'WhaleWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Wallet;
    const tokensRaw = 1_941_584_805n; // this buy
    const balanceAfterRaw = 5_565_048_661_569_635n; // the whole bag, from the chain

    const pos = await repo.applyBuy(
      buyRec({ mint: MINT, buyer, tokensRaw, usdIn: 0.077 }),
      { balanceAfterRaw },
    );

    expect(pos.tokensRaw).toBe(tokensRaw);
    expect(pos.onchainRaw).toBe(balanceAfterRaw);
    expect(pos.driftRaw).toBe(balanceAfterRaw - tokensRaw);
    expect(pos.driftRaw).toBeGreaterThan(0n);
    expect(pos.reconciled).toBe(false);

    // THE ASSERTION THAT MATTERS: no percentage is rendered.
    const line = positionLine({
      reconciled: pos.reconciled,
      tokensRaw: pos.tokensRaw,
      balanceBeforeRaw: balanceAfterRaw - tokensRaw, // held a bag before this buy
      avgCostUsd: avgCostUsd(pos, 5),
      priceUsd: 0.0000000396,
      hasPriorHistory: false,
    });

    expect(line.kind).toBe('omitted');
    expect(line.text).toBeNull();

    // Had we rendered it anyway, THIS is the lie we would have published: a
    // percentage computed against a basis describing a tiny sliver of the bag.
    const naive = positionLine({
      reconciled: true, // pretend
      tokensRaw: pos.tokensRaw,
      balanceBeforeRaw: 1n,
      avgCostUsd: avgCostUsd(pos, 5),
      priceUsd: 0.0000000396,
      hasPriorHistory: true,
    });
    expect(naive.kind).toBe('position'); // it WOULD have produced a confident number
  });

  it('holdingsUsd is exact from the chain even on an unreconciled wallet', async () => {
    // holdingsUsd comes from balanceAfterRaw — the chain — so it is exact whether or not the
    // ledger is reconciled. (Note: since the whale TIER moved to SOL+USDC wallet value, this
    // figure no longer drives the tier; the test still guards the derivePricing math.)
    const { derivePricing } = await import('../src/pricing/derive.js');
    const { SOL_QUOTE } = await import('../src/pricing/quote.js');

    const pricing = derivePricing(
      {
        quoteRaw: 999_387n, // a pennies buy
        quote: SOL_QUOTE,
        mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Mint,
        tokensRaw: 1_941_584_805n,
        decimals: 5,
        supplyRaw: 88_000_000_000_000_000n,
        balanceBeforeRaw: 5_563_107_076_764_830n,
        balanceAfterRaw: 5_565_048_661_569_635n, // an enormous bag
      },
      { solUsd: 76.66, stableUsd: 1 },
    );

    expect(pricing!.usdIn).toBeLessThan(1); // the buy itself is pennies
    expect(pricing!.holdingsUsd).toBeGreaterThan(200); // …but the bag is huge
  });
});

// ---------------------------------------------------------------------------
// RENDER RULE
// ---------------------------------------------------------------------------

describe('render rule — never a % from an unreconciled ledger', () => {
  const base = {
    reconciled: true,
    tokensRaw: 100_000_000n,
    balanceBeforeRaw: 50_000_000n,
    avgCostUsd: 1,
    priceUsd: 2.28,
    hasPriorHistory: true,
  };

  it('renders a Position % only when reconciled', () => {
    const ok = positionLine(base);
    expect(ok.kind).toBe('position');
    expect(ok.text).toBe('Position +128%');

    const bad = positionLine({ ...base, reconciled: false });
    expect(bad.kind).toBe('omitted');
    expect(bad.text).toBeNull();
  });

  it('says "New Holder" on first sight (chain says they held nothing)', () => {
    const line = positionLine({ ...base, balanceBeforeRaw: 0n, hasPriorHistory: false });
    expect(line.kind).toBe('new-holder');
    expect(line.text).toBe('🆕 New Holder');
  });

  it('says "Returning" when a known wallet re-enters from zero', () => {
    const line = positionLine({ ...base, balanceBeforeRaw: 0n, hasPriorHistory: true });
    expect(line.kind).toBe('returning');
    expect(line.text).toBe('🔁 Returning');
  });

  /**
   * PHASE 4.7. A RECONCILED zero basis means every token really did arrive free — and
   * a free bag really is 100% profit, so we say so.
   *
   * This is only safe because `basis_unpriced` keeps arbs out of here. An arb has a
   * zero basis too, but its zero is a hole in our knowledge rather than a fact about
   * the world, and it never reconciles — so it never reaches this line.
   *
   * Not rendered as a percentage: a return against a zero basis is infinite, and
   * "+100%" would read as "doubled", which is a different and false claim.
   */
  it('calls a reconciled zero basis what it is: a free bag, and carries NO number', () => {
    const line = positionLine({ ...base, avgCostUsd: 0 });
    expect(line.kind).toBe('free');
    expect(line.text).toBe('🎁 Free bag — no cost basis');

    // PHASE 4.8. This line occupies the SAME SLOT as `Position +128%`, so any figure in
    // it is read on that scale — and a reader comparing "100%" against 128% concludes
    // the free bag did WORSE. It did infinitely better: a return against a zero basis
    // is UNDEFINED, not 100%. Two incommensurable quantities must never share a slot.
    expect(line.text).not.toContain('100%');
    expect(line.text).not.toMatch(/\d/); // no digits AT ALL
  });

  it('an UNPRICEABLE basis is never a free bag — it is silence', () => {
    // Same zero basis, but we could not value what they paid. `reconciled` is false
    // (basis_unpriced vetoed it), so the line must be omitted, NOT called free.
    expect(positionLine({ ...base, avgCostUsd: 0, reconciled: false }).kind).toBe('omitted');
  });

  it('shows a loss with the sign', () => {
    const line = positionLine({ ...base, priceUsd: 0.59 });
    expect(line.text).toBe('Position -41%');
  });
});

// ---------------------------------------------------------------------------
// BACKFILL
// ---------------------------------------------------------------------------

/** Builds a synthetic history: a big early buy, then the small buy the bot saw. */
function historyTx(opts: {
  sig: string;
  slot: number;
  blockTime: number;
  wallet: string;
  mint: string;
  tokenBefore: bigint;
  tokenAfter: bigint;
  solBefore: bigint;
  solAfter: bigint;
}): ConfirmedTx {
  return {
    slot: opts.slot,
    blockTime: opts.blockTime,
    transaction: {
      message: {
        accountKeys: [{ pubkey: opts.wallet, signer: true, writable: true }],
      },
      signatures: [opts.sig],
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [Number(opts.solBefore)],
      postBalances: [Number(opts.solAfter) - 5_000],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: opts.mint,
          owner: opts.wallet,
          uiTokenAmount: { amount: opts.tokenBefore.toString(), decimals: 6 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: opts.mint,
          owner: opts.wallet,
          uiTokenAmount: { amount: opts.tokenAfter.toString(), decimals: 6 },
        },
      ],
    },
  };
}

/**
 * Mimics the real chain: getSignaturesForAddress returns NEWEST FIRST.
 *
 * Sorted by slot rather than trusting the caller's array order — the Backfiller
 * reverses this list to replay oldest->newest, and a weighted average replayed in
 * the wrong order gives a different (wrong) answer. Getting this backwards is a
 * real bug, so the stub must not quietly paper over it.
 */
function stubHistory(txs: ConfirmedTx[]): HistorySource {
  const newestFirst = [...txs].sort((a, b) => b.slot - a.slot);
  return {
    signaturesFor: async () =>
      newestFirst.map((t) => ({ signature: t.transaction.signatures[0] as string, slot: t.slot })),
    getTransaction: async (sig) => txs.find((t) => t.transaction.signatures[0] === sig) ?? null,
  };
}

describe('backfill — its job is to REACH reconciled=1', () => {
  it('replays history, collapses drift to dust, and flips reconciled — then the % renders', async () => {
    const W = 'WhaleWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // The bag the bot never saw: 10,000,000 tokens bought long ago for 1 SOL.
    const old = historyTx({
      sig: 'old-big-buy',
      slot: 100,
      blockTime: 1_700_000_000,
      wallet: W,
      mint: MINT,
      tokenBefore: 0n,
      tokenAfter: 10_000_000_000_000n,
      solBefore: 5_000_000_000n,
      solAfter: 4_000_000_000n, // paid 1 SOL
    });

    // Today's small buy, which the bot DID see: +200,000 tokens for 0.1 SOL.
    const recent = historyTx({
      sig: 'todays-buy',
      slot: 200,
      blockTime: 1_783_000_000,
      wallet: W,
      mint: MINT,
      tokenBefore: 10_000_000_000_000n,
      tokenAfter: 10_000_200_000_000n,
      solBefore: 4_000_000_000n,
      solAfter: 3_900_000_000n, // paid 0.1 SOL
    });

    // Live: the bot observes only today's buy — and it observes it as the SAME
    // transaction the history walk will later hand back. That shared signature is
    // what the swap log's PK dedups on; a live row and a replayed row for one
    // transaction are one fact, not two.
    const pos0 = await repo.applyBuy(
      buyRec({ signature: 'todays-buy', slot: 200, buyer: W, tokensRaw: 200_000_000n, usdIn: 7.7 }),
      { balanceAfterRaw: 10_000_200_000_000n },
    );
    expect(pos0.reconciled).toBe(false);
    expect(pos0.driftRaw).toBe(10_000_000_000_000n);

    // …and the card would show NO position line.
    expect(
      positionLine({
        reconciled: pos0.reconciled,
        tokensRaw: pos0.tokensRaw,
        balanceBeforeRaw: 10_000_000_000_000n,
        avgCostUsd: avgCostUsd(pos0, 6),
        priceUsd: 0.0000385,
        hasPriorHistory: false,
      }).kind,
    ).toBe('omitted');

    // Now backfill.
    const backfiller = new Backfiller({
      repo,
      history: stubHistory([old, recent]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    });

    const out = await backfiller.enqueue(MINT, W, 6);
    expect(out.status).toBe('reconciled');

    const pos = (await repo.getPosition(MINT, W))!;

    // Drift collapsed, reconciled flipped.
    expect(pos.tokensRaw).toBe(10_000_200_000_000n);
    expect(pos.driftRaw).toBe(0n);
    expect(pos.reconciled).toBe(true);
    expect(pos.backfilled).toBe(true);

    // Basis now describes the WHOLE bag: 1.1 SOL @ $77 = $84.70 for 10,000,200 tokens.
    expect(pos.costUsd).toBeCloseTo(1.1 * 77, 4);

    // And NOW the percentage may render.
    const line = positionLine({
      reconciled: pos.reconciled,
      tokensRaw: pos.tokensRaw,
      balanceBeforeRaw: 10_000_000_000_000n,
      avgCostUsd: avgCostUsd(pos, 6),
      priceUsd: avgCostUsd(pos, 6) * 2, // doubled since
      hasPriorHistory: true,
    });
    expect(line.kind).toBe('position');
    expect(line.text).toBe('Position +100%');
  });

  it('an AIRDROPPED wallet reconciles to zero cost, not to phantom profit', async () => {
    const W = 'AirdropWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // Tokens arrive with NO quote leg paid. They were free.
    const airdrop = historyTx({
      sig: 'the-airdrop',
      slot: 50,
      blockTime: 1_700_000_000,
      wallet: W,
      mint: MINT,
      tokenBefore: 0n,
      tokenAfter: 5_000_000_000n,
      solBefore: 1_000_000_000n,
      solAfter: 1_000_000_000n, // unchanged: nothing was paid
    });

    const ev = classify(airdrop, MINT, W);
    expect(ev?.kind).toBe('transfer');
    expect((ev as Extract<typeof ev, { kind: 'transfer' }>).direction).toBe('in');

    const backfiller = new Backfiller({
      repo,
      history: stubHistory([airdrop]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    });

    // Seed the live sighting so there is an on-chain reading to reconcile against.
    await repo.applyBuy(buyRec({ buyer: W, tokensRaw: 0n, usdIn: 0 }), {
      balanceAfterRaw: 5_000_000_000n,
    });

    const out = await backfiller.enqueue(MINT, W, 6);
    expect(out.status).toBe('reconciled');

    const pos = (await repo.getPosition(MINT, W))!;
    expect(pos.tokensRaw).toBe(5_000_000_000n);
    expect(pos.reconciled).toBe(true);

    // The tokens were FREE. Cost basis is zero — not a phantom "bought at $0.00001".
    expect(pos.costUsd).toBe(0);
    expect(avgCostUsd(pos, 6)).toBe(0);

    // PHASE 4.7: and that zero is the TRUTH, not a gap in our knowledge. Nothing was
    // paid — there is no counter-leg anywhere in the transaction — so the basis is
    // priceable and the wallet reconciles.
    expect(pos.basisUnpriced).toBe(false);
    expect(pos.reconciled).toBe(true);

    // So we can say what is actually the case: the whole bag is profit.
    const line = positionLine({
      reconciled: pos.reconciled,
      tokensRaw: pos.tokensRaw,
      balanceBeforeRaw: 5_000_000_000n,
      avgCostUsd: avgCostUsd(pos, 6),
      priceUsd: 0.001,
      hasPriorHistory: true,
    });
    expect(line.kind).toBe('free');
    expect(line.text).toBe('🎁 Free bag — no cost basis');
    expect(line.text).not.toContain('100%'); // never a number in the Position slot
  });

  it('a transfer OUT is a quantity-only reduction — no realized PnL', () => {
    let s = applyBuy(EMPTY_BASIS, { tokensRaw: 100_000_000n, usdIn: 100 });
    s = applyTransferOut(s, 40_000_000n, 6);

    expect(s.tokensRaw).toBe(60_000_000n);
    expect(s.costUsd).toBeCloseTo(60, 6); // cost retired at the average
    expect(s.realizedPnlUsd).toBe(0); // nothing was SOLD, so nothing was made
    expect(avgCostUsd(s, 6)).toBeCloseTo(1, 9); // basis unchanged
  });

  it('a transfer IN drags the average cost DOWN (free tokens are free)', () => {
    let s = applyBuy(EMPTY_BASIS, { tokensRaw: 100_000_000n, usdIn: 100 }); // $1.00/token
    s = applyTransferIn(s, 100_000_000n); // 100 free tokens

    expect(s.tokensRaw).toBe(200_000_000n);
    expect(s.costUsd).toBeCloseTo(100, 6); // unchanged — they cost nothing
    expect(avgCostUsd(s, 6)).toBeCloseTo(0.5, 9); // halved
  });

  it('does NOT claim reconciliation when the signature cap was hit', async () => {
    const W = 'CappedWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // A history source that reports the hard cap — i.e. we KNOW we did not see it all.
    const capped: HistorySource = {
      signaturesFor: async (_w, limit) =>
        Array.from({ length: limit }, (_, i) => ({ signature: `s${i}`, slot: i })),
      getTransaction: async () => null, // nothing replayable
    };

    await repo.applyBuy(buyRec({ buyer: W, tokensRaw: 100n, usdIn: 1 }), {
      balanceAfterRaw: 100n, // drift would otherwise be ZERO -> "reconciled"
    });

    const backfiller = new Backfiller({
      repo,
      history: capped,
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    });

    const out = await backfiller.enqueue(MINT, W, 6);

    // Even though the arithmetic happens to line up, we hit the cap: history is
    // incomplete, so we must NOT claim the ledger is trustworthy.
    expect(out.status).toBe('unreconciled');
    if (out.status !== 'unreconciled') throw new Error('unreachable');
    expect(out.reason).toBe('cap-hit');

    const pos = (await repo.getPosition(MINT, W))!;
    expect(pos.reconciled).toBe(false);
    expect(pos.backfilledAt).not.toBeNull(); // it ran…
    expect(pos.backfilled).toBe(true); // …and is recorded, but did not succeed
  });

  it('honours the 24h per-wallet cache', async () => {
    const W = 'CachedWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    let calls = 0;
    const counting: HistorySource = {
      signaturesFor: async () => {
        calls++;
        return [];
      },
      getTransaction: async () => null,
    };

    await repo.applyBuy(buyRec({ buyer: W, tokensRaw: 5n, usdIn: 1 }), { balanceAfterRaw: 999n });

    let now = 1_000_000;
    const backfiller = new Backfiller({
      repo,
      history: counting,
      solHistory: new StaticHistoricalSolUsd(77),
      log,
      now: () => now,
    });

    await backfiller.enqueue(MINT, W, 6);
    expect(calls).toBe(1);

    // A burst of further buys must not re-walk the same wallet's history.
    await backfiller.enqueue(MINT, W, 6);
    await backfiller.enqueue(MINT, W, 6);
    expect(calls).toBe(1);

    now += 25 * 60 * 60 * 1_000; // past the 24h cache
    await backfiller.enqueue(MINT, W, 6);
    expect(calls).toBe(2);
  });

  /**
   * INTEGRATION: one REAL wallet's real $RICE history.
   *
   * This wallet bought 27,305,176,224 RICE (the buy-pumpswap fixture) and then
   * transferred the ENTIRE bag out. Ground truth from getTokenAccountsByOwner at
   * capture time: it holds exactly 0.
   *
   * That makes it a sharp test of the transfer path. A ledger built from swaps
   * alone would insist the wallet holds 27.3 billion tokens while the chain says
   * zero — drift of -27,305,176,224, and any Position % rendered from it would be
   * describing a bag that no longer exists.
   */
  it('replays a REAL wallet\'s $RICE history and matches the chain exactly', async () => {
    const fx = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'wallet-rice-history.json'), 'utf8'),
    ) as { wallet: string; mint: string; onchainRaw: string; txs: ConfirmedTx[] };

    const onchainRaw = BigInt(fx.onchainRaw); // ground truth, fetched independently
    expect(onchainRaw).toBe(0n);

    // Sanity: the history really does contain a buy AND a transfer-out.
    const classified = fx.txs.map((t) => classify(t, fx.mint, fx.wallet)).filter(Boolean);
    expect(classified.map((e) => e!.kind).sort()).toEqual(['buy', 'transfer']);
    expect(classified.find((e) => e!.kind === 'transfer')).toMatchObject({ direction: 'out' });

    // What the bot observed LIVE: only the buy. Replay it exactly as the chain shows
    // it — same signature, same slot, same balanceAfterRaw. At that instant the
    // ledger genuinely DID agree with the chain: they bought the bag and held it.
    const buyTx = fx.txs.find((t) => classify(t, fx.mint, fx.wallet)?.kind === 'buy')!;
    const buyEv = classify(buyTx, fx.mint, fx.wallet) as Extract<BuyEvent, { kind: 'buy' }>;
    expect(buyEv.tokensRaw).toBe(27_305_176_224n);

    await repo.applyBuy(
      buyRec({
        signature: buyEv.signature,
        slot: buyEv.slot,
        mint: fx.mint,
        buyer: fx.wallet,
        tokensRaw: buyEv.tokensRaw,
        usdIn: 2.92,
      }),
      { balanceAfterRaw: buyEv.balanceAfterRaw },
    );

    const before = (await repo.getPosition(fx.mint, fx.wallet))!;
    expect(before.tokensRaw).toBe(27_305_176_224n);

    // Then they transferred the ENTIRE bag out — and the live path CANNOT SEE IT.
    // The normalizer returns null on transfers by design, so no swap arrives, no
    // reconciliation checkpoint fires, and the ledger goes silently stale: it still
    // insists on 27.3 billion tokens while the chain says zero. A Position % rendered
    // from it would describe a bag that no longer exists.
    //
    // This is precisely why an unreconciled wallet must trigger a backfill: it is the
    // ONLY path by which a transfer ever enters the swap log.
    expect(before.tokensRaw).not.toBe(onchainRaw);

    const backfiller = new Backfiller({
      repo,
      history: stubHistory(fx.txs),
      solHistory: new StaticHistoricalSolUsd(76.66),
      log,
    });

    const out = await backfiller.enqueue(fx.mint, fx.wallet, 6);
    expect(out.status).toBe('reconciled');

    const after = (await repo.getPosition(fx.mint, fx.wallet))!;

    // The replay saw the transfer-out and the ledger now agrees with the chain.
    expect(after.tokensRaw).toBe(onchainRaw);
    expect(after.tokensRaw).toBe(0n);
    expect(after.driftRaw).toBe(0n);
    expect(after.reconciled).toBe(true);

    // And the on-chain figure the fold DERIVED from the replayed transfer-out matches
    // the ground truth fetched independently via getTokenAccountsByOwner.
    expect(after.onchainRaw).toBe(onchainRaw);

    // They hold nothing, so there is no cost basis and no realized PnL: the tokens
    // were moved, not sold.
    expect(after.costUsd).toBe(0);
    expect(after.realizedPnlUsd).toBe(0);
  });

  it('coalesces a burst of concurrent enqueues into ONE walk', async () => {
    const W = 'BurstWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    let calls = 0;
    const slow: HistorySource = {
      signaturesFor: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return [];
      },
      getTransaction: async () => null,
    };

    const backfiller = new Backfiller({
      repo,
      history: slow,
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    });

    await Promise.all(Array.from({ length: 8 }, () => backfiller.enqueue(MINT, W, 6)));
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PHASE 4.5 — positions are a DERIVED FOLD over a durable swap log.
//
// The whole point: a backfill walk takes SECONDS, and the old backfiller ended it
// by OVERWRITING the position row with what the walk found. A live buy landing
// mid-walk was clobbered — its tokens and its cost silently vanished.
//
// Nothing writes position state any more. It writes FACTS, and the position is a
// pure fold over the facts. Two writers cannot clobber each other because neither
// holds any state to clobber.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What the backfiller does: ask the ONE parser what a given wallet did in a given
 * transaction. There is no second classifier to ask.
 */
const classify = (tx: ConfirmedTx, mint: string, wallet: string) =>
  normalizeSwap(tx, mint, { wallet }).event;

/**
 * The same transaction — same signature, same token movement — with every quote leg
 * removed: no native SOL delta for anyone, and no non-target token balances.
 *
 * `normalizeSwap` then has nothing it can call a payment, so it honestly reports a
 * transfer where the live path reported a buy. That is a genuine cross-path
 * disagreement about one transaction, which is exactly the hazard the narrowed PK
 * exists to make harmless.
 */
function stripQuoteLeg(tx: ConfirmedTx, mint: string): ConfirmedTx {
  const clone = structuredClone(tx);
  const meta = clone.meta!;

  // Every owner's native delta becomes exactly 0 (the fee is added back for index 0).
  meta.postBalances = meta.preBalances.map((p, i) => (i === 0 ? p - meta.fee : p));

  // Drop wSOL / USDC / everything that is not the mint under test.
  meta.preTokenBalances = (meta.preTokenBalances ?? []).filter((b) => b.mint === mint);
  meta.postTokenBalances = (meta.postTokenBalances ?? []).filter((b) => b.mint === mint);

  return clone;
}

describe('the swap log — a backfill can no longer clobber a live buy', () => {
  const W = 'RaceWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  /** The bag the bot never saw: 10,000,000 tokens for 1 SOL, long ago. */
  const oldBuy = (): ConfirmedTx =>
    historyTx({
      sig: 'old-buy',
      slot: 100,
      blockTime: 1_700_000_000,
      wallet: W,
      mint: MINT,
      tokenBefore: 0n,
      tokenAfter: 10_000_000_000_000n,
      solBefore: 5_000_000_000n,
      solAfter: 4_000_000_000n, // paid 1 SOL -> $77
    });

  /** A history walk that parks inside getTransaction until we let it go. */
  function gatedHistory(tx: ConfirmedTx): {
    history: HistorySource;
    atGate: Promise<void>;
    release: () => void;
  } {
    let arrived!: () => void;
    let release!: () => void;
    const atGate = new Promise<void>((r) => (arrived = r));
    const gate = new Promise<void>((r) => (release = r));

    return {
      atGate,
      release,
      history: {
        signaturesFor: async () => [{ signature: 'old-buy', slot: 100 }],
        getTransaction: async (sig) => {
          arrived(); // the walk is now genuinely in flight
          await gate;
          return sig === 'old-buy' ? tx : null;
        },
      },
    };
  }

  /**
   * THE POINT OF THE WHOLE PATCH.
   *
   * Start a walk, land a live buy in the middle of it, let the walk finish. The
   * live buy's tokens and cost must survive.
   */
  it('a live buy landing DURING a walk survives it', async () => {
    const { history, atGate, release } = gatedHistory(oldBuy());
    const backfiller = new Backfiller({
      repo,
      history,
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    });

    const walk = backfiller.enqueue(MINT, W, 6);
    await atGate; // the backfiller is now inside the walk, holding the old state

    // …and NOW a live buy lands. Under the old read-modify-write backfiller this is
    // the buy that got overwritten into oblivion.
    await repo.applyBuy(
      buyRec({ signature: 'live-mid-walk', slot: 300, buyer: W, tokensRaw: 500_000_000n, usdIn: 20 }),
      { balanceAfterRaw: 10_000_500_000_000n },
    );

    release();
    const out = await walk;
    expect(out.status).toBe('reconciled');

    const pos = (await repo.getPosition(MINT, W))!;

    // The old bag AND the mid-walk buy. Neither clobbered the other.
    expect(pos.tokensRaw).toBe(10_000_500_000_000n);
    expect(pos.costUsd).toBeCloseTo(77 + 20, 6); // 1 SOL @ $77, plus the live buy's $20
    expect(pos.driftRaw).toBe(0n);
    expect(pos.reconciled).toBe(true);
  });

  /**
   * NEGATIVE CONTROL — the same shape as the double-claim control in db.test.ts.
   *
   * Without this, the test above could pass for the wrong reason and go quietly
   * vacuous. Here we perform, by hand, exactly what the old backfiller did: end the
   * walk by OVERWRITING the position row with the state the walk computed. The walk
   * never saw the live buy, so the write erases it.
   */
  it('NEGATIVE CONTROL: a read-modify-write overwrite LOSES that buy', async () => {
    await repo.applyBuy(
      buyRec({ signature: 'live-mid-walk', slot: 300, buyer: W, tokensRaw: 500_000_000n, usdIn: 20 }),
      { balanceAfterRaw: 10_000_500_000_000n },
    );

    const backfiller = new Backfiller({
      repo,
      history: stubHistory([oldBuy()]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    });
    await backfiller.enqueue(MINT, W, 6);

    // The correct answer, which the fold produces.
    expect((await repo.getPosition(MINT, W))!.tokensRaw).toBe(10_000_500_000_000n);

    // Now do what the OLD backfiller did: overwrite the row wholesale with the state
    // its walk computed — a walk that, having started before the live buy, knows only
    // about the old bag.
    repo.raw
      .prepare('UPDATE positions SET tokens_raw = ?, cost_usd = ? WHERE mint = ? AND buyer = ?')
      .run('10000000000000', 77, MINT, W);

    const clobbered = (await repo.getPosition(MINT, W))!;
    expect(clobbered.tokensRaw).toBe(10_000_000_000_000n); // the live buy's 500,000,000: GONE
    expect(clobbered.costUsd).toBeCloseTo(77, 6); // its $20: GONE

    // And here is why the fold makes that class of bug unreachable: the derived row
    // was destroyed, but the FACT was not. Recomputing puts it straight back.
    const rebuilt = await repo.recomputePosition(MINT, W, 6);
    expect(rebuilt.tokensRaw).toBe(10_000_500_000_000n);
    expect(rebuilt.costUsd).toBeCloseTo(97, 6);
  });

  /**
   * IDEMPOTENCY. The PK (signature, mint, wallet, kind) is what makes a replay safe:
   * re-walking a wallet inserts nothing and changes nothing.
   */
  it('a second walk of the same history inserts ZERO rows and changes nothing', async () => {
    let now = 1_000_000;
    const backfiller = new Backfiller({
      repo,
      history: stubHistory([oldBuy()]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
      now: () => now,
    });

    await repo.applyBuy(
      buyRec({ signature: 'seen-live', slot: 200, buyer: W, tokensRaw: 200_000_000n, usdIn: 7.7 }),
      { balanceAfterRaw: 10_000_200_000_000n },
    );

    const first = await backfiller.enqueue(MINT, W, 6);
    if (first.status !== 'reconciled') throw new Error(`expected reconciled, got ${first.status}`);
    expect(first.inserted).toBe(1); // the one buy the walk discovered

    const after1 = (await repo.getPosition(MINT, W))!;
    expect(after1.tokensRaw).toBe(10_000_200_000_000n);

    // Walk it again, past the 24h cache. Same history, same facts.
    now += WALLET_CACHE_MS + 1;
    const second = await backfiller.enqueue(MINT, W, 6);
    if (second.status !== 'reconciled') throw new Error(`expected reconciled, got ${second.status}`);

    expect(second.inserted).toBe(0); // THE POINT: the PK already held every row

    const after2 = (await repo.getPosition(MINT, W))!;
    expect(after2.tokensRaw).toBe(after1.tokensRaw);
    expect(after2.costUsd).toBeCloseTo(after1.costUsd, 9);
    expect(after2.realizedPnlUsd).toBeCloseTo(after1.realizedPnlUsd, 9);
    expect(after2.reconciled).toBe(true);

    // Two facts total: the replayed old buy, and the live one. Not four.
    expect((await repo.listSwaps(MINT, W)).length).toBe(2);
  });

  /**
   * HOT WALLET. Buys land every 100ms for the whole duration of the walk.
   *
   * There is nothing to clobber, so there is nothing to abort — which means a wallet
   * that keeps trading still converges. (An "abort the write if the row moved"
   * fix would have livelocked exactly here, retrying forever.)
   */
  it('a HOT wallet converges: buys land every 100ms through the entire walk', async () => {
    const HOT = 'HotWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    const early = historyTx({
      sig: 'hot-old-buy',
      slot: 100,
      blockTime: 1_700_000_000,
      wallet: HOT,
      mint: MINT,
      tokenBefore: 0n,
      tokenAfter: 10_000_000_000_000n,
      solBefore: 5_000_000_000n,
      solAfter: 4_000_000_000n, // 1 SOL -> $77
    });

    let walks = 0;
    const slow: HistorySource = {
      signaturesFor: async () => {
        walks++;
        return [{ signature: 'hot-old-buy', slot: 100 }];
      },
      getTransaction: async () => {
        await sleep(350); // a slow walk, as a real one is
        return early;
      },
    };

    const backfiller = new Backfiller({
      repo,
      history: slow,
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    });

    const walk = backfiller.enqueue(MINT, HOT, 6);

    // Chain balance tracks every buy: the old bag, plus 100,000,000 per buy.
    let chain = 10_000_000_000_000n;
    let n = 0;
    const inFlight: Promise<unknown>[] = [];

    const iv = setInterval(() => {
      n += 1;
      chain += 100_000_000n;
      inFlight.push(
        repo.applyBuy(
          buyRec({ signature: `hot-${n}`, slot: 200 + n, buyer: HOT, tokensRaw: 100_000_000n, usdIn: 5 }),
          { balanceAfterRaw: chain },
        ),
      );
    }, 100);

    const out = await walk;
    clearInterval(iv);
    await Promise.all(inFlight);

    expect(n).toBeGreaterThanOrEqual(2); // buys really did land mid-walk
    expect(walks).toBe(1); // the walk ran ONCE: no abort, no retry
    expect(out.status).toBe('reconciled');

    const pos = (await repo.getPosition(MINT, HOT))!;

    // Every hot buy survived, and so did the bag the walk discovered.
    expect(pos.tokensRaw).toBe(10_000_000_000_000n + BigInt(n) * 100_000_000n);
    expect(pos.costUsd).toBeCloseTo(77 + n * 5, 6);
    expect(pos.driftRaw).toBe(0n);
    expect(pos.reconciled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PHASE 4.6 — one parser, and a key that does not depend on it.
//
// `kind` is DERIVED from the sign of a wallet's net delta, so it describes a swap; it
// does not identify one. While it sat in the PK, not-double-counting was contingent
// on two code paths AGREEING about classification. That is not a property to test
// for — it is one to design out.
// ---------------------------------------------------------------------------

describe('the narrowed PK — one transaction, one row, whatever anyone calls it', () => {
  /** The real $RICE buy from the captured wallet history. */
  function realBuy(): { tx: ConfirmedTx; mint: string; wallet: string; buy: BuyEvent } {
    const fx = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'wallet-rice-history.json'), 'utf8'),
    ) as { wallet: string; mint: string; txs: ConfirmedTx[] };

    const tx = fx.txs.find((t) => classify(t, fx.mint, fx.wallet)?.kind === 'buy')!;
    const buy = classify(tx, fx.mint, fx.wallet) as BuyEvent;
    return { tx, mint: fx.mint, wallet: fx.wallet, buy };
  }

  /** Apply a transaction exactly as the LIVE path does. */
  const applyLive = (mint: string, buy: BuyEvent) =>
    repo.applyBuy(
      buyRec({
        signature: buy.signature,
        slot: buy.slot,
        mint,
        buyer: buy.buyer,
        tokensRaw: buy.tokensRaw,
        quoteMint: buy.quoteMint,
        quoteSymbol: buy.quoteSymbol,
        quoteRaw: buy.quoteRaw,
        usdIn: 2.92,
      }),
      { balanceAfterRaw: buy.balanceAfterRaw },
      6,
    );

  /**
   * THE POINT OF THE PATCH.
   *
   * One real transaction, applied by the LIVE path, then discovered again by the
   * backfill. Exactly one row, and a position that does not budge.
   */
  it('a live buy re-discovered by the backfill stays ONE row, and the position is unchanged', async () => {
    const { tx, mint, wallet, buy } = realBuy();

    await applyLive(mint, buy);
    const before = (await repo.getPosition(mint, wallet))!;
    expect(before.tokensRaw).toBe(27_305_176_224n);

    // The backfill now walks the same wallet and finds the SAME transaction.
    const out = await new Backfiller({
      repo,
      history: stubHistory([tx]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    }).enqueue(mint, wallet, 6);

    if (out.status !== 'reconciled') throw new Error(`expected reconciled, got ${out.status}`);
    expect(out.inserted).toBe(0); // it had nothing new to tell us

    expect((await repo.listSwaps(mint, wallet)).length).toBe(1);

    const after = (await repo.getPosition(mint, wallet))!;
    expect(after.tokensRaw).toBe(before.tokensRaw);
    expect(after.costUsd).toBeCloseTo(before.costUsd, 12);
    expect(after.realizedPnlUsd).toBeCloseTo(before.realizedPnlUsd, 12);
    expect(after.onchainRaw).toBe(before.onchainRaw);
    expect(after.driftRaw).toBe(before.driftRaw);
    expect(after.reconciled).toBe(before.reconciled);
  });

  /**
   * THE TEST THAT PROVES THE HAZARD IS STRUCTURAL, NOT DORMANT.
   *
   * Force the two paths to DISAGREE about what the transaction was: the live path saw
   * a buy; the backfill is handed a doctored copy of the same signature with the quote
   * leg stripped, so `normalizeSwap` legitimately calls it a transfer_in.
   *
   * With `kind` in the key those were two different rows and the wallet's 27.3 BILLION
   * tokens were counted TWICE. With `kind` out of the key the second write collides
   * with the first no matter what either side decided — so it cannot happen, and no
   * future classifier change can make it happen again.
   */
  it('even when the two paths DISAGREE about kind, it still collapses to one row', async () => {
    const { tx, mint, wallet, buy } = realBuy();

    await applyLive(mint, buy);
    const before = (await repo.getPosition(mint, wallet))!;

    // Same signature. No quote leg. The one parser now honestly calls it a transfer.
    const doctored = stripQuoteLeg(tx, mint);
    const disagreeing = classify(doctored, mint, wallet)!;
    expect(disagreeing.kind).toBe('transfer'); // …where the live path said 'buy'
    expect(disagreeing.signature).toBe(buy.signature); // …about the SAME transaction

    const out = await new Backfiller({
      repo,
      history: stubHistory([doctored]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    }).enqueue(mint, wallet, 6);

    if (out.status === 'skipped') throw new Error('unexpected skip');
    expect(out.inserted).toBe(0); // THE POINT: the key collided regardless of `kind`

    // ONE row. Not one 'buy' plus one 'transfer_in'.
    const rows = await repo.listSwaps(mint, wallet);
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('buy'); // the first writer's classification stands

    // And the position did not double.
    const after = (await repo.getPosition(mint, wallet))!;
    expect(after.tokensRaw).toBe(before.tokensRaw);
    expect(after.tokensRaw).toBe(27_305_176_224n); // NOT 54,610,352,448
    expect(after.costUsd).toBeCloseTo(before.costUsd, 12);
  });
});

// ---------------------------------------------------------------------------
// PHASE 4.7 — a FREE RECEIPT is not an UNPRICED PURCHASE.
//
// Both arrive as `transfer_in` with usd_value 0. They are nothing alike: an airdrop's
// zero is the truth; an arb's zero is a hole where a price should be. Booking the
// second at zero cost manufactures a basis of nothing and publishes a vast, confident,
// wrong Position %.
//
// We do not go looking for a price for the counterparty token. We ABSTAIN.
// ---------------------------------------------------------------------------

describe('unpriceable basis — abstain rather than guess', () => {
  const ARBER = 'ArbWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const OTHER_TOKEN = '8P7Bk2eSW4VgraaFaSjxdbzuri22rqjqrN8PZ4g7jups'; // not in QUOTE_REGISTRY

  /**
   * The wallet acquires `mint` by handing over some non-registry token. No SOL, no
   * USDC — nothing we can put a dollar figure on.
   */
  function arbTx(opts: {
    sig: string;
    slot: number;
    wallet: string;
    tokenBefore: bigint;
    tokenAfter: bigint;
    otherBefore: bigint;
    otherAfter: bigint;
  }): ConfirmedTx {
    const bal = (mint: string, amount: bigint, idx: number) => ({
      accountIndex: idx,
      mint,
      owner: opts.wallet,
      uiTokenAmount: { amount: amount.toString(), decimals: 6 },
    });

    return {
      slot: opts.slot,
      blockTime: 1_700_000_000,
      transaction: {
        message: { accountKeys: [{ pubkey: opts.wallet, signer: true, writable: true }] },
        signatures: [opts.sig],
      },
      meta: {
        err: null,
        fee: 5_000,
        // No native SOL movement at all: the fee is added back for the fee payer, so
        // this wallet's SOL delta is exactly 0 and there is no quote leg anywhere.
        preBalances: [1_000_000_000],
        postBalances: [1_000_000_000 - 5_000],
        preTokenBalances: [bal(MINT, opts.tokenBefore, 1), bal(OTHER_TOKEN, opts.otherBefore, 2)],
        postTokenBalances: [bal(MINT, opts.tokenAfter, 1), bal(OTHER_TOKEN, opts.otherAfter, 2)],
      },
    };
  }

  it('the parser marks an arb-in as unpriced, and a true airdrop as NOT unpriced', () => {
    const arb = arbTx({
      sig: 'arb-in',
      slot: 10,
      wallet: ARBER,
      tokenBefore: 0n,
      tokenAfter: 9_000_000n,
      otherBefore: 500_000_000n,
      otherAfter: 100_000_000n, // they PAID 400,000,000 of a token we cannot value
    });

    const ev = classify(arb, MINT, ARBER) as Extract<ReturnType<typeof classify>, { kind: 'transfer' }>;
    expect(ev.kind).toBe('transfer'); // still never a buy — the 2.5 boundary holds
    expect(ev.direction).toBe('in');
    expect(ev.unpriced).toBe(true); // …but we know they did not get it for free

    // The same shape with NO counter-leg is a genuine airdrop.
    const gift = arbTx({
      sig: 'gift',
      slot: 11,
      wallet: ARBER,
      tokenBefore: 0n,
      tokenAfter: 9_000_000n,
      otherBefore: 500_000_000n,
      otherAfter: 500_000_000n, // unchanged: nothing was given up
    });
    expect((classify(gift, MINT, ARBER) as { unpriced: boolean }).unpriced).toBe(false);
  });

  it('the REAL token-to-token-arb fixture is unpriced', () => {
    // Scoped to the WALLET, which is the only path that sees an arb: the live path now requires a
    // signing actor, and in this transaction no signer's balance of the mint moved.
    const fx = fixture('token-to-token-arb');
    const ev = normalizeSwap(fx.tx, fx.mint, { wallet: 'sMpv67edxYRByacJu5deAqtDAJtXhVgPXviebeiRpqf' as Wallet }).event!;

    expect(ev.kind).toBe('transfer'); // never a buy
    expect((ev as Extract<typeof ev, { kind: 'transfer' }>).unpriced).toBe(true);
  });

  /**
   * THE ARB TEST.
   *
   * Drift is ZERO — the ledger's token count agrees with the chain perfectly. Every
   * leg is accounted for. And we STILL must not render a percentage, because one of
   * those legs is denominated in something we cannot value.
   *
   * This is why `basis_unpriced` is a separate veto from `history_truncated`: a
   * backfill would not help here. There is nothing missing. Abstaining IS the answer.
   */
  it('an arbed-in bag: drift 0, but unpriced -> NO Position %, and holdingsUsd still exact', async () => {
    const arb = arbTx({
      sig: 'arb-in',
      slot: 10,
      wallet: ARBER,
      tokenBefore: 0n,
      tokenAfter: 9_000_000n,
      otherBefore: 500_000_000n,
      otherAfter: 100_000_000n,
    });

    await new Backfiller({
      repo,
      history: stubHistory([arb]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    }).enqueue(MINT, ARBER, 6);

    const pos = (await repo.getPosition(MINT, ARBER))!;

    expect(pos.tokensRaw).toBe(9_000_000n);
    expect(pos.onchainRaw).toBe(9_000_000n);
    expect(pos.driftRaw).toBe(0n); // the ledger agrees with the chain EXACTLY…
    expect(pos.basisUnpriced).toBe(true); // …but the basis is a hole
    expect(pos.historyTruncated).toBe(false); // and NOT for want of history
    expect(pos.reconciled).toBe(false); // so we abstain

    // NO percentage. Not an inflated one, not a "free bag" one. Silence.
    const line = positionLine({
      reconciled: pos.reconciled,
      tokensRaw: pos.tokensRaw,
      balanceBeforeRaw: 1n, // they held something before, so it is not "New Holder"
      avgCostUsd: avgCostUsd(pos, 6),
      priceUsd: 0.001,
      hasPriorHistory: true,
    });
    expect(line.kind).toBe('omitted');
    expect(line.text).toBeNull();

    // But holdingsUsd comes from the CHAIN and is exact, so it still renders and the
    // whale tier still fires correctly. Only the Position % goes dark.
    const holdingsUsd = (Number(pos.onchainRaw) / 1e6) * 0.001; // 9 whole tokens @ $0.001
    expect(holdingsUsd).toBeCloseTo(0.009, 9);
  });

  /**
   * NEGATIVE CONTROL — the number we would otherwise have published.
   *
   * Without the flag, that same wallet is "reconciled" (drift really is 0) with a cost
   * basis of $0 across 9,000,000 tokens. Add one real $100 buy and the average basis
   * collapses to a tenth of a cent — and the card renders a confident, enormous,
   * WRONG percentage. Seeing it once is the point.
   */
  it('NEGATIVE CONTROL: without the flag, the mixed wallet publishes a 900% lie', async () => {
    const MIXED = 'MixedWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // A real buy: 1,000,000 tokens for $100 -> a true basis of $100/token (6dp).
    await repo.applyBuy(
      buyRec({ signature: 'real-buy', slot: 5, buyer: MIXED, tokensRaw: 1_000_000n, usdIn: 100 }),
      { balanceAfterRaw: 1_000_000n },
      6,
    );

    const arb = arbTx({
      sig: 'mixed-arb',
      slot: 10,
      wallet: MIXED,
      tokenBefore: 1_000_000n,
      tokenAfter: 10_000_000n, // +9,000,000, paid for in an unvaluable token
      otherBefore: 500_000_000n,
      otherAfter: 100_000_000n,
    });

    await new Backfiller({
      repo,
      history: stubHistory([arb]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    }).enqueue(MINT, MIXED, 6);

    const pos = (await repo.getPosition(MINT, MIXED))!;

    // ONE unvaluable leg poisons the whole average.
    expect(pos.basisUnpriced).toBe(true);
    expect(pos.driftRaw).toBe(0n);
    expect(pos.reconciled).toBe(false);

    // What we DO render: nothing.
    expect(
      positionLine({
        reconciled: pos.reconciled,
        tokensRaw: pos.tokensRaw,
        balanceBeforeRaw: 1_000_000n,
        avgCostUsd: avgCostUsd(pos, 6),
        priceUsd: 100,
        hasPriorHistory: true,
      }).kind,
    ).toBe('omitted');

    // What we WOULD have rendered without the flag — the arb's 9,000,000 tokens booked
    // at zero cost, dragging a true $100/token basis down to $10/token:
    const lie = positionLine({
      reconciled: true, // pretend basis_unpriced does not exist
      tokensRaw: pos.tokensRaw,
      balanceBeforeRaw: 1_000_000n,
      avgCostUsd: avgCostUsd(pos, 6),
      priceUsd: 100, // the token has not moved at all since their real buy
      hasPriorHistory: true,
    });

    expect(avgCostUsd(pos, 6)).toBeCloseTo(10, 9); // $100 spread over 10 tokens
    expect(lie.kind).toBe('position');
    expect(lie.text).toBe('Position +900%'); // …on a wallet that is actually flat.
  });

  /**
   * PHASE 4.8 — realized PnL is NULL when it is UNKNOWABLE.
   *
   * A `transfer_out` into a token we cannot value disposes of the mint and books no
   * realized PnL for that leg, because that leg's PnL cannot be known. The running
   * total is therefore missing a piece it can never learn. A number here would look
   * authoritative and be wrong; NULL says what is true.
   */
  it('an unpriced SELL makes realized PnL NULL — not zero, not a guess', async () => {
    const SELLER = 'ArbOutWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // A real, priceable buy: 10 tokens for $100.
    await repo.applyBuy(
      buyRec({ signature: 'clean-buy', slot: 5, buyer: SELLER, tokensRaw: 10_000_000n, usdIn: 100 }),
      { balanceAfterRaw: 10_000_000n },
      6,
    );
    expect((await repo.getPosition(MINT, SELLER))!.realizedPnlUsd).toBe(0); // a real number

    // …then they dump 4 tokens into some token we cannot value.
    const arbOut = arbTx({
      sig: 'arb-out',
      slot: 10,
      wallet: SELLER,
      tokenBefore: 10_000_000n,
      tokenAfter: 6_000_000n, // -4,000,000 of the mint…
      otherBefore: 100_000_000n,
      otherAfter: 500_000_000n, // …for 400,000,000 of something unvaluable
    });

    const ev = classify(arbOut, MINT, SELLER) as Extract<ReturnType<typeof classify>, { kind: 'transfer' }>;
    expect(ev.direction).toBe('out');
    expect(ev.unpriced).toBe(true);

    await new Backfiller({
      repo,
      history: stubHistory([arbOut]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    }).enqueue(MINT, SELLER, 6);

    const pos = (await repo.getPosition(MINT, SELLER))!;

    // THE POINT: we cannot know what that disposal realized, so we do not claim to.
    expect(pos.realizedPnlUsd).toBeNull();

    // The quantities are still exact — only the VALUATION is unknowable.
    expect(pos.tokensRaw).toBe(6_000_000n);
    expect(pos.driftRaw).toBe(0n);
  });

  /**
   * The distinction that must NOT be collapsed. Two different blindnesses:
   *
   *   unpriced BUY  -> the cost BASIS is corrupt. Nothing was sold, so realized PnL
   *                    is untouched and stays a real, correct number.
   *   unpriced SELL -> realized PnL is corrupt, and only realized PnL.
   */
  it('an unpriced BUY does NOT null realized PnL — nothing was sold', async () => {
    const MIXED = 'ArbInSellerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // Buy 10 tokens for $100 ($10/token), then sell 4 for $80 — a clean, priceable sell.
    await repo.applyBuy(
      buyRec({ signature: 'b1', slot: 5, buyer: MIXED, tokensRaw: 10_000_000n, usdIn: 100 }),
      { balanceAfterRaw: 10_000_000n },
      6,
    );
    await repo.applySell(
      {
        signature: 's1',
        mint: MINT,
        seller: MIXED,
        quoteMint: SOL,
        quoteSymbol: 'SOL',
        quoteRaw: 1_000_000_000n,
        tokensRaw: 4_000_000n,
        usdOut: 80,
        slot: 6,
        blockTime: null,
      },
      6,
      { balanceAfterRaw: 6_000_000n },
    );

    // Sold 4 @ $20 against a $10 basis = +$40 realized. Knowable, and known.
    expect((await repo.getPosition(MINT, MIXED))!.realizedPnlUsd).toBeCloseTo(40, 6);

    // NOW they arb IN — acquiring tokens with something we cannot value.
    const arbIn = arbTx({
      sig: 'arb-in-later',
      slot: 20,
      wallet: MIXED,
      tokenBefore: 6_000_000n,
      tokenAfter: 15_000_000n,
      otherBefore: 500_000_000n,
      otherAfter: 100_000_000n,
    });

    await new Backfiller({
      repo,
      history: stubHistory([arbIn]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    }).enqueue(MINT, MIXED, 6);

    const pos = (await repo.getPosition(MINT, MIXED))!;

    // The BASIS is now unknowable, so no Position % renders…
    expect(pos.basisUnpriced).toBe(true);
    expect(pos.reconciled).toBe(false);

    // …but the sells they already made are still perfectly well valued. Realized PnL
    // survives, because nothing about that arb changed what those sells realized.
    expect(pos.realizedPnlUsd).toBeCloseTo(40, 6);
    expect(pos.realizedPnlUsd).not.toBeNull();
  });

  it('a NULL realized PnL comes back NULL from a rebuild — it is DERIVED', async () => {
    const SELLER = 'ArbOutWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    await repo.applyBuy(
      buyRec({ signature: 'clean-buy', slot: 5, buyer: SELLER, tokensRaw: 10_000_000n, usdIn: 100 }),
      { balanceAfterRaw: 10_000_000n },
      6,
    );
    await new Backfiller({
      repo,
      history: stubHistory([
        arbTx({
          sig: 'arb-out',
          slot: 10,
          wallet: SELLER,
          tokenBefore: 10_000_000n,
          tokenAfter: 6_000_000n,
          otherBefore: 100_000_000n,
          otherAfter: 500_000_000n,
        }),
      ]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    }).enqueue(MINT, SELLER, 6);

    expect((await repo.getPosition(MINT, SELLER))!.realizedPnlUsd).toBeNull();

    repo.raw.exec('DELETE FROM positions');
    await repo.rebuildPositions();

    // NULL is not "not computed yet" — it is a value the fold produces. If it did not
    // come back, it was being remembered rather than derived.
    expect((await repo.getPosition(MINT, SELLER))!.realizedPnlUsd).toBeNull();
  });

  it('basis_unpriced survives a rebuild from the log alone — it is DERIVED', async () => {
    const arb = arbTx({
      sig: 'arb-in',
      slot: 10,
      wallet: ARBER,
      tokenBefore: 0n,
      tokenAfter: 9_000_000n,
      otherBefore: 500_000_000n,
      otherAfter: 100_000_000n,
    });

    await new Backfiller({
      repo,
      history: stubHistory([arb]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    }).enqueue(MINT, ARBER, 6);

    const before = (await repo.getPosition(MINT, ARBER))!;
    expect(before.basisUnpriced).toBe(true);

    repo.raw.exec('DELETE FROM positions');
    await repo.rebuildPositions();

    const after = (await repo.getPosition(MINT, ARBER))!;

    // If it could not be re-derived from the swap rows, it was not a fold.
    expect(after.basisUnpriced).toBe(true);
    expect(after.reconciled).toBe(false);
    expect(after.driftRaw).toBe(before.driftRaw);
    expect(after.tokensRaw).toBe(before.tokensRaw);
  });
});

describe('positions are a MATERIALIZED VIEW: rebuild from the log alone', () => {
  /**
   * Delete the positions table outright and rebuild every row from `swaps`. Every
   * derived value must come back identical. If it does not, the fold is not pure and
   * that is the bug.
   *
   * `firstSeen` / `backfilled` / `backfilledAt` / `historyTruncated` are deliberately
   * NOT compared: they record what OUR PROCESS did, not what the chain did. They are
   * not facts about the wallet, so they are not part of the fold.
   */
  it('every derived value is identical after a full rebuild', async () => {
    const A = 'RebuildAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const B = 'RebuildBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    // Wallet A: two buys and a partial sell — a realized-PnL path.
    await repo.applyBuy(
      buyRec({ signature: 'a1', slot: 10, buyer: A, tokensRaw: 1_000_000n, usdIn: 100 }),
      { balanceAfterRaw: 1_000_000n },
    );
    await repo.applyBuy(
      buyRec({ signature: 'a2', slot: 20, buyer: A, tokensRaw: 1_000_000n, usdIn: 300 }),
      { balanceAfterRaw: 2_000_000n },
    );
    await repo.applySell(
      {
        signature: 'a3',
        mint: MINT,
        seller: A,
        quoteMint: SOL,
        quoteSymbol: 'SOL',
        quoteRaw: 1_000_000_000n,
        tokensRaw: 500_000n,
        usdOut: 250,
        slot: 30,
        blockTime: null,
      },
      6,
      { balanceAfterRaw: 1_500_000n },
    );

    // Wallet B: an airdrop discovered by backfill (transfer_in, zero cost) and a buy.
    const airdrop = historyTx({
      sig: 'b-airdrop',
      slot: 5,
      blockTime: 1_700_000_000,
      wallet: B,
      mint: MINT,
      tokenBefore: 0n,
      tokenAfter: 4_000_000n,
      solBefore: 1_000_000_000n,
      solAfter: 1_000_000_000n, // nothing paid: FREE
    });

    await repo.applyBuy(
      buyRec({ signature: 'b1', slot: 40, buyer: B, tokensRaw: 1_000_000n, usdIn: 50 }),
      { balanceAfterRaw: 5_000_000n },
    );
    await new Backfiller({
      repo,
      history: stubHistory([airdrop]),
      solHistory: new StaticHistoricalSolUsd(77),
      log,
    }).enqueue(MINT, B, 6);

    const snapshot = async () => ({
      a: (await repo.getPosition(MINT, A))!,
      b: (await repo.getPosition(MINT, B))!,
    });

    const before = await snapshot();

    // The airdrop is zero-cost, so B's basis is $50 across 5,000,000 tokens — the free
    // tokens drag the average DOWN rather than becoming phantom profit.
    expect(before.b.tokensRaw).toBe(5_000_000n);
    expect(before.b.costUsd).toBeCloseTo(50, 6);
    expect(before.b.reconciled).toBe(true);

    // NUKE the materialized view.
    repo.raw.exec('DELETE FROM positions');
    expect(await repo.getPosition(MINT, A)).toBeNull();

    await repo.rebuildPositions();

    const after = await snapshot();

    for (const k of ['a', 'b'] as const) {
      expect(after[k].tokensRaw).toBe(before[k].tokensRaw);
      expect(after[k].costUsd).toBeCloseTo(before[k].costUsd, 9);
      expect(after[k].realizedPnlUsd).toBeCloseTo(before[k].realizedPnlUsd, 9);
      // Reconciliation rebuilds too: onchain_raw is the newest balanceAfterRaw in the
      // log, so drift and reconciled are derived, not remembered.
      expect(after[k].onchainRaw).toBe(before[k].onchainRaw);
      expect(after[k].driftRaw).toBe(before[k].driftRaw);
      expect(after[k].reconciled).toBe(before[k].reconciled);
    }

    // A genuinely exercised the sell path — otherwise this test proves less than it looks.
    expect(after.a.realizedPnlUsd).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ONE APPLICATION PATH: live and flushed swaps must fold in identically
// ---------------------------------------------------------------------------

describe('swap applier — a swap folds in the same way however it arrived', () => {
  const fakeFeed = (solUsd: number | null): SolUsdFeed =>
    ({ solUsd: () => solUsd, ageMs: () => null }) as unknown as SolUsdFeed;

  const tokens = (): TokenMetaCache =>
    new TokenMetaCache(
      { getTokenSupply: async () => ({ amount: 1_000_000_000_000_000n, decimals: 6 }), getAssetMeta: async () => null },
      repo,
      log,
    );

  /** A backfiller that never walks anything: this suite is about the apply path. */
  const idleBackfiller = (): Backfiller =>
    new Backfiller({
      repo,
      history: { signaturesFor: async () => [], getTransaction: async () => null },
      solHistory: new StaticHistoricalSolUsd(100),
      log,
    });

  const applier = (pricerLog = log) =>
    makeSwapApplier({ repo, log: pricerLog, backfiller: idleBackfiller(), backfill: false });

  const sellEvent = (over: Partial<SellEvent> = {}): SellEvent => ({
    kind: 'sell',
    signature: 'sell-sig-1',
    slot: 20,
    blockTime: 1_700_000_100,
    mint: MINT,
    quoteMint: SOL,
    quoteSymbol: 'SOL',
    quoteRaw: 1_000_000_000n, // 1 SOL received
    tokensRaw: 400_000n,
    balanceBeforeRaw: 1_000_000n,
    balanceAfterRaw: 600_000n,
    seller: WALLET,
    ...over,
  });

  /** Ledger: 1.0 whole token, $100 of cost. A clean, reconciled starting point. */
  async function seedReconciledLedger(): Promise<void> {
    const pos = await repo.applyBuy(
      buyRec({ tokensRaw: 1_000_000n, usdIn: 100, priceUsd: 100 }),
      { balanceAfterRaw: 1_000_000n },
    );
    expect(pos.reconciled).toBe(true);
    expect(pos.tokensRaw).toBe(1_000_000n);
  }

  /**
   * THE REGRESSION.
   *
   * A SOL-quoted SELL that arrives while the SOL feed is down is HELD, exactly like
   * a buy. When the feed recovers it must be applied to the basis.
   *
   * The flush callback used to dispatch only `kind === 'buy'`, so a held sell was
   * flushed straight into the bin. The ledger then kept 1.0 token it no longer held
   * and $100 of cost it had already retired — and the drift silently hid that
   * wallet's Position % until a backfill rebuilt it.
   */
  it('applies a SOL-quoted SELL that was HELD while the SOL feed was down', async () => {
    await seedReconciledLedger();

    let sol: number | null = null;
    const feed = { solUsd: () => sol, ageMs: () => null } as unknown as SolUsdFeed;
    const pricer = new Pricer({ feed, tokens: tokens(), log });
    const app = applier();

    // Feed is DOWN. The sell is held, not applied — and certainly not dropped.
    const sell = sellEvent();
    const outcome = await pricer.price(sell);
    expect(outcome.status).toBe('held');
    await app.onSwap(sell, outcome);
    expect(pricer.heldCount).toBe(1);

    // The ledger has NOT moved yet: nothing was priced, so nothing was applied.
    expect((await repo.getPosition(MINT, WALLET))!.tokensRaw).toBe(1_000_000n);

    // Feed recovers. Everything held gets applied — sells included.
    sol = 100;
    const flushed = await pricer.flushHeld((e, o) => app.onSwap(e, o));
    expect(flushed).toBe(1);

    const pos = (await repo.getPosition(MINT, WALLET))!;

    // 400k raw of 1M sold, at the $100/token average -> $40 of cost retired.
    expect(pos.tokensRaw).toBe(600_000n);
    expect(pos.costUsd).toBeCloseTo(60, 6);

    // 1 SOL @ $100 for 0.4 tokens = $250/token, against a $100/token basis.
    expect(pos.realizedPnlUsd).toBeCloseTo((250 - 100) * 0.4, 6);

    // And because a sell is a reconciliation checkpoint too, the ledger still
    // agrees with the chain. THIS is what silently broke when the sell vanished.
    expect(pos.onchainRaw).toBe(600_000n);
    expect(pos.driftRaw).toBe(0n);
    expect(pos.reconciled).toBe(true);
  });

  /**
   * The counterpart to the Phase 2.5 buy rule: a USDC-quoted sell does not need the
   * SOL feed, so it must value correctly and apply IMMEDIATELY while SOL is down.
   */
  it('values a USDC-quoted SELL while the SOL feed is DOWN', async () => {
    await seedReconciledLedger();

    const pricer = new Pricer({ feed: fakeFeed(null), tokens: tokens(), log });
    const app = applier();

    const sell = sellEvent({
      signature: 'sell-usdc',
      quoteMint: USDC_MINT,
      quoteSymbol: 'USDC',
      quoteRaw: 100_000_000n, // 100 USDC, 6dp
    });

    const outcome = await pricer.price(sell);
    expect(outcome.status).toBe('priced'); // NOT held: it never needed SOL
    await app.onSwap(sell, outcome);
    expect(pricer.heldCount).toBe(0);

    const pos = (await repo.getPosition(MINT, WALLET))!;
    expect(pos.tokensRaw).toBe(600_000n);
    expect(pos.costUsd).toBeCloseTo(60, 6);
    // 100 USDC for 0.4 tokens = $250/token, same as above.
    expect(pos.realizedPnlUsd).toBeCloseTo((250 - 100) * 0.4, 6);
    expect(pos.reconciled).toBe(true);
  });

  it('a held BUY still flushes into the ledger (the path that already worked)', async () => {
    let sol: number | null = null;
    const feed = { solUsd: () => sol, ageMs: () => null } as unknown as SolUsdFeed;
    const pricer = new Pricer({ feed, tokens: tokens(), log });
    const app = applier();

    const buy: BuyEvent = {
      kind: 'buy',
      signature: 'held-buy',
      slot: 5,
      blockTime: 1_700_000_000,
      mint: MINT,
      quoteMint: SOL,
      quoteSymbol: 'SOL',
      quoteRaw: 1_000_000_000n,
      tokensRaw: 1_000_000n,
      balanceBeforeRaw: 0n,
      balanceAfterRaw: 1_000_000n,
      buyer: WALLET,
    };

    expect((await pricer.price(buy)).status).toBe('held');
    expect(await repo.getPosition(MINT, WALLET)).toBeNull();

    sol = 100;
    await pricer.flushHeld((e, o) => app.onSwap(e, o));

    const pos = (await repo.getPosition(MINT, WALLET))!;
    expect(pos.tokensRaw).toBe(1_000_000n);
    expect(pos.costUsd).toBeCloseTo(100, 6);
    expect(pos.reconciled).toBe(true);
  });

  it('a swap that could not be priced at all is not applied to the ledger', async () => {
    await seedReconciledLedger();
    const app = applier();

    await app.onSwap(sellEvent(), { status: 'dropped', reason: 'no-token-metadata' });

    const pos = (await repo.getPosition(MINT, WALLET))!;
    expect(pos.tokensRaw).toBe(1_000_000n); // untouched
    expect(pos.realizedPnlUsd).toBe(0);
  });

});
