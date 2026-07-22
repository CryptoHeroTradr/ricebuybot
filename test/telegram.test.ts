import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.js';
import { DeliveryQueue } from '../src/telegram/queue.js';
import { classify, isCustomEmojiRejection } from '../src/telegram/errors.js';
import { TelegramSender } from '../src/telegram/sender.js';
import type { Outbound, Sender } from '../src/telegram/sender.js';
import { createLogger } from '../src/ops/logger.js';
import type { ChatId, Signature } from '../src/core/types.js';

const log = createLogger('silent' as 'info', false);
const CHAT = -1001 as ChatId;
const CHAT_B = -1002 as ChatId;
const sig = (n: number): Signature => `sig${n}`.padEnd(88, 'x') as Signature;

const CARD = {
  text: 'card',
  entities: [],
  keyboard: [],
  ladderCount: 1,
  ladderTruncated: false,
};

/** A Telegram error, shaped as grammY surfaces it. */
function tgError(code: number, description: string, retryAfter?: number): Error {
  return Object.assign(new Error(description), {
    error_code: code,
    description,
    ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
  });
}

class FakeSender implements Sender {
  sent: ChatId[] = [];
  failures: Error[] = [];
  constructor(private script: (n: number) => Error | null = () => null) {}
  async send(msg: Outbound): Promise<number> {
    const err = this.script(this.sent.length + this.failures.length);
    if (err) {
      this.failures.push(err);
      throw err;
    }
    this.sent.push(msg.chatId);
    return this.sent.length;
  }
}

let dir: string;
let repo: SqliteRepo;
let slept: number[];

function makeQueue(sender: Sender, over: Partial<ConstructorParameters<typeof DeliveryQueue>[0]> = {}) {
  return new DeliveryQueue({
    repo,
    sender,
    log,
    sleep: async (ms) => {
      slept.push(ms); // virtual time: the tests never actually wait
    },
    perChatMs: 0,
    ...over,
  });
}

const job = (n: number, chatId: ChatId = CHAT, enqueuedAt = Date.now()) => ({
  signature: sig(n),
  chatId,
  enqueuedAt,
  build: async (): Promise<Outbound> => ({ chatId, card: CARD, fileId: null, kind: null }),
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-tg-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  await repo.upsertChat({ chatId: CHAT, title: 'g', addedBy: 1, paused: false });
  await repo.upsertChat({ chatId: CHAT_B, title: 'h', addedBy: 1, paused: false });
  slept = [];
});

afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// =============================================================================
// ERROR CLASSIFICATION
// =============================================================================

describe('error classification', () => {
  it('429 -> honour retry_after EXACTLY', () => {
    const v = classify(tgError(429, 'Too Many Requests: retry after 7', 7));
    expect(v).toEqual({ kind: 'rate_limit', retryAfterSec: 7 });
  });

  it('403 and friends -> permanent AND pause the chat', () => {
    for (const d of ['Forbidden: bot was kicked from the group chat', 'Forbidden: bot was blocked by the user']) {
      const v = classify(tgError(403, d));
      expect(v.kind).toBe('permanent');
      expect(v.kind === 'permanent' && v.pauseChat).toBe(true);
    }
    const notFound = classify(tgError(400, 'Bad Request: chat not found'));
    expect(notFound.kind === 'permanent' && notFound.pauseChat).toBe(true);
  });

  it('a plain 400 is permanent for THIS message but must NOT pause the chat', () => {
    // Our bug (a bad caption, a stale file_id), not the group's. Pausing here would take
    // a healthy chat offline because we sent one malformed card.
    const v = classify(tgError(400, 'Bad Request: message caption is too long'));
    expect(v.kind === 'permanent' && v.pauseChat).toBe(false);
  });

  it('5xx and network noise are retryable', () => {
    expect(classify(tgError(500, 'Internal Server Error')).kind).toBe('retryable');
    expect(classify(new Error('socket hang up')).kind).toBe('retryable');
  });

  it('spots a custom-emoji rejection', () => {
    expect(isCustomEmojiRejection(tgError(400, 'Bad Request: CUSTOM_EMOJI_INVALID'))).toBe(true);
    expect(isCustomEmojiRejection(tgError(400, 'Bad Request: message is too long'))).toBe(false);
  });
});

// =============================================================================
// THE QUEUE
// =============================================================================

describe('delivery queue', () => {
  it('sends, then records the message_id', async () => {
    const sender = new FakeSender();
    const q = makeQueue(sender);

    q.enqueue(job(1));
    await settle();

    expect(sender.sent).toEqual([CHAT]);
    const row = repo.raw.prepare('SELECT state, message_id FROM sends').get() as {
      state: string;
      message_id: number;
    };
    expect(row.state).toBe('sent');
    expect(row.message_id).toBe(1);
  });

  it('429 -> waits EXACTLY retry_after, keeps the claim, and succeeds on retry', async () => {
    let n = 0;
    const sender = new FakeSender(() => (n++ === 0 ? tgError(429, 'Too Many Requests', 7) : null));
    const q = makeQueue(sender);

    q.enqueue(job(1));
    await settle();

    expect(slept).toContain(7_000); // exactly what Telegram asked for — not a doubling ramp
    expect(sender.sent).toEqual([CHAT]);
    expect((repo.raw.prepare('SELECT state FROM sends').get() as { state: string }).state).toBe('sent');
  });

  it('gives up after 3 attempts and DEAD-LETTERS, releasing the claim', async () => {
    const sender = new FakeSender(() => tgError(500, 'Internal Server Error'));
    const q = makeQueue(sender);

    q.enqueue(job(1));
    await settle();

    expect(sender.failures).toHaveLength(3);
    // releaseSend DELETES the row: a retryable failure must stay re-claimable later,
    // unlike a permanent one, which tombstones.
    expect(repo.raw.prepare('SELECT COUNT(*) AS n FROM sends').get()).toEqual({ n: 0 });
  });

  it('403 -> tombstone, pause the chat, and stop trying. Self-healing.', async () => {
    const sender = new FakeSender(() => tgError(403, 'Forbidden: bot was kicked from the supergroup chat'));
    const q = makeQueue(sender);

    q.enqueue(job(1));
    await settle();

    expect(sender.failures).toHaveLength(1); // ONE attempt, not three
    expect((await repo.getChat(CHAT))?.paused).toBe(true);
    expect((repo.raw.prepare('SELECT state FROM sends').get() as { state: string }).state).toBe('failed');
  });

  it('drops a buy older than 120s — a stale post is worse than none', async () => {
    const sender = new FakeSender();
    const q = makeQueue(sender);

    q.enqueue(job(1, CHAT, Date.now() - 121_000));
    await settle();

    expect(sender.sent).toEqual([]);
    // And it never even bought a claim for a message it was going to throw away.
    expect(repo.raw.prepare('SELECT COUNT(*) AS n FROM sends').get()).toEqual({ n: 0 });
  });

  it('throttles per chat, and two chats do not block each other', async () => {
    const sender = new FakeSender();
    const q = makeQueue(sender, { perChatMs: 3_000 });

    q.enqueue(job(1, CHAT));
    q.enqueue(job(2, CHAT));
    q.enqueue(job(3, CHAT_B));
    await settle();

    expect(sender.sent).toHaveLength(3);
    expect(slept.some((ms) => ms > 0)).toBe(true); // the second post to CHAT waited
  });
});

// =============================================================================
// INVARIANT 2 — THE DOUBLE-POST GUARD
// =============================================================================

describe('INVARIANT 2: a restart never double-posts', () => {
  it('claimSend gates the send: a replayed buy is dropped SILENTLY', async () => {
    const sender = new FakeSender();
    const q = makeQueue(sender);

    q.enqueue(job(1));
    await settle();
    // The websocket reconnects and replays the same signature. This is the NORMAL case.
    q.enqueue(job(1));
    await settle();

    expect(sender.sent).toEqual([CHAT]); // exactly one post
  });

  /**
   * KILL THE PROCESS MID-QUEUE.
   *
   * The claim is taken, then the process dies before markSent. It is NOT KNOWABLE whether
   * Telegram received that message — the API call may have succeeded and we died before
   * recording it. INVARIANT 9: we DROP. The row is swept to 'failed' at boot and never
   * resent, because a duplicate post is strictly worse than a missed one, and by the time
   * we are back the buy is stale anyway.
   *
   * The test proves the thing that actually matters: after the crash and the sweep, a
   * fresh queue replaying the same buy sends NOTHING.
   */
  it('a send claimed but never recorded is swept to failed, and NEVER resent', async () => {
    // --- the "crash": claim it, then die before markSent -----------------------------
    await repo.claimSend(sig(1), CHAT);
    expect((repo.raw.prepare('SELECT state FROM sends').get() as { state: string }).state).toBe('claimed');

    // --- reboot ----------------------------------------------------------------------
    const swept = await repo.sweepOrphanedClaims('orphaned');
    expect(swept).toBe(1);
    expect((repo.raw.prepare('SELECT state FROM sends').get() as { state: string }).state).toBe('failed');

    // --- the ingestor replays the same buy after the restart --------------------------
    const sender = new FakeSender();
    const q = makeQueue(sender);
    q.enqueue(job(1));
    await settle();

    // The tombstone makes the claim un-takeable. Nothing goes out. No double post.
    expect(sender.sent).toEqual([]);
  });

  it('a chat that has NOT been posted to still gets its card after the crash', async () => {
    // The sweep must not be a blanket amnesty: only the orphaned (signature, chat) pair is
    // dropped. Every other fan-out target is untouched.
    await repo.claimSend(sig(1), CHAT);
    await repo.sweepOrphanedClaims('orphaned');

    const sender = new FakeSender();
    const q = makeQueue(sender);
    q.enqueue(job(1, CHAT)); // dropped — tombstoned
    q.enqueue(job(1, CHAT_B)); // fine — never claimed
    await settle();

    expect(sender.sent).toEqual([CHAT_B]);
  });
});

// =============================================================================
// THE CUSTOM-EMOJI FALLBACK
// =============================================================================

describe('a bad custom emoji never kills the post', () => {
  it('retries ONCE with the custom_emoji entities stripped', async () => {
    const attempts: number[] = [];

    // A TelegramSender with its wire call stubbed: we are testing the fallback, not grammY.
    const sender = new TelegramSender('123:fake', -100, log);
    (sender as unknown as { [k: string]: unknown })['dispatchForTest'] = null;

    // Re-implement #dispatch's observable contract via the public send() by monkeypatching
    // the bot api — the simplest honest seam.
    const api = { calls: 0 };
    (sender.bot as unknown as { api: unknown }).api = {
      sendMessage: async (_chat: number, _text: string, opts: { entities?: unknown[] }) => {
        api.calls++;
        attempts.push((opts.entities ?? []).length);
        if (api.calls === 1) throw tgError(400, 'Bad Request: CUSTOM_EMOJI_INVALID');
        return { message_id: 42 };
      },
    };

    const id = await sender.send({
      chatId: CHAT,
      card: {
        text: '🍚🍚',
        entities: [
          { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: 'X' },
          { type: 'custom_emoji', offset: 2, length: 2, custom_emoji_id: 'X' },
          { type: 'bold', offset: 0, length: 4 },
        ],
        keyboard: [],
        ladderCount: 2,
        ladderTruncated: false,
      },
      fileId: null,
      kind: null,
    });

    expect(id).toBe(42);
    expect(api.calls).toBe(2);
    // First attempt carried all three entities; the retry dropped ONLY the custom ones —
    // the unicode ladder is already the text, so the card still has its grains.
    expect(attempts).toEqual([3, 1]);
  });
});
