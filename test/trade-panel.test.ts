import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { createLogger } from '../src/ops/logger.ts';
import {
  renderPanel,
  LIVE_BANNER,
  DRY_BANNER,
  PANEL_VERBS,
  cb,
  parseCb,
  type PanelData,
} from '../src/telegram/trade-panel/render.ts';
import { PanelSessions } from '../src/telegram/trade-panel/session.ts';
import {
  applyStopAll,
  applySetContract,
  applyInterval,
  applyAmount,
  applyPause,
  applyResumeAll,
  applyCaps,
  dispatchTradeCommand,
  parseAmount,
  haltForWalletChange,
  PANEL_TTL_MS,
} from '../src/telegram/trade-panel/commands.ts';
import { completePrompt } from '../src/telegram/trade-panel/index.ts';
import type { Mint } from '../src/core/types.ts';
import type { Schedule } from '../src/trade/scheduler.ts';

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const MINT2 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Mint;
const A = 111;
const B = 222;
const SOL = 1_000_000_000n;

let dir: string;
let repo: SqliteRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-panel-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  await repo.addAutotraderUser(A, 'alice', 1);
  await repo.addAutotraderUser(B, 'bob', 1);
});
afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seed(userId: number, over: Partial<{ side: Schedule['side']; amountRaw: bigint; amountKind: Schedule['amountKind']; interval: number; mint: Mint }> = {}): Promise<number> {
  const id = await repo.createSchedule({
    userId, mint: over.mint ?? MINT, side: over.side ?? 'buy',
    amountRaw: over.amountRaw ?? SOL / 20n, amountKind: over.amountKind ?? 'absolute',
    intervalMinutes: over.interval ?? 15, firstRunAt: 1_000_000,
  });
  await repo.setCaps({ userId, mint: over.mint ?? MINT, maxPerExecUsd: 50, maxPerDayUsd: 200 });
  return id;
}

function panelData(over: Partial<PanelData> = {}): PanelData {
  return {
    tradeLive: false, symbol: '$RICE', mint: MINT, pubkey: '7xKXtgsffffffffffffffffffffffffffffff9fPq',
    walletUnlocked: true, solBalance: 2_410_000_000n, tokenBalance: 8_204_113_000_000n, tokenDecimals: 6,
    schedules: [], spentTodayUsd: 18.42, caps: { perExecUsd: 50, perDayUsd: 200 }, now: 1_000_000,
    ...over,
  };
}

// ===========================================================================================
// RULE A — the panel shows whether money is at stake, at the TOP, always
// ===========================================================================================

describe('the money-at-stake banner (RULE A)', () => {
  it('renders 🔴 LIVE as the very first line when trading is live', () => {
    const { text } = renderPanel(panelData({ tradeLive: true }), 'tok');
    expect(text.split('\n')[0]).toBe(LIVE_BANNER);
  });

  it('renders 🟡 DRY RUN as the very first line when not live', () => {
    const { text } = renderPanel(panelData({ tradeLive: false }), 'tok');
    expect(text.split('\n')[0]).toBe(DRY_BANNER);
    expect(text).toContain('wallet untouched');
  });
});

// ===========================================================================================
// The full panel: settings + the complete button board, one message
// ===========================================================================================

describe('the panel board', () => {
  it('renders settings and the FULL button board with a STOP ALL', async () => {
    const s = await repo.getSchedule(await seed(A));
    const { text, keyboard } = renderPanel(panelData({ schedules: [{ schedule: s!, last: null }] }), 'tok');
    expect(text).toContain('🤖 Autotrader — $RICE');
    expect(text).toMatch(/Buy\s+0\.05 SOL  every 15 min/);
    expect(text).toContain('Today  $18.42 / $200 cap');

    const verbs = keyboard.flat().map((b) => parseCb(b.callback_data)!.verb);
    // The whole board, and every verb is one of the known PANEL_VERBS.
    for (const v of PANEL_VERBS) expect(verbs).toContain(v);
    expect(keyboard.flat().some((b) => b.text.includes('STOP ALL'))).toBe(true);
  });

  it('never puts a mint or id in callback_data — only t:<token>:<verb> (the 64-byte wall)', () => {
    const { keyboard } = renderPanel(panelData(), 'abc12345');
    for (const b of keyboard.flat()) {
      expect(b.callback_data.length).toBeLessThanOrEqual(64);
      expect(b.callback_data).toMatch(/^t:abc12345:[a-z]+$/);
      expect(b.callback_data).not.toContain(MINT);
    }
  });

  it('re-renders with the NEW value after a setting changes', async () => {
    const id = await seed(A, { interval: 15 });
    const r = await applyInterval(repo, A, id, '30');
    expect(r.ok).toBe(true);
    const s = await repo.getSchedule(id);
    const { text } = renderPanel(panelData({ schedules: [{ schedule: s!, last: null }] }), 'tok');
    expect(text).toMatch(/every 30 min/);
  });
});

// ===========================================================================================
// STOP ALL, contract, wallet — money-moving state changes
// ===========================================================================================

describe('stop / contract / wallet', () => {
  it('STOP ALL pauses every one of the user\'s schedules in one call, no confirmation', async () => {
    const id1 = await seed(A);
    const id2 = await seed(A);
    const r = await applyStopAll(repo, A);
    expect(r.ok).toBe(true);
    expect((await repo.getSchedule(id1))!.state).toBe('paused');
    expect((await repo.getSchedule(id2))!.state).toBe('paused');
  });

  it('changing the CONTRACT halts the schedules and says so', async () => {
    const id = await seed(A);
    const r = await applySetContract(repo, A, MINT2);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/HALTED/);
    expect((await repo.getSchedule(id))!.state).toBe('halted');
    expect((await repo.getSchedule(id))!.haltReason).toBe('contract changed');
    expect(await repo.getContract(A)).toBe(MINT2);
  });

  it('rejects an implausible contract mint before writing anything', async () => {
    const id = await seed(A);
    const r = await applySetContract(repo, A, 'not-a-mint');
    expect(r.ok).toBe(false);
    expect((await repo.getSchedule(id))!.state).toBe('active'); // untouched
    expect(await repo.getContract(A)).toBeNull();
  });

  it('changing the WALLET halts the schedules (the /wallet hook)', async () => {
    const id = await seed(A);
    const halted = await haltForWalletChange(repo, A);
    expect(halted).toBe(1);
    expect((await repo.getSchedule(id))!.state).toBe('halted');
    expect((await repo.getSchedule(id))!.haltReason).toBe('wallet changed');
  });

  it('resume brings halted/paused schedules back', async () => {
    const id = await seed(A);
    await applySetContract(repo, A, MINT2);
    expect((await repo.getSchedule(id))!.state).toBe('halted');
    const r = await applyResumeAll(repo, A);
    expect(r.ok).toBe(true);
    expect((await repo.getSchedule(id))!.state).toBe('active');
  });
});

// ===========================================================================================
// VALIDATE-BEFORE-WRITE (RULE B) + USER ISOLATION
// ===========================================================================================

describe('validate-before-write and user isolation', () => {
  it('refuses to act on an id that does not exist — no write, specific message', async () => {
    const r = await applyInterval(repo, A, 9999, '30');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No schedule #9999/);
  });

  it("refuses to act on ANOTHER user's schedule, and does not touch it", async () => {
    const bId = await seed(B, { interval: 15 });
    // Alice tries to change Bob's schedule by id.
    for (const attempt of [
      () => applyInterval(repo, A, bId, '99'),
      () => applyAmount(repo, A, bId, '0.5'),
      () => applyPause(repo, A, bId),
    ]) {
      const r = await attempt();
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/of yours/);
    }
    // Bob's schedule is exactly as seeded.
    const b = await repo.getSchedule(bId);
    expect(b!.intervalMinutes).toBe(15);
    expect(b!.state).toBe('active');
  });

  it('completePrompt is user-scoped too — a button reply cannot reach another user', async () => {
    const bId = await seed(B);
    const r = await completePrompt(repo, A, 'pause', String(bId), MINT, 1_000_000);
    expect(r.ok).toBe(false);
  });

  it('/history and listSchedules return ONLY the calling user\'s rows', async () => {
    const aId = await seed(A);
    const bId = await seed(B);
    const aExec = await repo.claimExecution(aId, A, 1);
    await repo.settleExecution(aExec!, { state: 'confirmed', usdValue: 1 });
    const bExec = await repo.claimExecution(bId, B, 1);
    await repo.settleExecution(bExec!, { state: 'confirmed', usdValue: 1 });

    const aHistory = await repo.listExecutionsForUser(A, 50);
    expect(aHistory.every((e) => e.userId === A)).toBe(true);
    expect(aHistory.some((e) => e.userId === B)).toBe(false);

    expect((await repo.listSchedules(A)).every((s) => s.userId === A)).toBe(true);
    expect((await repo.listSchedules(B)).every((s) => s.userId === B)).toBe(true);
  });
});

// ===========================================================================================
// STALENESS — a panel older than 15 minutes refuses to act
// ===========================================================================================

describe('panel staleness', () => {
  it('a panel older than 15 minutes is expired; a fresh one is fine', () => {
    const clock = { t: 1_000_000 };
    const sessions = new PanelSessions(() => clock.t);
    const p = sessions.open(A);
    sessions.setMessageId(p.token, 55);

    expect(sessions.panel(p.token, A)).not.toBe('expired'); // fresh
    clock.t += 20 * 60_000; // 20 minutes later
    expect(sessions.panel(p.token, A)).toBe('expired');
    expect(PANEL_TTL_MS).toBe(15 * 60_000);
  });

  it("a panel token from someone else's screenshot is not a key to it", () => {
    const sessions = new PanelSessions(() => 1_000_000);
    const p = sessions.open(A);
    expect(sessions.panel(p.token, B)).toBeNull(); // wrong user — same answer as gone
    expect(sessions.panel(p.token, A)).toBeTruthy();
  });
});

// ===========================================================================================
// COMMAND EQUIVALENCE — every button has a typed command, and vice versa
// ===========================================================================================

describe('every button has a typed-command equivalent', () => {
  it('every panel verb is handled (prompt or immediate) — none is a dead button', async () => {
    // completePrompt must handle every prompt verb without falling to the default. 'stop' is the one
    // immediate, no-prompt action (STOP ALL) and 'wallet' points to /wallet; the rest complete here.
    const promptVerbs = PANEL_VERBS.filter((v) => v !== 'stop' && v !== 'wallet');
    for (const v of promptVerbs) {
      const r = await completePrompt(repo, A, v, '', MINT, 1_000_000);
      // A parse/validation error is fine (empty input) — what must NOT happen is the "Nothing to do"
      // default, which would mean the verb has no handler at all.
      expect(r.message, `verb ${v} must be handled`).not.toBe('Nothing to do.');
    }
  });

  it('the typed dispatcher covers every subcommand (none falls to the usage error)', async () => {
    const id = await seed(A);
    const usage = 'Try:';
    const cases: string[][] = [
      ['new', 'buy', '0.05', '15'],
      ['amount', String(id), '0.06'],
      ['interval', String(id), '30'],
      ['slippage', String(id), '150'],
      ['pause', String(id)],
      ['resume', String(id)],
      ['stop'],
      ['caps', '25', '100'],
      ['delete', String(id)],
    ];
    for (const tokens of cases) {
      const r = await dispatchTradeCommand(repo, A, MINT, tokens, 1_000_000);
      expect(r.message.startsWith(usage), `subcommand ${tokens[0]} must be recognised`).toBe(false);
    }
  });

  it('plain input parses without units: 0.05 (SOL), 10% (percent), 5000 (tokens)', () => {
    expect(parseAmount('0.05', 'buy')).toEqual({ amountRaw: 50_000_000n, amountKind: 'absolute' });
    expect(parseAmount('10%', 'sell')).toEqual({ amountRaw: 1000n, amountKind: 'percent_of_balance' });
    expect(parseAmount('5000', 'sell')).toEqual({ amountRaw: 5000n, amountKind: 'absolute' });
    expect(parseAmount('10%', 'buy')).toHaveProperty('error'); // percent is a sell concept
  });
});

// ===========================================================================================
// OWNER ISOLATION — no owner command reads another user's money (structural)
// ===========================================================================================

describe('the owner administers membership, never money', () => {
  it('no owner-gated command reads another user\'s balance, schedules, or executions', () => {
    // Structural guarantee: scan the command sources for a money-read reachable from an owner path.
    const files = [
      'src/telegram/trade-commands.ts',
      'src/telegram/resolve-command.ts',
      'src/telegram/trade-panel/index.ts',
      'src/telegram/trade-panel/commands.ts',
    ].map((f) => readFileSync(join(import.meta.dirname, '..', f), 'utf8'));

    // The /trader (owner) command surface manages membership only. It must not fetch a wallet
    // inventory, list another user's schedules, or read their executions.
    const trade = files[0]!;
    const traderBlock = trade.slice(trade.indexOf("bot.command('trader'"), trade.indexOf("bot.command('wallet'"));
    for (const forbidden of ['fetchInventory', 'listSchedules', 'listExecutionsForUser', 'getBalance', 'getTokenBalances']) {
      expect(traderBlock.includes(forbidden), `/trader must not call ${forbidden}`).toBe(false);
    }

    // And no apply* in the panel takes a "target user" — every one is scoped to the acting userId.
    // (The signatures all read `userId`, never a separate owner+target pair.)
    const panelCmds = files[3]!;
    expect(panelCmds).not.toMatch(/ownerUserId|targetUser|asUser/);
  });
});
