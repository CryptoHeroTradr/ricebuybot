import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

import type { Logger } from 'pino';

import type { MediaKind, Mint } from '../core/types.js';
import type { TierFolder } from '../core/tiers.js';
import type { Repo } from '../db/index.js';
import { generate } from '../../scripts/build-manifest.ts';
import { ARCHIVE_DIR, contentName, locateInTiers } from './pool.ts';
import type { MediaPool } from './index.js';

/**
 * THE WRITE SIDE OF THE POOL. Phase 8.5.
 *
 * INVARIANT 4: the bot owns the tree and is its sole writer — and this is the only file in
 * `src/` that writes to it. `MediaPool` remains read-only and must never grow a write
 * method: reading and writing the pool are different jobs with different failure modes,
 * and a `pick()` that could also delete is a `pick()` nobody can reason about.
 *
 * IT REUSES THE ONE MANIFEST GENERATOR (`scripts/build-manifest.ts`). It does not write a
 * manifest of its own. A second writer would be a second definition of what a pool is, and
 * the two would drift — the same failure the second parser and the second tier list both
 * were. The generator is pure + fs, so importing it costs nothing.
 */

const FILE_MODE = 0o640;

/**
 * THE MODE FOR A POOL DIRECTORY — AND NOTE WHAT IS *NOT* IN IT: the setgid bit.
 *
 * The pool depends on setgid dirs (INVARIANT 4): a tier folder is `2750
 * ricebuybot:www-data`, and setgid is what makes a file the bot creates inside it land in
 * group www-data so nginx can read it. So it is tempting to write `0o2750` here, and this
 * code did. **The bot is not allowed to set that bit, and must not ask.**
 *
 * `ricebuybot.service` sets `RestrictSUIDSGID=yes`, which seccomp-filters any mkdir/chmod/
 * open carrying S_ISUID or S_ISGID and fails it with **EPERM** — and it does so even when
 * the directory ALREADY EXISTS, because Node's recursive mkdir returns EPERM straight out
 * rather than falling through to its "already there, fine" stat. So `mkdir(0o2750)` did not
 * degrade on the happy path; it threw on EVERY curation write, on a tree that was already
 * perfectly provisioned.
 *
 * The bit does not need setting. **The kernel inherits it**: a directory created inside a
 * setgid parent gets the parent's group AND its setgid bit, for free, no privilege required.
 * `setup-media-pool.sh` sets `2750` on MEDIA_ROOT and on the mint folder precisely so this
 * propagates, and 0o750 inside them still comes out 0o2750.
 *
 * So the hardening and the pool layout were never actually in conflict — the code was just
 * asking for something it already had. Do not "restore" the 2 here to make the intent
 * legible: it reads as intent and behaves as an outage.
 */
export const DIR_MODE = 0o750;

/** getFile downloads cap at 20MB, even though SENDS allow 50MB. Telegram is not symmetric. */
export const DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export interface CurateDeps {
  readonly repo: Repo;
  readonly pool: MediaPool;
  readonly root: string;
  readonly log: Logger;
}

export type AddResult =
  | { readonly kind: 'added'; readonly sha256: string; readonly count: number }
  | { readonly kind: 'duplicate-here'; readonly sha256: string; readonly tier: TierFolder }
  /** Already in the pool, in ANOTHER tier. The caller offers a move; it does not decide. */
  | { readonly kind: 'duplicate-elsewhere'; readonly sha256: string; readonly tier: TierFolder };

/**
 * Write bytes into a tier, content-addressed, and make the change LIVE.
 *
 * The file is CREATED in the destination directory and never renamed into it. That is not
 * a style choice: the tier folders are setgid so nginx can read what the bot writes, and
 * setgid only applies to a file CREATED in the directory — `rename` (and `copyFile`, which
 * clones the source's metadata) carry the old group across, and the meme lands unreadable
 * by nginx while looking perfectly fine on disk. That bug cost a full debugging cycle in
 * Phase 5b; see scripts/tier.ts, which learned it the hard way.
 */
export async function addMedia(
  deps: CurateDeps,
  mint: Mint,
  tier: TierFolder,
  bytes: Buffer,
  ext: string,
  kind: MediaKind,
  fileId: string,
): Promise<AddResult> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const name = contentName(sha256, ext);

  // DEDUP ACROSS ALL TIERS, by content.
  //
  // The same meme in two tiers doubles its odds in rotation, and the curator would never
  // work out why that one keeps showing up. It is also ambiguous: one item, two tiers, and
  // no rule can pick between them that is not a guess.
  const existing = await locateInTiers(deps.root, mint, name);
  if (existing) {
    return existing.tier === tier
      ? { kind: 'duplicate-here', sha256, tier: existing.tier }
      : { kind: 'duplicate-elsewhere', sha256, tier: existing.tier };
  }

  const dir = path.join(deps.root, mint, tier);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });

  // Atomic: write a temp file in the DESTINATION directory (so setgid applies), fsync, then
  // rename within that directory. The manifest run can never hash a half-written meme.
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  await pipeline(Readable.from(bytes), createWriteStream(tmp, { mode: FILE_MODE }));

  const handle = await fs.open(tmp, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, path.join(dir, name));

  await regenerate(deps, mint, sha256);

  // The file_id is ALREADY VALID — Telegram minted it when the curator sent us the file, and
  // file_ids are per-bot, so the one we received is ours. Store it now and this meme will
  // NEVER be uploaded to the vault. That is the whole point of curating in a DM: the common
  // path costs zero uploads.
  //
  // BUT `media_file_ids.sha256` REFERENCES `media_items(sha256)`, so this write has a
  // precondition: the manifest must have published the item and the refresh must have landed
  // the row. Both steps above are allowed to fail — a failed `generate()` is caught by
  // design, and the generator legitimately SKIPS a file ffprobe cannot read. So the
  // precondition is checked, never assumed: an unmet one used to surface as a raw
  // `FOREIGN KEY constraint failed` out of the message handler, which the curator saw as
  // "Something went wrong on my end" on a meme that was, in fact, safely on disk.
  //
  // The cache is an OPTIMISATION, not the meme. Skipping it costs one upload on first send;
  // throwing costs the curator their meme and tells them a lie about why.
  if (await isPublished(deps, mint, sha256)) {
    await deps.repo.putFileId(sha256, fileId);
  } else {
    deps.log.warn(
      { mint, tier, sha256 },
      'meme is on disk but not yet in the manifest — file_id not cached, it will upload once on first send',
    );
  }

  const count = (await deps.repo.listMedia(mint, tier)).length;
  deps.log.info({ mint, tier, sha256 }, 'meme curated via DM');
  return { kind: 'added', sha256, count };
}

/**
 * Move a meme from whichever tier holds it into another one. One meme, one tier.
 */
export async function moveMedia(deps: CurateDeps, mint: Mint, sha256: string, to: TierFolder): Promise<boolean> {
  const item = (await deps.repo.listAllMedia(mint)).find((i) => i.sha256 === sha256);
  if (!item) return false;

  const name = path.basename(item.relPath);
  const from = await locateInTiers(deps.root, mint, name);
  if (!from) return false;

  const dir = path.join(deps.root, mint, to);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });

  // Re-CREATE at the destination (setgid again), then unlink the original.
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  await pipeline(Readable.from(await fs.readFile(from.path)), createWriteStream(tmp, { mode: FILE_MODE }));
  await fs.rename(tmp, path.join(dir, name));
  await fs.rm(from.path, { force: true });

  await regenerate(deps, mint, sha256);
  return true;
}

/**
 * Remove a meme. It is ARCHIVED, never unlinked.
 *
 * Two separate things happen, and both are needed:
 *
 *   1. `removed_at` is set FIRST. That is what drops it from every rotation bag, in every
 *      group, immediately — the file_id still works, so "we can still send it" would
 *      otherwise quietly stay "we do send it", and the 🗑 button would be a lie.
 *   2. the bytes move to `_archive/`, which the manifest excludes and nginx denies.
 *
 * Order matters. Flag first, then move: a manifest refresh landing between the two steps
 * sees the file still in its tier folder and upserts it — and if that upsert could clear
 * `removed_at`, the race would RESURRECT a meme an admin had just deleted. It cannot (see
 * SqliteRepo.upsertMediaItem), and this order means it never even gets the chance.
 */
export async function removeMedia(deps: CurateDeps, mint: Mint, sha256: string): Promise<boolean> {
  const item = (await deps.repo.listAllMedia(mint)).find((i) => i.sha256 === sha256);
  if (!item) return false;

  // 1. Out of rotation, everywhere, now.
  await deps.repo.markMediaRemoved([sha256], Date.now());

  // 2. The bytes go to _archive. NEVER unlinked: an admin who deletes the group's best meme
  //    by mistake is one operator command away from having it back. `rm` has no such
  //    affordance, and a 🗑 in a chat window is exactly the place a mistake gets made.
  const name = path.basename(item.relPath);
  const from = await locateInTiers(deps.root, mint, name);
  if (from) {
    const archive = path.join(deps.root, mint, ARCHIVE_DIR);
    await fs.mkdir(archive, { recursive: true, mode: DIR_MODE });
    await pipeline(Readable.from(await fs.readFile(from.path)), createWriteStream(path.join(archive, name), { mode: FILE_MODE }));
    await fs.rm(from.path, { force: true });
  }

  await regenerate(deps, mint, sha256);
  deps.log.info({ mint, sha256 }, 'meme archived via DM');
  return true;
}

/** Has the manifest published this content, and has the row landed? The file_id's precondition. */
async function isPublished(deps: CurateDeps, mint: Mint, sha256: string): Promise<boolean> {
  return (await deps.repo.listAllMedia(mint)).some((i) => i.sha256 === sha256);
}

/**
 * Regenerate the manifest and make the change live in the next buy card.
 *
 * `generate()` writes atomically (temp + rename), and the reconcile lands the DB row — so no
 * restart, and the website carousel picks it up on its next read of a manifest that is
 * served `no-cache` precisely so this is instant.
 *
 * IT RECONCILES THE CURATED MINT BY NAME, and must keep doing so. This used to call
 * `pool.refresh()`, which iterates `activeMints()` — and curation is deliberately allowed on
 * mints that are NOT active: a paused group still owns its art, and the owner seeds a pool
 * before any group exists (see `telegram/curate/auth.ts`). On exactly those mints the
 * refresh reconciled nothing, no `media_items` row appeared, and the meme silently failed to
 * arrive. The mint is right here in the arguments; there is no reason to go looking for it
 * in a list that is answering a different question.
 */
async function regenerate(deps: CurateDeps, mint: Mint, sha256: string): Promise<void> {
  try {
    await generate({ root: deps.root, mint, warn: (m) => deps.log.warn({ mint, sha256 }, m) });
  } catch (err) {
    // The bytes are on disk and the DB row will follow on the next poll; a failed manifest
    // write is recoverable and must not lose the meme the curator just sent.
    deps.log.error({ mint, err: (err as Error).message }, 'manifest regeneration failed after a curation write');
  }
  try {
    await deps.pool.refreshMint(mint);
  } catch (err) {
    // Same reasoning: recoverable, and the meme is already on disk. The caller checks whether
    // the row landed rather than assuming this worked.
    deps.log.error({ mint, err: (err as Error).message }, 'media refresh failed after a curation write');
  }
}
