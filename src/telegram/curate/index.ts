import type { Bot, Context } from 'grammy';
import { InputMediaBuilder } from 'grammy';
import type { Logger } from 'pino';

import type { MediaKind, Mint } from '../../core/types.js';
import { TIER_FOLDERS, isTierFolder, type TierFolder } from '../../core/tiers.js';
import { symbol as displaySymbol } from '../../render/format.js';
import type { Repo } from '../../db/index.js';
import type { MediaPool } from '../../media/index.js';
import { addMedia, moveMedia, removeMedia, DOWNLOAD_LIMIT_BYTES, type CurateDeps } from '../../media/curate.js';
import { NOT_A_CURATOR, resolveCurator, type AuthDeps } from './auth.js';
import { CurationSessions, AWAITING_TTL_MS, cb, parseCb, type Board } from './session.js';
import { InputArbiter } from '../input-arbiter.js';
import * as view from './view.js';

export { CurationSessions } from './session.js';
export * as curateView from './view.js';
export { resolveCurator, curatableMints, isAdminForMint, NOT_A_CURATOR } from './auth.js';

export interface CurateUiDeps {
  readonly repo: Repo;
  readonly pool: MediaPool;
  readonly log: Logger;
  readonly mediaRoot: string;
  readonly botToken: string;
  readonly ownerUserId?: number | undefined;
  /** The shared DM input arbiter — one awaiting state per user across all handlers. */
  readonly arbiter: InputArbiter;
  readonly sessions?: CurationSessions;
}

/** Telegram's document types we accept, mapped to how the bot must SEND them later. */
function kindOf(msg: Context['msg']): { kind: MediaKind; fileId: string; size: number; ext: string } | null {
  if (!msg) return null;

  const photo = msg.photo?.[msg.photo.length - 1];
  if (photo) return { kind: 'photo', fileId: photo.file_id, size: photo.file_size ?? 0, ext: '.jpg' };

  if (msg.animation) {
    return {
      kind: 'animation',
      fileId: msg.animation.file_id,
      size: msg.animation.file_size ?? 0,
      ext: extOf(msg.animation.file_name, '.mp4'),
    };
  }
  if (msg.video) {
    return { kind: 'video', fileId: msg.video.file_id, size: msg.video.file_size ?? 0, ext: extOf(msg.video.file_name, '.mp4') };
  }

  // A forwarded meme very often arrives as a DOCUMENT — that is the primary path, not an
  // edge case. Telegram sends a GIF as an animation from the picker but as a document when
  // it came from a file manager, and a curator forwarding from another channel gets
  // whichever the original sender used.
  const doc = msg.document;
  if (doc?.mime_type) {
    const ext = extOf(doc.file_name, doc.mime_type.includes('gif') ? '.gif' : '.mp4');
    if (doc.mime_type.startsWith('image/')) {
      return { kind: doc.mime_type.includes('gif') ? 'animation' : 'photo', fileId: doc.file_id, size: doc.file_size ?? 0, ext };
    }
    if (doc.mime_type.startsWith('video/')) {
      return { kind: 'video', fileId: doc.file_id, size: doc.file_size ?? 0, ext };
    }
  }
  return null;
}

function extOf(name: string | undefined, fallback: string): string {
  const dot = name?.lastIndexOf('.') ?? -1;
  return dot > 0 ? (name as string).slice(dot).toLowerCase() : fallback;
}

export function registerCuration(bot: Bot, deps: CurateUiDeps): void {
  const sessions = deps.sessions ?? new CurationSessions();
  const arbiter = deps.arbiter;
  // How to drop our payload when the arbiter's /cancel releases the slot.
  arbiter.onCancel('curation', (uid: number) => void sessions.stopAwaiting(uid));
  const auth: AuthDeps = { repo: deps.repo, api: bot.api, ownerUserId: deps.ownerUserId };
  const curate: CurateDeps = { repo: deps.repo, pool: deps.pool, root: deps.mediaRoot, log: deps.log };

  const isDm = (ctx: Context): boolean => ctx.chat?.type === 'private';

  const symbolOf = async (mint: Mint): Promise<string> =>
    displaySymbol((await deps.repo.getToken(mint))?.symbol ?? null, mint);

  const countsOf = async (mint: Mint): Promise<Record<TierFolder, number>> => {
    const out = {} as Record<TierFolder, number>;
    for (const t of TIER_FOLDERS) out[t] = (await deps.repo.listMedia(mint, t)).length;
    return out;
  };

  const liveItems = async (mint: Mint, tier: TierFolder) => deps.repo.listMedia(mint, tier);

  // -------------------------------------------------------------------------
  // /media — the entry point, and the security gate
  // -------------------------------------------------------------------------

  bot.command('media', async (ctx) => {
    if (!isDm(ctx)) return void ctx.reply('Send me /media in a DM and I’ll open the meme board there.');

    const userId = ctx.from?.id ?? 0;

    // AUTHORIZATION, re-derived right now. A stranger gets nothing — not a board, not a
    // count, not the knowledge that a pool exists.
    const who = await resolveCurator(auth, userId);

    if (who.kind === 'none') return void ctx.reply(NOT_A_CURATOR);

    if (who.kind === 'many') {
      // More than one mint: ask which. A curator with exactly one is never asked.
      const rows = await Promise.all(
        who.mints.map(async (m) => {
          const board = sessions.openBoard(userId, m);
          return [{ text: `$${await symbolOf(m)}`, callback_data: cb(board.token, 'board') }];
        }),
      );
      return void ctx.reply('Which token?', { reply_markup: { inline_keyboard: rows } });
    }

    const board = sessions.openBoard(userId, who.mint);
    await showBoard(ctx, board, true);
  });

  bot.command('done', async (ctx) => {
    const uid = ctx.from?.id ?? 0;
    const stopped = sessions.stopAwaiting(uid);
    arbiter.release(uid, 'curation');
    await ctx.reply(stopped ? 'Done. Send /media to see the board.' : 'Nothing in progress.');
  });

  // -------------------------------------------------------------------------
  // rendering: ONE message, edited in place
  // -------------------------------------------------------------------------

  async function showBoard(ctx: Context, board: Board, fresh = false): Promise<void> {
    board.tier = null;
    const counts = await countsOf(board.mint);
    const text = view.boardText(await symbolOf(board.mint), counts);
    const markup = { inline_keyboard: view.boardKeyboard(board.token, counts) };

    if (fresh || board.messageId === null) {
      const m = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: markup });
      board.messageId = m.message_id;
      return;
    }

    // Coming BACK from a gallery means the message currently holds media, and a media
    // message cannot be edited into a text one. Delete and repost — the only place this
    // flow is allowed to make a second message, and it removes the first.
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, board.messageId);
    } catch {
      /* already gone */
    }
    const m = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: markup });
    board.messageId = m.message_id;
  }

  async function showGallery(ctx: Context, board: Board): Promise<void> {
    const tier = board.tier as TierFolder;
    const items = await liveItems(board.mint, tier);

    // The pool may have shrunk under this board (another curator, a removal). Clamp rather
    // than page off the end.
    board.index = items.length === 0 ? 0 : Math.min(board.index, items.length - 1);

    const item = view.itemAt(items, board.index);
    const caption = view.galleryCaption(tier, board.index, items.length);
    const markup = { inline_keyboard: view.galleryKeyboard(board.token, items.length) };
    const chatId = ctx.chat!.id;

    // Empty tier: there is no media to show, so this is a TEXT message. Rendering an empty
    // gallery as media would mean inventing a placeholder image, which is a lie about the
    // pool's contents.
    if (!item) {
      if (board.messageId !== null) {
        try {
          await ctx.api.deleteMessage(chatId, board.messageId);
        } catch {
          /* gone */
        }
      }
      const m = await ctx.reply(caption, { reply_markup: markup });
      board.messageId = m.message_id;
      return;
    }

    const fileId = await deps.pool.fileIdFor(item);
    if (!fileId) {
      await ctx.answerCallbackQuery?.({ text: "I can't display that one — its file is missing." }).catch(() => {});
      return;
    }

    const media =
      item.kind === 'photo'
        ? InputMediaBuilder.photo(fileId, { caption })
        : item.kind === 'animation'
          ? InputMediaBuilder.animation(fileId, { caption })
          : InputMediaBuilder.video(fileId, { caption });

    // editMessageMedia: the curator is PAGING, not chatting. Twenty taps must not leave
    // twenty messages behind them.
    if (board.messageId !== null) {
      try {
        await ctx.api.editMessageMedia(chatId, board.messageId, media, { reply_markup: markup });
        return;
      } catch {
        // The message currently holds TEXT (we came from the board, or from an empty tier),
        // and text cannot be edited into media. Replace it.
        try {
          await ctx.api.deleteMessage(chatId, board.messageId);
        } catch {
          /* gone */
        }
      }
    }

    const sent =
      item.kind === 'photo'
        ? await ctx.replyWithPhoto(fileId, { caption, reply_markup: markup })
        : item.kind === 'animation'
          ? await ctx.replyWithAnimation(fileId, { caption, reply_markup: markup })
          : await ctx.replyWithVideo(fileId, { caption, reply_markup: markup });

    board.messageId = sent.message_id;
  }

  // -------------------------------------------------------------------------
  // the buttons
  // -------------------------------------------------------------------------

  bot.on('callback_query:data', async (ctx, next) => {
    const parsed = parseCb(ctx.callbackQuery.data);
    if (!parsed) return next();

    const userId = ctx.from.id;
    const board = sessions.board(parsed.token, userId);

    // Not theirs, or gone. Both answer the same way: a token someone else's screenshot
    // showed you is not a key to their board.
    if (board === null) {
      await ctx.answerCallbackQuery({ text: view.EXPIRED });
      return;
    }
    if (board === 'expired') {
      await ctx.answerCallbackQuery({ text: view.EXPIRED, show_alert: true });
      return;
    }

    const verb = parsed.verb;
    await ctx.answerCallbackQuery().catch(() => {});

    if (verb === 'board') return void showBoard(ctx, board);

    if (verb.startsWith('t:')) {
      const tier = verb.slice(2);
      if (!isTierFolder(tier)) return;
      board.tier = tier;
      board.index = 0;
      return void showGallery(ctx, board);
    }

    if (verb === 'gallery') return void showGallery(ctx, board);

    if (verb === 'prev' || verb === 'next') {
      const items = await liveItems(board.mint, board.tier as TierFolder);
      board.index = view.step(board.index, items.length, verb === 'next' ? 1 : -1);
      return void showGallery(ctx, board);
    }

    if (verb === 'add') {
      const claim = arbiter.acquire(userId, 'curation', { ttlMs: AWAITING_TTL_MS });
      if (!claim.ok) {
        return void ctx.reply(`Finish your ${claim.heldLabel} first, or send /cancel to drop it — then tap ➕ Add again.`);
      }
      sessions.startAwaiting(userId, board.mint, board.tier as TierFolder);
      if (claim.cancelled) await ctx.reply(`(cancelled the pending ${claim.cancelled})`);
      const name = board.tier;
      await ctx.reply(
        `Send or forward media for **${name}**. I'll add each one as it arrives.\n\n/done when finished.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    if (verb === 'rm') {
      const items = await liveItems(board.mint, board.tier as TierFolder);
      if (items.length === 0) return;
      await ctx.reply(view.removeConfirm(board.tier as TierFolder, board.index, items.length), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: view.removeKeyboard(board.token) },
      });
      return;
    }

    if (verb === 'rm!') {
      const items = await liveItems(board.mint, board.tier as TierFolder);
      const item = view.itemAt(items, board.index);
      if (!item) return;

      await removeMedia(curate, board.mint, item.sha256);

      // Clamp: removing the last item leaves the EMPTY view, not a crash and not an index
      // pointing past the end of a shorter list.
      const left = await liveItems(board.mint, board.tier as TierFolder);
      board.index = left.length === 0 ? 0 : Math.min(board.index, left.length - 1);

      await ctx.reply('🗑 Removed. It’s out of every group’s rotation now, and off the website.');
      return void showGallery(ctx, board);
    }

    // The move offer, raised when a forwarded meme is already in another tier.
    if (verb.startsWith('mv:')) {
      const to = verb.slice(3);
      const awaiting = sessions.awaiting(userId);
      if (!isTierFolder(to) || !awaiting?.pendingMove) return;

      await moveMedia(curate, board.mint, awaiting.pendingMove.sha256, to);
      awaiting.pendingMove = undefined;
      await ctx.reply(`✅ Moved. It's in ${to} now, and only there.`);
      return;
    }

    if (verb === 'keep') {
      const awaiting = sessions.awaiting(userId);
      if (awaiting) awaiting.pendingMove = undefined;
      await ctx.reply('Left where it was.');
      return;
    }
  });

  // -------------------------------------------------------------------------
  // incoming media, while awaiting
  // -------------------------------------------------------------------------

  bot.on('message', async (ctx, next) => {
    if (!isDm(ctx)) return next();

    const userId = ctx.from?.id ?? 0;
    // Process only if WE hold the single input slot — never by handler order. While a /wallet key
    // is awaited the slot is the wallet's, so a forwarded file here does not steal that turn.
    if (!arbiter.owns(userId, 'curation')) return next();
    const awaiting = sessions.awaiting(userId);
    if (!awaiting) return next();

    const found = kindOf(ctx.msg);
    if (!found) return next(); // not media — let the other handlers have it

    // The gate again, on the ACTION and not just on the board. A board opened while the user
    // was an admin must not keep working after they are not — the whole point of checking at
    // action time is that the check is at the ACTION.
    const still = await resolveCurator(auth, userId);
    const allowed =
      still.kind === 'one' ? still.mint === awaiting.mint : still.kind === 'many' && still.mints.includes(awaiting.mint);
    if (!allowed) {
      sessions.stopAwaiting(userId);
      arbiter.release(userId, 'curation');
      return void ctx.reply(NOT_A_CURATOR);
    }

    // 20MB: getFile DOWNLOADS cap at 20MB even though sends allow 50MB. Say the number and
    // the reason — a silent failure here is a curator watching a meme vanish into nothing.
    if (found.size > DOWNLOAD_LIMIT_BYTES) {
      return void ctx.reply(view.tooBig(found.size), { parse_mode: 'Markdown' });
    }

    let bytes: Buffer;
    try {
      const file = await ctx.api.getFile(found.fileId);
      if ((file.file_size ?? 0) > DOWNLOAD_LIMIT_BYTES) {
        return void ctx.reply(view.tooBig(file.file_size as number), { parse_mode: 'Markdown' });
      }
      const url = `https://api.telegram.org/file/bot${deps.botToken}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      // Protected-content media cannot be downloaded by a bot, ever. Say so plainly and do
      // NOT retry — retrying a thing that is forbidden by policy just wastes both our time.
      deps.log.warn({ err: (err as Error).message }, 'could not download curated media');
      return void ctx.reply(
        "I can't download that one — the chat it came from has content protection on. Save it and send it to me as a file instead.",
      );
    }

    const result = await addMedia(curate, awaiting.mint, awaiting.tier, bytes, found.ext, found.kind, found.fileId);
    sessions.touch(userId);

    if (result.kind === 'duplicate-here') {
      return void ctx.reply(`Already in ${awaiting.tier}.`);
    }

    if (result.kind === 'duplicate-elsewhere') {
      awaiting.pendingMove = { sha256: result.sha256, from: result.tier };
      const board = sessions.openBoard(userId, awaiting.mint);
      return void ctx.reply(view.moveText(awaiting.tier, result.tier), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: view.moveKeyboard(board.token, awaiting.tier, result.tier) },
      });
    }

    // One line, not a gallery. A curator forwarding twenty memes wants twenty ticks.
    await ctx.reply(view.addedLine(awaiting.tier, result.count));
  });
}
