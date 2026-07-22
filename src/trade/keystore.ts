import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeBase58, encodeBase58, SECRET_KEY_BYTES } from './base58.js';

/**
 * ONE KEYSTORE PER USER, EACH UNDER THAT USER'S OWN PASSPHRASE (INVARIANT 15).
 *
 * THERE IS NO MASTER KEY. Not a fallback, not an escrow, not an owner override. The decrypt
 * path takes a passphrase and derives a key from it and the file's own salt; there is no
 * branch that reaches a secret by any other route, which is why "user A decrypts user B's
 * keystore" is not a policy we enforce but a thing the code cannot express. The owner
 * administers MEMBERSHIP (`access.ts`) and never touches anyone's key.
 *
 * One leaked passphrase is therefore one wallet. That property is the entire point of paying
 * the per-user file cost instead of encrypting a single blob under one operator secret.
 *
 * ON DISK: `<dir>/<user_id>.json`, mode 0600, containing ciphertext and public metadata only.
 * The plaintext secret key exists in exactly one place — a Buffer in this process's memory,
 * held only between /wallet unlock and /wallet lock — and NEVER in SQLite, .env, a temp file,
 * a log line or a Telegram message.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST: an attacker who has the passphrase, or who can read this
 * process's memory while a wallet is unlocked. Encryption at rest makes a stolen disk image
 * inert. It does nothing about a compromised running host. Say so plainly to users; a wallet
 * warning that oversells the protection is worse than none.
 */

/** scrypt cost. 2^15 is ~100ms and ~32MB per derivation — deliberately slow. */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
/** 128 * N * r = 32MiB exactly, so the default maxmem rejects it. Give it headroom. */
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

const SALT_LEN = 16;
const IV_LEN = 12;
const CIPHER = 'aes-256-gcm';

/** A Solana secret key is seed(32) || pubkey(32). */
const SEED_LEN = 32;

/** PKCS#8 preamble for a raw ed25519 seed. Node has no "import raw ed25519 seed" API. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface KeystoreFile {
  readonly v: 1;
  readonly userId: number;
  /** Public. Needed to show /wallet while the key is LOCKED, so it must not be encrypted. */
  readonly pubkey: string;
  readonly kdf: 'scrypt';
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: string;
  readonly cipher: 'aes-256-gcm';
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
  readonly createdAt: number;
}

export class KeystoreError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'bad-passphrase' | 'corrupt' | 'exists' | 'locked',
  ) {
    super(message);
    this.name = 'KeystoreError';
  }
}

/**
 * A decrypted key, live in memory.
 *
 * `secret` is a Buffer and not a string ON PURPOSE: a JS string cannot be overwritten — it
 * lives until GC decides otherwise and may be copied by interning or by the JIT. A Buffer can
 * be zeroed, and `zero()` does exactly that.
 */
export interface UnlockedKey {
  readonly userId: number;
  readonly pubkey: string;
  readonly secret: Buffer;
  readonly signingKey: KeyObject;
  readonly unlockedAt: number;
  zero(): void;
}

function deriveKey(passphrase: string, salt: Buffer, n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

/** Raw 32-byte ed25519 seed -> a Node signing key. */
function signingKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** The last 32 bytes of the SPKI DER are the raw public key. */
function pubkeyBytesOf(signingKey: KeyObject): Buffer {
  const spki = createPublicKey(signingKey).export({ type: 'spki', format: 'der' });
  return Buffer.from(spki.subarray(spki.length - 32));
}

/**
 * Validate a 64-byte Solana secret and return the key material it implies.
 *
 * The stored 64 bytes are seed||pubkey, and we do NOT trust the trailing half: we derive the
 * public key from the seed and compare. A key whose two halves disagree is corrupt or crafted,
 * and importing it would give the user a wallet address that cannot sign for itself.
 */
export function keypairFromSecret(secret: Buffer): { pubkey: string; signingKey: KeyObject } {
  if (secret.length !== SECRET_KEY_BYTES) {
    throw new KeystoreError(`secret key must be ${SECRET_KEY_BYTES} bytes`, 'corrupt');
  }
  const seed = secret.subarray(0, SEED_LEN);
  const signingKey = signingKeyFromSeed(Buffer.from(seed));
  const derived = pubkeyBytesOf(signingKey);
  const claimed = secret.subarray(SEED_LEN);

  if (!timingSafeEqual(derived, claimed)) {
    throw new KeystoreError('secret key is malformed (public half does not match the seed)', 'corrupt');
  }
  return { pubkey: encodeBase58(derived), signingKey };
}

export interface KeystoreDeps {
  readonly dir: string;
  readonly now?: () => number;
}

export class Keystore {
  readonly #dir: string;
  readonly #now: () => number;
  /** userId -> live key. The ONLY place a plaintext secret exists. */
  readonly #unlocked = new Map<number, UnlockedKey>();

  constructor(deps: KeystoreDeps) {
    this.#dir = deps.dir;
    this.#now = deps.now ?? Date.now;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
  }

  #path(userId: number): string {
    return join(this.#dir, `${userId}.json`);
  }

  has(userId: number): boolean {
    return existsSync(this.#path(userId));
  }

  read(userId: number): KeystoreFile {
    const path = this.#path(userId);
    if (!existsSync(path)) throw new KeystoreError('no keystore for that user', 'not-found');
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
    } catch {
      throw new KeystoreError('keystore file is unreadable', 'corrupt');
    }
  }

  /** The wallet address, readable WITHOUT the passphrase — /wallet works while locked. */
  pubkeyOf(userId: number): string | null {
    return this.has(userId) ? this.read(userId).pubkey : null;
  }

  /**
   * Encrypt a secret under this user's passphrase and write it.
   *
   * Atomic (temp + rename) and 0600 BEFORE any bytes land, so there is never an instant where
   * a keystore exists at default permissions. `mode` on writeFileSync is masked by umask, so
   * chmod explicitly rather than trusting it.
   */
  import(userId: number, secret: Buffer, passphrase: string, opts: { overwrite?: boolean } = {}): string {
    if (this.has(userId) && !opts.overwrite) {
      throw new KeystoreError('a keystore already exists for that user', 'exists');
    }
    const { pubkey } = keypairFromSecret(secret);

    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const key = deriveKey(passphrase, salt);

    const cipher = createCipheriv(CIPHER, key, iv);
    const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
    const tag = cipher.getAuthTag();
    key.fill(0);

    const file: KeystoreFile = {
      v: 1,
      userId,
      pubkey,
      kdf: 'scrypt',
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: salt.toString('base64'),
      cipher: CIPHER,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
      createdAt: this.#now(),
    };

    const path = this.#path(userId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    return pubkey;
  }

  /** A fresh wallet. Returns the base58 secret for ONE-TIME display; it is never stored. */
  generate(userId: number, passphrase: string, opts: { overwrite?: boolean } = {}): { pubkey: string; secretBase58: string } {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
    const seed = Buffer.from(pkcs8.subarray(pkcs8.length - SEED_LEN));
    const pub = pubkeyBytesOf(privateKey);
    const secret = Buffer.concat([seed, pub]);

    try {
      const pubkey = this.import(userId, secret, passphrase, opts);
      return { pubkey, secretBase58: encodeBase58(secret) };
    } finally {
      seed.fill(0);
      secret.fill(0);
    }
  }

  /**
   * Decrypt into memory. WRONG PASSPHRASE FAILS CLOSED.
   *
   * GCM authenticates before it returns plaintext, so a wrong passphrase throws out of
   * `final()` rather than yielding garbage that later looks like a key. That is the difference
   * between "fails closed" and "signs with rubbish", and it is why an AEAD is not optional here.
   */
  unlock(userId: number, passphrase: string): UnlockedKey {
    const file = this.read(userId);

    const salt = Buffer.from(file.salt, 'base64');
    const key = deriveKey(passphrase, salt, file.n, file.r, file.p);

    let secret: Buffer;
    try {
      const decipher = createDecipheriv(file.cipher, key, Buffer.from(file.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      secret = Buffer.concat([decipher.update(Buffer.from(file.ct, 'base64')), decipher.final()]);
    } catch {
      // Indistinguishable from a corrupt file BY DESIGN — do not tell a guesser which it was.
      throw new KeystoreError('wrong passphrase', 'bad-passphrase');
    } finally {
      key.fill(0);
    }

    const { pubkey, signingKey } = keypairFromSecret(secret);
    if (pubkey !== file.pubkey) {
      secret.fill(0);
      throw new KeystoreError('keystore public key does not match its ciphertext', 'corrupt');
    }

    this.lock(userId); // never leave a previous key live
    const entry: UnlockedKey = {
      userId,
      pubkey,
      secret,
      signingKey,
      unlockedAt: this.#now(),
      zero: () => secret.fill(0),
    };
    this.#unlocked.set(userId, entry);
    return entry;
  }

  isUnlocked(userId: number): boolean {
    return this.#unlocked.has(userId);
  }

  get(userId: number): UnlockedKey | null {
    return this.#unlocked.get(userId) ?? null;
  }

  /** Zero and forget one user's key. Idempotent. */
  lock(userId: number): void {
    const entry = this.#unlocked.get(userId);
    if (!entry) return;
    entry.zero();
    this.#unlocked.delete(userId);
  }

  /** Shutdown, and every restart's starting state. */
  lockAll(): void {
    for (const userId of [...this.#unlocked.keys()]) this.lock(userId);
  }

  unlockedUsers(): readonly number[] {
    return [...this.#unlocked.keys()];
  }

  /** Decrypt for /wallet export. Returns base58; the caller must not log or persist it. */
  exportSecret(userId: number, passphrase: string): string {
    const entry = this.unlock(userId, passphrase);
    return encodeBase58(entry.secret);
  }

  /**
   * DESTROY a keystore. `/trader purge` only — never a side effect of revoking access
   * (INVARIANT 14). Locks the live key first so purging does not leave one resident.
   */
  purge(userId: number): boolean {
    this.lock(userId);
    const path = this.#path(userId);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }
}
