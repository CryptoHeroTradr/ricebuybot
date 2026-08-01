import type { Logger } from 'pino';

import type { BuyEvent, MediaKind, Mint } from '../core/types.js';
import { TIER_BY_NAME, TREASURY_FOLDER, TREASURY_NAME } from '../core/tiers.js';
import type { Repo } from '../db/index.js';
import type { MediaPool, Pick } from '../media/index.js';
import { renderCard, type CardInput } from '../render/card.js';
import type { PositionView } from '../render/position.js';
import type { DeliveryQueue } from './queue.js';
import type { Outbound } from './sender.js';
import { capabilities } from '../core/plans.js';
import { DEFAULT_LINKS } from '../core/links.js';
import { effective, planOf } from './plan-gate.js';

export interface Priced {
  readonly usdIn: number;
  readonly priceUsd: number;
  readonly marketCapUsd: number;
  /** The buyer's SOL+USDC wallet value — the whale signal (pricing/wallet-value.ts). */
  readonly whaleValueUsd: number;
  readonly quoteAmount: number;
  readonly tokensOut: number;
}

/** What actually went out. Phase 9's single per-buy log line is rendered from this. */
export interface CardSummary {
  readonly earnedTier: string;
  readonly usedTier: string | null;
  readonly mediaSha: string | null;
  readonly chatsPosted: number;
}

export interface FanOutDeps {
  readonly repo: Repo;
  readonly media: MediaPool;
  readonly queue: DeliveryQueue;
  readonly log: Logger;
  readonly now?: () => number;
  /**
   * Called ONCE per buy, after fan-out, with what was actually chosen.
   *
   * Only fan-out knows the used tier, the media sha and how many chats took it — so this is
   * the only place the one info-level line per buy can be written without re-deriving any of
   * it somewhere else and getting it subtly wrong.
   */
  readonly onCard?: (summary: CardSummary) => void;
  /** The ledger view for the Position line. Null when we have no basis to speak of. */
  readonly position?: (mint: Mint, buyer: string) => Promise<PositionView | null>;
  /**
   * PHASE 17 — the project's treasury wallet (cfg.TREASURY_WALLET). A buy FROM it cards as a
   * TREASURY BUY BACK: same layout, its own headline, its own art folder.
   *
   * Absent (or empty) means the feature is off and no buy is ever a buy back — never that some
   * default address is assumed here. The default lives in `config/`, where an operator can see it
   * and override it; a second one hidden in the fan-out would be a rule nobody could find.
   */
  readonly treasuryWallet?: string | undefined;
}

/**
 * Fan one buy out to every chat watching that mint.
 *
 * Each chat gets its OWN card: its own tier policy, its own emoji, its own headline, its
 * own rotation bag. Two groups tracking $RICE do not see the same meme, and that is
 * deliberate (see MediaPool).
 *
 * `min_buy_usd` is applied HERE, before anything else — before tiering, before art, before
 * a claim. A buy below a group's floor is not a small card, it is no card.
 */
export async function fanOut(event: BuyEvent, priced: Priced, deps: FanOutDeps): Promise<number> {
  const { repo, media, queue, log } = deps;
  const now = deps.now ?? Date.now;

  // PHASE 17 — is this the treasury buying its own token back? Decided ONCE, here, for every
  // watching chat: the answer is a fact about the buyer, and a per-chat re-test could only ever
  // produce the same answer more expensively.
  const isTreasury = isTreasuryBuy(event.buyer, deps.treasuryWallet);

  const watchers = await repo.chatTokensForMint(event.mint);
  let queued = 0;
  let last: Omit<CardSummary, 'chatsPosted'> | null = null;

  for (const ct of watchers) {
    if (!ct.enabled) continue;
    // A TREASURY BUY BACK IGNORES THE GROUP'S FLOOR, and it is the only thing that does.
    //
    // `min_buy_usd` exists to keep a feed of strangers' dust out of a chat. A buy back is not that:
    // it is the project itself, and a group that has asked to be told when the treasury buys means
    // it whether the treasury spent $4,000 or $4. Sizing it out would make the card silently
    // conditional on a number set for an entirely different purpose.
    if (!isTreasury && priced.usdIn < ct.minBuyUsd) continue; // below this group's floor: no card at all

    // PLAN GATE, at the point of USE (Phase 11).
    //
    // Not just in the /setX commands: a chat downgraded from paid keeps a perfectly legal
    // paid config in the DB, and if the gate lived only in the setters it would keep every
    // paid feature forever. The stored config is untouched — an upgrade restores it instantly
    // — but what it can DO is clamped here, every time.
    // planOf() consults PLAN_WHITELIST first, so a whitelisted chat gets the paid feature set
    // on the SEND path too — not just in the commands. Gating one and not the other is how a
    // group is told it has the pool and then never sees a pool meme.
    const caps = capabilities(await planOf(repo, ct.chatId));
    const eff = effective(ct, caps, DEFAULT_LINKS);

    // Treasury art comes from its own folder and NEVER from a tier (see MediaPool.pickTreasury).
    // Note what is not consulted for a buy back: the priority chain. A treasury buy is not a size
    // of buy, so it has no tier to earn — including no Whale, which is why the card carries no
    // wallet-value line even when the treasury is holding a fortune in SOL.
    const picked: Pick | null = isTreasury
      ? {
          earnedTier: TREASURY_NAME,
          usedTier: TREASURY_FOLDER,
          item: await media.pickTreasury(event.mint, ct.chatId),
        }
      : await media.pick(event.mint, ct.chatId, priced.usdIn, priced.whaleValueUsd);
    if (!picked) continue; // pickTier said no — should be unreachable after the floor check

    const token = await repo.getToken(event.mint);
    if (!token) {
      log.warn({ mint: event.mint }, 'no token metadata — skipping card');
      continue;
    }

    const position = deps.position ? await deps.position(event.mint, event.buyer) : null;

    const input: CardInput = {
      signature: event.signature,
      mint: event.mint,
      buyer: event.buyer,
      token,
      // The headline comes from the EARNED tier. The art may have come from elsewhere.
      earnedTier: picked.earnedTier,
      usedTier: picked.usedTier,
      media: picked.item,
      usdIn: priced.usdIn,
      quoteAmount: priced.quoteAmount,
      quoteSymbol: event.quoteSymbol,
      tokensOut: priced.tokensOut,
      marketCapUsd: priced.marketCapUsd,
      whaleValueUsd: priced.whaleValueUsd,
      position,
      emoji: ct.emoji,
      emojiCustomId: eff.emojiCustomId, // dropped on free — the unicode glyph IS the text
      emojiStepUsd: ct.emojiStepUsd,
      maxEmojis: ct.maxEmojis,
      tierHeadlines: ct.tierHeadlines,
      links: eff.links, // free chats get the three defaults, whatever they have stored
    };

    const card = renderCard(input);

    // The media is resolved LAZILY, inside build(), for two reasons: a job that gets
    // dropped as stale never pays for a file_id, and a job that waits behind a 429 picks
    // up a file_id that was minted while it waited.
    const build = async (): Promise<Outbound> => {
      // eff.mediaMode: a free chat on 'pool' falls back to its static image, then to text.
      const resolved = await resolveMedia(eff.mediaMode, ct.staticFileId, ct.staticKind, picked.item, media);
      return { chatId: ct.chatId, card, fileId: resolved.fileId, kind: resolved.kind };
    };

    queue.enqueue({
      signature: event.signature,
      chatId: ct.chatId,
      enqueuedAt: now(),
      delayMs: eff.postDelayMs, // free: 5s late. Paid: instant.
      build,
    });
    queued++;

    last = { earnedTier: picked.earnedTier, usedTier: picked.usedTier, mediaSha: picked.item?.sha256 ?? null };
  }

  if (last) deps.onCard?.({ ...last, chatsPosted: queued });
  return queued;
}

/**
 * Which bytes actually go out.
 *
 *   media_mode = 'static' -> always the chat's own file_id, never the pool
 *   media_mode = 'none'   -> no media: a plain sendMessage with the SAME body
 *   media_mode = 'pool'   -> the tiered pick; and if the pool cannot produce a file_id
 *                            (no art, or the bytes are gone and it was never uploaded),
 *                            fall through to static, then to text.
 *
 * NEVER FAIL A POST FOR WANT OF ART. Every branch here ends in a card going out.
 */
async function resolveMedia(
  mode: string,
  staticFileId: string | null,
  staticKind: MediaKind | null,
  item: Parameters<MediaPool['fileIdFor']>[0] | null,
  media: MediaPool,
): Promise<{ fileId: string | null; kind: MediaKind | null }> {
  if (mode === 'none') return { fileId: null, kind: null };

  if (mode === 'static') {
    return staticFileId ? { fileId: staticFileId, kind: staticKind ?? 'photo' } : { fileId: null, kind: null };
  }

  if (item) {
    const fileId = await media.fileIdFor(item);
    if (fileId) return { fileId, kind: item.kind };
  }

  // Pool had nothing usable. Static is the next best thing; text-only is still a post.
  if (staticFileId) return { fileId: staticFileId, kind: staticKind ?? 'photo' };
  return { fileId: null, kind: null };
}

/**
 * Is this buy the treasury's own?
 *
 * Exact address match, and NOTHING else — no prefix, no case folding (base58 is case-sensitive and
 * two addresses differing only in case are two different accounts). An unset or empty
 * `treasuryWallet` matches nothing, so the feature is off rather than loose.
 */
export function isTreasuryBuy(buyer: string, treasuryWallet: string | undefined): boolean {
  return treasuryWallet !== undefined && treasuryWallet !== '' && buyer === treasuryWallet;
}

export { TIER_BY_NAME };
