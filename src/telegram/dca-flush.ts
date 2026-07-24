import type { Logger } from 'pino';

import type { ChatId, Mint } from '../core/types.js';
import type { Repo } from '../db/index.js';
import { renderDcaCard, aggregateByWallet } from '../render/dca-card.js';
import type { Card } from '../render/card.js';
import { DEFAULT_LINKS } from '../core/links.js';
import { lastClosedWindowStart, windowEnd, windowStartFor, dcaClaimKey, normalizeWindowMinutes, MIN_DCA_WINDOW_MINUTES, MAX_DCA_WINDOW_MINUTES } from './dca-window.js';
import type { DeliveryQueue } from './queue.js';
import type { MediaKind } from '../core/types.js';

/**
 * PHASE 16 — the DCA flush loop. Turns the per-window aggregate into ONE card per (chat, mint, window).
 *
 * It reads, it never buffers: at each tick it queries the DCA-attributed buys for each CLOSED window
 * from the buys table (restart-safe by construction) and groups by wallet. The dca_cursor per
 * (chat, mint) is what stops a window being flushed twice or skipped. Idempotency across a restart
 * mid-flush is the DeliveryQueue's claim on (dcaClaimKey, chat_id) — the same claimSend as every card.
 *
 * EMPTY WINDOW POSTS NOTHING. dca_display='off' posts nothing either, but still advances the cursor
 * so a later switch to 'aggregate' does not dump a backlog.
 */

const TICK_MS = 60_000;
/** A hard bound on windows processed per (chat, mint) per tick, so a long gap cannot flood. */
const MAX_WINDOWS_PER_TICK = 48;

/** Resolves DCA art for a chat, or null for a text-only card. Phase 16(1) passes text-only; the
 *  dca/ media pool (Phase 16(2)) supplies the real one. An empty dca/ MUST fall back to text-only —
 *  never to tier art, which would make a DCA card look like an organic buy. */
export type DcaMediaPick = (mint: Mint, chatId: ChatId) => Promise<{ fileId: string; kind: MediaKind } | null>;

export interface DcaFlushDeps {
  readonly repo: Repo;
  readonly queue: DeliveryQueue;
  readonly log: Logger;
  /** Rendered as "Creator Fee" on the card instead of an address. */
  readonly creatorFeeWallet?: string | undefined;
  readonly pickMedia?: DcaMediaPick;
  readonly now?: () => number;
}

export class DcaFlusher {
  readonly #d: DcaFlushDeps;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: DcaFlushDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick().catch((e) => this.#d.log.error({ err: msg(e) }, 'dca flush tick failed')), TICK_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** One pass. Returns the number of DCA cards enqueued (for tests and the boot log). */
  async tick(): Promise<number> {
    let queued = 0;
    for (const mint of await this.#d.repo.activeMints()) {
      for (const ct of await this.#d.repo.chatTokensForMint(mint)) {
        if (!ct.enabled) continue;
        try {
          queued += await this.#flushChat(ct.chatId, mint, ct.dcaWindowMinutes, ct.dcaDisplay, ct.links);
        } catch (err) {
          this.#d.log.error({ chatId: ct.chatId, mint, err: msg(err) }, 'dca flush: chat failed — others continue');
        }
      }
    }
    return queued;
  }

  async #flushChat(
    chatId: ChatId, mint: Mint, windowMinutes: number, display: 'aggregate' | 'off', links: Readonly<Record<string, string>> | null,
  ): Promise<number> {
    const nowMs = this.#now();
    const lastClosed = lastClosedWindowStart(nowMs, windowMinutes);
    if (lastClosed < 0) return 0;

    const cursor = await this.#d.repo.getDcaCursor(chatId, mint);
    // First run: process only the most recent closed window (never dump all of history). Otherwise
    // process each closed window we have not flushed yet, bounded.
    let ws = cursor === null ? lastClosed : cursor + windowMinutes * 60_000;
    let processed = 0;
    let enqueued = 0;

    while (ws <= lastClosed && processed < MAX_WINDOWS_PER_TICK) {
      // 'off' posts nothing, but the loop still advances the cursor past this window below.
      if (display === 'aggregate') {
        const rows = await this.#d.repo.dcaBuysInWindow(mint, ws, windowEnd(ws, windowMinutes));
        const lines = aggregateByWallet(rows);
        if (lines.length > 0) {
          await this.#enqueueCard(chatId, mint, ws, lines, links);
          enqueued++;
        }
        // else: EMPTY WINDOW POSTS NOTHING.
      }
      ws += windowMinutes * 60_000;
      processed++;
    }

    // Advance the cursor to the last window we considered — so nothing is re-flushed, and a long gap
    // does not re-scan the same range next tick.
    const newCursor = processed > 0 ? ws - windowMinutes * 60_000 : lastClosed;
    if (cursor === null || newCursor > cursor) {
      await this.#d.repo.setDcaCursor(chatId, mint, newCursor);
    }
    return enqueued;
  }

  async #enqueueCard(
    chatId: ChatId, mint: Mint, windowStart: number,
    lines: readonly { wallet: string; tokensRaw: bigint }[], links: Readonly<Record<string, string>> | null,
  ): Promise<void> {
    const token = await this.#d.repo.getToken(mint);
    const decimals = token?.decimals ?? 6;
    const dca = renderDcaCard({
      mint,
      decimals,
      lines,
      creatorFeeWallet: this.#d.creatorFeeWallet,
      links: links ?? DEFAULT_LINKS,
    });
    // renderDcaCard returns text/entities/keyboard; the queue wants a full Card.
    const card: Card = { text: dca.text, entities: dca.entities, keyboard: dca.keyboard, ladderCount: 0, ladderTruncated: false };

    // The claim key is (chat_id, window_start), NOT a signature — one card, many signatures. The
    // queue's claimSend(key, chat) makes a restart mid-flush safe: the second flush loses the claim.
    const key = dcaClaimKey(mint, windowStart);
    this.#d.queue.enqueue({
      signature: key as never,
      chatId,
      enqueuedAt: this.#now(),
      build: async () => {
        // An empty dca/ falls back to TEXT-ONLY — never tier art (that would look organic).
        const media = this.#d.pickMedia ? await this.#d.pickMedia(mint, chatId).catch(() => null) : null;
        return { chatId, card, fileId: media?.fileId ?? null, kind: media?.kind ?? null };
      },
    });
    this.#d.log.info({ chatId, mint, windowStart, wallets: lines.length }, 'dca aggregate card enqueued');
  }
}

/** Window boundary a buy at `atMs` belongs to — exported for the fanout suppression path. */
export { windowStartFor };

/**
 * /dcawindow <minutes> — OWNER-ONLY. The DCA aggregate window is the owner's program, not a
 * per-group knob, so a group admin cannot change it. Applies to every chat_token; takes effect on
 * the next window boundary with no restart (the window is a pure function of the clock).
 */
export function registerDcaWindowCommand(
  bot: import('grammy').Bot,
  deps: { repo: Pick<Repo, 'setDcaWindowMinutes'>; ownerUserId?: number | undefined; log: Logger },
): void {
  bot.command('dcawindow', async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    // Owner-only. A non-owner (including a group admin) gets no effect — this is not their setting.
    if (deps.ownerUserId === undefined || userId !== deps.ownerUserId) return;
    const raw = Number((ctx.match ?? '').toString().trim());
    const minutes = normalizeWindowMinutes(raw);
    if (minutes === null) {
      await ctx.reply(`Usage: /dcawindow <minutes>  (${MIN_DCA_WINDOW_MINUTES}–${MAX_DCA_WINDOW_MINUTES})`);
      return;
    }
    const changed = await deps.repo.setDcaWindowMinutes(minutes);
    await ctx.reply(`DCA window set to ${minutes} min across ${changed} watch(es). Takes effect on the next window boundary.`);
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
