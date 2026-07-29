import type { Logger } from 'pino';

import type { ExecutionRecord, ExecutionState, Schedule } from '../trade/scheduler.js';
import { usd } from '../render/format.js';

/**
 * PHASE 16 (6) — the daily digest DM.
 *
 * Once a day, each autotrader member gets a private summary of the last 24 hours: what the bot did
 * with their money (executions, total spent, average fill), what they changed (the audit trail
 * count), what is HALTED and waiting on them, and their wallet balance. It is per-user and scoped to
 * that user's own rows — the same boundary as /trade and /history (INVARIANT 14).
 *
 * A quiet day sends NOTHING. A daily "you did nothing" ping trains people to mute the bot, and a
 * muted bot is one that cannot deliver the digest that matters — the one that says a schedule halted.
 * So the digest only goes out when there is activity or a halt to act on.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;
const DAY_MS = 86_400_000;
const TICK_MS = 15 * 60_000;
/** The meta key holding the last day-index we sent a digest for — idempotent across restarts. */
const META_KEY = 'digest:last_day';

export interface DigestData {
  readonly executions: readonly ExecutionRecord[];
  readonly settingChanges: number;
  readonly halted: readonly { readonly id: number; readonly haltReason: string | null }[];
  /** null when there is no wallet, it is locked to us, or the RPC read failed — the digest omits the line. */
  readonly solBalanceLamports: bigint | null;
}

/**
 * The 24h numbers, computed once.
 *
 * Extracted from {@link buildDigest} when the site bridge started returning the same figures for
 * the website's dashboard (Phase 9). They are the same numbers under the same counting rules, so
 * they are computed in ONE place and rendered in two — a second implementation is how a user ends
 * up reading "$40 spent" in a DM and "$38 spent" on the site and trusting neither.
 *
 * PURE: an array in, numbers out. No clock, no I/O, no formatting.
 */
export interface DigestFigures {
  readonly executions: number;
  readonly confirmed: number;
  readonly submitted: number;
  readonly unknown: number;
  readonly failed: number;
  /** How many executions contributed to `spentUsd` — 0 means "nothing priced", not "$0 spent". */
  readonly spendingCount: number;
  readonly spentUsd: number;
  readonly avgTradeUsd: number;
  readonly avgFillPriceUsd: number | null;
}

export function digestFigures(executions: readonly ExecutionRecord[]): DigestFigures {
  const count = (s: ExecutionState): number => executions.filter((e) => e.state === s).length;

  // Spend counts CONFIRMED + UNKNOWN — the same rule as the daily cap, because an UNKNOWN may
  // have spent (INVARIANT 16). These are DISPLAY dollars (usd_value is REAL); INVARIANT 6 governs
  // raw token/lamport integers, never a rendered dollar figure, so summing here is correct.
  const spending = executions.filter((e) => (e.state === 'confirmed' || e.state === 'UNKNOWN') && e.usdValue != null);
  const spentUsd = spending.reduce((sum, e) => sum + (e.usdValue ?? 0), 0);
  const priced = executions.filter((e) => e.priceUsd != null);

  return {
    executions: executions.length,
    confirmed: count('confirmed'),
    submitted: count('submitted'),
    unknown: count('UNKNOWN'),
    failed: count('failed'),
    spendingCount: spending.length,
    spentUsd,
    avgTradeUsd: spending.length > 0 ? spentUsd / spending.length : 0,
    avgFillPriceUsd: priced.length > 0 ? priced.reduce((s, e) => s + (e.priceUsd ?? 0), 0) / priced.length : null,
  };
}

/**
 * Render the 24h digest, or null when there is nothing worth a DM (no executions, no halts, no
 * changes). PURE — testable with no bot, no DB, no clock.
 */
export function buildDigest(d: DigestData): string | null {
  if (d.executions.length === 0 && d.halted.length === 0 && d.settingChanges === 0) return null;

  const f = digestFigures(d.executions);
  const lines: string[] = ['📊 Your autotrader — last 24h', ''];

  if (f.executions > 0) {
    const parts = [`${f.confirmed} confirmed`];
    if (f.submitted > 0) parts.push(`${f.submitted} pending`);
    if (f.unknown > 0) parts.push(`${f.unknown} ⚠️ UNKNOWN`);
    if (f.failed > 0) parts.push(`${f.failed} failed`);
    lines.push(`${f.executions} execution(s): ${parts.join(', ')}`);

    const spendLine = f.spendingCount > 0 ? `Spent ${usd(f.spentUsd)} · avg ${usd(f.avgTradeUsd)}/trade` : 'Spent $0';
    lines.push(f.avgFillPriceUsd != null ? `${spendLine} · avg fill $${f.avgFillPriceUsd.toPrecision(4)}` : spendLine);
  }

  if (d.solBalanceLamports != null) {
    lines.push(`Wallet: ${(Number(d.solBalanceLamports) / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  }

  if (d.settingChanges > 0) lines.push(`${d.settingChanges} setting change(s) — see /history settings`);

  if (d.halted.length > 0) {
    lines.push('', `🛑 ${d.halted.length} schedule(s) HALTED — ▶️ Resume when ready:`);
    for (const h of d.halted) lines.push(`  #${h.id}${h.haltReason ? ` — ${h.haltReason}` : ''}`);
  }

  return lines.join('\n');
}

/** The repo surface the digest reads — all user-scoped, all read-only except the day marker. */
export interface DigestRepo {
  listAutotraderUsers(): Promise<readonly { readonly userId: number; readonly locked: boolean }[]>;
  executionsSince(userId: number, sinceMs: number): Promise<readonly ExecutionRecord[]>;
  listSettingChangesSince(userId: number, sinceMs: number): Promise<readonly { readonly id: number }[]>;
  listSchedules(userId: number): Promise<readonly Schedule[]>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

export interface DigestDeps {
  readonly repo: DigestRepo;
  readonly pubkeyOf: (userId: number) => string | null;
  readonly getBalance: (pubkey: string) => Promise<bigint | null>;
  /** DM one user. Best-effort — a blocked/unreachable user must not stop the others. */
  readonly send: (userId: number, text: string) => Promise<void>;
  readonly log: Logger;
  /** UTC hour to send at (0–23). Default 0 (just after midnight UTC). */
  readonly hourUtc?: number;
  readonly now?: () => number;
}

export class DigestScheduler {
  readonly #d: DigestDeps;
  readonly #now: () => number;
  readonly #hourUtc: number;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: DigestDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#hourUtc = Math.min(Math.max(deps.hourUtc ?? 0, 0), 23);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(
      () => void this.tick().catch((e) => this.#d.log.error({ err: msg(e) }, 'digest tick failed')),
      TICK_MS,
    );
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * One pass. Sends the digest to every member IFF the UTC day has advanced past the last one we
   * sent for AND the clock has reached the send hour. Returns the number of DMs sent.
   *
   * The day marker is persisted (meta), so a restart in the middle of the digest hour does not
   * re-blast everyone — the same discipline as every other idempotent surface in the bot.
   */
  async tick(): Promise<number> {
    const now = this.#now();
    if (new Date(now).getUTCHours() < this.#hourUtc) return 0;

    const today = Math.floor(now / DAY_MS);
    const last = Number(await this.#d.repo.getMeta(META_KEY));
    if (Number.isFinite(last) && last >= today) return 0; // already sent today

    const since = now - DAY_MS;
    let sent = 0;
    for (const m of await this.#d.repo.listAutotraderUsers()) {
      if (m.locked) continue; // a revoked member is off every surface, the digest included
      try {
        const text = buildDigest({
          executions: await this.#d.repo.executionsSince(m.userId, since),
          settingChanges: (await this.#d.repo.listSettingChangesSince(m.userId, since)).length,
          halted: (await this.#d.repo.listSchedules(m.userId))
            .filter((s) => s.state === 'halted')
            .map((s) => ({ id: s.id, haltReason: s.haltReason })),
          solBalanceLamports: await this.#balanceOf(m.userId),
        });
        if (text) {
          await this.#d.send(m.userId, text);
          sent++;
        }
      } catch (err) {
        this.#d.log.error({ userId: m.userId, err: msg(err) }, 'digest: one member failed — others continue');
      }
    }

    // Mark the day sent only AFTER the pass. A crash mid-pass re-runs the whole day next tick; a
    // duplicate digest DM is harmless, a silently skipped one is not.
    await this.#d.repo.setMeta(META_KEY, String(today));
    return sent;
  }

  async #balanceOf(userId: number): Promise<bigint | null> {
    const pk = this.#d.pubkeyOf(userId);
    if (!pk) return null;
    return this.#d.getBalance(pk).catch(() => null);
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
