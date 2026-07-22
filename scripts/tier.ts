#!/usr/bin/env node
/**
 * `tier` — the BULK curation path for the media pool. Phase 5a.
 *
 * Nobody forwards fifty memes to a bot one at a time. This is how the pool is
 * seeded:
 *
 *   tier massive foo.gif            # from the drop zone, _incoming/<mint>/
 *   tier massive ./gifs/*           # a batch, from anywhere
 *   tier archive <sha256>.gif       # a removal
 *
 * The DM flow (Phase 8.5) is for ONGOING curation. This is for the first fifty.
 *
 * FILES ARE RENAMED TO THEIR CONTENT HASH on the way in — `foo.gif` lands as
 * `<sha256>.gif`. That is what lets nginx serve the pool with a one-year
 * immutable cache: a URL can never come to mean different bytes. The name it
 * arrived with is kept in the manifest as `label`, for humans only.
 *
 * Every run ends by regenerating manifest.json, so the pool and the manifest can
 * never disagree because someone forgot a second command.
 *
 * REMOVALS ARE NEVER UNLINKED. `archive` moves the file to `<mint>/_archive/`,
 * which the manifest excludes and nginx denies. An admin who deletes a meme from
 * a DM by mistake is one `tier massive _archive/foo.gif` away from having it
 * back; an admin who deletes it with `rm` is not.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  ARCHIVE_DIR,
  contentName,
  locateInTiers,
  PoolError,
  sha256File,
  TIER_DIRS,
  type Tier,
} from '../src/media/pool.ts';
import { DEFAULT_MINT, DEFAULT_ROOT, generate } from './build-manifest.ts';

/** `archive` is a DESTINATION, not a fifth tier. The tiers are fixed at four. */
type Destination = Tier | 'archive';

const DESTINATIONS: readonly string[] = [...TIER_DIRS, 'archive'];

/** Files land readable by the group (nginx) and writable only by the owner (the bot). */
const FILE_MODE = 0o640;

function isDestination(v: string): v is Destination {
  return DESTINATIONS.includes(v);
}

function destDir(root: string, mint: string, dest: Destination): string {
  return path.join(root, mint, dest === 'archive' ? ARCHIVE_DIR : dest);
}

async function isFile(p: string): Promise<boolean> {
  const st = await fs.stat(p).catch(() => null);
  return st?.isFile() ?? false;
}

/**
 * Find the file the operator meant.
 *
 * A bare name resolves against the drop zone — `tier massive foo.gif` is the
 * documented path and must not require typing the full _incoming path. A path
 * that exists as given wins, so globs (`./gifs/*`) and absolute paths work.
 * Tier folders are searched too, which is what makes `tier archive foo.gif` and
 * re-tiering (`tier whale regular/foo.gif`) work.
 */
async function resolveSource(root: string, mint: string, arg: string): Promise<string> {
  const candidates = [
    path.resolve(arg),
    path.join(root, '_incoming', mint, arg),
    path.join(root, mint, arg),
    ...TIER_DIRS.map((t) => path.join(root, mint, t, arg)),
    path.join(root, mint, ARCHIVE_DIR, arg),
  ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new PoolError(
    `not found: ${arg}\n` +
      `  Looked in the drop zone (${path.join(root, '_incoming', mint)}), the tier folders, and as a literal path.`,
  );
}

/** Nothing this tool does may touch a byte outside MEDIA_ROOT. Belt and braces around a glob typo. */
function assertInsideRoot(root: string, file: string): void {
  const rootResolved = path.resolve(root);
  const fileResolved = path.resolve(file);
  if (fileResolved !== rootResolved && !fileResolved.startsWith(rootResolved + path.sep)) {
    throw new PoolError(`refusing to write outside MEDIA_ROOT: ${fileResolved}`);
  }
}

/**
 * Move one file into place, RENAMED TO ITS CONTENT HASH.
 *
 * The rename is the point of this whole function. nginx serves tier files
 * `immutable, max-age=1y`, so a client that fetches a URL will not ask again for
 * a year — which is only safe if a URL can never mean different bytes. Keeping
 * the operator's filename breaks exactly that: `tier massive foo.gif` today and a
 * DIFFERENT foo.gif next month would serve the old meme to every cached client
 * until 2027. `<sha256>.<ext>` makes it impossible: different bytes, different URL.
 *
 * It also collapses two problems into one. Identity and filename now converge, so
 * "is this already in the pool?" is a stat, and the cross-tier duplicate check
 * below falls out for free.
 *
 * WHY THIS COPIES INSTEAD OF RENAMING, even within one filesystem.
 *
 * The tier folders are setgid (`2750 ricebuybot:www-data`) so that nginx can read
 * anything the bot puts there. But setgid only sets the group of a file that is
 * CREATED in the directory — a file RENAMED into it keeps the group it already
 * had. `_incoming` is `ricebuybot:ricebuybot`, so a renamed meme lands as
 * `ricebuybot:ricebuybot 0640`: unreadable by www-data, and the site serves an
 * error for a file that is plainly sitting right there on disk.
 *
 * That bug is invisible from the bot's side — the bot reads the pool as its owner
 * and sees nothing wrong. It only shows up in a browser. (It is also why
 * manifest.json worked while the memes did not: the generator CREATES the manifest
 * in the tier root, so setgid applied to it.)
 *
 * Creating the file in the destination directory makes the group correct by
 * construction, with no chgrp and therefore no privileges. Copy to a temp file in
 * the DESTINATION directory, fsync, then rename within that same directory — which
 * is atomic — and unlink the source. The meme never appears at its final path
 * half-written, so the manifest run can never hash a partial file.
 */
async function placeFile(source: string, dir: string, name: string): Promise<string> {
  const dest = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true, mode: 0o2750 });

  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);

  // STREAM the bytes into a file we CREATE. Not `fs.copyFile`, and not `fs.rename`:
  // neither of them inherits the destination directory's setgid group.
  //
  //   rename    keeps the source's group (it moves an inode, it does not make one)
  //   copyFile  keeps the source's group too — libuv clones the source's metadata
  //   open(…w)  CREATES an inode in the directory, so setgid applies. This one.
  //
  // Verified, not assumed: test/media-pool.test.ts builds a real setgid directory
  // and asserts the group of what comes out. The first two both fail it.
  await pipeline(createReadStream(source), createWriteStream(tmp, { mode: FILE_MODE }));

  const handle = await fs.open(tmp, 'r+');
  try {
    await handle.sync(); // the bytes are on disk before anything can see the name
  } finally {
    await handle.close();
  }

  await fs.rename(tmp, dest); // same directory: atomic
  await fs.rm(source, { force: true });

  return dest;
}

interface Placement {
  readonly dest: string;
  readonly sha256: string;
  readonly label: string;
  readonly skipped: boolean;
  /** Set when this was a relocation out of another tier, for the summary line. */
  readonly movedFrom?: Tier;
}

/**
 * Decide what to do with one file, then do it.
 *
 * THE DUPLICATE POLICY LIVES HERE, and it rests entirely on `locateInTiers` —
 * the single shared implementation, which Phase 8.5's DM flow will use to ask the
 * same question when an admin forwards a meme the pool has already seen.
 *
 * A meme lives in exactly ONE tier. Content is identity (the file_id cache is keyed
 * by sha256, invariant 3), so the same bytes in two tiers is one item with two tiers
 * and no rule can choose between them that is not a guess. The generator hard-errors
 * on it; this refuses to create it in the first place, where the operator is standing
 * and can act.
 *
 * But refusing is not enough on its own — RELOCATION MUST BE POSSIBLE. The old code
 * refused and then told the operator to run `tier whale <sha>.gif`, which collided
 * with the file against ITSELF and failed too. The advice was a lie and a meme could
 * never change tier. `--move` is the explicit, non-guessable way to say "yes, move it".
 */
async function place(
  root: string,
  mint: string,
  source: string,
  dest: Destination,
  move: boolean,
): Promise<Placement> {
  const label = path.basename(source);
  const ext = path.extname(source).toLowerCase();
  const sha256 = await sha256File(source);
  const name = contentName(sha256, ext);
  const dir = destDir(root, mint, dest);

  // Archiving is a REMOVAL, not a duplicate: the file is supposed to already be in a tier, and
  // taking it out is the whole point. No --move ceremony for it.
  if (dest === 'archive') {
    const archived = path.join(dir, name);

    // THE BYTES MAY ALREADY BE IN _archive AND STILL LIVE IN A TIER.
    //
    // That happens whenever something archived a COPY rather than moving the original (an
    // interrupted run, a restore, an operator with cp). The old code saw the destination file,
    // said "already present" and returned — leaving the live copy sitting in its tier folder,
    // still in rotation, still on the website. It reported success and removed nothing.
    //
    // Archiving is defined by what leaves the TIER, not by what arrives in _archive. So if the
    // bytes are already safe, we still take the live copy out.
    if (await isFile(archived)) {
      if (path.resolve(source) !== path.resolve(archived)) {
        await fs.rm(source, { force: true });
        return { dest: archived, sha256, label, skipped: false };
      }
      return { dest: archived, sha256, label, skipped: true }; // it really was only in _archive
    }

    return { dest: await placeFile(source, dir, name), sha256, label, skipped: false };
  }

  const existing = await locateInTiers(root, mint, name);

  // Already exactly where it is being sent. Not an error: re-running
  // `tier massive ./gifs/*` after adding one file must no-op on the other forty-nine.
  if (existing?.tier === dest) {
    // The operator handed us a second copy of something already in the pool. Drop
    // the copy — but only if it is NOT the pool's own file we just found.
    if (path.resolve(source) !== path.resolve(existing.path)) await fs.rm(source, { force: true });
    return { dest: existing.path, sha256, label, skipped: true };
  }

  if (existing && !move) {
    throw new PoolError(
      `already in the pool, in a DIFFERENT tier:\n` +
        `    ${existing.path}\n` +
        `    (tier: ${existing.tier})\n\n` +
        `  ${label} is byte-identical to it, and a meme lives in exactly one tier.\n` +
        `  To MOVE it from ${existing.tier} to ${dest}:\n\n` +
        `      tier ${dest} ${name} --move\n`,
    );
  }

  if (existing && move) {
    // Relocate the file ALREADY IN THE POOL — not the source the operator named,
    // which may be an unrelated second copy sitting in the drop zone. Placing the
    // pool's own file also unlinks it from the old tier, which is the move.
    const placed = await placeFile(existing.path, dir, name);
    if (path.resolve(source) !== path.resolve(existing.path)) await fs.rm(source, { force: true });
    return { dest: placed, sha256, label, skipped: false, movedFrom: existing.tier };
  }

  return { dest: await placeFile(source, dir, name), sha256, label, skipped: false };
}

function usage(): never {
  process.stdout.write(
    'usage: tier <regular|big|whale|massive|archive> <file...> [--move] [--root DIR] [--mint MINT] [--dry-run]\n\n' +
      '  tier massive foo.gif             move foo.gif from _incoming/<mint>/ into massive/\n' +
      '  tier massive ./gifs/*            bulk-seed a tier from anywhere\n' +
      '  tier whale <sha256>.gif --move   RE-TIER a meme already in the pool\n' +
      '  tier archive <sha256>.gif        retire a meme (moved to _archive/, never deleted)\n\n' +
      'A meme lives in exactly ONE tier. Adding content the pool already holds is\n' +
      'refused unless you pass --move, which relocates it and names where it came from.\n\n' +
      'Files are renamed to <sha256>.<ext> on the way in; the original name is kept\n' +
      'in the manifest as `label`. Regenerates manifest.json when done.\n',
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') usage();

  let root = DEFAULT_ROOT;
  let mint = DEFAULT_MINT;
  let dryRun = false;
  let move = false;
  const files: string[] = [];
  let dest: Destination | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--root') root = argv[++i] ?? '';
    else if (arg === '--mint') mint = argv[++i] ?? '';
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--move') move = true;
    else if (dest === null) {
      if (!isDestination(arg)) {
        throw new PoolError(
          `unknown destination: ${arg}\n  The four tiers are fixed: ${TIER_DIRS.join(', ')}. Plus 'archive'.`,
        );
      }
      dest = arg;
    } else files.push(arg);
  }

  if (dest === null) usage();
  if (files.length === 0) throw new PoolError('no files given');

  const dir = destDir(root, mint, dest);
  assertInsideRoot(root, dir);

  let moved = 0;
  let already = 0;
  // The name a meme arrived with survives ONLY here — the file on disk is now a
  // hash. Hand it to the generator so `label` makes it into the manifest.
  const labels = new Map<string, string>();

  for (const arg of files) {
    const source = await resolveSource(root, mint, arg);
    if (dryRun) {
      const sha = await sha256File(source);
      process.stdout.write(`  → ${path.basename(source)} -> ${dest}/${sha}${path.extname(source).toLowerCase()}\n`);
      continue;
    }
    const result = await place(root, mint, source, dest, move);
    assertInsideRoot(root, result.dest);
    labels.set(result.sha256, result.label);
    if (result.skipped) {
      process.stdout.write(`  = ${result.label} already in ${dest} (identical bytes)\n`);
      already++;
    } else if (result.movedFrom) {
      process.stdout.write(`  ↻ ${path.basename(result.dest)}: ${result.movedFrom} -> ${dest}\n`);
      moved++;
    } else {
      process.stdout.write(`  → ${result.label} -> ${dest}/${path.basename(result.dest)}\n`);
      moved++;
    }
  }

  if (dryRun) {
    process.stdout.write('\ndry run — nothing moved, manifest untouched\n');
    return;
  }

  const { manifest, warnings } = await generate({
    root,
    mint,
    labels,
    warn: (m) => process.stderr.write(`WARN  ${m}\n`),
  });
  const counts = TIER_DIRS.map((t) => `${t} ${manifest.tiers[t]}`).join('  ');
  process.stdout.write(
    `\n${moved} moved, ${already} already present. ` +
      `manifest.json: ${manifest.count} items — ${counts}` +
      `${warnings.length > 0 ? ` (${warnings.length} warned)` : ''}\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof PoolError ? err.message : ((err as Error).stack ?? String(err));
  process.stderr.write(`\nERROR ${msg}\n`);
  process.exit(1);
});
