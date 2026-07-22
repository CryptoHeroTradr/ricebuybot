import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.js';
import { FsMediaPool, LocalFsSource } from '../src/media/index.js';
import { addMedia, moveMedia, removeMedia, DOWNLOAD_LIMIT_BYTES, type CurateDeps } from '../src/media/curate.js';
import { curatableMints, resolveCurator } from '../src/telegram/curate/auth.js';
import { CurationSessions, cb, parseCb, BOARD_TTL_MS } from '../src/telegram/curate/session.js';
import * as view from '../src/telegram/curate/view.js';
import { createLogger } from '../src/ops/logger.js';
import type { Api } from 'grammy';
import type { ChatId, Mint } from '../src/core/types.js';

const log = createLogger('silent' as 'info', false);
const RICE = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Mint;
const GROUP_RICE = -1001 as ChatId;
const GROUP_BONK = -1002 as ChatId;

const ADMIN_USER = 111;
const OTHER_ADMIN = 222;
const STRANGER = 999;

/** Real 1x1 media — the manifest generator runs ffprobe on whatever we write. */
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const GIF2 = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A Bot API that says who is an admin where. Counts calls, so "never cached" is testable. */
function fakeApi(admins: Record<number, ChatId[]>, calls = { n: 0 }): Api {
  return {
    getChatMember: async (chatId: number, userId: number) => {
      calls.n++;
      const isAdmin = (admins[userId] ?? []).includes(chatId as ChatId);
      return { status: isAdmin ? 'administrator' : 'member' } as never;
    },
  } as unknown as Api;
}

let dir: string;
let root: string;
let repo: SqliteRepo;
let pool: FsMediaPool;
let curate: CurateDeps;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-curate-'));
  root = join(dir, 'media');
  for (const mint of [RICE, BONK]) {
    for (const t of ['regular', 'big', 'whale', 'massive', '_archive']) {
      mkdirSync(join(root, mint, t), { recursive: true });
    }
  }

  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();

  await repo.upsertChat({ chatId: GROUP_RICE, title: 'rice', addedBy: ADMIN_USER, paused: false });
  await repo.upsertChat({ chatId: GROUP_BONK, title: 'bonk', addedBy: OTHER_ADMIN, paused: false });
  await repo.addChatToken(GROUP_RICE, RICE);
  await repo.addChatToken(GROUP_BONK, BONK);

  // PRODUCTION WIRING, deliberately: index.ts passes `mints: () => repo.activeMints()`.
  //
  // This used to be a hardcoded `async () => [RICE, BONK]`, and that is precisely what hid a
  // live bug. Curation is allowed on mints `activeMints()` does not return (a paused group,
  // the owner's bootstrap), and against a hardcoded list those mints reconcile fine — so the
  // suite was green while every one of them failed in the curator's DM. A fixture that
  // answers a question production never asks cannot see production's answer.
  pool = new FsMediaPool({
    repo,
    source: new LocalFsSource(root),
    log,
    mints: () => repo.activeMints(),
    pollMs: 1e9,
  });
  curate = { repo, pool, root, log };
});

afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (mint: Mint, tier: 'regular' | 'big' | 'whale' | 'massive', bytes: Buffer, ext = '.gif', fileId = 'FID') =>
  addMedia(curate, mint, tier, bytes, ext, ext === '.png' ? 'photo' : 'animation', fileId);

// =============================================================================
// AUTHORIZATION — the whole security boundary
// =============================================================================

describe('authorization: a stranger DMing the bot gets NOTHING', () => {
  it('a user who administers no configured group can curate nothing', async () => {
    const api = fakeApi({ [ADMIN_USER]: [GROUP_RICE] });
    const who = await resolveCurator({ repo, api }, STRANGER);

    expect(who.kind).toBe('none');
    expect(await curatableMints({ repo, api }, STRANGER)).toEqual([]);
  });

  it('an admin of the $RICE group may curate $RICE — and ONLY $RICE', async () => {
    const api = fakeApi({ [ADMIN_USER]: [GROUP_RICE], [OTHER_ADMIN]: [GROUP_BONK] });

    expect(await curatableMints({ repo, api }, ADMIN_USER)).toEqual([RICE]);
    expect(await curatableMints({ repo, api }, OTHER_ADMIN)).toEqual([BONK]);
  });

  /**
   * INVARIANT 8, in the DM flow. A cache here would let a freshly-demoted admin keep putting
   * memes on the card of the group that just removed them.
   */
  it('re-asks Telegram EVERY time — it is never cached', async () => {
    const calls = { n: 0 };
    const api = fakeApi({ [ADMIN_USER]: [GROUP_RICE] }, calls);

    await curatableMints({ repo, api }, ADMIN_USER);
    const first = calls.n;
    expect(first).toBeGreaterThan(0);

    await curatableMints({ repo, api }, ADMIN_USER);
    expect(calls.n).toBeGreaterThan(first);
  });

  it('losing admin means losing curation, immediately', async () => {
    const live: Record<number, ChatId[]> = { [ADMIN_USER]: [GROUP_RICE] };
    const api = fakeApi(live);
    expect(await curatableMints({ repo, api }, ADMIN_USER)).toEqual([RICE]);

    live[ADMIN_USER] = []; // demoted
    expect(await curatableMints({ repo, api }, ADMIN_USER)).toEqual([]);
  });

  it('skips the picker for one mint, and asks when there are several', async () => {
    const api = fakeApi({ [ADMIN_USER]: [GROUP_RICE, GROUP_BONK] });
    await repo.addChatToken(GROUP_BONK, BONK);

    expect((await resolveCurator({ repo, api }, ADMIN_USER)).kind).toBe('many');
    expect((await resolveCurator({ repo, api: fakeApi({ [OTHER_ADMIN]: [GROUP_BONK] }) }, OTHER_ADMIN)).kind).toBe('one');
  });

  it('the owner may curate everything, even before any group exists', async () => {
    const api = fakeApi({});
    const mints = await curatableMints({ repo, api, ownerUserId: 42 }, 42);
    expect([...mints].sort()).toEqual([RICE, BONK].sort());
  });

  it('an explicit grant works without Telegram admin', async () => {
    await repo.addCurator(STRANGER, RICE, ADMIN_USER);
    const api = fakeApi({});
    expect(await curatableMints({ repo, api }, STRANGER)).toEqual([RICE]);
  });
});

// =============================================================================
// THE 64-BYTE CALLBACK WALL
// =============================================================================

describe('callback_data stays under Telegram’s 64-byte cap', () => {
  it('never carries the mint — a mint alone is 44 chars', () => {
    const s = new CurationSessions();
    const board = s.openBoard(ADMIN_USER, RICE);

    for (const verb of ['board', 't:massive', 'prev', 'next', 'add', 'rm', 'rm!', 'mv:whale', 'keep']) {
      const data = cb(board.token, verb);
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
      expect(data).not.toContain(RICE); // the whole reason the session exists
      expect(parseCb(data)).toEqual({ token: board.token, verb });
    }

    // For contrast: packing the mint in would have blown the budget.
    expect(Buffer.byteLength(`gallery:${RICE}:massive:12`, 'utf8')).toBeGreaterThan(60);
  });

  it('a board belongs to ONE user — a leaked token is not a key', () => {
    const s = new CurationSessions();
    const board = s.openBoard(ADMIN_USER, RICE);

    expect(s.board(board.token, ADMIN_USER)).not.toBeNull();
    expect(s.board(board.token, STRANGER)).toBeNull(); // someone else's screenshot
  });

  it('a board older than 15 minutes expires rather than acting on a changed pool', () => {
    let now = 1_000;
    const s = new CurationSessions(() => now);
    const board = s.openBoard(ADMIN_USER, RICE);

    now += BOARD_TTL_MS - 1;
    expect(s.board(board.token, ADMIN_USER)).not.toBe('expired');

    now += 2;
    expect(s.board(board.token, ADMIN_USER)).toBe('expired');
  });
});

// =============================================================================
// ADD
// =============================================================================

describe('adding memes', () => {
  it('writes <sha256>.<ext>, stores the file_id, and needs NO vault upload', async () => {
    const r = await add(RICE, 'whale', GIF, '.gif', 'FILEID_1');
    expect(r.kind).toBe('added');

    const name = `${sha(GIF)}.gif`;
    expect(existsSync(join(root, RICE, 'whale', name))).toBe(true);

    // The file_id Telegram minted when the curator sent it IS ours — file_ids are per-bot.
    // So it is cached at curation time and this meme is never uploaded to the vault.
    expect(await repo.getFileId(sha(GIF))).toBe('FILEID_1');

    const items = await repo.listMedia(RICE, 'whale');
    expect(items.map((i) => i.sha256)).toEqual([sha(GIF)]);
  });

  it('appears in the manifest, so the website sees it too', async () => {
    await add(RICE, 'whale', GIF);
    const manifest = JSON.parse(readFileSync(join(root, RICE, 'manifest.json'), 'utf8')) as {
      items: { sha256: string; tier: string }[];
    };
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]).toMatchObject({ sha256: sha(GIF), tier: 'whale' });
  });

  it('the SAME meme twice is a duplicate, not a second copy', async () => {
    await add(RICE, 'whale', GIF);
    const second = await add(RICE, 'whale', GIF);

    expect(second.kind).toBe('duplicate-here');
    expect(await repo.listMedia(RICE, 'whale')).toHaveLength(1);
    expect(readdirSync(join(root, RICE, 'whale')).filter((f) => !f.startsWith('.'))).toHaveLength(1);
  });

  /**
   * The same meme in two tiers would double its odds in rotation and the curator would never
   * work out why it kept coming up.
   */
  it('a meme already in another tier is OFFERED A MOVE, not silently duplicated', async () => {
    await add(RICE, 'big', GIF);
    const result = await add(RICE, 'whale', GIF);

    expect(result).toMatchObject({ kind: 'duplicate-elsewhere', tier: 'big' });
    expect(await repo.listMedia(RICE, 'whale')).toHaveLength(0); // NOT added
  });

  it('after a move it exists in exactly ONE tier', async () => {
    await add(RICE, 'big', GIF);
    await moveMedia(curate, RICE, sha(GIF), 'whale');

    expect(await repo.listMedia(RICE, 'big')).toHaveLength(0);
    expect((await repo.listMedia(RICE, 'whale')).map((i) => i.sha256)).toEqual([sha(GIF)]);
    expect(existsSync(join(root, RICE, 'big', `${sha(GIF)}.gif`))).toBe(false);
    expect(existsSync(join(root, RICE, 'whale', `${sha(GIF)}.gif`))).toBe(true);
  });

  it('rejects a 25MB video with the size AND the reason', () => {
    const size = 25 * 1024 * 1024;
    expect(size).toBeGreaterThan(DOWNLOAD_LIMIT_BYTES);

    const msg = view.tooBig(size);
    expect(msg).toContain('25MB'); // the number
    expect(msg).toContain('only lets me download 20MB'); // the reason
    expect(msg).toContain('tier'); // what to do instead
  });
});

// =============================================================================
// REMOVE
// =============================================================================

describe('removing a meme', () => {
  it('leaves every rotation bag immediately, lands in _archive, and is NOT unlinked', async () => {
    await add(RICE, 'whale', GIF);
    await add(RICE, 'whale', PNG, '.png');
    await pool.refresh();

    // It is in rotation before.
    expect((await repo.listMedia(RICE, 'whale')).map((i) => i.sha256)).toContain(sha(GIF));

    await removeMedia(curate, RICE, sha(GIF));

    // 1. out of rotation, in EVERY group, immediately
    const live = await repo.listMedia(RICE, 'whale');
    expect(live.map((i) => i.sha256)).not.toContain(sha(GIF));
    expect(live).toHaveLength(1);

    // 2. gone from the manifest — so the website drops it too
    const manifest = JSON.parse(readFileSync(join(root, RICE, 'manifest.json'), 'utf8')) as {
      items: { sha256: string }[];
    };
    expect(manifest.items.map((i) => i.sha256)).not.toContain(sha(GIF));

    // 3. the bytes still exist. NEVER unlinked — a 🗑 in a chat window is exactly where a
    //    mistake gets made, and an operator can put it back.
    expect(existsSync(join(root, RICE, 'whale', `${sha(GIF)}.gif`))).toBe(false);
    expect(existsSync(join(root, RICE, '_archive', `${sha(GIF)}.gif`))).toBe(true);
  });

  it('never comes out of a bag again, even though its file_id still works', async () => {
    await add(RICE, 'whale', GIF, '.gif', 'STILL_VALID');
    await add(RICE, 'whale', PNG, '.png', 'OTHER');
    await removeMedia(curate, RICE, sha(GIF));

    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = await pool.pick(RICE, GROUP_RICE, 20, 20);
      if (p?.item) seen.add(p.item.sha256);
    }
    expect(seen.has(sha(GIF))).toBe(false);

    // "we CAN still send it" must never quietly become "we DO send it".
    expect(await repo.getFileId(sha(GIF))).toBe('STILL_VALID');
  });

  it('removing the LAST item leaves the empty view, not a crash', async () => {
    await add(RICE, 'massive', GIF);
    await removeMedia(curate, RICE, sha(GIF));

    const items = await repo.listMedia(RICE, 'massive');
    expect(items).toHaveLength(0);
    expect(view.itemAt(items, 0)).toBeNull();
    expect(view.galleryCaption('massive', 0, 0)).toBe('Massive — 0/0. No memes yet.');
    expect(view.galleryKeyboard('tok', 0).flat().map((b) => b.text)).toEqual(['➕ Add', '⬅ Tiers']); // no ◀ ▶, no 🗑
  });

  it('the confirmation says the website out loud', () => {
    // A curator deleting from a chat window is thinking about the bot, not about the
    // carousel on 1grainofrice.com that reads the same manifest.
    expect(view.removeConfirm('whale', 0, 3)).toContain('website carousel');
    expect(view.removeConfirm('whale', 0, 3)).toContain("isn't deleted");
  });
});

// =============================================================================
// THE GALLERY
// =============================================================================

describe('the gallery', () => {
  it('counts 1/3, 2/3, 3/3 and WRAPS', async () => {
    for (const [b, e] of [
      [GIF, '.gif'],
      [PNG, '.png'],
      [GIF2, '.gif'],
    ] as const) {
      await add(RICE, 'whale', b as Buffer, e);
    }
    const items = await repo.listMedia(RICE, 'whale');
    expect(items).toHaveLength(3);

    expect(view.galleryCaption('whale', 0, 3)).toBe('Whale — 1/3');
    expect(view.galleryCaption('whale', 2, 3)).toBe('Whale — 3/3');

    // ▶ from the last wraps to the first; ◀ from the first wraps to the last.
    expect(view.step(2, 3, 1)).toBe(0);
    expect(view.step(0, 3, -1)).toBe(2);
  });

  it('flags a thin tier — under 5 means visible repetition', () => {
    const text = view.boardText('RICE', { regular: 48, big: 22, whale: 9, massive: 3 });
    expect(text).toContain('Massive     3   ⚠️ tier is thin');
    expect(text).not.toContain('Regular   48   ⚠️');
  });

  it('flags an empty tier too', () => {
    expect(view.boardText('RICE', { regular: 5, big: 5, whale: 5, massive: 0 })).toContain('⚠️ empty');
  });
});

// =============================================================================
// TWO CURATORS, TWO POOLS
// =============================================================================

describe('two curators for two mints', () => {
  it('see only their own pool', async () => {
    await add(RICE, 'whale', GIF);
    await add(BONK, 'whale', PNG, '.png');

    const api = fakeApi({ [ADMIN_USER]: [GROUP_RICE], [OTHER_ADMIN]: [GROUP_BONK] });

    expect(await curatableMints({ repo, api }, ADMIN_USER)).toEqual([RICE]);
    expect(await curatableMints({ repo, api }, OTHER_ADMIN)).toEqual([BONK]);

    expect((await repo.listMedia(RICE, 'whale')).map((i) => i.sha256)).toEqual([sha(GIF)]);
    expect((await repo.listMedia(BONK, 'whale')).map((i) => i.sha256)).toEqual([sha(PNG)]);
  });
});

// =============================================================================
// LIVE WITHOUT A RESTART
// =============================================================================

describe('a curated meme is live in the next buy card', () => {
  it('no restart, and no vault upload', async () => {
    await repo.putToken({
      mint: RICE,
      symbol: 'RICE',
      name: 'Rice',
      decimals: 6,
      supplyRaw: 1_000_000_000_000n,
      fetchedAtMs: 1,
    });

    // Empty pool: a whale buy would post text-only.
    expect(await pool.stats(RICE)).toMatchObject({ whale: 0 });

    await add(RICE, 'whale', GIF, '.gif', 'CURATED_FILE_ID');

    // Same process, no restart: the pick returns it, and its file_id is already cached — so
    // fileIdFor does NOT need an uploader (there isn't one on this pool).
    const picked = await pool.pick(RICE, GROUP_RICE, 20, 50_000);
    expect(picked?.earnedTier).toBe('Whale');
    expect(picked?.item?.sha256).toBe(sha(GIF));
    expect(await pool.fileIdFor(picked!.item!)).toBe('CURATED_FILE_ID');
  });
});

// =============================================================================
// CURATION ON A MINT THAT IS NOT "ACTIVE"
//
// `auth.ts` deliberately lets a curator work on a mint `repo.activeMints()` does not
// return — a paused group has not stopped owning its art, and the owner has to be able to
// seed a pool before any group is configured at all (the bootstrap case).
//
// The write path has to hold up on exactly those mints. It did not: `regenerate()` called
// `pool.refresh()`, which iterates ACTIVE mints, so it reconciled nothing, no `media_items`
// row appeared, and `putFileId` — whose sha256 REFERENCES `media_items(sha256)` — died on a
// raw `FOREIGN KEY constraint failed`. That threw out of the message handler, so the curator
// forwarded a meme and got "Something went wrong on my end" while the bytes sat safely on
// disk. The board still said 0/0, so it read as "the bot ignored me".
// =============================================================================

describe('a curator may add media to a mint that is not active', () => {
  it('PAUSED group: its admins still curate it', async () => {
    await repo.upsertChat({ chatId: GROUP_RICE, title: 'rice', addedBy: ADMIN_USER, paused: true });
    expect(await repo.activeMints()).not.toContain(RICE);

    const result = await add(RICE, 'big', GIF);

    expect(result.kind).toBe('added');
    expect((await repo.listMedia(RICE, 'big')).map((i) => i.sha256)).toEqual([sha(GIF)]);
    // The file_id Telegram already minted is cached — the whole point of curating in a DM.
    expect(await repo.getFileId(sha(GIF))).toBe('FID');
  });

  it('OWNER bootstrap: no group configured for the mint at all', async () => {
    const FRESH = 'So11111111111111111111111111111111111111112' as Mint;
    mkdirSync(join(root, FRESH, 'massive'), { recursive: true });
    expect(await repo.activeMints()).not.toContain(FRESH);

    const result = await addMedia(curate, FRESH, 'massive', GIF, '.gif', 'animation', 'FID');

    expect(result.kind).toBe('added');
    expect((await repo.listMedia(FRESH, 'massive')).map((i) => i.sha256)).toEqual([sha(GIF)]);
  });

  /**
   * The count in "✅ Added to Big — n/n" is read straight off the DB, so a mint that failed to
   * reconcile would have told the curator 0 about a meme it had just accepted.
   */
  it('reports a truthful count back to the curator', async () => {
    await repo.upsertChat({ chatId: GROUP_RICE, title: 'rice', addedBy: ADMIN_USER, paused: true });

    const result = await add(RICE, 'big', GIF);
    expect(result).toMatchObject({ kind: 'added', count: 1 });
  });
});

// =============================================================================
// THE FILE_ID CACHE IS AN OPTIMISATION, NOT THE MEME
// =============================================================================

describe('an item the manifest refuses to publish', () => {
  /**
   * The generator SKIPS a file ffprobe cannot read, and `generate()` is allowed to fail
   * outright (its try/catch says so). Either way no `media_items` row appears — and the
   * file_id write has a foreign key onto that row.
   *
   * A missing file_id costs ONE upload on first send. Throwing costs the curator their meme
   * and blames it on a bug they cannot see. So: skip, warn, keep the bytes.
   */
  it('does not take the whole add down with a FOREIGN KEY error', async () => {
    const NOT_MEDIA = Buffer.from('this is not a gif and ffprobe will not have it');

    const result = await addMedia(curate, RICE, 'big', NOT_MEDIA, '.gif', 'animation', 'FID');

    expect(result.kind).toBe('added');
    // The bytes are on disk, which is what makes the next manifest run able to recover it.
    expect(existsSync(join(root, RICE, 'big', `${sha(NOT_MEDIA)}.gif`))).toBe(true);
    // Uncacheable for now — it will upload once on first send.
    expect(await repo.getFileId(sha(NOT_MEDIA))).toBeNull();
  });
});
