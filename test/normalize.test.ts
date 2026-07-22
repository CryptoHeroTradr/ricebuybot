import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeSwap } from '../src/ingest/normalize.js';
import { toConfirmedTx } from '../src/ingest/ws.js';
import { SignatureLru } from '../src/ingest/dedup.js';
import { Backoff } from '../src/ingest/backoff.js';
import type { ConfirmedTx } from '../src/ingest/solana-types.js';

/**
 * Every fixture is a REAL mainnet transaction, captured verbatim.
 *
 * The expected values below were derived INDEPENDENTLY, by a throwaway Python
 * re-implementation reading the raw JSON (scripts/verify-fixtures.py), and only
 * then compared against this normalizer. They are cross-validated, not echoed
 * back from the code under test.
 */
interface Fixture {
  name: string;
  mint: string;
  signature: string;
  venues?: string[];
  tx: ConfirmedTx;
}

function load(name: string): Fixture {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8')) as Fixture;
}

interface Expectation {
  kind: 'buy' | 'sell';
  who: string;
  tokensRaw: bigint;
  quoteRaw: bigint;
  quoteSymbol: string;
  balanceBeforeRaw: bigint;
  balanceAfterRaw: bigint;
}

/**
 * THE FIXTURE CORPUS WAS POISONED, AND THE TESTS ENSHRINED IT.
 *
 * These fixtures were captured by the very classifier they were then used to test — so a
 * transaction the classifier *called* a buy was saved as `buy-*.json`, and a test was written
 * asserting it is a buy. The suite was green for nine phases while encoding the bug.
 *
 * The bug: "gained the mint AND gave up quote" does not describe a buyer. It describes ONE SIDE
 * OF ANY TRADE, and on a SELL that side is the AMM POOL. In production this posted
 * "🐳 WHALE BUY!" to a live group about a pump AMM liquidity pool (sig 4u4ccxck…).
 *
 * Every fixture below was re-verified AGAINST THE CHAIN — `getAccountInfo` on the account that
 * "gained the mint", to see whether it is a system-owned wallet or a program-owned pool PDA:
 *
 *   buy-pumpfun-bonding-curve   signer +5,460,328,478,971   gainer = WALLET      -> a real BUY
 *   buy-pumpswap                signer   +27,305,176,224    gainer = WALLET      -> a real BUY
 *   buy-usdc-quoted             signer      +29,200,568     gainer = WALLET      -> a real BUY
 *
 *   buy-whale-existing-balance  signer  -1,941,584,805      gainer = Meteora DLMM POOL  -> a SELL
 *   buy-jupiter-multihop        signer            0         gainer = pump AMM POOL      -> not the signer's trade
 *   buy-multi-venue-route       signer            0         gainer = pump AMM POOL      -> not the signer's trade
 *   buy-raydium-amm-v4          signer            0         gainer = pump AMM POOL      -> not the signer's trade
 *   buy-raydium-clmm            signer            0         gainer = Orca Whirlpool POOL-> not the signer's trade
 *   sell                        signer            0         (signers are a GAS RELAYER) -> not the signer's trade
 *
 * The three genuine buys share exactly one property that all six impostors lack: THE SIGNER
 * GAINED THE MINT. That is now the rule.
 *
 * The filenames are left as they are, deliberately. Renaming them would erase the evidence that
 * they were ever believed to be buys — and that belief, not the transactions, is what shipped.
 */
const EXPECTED: Record<string, Expected> = {
  'buy-pumpfun-bonding-curve': {
    kind: 'buy',
    who: '2jyhLnupSCduevsTBoA7hdpyz9CBnoKHbDfcEXa3Hkc5',
    tokensRaw: 5_460_328_478_971n,
    quoteRaw: 453_162_403n,
    quoteSymbol: 'SOL',
    balanceBeforeRaw: 0n,
    balanceAfterRaw: 5_460_328_478_971n,
  },
  'buy-pumpswap': {
    kind: 'buy',
    who: 'BfEhdonWCqQa3qxucTevNCizBnnaSJ7kJY4D1qSgiicQ',
    tokensRaw: 27_305_176_224n,
    quoteRaw: 38_110_479n,
    quoteSymbol: 'SOL',
    balanceBeforeRaw: 0n,
    balanceAfterRaw: 27_305_176_224n,
  },
};

/** Verified against the chain: the account that gained the mint is a program-owned POOL PDA. */
const NOT_THE_SIGNERS_TRADE = [
  'buy-jupiter-multihop',
  'buy-multi-venue-route',
  'buy-raydium-amm-v4',
  'buy-raydium-clmm',
  'sell',
] as const;

describe('normalizeSwap — real mainnet fixtures (INVARIANT 1: balance-delta only)', () => {
  /**
   * REGRESSION — this one was posted to a live group as "🐳 WHALE BUY!" and it was a SELL.
   *
   * The fee payer dumped 898,469 RICE and took 1.03 SOL. The PumpSwap pool vault took the RICE
   * and paid out the SOL — which matches "gained the mint AND gave up quote" EXACTLY. The pool
   * was the only owner matching, so it was named the buyer.
   *
   * The buyer rule was never a description of a buyer; it is a description of ONE SIDE OF ANY
   * TRADE, and on a sell that side is the pool. The actor must SIGN: a trader signs the
   * transaction that moves their money, and a pool authority is a PDA that cannot.
   */
  it('a SELL is never a buy, even when the AMM pool looks exactly like a buyer', () => {
    const fx = load('sell-misread-as-buy');
    const { event } = normalizeSwap(fx.tx, fx.mint as Mint, { solUsd: 150 });

    expect(event?.kind).not.toBe('buy'); // it posted a WHALE BUY card about a liquidity pool
    expect(event?.kind).toBe('sell');

    // And the seller is the human who signed — not the pool that received the tokens.
    expect(event && 'seller' in event && event.seller).toBe('2gJBjenSB2rVnMikoCmURintiDJVnDqQ7MNx6dxFX4Yv');
  });

  /**
   * THE SIX IMPOSTORS. Each was saved as a "buy" and asserted to be one.
   *
   * In every case the account that gained the mint is a POOL PDA (pump AMM, Orca Whirlpool,
   * Meteora DLMM) and no signer's balance of the mint moved — so the transaction is not the
   * signer's trade at all: it is pool-to-pool routing, or a relayer-executed swap we cannot
   * attribute to a human.
   *
   * We return NULL rather than guessing an owner out of the deltas. Guessing is exactly what put
   * a liquidity pool on a WHALE BUY card in front of a live group.
   */
  it.each(NOT_THE_SIGNERS_TRADE)('%s is NOT a buy — the "buyer" is a pool PDA', (name) => {
    const fx = load(name);
    const { event, reason } = normalizeSwap(fx.tx, fx.mint as Mint, { solUsd: 150 });

    expect(event?.kind).not.toBe('buy');
    expect(event).toBeNull();
    expect(reason).toBe('no-signing-actor');
  });

  /**
   * Captured as `buy-whale-existing-balance`, asserted as a buy, and posted as one. The signer
   * DUMPED 1,941,584,805 tokens into a Meteora DLMM pool and took the SOL. It is a sell.
   */
  it('buy-whale-existing-balance is a SELL — the signer dumped into a Meteora pool', () => {
    const fx = load('buy-whale-existing-balance');
    const { event } = normalizeSwap(fx.tx, fx.mint as Mint, { solUsd: 150 });

    expect(event?.kind).toBe('sell');
    expect(event && 'seller' in event && event.seller).toBe('EtrBDkEmmVGjRQ3NVhFu5gj4XDjAkDVgHP4KQxp5Sh19');
  });

  for (const [name, want] of Object.entries(EXPECTED)) {
    describe(name, () => {
      const fx = load(name);
      const { event } = normalizeSwap(fx.tx, fx.mint);

      it(`classifies as ${want.kind}`, () => {
        expect(event).not.toBeNull();
        expect(event?.kind).toBe(want.kind);
      });

      it('attributes the right wallet', () => {
        const who = event?.kind === 'buy' ? event.buyer : event?.kind === 'sell' ? event.seller : null;
        expect(who).toBe(want.who);
      });

      it('extracts exact amounts', () => {
        expect(event?.tokensRaw).toBe(want.tokensRaw);
        expect(event?.quoteRaw).toBe(want.quoteRaw);
        expect(event?.quoteSymbol).toBe(want.quoteSymbol);
      });

      it('captures exact absolute balances', () => {
        expect(event?.balanceBeforeRaw).toBe(want.balanceBeforeRaw);
        expect(event?.balanceAfterRaw).toBe(want.balanceAfterRaw);
      });

      // The invariant that guards every whale call.
      it('satisfies the delta invariant (after - before === ±tokensRaw)', () => {
        const delta = (event as { balanceAfterRaw: bigint }).balanceAfterRaw -
          (event as { balanceBeforeRaw: bigint }).balanceBeforeRaw;
        const signed = want.kind === 'buy' ? want.tokensRaw : -want.tokensRaw;
        expect(delta).toBe(signed);
      });
    });
  }

  /**
   * PHASE 4.6: a transfer is a first-class RESULT, not a null.
   *
   * It is still not a buy and it is still never posted — the live path filters it out
   * (see BaseIngestor). But it is a real thing that happened, and reporting it as
   * `null` is what forced the backfiller to carry a SECOND parser just to see the
   * airdrops and outbound sends this one was throwing away. Two parsers means two
   * classifications of one transaction, which is how a wallet double-counts.
   */
  it('classifies a plain SPL transfer as a transfer — not a buy, and not nothing', () => {
    const fx = load('spl-transfer');
    const { event } = normalizeSwap(fx.tx, fx.mint);

    expect(event?.kind).toBe('transfer');
    const t = event as Extract<typeof event, { kind: 'transfer' }>;

    expect(t.direction === 'in' || t.direction === 'out').toBe(true);
    expect(t.tokensRaw).toBeGreaterThan(0n); // always positive; direction carries the sign
    expect(t.balanceAfterRaw - t.balanceBeforeRaw).toBe(
      t.direction === 'in' ? t.tokensRaw : -t.tokensRaw,
    );
  });

  it('null now means ONLY "this transaction does not touch the mint"', () => {
    const fx = load('spl-transfer');
    const { event, reason } = normalizeSwap(fx.tx, 'NotTheMint1111111111111111111111111111111111');

    expect(event).toBeNull();
    expect(reason).toBe('no-mint-movement');
  });

  /**
   * THE PHASE 2.5 BUG, as a fixture.
   *
   * A real Jupiter swap paid from a USDC balance. The route goes through SOL
   * internally, but the BUYER's deltas are: USDC -20.000000, target mint +29200568,
   * and SOL FLAT — both wSOL and native SOL are exactly 0.
   *
   * The old SOL-only rule therefore computed quoteSpent = 0 and dropped this as
   * 'no-quote-movement'. It is not an exotic case; it is an ordinary user paying
   * from the stablecoin they already hold.
   */
  it('classifies a USDC-quoted buy that the SOL-only rule silently ate', () => {
    const fx = load('buy-usdc-quoted');
    const { event } = normalizeSwap(fx.tx, fx.mint);

    expect(event?.kind).toBe('buy');
    const buy = event as Extract<typeof event, { kind: 'buy' }>;

    expect(buy.quoteSymbol).toBe('USDC');
    expect(buy.quoteMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(buy.quoteRaw).toBe(20_000_000n); // 20.000000 USDC at 6dp
    expect(buy.tokensRaw).toBe(29_200_568n);
    expect(buy.buyer).toBe('5QLpP6UH7jEXEnZUrxZmRTWGa6Ajmum5ei62JvBHFCiL');

    // The delta invariant still holds on the USDC path.
    expect(buy.balanceAfterRaw - buy.balanceBeforeRaw).toBe(buy.tokensRaw);
  });

  it("the USDC buyer's SOL delta really is flat — proving the old rule dropped it", () => {
    const fx = load('buy-usdc-quoted');
    const meta = fx.tx.meta!;
    const buyer = '5QLpP6UH7jEXEnZUrxZmRTWGa6Ajmum5ei62JvBHFCiL';
    const WSOL = 'So11111111111111111111111111111111111111112';

    const wsolDelta = [...(meta.postTokenBalances ?? [])]
      .filter((b) => b.mint === WSOL && b.owner === buyer)
      .reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n) -
      [...(meta.preTokenBalances ?? [])]
        .filter((b) => b.mint === WSOL && b.owner === buyer)
        .reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);

    // No wSOL movement whatsoever for the buyer. The old rule had nothing to see.
    expect(wsolDelta).toBe(0n);
  });

  /**
   * The other side of the boundary. This tx gains RICE by giving up a DIFFERENT
   * non-quote token — a token->token arb. No registry asset was paid out, so it is
   * not a buy, and widening the quote rule must NOT have turned it into one.
   */
  it('still never calls a token->token arb a BUY — the boundary holds', () => {
    const fx = load('token-to-token-arb');
    const { event } = normalizeSwap(fx.tx, fx.mint);

    // THE ASSERTION THAT MATTERS, unchanged since Phase 2.5: widening the quote rule must not
    // turn an arb into a buy. It never becomes one.
    expect(event?.kind).not.toBe('buy');

    // Post-signer-rule it is null: no SIGNER's balance of the mint moved here either, so it is
    // not the signer's trade. The backfill still sees it, because that path is wallet-scoped and
    // asks a different question ("what did THIS wallet do here").
    expect(event).toBeNull();
  });

  /**
   * REGRESSION — this one reached a live group as SILENCE. A real $48.13 buy of $RICE was
   * ingested, priced at "<$0.01", dropped under the $10 floor, and folded into cost basis as
   * very nearly free. Nothing was logged as wrong: from `deliveredToday: 0` alone it is
   * indistinguishable from a genuine dust buy, which is what made it survive.
   *
   * A DFlow route paid in Plakoro. The buyer never touched the wSOL the route passed through, so
   * their ONLY registry outflow is -6,000 lamports of routing dust — and `dominantQuote` faithfully
   * returned it. The fill leg is where the money is.
   *
   * The expected values below were derived independently from the raw JSON (owner-keyed balance
   * diff, computed before the fix was written), not read back out of the normalizer.
   */
  it('prices a token-for-token route from the fill leg, not the buyer dust', () => {
    const fx = load('buy-token-for-token-route');
    const { event } = normalizeSwap(fx.tx, fx.mint as Mint, { solUsd: 78.35 });

    expect(event?.kind).toBe('buy');
    expect(event && 'buyer' in event && event.buyer).toBe('aFFsiWtY3tfiGV6WCASG7onrk2fbRdagt5DMAMeNzSX');
    expect(event?.tokensRaw).toBe(775_208_679_335n);

    // The pool that paid out the RICE took 0.615229634 wSOL in. THAT is what the tokens cost.
    expect(event?.quoteSymbol).toBe('SOL');
    expect(event?.quoteRaw).toBe(615_229_634n);

    // ~$48 at the SOL price of the block — not the $0.0005 that got it dropped. The floor is $10,
    // so this single number is the whole difference between a card and silence.
    const usd = (Number(event?.quoteRaw) / 1e9) * 78.35;
    expect(usd).toBeGreaterThan(45);
    expect(usd).toBeLessThan(50);
  });

  /**
   * NOT VACUOUS. Proves the buyer's own registry outflow really was dust — i.e. that the old rule
   * genuinely had nothing to see, and this fixture is not passing for some unrelated reason.
   *
   * Mirrors the USDC test above ("the USDC buyer's SOL delta really is flat"), and for the same
   * reason: a boundary test that cannot fail against the old code proves nothing about the fix.
   */
  it("the token-for-token buyer's own registry outflow really is dust — 6,000 lamports", () => {
    const fx = load('buy-token-for-token-route');
    const buyer = 'aFFsiWtY3tfiGV6WCASG7onrk2fbRdagt5DMAMeNzSX';
    const meta = fx.tx.meta as NonNullable<ConfirmedTx['meta']>;
    const keys = fx.tx.transaction.message.accountKeys as unknown[];
    const idx = keys.findIndex((k) => (typeof k === 'object' ? (k as { pubkey: string }).pubkey : k) === buyer);

    // Fee added back, exactly as nativeDeltas does: what they SPENT, not what gas cost.
    const native = BigInt(meta.postBalances[idx] as number) - BigInt(meta.preBalances[idx] as number) + BigInt(meta.fee);
    expect(native).toBe(-6_000n);

    // And they hold no wSOL token account here at all — the route's wSOL never was theirs.
    const buyerWsol = [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])].filter(
      (b) => b.owner === buyer && b.mint === 'So11111111111111111111111111111111111111112',
    );
    expect(buyerWsol).toHaveLength(0);

    // 6,000 lamports is ~$0.0005. Under every floor there is; that is why the buy vanished.
    expect((6_000 / 1e9) * 78.35).toBeLessThan(0.01);
  });
});

/**
 * FIXTURE COHERENCE.
 *
 * Every fixture must describe a transaction that could actually have happened on
 * chain. A buy of 27.3 billion tokens cannot report `balanceAfterRaw = 0`.
 *
 * This matters more than it looks. An incoherent fixture will happily pass a fold
 * that a real transaction would break — it lets a test certify arithmetic that
 * reality never has to satisfy. (Phase 4.5 found exactly that: a fixture whose buy
 * claimed a post-balance of zero, which the old clobbering backfiller hid.)
 */
describe('fixture coherence — every fixture must be physically possible', () => {
  // Only the VERIFIED trades. The six impostors have no event to be coherent about: no signer's
  // balance of the mint moved in them, which is precisely why they are not the signer's trade.
  const FIXTURES = [
    // The three VERIFIED buys (signer gained the mint; the gainer is a system-owned wallet).
    'buy-pumpfun-bonding-curve',
    'buy-pumpswap',
    'buy-usdc-quoted',
    // Verified sells (signer dumped the mint into a pool).
    'buy-whale-existing-balance',
    'sell-misread-as-buy',
    'spl-transfer',
  ];

  for (const name of FIXTURES) {
    it(`${name}: balanceAfter - balanceBefore === the signed token movement`, () => {
      const fx = load(name);
      const { event } = normalizeSwap(fx.tx, fx.mint);
      expect(event).not.toBeNull();

      const e = event!;
      const signed =
        e.kind === 'buy' || (e.kind === 'transfer' && e.direction === 'in') ? e.tokensRaw : -e.tokensRaw;

      // THE identity. It is what makes `balanceAfterRaw` usable as the reconciliation
      // checkpoint at all: if it did not hold, drift would be measuring nothing.
      expect(e.balanceAfterRaw - e.balanceBeforeRaw).toBe(signed);

      // A balance is a quantity of tokens. It cannot be negative.
      expect(e.balanceBeforeRaw >= 0n).toBe(true);
      expect(e.balanceAfterRaw >= 0n).toBe(true);

      // Tokens moved is always POSITIVE — direction is carried by the kind, never by
      // the sign (a TEXT bigint has no reliable sign in SQLite).
      expect(e.tokensRaw > 0n).toBe(true);
    });
  }

  it('the captured $RICE wallet history is coherent end to end', () => {
    const fx = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'wallet-rice-history.json'), 'utf8'),
    ) as { wallet: string; mint: string; onchainRaw: string; txs: ConfirmedTx[] };

    // Replaying the wallet's whole history must land on the balance the chain
    // independently reports. If it does not, the fixture is not a real wallet.
    let running = 0n;
    const ordered = [...fx.txs].sort((a, b) => a.slot - b.slot);

    for (const tx of ordered) {
      const e = normalizeSwap(tx, fx.mint, { wallet: fx.wallet }).event;
      if (!e) continue;

      expect(e.balanceBeforeRaw).toBe(running); // each tx starts where the last ended
      const signed =
        e.kind === 'buy' || (e.kind === 'transfer' && e.direction === 'in') ? e.tokensRaw : -e.tokensRaw;
      running += signed;
      expect(e.balanceAfterRaw).toBe(running);
    }

    expect(running).toBe(BigInt(fx.onchainRaw));
  });
});

describe('dominant quote (never a sum)', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const WSOL = 'So11111111111111111111111111111111111111112';
  const TARGET = 'TARGETmintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const BUYER = 'BuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  /**
   * Synthetic, because the real chain does not hand you a clean isolated example
   * of "USDC payment plus lamport dust" on demand. The FIXTURES cover reality;
   * this covers the arithmetic rule.
   */
  const tx = (opts: { usdc: bigint; solDust: bigint }): ConfirmedTx => ({
    slot: 1,
    blockTime: 1,
    transaction: {
      message: {
        accountKeys: [
          { pubkey: BUYER, signer: true, writable: true },
          { pubkey: 'PoolAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', signer: false, writable: true },
        ],
      },
      signatures: ['sig-dominant'],
    },
    meta: {
      err: null,
      fee: 5_000,
      // Buyer loses `solDust` lamports of ATA rent; fee is added back by the parser.
      preBalances: [1_000_000_000, 0],
      postBalances: [1_000_000_000 - 5_000 - Number(opts.solDust), 0],
      preTokenBalances: [
        { accountIndex: 2, mint: USDC, owner: BUYER, uiTokenAmount: { amount: '500000000', decimals: 6 } },
      ],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint: USDC,
          owner: BUYER,
          uiTokenAmount: { amount: String(500_000_000n - opts.usdc), decimals: 6 },
        },
        { accountIndex: 3, mint: TARGET, owner: BUYER, uiTokenAmount: { amount: '1000000', decimals: 6 } },
      ],
    },
  });

  it('quotes ONLY the dominant leg — ATA rent dust is not counted as spend', () => {
    // Pays 100 USDC, and burns ~2039280 lamports (a real ATA rent figure) on the way.
    const { event } = normalizeSwap(tx({ usdc: 100_000_000n, solDust: 2_039_280n }), TARGET, { solUsd: 150 });

    expect(event?.kind).toBe('buy');
    expect(event?.quoteSymbol).toBe('USDC');

    // Exactly the USDC paid. NOT usdc + dust — summing would inflate what the buyer
    // spent, which corrupts priceUsd, which feeds market cap AND the whale test.
    expect(event?.quoteRaw).toBe(100_000_000n);
  });

  it('picks SOL when SOL is genuinely the larger leg', () => {
    // 1 USDC of dust against 1 SOL (~$150) of real payment.
    const { event } = normalizeSwap(tx({ usdc: 1_000_000n, solDust: 1_000_000_000n }), TARGET, { solUsd: 150 });

    expect(event?.quoteSymbol).toBe('SOL');
    expect(event?.quoteRaw).toBe(1_000_000_000n);
  });

  it('warns when a second leg exceeds 5% — a genuine multi-asset payment', () => {
    const warnings: unknown[] = [];
    const log = {
      warn: (obj: unknown) => void warnings.push(obj),
      debug: () => undefined,
      info: () => undefined,
      error: () => undefined,
    } as unknown as Parameters<typeof normalizeSwap>[2] extends { log?: infer L } ? L : never;

    // 100 USDC dominant, plus 0.1 SOL (~$15) — 15%, well over the 5% line.
    normalizeSwap(tx({ usdc: 100_000_000n, solDust: 100_000_000n }), TARGET, { solUsd: 150, log });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatchObject({
      dominant: { symbol: 'USDC' },
      secondary: { symbol: 'SOL' },
    });
  });

  it('stays quiet when the second leg is mere dust', () => {
    const warnings: unknown[] = [];
    const log = {
      warn: (obj: unknown) => void warnings.push(obj),
      debug: () => undefined,
      info: () => undefined,
      error: () => undefined,
    } as never;

    normalizeSwap(tx({ usdc: 100_000_000n, solDust: 2_039_280n }), TARGET, { solUsd: 150, log });
    expect(warnings).toEqual([]); // ~$0.31 of rent against $100 — not worth a line
  });

  it('never classifies a fixture against a mint it does not touch', () => {
    const fx = load('buy-pumpswap');
    const { event, reason } = normalizeSwap(fx.tx, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(event).toBeNull();
    expect(reason).toBe('no-mint-movement');
  });

  it('drops a failed transaction', () => {
    const fx = load('buy-pumpswap');
    const failed = { ...fx.tx, meta: { ...fx.tx.meta!, err: { InstructionError: [0, 'Custom'] } } };
    expect(normalizeSwap(failed as ConfirmedTx, fx.mint).reason).toBe('failed-tx');
  });

  it('does not count gas as buying pressure', () => {
    // The whale fixture spent 999_387 lamports on a ~5000-lamport-fee tx. If the
    // fee were being counted as spend, the figure would be higher by the fee.
    const fx = load('buy-whale-existing-balance');
    const { event } = normalizeSwap(fx.tx, fx.mint);
    const fee = BigInt(fx.tx.meta!.fee);

    expect(event?.quoteRaw).toBe(999_387n);
    expect(fee).toBeGreaterThan(0n);
    expect(event!.quoteRaw + fee).not.toBe(999_387n); // i.e. fee is genuinely excluded
  });

  /**
   * The wrong-whale guard, exercised the ONLY way it can genuinely fail.
   *
   * Note what does NOT work as a test here: naively adding a stray pre-balance row
   * for the buyer just shifts `before`, and since the owner-keyed delta is itself
   * `after - before`, the check stays satisfied. That was the first version of
   * this test and it was worthless — the assertion could never fire.
   *
   * A real divergence needs a token account whose OWNER differs between the pre
   * and post rows: the owner-keyed sums then attribute the two halves of one
   * account's movement to two different wallets, while the account-keyed pass
   * refuses to count it. That is the state we must never publish from.
   */
  it('drops an event whose owner-keyed and account-keyed balances disagree (wrong-whale guard)', () => {
    // buy-usdc-quoted's buyer already held a balance, so there is a PRE row to tamper. (A
    // new-holder buy has none — nothing to make incoherent.)
    const fx = load('buy-usdc-quoted');
    const buyer = (normalizeSwap(fx.tx, fx.mint).event as { buyer: string }).buyer;
    const meta = fx.tx.meta!;

    // Reassign the PRE row of the buyer's token account to a different owner, leaving the POST row
    // as theirs. The two independent derivations of tokensRaw now disagree — which is the exact
    // state the guard exists to catch, so a fabricated whale is never published.
    const preTampered = meta.preTokenBalances!.map((b) =>
      b.mint === fx.mint && b.owner === buyer
        ? { ...b, owner: 'ImposterWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
        : b,
    );

    const tampered: ConfirmedTx = { ...fx.tx, meta: { ...meta, preTokenBalances: preTampered } };

    const { event, reason } = normalizeSwap(tampered, fx.mint);
    expect(event).toBeNull();
    expect(reason).toBe('balance-mismatch');
  });

  it('the guard is not vacuous: the untampered fixture passes it', () => {
    // Pairs with the test above — proves the drop was caused by the tampering and not by
    // something incidental about the fixture.
    const fx = load('buy-usdc-quoted');
    expect(normalizeSwap(fx.tx, fx.mint).event).not.toBeNull();
  });
});

describe('toConfirmedTx — both transports produce the SAME shape', () => {
  it('unwraps a Helius transactionNotification into the RPC shape', () => {
    const fx = load('buy-pumpswap');
    // Helius nests tx+meta one level deeper and puts slot/signature on the envelope.
    const helius = {
      slot: fx.tx.slot,
      signature: fx.signature,
      blockTime: fx.tx.blockTime,
      transaction: { transaction: fx.tx.transaction, meta: fx.tx.meta },
    };

    const tx = toConfirmedTx(helius);
    expect(tx).not.toBeNull();

    // Crucially: the SAME normalizer, run on the unwrapped WS payload, must give
    // byte-identical results to the RPC payload. One interpretation, two transports.
    const viaWs = normalizeSwap(tx as ConfirmedTx, fx.mint).event;
    const viaRpc = normalizeSwap(fx.tx, fx.mint).event;
    expect(viaWs).toEqual(viaRpc);
  });

  it('rejects junk rather than throwing', () => {
    expect(toConfirmedTx(null)).toBeNull();
    expect(toConfirmedTx({})).toBeNull();
    expect(toConfirmedTx({ slot: 1 })).toBeNull();
  });
});

describe('SignatureLru', () => {
  it('reports a repeat and evicts oldest past capacity', () => {
    const lru = new SignatureLru(3);
    expect(lru.seen('a')).toBe(false);
    expect(lru.seen('a')).toBe(true);

    lru.seen('b');
    lru.seen('c');
    lru.seen('d'); // evicts the least-recently-used

    expect(lru.size).toBe(3);
    expect(lru.seen('d')).toBe(true);
  });

  it('refreshes recency so a hot signature is not evicted mid-replay', () => {
    const lru = new SignatureLru(2);
    lru.seen('a');
    lru.seen('b');
    lru.seen('a'); // 'a' becomes most recent -> 'b' is now the eviction target
    lru.seen('c');

    expect(lru.seen('a')).toBe(true);
    expect(lru.seen('b')).toBe(false); // evicted
  });
});

describe('Backoff', () => {
  it('ramps exponentially and caps at 30s', () => {
    const b = new Backoff(1_000, 30_000, () => 1); // rand=1 => full window
    const seen = [b.next(), b.next(), b.next(), b.next(), b.next(), b.next(), b.next()];
    expect(seen.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(seen[5]).toBe(30_000); // capped
    expect(seen[6]).toBe(30_000);
  });

  it('applies full jitter so reconnecting bots do not stampede in lockstep', () => {
    const b = new Backoff(1_000, 30_000, () => 0.5);
    expect(b.next()).toBe(500); // half the window, not the whole thing
  });

  it('resets after a healthy connection', () => {
    const b = new Backoff(1_000, 30_000, () => 1);
    b.next();
    b.next();
    b.reset();
    expect(b.next()).toBe(1_000);
  });
});
