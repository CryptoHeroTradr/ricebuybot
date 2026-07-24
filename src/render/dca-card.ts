import type { Mint, Signature, Wallet } from '../core/types.js';
import { Caption, type MessageEntity } from './entities.js';
import { buildKeyboard, buyerUrl, type Button } from './links.js';

/**
 * PHASE 16 — the DCA aggregate card. One card per WINDOW, not one per buy.
 *
 * A 15-minute DCA is 96 buys a day: posted individually they bury every organic buy and the feed
 * becomes a metronome. The roll-up is the design, not a throttle bolted on afterwards.
 *
 * DELIBERATELY SPARSE. No market cap, no USD, no position, no new/returning holder. Those numbers
 * are meaningless spread across several wallets and several buys, and printing them would imply a
 * precision the aggregate does not have. What is true and useful is: who bought, and how much.
 */

export interface DcaWalletLine {
  /** The buying wallet, full address (truncated for display, linked to solscan). */
  readonly wallet: string;
  /** Total tokens bought by THIS wallet across the window, raw units, summed as bigint. */
  readonly tokensRaw: bigint;
}

export interface DcaCardInput {
  readonly mint: string;
  readonly decimals: number;
  readonly lines: readonly DcaWalletLine[];
  /** Rendered as "Creator Fee" instead of an address. Every other wallet is the address. */
  readonly creatorFeeWallet?: string | undefined;
  readonly links: Readonly<Record<string, string>> | null;
}

export interface DcaCard {
  readonly text: string;
  readonly entities: readonly MessageEntity[];
  readonly keyboard: Button[][];
}

/** 7xKX…9fPq — the same shortening the wallet surfaces use. */
export function shortWallet(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/**
 * WHOLE GRAINS ONLY, FLOORED.
 *
 * Never round: rounding up would claim more grains than were actually bought, on a card whose whole
 * purpose is honest disclosure. Floor is the only direction that cannot overstate.
 */
export function wholeGrains(tokensRaw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = tokensRaw / scale; // bigint division truncates toward zero == floor for positives
  return whole.toLocaleString('en-US');
}

/**
 * Sum a window's buys per wallet and sort biggest-first.
 *
 * Summed as BIGINT, never through SQL SUM(): `tokens_raw` is a u64 held as TEXT, and SQLite's SUM
 * would round it through a float and drop the low bits (INVARIANT 6).
 */
export function aggregateByWallet(
  rows: readonly { readonly buyer: string; readonly tokensRaw: bigint }[],
): DcaWalletLine[] {
  const byWallet = new Map<string, bigint>();
  for (const r of rows) byWallet.set(r.buyer, (byWallet.get(r.buyer) ?? 0n) + r.tokensRaw);
  return [...byWallet.entries()]
    .map(([wallet, tokensRaw]) => ({ wallet, tokensRaw }))
    .sort((a, b) => (a.tokensRaw < b.tokensRaw ? 1 : a.tokensRaw > b.tokensRaw ? -1 : 0)); // biggest DCA leads
}

/**
 * The card. One line PER WALLET (amounts summed across that wallet's buys in the window), sorted
 * by amount descending.
 *
 * The button row is the full organic row MINUS the per-buy Buyer/TX links: there are several buys
 * behind this card, so a single "TX" would be a lie, and each wallet line already links out.
 */
export function renderDcaCard(input: DcaCardInput): DcaCard {
  const cap = new Caption();
  cap.add('🌾 ');
  cap.bold('DCA Buys');
  cap.add('\n');

  for (const line of input.lines) {
    const isCreator = input.creatorFeeWallet !== undefined && line.wallet === input.creatorFeeWallet;
    if (isCreator) {
      // The creator fee wallet is the one address with a name. Every OTHER wallet is the truncated
      // address and nothing else — never a name, never a villager label. A label on a stranger's
      // wallet is an identity claim the bot cannot make.
      cap.add('Creator Fee');
    } else {
      cap.link(shortWallet(line.wallet), buyerUrl(line.wallet));
    }
    cap.add(' DCA bought ');
    cap.bold(wholeGrains(line.tokensRaw, input.decimals));
    cap.add(' grains\n');
  }

  // The full organic button row, MINUS anything per-buy. The default links all template {mint}
  // only, so the row is unchanged — but a group may have added a custom {buyer}/{signature} link,
  // and on an aggregate (several buyers, several signatures) that has no single value. Dropping it
  // is the module's own rule: never render a dead button.
  const perBuy = /\{buyer\}|\{signature\}/;
  const links = input.links
    ? Object.fromEntries(Object.entries(input.links).filter(([, url]) => !perBuy.test(url)))
    : null;

  return {
    text: cap.text,
    entities: cap.entities,
    keyboard: buildKeyboard(links, { mint: input.mint as Mint, buyer: '' as Wallet, signature: '' as Signature }),
  };
}
