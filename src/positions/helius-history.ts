import type { Wallet } from '../core/types.js';
import type { ConfirmedTx } from '../ingest/solana-types.js';
import { scrubUrl, type Logger } from '../ops/logger.js';
import type { HistorySource } from './backfill.js';

/**
 * Wallet history over JSON-RPC. Used only by the backfill, never on the hot path.
 *
 * INVARIANT 5: the URL carries the API key, so it never reaches a log line.
 */
export class HeliusHistory implements HistorySource {
  readonly #url: string;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;

  constructor(url: string, log: Logger, fetchFn: typeof fetch = fetch) {
    this.#url = url;
    this.#log = log;
    this.#fetch = fetchFn;
  }

  async #call<T>(method: string, params: unknown): Promise<T | null> {
    try {
      const res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        this.#log.warn({ method, status: res.status, url: scrubUrl(this.#url) }, 'history rpc failed');
        return null;
      }
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error) {
        this.#log.warn({ method, err: json.error.message }, 'history rpc error');
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      this.#log.warn(
        { method, err: err instanceof Error ? err.message : String(err) },
        'history rpc threw',
      );
      return null;
    }
  }

  async signaturesFor(wallet: Wallet, limit: number): Promise<Array<{ signature: string; slot: number }>> {
    const out: Array<{ signature: string; slot: number }> = [];
    let before: string | undefined;

    // getSignaturesForAddress caps at 1000 per call anyway; page until `limit`.
    while (out.length < limit) {
      const page = await this.#call<Array<{ signature: string; slot: number; err: unknown }>>(
        'getSignaturesForAddress',
        [wallet, { limit: Math.min(1_000, limit - out.length), ...(before ? { before } : {}) }],
      );
      if (!page || page.length === 0) break;

      for (const s of page) {
        if (!s.err) out.push({ signature: s.signature, slot: s.slot });
      }
      before = page[page.length - 1]?.signature;
      if (page.length < 1_000) break; // exhausted
    }
    return out.slice(0, limit);
  }

  async getTransaction(signature: string): Promise<ConfirmedTx | null> {
    return this.#call<ConfirmedTx>('getTransaction', [signature, TX_CONFIG]);
  }

  /**
   * A JSON-RPC BATCH request: many getTransaction calls in one HTTP round-trip.
   *
   * The backfill classifies with `normalizeSwap`, which needs the RAW transaction —
   * heavier than Helius's parsed history, and worth it: a second parser is a second
   * classification, and two classifications of one transaction is how a wallet
   * double-counts. This is what keeps the cost of having exactly one parser sane.
   *
   * Responses come back in arbitrary order, so they are matched by `id`, never by
   * position.
   */
  async getTransactions(signatures: readonly string[]): Promise<Array<ConfirmedTx | null>> {
    if (signatures.length === 0) return [];

    const body = signatures.map((sig, id) => ({
      jsonrpc: '2.0',
      id,
      method: 'getTransaction',
      params: [sig, TX_CONFIG],
    }));

    try {
      const res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000), // a batch is slower than a single call
      });

      if (!res.ok) {
        this.#log.warn(
          { status: res.status, batch: signatures.length, url: scrubUrl(this.#url) },
          'history batch failed; falling back to single fetches',
        );
        return this.#oneByOne(signatures);
      }

      const json = (await res.json()) as Array<{ id?: number; result?: ConfirmedTx; error?: { message?: string } }>;
      if (!Array.isArray(json)) return this.#oneByOne(signatures);

      const out: Array<ConfirmedTx | null> = new Array(signatures.length).fill(null);
      for (const r of json) {
        if (typeof r.id !== 'number' || r.id < 0 || r.id >= signatures.length) continue;
        if (r.error) {
          this.#log.warn({ err: r.error.message }, 'history batch entry error');
          continue;
        }
        out[r.id] = r.result ?? null;
      }
      return out;
    } catch (err) {
      this.#log.warn(
        { err: err instanceof Error ? err.message : String(err), batch: signatures.length },
        'history batch threw; falling back to single fetches',
      );
      return this.#oneByOne(signatures);
    }
  }

  /** A batch that fails must not lose the whole walk — a truncated walk is a lie. */
  async #oneByOne(signatures: readonly string[]): Promise<Array<ConfirmedTx | null>> {
    const out: Array<ConfirmedTx | null> = [];
    for (const sig of signatures) out.push(await this.getTransaction(sig));
    return out;
  }
}

const TX_CONFIG = {
  encoding: 'jsonParsed',
  maxSupportedTransactionVersion: 0,
  commitment: 'confirmed',
} as const;
