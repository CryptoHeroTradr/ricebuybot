import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import pino from 'pino';

import { SqliteRepo } from '../src/db/sqlite.js';
import { Keystore } from '../src/trade/keystore.js';
import { InputArbiter } from '../src/telegram/input-arbiter.js';
import { registerTradeCommands, type TradeCommandDeps } from '../src/telegram/trade-commands.js';
import { exposureWarning, type WalletRpc } from '../src/trade/wallet.js';
import { CUSTODY_ACK_PHRASE, checkModeSwitch, custodyWarning, parseMode } from '../src/trade/mode.js';
import { makeDcaAttribution } from '../src/telegram/dca-attribution.js';
import { makeRecurringProgramCheck, parseRecurringProgramIds, DEFAULT_RECURRING_PROGRAM_IDS } from '../src/ingest/recurring.js';
import { Scheduler, dryRunExecutor, type TradeValuer } from '../src/trade/scheduler.js';
import type { BuyEvent } from '../src/core/types.js';
import type { ConfirmedTx } from '../src/ingest/solana-types.js';

/**
 * PHASE 7 — the two modes, and the buy-card attribution that makes wallet mode visible.
 *
 * The acceptance criteria are asserted here in the order they were written, because each one is a
 * property somebody could quietly regress without any other test noticing:
 *
 *   1. a new user defaults to wallet mode with no keystore
 *   2. /wallet import is refused in wallet mode
 *   3. switching to key mode requires the typed custody ack
 *   4. a wallet-mode DCA buy from a linked wallet cards as a DCA through the Phase 16 path
 *   5. a MANUAL buy from the SAME wallet does NOT
 *
 * 4 and 5 are one pair, deliberately: 4 alone passes just as well against a rule that attributes
 * every buy from a linked wallet, which is the exact mistake the judgement call exists to avoid.
 */

const log = pino({ level: 'silent' });
const RICE = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
const OWNER = 1000;
const MEMBER = 2000;
const WALLET = 'RiceViLLagerWa11etAddressAAAAAAAAAAAAAAAAAAA';
const OTHER_WALLET = 'StrangerWa11etAddressBBBBBBBBBBBBBBBBBBBBBBB';
const RECURRING = DEFAULT_RECURRING_PROGRAM_IDS[0] as string;

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'rbb-mode-'));

type Handler = (ctx: any, next?: () => Promise<void>) => Promise<void>;

class FakeBot {
  commands = new Map<string, Handler>();
  textHandler: Handler | null = null;
  command(name: string, h: Handler): void {
    this.commands.set(name, h);
  }
  on(event: string, h: Handler): void {
    if (event === 'message:text') this.textHandler = h;
  }
}

class FakeCtx {
  replies: string[] = [];
  constructor(
    public userId: number,
    public text = '',
    public match = '',
  ) {}
  get from() {
    return { id: this.userId };
  }
  get chat() {
    return { id: this.userId, type: 'private' };
  }
  get message() {
    return { text: this.text, message_id: 55 };
  }
  reply = async (text: string) => {
    this.replies.push(text);
    return { message_id: 999 };
  };
  api = {
    deleteMessage: async () => undefined,
    sendMessage: async () => undefined,
  };
  next = async () => undefined;
  said(fragment: string): boolean {
    return this.replies.join('\n').includes(fragment);
  }
}

const rpc: WalletRpc = {
  getBalance: async () => 1_000_000_000n,
  getOwnedTokenAccountsParsed: async () => [],
};

let repo: SqliteRepo;
let keystore: Keystore;
let bot: FakeBot;
let activeSchedules: number;

function wire(): TradeCommandDeps {
  repo = new SqliteRepo(':memory:', log);
  keystore = new Keystore({ dir: tmpDir() });
  bot = new FakeBot();
  activeSchedules = 0;

  const deps: TradeCommandDeps = {
    repo,
    keystore,
    rpc,
    log,
    unlockConfig: { ownerUserId: OWNER, ownerPassphrase: undefined },
    primaryMint: RICE,
    primarySymbol: 'RICE',
    pauseSchedules: async () => undefined,
    arbiter: new InputArbiter(),
    activeScheduleCount: async () => activeSchedules,
    recordModeChange: (userId, from, to) =>
      repo.recordSettingChange({ userId, action: 'mode', scheduleId: null, field: 'custody', fromValue: from, toValue: to }),
  };
  registerTradeCommands(bot as any, deps);
  return deps;
}

beforeEach(async () => {
  wire();
  await repo.init();
  await repo.addAutotraderUser(MEMBER, 'member', OWNER);
});

// ==========================================================================================
// 1. THE DEFAULT
// ==========================================================================================

describe('a new member defaults to WALLET mode, holding nothing', () => {
  it('is wallet mode the moment they are added — no command, no switch, no keystore', async () => {
    const member = await repo.getAutotraderUser(MEMBER);
    expect(member?.mode).toBe('wallet');
    expect(keystore.has(MEMBER)).toBe(false);
  });

  it('/mode ANSWERS rather than staying silent — custody is never something you have to infer', async () => {
    const ctx = new FakeCtx(MEMBER, '', '');
    await bot.commands.get('mode')!(ctx);
    expect(ctx.said('WALLET mode')).toBe(true);
    expect(ctx.said('I hold no key for you')).toBe(true);
  });

  it('re-adding a removed member does NOT reset their mode — custody is not membership', async () => {
    await repo.setAutotraderMode(MEMBER, 'key');
    await repo.setAutotraderLocked(MEMBER, true);
    await repo.addAutotraderUser(MEMBER, 'member', OWNER); // the re-add clears `locked`
    const back = await repo.getAutotraderUser(MEMBER);
    expect(back?.locked).toBe(false);
    expect(back?.mode).toBe('key'); // …and leaves the key they still have exactly where it was
  });

  it('a LOCKED member reads as wallet mode — a revoked member is not one the bot trades for', async () => {
    await repo.setAutotraderMode(MEMBER, 'key');
    await repo.setAutotraderLocked(MEMBER, true);
    expect(await repo.traderMode(MEMBER)).toBe('wallet');
  });
});

// ==========================================================================================
// 2. /wallet IS REFUSED IN WALLET MODE
// ==========================================================================================

describe('/wallet import is REFUSED in wallet mode', () => {
  it('refuses before the warning, before the ack, and before any awaiting-input state exists', async () => {
    const ctx = new FakeCtx(MEMBER, '', 'import');
    await bot.commands.get('wallet')!(ctx);

    expect(ctx.said('Not in wallet mode')).toBe(true);
    expect(ctx.said('/mode key')).toBe(true);
    // The custody warning is NOT shown: showing it here would frame handing over a key as the
    // next step of a flow the user is already inside.
    expect(ctx.said('All of the above is exposed')).toBe(false);

    // And the input slot was never taken — a stray reply cannot be read as a secret key.
    const stray = new FakeCtx(MEMBER, 'not a key at all');
    await bot.textHandler!(stray, stray.next);
    expect(stray.replies).toEqual([]);
  });

  it('refuses /wallet generate too — a key the bot made and kept is just as custodial', async () => {
    const ctx = new FakeCtx(MEMBER, '', 'generate');
    await bot.commands.get('wallet')!(ctx);
    expect(ctx.said('Not in wallet mode')).toBe(true);
    expect(keystore.has(MEMBER)).toBe(false);
  });

  it('allows both again once the member has opted into key mode', async () => {
    await repo.setAutotraderMode(MEMBER, 'key');
    const ctx = new FakeCtx(MEMBER, '', 'import');
    await bot.commands.get('wallet')!(ctx);
    expect(ctx.said('All of the above is exposed')).toBe(true); // the Phase 12 flow, untouched
  });

  it('bare /wallet in wallet mode does not advertise import or generate', async () => {
    const ctx = new FakeCtx(MEMBER, '', '');
    await bot.commands.get('wallet')!(ctx);
    expect(ctx.said('WALLET mode')).toBe(true);
    expect(ctx.said('/wallet generate')).toBe(false);
    expect(ctx.said('/wallet import')).toBe(false);
  });
});

// ==========================================================================================
// 3. SWITCHING
// ==========================================================================================

describe('wallet -> key requires the typed custody acknowledgement', () => {
  it('shows the Phase 12 warning VERBATIM and switches nothing until the phrase arrives', async () => {
    const ctx = new FakeCtx(MEMBER, '', 'key');
    await bot.commands.get('mode')!(ctx);

    // Verbatim, and asserted as such: the two must not be able to drift apart.
    expect(ctx.said(exposureWarning())).toBe(true);
    expect(custodyWarning()).toBe(exposureWarning());
    expect(ctx.said(CUSTODY_ACK_PHRASE)).toBe(true);
    expect(await repo.traderMode(MEMBER)).toBe('wallet'); // nothing has changed yet
  });

  it('a WRONG phrase leaves them in wallet mode', async () => {
    const ask = new FakeCtx(MEMBER, '', 'key');
    await bot.commands.get('mode')!(ask);

    const reply = new FakeCtx(MEMBER, 'i understand'); // case matters
    await bot.textHandler!(reply, reply.next);

    expect(reply.said('Not acknowledged')).toBe(true);
    expect(await repo.traderMode(MEMBER)).toBe('wallet');
  });

  it('the EXACT phrase switches, and lands in the settings audit trail', async () => {
    const ask = new FakeCtx(MEMBER, '', 'key');
    await bot.commands.get('mode')!(ask);

    const ack = new FakeCtx(MEMBER, CUSTODY_ACK_PHRASE);
    await bot.textHandler!(ack, ack.next);

    expect(await repo.traderMode(MEMBER)).toBe('key');
    expect(ack.said('KEY mode')).toBe(true);
    // Still holds nothing until they actually import — and the message says so.
    expect(keystore.has(MEMBER)).toBe(false);
    expect(ack.said('Nothing has been imported yet')).toBe(true);

    const audit = await repo.listSettingChanges(MEMBER, 10);
    expect(audit[0]).toMatchObject({ action: 'mode', fromValue: 'wallet', toValue: 'key' });
  });
});

describe('key -> wallet refuses while a custodial schedule is ACTIVE', () => {
  beforeEach(async () => {
    await repo.setAutotraderMode(MEMBER, 'key');
  });

  it('refuses, names the count, and tells them how to clear it', async () => {
    activeSchedules = 2;
    const ctx = new FakeCtx(MEMBER, '', 'wallet');
    await bot.commands.get('mode')!(ctx);

    expect(ctx.said('2 ACTIVE schedule(s)')).toBe(true);
    expect(ctx.said('/stop')).toBe(true);
    expect(await repo.traderMode(MEMBER)).toBe('key'); // refused means UNCHANGED
  });

  it('switches with none active — and LOCKS the keystore rather than destroying it', async () => {
    keystore.generate(MEMBER, 'a-passphrase-long-enough', { overwrite: true });
    keystore.unlock(MEMBER, 'a-passphrase-long-enough');
    expect(keystore.isUnlocked(MEMBER)).toBe(true);

    activeSchedules = 0;
    const ctx = new FakeCtx(MEMBER, '', 'wallet');
    await bot.commands.get('mode')!(ctx);

    expect(await repo.traderMode(MEMBER)).toBe('wallet');
    expect(keystore.isUnlocked(MEMBER)).toBe(false); // locked
    expect(keystore.has(MEMBER)).toBe(true); // NOT destroyed — it is their key
    // NEVER SILENTLY ORPHAN A KEY: the confirmation is also the get-your-funds-out message.
    expect(ctx.said('LOCKED, NOT DELETED')).toBe(true);
    expect(ctx.said('/wallet export')).toBe(true);
    expect(ctx.said('/trader purge')).toBe(true);
  });

  it('says nothing about an orphaned key when there was never a keystore', async () => {
    const ctx = new FakeCtx(MEMBER, '', 'wallet');
    await bot.commands.get('mode')!(ctx);
    expect(ctx.said('LOCKED, NOT DELETED')).toBe(false);
  });
});

describe('the switch rules themselves (pure)', () => {
  it('refuses a no-op switch rather than pretending something happened', () => {
    expect(checkModeSwitch('wallet', 'wallet', 0)).toMatchObject({ ok: false, reason: 'same-mode' });
  });
  it('gates key -> wallet on state, and wallet -> key on nothing', () => {
    expect(checkModeSwitch('key', 'wallet', 1)).toMatchObject({ ok: false, reason: 'active-schedules' });
    expect(checkModeSwitch('key', 'wallet', 0)).toMatchObject({ ok: true });
    // Active schedules cannot exist in wallet mode, but even if they somehow did they must never
    // become a reason to REFUSE giving a key back... and never a reason to skip the warning.
    expect(checkModeSwitch('wallet', 'key', 99)).toMatchObject({ ok: true });
  });
  it('never guesses which mode an unrecognised word meant', () => {
    expect(parseMode('KEY')).toBe('key');
    expect(parseMode(' wallet ')).toBe('wallet');
    expect(parseMode('keys')).toBeNull();
    expect(parseMode('custodial')).toBeNull();
  });
});

// ==========================================================================================
// 4 + 5. BUY-CARD ATTRIBUTION — the pair that has to be asserted together
// ==========================================================================================

function tx(programIds: string[]): ConfirmedTx {
  return {
    slot: 1,
    blockTime: 1_700_000_000,
    transaction: { message: { accountKeys: programIds }, signatures: ['sig'] },
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [] },
  };
}

function buy(overrides: Partial<BuyEvent> = {}): BuyEvent {
  return {
    kind: 'buy',
    signature: 'sig-1',
    slot: 1,
    blockTime: 1_700_000_000,
    mint: RICE,
    buyer: WALLET,
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteSymbol: 'SOL',
    quoteRaw: 100_000_000n,
    tokensRaw: 5_000_000_000n,
    balanceBeforeRaw: 0n,
    balanceAfterRaw: 5_000_000_000n,
    ...overrides,
  } as BuyEvent;
}

describe('the recurring-program check is set membership, not a decoder', () => {
  const check = makeRecurringProgramCheck(DEFAULT_RECURRING_PROGRAM_IDS);

  it('sees a recurring program among the static account keys', () => {
    expect(check(tx(['SomeOtherProgram1111111111111111111111111111', RECURRING]))).toBe(true);
  });

  it('sees one loaded from an ADDRESS LOOKUP TABLE — most Jupiter routes use them', () => {
    const t = tx(['SomeOtherProgram1111111111111111111111111111']);
    (t.meta as { loadedAddresses?: unknown }).loadedAddresses = { writable: [], readonly: [RECURRING] };
    expect(check(t)).toBe(true);
  });

  it('says no to an ordinary swap', () => {
    expect(check(tx(['SomeOtherProgram1111111111111111111111111111']))).toBe(false);
  });

  it('an EMPTY configured set attributes NOTHING — never everything', () => {
    expect(makeRecurringProgramCheck([])(tx([RECURRING]))).toBe(false);
    expect(parseRecurringProgramIds('')).toEqual([]);
    expect(parseRecurringProgramIds(undefined)).toBe(DEFAULT_RECURRING_PROGRAM_IDS);
    expect(parseRecurringProgramIds(` ${RECURRING} , `)).toEqual([RECURRING]);
  });
});

describe('a wallet-mode DCA buy cards as a DCA — through the EXISTING Phase 16 path', () => {
  const attribution = () => makeDcaAttribution({ repo, log, now: () => 1_700_000_500_000 });

  beforeEach(async () => {
    // The Phase 6 wallet-ownership proof is what puts the address in `site_links`.
    await repo.linkSite(MEMBER, WALLET);
  });

  it('is suppressed from organic fan-out and appears in the aggregate window', async () => {
    const e = buy({ viaRecurringProgram: true });
    // The buy is in `buys` exactly as any observed buy is — nothing about ingestion changes.
    await repo.recordBuy({
      signature: e.signature, mint: e.mint, buyer: e.buyer, quoteMint: e.quoteMint, quoteSymbol: e.quoteSymbol,
      quoteRaw: e.quoteRaw, tokensRaw: e.tokensRaw, usdIn: 20, priceUsd: 0.000004, slot: e.slot, blockTime: e.blockTime,
    });

    expect(await attribution().isDca(e)).toBe(true); // -> suppressed from the organic card

    // …and reachable by the SAME query the flusher already used for custodial executions.
    const blockMs = 1_700_000_000_000;
    const rows = await repo.dcaBuysInWindow(RICE, blockMs - 1000, blockMs + 1000);
    expect(rows).toEqual([{ buyer: WALLET, tokensRaw: 5_000_000_000n }]);
  });

  it('buckets by BLOCK TIME, not by when we noticed — a reconnect backlog does not pile into one window', async () => {
    const e = buy({ viaRecurringProgram: true, blockTime: 1_700_000_000 });
    await attribution().isDca(e);
    const row = repo.raw.prepare<[], { at: number }>('SELECT at FROM wallet_dca_buys').get();
    expect(row?.at).toBe(1_700_000_000_000); // block time, not the 1_700_000_500_000 clock
  });

  it('is idempotent — a gap-recovery replay does not double-count it into the aggregate', async () => {
    const e = buy({ viaRecurringProgram: true });
    await repo.recordBuy({
      signature: e.signature, mint: e.mint, buyer: e.buyer, quoteMint: e.quoteMint, quoteSymbol: e.quoteSymbol,
      quoteRaw: e.quoteRaw, tokensRaw: e.tokensRaw, usdIn: 20, priceUsd: 0.000004, slot: e.slot, blockTime: e.blockTime,
    });
    await attribution().isDca(e);
    await attribution().isDca(e); // the replay

    const blockMs = 1_700_000_000_000;
    expect(await repo.dcaBuysInWindow(RICE, blockMs - 1000, blockMs + 1000)).toHaveLength(1);
  });

  it('a KEY-mode member\'s address is not attributed here — their executions already are', async () => {
    await repo.setAutotraderMode(MEMBER, 'key');
    expect(await attribution().isDca(buy({ viaRecurringProgram: true }))).toBe(false);
  });

  it('a REVOKED member stops being attributed immediately — no cache, no TTL', async () => {
    await repo.setAutotraderLocked(MEMBER, true);
    expect(await attribution().isDca(buy({ viaRecurringProgram: true }))).toBe(false);
  });

  it('but a buy ALREADY attributed stays attributed after a revocation — or a replay double-discloses it', async () => {
    const e = buy({ viaRecurringProgram: true });
    expect(await attribution().isDca(e)).toBe(true); // attributed; it is in a published aggregate now

    await repo.setAutotraderLocked(MEMBER, true);

    // The gap-recovery replay. Re-evaluating from scratch would say "not a DCA" and fan this out
    // as an organic card — the same buy, disclosed twice, in two different shapes.
    expect(await attribution().isDca(e)).toBe(true);
    // Revocation still governs their FUTURE buys.
    expect(await attribution().isDca(buy({ signature: 'sig-later', viaRecurringProgram: true }))).toBe(false);
  });

  it('an unlinked stranger using the same program is not attributed', async () => {
    expect(await attribution().isDca(buy({ buyer: OTHER_WALLET, viaRecurringProgram: true }))).toBe(false);
  });
});

describe('a MANUAL buy from the SAME linked wallet does NOT card as DCA', () => {
  it('no recurring program means no attribution — the villager gets their organic buy card', async () => {
    await repo.linkSite(MEMBER, WALLET);
    const attribution = makeDcaAttribution({ repo, log });

    // Same wallet, same mint, same everything — except nobody automated it.
    const manual = buy({ signature: 'sig-manual' }); // viaRecurringProgram left unset
    expect(await attribution.isDca(manual)).toBe(false);

    // Nothing was written, so it cannot leak into a later window either.
    expect(repo.raw.prepare('SELECT COUNT(*) AS n FROM wallet_dca_buys').get()).toEqual({ n: 0 });
  });

  it('an explicit false is treated exactly like an absent flag — only true is evidence', async () => {
    await repo.linkSite(MEMBER, WALLET);
    const attribution = makeDcaAttribution({ repo, log });
    expect(await attribution.isDca(buy({ viaRecurringProgram: false }))).toBe(false);
  });
});

// ==========================================================================================
// THE SCHEDULER RUNS NO TICK FOR A WALLET-MODE USER
// ==========================================================================================

describe('the custodial scheduler signs nothing for a wallet-mode user', () => {
  const valuer: TradeValuer = { usdValueOf: async () => 1, solBalanceLamports: async () => 10_000_000_000n };

  async function seedDueSchedule(): Promise<void> {
    await repo.createSchedule({
      userId: MEMBER, mint: RICE, side: 'buy', amountRaw: 100_000_000n,
      amountKind: 'absolute', intervalMinutes: 5, firstRunAt: 1_000,
    });
  }

  it('skips the due slot without claiming, halting or advancing it', async () => {
    await seedDueSchedule();
    const sched = new Scheduler({ repo, valuer, execute: dryRunExecutor(log), log, now: () => 1_000 });
    const outcomes = await sched.tick();

    expect(outcomes.map((o) => o.kind)).toEqual(['wallet-mode-skipped']);
    expect(repo.raw.prepare('SELECT COUNT(*) AS n FROM executions').get()).toEqual({ n: 0 });
    // Left exactly as its owner left it, in case they switch back.
    const after = (await repo.listSchedules(MEMBER))[0];
    expect(after?.state).toBe('active');
    expect(after?.nextRunAt).toBe(1_000);
  });

  it('fires that same slot the moment the owner is in key mode — the gate is the ONLY difference', async () => {
    await seedDueSchedule();
    await repo.setAutotraderMode(MEMBER, 'key');
    const sched = new Scheduler({ repo, valuer, execute: dryRunExecutor(log), log, now: () => 1_000 });
    expect((await sched.tick()).map((o) => o.kind)).toEqual(['fired']);
  });
});
