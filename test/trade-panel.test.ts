import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.ts';
import { createLogger } from '../src/ops/logger.ts';
import {
  renderPanel,
  LIVE_BANNER,
  DRY_BANNER,
  KEY_MODE_BANNER,
  WALLET_MODE_BANNER,
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
  applyResume,
  applyResumeAll,
  applyCaps,
  applySlippage,
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
    // PHASE 7: this whole file describes the CUSTODIAL panel — schedules, caps, a wallet to
    // unlock — which is the key-mode one. Stated, not defaulted into.
    tradeLive: false, mode: 'key', symbol: '$RICE', mint: MINT, pubkey: '7xKXtgsffffffffffffffffffffffffffffff9fPq',
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
// PHASE 7 — the custody banner, and the wallet-mode panel
// ===========================================================================================

describe('the custody banner sits beside the money-at-stake one', () => {
  it('states WHO HOLDS THE KEY on line two, in both modes, on every panel', () => {
    const key = renderPanel(panelData({ mode: 'key' }), 'tok').text.split('\n');
    expect(key[1]).toBe(KEY_MODE_BANNER);
    expect(key[1]).toContain('I hold an encrypted key');

    const wallet = renderPanel(panelData({ mode: 'wallet' }), 'tok').text.split('\n');
    expect(wallet[1]).toBe(WALLET_MODE_BANNER);
    expect(wallet[1]).toContain('I hold nothing');

    // Line one is still RULE A's, in both. The custody line is added beside it, not instead.
    expect(key[0]).toBe(DRY_BANNER);
    expect(wallet[0]).toBe(DRY_BANNER);
  });
});

describe('the wallet-mode panel is a launch point and a read-only view', () => {
  const walletPanel = (over: Partial<PanelData> = {}) =>
    renderPanel(panelData({ mode: 'wallet', pubkey: null, caps: null, ...over }), 'tok');

  it('offers NO control that would change a schedule the bot cannot sign for', () => {
    const { keyboard } = walletPanel({
      walletMode: { linkedWallet: 'RiceViL1ager11111111111111111111111111111111', recentBuys: [], miniAppUrl: 'https://1grainofrice.com' },
    });
    const labels = keyboard.flat().map((b) => b.text).join(' ');
    for (const gone of ['New schedule', 'Amount', 'Interval', 'Pause', 'Resume', 'Caps', 'Slippage', 'STOP ALL', 'Wallet']) {
      expect(labels).not.toContain(gone);
    }
    // What is left: the way out to the Mini App, and which token this view is about.
    expect(labels).toContain('Mini App');
    expect(labels).toContain('Contract');
  });

  it('launches the Mini App with a web_app button, NOT a plain url', () => {
    // The distinction is load-bearing (Phase 8): only a web_app launch hands the page a signed
    // initData, which is the only way it can prove to the bot whose orders to show. A url button
    // would open a browser with no identity attached and the Mini App would come up empty.
    const { keyboard } = walletPanel({
      walletMode: { linkedWallet: 'W', recentBuys: [], miniAppUrl: 'https://1grainofrice.com/onegrainofrice/tma' },
    });
    const launcher = keyboard.flat().find((b) => b.text.includes('Mini App'));
    expect(launcher).toBeDefined();
    expect(launcher).toMatchObject({ web_app: { url: 'https://1grainofrice.com/onegrainofrice/tma' } });
    expect(launcher).not.toHaveProperty('url');
  });

  it('shows no launch button at all when there is nowhere to launch — never a dead one', () => {
    const { keyboard } = walletPanel({ walletMode: { linkedWallet: 'W', recentBuys: [], miniAppUrl: undefined } });
    expect(keyboard.flat().some((b) => 'web_app' in b)).toBe(false);
    expect(keyboard.flat().some((b) => b.text.includes('Mini App'))).toBe(false);
  });

  it('asks an unlinked user to prove the wallet, and never shows a balance it has no business reading', () => {
    const { text } = walletPanel({ walletMode: { linkedWallet: null, recentBuys: [] } });
    expect(text).toContain('No wallet linked yet');
    expect(text).toContain('/linksite');
    expect(text).not.toContain('Balance');
    expect(text).not.toContain('cap');
  });

  it('lists OBSERVED fills and says plainly that live order state lives in the Mini App', () => {
    const { text } = walletPanel({
      walletMode: {
        linkedWallet: 'RiceViL1ager11111111111111111111111111111111',
        recentBuys: [{ tokensRaw: 12_345_000_000n, usdIn: 20.5, at: Date.UTC(2026, 6, 24, 14, 30) }],
        miniAppUrl: 'https://1grainofrice.com',
      },
    });
    expect(text).toContain('linked, proven by signature');
    expect(text).toContain('12,345 $RICE');
    expect(text).toContain('$20.5');
    // The boundary, stated rather than implied by an absence.
    expect(text).toContain('fills I saw on-chain');
    expect(text).toContain('Mini App');
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
// INVARIANT 16 — RESUME IS NOT AN EXIT FROM AMBIGUITY
// ===========================================================================================

/**
 * An UNKNOWN outcome means a swap may or may not have landed. `/resolve` is the only exit because
 * it makes a human check the chain first; resume must not be a back door around it, on ANY surface.
 *
 * Until this was fixed, `applyResume` -> `unhaltSchedule` cleared the halt unconditionally, and the
 * only thing catching it was `quarantineUnresolvedOnBoot` re-halting the schedule at the NEXT
 * RESTART — which could be days later, with the schedule trading in between on top of a trade
 * nobody had confirmed.
 */
describe('resume cannot clear an UNKNOWN-outcome halt', () => {
  /** Put a schedule in the state the executor leaves behind on an ambiguous swap. */
  async function unknownHalted(userId: number): Promise<{ scheduleId: number; executionId: number }> {
    const scheduleId = await seed(userId);
    const executionId = (await repo.claimExecution(scheduleId, userId, 1_000))!;
    await repo.settleExecution(executionId, { state: 'UNKNOWN', signature: 'sig-ambiguous' });
    await repo.haltSchedule(scheduleId, `UNKNOWN outcome for execution ${executionId} (sig-ambiguous)`, 1_000);
    return { scheduleId, executionId };
  }

  it('refuses, names the execution, and points at /resolve', async () => {
    const { scheduleId, executionId } = await unknownHalted(A);

    const r = await applyResume(repo, A, scheduleId);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('UNKNOWN');
    expect(r.message).toContain(`/resolve ${executionId} confirmed|failed`);
    expect((await repo.getSchedule(scheduleId))!.state).toBe('halted');
    // The halt reason survives too — a refused resume must not half-clear the state it refused.
    expect((await repo.getSchedule(scheduleId))!.haltReason).toContain('UNKNOWN');
  });

  it('writes NO audit row for a resume it refused — the trail records changes, not attempts', async () => {
    const { scheduleId } = await unknownHalted(A);
    await applyResume(repo, A, scheduleId);
    expect(await repo.listSettingChanges(A, 10)).toHaveLength(0);
  });

  it('still resumes an ORDINARY halt — a cap breach, a contract change, a manual pause', async () => {
    // A cap/dead-man style halt: halted, but with no unresolved execution behind it.
    const capHalted = await seed(A);
    await repo.haltSchedule(capHalted, 'daily cap $200 reached', 1_000);
    expect((await applyResume(repo, A, capHalted)).ok).toBe(true);
    expect((await repo.getSchedule(capHalted))!.state).toBe('active');

    const contractHalted = await seed(A);
    await applySetContract(repo, A, MINT2); // halts every schedule of A's
    expect((await applyResume(repo, A, contractHalted)).ok).toBe(true);
    expect((await repo.getSchedule(contractHalted))!.state).toBe('active');

    const paused = await seed(A);
    await applyPause(repo, A, paused);
    expect((await applyResume(repo, A, paused)).ok).toBe(true);
    expect((await repo.getSchedule(paused))!.state).toBe('active');
  });

  it('a CONFIRMED or FAILED execution does not block anything — only an unresolved one does', async () => {
    const scheduleId = await seed(A);
    const execId = (await repo.claimExecution(scheduleId, A, 1_000))!;
    await repo.settleExecution(execId, { state: 'confirmed', signature: 'sig-ok' });
    await repo.haltSchedule(scheduleId, 'daily cap reached', 1_000);
    expect((await applyResume(repo, A, scheduleId)).ok).toBe(true);
  });

  it('RESUME ALL resumes the rest and reports the one it cannot, with its /resolve', async () => {
    const { scheduleId: blocked, executionId } = await unknownHalted(A);
    const ordinary = await seed(A);
    await repo.haltSchedule(ordinary, 'wallet changed', 1_000);

    const r = await applyResumeAll(repo, A);
    expect(r.ok).toBe(true);
    expect((await repo.getSchedule(ordinary))!.state).toBe('active'); // the rest still resume
    expect((await repo.getSchedule(blocked))!.state).toBe('halted'); // the one that must not
    expect(r.message).toContain(`#${blocked}`);
    expect(r.message).toContain(`/resolve ${executionId}`);
  });

  it('the bulk SQL is the backstop: resumeUserSchedules ITSELF cannot clear an UNKNOWN halt', async () => {
    // Not routed through the command layer at all — this is the raw repo call a future caller
    // might reach for. A bulk UPDATE is exactly the shape of thing that quietly clears a row
    // nobody meant to clear, so the exclusion lives in the statement as well as above it.
    const { scheduleId } = await unknownHalted(A);
    const ordinary = await seed(A);
    await repo.haltSchedule(ordinary, 'wallet changed', 1_000);

    const resumed = await repo.resumeUserSchedules(A);
    expect(resumed).toBe(1); // the ordinary one only
    expect((await repo.getSchedule(scheduleId))!.state).toBe('halted');
  });

  it('is scoped per user — B’s unresolved execution does not freeze A’s schedule', async () => {
    await unknownHalted(B);
    const mine = await seed(A);
    await repo.haltSchedule(mine, 'wallet changed', 1_000);
    expect((await applyResume(repo, A, mine)).ok).toBe(true);
    expect((await repo.getSchedule(mine))!.state).toBe('active');
  });

  /**
   * `unhaltSchedule` stays UNCONDITIONAL on purpose: its other callers are the executor's own
   * resolution paths, and every one of them settles the execution out of UNKNOWN first, so a guard
   * there would be dead code at best and a schedule that can never come back at worst. The cost of
   * that choice is that the primitive is still sharp — so the set of things allowed to hold it is
   * pinned here. A new user-facing resume path calling it directly would reopen exactly the hole
   * this section closes, and would fail this test on the way in.
   */
  it('only the executor and applyResume may call unhaltSchedule directly', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const callers = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => readFileSync(join(src, f), 'utf8').includes('unhaltSchedule'))
      .map((f) => f.split(sep).join('/'))
      // The repo IMPLEMENTS the method; implementing it is not calling it.
      .filter((f) => f !== 'db/sqlite.ts')
      .sort();
    expect(callers, 'a new caller of unhaltSchedule — does it settle the execution first?').toEqual([
      'telegram/trade-panel/commands.ts',
      'trade/executor.ts',
    ]);
  });

  it('once the execution is resolved, the schedule resumes normally', async () => {
    const { scheduleId, executionId } = await unknownHalted(A);
    expect((await applyResume(repo, A, scheduleId)).ok).toBe(false);

    // What /resolve does: settle the execution out of UNKNOWN. (The real command also unhalts —
    // asserted end-to-end against the live Executor in test/executor.test.ts.)
    await repo.settleExecution(executionId, { state: 'confirmed', signature: 'sig-ambiguous' });

    const r = await applyResume(repo, A, scheduleId);
    expect(r.ok).toBe(true);
    expect((await repo.getSchedule(scheduleId))!.state).toBe('active');
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

describe('Phase 16 hard limits at the panel (UX guard; the executor is the authority)', () => {
  it('refuses slippage above the 10% (1000 bps) hard maximum', async () => {
    const id = await seed(A);
    expect((await applySlippage(repo, A, id, '1000')).ok).toBe(true); // 10% is allowed
    const over = await applySlippage(repo, A, id, '1500');
    expect(over.ok).toBe(false);
    expect(over.message).toMatch(/0.1000|0–1000|1000/);
    expect((await repo.getSchedule(id))!.slippageBps).toBe(1000); // never stored above the max
  });

  it('refuses a daily cap above the env ceiling', async () => {
    const ceiling = 200;
    const over = await applyCaps(repo, A, MINT, '50', '500', '', ceiling);
    expect(over.ok).toBe(false);
    expect(over.message).toMatch(/ceiling/);
    expect(await repo.getCaps(A, MINT)).toBeNull(); // nothing written
    // At or below the ceiling is fine.
    expect((await applyCaps(repo, A, MINT, '50', '200', '', ceiling)).ok).toBe(true);
  });

  it('refuses a lifetime cap above the env ceiling, and clears with "none"', async () => {
    const lifeCeiling = 1000;
    const over = await applyCaps(repo, A, MINT, '50', '200', '5000', Infinity, lifeCeiling);
    expect(over.ok).toBe(false);
    expect(over.message).toMatch(/ceiling/);
    expect(await repo.getCaps(A, MINT)).toBeNull(); // nothing written

    // At/below the lifetime ceiling stores it; "none" clears it back to null.
    expect((await applyCaps(repo, A, MINT, '50', '200', '900', Infinity, lifeCeiling)).ok).toBe(true);
    expect((await repo.getCaps(A, MINT))!.maxLifetimeUsd).toBe(900);
    expect((await applyCaps(repo, A, MINT, '50', '200', 'none', Infinity, lifeCeiling)).ok).toBe(true);
    expect((await repo.getCaps(A, MINT))!.maxLifetimeUsd).toBeNull();
  });
});

// ===========================================================================================
// PHASE 16 (6) — the settings audit trail: what / from / to / when, per user
// ===========================================================================================
describe('the settings audit trail', () => {
  it('records an interval change with the OLD and NEW values', async () => {
    const id = await seed(A, { interval: 15 });
    await applyInterval(repo, A, id, '30');

    const [row] = await repo.listSettingChanges(A, 10);
    expect(row).toMatchObject({
      userId: A, action: 'schedule.interval', scheduleId: id, field: 'interval_minutes',
      fromValue: '15', toValue: '30',
    });
    expect(row!.at).toBeGreaterThan(0); // stamped at write time
  });

  it('records caps, contract, and a create — the account-wide changes carry no schedule id', async () => {
    await applyCaps(repo, A, MINT, '50', '200');
    await applySetContract(repo, A, MINT2);

    const rows = await repo.listSettingChanges(A, 10);
    const caps = rows.find((r) => r.action === 'caps');
    const contract = rows.find((r) => r.action === 'contract');
    expect(caps).toMatchObject({ scheduleId: null, toValue: '$50/$200/none' });
    expect(contract).toMatchObject({ scheduleId: null, field: 'mint', toValue: MINT2 });
  });

  it('records a delete with the old shape and a null to-value', async () => {
    const id = await seed(A, { interval: 20 });
    // Clear the create row so we assert on the delete.
    const before = (await repo.listSettingChanges(A, 50)).length;
    await dispatchTradeCommand(repo, A, MINT, ['delete', String(id)], 1_000_000);

    const rows = await repo.listSettingChanges(A, 50);
    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({ action: 'schedule.delete', scheduleId: id, toValue: null });
    expect(rows[0]!.fromValue).toMatch(/every 20 min/);
  });

  it('a REFUSED change records NOTHING — the trail is of changes that happened', async () => {
    // An interval on a schedule that is not the caller's is refused before any write.
    const bId = await seed(B);
    const r = await applyInterval(repo, A, bId, '99');
    expect(r.ok).toBe(false);
    expect(await repo.listSettingChanges(A, 10)).toHaveLength(0);
  });

  it('is user-scoped — one member never sees another’s trail', async () => {
    await applyCaps(repo, A, MINT, '50', '200');
    await applyCaps(repo, B, MINT, '10', '30');
    expect((await repo.listSettingChanges(A, 10)).every((r) => r.userId === A)).toBe(true);
    expect((await repo.listSettingChanges(B, 10)).every((r) => r.userId === B)).toBe(true);
  });

  it('a wallet change is audited through haltForWalletChange', async () => {
    await seed(A);
    await haltForWalletChange(repo, A);
    const [row] = await repo.listSettingChanges(A, 10);
    expect(row).toMatchObject({ action: 'wallet', scheduleId: null });
  });
});
