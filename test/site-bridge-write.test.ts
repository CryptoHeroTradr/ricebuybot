import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate, migrationsDir, loadMigrations } from '../src/db/migrate.js';

import { SqliteRepo } from '../src/db/sqlite.js';
import { createLogger } from '../src/ops/logger.js';
import { encodeBase58 } from '../src/trade/base58.js';
import { LinkCodeStore, NonceStore } from '../src/site-bridge/store.js';
import { createSiteBridgeRoute } from '../src/site-bridge/routes.js';
import { challengeMessage, writeMessage } from '../src/site-bridge/messages.js';
import { KEY_ONLY_PATHS, KEY_REFUSAL, withAuditSource } from '../src/site-bridge/mutations.js';
import {
  applyAmount,
  applyCaps,
  applyNew,
  applyInterval,
  applyPause,
  applyResume,
  WALLET_MODE_REFUSAL,
} from '../src/telegram/trade-panel/commands.js';
import type { Mint } from '../src/core/types.js';

/**
 * PHASE 9 — the site bridge's WRITE path.
 *
 * The phase's claim is not "the site can pause a schedule". It is that the site can pause a
 * schedule *under exactly the rules the Telegram panel pauses one*, and that the mutation path
 * hands out nothing the read path would not have. So the tests come in four groups:
 *
 *   1. PROOF — a write is authenticated by a signature over THAT write, and its nonce dies with it;
 *   2. OWNERSHIP — the acting user is re-derived from the wallet, and a write naming someone
 *      else's schedule is refused, with the panel's own sentence;
 *   3. IDENTITY WITH THE PANEL — the interesting refusals are asserted by running the panel's
 *      apply* on an identical twin user and comparing the message character for character. A test
 *      that merely asserts "the site refuses too" would still pass on the day the two surfaces
 *      start refusing for different reasons or in different words;
 *   4. ATTRIBUTION AND SILENCE — every mutation lands in the audit trail tagged source=site, and no
 *      /site/* response has ever carried a key, a passphrase or a secret.
 */

const SECRET = 'super-secret-bridge-value-0123456789';
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const USER_A = 111;
const USER_B = 222;
/** The identical twin: same state as A, driven through the PANEL instead of the site. */
const USER_TWIN = 333;
const SOL = 1_000_000_000n;
const DAY_CEILING = 500;
const LIFETIME_CEILING = 5_000;
/** The minimum buy, in the unit it is denominated in: 0.001 SOL is the boundary (which belongs to
 *  the user) and 0.0005 SOL is below it. No SOL/USD price is needed to say either — that is the
 *  point of the floor being SOL-denominated on both surfaces. */
const MIN_BUY_SOL = '0.001';
const BELOW_MIN_SOL = '0.0005';
const log = createLogger('silent' as 'info', false);

function makeWallet(): { address: string; sign: (m: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    address: encodeBase58(new Uint8Array(rawPub)),
    sign: (m) => encodeBase58(new Uint8Array(sign(null, Buffer.from(m, 'utf8'), privateKey))),
  };
}

// ── mock http, same shape as the read suite ───────────────────────────────────────────────────
function mockReq(method: string, url: string, headers: Record<string, string>): EventEmitter & Record<string, unknown> {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  req.destroy = () => undefined;
  return req;
}
function mockRes(): { res: Record<string, unknown>; done: Promise<void> } {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const res: Record<string, unknown> = {
    statusCode: 0,
    headersSent: false,
    body: '',
    writeHead(s: number) { (res as { statusCode: number }).statusCode = s; (res as { headersSent: boolean }).headersSent = true; return res; },
    end(b?: string) { (res as { body: string }).body = b ?? ''; resolve(); },
  };
  return { res, done };
}

let dir: string;
let repo: SqliteRepo;
let codes: LinkCodeStore;
let nonces: NonceStore;
let route: (req: unknown, res: unknown) => boolean;
let clock: number;
let wallet: ReturnType<typeof makeWallet>;
let walletB: ReturnType<typeof makeWallet>;

beforeEach(async () => {
  clock = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-write-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  for (const u of [USER_A, USER_B, USER_TWIN]) {
    await repo.addAutotraderUser(u, `u${u}`, 1);
    // Custodial mode: these are the users whose schedules the bot runs. A new member is a
    // wallet-mode member (migration 019), which the wallet-mode test below relies on.
    await repo.setAutotraderMode(u, 'key');
  }
  codes = new LinkCodeStore(10 * 60_000, () => clock);
  nonces = new NonceStore(5 * 60_000, () => clock);
  const r = createSiteBridgeRoute({
    repo,
    codes,
    nonces,
    secret: SECRET,
    log,
    now: () => clock,
    dashboard: { tradeLive: false, defaultMint: MINT },
    write: {
      repo,
      access: repo,
      defaultMint: MINT,
      maxPerDayUsdCeiling: DAY_CEILING,
      maxLifetimeUsdCeiling: LIFETIME_CEILING,
      // The SAME ceilings the panel is registered with — see index.ts. A different ceiling per
      // surface would be a different guard. The minimum buy needs nothing passed at all: it is
      // SOL-denominated and compares against the lamports being written.
    },
  });
  route = r as unknown as (req: unknown, res: unknown) => boolean;

  wallet = makeWallet();
  walletB = makeWallet();
  await repo.linkSite(USER_A, wallet.address);
  await repo.linkSite(USER_B, walletB.address);
});
afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

interface CallResult { status: number; json: Record<string, unknown> }
async function call(
  method: string,
  path: string,
  opts: { secret?: string | null; body?: unknown } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  if (secret !== null) headers['x-site-bridge-secret'] = secret;
  const req = mockReq(method, path, headers);
  const { res, done } = mockRes();
  route(req, res);
  if (opts.body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(opts.body)));
    req.emit('end');
  }
  await done;
  const body = (res as { body: string }).body;
  return { status: (res as { statusCode: number }).statusCode, json: body ? JSON.parse(body) : {} };
}

/** Ask the bot for a nonce + the exact text to sign for THIS action. */
async function challenge(action: string, params: Record<string, unknown> = {}): Promise<{ nonce: string; message: string }> {
  const r = await call('POST', '/site/action-challenge', { body: { action, ...params } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { nonce: r.json.nonce as string, message: r.json.message as string };
}

/** The whole client-side dance: challenge -> sign what the bot says -> submit. */
async function signedWrite(
  w: ReturnType<typeof makeWallet>,
  action: string,
  params: Record<string, unknown> = {},
): Promise<CallResult> {
  const { nonce, message } = await challenge(action, params);
  return call('POST', `/site/${action}`, {
    body: { wallet: w.address, nonce, signature: w.sign(message), ...params },
  });
}

async function seedSchedule(userId: number): Promise<number> {
  return repo.createSchedule({
    userId, mint: MINT, side: 'buy', amountRaw: SOL / 10n, amountKind: 'absolute',
    intervalMinutes: 60, firstRunAt: clock,
  });
}

// ── 1. PROOF ──────────────────────────────────────────────────────────────────────────────────

describe('site bridge WRITE — the proof', () => {
  it('a signed pause from the linked wallet pauses THAT schedule and nothing else', async () => {
    const mine = await seedSchedule(USER_A);
    const alsoMine = await seedSchedule(USER_A);
    const theirs = await seedSchedule(USER_B);

    const r = await signedWrite(wallet, 'pause', { scheduleId: mine });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    expect((await repo.getSchedule(mine))!.state).toBe('paused');
    // The blast radius of one pause is one schedule — not the account, not the user's other rows.
    expect((await repo.getSchedule(alsoMine))!.state).toBe('active');
    expect((await repo.getSchedule(theirs))!.state).toBe('active');
  });

  it('resume, stop-all, amount, interval and caps all land through the same door', async () => {
    const id = await seedSchedule(USER_A);

    expect((await signedWrite(wallet, 'pause', { scheduleId: id })).status).toBe(200);
    expect((await signedWrite(wallet, 'resume', { scheduleId: id })).status).toBe(200);
    expect((await repo.getSchedule(id))!.state).toBe('active');

    expect((await signedWrite(wallet, 'amount', { scheduleId: id, amount: '0.25' })).status).toBe(200);
    expect((await repo.getSchedule(id))!.amountRaw).toBe(SOL / 4n);

    expect((await signedWrite(wallet, 'interval', { scheduleId: id, interval: 30 })).status).toBe(200);
    expect((await repo.getSchedule(id))!.intervalMinutes).toBe(30);

    expect((await signedWrite(wallet, 'caps', { per: 50, day: 200, lifetime: 1000 })).status).toBe(200);
    const caps = await repo.getCaps(USER_A, MINT);
    expect(caps).toMatchObject({ maxPerExecUsd: 50, maxPerDayUsd: 200, maxLifetimeUsd: 1000 });

    expect((await signedWrite(wallet, 'stop-all')).status).toBe(200);
    expect((await repo.getSchedule(id))!.state).toBe('paused');
  });

  it('refuses a REPLAYED write nonce — the second attempt dies with the nonce', async () => {
    const id = await seedSchedule(USER_A);
    const { nonce, message } = await challenge('pause', { scheduleId: id });
    const body = { wallet: wallet.address, nonce, signature: wallet.sign(message), scheduleId: id };

    expect((await call('POST', '/site/pause', { body })).status).toBe(200);
    await repo.unhaltSchedule(id); // put it back, so a successful replay would be visible

    const replay = await call('POST', '/site/pause', { body });
    expect(replay.status).toBe(401);
    expect((await repo.getSchedule(id))!.state).toBe('active');
  });

  it('a nonce is consumed PER WRITE — no write shares one with a read or another write', async () => {
    const id = await seedSchedule(USER_A);

    // A nonce minted for a write, spent on a READ: the read consumes it, and the write that was
    // going to use it now finds it gone. One nonce, one request, whatever kind.
    const first = await challenge('pause', { scheduleId: id });
    const read = await call('POST', '/site/schedules', {
      body: { wallet: wallet.address, nonce: first.nonce, signature: wallet.sign(challengeMessage(first.nonce)) },
    });
    expect(read.status).toBe(200);
    const spent = await call('POST', '/site/pause', {
      body: { wallet: wallet.address, nonce: first.nonce, signature: wallet.sign(first.message), scheduleId: id },
    });
    expect(spent.status).toBe(401);
    expect((await repo.getSchedule(id))!.state).toBe('active');

    // And the reverse: a read challenge's own nonce cannot back a write, because the write's
    // signature must be over the WRITE message and this wallet never signed one for it.
    const readNonce = (await call('GET', '/site/challenge')).json.nonce as string;
    const smuggled = await call('POST', '/site/pause', {
      body: { wallet: wallet.address, nonce: readNonce, signature: wallet.sign(challengeMessage(readNonce)), scheduleId: id },
    });
    expect(smuggled.status).toBe(401);
    expect((await repo.getSchedule(id))!.state).toBe('active');
  });

  it('the signature is bound to the ACTION — a proof for one write cannot drive another', async () => {
    const mine = await seedSchedule(USER_A);
    const alsoMine = await seedSchedule(USER_A);
    const { nonce, message } = await challenge('pause', { scheduleId: mine });

    // Same wallet, same nonce, same signature — pointed at a different schedule of their own.
    const swapped = await call('POST', '/site/pause', {
      body: { wallet: wallet.address, nonce, signature: wallet.sign(message), scheduleId: alsoMine },
    });
    expect(swapped.status).toBe(401);
    expect((await repo.getSchedule(alsoMine))!.state).toBe('active');

    // And re-pointed at a different ACTION: a pause proof is not a stop-all proof.
    const escalated = await call('POST', '/site/stop-all', {
      body: { wallet: wallet.address, nonce, signature: wallet.sign(message) },
    });
    expect(escalated.status).toBe(401);
    expect((await repo.getSchedule(mine))!.state).toBe('active');
  });

  it('refuses a signature from a DIFFERENT wallet, and a stale nonce', async () => {
    const id = await seedSchedule(USER_A);
    const attacker = makeWallet();

    const { nonce, message } = await challenge('pause', { scheduleId: id });
    const forged = await call('POST', '/site/pause', {
      body: { wallet: wallet.address, nonce, signature: attacker.sign(message), scheduleId: id },
    });
    expect(forged.status).toBe(401);

    const fresh = await challenge('pause', { scheduleId: id });
    clock += 5 * 60_000 + 1; // past the nonce TTL
    const stale = await call('POST', '/site/pause', {
      body: { wallet: wallet.address, nonce: fresh.nonce, signature: wallet.sign(fresh.message), scheduleId: id },
    });
    expect(stale.status).toBe(401);
    expect((await repo.getSchedule(id))!.state).toBe('active');
  });

  it('still requires the shared secret — a mutation path is not a public door', async () => {
    const id = await seedSchedule(USER_A);
    expect((await call('POST', '/site/action-challenge', { secret: null, body: { action: 'pause', scheduleId: id } })).status).toBe(401);
    expect((await call('POST', '/site/pause', { secret: 'wrong-but-long-enough-string-xx', body: {} })).status).toBe(401);
    expect((await repo.getSchedule(id))!.state).toBe('active');
  });
});

// ── 1b. THE SITE_BRIDGE_WRITES GATE ───────────────────────────────────────────────────────────

/**
 * The write surface is OPT-IN (SITE_BRIDGE_WRITES, default false), and reads do not depend on it.
 *
 * The flag is honoured at the COMPOSITION ROOT by supplying `write` or not — the factory's own
 * supported state — rather than by a boolean checked inside each handler. A gate that lives in the
 * handlers is a gate someone can forget to write into the seventh handler; a route that was never
 * mounted cannot be reached by an endpoint nobody remembered to guard.
 */
describe('site bridge WRITE — off unless the operator turns it on', () => {
  /** Mount the same bridge with the write surface present or absent, as index.ts does per the flag. */
  function mountWith(writes: boolean): void {
    const r = createSiteBridgeRoute({
      repo, codes, nonces, secret: SECRET, log, now: () => clock,
      dashboard: { tradeLive: false, defaultMint: MINT },
      write: writes
        ? { repo, access: repo, defaultMint: MINT, maxPerDayUsdCeiling: DAY_CEILING, maxLifetimeUsdCeiling: LIFETIME_CEILING }
        : undefined,
    });
    route = r as unknown as (req: unknown, res: unknown) => boolean;
  }

  const MUTATION_PATHS = ['/site/pause', '/site/resume', '/site/stop-all', '/site/amount', '/site/interval', '/site/caps'];

  it('OFF: all six mutation routes 404, and nothing can be changed through them', async () => {
    const id = await seedSchedule(USER_A);
    mountWith(false);

    for (const p of MUTATION_PATHS) {
      const r = await call('POST', p, { body: { wallet: wallet.address, scheduleId: id } });
      expect(r.status, p).toBe(404);
    }
    // The challenge that would mint a proof for one is gone too — there is nothing to prove to.
    expect((await call('POST', '/site/action-challenge', { body: { action: 'pause', scheduleId: id } })).status).toBe(404);
    expect((await repo.getSchedule(id))!.state).toBe('active');
  });

  it('OFF: the READ still works — the flag gates writes, not the bridge', async () => {
    await seedSchedule(USER_A);
    mountWith(false);

    const nonce = (await call('GET', '/site/challenge')).json.nonce as string;
    const r = await call('POST', '/site/schedules', {
      body: { wallet: wallet.address, nonce, signature: wallet.sign(challengeMessage(nonce)) },
    });
    expect(r.status).toBe(200);
    expect(r.json.linked).toBe(true);
    expect((r.json.schedules as unknown[]).length).toBe(1);
  });

  it('ON: the six routes mount and a signed write lands', async () => {
    const id = await seedSchedule(USER_A);
    mountWith(true);
    expect((await signedWrite(wallet, 'pause', { scheduleId: id })).status).toBe(200);
    expect((await repo.getSchedule(id))!.state).toBe('paused');
  });

  it('index.ts supplies the write surface ONLY under the flag', () => {
    // The two tests above prove the factory honours `write: undefined`. This one proves the boot
    // path actually decides it from SITE_BRIDGE_WRITES — the wiring between the flag and the
    // factory is the part that would regress silently, because everything else still passes.
    const src = readFileSync(join(import.meta.dirname, '..', 'src/index.ts'), 'utf8');
    expect(src).toMatch(/write:\s*cfg\.SITE_BRIDGE_WRITES\s*\n?\s*\?/);
    expect(src).toMatch(/:\s*undefined,/);
  });
});

// ── 2. OWNERSHIP ──────────────────────────────────────────────────────────────────────────────

describe('site bridge WRITE — acts only on the signer’s own schedules', () => {
  it('refuses a write naming ANOTHER user’s schedule, in the panel’s own words', async () => {
    const theirs = await seedSchedule(USER_B);

    const r = await signedWrite(wallet, 'pause', { scheduleId: theirs });
    expect(r.status).toBe(400);
    expect((await repo.getSchedule(theirs))!.state).toBe('active');

    // Character for character what the panel says to a Telegram user who tries the same thing.
    const panel = await applyPause(repo, USER_A, theirs);
    expect(r.json.error).toBe(panel.message);
    expect((await repo.getSchedule(theirs))!.state).toBe('active');
  });

  it('the acting user is re-resolved AT ACTION TIME — an unlinked wallet acts as nobody', async () => {
    const id = await seedSchedule(USER_A);
    const { nonce, message } = await challenge('pause', { scheduleId: id });

    // The link is dropped after the nonce is minted and the message signed: the proof is still
    // valid, and it now proves ownership of a wallet that is nobody's.
    await repo.linkSite(USER_B, wallet.address); // re-link REPLACES: A no longer owns this wallet
    const r = await call('POST', '/site/pause', {
      body: { wallet: wallet.address, nonce, signature: wallet.sign(message), scheduleId: id },
    });
    expect(r.status).toBe(400); // resolved to USER_B, who has no schedule #id
    expect((await repo.getSchedule(id))!.state).toBe('active');
  });

  it('a wallet with no link at all is refused, and reads the same as a revoked member', async () => {
    const stranger = makeWallet();
    const strangerRefusal = await signedWrite(stranger, 'stop-all');
    expect(strangerRefusal.status).toBe(403);

    // A REVOKED member still has their site_link. They must not be distinguishable from someone
    // who never linked — a refusal that tells the two apart is an allowlist oracle (INVARIANT 14).
    await repo.setAutotraderLocked(USER_A, true);
    const revoked = await signedWrite(wallet, 'stop-all');
    expect(revoked.status).toBe(strangerRefusal.status);
    expect(revoked.json.error).toBe(strangerRefusal.json.error);
  });

  it('a WALLET-MODE user is refused with the panel’s refusal — there is no schedule of ours', async () => {
    const id = await seedSchedule(USER_A);
    await repo.setAutotraderMode(USER_A, 'wallet');

    const r = await signedWrite(wallet, 'pause', { scheduleId: id });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe(WALLET_MODE_REFUSAL);
    expect((await repo.getSchedule(id))!.state).toBe('active');
  });
});

// ── 2b. THE UNKNOWN GUARD, FROM THE SURFACE THAT MADE IT REACHABLE ────────────────────────────

/**
 * INVARIANT 16 over the bridge. The write path is why this guard had to exist as more than a
 * convention: `/site/resume` reaches the same `applyResume` the panel's ▶️ does, so an UNKNOWN
 * halt was one signed request away from being cleared by someone who had not looked at the chain.
 */
describe('site bridge WRITE — resume is not an exit from an UNKNOWN outcome', () => {
  async function unknownHalted(userId: number): Promise<{ scheduleId: number; executionId: number }> {
    const scheduleId = await seedSchedule(userId);
    const executionId = (await repo.claimExecution(scheduleId, userId, clock))!;
    await repo.settleExecution(executionId, { state: 'UNKNOWN', signature: 'sig-ambiguous' });
    await repo.haltSchedule(scheduleId, `UNKNOWN outcome for execution ${executionId} (sig-ambiguous)`, clock);
    return { scheduleId, executionId };
  }

  it('a signed resume of an UNKNOWN-halted schedule is refused, pointing at /resolve in the bot', async () => {
    const { scheduleId, executionId } = await unknownHalted(USER_A);

    const r = await signedWrite(wallet, 'resume', { scheduleId });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain(`/resolve ${executionId} confirmed|failed`);
    expect((await repo.getSchedule(scheduleId))!.state).toBe('halted');

    // Word for word what a Telegram user is told — one guard, one sentence, two surfaces.
    const panel = await applyResume(repo, USER_A, scheduleId);
    expect(r.json.error).toBe(panel.message);
  });

  it('stop-all still works on it — pausing an ambiguous schedule is always safe', async () => {
    const { scheduleId } = await unknownHalted(USER_A);
    const other = await seedSchedule(USER_A);
    expect((await signedWrite(wallet, 'stop-all')).status).toBe(200);
    expect((await repo.getSchedule(other))!.state).toBe('paused');
    expect((await repo.getSchedule(scheduleId))!.state).toBe('halted'); // never un-halted
  });

  it('an ordinary halt still resumes from the site', async () => {
    const id = await seedSchedule(USER_A);
    await repo.haltSchedule(id, 'daily cap $200 reached', clock);
    expect((await signedWrite(wallet, 'resume', { scheduleId: id })).status).toBe(200);
    expect((await repo.getSchedule(id))!.state).toBe('active');
  });

  it('no audit row is written for the refused resume', async () => {
    const { scheduleId } = await unknownHalted(USER_A);
    await signedWrite(wallet, 'resume', { scheduleId });
    expect(await repo.listSettingChanges(USER_A, 10)).toHaveLength(0);
  });
});

// ── 3. IDENTITY WITH THE PANEL ────────────────────────────────────────────────────────────────

describe('site bridge WRITE — a guard that blocks the panel blocks the site, identically', () => {
  /** Seed the twin with the same schedule so the panel call has the same world to judge. */
  async function twin(): Promise<number> {
    return seedSchedule(USER_TWIN);
  }

  it('a sub-1-minute interval is refused with the same message on both surfaces', async () => {
    const mine = await seedSchedule(USER_A);
    const theirs = await twin();

    for (const bad of ['0', '-5', '0.5']) {
      const site = await signedWrite(wallet, 'interval', { scheduleId: mine, interval: bad });
      const panel = await applyInterval(repo, USER_TWIN, theirs, bad);
      expect(site.status).toBe(400);
      expect(panel.ok).toBe(false);
      expect(site.json.error).toBe(panel.message);
    }
    expect((await repo.getSchedule(mine))!.intervalMinutes).toBe(60); // untouched
  });

  it('a non-positive amount is refused with the same message on both surfaces', async () => {
    const mine = await seedSchedule(USER_A);
    const theirs = await twin();

    for (const bad of ['0', '-1', 'abc']) {
      const site = await signedWrite(wallet, 'amount', { scheduleId: mine, amount: bad });
      const panel = await applyAmount(repo, USER_TWIN, theirs, bad);
      expect(site.status).toBe(400);
      expect(site.json.error).toBe(panel.message);
    }
    expect((await repo.getSchedule(mine))!.amountRaw).toBe(SOL / 10n);
  });

  /**
   * THE 0.001 SOL MINIMUM BUY, ON AN EDIT.
   *
   * This test used to assert that the two surfaces AGREED — and they did, on accepting a sub-floor
   * edit, because the floor was checked at creation and at execution but nowhere in between. That
   * made create-high/edit-low a way around it from either surface. The agreement was real and the
   * behaviour was wrong; now they agree on REFUSING, which is what the assertion says.
   */
  it('a sub-minimum amount edit is REFUSED, identically on both surfaces', async () => {
    const mine = await seedSchedule(USER_A);
    const theirs = await twin();

    const dust = BELOW_MIN_SOL;
    const site = await signedWrite(wallet, 'amount', { scheduleId: mine, amount: dust });
    const panel = await applyAmount(repo, USER_TWIN, theirs, dust);

    expect(site.status).toBe(400);
    expect(panel.ok).toBe(false);
    expect(site.json.error).toBe(panel.message);
    expect(String(site.json.error)).toContain('below the 0.001 SOL minimum buy');
    // Neither schedule moved: a refused edit writes nothing on either surface.
    expect((await repo.getSchedule(mine))!.amountRaw).toBe(SOL / 10n);
    expect((await repo.getSchedule(theirs))!.amountRaw).toBe(SOL / 10n);
  });

  it('an edit AT or ABOVE the minimum still succeeds — the floor is `<`, not `<=`', async () => {
    const mine = await seedSchedule(USER_A);

    // Exactly the floor. The boundary belongs to the user.
    expect((await signedWrite(wallet, 'amount', { scheduleId: mine, amount: MIN_BUY_SOL })).status).toBe(200);
    expect((await repo.getSchedule(mine))!.amountRaw).toBe(1_000_000n);

    expect((await signedWrite(wallet, 'amount', { scheduleId: mine, amount: '0.05' })).status).toBe(200);
    expect((await repo.getSchedule(mine))!.amountRaw).toBe(50_000_000n);
  });

  it('creating below the floor and editing below it now refuse in the SAME words', async () => {
    const mine = await seedSchedule(USER_A);
    const created = await applyNew(repo, USER_TWIN, MINT, 'buy', BELOW_MIN_SOL, '60', clock);
    const edited = await signedWrite(wallet, 'amount', { scheduleId: mine, amount: BELOW_MIN_SOL });
    expect(created.ok).toBe(false);
    expect(edited.json.error).toBe(created.message); // one sentence, one rule, two moments
  });

  it('an over-ceiling cap is refused with the same message — same ceiling, both surfaces', async () => {
    const overDay = String(DAY_CEILING + 1);
    const site = await signedWrite(wallet, 'caps', { per: 50, day: overDay });
    const panel = await applyCaps(repo, USER_TWIN, MINT, '50', overDay, '', DAY_CEILING, LIFETIME_CEILING);
    expect(site.status).toBe(400);
    expect(site.json.error).toBe(panel.message);
    expect(await repo.getCaps(USER_A, MINT)).toBeNull(); // nothing was written

    const overLife = String(LIFETIME_CEILING + 1);
    const siteLife = await signedWrite(wallet, 'caps', { per: 50, day: 200, lifetime: overLife });
    const panelLife = await applyCaps(repo, USER_TWIN, MINT, '50', '200', overLife, DAY_CEILING, LIFETIME_CEILING);
    expect(siteLife.status).toBe(400);
    expect(siteLife.json.error).toBe(panelLife.message);

    // ...and the panel's other cap invariants come along for free, because they are the same code.
    const inverted = await signedWrite(wallet, 'caps', { per: 200, day: 50 });
    const panelInverted = await applyCaps(repo, USER_TWIN, MINT, '200', '50', '', DAY_CEILING, LIFETIME_CEILING);
    expect(inverted.json.error).toBe(panelInverted.message);
  });
});

// ── 4. ATTRIBUTION AND SILENCE ────────────────────────────────────────────────────────────────

describe('site bridge WRITE — attribution', () => {
  it('every mutation lands in the settings audit trail tagged source=site', async () => {
    const id = await seedSchedule(USER_A);
    expect((await signedWrite(wallet, 'pause', { scheduleId: id })).status).toBe(200);
    expect((await signedWrite(wallet, 'resume', { scheduleId: id })).status).toBe(200);
    expect((await signedWrite(wallet, 'amount', { scheduleId: id, amount: '0.25' })).status).toBe(200);
    expect((await signedWrite(wallet, 'interval', { scheduleId: id, interval: 30 })).status).toBe(200);
    expect((await signedWrite(wallet, 'caps', { per: 50, day: 200 })).status).toBe(200);
    expect((await signedWrite(wallet, 'stop-all')).status).toBe(200);

    const trail = await repo.listSettingChanges(USER_A, 50);
    expect(trail.map((t) => t.action).sort()).toEqual(
      ['caps', 'schedule.amount', 'schedule.interval', 'schedule.pause', 'schedule.resume', 'stop_all'].sort(),
    );
    // Not "at least one is tagged" — EVERY row from this surface is, or a change is unattributable.
    for (const row of trail) expect(row.source, `${row.action} is not attributable to the site`).toBe('site');
  });

  it('the SAME action from the panel is tagged source=telegram — the trail tells them apart', async () => {
    const id = await seedSchedule(USER_A);
    await applyPause(repo, USER_A, id); // the panel's own call, unwrapped
    await signedWrite(wallet, 'resume', { scheduleId: id });

    const trail = await repo.listSettingChanges(USER_A, 10);
    const bySource = Object.fromEntries(trail.map((t) => [t.action, t.source]));
    expect(bySource['schedule.pause']).toBe('telegram');
    expect(bySource['schedule.resume']).toBe('site');
  });

  it('the source is stamped at the REPO BOUNDARY, so a new apply* cannot forget it', async () => {
    // withAuditSource wraps the repo, not the call sites: anything written through it is tagged,
    // including an action written after today by someone who never read this file.
    const tagged = withAuditSource(repo, 'site');
    await tagged.recordSettingChange({
      userId: USER_A, action: 'an.action.invented.later', scheduleId: null,
      field: null, fromValue: null, toValue: 'x',
    });
    const [row] = await repo.listSettingChanges(USER_A, 1);
    expect(row!.source).toBe('site');

    // And the wrapper is still the same repo for everything else — a Proxy, not a copy: methods
    // that touch private state have to keep working.
    expect(await tagged.listSchedules(USER_A)).toEqual(await repo.listSchedules(USER_A));
  });

  it('a REFUSED write writes no audit row — the trail records changes, not attempts', async () => {
    const theirs = await seedSchedule(USER_B);
    await signedWrite(wallet, 'pause', { scheduleId: theirs });
    expect(await repo.listSettingChanges(USER_A, 10)).toHaveLength(0);
    expect(await repo.listSettingChanges(USER_B, 10)).toHaveLength(0);
  });
});

describe('site bridge WRITE — the bot returns no secret, ever', () => {
  /** Every field name anywhere in a response body, however deeply nested. */
  function fieldNames(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) for (const v of value) fieldNames(v, out);
    else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        fieldNames(v, out);
      }
    }
    return out;
  }

  const FORBIDDEN = /key|secret|passphrase|mnemonic|seed|private/i;

  it('no /site/* response shape carries a key, secret or passphrase field', async () => {
    const id = await seedSchedule(USER_A);
    const good = await challenge('pause', { scheduleId: id });

    // Every /site/* route this surface has, in both their happy and refusing forms.
    const responses: CallResult[] = [
      await call('GET', '/site/challenge'),
      await call('POST', '/site/link', { body: { wallet: wallet.address, code: 'NOPE', signature: 'x' } }),
      await call('POST', '/site/schedules', { body: { wallet: wallet.address, nonce: (await call('GET', '/site/challenge')).json.nonce, signature: wallet.sign(challengeMessage((await call('GET', '/site/challenge')).json.nonce as string)) } }),
      await call('POST', '/site/tma-wallet', { body: { initData: 'x' } }),
      await call('POST', '/site/action-challenge', { body: { action: 'pause', scheduleId: id } }),
      await call('POST', '/site/action-challenge', { body: { action: 'nonsense' } }),
      await call('POST', '/site/pause', { body: { wallet: wallet.address, nonce: good.nonce, signature: wallet.sign(good.message), scheduleId: id } }),
      await signedWrite(wallet, 'resume', { scheduleId: id }),
      await signedWrite(wallet, 'amount', { scheduleId: id, amount: '0.25' }),
      await signedWrite(wallet, 'interval', { scheduleId: id, interval: 30 }),
      await signedWrite(wallet, 'caps', { per: 50, day: 200, lifetime: 1000 }),
      await signedWrite(wallet, 'stop-all'),
      await signedWrite(wallet, 'pause', { scheduleId: 999_999 }), // refusal
      await signedWrite(makeWallet(), 'stop-all'), // unlinked refusal
      await call('POST', '/site/pause', { body: {} }), // malformed
      await call('GET', '/site/nope'), // 404
      ...(await Promise.all([...KEY_ONLY_PATHS].map((p) => call('POST', p, { body: {} })))),
    ];

    for (const r of responses) {
      for (const name of fieldNames(r.json)) {
        expect(FORBIDDEN.test(name), `a /site/* response returned a field named "${name}"`).toBe(false);
      }
      // Belt and braces: the shared secret itself must never be echoed back either.
      expect(JSON.stringify(r.json)).not.toContain(SECRET);
    }
  });

  it('refuses every key-taking route BY NAME — "manage your wallet in the bot"', async () => {
    for (const p of KEY_ONLY_PATHS) {
      const r = await call('POST', p, { body: { wallet: wallet.address } });
      expect(r.status, p).toBe(403);
      expect(String(r.json.error), p).toContain(KEY_REFUSAL);
    }
  });

  it('a successful write returns the panel’s message and nothing else', async () => {
    const id = await seedSchedule(USER_A);
    const r = await signedWrite(wallet, 'pause', { scheduleId: id });
    // The response is the contract: an outcome and the sentence the panel would have shown. Any
    // additional key is a widening of what the site learns from a write, and should be argued for.
    expect(Object.keys(r.json).sort()).toEqual(['message', 'ok']);
    expect(r.json.message).toBe(`Schedule #${id} paused.`);
    // ...which is what the panel says about the same schedule, not a paraphrase of it.
    const twinId = await seedSchedule(USER_TWIN);
    expect((await applyPause(repo, USER_TWIN, twinId)).message).toBe(`Schedule #${twinId} paused.`);
  });
});

// ── the migration that made attribution possible ──────────────────────────────────────────────

/**
 * Migration 020 adds `source` to a table that already has rows in production, so it is exercised
 * the way 015 taught us to (test/migration-fk.test.ts): against a POPULATED table, not a fresh one.
 *
 * The claim under test is the migration's own justification. Backfilling pre-existing rows to
 * 'telegram' is not the abstention principle being waived — it is DERIVED: until this phase the
 * bridge held a repo surface with no mutation method on it, so no row in this table could have come
 * from anywhere else. What must be true is that those rows come out saying 'telegram' and are told
 * apart from the site rows written afterwards.
 */
describe('migration 020 — the audit trail learns which surface issued a change', () => {
  it('backfills rows written before the distinction existed, and constrains new ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'ricebuybot-mig020-'));
    try {
      const subsetDir = (maxVersion: number): string => {
        const d = join(root, `migrations-to-${maxVersion}`);
        mkdirSync(d, { recursive: true });
        for (const m of loadMigrations()) {
          if (m.version <= maxVersion) writeFileSync(join(d, `${String(m.version).padStart(3, '0')}_${m.name}.sql`), m.sql);
        }
        return d;
      };

      const db = new Database(join(root, 'test.db'));
      db.pragma('foreign_keys = ON');

      // A DB as it stands in production today: migrated to 019, with real audit history in it.
      migrate(db, log, subsetDir(19));
      db.prepare(
        `INSERT INTO autotrader_settings_audit (user_id, at, action, schedule_id, field, from_value, to_value)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(USER_A, 1000, 'schedule.pause', 7, null, 'active', 'paused');

      migrate(db, log, migrationsDir());
      const latest = Math.max(...loadMigrations().map((m) => m.version));
      expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: latest });

      // The pre-existing row now names the only surface that could have written it.
      expect(db.prepare('SELECT source FROM autotrader_settings_audit WHERE action = ?').get('schedule.pause'))
        .toEqual({ source: 'telegram' });

      // And the column is NOT NULL, so no future row can be silently unattributable.
      expect(() =>
        db.prepare(
          `INSERT INTO autotrader_settings_audit (user_id, at, action, schedule_id, field, from_value, to_value, source)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).run(USER_A, 2000, 'caps', null, null, null, '$1/$2/none', null),
      ).toThrow(/NOT NULL/);

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── the write message itself ──────────────────────────────────────────────────────────────────

describe('site bridge WRITE — what the wallet is asked to sign', () => {
  it('names the action, the schedule and the value — a read challenge does not', async () => {
    const id = await seedSchedule(USER_A);
    const { nonce, message } = await challenge('pause', { scheduleId: id });

    expect(message).toBe(writeMessage('pause', id, [], nonce));
    expect(message).toContain('action:pause');
    expect(message).toContain(`schedule:${id}`);
    // The read challenge and the write message must not be the same string, or a signature
    // collected for a read could be spent on a write.
    expect(message).not.toBe(challengeMessage(nonce));
  });

  it('an account-wide action says so, rather than naming a schedule it does not have', async () => {
    const { nonce, message } = await challenge('stop-all');
    expect(message).toBe(writeMessage('stop-all', null, [], nonce));
    expect(message).toContain('schedule:all');
  });

  it('the value is in the message — signing an amount change shows the amount', async () => {
    const id = await seedSchedule(USER_A);
    const { message } = await challenge('amount', { scheduleId: id, amount: '0.25' });
    expect(message).toContain('value:0.25');
  });

  it('a number and its string spelling canonicalise to the same message', async () => {
    const id = await seedSchedule(USER_A);
    const a = await challenge('interval', { scheduleId: id, interval: 30 });
    const b = await challenge('interval', { scheduleId: id, interval: '30' });
    expect(a.message.replace(a.nonce, '')).toBe(b.message.replace(b.nonce, ''));
  });

  it('refuses to mint a challenge for a malformed intent', async () => {
    expect((await call('POST', '/site/action-challenge', { body: { action: 'pause' } })).status).toBe(400);
    expect((await call('POST', '/site/action-challenge', { body: { action: 'amount', scheduleId: 1 } })).status).toBe(400);
    expect((await call('POST', '/site/action-challenge', { body: { action: 'delete', scheduleId: 1 } })).status).toBe(400);
  });
});
