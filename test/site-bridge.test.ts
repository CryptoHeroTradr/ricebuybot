import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.js';
import { createLogger, REDACT_PATHS } from '../src/ops/logger.js';
import { encodeBase58 } from '../src/trade/base58.js';
import { LinkCodeStore, NonceStore } from '../src/site-bridge/store.js';
import { createSiteBridgeRoute } from '../src/site-bridge/routes.js';
import { linkMessage, challengeMessage } from '../src/site-bridge/messages.js';
import type { Mint } from '../src/core/types.js';

const SECRET = 'super-secret-bridge-value-0123456789';
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const USER_A = 111;
const USER_B = 222;
const SOL = 1_000_000_000n;
const log = createLogger('silent' as 'info', false);

/** A test wallet: a real ed25519 keypair, exposing its base58 address + a base58 signMessage —
 *  exactly what a Solana wallet's signMessage produces. */
function makeWallet(): { address: string; sign: (m: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    address: encodeBase58(new Uint8Array(rawPub)),
    sign: (m) => encodeBase58(new Uint8Array(sign(null, Buffer.from(m, 'utf8'), privateKey))),
  };
}

// ── mock http req/res so the RouteHandler can be exercised without a listener ─────────────────
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

beforeEach(async () => {
  clock = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-bridge-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  await repo.addAutotraderUser(USER_A, 'a', 1);
  await repo.addAutotraderUser(USER_B, 'b', 1);
  codes = new LinkCodeStore(10 * 60_000, () => clock);
  nonces = new NonceStore(5 * 60_000, () => clock);
  const r = createSiteBridgeRoute({ repo, codes, nonces, secret: SECRET, log, now: () => clock });
  route = r as unknown as (req: unknown, res: unknown) => boolean;
});
afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

interface CallResult { handled: boolean; status: number; json: Record<string, unknown> | null }
async function call(
  method: string,
  path: string,
  opts: { secret?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  if (secret !== null) headers['x-site-bridge-secret'] = secret;
  const req = mockReq(method, path, headers);
  const { res, done } = mockRes();
  const handled = route(req, res);
  if (opts.body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(opts.body)));
    req.emit('end');
  }
  await done;
  const body = (res as { body: string }).body;
  return { handled, status: (res as { statusCode: number }).statusCode, json: body ? JSON.parse(body) : null };
}

/** GET a challenge and return its nonce. */
async function getNonce(): Promise<string> {
  const r = await call('GET', '/site/challenge');
  return r.json!.nonce as string;
}

async function seedSchedule(userId: number): Promise<number> {
  return repo.createSchedule({
    userId, mint: MINT, side: 'buy', amountRaw: SOL / 10n, amountKind: 'absolute',
    intervalMinutes: 60, firstRunAt: clock,
  });
}

describe('site bridge — LINK', () => {
  it('stores the mapping, and a re-link REPLACES (never accumulates)', async () => {
    const w1 = makeWallet();
    const code1 = codes.issue(USER_A);
    const ok1 = await call('POST', '/site/link', { body: { wallet: w1.address, code: code1, signature: w1.sign(linkMessage(w1.address, code1)) } });
    expect(ok1.status).toBe(200);
    expect(await repo.userForWallet(w1.address)).toBe(USER_A);

    // Same user links a NEW wallet — the old wallet is detached, not kept alongside.
    const w2 = makeWallet();
    const code2 = codes.issue(USER_A);
    const ok2 = await call('POST', '/site/link', { body: { wallet: w2.address, code: code2, signature: w2.sign(linkMessage(w2.address, code2)) } });
    expect(ok2.status).toBe(200);
    expect(await repo.userForWallet(w2.address)).toBe(USER_A);
    expect(await repo.userForWallet(w1.address)).toBeNull();
  });

  it('rejects a signature that does not prove the wallet, and does not burn the code', async () => {
    const w = makeWallet();
    const other = makeWallet();
    const code = codes.issue(USER_A);
    const bad = await call('POST', '/site/link', { body: { wallet: w.address, code, signature: other.sign(linkMessage(w.address, code)) } });
    expect(bad.status).toBe(401);
    expect(await repo.userForWallet(w.address)).toBeNull();
    // The code survived a bad-signature attempt: a correct signature still links.
    const good = await call('POST', '/site/link', { body: { wallet: w.address, code, signature: w.sign(linkMessage(w.address, code)) } });
    expect(good.status).toBe(200);
    expect(await repo.userForWallet(w.address)).toBe(USER_A);
  });

  it('rejects an invalid/expired code', async () => {
    const w = makeWallet();
    const r = await call('POST', '/site/link', { body: { wallet: w.address, code: 'DEADBEEF01', signature: w.sign(linkMessage(w.address, 'DEADBEEF01')) } });
    expect(r.status).toBe(400);
    expect(await repo.userForWallet(w.address)).toBeNull();
  });
});

describe('site bridge — READ', () => {
  it('returns ONLY the linked user\'s schedules, with lifetime budget + spend', async () => {
    const wA = makeWallet();
    const codeA = codes.issue(USER_A);
    await call('POST', '/site/link', { body: { wallet: wA.address, code: codeA, signature: wA.sign(linkMessage(wA.address, codeA)) } });
    const aId = await seedSchedule(USER_A);
    await seedSchedule(USER_B); // another user's schedule must NEVER appear
    await repo.setCaps({ userId: USER_A, mint: MINT, maxPerExecUsd: 50, maxPerDayUsd: 200, maxLifetimeUsd: 500 });

    const nonce = await getNonce();
    const r = await call('POST', '/site/schedules', { body: { wallet: wA.address, nonce, signature: wA.sign(challengeMessage(nonce)) } });
    expect(r.status).toBe(200);
    expect(r.json!.linked).toBe(true);
    const schedules = r.json!.schedules as Array<{ id: number; caps: { lifetimeUsd: number } | null; spentLifetimeUsd: number }>;
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.id).toBe(aId); // only A's schedule
    expect(schedules[0]!.caps!.lifetimeUsd).toBe(500); // lifetime budget from 017
    expect(schedules[0]!).toHaveProperty('spentLifetimeUsd');
  });

  it('an unlinked but proven wallet reads as linked:false with no schedules', async () => {
    const w = makeWallet();
    const nonce = await getNonce();
    const r = await call('POST', '/site/schedules', { body: { wallet: w.address, nonce, signature: w.sign(challengeMessage(nonce)) } });
    expect(r.status).toBe(200);
    expect(r.json!.linked).toBe(false);
    expect(r.json!.schedules).toEqual([]);
  });

  it('refuses a REPLAYED (already-consumed) nonce', async () => {
    const wA = makeWallet();
    const codeA = codes.issue(USER_A);
    await call('POST', '/site/link', { body: { wallet: wA.address, code: codeA, signature: wA.sign(linkMessage(wA.address, codeA)) } });
    const nonce = await getNonce();
    const sig = wA.sign(challengeMessage(nonce));
    const first = await call('POST', '/site/schedules', { body: { wallet: wA.address, nonce, signature: sig } });
    expect(first.status).toBe(200);
    const replay = await call('POST', '/site/schedules', { body: { wallet: wA.address, nonce, signature: sig } });
    expect(replay.status).toBe(401); // the nonce died when it was consumed
  });

  it('refuses a STALE nonce (expired before use)', async () => {
    const wA = makeWallet();
    const nonce = await getNonce();
    clock += 5 * 60_000 + 1; // past the nonce TTL
    const r = await call('POST', '/site/schedules', { body: { wallet: wA.address, nonce, signature: wA.sign(challengeMessage(nonce)) } });
    expect(r.status).toBe(401);
  });

  it('refuses a signature for a DIFFERENT wallet', async () => {
    const wA = makeWallet();
    const attacker = makeWallet();
    const nonce = await getNonce();
    // Claim wallet A, but sign with the attacker's key.
    const r = await call('POST', '/site/schedules', { body: { wallet: wA.address, nonce, signature: attacker.sign(challengeMessage(nonce)) } });
    expect(r.status).toBe(401);
  });
});

describe('site bridge — SECRET gate', () => {
  it('refuses when the shared secret is missing or wrong', async () => {
    expect((await call('GET', '/site/challenge', { secret: null })).status).toBe(401);
    expect((await call('GET', '/site/challenge', { secret: 'wrong-but-long-enough-string-xx' })).status).toBe(401);
    expect((await call('GET', '/site/challenge')).status).toBe(200); // correct secret
  });

  it('SITE_BRIDGE_SECRET never reaches a serialized log line (scrubber covers it)', () => {
    const chunks: string[] = [];
    const stream = { write: (s: string) => void chunks.push(s) };
    // The SAME redact paths the real logger uses (exported from ops/logger).
    const testLog = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream as unknown as NodeJS.WritableStream);
    testLog.info({ headers: { 'x-site-bridge-secret': SECRET } }, 'incoming request');
    testLog.info({ SITE_BRIDGE_SECRET: SECRET }, 'config loaded');
    testLog.info({ req: { headers: { 'x-site-bridge-secret': SECRET } } }, 'nested');
    const out = chunks.join('');
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[REDACTED]');
  });
});

describe('site bridge — NO mutation over this channel', () => {
  it('no /site/* route changes a schedule (structurally read-only)', async () => {
    const wA = makeWallet();
    const codeA = codes.issue(USER_A);
    await call('POST', '/site/link', { body: { wallet: wA.address, code: codeA, signature: wA.sign(linkMessage(wA.address, codeA)) } });
    const id = await seedSchedule(USER_A);
    const before = await repo.getSchedule(id);

    // Exercise every endpoint, including attempts to smuggle mutation-shaped fields.
    const nonce = await getNonce();
    await call('POST', '/site/schedules', { body: { wallet: wA.address, nonce, signature: wA.sign(challengeMessage(nonce)), state: 'paused', amountRaw: '0' } });
    const reCode = codes.issue(USER_A);
    await call('POST', '/site/link', { body: { wallet: wA.address, code: reCode, signature: wA.sign(linkMessage(wA.address, reCode)) } });
    await call('POST', '/site/schedules/pause', { body: { id } }); // no such route
    await call('DELETE', `/site/schedules`, { body: { id } });

    const after = await repo.getSchedule(id);
    expect(after).toEqual(before); // the schedule is byte-for-byte unchanged
    expect(after!.state).toBe('active');
  });

  it('ignores non-/site paths (lets other handlers run)', () => {
    const { res } = mockRes();
    const req = mockReq('GET', '/health', {});
    expect(route(req, res)).toBe(false);
  });
});
