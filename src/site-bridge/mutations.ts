import type { Mint } from '../core/types.js';
import type { SettingChangeInput, SettingSource } from '../trade/audit.js';
import { checkMember, type AutotraderAccessRepo } from '../trade/access.js';
import {
  applyAmount,
  applyCaps,
  applyInterval,
  applyPause,
  applyResume,
  applyStopAll,
  WALLET_MODE_REFUSAL,
  type ApplyResult,
  type PanelRepo,
} from '../telegram/trade-panel/commands.js';

/**
 * PHASE 9 — the WRITE half of the site bridge.
 *
 * ONE COMMAND LAYER, TWO ENTRY POINTS. Nothing in this file decides what a pause means, what a
 * legal interval is, or whose schedule may be touched. Every one of those answers is already
 * written down in `telegram/trade-panel/commands.ts` and is reached here by calling the SAME
 * `apply*` function the Telegram panel calls — not a copy of it, not a re-implementation with the
 * same rules typed out again. A guard the panel enforces is a guard the site enforces because
 * there is only one place where the guard exists to be enforced.
 *
 * What this file DOES own is the three things the site path has and the panel does not:
 *
 *   1. a canonical INTENT — an untyped JSON body turned into exactly what will be done, so the
 *      string the wallet signs and the action that runs are derived from the same value;
 *   2. the ACTION-TIME gates a Telegram chat gets for free — membership and custody mode, both
 *      re-read per request and never cached (a revocation must bite now, not at a TTL);
 *   3. the AUDIT SOURCE stamp, applied at the repo boundary so that every apply* reached from
 *      here — including ones written after today — records `source=site` without its author
 *      having to remember.
 *
 * WHAT IS NOT HERE, AND MUST NOT BE. No key import, no key generate, no create-a-schedule-with-a-
 * new-wallet. Those need the bot to hold new key material, and the channel that gets a wallet to
 * hand over a key must be the one where the custody warning is shown and typed back — the bot.
 * {@link KEY_ONLY_PATHS} refuses them by name rather than by 404, because "that route does not
 * exist" and "that will never be offered here" are different sentences and the user deserves the
 * second one.
 */

// --- the actions this channel offers -----------------------------------------------------------

/** The six mutations, and nothing else. Adding to this union is a deliberate widening. */
export type SiteAction = 'pause' | 'resume' | 'stop-all' | 'amount' | 'interval' | 'caps';

/** Path -> action. The path names the action, and the signed message names it too — a request
 *  whose path disagrees with the message the wallet signed cannot verify. */
export const SITE_WRITE_PATHS: ReadonlyMap<string, SiteAction> = new Map([
  ['/site/pause', 'pause'],
  ['/site/resume', 'resume'],
  ['/site/stop-all', 'stop-all'],
  ['/site/amount', 'amount'],
  ['/site/interval', 'interval'],
  ['/site/caps', 'caps'],
] as const);

/**
 * Routes that will never exist on this channel, refused BY NAME. Everything here would require the
 * bot to take custody of new key material, and that conversation happens in Telegram or not at all.
 */
export const KEY_ONLY_PATHS: ReadonlySet<string> = new Set([
  '/site/wallet/import',
  '/site/wallet/generate',
  '/site/wallet/export',
  '/site/wallet/unlock',
  '/site/schedules/new-wallet',
]);

export const KEY_REFUSAL = 'manage your wallet in the bot';

/**
 * A parsed, canonical mutation. `args` are the raw-but-normalised strings the command layer parses
 * itself — the site does NOT pre-validate them into numbers, because the command layer's parsing IS
 * the guard (a sub-$1 buy, a sub-1-minute interval, an over-ceiling cap) and parsing twice is how
 * two surfaces end up disagreeing about what "0.5" means.
 */
export interface SiteIntent {
  readonly action: SiteAction;
  readonly scheduleId: number | null;
  readonly args: readonly string[];
}

export type ParseResult = { readonly intent: SiteIntent } | { readonly error: string };

/** A scalar from an untyped body, canonicalised to the string the command layer would have been
 *  typed. Numbers are accepted (JSON's natural shape) and stringified deterministically, so the
 *  challenge and the write derive the same message from the same body. */
function scalar(v: unknown): string | null {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Body -> intent. This rejects only what it cannot turn into an action at all (a missing id, a
 * missing amount). It deliberately does NOT judge the VALUES: "$0.40" and "0 minutes" parse fine
 * here and are refused by the command layer, in the panel's own words. Validating them twice would
 * mean maintaining the rules twice.
 */
export function parseIntent(action: SiteAction, body: Record<string, unknown>): ParseResult {
  const id = positiveInt(body.scheduleId);
  const needsId = action === 'pause' || action === 'resume' || action === 'amount' || action === 'interval';
  if (needsId && id === null) return { error: 'scheduleId must be a positive integer' };

  switch (action) {
    case 'pause':
    case 'resume':
      return { intent: { action, scheduleId: id, args: [] } };
    case 'stop-all':
      return { intent: { action, scheduleId: null, args: [] } };
    case 'amount': {
      const amount = scalar(body.amount);
      if (amount === null || amount === '') return { error: 'amount is required' };
      return { intent: { action, scheduleId: id, args: [amount] } };
    }
    case 'interval': {
      const interval = scalar(body.interval);
      if (interval === null || interval === '') return { error: 'interval is required' };
      return { intent: { action, scheduleId: id, args: [interval] } };
    }
    case 'caps': {
      const per = scalar(body.per);
      const day = scalar(body.day);
      if (per === null || per === '') return { error: 'per is required' };
      if (day === null || day === '') return { error: 'day is required' };
      // Lifetime is optional in the panel too: omitted KEEPS the current value, "none" clears it.
      // An omitted field and an empty string must canonicalise identically or the two endpoints
      // would build different messages for the same request.
      const life = scalar(body.lifetime) ?? '';
      return { intent: { action, scheduleId: null, args: [per, day, life] } };
    }
  }
}

// --- the action-time gates ---------------------------------------------------------------------

export interface WriteRefusal {
  readonly status: number;
  readonly error: string;
}

/**
 * A wallet that resolves to nobody and a wallet that resolves to a REVOKED member get the same
 * sentence. The panel answers a non-member with silence precisely so that a refusal cannot be used
 * to learn who is on the allowlist (INVARIANT 14); this channel cannot be silent — an HTTP caller
 * always learns something — so it makes the two cases indistinguishable instead.
 */
export const NOT_LINKED: WriteRefusal = Object.freeze({
  status: 403,
  error: 'this wallet is not linked to an account that can be changed here',
});

const WALLET_MODE: WriteRefusal = Object.freeze({ status: 403, error: WALLET_MODE_REFUSAL });

/**
 * Membership + custody mode, re-read AT ACTION TIME for every single write, exactly like the
 * panel's gate. Never cached: a cache here is a revocation with a TTL.
 *
 * Wallet mode is refused for the same reason the panel refuses it — there is no custodial schedule
 * of ours to change, so there is nothing here to act on. Note this is not a security boundary on
 * top of ownership (that is `ownedSchedule` inside the command layer); it is the honest answer.
 */
export async function authorizeWrite(
  access: AutotraderAccessRepo,
  userId: number,
): Promise<{ readonly ok: true } | WriteRefusal> {
  const verdict = await checkMember(access, userId);
  if (!verdict.allowed) return NOT_LINKED;
  if (verdict.member.mode !== 'key') return WALLET_MODE;
  return { ok: true };
}

// --- the audit-source stamp --------------------------------------------------------------------

/**
 * The SAME repo, with one method wrapped: every settings-audit row written through it carries the
 * given source.
 *
 * Why a wrapper and not an extra parameter on each apply*: the property that must hold is "every
 * mutation issued by this surface is attributable to it", and a parameter makes that property a
 * thing each call site must remember. Stamping at the boundary makes it a thing the call site
 * cannot get wrong — an apply* added next month is tagged without being touched.
 *
 * A Proxy rather than a spread, because the repo is a class instance: its methods live on the
 * prototype and `{...repo}` would silently produce an object with none of them. `Reflect.get` is
 * given the TARGET as receiver so methods that touch #private fields still work when bound.
 */
export function withAuditSource(repo: PanelRepo, source: SettingSource): PanelRepo {
  return new Proxy(repo, {
    get(target: PanelRepo, prop: string | symbol): unknown {
      if (prop === 'recordSettingChange') {
        return (entry: SettingChangeInput): Promise<void> =>
          target.recordSettingChange({ ...entry, source });
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as PanelRepo;
}

// --- the dispatch ------------------------------------------------------------------------------

export interface ApplyIntentOptions {
  /** The mint a cap applies to when the user has never chosen one — the panel's own fallback. */
  readonly defaultMint: string;
  readonly maxPerDayUsdCeiling?: number | undefined;
  readonly maxLifetimeUsdCeiling?: number | undefined;
}

/**
 * THE dispatch. Six cases, six `apply*` calls, no logic in between.
 *
 * `userId` is the user the WALLET resolved to moments ago in the route — never a user id from the
 * request body, which would be a caller choosing whose schedules to edit. Ownership of the named
 * schedule is then checked inside the command layer (`ownedSchedule`), which is what makes a write
 * naming someone else's id fail with the panel's own refusal rather than a bespoke one.
 */
export async function applyIntent(
  repo: PanelRepo,
  userId: number,
  intent: SiteIntent,
  opts: ApplyIntentOptions,
): Promise<ApplyResult> {
  const id = intent.scheduleId ?? Number.NaN;
  const arg = (i: number): string => intent.args[i] ?? '';
  switch (intent.action) {
    case 'pause':
      return applyPause(repo, userId, id);
    case 'resume':
      return applyResume(repo, userId, id);
    case 'stop-all':
      return applyStopAll(repo, userId);
    case 'amount':
      return applyAmount(repo, userId, id, arg(0));
    case 'interval':
      return applyInterval(repo, userId, id, arg(0));
    case 'caps': {
      const contract = (await repo.getContract(userId)) ?? (opts.defaultMint as Mint);
      return applyCaps(
        repo,
        userId,
        contract,
        arg(0),
        arg(1),
        arg(2),
        opts.maxPerDayUsdCeiling ?? Infinity,
        opts.maxLifetimeUsdCeiling ?? Infinity,
      );
    }
  }
}
