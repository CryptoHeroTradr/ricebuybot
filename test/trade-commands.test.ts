import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import pino from 'pino';

import { SqliteRepo } from '../src/db/sqlite.js';
import { Keystore } from '../src/trade/keystore.js';
import { registerTradeCommands, type TradeCommandDeps } from '../src/telegram/trade-commands.js';
import { renderWallet, exposureWarning, fetchInventory, type WalletRpc } from '../src/trade/wallet.js';
import { bootNotices, envUnlock, unlockModeFor } from '../src/trade/unlock.js';
import { decodeBase58 } from '../src/trade/base58.js';

const log = pino({ level: 'silent' });
const RICE = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump';
const OWNER = 1000;
const MEMBER = 2000;
const STRANGER = 3000;

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'rbb-cmd-'));

// --- a Telegram surface small enough to assert against ------------------------------------

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
  deleted: Array<{ chatId: number; messageId: number }> = [];
  dmsSent: Array<{ to: number; text: string }> = [];
  nextCalled = false;

  constructor(
    public userId: number,
    public text = '',
    public match = '',
    private opts: { chatType?: string; deleteFails?: boolean; messageId?: number } = {},
  ) {}

  get from() {
    return { id: this.userId };
  }
  get chat() {
    return { id: this.userId, type: this.opts.chatType ?? 'private' };
  }
  get message() {
    return { text: this.text, message_id: this.opts.messageId ?? 55 };
  }
  reply = async (text: string) => {
    this.replies.push(text);
    return { message_id: 999 };
  };
  api = {
    deleteMessage: async (chatId: number, messageId: number) => {
      if (this.opts.deleteFails) throw new Error('message to delete not found');
      this.deleted.push({ chatId, messageId });
    },
    sendMessage: async (to: number, text: string) => {
      this.dmsSent.push({ to, text });
    },
  };
  next = async () => {
    this.nextCalled = true;
  };
}

const rpc: WalletRpc = {
  getBalance: async () => 2_410_000_000n,
  getOwnedTokenAccountsParsed: async () => [
    { mint: RICE, amountRaw: 8_204_113_000_000n, decimals: 6 },
    { mint: 'Bonk1111111111111111111111111111111111111111', amountRaw: 500n, decimals: 5 },
    { mint: 'Nft11111111111111111111111111111111111111111', amountRaw: 1n, decimals: 0 },
    { mint: 'Nft22222222222222222222222222222222222222222', amountRaw: 1n, decimals: 0 },
  ],
};

let repo: SqliteRepo;
let keystore: Keystore;
let bot: FakeBot;
let paused: number[];

function setup(): TradeCommandDeps {
  repo = new SqliteRepo(':memory:', log);
  keystore = new Keystore({ dir: tmpDir() });
  bot = new FakeBot();
  paused = [];

  const deps: TradeCommandDeps = {
    repo,
    keystore,
    rpc,
    log,
    unlockConfig: { ownerUserId: OWNER, ownerPassphrase: undefined },
    primaryMint: RICE,
    primarySymbol: 'RICE',
    pauseSchedules: async (userId) => {
      paused.push(userId);
    },
  };
  registerTradeCommands(bot as any, deps);
  return deps;
}

beforeEach(async () => {
  setup();
  await repo.init(); // runs migrations, including 012_autotrader_users
  await repo.addAutotraderUser(MEMBER, 'member', OWNER);
});

// ------------------------------------------------------------------------------------------
// SILENCE (INVARIANT 14)
// ------------------------------------------------------------------------------------------

describe('a non-member gets NO reply (INVARIANT 14)', () => {
  it('/wallet says nothing at all to a stranger', async () => {
    const ctx = new FakeCtx(STRANGER, '', '');
    await bot.commands.get('wallet')!(ctx);
    // Not a refusal. Not "unknown command". NOTHING — a refusal is an oracle.
    expect(ctx.replies).toEqual([]);
  });

  it('/unlock says nothing to a stranger', async () => {
    const ctx = new FakeCtx(STRANGER, '', '');
    await bot.commands.get('unlock')!(ctx);
    expect(ctx.replies).toEqual([]);
  });

  it('/trader says nothing to a non-owner, even a member', async () => {
    const ctx = new FakeCtx(MEMBER, '', 'list');
    await bot.commands.get('trader')!(ctx);
    expect(ctx.replies).toEqual([]);
  });

  it('a REVOKED member is silenced at action time, with no restart', async () => {
    const ok = new FakeCtx(MEMBER, '', '');
    await bot.commands.get('wallet')!(ok);
    expect(ok.replies.length).toBeGreaterThan(0);

    await repo.setAutotraderLocked(MEMBER, true);

    const after = new FakeCtx(MEMBER, '', '');
    await bot.commands.get('wallet')!(after);
    expect(after.replies).toEqual([]); // immediately, no cache to expire
  });

  it('says nothing in a group, so membership is not disclosed to the room', async () => {
    const ctx = new FakeCtx(MEMBER, '', '', { chatType: 'supergroup' });
    await bot.commands.get('wallet')!(ctx);
    expect(ctx.replies).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// /wallet import — acknowledgement first, deletion always
// ------------------------------------------------------------------------------------------

describe('/wallet import', () => {
  it('refuses to accept a key until the warning is acknowledged', async () => {
    const start = new FakeCtx(MEMBER, '', 'import');
    await bot.commands.get('wallet')!(start);

    // The warning is shown FIRST and the key is not asked for yet.
    expect(start.replies[0]).toContain('All of the above is exposed');
    expect(start.replies[0]).toContain('I UNDERSTAND');
    expect(start.replies[0]).not.toContain('Send your base58');

    // Anything other than the exact phrase aborts.
    const wrong = new FakeCtx(MEMBER, 'ok sure');
    await bot.textHandler!(wrong, wrong.next);
    expect(wrong.replies.join()).toContain('Not acknowledged');

    // And the flow is over — a secret sent now is not treated as an import.
    const late = new FakeCtx(MEMBER, 'x'.repeat(88));
    await bot.textHandler!(late, late.next);
    expect(keystore.has(MEMBER)).toBe(false);
  });

  it('accepts the key only after the exact phrase, and DELETES the message', async () => {
    await bot.commands.get('wallet')!(new FakeCtx(MEMBER, '', 'import'));

    const ack = new FakeCtx(MEMBER, 'I UNDERSTAND');
    await bot.textHandler!(ack, ack.next);
    expect(ack.replies.join()).toContain('Send your base58 secret key');

    // A real key, produced the way /wallet generate produces one.
    const gen = new Keystore({ dir: tmpDir() });
    const { secretBase58 } = gen.generate(1, 'x');

    const send = new FakeCtx(MEMBER, secretBase58, '', { messageId: 77 });
    await bot.textHandler!(send, send.next);

    // THE ASSERTION: the message carrying the key was deleted.
    expect(send.deleted).toEqual([{ chatId: MEMBER, messageId: 77 }]);
    expect(send.replies.join()).toContain('deleted');

    const pass = new FakeCtx(MEMBER, 'my-passphrase', '', { messageId: 78 });
    await bot.textHandler!(pass, pass.next);
    expect(pass.deleted).toEqual([{ chatId: MEMBER, messageId: 78 }]); // passphrase too
    expect(keystore.has(MEMBER)).toBe(true);
    expect(keystore.isUnlocked(MEMBER)).toBe(true);
  });

  /**
   * The key is now in Telegram's history and outside our control. Saying "imported!" and
   * moving on is how somebody keeps using an effectively public key.
   */
  it('is LOUD when the message cannot be deleted', async () => {
    await bot.commands.get('wallet')!(new FakeCtx(MEMBER, '', 'import'));
    const ack = new FakeCtx(MEMBER, 'I UNDERSTAND');
    await bot.textHandler!(ack, ack.next);

    const gen = new Keystore({ dir: tmpDir() });
    const { secretBase58 } = gen.generate(1, 'x');

    const send = new FakeCtx(MEMBER, secretBase58, '', { deleteFails: true });
    await bot.textHandler!(send, send.next);

    const shouted = send.replies.join('\n');
    expect(shouted).toContain('COULD NOT DELETE');
    expect(shouted).toContain('COMPROMISED');
  });

  it('never echoes a rejected key back to the user', async () => {
    await bot.commands.get('wallet')!(new FakeCtx(MEMBER, '', 'import'));
    const ack = new FakeCtx(MEMBER, 'I UNDERSTAND');
    await bot.textHandler!(ack, ack.next);

    const nearMiss = 'z'.repeat(60); // wrong shape, but could be most of a real key
    const send = new FakeCtx(MEMBER, nearMiss);
    await bot.textHandler!(send, send.next);

    expect(send.replies.join()).not.toContain(nearMiss);
    expect(send.deleted.length).toBe(1); // deleted anyway — we do not know what it was
  });
});

// ------------------------------------------------------------------------------------------
// /wallet — the warning, every time
// ------------------------------------------------------------------------------------------

describe('/wallet inventory and warning', () => {
  it('lists real balances and an NFT count', async () => {
    const inv = await fetchInventory(rpc, 'PubKey', RICE, 'RICE');
    expect(inv.nfts).toBe(2);
    expect(inv.otherTokens).toBe(1); // BONK; the NFTs are not double-counted
    expect(inv.primary?.amountRaw).toBe(8_204_113_000_000n);

    const text = renderWallet(inv, { unlocked: true, mode: 'dm' });
    expect(text).toContain('2.41 SOL');
    expect(text).toContain('8,204,113 RICE');
    expect(text).toContain('+ 1 other token');
    expect(text).toContain('+ 2 NFTs');
  });

  it('shows the exposure warning EVERY time, not just the first', async () => {
    const first = new FakeCtx(MEMBER, '', '');
    const second = new FakeCtx(MEMBER, '', '');

    keystore.generate(MEMBER, 'pw');
    await bot.commands.get('wallet')!(first);
    await bot.commands.get('wallet')!(second);

    for (const ctx of [first, second]) {
      const text = ctx.replies.join('\n');
      expect(text).toContain('All of the above is exposed');
      expect(text).toContain("only what you'd accept losing");
      // And the honest caveat, which must never be edited out.
      expect(text).toContain('That limits the BOT, not an');
    }
  });

  it('always states which unlock mode is active', () => {
    const inv = { pubkey: 'AAAA', lamports: 0n, primary: null, primarySymbol: 'RICE', otherTokens: 0, nfts: 0 };
    expect(renderWallet(inv, { unlocked: false, mode: 'dm' })).toContain('locked · DM unlock');
    expect(renderWallet(inv, { unlocked: true, mode: 'env' })).toContain('unlocked · env unlock');
  });

  it('does not itemise the other tokens — a count is a warning, a list is surveillance', async () => {
    const inv = await fetchInventory(rpc, 'PubKey', RICE, 'RICE');
    const text = renderWallet(inv, { unlocked: true, mode: 'dm' });
    expect(text).not.toContain('Bonk1111');
    expect(text).not.toContain('Nft1111');
  });

  it('/wallet lock zeroes the key and pauses that user only', async () => {
    keystore.generate(MEMBER, 'pw');
    keystore.unlock(MEMBER, 'pw');

    await bot.commands.get('wallet')!(new FakeCtx(MEMBER, '', 'lock'));
    expect(keystore.isUnlocked(MEMBER)).toBe(false);
    expect(paused).toEqual([MEMBER]);
    expect(keystore.has(MEMBER)).toBe(true); // locking never destroys
  });
});

// ------------------------------------------------------------------------------------------
// /trader — membership, not money
// ------------------------------------------------------------------------------------------

describe('/trader (owner only)', () => {
  it('remove REVOKES but does not destroy the keystore (INVARIANT 14)', async () => {
    keystore.generate(MEMBER, 'pw');
    keystore.unlock(MEMBER, 'pw');

    const ctx = new FakeCtx(OWNER, '', `remove ${MEMBER}`);
    await bot.commands.get('trader')!(ctx);

    expect((await repo.getAutotraderUser(MEMBER))?.locked).toBe(true);
    expect(paused).toContain(MEMBER);
    expect(keystore.isUnlocked(MEMBER)).toBe(false);
    expect(keystore.has(MEMBER)).toBe(true); // THE POINT: their key survives revocation
    expect(ctx.replies.join()).toContain('NOT deleted');
  });

  it('purge requires the typed phrase, destroys the key, and TELLS the user', async () => {
    keystore.generate(MEMBER, 'pw');

    await bot.commands.get('trader')!(new FakeCtx(OWNER, '', `purge ${MEMBER}`));

    const wrong = new FakeCtx(OWNER, 'yes');
    await bot.textHandler!(wrong, wrong.next);
    expect(keystore.has(MEMBER)).toBe(true);
    expect(wrong.replies.join()).toContain('Not purged');

    await bot.commands.get('trader')!(new FakeCtx(OWNER, '', `purge ${MEMBER}`));
    const right = new FakeCtx(OWNER, 'DESTROY THIS KEY');
    await bot.textHandler!(right, right.next);

    expect(keystore.has(MEMBER)).toBe(false);
    expect(right.dmsSent.map((d) => d.to)).toContain(MEMBER);
    expect(right.dmsSent[0]?.text).toContain('deleted by the operator');
  });

  it('list shows membership and wallet state — never pubkeys or balances', async () => {
    keystore.generate(MEMBER, 'pw');
    const ctx = new FakeCtx(OWNER, '', 'list');
    await bot.commands.get('trader')!(ctx);

    const text = ctx.replies.join('\n');
    expect(text).toContain(String(MEMBER));
    expect(text).toContain('locked');
    expect(text).not.toContain(keystore.pubkeyOf(MEMBER)!);
  });
});

// ------------------------------------------------------------------------------------------
// unlock model
// ------------------------------------------------------------------------------------------

describe('unlock model', () => {
  it('env unlock is the OWNER\'S OWN keystore and nobody else\'s', () => {
    const ks = new Keystore({ dir: tmpDir() });
    ks.generate(OWNER, 'owner-pass');
    ks.generate(MEMBER, 'member-pass');

    // Even with the member's passphrase in the env slot, envUnlock only ever considers the
    // owner id — there is no argument that redirects it at somebody else.
    expect(envUnlock(ks, { ownerUserId: OWNER, ownerPassphrase: 'member-pass' }, log)).toEqual([]);
    expect(ks.isUnlocked(MEMBER)).toBe(false);

    expect(envUnlock(ks, { ownerUserId: OWNER, ownerPassphrase: 'owner-pass' }, log)).toEqual([OWNER]);
  });

  it('reports the mode per user, so nobody has to guess', () => {
    const cfg = { ownerUserId: OWNER, ownerPassphrase: 'x' };
    expect(unlockModeFor(cfg, OWNER)).toBe('env');
    expect(unlockModeFor(cfg, MEMBER)).toBe('dm');
    expect(unlockModeFor({ ownerUserId: OWNER, ownerPassphrase: undefined }, OWNER)).toBe('dm');
  });

  it('a restart notifies every member whose wallet is now locked', async () => {
    const ks = new Keystore({ dir: tmpDir() });
    ks.generate(MEMBER, 'pw');
    await repo.addAutotraderUser(OWNER, 'owner', OWNER);
    ks.generate(OWNER, 'pw');

    const notices = await bootNotices(repo, ks, [OWNER]);
    expect(notices.map((n) => n.userId)).toEqual([MEMBER]); // the owner was env-unlocked
    expect(notices[0]?.text).toContain('schedules are paused');
    expect(notices[0]?.text).toContain('/unlock');
  });

  it('does not pester a revoked member', async () => {
    const ks = new Keystore({ dir: tmpDir() });
    ks.generate(MEMBER, 'pw');
    await repo.setAutotraderLocked(MEMBER, true);
    expect(await bootNotices(repo, ks, [])).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// no secret anywhere
// ------------------------------------------------------------------------------------------

describe('no secret key reaches storage', () => {
  it('nothing in SQLite contains the key, in any table', async () => {
    const ks = new Keystore({ dir: tmpDir() });
    const { secretBase58, pubkey } = ks.generate(MEMBER, 'pw');
    await repo.addAutotraderUser(MEMBER, 'member', OWNER);
    await repo.logAutotraderAccess(MEMBER, 'add', OWNER);

    const db = repo.raw;
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);

    const secretBytes = Buffer.from(decodeBase58(secretBase58)).toString('hex');
    for (const table of tables) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all());
      expect(dump).not.toContain(secretBase58);
      expect(dump).not.toContain(secretBytes);
    }
    // The PUBLIC key is fine anywhere; it is the secret that must not appear.
    expect(pubkey.length).toBeGreaterThan(0);
  });

  it('the exposure warning names the real limit of the guard', () => {
    // Regression guard on the wording: if someone ever "tidies" this into implying the mint
    // guard protects the wallet, the warning starts manufacturing false confidence.
    expect(exposureWarning()).toContain('That limits the BOT, not an');
    expect(exposureWarning()).toContain('attacker holding your key');
  });
});
