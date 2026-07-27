import type { ConfirmedTx } from './solana-types.js';

/**
 * PHASE 7 — "was this buy an automated recurring order, or did the human just ape?"
 *
 * THIS IS NOT A DEX DECODER, AND INVARIANT 1 IS INTACT.
 *
 * Invariant 1 governs SWAP DETECTION: what moved, who moved it, and what it was worth are derived
 * from balance deltas alone, by one parser, with no per-DEX branch anywhere. Nothing in this file
 * touches any of that. `normalizeSwap` neither imports this module nor knows it exists; it will
 * classify the same transaction, find the same buyer and compute the same amount whether this
 * check says yes, no, or is never called at all.
 *
 * What this answers is a strictly narrower question, asked AFTER a buy has already been detected
 * and only about buys from wallets we have a proven identity link to: was this one of the wallet's
 * own scheduled orders, or a manual purchase? And it answers it the cheapest way there is — set
 * membership over the transaction's account keys. No instruction is read, no account is decoded,
 * no layout is assumed, and nothing here can affect what a buy IS. A program that renames its
 * instructions or reorders its accounts breaks decoders; it does not break this.
 *
 * THE DEFAULT IS "NOT DCA". A buy from a linked wallet that does not touch a recurring program is
 * a manual buy and cards as an ordinary organic buy — which is the truth about it. That is the
 * judgement call this phase makes deliberately: a villager who apes in with their own hands has
 * NOT set up an automated program, and labelling their trade "automatic" would be the bot making
 * a claim about someone's behaviour that is simply false. Under-attributing costs a roll-up;
 * over-attributing publishes a lie about a person.
 */

/**
 * Jupiter's recurring-order programs.
 *
 * ⚠️ VERIFY THESE AGAINST A REAL EXECUTION BEFORE TRUSTING WALLET-MODE ATTRIBUTION IN PRODUCTION.
 * They are the published Jupiter program addresses, but Jupiter has shipped several generations of
 * this product (DCA, then Value Averaging, then the Trigger/Recurring API the Mini App builds
 * against in `@rice/jupiter-dca`), and the set that actually signs a recurring fill today is a
 * question about the live chain, not about this repo. The failure mode of a wrong or missing id is
 * benign and visible — the buy simply cards as an ordinary organic buy instead of rolling into the
 * DCA aggregate — and it is fixable WITHOUT A DEPLOY via `JUPITER_RECURRING_PROGRAM_IDS`, which
 * replaces this list wholesale. The effective set is logged at boot for exactly that reason:
 * "why did no DCA card fire" has to be answerable from the logs.
 *
 * The safe direction is the one taken here: an id we do not know about means "not DCA", never
 * "probably DCA".
 */
export const DEFAULT_RECURRING_PROGRAM_IDS: readonly string[] = [
  // Jupiter DCA — the original recurring/dollar-cost-average program.
  'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M',
  // Jupiter Limit Order v2 — the program the Trigger/Recurring API family settles through.
  'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X',
  // Jupiter Value Averaging — the VA sibling of DCA; also an automated schedule, not a manual buy.
  'VALaaymxQh2mNy2trH9jUqHT1mTow76wpTcGmSWSwJe',
];

/**
 * Every account key in the transaction, INCLUDING addresses loaded from lookup tables.
 *
 * The ALT half is not optional. Jupiter routes are the heaviest users of address lookup tables on
 * Solana; a check that read only the static keys would miss the majority of real routes and the
 * feature would look "sometimes broken" rather than broken. `normalizeSwap` learned this the hard
 * way for attribution (miss the ALT addresses and every ALT-using route mis-attributes) — the same
 * lesson, the same shape, kept deliberately independent so neither can quietly change the other.
 */
function accountKeys(tx: ConfirmedTx): string[] {
  const raw = tx.transaction.message.accountKeys ?? [];
  const statics = raw.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const loaded = tx.meta?.loadedAddresses;
  return [...statics, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

/**
 * A reusable membership test over one program-id set. Built once at boot and handed to the
 * ingestor, so neither the parse nor the config lookup happens per transaction.
 */
export type RecurringProgramCheck = (tx: ConfirmedTx) => boolean;

export function makeRecurringProgramCheck(programIds: readonly string[]): RecurringProgramCheck {
  const set = new Set(programIds.filter((id) => id.length > 0));
  // An empty set means the operator has explicitly turned wallet-mode DCA attribution off. Say so
  // by structure: nothing is ever attributed, rather than everything.
  if (set.size === 0) return () => false;
  return (tx: ConfirmedTx): boolean => accountKeys(tx).some((k) => set.has(k));
}

/** Parse the env override. Empty/absent -> the defaults above; a set list REPLACES them. */
export function parseRecurringProgramIds(raw: string | undefined): readonly string[] {
  if (raw === undefined) return DEFAULT_RECURRING_PROGRAM_IDS;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids;
}
