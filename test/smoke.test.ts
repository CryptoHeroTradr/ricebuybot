import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config/index.js';
import { TIERS, TIER_NAMES, DEFAULT_TIER_POLICY, pickTier } from '../src/core/tiers.js';
import { lamportsToSol, rawAmount, toFloat } from '../src/core/money.js';
import { InFlight, Shutdown } from '../src/ops/lifecycle.js';
import { createLogger, scrub, scrubUrl } from '../src/ops/logger.js';
import { startHealthServer } from '../src/ops/health.js';

const VALID_ENV = {
  TELEGRAM_BOT_TOKEN: '123456789:AAHplaceholderplaceholderplaceholder',
  HELIUS_API_KEY: '00000000-0000-0000-0000-000000000000',
  HELIUS_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=deadbeef',
  HELIUS_WS_URL: 'wss://atlas-mainnet.helius-rpc.com/?api-key=deadbeef',
  DEFAULT_MINT: '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump',
  DB_PATH: './data/test.db',
  MEDIA_ROOT: '/srv/media',
  DRY_RUN: 'true',
} satisfies NodeJS.ProcessEnv;

describe('config', () => {
  it('accepts a valid env and applies defaults', () => {
    const cfg = loadConfig(VALID_ENV);
    expect(cfg.HTTP_PORT).toBe(3012);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.MEDIA_SOURCE).toBe('local');
    expect(cfg.DRY_RUN).toBe(true);
    expect(cfg.BACKFILL_POSITIONS).toBe(true); // backfill is on by default (Phase 4)
  });

  it('reports EVERY problem at once, not just the first', () => {
    let caught: ConfigError | null = null;
    try {
      loadConfig({ HTTP_PORT: 'not-a-number', DEFAULT_MINT: 'nope' });
    } catch (err) {
      caught = err as ConfigError;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const problems = caught!.problems.join('\n');
    // All five missing required vars, plus both invalid ones.
    for (const name of [
      'TELEGRAM_BOT_TOKEN',
      'HELIUS_API_KEY',
      'HELIUS_RPC_URL',
      'HELIUS_WS_URL',
      'DEFAULT_MINT',
      'DB_PATH',
      'MEDIA_ROOT',
      'HTTP_PORT',
    ]) {
      expect(problems).toContain(name);
    }
  });

  it('never echoes a bad value back in the error (INVARIANT 5)', () => {
    const secret = '987654321:SUPERSECRETTOKENVALUEDONOTLEAKAAAAA';
    try {
      loadConfig({ ...VALID_ENV, TELEGRAM_BOT_TOKEN: secret, HTTP_PORT: 'bad' });
    } catch (err) {
      expect((err as ConfigError).message).not.toContain('SUPERSECRET');
      expect((err as ConfigError).message).not.toContain('bad');
    }
  });

  it('treats an empty env var as unset, not as an empty string', () => {
    // `.env.example` ships `MEDIA_MANIFEST_URL=`; Node's --env-file parser yields ''.
    // That must behave as "not set" and not trip the optional-URL check.
    const cfg = loadConfig({ ...VALID_ENV, MEDIA_MANIFEST_URL: '', LOG_LEVEL: '' });
    expect(cfg.MEDIA_MANIFEST_URL).toBeUndefined();
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('requires MEDIA_MANIFEST_URL when MEDIA_SOURCE=http', () => {
    expect(() => loadConfig({ ...VALID_ENV, MEDIA_SOURCE: 'http' })).toThrow(/MEDIA_MANIFEST_URL/);
    expect(() =>
      loadConfig({ ...VALID_ENV, MEDIA_SOURCE: 'http', MEDIA_MANIFEST_URL: 'https://x.test/m.json' }),
    ).not.toThrow();
  });

  it('requires MEDIA_VAULT_CHAT_ID unless DRY_RUN', () => {
    expect(() => loadConfig({ ...VALID_ENV, DRY_RUN: 'false' })).toThrow(/MEDIA_VAULT_CHAT_ID/);
    expect(() => loadConfig({ ...VALID_ENV, DRY_RUN: 'false', MEDIA_VAULT_CHAT_ID: '-1001' })).not.toThrow();
  });

  it('TRADE_LIVE defaults to false and is independent of DRY_RUN', () => {
    // Money is the explicit opt-in: absent means false.
    expect(loadConfig(VALID_ENV).TRADE_LIVE).toBe(false);

    // All four DRY_RUN × TRADE_LIVE combinations parse, and neither flag moves the other.
    const combos = [
      { DRY_RUN: 'true', TRADE_LIVE: 'false' },
      { DRY_RUN: 'true', TRADE_LIVE: 'true' },
      { DRY_RUN: 'false', TRADE_LIVE: 'false', MEDIA_VAULT_CHAT_ID: '-1001' },
      { DRY_RUN: 'false', TRADE_LIVE: 'true', MEDIA_VAULT_CHAT_ID: '-1001' },
    ] as const;
    for (const c of combos) {
      const cfg = loadConfig({ ...VALID_ENV, ...c });
      expect(cfg.DRY_RUN).toBe(c.DRY_RUN === 'true');
      expect(cfg.TRADE_LIVE).toBe(c.TRADE_LIVE === 'true'); // DRY_RUN never changes TRADE_LIVE
    }
  });
});

describe('tiers', () => {
  it('is always exactly the four canonical tiers', () => {
    expect(TIER_NAMES).toEqual(['Regular', 'Big', 'Whale', 'Massive']);
    expect(TIERS.map((t) => t.folder)).toEqual(['regular', 'big', 'whale', 'massive']);
  });

  it('drops a buy below min_buy_usd, and any non-finite amount', () => {
    const p = DEFAULT_TIER_POLICY;
    expect(pickTier(0, 0, p)).toBeNull();
    expect(pickTier(9.99, 0, p)).toBeNull();
    expect(pickTier(Number.NaN, 0, p)).toBeNull();
    // ...but a tiny buy from a whale is still below the floor. min_buy_usd is a filter
    // on the EVENT, and it is applied before any tier question is asked.
    expect(pickTier(1, 1_000_000, p)).toBeNull();
  });
});

describe('money (INVARIANT 6)', () => {
  it('converts raw integer units without float drift', () => {
    expect(lamportsToSol(1_000_000_000n)).toBe(1);
    expect(lamportsToSol(1_500_000_000n)).toBe(1.5);
    expect(lamportsToSol(1n)).toBe(1e-9);
    expect(toFloat(rawAmount(123_456n, 6))).toBe(0.123456);
    expect(toFloat(rawAmount(-250n, 2))).toBe(-2.5);
    expect(toFloat(rawAmount(42n, 0))).toBe(42);
  });

  it('survives amounts that would lose precision as a Number', () => {
    // 9_007_199_254_740_993 is Number.MAX_SAFE_INTEGER + 2 — unrepresentable as a float.
    expect(toFloat(rawAmount(9_007_199_254_740_993n, 9))).toBeCloseTo(9_007_199.254740993, 6);
  });
});

describe('logger (INVARIANT 5)', () => {
  it('strips the api key out of a Helius URL', () => {
    const scrubbed = scrubUrl('https://mainnet.helius-rpc.com/?api-key=abc123secret');
    expect(scrubbed).not.toContain('abc123secret');
    expect(scrubbed).toContain('api-key=REDACTED');
  });

  it('strips a bot token out of free text', () => {
    const msg = scrub('failed calling https://api.telegram.org/bot123456789:AAHsecretsecretsecretsecretsecret/getMe');
    expect(msg).not.toContain('AAHsecretsecretsecretsecretsecret');
    expect(msg).toContain('[REDACTED_BOT_TOKEN]');
  });

  it('does not throw on an unparseable url', () => {
    expect(scrubUrl('not a url')).toBe('[unparseable-url]');
  });

  it('builds a logger without touching the network', () => {
    expect(() => createLogger('silent' as 'info', false)).not.toThrow();
  });
});

describe('lifecycle', () => {
  it('drains in-flight work before resolving', async () => {
    const inFlight = new InFlight();
    let done = false;

    const work = inFlight.track(async () => {
      await new Promise((r) => setTimeout(r, 30));
      done = true;
    });

    expect(inFlight.count).toBe(1);
    const drained = await inFlight.drain(1_000);

    expect(drained).toBe(true);
    expect(done).toBe(true);
    expect(inFlight.count).toBe(0);
    await work;
  });

  it('refuses new work once draining', async () => {
    const inFlight = new InFlight();
    await inFlight.drain(10);
    await expect(inFlight.track(async () => 1)).rejects.toThrow(/shutting down/);
  });

  it('reports a timeout rather than hanging forever', async () => {
    const inFlight = new InFlight();
    void inFlight.track(() => new Promise((r) => setTimeout(r, 500)));
    expect(await inFlight.drain(20)).toBe(false);
  });

  it('runs shutdown hooks in reverse order and survives a throwing hook', async () => {
    const order: string[] = [];
    const s = new Shutdown();
    s.register('first', () => void order.push('first'));
    s.register('boom', () => {
      throw new Error('nope');
    });
    s.register('last', () => void order.push('last'));

    const failures: string[] = [];
    await s.run((name) => failures.push(name));

    expect(order).toEqual(['last', 'first']);
    expect(failures).toEqual(['boom']);
  });
});

describe('health server', () => {
  it('serves GET /health -> {ok:true,uptime:n}', async () => {
    const log = createLogger('silent' as 'info', false);
    const health = await startHealthServer(0, log);
    try {
      const res = await fetch(`http://127.0.0.1:${health.port}/health`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { ok: boolean; uptime: number };
      expect(body.ok).toBe(true);
      expect(typeof body.uptime).toBe('number');
      expect(body.uptime).toBeGreaterThanOrEqual(0);

      const missing = await fetch(`http://127.0.0.1:${health.port}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await health.close();
    }
  });
});
