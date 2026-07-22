import { ConfigError, loadConfig, type Config } from './config/index.js';
import { SqliteRepo } from './db/index.js';
import { HeliusWebhookIngestor, HeliusWsIngestor, type Ingestor } from './ingest/index.js';
import { HeliusRpc, Pricer, SolUsdFeed, TokenMetaCache } from './pricing/index.js';
import { Backfiller, BinanceHistoricalSolUsd, HeliusHistory, makeSwapApplier } from './positions/index.js';
import { InFlight, Shutdown, createLogger, scrub, startHealthServer, type Logger } from './ops/index.js';
import { FsMediaPool, HttpManifestSource, LocalFsSource } from './media/index.js';
import { DeliveryQueue, DryRunSender, TelegramSender, fanOut, registerCommands, type Sender } from './telegram/index.js';
import { Keystore } from './trade/keystore.js';
import { registerTradeCommands } from './telegram/trade-commands.js';
import { bootNotices, envUnlock } from './trade/unlock.js';
import { registerCuration } from './telegram/curate/index.js';
import { setPlanWhitelist } from './telegram/plan-gate.js';
import { BurstDetector, DailyCap, digestText } from './telegram/digest.js';
import { WalletValue } from './pricing/wallet-value.js';
import { catchUp, type CatchupRpc } from './ingest/catchup.js';
import { Watchdog } from './ops/watchdog.js';
import { toFloat, rawAmount } from './core/money.js';
import { quoteAssetFor } from './pricing/quote.js';
import { DEFAULT_TIER_POLICY, TIERS, pickTier, renderHeadline } from './core/tiers.js';
import type { Mint, Wallet } from './core/types.js';

/** How long we wait for in-flight Telegram sends before giving up and exiting. */
const DRAIN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  // Config first, and on its own, so a bad env produces a clean report rather
  // than a stack trace from something downstream that was handed a bad value.
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n\nSee .env.example for the full list.\n\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const log: Logger = createLogger(cfg.LOG_LEVEL);
  const startedAtMs = Date.now();

  const inFlight = new InFlight();
  const shutdown = new Shutdown();

  log.info(
    {
      node: process.version,
      dryRun: cfg.DRY_RUN,
      mediaSource: cfg.MEDIA_SOURCE,
      defaultMint: cfg.DEFAULT_MINT,
      backfillPositions: cfg.BACKFILL_POSITIONS,
    },
    'ricebuybot starting',
  );

  if (cfg.DRY_RUN) log.warn('DRY_RUN=true — rendering to stdout, sending nothing');

  const repo = new SqliteRepo(cfg.DB_PATH, log);
  await repo.init();
  shutdown.register('repo', () => repo.close());

  // INVARIANT 9. Must run BEFORE any ingestion can claim a send. A row left in
  // 'claimed' by a crash is not knowably delivered, so we tombstone it and lose
  // it on purpose — a duplicate post is strictly worse than a missed one.
  await repo.sweepOrphanedClaims();

  // Seed DEFAULT_MINT so decimals/supply are known before the first buy lands.
  // Placeholder metadata; Phase 2 refreshes it from getTokenSupply on a 5m TTL.
  repo.seedToken({
    mint: cfg.DEFAULT_MINT,
    symbol: null,
    name: null,
    decimals: 6,
    supplyRaw: 0n,
    fetchedAtMs: 0, // fetchedAtMs=0 => already stale => refreshed on first use
  });

  // Drains in-flight sends. Registered BEFORE the ingestor so that, on the
  // reverse unwind, the ingestor stops FIRST and nothing new can arrive while we
  // are waiting. Get this order wrong and the drain races the socket forever.
  shutdown.register('drain-sends', async () => {
    const pending = inFlight.count;
    if (pending > 0) log.info({ pending }, 'draining in-flight sends');
    const drained = await inFlight.drain(DRAIN_TIMEOUT_MS);
    if (!drained) log.warn({ pending: inFlight.count }, 'drain timed out; exiting with sends still in flight');
  });

  // --- pricing ----------------------------------------------------------------
  const feed = new SolUsdFeed({ log });
  await feed.start(); // REST bootstrap, so solUsd() is never null after this line
  shutdown.register('pricing', () => feed.stop());

  // --- telegram + media (Phases 6 & 7) ----------------------------------------
  //
  // The uploader IS the TelegramSender: minting a file_id means uploading bytes to the
  // vault, which only the Bot API can do. Under DRY_RUN there is no bot and no uploader —
  // the pool still refreshes, diffs, rotates and picks; it simply cannot mint a file_id
  // for disk-seeded art, and nothing needs one because nothing is being sent.
  // PLAN_WHITELIST: chat ids that always get the paid feature set, no payment, no DB row.
  setPlanWhitelist(cfg.PLAN_WHITELIST);
  if (cfg.PLAN_WHITELIST.length > 0) {
    log.info({ chats: cfg.PLAN_WHITELIST.length }, 'plan whitelist loaded — these chats are always paid');
  }

  const telegram = cfg.DRY_RUN
    ? null
    : new TelegramSender(cfg.TELEGRAM_BOT_TOKEN, cfg.MEDIA_VAULT_CHAT_ID as number, log);

  const mediaPool = new FsMediaPool({
    repo,
    source:
      cfg.MEDIA_SOURCE === 'http'
        ? new HttpManifestSource(cfg.MEDIA_MANIFEST_URL as string)
        : new LocalFsSource(cfg.MEDIA_ROOT),
    ...(telegram ? { uploader: telegram } : {}),
    log,
    mints: () => repo.activeMints(),
  });
  await mediaPool.start(); // first refresh is awaited; the 60s poll and warm-up are not
  shutdown.register('media', () => mediaPool.stop());

  // An operator who has just curated art should not have to wait out the poll.
  process.on('SIGHUP', () => void mediaPool.onSighup());

  const rpc = new HeliusRpc(cfg.HELIUS_RPC_URL, log);
  const tokenMeta = new TokenMetaCache(rpc, repo, log);
  const pricer = new Pricer({
    feed,
    tokens: tokenMeta,
    log,
    stableUsd: cfg.STABLE_USD,
    whaleBasis: cfg.WHALE_BASIS,
  });

  // --- ingestion --------------------------------------------------------------
  const ingestor: Ingestor =
    cfg.INGEST_MODE === 'webhook'
      ? new HeliusWebhookIngestor(cfg.WEBHOOK_SECRET as string, { log, repo, solUsd: () => feed.solUsd() })
      : new HeliusWsIngestor(cfg.HELIUS_WS_URL, { log, repo, solUsd: () => feed.solUsd() });

  // The webhook adapter mounts itself on the health port rather than opening a
  // second listener. Bound to 127.0.0.1 — put a reverse proxy in front of it.
  const routes =
    ingestor instanceof HeliusWebhookIngestor ? [ingestor.handle.bind(ingestor)] : [];

  // --- delivery ----------------------------------------------------------------
  //
  // DRY_RUN prints the card and everything you need to judge it — the dollar figures the
  // tier was chosen from, the EARNED tier, the tier the art actually came from, the media
  // sha256 — and sends nothing (INVARIANT 7).
  let lastDescribed = { usdIn: 0, holdingsUsd: null as number | null, earnedTier: '-', usedTier: null as string | null, sha256: null as string | null };
  const sender: Sender = telegram ?? new DryRunSender(log, () => lastDescribed);

  const queue = new DeliveryQueue({ repo, sender, log });
  shutdown.register('queue', () => queue.stop());

  // Phase 9: /health reports LOCAL state only. It never calls Helius or Telegram — a health
  // check a third party can make fail is a health check that restarts you for their outage.
  let lastBuyAtMs: number | null = null;
  /** False until grammY's long-poll actually starts. DRY_RUN has no bot, so it stays false. */
  let telegramPolling = false;

  const health = await startHealthServer(cfg.HTTP_PORT, log, startedAtMs, routes, async () => {
    const mints = await repo.activeMints();
    let items = 0;
    let uploaded = 0;
    for (const mint of mints) {
      const h = await mediaPool.health(mint);
      items += h.total;
      uploaded += h.uploaded;
    }
    return {
      // ok:true used to mean "the process is up". It now also means "the bot can actually talk
      // to Telegram", because a bot that cannot is useless and was reporting itself healthy.
      telegramPolling,
      wsConnected: ingestor.connected,
      activeMints: mints.length,
      solUsd: feed.solUsd(),
      lastBuyAgeSec: lastBuyAtMs === null ? null : Math.floor((Date.now() - lastBuyAtMs) / 1000),
      queueDepth: queue.depth,
      deliveredToday: await repo.deliveredToday(),
      mediaItems: items,
      mediaUploaded: uploaded,
      mediaPending: items - uploaded,
    };
  });
  shutdown.register('health', () => health.close());

  // --- cost basis + reconciliation --------------------------------------------
  const backfiller = new Backfiller({
    repo,
    history: new HeliusHistory(cfg.HELIUS_RPC_URL, log),
    solHistory: new BinanceHistoricalSolUsd(log),
    log,
    stableUsd: cfg.STABLE_USD,
  });

  // ONE application path for a priced swap, whatever route it arrived by — live
  // off the ingestor, or out of the hold queue once the SOL feed recovered. Two
  // arrival paths, one interpretation; there is no second place to forget a case.
  const applier = makeSwapApplier({ repo, log, backfiller, backfill: cfg.BACKFILL_POSITIONS });

  // Phase 9: flood control. A launch pump is 200 buys a minute; a card each would
  // rate-limit the bot into oblivion, bury the chat, and get the tail dropped as stale
  // anyway. Above the threshold we post one digest per window instead. Nothing is lost —
  // every buy is still ingested, priced and folded into cost basis. Only POSTING aggregates.
  const burst = new BurstDetector();
  const dailyCap = new DailyCap(cfg.DAILY_SEND_CAP ?? null);

  // The whale test is the buyer's SOL+USDC wallet value — one RPC read per posted buy, cached per
  // wallet. See pricing/wallet-value.ts.
  const walletValue = new WalletValue({
    rpc: new HeliusRpc(cfg.HELIUS_RPC_URL, log),
    solUsd: () => feed.solUsd(),
    stableUsd: cfg.STABLE_USD,
    log,
  });

  const digestTimer = setInterval(() => {
    void (async () => {
      for (const mint of await repo.activeMints()) {
        if (!burst.bursting(mint)) continue;
        const d = burst.drain(mint);
        if (!d) continue;

        const token = await repo.getToken(mint);
        const symbol = token?.symbol ?? mint.slice(0, 4);

        for (const ct of await repo.chatTokensForMint(mint)) {
          if (!ct.enabled || !dailyCap.allow(ct.chatId)) continue;

          // The digest's tier is the HIGHEST in the window, not the tier of the largest buy:
          // a whale making a $20 add inside a burst is still a whale, because the tier is
          // holdings-based. Taking it from the biggest buy would re-introduce the ladder.
          const picked = await mediaPool.pick(mint, ct.chatId, d.topUsd, 0);
          const headline = renderHeadline(
            ct.tierHeadlines[TIERS.findIndex((t) => t.name === d.tier)] ?? '',
            symbol,
          );

          const item = picked?.item ?? null;
          const fileId = item ? await mediaPool.fileIdFor(item) : ct.staticFileId;

          await sender
            .send({
              chatId: ct.chatId,
              card: {
                text: digestText(symbol, d, headline),
                entities: [],
                keyboard: [],
                ladderCount: 0,
                ladderTruncated: false,
              },
              fileId: ct.mediaMode === 'none' ? null : fileId,
              kind: ct.mediaMode === 'none' ? null : (item?.kind ?? ct.staticKind),
            })
            .catch((err: unknown) => log.warn({ err: (err as Error).message }, 'digest send failed'));
        }

        log.info({ mint, count: d.count, totalUsd: d.totalUsd, tier: d.tier }, 'digest posted (burst mode)');
      }
    })();
  }, 60_000);
  digestTimer.unref();
  shutdown.register('digest', () => clearInterval(digestTimer));

  ingestor.onBuy(async (e) => {
    const outcome = await pricer.price(e);
    await applier.onSwap(e, outcome);
    if (outcome.status !== 'priced') return;

    const { pricing, token } = outcome;
    const quoteAsset = quoteAssetFor(e.quoteMint);
    lastBuyAtMs = Date.now();

    // THE WHALE SIGNAL: the buyer's liquid SOL+USDC value, fetched from the chain. It is what
    // decides the whale tier — NOT their bag of this token (which was gameable via a thin trade).
    const whaleValueUsd = await walletValue.valueOf(e.buyer);

    // Is this mint bursting? Record it and, if so, DO NOT fan out — the digest timer will
    // summarise the window. The buy is already ingested and folded; only the card is held.
    const tier = pickTier(pricing.usdIn, whaleValueUsd, DEFAULT_TIER_POLICY);
    if (tier && burst.record(e.mint, { usdIn: pricing.usdIn, tier: tier.name })) {
      log.info(
        {
          sig: e.signature,
          mint: e.mint,
          usd: Number(pricing.usdIn.toFixed(2)),
          whaleValueUsd: Number(whaleValueUsd.toFixed(2)),
          earnedTier: tier.name,
          burst: true,
        },
        'buy (held for digest — mint is bursting)',
      );
      return;
    }

    await inFlight.track(() =>
      fanOut(
        e,
        {
          usdIn: pricing.usdIn,
          priceUsd: pricing.priceUsd,
          marketCapUsd: pricing.marketCapUsd,
          whaleValueUsd,
          quoteAmount: toFloat(rawAmount(e.quoteRaw, quoteAsset?.decimals ?? 9)),
          tokensOut: toFloat(rawAmount(e.tokensRaw, token.decimals)),
        },
        {
          repo,
          media: mediaPool,
          queue,
          log,
          onCard: (card) => {
            // THE one info-level line per buy. Everything a "why did that fire as a whale?"
            // question needs is here — earnedTier AND holdingsUsd — so it is answerable from
            // the logs alone, without re-deriving anything.
            log.info(
              {
                sig: e.signature,
                mint: e.mint,
                usd: Number(pricing.usdIn.toFixed(2)),
                whaleValueUsd: Number(whaleValueUsd.toFixed(2)),
                earnedTier: card.earnedTier,
                usedTier: card.usedTier,
                mediaSha: card.mediaSha,
                chatsPosted: card.chatsPosted,
              },
              'buy',
            );
          },
          position: async (mint, buyer) => {
            const p = await repo.getPosition(mint, buyer as Wallet);
            if (!p) return null;
            return {
              reconciled: p.reconciled,
              tokensRaw: p.tokensRaw,
              balanceBeforeRaw: e.balanceBeforeRaw ?? 0n,
              avgCostUsd: p.tokensRaw > 0n ? p.costUsd / toFloat(rawAmount(p.tokensRaw, token.decimals)) : 0,
              priceUsd: pricing.priceUsd,
              hasPriorHistory: p.firstSeen !== null,
            };
          },
        },
      ),
    );
  });

  // Sells feed cost basis ONLY. They are NEVER posted to Telegram.
  ingestor.onSell(async (e) => {
    await applier.onSwap(e, await pricer.price(e));
  });

  // When the SOL feed comes back, everything held while it was down gets applied.
  // Held SELLS land here too: dropping them would leave the ledger holding tokens
  // the wallet has already sold.
  const flushTimer = setInterval(() => {
    void pricer.flushHeld((e, outcome) => applier.onSwap(e, outcome));
  }, 5_000);
  flushTimer.unref();
  shutdown.register('flush-timer', () => clearInterval(flushTimer));

  // The subscription set is whatever the DB says is active. DEFAULT_MINT is
  // watched too, so a fresh install with no groups still shows signs of life.
  const mints = new Set([...(await repo.activeMints()), cfg.DEFAULT_MINT]);
  for (const mint of mints) await ingestor.subscribe(mint);

  // --- group configuration (Phase 8) -------------------------------------------
  //
  // Commands need a Bot, so they exist only when we actually have one. Under DRY_RUN there
  // is no bot and nothing to configure — which is correct: DRY_RUN is for watching cards,
  // not for onboarding groups.
  if (telegram) {
    registerCommands(telegram.bot, {
      repo,
      media: mediaPool,
      sender,
      log,
      ownerUserId: cfg.OWNER_USER_ID,
      chain: {
        supplyOf: async (mint) => {
          const meta = await tokenMeta.get(mint);
          return meta ? { amount: meta.supplyRaw.toString(), decimals: meta.decimals } : null;
        },
      },
      subscribe: (mint) => ingestor.subscribe(mint),
      unsubscribe: (mint) => ingestor.unsubscribe(mint),
      currentMints: () => ingestor.mints,
    });
    // Phase 8.5: DM meme curation. Registered BEFORE bot.start(), and only when there is a
    // real bot — DRY_RUN has nothing to curate into and nothing to send.
    registerCuration(telegram.bot, {
      repo,
      pool: mediaPool,
      log,
      mediaRoot: cfg.MEDIA_ROOT,
      botToken: cfg.TELEGRAM_BOT_TOKEN,
      ownerUserId: cfg.OWNER_USER_ID,
    });

    /**
     * Phase 12: the autotrader's key custody (INVARIANTS 14-18).
     *
     * OFF unless AUTOTRADER=true. Note what is registered here and what is not: wallets,
     * keys and the allowlist — and NO trading. A phase that both introduces key custody and
     * executes trades is a phase where you cannot tell which half broke.
     *
     * Every wallet starts LOCKED. That is not a state to be recovered from at boot; it is
     * the correct state after a restart, and the mitigation is telling people (`bootNotices`),
     * not weakening it.
     */
    if (cfg.AUTOTRADER) {
      const keystore = new Keystore({ dir: cfg.KEYSTORE_DIR });
      const unlockConfig = {
        ownerUserId: cfg.OWNER_USER_ID,
        ownerPassphrase: cfg.OWNER_KEYSTORE_PASSPHRASE,
      };

      // INVARIANT 15: zero every key on the way out. Registered FIRST so it runs even if
      // something below throws during boot.
      shutdown.register('keystore', () => {
        keystore.lockAll();
        return Promise.resolve();
      });

      registerTradeCommands(telegram.bot, {
        repo,
        keystore,
        rpc: {
          getBalance: (pubkey) => rpc.getBalance(pubkey),
          getOwnedTokenAccountsParsed: (owner) => rpc.getOwnedTokenAccountsParsed(owner),
        },
        log,
        unlockConfig,
        primaryMint: cfg.DEFAULT_MINT,
        primarySymbol: (await tokenMeta.get(cfg.DEFAULT_MINT as Mint))?.symbol ?? 'tokens',
        // Phase 13 owns schedules. Until then there is nothing to pause, and the hook is
        // here so that lock/remove/purge already call it when there is.
        pauseSchedules: async () => undefined,
      });

      const envUnlocked = envUnlock(keystore, unlockConfig, log);

      // Tell everyone whose wallet a restart just locked. Best-effort and non-fatal: a user
      // who has blocked the bot must not stop the bot from booting.
      void bootNotices(repo, keystore, envUnlocked).then(async (notices) => {
        for (const n of notices) {
          try {
            await telegram.bot.api.sendMessage(n.userId, n.text);
          } catch {
            log.warn({ userId: n.userId }, 'autotrader: could not deliver restart notice');
          }
        }
      });

      log.info({ keystores: cfg.KEYSTORE_DIR, envUnlocked: envUnlocked.length }, 'autotrader: key custody ready (no trading in phase 12)');
    }

    /**
     * A handler that throws must SAY SO.
     *
     * grammY's default behaviour is to log and move on — so a command that died mid-way left
     * the user staring at "Checking that token on-chain…" forever, with no error anywhere they
     * could see. A bot that goes quiet is indistinguishable from a bot that is broken, and the
     * user cannot tell you what went wrong because they were shown nothing.
     */
    telegram.bot.catch((err) => {
      const e = err.error;
      log.error(
        { chatId: err.ctx.chat?.id, update: err.ctx.update.update_id, err: e instanceof Error ? e.message : String(e) },
        'command handler threw',
      );
      void err.ctx
        .reply('Something went wrong on my end — that is a bug, not you. It has been logged.')
        .catch(() => {});
    });

    /**
     * TELEGRAM POLLING IS NOT OPTIONAL, AND ITS FAILURE MUST NOT BE SILENT.
     *
     * This used to be `void bot.start(...)` — fire and forget. If the long-poll failed to start
     * (a 409 because something else is polling the same token, a network error, a revoked
     * token), the promise rejected into the void: no log, no crash, and /health cheerfully
     * reporting ok:true while the bot ingested buys perfectly and could not receive or send a
     * single Telegram message. A bot that cannot talk to Telegram is not healthy, and pretending
     * otherwise is the worst kind of failure — the invisible kind.
     *
     * So: log when polling actually starts, and treat a failure to start as FATAL. Restart=always
     * turns it into a visible crash loop, which someone fixes.
     */
    telegram.bot.start({
      drop_pending_updates: true,
      onStart: (me) => {
        telegramPolling = true;
        log.info({ username: me.username, id: me.id }, 'telegram polling started');
      },
    }).catch((err: unknown) => {
      telegramPolling = false;
      log.fatal(
        { err: err instanceof Error ? err.message : String(err) },
        'telegram polling FAILED — the bot cannot receive commands or post cards. Exiting.',
      );
      process.exit(1);
    });

    shutdown.register('bot', () => telegram.bot.stop());
    log.info('telegram commands registered');
  }

  // --- gap recovery + watchdog (Phase 9) ---------------------------------------
  //
  // A reconnect means we were away, and being away means we missed buys. Helius does not
  // replay them, so we go and get them — through `ingestor.replay()`, which is the SAME
  // entry point the live socket uses, so they meet the same parser and the same filters.
  // The overlap with what we already posted is deliberate: claimSend drops it silently.
  const catchupRpc: CatchupRpc = {
    getSignaturesForAddress: (mint, limit) => rpc.getSignaturesForAddress(mint, limit),
    getTransaction: (sig) => rpc.getTransaction(sig),
  };

  let recovering = false;
  ingestor.onReconnect(() => {
    if (recovering) return; // a flapping socket must not stack recoveries on top of each other
    recovering = true;

    void (async () => {
      try {
        const slot = await rpc.getSlot();
        if (slot === null) return;

        for (const mint of ingestor.mints) {
          const last = await repo.getCursor(mint);
          if (last === null || slot <= last) continue;

          const { txs } = await catchUp({ rpc: catchupRpc, log }, mint, last, slot);
          for (const tx of txs) await ingestor.replay(tx);
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, 'gap recovery failed');
      } finally {
        recovering = false;
      }
    })();
  });

  const watchdog = new Watchdog({ connected: () => ingestor.connected, log });
  watchdog.start();
  shutdown.register('watchdog', () => watchdog.stop());

  await ingestor.start();
  // Registered AFTER the drain hook, so on teardown it stops FIRST: no new buys
  // can arrive while we are draining sends.
  shutdown.register('ingest', () => ingestor.stop());

  log.info({ mode: cfg.INGEST_MODE, mints: [...mints] }, 'ingestion started');

  // Phase 2: priceSource.start()  -> shutdown.register('pricing', ...)
  // Phase 3: media.refresh()
  // Phase 3: bot.start()          -> shutdown.register('telegram', ...)

  log.info({ port: cfg.HTTP_PORT }, 'ricebuybot ready');

  let exiting = false;
  const stop = (signal: NodeJS.Signals) => {
    if (exiting) {
      log.warn({ signal }, 'already shutting down; ignoring');
      return;
    }
    exiting = true;
    log.info({ signal }, 'shutting down');

    void (async () => {
      const timer = setTimeout(() => {
        log.error('shutdown exceeded hard deadline; forcing exit');
        process.exit(1);
      }, DRAIN_TIMEOUT_MS + 5_000);
      timer.unref();

      await shutdown.run((name, err) => log.error({ hook: name, err: describe(err) }, 'shutdown hook failed'));

      clearTimeout(timer);
      log.info({ uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000) }, 'bye');
      process.exit(0);
    })();
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  process.on('unhandledRejection', (reason) => {
    log.error({ err: describe(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err: describe(err) }, 'uncaught exception');
    process.exit(1);
  });
}

/** INVARIANT 5: never let a raw error message reach a log line unscrubbed. */
function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    const out: { message: string; stack?: string } = { message: scrub(err.message) };
    if (err.stack) out.stack = scrub(err.stack);
    return out;
  }
  return { message: scrub(String(err)) };
}

await main();
