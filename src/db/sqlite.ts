import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as Db, type Statement } from 'better-sqlite3';

import type {
  BuyRecord,
  Chat,
  ChatId,
  ChatToken,
  MediaItem,
  MediaKind,
  MediaMode,
  Mint,
  Position,
  SellRecord,
  Signature,
  SwapKind,
  SwapRecord,
  SwapSource,
  TokenMeta,
  Wallet,
} from '../core/types.js';
import { DEFAULT_HEADLINES, type TierFolder } from '../core/tiers.js';
import { defaultLinksFor } from '../core/links.js';
import { isPlan, type Plan } from '../core/plans.js';
import {
  EMPTY_BASIS,
  applyBuy,
  applySell,
  applyTransferIn,
  applyTransferOut,
  type BasisState,
} from '../positions/basis.js';
import { reconcile } from '../positions/reconcile.js';
import type { Logger } from '../ops/logger.js';
import type { AutotraderMember } from '../trade/access.js';
import type {
  AmountKind,
  Caps,
  ExecutionOutcome,
  Schedule,
  ScheduleState,
  SchedulerRepo,
  Side,
} from '../trade/scheduler.js';
import { migrate } from './migrate.js';
import type { ChatTokenPatch, MediaItemInput, Repo } from './index.js';

/**
 * THE claim statement (INVARIANT 2).
 *
 * A read-then-write ("have I sent this?") double-posts under reconnect replay:
 * two callers both read "no", both send. This is a SINGLE atomic INSERT — SQLite
 * resolves the race in the storage engine, and `changes` tells us who won.
 *
 * `DO NOTHING` (not `DO UPDATE`) is what makes a 'failed' tombstone permanent:
 * the conflicting row is left exactly as it is, so a swept orphan can never be
 * re-claimed (INVARIANT 9).
 *
 * Exported so the concurrency test exercises this exact statement rather than a
 * lookalike that might not share its behaviour.
 */
export const CLAIM_SQL = `
  INSERT INTO sends (signature, chat_id, state, attempts, claimed_at)
  VALUES (?, ?, 'claimed', 1, ?)
  ON CONFLICT (signature, chat_id) DO NOTHING
`;

/**
 * WAL: readers never block the writer, which matters because the ingestor writes
 * while Telegram handlers read.
 * synchronous=NORMAL: safe under WAL (a crash cannot corrupt the DB, it can only
 * lose the last commit) and vastly faster than FULL.
 * busy_timeout: a second connection must WAIT for the writer, not fail. Without
 * this the concurrent-claim race resolves as an error instead of a loser.
 */
export const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
] as const;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  for (const p of PRAGMAS) db.pragma(p.replace(/^PRAGMA\s+/, ''));
  return db;
}

// --- row shapes ---------------------------------------------------------------

interface ChatRow {
  chat_id: number;
  title: string | null;
  added_by: number | null;
  paused: number;
  created_at: number;
  plan: string;
  plan_granted_at: number | null;
  plan_granted_by: number | null;
}

interface ChatTokenRow {
  id: number;
  chat_id: number;
  mint: string;
  min_buy_usd: number;
  emoji: string;
  emoji_custom_id: string | null;
  emoji_step_usd: number;
  max_emojis: number;
  media_mode: string;
  static_file_id: string | null;
  static_kind: string | null;
  buy_floor_big: number;
  buy_floor_massive: number;
  whale_holdings_usd: number;
  whale_basis: string;
  tier_headlines: string;
  links_json: string | null;
  enabled: number;
}

interface TokenRow {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  supply_raw: string;
  meta_updated_at: number;
}

interface MediaRow {
  sha256: string;
  mint: string;
  tier: string;
  rel_path: string;
  kind: string;
  bytes: number;
  first_seen: number;
  missing: number;
  removed_at: number | null;
}

interface PositionRow {
  mint: string;
  buyer: string;
  tokens_raw: string;
  cost_usd: number;
  realized_pnl_usd: number | null;
  backfilled: number;
  onchain_raw: string;
  drift_raw: string;
  reconciled: number;
  backfilled_at: number | null;
  history_truncated: number;
  basis_unpriced: number;
  first_seen: number | null;
  updated_at: number | null;
}

interface AutotraderRow {
  user_id: number;
  label: string | null;
  added_by: number | null;
  added_at: number;
  locked: number;
  locked_at: number | null;
}

function hydrateAutotrader(r: AutotraderRow): AutotraderMember {
  return {
    userId: r.user_id,
    label: r.label,
    addedBy: r.added_by,
    addedAt: r.added_at,
    locked: r.locked === 1,
    lockedAt: r.locked_at,
  };
}

// --- Phase 13: DCA scheduler rows (INVARIANT 14, 17: everything scoped by user_id) ---

interface ScheduleRow {
  id: number;
  user_id: number;
  mint: string;
  side: string;
  amount_raw: string;
  amount_kind: string;
  interval_minutes: number;
  slippage_bps: number;
  state: string;
  halt_reason: string | null;
  next_run_at: number;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

function hydrateSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    userId: r.user_id,
    mint: r.mint as Mint,
    side: r.side as Side,
    amountRaw: BigInt(r.amount_raw),
    amountKind: r.amount_kind as AmountKind,
    intervalMinutes: r.interval_minutes,
    slippageBps: r.slippage_bps,
    state: r.state as ScheduleState,
    haltReason: r.halt_reason,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
  };
}

interface CapsRow {
  user_id: number;
  mint: string;
  max_per_exec_usd: number;
  max_per_day_usd: number;
  min_sol_reserve_lamports: string;
}

function hydrateCaps(r: CapsRow): Caps {
  return {
    userId: r.user_id,
    mint: r.mint as Mint,
    maxPerExecUsd: r.max_per_exec_usd,
    maxPerDayUsd: r.max_per_day_usd,
    minSolReserveLamports: BigInt(r.min_sol_reserve_lamports),
  };
}

interface SwapRow {
  signature: string;
  mint: string;
  wallet: string;
  kind: SwapKind;
  tokens_raw: string;
  quote_mint: string | null;
  quote_raw: string | null;
  quote_symbol: string | null;
  usd_value: number;
  unpriced: number;
  balance_after_raw: string | null;
  slot: number;
  block_time: number | null;
  source: SwapSource;
}

const toBool = (n: number): boolean => n !== 0;
const fromBool = (b: boolean): number => (b ? 1 : 0);

/**
 * One-time position refolds, each keyed by its own marker.
 *
 * `positions` is a materialized view, so any migration that changes what the FOLD
 * computes must refold it once. Adding a marker here is how you do that — the fold
 * itself never needs touching.
 */
const REBUILD_MARKERS = [
  /** Phase 4.5: fold the swap log seeded from `buys` into `positions` for the first time. */
  'positions_rebuilt_from_swap_log',
  /** Phase 4.7: legacy transfer rows became `unpriced`, which vetoes `reconciled`. */
  'positions_rebuilt_unpriced_basis',
  /** Phase 4.8: realized_pnl_usd became nullable; re-derive which ones are unknowable. */
  'positions_rebuilt_nullable_pnl',
] as const;

/**
 * Knobs for a recompute. Everything here is either an input the fold cannot know
 * (decimals) or observational metadata that is not a property of the swaps.
 * NOTHING here can override a folded value — that is the point.
 */
export interface RecomputeOpts {
  /** Needed to value sells and transfer-outs. Buys do not use it. */
  readonly decimals?: number | undefined;
  readonly backfilled?: boolean | undefined;
  readonly backfilledAt?: number | null | undefined;
  /** The log for this wallet is known incomplete. Vetoes `reconciled`. */
  readonly historyTruncated?: boolean | undefined;
}

/** A position whose stored row did not match a fresh fold of the log. */
export interface PositionDisagreement {
  readonly mint: Mint;
  readonly wallet: Wallet;
  readonly before: Position | null;
  readonly after: Position;
}

/**
 * JSON parse that degrades to a fallback instead of throwing.
 * A malformed `tier_thresholds` must not take the whole bot down — a group with
 * a corrupt row should fall back to defaults and keep posting.
 */
function parseJsonOr<T>(raw: string | null, fallback: T, log: Logger, field: string): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.warn({ field }, 'malformed JSON column; falling back to default');
    return fallback;
  }
}

export class SqliteRepo implements Repo {
  readonly #db: Db;
  readonly #log: Logger;
  #claim!: Statement<[string, number, number]>;

  constructor(path: string, log: Logger) {
    this.#log = log;
    this.#db = openDb(path);
  }

  /** Escape hatch for tests and ops. Do not reach for this in application code. */
  get raw(): Db {
    return this.#db;
  }

  async init(): Promise<void> {
    // Phase 4.6: find the double-counts BEFORE the migration collapses them — once
    // the rows are merged the evidence is gone. These are not hypothetical: they are
    // wallets whose ledger already counted one transaction twice.
    const dupes = this.#findDoubleCounted();

    const applied = migrate(this.#db, this.#log);
    if (applied === 0) this.#log.debug('schema up to date');
    this.#claim = this.#db.prepare(CLAIM_SQL);

    // Phase 4.5: fold the seeded swap log into `positions`. Runs exactly once,
    // guarded by a marker — see #rebuildOnce.
    this.#rebuildOnce();

    // …and rebuild whatever the collapse changed, from the collapsed log.
    this.#reportAndRecompute(dupes);
  }

  /**
   * Groups of (signature, mint, wallet) holding more than one row — i.e. one
   * transaction counted more than once, because the old PK included `kind` and the
   * live path and the backfill classified it differently.
   *
   * Returns [] when `swaps` does not exist yet (a fresh DB) or already has the narrow
   * key (nothing to find).
   */
  #findDoubleCounted(): Array<{ signature: string; mint: string; wallet: string; kinds: string; sources: string }> {
    const exists = this.#db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='swaps'")
      .get();
    if (!exists) return [];

    return this.#db
      .prepare<[], { signature: string; mint: string; wallet: string; kinds: string; sources: string }>(
        `SELECT signature, mint, wallet,
                GROUP_CONCAT(kind)   AS kinds,
                GROUP_CONCAT(source) AS sources
           FROM swaps
          GROUP BY signature, mint, wallet
         HAVING COUNT(*) > 1`,
      )
      .all();
  }

  /**
   * Say it out loud, then fix it. A double-count is corrupt data, not a curiosity: it
   * inflated a wallet's tokens and cost, and the ledger it poisoned is the one that
   * decides whether we publish a Position %.
   */
  #reportAndRecompute(
    dupes: ReadonlyArray<{ signature: string; mint: string; wallet: string; kinds: string; sources: string }>,
  ): void {
    if (dupes.length === 0) return;

    for (const d of dupes) {
      this.#log.error(
        {
          signature: d.signature,
          mint: d.mint,
          wallet: d.wallet,
          kinds: d.kinds,
          sources: d.sources,
        },
        'DOUBLE-COUNTED SWAP: one transaction was logged twice under different `kind`s, ' +
          'so this wallet\'s tokens and cost were counted twice. Collapsing to one row and ' +
          'recomputing the position. The narrowed PK makes this unreachable from now on.',
      );
    }

    // ':' as the separator, NOT a literal NUL.
    //
    // Mints and wallets are base58, whose alphabet is alphanumeric minus 0/O/I/l — it
    // cannot contain ':', so the key is still unambiguous.
    //
    // A 0x00 byte in a source file makes grep and ripgrep classify the whole FILE as
    // binary, at which point they return NOTHING and say so quietly. Every future search
    // of the DB layer comes back empty and the reader concludes the code is not there.
    // (It already cost one session exactly that.) Same class of hazard as a verification
    // script whose output nobody reads: the failure is silence, not an error.
    const affected = new Set(dupes.map((d) => `${d.mint}:${d.wallet}`));
    for (const key of affected) {
      const [mint, wallet] = key.split(':') as [string, string];
      this.#db.transaction(() => this.#recompute(mint, wallet))();
    }

    this.#log.warn(
      { transactions: dupes.length, positions: affected.size },
      'collapsed double-counted swaps and recomputed the affected positions',
    );
  }

  async close(): Promise<void> {
    // Fold the WAL back into the main DB so a fresh open has nothing to replay.
    try {
      this.#db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best effort — never block shutdown on a checkpoint */
    }
    this.#db.close();
  }

  /** Seed DEFAULT_MINT so market cap and decimals are known before the first buy. */
  seedToken(meta: TokenMeta): void {
    this.#db
      .prepare(
        `INSERT INTO tokens (mint, symbol, name, decimals, supply_raw, meta_updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (mint) DO NOTHING`,
      )
      .run(meta.mint, meta.symbol, meta.name, meta.decimals, meta.supplyRaw.toString(), meta.fetchedAtMs);
  }

  // --- Chats ---

  async upsertChat(
    chat: Omit<Chat, 'createdAt' | 'plan' | 'planGrantedAt' | 'planGrantedBy'> & { createdAt?: number },
  ): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO chats (chat_id, title, added_by, paused, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET
           title    = excluded.title,
           added_by = excluded.added_by,
           paused   = excluded.paused`,
      )
      .run(chat.chatId, chat.title, chat.addedBy, fromBool(chat.paused), chat.createdAt ?? Date.now());
  }

  async getChat(chatId: ChatId): Promise<Chat | null> {
    const row = this.#db.prepare<[number], ChatRow>('SELECT * FROM chats WHERE chat_id = ?').get(chatId);
    if (!row) return null;
    return {
      chatId: row.chat_id,
      title: row.title,
      addedBy: row.added_by,
      paused: toBool(row.paused),
      createdAt: row.created_at,
      // An unrecognised value degrades to `free`. A corrupt row must never accidentally
      // hand out the paid feature set — fail towards the safe side of the money.
      plan: isPlan(row.plan) ? row.plan : 'free',
      planGrantedAt: row.plan_granted_at,
      planGrantedBy: row.plan_granted_by,
    };
  }

  async listChats(): Promise<readonly Chat[]> {
    return this.#db
      .prepare<[], ChatRow>('SELECT * FROM chats ORDER BY created_at DESC')
      .all()
      .map((row) => ({
        chatId: row.chat_id as ChatId,
        title: row.title,
        addedBy: row.added_by,
        paused: toBool(row.paused),
        createdAt: row.created_at,
        plan: isPlan(row.plan) ? row.plan : 'free',
        planGrantedAt: row.plan_granted_at,
        planGrantedBy: row.plan_granted_by,
      }));
  }

  async setPlan(chatId: ChatId, plan: Plan, grantedBy: number | null): Promise<void> {
    this.#db
      .prepare('UPDATE chats SET plan = ?, plan_granted_at = ?, plan_granted_by = ? WHERE chat_id = ?')
      .run(plan, Date.now(), grantedBy, chatId);
  }

  async setPaused(chatId: ChatId, paused: boolean): Promise<void> {
    this.#db.prepare('UPDATE chats SET paused = ? WHERE chat_id = ?').run(fromBool(paused), chatId);
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    // chat_tokens cascade (foreign_keys=ON).
    this.#db.prepare('DELETE FROM chats WHERE chat_id = ?').run(chatId);
  }

  // --- Chat tokens ---

  #hydrateChatToken(row: ChatTokenRow): ChatToken {
    return {
      id: row.id,
      chatId: row.chat_id,
      mint: row.mint,
      minBuyUsd: row.min_buy_usd,
      emoji: row.emoji,
      emojiCustomId: row.emoji_custom_id,
      emojiStepUsd: row.emoji_step_usd,
      maxEmojis: row.max_emojis,
      mediaMode: row.media_mode as MediaMode,
      staticFileId: row.static_file_id,
      staticKind: row.static_kind as MediaKind | null,
      buyFloorBig: row.buy_floor_big,
      buyFloorMassive: row.buy_floor_massive,
      whaleHoldingsUsd: row.whale_holdings_usd,
      whaleBasis: row.whale_basis === 'pre' ? 'pre' : 'post',
      tierHeadlines: parseJsonOr(row.tier_headlines, [...DEFAULT_HEADLINES], this.#log, 'tier_headlines'),
      links: parseJsonOr<Record<string, string> | null>(row.links_json, null, this.#log, 'links_json'),
      enabled: toBool(row.enabled),
    };
  }

  async addChatToken(chatId: ChatId, mint: Mint, patch: ChatTokenPatch = {}): Promise<ChatToken> {
    this.#db
      .prepare(
        `INSERT INTO chat_tokens (chat_id, mint) VALUES (?, ?)
         ON CONFLICT (chat_id, mint) DO NOTHING`,
      )
      .run(chatId, mint);

    // A new watch starts with its links already wired: the three templated defaults
    // (DexT / Screener / Buy) for everyone, plus the two rice sites for $RICE. Seeded on
    // INSERT and never re-applied, so a group that deletes a button keeps it deleted.
    const seeded = patch.links === undefined ? { ...patch, links: defaultLinksFor(mint) } : patch;

    if (Object.keys(seeded).length > 0) {
      const updated = await this.updateChatToken(chatId, mint, seeded);
      if (updated) return updated;
    }
    const row = await this.getChatToken(chatId, mint);
    if (!row) throw new Error('addChatToken: row vanished immediately after insert');
    return row;
  }

  async getChatToken(chatId: ChatId, mint: Mint): Promise<ChatToken | null> {
    const row = this.#db
      .prepare<[number, string], ChatTokenRow>('SELECT * FROM chat_tokens WHERE chat_id = ? AND mint = ?')
      .get(chatId, mint);
    return row ? this.#hydrateChatToken(row) : null;
  }

  async listChatTokens(chatId: ChatId): Promise<readonly ChatToken[]> {
    return this.#db
      .prepare<[number], ChatTokenRow>('SELECT * FROM chat_tokens WHERE chat_id = ? ORDER BY id')
      .all(chatId)
      .map((r) => this.#hydrateChatToken(r));
  }

  async updateChatToken(chatId: ChatId, mint: Mint, patch: ChatTokenPatch): Promise<ChatToken | null> {
    const COLUMNS: Record<keyof ChatTokenPatch, string> = {
      minBuyUsd: 'min_buy_usd',
      emoji: 'emoji',
      emojiCustomId: 'emoji_custom_id',
      emojiStepUsd: 'emoji_step_usd',
      maxEmojis: 'max_emojis',
      mediaMode: 'media_mode',
      staticFileId: 'static_file_id',
      staticKind: 'static_kind',
      buyFloorBig: 'buy_floor_big',
      buyFloorMassive: 'buy_floor_massive',
      whaleHoldingsUsd: 'whale_holdings_usd',
      whaleBasis: 'whale_basis',
      tierHeadlines: 'tier_headlines',
      links: 'links_json',
      enabled: 'enabled',
    };

    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    for (const [key, column] of Object.entries(COLUMNS) as Array<[keyof ChatTokenPatch, string]>) {
      if (!(key in patch)) continue;
      const v = patch[key];
      if (v === undefined) continue;
      sets.push(`${column} = ?`);
      if (key === 'tierHeadlines' || key === 'links') {
        values.push(v === null ? null : JSON.stringify(v));
      } else if (typeof v === 'boolean') {
        values.push(fromBool(v));
      } else {
        values.push(v as string | number | null);
      }
    }

    if (sets.length > 0) {
      values.push(chatId, mint);
      this.#db
        .prepare(`UPDATE chat_tokens SET ${sets.join(', ')} WHERE chat_id = ? AND mint = ?`)
        .run(...values);
    }
    return this.getChatToken(chatId, mint);
  }

  async removeChatToken(chatId: ChatId, mint: Mint): Promise<void> {
    this.#db.prepare('DELETE FROM chat_tokens WHERE chat_id = ? AND mint = ?').run(chatId, mint);
  }

  /**
   * The subscription source of truth: DISTINCT mints across ENABLED chat_tokens
   * on NON-PAUSED chats. A paused chat or a disabled watch must not hold a
   * subscription open — that is wasted Helius credits on data nobody will post.
   */
  async activeMints(): Promise<readonly Mint[]> {
    return this.#db
      .prepare<[], { mint: string }>(
        `SELECT DISTINCT ct.mint
           FROM chat_tokens ct
           JOIN chats c ON c.chat_id = ct.chat_id
          WHERE ct.enabled = 1 AND c.paused = 0
          ORDER BY ct.mint`,
      )
      .all()
      .map((r) => r.mint);
  }

  async chatTokensForMint(mint: Mint): Promise<readonly ChatToken[]> {
    return this.#db
      .prepare<[string], ChatTokenRow>(
        `SELECT ct.* FROM chat_tokens ct
           JOIN chats c ON c.chat_id = ct.chat_id
          WHERE ct.mint = ? AND ct.enabled = 1 AND c.paused = 0
          ORDER BY ct.id`,
      )
      .all(mint)
      .map((r) => this.#hydrateChatToken(r));
  }

  // --- Tokens ---

  async getToken(mint: Mint): Promise<TokenMeta | null> {
    const row = this.#db.prepare<[string], TokenRow>('SELECT * FROM tokens WHERE mint = ?').get(mint);
    if (!row) return null;
    return {
      mint: row.mint,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      supplyRaw: BigInt(row.supply_raw), // TEXT -> bigint, no float in the path
      fetchedAtMs: row.meta_updated_at,
    };
  }

  async putToken(meta: TokenMeta): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO tokens (mint, symbol, name, decimals, supply_raw, meta_updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (mint) DO UPDATE SET
           symbol          = excluded.symbol,
           name            = excluded.name,
           decimals        = excluded.decimals,
           supply_raw      = excluded.supply_raw,
           meta_updated_at = excluded.meta_updated_at`,
      )
      .run(meta.mint, meta.symbol, meta.name, meta.decimals, meta.supplyRaw.toString(), meta.fetchedAtMs);
  }

  // --- Media ---

  #hydrateMedia(row: MediaRow): MediaItem {
    return {
      sha256: row.sha256,
      mint: row.mint,
      tier: row.tier as TierFolder,
      relPath: row.rel_path,
      kind: row.kind as MediaKind,
      bytes: row.bytes,
      firstSeen: row.first_seen,
      missing: toBool(row.missing),
      removedAt: row.removed_at,
    };
  }

  /**
   * Re-seeing a known item must NOT reset first_seen or clear a file_id — the
   * sync job rewrites the pool regularly, and the content hash is the identity.
   * A moved or renamed file is the same item at a new path.
   */
  async upsertMediaItem(item: MediaItemInput): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO media_items (sha256, mint, tier, rel_path, kind, bytes, first_seen, missing)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (sha256) DO UPDATE SET
           mint     = excluded.mint,
           tier     = excluded.tier,
           rel_path = excluded.rel_path,
           kind     = excluded.kind,
           bytes    = excluded.bytes,
           missing  = 0`,
        // NOTE: removed_at is deliberately NOT cleared here.
        //
        // An admin's 🗑 is an instruction, and a manifest refresh must never undo it.
        // Phase 8.5 removes in two steps — set removed_at, then move the bytes to
        // _archive — and a refresh landing between them would see the file still in
        // its tier folder. Clearing removed_at on upsert would let that race quietly
        // RESURRECT a meme an admin had just deleted. Un-removing is an explicit act:
        // markMediaRemoved(shas, null).
      )
      .run(item.sha256, item.mint, item.tier, item.relPath, item.kind, item.bytes, item.firstSeen ?? Date.now());
  }

  /**
   * LIVE media for a tier — everything an admin has not removed.
   *
   * Note what is NOT filtered here: `missing`. A missing file is an ACCIDENT (a tidied
   * folder, a bad rsync), and its cached file_id still sends perfectly, so it stays in
   * rotation. Filtering on `missing = 0` — as this used to — throws away working art
   * because somebody moved a directory.
   *
   * `removed_at IS NOT NULL` is the opposite: an admin pressed 🗑 and meant it.
   */
  async listMedia(mint: Mint, tier: TierFolder): Promise<readonly MediaItem[]> {
    return this.#db
      .prepare<[string, string], MediaRow>(
        'SELECT * FROM media_items WHERE mint = ? AND tier = ? AND removed_at IS NULL ORDER BY sha256',
      )
      .all(mint, tier)
      .map((r) => this.#hydrateMedia(r));
  }

  /** Everything ever seen for this mint, removed items included. The refresh diff base. */
  async listAllMedia(mint: Mint): Promise<readonly MediaItem[]> {
    return this.#db
      .prepare<[string], MediaRow>('SELECT * FROM media_items WHERE mint = ? ORDER BY sha256')
      .all(mint)
      .map((r) => this.#hydrateMedia(r));
  }

  async markMediaMissing(shas: readonly string[], missing: boolean): Promise<void> {
    if (shas.length === 0) return;
    const stmt = this.#db.prepare('UPDATE media_items SET missing = ? WHERE sha256 = ?');
    this.#db.transaction(() => {
      for (const sha of shas) stmt.run(fromBool(missing), sha);
    })();
  }

  async markMediaRemoved(shas: readonly string[], removedAt: number | null): Promise<void> {
    if (shas.length === 0) return;
    const stmt = this.#db.prepare('UPDATE media_items SET removed_at = ? WHERE sha256 = ?');
    this.#db.transaction(() => {
      for (const sha of shas) stmt.run(removedAt, sha);
    })();
  }

  async deleteFileId(sha256: string): Promise<void> {
    this.#db.prepare('DELETE FROM media_file_ids WHERE sha256 = ?').run(sha256);
  }

  /** The boot warm-up queue: known art with no file_id yet. Removed items are not warmed. */
  async listMediaWithoutFileId(mint: Mint): Promise<readonly MediaItem[]> {
    return this.#db
      .prepare<[string], MediaRow>(
        `SELECT m.* FROM media_items m
          LEFT JOIN media_file_ids f ON f.sha256 = m.sha256
          WHERE m.mint = ? AND m.removed_at IS NULL AND f.sha256 IS NULL
          ORDER BY m.sha256`,
      )
      .all(mint)
      .map((r) => this.#hydrateMedia(r));
  }

  async getFileId(sha256: string): Promise<string | null> {
    const row = this.#db
      .prepare<[string], { file_id: string }>('SELECT file_id FROM media_file_ids WHERE sha256 = ?')
      .get(sha256);
    return row?.file_id ?? null;
  }

  async putFileId(sha256: string, fileId: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO media_file_ids (sha256, file_id, uploaded_at) VALUES (?, ?, ?)
         ON CONFLICT (sha256) DO UPDATE SET file_id = excluded.file_id, uploaded_at = excluded.uploaded_at`,
      )
      .run(sha256, fileId, Date.now());
  }

  // --- Rotation ---

  async getBag(mint: Mint, chatId: ChatId, tier: TierFolder): Promise<readonly string[] | null> {
    const row = this.#db
      .prepare<[string, number, string], { bag: string }>(
        'SELECT bag FROM media_rotation WHERE mint = ? AND chat_id = ? AND tier = ?',
      )
      .get(mint, chatId, tier);
    if (!row) return null;
    return parseJsonOr<string[]>(row.bag, [], this.#log, 'media_rotation.bag');
  }

  async putBag(mint: Mint, chatId: ChatId, tier: TierFolder, bag: readonly string[]): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO media_rotation (mint, chat_id, tier, bag, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (mint, chat_id, tier) DO UPDATE SET bag = excluded.bag, updated_at = excluded.updated_at`,
      )
      .run(mint, chatId, tier, JSON.stringify(bag), Date.now());
  }

  // --- Curators ---

  async addCurator(userId: number, mint: Mint, grantedBy: number | null): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO curators (user_id, mint, granted_at, granted_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, mint) DO NOTHING`,
      )
      .run(userId, mint, Date.now(), grantedBy);
  }

  async removeCurator(userId: number, mint: Mint): Promise<void> {
    this.#db.prepare('DELETE FROM curators WHERE user_id = ? AND mint = ?').run(userId, mint);
  }

  async grantedMints(userId: number): Promise<readonly Mint[]> {
    return this.#db
      .prepare<[number], { mint: string }>('SELECT mint FROM curators WHERE user_id = ?')
      .all(userId)
      .map((r) => r.mint as Mint);
  }

  async chatsForMint(mint: Mint): Promise<readonly ChatId[]> {
    return this.#db
      .prepare<[string], { chat_id: number }>('SELECT DISTINCT chat_id FROM chat_tokens WHERE mint = ?')
      .all(mint)
      .map((r) => r.chat_id as ChatId);
  }

  // --- Buys & positions ---

  async recordBuy(buy: BuyRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO buys (signature, mint, buyer, quote_mint, quote_symbol, quote_raw,
                           tokens_raw, usd_in, price_usd, slot, block_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (signature, mint, buyer) DO NOTHING`,
      )
      .run(
        buy.signature,
        buy.mint,
        buy.buyer,
        buy.quoteMint,
        buy.quoteSymbol,
        buy.quoteRaw.toString(), // TEXT: a u64 would lose precision as REAL
        buy.tokensRaw.toString(),
        buy.usdIn,
        buy.priceUsd,
        buy.slot,
        buy.blockTime,
      );
  }

  async hasBuy(signature: Signature, mint: Mint, buyer: Wallet): Promise<boolean> {
    return (
      this.#db
        .prepare<[string, string, string], { 1: number }>(
          'SELECT 1 FROM buys WHERE signature = ? AND mint = ? AND buyer = ?',
        )
        .get(signature, mint, buyer) !== undefined
    );
  }

  #hydratePosition(row: PositionRow): Position {
    return {
      mint: row.mint,
      buyer: row.buyer,
      tokensRaw: BigInt(row.tokens_raw),
      costUsd: row.cost_usd,
      realizedPnlUsd: row.realized_pnl_usd,
      backfilled: toBool(row.backfilled),
      onchainRaw: BigInt(row.onchain_raw),
      driftRaw: BigInt(row.drift_raw),
      reconciled: toBool(row.reconciled),
      backfilledAt: row.backfilled_at,
      historyTruncated: toBool(row.history_truncated),
      basisUnpriced: toBool(row.basis_unpriced),
      firstSeen: row.first_seen,
      updatedAt: row.updated_at,
    };
  }

  async getPosition(mint: Mint, buyer: Wallet): Promise<Position | null> {
    const row = this.#db
      .prepare<[string, string], PositionRow>('SELECT * FROM positions WHERE mint = ? AND buyer = ?')
      .get(mint, buyer);
    return row ? this.#hydratePosition(row) : null;
  }

  #readState(mint: Mint, buyer: Wallet): PositionRow | undefined {
    return this.#db
      .prepare<[string, string], PositionRow>('SELECT * FROM positions WHERE mint = ? AND buyer = ?')
      .get(mint, buyer);
  }

  /** Persist a full basis + reconciliation snapshot. Caller is inside a transaction. */
  #writeState(args: {
    mint: Mint;
    buyer: Wallet;
    state: BasisState;
    /** NULL when an unpriced sell makes it unknowable (Phase 4.8). */
    realizedPnlUsd: number | null;
    onchainRaw: bigint;
    driftRaw: bigint;
    reconciled: boolean;
    historyTruncated: boolean;
    basisUnpriced: boolean;
    backfilled: boolean;
    backfilledAt: number | null;
    firstSeen: number;
    now: number;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO positions (mint, buyer, tokens_raw, cost_usd, realized_pnl_usd, backfilled,
                                onchain_raw, drift_raw, reconciled, backfilled_at,
                                history_truncated, basis_unpriced, first_seen, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (mint, buyer) DO UPDATE SET
           tokens_raw        = excluded.tokens_raw,
           cost_usd          = excluded.cost_usd,
           realized_pnl_usd  = excluded.realized_pnl_usd,
           backfilled        = excluded.backfilled,
           onchain_raw       = excluded.onchain_raw,
           drift_raw         = excluded.drift_raw,
           reconciled        = excluded.reconciled,
           backfilled_at     = excluded.backfilled_at,
           history_truncated = excluded.history_truncated,
           basis_unpriced    = excluded.basis_unpriced,
           updated_at        = excluded.updated_at`,
      )
      .run(
        args.mint,
        args.buyer,
        args.state.tokensRaw.toString(), // TEXT: bigint-safe
        args.state.costUsd,
        args.realizedPnlUsd,
        fromBool(args.backfilled),
        args.onchainRaw.toString(),
        args.driftRaw.toString(),
        fromBool(args.reconciled),
        args.backfilledAt,
        fromBool(args.historyTruncated),
        fromBool(args.basisUnpriced),
        args.firstSeen,
        args.now,
      );
  }

  // --- THE SWAP LOG: positions are a fold over it, never a mutated row ---------

  /**
   * Append one fact. `INSERT OR IGNORE`, always — the PK (signature, mint, wallet) is
   * what makes a history replay idempotent, and `kind` is deliberately NOT in it
   * (INVARIANT 12).
   *
   * Returns 1 if this row was new, 0 if we already knew about it.
   */
  #insertSwap(s: SwapRecord): number {
    const r = this.#db
      .prepare(
        `INSERT OR IGNORE INTO swaps (signature, mint, wallet, kind, tokens_raw,
                                      quote_mint, quote_raw, quote_symbol, usd_value,
                                      unpriced, balance_after_raw, slot, block_time, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.signature,
        s.mint,
        s.wallet,
        s.kind,
        s.tokensRaw.toString(), // TEXT: bigint-safe
        s.quoteMint,
        s.quoteRaw === null ? null : s.quoteRaw.toString(),
        s.quoteSymbol,
        s.usdValue,
        fromBool(s.unpriced),
        s.balanceAfterRaw === null ? null : s.balanceAfterRaw.toString(),
        s.slot,
        s.blockTime,
        s.source,
      );
    return r.changes;
  }

  /**
   * THE FOLD. Every swap for one (mint, wallet), oldest first, through basis.ts.
   *
   * Pure in everything that matters: same rows in, same state out. That is what
   * lets two writers touch the same wallet concurrently without either clobbering
   * the other — they append facts, and this recomputes from all of them.
   *
   * Order is (slot, signature, kind) and must stay total: a weighted average is
   * NOT commutative across a sell, so an unstable order would give a different —
   * wrong — cost basis on replay.
   */
  #foldSwaps(
    mint: Mint,
    wallet: Wallet,
    decimals: number,
  ): { state: BasisState; basisUnpriced: boolean; realizedPnlUnknowable: boolean } {
    const rows = this.#db
      .prepare<[string, string], SwapRow>(
        `SELECT * FROM swaps WHERE mint = ? AND wallet = ?
          ORDER BY slot ASC, signature ASC, kind ASC`,
      )
      .all(mint, wallet);

    // DERIVED, never remembered: one unvaluable leg poisons the weighted average, so
    // it poisons the whole position (Phase 4.7). Rebuilding from the log alone must
    // reproduce this exactly — if it could not, it would not be a fold.
    let basisUnpriced = false;

    // …and separately: did the wallet DISPOSE of the mint into something we cannot
    // value? That leg books no realized PnL, because its PnL is unknowable — so the
    // running total is missing a piece it can never learn, and the honest answer is
    // NULL rather than a number that merely looks like one (Phase 4.8).
    //
    // Deliberately NOT the same condition as `basisUnpriced`. An unpriced BUY corrupts
    // the cost basis and leaves realized PnL alone; an unpriced SELL does the reverse.
    let realizedPnlUnknowable = false;

    let state = EMPTY_BASIS;
    for (const r of rows) {
      if (toBool(r.unpriced)) {
        basisUnpriced = true;
        if (r.kind === 'sell' || r.kind === 'transfer_out') realizedPnlUnknowable = true;
      }

      const tokensRaw = BigInt(r.tokens_raw);
      switch (r.kind) {
        case 'buy':
          state = applyBuy(state, { tokensRaw, usdIn: r.usd_value });
          break;
        case 'sell':
          state = applySell(state, { soldRaw: tokensRaw, usdOut: r.usd_value, decimals });
          break;
        case 'transfer_in':
          // FREE tokens. Zero cost, which correctly drags avgCost down: an airdrop
          // must never turn into phantom profit.
          state = applyTransferIn(state, tokensRaw);
          break;
        case 'transfer_out':
          // Quantity-only reduction at the current average. No realized PnL —
          // nothing was sold, so nothing was made or lost.
          state = applyTransferOut(state, tokensRaw, decimals);
          break;
      }
    }
    return { state, basisUnpriced, realizedPnlUnknowable };
  }

  /**
   * The newest absolute on-chain reading in the log. This is `onchain_raw`, and it
   * is why the ledger is derivable from the log alone.
   *
   * Null — not zero — when no swap ever revealed one. Zero is a REAL holding (a
   * wallet that sold out entirely), and conflating the two would call a fully-exited
   * wallet "unreconciled" forever.
   */
  #latestOnchain(mint: Mint, wallet: Wallet): bigint | null {
    const row = this.#db
      .prepare<[string, string], { balance_after_raw: string }>(
        `SELECT balance_after_raw FROM swaps
          WHERE mint = ? AND wallet = ? AND balance_after_raw IS NOT NULL
          ORDER BY slot DESC, signature DESC LIMIT 1`,
      )
      .get(mint, wallet);
    return row ? BigInt(row.balance_after_raw) : null;
  }

  /** Decimals for the fold. Sells and transfer-outs need them; buys do not. */
  #decimalsFor(mint: Mint, override?: number): number {
    if (override !== undefined) return override;
    const row = this.#db
      .prepare<[string], { decimals: number }>('SELECT decimals FROM tokens WHERE mint = ?')
      .get(mint);
    return row?.decimals ?? 0;
  }

  /**
   * Recompute a position from the log. Caller is inside a transaction.
   *
   * Everything derived (tokens, cost, realized PnL, drift, reconciled) comes from
   * the fold. Everything observational (first_seen, backfilled_at) is carried
   * forward — it is not a property of the swaps.
   */
  #recompute(mint: Mint, wallet: Wallet, opts: RecomputeOpts = {}): PositionRow {
    const now = Date.now();
    const prior = this.#readState(mint, wallet);
    const { state, basisUnpriced, realizedPnlUnknowable } = this.#foldSwaps(
      mint,
      wallet,
      this.#decimalsFor(mint, opts.decimals),
    );

    // Prefer the log. Fall back to a pre-existing reading only for rows seeded from
    // `buys`, which never persisted one.
    const priorOnchain = prior && BigInt(prior.onchain_raw) > 0n ? BigInt(prior.onchain_raw) : null;
    const onchain = this.#latestOnchain(mint, wallet) ?? priorOnchain;

    // No chain reading has EVER been seen for this wallet. We cannot claim a drift
    // of zero — we have nothing to compare against — so we claim nothing.
    const r =
      onchain === null
        ? { onchainRaw: 0n, driftRaw: 0n, reconciled: false }
        : reconcile(state.tokensRaw, onchain);

    const truncated = opts.historyTruncated ?? (prior ? toBool(prior.history_truncated) : false);

    this.#writeState({
      mint,
      buyer: wallet,
      state,
      // NULL = unknowable, not zero. The compiler makes every reader face it.
      realizedPnlUsd: realizedPnlUnknowable ? null : state.realizedPnlUsd,
      onchainRaw: r.onchainRaw,
      driftRaw: r.driftRaw,
      // RECONCILED HAS THREE INPUTS. Drift is the arbiter; two INDEPENDENT flags veto
      // it, and they are kept separate on purpose — when a wallet's Position % is dark
      // you want to know WHICH kind of blind you are:
      //
      //   historyTruncated  we do not have all the legs        (a backfill might fix it)
      //   basisUnpriced     we have all the legs and cannot    (nothing will fix it;
      //                     value one of them                   abstaining IS the answer)
      //
      // Drift can read as ZERO in both cases while the cost basis is nonsense, which is
      // exactly the confident public lie INVARIANT 10 exists to prevent.
      reconciled: r.reconciled && !truncated && !basisUnpriced,
      historyTruncated: truncated,
      basisUnpriced,
      backfilled: opts.backfilled ?? (prior ? toBool(prior.backfilled) : false),
      backfilledAt: opts.backfilledAt ?? prior?.backfilled_at ?? null,
      firstSeen: prior?.first_seen ?? now,
      now,
    });

    return this.#readState(mint, wallet) as PositionRow;
  }

  /**
   * THE ONE DOOR. Append a swap, then recompute the position from the whole log.
   *
   * Live ingest, hold-queue flush and backfill all come through here. There is no
   * other way to move a position.
   */
  async applySwap(swap: SwapRecord, opts: RecomputeOpts = {}): Promise<Position> {
    const run = this.#db.transaction((): PositionRow => {
      this.#insertSwap(swap);
      return this.#recompute(swap.mint, swap.wallet, opts);
    });
    return this.#hydratePosition(run());
  }

  /**
   * The same door, for a batch: insert everything a history walk discovered, then
   * recompute ONCE.
   *
   * The whole batch plus the recompute is a single transaction, so a live buy that
   * lands mid-walk either lands wholly before it (and the fold sees it) or wholly
   * after (and recomputes on top). It cannot be half-applied, and it cannot be
   * overwritten — nothing here writes state, only facts.
   */
  async applySwaps(
    swaps: readonly SwapRecord[],
    opts: RecomputeOpts & { mint: Mint; wallet: Wallet },
  ): Promise<{ position: Position; inserted: number }> {
    const run = this.#db.transaction((): { row: PositionRow; inserted: number } => {
      let inserted = 0;
      for (const s of swaps) inserted += this.#insertSwap(s);
      return { row: this.#recompute(opts.mint, opts.wallet, opts), inserted };
    });

    const { row, inserted } = run();
    return { position: this.#hydratePosition(row), inserted };
  }

  /** Recompute from the log without adding anything. */
  async recomputePosition(mint: Mint, wallet: Wallet, decimals?: number): Promise<Position> {
    const run = this.#db.transaction((): PositionRow => this.#recompute(mint, wallet, { decimals }));
    return this.#hydratePosition(run());
  }

  async listSwaps(mint: Mint, wallet: Wallet): Promise<readonly SwapRecord[]> {
    return this.#db
      .prepare<[string, string], SwapRow>(
        `SELECT * FROM swaps WHERE mint = ? AND wallet = ?
          ORDER BY slot ASC, signature ASC, kind ASC`,
      )
      .all(mint, wallet)
      .map((r) => ({
        signature: r.signature,
        mint: r.mint,
        wallet: r.wallet,
        kind: r.kind,
        tokensRaw: BigInt(r.tokens_raw),
        quoteMint: r.quote_mint,
        quoteSymbol: r.quote_symbol,
        quoteRaw: r.quote_raw === null ? null : BigInt(r.quote_raw),
        usdValue: r.usd_value,
        unpriced: toBool(r.unpriced),
        balanceAfterRaw: r.balance_after_raw === null ? null : BigInt(r.balance_after_raw),
        slot: r.slot,
        blockTime: r.block_time,
        source: r.source,
      }));
  }

  /**
   * Rebuild EVERY position from the swap log.
   *
   * This is the proof that `positions` is a materialized view and not a store: drop
   * the table, run this, and every derived value comes back identical. If it does
   * not, the fold is not pure and that is the bug.
   *
   * Returns the pairs whose stored row DISAGREED with the fold. On the Phase 4.5
   * migration those are wallets the old mutable ledger had already got wrong —
   * sells were never persisted, so their basis was built from a write that no
   * durable fact backs. We log them; we do not paper over them.
   */
  #rebuildAll(): PositionDisagreement[] {
    const pairs = this.#db
      .prepare<[], { mint: string; wallet: string }>('SELECT DISTINCT mint, wallet FROM swaps')
      .all();

    const disagreed: PositionDisagreement[] = [];

    this.#db.transaction(() => {
      for (const { mint, wallet } of pairs) {
        const priorRow = this.#readState(mint, wallet);
        const before = priorRow ? this.#hydratePosition(priorRow) : null;
        const after = this.#hydratePosition(this.#recompute(mint, wallet));

        // NULL is a VALUE here ("unknowable"), not a missing one: a stored number where
        // the fold says NULL is exactly the disagreement we want reported, not silently
        // coerced away (Phase 4.8).
        const samePnl = (a: number | null, b: number | null): boolean =>
          a === null || b === null ? a === b : Math.abs(a - b) < 1e-9;

        const same =
          before !== null &&
          before.tokensRaw === after.tokensRaw &&
          Math.abs(before.costUsd - after.costUsd) < 1e-9 &&
          samePnl(before.realizedPnlUsd, after.realizedPnlUsd);

        if (!same) disagreed.push({ mint, wallet, before, after });
      }
    })();

    return disagreed;
  }

  async rebuildPositions(): Promise<readonly PositionDisagreement[]> {
    return this.#rebuildAll();
  }

  /**
   * Refold `positions` once per marker.
   *
   * `positions` is a materialized view, so a migration that changes what the FOLD
   * computes — 4.5 seeding the log, 4.7 making legacy transfers `unpriced` — must
   * refold it. The refold cannot live in the migration SQL: it is bigint arithmetic,
   * and SQLite's SUM() over a TEXT u64 rounds through a float and drops the low bits
   * (INVARIANT 6).
   */
  #rebuildOnce(): void {
    const seen = this.#db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
    const mark = this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

    for (const marker of REBUILD_MARKERS) {
      if (seen.get(marker)) continue;

      const disagreed = this.#rebuildAll();

      for (const d of disagreed) {
        this.#log.warn(
          {
            marker,
            mint: d.mint,
            wallet: d.wallet,
            storedTokensRaw: d.before?.tokensRaw.toString() ?? null,
            foldedTokensRaw: d.after.tokensRaw.toString(),
            storedCostUsd: d.before?.costUsd ?? null,
            foldedCostUsd: d.after.costUsd,
          },
          'position disagreed with the swap-log fold; rebuilding it from the log',
        );
      }

      mark.run(marker, String(Date.now()));

      if (disagreed.length > 0) {
        this.#log.info({ marker, disagreed: disagreed.length }, 'refolded positions from the swap log');
      }
    }
  }

  // --- Adapters onto the one door ----------------------------------------------
  //
  // A BuyRecord and a SellRecord ARE swaps; these just name the shape the ingest and
  // pricing pipeline already produces. They cannot bypass the log.

  async applyBuy(buy: BuyRecord, chain?: { balanceAfterRaw: bigint }, decimals?: number): Promise<Position> {
    return this.applySwap(
      {
        signature: buy.signature,
        mint: buy.mint,
        wallet: buy.buyer,
        kind: 'buy',
        tokensRaw: buy.tokensRaw,
        quoteMint: buy.quoteMint,
        quoteSymbol: buy.quoteSymbol,
        quoteRaw: buy.quoteRaw,
        usdValue: buy.usdIn,
        // A buy was paid for in a REGISTRY quote asset, by definition — that is what
        // made it a buy rather than a transfer. So it is always priceable.
        unpriced: false,
        // EVERY BUY IS A RECONCILIATION CHECKPOINT — and now a durable one.
        balanceAfterRaw: chain?.balanceAfterRaw ?? null,
        slot: buy.slot,
        blockTime: buy.blockTime,
        source: 'live',
      },
      { decimals },
    );
  }

  async applySell(sell: SellRecord, decimals: number, chain?: { balanceAfterRaw: bigint }): Promise<Position> {
    return this.applySwap(
      {
        signature: sell.signature,
        mint: sell.mint,
        wallet: sell.seller,
        kind: 'sell',
        tokensRaw: sell.tokensRaw,
        quoteMint: sell.quoteMint,
        quoteSymbol: sell.quoteSymbol,
        quoteRaw: sell.quoteRaw,
        usdValue: sell.usdOut,
        unpriced: false, // a sell received a registry quote asset; always priceable
        balanceAfterRaw: chain?.balanceAfterRaw ?? null,
        slot: sell.slot,
        blockTime: sell.blockTime,
        source: 'live',
      },
      { decimals },
    );
  }

  /** Wallets whose ledger does not match the chain and are due a backfill. */
  async listUnreconciled(staleBeforeMs: number, limit = 50): Promise<readonly Position[]> {
    return this.#db
      .prepare<[number, number], PositionRow>(
        `SELECT * FROM positions
          WHERE reconciled = 0
            AND (backfilled_at IS NULL OR backfilled_at < ?)
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(staleBeforeMs, limit)
      .map((r) => this.#hydratePosition(r));
  }

  /** Record that a backfill ran, whether or not it achieved reconciliation. */
  async markBackfilled(mint: Mint, buyer: Wallet, at: number): Promise<void> {
    this.#db
      .prepare('UPDATE positions SET backfilled = 1, backfilled_at = ? WHERE mint = ? AND buyer = ?')
      .run(at, mint, buyer);
  }

  // --- Sends: THE IDEMPOTENCY CHOKEPOINT ---

  async claimSend(signature: Signature, chatId: ChatId): Promise<boolean> {
    // changes === 1 -> the row is ours. changes === 0 -> someone already holds it
    // (claimed, sent, or a failed tombstone). Either way: do nothing.
    return this.#claim.run(signature, chatId, Date.now()).changes === 1;
  }

  async markSent(signature: Signature, chatId: ChatId, messageId: number): Promise<void> {
    this.#db
      .prepare(
        `UPDATE sends SET state = 'sent', message_id = ?, settled_at = ?, fail_reason = NULL
          WHERE signature = ? AND chat_id = ?`,
      )
      .run(messageId, Date.now(), signature, chatId);
  }

  /** RETRYABLE failure. Deleting the row is what permits a future re-claim. */
  async releaseSend(signature: Signature, chatId: ChatId, reason: string): Promise<void> {
    this.#db.prepare('DELETE FROM sends WHERE signature = ? AND chat_id = ?').run(signature, chatId);
    this.#log.debug({ signature, chatId, reason }, 'send released for retry');
  }

  /**
   * PERMANENT failure. The tombstone is the point: it is never retried, and its
   * presence is what stops a replay from hammering a dead chat.
   */
  async failSend(signature: Signature, chatId: ChatId, reason: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO sends (signature, chat_id, state, attempts, claimed_at, settled_at, fail_reason)
         VALUES (?, ?, 'failed', 1, ?, ?, ?)
         ON CONFLICT (signature, chat_id) DO UPDATE SET
           state       = 'failed',
           settled_at  = excluded.settled_at,
           fail_reason = excluded.fail_reason,
           attempts    = sends.attempts + 1`,
      )
      .run(signature, chatId, Date.now(), Date.now(), reason);
  }

  /**
   * INVARIANT 9 — resolve orphaned claims by LOSING them, deliberately.
   *
   * A crash between claimSend and markSent leaves state='claimed' with no
   * message_id, and it is NOT KNOWABLE whether Telegram received the message.
   * We tombstone it and never resend. The buy is stale by the time the process is
   * back anyway, and a duplicate post is strictly worse than a missed one.
   *
   * One log line per orphan. If that line appears often, the bug is upstream.
   */
  async sweepOrphanedClaims(reason = 'orphaned'): Promise<number> {
    const orphans = this.#db
      .prepare<[], { signature: string; chat_id: number; claimed_at: number }>(
        `SELECT signature, chat_id, claimed_at FROM sends WHERE state = 'claimed'`,
      )
      .all();

    if (orphans.length === 0) return 0;

    const stmt = this.#db.prepare(
      `UPDATE sends SET state = 'failed', settled_at = ?, fail_reason = ?
        WHERE signature = ? AND chat_id = ? AND state = 'claimed'`,
    );
    this.#db.transaction(() => {
      const now = Date.now();
      for (const o of orphans) stmt.run(now, reason, o.signature, o.chat_id);
    })();

    for (const o of orphans) {
      this.#log.warn(
        { signature: o.signature, chatId: o.chat_id, claimedAt: o.claimed_at, reason },
        'orphaned send claim swept to failed; will NOT be resent (INVARIANT 9)',
      );
    }
    this.#log.info({ swept: orphans.length }, 'orphaned send claims swept');
    return orphans.length;
  }

  async deliveredToday(): Promise<number> {
    const since = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const row = this.#db
      .prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM sends WHERE state = 'sent' AND settled_at >= ?")
      .get(since);
    return row?.n ?? 0;
  }

  // --- Autotrader allowlist (Phase 12, INVARIANT 14) ---
  //
  // Note what is NOT here: any join to chat_plans, and any column a plan could set. Membership
  // is hand-entered and nothing widens it. A keystore is never touched by these methods —
  // removal locks the row and leaves the key on disk (`access.ts`).

  async getAutotraderUser(userId: number): Promise<AutotraderMember | null> {
    const row = this.#db
      .prepare<[number], AutotraderRow>('SELECT * FROM autotrader_users WHERE user_id = ?')
      .get(userId);
    return row ? hydrateAutotrader(row) : null;
  }

  async listAutotraderUsers(): Promise<readonly AutotraderMember[]> {
    return this.#db
      .prepare<[], AutotraderRow>('SELECT * FROM autotrader_users ORDER BY added_at')
      .all()
      .map(hydrateAutotrader);
  }

  async addAutotraderUser(userId: number, label: string | null, addedBy: number | null): Promise<void> {
    // Re-adding a removed member clears `locked` — that is the point of re-adding them — but
    // never resurrects anything about their key, which was not touched by the removal.
    this.#db
      .prepare(
        `INSERT INTO autotrader_users (user_id, label, added_by, added_at, locked, locked_at)
         VALUES (?, ?, ?, ?, 0, NULL)
         ON CONFLICT(user_id) DO UPDATE SET label = excluded.label, locked = 0, locked_at = NULL`,
      )
      .run(userId, label, addedBy, Date.now());
  }

  async setAutotraderLocked(userId: number, locked: boolean): Promise<void> {
    this.#db
      .prepare('UPDATE autotrader_users SET locked = ?, locked_at = ? WHERE user_id = ?')
      .run(locked ? 1 : 0, locked ? Date.now() : null, userId);
  }

  async deleteAutotraderUser(userId: number): Promise<void> {
    this.#db.prepare('DELETE FROM autotrader_users WHERE user_id = ?').run(userId);
  }

  async logAutotraderAccess(userId: number, action: string, actor: number | null, note?: string): Promise<void> {
    this.#db
      .prepare('INSERT INTO autotrader_access_log (user_id, action, actor, at, note) VALUES (?, ?, ?, ?, ?)')
      .run(userId, action, actor, Date.now(), note ?? null);
  }

  // --- Phase 13: DCA scheduler (SchedulerRepo). EVERY cap query is filtered by user_id. ---
  //
  // The idempotency of the whole surface rests on `claimExecution`: it is the same atomic
  // INSERT ... ON CONFLICT DO NOTHING as claimSend (INVARIANT 2), and it is what makes an
  // overlapping tick or a restart replay resolve to exactly one winner.

  async dueSchedules(now: number): Promise<readonly Schedule[]> {
    return this.#db
      .prepare<[number], ScheduleRow>(
        `SELECT * FROM schedules WHERE state = 'active' AND next_run_at <= ? ORDER BY next_run_at`,
      )
      .all(now)
      .map(hydrateSchedule);
  }

  async activeSchedules(): Promise<readonly Schedule[]> {
    return this.#db
      .prepare<[], ScheduleRow>(`SELECT * FROM schedules WHERE state = 'active' ORDER BY next_run_at`)
      .all()
      .map(hydrateSchedule);
  }

  async getSchedule(id: number): Promise<Schedule | null> {
    const row = this.#db.prepare<[number], ScheduleRow>('SELECT * FROM schedules WHERE id = ?').get(id);
    return row ? hydrateSchedule(row) : null;
  }

  /** Every schedule for one user, halted and paused included. Scoped by user_id. */
  async listSchedules(userId: number): Promise<readonly Schedule[]> {
    return this.#db
      .prepare<[number], ScheduleRow>('SELECT * FROM schedules WHERE user_id = ? ORDER BY id')
      .all(userId)
      .map(hydrateSchedule);
  }

  /** Create a schedule. `firstRunAt` is the first slot; the tick advances from there (rule 3). */
  async createSchedule(input: {
    userId: number;
    mint: Mint;
    side: Side;
    amountRaw: bigint;
    amountKind: AmountKind;
    intervalMinutes: number;
    slippageBps?: number;
    firstRunAt: number;
    state?: ScheduleState;
  }): Promise<number> {
    const now = Date.now();
    const res = this.#db
      .prepare(
        `INSERT INTO schedules
           (user_id, mint, side, amount_raw, amount_kind, interval_minutes, slippage_bps,
            state, next_run_at, last_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        input.userId,
        input.mint,
        input.side,
        input.amountRaw.toString(),
        input.amountKind,
        input.intervalMinutes,
        input.slippageBps ?? 100,
        input.state ?? 'active',
        input.firstRunAt,
        now,
        now,
      );
    return Number(res.lastInsertRowid);
  }

  /** Set (or replace) a user's per-mint caps. */
  async setCaps(input: {
    userId: number;
    mint: Mint;
    maxPerExecUsd: number;
    maxPerDayUsd: number;
    minSolReserveLamports?: bigint;
  }): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO caps (user_id, mint, max_per_exec_usd, max_per_day_usd, min_sol_reserve_lamports)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, mint) DO UPDATE SET
           max_per_exec_usd = excluded.max_per_exec_usd,
           max_per_day_usd = excluded.max_per_day_usd,
           min_sol_reserve_lamports = excluded.min_sol_reserve_lamports`,
      )
      .run(
        input.userId,
        input.mint,
        input.maxPerExecUsd,
        input.maxPerDayUsd,
        (input.minSolReserveLamports ?? 20_000_000n).toString(),
      );
  }

  async getCaps(userId: number, mint: Mint): Promise<Caps | null> {
    const row = this.#db
      .prepare<[number, string], CapsRow>('SELECT * FROM caps WHERE user_id = ? AND mint = ?')
      .get(userId, mint);
    return row ? hydrateCaps(row) : null;
  }

  /**
   * Rolling-24h spend for ONE user on ONE mint. CONFIRMED and UNKNOWN both count — an UNKNOWN
   * execution may have spent (INVARIANT 16), so it must occupy cap headroom or a lost-outcome
   * tx becomes free budget. Filtered by user_id: one person's spend never touches another's cap.
   */
  async usdSpent24h(userId: number, mint: Mint, sinceMs: number): Promise<number> {
    const row = this.#db
      .prepare<[number, string, number], { total: number | null }>(
        `SELECT COALESCE(SUM(e.usd_value), 0) AS total
           FROM executions e
           JOIN schedules  s ON s.id = e.schedule_id
          WHERE e.user_id = ?
            AND s.mint = ?
            AND e.planned_at >= ?
            AND e.state IN ('confirmed', 'UNKNOWN')`,
      )
      .get(userId, mint, sinceMs);
    return row?.total ?? 0;
  }

  async advanceSchedule(id: number, nextRunAt: number, lastRunAt: number | null): Promise<void> {
    this.#db
      .prepare('UPDATE schedules SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?')
      .run(nextRunAt, lastRunAt, Date.now(), id);
  }

  async haltSchedule(id: number, reason: string, at: number): Promise<void> {
    this.#db
      .prepare(`UPDATE schedules SET state = 'halted', halt_reason = ?, updated_at = ? WHERE id = ?`)
      .run(reason, at, id);
  }

  /**
   * THE claim. Atomic INSERT — the UNIQUE(schedule_id, planned_at) makes a double-fire
   * impossible. `changes === 1` means we own the slot; 0 means another tick already does, and
   * we return null so the caller does nothing. Identical discipline to claimSend.
   */
  async claimExecution(scheduleId: number, userId: number, plannedAt: number): Promise<number | null> {
    const res = this.#db
      .prepare(
        `INSERT INTO executions (schedule_id, user_id, planned_at, state)
         VALUES (?, ?, ?, 'claimed')
         ON CONFLICT (schedule_id, planned_at) DO NOTHING`,
      )
      .run(scheduleId, userId, plannedAt);
    return res.changes === 1 ? Number(res.lastInsertRowid) : null;
  }

  async settleExecution(id: number, outcome: ExecutionOutcome): Promise<void> {
    this.#db
      .prepare(
        `UPDATE executions
            SET state = ?, signature = ?, in_raw = ?, out_raw = ?, price_usd = ?, usd_value = ?, error = ?
          WHERE id = ?`,
      )
      .run(
        outcome.state,
        outcome.signature ?? null,
        outcome.inRaw != null ? outcome.inRaw.toString() : null,
        outcome.outRaw != null ? outcome.outRaw.toString() : null,
        outcome.priceUsd ?? null,
        outcome.usdValue ?? null,
        outcome.error ?? null,
        id,
      );
  }

  // --- Cursors ---

  async getCursor(mint: Mint): Promise<number | null> {
    const row = this.#db
      .prepare<[string], { last_slot: number }>('SELECT last_slot FROM cursors WHERE mint = ?')
      .get(mint);
    return row?.last_slot ?? null;
  }

  async setCursor(mint: Mint, slot: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO cursors (mint, last_slot) VALUES (?, ?)
         ON CONFLICT (mint) DO UPDATE SET last_slot = excluded.last_slot
          WHERE excluded.last_slot > cursors.last_slot`, // never rewind
      )
      .run(mint, slot);
  }
}
