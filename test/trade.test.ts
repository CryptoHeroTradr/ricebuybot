import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import pino from 'pino';

import { decodeBase58, encodeBase58, looksLikeSecretKey } from '../src/trade/base58.js';
import { Keystore, KeystoreError, keypairFromSecret } from '../src/trade/keystore.js';
import { assertOnlyAllowedEffects, GuardError, parseTokenAccount, WSOL_MINT, type TokenAccountState } from '../src/trade/guard.js';
import { Signer, SignerError, frameTransaction, type SimulationRpc } from '../src/trade/signer.js';
import { checkMember, type AutotraderAccessRepo, type AutotraderMember } from '../src/trade/access.js';
import { isSecretKeyBase58, scrub, scrubDeep } from '../src/ops/logger.js';

const RICE = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const log = pino({ level: 'silent' });

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ricebuybot-keystore-'));
}

/** A real ed25519 secret, produced the same way /wallet generate does. */
function freshSecret(): { secret: Buffer; pubkey: string; base58: string } {
  const ks = new Keystore({ dir: tmpDir() });
  const { secretBase58 } = ks.generate(1, 'throwaway');
  const secret = Buffer.from(decodeBase58(secretBase58));
  return { secret, pubkey: keypairFromSecret(secret).pubkey, base58: secretBase58 };
}

// ---------------------------------------------------------------------------------------------
// base58
// ---------------------------------------------------------------------------------------------

describe('base58', () => {
  it('round-trips, including leading zero bytes', () => {
    const cases = [Buffer.from([0, 0, 1, 2, 3]), Buffer.from('hello world'), randomBytes(64)];
    for (const c of cases) expect(Buffer.from(decodeBase58(encodeBase58(c)))).toEqual(c);
  });

  it('matches known vectors', () => {
    expect(encodeBase58(Buffer.from([0]))).toBe('1');
    expect(encodeBase58(Buffer.from('hello world'))).toBe('StV1DL6CwTryKyV');
    expect(Buffer.from(decodeBase58('StV1DL6CwTryKyV')).toString()).toBe('hello world');
  });

  /** A decoder that echoes its input is a decoder that logs somebody's key. */
  it('never echoes the input in an error', () => {
    const secret = freshSecret().base58;
    try {
      decodeBase58(`${secret}0OIl`);
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(secret);
      expect(message).not.toContain(secret.slice(0, 8));
    }
  });

  it('recognises a 64-byte secret by shape', () => {
    expect(looksLikeSecretKey(freshSecret().base58)).toBe(true);
    expect(looksLikeSecretKey(RICE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// keystore — INVARIANT 15
// ---------------------------------------------------------------------------------------------

describe('keystore: one per user, no master key (INVARIANT 15)', () => {
  it('a wrong passphrase FAILS CLOSED — it does not return garbage', () => {
    const ks = new Keystore({ dir: tmpDir() });
    const { secret } = freshSecret();
    ks.import(7, secret, 'correct horse battery staple');

    // AEAD: authentication happens before plaintext is returned, so this throws rather than
    // yielding rubbish that would later be signed with.
    expect(() => ks.unlock(7, 'wrong passphrase')).toThrow(KeystoreError);
    try {
      ks.unlock(7, 'wrong passphrase');
    } catch (err) {
      expect((err as KeystoreError).code).toBe('bad-passphrase');
    }
    expect(ks.isUnlocked(7)).toBe(false);
    expect(ks.get(7)).toBeNull();
  });

  /** THE INVARIANT. If this can ever pass, the whole per-user design is decoration. */
  it("user A's passphrase cannot decrypt user B's keystore", () => {
    const ks = new Keystore({ dir: tmpDir() });
    const a = freshSecret();
    const b = freshSecret();
    ks.import(1, a.secret, 'passphrase-A');
    ks.import(2, b.secret, 'passphrase-B');

    expect(() => ks.unlock(2, 'passphrase-A')).toThrow(KeystoreError);
    expect(() => ks.unlock(1, 'passphrase-B')).toThrow(KeystoreError);

    // And each still opens with its own.
    expect(ks.unlock(1, 'passphrase-A').pubkey).toBe(a.pubkey);
    expect(ks.unlock(2, 'passphrase-B').pubkey).toBe(b.pubkey);
  });

  /**
   * NO MASTER KEY PATH. Asserted structurally, not by trying passphrases: every unlock derives
   * from the file's OWN salt plus the supplied passphrase, so two keystores never share key
   * material, and there is no field in the file that any other secret could open.
   */
  it('has no master key: distinct salts, and nothing shared between files', () => {
    const dir = tmpDir();
    const ks = new Keystore({ dir });
    ks.import(1, freshSecret().secret, 'same-passphrase');
    ks.import(2, freshSecret().secret, 'same-passphrase');

    const one = JSON.parse(readFileSync(join(dir, '1.json'), 'utf8'));
    const two = JSON.parse(readFileSync(join(dir, '2.json'), 'utf8'));

    // Even with an IDENTICAL passphrase the derived keys differ, because the salt differs.
    expect(one.salt).not.toBe(two.salt);
    expect(one.iv).not.toBe(two.iv);
    expect(one.ct).not.toBe(two.ct);

    // The file carries no escrow blob, no shared wrap, no operator copy.
    expect(Object.keys(one).sort()).toEqual(
      ['cipher', 'createdAt', 'ct', 'iv', 'kdf', 'n', 'p', 'pubkey', 'r', 'salt', 'tag', 'userId', 'v'].sort(),
    );
  });

  it('never writes a plaintext secret to disk, and the file is 0600', () => {
    const dir = tmpDir();
    const ks = new Keystore({ dir });
    const { secret, base58 } = freshSecret();
    ks.import(9, secret, 'pw');

    const raw = readFileSync(join(dir, '9.json'), 'utf8');
    expect(raw).not.toContain(base58);
    expect(raw).not.toContain(secret.toString('base64'));
    expect(raw).not.toContain(secret.toString('hex'));

    expect(statSync(join(dir, '9.json')).mode & 0o777).toBe(0o600);
  });

  it('zeroes the key on lock, and lockAll clears every user', () => {
    const ks = new Keystore({ dir: tmpDir() });
    ks.import(1, freshSecret().secret, 'pw');
    const live = ks.unlock(1, 'pw');
    expect(live.secret.some((b) => b !== 0)).toBe(true);

    ks.lock(1);
    expect(live.secret.every((b) => b === 0)).toBe(true); // actually zeroed, not just dropped
    expect(ks.isUnlocked(1)).toBe(false);

    ks.import(2, freshSecret().secret, 'pw2');
    ks.unlock(2, 'pw2');
    ks.lockAll();
    expect(ks.unlockedUsers()).toEqual([]);
  });

  it('rejects a malformed secret whose halves disagree', () => {
    const bad = Buffer.concat([freshSecret().secret.subarray(0, 32), randomBytes(32)]);
    expect(() => keypairFromSecret(bad)).toThrow(/malformed/);
  });

  /** Revocation is not destruction (INVARIANT 14). Only purge deletes. */
  it('purge deletes the keystore; nothing else does', () => {
    const ks = new Keystore({ dir: tmpDir() });
    ks.import(3, freshSecret().secret, 'pw');
    ks.unlock(3, 'pw');

    ks.lock(3);
    expect(ks.has(3)).toBe(true); // locking a wallet must never delete it

    expect(ks.purge(3)).toBe(true);
    expect(ks.has(3)).toBe(false);
    expect(ks.pubkeyOf(3)).toBeNull();
  });

  it('the pubkey is readable while locked, so /wallet works at rest', () => {
    const ks = new Keystore({ dir: tmpDir() });
    const { secret, pubkey } = freshSecret();
    ks.import(4, secret, 'pw');
    expect(ks.isUnlocked(4)).toBe(false);
    expect(ks.pubkeyOf(4)).toBe(pubkey);
  });
});

// ---------------------------------------------------------------------------------------------
// the guard — INVARIANT 18
// ---------------------------------------------------------------------------------------------

/** Build a 165-byte SPL token account. */
function tokenAccount(opts: {
  address: string;
  mint: string;
  owner: string;
  amount: bigint;
  delegate?: string | null;
  delegatedAmount?: bigint;
  closeAuthority?: string | null;
}): Buffer {
  const buf = Buffer.alloc(165);
  Buffer.from(decodeBase58(opts.mint)).copy(buf, 0);
  Buffer.from(decodeBase58(opts.owner)).copy(buf, 32);
  buf.writeBigUInt64LE(opts.amount, 64);
  if (opts.delegate) {
    buf.writeUInt32LE(1, 72);
    Buffer.from(decodeBase58(opts.delegate)).copy(buf, 76);
  }
  buf.writeBigUInt64LE(opts.delegatedAmount ?? 0n, 121);
  if (opts.closeAuthority) {
    buf.writeUInt32LE(1, 129);
    Buffer.from(decodeBase58(opts.closeAuthority)).copy(buf, 133);
  }
  return buf;
}

const WALLET = freshSecret().pubkey;
const ATTACKER = freshSecret().pubkey;
const RICE_ATA = freshSecret().pubkey;
const BONK_ATA = freshSecret().pubkey;
const NFT_ATA = freshSecret().pubkey;
const NFT_MINT = freshSecret().pubkey;

const riceBefore: TokenAccountState = parseTokenAccount(
  RICE_ATA,
  tokenAccount({ address: RICE_ATA, mint: RICE, owner: WALLET, amount: 1_000n }),
);
const bonkBefore: TokenAccountState = parseTokenAccount(
  BONK_ATA,
  tokenAccount({ address: BONK_ATA, mint: BONK, owner: WALLET, amount: 5_000n }),
);
const nftBefore: TokenAccountState = parseTokenAccount(
  NFT_ATA,
  tokenAccount({ address: NFT_ATA, mint: NFT_MINT, owner: WALLET, amount: 1n }),
);

function after(entries: Array<[string, Buffer | null]>): Map<string, TokenAccountState | null> {
  return new Map(entries.map(([addr, buf]) => [addr, buf === null ? null : parseTokenAccount(addr, buf)]));
}

describe('the mint guard (INVARIANT 18)', () => {
  it('allows a SOL -> RICE swap when RICE is the allowed mint', () => {
    expect(() =>
      assertOnlyAllowedEffects({
        walletPubkey: WALLET,
        allowedMints: [RICE],
        before: [riceBefore, bonkBefore, nftBefore],
        after: after([
          [RICE_ATA, tokenAccount({ address: RICE_ATA, mint: RICE, owner: WALLET, amount: 2_000n })], // gained
          [BONK_ATA, tokenAccount({ address: BONK_ATA, mint: BONK, owner: WALLET, amount: 5_000n })], // untouched
          [NFT_ATA, tokenAccount({ address: NFT_ATA, mint: NFT_MINT, owner: WALLET, amount: 1n })],
        ]),
      }),
    ).not.toThrow();
  });

  it('THROWS on a swap of an unrelated SPL token', () => {
    expect(() =>
      assertOnlyAllowedEffects({
        walletPubkey: WALLET,
        allowedMints: [RICE],
        before: [riceBefore, bonkBefore],
        after: after([
          [RICE_ATA, tokenAccount({ address: RICE_ATA, mint: RICE, owner: WALLET, amount: 1_000n })],
          [BONK_ATA, tokenAccount({ address: BONK_ATA, mint: BONK, owner: WALLET, amount: 0n })], // drained
        ]),
      }),
    ).toThrow(/not in the schedule's allowed mints/);
  });

  it('THROWS on an NFT transfer', () => {
    expect(() =>
      assertOnlyAllowedEffects({
        walletPubkey: WALLET,
        allowedMints: [RICE],
        before: [nftBefore],
        after: after([[NFT_ATA, tokenAccount({ address: NFT_ATA, mint: NFT_MINT, owner: WALLET, amount: 0n })]]),
      }),
    ).toThrow(GuardError);
  });

  /**
   * THE ZERO-BALANCE DRAIN VECTORS. None of these moves a single token, so a balance-only diff
   * would wave all three through. This is the reason the guard diffs account STATE.
   */
  it('THROWS on Approve (delegate set) — which moves nothing', () => {
    expect(() =>
      assertOnlyAllowedEffects({
        walletPubkey: WALLET,
        allowedMints: [RICE],
        before: [riceBefore],
        after: after([
          [
            RICE_ATA,
            tokenAccount({ address: RICE_ATA, mint: RICE, owner: WALLET, amount: 1_000n, delegate: ATTACKER, delegatedAmount: 1_000n }),
          ],
        ]),
      }),
    ).toThrow(/delegate/i);
  });

  it('THROWS on SetAuthority (owner reassigned) — which moves nothing', () => {
    expect(() =>
      assertOnlyAllowedEffects({
        walletPubkey: WALLET,
        allowedMints: [RICE],
        before: [riceBefore],
        after: after([[RICE_ATA, tokenAccount({ address: RICE_ATA, mint: RICE, owner: ATTACKER, amount: 1_000n })]]),
      }),
    ).toThrow(/reassigns owner/);
  });

  it('THROWS on a close authority being set — which moves nothing', () => {
    expect(() =>
      assertOnlyAllowedEffects({
        walletPubkey: WALLET,
        allowedMints: [RICE],
        before: [riceBefore],
        after: after([
          [RICE_ATA, tokenAccount({ address: RICE_ATA, mint: RICE, owner: WALLET, amount: 1_000n, closeAuthority: ATTACKER })],
        ]),
      }),
    ).toThrow(/close authority/);
  });

  it('THROWS on CloseAccount of a non-wSOL account', () => {
    expect(() =>
      assertOnlyAllowedEffects({
        walletPubkey: WALLET,
        allowedMints: [RICE],
        before: [riceBefore],
        after: after([[RICE_ATA, null]]),
      }),
    ).toThrow(/closes token account/);
  });

  it('permits unwrapping wSOL, which every swap does', () => {
    const wsolAta = freshSecret().pubkey;
    const before = parseTokenAccount(wsolAta, tokenAccount({ address: wsolAta, mint: WSOL_MINT, owner: WALLET, amount: 5n }));
    expect(() =>
      assertOnlyAllowedEffects({ walletPubkey: WALLET, allowedMints: [RICE], before: [before], after: after([[wsolAta, null]]) }),
    ).not.toThrow();
  });

  /**
   * allowedMints IS THE CALLER'S. A transaction cannot widen its own permission by touching a
   * mint — that is the difference between a guard and a rubber stamp.
   */
  it('cannot be satisfied by the transaction describing itself', () => {
    const call = (allowedMints: readonly string[]) =>
      assertOnlyAllowedEffects({
        walletPubkey: WALLET,
        allowedMints,
        before: [bonkBefore],
        after: after([[BONK_ATA, tokenAccount({ address: BONK_ATA, mint: BONK, owner: WALLET, amount: 0n })]]),
      });

    // The transaction touches BONK. With the caller allowing only RICE it is refused...
    expect(() => call([RICE])).toThrow(GuardError);
    // ...and permitted ONLY when the caller — not the transaction — names BONK.
    expect(() => call([BONK])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// signer
// ---------------------------------------------------------------------------------------------

/** A transaction that is well-framed: 1 empty signature slot, header, and one account key. */
function fakeTx(feePayer: string, versioned = false): string {
  const keys = Buffer.from(decodeBase58(feePayer));
  const message = Buffer.concat([
    versioned ? Buffer.from([0x80]) : Buffer.alloc(0),
    Buffer.from([1, 0, 0]), // header
    Buffer.from([1]), // shortvec: 1 account key
    keys,
    Buffer.alloc(32), // recent blockhash
    Buffer.from([0]), // shortvec: 0 instructions
  ]);
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
}

function memberRepo(members: number[]): AutotraderAccessRepo {
  const row = (userId: number): AutotraderMember => ({
    userId,
    label: null,
    addedBy: 1,
    addedAt: 0,
    locked: false,
    lockedAt: null,
  });
  return {
    getAutotraderUser: async (userId) => (members.includes(userId) ? row(userId) : null),
    listAutotraderUsers: async () => members.map(row),
    addAutotraderUser: async () => undefined,
    setAutotraderLocked: async () => undefined,
    deleteAutotraderUser: async () => undefined,
    logAutotraderAccess: async () => undefined,
  };
}

function rpcReturning(before: TokenAccountState[], after: (string | null)[], err: unknown = null): SimulationRpc {
  return {
    getOwnedTokenAccounts: async () => before,
    simulateTransaction: async () => ({ err, accounts: after }),
  };
}

describe('signer', () => {
  it('a LOCKED wallet throws — it never signs with a zeroed key', async () => {
    const ks = new Keystore({ dir: tmpDir() });
    const { secret, pubkey } = freshSecret();
    ks.import(5, secret, 'pw');
    // imported but never unlocked
    const signer = new Signer({ keystore: ks, access: memberRepo([5]), rpc: rpcReturning([], []), log });

    await expect(signer.sign(5, [RICE], fakeTx(pubkey))).rejects.toThrow(SignerError);
    await expect(signer.sign(5, [RICE], fakeTx(pubkey))).rejects.toThrow(/locked/);
  });

  it('a NON-MEMBER throws before anything else happens', async () => {
    const ks = new Keystore({ dir: tmpDir() });
    const { secret, pubkey } = freshSecret();
    ks.import(6, secret, 'pw');
    ks.unlock(6, 'pw');
    const signer = new Signer({ keystore: ks, access: memberRepo([]), rpc: rpcReturning([], []), log });

    await expect(signer.sign(6, [RICE], fakeTx(pubkey))).rejects.toThrow(/not an autotrader member/);
  });

  it('refuses a transaction whose fee payer is somebody else', async () => {
    const ks = new Keystore({ dir: tmpDir() });
    const { secret } = freshSecret();
    ks.import(8, secret, 'pw');
    ks.unlock(8, 'pw');
    const signer = new Signer({ keystore: ks, access: memberRepo([8]), rpc: rpcReturning([], []), log });

    await expect(signer.sign(8, [RICE], fakeTx(ATTACKER))).rejects.toThrow(/fee payer/);
  });

  it('signs a clean transaction, and the signature verifies', async () => {
    const ks = new Keystore({ dir: tmpDir() });
    const { secret, pubkey } = freshSecret();
    ks.import(10, secret, 'pw');
    ks.unlock(10, 'pw');
    const signer = new Signer({ keystore: ks, access: memberRepo([10]), rpc: rpcReturning([], []), log });

    const signed = await signer.sign(10, [RICE], fakeTx(pubkey));
    const raw = Buffer.from(signed, 'base64');
    const { message } = frameTransaction(raw);
    const signature = raw.subarray(1, 65);

    expect(signature.every((b) => b === 0)).toBe(false); // actually signed
    const { verify } = await import('node:crypto');
    const { createPublicKey } = await import('node:crypto');
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(decodeBase58(pubkey))]);
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(verify(null, message, pub, signature)).toBe(true);
  });

  it('FAILS CLOSED when simulation errors — no signature is produced', async () => {
    const ks = new Keystore({ dir: tmpDir() });
    const { secret, pubkey } = freshSecret();
    ks.import(11, secret, 'pw');
    ks.unlock(11, 'pw');
    const signer = new Signer({
      keystore: ks,
      access: memberRepo([11]),
      rpc: rpcReturning([], [], { InstructionError: [0, 'Custom'] }),
      log,
    });

    await expect(signer.sign(11, [RICE], fakeTx(pubkey))).rejects.toThrow(/simulation failed/);
  });

  it('FAILS CLOSED when the simulation returns fewer accounts than asked for', async () => {
    const ks = new Keystore({ dir: tmpDir() });
    const { secret, pubkey } = freshSecret();
    ks.import(12, secret, 'pw');
    ks.unlock(12, 'pw');
    const signer = new Signer({ keystore: ks, access: memberRepo([12]), rpc: rpcReturning([riceBefore], []), log });

    await expect(signer.sign(12, [RICE], fakeTx(pubkey))).rejects.toThrow(/fewer accounts/);
  });

  it('runs the guard for real: an NFT-draining transaction is refused unsigned', async () => {
    const ks = new Keystore({ dir: tmpDir() });
    const { secret, pubkey } = freshSecret();
    ks.import(13, secret, 'pw');
    ks.unlock(13, 'pw');

    const drained = tokenAccount({ address: NFT_ATA, mint: NFT_MINT, owner: WALLET, amount: 0n }).toString('base64');
    const signer = new Signer({
      keystore: ks,
      access: memberRepo([13]),
      rpc: rpcReturning([nftBefore], [drained]),
      log,
    });

    await expect(signer.sign(13, [RICE], fakeTx(pubkey))).rejects.toThrow(GuardError);
  });
});

// ---------------------------------------------------------------------------------------------
// access — silence, not refusal
// ---------------------------------------------------------------------------------------------

describe('allowlist (INVARIANT 14)', () => {
  it('a non-member is refused, and a LOCKED member is not a member', async () => {
    const locked: AutotraderMember = { userId: 2, label: null, addedBy: 1, addedAt: 0, locked: true, lockedAt: 5 };
    const repo: AutotraderAccessRepo = {
      ...memberRepo([1]),
      getAutotraderUser: async (id) =>
        id === 1 ? { userId: 1, label: null, addedBy: 1, addedAt: 0, locked: false, lockedAt: null } : id === 2 ? locked : null,
    };

    expect((await checkMember(repo, 1)).allowed).toBe(true);
    expect((await checkMember(repo, 2)).allowed).toBe(false); // revoked, at action time
    expect((await checkMember(repo, 3)).allowed).toBe(false);
  });

  /** The verdict carries no reason string — there is nothing for a handler to reply WITH. */
  it('a refusal carries no message to leak', async () => {
    const verdict = await checkMember(memberRepo([]), 99);
    expect(verdict).toEqual({ allowed: false });
    expect(Object.keys(verdict)).toEqual(['allowed']);
  });
});

// ---------------------------------------------------------------------------------------------
// redaction — INVARIANT 5 + 15
// ---------------------------------------------------------------------------------------------

describe('redaction of signing keys (INVARIANT 15)', () => {
  it('scrubs a real-shaped secret key MID-STRING', () => {
    const secret = freshSecret().base58;
    const out = scrub(`failed to import ${secret} for user 7`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED_SECRET_KEY]');
  });

  /** THE PHASE 0 LESSON: anchoring is where redaction fails. */
  it('scrubs one buried in a NESTED error object', () => {
    const secret = freshSecret().base58;
    const err = new Error(`rpc rejected payload {"key":"${secret}"}`);
    const nested = { level: 'error', ctx: { attempt: 2, cause: { err, note: `retry with ${secret}` } } };

    const scrubbed = JSON.stringify(scrubDeep(nested));
    expect(scrubbed).not.toContain(secret);
    // Not one fragment, either.
    expect(scrubbed).not.toContain(secret.slice(0, 16));
    expect(scrubbed).not.toContain(secret.slice(-16));
  });

  it('scrubs 64-char hex', () => {
    const hex = randomBytes(32).toString('hex');
    expect(scrub(`seed=${hex}`)).not.toContain(hex);
  });

  it('still redacts bot tokens and api keys', () => {
    expect(scrub('https://api.telegram.org/bot123456789:AAHfake_token_value_here_padded/x')).toContain('[REDACTED_BOT_TOKEN]');
    expect(scrub('https://x.helius-rpc.com/?api-key=abc123')).toContain('REDACTED');
  });

  /**
   * THE SHAPE COLLISION, RESOLVED STRUCTURALLY.
   *
   * A secret key and a transaction signature are both 64 bytes, so both are 87-88 base58 chars.
   * The discriminator is that a secret key is [seed][pubkey] — its second half is DERIVABLE from
   * its first — and a signature is not.
   *
   * The four tests below are the four directions. The previous name-allowlist approach could not
   * satisfy the first two, in either order: it was a heuristic on the container, and the
   * container's name is not evidence about the value.
   */
  describe('the base58 discriminator (structural, not by field name)', () => {
    /** A REAL mainnet signature, from the fixture captured for the DFlow pricing bug. */
    const REAL_SIGNATURE = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'buy-token-for-token-route.json'), 'utf8'),
    ).signature as string;

    it('is the right shape to collide — 64 bytes, same as a secret key', () => {
      // Not vacuous: if this ever stopped decoding to 64 bytes the tests below would pass for
      // the wrong reason, because the derivation would be skipped on length alone.
      expect(decodeBase58(REAL_SIGNATURE).length).toBe(64);
      expect(REAL_SIGNATURE.length).toBeGreaterThanOrEqual(87);
    });

    /** 1. THE OLD ALLOWLIST LET THIS THROUGH — a real key under a "public" field name. */
    it('REDACTS a real secret key even when the field is named `signature`', () => {
      const secret = freshSecret().base58;
      const out = scrubDeep({ signature: secret, sig: secret }) as Record<string, string>;
      expect(out['signature']).toBe('[REDACTED_SECRET_KEY]');
      expect(out['sig']).toBe('[REDACTED_SECRET_KEY]');
    });

    /** 2. THE OLD ALLOWLIST BLANKED THIS — a real signature under a "secret-sounding" name. */
    it('KEEPS a real transaction signature under a field named `secret` or `key`', () => {
      const out = scrubDeep({ secret: REAL_SIGNATURE, key: REAL_SIGNATURE, whatever: REAL_SIGNATURE }) as Record<
        string,
        string
      >;
      expect(out['secret']).toBe(REAL_SIGNATURE);
      expect(out['key']).toBe(REAL_SIGNATURE);
      expect(out['whatever']).toBe(REAL_SIGNATURE);
    });

    /** 4. THE GUARD IS THE DERIVATION, NOT THE LENGTH. */
    it('KEEPS a 64-byte base58 string of random bytes — it is not a valid keypair', () => {
      const notAKeypair = encodeBase58(randomBytes(64));
      expect(isSecretKeyBase58(notAKeypair)).toBe(false);
      expect(scrub(`value=${notAKeypair}`)).toContain(notAKeypair);
    });

    it('answers the predicate correctly on real inputs, both ways', () => {
      expect(isSecretKeyBase58(freshSecret().base58)).toBe(true);
      expect(isSecretKeyBase58(REAL_SIGNATURE)).toBe(false);
    });

    /** A signature survives free text too, not only structured fields. */
    it('keeps a signature spliced into an error message, but not a key', () => {
      const secret = freshSecret().base58;
      expect(scrub(`fetching tx ${REAL_SIGNATURE} failed`)).toContain(REAL_SIGNATURE);
      expect(scrub(`importing ${secret} failed`)).not.toContain(secret);
    });

    /**
     * The hex path KEEPS its name allowlist, and that asymmetry is deliberate: a 32-byte seed
     * and a sha256 are both indistinguishable random bytes, so no structural test exists.
     */
    it('still protects sha256 field values, which have no structural test available', () => {
      const sha = 'a'.repeat(64);
      const out = scrubDeep({ mediaSha: sha, sha256: sha, other: sha }) as Record<string, string>;
      expect(out['mediaSha']).toBe(sha);
      expect(out['sha256']).toBe(sha);
      // ...and outside those names, 64-char hex is still treated as possible key material.
      expect(out['other']).toBe('[REDACTED_HEX64]');
    });
  });
});
