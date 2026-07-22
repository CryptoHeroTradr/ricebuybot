/**
 * Fill the two fixtures the broad scan could not find:
 *
 *  1. A pump.fun BONDING-CURVE buy. RICE has graduated to PumpSwap, so it has
 *     none — we must find a token still on the curve, by scanning the pump.fun
 *     program itself.
 *  2. A genuine plain SPL TRANSFER (no swap at all). The broad scan's candidate
 *     turned out to be a token->token arb with no SOL leg: null for the right
 *     value but the wrong reason, which would make a weak test.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSwap } from '../dist/ingest/normalize.js';

const RPC = process.env.CAPTURE_RPC || 'https://api.mainnet-beta.solana.com';
const OUT = join(process.cwd(), 'test', 'fixtures');
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

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

const keys = (tx) =>
  (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));

function save(name, mint, sig, tx, note) {
  writeFileSync(
    join(OUT, `${name}.json`),
    JSON.stringify(
      { _comment: 'REAL mainnet transaction, captured verbatim. Do not hand-edit.', name, mint, signature: sig, note, tx },
      null,
      2,
    ),
  );
  console.log(`saved ${name}: ${sig}`);
}

// --- 1. pump.fun bonding-curve buy -------------------------------------------
{
  console.log('scanning pump.fun program for a bonding-curve buy…');
  const sigs = await rpc('getSignaturesForAddress', [PUMPFUN, { limit: 120 }]);
  let done = false;

  for (const s of sigs) {
    if (s.err || done) continue;
    const tx = await getTx(s.signature);
    if (!tx?.meta) continue;

    // Still on the curve: pump.fun present, PumpSwap (the graduated AMM) absent.
    const k = keys(tx);
    if (!k.includes(PUMPFUN) || k.includes(PUMPSWAP)) continue;

    // The traded mint is the non-WSOL mint in the token balances.
    const balances = [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])];
    const mints = [...new Set(balances.map((b) => b.mint))].filter((m) => m !== WSOL);

    for (const mint of mints) {
      const { event } = normalizeSwap(tx, mint);
      if (event?.kind === 'buy') {
        save('buy-pumpfun-bonding-curve', mint, s.signature, tx, 'token still on the pump.fun bonding curve');
        console.log(`  tokens=${event.tokensRaw} lamports=${event.quoteLamports} before=${event.balanceBeforeRaw} after=${event.balanceAfterRaw}`);
        done = true;
        break;
      }
    }
  }
  if (!done) console.log('  !! no bonding-curve buy found');
}

// --- 2. a genuine plain SPL transfer ------------------------------------------
{
  console.log('\nscanning for a plain SPL transfer (no swap)…');
  const MINTS = [
    '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump',
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  ];
  let done = false;

  for (const mint of MINTS) {
    if (done) break;
    const sigs = await rpc('getSignaturesForAddress', [mint, { limit: 100 }]);

    for (const s of sigs) {
      if (s.err || done) continue;
      const tx = await getTx(s.signature);
      if (!tx?.meta) continue;

      const ins = tx.transaction.message.instructions ?? [];
      // Every top-level instruction must be a token transfer or plumbing.
      const onlyTransfer =
        ins.length > 0 &&
        ins.every((i) => {
          const pid = i.programId ?? '';
          const type = i.parsed?.type;
          if (pid.startsWith('ComputeBudget')) return true;
          if (TOKEN_PROGRAMS.has(pid)) return type === 'transfer' || type === 'transferChecked';
          return false;
        }) &&
        ins.some((i) => TOKEN_PROGRAMS.has(i.programId ?? ''));

      // No inner instructions at all => nothing sneaky underneath.
      const noInner = (tx.meta.innerInstructions ?? []).length === 0;
      if (!onlyTransfer || !noInner) continue;

      const { event, reason } = normalizeSwap(tx, mint);
      if (event !== null) {
        console.log(`  !! ${s.signature} looked like a transfer but classified as ${event.kind}`);
        continue;
      }

      save('spl-transfer', mint, s.signature, tx, 'plain SPL token transfer; MUST normalize to null');
      console.log(`  reason=${reason}`);
      done = true;
    }
  }
  if (!done) console.log('  !! no plain transfer found');
}
