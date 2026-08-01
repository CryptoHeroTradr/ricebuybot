/**
 * WOULD THIS TRADE COMPLETE? — the executor's own path, up to the last step before money moves.
 *
 * It runs the REAL guards in the REAL order (`src/trade/executor.ts` #run), against the live
 * Jupiter API and the live chain:
 *
 *     quote -> price-impact guard -> build -> SIMULATE -> (stop)
 *
 * and stops immediately before signing. Nothing is signed, nothing is sent, no key is read and no
 * keystore is unlocked — so this is safe to run against a production wallet while the bot is
 * trading, and safe to run as often as you like.
 *
 * Simulation is where the answer usually is: it executes the transaction against real chain state
 * and reports the error the send WOULD have hit — insufficient lamports for the ATA rent, a stale
 * route, a slippage bound that cannot be met. That is exactly the class of failure that shows up in
 * `/history` as `failed —` with no signature, because the executor never got as far as submitting.
 *
 *   sudo -E node scripts/probe-trade.ts --wallet <pubkey> --sol 0.01 [--mint <mint>] [--slippage-bps 100]
 *
 * `-E` matters: it keeps HELIUS_RPC_URL, JUPITER_API_URL, MAX_PRICE_IMPACT_PCT and
 * PRIORITY_FEE_LAMPORTS from the bot's environment, so what is probed is what the bot is
 * CONFIGURED to do rather than what the defaults say. Without an RPC URL it falls back to the
 * public mainnet endpoint, which is rate-limited but fine for one probe.
 */
import { DEFAULT_MINT } from '../src/media/pool.ts';

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

interface Args {
  wallet: string;
  sol: number;
  mint: string;
  slippageBps: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const wallet = get('--wallet');
  const sol = Number(get('--sol') ?? '0.01');
  if (!wallet) throw new Error('--wallet <pubkey> is required (the trading wallet — /trade shows it)');
  if (!Number.isFinite(sol) || sol <= 0) throw new Error('--sol must be a positive number of SOL');
  return {
    wallet,
    sol,
    mint: get('--mint') ?? process.env.DEFAULT_MINT ?? DEFAULT_MINT,
    slippageBps: Number(get('--slippage-bps') ?? '100'),
  };
}

/** The three settings that decide a trade, read from the bot's own env where present. */
const CFG = {
  jupiter: (process.env.JUPITER_API_URL ?? 'https://lite-api.jup.ag/swap/v1').replace(/\/+$/, ''),
  rpc: process.env.HELIUS_RPC_URL ?? PUBLIC_RPC,
  maxPriceImpactPct: Number(process.env.MAX_PRICE_IMPACT_PCT ?? '0.03'),
  priorityFeeLamports: Number(process.env.PRIORITY_FEE_LAMPORTS ?? '100000'),
};

let failed = false;
const pass = (m: string): void => console.log(`  ✅ ${m}`);
const fail = (m: string): void => {
  failed = true;
  console.log(`  ❌ ${m}`);
};
const note = (m: string): void => console.log(`     ${m}`);
const step = (m: string): void => console.log(`\n${m}`);

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(CFG.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lamports = BigInt(Math.round(args.sol * LAMPORTS_PER_SOL));

  console.log('PROBE — the executor path, stopped before signing. Nothing is sent.');
  console.log(`  wallet     ${args.wallet}`);
  console.log(`  buying     ${args.sol} SOL (${lamports} lamports) of ${args.mint}`);
  console.log(`  jupiter    ${CFG.jupiter}`);
  console.log(`  rpc        ${CFG.rpc === PUBLIC_RPC ? 'public mainnet (no HELIUS_RPC_URL in env)' : 'from HELIUS_RPC_URL'}`);
  console.log(`  guards     price impact <= ${(CFG.maxPriceImpactPct * 100).toFixed(2)}%, slippage ${args.slippageBps} bps, priority fee ${CFG.priorityFeeLamports} lamports`);

  // --- 0. BALANCE. Not one of the executor's guards, but the reason simulation fails most often:
  //        the buy itself is only part of what a swap costs. -----------------------------------
  step('0. Wallet balance');
  const bal = await rpc<{ value: number }>('getBalance', [args.wallet, { commitment: 'confirmed' }])
    .then((r) => BigInt(r.value))
    .catch((e: Error) => {
      fail(`could not read the balance: ${e.message}`);
      return null;
    });
  if (bal !== null) {
    const ATA_RENT = 2_039_280n; // ~0.00204 SOL, charged ONCE if the wallet has no account for this mint
    const TX_FEE = 5_000n;
    const needed = lamports + BigInt(CFG.priorityFeeLamports) + TX_FEE + ATA_RENT;
    console.log(`  balance    ${Number(bal) / LAMPORTS_PER_SOL} SOL`);
    note(`a first buy of a new mint also pays ~${Number(ATA_RENT) / LAMPORTS_PER_SOL} SOL of ATA rent + fees`);
    if (bal >= needed) pass(`covers the buy plus fees and rent (${Number(needed) / LAMPORTS_PER_SOL} SOL)`);
    else fail(`too small: needs ~${Number(needed) / LAMPORTS_PER_SOL} SOL for buy + priority fee + rent, has ${Number(bal) / LAMPORTS_PER_SOL}`);
    note('and the caps row\'s min_sol_reserve_lamports must ALSO still be left behind — see why-failed.sh');
  }

  // --- 1. QUOTE ---------------------------------------------------------------------------
  step('1. Jupiter quote');
  const url = new URL(`${CFG.jupiter}/quote`);
  url.searchParams.set('inputMint', SOL_MINT);
  url.searchParams.set('outputMint', args.mint);
  url.searchParams.set('amount', lamports.toString());
  url.searchParams.set('slippageBps', String(args.slippageBps));
  const qres = await fetch(url, { headers: { accept: 'application/json' } });
  if (!qres.ok) {
    fail(`quote HTTP ${qres.status} — the executor fails here with "jupiter quote HTTP ${qres.status}"`);
    note(await qres.text().then((t) => t.slice(0, 300)));
    process.exit(1);
  }
  const quote = (await qres.json()) as {
    outAmount: string;
    priceImpactPct: string;
    routePlan: { swapInfo: { label: string } }[];
  };
  const impact = Number(quote.priceImpactPct);
  pass(`routed via ${quote.routePlan.map((r) => r.swapInfo.label).join(' -> ')}`);
  note(`out ${quote.outAmount} raw units`);

  // --- 2. PRICE-IMPACT GUARD ----------------------------------------------------------------
  step('2. Price-impact guard');
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  if (impact > CFG.maxPriceImpactPct) {
    fail(`price impact ${pct(impact)} exceeds max ${pct(CFG.maxPriceImpactPct)} — the executor refuses here`);
    note('raise MAX_PRICE_IMPACT_PCT only if that impact is the POOL\'s standing fee rather than your size');
  } else {
    pass(`price impact ${pct(impact)} is under the ${pct(CFG.maxPriceImpactPct)} guard`);
    const headroom = CFG.maxPriceImpactPct - impact;
    if (headroom < 0.01) {
      note(`⚠️  only ${pct(headroom)} of headroom — a wobble in the pool fails the trade with no warning`);
    }
  }

  // --- 3. BUILD ------------------------------------------------------------------------------
  step('3. Build the swap transaction');
  const bres = await fetch(`${CFG.jupiter}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: args.wallet,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: CFG.priorityFeeLamports,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!bres.ok) {
    fail(`swap build HTTP ${bres.status} — the executor fails here with "jupiter swap HTTP ${bres.status}"`);
    note(await bres.text().then((t) => t.slice(0, 300)));
    process.exit(1);
  }
  const { swapTransaction } = (await bres.json()) as { swapTransaction: string };
  pass(`built (${swapTransaction.length} base64 chars)`);

  // --- 4. SIMULATE — the same call the executor makes, and the one that answers the question --
  step('4. Simulate against live chain state');
  const sim = await rpc<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>(
    'simulateTransaction',
    [swapTransaction, { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', commitment: 'confirmed' }],
  ).catch((e: Error) => {
    fail(`simulation call failed: ${e.message}`);
    return null;
  });
  if (sim) {
    if (sim.value.err) {
      fail(`simulation failed: ${JSON.stringify(sim.value.err)} — this is what the executor records`);
      for (const line of (sim.value.logs ?? []).slice(-12)) note(line);
    } else {
      pass(`simulation succeeded (${sim.value.unitsConsumed ?? '?'} compute units)`);
      note('the transaction executes against real chain state — a real send would land');
    }
  }

  step(failed ? '❌ THIS TRADE WOULD NOT COMPLETE — see the failures above.' : '✅ THIS TRADE WOULD COMPLETE.');
  console.log('   Not covered here (they are bot state, not chain state): TRADE_LIVE, the caps row,');
  console.log('   the SOL reserve, and whether the member is in `key` mode. Run why-failed.sh for those.\n');
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(`probe failed: ${(err as Error).message}`);
  process.exit(1);
});
