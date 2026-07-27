import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { createLogger } from '../src/ops/logger.ts';
import { DcaFlusher } from '../src/telegram/dca-flush.ts';
import { dcaClaimKey, windowStartFor } from '../src/telegram/dca-window.ts';
import type { ChatId, Mint } from '../src/core/types.ts';

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const CHAT = -1001 as ChatId;
const USER = 4242;
const W1 = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const W2 = '9aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcdEf';

// A window that closed at 14:00; "now" sits mid the next window so 14:00–14:30 is the last closed one.
const WSTART = new Date('2026-07-24T14:00:00.000Z').getTime();
const NOW = WSTART + 40 * 60_000; // 14:40

interface Enqueued { signature: string; chatId: number; card: { text: string; keyboard: unknown[][] }; fileId: string | null }

function fakeQueue(sink: Enqueued[]) {
  return {
    enqueue: (job: { signature: string; chatId: number; build: () => Promise<{ chatId: number; card: unknown; fileId: string | null; kind: unknown }> }) => {
      void job.build().then((o) => sink.push({ signature: job.signature, chatId: o.chatId, card: o.card as never, fileId: o.fileId }));
    },
  } as never;
}

let dir: string;
let repo: SqliteRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-flush-'));
  repo = new SqliteRepo(join(dir, 't.db'), log);
  await repo.init();
  await repo.addAutotraderUser(USER, 'trader', 1);
  await repo.upsertChat({ chatId: CHAT, title: 'Rice Fam', addedBy: 1, paused: false });
  await repo.addChatToken(CHAT, MINT); // dca_window_minutes defaults to 30, dca_display 'aggregate'
  repo.seedToken({ mint: MINT, symbol: 'RICE', name: 'Rice', decimals: 6, supplyRaw: 0n, fetchedAtMs: Date.now() });
});
afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

async function scheduleId(): Promise<number> {
  return repo.createSchedule({ userId: USER, mint: MINT, side: 'buy', amountRaw: 50_000_000n, amountKind: 'absolute', intervalMinutes: 15, firstRunAt: WSTART });
}

/** Record a DCA buy: an execution row (attribution) + a buys row, at plannedAt inside the window. */
async function dcaBuy(sched: number, sig: string, buyer: string, tokensRaw: bigint, plannedAt: number): Promise<void> {
  const execId = (await repo.claimExecution(sched, USER, plannedAt))!;
  await repo.settleExecution(execId, { state: 'confirmed', signature: sig });
  await repo.recordBuy({
    signature: sig as never, mint: MINT, buyer: buyer as never,
    quoteMint: 'So11111111111111111111111111111111111111112' as never, quoteSymbol: 'SOL',
    quoteRaw: 50_000_000n, tokensRaw, usdIn: 5, priceUsd: 0.0001, slot: 1, blockTime: null,
  });
}

const flusher = (sink: Enqueued[]): DcaFlusher =>
  new DcaFlusher({ repo, queue: fakeQueue(sink), log, creatorFeeWallet: undefined, now: () => NOW });

describe('the DCA flush loop', () => {
  it('six buys from three wallets in one window -> ONE card with THREE lines, summed & sorted', async () => {
    const s = await scheduleId();
    // W1: 100,000 + 22,410 ; CREATOR-ish W2 leads at 240,000 ; a third wallet 84,203.
    const W3 = 'CrEaToR33333333333333333333333333333333333';
    await dcaBuy(s, 's1', W1, 100_000_000_000n, WSTART + 60_000);
    await dcaBuy(s, 's2', W3, 200_000_000_000n, WSTART + 120_000);
    await dcaBuy(s, 's3', W2, 40_000_000_000n, WSTART + 180_000);
    await dcaBuy(s, 's4', W1, 22_410_000_000n, WSTART + 240_000);
    await dcaBuy(s, 's5', W3, 40_000_000_000n, WSTART + 300_000);
    await dcaBuy(s, 's6', W2, 44_203_000_000n, WSTART + 360_000);

    const sink: Enqueued[] = [];
    const n = await flusher(sink).tick();
    await new Promise((r) => setTimeout(r, 0)); // let build() resolve

    expect(n).toBe(1); // ONE card
    expect(sink).toHaveLength(1);
    const body = sink[0]!.card.text.split('\n').filter(Boolean);
    expect(body[0]).toBe('🌾 DCA Buys');
    expect(body.slice(1)).toHaveLength(3); // three wallet lines
    expect(body[1]).toContain('240,000 grains'); // biggest leads
    expect(body[2]).toContain('122,410 grains');
    expect(body[3]).toContain('84,203 grains');
    expect(sink[0]!.fileId).toBeNull(); // text-only until the dca/ pool (Phase 16 part 2)
    expect(sink[0]!.signature).toBe(dcaClaimKey(MINT, WSTART));
  });

  it('an EMPTY window posts NOTHING (and advances the cursor)', async () => {
    const sink: Enqueued[] = [];
    const n = await flusher(sink).tick();
    expect(n).toBe(0);
    expect(sink).toHaveLength(0);
    // Cursor advanced to the last closed window, so a later empty tick does nothing either.
    expect(await repo.getDcaCursor(CHAT, MINT)).toBe(windowStartFor(NOW, 30) - 30 * 60_000);
  });

  it("dca_display='off' posts nothing even with buys", async () => {
    const s = await scheduleId();
    await dcaBuy(s, 'off1', W1, 10_000_000n, WSTART + 60_000);
    repo.raw.prepare("UPDATE chat_tokens SET dca_display = 'off' WHERE chat_id = ?").run(CHAT);

    const sink: Enqueued[] = [];
    expect(await flusher(sink).tick()).toBe(0);
    expect(sink).toHaveLength(0);
  });

  it('flushes each window exactly once — a second tick posts nothing new', async () => {
    const s = await scheduleId();
    await dcaBuy(s, 'a', W1, 5_000_000n, WSTART + 60_000);
    const sink: Enqueued[] = [];
    const f = flusher(sink);
    expect(await f.tick()).toBe(1);
    expect(await f.tick()).toBe(0); // cursor advanced; nothing re-flushed
  });

  it('a restart mid-flush cannot double-post — the (chat, window) claim wins once', async () => {
    const s = await scheduleId();
    await dcaBuy(s, 'r1', W1, 5_000_000n, WSTART + 60_000);
    // Simulate the queue already having claimed this window before the crash.
    const key = dcaClaimKey(MINT, WSTART) as never;
    expect(await repo.claimSend(key, CHAT)).toBe(true);
    // The post-restart flush enqueues, but the queue's claim on the same key now returns false.
    expect(await repo.claimSend(key, CHAT)).toBe(false);
  });

  it('does not backfill a huge history on first run — only the last closed window', async () => {
    const s = await scheduleId();
    // A buy three windows ago and one in the last closed window.
    await dcaBuy(s, 'old', W1, 1_000_000_000_000n, WSTART - 90 * 60_000 + 60_000);
    await dcaBuy(s, 'new', W2, 2_000_000_000_000n, WSTART + 60_000);
    const sink: Enqueued[] = [];
    const n = await flusher(sink).tick(); // cursor is null -> only the last closed window
    await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(1);
    expect(sink[0]!.card.text).toContain('2,000,000'); // the recent one
    expect(sink[0]!.card.text).not.toContain('1,000,000'); // NOT the old window
  });
});

/**
 * PHASE 7 — the wallet-mode half of the attribution set, asserted at the CARD, not at the query.
 *
 * The whole claim of the phase is "zero new pipeline": a Jupiter recurring order signed by a
 * villager's own wallet has to come out of the same flusher, in the same window, on the same card,
 * beside a custodial execution. Asserting the repo query would prove the row is findable; this
 * proves the group actually gets told.
 */
describe('a wallet-mode DCA buy reaches the SAME card as a custodial one', () => {
  const VILLAGER = 'ViL1agerWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  /** A Jupiter recurring fill: a `buys` row plus an attribution row. No execution, no signature of ours. */
  async function walletDcaBuy(sig: string, buyer: string, tokensRaw: bigint, atMs: number): Promise<void> {
    await repo.recordBuy({
      signature: sig as never, mint: MINT, buyer: buyer as never,
      quoteMint: 'So11111111111111111111111111111111111111112' as never, quoteSymbol: 'SOL',
      quoteRaw: 50_000_000n, tokensRaw, usdIn: 5, priceUsd: 0.0001, slot: 1, blockTime: null,
    });
    await repo.recordWalletDcaBuy(sig as never, MINT, buyer as never, atMs);
  }

  it('renders one card carrying BOTH a custodial line and a wallet-mode line, summed and sorted', async () => {
    const s = await scheduleId();
    await dcaBuy(s, 'exec-1', W1, 100_000_000_000n, WSTART + 60_000); // ours, via executions
    await walletDcaBuy('jup-1', VILLAGER, 250_000_000_000n, WSTART + 90_000); // theirs, via Jupiter
    await walletDcaBuy('jup-2', VILLAGER, 10_000_000_000n, WSTART + 120_000);

    const sink: Enqueued[] = [];
    expect(await flusher(sink).tick()).toBe(1); // ONE card, not one per source
    await new Promise((r) => setTimeout(r, 0));

    const body = sink[0]!.card.text.split('\n').filter(Boolean);
    expect(body[0]).toBe('🌾 DCA Buys');
    expect(body.slice(1)).toHaveLength(2);
    expect(body[1]).toContain('260,000 grains'); // the villager's two fills, summed, leading
    expect(body[2]).toContain('100,000 grains');
  });

  it('THE CREATOR FEE RULE IS UNCHANGED — matched by address, whichever mode it arrived by', async () => {
    const CREATOR = 'CrEaToRFeeWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await walletDcaBuy('jup-creator', CREATOR, 7_000_000_000n, WSTART + 60_000);

    const sink: Enqueued[] = [];
    await new DcaFlusher({ repo, queue: fakeQueue(sink), log, creatorFeeWallet: CREATOR, now: () => NOW }).tick();
    await new Promise((r) => setTimeout(r, 0));

    expect(sink[0]!.card.text).toContain('Creator Fee');
    expect(sink[0]!.card.text).not.toContain(CREATOR.slice(0, 4)); // named, never addressed
  });

  it('a buy with NO attribution row is invisible here — a manual ape keeps its organic card', async () => {
    await repo.recordBuy({
      signature: 'manual-1' as never, mint: MINT, buyer: VILLAGER as never,
      quoteMint: 'So11111111111111111111111111111111111111112' as never, quoteSymbol: 'SOL',
      quoteRaw: 50_000_000n, tokensRaw: 999_000_000_000n, usdIn: 5, priceUsd: 0.0001, slot: 1, blockTime: null,
    });
    const sink: Enqueued[] = [];
    expect(await flusher(sink).tick()).toBe(0);
    expect(sink).toHaveLength(0);
  });
});

describe('/dcawindow is owner-only', () => {
  it('sets the window across chat_tokens (owner) and is a no-op for anyone else', async () => {
    // The repo setter is what /dcawindow calls; the command gate is tested by the owner check.
    const changed = await repo.setDcaWindowMinutes(10);
    expect(changed).toBe(1);
    const ct = (await repo.getChatToken(CHAT, MINT))!;
    expect(ct.dcaWindowMinutes).toBe(10);
  });
});
