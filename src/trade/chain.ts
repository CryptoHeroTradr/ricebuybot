import type { ConfirmedTx } from '../ingest/solana-types.js';
import type { Logger } from '../ops/logger.js';
import { parseTokenAccount, TOKEN_PROGRAM, type TokenAccountState } from './guard.js';
import type { SimulationRpc } from './signer.js';
import type { ChainRpc, SignatureStatus } from './executor.js';

/**
 * Phase 14 — the chain adapter that backs BOTH the signer's guard (`SimulationRpc`) and the
 * executor (`ChainRpc`), over the Helius JSON-RPC. It is the single place that knows the wire
 * shapes of simulate / send / getSignatureStatuses; everything above it works in typed results.
 */

export interface RawRpc {
  rpc<T>(method: string, params: unknown): Promise<T>;
  getTransaction(signature: string): Promise<ConfirmedTx | null>;
}

interface SimValue {
  err: unknown;
  accounts: ({ data: [string, string] } | null)[] | null;
}
interface StatusValue {
  confirmationStatus: SignatureStatus['confirmationStatus'];
  err: unknown;
  slot: number;
}

export class TradeChain implements SimulationRpc, ChainRpc {
  readonly #rpc: RawRpc;
  readonly #log: Logger;

  constructor(rpc: RawRpc, log: Logger) {
    this.#rpc = rpc;
    this.#log = log.child({ mod: 'trade-chain' });
  }

  // --- SimulationRpc (the signer's guard) ---------------------------------------------------

  /** Simulate an UNSIGNED tx and return the post-execution state of `addresses`. Fails closed:
   *  any transport error rejects (never a resolved-but-empty result). */
  async simulateTransaction(
    txBase64: string,
    addresses: readonly string[],
  ): Promise<{ err: unknown; accounts: readonly (string | null)[] }> {
    const r = await this.#rpc.rpc<{ value: SimValue | null }>('simulateTransaction', [
      txBase64,
      {
        sigVerify: false,
        replaceRecentBlockhash: true,
        encoding: 'base64',
        commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: [...addresses] },
      },
    ]);
    const value = r?.value;
    if (!value) throw new Error('simulateTransaction returned no value');
    const accounts = (value.accounts ?? []).map((a) => (a && a.data ? a.data[0] : null));
    return { err: value.err ?? null, accounts };
  }

  /** Every token account the wallet owns, parsed for the guard's diff. THROWS on failure — an
   *  empty list from a failed RPC would read as "owns nothing", the guard's worst false positive. */
  async getOwnedTokenAccounts(owner: string): Promise<readonly TokenAccountState[]> {
    const r = await this.#rpc.rpc<{ value: { pubkey: string; account: { data: [string, string] } }[] }>(
      'getTokenAccountsByOwner',
      [owner, { programId: TOKEN_PROGRAM }, { encoding: 'base64', commitment: 'confirmed' }],
    );
    return (r?.value ?? []).map((x) => parseTokenAccount(x.pubkey, Buffer.from(x.account.data[0], 'base64')));
  }

  // --- ChainRpc (the executor) --------------------------------------------------------------

  async simulate(txBase64: string): Promise<{ err: unknown }> {
    const r = await this.#rpc.rpc<{ value: { err: unknown } | null }>('simulateTransaction', [
      txBase64,
      { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', commitment: 'confirmed' },
    ]);
    return { err: r?.value?.err ?? null };
  }

  async send(txBase64: string): Promise<string> {
    // skipPreflight:false so the node also rejects an obviously-bad tx; we already simulated, this
    // is belt and braces. maxRetries lets the RPC re-broadcast while the blockhash is alive.
    return this.#rpc.rpc<string>('sendTransaction', [
      txBase64,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);
  }

  async signatureStatus(signature: string): Promise<SignatureStatus | null> {
    const r = await this.#rpc.rpc<{ value: (StatusValue | null)[] }>('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const s = r?.value?.[0];
    return s ? { confirmationStatus: s.confirmationStatus, err: s.err ?? null, slot: s.slot } : null;
  }

  getTransaction(signature: string): Promise<ConfirmedTx | null> {
    return this.#rpc.getTransaction(signature);
  }
}
