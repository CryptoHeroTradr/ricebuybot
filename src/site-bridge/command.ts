import type { Bot, Context } from 'grammy';
import { AutotraderAccess, type AutotraderAccessRepo } from '../trade/access.js';
import type { Logger } from '../ops/logger.js';
import type { LinkCodeStore } from './store.js';

/**
 * /linksite — DM-only, autotrader-member-only. Mints a one-time code and SENDS it.
 *
 * The code is entered ON THE SITE, so this command NEVER awaits a typed reply: it does not touch
 * the shared input arbiter, and it must NOT grow a "type the code back to me" step. Such a step
 * would open a DM awaiting-input state that collides with /wallet import (INVARIANT 15's custody
 * flow) — only one awaiting state per user exists. This command only SENDS.
 */
export function registerLinkSiteCommand(
  bot: Bot,
  deps: { repo: AutotraderAccessRepo; codes: LinkCodeStore; log: Logger; siteUrl?: string },
): void {
  const access = new AutotraderAccess(deps.repo, deps.log);
  bot.command('linksite', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    if (ctx.chat?.type !== 'private') return; // DM-only, like the rest of the autotrader surface
    if (!(await access.check(userId)).allowed) return; // silence for non-members (INVARIANT 14)

    const code = deps.codes.issue(userId);
    const where = deps.siteUrl ? ` (${deps.siteUrl})` : '';
    await ctx
      .reply(
        `🔗 Link your wallet to the $RICE site${where}:\n\n` +
          `Code: <code>${code}</code>\n\n` +
          `Open the DCA tab, connect your wallet, enter this code and sign the message. ` +
          `It's single-use and expires in 10 minutes. I won't ask you to type anything back here.`,
        { parse_mode: 'HTML' },
      )
      .catch(() => undefined);
  });
}
