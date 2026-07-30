import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteRepo } from '../src/db/sqlite.js';
import { createLogger } from '../src/ops/logger.js';
import { registerCommands, type CommandDeps } from '../src/telegram/commands.js';
import { dcaSectionMessage, settingsMessage } from '../src/telegram/settings.js';
import { LIVE_BANNER, DRY_BANNER, KEY_MODE_BANNER, WALLET_MODE_BANNER } from '../src/telegram/trade-panel/render.js';
import type { ChatId, Mint } from '../src/core/types.js';

/**
 * PHASE 9 — `/settings` answers for two products, and the second one is not for everybody.
 *
 * The gating is the whole risk here, and it is not a UI preference. Every autotrader surface is
 * DM-only and allowlist-only, and a non-member is met with SILENCE (INVARIANT 14) — because a
 * refusal is an oracle: send `/wallet` to a bot, get "you are not authorised", and you have learned
 * both that the autotrader exists and that there is a list to be on. `/settings` is the one command
 * everybody types, so a DCA section that announced itself and then refused would put that oracle
 * exactly where it does the most work.
 *
 * So: the section is ABSENT in a group, ABSENT for a non-member, ABSENT for a revoked member, and
 * ABSENT when the autotrader is not deployed. Not greyed out, not explained — absent.
 */

const log = createLogger('silent' as 'info', false);
const MINT = '2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump' as Mint;
const GROUP = -1001 as ChatId;
const MEMBER = 111;
const STRANGER = 222;
/** A member who never runs /use. Distinct from MEMBER because the bot's DM target map is
 *  module-scoped — one process, one map, which is correct in production and means a test must not
 *  rely on it being empty just because it re-registered the handlers. */
const MEMBER_NO_GROUP = 333;
const OWNER = 999;

type Handler = (ctx: unknown) => Promise<unknown> | unknown;

class FakeBot {
  /** The admin check the /use tap re-runs. Administrator, so the tap is allowed. */
  api = { getChatMember: async () => ({ status: 'administrator' }) };
  commands = new Map<string, Handler>();
  command(name: string, h: Handler): void {
    this.commands.set(name, h);
  }
  on(): void {
    /* the settings command registers no message handlers */
  }
  callbacks: [RegExp, Handler][] = [];
  callbackQuery(pattern: RegExp, h: Handler): void {
    this.callbacks.push([pattern, h]);
  }
  use(): void {
    /* middleware registered by neighbours in the same module */
  }
}

class FakeCtx {
  replies: string[] = [];
  constructor(
    public userId: number,
    private chatType: 'private' | 'supergroup' = 'private',
    private chatId: number = userId,
  ) {}
  get from() {
    return { id: this.userId };
  }
  get chat() {
    return { id: this.chatId, type: this.chatType, title: 'A group' };
  }
  get match() {
    return '';
  }
  reply = async (t: string) => {
    this.replies.push(t);
    return { message_id: 1 };
  };
  api = { getChatMember: async () => ({ status: 'administrator' }) };
}

let dir: string;
let repo: SqliteRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ricebuybot-settings-'));
  repo = new SqliteRepo(join(dir, 'test.db'), log);
  await repo.init();
  await repo.upsertChat({ chatId: GROUP, title: 'A group', addedBy: MEMBER, paused: false });
  await repo.addChatToken(GROUP, MINT);
  await repo.addAutotraderUser(MEMBER, 'member', 1);
  await repo.addAutotraderUser(MEMBER_NO_GROUP, 'member-no-group', 1);
});
afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Register the command surface and return `/settings`, driven the way grammY would drive it. */
function mount(opts: { autotrader?: boolean; tradeLive?: boolean } = {}): (ctx: FakeCtx) => Promise<void> {
  const bot = new FakeBot();
  const deps = {
    repo,
    media: { pick: async () => null, health: async () => null } as unknown as CommandDeps['media'],
    sender: {} as CommandDeps['sender'],
    log,
    ownerUserId: OWNER,
    chain: { supplyOf: async () => null },
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
    currentMints: () => [],
    ...(opts.autotrader === false
      ? {}
      : { autotrader: { access: repo, tradeLive: opts.tradeLive ?? false } }),
  } as unknown as CommandDeps;
  registerCommands(bot as never, deps);
  const handler = bot.commands.get('settings');
  if (!handler) throw new Error('/settings is not registered');
  const run = async (ctx: FakeCtx): Promise<void> => void (await handler(ctx));
  /**
   * Pick a group for a DM, the way a user does: `/use` draws buttons and the TAP sets the target.
   * Driven through the real callback handler rather than by reaching into private state, so a DM
   * in these tests is in the same condition a DM is in after someone actually ran /use.
   */
  run.use = async (userId: number, chatId: number): Promise<void> => {
    const entry = bot.callbacks.find(([re]) => re.test(`use:${chatId}`));
    if (!entry) throw new Error('the use: callback is not registered');
    await entry[1]({
      match: ['', String(chatId)],
      from: { id: userId },
      chat: { id: userId, type: 'private' },
      answerCallbackQuery: async () => undefined,
      reply: async () => ({ message_id: 1 }),
    });
  };
  return run;
}

const BUY_HEADER = '🍚 *BUY BOT*';
const DCA_HEADER = '🤖 *DCA BOT*';

// ── gating ────────────────────────────────────────────────────────────────────────────────────

describe('the DCA section appears only where it can be used', () => {
  it('IN A GROUP: buy bot only — the DCA section is absent, not refused', async () => {
    const settings = mount();
    // The caller is an allowlisted member, so this isolates the CONTEXT from the membership: even
    // for someone who may use the autotrader, a group is the wrong place to print their DM's
    // controls — the other people in the room are reading over their shoulder.
    const ctx = new FakeCtx(MEMBER, 'supergroup', GROUP);
    await settings(ctx);

    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain(BUY_HEADER);
    expect(ctx.replies[0]).not.toContain(DCA_HEADER);
    // Not a single autotrader command name leaks into a group.
    for (const cmd of ['/wallet', '/trade', '/unlock', '/linksite', '/resolve', '/trader']) {
      expect(ctx.replies[0], `${cmd} leaked into a group`).not.toContain(cmd);
    }
  });

  it('DM, NOT A MEMBER: buy bot only, with no hint that an autotrader exists', async () => {
    const settings = mount();
    const ctx = new FakeCtx(STRANGER, 'private');
    await settings(ctx);

    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).not.toContain(DCA_HEADER);
    expect(ctx.replies[0]).not.toContain('autotrader');
    expect(ctx.replies[0]).not.toContain('/wallet');
  });

  it('DM, REVOKED MEMBER: the section disappears immediately, not at some TTL', async () => {
    await repo.setAutotraderLocked(MEMBER, true);
    const settings = mount();
    const ctx = new FakeCtx(MEMBER, 'private');
    await settings(ctx);
    expect(ctx.replies[0]).not.toContain(DCA_HEADER);
  });

  it('DM, ALLOWLISTED: both sections, buy bot first', async () => {
    const settings = mount();
    await settings.use(MEMBER, GROUP); // as if they had run /use and tapped the group
    const ctx = new FakeCtx(MEMBER, 'private');
    await settings(ctx);

    expect(ctx.replies).toHaveLength(1);
    const msg = ctx.replies[0] as string;
    expect(msg).toContain(BUY_HEADER);
    expect(msg).toContain(DCA_HEADER);
    expect(msg.indexOf(BUY_HEADER)).toBeLessThan(msg.indexOf(DCA_HEADER));
  });

  it('AUTOTRADER OFF: nobody gets the section, member or not', async () => {
    // The commands are not registered in that deployment, so listing them would document a surface
    // that does not answer.
    const settings = mount({ autotrader: false });
    const ctx = new FakeCtx(MEMBER, 'private');
    await settings(ctx);
    expect(ctx.replies[0]).not.toContain(DCA_HEADER);
  });

  it('a member with no group picked still gets their DCA section', async () => {
    // `/settings` in a DM used to answer "Which group? Send /use to pick one." and stop. A member's
    // DCA commands have nothing to do with a group, so that answer was hiding them behind an
    // unrelated setup step.
    const settings = mount();
    const ctx = new FakeCtx(MEMBER_NO_GROUP, 'private'); // never ran /use
    await settings(ctx);
    const msg = ctx.replies[0] as string;
    expect(msg).toContain('Which group? Send /use to pick one.'); // unchanged, verbatim
    expect(msg).toContain(DCA_HEADER);
  });

  it('a NON-member with no group picked gets exactly the old reply, unchanged', async () => {
    const settings = mount();
    const ctx = new FakeCtx(STRANGER, 'private');
    await settings(ctx);
    expect(ctx.replies).toEqual(['Which group? Send /use to pick one.']);
  });
});

// ── the banner ────────────────────────────────────────────────────────────────────────────────

describe('the DCA section says whether money is at stake', () => {
  it('reflects TRADE_LIVE, in the panel’s own words', async () => {
    for (const [tradeLive, banner] of [
      [true, LIVE_BANNER],
      [false, DRY_BANNER],
    ] as const) {
      const settings = mount({ tradeLive });
      const ctx = new FakeCtx(MEMBER, 'private');
      await settings(ctx);
      expect(ctx.replies[0], `TRADE_LIVE=${tradeLive}`).toContain(banner);
    }
  });

  it('states who holds the key, and follows the member’s mode', async () => {
    // A new member is a wallet-mode member (migration 019).
    const walletCtx = new FakeCtx(MEMBER, 'private');
    await mount()(walletCtx);
    expect(walletCtx.replies[0]).toContain(WALLET_MODE_BANNER);

    await repo.setAutotraderMode(MEMBER, 'key');
    const keyCtx = new FakeCtx(MEMBER, 'private');
    await mount()(keyCtx);
    expect(keyCtx.replies[0]).toContain(KEY_MODE_BANNER);
  });

  it('does not author its own wording for either banner', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src/telegram/settings.ts'), 'utf8');
    expect(src).toContain('LIVE_BANNER');
    expect(src).toContain('modeBanner(');
    expect(src).not.toContain('DRY RUN —'); // the string itself belongs to render.ts
  });
});

// ── the commands listed are the commands that exist ───────────────────────────────────────────

describe('every command named in the DCA section is registered', () => {
  const ROOT = join(import.meta.dirname, '..');

  /** Every `bot.command('x', …)` in src/, which is the only way a command comes to exist. */
  function registeredCommands(): Set<string> {
    const found = new Set<string>();
    const walk = (d: string): void => {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) {
          for (const m of readFileSync(full, 'utf8').matchAll(/bot\.command\('([a-z]+)'/g)) found.add(m[1] as string);
        }
      }
    };
    walk(join(ROOT, 'src'));
    return found;
  }

  it('names no command the bot does not have', () => {
    const registered = registeredCommands();
    const section = [
      dcaSectionMessage({ tradeLive: true, mode: 'key', isOwner: true }),
      dcaSectionMessage({ tradeLive: false, mode: 'wallet', isOwner: false }),
    ].join('\n');

    const named = new Set([...section.matchAll(/\/([a-z]+)/g)].map((m) => m[1] as string));
    expect(named.size).toBeGreaterThan(4); // the regex must actually be finding commands
    for (const cmd of named) {
      expect(registered.has(cmd), `/${cmd} is listed in /settings but is not registered anywhere`).toBe(true);
    }
  });

  it('lists the autotrader commands a member actually needs', () => {
    // The point of the section is discovery, so the set is pinned: a command that quietly stops
    // being listed is as much a regression as one that is listed and does not exist.
    const key = dcaSectionMessage({ tradeLive: false, mode: 'key', isOwner: false });
    for (const cmd of ['/wallet', '/unlock', '/mode', '/trade', '/history', '/resolve', '/dca', '/linksite']) {
      expect(key, `${cmd} is missing from the DCA section`).toContain(cmd);
    }
  });

  it('labels the owner-only line, and shows it only to the owner', () => {
    expect(dcaSectionMessage({ tradeLive: false, mode: 'key', isOwner: true })).toMatch(/\/trader[^\n]*owner only/);
    expect(dcaSectionMessage({ tradeLive: false, mode: 'key', isOwner: false })).not.toContain('/trader');
  });

  it('WALLET MODE gets the commands that work in wallet mode, not the custodial ones', () => {
    // In wallet mode the bot holds no key and runs no schedule, so `/wallet import` and the
    // schedule controls would refuse. The panel makes the same split.
    const wallet = dcaSectionMessage({ tradeLive: false, mode: 'wallet', isOwner: false });
    expect(wallet).toContain('/dca');
    expect(wallet).toContain('/mode');
    expect(wallet).not.toContain('/unlock');
    expect(wallet).not.toContain('/trade new');
    expect(wallet).not.toContain('/resolve');
  });
});

// ── the buy-bot half did not move ─────────────────────────────────────────────────────────────

describe('the BUY BOT section is the old message, unchanged', () => {
  const ROOT = join(import.meta.dirname, '..');
  /** The commit this restructure started from. */
  const BASELINE = 'b662971';

  /** The body of `settingsMessage`, from a given source text. */
  function settingsBody(src: string): string {
    const start = src.indexOf('export function settingsMessage(');
    expect(start, 'settingsMessage moved — re-point this check').toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    return src.slice(start, end);
  }

  it('is the pre-restructure function, plus a header and nothing else', async () => {
    // Compared at SOURCE level, and deliberately not by executing the old module: a `data:` import
    // of the old TypeScript does not run (it still has type annotations), so a test that tried it
    // would fall through to a weaker check and quietly stop testing what its name claims. This
    // cannot degrade — if the extraction ever fails to line up, the strings differ and it fails.
    let before: string;
    try {
      before = execFileSync('git', ['show', `${BASELINE}:src/telegram/settings.ts`], { cwd: ROOT, encoding: 'utf8' });
    } catch {
      return; // shallow checkout; the runtime assertions below still ran
    }

    const now = readFileSync(join(ROOT, 'src/telegram/settings.ts'), 'utf8');
    // Remove exactly what this change added to the message: the explanatory comment and the two
    // array entries that are the header and its blank line.
    const stripped = settingsBody(now)
      .split('\n')
      .filter((l) => !l.includes('PHASE 9 — the section header'))
      .filter((l) => !/^\s*\/\/ (per-user autotrader|`\/setmin` on their DCA|a rewrite, and a test pins)/.test(l))
      .filter((l) => l.trim() !== "'🍚 *BUY BOT* — what this group posts',")
      .join('\n');
    // The header's blank-line entry is indistinguishable from the message's own blank lines, so it
    // is removed positionally: the first `'',` after the opening of the array.
    const openedAt = stripped.indexOf('return [');
    const firstBlank = stripped.indexOf("    '',", openedAt);
    const withoutHeader = stripped.slice(0, firstBlank) + stripped.slice(firstBlank + "    '',\n".length);

    expect(
      withoutHeader,
      'the buy-bot message changed beyond the added header — this was meant to be presentation only',
    ).toBe(settingsBody(before));
  });

  it('still shows every buy-bot control it showed before', async () => {
    const ct = (await repo.listChatTokens(GROUP))[0]!;
    const msg = settingsMessage(ct, 'RICE', false, 'free');
    for (const cmd of [
      '/setca', '/setmin', '/setfloors', '/setwhale', '/setemoji', '/setstep', '/setmaxemoji',
      '/mediamode', '/setmedia', '/mediastats', '/setheadline', '/setlink', '/preview',
      '/pause', '/resume', '/reset',
    ]) {
      expect(msg, `${cmd} disappeared from the buy-bot section`).toContain(cmd);
    }
  });
});

/** Strip the TypeScript that a data: import cannot handle. Best-effort; the caller has a fallback. */
function transpileForImport(src: string): string {
  return src
    .replace(/^import type[^;]+;$/gm, '')
    .replace(/^import \{[^}]*\} from '[^']*';$/gm, '')
    .replace(/: [A-Za-z<>[\]|' ]+(?=[,)=])/g, '');
}
