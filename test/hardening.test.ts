import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.js';
import { catchUp, MAX_CATCHUP_AGE_MS, type CatchupRpc } from '../src/ingest/catchup.js';
import { BurstDetector, DailyCap, digestText } from '../src/telegram/digest.js';
import { DeliveryQueue } from '../src/telegram/queue.js';
import { Watchdog } from '../src/ops/watchdog.js';
import { createLogger } from '../src/ops/logger.js';
import { DIR_MODE } from '../src/media/curate.js';
import type { ChatId, Mint, Signature } from '../src/core/types.js';
import type { Outbound, Sender } from '../src/telegram/sender.js';

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const CHAT = -1001 as ChatId;
const sig = (n: number): Signature => `sig${n}`.padEnd(88, 'x') as Signature;

let dir: string;
let dbPath: string;
let repo: SqliteRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-hard-'));
  dbPath = join(dir, 'test.db');
  repo = new SqliteRepo(dbPath, log);
  await repo.init();
  await repo.upsertChat({ chatId: CHAT, title: 'g', addedBy: 1, paused: false });
});

afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

// =============================================================================
// GAP RECOVERY
// =============================================================================

describe('gap recovery', () => {
  const NOW = 1_700_000_000_000;
  const secs = (msAgo: number): number => Math.floor((NOW - msAgo) / 1000);

  const rpc = (sigs: { signature: string; slot: number; blockTime: number | null }[]): CatchupRpc => ({
    getSignaturesForAddress: async (_m, limit) => sigs.slice(0, limit),
    getTransaction: async (signature) => ({ signature, slot: 1 }) as never,
  });

  it('recovers everything after the cursor, OLDEST FIRST', async () => {
    // The RPC returns newest-first. Replaying a burst in reverse would post a wallet's
    // second buy before its first, which the cost-basis fold then has to unpick.
    const r = await catchUp(
      { rpc: rpc([
        { signature: 'c', slot: 300, blockTime: secs(1000) },
        { signature: 'b', slot: 200, blockTime: secs(2000) },
        { signature: 'a', slot: 150, blockTime: secs(3000) },
      ]), log, now: () => NOW },
      MINT,
      100,
      400,
    );

    expect(r.txs.map((t) => (t as { signature: string }).signature)).toEqual(['a', 'b', 'c']);
  });

  it('stops at the cursor — it does not re-walk history we already have', async () => {
    const r = await catchUp(
      { rpc: rpc([
        { signature: 'new', slot: 300, blockTime: secs(1000) },
        { signature: 'old', slot: 50, blockTime: secs(2000) }, // already ours
      ]), log, now: () => NOW },
      MINT,
      100,
      400,
    );

    expect(r.txs).toHaveLength(1);
  });

  /**
   * After a 40-minute outage, dumping every missed buy into the group posts prices that are
   * no longer true, in an order that no longer means anything — and rate-limits the bot on
   * the way. The queue's 120s staleness rule would drop most of them anyway.
   */
  it('does NOT recover buys older than 10 minutes', async () => {
    const r = await catchUp(
      { rpc: rpc([
        { signature: 'fresh', slot: 300, blockTime: secs(60_000) }, // 1 min old
        { signature: 'stale', slot: 250, blockTime: secs(11 * 60_000) }, // 11 min old
      ]), log, now: () => NOW },
      MINT,
      100,
      400,
    );

    expect(r.txs.map((t) => (t as { signature: string }).signature)).toEqual(['fresh']);
    expect(r.skippedTooOld).toBe(1);
    expect(MAX_CATCHUP_AGE_MS).toBe(600_000);
  });

  it('caps the walk, and SAYS it was truncated', async () => {
    const many = Array.from({ length: 900 }, (_, i) => ({
      signature: `s${i}`,
      slot: 1000 - i,
      blockTime: secs(1000),
    }));
    const r = await catchUp({ rpc: rpc(many), log, now: () => NOW, maxSignatures: 500 }, MINT, 0, 2000);

    expect(r.txs).toHaveLength(500);
    expect(r.truncated).toBe(true); // a silently truncated walk is a lie
  });

  it('does nothing when there is no gap', async () => {
    const r = await catchUp({ rpc: rpc([]), log, now: () => NOW }, MINT, 500, 500);
    expect(r.txs).toEqual([]);
  });

  it('one bad fetch does not abandon the rest of the window', async () => {
    const flaky: CatchupRpc = {
      getSignaturesForAddress: async () => [
        { signature: 'good', slot: 300, blockTime: secs(1000) },
        { signature: 'bad', slot: 200, blockTime: secs(1000) },
      ],
      getTransaction: async (s) => {
        if (s === 'bad') throw new Error('rpc 500');
        return { signature: s } as never;
      },
    };
    const r = await catchUp({ rpc: flaky, log, now: () => NOW }, MINT, 100, 400);
    expect(r.txs).toHaveLength(1);
  });
});

// =============================================================================
// FLOOD CONTROL
// =============================================================================

describe('burst detection', () => {
  it('trips above 20 qualifying buys in 60s, and recovers when the rate drops', () => {
    let now = 1_000;
    const b = new BurstDetector({ now: () => now });

    for (let i = 0; i < 20; i++) expect(b.record(MINT, { usdIn: 10, tier: 'Regular' })).toBe(false);
    expect(b.record(MINT, { usdIn: 10, tier: 'Regular' })).toBe(true); // the 21st

    now += 61_000; // the window slides past them all
    expect(b.bursting(MINT)).toBe(false);
  });

  /**
   * THE POINT OF THE DIGEST KNOWING ABOUT TIERS AT ALL.
   *
   * A whale making a $20 add inside a burst is still a whale — the tier is holdings-based.
   * Taking the digest's tier from the LARGEST BUY would quietly re-introduce the ladder the
   * whole design exists to kill: the digest would say BIG and show big art for a window that
   * contained a whale.
   */
  it('uses the HIGHEST TIER in the window, not the tier of the biggest buy', () => {
    const b = new BurstDetector();

    b.record(MINT, { usdIn: 900, tier: 'Big' }); // the biggest buy...
    b.record(MINT, { usdIn: 20, tier: 'Whale' }); // ...but this one is the whale
    b.record(MINT, { usdIn: 50, tier: 'Regular' });

    const d = b.drain(MINT);
    expect(d?.tier).toBe('Whale'); // NOT 'Big'
    expect(d?.topUsd).toBe(900); // the top buy is still reported honestly
    expect(d?.count).toBe(3);
    expect(d?.totalUsd).toBe(970);
  });

  it('drains exactly once — a buy is in one digest, never two, never none', () => {
    const b = new BurstDetector();
    b.record(MINT, { usdIn: 10, tier: 'Regular' });

    expect(b.drain(MINT)?.count).toBe(1);
    expect(b.drain(MINT)).toBeNull();
  });

  it('renders the digest line', () => {
    const text = digestText('RICE', { count: 14, totalUsd: 2481, topUsd: 612, tier: 'Whale' }, '🐳 WHALE BUY!');
    expect(text).toContain('14 buys · $2,481 total · top buy $612.00');
    expect(text).toContain('🐳 WHALE BUY!');
  });

  it('the daily cap is OFF by default', () => {
    const off = new DailyCap(null);
    for (let i = 0; i < 5000; i++) expect(off.allow(CHAT)).toBe(true);

    const on = new DailyCap(2);
    expect(on.allow(CHAT)).toBe(true);
    expect(on.allow(CHAT)).toBe(true);
    expect(on.allow(CHAT)).toBe(false);
  });
});

// =============================================================================
// WATCHDOG
// =============================================================================

describe('watchdog: fail loud, restart clean', () => {
  it('exits(1) after the ws has been down for 120s — not before', () => {
    let now = 0;
    let connected = false;
    const exits: number[] = [];
    const w = new Watchdog({ connected: () => connected, log, now: () => now, exit: (c) => exits.push(c) });

    w.tick(); // first observation: down since now
    now += 119_000;
    w.tick();
    expect(exits).toEqual([]); // still inside the limit

    now += 2_000;
    w.tick();
    // A silently-dead bot is the worst failure this thing has, because nobody notices it.
    // A crash loop is noisy and gets fixed.
    expect(exits).toEqual([1]);
  });

  it('a reconnect clears the countdown', () => {
    let now = 0;
    let connected = false;
    const exits: number[] = [];
    const w = new Watchdog({ connected: () => connected, log, now: () => now, exit: (c) => exits.push(c) });

    w.tick();
    now += 119_000;
    connected = true;
    w.tick(); // recovered

    connected = false;
    now += 1_000;
    w.tick(); // the clock starts again from HERE
    now += 119_000;
    w.tick();
    expect(exits).toEqual([]);
  });
});

// =============================================================================
// 429 STORM
// =============================================================================

describe('a 429 storm', () => {
  it('loses no message and never escalates its own backoff', async () => {
    const slept: number[] = [];
    let attempt = 0;

    // Telegram says "wait 3" for the first two attempts of every message, then relents.
    const sender: Sender = {
      send: async (_m: Outbound) => {
        attempt++;
        if (attempt % 3 !== 0) {
          throw Object.assign(new Error('Too Many Requests'), {
            error_code: 429,
            parameters: { retry_after: 3 },
          });
        }
        return attempt;
      },
    };

    const q = new DeliveryQueue({
      repo,
      sender,
      log,
      perChatMs: 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    for (let i = 0; i < 10; i++) {
      q.enqueue({
        signature: sig(i),
        chatId: CHAT,
        enqueuedAt: Date.now(),
        build: async () => ({ chatId: CHAT, card: { text: 'x', entities: [], keyboard: [], ladderCount: 1, ladderTruncated: false }, fileId: null, kind: null }),
      });
    }
    await new Promise((r) => setTimeout(r, 50));

    // Every message eventually landed. Nothing was dropped, nothing double-sent.
    const sent = repo.raw.prepare("SELECT COUNT(*) AS n FROM sends WHERE state = 'sent'").get() as { n: number };
    expect(sent.n).toBe(10);

    // And we waited EXACTLY what we were told, every time — never a doubling ramp on top,
    // which is how a 429 becomes a ban.
    expect(slept.every((ms) => ms === 3_000)).toBe(true);
  });
});

// =============================================================================
// kill -9 — THE ACCEPTANCE
// =============================================================================

describe('kill -9 mid-flight', () => {
  /**
   * Claim two sends, then SIGKILL the process before either is recorded. No graceful
   * shutdown, no finally block, no chance to clean up — the process simply stops existing.
   */
  it('nothing double-posts, orphans are swept and NEVER resent, and the file_id cache survives', async () => {
    // Seed a file_id cache entry and a media item, so we can prove they survive.
    await repo.upsertMediaItem({
      sha256: 'a'.repeat(64),
      mint: MINT,
      tier: 'whale',
      relPath: `${MINT}/whale/a.gif`,
      kind: 'animation',
      bytes: 10,
    });
    await repo.putFileId('a'.repeat(64), 'CACHED_FILE_ID');
    await repo.close();

    // --- the crash ------------------------------------------------------------------
    //
    // The victim script lives INSIDE the project: a script in /tmp cannot resolve
    // `better-sqlite3`, and the failure would be swallowed by the catch below — leaving a
    // test that "passes" having never crashed anything.
    const victim = join(process.cwd(), `.victim-${process.pid}.mjs`);
    writeFileSync(
      victim,
      `
      import Database from 'better-sqlite3';
      const db = new Database(${JSON.stringify(dbPath)});
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      const claim = db.prepare(
        "INSERT INTO sends (signature, chat_id, state, attempts, claimed_at) VALUES (?, ?, 'claimed', 1, ?) ON CONFLICT DO NOTHING"
      );
      claim.run(${JSON.stringify(sig(1))}, ${CHAT}, Date.now());
      claim.run(${JSON.stringify(sig(2))}, ${CHAT}, Date.now());
      // The Bot API call may or may not have gone out. We will never know: die NOW.
      process.kill(process.pid, 'SIGKILL');
      `,
    );

    let killed = false;
    try {
      execFileSync('node', [victim], { stdio: 'pipe' });
    } catch (err) {
      // SIGKILL is the expected outcome. ANY other failure means the child never got as far
      // as claiming, and this test would then prove nothing at all.
      killed = (err as { signal?: string }).signal === 'SIGKILL';
      if (!killed) throw new Error(`victim died wrong: ${(err as Error).message}`);
    }
    rmSync(victim, { force: true });
    expect(killed).toBe(true);

    // --- reboot ----------------------------------------------------------------------
    repo = new SqliteRepo(dbPath, log);
    await repo.init();

    // Two rows are sitting in 'claimed' with no message_id. It is NOT KNOWABLE whether
    // Telegram received them — the API call may have succeeded and the process died before
    // recording it.
    const orphaned = repo.raw
      .prepare("SELECT COUNT(*) AS n FROM sends WHERE state = 'claimed'")
      .get() as { n: number };
    expect(orphaned.n).toBe(2);

    // Boot sweeps them. (This is a BOOT step, not part of init() — index.ts calls it
    // explicitly, and so does this test, because the test is simulating a boot.)
    const swept = await repo.sweepOrphanedClaims();
    expect(swept).toBe(2);

    // (b) orphaned claims -> 'failed', with a reason. INVARIANT 9: we DROP, we never resend.
    const rows = repo.raw.prepare('SELECT signature, state, fail_reason FROM sends ORDER BY signature').all() as {
      signature: string;
      state: string;
      fail_reason: string | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === 'failed')).toBe(true);
    expect(rows.every((r) => r.fail_reason !== null)).toBe(true);

    // (a) nothing double-posts: the tombstone makes the claim un-takeable, forever.
    const sent: ChatId[] = [];
    const sender: Sender = {
      send: async (m) => {
        sent.push(m.chatId);
        return 1;
      },
    };
    const q = new DeliveryQueue({ repo, sender, log, perChatMs: 0, sleep: async () => {} });

    for (const n of [1, 2]) {
      q.enqueue({
        signature: sig(n),
        chatId: CHAT,
        enqueuedAt: Date.now(),
        build: async () => ({ chatId: CHAT, card: { text: 'x', entities: [], keyboard: [], ladderCount: 1, ladderTruncated: false }, fileId: null, kind: null }),
      });
    }
    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toEqual([]); // the replayed buys go nowhere. No duplicate posts.

    // (e) the file_id cache survived the SIGKILL with zero re-uploads needed.
    expect(await repo.getFileId('a'.repeat(64))).toBe('CACHED_FILE_ID');
    expect((await repo.listMedia(MINT, 'whale')).map((i) => i.sha256)).toEqual(['a'.repeat(64)]);
  });

  /** (c)/(d) live in the gap-recovery suite above: recovered under 10 min, skipped over it. */
  it('a buy that never got claimed still posts after the restart', async () => {
    await repo.claimSend(sig(1), CHAT);
    await repo.sweepOrphanedClaims('orphaned');

    const sent: Signature[] = [];
    const sender: Sender = {
      send: async () => {
        sent.push(sig(2));
        return 1;
      },
    };
    const q = new DeliveryQueue({ repo, sender, log, perChatMs: 0, sleep: async () => {} });

    q.enqueue({
      signature: sig(2), // untouched by the crash
      chatId: CHAT,
      enqueuedAt: Date.now(),
      build: async () => ({ chatId: CHAT, card: { text: 'x', entities: [], keyboard: [], ladderCount: 1, ladderTruncated: false }, fileId: null, kind: null }),
    });
    await new Promise((r) => setTimeout(r, 30));

    // The sweep is not a blanket amnesty: only the ORPHANED pair is dropped.
    expect(sent).toHaveLength(1);
  });
});

// =============================================================================
// THE SYSTEMD UNIT AND THE POOL WRITE PATH MUST AGREE ABOUT SETGID
//
// `ricebuybot.service` sets RestrictSUIDSGID=yes. That seccomp-filters any mkdir carrying
// S_ISGID and fails it with EPERM — including when the directory ALREADY EXISTS, because
// Node's recursive mkdir returns EPERM straight out instead of falling through to its
// "already there, fine" stat.
//
// So `mkdir(0o2750)` did not degrade on the happy path. It threw on EVERY curation write,
// against a tree setup-media-pool.sh had already provisioned perfectly — and it surfaced to
// the curator as "Something went wrong on my end" with the meme never reaching disk at all.
//
// Nothing in the unit tests could see it: seccomp is applied by systemd, and vitest is not
// systemd. So the coupling is asserted directly instead — the unit's claim on one side, the
// code's mode on the other.
// =============================================================================

describe('the pool write path vs. RestrictSUIDSGID', () => {
  const unit = readFileSync(join(import.meta.dirname, '../deploy/systemd/ricebuybot.service'), 'utf8');

  it('the unit really does forbid setting setgid — the premise of everything below', () => {
    expect(unit).toMatch(/^RestrictSUIDSGID=yes$/m);
  });

  /**
   * The regression, stated as the constraint it is. If this ever goes back to 0o2750 the bot
   * cannot write a single meme, and it fails at the FIRST mkdir — so nothing downstream
   * (dedup, manifest, file_id) even gets a chance to run.
   */
  it('never asks for setgid (or setuid) in a directory mode', () => {
    expect(DIR_MODE & 0o2000).toBe(0); // S_ISGID
    expect(DIR_MODE & 0o4000).toBe(0); // S_ISUID
  });

  /**
   * INVARIANT 4 still has to hold: a tier dir must end up setgid so files the bot creates in
   * it land in group www-data and nginx can read them. It does — the KERNEL does it. This is
   * why not asking costs nothing: setup-media-pool.sh puts 2750 on MEDIA_ROOT and the mint
   * folder precisely so it propagates down.
   */
  it('still yields a setgid dir, because the kernel inherits it from a setgid parent', async () => {
    const parent = join(dir, 'pool');
    mkdirSync(parent);
    chmodSync(parent, 0o2750);

    const tier = join(parent, 'big');
    await fsp.mkdir(tier, { recursive: true, mode: DIR_MODE });

    expect(statSync(tier).mode & 0o7777).toBe(0o2750);
  });

  it('and asks for exactly the permission bits the pool documents', () => {
    expect(DIR_MODE).toBe(0o750);
  });
});
