import {
  QUOTE_REGISTRY,
  WSOL_MINT,
  approxUsd,
  type QuoteAssetDef,
} from '../core/quotes.js';
import type { BuyEvent, Mint, NormalizedEvent, SellEvent, TransferEvent, Wallet } from '../core/types.js';
import type { Logger } from '../ops/logger.js';
import type { AccountKey, ConfirmedTx, TokenBalance } from './solana-types.js';

/**
 * DEX-AGNOSTIC swap detection (INVARIANT 1).
 *
 * We never decode an instruction and we never look at a program id. We diff the
 * balances the transaction actually moved. That is why this works on pump.fun,
 * PumpSwap, Raydium, Meteora, Orca and any Jupiter route — including routes that
 * do not exist yet — with no code change, forever.
 *
 * The quote asset is resolved from the REGISTRY (core/quotes.ts), never named
 * here. A Jupiter swap paid from a USDC balance routes through SOL internally,
 * but the BUYER's deltas are USDC down, target-mint up, SOL flat — so a SOL-only
 * rule silently eats an ordinary user paying from the stablecoin they already
 * hold. That is the bug this file exists to not have.
 */

export type RejectReason =
  | 'failed-tx'
  | 'no-meta'
  | 'no-mint-movement'
  | 'no-quote-movement'
  | 'balance-mismatch'
  /** No SIGNER's balance of the mint moved — not the signer's trade. Pool routing, or a relayer. */
  | 'no-signing-actor';

export interface NormalizeResult {
  event: NormalizedEvent | null;
  reason?: RejectReason;
}

export interface NormalizeOpts {
  readonly log?: Logger;
  /** Live SOL/USD, used ONLY to rank competing quote legs. Never to price a buy. */
  readonly solUsd?: number | null;
  /**
   * Classify from ONE wallet's point of view instead of picking the transaction's
   * principal owner (Phase 4.6).
   *
   * This is what lets the backfiller reuse this exact function. It walks a wallet's
   * signatures, so it needs "what did THIS wallet do here", not "who was the buyer".
   * It is a different QUESTION of the same parser — not a second parser. There must
   * never be a second parser: two classifications of one transaction is how a wallet
   * double-counts.
   */
  readonly wallet?: Wallet;
}

interface OwnerDelta {
  delta: bigint;
  before: bigint;
  after: bigint;
}

const zero = (): OwnerDelta => ({ delta: 0n, before: 0n, after: 0n });
const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/** Full ordered account key list, INCLUDING addresses loaded from lookup tables. */
function accountKeyList(tx: ConfirmedTx): AccountKey[] {
  const raw = tx.transaction.message.accountKeys ?? [];
  if (raw.length > 0 && typeof raw[0] === 'object') return raw as AccountKey[];

  const statics = (raw as string[]).map((pubkey) => ({ pubkey, signer: false, writable: false }));
  const loaded = tx.meta?.loadedAddresses;
  const w = (loaded?.writable ?? []).map((pubkey) => ({ pubkey, signer: false, writable: true, source: 'lookupTable' }));
  const r = (loaded?.readonly ?? []).map((pubkey) => ({ pubkey, signer: false, writable: false, source: 'lookupTable' }));
  return [...statics, ...w, ...r];
}

/**
 * Native SOL delta per account pubkey.
 *
 * The fee payer's raw delta bundles gas in with whatever it spent:
 *   post = pre - fee - spent  =>  delta = -fee - spent
 * We add the fee back so gas is not mistaken for buying pressure.
 */
function nativeDeltas(tx: ConfirmedTx, keys: AccountKey[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const meta = tx.meta;
  if (!meta) return out;

  const feePayer = keys[0]?.pubkey;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const pre = meta.preBalances[i];
    const post = meta.postBalances[i];
    if (!key || pre === undefined || post === undefined) continue;

    let delta = BigInt(post) - BigInt(pre);
    if (key.pubkey === feePayer) delta += BigInt(meta.fee);
    out.set(key.pubkey, (out.get(key.pubkey) ?? 0n) + delta);
  }
  return out;
}

/** Per-owner token deltas AND absolute balances, for one mint. */
function tokenDeltas(pre: TokenBalance[], post: TokenBalance[], mint: Mint): Map<string, OwnerDelta> {
  const out = new Map<string, OwnerDelta>();
  const bump = (owner: string | undefined, amount: bigint, side: 'before' | 'after'): void => {
    if (!owner) return;
    const cur = out.get(owner) ?? zero();
    cur[side] += amount;
    out.set(owner, cur);
  };

  for (const b of pre) if (b.mint === mint) bump(b.owner, BigInt(b.uiTokenAmount.amount), 'before');
  for (const b of post) if (b.mint === mint) bump(b.owner, BigInt(b.uiTokenAmount.amount), 'after');
  for (const v of out.values()) v.delta = v.after - v.before;
  return out;
}

/**
 * Independent second derivation of an owner's movement, keyed by ACCOUNT INDEX
 * rather than by owner. See the wrong-whale guard below — without a genuinely
 * separate path, that check is a tautology and can never fire.
 */
function movementByAccount(pre: TokenBalance[], post: TokenBalance[], mint: Mint, owner: string): bigint {
  const preByIdx = new Map<number, TokenBalance>();
  const postByIdx = new Map<number, TokenBalance>();
  for (const b of pre) if (b.mint === mint) preByIdx.set(b.accountIndex, b);
  for (const b of post) if (b.mint === mint) postByIdx.set(b.accountIndex, b);

  let delta = 0n;
  for (const idx of new Set([...preByIdx.keys(), ...postByIdx.keys()])) {
    const p = preByIdx.get(idx);
    const q = postByIdx.get(idx);
    const preOwner = p?.owner;
    const postOwner = q?.owner;
    if (preOwner !== undefined && preOwner !== owner) continue;
    if (postOwner !== undefined && postOwner !== owner) continue;
    if (preOwner === undefined && postOwner === undefined) continue;

    delta += (q ? BigInt(q.uiTokenAmount.amount) : 0n) - (p ? BigInt(p.uiTokenAmount.amount) : 0n);
  }
  return delta;
}

/** One owner's net movement in one registry quote asset. */
interface QuoteLeg {
  readonly def: QuoteAssetDef;
  /** Signed. Negative = the owner paid it out. */
  readonly delta: bigint;
}

/**
 * Every registry quote asset, netted per owner.
 *
 * Native SOL folds into the wSOL entry: they are one asset, reported by the chain
 * in two places.
 */
function quoteLegsByOwner(
  pre: TokenBalance[],
  post: TokenBalance[],
  sol: Map<string, bigint>,
): Map<string, QuoteLeg[]> {
  const byOwner = new Map<string, Map<Mint, bigint>>();

  const add = (owner: string, mint: Mint, delta: bigint): void => {
    if (delta === 0n) return;
    const legs = byOwner.get(owner) ?? new Map<Mint, bigint>();
    legs.set(mint, (legs.get(mint) ?? 0n) + delta);
    byOwner.set(owner, legs);
  };

  // Iterate the REGISTRY. No asset is named here.
  for (const def of QUOTE_REGISTRY) {
    for (const [owner, d] of tokenDeltas(pre, post, def.mint)) add(owner, def.mint, d.delta);
  }
  for (const [owner, delta] of sol) add(owner, WSOL_MINT, delta);

  const out = new Map<string, QuoteLeg[]>();
  for (const [owner, legs] of byOwner) {
    const list: QuoteLeg[] = [];
    for (const [mint, delta] of legs) {
      const def = QUOTE_REGISTRY.find((q) => q.mint === mint);
      if (def && delta !== 0n) list.push({ def, delta });
    }
    if (list.length > 0) out.set(owner, list);
  }
  return out;
}

/**
 * THE DOMINANT QUOTE.
 *
 * Take the LARGEST leg by USD value. Do NOT sum the legs: a buyer paying in USDC
 * also pays a few thousand lamports of ATA rent, and summing would book that dust
 * as part of what they spent. That corrupts priceUsd, which feeds market cap AND
 * the whale test — one bad line item poisons three numbers.
 *
 * `want` selects the side: 'out' for a buy (they paid), 'in' for a sell.
 *
 * If a SECOND leg exceeds 5% of the dominant one, that is a genuine multi-asset
 * payment and we are about to under-report it. Warn, with both legs, rather than
 * silently quoting only the larger.
 */
function dominantQuote(
  legs: QuoteLeg[],
  want: 'out' | 'in',
  solUsd: number | null,
  ctx: { signature: string; mint: Mint; owner: string },
  log?: Logger,
): { def: QuoteAssetDef; raw: bigint } | null {
  const wanted = legs.filter((l) => (want === 'out' ? l.delta < 0n : l.delta > 0n));
  if (wanted.length === 0) return null;

  const ranked = wanted
    .map((l) => ({ leg: l, usd: approxUsd(l.def, l.delta, solUsd) }))
    .sort((a, b) => b.usd - a.usd);

  const top = ranked[0] as { leg: QuoteLeg; usd: number };
  const second = ranked[1];

  if (second && top.usd > 0 && second.usd / top.usd > 0.05) {
    log?.warn(
      {
        ...ctx,
        dominant: { symbol: top.leg.def.symbol, usd: Number(top.usd.toFixed(2)) },
        secondary: { symbol: second.leg.def.symbol, usd: Number(second.usd.toFixed(2)) },
      },
      'multi-asset payment: quoting only the dominant leg, so this buy is under-reported',
    );
  }

  return { def: top.leg.def, raw: abs(top.leg.delta) };
}

export function normalizeSwap(tx: ConfirmedTx, mint: Mint, opts: NormalizeOpts = {}): NormalizeResult {
  const log = opts.log;
  const solUsd = opts.solUsd ?? null;

  const meta = tx.meta;
  if (!meta) return { event: null, reason: 'no-meta' };
  if (meta.err !== null && meta.err !== undefined) return { event: null, reason: 'failed-tx' };

  const keys = accountKeyList(tx);
  const signers = new Set(keys.filter((k) => k.signer).map((k) => k.pubkey));

  const preTok = meta.preTokenBalances ?? [];
  const postTok = meta.postTokenBalances ?? [];

  const mintDeltas = tokenDeltas(preTok, postTok, mint);
  const legsByOwner = quoteLegsByOwner(preTok, postTok, nativeDeltas(tx, keys));

  const signature = tx.transaction.signatures[0] ?? '';
  const blockTime = tx.blockTime ?? null;

  const legsOf = (owner: string): QuoteLeg[] => legsByOwner.get(owner) ?? [];

  // Everyone whose balance of the mint actually moved. When a wallet is named, that
  // is the ONLY candidate: we are answering "what did this wallet do here".
  const movers = [...mintDeltas.entries()].filter(
    ([owner, d]) => d.delta !== 0n && (opts.wallet === undefined || owner === opts.wallet),
  );
  if (movers.length === 0) return { event: null, reason: 'no-mint-movement' };

  /**
   * THE TRADER SIGNS. A POOL CANNOT.
   *
   * "Gained the mint AND gave up quote" was never a description of a buyer. It describes ONE SIDE
   * OF ANY TRADE — and on a SELL, that side is the AMM POOL: it receives the tokens being dumped
   * and pays out SOL, matching the old buyer rule exactly.
   *
   * Signature 4u4ccxck… : the fee payer dumped 898,469 RICE for 1.03 SOL and the pump AMM pool
   * vault took the RICE and paid the SOL. The pool was the ONLY owner matching, so it was crowned
   * the buyer and a live group was told "🐳 WHALE BUY!" about a liquidity pool. `pickOwner`
   * PREFERRED a signer but fell back to whoever was left — and with one candidate there is nothing
   * to prefer. A preference is not a constraint.
   *
   * WHY THE TESTS DID NOT CATCH IT: they were captured by this same rule. Five of the eight
   * `buy-*` fixtures are not buys at all — in each, the account that "gained the mint" is a
   * program-owned pool PDA (pump AMM, Orca Whirlpool, Meteora DLMM) and the signer either lost the
   * mint or never touched it. The suite was green because it asserted the bug.
   *
   * The three genuine buys (pumpfun-bonding-curve, pumpswap, usdc-quoted) share exactly one
   * property that all five fakes lack: THE SIGNER GAINED THE MINT.
   *
   * So a trade belongs to whoever SIGNED for it. A human signs the transaction that moves their
   * own money; a pool authority is a PDA and can never sign. This makes "the pool is the buyer"
   * structurally unrepresentable rather than merely unlikely — and it needs no per-DEX decoder
   * (INVARIANT 1), no pool registry, and no RPC lookup.
   *
   * THE COST: a buy executed by a vault or smart wallet that does not itself sign is not posted.
   * That is the right side of the trade-off, and the same one the wrong-whale guard makes: a
   * missed post is cheap and nobody sees it; a fabricated one is a screenshot.
   *
   * The wallet-scoped path (backfill) is EXEMPT — it asks "what did THIS wallet do here", where
   * the wallet is given rather than inferred, and an airdrop recipient signs nothing.
   */
  const actors = opts.wallet !== undefined ? movers : movers.filter(([owner]) => signers.has(owner));

  // No signer's balance of this mint moved: whatever happened here, it is not the signer's trade.
  // It is pool-to-pool routing, or a relayer-executed swap we cannot attribute. Say so rather than
  // guessing an owner out of the deltas — guessing is what put a pool on a WHALE BUY card.
  if (actors.length === 0 && opts.wallet === undefined) {
    return { event: null, reason: 'no-signing-actor' };
  }

  // --- buy: gained the mint AND paid out at least one registry quote ----------
  const buyers = actors.filter(([owner, d]) => d.delta > 0n && legsOf(owner).some((l) => l.delta < 0n));

  if (buyers.length > 0) {
    const owner = pickOwner(buyers, signers);
    const d = mintDeltas.get(owner) as OwnerDelta;

    let quote = dominantQuote(legsOf(owner), 'out', solUsd, { signature, mint, owner }, log);

    // Did they pay in a token the registry cannot price? Then the registry outflow above is
    // NOT the payment — it is routing dust — and the real figure is on the other side of the
    // fill. See routedQuote.
    if (counterLegs(preTok, postTok, mint, owner).some((c) => c.delta < 0n)) {
      const routed = routedQuote(mintDeltas, legsOf, owner, solUsd, { signature, mint }, log);
      const dust = quote ? approxUsd(quote.def, quote.raw, solUsd) : 0;
      const filled = routed ? approxUsd(routed.def, routed.raw, solUsd) : 0;

      if (routed && filled > dust) {
        log?.info(
          {
            signature,
            mint,
            owner,
            buyerLeg: quote ? { symbol: quote.def.symbol, usd: Number(dust.toFixed(4)) } : null,
            filledLeg: { symbol: routed.def.symbol, usd: Number(filled.toFixed(2)) },
          },
          'token-for-token route: priced from the fill leg, not the buyer dust',
        );
        quote = routed;
      }
    }

    if (!quote || quote.raw === 0n) return { event: null, reason: 'no-quote-movement' };

    if (!balancesAgree(d, movementByAccount(preTok, postTok, mint, owner), signature, mint, owner, log)) {
      return { event: null, reason: 'balance-mismatch' };
    }

    const event: BuyEvent = {
      kind: 'buy',
      signature,
      slot: tx.slot,
      blockTime,
      mint,
      buyer: owner,
      quoteMint: quote.def.mint,
      quoteSymbol: quote.def.symbol,
      quoteRaw: quote.raw,
      tokensRaw: d.delta,
      balanceBeforeRaw: d.before,
      balanceAfterRaw: d.after,
    };
    return { event };
  }

  // --- sell: gave up the mint AND received a registry quote -------------------
  // Symmetric, from the same `actors` set: on a BUY the pool is the one LOSING the mint and
  // gaining quote, so gating buys and not sells would simply relocate the bug.
  const sellers = actors.filter(([owner, d]) => d.delta < 0n && legsOf(owner).some((l) => l.delta > 0n));

  if (sellers.length > 0) {
    const owner = pickOwner(sellers, signers, true);
    const d = mintDeltas.get(owner) as OwnerDelta;

    const quote = dominantQuote(legsOf(owner), 'in', solUsd, { signature, mint, owner }, log);
    if (!quote || quote.raw === 0n) return { event: null, reason: 'no-quote-movement' };

    if (!balancesAgree(d, movementByAccount(preTok, postTok, mint, owner), signature, mint, owner, log)) {
      return { event: null, reason: 'balance-mismatch' };
    }

    const event: SellEvent = {
      kind: 'sell',
      signature,
      slot: tx.slot,
      blockTime,
      mint,
      seller: owner,
      quoteMint: quote.def.mint,
      quoteSymbol: quote.def.symbol,
      quoteRaw: quote.raw,
      tokensRaw: abs(d.delta),
      balanceBeforeRaw: d.before,
      balanceAfterRaw: d.after,
    };
    return { event };
  }

  // --- transfer: the mint moved, but NO quote leg on either side ---------------
  //
  // Not a buy, and not nothing. An airdrop lands here; so does a wallet sending its
  // bag away. Both are invisible to the pricing path and both are exactly what makes
  // a wallet's ledger disagree with the chain, so the backfill needs them.
  //
  // A token-for-token swap (gained the mint, gave up some NON-registry token) also
  // lands here. It was NOT free, but we cannot price the leg we were paid in, so it
  // is booked at zero cost — the same treatment the old backfill parser gave it.
  // That understates the basis, and the wallet stays honest by staying unreconciled
  // rather than by us guessing a number.
  const owner = pickOwner(movers, signers, true);
  const d = mintDeltas.get(owner) as OwnerDelta;

  if (!balancesAgree(d, movementByAccount(preTok, postTok, mint, owner), signature, mint, owner, log)) {
    return { event: null, reason: 'balance-mismatch' };
  }

  const direction = d.delta > 0n ? 'in' : 'out';

  // PHASE 4.7: is this a FREE RECEIPT, or a PURCHASE we cannot value?
  //
  // Both look like "the mint moved, no quote leg". They are nothing alike:
  //
  //   in,  no counter-leg  -> an airdrop. It really was free; usd_value 0 is the TRUTH.
  //   in,  counter-leg     -> they PAID, in a token we cannot price. Zero cost is a LIE.
  //   out, counter-leg     -> they SOLD into a token we cannot price. Realized PnL is
  //                           unknowable, so we must not book one.
  //
  // This is decided HERE, in the parser, because this is the only place every delta for
  // the wallet is in one hand. Downstream sees a row, not a transaction.
  const counter = counterLegs(preTok, postTok, mint, owner);
  const unpriced = counter.some((c) => (direction === 'in' ? c.delta < 0n : c.delta > 0n));

  if (unpriced && log) {
    log.debug(
      { signature, mint, owner, direction, counterparty: counter[0]?.mint },
      'transfer against an unvaluable token: basis is unpriceable, Position % will abstain',
    );
  }

  const event: TransferEvent = {
    kind: 'transfer',
    signature,
    slot: tx.slot,
    blockTime,
    mint,
    wallet: owner,
    direction,
    tokensRaw: abs(d.delta),
    balanceBeforeRaw: d.before,
    balanceAfterRaw: d.after,
    unpriced,
  };
  return { event };
}

/**
 * Every OTHER token this owner moved — not the target mint, and not a registry quote
 * (a registry quote would have made this a buy or a sell, so by here there are none).
 *
 * What is left is the unvaluable stuff: the counterparty token of an arb, an LP token,
 * some random SPL. We do not try to price it — we only need to know it EXISTS, because
 * its existence is what tells us the tokens were not free.
 */
function counterLegs(
  pre: TokenBalance[],
  post: TokenBalance[],
  mint: Mint,
  owner: string,
): Array<{ mint: Mint; delta: bigint }> {
  const isQuote = new Set<Mint>(QUOTE_REGISTRY.map((q) => q.mint));
  const totals = new Map<Mint, bigint>();

  const bump = (b: TokenBalance, sign: bigint): void => {
    if (b.owner !== owner) return;
    if (b.mint === mint || isQuote.has(b.mint)) return;
    totals.set(b.mint, (totals.get(b.mint) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  };

  for (const b of pre) bump(b, -1n);
  for (const b of post) bump(b, 1n);

  return [...totals].filter(([, delta]) => delta !== 0n).map(([m, delta]) => ({ mint: m, delta }));
}

/**
 * THE FILL LEG: what the counterparty took in, for a buy paid in a token we cannot price.
 *
 * An aggregator route paid from an unregistered SPL token — Plakoro -> wSOL -> RICE, DFlow or
 * Jupiter — never puts the wSOL in the BUYER's hands. Their whole registry outflow is a few
 * thousand lamports of routing dust, so `dominantQuote` priced a $48 buy at $0.0005: under every
 * `min_buy_usd` floor, no card, and folded into cost basis as very nearly free. Signature
 * X6BCc3aY… is a real one — 775,208 RICE in, 1.61M Plakoro out, native SOL delta -6,000 lamports.
 *
 * The value is on-chain regardless, one row further down the same balance diff: whoever PAID OUT
 * the mint took the real quote IN. There, the pump AMM pool, -775,208 RICE and +0.6152 wSOL.
 *
 * THIS IS NOT PRICING THE UNVALUABLE LEG (INVARIANT 13). We never guess a USD price for Plakoro.
 * We read the wSOL the fill actually moved and price it off the same SOL feed as any other buy —
 * a registry asset, a real amount, from the same transaction. What the buyer handed over remains
 * unvalued and unguessed; what the mint COST is a different quantity, and that one is a fact.
 *
 * Still pure balance-delta (INVARIANT 1): no program id, no router list, no RPC call.
 *
 * Only consulted when the buyer spent a non-registry token, so an ordinary SOL or USDC buy never
 * reaches it. When both legs are real the larger wins, which keeps the dominant-quote rule intact.
 */
function routedQuote(
  mintDeltas: Map<string, OwnerDelta>,
  legsOf: (owner: string) => QuoteLeg[],
  buyer: string,
  solUsd: number | null,
  ctx: { signature: string; mint: Mint },
  log?: Logger,
): { def: QuoteAssetDef; raw: bigint } | null {
  // Whoever gave up the mint filled this buy. Several may qualify on a split route; the one that
  // gave up the MOST of it is the fill this buyer's tokens actually came out of.
  const sources = [...mintDeltas.entries()].filter(([owner, d]) => owner !== buyer && d.delta < 0n);
  if (sources.length === 0) return null;

  const source = sources.reduce((a, b) => (abs(b[1].delta) > abs(a[1].delta) ? b : a))[0];
  return dominantQuote(legsOf(source), 'in', solUsd, { ...ctx, owner: source }, log);
}

/**
 * Aggregator routes leave several owners holding a positive delta of the mint —
 * the buyer, plus pool/vault PDAs mid-route. Pool authorities are PDAs and can
 * never sign, so: prefer a signer, then take the largest movement.
 */
function pickOwner(candidates: Array<[string, OwnerDelta]>, signers: Set<string>, byMagnitude = false): string {
  const size = (d: OwnerDelta): bigint => (byMagnitude ? abs(d.delta) : d.delta);
  const best = (list: Array<[string, OwnerDelta]>): string =>
    list.reduce((a, b) => (size(b[1]) > size(a[1]) ? b : a))[0];

  const signing = candidates.filter(([owner]) => signers.has(owner));
  return signing.length > 0 ? best(signing) : best(candidates);
}

/**
 * The owner-keyed sums and the account-keyed sums are two independent
 * derivations, so they must agree. When they do not, the balance rows do not
 * describe one coherent wallet and we would be about to publish a WRONG whale
 * call. Drop it. A missed post is cheap; a fabricated "🐳 WHALE BUY" is not.
 */
function balancesAgree(
  d: OwnerDelta,
  crossCheck: bigint,
  signature: string,
  mint: string,
  owner: string,
  log?: Logger,
): boolean {
  if (d.after - d.before === crossCheck) return true;
  log?.warn(
    {
      signature,
      mint,
      owner,
      before: d.before.toString(),
      after: d.after.toString(),
      ownerKeyedDelta: (d.after - d.before).toString(),
      accountKeyedDelta: crossCheck.toString(),
    },
    'balance delta invariant violated; dropping event rather than posting a wrong whale call',
  );
  return false;
}
