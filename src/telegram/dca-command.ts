import type { Bot, Context } from 'grammy';

import type { Logger } from '../ops/logger.js';
import { AutotraderAccess, type AutotraderAccessRepo } from '../trade/access.js';

/**
 * PHASE 8 — `/dca`, the front door to the Mini App.
 *
 * WHAT THE BOT DOES ON THIS PATH, IN FULL: it opens a webview. That is the entire server-side
 * involvement in a wallet-mode DCA. It does not serve the app (the website does, over its own
 * TLS), does not proxy Jupiter, does not see the transaction, does not hold a key, and cannot
 * sign. The Mini App talks to the user's wallet and to Jupiter directly; the only thing it ever
 * asks this bot is "which wallet did this Telegram user prove they own", which is a read.
 *
 * If a future change makes the bot do more than open a webview on this path, that is the moment to
 * stop and re-read INVARIANT 14 — the temptation named in the phase brief is precisely a
 * server-side signer added "to make Telegram smoother", and it would be send-key custody wearing
 * wallet mode's label.
 *
 * A `web_app` button is used rather than a plain URL so the app opens INSIDE Telegram, which is
 * what makes `initData` available and therefore what lets the read bridge know who is asking.
 */

export interface DcaCommandDeps {
  readonly repo: AutotraderAccessRepo;
  readonly log: Logger;
  /** The site's /tma route. Absent = no button; the command says so rather than failing. */
  readonly miniAppUrl?: string | undefined;
  /** Where to send someone with no Mini App configured. Cosmetic. */
  readonly siteUrl?: string | undefined;
}

export function registerDcaCommand(bot: Bot, deps: DcaCommandDeps): void {
  const access = new AutotraderAccess(deps.repo, deps.log);

  bot.command('dca', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    // DM-only and member-gated, with SILENCE for a non-member — the same discipline as every other
    // autotrader surface (INVARIANT 14). A refusal here would confirm the autotrader exists.
    if (ctx.chat?.type !== 'private') return;
    if (!(await access.check(userId)).allowed) return;

    if (!deps.miniAppUrl) {
      await ctx
        .reply(
          [
            '🌾 DCA runs from your own wallet.',
            '',
            deps.siteUrl
              ? `Open ${deps.siteUrl} and go to the DCA tab — connect your wallet there and`
              : 'Open the $RICE site and go to the DCA tab — connect your wallet there and',
            'set up a recurring buy. It runs on Jupiter, on-chain, from your wallet.',
            '',
            '/linksite links that wallet to me so I can show you your orders here.',
          ].join('\n'),
        )
        .catch(() => undefined);
      return;
    }

    const mode = await access.mode(userId);
    await ctx
      .reply(
        [
          '🌾 Your DCA — in your wallet, on-chain.',
          '',
          mode === 'wallet'
            ? 'I hold no key for you. Everything below is signed by your own wallet;'
            : "You're in KEY mode, so I also run a schedule for you. This is separate —",
          mode === 'wallet'
            ? 'I only show you what your orders are doing.'
            : 'orders you create here belong to your wallet, not to my scheduler.',
        ].join('\n'),
        {
          reply_markup: {
            inline_keyboard: [[{ text: '🌾 Open DCA', web_app: { url: deps.miniAppUrl } }]],
          },
        },
      )
      .catch(() => undefined);
  });
}
