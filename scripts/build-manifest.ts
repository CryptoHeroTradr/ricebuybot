#!/usr/bin/env node
/**
 * Media pool manifest generator — Phase 5a.
 *
 * STANDALONE BY DESIGN — and note what that does and does not mean.
 *
 * It has NO RUNTIME DEPENDENCY ON THE BOT: no DB, no config/env loader, no network,
 * no npm packages. It runs on the VPS from a systemd timer under the `ricebuybot`
 * user whether or not the bot is installed, built, configured or running. THAT is the
 * property that matters, and it is the one to protect.
 *
 * It does import `src/media/pool.ts` — tier constants, content-addressed naming,
 * locateInTiers, the manifest schema. Those are pure functions over the filesystem, so
 * importing them costs the guarantee above exactly nothing, and it means the pool has
 * ONE definition rather than a copy here and a copy in the bot that drift apart.
 * (Node runs the `.ts` import directly via type stripping; tsc rewrites it to `.js`
 * on emit. Do not "fix" the extension.)
 *
 * It walks the four tier folders under `<root>/<mint>/` and emits one record per
 * media file, then writes `<root>/<mint>/manifest.json` ATOMICALLY (temp +
 * fsync + rename) so a client — the bot, onegrainofrice, RiceDAO — can never
 * read a half-written manifest.
 *
 * Determinism: an unchanged pool produces a BYTE-IDENTICAL manifest. Items are
 * sorted by sha256 and the JSON is stable. There is deliberately no
 * `generated_at` field: a timestamp would make every run differ, which destroys
 * the cheapest possible staleness check (`cmp` the bytes) and would make the
 * 5-minute timer rewrite the file — and bust every HTTP cache — forever, even
 * when nothing changed. Freshness is what HTTP `Last-Modified` is for.
 *
 * Usage:
 *   node scripts/build-manifest.ts [--root DIR] [--mint MINT] [--check] [--quiet]
 *
 *   --check   Do not write. Exit 1 if the manifest on disk differs from what
 *             this pool would produce. For CI and for asserting determinism.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import {
  ARCHIVE_DIR,
  contentName,
  DEFAULT_MEDIA_ROOT,
  DEFAULT_MINT as RICE_MINT,
  MANIFEST_NAME,
  PoolError,
  sha256File,
  TIER_DIRS,
  type Manifest,
  type ManifestItem,
  type MediaKind,
  type Tier,
} from '../src/media/pool.ts';

export {
  ARCHIVE_DIR,
  contentName,
  locateInTiers,
  MANIFEST_NAME,
  PoolError,
  sha256File,
  TIER_DIRS,
  type Manifest,
  type ManifestItem,
  type MediaKind,
  type PoolLocation,
  type Tier,
} from '../src/media/pool.ts';

const execFileAsync = promisify(execFile);

/** The only entries allowed to exist under `<root>/<mint>/`. Anything else is an ERROR. */
const ALLOWED_DIRS: readonly string[] = [...TIER_DIRS, ARCHIVE_DIR];

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MOVING_EXTS = new Set(['.gif', '.mp4', '.webm']);

/** Telegram's upload ceilings. A file over these can never be sent, so it is not pool material. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_MOVING_BYTES = 50 * 1024 * 1024;

export interface BuildOptions {
  readonly root: string;
  readonly mint: string;
  /** Called for every file we decline to include. Skips are always visible. */
  readonly warn?: (msg: string) => void;
  /**
   * sha256 -> human label, for content this run is seeing for the first time.
   * `tier.ts` passes the filename the meme arrived with, because after the move
   * that name exists nowhere else. Existing labels are carried forward without it.
   */
  readonly labels?: ReadonlyMap<string, string>;
}

export interface BuildResult {
  readonly manifest: Manifest;
  readonly json: string;
  readonly warnings: readonly string[];
}

interface Probed {
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | null;
  readonly hasAudio: boolean;
}

/**
 * Dimensions, duration and audio-track presence, straight from ffprobe.
 *
 * Audio is what separates an `animation` from a `video` for Telegram: an .mp4
 * with no audio track is sent as an animation (it autoplays, loops, no player
 * chrome), and the same file with audio must be sent as a video. Guessing from
 * the extension gets this wrong on exactly the files people care about.
 */
async function ffprobe(file: string): Promise<Probed> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const probe = JSON.parse(stdout) as {
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
    format?: { duration?: string };
  };
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video || !video.width || !video.height) throw new Error('no video stream / no dimensions');

  const rawDuration = probe.format?.duration ?? video.duration;
  const seconds = rawDuration === undefined ? NaN : Number.parseFloat(rawDuration);

  return {
    width: video.width,
    height: video.height,
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

/**
 * Did ffprobe FAIL TO RUN, or did it run and RETURN A VERDICT?
 *
 * This is the whole of the environment/file distinction (Phase 5a.1). An empty
 * manifest is a LIE when the tool never ran — the pool may be full — and the TRUTH
 * when it ran and rejected the file. The two must never resolve to the same object,
 * so they must be told apart at the point of failure, not counted after the fact.
 *
 * The shapes are exact, verified against Node's child_process:
 *   - spawn/stdio error  -> STRING errno `code`   (ENOENT, EACCES, EPERM,
 *                           ERR_CHILD_PROCESS_STDIO_MAXBUFFER)   -> tool never ran
 *   - killed by a signal -> `signal` set / `killed === true` (incl. timeout) -> ran, no verdict
 *   - exited non-zero    -> NUMERIC `code`                        -> ran, gave a verdict (FILE)
 *   - our own post-run
 *     validation throw    -> no `code`, no `signal`               -> exited 0, we rejected it (FILE)
 *
 * So: a numeric exit code (or no code at all) is a verdict; anything else is the
 * environment. Default is NOT environment — a bare Error we cannot classify came
 * from a process that ran, so it is a FILE verdict and never wedges the timer.
 */
function isEnvironmentFailure(err: unknown): boolean {
  const e = err as { code?: unknown; signal?: unknown; killed?: unknown };
  if (e.signal != null || e.killed === true) return true; // killed by a signal, or timed out
  if (typeof e.code === 'string') return true; // spawn/stdio errno — the tool never ran
  return false; // numeric exit code, or a plain post-run throw: ffprobe returned a verdict
}

function kindFor(ext: string, hasAudio: boolean): MediaKind | null {
  if (PHOTO_EXTS.has(ext)) return 'photo';
  if (ext === '.gif') return 'animation';
  if (ext === '.mp4' || ext === '.webm') return hasAudio ? 'video' : 'animation';
  return null;
}

/** Read the manifest already on disk. Absent or corrupt -> treat as empty; we are about to replace it. */
async function readExisting(manifestPath: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as Manifest;
    return Array.isArray(parsed.items) ? parsed : null;
  } catch {
    return null;
  }
}

async function listDir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Walk the pool and build the manifest. Pure: writes nothing.
 *
 * THROWS `PoolError` on an unexpected folder. It does not skip it and it does
 * not warn about it. A folder named `epic/` means someone believes there is a
 * fifth tier — and the tiers are a schema constant (`src/core/tiers.ts`), so
 * every meme in it would be silently unreachable forever. Loud beats lossy.
 */
export async function buildManifest(opts: BuildOptions): Promise<BuildResult> {
  const warnings: string[] = [];
  const warn = (msg: string): void => {
    warnings.push(msg);
    opts.warn?.(msg);
  };

  const mintDir = path.join(opts.root, opts.mint);
  const stat = await fs.stat(mintDir).catch(() => null);
  if (!stat?.isDirectory()) throw new PoolError(`pool not found: ${mintDir}`);

  // Guard the mint root BEFORE reading a single file: a stray folder is fatal.
  for (const entry of await listDir(mintDir)) {
    if (entry.isDirectory()) {
      if (!ALLOWED_DIRS.includes(entry.name)) {
        throw new PoolError(
          `unexpected folder ${path.join(mintDir, entry.name)}\n` +
            `  The four tiers are fixed: ${TIER_DIRS.join(', ')} (plus ${ARCHIVE_DIR}).\n` +
            `  Refusing to generate a manifest that silently ignores it — its contents would never be posted.`,
        );
      }
      continue;
    }
    // Loose files at the mint root are not media and are not served. Say so.
    if (entry.name !== MANIFEST_NAME && !entry.name.startsWith('.')) {
      warn(`stray file at pool root, not media: ${path.join(opts.mint, entry.name)}`);
    }
  }

  const existing = await readExisting(path.join(mintDir, MANIFEST_NAME));
  const addedAtBySha = new Map<string, number>();
  const labelBySha = new Map<string, string>();
  for (const item of existing?.items ?? []) {
    if (typeof item.sha256 !== 'string') continue;
    if (Number.isFinite(item.added_at)) addedAtBySha.set(item.sha256, item.added_at);
    if (typeof item.label === 'string') labelBySha.set(item.sha256, item.label);
  }
  for (const [sha, label] of opts.labels ?? []) labelBySha.set(sha, label);

  /** sha256 -> where we first saw it. Populated BEFORE ffprobe, so duplicate detection
   *  does not depend on either copy being probeable. */
  const seenBySha = new Map<string, { rel_path: string; tier: Tier; name: string }>();
  const collected: ManifestItem[] = [];
  /**
   * Skips where the TOOL ITSELF failed — ffprobe missing, unrunnable, killed, timed
   * out. Each is proof we learned nothing about that file. ANY entry here makes the
   * whole run refuse to write, regardless of how many other files got through: a
   * partial environment failure is still an environment failure. FILE-class skips
   * (a verdict was reached) never land here and never throw.
   */
  const environmentFailures: string[] = [];

  for (const tier of TIER_DIRS) {
    const tierDir = path.join(mintDir, tier);

    for (const entry of await listDir(tierDir)) {
      const rel = path.join(opts.mint, tier, entry.name);
      const relPosix = rel.split(path.sep).join('/');

      if (entry.isDirectory()) {
        throw new PoolError(
          `unexpected folder ${path.join(tierDir, entry.name)}\n` +
            `  Tier folders are FLAT. Nesting hides memes from the rotation.`,
        );
      }
      if (entry.name.startsWith('.')) continue;

      const file = path.join(tierDir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      if (!PHOTO_EXTS.has(ext) && !MOVING_EXTS.has(ext)) {
        warn(`skip ${rel}: unsupported extension ${ext || '(none)'}`);
        continue;
      }

      const st = await fs.stat(file);
      const limit = PHOTO_EXTS.has(ext) ? MAX_PHOTO_BYTES : MAX_MOVING_BYTES;
      if (st.size > limit) {
        const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`;
        warn(`skip ${rel}: ${mb(st.size)} exceeds Telegram's ${mb(limit)} ceiling — it could never be sent`);
        continue;
      }

      // ---- CHEAP CHECKS FIRST. Nothing below here spawns a subprocess. ----
      //
      // Both of the next two checks are pure hash/filename comparisons, and both
      // used to sit DOWNSTREAM of the ffprobe spawn. That cost more than time:
      //   - a misnamed `foo.gif` was reported as "ffprobe could not parse it",
      //     which names the wrong defect and sends the curator to the wrong fix;
      //   - the duplicate check, specified as a HARD ERROR, failed OPEN whenever
      //     both copies happened to be skipped by ffprobe first.
      // A check that fails closed by design must not sit behind one that can skip.

      const sha256 = await sha256File(file);

      // THE FILENAME MUST BE THE HASH — this is what makes the immutable cache safe.
      //
      // nginx serves tier files `max-age=31536000, immutable`. A client that has
      // fetched /media/massive/foo.gif will not ask again for a YEAR. If foo.gif
      // can ever mean different bytes, that client is stuck with the old meme and
      // no amount of curation reaches it. Content-addressed names make that
      // impossible by construction: different bytes, different URL.
      //
      // So a file whose name is not its hash is not published — skipped, not fatal,
      // and it never reaches ffprobe. This is a FILE-class skip: we reached a verdict
      // about the file (its name is wrong) with no tool involved. It NEVER throws, not
      // even as the only file in the pool — that is a truthful empty manifest, and one
      // hand-dropped file must never wedge the 5-minute timer (Phase 5a.1).
      const expected = contentName(sha256, ext);
      if (entry.name !== expected) {
        warn(
          `skip ${rel}: not content-addressed (expected ${expected}).\n` +
            `        Its URL is served immutable for a year, so the name MUST be the hash.\n` +
            `        Add it properly:  tier ${tier} ${file}`,
        );
        continue;
      }

      // The same bytes in two tiers is ONE item (identity is the content — it is the
      // file_id cache key, invariant 3) with TWO tiers, and no rule can pick between
      // them that is not a guess. Picking quietly would put a meme in a tier its
      // curator did not choose. So: refuse, name both paths, and let a human decide.
      //
      // tier.ts refuses to create this in the first place, so reaching here means the
      // pool was edited by hand. The manifest on disk is left exactly as it was.
      const prior = seenBySha.get(sha256);
      if (prior) {
        throw new PoolError(
          `the same content is in two tiers:\n` +
            `    ${prior.rel_path}   (${prior.tier})\n` +
            `    ${relPosix}   (${tier})\n` +
            `  One meme, one tier. Archive the one you do not want:\n` +
            `    tier archive ${entry.name}`,
        );
      }
      seenBySha.set(sha256, { rel_path: relPosix, tier, name: entry.name });

      // ---- EXPENSIVE CHECK. Only content-addressed, non-duplicate files get here. ----
      let probed: Probed;
      try {
        probed = await ffprobe(file);
      } catch (err) {
        const detail = (err as Error).message.split('\n')[0];
        if (isEnvironmentFailure(err)) {
          // The tool never returned a verdict. We did NOT learn this file is bad, so
          // dropping it is not a fact — it is a hole. Record it; the run will refuse
          // to write below rather than publish a manifest missing a file that may be
          // perfectly good.
          warn(`skip ${rel}: ffprobe FAILED TO RUN (${detail}) — environment fault, not a bad file`);
          environmentFailures.push(`${rel}: ${detail}`);
        } else {
          // ffprobe ran and rejected it (or produced no usable stream). A verdict.
          warn(`skip ${rel}: ffprobe could not parse it (${detail})`);
        }
        continue;
      }

      const kind = kindFor(ext, probed.hasAudio);
      if (kind === null) {
        warn(`skip ${rel}: unsupported extension ${ext}`);
        continue;
      }

      // Key order here IS the key order in the JSON. Keep it stable.
      collected.push({
        sha256,
        tier,
        rel_path: relPosix,
        ...(labelBySha.has(sha256) ? { label: labelBySha.get(sha256) as string } : {}),
        kind,
        bytes: st.size,
        width: probed.width,
        height: probed.height,
        ...(kind === 'photo' || probed.durationMs === null ? {} : { duration_ms: probed.durationMs }),
        added_at: addedAtBySha.get(sha256) ?? Math.floor(st.mtimeMs),
      });
    }
  }

  /**
   * CORRUPT AND EMPTY MUST NOT PRODUCE THE SAME OBJECT (the Phase 6 rule), enforced on
   * the WRITER — where it does the damage — and decided by the REASON a file was
   * skipped, never by the count.
   *
   * The rule: if the TOOL failed to run on even one file, refuse to write. An ffprobe
   * that is missing, unrunnable, killed or timed out taught us nothing about that file,
   * so any manifest built without it is missing rows it has no basis to omit — a lie
   * about a pool that may be full. That holds whether it failed on all files or on one
   * of fifty; a partial environment failure still corrupts the output silently.
   *
   * Left intact: the previous manifest. A stale manifest serves the right memes; an
   * empty one serves none. On the VPS the alternative is the 5-minute timer quietly
   * blanking every rotation bag and dropping both websites to hardcoded art.
   *
   * What does NOT throw: FILE-class skips (wrong name, over the ceiling, bytes that do
   * not match the name, ffprobe running and rejecting the file). Those are verdicts. A
   * pool that reduces to zero items purely through FILE skips writes a TRUTHFUL empty
   * manifest — including the one-hand-dropped-file case the count-based guard used to
   * throw on, in violation of Phase 5a.1. A genuinely empty pool writes empty, as ever.
   */
  if (environmentFailures.length > 0) {
    throw new PoolError(
      `ffprobe FAILED TO RUN on ${environmentFailures.length} file(s) — a BROKEN ENVIRONMENT, not bad files.\n` +
        `  No manifest was written and the previous one is left intact, because a skip here is\n` +
        `  a hole, not a verdict: these files may be perfectly good and we could not tell.\n` +
        `  The usual cause is a missing or broken ffprobe:  apt install ffmpeg\n` +
        `  Failures:\n` +
        environmentFailures.map((f) => `    - ${f}`).join('\n'),
    );
  }

  const items = collected.sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));

  const tiers = Object.fromEntries(
    TIER_DIRS.map((t) => [t, items.filter((i) => i.tier === t).length]),
  ) as Record<Tier, number>;

  const manifest: Manifest = { version: 1, mint: opts.mint, count: items.length, tiers, items };
  return { manifest, json: `${JSON.stringify(manifest, null, 2)}\n`, warnings };
}

/**
 * Write the manifest atomically: temp file in the SAME directory (so rename is
 * a same-filesystem operation and therefore atomic), fsync, then rename over
 * the old one. A reader either sees the whole previous manifest or the whole
 * new one, never a truncated file and never a missing one.
 */
export async function writeManifest(root: string, mint: string, json: string): Promise<string> {
  const dest = path.join(root, mint, MANIFEST_NAME);
  const tmp = path.join(root, mint, `.${MANIFEST_NAME}.${process.pid}.tmp`);
  const handle = await fs.open(tmp, 'w', 0o640);
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return dest;
}

/** Generate and write in one call. The single entry point for `tier.ts` and the timer. */
export async function generate(opts: BuildOptions): Promise<BuildResult & { path: string }> {
  const result = await buildManifest(opts);
  const dest = await writeManifest(opts.root, opts.mint, result.json);
  return { ...result, path: dest };
}

export const DEFAULT_ROOT = process.env.MEDIA_ROOT ?? DEFAULT_MEDIA_ROOT;
export const DEFAULT_MINT = process.env.DEFAULT_MINT ?? RICE_MINT;

function parseArgs(argv: readonly string[]): { root: string; mint: string; check: boolean; quiet: boolean } {
  let root = DEFAULT_ROOT;
  let mint = DEFAULT_MINT;
  let check = false;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') root = argv[++i] ?? '';
    else if (arg === '--mint') mint = argv[++i] ?? '';
    else if (arg === '--check') check = true;
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: build-manifest.ts [--root DIR] [--mint MINT] [--check] [--quiet]\n' +
          '  --check  do not write; exit 1 if manifest.json is out of date\n',
      );
      process.exit(0);
    } else throw new PoolError(`unknown argument: ${arg}`);
  }
  if (!root || !mint) throw new PoolError('--root and --mint must be non-empty');
  return { root, mint, check, quiet };
}

async function main(): Promise<void> {
  const { root, mint, check, quiet } = parseArgs(process.argv.slice(2));
  const { manifest, json, warnings } = await buildManifest({
    root,
    mint,
    warn: (m) => process.stderr.write(`WARN  ${m}\n`),
  });

  if (check) {
    const current = await fs.readFile(path.join(root, mint, MANIFEST_NAME), 'utf8').catch(() => null);
    if (current !== json) {
      process.stderr.write('manifest.json is OUT OF DATE — run build-manifest.ts\n');
      process.exit(1);
    }
    if (!quiet) process.stdout.write(`manifest.json up to date (${manifest.count} items)\n`);
    return;
  }

  const dest = await writeManifest(root, mint, json);
  if (!quiet) {
    const counts = TIER_DIRS.map((t) => `${t} ${manifest.tiers[t]}`).join('  ');
    process.stdout.write(`${dest}\n  ${manifest.count} items — ${counts}\n`);
    if (warnings.length > 0) process.stdout.write(`  ${warnings.length} skipped or warned (see above)\n`);
  }
}

// Only run when executed directly, not when imported by tier.ts or the tests.
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((err: unknown) => {
    const msg = err instanceof PoolError ? err.message : ((err as Error).stack ?? String(err));
    process.stderr.write(`\nERROR ${msg}\n`);
    process.exit(1);
  });
}
