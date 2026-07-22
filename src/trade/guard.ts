import { encodeBase58 } from './base58.js';

/**
 * THE MINT GUARD (INVARIANT 18) — BY SIMULATION, NOT BY DECOMPILATION.
 *
 * We do not parse the transaction's instructions. We ask the chain what the transaction WOULD
 * DO and diff the user's own accounts across that simulation. This is INVARIANT 1's reasoning
 * applied to signing: an instruction decoder must be taught every program, every CPI and every
 * new router, and it is wrong the day someone ships a program it has not met. An effect diff is
 * indifferent to how the effect was achieved.
 *
 * WHAT IS DIFFED, AND WHY IT IS NOT JUST BALANCES.
 *
 * A balance diff would miss the three drain vectors that matter most, because NONE of them
 * moves a token:
 *
 *   Approve        -> delegate set. Zero tokens move. The attacker drains later, using the
 *                     delegation the owner themselves authorised.
 *   SetAuthority   -> account owner (or close authority) reassigned. Zero tokens move.
 *   CloseAccount   -> on an emptied account. Zero tokens move.
 *
 * So we diff the ACCOUNT STATE — mint, owner, amount, delegate, delegated amount, close
 * authority — of every token account the user owns. Those are fixed offsets in the SPL token
 * account layout. Reading six fields at known offsets is not an instruction parser: there are
 * no discriminators here, no CPI reasoning, no address-lookup-table resolution.
 *
 * THE ACCOUNT LIST COMES FROM US, NOT FROM THE TRANSACTION. It is enumerated with
 * `getTokenAccountsByOwner` against the user's pubkey. A transaction cannot hide an account
 * from the guard by omitting it, and — with `allowedMints` supplied by the CALLER from the
 * schedule row — the guard never derives its own permission from the thing it is guarding.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO. Read this before trusting it.
 *
 * 1. IT CONSTRAINS THE BOT, NOT AN ATTACKER. It runs before we sign. Someone holding the
 *    decrypted key signs whatever they like and never comes near this code. This is not wallet
 *    security; it is a leash on our own automation. The /wallet warning says the same thing to
 *    users and must keep saying it.
 *
 * 2. TOCTOU. Simulation runs against a recent bank; execution happens later against a different
 *    one. A transaction that branches on on-chain state can simulate benign and execute hostile.
 *    Re-simulate immediately before send and keep blockhash validity short. This narrows the
 *    window; it does not close it.
 *
 * 3. IT TRUSTS THE RPC. A hostile or compromised endpoint can report a clean simulation. A
 *    local decoder would depend only on local code. That is the price of not having a decoder,
 *    and it is why every RPC failure here THROWS rather than degrading.
 *
 * 4. IT DOES NOT CAP VALUE. A swap legitimately spends SOL, so "spent SOL" cannot be an error
 *    here. How MUCH may be spent is INVARIANT 17's per-execution and 24h caps, enforced by the
 *    caller. This guard answers "which assets", never "how much".
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** SPL token account layout. Fixed offsets — the whole of what this module reads. */
const TOKEN_ACCOUNT_LEN = 165;
const OFF_MINT = 0;
const OFF_OWNER = 32;
const OFF_AMOUNT = 64;
const OFF_DELEGATE_TAG = 72;
const OFF_DELEGATE = 76;
const OFF_DELEGATED_AMOUNT = 121;
const OFF_CLOSE_AUTH_TAG = 129;
const OFF_CLOSE_AUTH = 133;

export interface TokenAccountState {
  readonly address: string;
  readonly mint: string;
  readonly owner: string;
  readonly amount: bigint;
  readonly delegate: string | null;
  readonly delegatedAmount: bigint;
  readonly closeAuthority: string | null;
}

export class GuardError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'simulation-failed'
      | 'foreign-mint'
      | 'authority-change'
      | 'delegate-change'
      | 'close-authority-change'
      | 'account-closed'
      | 'owner-change'
      | 'unreadable-account',
  ) {
    super(message);
    this.name = 'GuardError';
  }
}

function pubkeyAt(data: Buffer, offset: number): string {
  return encodeBase58(data.subarray(offset, offset + 32));
}

/** Parse the six fields we care about. Anything shorter than the layout is not a token account. */
export function parseTokenAccount(address: string, raw: Buffer): TokenAccountState {
  if (raw.length < TOKEN_ACCOUNT_LEN) {
    throw new GuardError(`token account ${address} is ${raw.length} bytes, expected ${TOKEN_ACCOUNT_LEN}`, 'unreadable-account');
  }
  const delegated = raw.readUInt32LE(OFF_DELEGATE_TAG) === 1;
  const closeSet = raw.readUInt32LE(OFF_CLOSE_AUTH_TAG) === 1;

  return {
    address,
    mint: pubkeyAt(raw, OFF_MINT),
    owner: pubkeyAt(raw, OFF_OWNER),
    amount: raw.readBigUInt64LE(OFF_AMOUNT),
    delegate: delegated ? pubkeyAt(raw, OFF_DELEGATE) : null,
    delegatedAmount: raw.readBigUInt64LE(OFF_DELEGATED_AMOUNT),
    closeAuthority: closeSet ? pubkeyAt(raw, OFF_CLOSE_AUTH) : null,
  };
}

export interface GuardInput {
  /** The user's wallet. Every account below must be owned by it. */
  readonly walletPubkey: string;
  /**
   * FROM THE CALLER — the schedule row's configured mint(s). Never derived from the
   * transaction, never defaulted to "whatever it touches". SOL/WSOL is always permitted on
   * top of these because it is the pair side of every swap.
   */
  readonly allowedMints: readonly string[];
  /** The user's token accounts BEFORE, from our own enumeration. */
  readonly before: readonly TokenAccountState[];
  /** The same accounts AFTER simulation. Missing = the transaction closed it. */
  readonly after: ReadonlyMap<string, TokenAccountState | null>;
}

/**
 * Assert a simulated transaction only did things a DCA bot is allowed to do.
 *
 * Throws on the FIRST violation. It never returns a "mostly fine" verdict, and there is no
 * severity ladder: a guard with a warning level is a guard someone will learn to ignore.
 */
export function assertOnlyAllowedEffects(input: GuardInput): void {
  const permitted = new Set<string>([WSOL_MINT, ...input.allowedMints]);

  for (const pre of input.before) {
    const post = input.after.get(pre.address);

    // --- the account vanished -------------------------------------------------------------
    //
    // Unwrapping a wSOL account at the end of a swap is ordinary and expected. Closing
    // anything else is a DCA bot doing something it has no reason to do, and CloseAccount
    // sends the rent lamports somewhere the guard is not looking.
    if (post === null || post === undefined) {
      if (pre.mint === WSOL_MINT) continue;
      throw new GuardError(`transaction closes token account ${pre.address} (mint ${pre.mint})`, 'account-closed');
    }

    // --- authority and delegation: checked on EVERY account, allowed mint or not ----------
    //
    // These are the zero-balance drain vectors. A delegate on the RICE account is exactly as
    // fatal as one on an NFT, so `permitted` does not enter into it. Note the comparisons are
    // against the PRE state, not against null: an account that already had a delegate keeps
    // it, but this transaction may not be the thing that changes one.
    if (post.owner !== pre.owner) {
      throw new GuardError(`transaction reassigns owner of ${pre.address} (SetAuthority)`, 'owner-change');
    }
    if (post.delegate !== pre.delegate) {
      throw new GuardError(`transaction sets a delegate on ${pre.address} (Approve)`, 'delegate-change');
    }
    if (post.delegatedAmount !== pre.delegatedAmount) {
      throw new GuardError(`transaction changes the delegated amount on ${pre.address} (Approve)`, 'delegate-change');
    }
    if (post.closeAuthority !== pre.closeAuthority) {
      throw new GuardError(`transaction changes the close authority of ${pre.address} (SetAuthority)`, 'close-authority-change');
    }
    if (post.mint !== pre.mint) {
      throw new GuardError(`account ${pre.address} changed mint — refusing to sign`, 'unreadable-account');
    }

    // --- value movement: only on mints the CALLER allowed ---------------------------------
    //
    // An NFT transfer lands here: its balance goes 1 -> 0 and its mint is not in `permitted`,
    // so it throws. So does a swap of some unrelated SPL token the wallet happens to hold.
    if (post.amount !== pre.amount && !permitted.has(pre.mint)) {
      throw new GuardError(
        `transaction moves mint ${pre.mint}, which is not SOL/wSOL and not in the schedule's allowed mints`,
        'foreign-mint',
      );
    }
  }
}
