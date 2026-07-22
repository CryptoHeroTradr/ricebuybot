import type { Mint } from '../core/types.js';

/**
 * Validation results carry a SPECIFIC reason, always.
 *
 * "Invalid mint" tells a group admin nothing and turns a 5-second fix into a support
 * conversation. "That's 43 characters — a mint is 32-44" tells them they pasted a
 * signature. Every rejection below names what was actually wrong.
 */
export type Valid<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...BASE58].map((c, i) => [c, i]));

/** Decode base58 to bytes. Null if the string is not base58 at all. */
export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return null;

  const bytes: number[] = [0];
  for (const ch of s) {
    const v = B58_MAP.get(ch);
    if (v === undefined) return null;

    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] as number) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Leading '1's are leading zero bytes.
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * A Solana mint is a 32-BYTE public key, base58-encoded. Length in CHARACTERS is 32-44 and
 * is only a hint — the real test is that it decodes to exactly 32 bytes.
 *
 * The common mistakes each get their own message, because each has a different fix:
 *   - a transaction signature is 64 bytes (people paste the wrong thing from Solscan)
 *   - an 0x… address is Ethereum (people paste from the wrong chain entirely)
 *   - a bad character is usually 0/O/I/l, which base58 deliberately excludes
 */
export function validateMintFormat(raw: string): Valid<Mint> {
  const s = raw.trim();

  if (s.length === 0) return { ok: false, why: 'Send it like this: `/setca <mint address>`' };

  if (s.startsWith('0x')) {
    return { ok: false, why: "That's an Ethereum address. I only speak Solana — mints look like `2wQq3Mr…pump`." };
  }

  const bad = [...s].find((c) => !B58_MAP.has(c));
  if (bad !== undefined) {
    const hint = '0OIl'.includes(bad)
      ? ` (base58 has no \`${bad}\` — it leaves out 0, O, I and l because they look alike)`
      : '';
    return { ok: false, why: `That has a \`${bad}\` in it, which isn't valid base58${hint}.` };
  }

  // DECODE FIRST, then judge the length.
  //
  // A transaction signature is 88 characters, so a character-length check fires before the
  // byte check ever runs — and the single most common mis-paste (grabbing the signature
  // instead of the token address from Solscan) would get the generic "wrong length" reply
  // instead of the one sentence that actually tells them what they did.
  const bytes = base58Decode(s);
  if (!bytes) return { ok: false, why: "That isn't valid base58." };

  if (bytes.length === 64) {
    return { ok: false, why: "That's a transaction signature, not a mint. You want the token address." };
  }

  if (s.length < 32 || s.length > 44) {
    return {
      ok: false,
      why: `That doesn't look like a valid mint — it should be 32-44 base58 characters, and that one is ${s.length}.`,
    };
  }

  if (bytes.length !== 32) {
    return { ok: false, why: `That decodes to ${bytes.length} bytes; a mint is exactly 32.` };
  }

  return { ok: true, value: s as Mint };
}

export interface ChainCheck {
  /** getTokenSupply on the mint. Throws on RPC failure. */
  supplyOf(mint: Mint): Promise<{ amount: string; decimals: number } | null>;
}

/**
 * The format was fine — but does this token EXIST, and does it have a supply?
 *
 * A well-formed base58 key that is not a mint is the nastiest failure here: the group
 * configures it happily, the bot subscribes, and then nothing ever posts, forever, with no
 * error anywhere. The group concludes the bot is broken. One RPC call at config time turns
 * a silent permanent failure into a sentence.
 */
export async function validateMintOnChain(mint: Mint, chain: ChainCheck): Promise<Valid<{ decimals: number; supplyRaw: bigint }>> {
  let supply: { amount: string; decimals: number } | null;
  try {
    supply = await chain.supplyOf(mint);
  } catch {
    return { ok: false, why: "I couldn't reach the chain to check that mint. Try again in a moment." };
  }

  if (!supply) {
    return { ok: false, why: "I can't find that token on Solana. Double-check the address — is it definitely a mint?" };
  }

  const raw = BigInt(supply.amount);
  if (raw === 0n) {
    return { ok: false, why: 'That mint exists but has a supply of zero, so there is nothing to track.' };
  }

  return { ok: true, value: { decimals: supply.decimals, supplyRaw: raw } };
}

// --- the numeric settings -------------------------------------------------------------

export function validateUsd(raw: string, opts: { min: number; max: number; label: string }): Valid<number> {
  const n = Number(String(raw).replace(/[$,]/g, '').trim());
  if (!Number.isFinite(n)) return { ok: false, why: `\`${raw}\` isn't a number. ${opts.label} is in dollars, e.g. \`250\`.` };
  if (n < opts.min || n > opts.max) {
    return { ok: false, why: `${opts.label} must be between $${opts.min.toLocaleString()} and $${opts.max.toLocaleString()}.` };
  }
  return { ok: true, value: n };
}

export function validateInt(raw: string, opts: { min: number; max: number; label: string }): Valid<number> {
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n)) return { ok: false, why: `\`${raw}\` isn't a whole number.` };
  if (n < opts.min || n > opts.max) return { ok: false, why: `${opts.label} must be between ${opts.min} and ${opts.max}.` };
  return { ok: true, value: n };
}

/**
 * The three BUY-SIZE floors, strictly ascending.
 *
 * Ascending is not fussiness. The tier chain tests massive first, then big — so floors that
 * cross over make a tier UNREACHABLE, and nothing in the running bot would ever complain.
 * A group that set `/setfloors 10 1000 250` would simply never post a Massive card again and
 * would have no way of knowing why.
 *
 * Note the Whale floor is NOT here: it is denominated in HOLDINGS, not buy size (/setwhale).
 * Putting it in this list is what the old ladder did, and it is the mistake this whole tier
 * model exists to undo.
 */
export function validateFloors(regular: string, big: string, massive: string): Valid<{ regular: number; big: number; massive: number }> {
  const r = validateUsd(regular, { min: 0, max: 100_000, label: 'The Regular floor' });
  if (!r.ok) return r;
  const b = validateUsd(big, { min: 0, max: 100_000, label: 'The Big floor' });
  if (!b.ok) return b;
  const m = validateUsd(massive, { min: 0, max: 1_000_000, label: 'The Massive floor' });
  if (!m.ok) return m;

  if (!(r.value < b.value && b.value < m.value)) {
    return {
      ok: false,
      why:
        'The floors must go up: Regular < Big < Massive.\n' +
        `You sent Regular $${r.value}, Big $${b.value}, Massive $${m.value}.\n` +
        'If they overlap, a tier can never fire — and nothing would tell you.',
    };
  }
  return { ok: true, value: { regular: r.value, big: b.value, massive: m.value } };
}
