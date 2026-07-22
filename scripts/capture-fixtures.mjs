/**
 * Capture REAL confirmed transactions as test fixtures.
 *
 * Program ids are used HERE ONLY, to label candidates so we can curate a diverse
 * fixture set (pump.fun / PumpSwap / Raydium / Jupiter / …). The normalizer under
 * test never sees them — it is balance-delta only (INVARIANT 1). Do not be
 * tempted to move this map into src/.
 *
 * Usage: node scripts/capture-fixtures.mjs [--rpc <url>] [--scan N]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSwap } from '../dist/ingest/normalize.js';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const RPC = argOf('--rpc', process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com');
const SCAN = Number(argOf('--scan', '60'));
const OUT = join(process.cwd(), 'test', 'fixtures');

const VENUES = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun-bonding-curve',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'pumpswap',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'raydium-clmm',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium-amm-v4',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'raydium-cpmm',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'jupiter-v6',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'orca-whirlpool',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'meteora-dlmm',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'spl-token',
};

const MINTS = [
  ['2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump', 'RICE'],
  ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK'],
  ['EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF'],
  ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP'],
];

let rpcCalls = 0;
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    rpcCalls++;
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 6) throw new Error(`${method}: HTTP ${res.status} after retries`);
      const wait = Math.min(8000, 500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  }
}

/** Which venues does this tx touch? Curation only. */
function venuesOf(tx) {
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const found = new Set();
  for (const k of keys) if (VENUES[k]) found.add(VENUES[k]);
  return [...found];
}

/** Rough hop count for a Jupiter route: distinct AMM venues touched. */
function hops(tx) {
  return venuesOf(tx).filter((v) => v !== 'jupiter-v6' && v !== 'spl-token').length;
}

const buckets = new Map();
const keep = (name, rec) => {
  if (!buckets.has(name)) buckets.set(name, rec);
};

for (const [mint, sym] of MINTS) {
  process.stderr.write(`\nscanning ${sym} (${SCAN} sigs)…\n`);
  let sigs;
  try {
    sigs = await rpc('getSignaturesForAddress', [mint, { limit: SCAN }]);
  } catch (e) {
    process.stderr.write(`  !! ${e.message}\n`);
    continue;
  }

  for (const s of sigs) {
    if (s.err) continue;
    let tx;
    try {
      tx = await rpc('getTransaction', [
        s.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ]);
    } catch {
      continue;
    }
    if (!tx || !tx.meta) continue;

    const { event, reason } = normalizeSwap(tx, mint);
    const venues = venuesOf(tx);
    const label = venues.filter((v) => v !== 'spl-token');

    const rec = { mint, sym, signature: s.signature, tx, venues, event, reason };

    if (event?.kind === 'buy') {
      const big = event.balanceBeforeRaw > 0n;
      if (label.includes('pumpfun-bonding-curve')) keep('buy-pumpfun-bonding-curve', rec);
      if (label.includes('pumpswap')) keep('buy-pumpswap', rec);
      if (label.includes('raydium-clmm')) keep('buy-raydium-clmm', rec);
      if (label.includes('raydium-amm-v4')) keep('buy-raydium-amm-v4', rec);
      if (label.includes('orca-whirlpool')) keep('buy-orca-whirlpool', rec);
      if (label.includes('meteora-dlmm')) keep('buy-meteora-dlmm', rec);
      if (label.includes('jupiter-v6') && hops(tx) >= 2) keep('buy-jupiter-multihop', rec);
      if (label.includes('jupiter-v6')) keep('buy-jupiter', rec);

      // Whale path: a buyer who ALREADY held a meaningful stack.
      if (big) {
        const cur = buckets.get('buy-whale-existing-balance');
        if (!cur || event.balanceBeforeRaw > cur.event.balanceBeforeRaw) {
          buckets.set('buy-whale-existing-balance', rec);
        }
      }
    } else if (event?.kind === 'sell') {
      keep('sell', rec);
    } else if (reason === 'no-quote-movement') {
      // Mint moved but no quote leg: a plain transfer / airdrop. MUST be null.
      keep('spl-transfer', rec);
    }
  }
}

mkdirSync(OUT, { recursive: true });
const manifest = [];

for (const [name, rec] of buckets) {
  const file = `${name}.json`;
  writeFileSync(
    join(OUT, file),
    JSON.stringify(
      {
        _comment: 'REAL mainnet transaction, captured verbatim. Do not hand-edit.',
        name,
        mint: rec.mint,
        symbol: rec.sym,
        signature: rec.signature,
        venues: rec.venues,
        tx: rec.tx,
      },
      null,
      2,
    ),
  );

  const e = rec.event;
  manifest.push({
    name,
    sym: rec.sym,
    venues: rec.venues.join('+'),
    kind: e?.kind ?? `null(${rec.reason})`,
    tokens: e ? String(e.tokensRaw) : '-',
    lamports: e ? String(e.quoteLamports) : '-',
    before: e ? String(e.balanceBeforeRaw) : '-',
    after: e ? String(e.balanceAfterRaw) : '-',
  });
}

console.table(manifest);
process.stderr.write(`\n${buckets.size} fixtures -> ${OUT} (${rpcCalls} rpc calls)\n`);
