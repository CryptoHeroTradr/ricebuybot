/**
 * Media pool PRIMITIVES. Pure, plus the filesystem. Nothing else.
 *
 * WHAT THIS MODULE MAY DEPEND ON: `node:fs`, `node:crypto`, `node:path`, and
 * `core/tiers`. That is the whole list, and it is the point.
 *
 * The property being protected was never "the pool tooling imports nothing from
 * src/" — it is that **the pool has no runtime dependency on the bot's DB, config
 * or network**, so `scripts/build-manifest.ts` runs from a systemd timer whether or
 * not the bot is installed, built, configured or running. A hashing function and a
 * few `stat` calls do not violate that; an import of `config/` or `db/` would.
 *
 * So: no `config/` (no env), no `db/`, no network, no logger, no grammY. If you find
 * yourself adding one, you are in the wrong file — the caller wants
 * `scripts/build-manifest.ts` or `src/media/`.
 *
 * Both sides consume this ONE definition of what a pool is:
 *
 *   scripts/build-manifest.ts   the standalone generator (systemd, no build step)
 *   scripts/tier.ts             the bulk curation CLI
 *   src/telegram/…              Phase 8.5's DM curation flow — it needs locateInTiers
 *                               to say "already in Big — move it to Whale?"
 *
 * NOTE THE `.ts` IMPORT BELOW, and do not "fix" it to `.js`. The scripts are executed
 * directly by Node's type stripping (`node scripts/build-manifest.ts`), and Node does
 * NOT resolve a `.js` specifier to a `.ts` file on disk — it throws. `tsc` rewrites
 * the extension back to `.js` on emit (`rewriteRelativeImportExtensions`), so the
 * compiled bot is unaffected. One spelling that satisfies both runtimes.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { TIER_FOLDERS, type TierFolder } from '../core/tiers.ts';

/**
 * The four tiers, as pool folder names.
 *
 * Re-exported from `core/tiers.ts` — the single source of truth (see CLAUDE.md).
 * This used to be a hand-copied duplicate here, policed by a test that asserted the
 * two lists matched. The duplicate is gone, so the test is too: there is nothing left
 * for it to catch.
 */
export const TIER_DIRS: readonly TierFolder[] = TIER_FOLDERS;
export type Tier = TierFolder;

/** Holds removals. Never served, never in the manifest, never unlinked. */
export const ARCHIVE_DIR = '_archive';

export const MANIFEST_NAME = 'manifest.json';

/** A pool that is malformed rather than merely empty. Fatal: we refuse to write a manifest. */
export class PoolError extends Error {}

export type MediaKind = 'photo' | 'animation' | 'video';

export interface ManifestItem {
  /** Lowercase hex sha256 of the file bytes. The item's identity, and the file_id cache key. */
  readonly sha256: string;
  readonly tier: Tier;
  /** Path relative to MEDIA_ROOT, e.g. `<mint>/massive/<sha256>.gif`. THE FILENAME IS THE HASH. */
  readonly rel_path: string;
  /** The human name the file arrived with. A HINT, not identity. Nothing may key on it. */
  readonly label?: string;
  readonly kind: MediaKind;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** Present for animation/video only. */
  readonly duration_ms?: number;
  /** When this CONTENT first appeared in the pool, ms since epoch. Carried forward by sha256. */
  readonly added_at: number;
}

export interface Manifest {
  readonly version: 1;
  readonly mint: string;
  readonly count: number;
  readonly tiers: Readonly<Record<Tier, number>>;
  readonly items: readonly ManifestItem[];
}

/** Lowercase hex sha256 of a file's bytes. Streamed: a meme can be 50MB. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * The name a piece of content MUST have in the pool: `<sha256>.<ext>`.
 *
 * This is what makes the one-year immutable cache safe. nginx serves tier files
 * `max-age=31536000, immutable`, so a client that fetches a URL will not ask again
 * for a year — which is only sound if a URL can never come to mean different bytes.
 * Content-addressing makes that impossible by construction: different bytes, different
 * name, different URL.
 *
 * `ext` is taken from the original filename and lower-cased; it carries the leading dot.
 */
export function contentName(sha256: string, ext: string): string {
  return `${sha256}${ext.toLowerCase()}`;
}

/** Where a given piece of content already lives. */
export interface PoolLocation {
  readonly tier: Tier;
  /** Absolute path of the file already in the pool. */
  readonly path: string;
}

/**
 * Is this content already in the pool, and if so, in which tier?
 *
 * THE ONE IMPLEMENTATION, deliberately. `tier.ts` uses it to refuse a duplicate (or,
 * with --move, to relocate one); Phase 8.5's DM flow needs the identical question to
 * answer "this is already in Big — move it to Whale?" when an admin forwards a meme
 * the pool has already seen. Two implementations would drift, and the failure mode is
 * a meme living in two tiers at once — which the generator then refuses to publish, so
 * one bad answer here takes down the whole manifest.
 *
 * It is a stat across four directories, NOT a walk-and-hash. That is a direct dividend
 * of content-addressing the filenames: the file we are looking for can only have one
 * possible name, so we ask the filesystem for it by name.
 *
 * `name` is the content-addressed filename — build it with `contentName()`.
 */
export async function locateInTiers(root: string, mint: string, name: string): Promise<PoolLocation | null> {
  for (const tier of TIER_DIRS) {
    const candidate = path.join(root, mint, tier, name);
    const st = await fs.stat(candidate).catch(() => null);
    if (st?.isFile()) return { tier, path: candidate };
  }
  return null;
}

/** $RICE. The flagship, and the only pool that exists today. */
export const DEFAULT_MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
export const DEFAULT_MEDIA_ROOT = '/srv/media';
