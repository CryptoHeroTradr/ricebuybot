import { execFile, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildManifest, generate } from '../scripts/build-manifest.ts';
import { PoolError, TIER_DIRS, type Manifest } from '../src/media/pool.ts';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';

/** Real 1x1 media. ffprobe must be able to parse these, so they cannot be fabricated garbage. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** The pool is content-addressed, so a fixture's NAME is a function of its bytes. */
function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The name a meme must have to be publishable: `<sha256>.<ext>`. */
function addressed(bytes: Buffer, ext: string): string {
  return `${sha(bytes)}${ext}`;
}

let root: string;

async function put(tier: string, name: string, bytes: Buffer): Promise<string> {
  const dir = path.join(root, MINT, tier);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  return file;
}

async function build(): Promise<Manifest> {
  return (await buildManifest({ root, mint: MINT })).manifest;
}

/** Run a script exactly as an operator would: a real process, real argv, real exit code. */
async function runScript(script: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [path.join(REPO, 'scripts', script), ...args], {
      cwd: REPO,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ricepool-'));
  for (const tier of TIER_DIRS) await mkdir(path.join(root, MINT, tier), { recursive: true });
  await mkdir(path.join(root, '_incoming', MINT), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * These are INTEGRATION tests and they have a legitimately different time budget
 * from a unit test: `runScript` spawns a real `node` process per call, and
 * `buildManifest` spawns an `ffprobe` per media file — some tests do both, twice.
 * Measured on a loaded single-core box, one test ranged from 332ms to 3702ms, and
 * 4 of 6 runs blew the 5s default.
 *
 * Scoped to the describes below ON PURPOSE, rather than raised in vitest.config.ts.
 * A global 30s would make a genuinely hung UNIT test take 30s to fail everywhere,
 * and fast failure is worth keeping where nothing is being spawned.
 */
const SUBPROCESS_TIMEOUT_MS = 30_000;

/**
 * ffprobe is a hard dependency of the generator, and its absence is INVISIBLE:
 * with no ffprobe, every file is skipped with a warning and the manifest comes
 * out empty — at which point "an unchanged pool is byte-identical" and "items
 * are sorted by sha256" both pass, vacuously, over an empty array.
 *
 * So assert it exists, loudly, before anything else runs. `apt install ffmpeg`.
 */
describe('preconditions', () => {
  it('ffprobe is installed — without it every assertion below goes vacuous', async () => {
    await expect(execFileAsync('ffprobe', ['-version'])).resolves.toBeTruthy();
  });
}, { timeout: SUBPROCESS_TIMEOUT_MS });

describe('the four tiers', () => {
  it('ERRORS on an unexpected folder rather than silently ignoring it', async () => {
    await mkdir(path.join(root, MINT, 'epic'), { recursive: true });
    await expect(build()).rejects.toThrow(PoolError);
    await expect(build()).rejects.toThrow(/unexpected folder .*epic/);
  });

  it('the CLI exits non-zero on a stray folder, and writes NO manifest', async () => {
    await put('massive', 'a.gif', GIF_1X1);
    await mkdir(path.join(root, MINT, 'epic'), { recursive: true });

    const { code, stderr } = await runScript('build-manifest.ts', ['--root', root, '--mint', MINT]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unexpected folder/);
    await expect(stat(path.join(root, MINT, 'manifest.json'))).rejects.toThrow();
  });

  it('ERRORS on a folder nested inside a tier — nesting hides memes from the rotation', async () => {
    await mkdir(path.join(root, MINT, 'massive', 'best'), { recursive: true });
    await expect(build()).rejects.toThrow(/Tier folders are FLAT/);
  });
}, { timeout: SUBPROCESS_TIMEOUT_MS });

describe('manifest', () => {
  it('records sha256, tier, kind and dimensions for a new file', async () => {
    await put('massive', addressed(GIF_1X1, '.gif'), GIF_1X1);
    const manifest = await build();

    expect(manifest.count).toBe(1);
    const item = manifest.items[0]!;
    expect(item.tier).toBe('massive');
    expect(item.sha256).toBe(sha(GIF_1X1));
    // The URL IS the hash. This is the line the immutable cache rests on.
    expect(item.rel_path).toBe(`${MINT}/massive/${sha(GIF_1X1)}.gif`);
    expect(item.kind).toBe('animation');
    expect(item.width).toBe(1);
    expect(item.height).toBe(1);
    expect(item.bytes).toBe(GIF_1X1.length);
    expect(manifest.tiers).toEqual({ regular: 0, big: 0, whale: 0, massive: 1 });
  });

  it('classifies photos and animations by extension', async () => {
    await put('regular', addressed(PNG_1X1, '.png'), PNG_1X1);
    await put('regular', addressed(GIF_1X1, '.gif'), GIF_1X1);
    const manifest = await build();

    const kinds = Object.fromEntries(manifest.items.map((i) => [i.sha256, i.kind]));
    expect(kinds).toEqual({ [sha(PNG_1X1)]: 'photo', [sha(GIF_1X1)]: 'animation' });
  });

  it('is byte-identical when the pool has not changed', async () => {
    await put('regular', addressed(PNG_1X1, '.png'), PNG_1X1);
    await put('whale', addressed(GIF_1X1, '.gif'), GIF_1X1);

    const first = await generate({ root, mint: MINT });
    const second = await generate({ root, mint: MINT });

    expect(first.manifest.count).toBe(2); // an empty manifest is byte-identical for free
    expect(second.json).toBe(first.json);
    expect(await readFile(path.join(root, MINT, 'manifest.json'), 'utf8')).toBe(first.json);
  });

  it('sorts by sha256, so file order on disk cannot change the output', async () => {
    await put('regular', addressed(PNG_1X1, '.png'), PNG_1X1);
    await put('massive', addressed(GIF_1X1, '.gif'), GIF_1X1);
    const manifest = await build();

    const shas = manifest.items.map((i) => i.sha256);
    expect(shas).toHaveLength(2); // an empty list is sorted for free
    expect(shas).toEqual([...shas].sort());
  });

  it('leaves no temp file behind — clients never see a half-written manifest', async () => {
    await put('big', addressed(GIF_1X1, '.gif'), GIF_1X1);
    const { manifest } = await generate({ root, mint: MINT });
    expect(manifest.count).toBe(1);

    const entries = await readdir(path.join(root, MINT));
    expect(entries.filter((e) => e.includes('tmp'))).toEqual([]);
  });

  it('excludes _archive — a retired meme is recoverable, but never posted', async () => {
    await put('_archive', addressed(GIF_1X1, '.gif'), GIF_1X1);
    await put('massive', addressed(PNG_1X1, '.png'), PNG_1X1);

    const manifest = await build();

    expect(manifest.count).toBe(1);
    expect(manifest.items[0]!.rel_path).toBe(`${MINT}/massive/${sha(PNG_1X1)}.png`);
  });

  it('carries added_at forward by CONTENT, so a re-tier is not a re-add', async () => {
    const file = await put('regular', addressed(GIF_1X1, '.gif'), GIF_1X1);
    // PERSIST it: added_at is carried forward from the manifest ON DISK, so a
    // build() that writes nothing has nothing to carry forward from.
    const before = (await generate({ root, mint: MINT })).manifest.items[0]!;

    // Re-tier it: same bytes, new folder, new mtime.
    await mkdir(path.join(root, MINT, 'massive'), { recursive: true });
    await writeFile(path.join(root, MINT, 'massive', addressed(GIF_1X1, '.gif')), GIF_1X1);
    await rm(file);

    const after = (await build()).items[0]!;

    expect(after.sha256).toBe(before.sha256);
    expect(after.tier).toBe('massive');
    expect(after.added_at).toBe(before.added_at);
  });
}, { timeout: SUBPROCESS_TIMEOUT_MS });

describe('skips (warn, never fail the run)', () => {
  it('skips a photo over Telegram’s 10MB ceiling', async () => {
    await put('regular', 'huge.png', Buffer.alloc(10 * 1024 * 1024 + 1));
    await put('regular', addressed(PNG_1X1, '.png'), PNG_1X1);

    const { manifest, warnings } = await buildManifest({ root, mint: MINT });

    expect(manifest.count).toBe(1);
    expect(warnings.join('\n')).toMatch(/huge\.png.*exceeds/);
  });

  it('skips a file ffprobe cannot parse', async () => {
    await put('regular', 'corrupt.png', Buffer.from('this is not a png'));
    await put('regular', addressed(GIF_1X1, '.gif'), GIF_1X1);

    const { manifest, warnings } = await buildManifest({ root, mint: MINT });

    expect(manifest.count).toBe(1);
    expect(warnings.join('\n')).toMatch(/corrupt\.png.*ffprobe/);
  });

  it('skips an unsupported extension', async () => {
    await put('regular', 'notes.txt', Buffer.from('hello'));
    const { manifest, warnings } = await buildManifest({ root, mint: MINT });

    expect(manifest.count).toBe(0);
    expect(warnings.join('\n')).toMatch(/notes\.txt.*unsupported/);
  });

  it('skips a file that is not named after its own hash', async () => {
    // The immutable one-year cache is safe ONLY because a URL cannot come to mean
    // different bytes. A file called foo.gif can. So it is never published.
    await put('regular', 'foo.gif', GIF_1X1);

    const { manifest, warnings } = await buildManifest({ root, mint: MINT });

    expect(manifest.count).toBe(0);
    expect(warnings.join('\n')).toMatch(/not content-addressed/);
  });

  it('skips a content-addressed file whose bytes no longer match its name', async () => {
    // Someone replaced the bytes under a hash filename. That is the exact attack
    // the immutable cache cannot survive, so it must never reach the manifest.
    await put('massive', `${sha(GIF_1X1)}.gif`, PNG_1X1);

    const { manifest, warnings } = await buildManifest({ root, mint: MINT });

    expect(manifest.count).toBe(0);
    expect(warnings.join('\n')).toMatch(/not content-addressed/);
  });
}, { timeout: SUBPROCESS_TIMEOUT_MS });

describe('the same meme in two tiers', () => {
  it('is a HARD ERROR naming both paths — no rule can pick a tier that is not a guess', async () => {
    await put('regular', `${sha(GIF_1X1)}.gif`, GIF_1X1);
    await put('massive', `${sha(GIF_1X1)}.gif`, GIF_1X1);

    await expect(build()).rejects.toThrow(PoolError);
    await expect(build()).rejects.toThrow(/same content is in two tiers/);
    // Both paths, so a human can act without going and looking.
    await expect(build()).rejects.toThrow(/regular/);
    await expect(build()).rejects.toThrow(/massive/);
  });

  it('leaves the previous manifest intact — a bad pool does not destroy a good manifest', async () => {
    await put('whale', `${sha(PNG_1X1)}.png`, PNG_1X1);
    const good = (await generate({ root, mint: MINT })).json;

    await put('regular', `${sha(GIF_1X1)}.gif`, GIF_1X1);
    await put('massive', `${sha(GIF_1X1)}.gif`, GIF_1X1);
    await expect(generate({ root, mint: MINT })).rejects.toThrow(PoolError);

    expect(await readFile(path.join(root, MINT, 'manifest.json'), 'utf8')).toBe(good);
  });

  it('re-tiering with --move relocates the meme and leaves ONE copy', async () => {
    const name = addressed(GIF_1X1, '.gif');
    await put('massive', name, GIF_1X1);

    const { code, stdout } = await runScript('tier.ts', ['whale', name, '--move', '--root', root, '--mint', MINT]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/massive -> whale/);
    await expect(stat(path.join(root, MINT, 'whale', name))).resolves.toBeTruthy();
    await expect(stat(path.join(root, MINT, 'massive', name))).rejects.toThrow();

    const manifest = await build();
    expect(manifest.count).toBe(1);
    expect(manifest.items[0]!.tier).toBe('whale');
  });

  /**
   * REGRESSION. The refusal used to tell the operator to run `tier whale <sha>.gif`
   * to relocate — and that command collided the file with ITSELF and failed too. The
   * tool's own advice did not work, and a meme could never change tier. Whatever the
   * error message says to do must actually do it.
   */
  it('the command the refusal SUGGESTS actually works', async () => {
    const name = addressed(GIF_1X1, '.gif');
    await put('big', name, GIF_1X1);
    await writeFile(path.join(root, '_incoming', MINT, 'dupe.gif'), GIF_1X1);

    const refused = await runScript('tier.ts', ['whale', 'dupe.gif', '--root', root, '--mint', MINT]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/tier: big/);

    // Lift the suggested command straight out of the error text and run it verbatim.
    const suggested = /\n\s+(tier .+)\n/.exec(refused.stderr)?.[1];
    expect(suggested).toBeDefined();
    const argv = suggested!.split(/\s+/).slice(1); // drop the leading "tier"

    const { code } = await runScript('tier.ts', [...argv, '--root', root, '--mint', MINT]);

    expect(code).toBe(0);
    await expect(stat(path.join(root, MINT, 'whale', name))).resolves.toBeTruthy();
    await expect(stat(path.join(root, MINT, 'big', name))).rejects.toThrow();
  });

  it('--move drops the duplicate the operator handed over, keeping the pool at one copy', async () => {
    const name = addressed(GIF_1X1, '.gif');
    await put('big', name, GIF_1X1);
    const incoming = path.join(root, '_incoming', MINT, 'dupe.gif');
    await writeFile(incoming, GIF_1X1);

    const { code } = await runScript('tier.ts', ['whale', 'dupe.gif', '--move', '--root', root, '--mint', MINT]);

    expect(code).toBe(0);
    await expect(stat(path.join(root, MINT, 'whale', name))).resolves.toBeTruthy();
    await expect(stat(path.join(root, MINT, 'big', name))).rejects.toThrow();
    await expect(stat(incoming)).rejects.toThrow(); // the drop-zone copy is gone too
    expect((await build()).count).toBe(1);
  });

  it('archiving needs no --move — a removal is not a duplicate', async () => {
    const name = addressed(GIF_1X1, '.gif');
    await put('whale', name, GIF_1X1);

    const { code } = await runScript('tier.ts', ['archive', name, '--root', root, '--mint', MINT]);

    expect(code).toBe(0);
    await expect(stat(path.join(root, MINT, '_archive', name))).resolves.toBeTruthy();
    expect((await build()).count).toBe(0);
  });

  it('tier.ts REFUSES to create one in the first place', async () => {
    await put('massive', `${sha(GIF_1X1)}.gif`, GIF_1X1);
    const incoming = path.join(root, '_incoming', MINT, 'same-meme-different-name.gif');
    await writeFile(incoming, GIF_1X1);

    const { code, stderr } = await runScript('tier.ts', [
      'regular',
      'same-meme-different-name.gif',
      '--root',
      root,
      '--mint',
      MINT,
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/already in the pool, in a DIFFERENT tier/i);
    // The pool is still generatable — the refusal happened BEFORE the move.
    await expect(build()).resolves.toBeTruthy();
  });
}, { timeout: SUBPROCESS_TIMEOUT_MS });

describe('tier CLI', () => {
  it('moves, CONTENT-ADDRESSES, and regenerates the manifest, in one command', async () => {
    const incoming = path.join(root, '_incoming', MINT, 'seed.gif');
    await writeFile(incoming, GIF_1X1);

    const { code, stdout } = await runScript('tier.ts', ['massive', 'seed.gif', '--root', root, '--mint', MINT]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/seed\.gif -> massive/);

    // The file moved out of the drop zone...
    await expect(stat(incoming)).rejects.toThrow();
    // ...and landed under its HASH, not the name it arrived with. The original
    // name must NOT be a URL: it could be reused for different bytes tomorrow,
    // and nginx serves this path immutable for a year.
    await expect(stat(path.join(root, MINT, 'massive', 'seed.gif'))).rejects.toThrow();
    await expect(stat(path.join(root, MINT, 'massive', addressed(GIF_1X1, '.gif')))).resolves.toBeTruthy();

    // ...and the manifest on disk already knows about it. No second command.
    const manifest = JSON.parse(await readFile(path.join(root, MINT, 'manifest.json'), 'utf8')) as Manifest;
    expect(manifest.count).toBe(1);
    expect(manifest.items[0]!.tier).toBe('massive');
    expect(manifest.items[0]!.rel_path).toBe(`${MINT}/massive/${sha(GIF_1X1)}.gif`);
    // The human name survives as a label — a hint, never an identity.
    expect(manifest.items[0]!.label).toBe('seed.gif');
  });

  it('keeps the label across a later regeneration it knows nothing about', async () => {
    const incoming = path.join(root, '_incoming', MINT, 'seed.gif');
    await writeFile(incoming, GIF_1X1);
    await runScript('tier.ts', ['massive', 'seed.gif', '--root', root, '--mint', MINT]);

    // The 5-minute timer runs build-manifest.ts with no idea what the file was called.
    const { code } = await runScript('build-manifest.ts', ['--root', root, '--mint', MINT]);

    expect(code).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(root, MINT, 'manifest.json'), 'utf8')) as Manifest;
    expect(manifest.items[0]!.label).toBe('seed.gif');
  });

  it('takes a batch of paths, which is how the first fifty memes get seeded', async () => {
    const dir = path.join(root, 'batch');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'one.gif'), GIF_1X1);
    await writeFile(path.join(dir, 'two.png'), PNG_1X1);

    const { code } = await runScript('tier.ts', [
      'whale',
      path.join(dir, 'one.gif'),
      path.join(dir, 'two.png'),
      '--root',
      root,
      '--mint',
      MINT,
    ]);

    expect(code).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(root, MINT, 'manifest.json'), 'utf8')) as Manifest;
    expect(manifest.count).toBe(2);
    expect(manifest.items.every((i) => i.tier === 'whale')).toBe(true);
  });

  it('archives a meme instead of unlinking it — it stays recoverable on the box', async () => {
    const name = addressed(GIF_1X1, '.gif');
    await put('massive', name, GIF_1X1);

    const { code } = await runScript('tier.ts', ['archive', name, '--root', root, '--mint', MINT]);

    expect(code).toBe(0);
    // The bytes still exist...
    await expect(stat(path.join(root, MINT, '_archive', name))).resolves.toBeTruthy();
    // ...but they are out of rotation.
    const manifest = JSON.parse(await readFile(path.join(root, MINT, 'manifest.json'), 'utf8')) as Manifest;
    expect(manifest.count).toBe(0);
  });

  /**
   * REGRESSION. The tier folders are setgid (2750 ricebuybot:www-data) so nginx can
   * read what the bot puts there. setgid sets the group of a file CREATED in the
   * directory — a file RENAMED into it keeps its old group. tier.ts used to rename,
   * so memes landed group-owned by the bot and nginx could not read them: the site
   * served an error for a file sitting right there on disk, while manifest.json (which
   * the generator CREATES in place, so setgid applied) worked fine and hid the problem.
   *
   * This is invisible to every test that only reads the pool as its owner, which is why
   * it survived the whole of Phase 5a. It is caught here by giving the destination a
   * real setgid bit and a group the source does NOT have, then asserting the file came
   * out with the DIRECTORY's group.
   */
  it('a moved file inherits the TIER FOLDER’s group, not the source’s — nginx must be able to read it', async () => {
    const secondary = execSync('id -Gn').toString().trim().split(/\s+/).find((g) => g !== process.env.USER);
    if (!secondary) return; // single-group environment: nothing to prove against

    const tierDir = path.join(root, MINT, 'massive');
    await mkdir(tierDir, { recursive: true });
    execSync(`chgrp ${secondary} ${tierDir} && chmod 2750 ${tierDir}`);
    const wantGid = (await stat(tierDir)).gid;

    // The source sits in a directory with the DEFAULT group — the one a rename
    // would have carried across.
    const incoming = path.join(root, '_incoming', MINT, 'seed.gif');
    await writeFile(incoming, GIF_1X1);
    expect((await stat(incoming)).gid).not.toBe(wantGid);

    const { code } = await runScript('tier.ts', ['massive', 'seed.gif', '--root', root, '--mint', MINT]);
    expect(code).toBe(0);

    const landed = await stat(path.join(tierDir, addressed(GIF_1X1, '.gif')));
    expect(landed.gid).toBe(wantGid);
    // ...and group-readable, or the group ownership bought nothing.
    expect(landed.mode & 0o040).toBe(0o040);
  });

  /**
   * REGRESSION (found in production). The bytes were already in _archive (an interrupted run had
   * archived a COPY), so `tier archive` said "already present" and returned — leaving the live
   * copy in its tier folder, still in rotation, still on the website. It reported success and
   * removed nothing.
   *
   * Archiving is defined by what leaves the TIER, not by what arrives in _archive.
   */
  it('archives the LIVE copy even when identical bytes are already in _archive', async () => {
    const name = addressed(GIF_1X1, '.gif');
    await put('whale', name, GIF_1X1);
    await put('_archive', name, GIF_1X1); // an earlier run archived a copy, not the original

    const { code } = await runScript('tier.ts', ['archive', name, '--root', root, '--mint', MINT]);

    expect(code).toBe(0);
    await expect(stat(path.join(root, MINT, 'whale', name))).rejects.toThrow(); // OUT of rotation
    await expect(stat(path.join(root, MINT, '_archive', name))).resolves.toBeTruthy(); // still kept
    expect((await build()).count).toBe(0);
  });

  it('rejects a fifth tier', async () => {
    const { code, stderr } = await runScript('tier.ts', ['epic', 'x.gif', '--root', root, '--mint', MINT]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown destination: epic/);
  });
}, { timeout: SUBPROCESS_TIMEOUT_MS });
