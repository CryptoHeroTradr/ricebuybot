import type { ConfirmedTx } from '../ingest/solana-types.js';
import type { Mint, TokenMeta } from '../core/types.js';
import type { Repo } from '../db/index.js';
import { scrubUrl, type Logger } from '../ops/logger.js';

export const META_TTL_MS = 5 * 60 * 1_000;

export interface SolanaRpc {
  /** getTokenSupply. Supply AND decimals both come from the chain. */
  getTokenSupply(mint: Mint): Promise<{ amount: bigint; decimals: number } | null>;
  /** DAS getAsset. Metadata is optional and often missing on fresh pump tokens. */
  getAssetMeta(mint: Mint): Promise<{ symbol: string | null; name: string | null } | null>;
}

/** Symbol of last resort when a token has no metadata: the mint's first 4 chars. */
export function fallbackSymbol(mint: Mint): string {
  return mint.slice(0, 4);
}

/**
 * Token supply / decimals / symbol, cached 5 minutes and persisted to `tokens`.
 *
 * NEVER hardcode "pump tokens are 6 decimals and 1B supply". They usually are —
 * and the flagship $RICE is 6 decimals but 982,048,494.78 supply, not 1B, because
 * supply moves. Market cap is computed from this number; hardcoding it would
 * quietly misreport every market cap the bot ever prints. Always read the chain.
 */
export class TokenMetaCache {
  readonly #rpc: SolanaRpc;
  readonly #repo: Repo;
  readonly #log: Logger;
  readonly #ttlMs: number;
  readonly #now: () => number;
  /** Coalesces concurrent misses so a burst of buys triggers ONE RPC call. */
  readonly #inflight = new Map<Mint, Promise<TokenMeta | null>>();
  readonly #mem = new Map<Mint, TokenMeta>();

  constructor(rpc: SolanaRpc, repo: Repo, log: Logger, ttlMs = META_TTL_MS, now: () => number = Date.now) {
    this.#rpc = rpc;
    this.#repo = repo;
    this.#log = log;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /**
   * NOT a type predicate. "Fresh" is a claim about the AGE of a TokenMeta, not
   * about whether it is one — writing `meta is TokenMeta` here makes the compiler
   * narrow a stale-but-present value to `never` in the else branch, which quietly
   * deletes the stale-fallback path below.
   */
  #fresh(meta: TokenMeta | null | undefined): boolean {
    return !!meta && this.#now() - meta.fetchedAtMs < this.#ttlMs;
  }

  /**
   * Fresh metadata for a mint.
   *
   * On an RPC failure we fall back to the last PERSISTED value even if it is
   * stale. A five-minute-old supply is overwhelmingly better than refusing to
   * price a buy — supply barely moves, and the alternative is dropping the post.
   */
  async get(mint: Mint): Promise<TokenMeta | null> {
    const cached = this.#mem.get(mint);
    if (cached && this.#fresh(cached)) return cached;

    const existing = this.#inflight.get(mint);
    if (existing) return existing;

    const task = this.#load(mint).finally(() => this.#inflight.delete(mint));
    this.#inflight.set(mint, task);
    return task;
  }

  async #load(mint: Mint): Promise<TokenMeta | null> {
    const persisted = await this.#repo.getToken(mint);
    if (persisted && this.#fresh(persisted)) {
      this.#mem.set(mint, persisted);
      return persisted;
    }

    try {
      const supply = await this.#rpc.getTokenSupply(mint);
      if (!supply) throw new Error('getTokenSupply returned nothing');

      // Metadata is best-effort: a token with no on-chain name still needs a price.
      let symbol: string | null = null;
      let name: string | null = null;
      try {
        const asset = await this.#rpc.getAssetMeta(mint);
        symbol = asset?.symbol?.trim() || null;
        name = asset?.name?.trim() || null;
      } catch (err) {
        this.#log.debug({ mint, err: msg(err) }, 'asset metadata unavailable; using fallback symbol');
      }

      const meta: TokenMeta = {
        mint,
        symbol: symbol ?? fallbackSymbol(mint),
        name,
        decimals: supply.decimals,
        supplyRaw: supply.amount,
        fetchedAtMs: this.#now(),
      };

      this.#mem.set(mint, meta);
      await this.#repo.putToken(meta);
      this.#log.debug(
        { mint, symbol: meta.symbol, decimals: meta.decimals, supplyRaw: meta.supplyRaw.toString() },
        'token metadata refreshed',
      );
      return meta;
    } catch (err) {
      if (persisted) {
        this.#log.warn(
          { mint, err: msg(err), ageMs: this.#now() - persisted.fetchedAtMs },
          'token metadata refresh failed; using stale persisted value',
        );
        this.#mem.set(mint, persisted);
        return persisted;
      }
      this.#log.error({ mint, err: msg(err) }, 'token metadata unavailable and nothing persisted');
      return null;
    }
  }
}

/** Helius JSON-RPC. The URL carries the API key, so it never reaches a log line. */
export class HeliusRpc implements SolanaRpc {
  readonly #url: string;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;

  constructor(url: string, log: Logger, fetchFn: typeof fetch = fetch) {
    this.#url = url;
    this.#log = log;
    this.#fetch = fetchFn;
  }

  async #call<T>(method: string, params: unknown): Promise<T> {
    const res = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      // INVARIANT 5: report the endpoint, never the key.
      throw new Error(`${method} -> HTTP ${res.status} from ${scrubUrl(this.#url)}`);
    }
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(`${method}: ${json.error.message ?? 'rpc error'}`);
    return json.result as T;
  }

  /** Native SOL balance (lamports) of a wallet. For the whale test's SOL+USDC valuation. */
  async getBalance(pubkey: string): Promise<bigint | null> {
    try {
      const r = await this.#call<{ value: number }>('getBalance', [pubkey, { commitment: 'confirmed' }]);
      return BigInt(r?.value ?? 0);
    } catch (err) {
      this.#log.warn({ err: msg(err) }, 'getBalance failed');
      return null;
    }
  }

  /**
   * Raw balances of specific mints held by a wallet — summed across all its token accounts.
   *
   * One `getTokenAccountsByOwner` over the SPL Token program returns every token account the
   * wallet owns; we keep only the mints asked for. A wallet with a hundred dust tokens makes
   * this response large, but it is ONE round trip and it is cached upstream, which is the right
   * trade vs. a separate call per mint.
   */
  async getTokenBalances(owner: string, mints: readonly string[]): Promise<Map<string, bigint>> {
    const want = new Set(mints);
    const out = new Map<string, bigint>();
    try {
      const r = await this.#call<{
        value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }[];
      }>('getTokenAccountsByOwner', [
        owner,
        { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);
      for (const acc of r?.value ?? []) {
        const info = acc.account.data.parsed.info;
        if (!want.has(info.mint)) continue;
        out.set(info.mint, (out.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
      }
    } catch (err) {
      this.#log.warn({ err: msg(err) }, 'getTokenBalances failed');
    }
    return out;
  }

  /**
   * EVERY token account a wallet owns, with mint and decimals — for the autotrader's /wallet
   * inventory (phase 12).
   *
   * Distinct from `getTokenBalances`, which filters to mints the caller already cares about.
   * Here the whole point is the ones nobody asked about: the exposure warning counts what a
   * user would lose that they were not thinking about.
   *
   * Unlike the read above this one THROWS on failure rather than returning an empty list. An
   * empty inventory rendered from a failed RPC reads as "this wallet holds nothing", which is
   * the most dangerous possible thing to tell someone under a warning about what they could
   * lose. The guard's account enumeration reads the same way, for the same reason.
   */
  async getOwnedTokenAccountsParsed(
    owner: string,
  ): Promise<readonly { mint: string; amountRaw: bigint; decimals: number }[]> {
    const r = await this.#call<{
      value: {
        account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } };
      }[];
    }>('getTokenAccountsByOwner', [
      owner,
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);

    return (r?.value ?? []).map((acc) => {
      const info = acc.account.data.parsed.info;
      return { mint: info.mint, amountRaw: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals };
    });
  }

  /** Current confirmed slot. Gap recovery compares it against the stored cursor. */
  async getSlot(): Promise<number | null> {
    try {
      return await this.#call<number>('getSlot', [{ commitment: 'confirmed' }]);
    } catch (err) {
      this.#log.warn({ err: msg(err) }, 'getSlot failed');
      return null;
    }
  }

  /** Newest-first signatures that touched an address. Gap recovery walks these back. */
  async getSignaturesForAddress(
    mint: Mint,
    limit: number,
  ): Promise<readonly { signature: string; slot: number; blockTime: number | null }[]> {
    const r = await this.#call<{ signature: string; slot: number; blockTime: number | null; err: unknown }[]>(
      'getSignaturesForAddress',
      [mint, { limit, commitment: 'confirmed' }],
    );
    // Failed transactions never moved a balance, so they can never be a buy.
    return (r ?? []).filter((x) => x.err === null);
  }

  async getTransaction(signature: string): Promise<ConfirmedTx | null> {
    return this.#call<ConfirmedTx | null>('getTransaction', [
      signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
  }

  /**
   * Raw JSON-RPC passthrough for callers that need a method not wrapped above — the Phase 14
   * trade chain adapter (simulate / send / getSignatureStatuses / getTokenAccountsByOwner-base64).
   * Kept narrow and off the hot path; the wrapped methods above stay the preferred surface.
   */
  rpc<T>(method: string, params: unknown): Promise<T> {
    return this.#call<T>(method, params);
  }

  async getTokenSupply(mint: Mint): Promise<{ amount: bigint; decimals: number } | null> {
    const r = await this.#call<{ value?: { amount: string; decimals: number } }>('getTokenSupply', [mint]);
    if (!r?.value) return null;
    // amount is a decimal STRING; BigInt it. Number() would round a u64.
    return { amount: BigInt(r.value.amount), decimals: r.value.decimals };
  }

  async getAssetMeta(mint: Mint): Promise<{ symbol: string | null; name: string | null } | null> {
    try {
      const r = await this.#call<{
        content?: { metadata?: { symbol?: string; name?: string } };
        token_info?: { symbol?: string };
      }>('getAsset', { id: mint });

      const symbol = r?.token_info?.symbol ?? r?.content?.metadata?.symbol ?? null;
      const name = r?.content?.metadata?.name ?? null;
      return { symbol, name };
    } catch (err) {
      this.#log.debug({ mint, err: msg(err) }, 'getAsset failed');
      return null;
    }
  }
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
