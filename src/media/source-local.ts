import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

import type { MediaItem, MediaKind, Mint } from '../core/types.js';
import { TIER_FOLDERS, isTierFolder, type TierFolder } from '../core/tiers.js';
import { ARCHIVE_DIR, MANIFEST_NAME, PoolError, type Manifest } from './pool.js';
import type { MediaSource } from './index.js';

/** One entry from the manifest, normalised into the shape the DB stores. */
export interface PoolEntry {
  readonly sha256: string;
  readonly tier: TierFolder;
  readonly relPath: string;
  readonly kind: MediaKind;
  readonly bytes: number;
  readonly addedAt: number;
}

export interface PoolSnapshot {
  readonly mint: Mint;
  readonly entries: readonly PoolEntry[];
}

/**
 * Parse and VALIDATE a manifest. A malformed manifest is an error, not an empty pool.
 *
 * The difference is the whole ballgame. "The manifest is garbage" and "the pool is
 * empty" produce the same object if you shrug at bad entries — and an empty pool makes
 * `refresh()` mark EVERY item missing and empties every rotation bag. A JSON typo would
 * silently wipe the bot's art. So: throw, keep the last good state, and post with the
 * media we already know about.
 */
export function parseManifest(raw: unknown, mint: Mint): PoolSnapshot {
  if (typeof raw !== 'object' || raw === null) throw new PoolError('manifest is not an object');
  const m = raw as Partial<Manifest>;
  if (!Array.isArray(m.items)) throw new PoolError('manifest has no items array');

  const entries: PoolEntry[] = [];
  for (const item of m.items) {
    if (
      typeof item?.sha256 !== 'string' ||
      typeof item.rel_path !== 'string' ||
      typeof item.kind !== 'string' ||
      typeof item.bytes !== 'number' ||
      !isTierFolder(item.tier)
    ) {
      throw new PoolError(`manifest entry is malformed: ${JSON.stringify(item)?.slice(0, 120)}`);
    }
    entries.push({
      sha256: item.sha256,
      tier: item.tier,
      relPath: item.rel_path,
      kind: item.kind as MediaKind,
      bytes: item.bytes,
      addedAt: typeof item.added_at === 'number' ? item.added_at : Date.now(),
    });
  }
  return { mint, entries };
}

/**
 * The DEFAULT source: the pool is a folder on this machine.
 *
 * This is the normal case and the one to use. RiceBuybot runs on the same VPS as the
 * pool, so an upload hands Telegram the actual BYTES — which lifts the ceiling to 50MB.
 * Sending Telegram a URL instead caps every file at 20MB and throws away half the range
 * of what the pool can hold, for no benefit whatsoever.
 *
 * READ-ONLY (invariant 4). This class opens files and never writes one.
 */
export class LocalFsSource implements MediaSource {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async snapshot(mint: Mint): Promise<PoolSnapshot> {
    const file = path.join(this.#root, mint, MANIFEST_NAME);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      throw new PoolError(`cannot read ${file}: ${(err as Error).message}`);
    }
    return parseManifest(JSON.parse(raw), mint);
  }

  /**
   * The bytes, for a first-ever upload. `null` when the file is gone — that is a
   * `missing` item, and missing is survivable: if we already have its file_id we never
   * come here at all.
   */
  async bytes(item: MediaItem): Promise<Buffer | null> {
    try {
      return await readFile(path.join(this.#root, item.relPath));
    } catch {
      return null;
    }
  }

  /**
   * The sha256s in `_archive/`. Filenames are content-addressed, so the name IS the hash — no
   * need to open a single file.
   */
  async archived(mint: Mint): Promise<ReadonlySet<string>> {
    try {
      const names = await readdir(path.join(this.#root, mint, ARCHIVE_DIR));
      return new Set(
        names
          .filter((n) => !n.startsWith('.'))
          .map((n) => n.replace(/\.[^.]+$/, ''))
          .filter((sha) => /^[0-9a-f]{64}$/.test(sha)),
      );
    } catch {
      return new Set(); // no archive folder yet
    }
  }

  /**
   * Files in a tier folder that the manifest does not list.
   *
   * Counting rather than hashing: a file is published iff the generator put it in the
   * manifest, so "on disk but not in the manifest" is exactly the set the generator
   * refused — non-content-addressed names, hash/byte mismatches, oversize, unparseable.
   * Every one of them is invisible to the bot and needs a human.
   */
  async unpublished(mint: Mint): Promise<number | null> {
    let snapshot;
    try {
      snapshot = await this.snapshot(mint);
    } catch {
      return null; // no manifest at all: we cannot say what is missing FROM it
    }
    const published = new Set(snapshot.entries.map((e) => e.relPath.split('/').pop()));

    let orphans = 0;
    for (const tier of TIER_FOLDERS) {
      let names: string[];
      try {
        names = await readdir(path.join(this.#root, mint, tier));
      } catch {
        continue; // tier folder does not exist yet — that is empty, not broken
      }
      for (const n of names) {
        if (n.startsWith('.')) continue; // in-flight temp writes are not orphans
        if (!published.has(n)) orphans++;
      }
    }
    return orphans;
  }
}
