import { Bot, InputFile } from 'grammy';
import type { Logger } from 'pino';

import type { ChatId, MediaItem, MediaKind } from '../core/types.js';
import type { MediaUploader } from '../media/index.js';
import type { Card } from '../render/card.js';
import { isCustomEmojiRejection } from './errors.js';

/** What the queue hands the transport. */
export interface Outbound {
  readonly chatId: ChatId;
  readonly card: Card;
  /** Resolved file_id, or null for a text-only send. */
  readonly fileId: string | null;
  readonly kind: MediaKind | null;
}

export interface Sender {
  send(msg: Outbound): Promise<number>;
}

/**
 * The grammY surface. The ONLY file that talks to the Bot API.
 *
 * `render/` produced text + entities and knows nothing about Telegram; `media/` produced
 * a file_id and knows nothing about Telegram. This is where they meet the wire.
 */
export class TelegramSender implements Sender, MediaUploader {
  readonly #bot: Bot;
  readonly #log: Logger;
  readonly #vaultChatId: number;

  constructor(token: string, vaultChatId: number, log: Logger) {
    this.#bot = new Bot(token);
    this.#vaultChatId = vaultChatId;
    this.#log = log.child({ mod: 'telegram' });
  }

  get bot(): Bot {
    return this.#bot;
  }

  /**
   * Upload bytes to the vault and keep the file_id Telegram mints.
   *
   * The vault is a private channel only the bot posts to, so a first-ever send never
   * uploads into a public group: no spinner, no half-rendered card, nobody watching a
   * 40MB video crawl in. See MediaUploader.
   */
  async uploadToVault(kind: MediaKind, bytes: Buffer, filename: string): Promise<string> {
    const file = new InputFile(bytes, filename);

    switch (kind) {
      case 'photo': {
        const m = await this.#bot.api.sendPhoto(this.#vaultChatId, file);
        // Telegram returns every rendered size; the LAST is the largest, and it is the
        // one whose file_id we want — the others are thumbnails.
        const largest = m.photo[m.photo.length - 1];
        if (!largest) throw new Error('sendPhoto returned no photo sizes');
        return largest.file_id;
      }
      case 'animation': {
        const m = await this.#bot.api.sendAnimation(this.#vaultChatId, file);
        if (!m.animation) throw new Error('sendAnimation returned no animation');
        return m.animation.file_id;
      }
      case 'video': {
        const m = await this.#bot.api.sendVideo(this.#vaultChatId, file);
        if (!m.video) throw new Error('sendVideo returned no video');
        return m.video.file_id;
      }
    }
  }

  /**
   * Send one card. Returns the message_id, which the ledger records.
   *
   * A CUSTOM-EMOJI REJECTION NEVER KILLS THE POST. Custom emoji require the group to
   * permit them (and the bot to have the right); a group that does not is a config
   * mistake, not a reason to eat a buy. So: retry ONCE with the custom_emoji entities
   * stripped, which leaves the plain unicode emoji already in the text — the ladder is
   * still there, it is just not premium. Warn, and move on.
   */
  async send(msg: Outbound): Promise<number> {
    try {
      return await this.#dispatch(msg, msg.card.entities);
    } catch (err) {
      if (!isCustomEmojiRejection(err)) throw err;

      const plain = msg.card.entities.filter((e) => e.type !== 'custom_emoji');
      this.#log.warn(
        { chatId: msg.chatId, err: (err as Error).message },
        'custom emoji rejected — resending with the unicode ladder',
      );
      return this.#dispatch(msg, plain);
    }
  }

  async #dispatch(msg: Outbound, entities: readonly Card['entities'][number][]): Promise<number> {
    const { chatId, card, fileId, kind } = msg;
    const markup = {
      inline_keyboard: card.keyboard.map((row) => row.map((b) => ({ text: b.text, url: b.url }))),
    };

    // No parse_mode ANYWHERE: entities and parse_mode are mutually exclusive, and the
    // ladder needs entities. See render/entities.ts.
    if (fileId === null || kind === null) {
      const m = await this.#bot.api.sendMessage(chatId, card.text, {
        entities: entities as never,
        reply_markup: markup,
        link_preview_options: { is_disabled: true },
      });
      return m.message_id;
    }

    const opts = { caption: card.text, caption_entities: entities as never, reply_markup: markup };

    switch (kind) {
      case 'photo':
        return (await this.#bot.api.sendPhoto(chatId, fileId, opts)).message_id;
      case 'animation':
        return (await this.#bot.api.sendAnimation(chatId, fileId, opts)).message_id;
      case 'video':
        return (await this.#bot.api.sendVideo(chatId, fileId, opts)).message_id;
    }
  }
}

/**
 * INVARIANT 7. Renders to stdout and sends NOTHING.
 *
 * It prints everything you need to judge a card without a token: the dollar figures the
 * tier was chosen from, the EARNED tier, the tier the art actually came from (they differ
 * when a folder is empty — and that difference is exactly the thing that is easy to get
 * wrong), and the media sha256 so you can go and look at the file.
 */
export class DryRunSender implements Sender {
  #n = 0;

  constructor(
    private readonly log: Logger,
    private readonly describe: (chatId: ChatId) => {
      usdIn: number;
      holdingsUsd: number | null;
      earnedTier: string;
      usedTier: string | null;
      sha256: string | null;
    },
  ) {}

  async send(msg: Outbound): Promise<number> {
    const d = this.describe(msg.chatId);
    const rule = '─'.repeat(56);

    process.stdout.write(
      `\n${rule}\n` +
        `DRY_RUN card -> chat ${msg.chatId}\n` +
        `  usdIn=${d.usdIn.toFixed(2)}  holdingsUsd=${d.holdingsUsd?.toFixed(2) ?? 'null'}\n` +
        `  earnedTier=${d.earnedTier}  usedTier=${d.usedTier ?? 'none'}  media=${d.sha256 ?? 'none'}\n` +
        `  ladder=${msg.card.ladderCount}${msg.card.ladderTruncated ? ' (TRUNCATED)' : ''}` +
        `  entities=${msg.card.entities.length}\n` +
        `${rule}\n${msg.card.text}\n${rule}\n` +
        `${msg.card.keyboard.map((r) => r.map((b) => `[ ${b.text} ]`).join(' ')).join('\n')}\n`,
    );
    return ++this.#n;
  }
}
