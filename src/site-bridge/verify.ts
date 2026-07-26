import { createPublicKey, verify } from 'node:crypto';
import { decodeBase58 } from '../trade/base58.js';

/**
 * Verify a Solana wallet's ed25519 signature over a message — server-side, on the bot, with NO new
 * dependency. Node's crypto verifies ed25519 from a KeyObject; a Solana pubkey is a raw 32-byte
 * ed25519 key, so we wrap it in its SPKI-DER prefix to build the KeyObject (a standard, stable trick).
 *
 * Returns FALSE on any malformed input (bad base58, wrong length, garbage) rather than throwing —
 * a bad request is a rejected signature, never a 500 that leaks a stack trace.
 */

// SPKI-DER header for an ed25519 public key. Prepend to the raw 32 bytes -> a valid SPKI encoding.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyWalletSignature(
  walletBase58: string,
  message: string,
  signatureBase58: string,
): boolean {
  try {
    const pub = decodeBase58(walletBase58);
    const sig = decodeBase58(signatureBase58);
    if (pub.length !== 32 || sig.length !== 64) return false;
    const keyObj = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub)]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message, 'utf8'), keyObj, Buffer.from(sig));
  } catch {
    return false;
  }
}
