import { createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';

import pino from 'pino';

import { decodeBase58 } from '../trade/base58.js';

/**
 * INVARIANT 5: no key, token, or wallet secret ever enters a log line or an
 * error message.
 *
 * Two layers of defence, because one is not enough:
 *   1. `redact` scrubs known-sensitive KEYS anywhere in a logged object.
 *   2. `scrubUrl` / `scrub` strip secrets out of VALUES — Helius puts its API key
 *      in the query string, so a bare `logger.info({ url })` would leak it even
 *      though the key name ("url") is innocent.
 *
 * Anything carrying a URL must go through `scrubUrl` before it is logged.
 */

const SENSITIVE_KEYS = [
  'token',
  'apiKey',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'authorization',
  'privateKey',
  'private_key',
  'seed',
  'mnemonic',
  'TELEGRAM_BOT_TOKEN',
  'HELIUS_API_KEY',
  'HELIUS_RPC_URL',
  'HELIUS_WS_URL',
  // Phase 12 (INVARIANT 15). A signing key must not reach a log line by ANY name.
  'passphrase',
  'passphrase_hash',
  'secretKey',
  'secret_key',
  'keypair',
  'keystore',
  'OWNER_KEYSTORE_PASSPHRASE',
];

const REDACT_PATHS = SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

const SECRET_QUERY_PARAMS = new Set(['api-key', 'apikey', 'api_key', 'key', 'token', 'access_token']);

/**
 * Strip credentials out of a URL, keeping enough to be useful in a log line.
 * Returns a placeholder rather than throwing on unparseable input — a logger
 * must never be the thing that crashes a request path.
 */
export function scrubUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const name of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_PARAMS.has(name.toLowerCase())) u.searchParams.set(name, 'REDACTED');
    }
    if (u.username || u.password) {
      u.username = 'REDACTED';
      u.password = '';
    }
    return u.toString();
  } catch {
    return '[unparseable-url]';
  }
}

/**
 * Telegram bot tokens look like `123456:AA...`. Never let one through verbatim.
 *
 * No leading \b: the token's highest-risk appearance is inside a Bot API URL
 * (`https://api.telegram.org/bot123456789:AAH.../sendPhoto`), where the digits are
 * preceded by the "t" of "bot" and a word boundary would NOT match — leaking the
 * token through exactly the error strings most likely to be logged.
 */
const BOT_TOKEN_RE = /\d{6,}:[A-Za-z0-9_-]{30,}/g;

/**
 * A 64-byte ed25519 SECRET KEY, base58 — 87 or 88 characters (INVARIANT 15).
 *
 * NO ANCHORS AND NO \b, deliberately. That is the Phase 0 lesson repeated: the bot token regex
 * lost its `\b` because the token's highest-risk appearance is mid-string inside a URL. A
 * secret key's highest-risk appearance is the same — spliced into an error message
 * ("failed to parse 4xQ…"), inside a nested `err.message`, inside a JSON body echoed back by a
 * third party. Anchoring is exactly where redaction fails.
 */
const SECRET_B58_RE = /[1-9A-HJ-NP-Za-km-z]{87,88}/g;

/** 64-char hex — a raw key rendered the other common way. */
const HEX64_RE = /[0-9a-fA-F]{64}/g;

/**
 * THE SHAPE COLLISION, AND THE STRUCTURAL TEST THAT RESOLVES IT.
 *
 * A Solana transaction SIGNATURE is 64 bytes, so it is also 87-88 base58 characters. Shape alone
 * cannot tell it from a secret key, and blanket redaction would blank the `sig` on every buy
 * line — the field you search for when a card did not post.
 *
 * This used to be resolved by skipping five known-public FIELD NAMES. That was a heuristic on the
 * container, and it was wrong in both directions: a signature logged under any other name was
 * blanked, and a real key logged under `signature` sailed through unredacted. **The name is not
 * evidence about the value.**
 *
 * So ask the VALUE instead. A Solana secret key is [32-byte seed][32-byte public key], which
 * means its second half is DERIVABLE from its first. A signature has no such relation:
 *
 *   decode -> not 64 bytes?            not a secret key, leave it alone
 *   derive ed25519 pubkey from [0..32)
 *   equals [32..64)?                   IT IS A SECRET KEY -> redact
 *   otherwise                          a signature or other 64-byte value -> leave it alone
 *
 * Zero false negatives: a real keypair always satisfies this, by construction. A signature
 * satisfying it by chance is 2^-256 — not a risk, an impossibility with a number attached.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Derive the public half of an ed25519 seed.
 *
 * The six-byte DER preamble is duplicated from `trade/keystore.ts` rather than imported: the
 * logger must not depend on the keystore (which opens files and holds live secrets), and a
 * logger that can be broken by a change to key custody is a logger that stops working exactly
 * when you need it. The constant is a fixed part of the ed25519 PKCS#8 encoding, not a policy
 * either module owns.
 */
function ed25519PubkeyFromSeed(seed: Buffer): Buffer {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(priv).export({ type: 'spki', format: 'der' });
  return Buffer.from(spki.subarray(spki.length - 32));
}

/**
 * Is this base58 string an actual Solana secret key?
 *
 * FAILS CLOSED. Any unexpected error redacts: the cost of blanking one signature is a slightly
 * worse log line, and the cost of the other mistake is a published private key.
 *
 * The derivation runs ONLY when the decode yields exactly 64 bytes, so a base58 string of any
 * other length costs a decode and nothing more.
 */
export function isSecretKeyBase58(candidate: string): boolean {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(decodeBase58(candidate));
  } catch {
    return false; // not decodable, so not a key we could leak
  }
  if (bytes.length !== 64) return false;

  try {
    return timingSafeEqual(ed25519PubkeyFromSeed(bytes.subarray(0, 32)), bytes.subarray(32));
  } catch {
    return true; // see FAILS CLOSED
  }
}

/**
 * THE HEX PATH KEEPS A NAME ALLOWLIST, AND THAT ASYMMETRY IS DELIBERATE.
 *
 * DO NOT "tidy" this into consistency with the base58 path above. There is no structural test
 * available here and there cannot be one: a raw 32-byte ed25519 SEED and a sha256 digest are
 * both 32 bytes of indistinguishable random data. The seed carries no derivable second half to
 * check — that relation only exists in the 64-byte [seed][pubkey] form. Asking "is this hex a
 * key?" has no answer; asking it of base58 does. Different questions, different mechanisms.
 *
 * This is also the LOWER-RISK path. Solana secret keys circulate as 64-byte base58 — that is
 * what Phantom exports, what `/wallet export` emits, and what a user pastes into a DM. A key
 * arriving as 32-byte hex is the unusual case, and `sha256`/`mediaSha`/`checksum` values are
 * logged on essentially every buy.
 */
const HEX_PUBLIC_FIELDS: ReadonlySet<string> = new Set(['sha256', 'mediaSha', 'checksum']);

function redactSecretKeys(text: string): string {
  return text.replace(SECRET_B58_RE, (match) => (isSecretKeyBase58(match) ? '[REDACTED_SECRET_KEY]' : match));
}

function redactCommon(text: string): string {
  return text
    .replace(BOT_TOKEN_RE, '[REDACTED_BOT_TOKEN]')
    .replace(/([?&](?:api-key|apikey|api_key|key|token|access_token)=)[^&\s"']+/gi, '$1REDACTED');
}

/** Last-resort scrub for free-text (error messages, third-party strings). */
export function scrub(text: string): string {
  return redactSecretKeys(redactCommon(text)).replace(HEX64_RE, '[REDACTED_HEX64]');
}

/**
 * Walk a logged object and scrub every string in it.
 *
 * pino's `redact` handles KEYS at known paths; this handles VALUES at unknown ones — a key
 * spliced into `err.message` three levels down is caught by neither the redact paths nor the
 * message-only hook, and that nested case is precisely what the acceptance test checks.
 *
 * Depth-capped and cycle-safe: a logger must never be the thing that hangs or overflows the
 * process it is instrumenting.
 */
export function scrubDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // The base58 path needs no exception: it asks the VALUE whether it is a key, so a signature
    // survives under ANY field name and a key is caught under any field name. Only the hex path,
    // which has no structural test available, still consults the name.
    out[k] = typeof v === 'string' && HEX_PUBLIC_FIELDS.has(k) ? scrubExceptHex(v) : scrubDeep(v, depth + 1, seen);
  }
  return out;
}

/** For fields that legitimately carry a sha256. See HEX_PUBLIC_FIELDS. */
function scrubExceptHex(text: string): string {
  return redactSecretKeys(redactCommon(text));
}

export type Logger = pino.Logger;

export function createLogger(level: string, pretty = !process.env['PM2_HOME'] && process.stdout.isTTY): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { svc: 'ricebuybot' },
    serializers: {
      // Errors are the highest-risk carrier: a third party's message, a stack trace, a `cause`
      // chain. Serialize as usual, then scrub every string in the result.
      err: (e: unknown) => scrubDeep(pino.stdSerializers.err(e as Error)),
    },
    formatters: {
      level: (label) => ({ level: label }),
      // Every logged object, at any depth. See scrubDeep.
      log: (obj) => scrubDeep(obj) as Record<string, unknown>,
    },
    hooks: {
      // Scrub the free-text message of every log line, whatever produced it.
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? scrub(a) : a)) as typeof args;
        return method.apply(this, scrubbed);
      },
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
      : {}),
  });
}
