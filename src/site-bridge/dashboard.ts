import { DRY_BANNER, LIVE_BANNER, modeBanner } from '../telegram/trade-panel/render.js';
import { digestFigures } from '../telegram/trade-digest.js';
import type { ExecutionRecord, Schedule } from '../trade/scheduler.js';
import type { Mint } from '../core/types.js';
import type {
  SiteBanner,
  SiteCaps,
  SiteDashboard,
  SiteDigest,
  SiteExecution,
  SiteSchedule,
  SiteTraderMode,
} from './dashboard-contract.js';
import { SITE_DIGEST_WINDOW_MS, SITE_EXECUTION_LIMIT, SITE_WALLET_BUY_LIMIT } from './dashboard-contract.js';

/**
 * PHASE 9 — assembling the website's dashboard out of the SAME reads the Telegram panel makes.
 *
 * The panel and this builder answer the same question for the same person on two screens, so
 * nothing here re-derives a figure that already has an owner elsewhere:
 *
 *   * the LIVE/DRY and custody sentences are the panel's own exported constants, so the two
 *     surfaces cannot word the most important warning in the product differently;
 *   * the 24h numbers come from `digestFigures`, the function the daily DM renders from;
 *   * every row is fetched with the acting user's id through the panel's user-scoped reads.
 *
 * READ-ONLY, TOP TO BOTTOM. Every method on {@link SiteDashboardRepo} is a SELECT. This module
 * imports no mutation, touches no keystore, and knows nothing about custody beyond which of the two
 * modes to name in a banner. What it must NOT return is documented on the contract type, not here,
 * because the contract is what the site reads.
 */

const DAY_MS = 86_400_000;

/** The read surface the dashboard needs. Every method is user-scoped or public-data-only. */
export interface SiteDashboardRepo {
  listSchedules(userId: number): Promise<readonly Schedule[]>;
  getCaps(userId: number, mint: Mint): Promise<{ maxPerExecUsd: number; maxPerDayUsd: number; maxLifetimeUsd: number | null } | null>;
  usdSpent24h(userId: number, mint: Mint, sinceMs: number): Promise<number>;
  usdSpentLifetime(userId: number, mint: Mint): Promise<number>;
  getContract(userId: number): Promise<Mint | null>;
  listExecutionsForUser(userId: number, limit: number): Promise<readonly ExecutionRecord[]>;
  lastExecutionForSchedule(scheduleId: number): Promise<ExecutionRecord | null>;
  executionsSince(userId: number, sinceMs: number): Promise<readonly ExecutionRecord[]>;
  listSettingChangesSince(userId: number, sinceMs: number): Promise<readonly { readonly id: number }[]>;
  recentWalletDcaBuys(wallet: string, mint: Mint, limit: number): Promise<readonly { tokensRaw: bigint; usdIn: number; at: number }[]>;
}

export interface DashboardDeps {
  readonly repo: SiteDashboardRepo;
  readonly tradeLive: boolean;
  readonly defaultMint: string;
  /** Token symbol for the contract, when the metadata cache has it. Absent/null -> the mint's
   *  first four characters, which is exactly the panel's fallback. Never fails the read. */
  readonly symbolOf?: ((mint: string) => Promise<string | null>) | undefined;
  readonly now: () => number;
}

/** The banner, and it is built even for an unlinked wallet: whether the bot is trading live is a
 *  fact about the bot, and the site must be able to say it before it knows who is looking. */
export function siteBanner(tradeLive: boolean, mode: SiteTraderMode): SiteBanner {
  return {
    tradeLive,
    mode,
    text: tradeLive ? LIVE_BANNER : DRY_BANNER,
    modeText: modeBanner(mode),
  };
}

function capsDto(caps: { maxPerExecUsd: number; maxPerDayUsd: number; maxLifetimeUsd: number | null } | null): SiteCaps | null {
  return caps ? { perExecUsd: caps.maxPerExecUsd, perDayUsd: caps.maxPerDayUsd, lifetimeUsd: caps.maxLifetimeUsd } : null;
}

/** bigint -> string at the wire boundary (INVARIANT 6): JSON has no bigint and a u64 does not
 *  survive `Number`. The site parses these, it never adds them. */
function executionDto(e: ExecutionRecord): SiteExecution {
  return {
    id: e.id,
    scheduleId: e.scheduleId,
    plannedAt: e.plannedAt,
    state: e.state,
    signature: e.signature,
    inRaw: e.inRaw != null ? e.inRaw.toString() : null,
    outRaw: e.outRaw != null ? e.outRaw.toString() : null,
    priceUsd: e.priceUsd,
    usdValue: e.usdValue,
    error: e.error,
  };
}

async function scheduleDto(repo: SiteDashboardRepo, s: Schedule, now: number): Promise<SiteSchedule> {
  const [caps, spentTodayUsd, spentLifetimeUsd, last] = await Promise.all([
    repo.getCaps(s.userId, s.mint),
    repo.usdSpent24h(s.userId, s.mint, now - DAY_MS),
    repo.usdSpentLifetime(s.userId, s.mint),
    repo.lastExecutionForSchedule(s.id),
  ]);
  return {
    id: s.id,
    mint: s.mint,
    side: s.side,
    amountKind: s.amountKind,
    amountRaw: s.amountRaw.toString(),
    intervalMinutes: s.intervalMinutes,
    slippageBps: s.slippageBps,
    state: s.state,
    haltReason: s.haltReason,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt,
    caps: capsDto(caps),
    spentTodayUsd,
    spentLifetimeUsd,
    lastExecution: last ? executionDto(last) : null,
  };
}

/** The same window and the same counting rules as the daily DM — see `digestFigures`. */
async function digestDto(repo: SiteDashboardRepo, userId: number, schedules: readonly Schedule[], now: number): Promise<SiteDigest> {
  const since = now - SITE_DIGEST_WINDOW_MS;
  const [executions, changes] = await Promise.all([
    repo.executionsSince(userId, since),
    repo.listSettingChangesSince(userId, since),
  ]);
  const f = digestFigures(executions);
  return {
    windowMs: SITE_DIGEST_WINDOW_MS,
    executions: f.executions,
    confirmed: f.confirmed,
    submitted: f.submitted,
    unknown: f.unknown,
    failed: f.failed,
    spentUsd: f.spentUsd,
    avgTradeUsd: f.avgTradeUsd,
    avgFillPriceUsd: f.avgFillPriceUsd,
    settingChanges: changes.length,
    halted: schedules.filter((s) => s.state === 'halted').map((s) => ({ id: s.id, haltReason: s.haltReason })),
  };
}

/** The panel's symbol rule, verbatim: the metadata symbol if there is one, else the mint's first
 *  four characters. A failed lookup is a fallback, never an error — a dashboard must still render. */
async function symbolFor(deps: DashboardDeps, mint: string): Promise<string> {
  const s = deps.symbolOf ? await deps.symbolOf(mint).catch(() => null) : null;
  return s ? `$${s}` : mint.slice(0, 4);
}

/** A proven wallet that no Telegram user has linked. Not an error: the banner is still the truth,
 *  and the site renders its "link your wallet in the bot" state around it. */
export function unlinkedDashboard(deps: DashboardDeps, mode: SiteTraderMode = 'wallet'): SiteDashboard {
  return {
    ok: true,
    linked: false,
    banner: siteBanner(deps.tradeLive, mode),
    contract: null,
    schedules: [],
    caps: null,
    spend: null,
    executions: [],
    digest: null,
    walletMode: null,
    serverTime: deps.now(),
  };
}

/**
 * THE dashboard for one linked user.
 *
 * `userId` is the id the signing wallet resolved to in the route, moments ago — never anything from
 * the request body. Every read below is keyed by it, which is what makes "only theirs" a property
 * of the query rather than of a filter someone could forget.
 *
 * WALLET MODE RETURNS A DIFFERENT DASHBOARD, not this one with empty arrays — the same choice the
 * panel makes. There is no custodial schedule, no cap of ours and no execution of ours, so listing
 * those sections empty would describe machinery that is not running; what comes back instead is the
 * proven wallet and the fills the bot observed for it.
 */
export async function buildDashboard(
  deps: DashboardDeps,
  userId: number,
  mode: SiteTraderMode,
  linkedWallet: string | null,
): Promise<SiteDashboard> {
  const now = deps.now();
  const contractMint = (await deps.repo.getContract(userId)) ?? (deps.defaultMint as Mint);
  const symbol = await symbolFor(deps, contractMint);
  const banner = siteBanner(deps.tradeLive, mode);
  const contract = { mint: contractMint as string, symbol };

  if (mode === 'wallet') {
    const recentBuys = linkedWallet
      ? await deps.repo.recentWalletDcaBuys(linkedWallet, contractMint, SITE_WALLET_BUY_LIMIT).catch(() => [])
      : [];
    return {
      ok: true,
      linked: true,
      banner,
      contract,
      schedules: [],
      caps: null,
      spend: null,
      executions: [],
      digest: null,
      walletMode: {
        linkedWallet,
        recentBuys: recentBuys.map((b) => ({ tokensRaw: b.tokensRaw.toString(), usdIn: b.usdIn, at: b.at })),
      },
      serverTime: now,
    };
  }

  const [schedules, caps, todayUsd, lifetimeUsd, executions] = await Promise.all([
    deps.repo.listSchedules(userId),
    deps.repo.getCaps(userId, contractMint),
    deps.repo.usdSpent24h(userId, contractMint, now - DAY_MS),
    deps.repo.usdSpentLifetime(userId, contractMint),
    deps.repo.listExecutionsForUser(userId, SITE_EXECUTION_LIMIT),
  ]);

  return {
    ok: true,
    linked: true,
    banner,
    contract,
    schedules: await Promise.all(schedules.map((s) => scheduleDto(deps.repo, s, now))),
    caps: capsDto(caps),
    spend: { todayUsd, lifetimeUsd },
    executions: executions.map(executionDto),
    digest: await digestDto(deps.repo, userId, schedules, now),
    walletMode: null,
    serverTime: now,
  };
}
