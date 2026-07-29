import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.js';
import { createLogger } from '../src/ops/logger.js';
import { encodeBase58 } from '../src/trade/base58.js';
import { LinkCodeStore, NonceStore } from '../src/site-bridge/store.js';
import { createSiteBridgeRoute } from '../src/site-bridge/routes.js';
import { challengeMessage } from '../src/site-bridge/messages.js';
import { SITE_EXECUTION_LIMIT, type SiteDashboard } from '../src/site-bridge/dashboard-contract.js';
import { LIVE_BANNER, DRY_BANNER, KEY_MODE_BANNER, WALLET_MODE_BANNER } from '../src/telegram/trade-panel/render.js';
import { buildDigest } from '../src/telegram/trade-digest.js';
import type { Mint } from '../src/core/types.js';

/**
 * PHASE 9 (read) — the website's dashboard.
 *
 * The claim is that the site can render THE SAME PICTURE the Telegram panel renders, for the same
 * person, without being told anything the panel would not tell them and without being told anything
 * about anyone else. Four things follow, and each has its own section below:
 *
 *   1. the picture is complete — schedules, caps and spend, executions, halts, the 24h figures;
 *   2. the banner is right, because it is the single fact a person managing money from a browser
 *      most needs and the one they cannot infer from anything else on the page;
 *   3. it is ONLY theirs;
 *   4. it carries no secret — no custodial address, no balance derived from one, nothing key-shaped.
 */

const SECRET = 'super-secret-bridge-value-0123456789';
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const MINT2 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Mint;
const USER_A = 111;
const USER_B = 222;
const SOL = 1_000_000_000n;
const log = createLogger('silent' as 'info', false);

function makeWallet(): { address: string; sign: (m: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    address: encodeBase58(new Uint8Array(rawPub)),
    sign: (m) => encodeBase58(new Uint8Array(sign(null, Buffer.from(m, 'utf8'), privateKey))),
  };
}

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
let nonces: NonceStore;
let route: (req: unknown, res: unknown) => boolean;
let clock: number;
let wallet: ReturnType<typeof makeWallet>;
let walletB: ReturnType<typeof makeWallet>;

/** Mount the bridge. `tradeLive` is a parameter because it is the thing under test in §2. */
function mount(opts: { tradeLive?: boolean; symbol?: string | null } = {}): void {
  const r = createSiteBridgeRoute({
    repo,
    codes: new LinkCodeStore(10 * 60_000, () => clock),
    nonces,
    secret: SECRET,
    log,
    now: () => clock,
    dashboard: {
      tradeLive: opts.tradeLive ?? false,
      defaultMint: MINT,
      symbolOf: async () => opts.symbol ?? null,
    },
  });
  route = r as unknown as (req: unknown, res: unknown) => boolean;
}

beforeEach(async () => {
  clock = 1_700_000_000_000;
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-dash-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  for (const u of [USER_A, USER_B]) {
    await repo.addAutotraderUser(u, `u${u}`, 1);
    await repo.setAutotraderMode(u, 'key'); // the custodial half — the one with schedules
  }
  nonces = new NonceStore(5 * 60_000, () => clock);
  wallet = makeWallet();
  walletB = makeWallet();
  await repo.linkSite(USER_A, wallet.address);
  await repo.linkSite(USER_B, walletB.address);
  mount();
});
afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = mockReq(method, path, { 'x-site-bridge-secret': SECRET });
  const { res, done } = mockRes();
  route(req, res);
  if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }
  await done;
  const raw = (res as { body: string }).body;
  return { status: (res as { statusCode: number }).statusCode, json: raw ? JSON.parse(raw) : {} };
}

/** The full signed read, as the site performs it. */
async function dashboard(w: ReturnType<typeof makeWallet> = wallet): Promise<SiteDashboard> {
  const nonce = (await call('GET', '/site/challenge')).json.nonce as string;
  const r = await call('POST', '/site/schedules', { wallet: w.address, nonce, signature: w.sign(challengeMessage(nonce)) });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as unknown as SiteDashboard;
}

async function seedSchedule(userId: number, over: { mint?: Mint; interval?: number } = {}): Promise<number> {
  return repo.createSchedule({
    userId, mint: over.mint ?? MINT, side: 'buy', amountRaw: SOL / 10n, amountKind: 'absolute',
    intervalMinutes: over.interval ?? 60, firstRunAt: clock,
  });
}

/** An execution in a given end state, the way the executor leaves one. */
async function seedExecution(
  scheduleId: number,
  userId: number,
  at: number,
  outcome: { state: 'confirmed' | 'failed' | 'UNKNOWN'; usdValue?: number; priceUsd?: number; signature?: string },
): Promise<number> {
  const id = (await repo.claimExecution(scheduleId, userId, at))!;
  await repo.settleExecution(id, {
    state: outcome.state,
    signature: outcome.signature ?? `sig-${id}`,
    inRaw: 100_000_000n,
    outRaw: 4_200_000n,
    usdValue: outcome.usdValue ?? 20,
    priceUsd: outcome.priceUsd ?? 0.0001,
  });
  return id;
}

// ── 1. THE WHOLE PICTURE ──────────────────────────────────────────────────────────────────────

describe('site dashboard — everything the panel shows', () => {
  it('returns schedules, caps, spend, executions, halts and the 24h figures in one read', async () => {
    const active = await seedSchedule(USER_A);
    const halted = await seedSchedule(USER_A);
    await repo.haltSchedule(halted, 'daily cap $200 reached', clock);
    await repo.setCaps({ userId: USER_A, mint: MINT, maxPerExecUsd: 50, maxPerDayUsd: 200, maxLifetimeUsd: 500 });
    const execId = await seedExecution(active, USER_A, clock - 3_600_000, { state: 'confirmed', usdValue: 20 });

    const d = await dashboard();
    expect(d.linked).toBe(true);

    // Schedules, with everything the panel renders per row.
    expect(d.schedules).toHaveLength(2);
    const a = d.schedules.find((s) => s.id === active)!;
    expect(a).toMatchObject({
      mint: MINT, side: 'buy', amountKind: 'absolute',
      amountRaw: (SOL / 10n).toString(), // INVARIANT 6: raw integers cross as strings
      intervalMinutes: 60, state: 'active',
    });
    expect(a.nextRunAt).toBeGreaterThan(0);
    expect(a.lastExecution?.id).toBe(execId); // the panel's "last … → … at HH:MM" row
    expect(a.lastExecution?.signature).toBe(`sig-${execId}`);

    // The halt reason, verbatim — the site shows the same sentence the panel does.
    const h = d.schedules.find((s) => s.id === halted)!;
    expect(h.state).toBe('halted');
    expect(h.haltReason).toBe('daily cap $200 reached');

    // Caps for the contract mint, and the spend against each.
    expect(d.caps).toEqual({ perExecUsd: 50, perDayUsd: 200, lifetimeUsd: 500 });
    expect(d.spend!.todayUsd).toBe(20);
    expect(d.spend!.lifetimeUsd).toBe(20);

    // The execution strip.
    expect(d.executions).toHaveLength(1);
    expect(d.executions[0]).toMatchObject({ id: execId, scheduleId: active, state: 'confirmed', usdValue: 20 });
    expect(d.executions[0]!.inRaw).toBe('100000000'); // string, not a rounded number

    // The digest figures.
    expect(d.digest).toMatchObject({ executions: 1, confirmed: 1, failed: 0, unknown: 0, spentUsd: 20 });
    expect(d.digest!.halted).toEqual([{ id: halted, haltReason: 'daily cap $200 reached' }]);

    // The contract, and the bot's clock to count down against.
    expect(d.contract).toEqual({ mint: MINT, symbol: MINT.slice(0, 4) });
    expect(d.serverTime).toBe(clock);
  });

  it('the digest figures are the DM’s figures — one computation, two renderings', async () => {
    const id = await seedSchedule(USER_A);
    await seedExecution(id, USER_A, clock - 1_000, { state: 'confirmed', usdValue: 20, priceUsd: 0.0002 });
    await seedExecution(id, USER_A, clock - 2_000, { state: 'UNKNOWN', usdValue: 12, priceUsd: 0.0003 });
    await seedExecution(id, USER_A, clock - 3_000, { state: 'failed', usdValue: 0, priceUsd: 0.0001 });

    const d = await dashboard();
    expect(d.digest).toMatchObject({ executions: 3, confirmed: 1, unknown: 1, failed: 1 });
    // CONFIRMED + UNKNOWN, the cap's own rule: an UNKNOWN may have spent (INVARIANT 16).
    expect(d.digest!.spentUsd).toBe(32);
    expect(d.digest!.avgTradeUsd).toBe(16);

    // The DM renders from the same numbers, so its text agrees with the dashboard's figures.
    const dm = buildDigest({
      executions: await repo.executionsSince(USER_A, clock - 86_400_000),
      settingChanges: 0,
      halted: [],
      solBalanceLamports: null,
    })!;
    expect(dm).toContain('3 execution(s)');
    expect(dm).toContain('1 ⚠️ UNKNOWN');
    expect(dm).toContain('$32.00');
  });

  it('counts setting changes from BOTH surfaces in the window', async () => {
    await repo.recordSettingChange({ userId: USER_A, action: 'schedule.pause', scheduleId: 1, field: null, fromValue: 'active', toValue: 'paused' });
    await repo.recordSettingChange({ userId: USER_A, action: 'caps', scheduleId: null, field: null, fromValue: null, toValue: '$50/$200/none', source: 'site' });
    await seedSchedule(USER_A);
    expect((await dashboard()).digest!.settingChanges).toBe(2);
  });

  it('caps and spend follow the user’s CONTRACT, not whichever mint a schedule happens to use', async () => {
    await repo.setContract(USER_A, MINT2);
    await repo.setCaps({ userId: USER_A, mint: MINT2, maxPerExecUsd: 10, maxPerDayUsd: 30, maxLifetimeUsd: null });
    await seedSchedule(USER_A, { mint: MINT }); // an old schedule on the previous contract

    const d = await dashboard();
    expect(d.contract!.mint).toBe(MINT2);
    expect(d.caps).toEqual({ perExecUsd: 10, perDayUsd: 30, lifetimeUsd: null });
    // ...while the schedule row still carries the caps for ITS OWN mint, which is what governs it.
    expect(d.schedules[0]!.mint).toBe(MINT);
    expect(d.schedules[0]!.caps).toBeNull();
  });

  it('caps unset reads as null, never as zero — "no cap" and "a $0 cap" are opposites', async () => {
    await seedSchedule(USER_A);
    const d = await dashboard();
    expect(d.caps).toBeNull();
    expect(d.spend).toEqual({ todayUsd: 0, lifetimeUsd: 0 });
  });

  it('caps the execution strip at the documented limit', async () => {
    const id = await seedSchedule(USER_A);
    for (let i = 0; i < SITE_EXECUTION_LIMIT + 4; i++) {
      await seedExecution(id, USER_A, clock - i * 60_000, { state: 'confirmed' });
    }
    const d = await dashboard();
    expect(d.executions).toHaveLength(SITE_EXECUTION_LIMIT);
  });

  it('uses the token symbol when the metadata cache has one, and the panel’s fallback when it does not', async () => {
    await seedSchedule(USER_A);
    mount({ symbol: 'RICE' });
    expect((await dashboard()).contract!.symbol).toBe('$RICE');

    mount({ symbol: null });
    expect((await dashboard()).contract!.symbol).toBe(MINT.slice(0, 4));
  });
});

// ── 2. THE BANNER ─────────────────────────────────────────────────────────────────────────────

/**
 * RULE A, over the wire. The site must be able to say 🔴 LIVE vs 🟡 DRY RUN as unmissably as the
 * panel does — and the failure this guards is the quiet one: a dashboard that renders DRY RUN while
 * the bot is spending real money. Absence of a warning is not a signal.
 */
describe('site dashboard — the banner', () => {
  it('reflects TRADE_LIVE, in both the boolean and the bot’s own sentence', async () => {
    await seedSchedule(USER_A);

    mount({ tradeLive: true });
    const live = await dashboard();
    expect(live.banner.tradeLive).toBe(true);
    expect(live.banner.text).toBe(LIVE_BANNER);
    expect(live.banner.text).toContain('LIVE');

    mount({ tradeLive: false });
    const dry = await dashboard();
    expect(dry.banner.tradeLive).toBe(false);
    expect(dry.banner.text).toBe(DRY_BANNER);
    expect(dry.banner.text).toContain('DRY RUN');
  });

  it('states WHO HOLDS THE KEY, and follows a mode switch immediately', async () => {
    await seedSchedule(USER_A);
    const asKey = await dashboard();
    expect(asKey.banner.mode).toBe('key');
    expect(asKey.banner.modeText).toBe(KEY_MODE_BANNER);
    expect(asKey.banner.modeText).toContain('I hold an encrypted key');

    await repo.setAutotraderMode(USER_A, 'wallet');
    const asWallet = await dashboard();
    expect(asWallet.banner.mode).toBe('wallet');
    expect(asWallet.banner.modeText).toBe(WALLET_MODE_BANNER);
    expect(asWallet.banner.modeText).toContain('I hold nothing');
  });

  it('is present even for an UNLINKED wallet — whether the bot trades live is not a private fact', async () => {
    mount({ tradeLive: true });
    const stranger = makeWallet();
    const d = await dashboard(stranger);
    expect(d.linked).toBe(false);
    expect(d.banner.tradeLive).toBe(true);
    expect(d.banner.text).toBe(LIVE_BANNER);
    // ...and nothing else, because there is nobody to show anything about.
    expect(d.schedules).toEqual([]);
    expect(d.executions).toEqual([]);
    expect(d.digest).toBeNull();
    expect(d.contract).toBeNull();
  });

  it('WALLET MODE returns the wallet-mode dashboard, not the custodial one with empty rows', async () => {
    // The panel renders a different panel in wallet mode; the site gets the same treatment. A
    // wallet-mode member's custodial schedules are never ticked, so listing them on a dashboard —
    // beside controls that would refuse — would describe machinery that is not running.
    const id = await seedSchedule(USER_A);
    await repo.setAutotraderMode(USER_A, 'wallet');

    const d = await dashboard();
    expect(d.linked).toBe(true);
    expect(d.schedules).toEqual([]);
    expect(d.caps).toBeNull();
    expect(d.digest).toBeNull();
    expect(d.walletMode).not.toBeNull();
    expect(d.walletMode!.linkedWallet).toBe(wallet.address); // the address they just signed with
    expect(d.walletMode!.recentBuys).toEqual([]);
    expect(await repo.getSchedule(id)).not.toBeNull(); // hidden from the view, not deleted
  });
});

// ── 3. ONLY THEIRS ────────────────────────────────────────────────────────────────────────────

describe('site dashboard — only the linked user’s own data', () => {
  it('never leaks another user’s schedules, executions, caps or halts', async () => {
    const mine = await seedSchedule(USER_A);
    await repo.setCaps({ userId: USER_A, mint: MINT, maxPerExecUsd: 5, maxPerDayUsd: 25, maxLifetimeUsd: null });
    await seedExecution(mine, USER_A, clock - 1_000, { state: 'confirmed', usdValue: 3 });

    const theirs = await seedSchedule(USER_B);
    await repo.haltSchedule(theirs, 'THEIR SECRET HALT', clock);
    await repo.setCaps({ userId: USER_B, mint: MINT, maxPerExecUsd: 999, maxPerDayUsd: 9999, maxLifetimeUsd: 99999 });
    await seedExecution(theirs, USER_B, clock - 2_000, { state: 'confirmed', usdValue: 777, signature: 'THEIR-SIG' });
    await repo.recordSettingChange({ userId: USER_B, action: 'caps', scheduleId: null, field: null, fromValue: null, toValue: 'theirs' });

    const d = await dashboard();
    expect(d.schedules.map((s) => s.id)).toEqual([mine]);
    expect(d.executions.map((e) => e.scheduleId)).toEqual([mine]);
    expect(d.caps).toEqual({ perExecUsd: 5, perDayUsd: 25, lifetimeUsd: null });
    expect(d.spend!.todayUsd).toBe(3); // not 780
    expect(d.digest).toMatchObject({ executions: 1, settingChanges: 0 });
    expect(d.digest!.halted).toEqual([]);

    // Nothing of B's appears anywhere in the payload, at any depth.
    const body = JSON.stringify(d);
    expect(body).not.toContain('THEIR SECRET HALT');
    expect(body).not.toContain('THEIR-SIG');
    expect(body).not.toContain('777');
    expect(body).not.toContain(walletB.address);
  });

  it('the acting user comes from the SIGNATURE, not from anything in the body', async () => {
    const mine = await seedSchedule(USER_A);
    const theirs = await seedSchedule(USER_B);
    const nonce = (await call('GET', '/site/challenge')).json.nonce as string;

    // A body naming user B, signed by A's wallet. The claim is ignored; A's own view comes back.
    const r = await call('POST', '/site/schedules', {
      wallet: wallet.address, nonce, signature: wallet.sign(challengeMessage(nonce)),
      userId: USER_B, scheduleId: theirs, telegram_user_id: USER_B,
    });
    const d = r.json as unknown as SiteDashboard;
    expect(d.schedules.map((s) => s.id)).toEqual([mine]);
  });
});

// ── 4. NO SECRET ──────────────────────────────────────────────────────────────────────────────

describe('site dashboard — nothing secret crosses', () => {
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

  it('carries no key-, secret- or passphrase-shaped field anywhere in the payload', async () => {
    const id = await seedSchedule(USER_A);
    await repo.setCaps({ userId: USER_A, mint: MINT, maxPerExecUsd: 50, maxPerDayUsd: 200, maxLifetimeUsd: 500 });
    await seedExecution(id, USER_A, clock - 1_000, { state: 'UNKNOWN' });
    await repo.haltSchedule(id, 'UNKNOWN outcome for execution 1 (sig-1)', clock);

    for (const d of [await dashboard(), await dashboard(makeWallet())]) {
      for (const name of fieldNames(d)) {
        expect(/key|secret|passphrase|mnemonic|seed|private/i.test(name), `field "${name}"`).toBe(false);
      }
      expect(JSON.stringify(d)).not.toContain(SECRET);
    }
  });

  it('discloses NO custodial address and no balance derived from one', async () => {
    await seedSchedule(USER_A);
    const d = await dashboard();
    const body = JSON.stringify(d);

    // The panel shows the keystore's address and its SOL/token balances. Those are facts about a
    // key the bot holds, and the bridge has no keystore access to get them with — by design.
    expect(body).not.toMatch(/pubkey|solBalance|tokenBalance|walletUnlocked|unlocked/i);
    // The one address that does come back in wallet mode is the caller's own, which they just
    // proved by signing — telling someone their own address discloses nothing.
    await repo.setAutotraderMode(USER_A, 'wallet');
    expect((await dashboard()).walletMode!.linkedWallet).toBe(wallet.address);
  });

  it('the contract file the site imports has no imports of its own', async () => {
    // It is copied into another repo, so anything it depended on would have to travel with it —
    // and a contract that drags runtime code along stops being just a description of a payload.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(join(import.meta.dirname, '..', 'src/site-bridge/dashboard-contract.ts'), 'utf8'),
    );
    expect(src).not.toMatch(/^import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
  });
});
