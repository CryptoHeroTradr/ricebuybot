#!/usr/bin/env node
/**
 * Phase 7 acceptance: DRY_RUN cards from REAL $RICE chain data.
 *
 *   node scripts/dry-run-cards.ts
 *
 * Pulls recent transactions for the mint straight off Helius RPC, runs them through the
 * SAME normalizeSwap the live socket uses, prices them at the live SOL/USD, and renders
 * the card the bot would post — through the real fan-out, the real tier chain, the real
 * media pool and the real DryRunSender. It sends nothing (INVARIANT 7).
 *
 * WHY THIS EXISTS RATHER THAN "point it at the websocket": the Enhanced WebSocket
 * (atlas-mainnet, transactionSubscribe) answers 401 on this Helius plan. The RPC key is
 * fine — `getHealth` returns ok — so the *data* is reachable even though the *stream* is
 * not. This harness therefore exercises everything downstream of the socket on real
 * transactions, which is the part Phase 7 actually added.
 *
 * It also renders one synthetic card per tier, so the headline/tier mapping can be read
 * off at a glance without waiting for a whale to show up on chain.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { normalizeSwap } from '../src/ingest/normalize.ts';
import { derivePricing } from '../src/pricing/derive.ts';
import { quoteAssetFor } from '../src/pricing/quote.ts';
import { FsMediaPool, LocalFsSource } from '../src/media/index.ts';
import { DeliveryQueue, DryRunSender, fanOut } from '../src/telegram/index.ts';
import { pickTier, DEFAULT_TIER_POLICY } from '../src/core/tiers.ts';
import { toFloat, rawAmount } from '../src/core/money.ts';
import { createLogger } from '../src/ops/logger.ts';
import type { BuyEvent, ChatId, Mint, TokenMeta, Wallet } from '../src/core/types.ts';

const MINT = (process.env.DEFAULT_MINT ?? '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump') as Mint;
const RPC = process.env.HELIUS_RPC_URL;
const CHAT = -1001234567890 as ChatId;

/**
 * --fixtures runs against the REAL captured transactions in test/fixtures/ instead of
 * hitting the chain. Same normalizeSwap, same pricing, same fan-out, same cards — it is
 * real chain data, it was just captured earlier.
 *
 * It exists because the Helius key in .env is DEAD (`getTokenSupply` -> "Invalid API
 * key"; the Enhanced WebSocket -> 401). Note that `getHealth` answers "ok" WITHOUT a
 * valid key, so it is useless as a liveness probe — that false positive cost a detour.
 */
const FIXTURES = process.argv.includes('--fixtures');

if (!RPC && !FIXTURES) {
  process.stderr.write('HELIUS_RPC_URL is required, or pass --fixtures\n');
  process.exit(1);
}

const log = createLogger((process.env.LOG_LEVEL ?? 'warn') as 'warn');

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC as string, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

/** Live SOL/USD, so the dollar figures on the cards are real. */
async function solUsd(): Promise<number> {
  const r = await fetch('https://api.binance.us/api/v3/ticker/bookTicker?symbol=SOLUSDT');
  const t = (await r.json()) as { bidPrice: string; askPrice: string };
  return (Number(t.bidPrice) + Number(t.askPrice)) / 2;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ricebuybot-dryrun-'));
  const repo = new SqliteRepo(join(dir, 'dry.db'), log);
  await repo.init();

  // --- a group watching $RICE, with the defaults it would really get ---------------
  await repo.upsertChat({ chatId: CHAT, title: 'DRY RUN', addedBy: 1, paused: false });
  const ct = await repo.addChatToken(CHAT, MINT); // links seed themselves: $RICE gets both sites

  // --- token metadata, from the chain (never hardcode "6 decimals, 1B supply") ------
  //
  // The flagship is 6dp but 982,048,494.78 supply — NOT 1B. Market cap is computed from
  // this number, so it is read from the chain. Under --fixtures we use the real figure
  // captured from the chain rather than inventing a round one.
  const supply = FIXTURES
    ? { value: { amount: '982048494780000', decimals: 6 } }
    : await rpc<{ value: { amount: string; decimals: number } }>('getTokenSupply', [MINT]);
  const token: TokenMeta = {
    mint: MINT,
    symbol: 'RICE',
    name: 'One Grain of Rice',
    decimals: supply.value.decimals,
    supplyRaw: BigInt(supply.value.amount),
    fetchedAtMs: Date.now(),
  };
  await repo.putToken(token);

  // --- a media pool with art in every tier ------------------------------------------
  for (const [tier, n] of [
    ['regular', 3],
    ['big', 2],
    ['whale', 2],
    ['massive', 1],
  ] as const) {
    for (let i = 0; i < n; i++) {
      await repo.upsertMediaItem({
        sha256: `${tier}${i}`.padEnd(64, '0'),
        mint: MINT,
        tier,
        relPath: `${MINT}/${tier}/${tier}${i}.gif`,
        kind: 'animation',
        bytes: 1234,
      });
    }
  }

  const media = new FsMediaPool({
    repo,
    source: new LocalFsSource(process.env.MEDIA_ROOT ?? '/srv/media'),
    log,
    mints: async () => [MINT],
    pollMs: 3_600_000,
  });
  // NOTE: no refresh() — the pool rows above ARE the pool for this harness. A refresh
  // would read the real manifest and mark them all missing.

  const price = await solUsd();
  const deps = { solUsd: price, stableUsd: 1 };
  process.stdout.write(`\nSOL/USD = $${price.toFixed(2)}   supply = ${supply.value.amount} (${token.decimals}dp)\n`);

  let described = {
    usdIn: 0,
    holdingsUsd: null as number | null,
    earnedTier: '-',
    usedTier: null as string | null,
    sha256: null as string | null,
  };
  const sender = new DryRunSender(log, () => described);
  const queue = new DeliveryQueue({ repo, sender, log, perChatMs: 0 });

  /**
   * `sigOverride` exists because the per-tier demo replays ONE real transaction with four
   * different dollar figures — and (signature, chat_id) is the idempotency key, so the
   * 2nd, 3rd and 4th were correctly refused by claimSend and printed nothing at all. That
   * is INVARIANT 2 working; the demo just has to stop pretending four different buys are
   * the same buy.
   */
  const post = async (
    event: BuyEvent,
    usdIn: number,
    holdingsUsd: number,
    label: string,
    sigOverride?: string,
  ): Promise<void> => {
    if (sigOverride) event = { ...event, signature: sigOverride as BuyEvent['signature'] };
    const quote = quoteAssetFor(event.quoteMint);
    const tk = (await repo.getToken(event.mint)) ?? token;
    const picked = await media.pick(event.mint, CHAT, usdIn, holdingsUsd);
    described = {
      usdIn,
      holdingsUsd,
      earnedTier: picked?.earnedTier ?? '-',
      usedTier: picked?.usedTier ?? null,
      sha256: picked?.item?.sha256 ?? null,
    };
    process.stdout.write(`\n### ${label}\n`);
    await fanOut(
      event,
      {
        usdIn,
        priceUsd: usdIn / toFloat(rawAmount(event.tokensRaw, tk.decimals)),
        marketCapUsd:
          (usdIn / toFloat(rawAmount(event.tokensRaw, tk.decimals))) * toFloat(rawAmount(tk.supplyRaw, tk.decimals)),
        whaleValueUsd: holdingsUsd,
        quoteAmount: toFloat(rawAmount(event.quoteRaw, quote?.decimals ?? 9)),
        tokensOut: toFloat(rawAmount(event.tokensRaw, tk.decimals)),
      },
      { repo, media, queue, log },
    );
    await new Promise((r) => setTimeout(r, 50)); // let the queue drain
  };

  // =================================================================================
  // 1. REAL buys, off the chain, right now.
  // =================================================================================
  process.stdout.write('\n══ REAL $RICE BUYS (live chain data, priced at the live SOL/USD) ══\n');

  const txs: { signature: string; tx: unknown; mint?: Mint | undefined; symbol?: string | undefined }[] = [];

  if (FIXTURES) {
    // Real transactions, captured from mainnet. Buys only — the sell/transfer/arb
    // fixtures are there to prove the parser DOESN'T post them.
    const dir = join(process.cwd(), 'test', 'fixtures');
    for (const f of readdirSync(dir).filter((f) => f.startsWith('buy-') && f.endsWith('.json'))) {
      // Each fixture is a WRAPPER: { mint, symbol, signature, tx }. The mint is the
      // fixture's own — these were captured across several tokens — so the card is
      // rendered for whatever token the transaction actually bought.
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        mint: string;
        symbol?: string;
        tx: unknown;
      };
      txs.push({ signature: f.replace('.json', ''), tx: fx.tx, mint: fx.mint as Mint, symbol: fx.symbol });
    }
  } else {
    const sigs = await rpc<{ signature: string }[]>('getSignaturesForAddress', [MINT, { limit: 40 }]);
    for (const { signature } of sigs.slice(0, 25)) {
      const tx = await rpc<unknown>('getTransaction', [
        signature,
        { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
      ]);
      if (tx) txs.push({ signature, tx });
    }
  }

  let found = 0;

  for (const { signature, tx, mint: fxMint, symbol: fxSymbol } of txs) {
    if (found >= 6) break;
    const target = fxMint ?? MINT;

    // Every mint this harness sees gets a watching chat, its metadata and its art.
    if (target !== MINT) {
      await repo.addChatToken(CHAT, target);
      await repo.putToken({ ...token, mint: target, symbol: fxSymbol ?? target.slice(0, 4) });
      for (const [tier, n] of [['regular', 3], ['big', 2], ['whale', 2], ['massive', 1]] as const) {
        for (let i = 0; i < n; i++) {
          await repo.upsertMediaItem({
            sha256: `${target.slice(0, 6)}${tier}${i}`.padEnd(64, '0'),
            mint: target,
            tier,
            relPath: `${target}/${tier}/${tier}${i}.gif`,
            kind: 'animation',
            bytes: 1234,
          });
        }
      }
    }

    const { event } = normalizeSwap(tx as never, target, { solUsd: price });
    if (!event || event.kind !== 'buy') continue;

    const tokenMeta = (await repo.getToken(target))!;
    const priced = derivePricing(
      {
        mint: target,
        quote: quoteAssetFor(event.quoteMint)!,
        quoteRaw: event.quoteRaw,
        tokensRaw: event.tokensRaw,
        decimals: tokenMeta.decimals,
        supplyRaw: tokenMeta.supplyRaw,
        balanceBeforeRaw: event.balanceBeforeRaw ?? 0n,
        balanceAfterRaw: event.balanceAfterRaw ?? 0n,
      },
      deps,
      'post',
    );
    if (!priced) continue;

    found++;
    const tier = pickTier(priced.usdIn, priced.holdingsUsd, DEFAULT_TIER_POLICY);
    await post(
      event,
      priced.usdIn,
      priced.holdingsUsd,
      `real buy ${signature.slice(0, 12)}…  ->  ${tier?.name ?? 'below min_buy_usd'}`,
    );
  }

  if (found === 0) {
    process.stdout.write('\n  (no buys in the last 40 signatures — the mint is quiet right now)\n');
  }

  // =================================================================================
  // 2. One card per tier, so the headline mapping can be read off directly.
  //    The EVENT is a real transaction; only the dollar figures are forced.
  // =================================================================================
  process.stdout.write('\n══ ONE CARD PER TIER (real tx shape, forced USD so every tier fires) ══\n');

  const template = ((): BuyEvent | null => {
    for (const { tx, mint: m } of txs) {
      const { event: e } = normalizeSwap(tx as never, m ?? MINT, { solUsd: price });
      if (e?.kind === 'buy') return e;
    }
    return null;
  })();

  if (template) {
    await post(template, 23.29, 40, 'Regular  — $23.29 buy, $40 held', 'demo-regular');
    await post(template, 340, 600, 'Big      — $340 buy, $600 held (a chunky buy from a small holder)', 'demo-big');
    await post(template, 20, 50_000, 'Whale    — $20 buy, $50,000 HELD (holdings, not buy size)', 'demo-whale');
    await post(template, 2_400, 2_400, 'Massive  — $2,400 buy', 'demo-massive');

    // The one that is easy to get wrong: an empty whale/ folder must NOT change the copy.
    const whaleShas = (await repo.listMedia(template.mint, 'whale')).map((i) => i.sha256);
    await repo.markMediaRemoved(whaleShas, Date.now());
    await post(
      template,
      20,
      50_000,
      'Whale with an EMPTY whale/ folder — headline must STILL say WHALE',
      'demo-whale-noart',
    );
  }

  process.stdout.write(`\nchat_token: min_buy=$${ct.minBuyUsd} big=$${ct.buyFloorBig} massive=$${ct.buyFloorMassive} whale_holdings=$${ct.whaleHoldingsUsd}\n`);
  process.stdout.write(`links: ${Object.keys(ct.links ?? {}).join(', ')}\n\n`);

  await repo.close();
  rmSync(dir, { recursive: true, force: true });
}

main().catch((err: unknown) => {
  process.stderr.write(`\nERROR ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
