/**
 * Capture ONE real wallet's full $RICE history, plus its TRUE on-chain balance.
 *
 * The balance is fetched independently (getTokenAccountsByOwner) — it is the
 * ground truth the replay must reconcile against. If the backfill can rebuild that
 * exact number from history alone, the cost-basis engine works on real data.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyForWallet } from '../dist/positions/replay.js';

const RPC = process.env.CAPTURE_RPC || 'https://api.mainnet-beta.solana.com';
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
const WALLET = process.argv[2] || 'BfEhdonWCqQa3qxucTevNCizBnnaSJ7kJY4D1qSgiicQ';
const OUT = join(process.cwd(), 'test', 'fixtures');

async function rpc(method, params) {
  for (let a = 0; ; a++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (a >= 6) throw new Error(`${method}: ${res.status}`);
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** a)));
      continue;
    }
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
}

// Ground truth: what does the chain say this wallet holds RIGHT NOW?
const accounts = await rpc('getTokenAccountsByOwner', [WALLET, { mint: MINT }, { encoding: 'jsonParsed' }]);
const onchain = (accounts?.value ?? []).reduce(
  (n, a) => n + BigInt(a.account.data.parsed.info.tokenAmount.amount),
  0n,
);
console.log(`wallet   ${WALLET}`);
console.log(`onchain  ${onchain} raw RICE (${accounts?.value?.length ?? 0} token account(s))`);

const sigs = await rpc('getSignaturesForAddress', [WALLET, { limit: 1000 }]);
console.log(`history  ${sigs.length} signatures`);

const txs = [];
for (const s of sigs) {
  if (s.err) continue;
  const tx = await rpc('getTransaction', [
    s.signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  ]);
  if (!tx?.meta) continue;
  const ev = classifyForWallet(tx, MINT, WALLET);
  if (!ev) continue; // not a RICE-moving tx for this wallet
  txs.push(tx);
  console.log(`  ${ev.kind.padEnd(12)} tokens=${ev.tokensRaw} after=${ev.balanceAfterRaw} ${s.signature.slice(0, 12)}…`);
}

writeFileSync(
  join(OUT, 'wallet-rice-history.json'),
  JSON.stringify(
    {
      _comment: 'REAL mainnet wallet history. onchainRaw is ground truth from getTokenAccountsByOwner.',
      wallet: WALLET,
      mint: MINT,
      onchainRaw: onchain.toString(),
      txs,
    },
    null,
    2,
  ),
);
console.log(`\nsaved ${txs.length} RICE-moving txs -> test/fixtures/wallet-rice-history.json`);
