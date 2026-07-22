/**
 * Capture (a) a real USDC-quoted mainnet buy, and (b) the token->token arb that
 * must still normalize to null. Those two are the boundary of the new rule.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSwap } from '../dist/ingest/normalize.js';

const RPC = process.env.CAPTURE_RPC || 'https://api.mainnet-beta.solana.com';
const OUT = join(process.cwd(), 'test', 'fixtures');
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const WSOL = 'So11111111111111111111111111111111111111112';
const QUOTES = new Set([USDC, USDT, WSOL]);

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

const getTx = (sig) =>
  rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);

function save(name, mint, sig, tx, note) {
  writeFileSync(
    join(OUT, `${name}.json`),
    JSON.stringify({ _comment: 'REAL mainnet transaction, captured verbatim. Do not hand-edit.', name, mint, signature: sig, note, tx }, null, 2),
  );
  console.log(`saved ${name}: ${sig}`);
}

// --- (a) a USDC-quoted buy ----------------------------------------------------
console.log('scanning Jupiter for a USDC-quoted buy…');
{
  let done = false;
  // Scan several pages: USDC-paid swaps are common but not every tx.
  let before;
  for (let page = 0; page < 6 && !done; page++) {
    const sigs = await rpc('getSignaturesForAddress', [JUP, { limit: 100, ...(before ? { before } : {}) }]);
    if (!sigs.length) break;
    before = sigs[sigs.length - 1].signature;

    for (const s of sigs) {
      if (s.err || done) continue;
      const tx = await getTx(s.signature);
      if (!tx?.meta) continue;

      // Candidate target mints: anything moved that is NOT a quote asset.
      const balances = [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])];
      const targets = [...new Set(balances.map((b) => b.mint))].filter((m) => !QUOTES.has(m));

      for (const mint of targets) {
        const { event } = normalizeSwap(tx, mint);
        if (event?.kind === 'buy' && event.quoteSymbol === 'USDC') {
          save('buy-usdc-quoted', mint, s.signature, tx, 'Jupiter swap paid from a USDC balance; SOL delta is flat');
          console.log(`  quoteRaw=${event.quoteRaw} (USDC 6dp) tokens=${event.tokensRaw} buyer=${event.buyer}`);
          done = true;
          break;
        }
      }
    }
    console.log(`  …page ${page + 1} scanned`);
  }
  if (!done) console.log('  !! no USDC-quoted buy found');
}

// --- (b) the token->token arb that must stay null -----------------------------
console.log('\nre-fetching the token->token arb (must normalize to null)…');
{
  const SIG = 'NPiETdjax5XGZRVFB5JKpvAFX2qaEfccD3iMMkjkB4VqvEdK4Sw8XuXNVRKQTYqXgK8wczHUEFCPZgTVcfAUW8G';
  const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
  const tx = await getTx(SIG);
  if (!tx?.meta) {
    console.log('  !! could not fetch');
  } else {
    const { event, reason } = normalizeSwap(tx, MINT);
    console.log(`  -> ${event ? event.kind : 'null'} (${reason ?? '-'})`);
    save('token-to-token-arb', MINT, SIG, tx, 'gains RICE by selling another non-quote token; no registry quote paid => MUST be null');
  }
}
