import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capabilities, isPlan, UPSELL } from '../src/core/plans.js';
import { DEFAULT_LINKS } from '../src/core/links.js';
import { SqliteRepo } from '../src/db/sqlite.js';
import { effective, gate, gateMints, capsOf, planOf, setPlanWhitelist } from '../src/telegram/plan-gate.js';
import { DeliveryQueue } from '../src/telegram/queue.js';
import { createLogger } from '../src/ops/logger.js';
import type { ChatId, ChatToken, Mint, Signature } from '../src/core/types.js';
import type { Outbound, Sender } from '../src/telegram/sender.js';

const log = createLogger('silent' as 'info', false);
const RICE = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Mint;
const CHAT = -1001 as ChatId;

let dir: string;
let repo: SqliteRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-plan-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  await repo.upsertChat({ chatId: CHAT, title: 'g', addedBy: 1, paused: false });
});

afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

// =============================================================================
// THE CAPABILITY TABLE
// =============================================================================

describe('plans', () => {
  it('free gets one mint, unicode emoji, static media, a 5s delay, default links', () => {
    const c = capabilities('free');
    expect(c).toEqual({
      maxMints: 1,
      customEmoji: false,
      mediaPool: false,
      postDelayMs: 5_000,
      customLinks: false,
    });
  });

  it('paid gets the pool, custom emoji, instant posts, several mints, custom links', () => {
    const c = capabilities('paid');
    expect(c.mediaPool).toBe(true);
    expect(c.customEmoji).toBe(true);
    expect(c.postDelayMs).toBe(0);
    expect(c.maxMints).toBeGreaterThan(1);
    expect(c.customLinks).toBe(true);
  });

  it('every chat starts on free — a migration does not gift anybody the paid plan', async () => {
    // The abstention principle applied to money: no existing row carries any evidence that
    // somebody paid, so defaulting them to `paid` would silently hand out the full feature set
    // forever, and nobody would notice, because gaining features is invisible.
    expect((await repo.getChat(CHAT))?.plan).toBe('free');
  });

  it('an unknown plan cannot even be WRITTEN — the DB refuses it', () => {
    // Defence in depth, and the DB is the outer layer: a typo in a future migration, or an
    // operator poking at sqlite3, cannot invent an 'enterprise' plan that the code would then
    // have to guess about.
    expect(() => repo.raw.prepare("UPDATE chats SET plan = 'enterprise' WHERE chat_id = ?").run(CHAT)).toThrow(
      /CHECK constraint/i,
    );
    expect(isPlan('enterprise')).toBe(false);
  });

  it('and if one ever got past the DB, it would degrade to free — never to paid', async () => {
    // The inner layer. `isPlan` gates the hydration, so an unrecognised value fails towards
    // the safe side of the money rather than gifting the full feature set.
    repo.raw.prepare('PRAGMA ignore_check_constraints = ON').run();
    repo.raw.prepare("UPDATE chats SET plan = 'enterprise' WHERE chat_id = ?").run(CHAT);

    expect((await repo.getChat(CHAT))?.plan).toBe('free');
  });

  it('/grant records who granted it and when', async () => {
    await repo.setPlan(CHAT, 'paid', 999);
    const chat = await repo.getChat(CHAT);

    expect(chat?.plan).toBe('paid');
    expect(chat?.planGrantedBy).toBe(999);
    expect(chat?.planGrantedAt).toBeGreaterThan(0);
  });

  it('upsertChat cannot change a plan — only /grant can', async () => {
    await repo.setPlan(CHAT, 'paid', 1);
    // A `my_chat_member` update (a rename, a re-add) must not be a chance to reset billing.
    await repo.upsertChat({ chatId: CHAT, title: 'renamed', addedBy: 1, paused: false });
    expect((await repo.getChat(CHAT))?.plan).toBe('paid');
  });
});

// =============================================================================
// /approve — owner pre-approval of any group id, for all features
// =============================================================================

describe('/approve (owner DM)', () => {
  const NEW_GROUP = -1009999 as ChatId; // a group the bot has never seen

  it('pre-approves a group the bot has never seen, then planOf reads it back as paid', async () => {
    // The /approve path: create the row when there is none, then grant paid. This is what
    // /grant deliberately refuses (it knows no such chat), because pre-approval must work
    // BEFORE any my_chat_member row exists.
    expect(await repo.getChat(NEW_GROUP)).toBeNull();

    await repo.upsertChat({ chatId: NEW_GROUP, title: null, addedBy: null, paused: false });
    await repo.setPlan(NEW_GROUP, 'paid', 42);

    expect(await planOf(repo, NEW_GROUP)).toBe('paid');
    expect((await capsOf(repo, NEW_GROUP)).mediaPool).toBe(true);
    // Recorded as a fact — who approved it and when — unlike the env whitelist.
    const chat = await repo.getChat(NEW_GROUP);
    expect(chat?.planGrantedBy).toBe(42);
    expect(chat?.planGrantedAt).toBeGreaterThan(0);
  });

  it('applies the moment the bot joins — the join does not reset the grant', async () => {
    await repo.upsertChat({ chatId: NEW_GROUP, title: null, addedBy: null, paused: false });
    await repo.setPlan(NEW_GROUP, 'paid', 42);

    // my_chat_member fires on join and upserts with the real title/owner. Plan must survive it.
    await repo.upsertChat({ chatId: NEW_GROUP, title: 'Partner Group', addedBy: 7, paused: false });
    expect((await repo.getChat(NEW_GROUP))?.plan).toBe('paid');
  });

  it('/unapprove flips it back to free', async () => {
    await repo.upsertChat({ chatId: NEW_GROUP, title: null, addedBy: null, paused: false });
    await repo.setPlan(NEW_GROUP, 'paid', 42);
    expect(await planOf(repo, NEW_GROUP)).toBe('paid');

    await repo.setPlan(NEW_GROUP, 'free', 42);
    expect(await planOf(repo, NEW_GROUP)).toBe('free');
  });
});

// =============================================================================
// GATES
// =============================================================================

describe('gates', () => {
  it('free tracks one mint; paid tracks more', () => {
    expect(gateMints(capabilities('free'), 0).allowed).toBe(true);
    expect(gateMints(capabilities('free'), 1).allowed).toBe(false);
    expect(gateMints(capabilities('free'), 1).why).toBe(UPSELL.maxMints);

    expect(gateMints(capabilities('paid'), 1).allowed).toBe(true);
    expect(gateMints(capabilities('paid'), 9).allowed).toBe(true);
    expect(gateMints(capabilities('paid'), 10).allowed).toBe(false);
  });

  it('the pool, custom emoji and custom links are paid', () => {
    const free = capabilities('free');
    const paid = capabilities('paid');

    for (const key of ['mediaPool', 'customEmoji', 'customLinks'] as const) {
      expect(gate(free, key).allowed).toBe(false);
      expect(gate(free, key).why).toBe(UPSELL[key]);
      expect(gate(paid, key).allowed).toBe(true);
    }
  });

  it('the upsell says what they GET, not what they are missing', () => {
    // A group hitting a limit is a group USING the bot. Be gracious about it.
    expect(UPSELL.mediaPool).toContain('you can still set ONE image');
    expect(UPSELL.customEmoji).toContain('still works with any standard emoji');
    expect(UPSELL.customLinks).toContain('still get DexTools');
  });

  it('reads the plan from the DB', async () => {
    expect((await capsOf(repo, CHAT)).mediaPool).toBe(false);
    await repo.setPlan(CHAT, 'paid', 1);
    expect((await capsOf(repo, CHAT)).mediaPool).toBe(true);
  });
});

// =============================================================================
// THE DOWNGRADE — the case the whole design turns on
// =============================================================================

describe('a downgraded chat', () => {
  /**
   * The obvious design gates only the /setX commands: a free chat is never ALLOWED to set a
   * custom emoji, so it never HAS one. That holds right up until a plan is downgraded — and
   * then the chat is sitting there with `emoji_custom_id` set, `media_mode = 'pool'` and six
   * custom buttons, every one of them configured perfectly legally while it was paying.
   *
   * If the gate lives only in the setters, that chat keeps every paid feature FOREVER and the
   * downgrade is a no-op. So the send path clamps too.
   */
  const paidConfig = {
    mint: RICE,
    mediaMode: 'pool' as const,
    emoji: '🍚',
    emojiCustomId: '5368324170671202286',
    staticFileId: 'STATIC',
    staticKind: 'photo' as const,
    links: { DexT: 'x', Custom: 'https://mine' },
  } as unknown as ChatToken;

  it('keeps every paid feature if you only gate the setters — which is why we do not', () => {
    // The stored config, ungated, still says pool + custom emoji + custom links.
    expect(paidConfig.mediaMode).toBe('pool');
    expect(paidConfig.emojiCustomId).not.toBeNull();
  });

  it('is clamped at the point of USE, so the downgrade takes effect immediately', () => {
    const eff = effective(paidConfig, capabilities('free'), DEFAULT_LINKS);

    expect(eff.mediaMode).toBe('static'); // the pool falls back to their one image
    expect(eff.emojiCustomId).toBeNull(); // premium rendering gone...
    expect(eff.links).toBe(DEFAULT_LINKS); // custom buttons gone
    expect(eff.postDelayMs).toBe(5_000); // and posts are 5s late again
  });

  it('loses NOTHING it had configured — an upgrade restores it instantly', () => {
    const eff = effective(paidConfig, capabilities('paid'), DEFAULT_LINKS);

    // The row was never rewritten. We gate what the plan CAN DO, we do not delete what the
    // chat has SAID.
    expect(eff.mediaMode).toBe('pool');
    expect(eff.emojiCustomId).toBe('5368324170671202286');
    expect(eff.links).toEqual(paidConfig.links);
    expect(eff.postDelayMs).toBe(0);
  });

  it('still has its emoji ladder — the unicode glyph WAS always the text', () => {
    // A custom_emoji entity only ever decorated the glyph underneath (render/emoji.ts). So
    // dropping the entity costs the premium rendering and nothing else: the grains are still
    // there. A downgrade that emptied the ladder would look like a bug, not a plan.
    const eff = effective(paidConfig, capabilities('free'), DEFAULT_LINKS);
    expect(eff.emojiCustomId).toBeNull();
    expect(paidConfig.emoji).toBe('🍚'); // the text is untouched
  });

  it('a free chat with no static image degrades to a TEXT card, not to silence', () => {
    const noImage = { ...paidConfig, staticFileId: null } as unknown as ChatToken;
    const eff = effective(noImage, capabilities('free'), DEFAULT_LINKS);

    expect(eff.mediaMode).toBe('static');
    // resolveMedia() then finds no static file_id and sends text-only. The buy still posts.
    // Never fail a post because art is missing.
  });
});

// =============================================================================
// THE 5s DELAY
// =============================================================================

describe('the free plan posts 5 seconds late', () => {
  const card = { text: 'x', entities: [], keyboard: [], ladderCount: 1, ladderTruncated: false };
  const job = (n: number, delayMs: number, enqueuedAt = Date.now()) => ({
    signature: `sig${n}`.padEnd(88, 'x') as Signature,
    chatId: CHAT,
    enqueuedAt,
    delayMs,
    build: async (): Promise<Outbound> => ({ chatId: CHAT, card, fileId: null, kind: null }),
  });

  it('holds a free card for 5s and an instant one for none', async () => {
    const slept: number[] = [];
    const sent: string[] = [];
    const sender: Sender = {
      send: async () => {
        sent.push('x');
        return sent.length;
      },
    };
    const q = new DeliveryQueue({
      repo,
      sender,
      log,
      perChatMs: 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    q.enqueue(job(1, 5_000));
    await new Promise((r) => setTimeout(r, 30));
    expect(slept).toContain(5_000);
    expect(sent).toHaveLength(1); // delayed, NOT dropped

    slept.length = 0;
    q.enqueue(job(2, 0));
    await new Promise((r) => setTimeout(r, 30));
    expect(slept.filter((ms) => ms > 0)).toEqual([]); // paid: no hold at all
  });

  it('never costs a free chat a buy — 5s is nowhere near the 120s staleness rule', async () => {
    const sent: string[] = [];
    const sender: Sender = {
      send: async () => {
        sent.push('x');
        return 1;
      },
    };
    const q = new DeliveryQueue({ repo, sender, log, perChatMs: 0, sleep: async () => {} });

    q.enqueue(job(3, 5_000));
    await new Promise((r) => setTimeout(r, 30));

    // A plan that silently ate buys would look broken, not slow — a cruel way to sell an
    // upgrade and a worse way to keep a free user.
    expect(sent).toHaveLength(1);
  });

  it('does not add the delay on top of a wait the chat has already served', async () => {
    const slept: number[] = [];
    const sender: Sender = { send: async () => 1 };
    const q = new DeliveryQueue({
      repo,
      sender,
      log,
      perChatMs: 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    // Enqueued 4s ago (it was stuck behind a 429). Only 1s of the 5s hold is left.
    q.enqueue(job(4, 5_000, Date.now() - 4_000));
    await new Promise((r) => setTimeout(r, 30));

    const held = slept.filter((ms) => ms > 0);
    expect(held[0]).toBeLessThanOrEqual(1_100);
    expect(held[0]).toBeGreaterThan(0);
  });
});

// =============================================================================
// MULTI-MINT
// =============================================================================

describe('multiple mints', () => {
  it('free chats hold one; paid chats hold several', async () => {
    await repo.addChatToken(CHAT, RICE);
    expect(gateMints(await capsOf(repo, CHAT), (await repo.listChatTokens(CHAT)).length).allowed).toBe(false);

    await repo.setPlan(CHAT, 'paid', 1);
    expect(gateMints(await capsOf(repo, CHAT), (await repo.listChatTokens(CHAT)).length).allowed).toBe(true);

    await repo.addChatToken(CHAT, BONK);
    expect(await repo.listChatTokens(CHAT)).toHaveLength(2);
  });
});

// =============================================================================
// PLAN_WHITELIST — premium without paying
// =============================================================================

describe('PLAN_WHITELIST', () => {
  afterEach(() => setPlanWhitelist([]));

  it('a whitelisted chat gets the paid feature set with no DB row and no payment', async () => {
    expect(await planOf(repo, CHAT)).toBe('free');

    setPlanWhitelist([CHAT as unknown as number]);

    expect(await planOf(repo, CHAT)).toBe('paid');
    expect((await capsOf(repo, CHAT)).mediaPool).toBe(true);
    expect((await capsOf(repo, CHAT)).postDelayMs).toBe(0);

    // Nothing was written. Removing the id from the env removes the entitlement — there is no
    // row to find and unpick later.
    expect((await repo.getChat(CHAT))?.plan).toBe('free');
  });

  it('removing it from the list takes the entitlement away again', async () => {
    setPlanWhitelist([CHAT as unknown as number]);
    expect(await planOf(repo, CHAT)).toBe('paid');

    setPlanWhitelist([]);
    expect(await planOf(repo, CHAT)).toBe('free');
  });

  it('only UPGRADES — it never downgrades a chat that actually paid', async () => {
    await repo.setPlan(CHAT, 'paid', 1);
    setPlanWhitelist([]); // not on the list

    // A chat that bought the plan keeps it, whitelist or no whitelist.
    expect(await planOf(repo, CHAT)).toBe('paid');
  });

  it('does not leak to chats that are not on the list', async () => {
    setPlanWhitelist([-9999]);
    expect(await planOf(repo, CHAT)).toBe('free');
  });
});
