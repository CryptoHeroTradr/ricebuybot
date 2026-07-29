import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.js';
import { createLogger } from '../src/ops/logger.js';
import { LinkCodeStore, NonceStore } from '../src/site-bridge/store.js';
import { createSiteBridgeRoute } from '../src/site-bridge/routes.js';
import { verifyInitData, MAX_INIT_DATA_AGE_MS } from '../src/site-bridge/init-data.js';

/**
 * PHASE 8 — the Mini App path.
 *
 * The claim this file exists to keep honest is the phase's own: on the wallet-mode path the bot's
 * server NEVER SEES A KEY AND NEVER SIGNS. Its entire role is to open a webview and, through the
 * read bridge, answer "which wallet is this Telegram user's".
 *
 * Two kinds of test, because the claim has two halves:
 *   * behavioural — the identity endpoint verifies Telegram's signature properly, returns nothing
 *     but an address, and refuses everything it cannot verify;
 *   * structural — a grep over the whole Mini App server path proving no signer, keypair or
 *     signing primitive is reachable from it. That one fails if a future change adds one, which is
 *     the point: the invariant is enforced by a test, not by everyone remembering.
 */

const SECRET = 'super-secret-bridge-value-0123456789';
const BOT_TOKEN = '7654321:AAH-fake-bot-token-for-tests-only-xyz';
const USER = 4242;
const WALLET = 'RiceViL1agerWa11etAAAAAAAAAAAAAAAAAAAAAAAAAA';
const log = createLogger('silent' as 'info', false);

/** Build an initData query string signed the way Telegram signs one. */
function makeInitData(
  fields: Record<string, string>,
  botToken: string = BOT_TOKEN,
): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  const qs = new URLSearchParams(fields);
  qs.set('hash', hash);
  return qs.toString();
}

function validFields(nowMs: number, userId = USER): Record<string, string> {
  return {
    auth_date: String(Math.floor(nowMs / 1000)),
    query_id: 'AAHtest',
    user: JSON.stringify({ id: userId, first_name: 'Rice', username: 'ricevillager' }),
  };
}

// ── mock http, same shape as the site-bridge suite ────────────────────────────────────────────
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
let route: (req: unknown, res: unknown) => boolean;
let clock: number;

async function mount(opts: { botToken?: string | undefined } = {}): Promise<void> {
  const r = createSiteBridgeRoute({
    repo,
    codes: new LinkCodeStore(10 * 60_000, () => clock),
    nonces: new NonceStore(5 * 60_000, () => clock),
    secret: SECRET,
    log,
    now: () => clock,
    dashboard: { tradeLive: false, defaultMint: 'So11111111111111111111111111111111111111112' },
    botToken: 'botToken' in opts ? opts.botToken : BOT_TOKEN,
  });
  route = r as unknown as (req: unknown, res: unknown) => boolean;
}

beforeEach(async () => {
  clock = 1_800_000_000_000;
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-tma-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  await repo.addAutotraderUser(USER, 'villager', 1);
  await mount();
});
afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

interface CallResult { status: number; json: Record<string, unknown> | null }
async function call(body: unknown, secret: string | null = SECRET): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (secret !== null) headers['x-site-bridge-secret'] = secret;
  const req = mockReq('POST', '/site/tma-wallet', headers);
  const { res, done } = mockRes();
  route(req, res);
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await done;
  const raw = (res as { body: string }).body;
  return { status: (res as { statusCode: number }).statusCode, json: raw ? JSON.parse(raw) : null };
}

// ==========================================================================================
// initData verification — the only thing that says who is asking
// ==========================================================================================

describe('Telegram initData verification', () => {
  it('accepts a genuinely signed payload and extracts the user id', () => {
    const v = verifyInitData(makeInitData(validFields(clock)), BOT_TOKEN, clock);
    expect(v).toMatchObject({ ok: true, userId: USER });
  });

  it('REJECTS a payload signed with a different bot token', () => {
    const forged = makeInitData(validFields(clock), '1111111:some-other-bots-token');
    expect(verifyInitData(forged, BOT_TOKEN, clock)).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('REJECTS a tampered user id — the signature covers the whole payload', () => {
    // Sign as user 4242, then swap the user field for somebody else's. This is the attack the
    // signature exists to stop: reading another villager's linked wallet by editing one field.
    const genuine = makeInitData(validFields(clock, USER));
    const params = new URLSearchParams(genuine);
    params.set('user', JSON.stringify({ id: 9999, first_name: 'Mallory' }));
    expect(verifyInitData(params.toString(), BOT_TOKEN, clock)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('REJECTS a stale payload — a signature never expires, so freshness is checked separately', () => {
    const old = clock - MAX_INIT_DATA_AGE_MS - 60_000;
    const initData = makeInitData(validFields(old));
    // It is perfectly well signed…
    expect(verifyInitData(initData, BOT_TOKEN, old)).toMatchObject({ ok: true });
    // …and still refused now, because a captured blob must not be a permanent credential.
    expect(verifyInitData(initData, BOT_TOKEN, clock)).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('refuses malformed, hash-less and user-less input instead of throwing', () => {
    expect(verifyInitData('', BOT_TOKEN, clock).ok).toBe(false);
    expect(verifyInitData('not-a-query-string', BOT_TOKEN, clock)).toMatchObject({ reason: 'no-hash' });
    const noUser = makeInitData({ auth_date: String(Math.floor(clock / 1000)) });
    expect(verifyInitData(noUser, BOT_TOKEN, clock)).toMatchObject({ ok: false, reason: 'no-user' });
  });

  it('refuses when there is no bot token to check against — never falls open', () => {
    expect(verifyInitData(makeInitData(validFields(clock)), '', clock)).toMatchObject({ ok: false });
  });
});

// ==========================================================================================
// The endpoint — an address, and nothing else
// ==========================================================================================

describe('POST /site/tma-wallet', () => {
  it('returns the linked wallet for a verified Telegram user', async () => {
    await repo.linkSite(USER, WALLET);
    const r = await call({ initData: makeInitData(validFields(clock)) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, linked: true, wallet: WALLET, mode: 'wallet' });
  });

  it('says "not linked" rather than inventing one', async () => {
    const r = await call({ initData: makeInitData(validFields(clock)) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, linked: false, wallet: null });
  });

  it('RETURNS NOTHING BUT AN ADDRESS — no key material, no secret, no schedule', async () => {
    await repo.linkSite(USER, WALLET);
    const r = await call({ initData: makeInitData(validFields(clock)) });
    // The response is the contract. Anything beyond these four keys is a widening of what the
    // Mini App path is allowed to learn, and should have to be argued for.
    expect(Object.keys(r.json!).sort()).toEqual(['linked', 'mode', 'ok', 'wallet']);
    const body = JSON.stringify(r.json);
    for (const forbidden of ['secret', 'key', 'token', 'passphrase', 'signature', 'initData']) {
      expect(body.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('refuses a forged session with 401 and does NOT say which part was wrong', async () => {
    const forged = makeInitData(validFields(clock), '1111111:other-token');
    const r = await call({ initData: forged });
    expect(r.status).toBe(401);
    // The reason ('bad-signature' vs 'stale') is logged, never returned — it tells a forger which
    // half of the forgery to fix.
    expect(JSON.stringify(r.json)).not.toMatch(/signature|stale|hash/i);
  });

  it('still requires the shared secret — the Mini App route is not a public door', async () => {
    const r = await call({ initData: makeInitData(validFields(clock)) }, null);
    expect(r.status).toBe(401);
  });

  it('is NOT MOUNTED AT ALL without a bot token — identity that cannot be verified is absent, not degraded', async () => {
    await mount({ botToken: undefined });
    const r = await call({ initData: makeInitData(validFields(clock)) });
    expect(r.status).toBe(404);
  });

  it('a wallet linked to a DIFFERENT user is never returned', async () => {
    const other = 5555;
    await repo.addAutotraderUser(other, 'other', 1);
    await repo.linkSite(other, WALLET);
    const r = await call({ initData: makeInitData(validFields(clock)) }); // asking as USER
    expect(r.json).toMatchObject({ linked: false, wallet: null });
  });
});

// ==========================================================================================
// THE STRUCTURAL PROOF — no signer anywhere on the Mini App server path
// ==========================================================================================

describe('the Mini App server path holds no key and cannot sign', () => {
  /**
   * The files that make up the bot's entire server-side involvement in the Mini App path. If this
   * list ever needs to grow, that growth is itself the thing to scrutinise: the bot's job here is
   * to open a webview and answer one read.
   */
  const MINI_APP_PATH = [
    'src/site-bridge/init-data.ts',
    'src/site-bridge/routes.ts',
    'src/site-bridge/store.ts',
    'src/site-bridge/verify.ts',
    'src/site-bridge/messages.ts',
    'src/site-bridge/command.ts',
    'src/site-bridge/mutations.ts',
    'src/site-bridge/dashboard.ts',
    'src/site-bridge/dashboard-contract.ts',
    'src/telegram/dca-command.ts',
  ];

  /**
   * Signing primitives. Matching the phase brief's own instruction — "confirm by grep: no signer,
   * no keypair, in the Mini App server path" — made executable so it is confirmed on every run
   * rather than once by a reviewer.
   */
  const SIGNING_PRIMITIVES = [
    'Keypair',
    'secretKey',
    'privateKey',
    'partialSign',
    'sendTransaction',
    'signTransaction',
    'signAllTransactions',
    'Signer',
    'keystore',
    'Keystore',
    'decryptKey',
    'nacl.sign',
  ];

  const root = join(import.meta.dirname, '..');

  it('imports no signer and names no signing primitive', () => {
    for (const rel of MINI_APP_PATH) {
      const src = readFileSync(join(root, rel), 'utf8');
      // Strip comments: this file's own prose says "never signs", and a grep that trips on the
      // documentation of an invariant teaches people to delete the documentation.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const primitive of SIGNING_PRIMITIVES) {
        expect(code, `${rel} references \`${primitive}\` — the Mini App path must not be able to sign`).not.toContain(primitive);
      }
    }
  });

  it('pulls no RUNTIME code from src/trade/ except the allowlist gate and base58', () => {
    for (const rel of MINI_APP_PATH) {
      const src = readFileSync(join(root, rel), 'utf8');

      // TYPE-ONLY imports are exempt, and the distinction is the whole point rather than a
      // loophole. `import type` is erased by the compiler: it produces no require, pulls in no
      // module, and cannot execute. A `Schedule` shape describing what the read bridge returns is
      // a description of data. A VALUE import is a live edge to code that can run — which is the
      // thing that could one day sign — so those stay restricted.
      const valueImports = [...src.matchAll(/^import\s+(?!type\s)([\s\S]*?)from\s+'([^']+)';/gm)]
        .filter((m) => !/^\s*\{\s*type\s/.test(m[1] as string))
        .map((m) => m[2] as string);

      for (const spec of valueImports) {
        if (!spec.includes('trade/')) continue;
        // access.js is the membership check (may this user use the autotrader at all).
        // base58.js is pure encoding, used to VERIFY a wallet's signature — never to make one.
        expect(
          spec.endsWith('trade/access.js') || spec.endsWith('trade/base58.js'),
          `${rel} imports ${spec} from src/trade/ as runtime code — only the allowlist gate and base58 belong here`,
        ).toBe(true);
      }
    }
  });

  /**
   * PHASE 9 gave the bridge a write path, and it reaches the Telegram panel's command layer. That
   * edge is the POINT of the phase — one command layer, two entry points — but it is also the only
   * runtime edge out of `site-bridge/` into the rest of the bot, and an edge nobody declared is an
   * edge nobody notices growing. So it is named here: a second one has to be argued for, not
   * discovered later.
   *
   * Note what this does NOT claim. `trade-panel/commands.ts` itself imports `trade/executor.ts` for
   * the $1 minimum-buy constant, so the module graph reachable from the bridge does now include
   * trading code. That is not what keeps a key safe and never was: the bot has always loaded the
   * signer, and what stops the bridge signing is that it holds no passphrase, unlocks nothing and
   * calls nothing that could. The greps above stay pointed at the thing that would actually change
   * — this path naming a signing primitive itself.
   */
  it('leaves src/site-bridge/ by exactly one declared runtime edge', () => {
    const ALLOWED_OUTBOUND = [
      '../trade/access.js', // the allowlist gate
      '../trade/base58.js', // pure encoding, to VERIFY a wallet signature — never to make one
      '../telegram/trade-panel/commands.js', // PHASE 9 (write): the shared command layer
      // PHASE 9 (read): the dashboard returns the panel's own picture, so it reads the panel's own
      // words and the digest's own arithmetic rather than keeping second copies of either. Both are
      // PURE — render.ts is (data -> text) with no I/O by construction, and digestFigures is an
      // array in, numbers out. Neither can reach a key, and the most important warning in the
      // product cannot be reworded on one surface only if it exists in exactly one place.
      '../telegram/trade-panel/render.js',
      '../telegram/trade-digest.js',
    ];
    const dirPath = join(root, 'src/site-bridge');
    for (const file of readdirSync(dirPath).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(dirPath, file), 'utf8');
      const valueImports = [...src.matchAll(/^import\s+(?!type\s)([\s\S]*?)from\s+'([^']+)';/gm)]
        .filter((m) => !/^\s*\{\s*type\s/.test(m[1] as string))
        .map((m) => m[2] as string)
        .filter((spec) => spec.startsWith('../')); // './x.js' is inside the bridge
      for (const spec of valueImports) {
        expect(
          ALLOWED_OUTBOUND.includes(spec),
          `src/site-bridge/${file} imports ${spec} as runtime code — a NEW edge out of the bridge`,
        ).toBe(true);
      }
    }
  });

  it('the whole site-bridge directory is covered by the list above', () => {
    // A new file dropped into site-bridge/ would otherwise be exempt from every check in this
    // describe block simply by not being named in it.
    const dirPath = join(root, 'src/site-bridge');
    const onDisk = readdirSync(dirPath)
      .filter((f) => f.endsWith('.ts') && statSync(join(dirPath, f)).isFile())
      .map((f) => `src/site-bridge/${f}`)
      .sort();
    const covered = MINI_APP_PATH.filter((p) => p.startsWith('src/site-bridge/')).sort();
    expect(onDisk, 'a new src/site-bridge/ file is not covered by the no-signer check — add it to MINI_APP_PATH').toEqual(covered);
  });
});
