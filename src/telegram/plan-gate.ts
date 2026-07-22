import type { ChatId, ChatToken } from '../core/types.js';
import { capabilities, UPSELL, type Capabilities, type Plan } from '../core/plans.js';
import type { Repo } from '../db/index.js';

/**
 * PLAN ENFORCEMENT. Phase 11.
 *
 * ENFORCE AT THE POINT OF USE, NOT ONLY AT CONFIG TIME.
 *
 * The obvious design is to check the plan in the /setX commands and be done: a free chat is
 * never *allowed* to set a custom emoji, so a free chat never *has* one. That reasoning holds
 * right up until a plan is DOWNGRADED — a subscription lapses, an owner revokes a grant — and
 * then the chat is sitting there with `emoji_custom_id` set, `media_mode = 'pool'` and six
 * custom buttons, all configured perfectly legally while it was paying.
 *
 * If the gate lives only in the setters, that chat keeps every paid feature forever, and the
 * downgrade is a no-op. The config is not the entitlement — the PLAN is. So the render and
 * send paths clamp too, and a downgraded chat degrades gracefully the moment it is downgraded:
 * the pool falls back to its static image, the custom emoji falls back to the unicode glyph
 * that is already the text, the extra buttons drop off, and the posts start arriving 5s late.
 *
 * Nothing is destroyed by a downgrade. The config stays in the DB exactly as it was, so an
 * upgrade restores it instantly. We are gating what the plan CAN DO, not deleting what the
 * chat has SAID.
 */

export interface Gate {
  readonly allowed: boolean;
  /** What to tell them. Empty when allowed. */
  readonly why: string;
}

const OK: Gate = { allowed: true, why: '' };

/**
 * Chat ids that are always paid, from PLAN_WHITELIST.
 *
 * Set once at boot. An OVERRIDE, deliberately not a DB write: an id dropped from the env is an
 * entitlement gone on the next restart, with no row to find and unpick later. A /grant is the
 * opposite — a sale is a fact, so it is recorded with who granted it and when.
 *
 * The whitelist can only ever UPGRADE. It never downgrades a chat that paid.
 */
let whitelist: ReadonlySet<number> = new Set();

export function setPlanWhitelist(ids: readonly number[]): void {
  whitelist = new Set(ids);
}

export function isWhitelisted(chatId: ChatId): boolean {
  return whitelist.has(chatId as unknown as number);
}

export async function planOf(repo: Repo, chatId: ChatId): Promise<Plan> {
  if (isWhitelisted(chatId)) return 'paid';
  return (await repo.getChat(chatId))?.plan ?? 'free';
}

export async function capsOf(repo: Repo, chatId: ChatId): Promise<Capabilities> {
  return capabilities(await planOf(repo, chatId));
}

/** A capability check with the upsell attached, so no caller has to write the copy. */
export function gate(caps: Capabilities, key: keyof Capabilities): Gate {
  const value = caps[key];
  const allowed = typeof value === 'boolean' ? value : true;
  return allowed ? OK : { allowed: false, why: UPSELL[key] };
}

/** /setca: one mint on free, ten on paid. */
export function gateMints(caps: Capabilities, currentMints: number): Gate {
  return currentMints < caps.maxMints ? OK : { allowed: false, why: UPSELL.maxMints };
}

/**
 * The EFFECTIVE config for a chat, after its plan has been applied.
 *
 * This is what the renderer and the sender see — never the raw `chat_tokens` row. A downgraded
 * chat's stored config is untouched (so an upgrade restores it instantly) but what it can
 * actually DO is clamped here, in one place, every time.
 */
export interface EffectiveConfig {
  readonly mediaMode: ChatToken['mediaMode'];
  readonly emojiCustomId: string | null;
  readonly links: ChatToken['links'];
  readonly postDelayMs: number;
}

export function effective(ct: ChatToken, caps: Capabilities, defaultLinks: Readonly<Record<string, string>>): EffectiveConfig {
  return {
    // A free chat that was previously on the pool falls back to its static image, and to a
    // text-only card if it has none. It does NOT get the pool, and it does NOT break.
    mediaMode: !caps.mediaPool && ct.mediaMode === 'pool' ? 'static' : ct.mediaMode,

    // Dropping the custom_emoji ENTITY leaves the unicode glyph, because the glyph was always
    // the text — a custom emoji only ever decorated it (see render/emoji.ts). So a downgrade
    // costs the premium rendering and nothing else. The ladder still has its grains.
    emojiCustomId: caps.customEmoji ? ct.emojiCustomId : null,

    // Free chats get the three defaults, whatever they have stored.
    links: caps.customLinks ? ct.links : defaultLinks,

    postDelayMs: caps.postDelayMs,
  };
}
