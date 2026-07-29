import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { RouteHandler } from '../ops/health.js';
import type { Logger } from '../ops/logger.js';
import type { Mint } from '../core/types.js';
import type { Caps, Schedule } from '../trade/scheduler.js';
import type { PanelRepo } from '../telegram/trade-panel/commands.js';
import type { AutotraderAccessRepo } from '../trade/access.js';
import type { LinkCodeStore, NonceStore } from './store.js';
import { verifyWalletSignature } from './verify.js';
import { verifyInitData } from './init-data.js';
import { challengeMessage, linkMessage, writeMessage } from './messages.js';
import {
  applyIntent,
  authorizeWrite,
  parseIntent,
  withAuditSource,
  KEY_ONLY_PATHS,
  KEY_REFUSAL,
  NOT_LINKED,
  SITE_WRITE_PATHS,
  type ApplyIntentOptions,
  type SiteIntent,
} from './mutations.js';

/**
 * The bot side of the site bridge, mounted on the EXISTING :3012 handler (like the webhook
 * ingestor) — no second listener.
 *
 * READS are structurally read-only: they are given a repo surface ({@link SiteBridgeRepo}) with no
 * schedule-mutation method on it at all, so no read route can pause, edit, create, stop or delete
 * anything. That was the whole of this file until Phase 9.
 *
 * PHASE 9 ADDS A WRITE PATH, and it is deliberately a SEPARATE, OPTIONAL surface ({@link
 * SiteBridgeWrite}) rather than a widening of the read repo. Absent, the six mutation routes are
 * not mounted and this handler is exactly the read-only bridge it was before. Present, every one of
 * them goes through the same gauntlet:
 *
 *   shared secret -> canonical intent -> wallet signature OVER THAT INTENT -> nonce consumed
 *   -> wallet re-resolved to a Telegram user -> membership + custody mode re-checked
 *   -> the Telegram panel's own apply* -> audited as source=site
 *
 * Every step is a refusal the panel also makes; none of them is implemented twice. What the bridge
 * adds is proof of WHO is asking, which in Telegram is a property of the chat and here has to be
 * established from a signature.
 *
 * The bot NEVER returns a key, a passphrase or any secret from any of these routes, and no route
 * that would need the bot to take custody of key material exists at all ({@link KEY_ONLY_PATHS}).
 */

const MAX_BODY_BYTES = 8 * 1024;

/** The narrow repo surface the bridge may touch — reads + the one identity write, nothing else. */
export interface SiteBridgeRepo {
  /** Write the (telegram_user_id <-> wallet) mapping. Re-link REPLACES; never mutates a schedule. */
  linkSite(userId: number, wallet: string): Promise<void>;
  userForWallet(wallet: string): Promise<number | null>;
  /** PHASE 8: the reverse lookup — the wallet a Telegram user proved they own. Read-only. */
  walletForUser(userId: number): Promise<string | null>;
  /** PHASE 8: the user's custody mode, so the Mini App can say which half they are in. */
  traderMode(userId: number): Promise<'wallet' | 'key'>;
  listSchedules(userId: number): Promise<readonly Schedule[]>;
  getCaps(userId: number, mint: Mint): Promise<Caps | null>;
  usdSpent24h(userId: number, mint: Mint, sinceMs: number): Promise<number>;
  usdSpentLifetime(userId: number, mint: Mint): Promise<number>;
}

/**
 * PHASE 9 — the write surface, supplied only when the site is allowed to change things.
 *
 * `repo` here is the panel's OWN repo interface, not a bridge-shaped subset of it, because the
 * functions it is handed to are the panel's own. A narrower type would mean a second definition of
 * what a schedule write needs, which is the thing this phase exists not to have.
 */
export interface SiteBridgeWrite extends ApplyIntentOptions {
  readonly repo: PanelRepo;
  /** The allowlist, re-read per request. Membership and custody mode are action-time facts. */
  readonly access: AutotraderAccessRepo;
}

export interface SiteBridgeDeps {
  readonly repo: SiteBridgeRepo;
  readonly codes: LinkCodeStore;
  readonly nonces: NonceStore;
  readonly secret: string;
  readonly log: Logger;
  readonly now?: () => number;
  /**
   * PHASE 8. The bot token, used ONLY to verify a Mini App's `initData` HMAC — never sent
   * anywhere, never logged, never returned. Absent = the Mini App identity route is not mounted at
   * all, which is the right failure: a route that cannot verify identity must not exist rather
   * than fall back to trusting the caller.
   */
  readonly botToken?: string | undefined;
  /**
   * PHASE 9. Absent = the six mutation routes are NOT MOUNTED and the bridge is read-only, the same
   * way an absent bot token means the Mini App identity route does not exist. A surface that cannot
   * be gated properly should be missing, not degraded.
   */
  readonly write?: SiteBridgeWrite | undefined;
}

const DAY_MS = 86_400_000;

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/** Constant-time shared-secret check. Never logged, never echoed. */
function secretOk(got: string | string[] | undefined, secret: string): boolean {
  const provided = typeof got === 'string' ? got : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  log: Logger,
  cb: (body: Record<string, unknown>) => void | Promise<void>,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c: Buffer) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { ok: false, error: 'body too large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid json' });
      return;
    }
    Promise.resolve(cb(body)).catch((err: unknown) => {
      // Never log the body or headers — they carry the secret + the signature. Message only.
      log.error({ err: err instanceof Error ? err.message : 'error' }, 'site-bridge: handler error');
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
    });
  });
  req.on('error', () => {
    if (!aborted && !res.headersSent) sendJson(res, 400, { ok: false, error: 'read error' });
  });
}

async function scheduleDto(repo: SiteBridgeRepo, s: Schedule, now: () => number): Promise<unknown> {
  const [caps, spentTodayUsd, spentLifetimeUsd] = await Promise.all([
    repo.getCaps(s.userId, s.mint),
    repo.usdSpent24h(s.userId, s.mint, now() - DAY_MS),
    repo.usdSpentLifetime(s.userId, s.mint),
  ]);
  return {
    id: s.id,
    mint: s.mint,
    side: s.side,
    amountKind: s.amountKind,
    amountRaw: s.amountRaw.toString(), // bigint -> string for JSON
    intervalMinutes: s.intervalMinutes,
    slippageBps: s.slippageBps,
    state: s.state,
    haltReason: s.haltReason,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt,
    caps: caps ? { perExecUsd: caps.maxPerExecUsd, perDayUsd: caps.maxPerDayUsd, lifetimeUsd: caps.maxLifetimeUsd } : null,
    spentTodayUsd,
    spentLifetimeUsd, // the lifetime spend-so-far from migration 017
  };
}

export function createSiteBridgeRoute(deps: SiteBridgeDeps): RouteHandler {
  const now = deps.now ?? Date.now;

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (!path.startsWith('/site/')) return false; // not ours — let other handlers try

    // Shared-secret gate FIRST. Only the site server may reach this surface.
    if (!secretOk(req.headers['x-site-bridge-secret'], deps.secret)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }

    // Mint a read challenge. The bot dates it; the client never dates its own proof.
    if (req.method === 'GET' && path === '/site/challenge') {
      const { nonce, expiresAt } = deps.nonces.issue();
      sendJson(res, 200, { ok: true, nonce, message: challengeMessage(nonce), expiresAt });
      return true;
    }

    // Establish the (telegram_user <-> wallet) link. Verify the signature FIRST so a bad signature
    // never burns the code; consume the code only once ownership is proven.
    if (req.method === 'POST' && path === '/site/link') {
      readJsonBody(req, res, deps.log, async (body) => {
        const wallet = body.wallet;
        const code = body.code;
        const signature = body.signature;
        if (typeof wallet !== 'string' || typeof code !== 'string' || typeof signature !== 'string') {
          sendJson(res, 400, { ok: false, error: 'wallet, code and signature are required' });
          return;
        }
        if (!verifyWalletSignature(wallet, linkMessage(wallet, code), signature)) {
          sendJson(res, 401, { ok: false, error: 'signature does not prove this wallet' });
          return;
        }
        const userId = deps.codes.consume(code);
        if (userId === null) {
          sendJson(res, 400, { ok: false, error: 'invalid or expired code' });
          return;
        }
        await deps.repo.linkSite(userId, wallet);
        sendJson(res, 200, { ok: true });
      });
      return true;
    }

    // Read the wallet's linked schedules. Verify signature, then CONSUME the nonce (single-use —
    // a replay finds it gone; a stale one is expired). Then map wallet -> user and read-only fetch.
    if (req.method === 'POST' && path === '/site/schedules') {
      readJsonBody(req, res, deps.log, async (body) => {
        const wallet = body.wallet;
        const nonce = body.nonce;
        const signature = body.signature;
        if (typeof wallet !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
          sendJson(res, 400, { ok: false, error: 'wallet, nonce and signature are required' });
          return;
        }
        if (!verifyWalletSignature(wallet, challengeMessage(nonce), signature)) {
          sendJson(res, 401, { ok: false, error: 'signature does not prove this wallet' });
          return;
        }
        if (!deps.nonces.consume(nonce)) {
          sendJson(res, 401, { ok: false, error: 'nonce is stale or already used' });
          return;
        }
        const userId = await deps.repo.userForWallet(wallet);
        if (userId === null) {
          // Proven wallet, but not linked to any Telegram user — the site shows only on-chain orders.
          sendJson(res, 200, { ok: true, linked: false, schedules: [] });
          return;
        }
        // Per-user isolation is listSchedules(userId)'s existing guarantee: only THIS user's rows.
        const schedules = await deps.repo.listSchedules(userId);
        const dto = await Promise.all(schedules.map((s) => scheduleDto(deps.repo, s, now)));
        sendJson(res, 200, { ok: true, linked: true, schedules: dto });
      });
      return true;
    }

    /**
     * PHASE 8 — the Mini App asks "who am I, and which wallet is mine?".
     *
     * The ONLY thing this returns is an ADDRESS the user already proved they own (Phase 6) plus
     * their custody mode. No key, no signature, no schedule mutation, no ability to act. The Mini
     * App uses the address to read that wallet's open Jupiter orders — a public, on-chain read it
     * could perform for any address it happened to know; the bridge's job is only to say WHICH
     * address belongs to this Telegram user, which is the one part the browser cannot establish
     * for itself.
     *
     * Mounted only when a bot token is available to check the signature with. Identity that
     * cannot be verified is not degraded gracefully — the route simply is not there.
     */
    if (req.method === 'POST' && path === '/site/tma-wallet') {
      if (deps.botToken === undefined || deps.botToken.length === 0) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return true;
      }
      readJsonBody(req, res, deps.log, async (body) => {
        const initData = body.initData;
        if (typeof initData !== 'string') {
          sendJson(res, 400, { ok: false, error: 'initData is required' });
          return;
        }
        const verdict = verifyInitData(initData, deps.botToken as string, now());
        if (!verdict.ok || verdict.userId === undefined) {
          // The REASON goes to the log, never to the caller. "stale" vs "bad-signature" tells an
          // attacker which half of their forgery to work on; the operator debugging a real user
          // needs it, and the log is where they will be looking.
          deps.log.warn({ reason: verdict.reason }, 'site-bridge: rejected Mini App initData');
          sendJson(res, 401, { ok: false, error: 'could not verify this Mini App session' });
          return;
        }
        const [wallet, mode] = await Promise.all([
          deps.repo.walletForUser(verdict.userId),
          deps.repo.traderMode(verdict.userId),
        ]);
        sendJson(res, 200, { ok: true, linked: wallet !== null, wallet, mode });
      });
      return true;
    }

    /**
     * PHASE 9 — anything that would need the bot to take custody of key material. Refused by NAME,
     * with the one sentence that says where it does happen. A 404 would be true (there is no such
     * route) and useless: the person asking would go looking for the right spelling.
     */
    if (KEY_ONLY_PATHS.has(path)) {
      sendJson(res, 403, { ok: false, error: KEY_REFUSAL });
      return true;
    }

    // ── PHASE 9: the write surface ──────────────────────────────────────────────────────────────
    const write = deps.write;

    /**
     * Mint the nonce for a specific INTENT and hand back the exact text to sign.
     *
     * The client never composes the message. Both this route and the write below build it from a
     * parsed intent with {@link writeMessage}, so the string the user approves in their wallet and
     * the string the bot verifies are the same function of the same value — and a body that
     * changes between the two calls simply fails to verify.
     *
     * The nonce carries no memory of the intent, and does not need to: the signature is over the
     * intent, so a nonce minted for "pause 12" is useless for "pause 13" — that would require a
     * signature the user never produced.
     */
    if (req.method === 'POST' && path === '/site/action-challenge') {
      if (write === undefined) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return true;
      }
      readJsonBody(req, res, deps.log, (body) => {
        const action = SITE_WRITE_PATHS.get(`/site/${String(body.action ?? '')}`);
        if (action === undefined) {
          sendJson(res, 400, { ok: false, error: 'unknown action' });
          return;
        }
        const parsed = parseIntent(action, body);
        if ('error' in parsed) {
          sendJson(res, 400, { ok: false, error: parsed.error });
          return;
        }
        const { intent } = parsed;
        const { nonce, expiresAt } = deps.nonces.issue();
        sendJson(res, 200, {
          ok: true,
          nonce,
          message: writeMessage(intent.action, intent.scheduleId, intent.args, nonce),
          expiresAt,
        });
      });
      return true;
    }

    const writeAction = SITE_WRITE_PATHS.get(path);
    if (writeAction !== undefined && req.method === 'POST') {
      if (write === undefined) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return true;
      }
      readJsonBody(req, res, deps.log, async (body) => {
        const wallet = body.wallet;
        const nonce = body.nonce;
        const signature = body.signature;
        if (typeof wallet !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
          sendJson(res, 400, { ok: false, error: 'wallet, nonce and signature are required' });
          return;
        }
        const parsed = parseIntent(writeAction, body);
        if ('error' in parsed) {
          sendJson(res, 400, { ok: false, error: parsed.error });
          return;
        }
        const intent: SiteIntent = parsed.intent;

        // The proof must be over THIS action, rebuilt here from this request's own body — never
        // over a message the caller supplied, and never over the read challenge (see writeMessage).
        if (!verifyWalletSignature(wallet, writeMessage(intent.action, intent.scheduleId, intent.args, nonce), signature)) {
          sendJson(res, 401, { ok: false, error: 'signature does not prove this wallet' });
          return;
        }
        // CONSUMED PER WRITE. Single-use in one shared store, so a nonce can back exactly one
        // request of any kind: a read cannot lend its nonce to a write, and no two writes share one.
        if (!deps.nonces.consume(nonce)) {
          sendJson(res, 401, { ok: false, error: 'nonce is stale or already used' });
          return;
        }

        // RE-RESOLVED AT ACTION TIME. The acting user is derived from the wallet that just proved
        // itself — never from the request body, which would be a caller naming whose account to
        // edit. A wallet unlinked since the nonce was minted acts as nobody.
        const userId = await deps.repo.userForWallet(wallet);
        if (userId === null) {
          sendJson(res, NOT_LINKED.status, { ok: false, error: NOT_LINKED.error });
          return;
        }
        const gate = await authorizeWrite(write.access, userId);
        if (!('ok' in gate)) {
          sendJson(res, gate.status, { ok: false, error: gate.error });
          return;
        }

        // The panel's own command layer, through a repo that stamps source=site on every audit row
        // it writes. Ownership of the named schedule is checked inside it — a write naming another
        // user's schedule fails there, in the panel's words, not in a copy of them here.
        const result = await applyIntent(withAuditSource(write.repo, 'site'), userId, intent, write);

        // A guard refusal is a 400 carrying the panel's message VERBATIM. The site is not given a
        // softer or a different sentence than the one Telegram shows for the same refusal.
        sendJson(res, result.ok ? 200 : 400, result.ok
          ? { ok: true, message: result.message }
          : { ok: false, error: result.message });
      });
      return true;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
    return true;
  };
}
