import type { Bot, Context } from 'grammy';

import type { Logger } from '../ops/logger.js';
import { AutotraderAccess, isOwner, type AutotraderAccessRepo } from '../trade/access.js';
import type { ExecutionRecord } from '../trade/scheduler.js';

/**
 * /resolve <executionId> confirmed|failed — the ONLY exit from an UNKNOWN autotrader outcome.
 *
 * When a swap's outcome cannot be determined, the executor halts the schedule and never auto-
 * resumes from that ambiguity (a blind guess is a double-buy or a phantom loss). A human checks
 * the chain and states the verdict here. Same silence discipline as the rest of the autotrader
 * (access.ts): a non-member, a non-owner, or a DM-less context gets NO reply — a refusal is an
 * oracle that the autotrader exists.
 */

export interface ResolveDeps {
  readonly repo: AutotraderAccessRepo;
  readonly getExecution: (id: number) => Promise<ExecutionRecord | null>;
  readonly resolve: (id: number, verdict: 'confirmed' | 'failed') => Promise<{ ok: boolean; message: string }>;
  readonly ownerUserId?: number | undefined;
  readonly log: Logger;
}

export function registerResolveCommand(bot: Bot, deps: ResolveDeps): void {
  const access = new AutotraderAccess(deps.repo, deps.log);

  bot.command('resolve', async (ctx: Context) => {
    const userId = ctx.from?.id ?? 0;
    if (ctx.chat?.type !== 'private') return; // never in a group — silence
    const member = (await access.check(userId)).allowed;
    if (!member && !isOwner(deps.ownerUserId, userId)) return; // silence

    const parts = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    const id = Number(parts[0]);
    const verdict = parts[1];
    if (!Number.isInteger(id) || id <= 0 || (verdict !== 'confirmed' && verdict !== 'failed')) {
      await ctx.reply('Usage: /resolve <executionId> confirmed|failed');
      return;
    }

    const exec = await deps.getExecution(id);
    if (!exec) {
      await ctx.reply(`No execution ${id}.`);
      return;
    }
    // You may resolve only your OWN execution — unless you are the bot owner (admin).
    if (exec.userId !== userId && !isOwner(deps.ownerUserId, userId)) return; // silence — not theirs

    const r = await deps.resolve(id, verdict);
    await ctx.reply(r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`);
  });
}
