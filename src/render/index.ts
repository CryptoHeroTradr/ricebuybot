/**
 * Message rendering. Phase 7.
 *
 * PURE: a CardInput goes in, text + entities + a keyboard come out. No I/O, no clock, no
 * network — so it is exhaustively testable, and DRY_RUN prints exactly what would have
 * been sent.
 *
 * INVARIANT 6: this is the RENDER BOUNDARY. Raw integer amounts became floats upstream in
 * pricing/; nothing below this line does arithmetic on money.
 *
 * The caption is text + ENTITIES, never parse_mode — they are mutually exclusive, and the
 * emoji ladder needs custom_emoji entities. That also means there is no markup to escape.
 */
export { renderCard, headlineFor, CAPTION_MAX, CAPTION_BUDGET, type Card, type CardInput } from './card.js';
export { buildLadder, ladderCount, utf16Length, type Ladder } from './emoji.js';
export { Caption, type MessageEntity } from './entities.js';
export { buildKeyboard, defaultLinksFor, DEFAULT_LINKS, RICE_LINKS, RICE_MINT, type Button } from './links.js';
export { positionLine, type PositionLine, type PositionView } from './position.js';
export { usd, tokens, pct, symbol } from './format.js';
