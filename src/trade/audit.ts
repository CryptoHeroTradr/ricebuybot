/**
 * PHASE 16 (6) — the settings audit trail.
 *
 * The durable "what/from/to/when" for every autotrader knob a user turns. This is the type the
 * command layer writes and the daily digest reads. It is deliberately a record of INTENT (a user
 * changed a setting), distinct from `executions` (what the bot DID) and from `autotrader_access_log`
 * (who was granted or revoked membership).
 *
 * Values are strings, exactly as shown to the user — a dollar figure, a bps integer, a minute count,
 * a base58 mint. Nothing here is ever summed, so INVARIANT 6 (integer money) does not reach it; it is
 * a human-readable trail, not a ledger.
 */

/**
 * WHICH SURFACE issued a change. Phase 9 gave the website a write path into the same command layer
 * the Telegram panel uses, so "who turned this knob" now has a second possible answer and the trail
 * has to carry it — an audit row that cannot say where a change came from is not attributable.
 *
 * 'telegram' is the default because it is the surface the command layer was written for and the one
 * every call site already had; a caller that says nothing is the panel. The site path does NOT rely
 * on remembering to pass it — `withAuditSource` stamps it at the repo boundary, so every apply*,
 * including ones added later, is tagged by construction.
 */
export type SettingSource = 'telegram' | 'site';

export const DEFAULT_SETTING_SOURCE: SettingSource = 'telegram';

/** A recorded setting change, as stored (with its row id and server-stamped time). */
export interface SettingChange {
  readonly id: number;
  readonly userId: number;
  readonly at: number;
  /** The knob: 'schedule.create' | 'schedule.interval' | 'schedule.slippage' | 'schedule.amount'
   *  | 'schedule.pause' | 'schedule.resume' | 'schedule.delete' | 'stop_all' | 'resume_all'
   *  | 'caps' | 'contract' | 'wallet'. A plain string, not an enum — the DB does not constrain it,
   *  so a new action never needs a migration. */
  readonly action: string;
  /** The schedule this touched, or null for an account-wide change (caps/contract/wallet/bulk). */
  readonly scheduleId: number | null;
  /** The specific field, when the action changes more than one thing over its life; else null. */
  readonly field: string | null;
  /** null for a creation. */
  readonly fromValue: string | null;
  /** null for a deletion; both null for a bulk action carrying only a count. */
  readonly toValue: string | null;
  /** The surface that issued the change. Never null in storage — see migration 020. */
  readonly source: SettingSource;
}

/**
 * What a caller supplies. `id` is assigned by the DB; `at` is stamped server-side at write time.
 *
 * `source` is OPTIONAL and absent means {@link DEFAULT_SETTING_SOURCE}. That default is not a guess:
 * the command layer's only caller was the Telegram panel until the site bridge grew a write path,
 * and the site path stamps its own source at the repo boundary rather than at each call site.
 */
export type SettingChangeInput = Omit<SettingChange, 'id' | 'at' | 'source'> & {
  readonly source?: SettingSource;
};
