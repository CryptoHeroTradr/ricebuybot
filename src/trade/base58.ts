/**
 * Base58 (Bitcoin alphabet), which is how Solana spells every key.
 *
 * Hand-rolled rather than added as a dependency, for the same reason `normalize.ts` parses
 * chain data itself: this process has five production dependencies and an audited network
 * allowlist, and a 40-line pure function does not justify widening either.
 *
 * It handles secret keys, so it must not leak through its own failures:
 *   - `decode` throws a message that NEVER contains the input, not even a prefix. A caller
 *     logging `err.message` must not thereby log a fragment of somebody's key.
 *   - `looksLikeSecretKey` exists so callers can validate WITHOUT decoding, and without
 *     building a rejection message out of the thing they are rejecting.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const INDEX: ReadonlyMap<string, number> = new Map([...ALPHABET].map((c, i) => [c, i]));

export class Base58Error extends Error {
  constructor(what: string) {
    // No input echo. Ever. See the header.
    super(`base58: ${what}`);
    this.name = 'Base58Error';
  }
}

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // Leading zero bytes are not representable positionally; base58 spells each as '1'.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i] as number];
  return out;
}

export function decodeBase58(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);

  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;

  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const value = INDEX.get(s[i] as string);
    if (value === undefined) throw new Base58Error('invalid character');

    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i] as number;
  return out;
}

/** A Solana ed25519 secret key is 64 bytes, which is 87 or 88 base58 characters. */
export const SECRET_KEY_BYTES = 64;

/**
 * Cheap shape test, so a caller can reject junk without decoding it.
 *
 * Deliberately does NOT confirm the bytes are a valid key — only that the string is the right
 * shape to be one. Callers that need certainty decode and let `keypairFromSecret` verify.
 */
export function looksLikeSecretKey(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(s);
}

export function looksLikePubkey(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}
