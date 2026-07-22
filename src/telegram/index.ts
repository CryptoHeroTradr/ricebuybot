/**
 * Telegram surface (grammY). Phase 7.
 *
 * Contracts this module honours:
 *  - INVARIANT 2: every send is idempotent on (signature, chat_id). `claimSend` BEFORE
 *    the Bot API call, `markSent` after, `releaseSend` on a retryable failure,
 *    `failSend` on a permanent one. A restart never double-posts. See queue.ts — the
 *    claim is a single atomic INSERT and is never a read-then-write.
 *  - INVARIANT 3: media is uploaded by THIS bot, once, via `MediaPool.fileIdFor`.
 *  - INVARIANT 7: DRY_RUN renders to stdout and sends nothing (DryRunSender).
 *  - INVARIANT 8: config writes require verified admin status, re-checked at write time.
 *    (Phase 8 — no config commands live here yet.)
 *
 * `render/` is pure and knows nothing about Telegram; `media/` knows nothing about
 * Telegram. sender.ts is the only file that imports grammY.
 */
export { TelegramSender, DryRunSender, type Sender, type Outbound } from './sender.js';
export { DeliveryQueue, type Job, type QueueDeps } from './queue.js';
export { fanOut, type Priced, type FanOutDeps, type CardSummary } from './fanout.js';
export { classify, isCustomEmojiRejection, type Verdict } from './errors.js';
export { registerCommands, type CommandDeps } from './commands.js';
export { requireGroupAdmin, requireDmOwner, type Gate } from './admin.js';
export { Wizards, WIZARD_TTL_MS, PROMPTS, type Step } from './wizard.js';
export {
  validateMintFormat,
  validateMintOnChain,
  validateFloors,
  validateUsd,
  validateInt,
  base58Decode,
  type ChainCheck,
} from './validate.js';
export { settingsMessage, mediaStatsMessage, floorsSentence, whaleSentence } from './settings.js';
export { BurstDetector, DailyCap, digestText, type Digest, BURST_THRESHOLD } from './digest.js';
