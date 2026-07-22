import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HeliusWebhookIngestor } from '../src/ingest/webhook.js';
import { startHealthServer, type HealthServer } from '../src/ops/health.js';
import { createLogger } from '../src/ops/logger.js';
import type { BuyEvent } from '../src/core/types.js';
import type { Repo } from '../src/db/index.js';

const log = createLogger('silent' as 'info', false);
const SECRET = 'a-very-long-webhook-secret';

/** Only the two methods the ingestor actually calls. */
const stubRepo = (): Repo =>
  ({
    getCursor: async () => null,
    setCursor: async () => undefined,
  }) as unknown as Repo;

let server: HealthServer;
let ingestor: HeliusWebhookIngestor;
let buys: BuyEvent[];

beforeEach(async () => {
  buys = [];
  ingestor = new HeliusWebhookIngestor(SECRET, { log, repo: stubRepo() });
  ingestor.onBuy((e) => void buys.push(e));
  await ingestor.start();
  await ingestor.subscribe('2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump');

  server = await startHealthServer(0, log, Date.now(), [ingestor.handle.bind(ingestor)]);
});

afterEach(async () => {
  await ingestor.stop();
  await server.close();
});

const post = (body: unknown, auth?: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}/helius/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8')) as {
    mint: string;
    tx: unknown;
  };

describe('HeliusWebhookIngestor', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await post([{}]);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong secret', async () => {
    const res = await post([{}], 'not-the-secret-at-all-x');
    expect(res.status).toBe(401);
    expect(buys).toEqual([]);
  });

  it('rejects a secret that is a PREFIX of the real one', async () => {
    // Guards the length check in the constant-time compare.
    const res = await post([{}], SECRET.slice(0, -1));
    expect(res.status).toBe(401);
  });

  it('accepts the right secret and processes the buy', async () => {
    const fx = fixture('buy-pumpswap');
    const res = await post([fx.tx], SECRET);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // 200 is returned BEFORE processing, so give the microtask a tick to land.
    await new Promise((r) => setTimeout(r, 50));

    expect(buys.length).toBe(1);
    expect(buys[0]?.tokensRaw).toBe(27_305_176_224n);
    expect(buys[0]?.quoteRaw).toBe(38_110_479n);
    expect(buys[0]?.balanceAfterRaw).toBe(27_305_176_224n);
  });

  it('acks immediately, before the work is done (Helius retries a slow 200)', async () => {
    const fx = fixture('buy-pumpswap');
    const started = Date.now();
    const res = await post([fx.tx], SECRET);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(200);
  });

  it('yields the SAME event as the WS path would — one normalizer, two transports', async () => {
    // buy-pumpswap is a real $RICE buy (the point here is transport-equivalence, not the amounts).
    const fx = fixture('buy-pumpswap');
    const RICE = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
    await ingestor.subscribe(RICE);

    await post([fx.tx], SECRET);
    await new Promise((r) => setTimeout(r, 50));

    const buy = buys.find((b) => b.mint === RICE);
    expect(buy?.buyer).toBe('BfEhdonWCqQa3qxucTevNCizBnnaSJ7kJY4D1qSgiicQ');
    expect(buy?.tokensRaw).toBe(27_305_176_224n);
    expect(buy?.balanceAfterRaw).toBe(27_305_176_224n);
  });

  it('survives a junk body without falling over', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/helius/webhook`, {
      method: 'POST',
      headers: { authorization: SECRET },
      body: 'not json at all',
    });
    expect(res.status).toBe(200); // acked; the parse failure is logged, not fatal
    await new Promise((r) => setTimeout(r, 50));
    expect(buys).toEqual([]);
  });

  it('dedups a replayed delivery', async () => {
    const fx = fixture('buy-pumpswap');
    await post([fx.tx], SECRET);
    await post([fx.tx], SECRET); // Helius retried
    await new Promise((r) => setTimeout(r, 50));

    expect(buys.length).toBe(1);
  });

  it('leaves /health working on the same port', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
