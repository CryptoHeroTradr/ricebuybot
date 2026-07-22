import { describe, expect, it } from 'vitest';

import { WalletValue, type WalletValueRpc } from '../src/pricing/wallet-value.js';
import { pickTier, DEFAULT_TIER_POLICY } from '../src/core/tiers.js';
import { USDC_MINT, WSOL_MINT } from '../src/pricing/quote.js';
import { createLogger } from '../src/ops/logger.js';

const log = createLogger('silent' as 'info', false);
const WALLET = 'PreviewWa11etAddressPreviewWa11etAddress99';

function rpc(lamports: bigint | null, tokens: Record<string, bigint>): WalletValueRpc & { calls: number } {
  return {
    calls: 0,
    async getBalance() {
      this.calls++;
      return lamports;
    },
    async getTokenBalances(_owner, mints) {
      this.calls++;
      const out = new Map<string, bigint>();
      for (const m of mints) if (tokens[m] !== undefined) out.set(m, tokens[m] as bigint);
      return out;
    },
  };
}

describe('WalletValue — the whale test is SOL + USDC, not the token bag', () => {
  it('sums native SOL, wSOL and USDC at real prices', async () => {
    // 40 SOL @ $100 = $4,000  +  10 wSOL @ $100 = $1,000  +  8,000 USDC = $8,000  ->  $13,000
    const wv = new WalletValue({
      rpc: rpc(40_000_000_000n, { [WSOL_MINT]: 10_000_000_000n, [USDC_MINT]: 8_000_000_000n }),
      solUsd: () => 100,
      stableUsd: 1,
      log,
    });
    expect(await wv.valueOf(WALLET)).toBeCloseTo(13_000);
  });

  it('a wallet of pure USDC still whales, valued at $1', async () => {
    const wv = new WalletValue({
      rpc: rpc(0n, { [USDC_MINT]: 12_000_000_000n }),
      solUsd: () => 150,
      stableUsd: 1,
      log,
    });
    const value = await wv.valueOf(WALLET);
    expect(value).toBeCloseTo(12_000);
    expect(pickTier(20, value, DEFAULT_TIER_POLICY)?.name).toBe('Whale'); // $20 buy, whale wallet
  });

  it('the token bag is IRRELEVANT — a rich $RICE holder with no SOL/USDC is not a whale', async () => {
    // The whole point of the change: holding $50K of the token no longer makes you a whale.
    const wv = new WalletValue({ rpc: rpc(0n, {}), solUsd: () => 100, stableUsd: 1, log });
    const value = await wv.valueOf(WALLET);
    expect(value).toBe(0);
    expect(pickTier(20, value, DEFAULT_TIER_POLICY)?.name).toBe('Regular');
  });

  it('caches per wallet — a repeat buyer does not pay the RPC twice', async () => {
    const r = rpc(10_000_000_000n, { [USDC_MINT]: 20_000_000_000n });
    const wv = new WalletValue({ rpc: r, solUsd: () => 100, stableUsd: 1, log });

    await wv.valueOf(WALLET);
    const after = r.calls;
    await wv.valueOf(WALLET);
    expect(r.calls).toBe(after); // second call served from cache
  });

  it('the cache expires', async () => {
    let now = 0;
    const r = rpc(10_000_000_000n, {});
    const wv = new WalletValue({ rpc: r, solUsd: () => 100, stableUsd: 1, log, ttlMs: 60_000, now: () => now });

    await wv.valueOf(WALLET);
    const after = r.calls;
    now += 61_000;
    await wv.valueOf(WALLET);
    expect(r.calls).toBeGreaterThan(after);
  });

  it('SOL feed down: values USDC exactly, SOL as zero (safe undercount, not a fabrication)', async () => {
    // A wallet that is only a whale because of SOL will miss the tier during the outage rather
    // than being valued at a guessed price. A missed whale is invisible; a fabricated one is not.
    const wv = new WalletValue({
      rpc: rpc(100_000_000_000n, { [USDC_MINT]: 3_000_000_000n }),
      solUsd: () => null,
      stableUsd: 1,
      log,
    });
    expect(await wv.valueOf(WALLET)).toBeCloseTo(3_000); // the USDC only
  });

  it('an RPC failure is 0, never a whale', async () => {
    const broken: WalletValueRpc = {
      async getBalance() {
        return null;
      },
      async getTokenBalances() {
        return new Map();
      },
    };
    const wv = new WalletValue({ rpc: broken, solUsd: () => 100, stableUsd: 1, log });
    expect(await wv.valueOf(WALLET)).toBe(0);
  });
});
