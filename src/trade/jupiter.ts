import type { Logger } from '../ops/logger.js';
import { scrubUrl } from '../ops/logger.js';
import type { Jupiter, JupiterQuote } from './executor.js';

/**
 * Phase 14 — the Jupiter quote/swap HTTP client. Thin on purpose: it maps the wire JSON to the
 * typed {@link JupiterQuote} the executor works in, and nothing else. Amounts cross the boundary
 * as bigint (INVARIANT 6); Jupiter reports `priceImpactPct` as a decimal FRACTION string.
 *
 * This is the one new outbound host Phase 14 introduces (Phase 9 allowlist) — the VPS firewall
 * must permit `JUPITER_API_URL`.
 */

interface QuoteWire {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
}

export class JupiterHttp implements Jupiter {
  readonly #base: string;
  readonly #log: Logger;

  constructor(baseUrl: string, log: Logger) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#log = log.child({ mod: 'jupiter' });
  }

  async quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<JupiterQuote> {
    const url = new URL(`${this.#base}/quote`);
    url.searchParams.set('inputMint', p.inputMint);
    url.searchParams.set('outputMint', p.outputMint);
    url.searchParams.set('amount', p.amount.toString());
    url.searchParams.set('slippageBps', String(p.slippageBps));

    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      this.#log.warn({ status: res.status, url: scrubUrl(url.toString()) }, 'jupiter quote failed');
      throw new Error(`jupiter quote HTTP ${res.status}`);
    }
    const j = (await res.json()) as QuoteWire;
    return {
      inputMint: j.inputMint,
      outputMint: j.outputMint,
      inAmount: BigInt(j.inAmount),
      outAmount: BigInt(j.outAmount),
      priceImpactPct: Number(j.priceImpactPct),
      raw: j, // passed back verbatim to /swap
    };
  }

  async buildSwap(p: { quote: JupiterQuote; userPublicKey: string; prioritizationFeeLamports: number }): Promise<{ swapTransaction: string }> {
    const res = await fetch(`${this.#base}/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        quoteResponse: p.quote.raw,
        userPublicKey: p.userPublicKey,
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: p.prioritizationFeeLamports,
        dynamicComputeUnitLimit: true,
      }),
    });
    if (!res.ok) {
      this.#log.warn({ status: res.status }, 'jupiter swap build failed');
      throw new Error(`jupiter swap HTTP ${res.status}`);
    }
    const j = (await res.json()) as { swapTransaction: string };
    if (!j.swapTransaction) throw new Error('jupiter swap returned no transaction');
    return { swapTransaction: j.swapTransaction };
  }
}
