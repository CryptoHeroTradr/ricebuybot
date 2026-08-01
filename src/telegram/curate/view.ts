import type { MediaItem } from '../../core/types.js';
import { TIERS, DCA_FOLDER, TREASURY_FOLDER, MEDIA_FOLDERS, type MediaFolder } from '../../core/tiers.js';
import { cb } from './session.js';

/**
 * The board and gallery COPY and KEYBOARDS. Pure — so every screen a curator ever sees is
 * testable with no bot, no network and no Telegram.
 */

/** Below this, a tier visibly repeats itself. Massive is the one that will be thin. */
export const THIN_TIER = 5;

export interface Button {
  readonly text: string;
  readonly callback_data: string;
}

/**
 * The display name for a media folder. The four tiers have proper names; `dca` and `treasury` are
 * siblings on the category axis, not tiers, so they have no TierSpec — they render as "DCA" and
 * "Treasury". A folder that is none of those would fall through to its own string, but
 * `isMediaFolder` gates every caller.
 */
const CATEGORY_NAMES: Readonly<Record<string, string>> = { [DCA_FOLDER]: 'DCA', [TREASURY_FOLDER]: 'Treasury' };

export function folderName(folder: MediaFolder): string {
  return CATEGORY_NAMES[folder] ?? TIERS.find((t) => t.folder === folder)?.name ?? folder;
}

export function boardText(symbol: string, counts: Readonly<Record<MediaFolder, number>>): string {
  const rows = MEDIA_FOLDERS.map((folder) => {
    const n = counts[folder];
    const thin = n > 0 && n < THIN_TIER ? '   ⚠️ tier is thin' : n === 0 ? '   ⚠️ empty' : '';
    return `${folderName(folder).padEnd(9)} ${String(n).padStart(3)}${thin}`;
  });

  return [`🍚 $${symbol} media`, '', '```', ...rows, '```'].join('\n');
}

export function boardKeyboard(token: string, counts: Readonly<Record<MediaFolder, number>>): Button[][] {
  const b = (folder: MediaFolder): Button => ({
    text: `${folderName(folder)} ${counts[folder]}`,
    callback_data: cb(token, `t:${folder}`),
  });
  return [
    [b(TIERS[0].folder), b(TIERS[1].folder)],
    [b(TIERS[2].folder), b(TIERS[3].folder)],
    // dca and treasury are not tiers — they share a row BELOW the size ladder, so the board reads
    // as "four tiers, plus two category pools" and never as "six tiers".
    [b(DCA_FOLDER), b(TREASURY_FOLDER)],
  ];
}

/**
 * The gallery caption. The counter is ALWAYS the caption — it is the only thing telling a
 * curator where they are in a set they are paging through blind.
 */
export function galleryCaption(tier: MediaFolder, index: number, total: number): string {
  const name = folderName(tier);
  return total === 0 ? `${name} — 0/0. No memes yet.` : `${name} — ${index + 1}/${total}`;
}

export function galleryKeyboard(token: string, total: number): Button[][] {
  const rows: Button[][] = [];

  // No paging buttons on an empty tier: a ◀ that does nothing is worse than no ◀.
  if (total > 0) {
    rows.push([
      { text: '◀', callback_data: cb(token, 'prev') },
      { text: '▶', callback_data: cb(token, 'next') },
    ]);
  }

  const actions: Button[] = [{ text: '➕ Add', callback_data: cb(token, 'add') }];
  if (total > 0) actions.push({ text: '🗑 Remove', callback_data: cb(token, 'rm') });
  rows.push(actions);

  rows.push([{ text: '⬅ Tiers', callback_data: cb(token, 'board') }]);
  return rows;
}

/**
 * The removal confirmation.
 *
 * It says the website out loud. A curator deleting a meme from a chat window is thinking
 * about the bot; they are not thinking about the carousel on 1grainofrice.com, which reads
 * the same manifest and will drop it on the next poll. Surprising someone with a change to
 * a public website is not something to do quietly.
 */
export function removeConfirm(tier: MediaFolder, index: number, total: number): string {
  return [
    `Remove this meme from ${folderName(tier)}? (${index + 1}/${total})`,
    '',
    'It stops appearing in buy cards immediately, in every group.',
    '**This also removes it from the website carousel.**',
    '',
    "_The file isn't deleted — it moves to the archive, and an operator can put it back._",
  ].join('\n');
}

export function removeKeyboard(token: string): Button[][] {
  return [
    [
      { text: '✅ Yes, remove', callback_data: cb(token, 'rm!') },
      { text: 'Cancel', callback_data: cb(token, 'gallery') },
    ],
  ];
}

/** Offered when a forwarded meme is already in the pool, in a different tier. */
export function moveKeyboard(token: string, to: MediaFolder, from: MediaFolder): Button[][] {
  return [
    [
      { text: `Move to ${folderName(to)}`, callback_data: cb(token, `mv:${to}`) },
      { text: `Keep in ${folderName(from)}`, callback_data: cb(token, 'keep') },
    ],
  ];
}

export function moveText(to: MediaFolder, from: MediaFolder): string {
  return (
    `That meme is already in **${folderName(from)}**.\n\n` +
    `A meme lives in exactly one folder — if it were in two, it would come up twice as often and you'd never work out why.`
  );
}

export const EXPIRED = 'This board expired. Send /media again.';

/** The one-line confirmation a batch-forwarding curator sees, 20 times in a row. */
export function addedLine(tier: MediaFolder, count: number): string {
  return `✅ Added to ${folderName(tier)} — ${count}/${count}`;
}

export function tooBig(bytes: number): string {
  const mb = (bytes / 1024 / 1024).toFixed(0);
  return (
    `That's ${mb}MB — Telegram only lets me download 20MB, even though I can SEND 50MB.\n\n` +
    'Drop it on the box with `tier` instead.'
  );
}

/** The gallery view's current item, or null on an empty tier. */
export function itemAt(items: readonly MediaItem[], index: number): MediaItem | null {
  if (items.length === 0) return null;
  return items[((index % items.length) + items.length) % items.length] ?? null;
}

/** ◀ / ▶ wrap around. A curator at the end of Whale should not hit a wall. */
export function step(index: number, total: number, by: number): number {
  if (total === 0) return 0;
  return ((index + by) % total + total) % total;
}
