import { sign as edSign } from 'node:crypto';

import { decodeBase58, encodeBase58 } from './base58.js';
import { assertOnlyAllowedEffects, GuardError, parseTokenAccount, type TokenAccountState } from './guard.js';
import type { Keystore } from './keystore.js';
import type { AutotraderAccessRepo } from './access.js';
import { checkMember } from './access.js';
import type { Logger } from '../ops/logger.js';

/**
 * THE ONLY EXPORTED SURFACE THAT TOUCHES A KEY — and it is ALWAYS scoped to a user id.
 *
 * `sign(userId, allowedMints, tx)` has no overload without a user, no ambient "current user"
 * and no default. Cross-user signing is not forbidden by a runtime check that someone can
 * forget to call; it is UNREPRESENTABLE, because there is no expression in this module that
 * reaches a key without naming whose key it is. That is the difference between a rule and a
 * type (INVARIANT 15).
 *
 * The order of operations is deliberate and must not be rearranged:
 *
 *   1. allowlist   — a removed member cannot sign, checked at action time, never cached
 *   2. unlocked    — a locked wallet throws; it never signs with a zeroed buffer
 *   3. fee payer   — the transaction must pay from THIS user's wallet
 *   4. GUARD       — simulate, diff, assert (guard.ts)
 *   5. sign        — only now does a key get used
 *
 * Every step before 5 can throw, and all of them throw BEFORE any signature exists.
 */

/** What the signer needs from the chain. Narrow on purpose. */
export interface SimulationRpc {
  /**
   * Simulate and return the POST-EXECUTION state of `addresses`.
   *
   * Must reject (not return null, not return a partial result) on any transport failure —
   * the guard fails closed, and a resolved-but-empty response is indistinguishable from
   * "nothing happened", which is the one answer we must never accept by accident.
   */
  simulateTransaction(
    txBase64: string,
    addresses: readonly string[],
  ): Promise<{ err: unknown; accounts: readonly (string | null)[] }>;

  /** Every token account owned by this wallet, as it stands right now. */
  getOwnedTokenAccounts(owner: string): Promise<readonly TokenAccountState[]>;
}

export class SignerError extends Error {
  constructor(
    message: string,
    readonly code: 'not-a-member' | 'locked' | 'no-keystore' | 'wrong-fee-payer' | 'malformed-tx',
  ) {
    super(message);
    this.name = 'SignerError';
  }
}

export interface SignerDeps {
  readonly keystore: Keystore;
  readonly access: AutotraderAccessRepo;
  readonly rpc: SimulationRpc;
  readonly log: Logger;
}

/**
 * Compact-u16 ("shortvec"), Solana's array-length encoding. Up to three bytes, 7 bits each.
 */
function readShortVec(buf: Buffer, offset: number): { value: number; size: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buf.length) throw new SignerError('truncated transaction', 'malformed-tx');
    const byte = buf[offset + size] as number;
    value |= (byte & 0x7f) << (size * 7);
    size++;
    if ((byte & 0x80) === 0) break;
    if (size > 3) throw new SignerError('malformed length prefix', 'malformed-tx');
  }
  return { value, size };
}

/**
 * Split a serialized transaction into its signature block and its message, and read the FEE
 * PAYER — the first static account key.
 *
 * This reads FRAMING ONLY: the signature count, the message header, and the first 32-byte
 * account key. It does not walk the instruction list, does not look at a program id and does
 * not resolve address lookup tables. Those are the guard's job, and the guard does them by
 * simulation (guard.ts). The distinction matters: framing is a fixed, versionless layout that
 * cannot be extended by a new program, so reading it here does not reintroduce the decoder
 * this design exists to avoid.
 */
export function frameTransaction(raw: Buffer): { sigCount: number; sigOffset: number; message: Buffer; feePayer: string } {
  const { value: sigCount, size: sigLenSize } = readShortVec(raw, 0);
  const sigOffset = sigLenSize;
  const messageStart = sigOffset + sigCount * 64;

  if (messageStart >= raw.length) throw new SignerError('truncated transaction', 'malformed-tx');
  const message = raw.subarray(messageStart);

  // A versioned (v0+) message sets the high bit of its first byte; legacy messages start
  // straight into the header. Either way the fee payer is the first static key.
  let cursor = 0;
  if (((message[0] as number) & 0x80) !== 0) cursor = 1;
  cursor += 3; // header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned

  const { value: keyCount, size: keyLenSize } = readShortVec(message, cursor);
  cursor += keyLenSize;
  if (keyCount === 0) throw new SignerError('transaction has no account keys', 'malformed-tx');
  if (cursor + 32 > message.length) throw new SignerError('truncated account keys', 'malformed-tx');

  return { sigCount, sigOffset, message, feePayer: encodeBase58(message.subarray(cursor, cursor + 32)) };
}

export class Signer {
  readonly #keystore: Keystore;
  readonly #access: AutotraderAccessRepo;
  readonly #rpc: SimulationRpc;
  readonly #log: Logger;

  constructor(deps: SignerDeps) {
    this.#keystore = deps.keystore;
    this.#access = deps.access;
    this.#rpc = deps.rpc;
    this.#log = deps.log;
  }

  /**
   * @param userId       whose key. There is no signing without one.
   * @param allowedMints from the SCHEDULE ROW, by the caller. Never derived here.
   * @param txBase64     the unsigned transaction.
   */
  async sign(userId: number, allowedMints: readonly string[], txBase64: string): Promise<string> {
    // 1. allowlist, at action time
    const verdict = await checkMember(this.#access, userId);
    if (!verdict.allowed) throw new SignerError('not an autotrader member', 'not-a-member');

    // 2. unlocked. A locked wallet has no key in memory and must not fall back to anything.
    if (!this.#keystore.has(userId)) throw new SignerError('no keystore for that user', 'no-keystore');
    const key = this.#keystore.get(userId);
    if (!key) throw new SignerError('wallet is locked', 'locked');

    const raw = Buffer.from(txBase64, 'base64');
    const framed = frameTransaction(raw);

    // 3. the transaction must spend from THIS user's wallet
    if (framed.feePayer !== key.pubkey) {
      throw new SignerError('transaction fee payer is not this user\'s wallet', 'wrong-fee-payer');
    }

    // 4. THE GUARD. Enumerate the user's accounts ourselves, simulate, diff, assert.
    await this.#guard(key.pubkey, allowedMints, txBase64);

    // 5. sign. The first signature slot belongs to the fee payer, which we just proved is us.
    const signature = edSign(null, framed.message, key.signingKey);
    const out = Buffer.from(raw);
    signature.copy(out, framed.sigOffset);

    this.#log.info(
      { userId, pubkey: key.pubkey, allowedMints: [...allowedMints] },
      'autotrader: transaction signed (guard passed)',
    );
    return out.toString('base64');
  }

  async #guard(walletPubkey: string, allowedMints: readonly string[], txBase64: string): Promise<void> {
    const before = await this.#rpc.getOwnedTokenAccounts(walletPubkey);
    const addresses = before.map((a) => a.address);

    // A wallet with no token accounts still gets simulated: the simulation is also how we
    // learn the transaction executes at all, and refusing to simulate would mean signing a
    // transaction nothing has looked at.
    const sim = await this.#rpc.simulateTransaction(txBase64, addresses);

    if (sim.err !== null && sim.err !== undefined) {
      throw new GuardError(`simulation failed: ${JSON.stringify(sim.err)}`, 'simulation-failed');
    }
    if (sim.accounts.length !== addresses.length) {
      // Fail closed. A short array means we cannot account for every address we asked about.
      throw new GuardError('simulation returned fewer accounts than requested', 'simulation-failed');
    }

    const after = new Map<string, TokenAccountState | null>();
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i] as string;
      const data = sim.accounts[i];
      after.set(address, data === null || data === undefined ? null : parseTokenAccount(address, Buffer.from(data, 'base64')));
    }

    assertOnlyAllowedEffects({ walletPubkey, allowedMints, before, after });
  }
}

/** Re-exported so callers validate a pubkey without importing base58 directly. */
export { decodeBase58, encodeBase58 };
