import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InputArbiter, registerCancelCommand } from '../src/telegram/input-arbiter.ts';
import { encodeBase58 } from '../src/trade/base58.ts';
import { isSecretKeyBase58, scrub, createLogger } from '../src/ops/logger.ts';
import { SqliteRepo } from '../src/db/sqlite.ts';
import { completePrompt } from '../src/telegram/trade-panel/index.ts';
import { dispatchTradeCommand, applySetContract } from '../src/telegram/trade-panel/commands.ts';
import { PANEL_VERBS as VERBS } from '../src/telegram/trade-panel/render.ts';
import type { Mint } from '../src/core/types.ts';

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const USER = 4242;
const TTL = 10 * 60_000;

/** A REAL-shaped Solana secret key: 64 bytes of seed||pubkey, base58 — exactly what a user pastes
 *  into a DM, and what `isSecretKeyBase58` recognises. Never a fabricated string. */
function realSecretKeyBase58(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return encodeBase58(Buffer.concat([pkcs8.subarray(pkcs8.length - 32), spki.subarray(spki.length - 32)]));
}

// ===========================================================================================
// 1. ONE STATE PER USER, AND /wallet import TAKES PRECEDENCE
// ===========================================================================================

describe('the single DM input arbiter', () => {
  it('with a curation upload pending, /wallet import CANCELS it and claims the next message', () => {
    const a = new InputArbiter(() => 1_000);
    // A meme upload is awaiting.
    expect(a.acquire(USER, 'curation', { ttlMs: TTL })).toEqual({ ok: true, cancelled: null });
    expect(a.owns(USER, 'curation')).toBe(true);

    // /wallet import starts: it takes the slot, and REPORTS what it cancelled so the user is told.
    const claim = a.acquire(USER, 'wallet', { protected: true, ttlMs: TTL });
    expect(claim).toEqual({ ok: true, cancelled: 'meme upload' });

    // The next message belongs to the wallet — and to nobody else.
    expect(a.owns(USER, 'wallet')).toBe(true);
    expect(a.owns(USER, 'curation')).toBe(false);
    expect(a.owns(USER, 'panel')).toBe(false);
  });

  it('while a KEY is awaited, no other handler can take the slot — refused, not queued', () => {
    const a = new InputArbiter(() => 1_000);
    a.acquire(USER, 'wallet', { protected: true, ttlMs: TTL });

    for (const owner of ['panel', 'curation'] as const) {
      const r = a.acquire(USER, owner, { ttlMs: TTL });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.heldBy).toBe('wallet');
      // …and the wallet still owns the slot, so the key still routes to the wallet.
      expect(a.owns(USER, 'wallet')).toBe(true);
    }
  });

  it('never two open at once: a panel prompt displaces a curation upload (and says which)', () => {
    const a = new InputArbiter(() => 1_000);
    a.acquire(USER, 'curation', { ttlMs: TTL });
    const r = a.acquire(USER, 'panel', { ttlMs: TTL });
    expect(r).toEqual({ ok: true, cancelled: 'meme upload' });
    expect(a.owns(USER, 'curation')).toBe(false);
    expect(a.owns(USER, 'panel')).toBe(true);
    expect(a.open).toBe(1); // exactly one slot, ever
  });

  it('the same owner advancing a multi-step flow neither refuses nor reports a cancellation', () => {
    const a = new InputArbiter(() => 1_000);
    a.acquire(USER, 'wallet', { protected: true, ttlMs: TTL }); // import-ack
    const next = a.acquire(USER, 'wallet', { protected: true, ttlMs: TTL }); // -> import-secret
    expect(next).toEqual({ ok: true, cancelled: null });
    expect(a.owns(USER, 'wallet')).toBe(true);
  });

  it('release frees the slot only for its owner, and expiry frees it for everyone', () => {
    const clock = { t: 1_000 };
    const a = new InputArbiter(() => clock.t);
    a.acquire(USER, 'wallet', { protected: true, ttlMs: TTL });
    a.release(USER, 'panel'); // not yours — no effect
    expect(a.owns(USER, 'wallet')).toBe(true);
    a.release(USER, 'wallet');
    expect(a.peek(USER)).toBeNull();

    a.acquire(USER, 'panel', { ttlMs: TTL });
    clock.t += TTL + 1;
    expect(a.peek(USER)).toBeNull(); // expired slots never block anyone
  });

  it('isolates users: one member\'s slot is not another\'s', () => {
    const a = new InputArbiter(() => 1_000);
    a.acquire(USER, 'wallet', { protected: true, ttlMs: TTL });
    expect(a.acquire(999, 'panel', { ttlMs: TTL }).ok).toBe(true); // a different user is unaffected
    expect(a.owns(999, 'panel')).toBe(true);
    expect(a.owns(USER, 'wallet')).toBe(true);
  });
});

// ===========================================================================================
// 2. NEVER ECHO RAW USER INPUT IN A REJECTION
// ===========================================================================================

describe('a pasted secret key is never echoed back', () => {
  let dir: string;
  let repo: SqliteRepo;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ricebuybot-arb-'));
    repo = new SqliteRepo(join(dir, 'test.db'), log);
    await repo.init();
    await repo.addAutotraderUser(USER, 'tester', 1);
  });
  afterEach(async () => {
    await repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the key we test with is a REAL-shaped one (the guard would recognise it)', () => {
    const key = realSecretKeyBase58();
    expect(isSecretKeyBase58(key)).toBe(true);
    expect(key.length).toBeGreaterThan(80);
  });

  it('with an AMOUNT prompt pending, a pasted key is not echoed in the rejection', async () => {
    const key = realSecretKeyBase58();
    await repo.createSchedule({
      userId: USER, mint: MINT, side: 'buy', amountRaw: 50_000_000n, amountKind: 'absolute',
      intervalMinutes: 15, firstRunAt: 1_000,
    });
    const r = await completePrompt(repo, USER, 'amount', key, MINT, 1_000);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(key);
    expect(r.message).toMatch(/amount/i); // says what was EXPECTED instead
  });

  it('NO panel prompt echoes the key, for ANY verb', async () => {
    const key = realSecretKeyBase58();
    await repo.createSchedule({
      userId: USER, mint: MINT, side: 'sell', amountRaw: 1000n, amountKind: 'percent_of_balance',
      intervalMinutes: 60, firstRunAt: 1_000,
    });
    for (const verb of VERBS) {
      const r = await completePrompt(repo, USER, verb, key, MINT, 1_000);
      expect(r.message, `verb ${verb} must not echo the key`).not.toContain(key);
    }
  });

  it('NO typed subcommand echoes the key, in any argument position', async () => {
    const key = realSecretKeyBase58();
    const shapes: string[][] = [
      ['amount', key], ['amount', '1', key], ['interval', key], ['interval', '1', key],
      ['slippage', '1', key], ['pause', key], ['resume', key], ['delete', key],
      ['caps', key, key], ['new', 'buy', key, '15'], [key],
    ];
    for (const tokens of shapes) {
      const r = await dispatchTradeCommand(repo, USER, MINT, tokens, 1_000);
      expect(r.message, `tokens ${tokens[0]} must not echo the key`).not.toContain(key);
    }
  });

  it('a key pasted as a CONTRACT is rejected without echoing it', async () => {
    const key = realSecretKeyBase58();
    const r = await applySetContract(repo, USER, key);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(key);
  });

  it('scrub() is the backstop: a key that somehow reached a reply body is redacted', () => {
    const key = realSecretKeyBase58();
    const leaked = `That isn't valid: ${key}`;
    expect(scrub(leaked)).not.toContain(key);
    expect(scrub(leaked)).toContain('[REDACTED_SECRET_KEY]');
  });

  it('the wallet rejection is a CONSTANT string — it cannot interpolate the input', () => {
    // Structural: the import-secret rejection must not splice anything into the reply.
    const src = readFileSync(join(import.meta.dirname, '..', 'src/telegram/trade-commands.ts'), 'utf8');
    const idx = src.indexOf("case 'import-secret'");
    const block = src.slice(idx, idx + 900);
    expect(block).toContain("doesn't look like a base58 secret key");
    // No template interpolation anywhere in the rejection path for this case.
    const rejection = block.slice(block.indexOf('looksLikeSecretKey'), block.indexOf('setPending'));
    expect(rejection).not.toMatch(/\$\{/);
  });

  it('the panel routes every note through scrub before sending', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src/telegram/trade-panel/index.ts'), 'utf8');
    // Both the send and the edit path wrap the note.
    expect(src).toMatch(/scrub\(note\)/);
    expect((src.match(/scrub\(note\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================================
// 3. ROUTING IS STRUCTURAL, NOT ORDER-DEPENDENT
// ===========================================================================================

describe('routing does not depend on handler registration order', () => {
  it('every DM handler gates on arbiter.owns before processing a message', () => {
    const read = (f: string): string => readFileSync(join(import.meta.dirname, '..', f), 'utf8');
    // The panel and curation both yield unless they hold the slot. The wallet is the protected
    // owner, so while it holds the slot neither of the others can claim the message — whatever
    // order grammY runs them in, and however many handlers are added later.
    expect(read('src/telegram/trade-panel/index.ts')).toMatch(/arbiter\.owns\(userId, 'panel'\)/);
    expect(read('src/telegram/curate/index.ts')).toMatch(/arbiter\.owns\(userId, 'curation'\)/);
    // The wallet syncs the slot with its pending state on every set/clear.
    const wallet = read('src/telegram/trade-commands.ts');
    expect(wallet).toMatch(/arbiter\.acquire\(uid, 'wallet', \{ protected: true/);
    expect(wallet).toMatch(/arbiter\.release\(uid, 'wallet'\)/);
    expect(wallet).not.toMatch(/pending\.set\(userId/); // all sets go through setPending
  });
});

// ===========================================================================================
// 4. /cancel — THE EXIT. One implementation, owned by the arbiter, above every handler.
// ===========================================================================================

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
  nextCalled = false;
  constructor(
    public userId: number,
    public text = '',
    public match = '',
    private chatType = 'private',
  ) {}
  get from() { return { id: this.userId }; }
  get chat() { return { id: this.userId, type: this.chatType }; }
  get message() { return { text: this.text, message_id: 55 }; }
  reply = async (t: string) => { this.replies.push(t); return { message_id: 999 }; };
  api = {
    deleteMessage: async () => undefined,
    sendMessage: async () => undefined,
    editMessageText: async () => undefined,
  };
  next = async () => { this.nextCalled = true; };
}

describe('/cancel is the exit, and it is reachable from inside a protected slot', () => {
  it('releases a WALLET slot, and the panel works IMMEDIATELY afterward — not after the TTL', () => {
    const clock = { t: 1_000 };
    const a = new InputArbiter(() => clock.t);
    const bot = new FakeBot();
    registerCancelCommand(bot as never, a);

    a.acquire(USER, 'wallet', { protected: true, ttlMs: TTL });
    expect(a.acquire(USER, 'panel', { ttlMs: TTL }).ok).toBe(false); // locked out, as designed

    return (async () => {
      const ctx = new FakeCtx(USER);
      await bot.commands.get('cancel')!(ctx);
      expect(ctx.replies[0]).toBe('Cancelled the pending wallet setup.');
      expect(a.peek(USER)).toBeNull();

      // IMMEDIATELY — the clock has not moved, so this proves it is not the TTL expiring.
      expect(clock.t).toBe(1_000);
      expect(a.acquire(USER, 'panel', { ttlMs: TTL }).ok).toBe(true);
    })();
  });

  it('releases a CURATION slot and a PANEL slot, naming each', async () => {
    const a = new InputArbiter(() => 1_000);
    const bot = new FakeBot();
    registerCancelCommand(bot as never, a);

    for (const [owner, label] of [['curation', 'meme upload'], ['panel', 'settings prompt']] as const) {
      a.acquire(USER, owner, { ttlMs: TTL });
      const ctx = new FakeCtx(USER);
      await bot.commands.get('cancel')!(ctx);
      expect(ctx.replies[0]).toBe(`Cancelled the pending ${label}.`);
      expect(a.peek(USER)).toBeNull();
    }
  });

  it('with nothing open replies "Nothing to cancel." and changes nothing', async () => {
    const a = new InputArbiter(() => 1_000);
    const bot = new FakeBot();
    registerCancelCommand(bot as never, a);

    const ctx = new FakeCtx(USER);
    await bot.commands.get('cancel')!(ctx);
    expect(ctx.replies[0]).toBe('Nothing to cancel.');
    expect(a.peek(USER)).toBeNull();
    expect(a.open).toBe(0);
  });

  it('runs the owner cleanup, not just the slot release', async () => {
    const a = new InputArbiter(() => 1_000);
    const bot = new FakeBot();
    registerCancelCommand(bot as never, a);
    const cleared: number[] = [];
    a.onCancel('panel', (uid) => void cleared.push(uid));
    a.acquire(USER, 'panel', { ttlMs: TTL });

    await bot.commands.get('cancel')!(new FakeCtx(USER));
    expect(cleared).toEqual([USER]); // the payload cleanup ran
  });

  it('subsumes non-slot flows via a fallback (the group /setup wizard)', async () => {
    const a = new InputArbiter(() => 1_000);
    const bot = new FakeBot();
    registerCancelCommand(bot as never, a);
    let wizardOpen = true;
    a.onFallbackCancel('group setup', () => {
      if (!wizardOpen) return false;
      wizardOpen = false;
      return true;
    });

    const ctx = new FakeCtx(USER);
    await bot.commands.get('cancel')!(ctx);
    expect(ctx.replies[0]).toBe('Cancelled the pending group setup.');
    // Second time there is nothing left.
    const ctx2 = new FakeCtx(USER);
    await bot.commands.get('cancel')!(ctx2);
    expect(ctx2.replies[0]).toBe('Nothing to cancel.');
  });

  it('a /cancel typed in a GROUP does not reach into the user\'s DM wallet slot', async () => {
    const a = new InputArbiter(() => 1_000);
    const bot = new FakeBot();
    registerCancelCommand(bot as never, a);
    a.acquire(USER, 'wallet', { protected: true, ttlMs: TTL });

    await bot.commands.get('cancel')!(new FakeCtx(USER, '', '', 'supergroup'));
    expect(a.owns(USER, 'wallet')).toBe(true); // untouched from a group
  });
});

describe('/cancel during a real wallet import leaves NO fragment behind', () => {
  it('clears the pending state, not just the slot — and the panel is usable at once', async () => {
    const { Keystore } = await import('../src/trade/keystore.ts');
    const { registerTradeCommands } = await import('../src/telegram/trade-commands.ts');

    const dir = mkdtempSync(join(tmpdir(), 'ricebuybot-cancel-'));
    const repo2 = new SqliteRepo(':memory:', log);
    await repo2.init();
    await repo2.addAutotraderUser(USER, 'tester', 1);
    const arbiter = new InputArbiter();
    const bot = new FakeBot();

    // /cancel FIRST — exactly as boot does it, above the wallet's text handler.
    registerCancelCommand(bot as never, arbiter);
    registerTradeCommands(bot as never, {
      repo: repo2,
      keystore: new Keystore({ dir }),
      rpc: { getBalance: async () => 1n, getOwnedTokenAccountsParsed: async () => [] },
      log,
      unlockConfig: { ownerUserId: 1, ownerPassphrase: undefined },
      primaryMint: MINT,
      primarySymbol: 'RICE',
      pauseSchedules: async () => undefined,
      arbiter,
    });

    // Start a real import: pending = import-ack, slot protected.
    await bot.commands.get('wallet')!(new FakeCtx(USER, '', 'import'));
    expect(arbiter.owns(USER, 'wallet')).toBe(true);
    expect(arbiter.acquire(USER, 'panel', { ttlMs: TTL }).ok).toBe(false);

    // /cancel — reachable even though the wallet slot is PROTECTED.
    const cancelCtx = new FakeCtx(USER);
    await bot.commands.get('cancel')!(cancelCtx);
    expect(cancelCtx.replies[0]).toBe('Cancelled the pending wallet setup.');
    expect(arbiter.peek(USER)).toBeNull();

    // NO FRAGMENT of the pending state survives: the wallet's text handler now passes the message
    // straight through instead of reading it as the import's next step.
    const after = new FakeCtx(USER, 'I UNDERSTAND');
    await bot.textHandler!(after, after.next);
    expect(after.nextCalled).toBe(true);
    expect(after.replies).toEqual([]);

    // …and the panel can take the slot at once.
    expect(arbiter.acquire(USER, 'panel', { ttlMs: TTL }).ok).toBe(true);

    await repo2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('every refusal names its own exit', () => {
  it('the precedence refusals contain "/cancel" (so they cannot regress into dead ends)', () => {
    const read = (f: string): string => readFileSync(join(import.meta.dirname, '..', f), 'utf8');
    for (const f of ['src/telegram/trade-panel/index.ts', 'src/telegram/curate/index.ts']) {
      const src = read(f);
      const refusal = /Finish your \$\{claim\.heldLabel\}[^`]*/.exec(src)?.[0] ?? '';
      expect(refusal, `${f} refusal must name its exit`).toContain('/cancel');
    }
  });

  it('there is exactly ONE /cancel implementation, and it is the arbiter\'s', () => {
    const read = (f: string): string => readFileSync(join(import.meta.dirname, '..', f), 'utf8');
    expect(read('src/telegram/input-arbiter.ts')).toMatch(/bot\.command\('cancel'/);
    // The group-config surface no longer registers its own; it hooks in as a fallback.
    const cmds = read('src/telegram/commands.ts');
    expect(cmds).not.toMatch(/bot\.command\('cancel'/);
    expect(cmds).toMatch(/onFallbackCancel\('group setup'/);
  });

  it('boot registers /cancel BEFORE every handler that could swallow the message', () => {
    const boot = readFileSync(join(import.meta.dirname, '..', 'src/index.ts'), 'utf8');
    const at = (needle: string): number => boot.indexOf(needle);
    const cancelAt = at('registerCancelCommand(telegram.bot');
    expect(cancelAt).toBeGreaterThan(-1);
    // The wallet's text handler is the one that would read "/cancel" as a passphrase.
    for (const later of ['registerCommands(telegram.bot', 'registerCuration(telegram.bot', 'registerTradeCommands(telegram.bot', 'registerTradePanel(telegram.bot']) {
      expect(cancelAt, `/cancel must be registered before ${later}`).toBeLessThan(at(later));
    }
  });
});
