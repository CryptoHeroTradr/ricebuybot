/**
 * "THE CARD SAID $85K AND THE CHART SAYS $75K" — settle it, from the transaction itself.
 *
 * Replays one signature through the REAL parser and the REAL pricer (`normalizeSwap` ->
 * `derivePricing` — the same two functions every card is built from, INVARIANT 12) and prints the
 * numbers a card would carry, plus the breakdown that explains them:
 *
 *   - what left the BUYER's wallet, and
 *   - what reached the POOL, which is the price of the trade.
 *
 * The gap between those two is a fee that bought nothing — an aggregator's cut, a tip, the rent on
 * a token account — and it is the usual reason a card's market cap sits above a chart's. See
 * `fillQuote` in src/ingest/normalize.ts.
 *
 *   pnpm build && node dist/scripts/replay-card.js <signature> [--sol-usd 70.85] [--rpc <url>]
 *
 * From dist, like `cards:dry`: the parser it imports is ordinary bot source with `.js` specifiers,
 * which Node's type stripping cannot resolve to `.ts` on disk. `pnpm card:replay` wraps it.
 *
 * Read-only: one getTransaction and one getTokenSupply. No key, no DB, no send. Without --sol-usd
 * it uses the live SOL price the bot reports on /health, so the figures match what the bot would
 * have published at the moment you run it — NOT what it published at the time of the trade, which
 * is priced at that block's SOL price and cannot be recovered from the chain alone.
 */
import { normalizeSwap } from '../src/ingest/normalize.ts';
import { derivePricing } from '../src/pricing/derive.ts';
import { SOL_QUOTE, quoteAssetFor } from '../src/pricing/quote.ts';
import type { Mint } from '../src/core/types.ts';

const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const signature = positional[0];
const RPC = flag('--rpc') ?? process.env.HELIUS_RPC_URL ?? PUBLIC_RPC;

if (!signature) {
  console.error('usage: node scripts/replay-card.ts <signature> [--sol-usd 70.85] [--rpc <url>]');
  process.exit(1);
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}

/** The live SOL price, from the bot's own feed, so this agrees with what the bot would publish. */
async function solUsdFromHealth(): Promise<number | null> {
  const port = process.env.HTTP_PORT ?? '3012';
  return fetch(`http://127.0.0.1:${port}/health`)
    .then((r) => r.json() as Promise<{ solUsd: number | null }>)
    .then((h) => h.solUsd)
    .catch(() => null);
}

const usd = (n: number): string => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const solUsd = Number(flag('--sol-usd') ?? '') || (await solUsdFromHealth());
  if (solUsd === null) {
    console.error('no SOL price: pass --sol-usd, or run where the bot\'s /health is reachable');
    process.exit(1);
  }

  // jsonParsed, NOT json: the parser reads the signer flags off `accountKeys`, and the plain `json`
  // encoding returns bare address strings with no flags — every buy then looks like nobody's trade
  // ('no-signing-actor'). Same shape the ingestor receives.
  const tx = await rpc<Record<string, unknown>>('getTransaction', [
    signature,
    { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  if (!tx) throw new Error('transaction not found (or not yet confirmed)');

  // Which mint? The one that moved that is not a registry quote asset — asked of the transaction
  // rather than passed in, so this works on any buy without knowing the token first.
  const meta = tx.meta as { postTokenBalances?: { mint: string }[]; preTokenBalances?: { mint: string }[] };
  const mints = new Set(
    [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]
      .map((b) => b.mint)
      .filter((m) => quoteAssetFor(m as Mint) === null),
  );
  const mint = (flag('--mint') ?? [...mints][0]) as Mint | undefined;
  if (!mint) throw new Error('no non-quote mint moved in this transaction');

  const { event, reason } = normalizeSwap(tx as never, mint, { solUsd });
  if (!event) {
    console.log(`not classified as a swap of ${mint}: ${reason}`);
    process.exit(1);
  }
  if (event.kind !== 'buy') {
    console.log(`classified as a ${event.kind}, not a buy — buy cards are not rendered for it`);
    process.exit(0);
  }

  const supply = await rpc<{ value: { amount: string; decimals: number } }>('getTokenSupply', [mint]);
  const decimals = supply.value.decimals;

  const pricing = derivePricing(
    {
      quoteRaw: event.quoteRaw,
      quote: quoteAssetFor(event.quoteMint) ?? SOL_QUOTE,
      mint,
      tokensRaw: event.tokensRaw,
      decimals,
      supplyRaw: BigInt(supply.value.amount),
      balanceBeforeRaw: event.balanceBeforeRaw,
      balanceAfterRaw: event.balanceAfterRaw,
    },
    { solUsd, stableUsd: Number(process.env.STABLE_USD ?? '1') },
  );
  if (!pricing) throw new Error('the pricer declined this buy (unpriceable quote asset)');

  console.log(`\n${(signature as string).slice(0, 20)}…  mint ${mint}`);
  console.log(`  buyer        ${event.buyer}`);
  console.log(`  SOL/USD      ${usd(solUsd)}${flag('--sol-usd') ? ' (pinned)' : ' (live, from the bot)'}`);
  console.log(`  supply       ${(Number(supply.value.amount) / 10 ** decimals).toLocaleString('en-US')}`);
  console.log('\nTHE CARD:');
  console.log(`  🔀 Spent      ${usd(pricing.usdIn)}  (${Number(event.quoteRaw) / 10 ** (quoteAssetFor(event.quoteMint)?.decimals ?? 9)} ${event.quoteSymbol})`);
  console.log(`  🔀 Got        ${(Number(event.tokensRaw) / 10 ** decimals).toLocaleString('en-US')}`);
  console.log(`  💸 Market Cap ${usd(pricing.marketCapUsd)}`);
  console.log(`     price      $${pricing.priceUsd.toPrecision(6)}`);
  console.log('\nThe market cap is the PRICE THIS FILL PAID times the supply above. It should agree');
  console.log('with a chart to within the pool fee. If it does not, the gap is in one of those two');
  console.log('numbers — and both of them are printed here.\n');
}

main().catch((err: unknown) => {
  console.error(`replay failed: ${(err as Error).message}`);
  process.exit(1);
});
