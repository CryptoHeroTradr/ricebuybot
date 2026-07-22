/**
 * THE WALLET VIEW — inventory and warning, together, every time.
 *
 * The warning is not a one-off notice at import. A notice shown once is a notice scrolled
 * past; what changes behaviour is seeing the exposure as a NUMBER, next to the balances, on
 * every single /wallet. So `renderWallet` cannot produce a message without it — there is no
 * `showWarning` flag, because a flag is a thing somebody sets to false.
 *
 * The other tokens are COUNTED, never itemised. A count is a warning ("there are 3 more things
 * here you would lose"); a list of names, amounts and values is a portfolio readout, and the
 * bot has no business compiling one about a person. Same reason the NFTs are a number.
 */

import type { UnlockMode } from './unlock.js';

export interface TokenHolding {
  readonly mint: string;
  readonly amountRaw: bigint;
  readonly decimals: number;
}

export interface WalletInventory {
  readonly pubkey: string;
  readonly lamports: bigint;
  /** The schedule's mint, shown by name because it is the one the bot may touch. */
  readonly primary: TokenHolding | null;
  readonly primarySymbol: string;
  /** Everything else, counted only. */
  readonly otherTokens: number;
  readonly nfts: number;
}

/** What the inventory needs from the chain. */
export interface WalletRpc {
  getBalance(pubkey: string): Promise<bigint | null>;
  getOwnedTokenAccountsParsed(
    owner: string,
  ): Promise<readonly { mint: string; amountRaw: bigint; decimals: number }[]>;
}

/**
 * An NFT, for counting purposes: zero decimals and a balance of exactly one.
 *
 * A heuristic, and deliberately a cheap one. Confirming it properly means a `getTokenSupply`
 * per mint — dozens of RPC reads to render one message. The number exists to make "and your
 * NFTs" concrete rather than to be an inventory: being off by one on a wallet with 30 NFTs
 * changes nothing about the decision the warning is asking the person to make.
 */
function isNft(t: { amountRaw: bigint; decimals: number }): boolean {
  return t.decimals === 0 && t.amountRaw === 1n;
}

export async function fetchInventory(
  rpc: WalletRpc,
  pubkey: string,
  primaryMint: string,
  primarySymbol: string,
): Promise<WalletInventory> {
  const [lamports, accounts] = await Promise.all([rpc.getBalance(pubkey), rpc.getOwnedTokenAccountsParsed(pubkey)]);

  let primary: TokenHolding | null = null;
  let otherTokens = 0;
  let nfts = 0;

  for (const acc of accounts) {
    if (acc.mint === primaryMint) {
      // Summed: a wallet may hold one mint across several token accounts.
      const running: bigint = primary === null ? 0n : primary.amountRaw;
      primary = { mint: acc.mint, amountRaw: running + acc.amountRaw, decimals: acc.decimals };
      continue;
    }
    if (isNft(acc)) {
      nfts++;
      continue;
    }
    // A closed-out or dust-free account is not a holding worth warning about.
    if (acc.amountRaw > 0n) otherTokens++;
  }

  return { pubkey, lamports: lamports ?? 0n, primary, primarySymbol, otherTokens, nfts };
}

/** Raw -> display. The render boundary of INVARIANT 6; no float exists before this point. */
function fmtAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;

  const wholeStr = whole.toLocaleString('en-US');
  if (decimals === 0 || frac === 0n) return `${negative ? '-' : ''}${wholeStr}`;

  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 2);
  return `${negative ? '-' : ''}${wholeStr}${fracStr ? `.${fracStr}` : ''}`;
}

/** `7xKX…9fPq` — enough to recognise, short enough to read. */
export function shortPubkey(pubkey: string): string {
  return pubkey.length <= 12 ? pubkey : `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

/**
 * THE EXPOSURE WARNING. Shown on every /wallet and again at import.
 *
 * It says three separate things, and none of them is redundant:
 *   1. the whole wallet is exposed, not the DCA budget — the thing people assume wrongly;
 *   2. the bot's own reach IS narrow (the mint guard is real, and saying so is honest);
 *   3. that narrowness protects nothing against someone holding the key — so the guard is
 *      not offered as a reason to relax.
 *
 * Point 3 is the one that must never be edited out. A warning that implies the guard is
 * wallet security is worse than no warning, because it manufactures confidence.
 */
export function exposureWarning(): string {
  return [
    '⚠️ All of the above is exposed.',
    'Your key is encrypted on this server, but a server compromise',
    'means the WHOLE wallet — tokens, NFTs, LP positions — not just',
    'the DCA budget.',
    '',
    'The bot itself can only ever swap SOL ↔ RICE and is blocked',
    'from touching anything else. That limits the BOT, not an',
    'attacker holding your key.',
    '',
    "Suggested: use a wallet holding only what you'd accept losing.",
  ].join('\n');
}

export function renderWallet(inv: WalletInventory, state: { unlocked: boolean; mode: UnlockMode }): string {
  const lines: string[] = [];
  const status = `${state.unlocked ? 'unlocked' : 'locked'} · ${state.mode === 'dm' ? 'DM unlock' : 'env unlock'}`;

  lines.push(`🔑 Wallet — ${shortPubkey(inv.pubkey)}   (${status})`);
  lines.push('');
  lines.push(`  ${fmtAmount(inv.lamports, 9)} SOL`);
  if (inv.primary && inv.primary.amountRaw > 0n) {
    lines.push(`  ${fmtAmount(inv.primary.amountRaw, inv.primary.decimals)} ${inv.primarySymbol}`);
  }
  if (inv.otherTokens > 0) lines.push(`  + ${inv.otherTokens} other token${inv.otherTokens === 1 ? '' : 's'}`);
  if (inv.nfts > 0) lines.push(`  + ${inv.nfts} NFT${inv.nfts === 1 ? '' : 's'}`);
  lines.push('');
  lines.push(exposureWarning());

  return lines.join('\n');
}

/**
 * The extra paragraph shown at IMPORT when the wallet being handed over is not a throwaway.
 *
 * Import is the only moment a person is actually deciding. Afterwards the warning is a thing
 * they have already agreed to; here it is still a question.
 */
export function importValueWarning(inv: WalletInventory): string | null {
  if (inv.nfts === 0 && inv.otherTokens === 0) return null;

  const parts: string[] = [];
  if (inv.nfts > 0) parts.push(`${inv.nfts} NFT${inv.nfts === 1 ? '' : 's'}`);
  if (inv.otherTokens > 0) parts.push(`${inv.otherTokens} other token${inv.otherTokens === 1 ? '' : 's'}`);

  return [
    `❗ This wallet holds ${parts.join(' and ')}.`,
    '',
    'That is not a throwaway wallet. If this server is compromised,',
    'all of it goes — not just the amount you plan to trade.',
    '',
    "Suggested: use a wallet holding only what you'd accept losing.",
  ].join('\n');
}
