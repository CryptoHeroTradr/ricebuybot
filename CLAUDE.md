# RiceBuybot

Self-hosted, multi-tenant Telegram buy bot for Solana SPL tokens. Flagship deployment is
$RICE (`2wQq3MrFFHPQnapMt1wnZ2vGkVZDv5ENDCrdLCqFpump`), but every group configures its own
mint, media pool, threshold, and emoji ladder.

Node 22, TypeScript (ESM, strict, NodeNext), pnpm. PM2 on the VPS. No telemetry, no Cloudflare.

---

## Invariants

These are load-bearing. Do not violate them, and do not "temporarily" work around them.

1. **Swap detection is DEX-agnostic balance-delta only. Never add a per-DEX instruction decoder.**
2. **Every outbound Telegram send is idempotent, keyed on (signature, chat_id). A restart must never double-post.**
3. **Telegram file_ids are bot-specific and non-portable. RiceBuybot uploads every media item itself, once, and caches the file_id keyed by content sha256.**
4. **RiceBuybot is the sole writer to the media pool and owns the tree.** Writes are confined to: creating files inside `_incoming/` and the four tier folders, and moving files between `_incoming/` → `tier/` → `_archive/`. Files are never unlinked and nothing is ever written outside `MEDIA_ROOT`. Every write is atomic (temp + rename) and regenerates the manifest. nginx and the websites are read-only consumers.
5. **Secrets only from env. No key, token, or wallet ever enters a log line or an error message.**
6. **All money is integers (lamports / raw token units). Floats only at the render boundary.**
7. **DRY_RUN=true renders to stdout and sends nothing.**
8. **Group config writes require verified Telegram admin status, re-checked at write time. Never cached.**
9. **An orphaned send claim is resolved by LOSING it. On boot, every row still in `state='claimed'` is swept to `'failed'` and NEVER resent. This is intentional, documented data loss. Do not "fix" it.**
10. **NEVER render a Position % from an unreconciled ledger. If `reconciled = 0`, omit the line entirely. Being publicly wrong about a whale's PnL is far worse than saying nothing.**
11. **`positions` is a DERIVED FOLD over the `swaps` log. Never mutate a position row. Every write appends a fact and recomputes.**
12. **ONE parser. `normalizeSwap` classifies every transaction, live and backfilled. Never write a second classifier — and never put a classification (`kind`) in an identity key.**
13. **A free receipt is not an unpriced purchase. Never price an unvaluable leg — ABSTAIN. `usd_value = 0` is the truth only when nothing was given up.**

### Autotrader (phases 12–16)

**Phase 12 is built: key custody only. There is no trading.** `src/trade/` holds the allowlist,
the per-user keystore, the unlock model and the signer; `autotrader_users` and
`autotrader_access_log` exist (migration 012); `/trader` and `/wallet` are live behind
`AUTOTRADER=true`. Nothing schedules, quotes, routes or sends a transaction — `Signer.sign()` is
reachable only from tests. **Phases 13–16 (schedules, quoting, execution, reporting) are NOT
built**, and invariants 16 and 17 below therefore describe a surface that does not exist yet.

Splitting it that way was the point: a phase that both introduces key custody and executes trades
is a phase where you cannot tell which half broke.

These were written down before the first line existed, because every one of them is cheap to
design in and expensive to retrofit, and because this is the only part of the bot that will ever
hold a key that can spend.

14. The autotrader serves the hand-entered autotrader_users allowlist ONLY. No plan tier, no /grant, no config flag widens it. Every user sees and controls their own wallet and schedules and nobody else's — not even the owner, who administers membership but never another person's keys.

15. A signing key never touches a log line, an error message, a Telegram message, or any table. Keystores are per-user and per-passphrase: one leak is one wallet, never all of them. There is no master key.

16. A swap of uncertain outcome is NEVER retried. Mark it UNKNOWN, halt that user's schedules, require human resolution. An RPC timeout is not a failed transaction — it may still confirm, and a blind retry is a double-buy with real money.

17. Every autotrader action is capped twice, PER USER: per-execution and per-rolling-24h. A bug that fires the loop 1000x must lose one person's daily cap, not everyone's wallet.

18. The signer REJECTS any transaction touching a mint other than SOL/WSOL and the schedule's configured mint, and rejects SetAuthority, Approve, and CloseAccount on foreign accounts. These wallets hold other tokens, LP positions, and NFTs; the bot's reach must be strictly narrower than the key's. This is a pre-sign assertion with allowedMints supplied by the caller — a guard that derives its own permission from the transaction is not a guard.

### Why each one exists

1. There are too many DEXes and they change too often. Balance-delta parsing works on pump.fun,
   PumpSwap, Raydium, Meteora, Orca and any Jupiter route — including ones that do not exist yet —
   with zero code change. A decoder is a permanent maintenance tax that buys nothing.
2. WebSocket reconnects replay. Restarts replay. Without an atomic claim on (signature, chat_id),
   a routine redeploy spams every group with buys they have already seen.
3. This is the constraint that shapes the whole media design. The meme bot's file_ids are worthless
   to us. RiceBuybot must hold the original bytes, upload each item exactly once, and cache what
   Telegram hands back. That is why the pool is a filesystem folder, not a Telegram-native handoff.
4. This invariant used to say the opposite — read-only, owned by a one-way sync job pulling from the
   meme bot. **That sync job does not exist and never will** (Phase 5a): the pool is curated in
   RiceBuybot's own DMs and seeded with `scripts/tier.ts`, so the bot IS the curator. A pool the bot
   may not write to cannot be curated by the bot.

   What survives the reversal is the *fence*, and it moved from convention to the filesystem.
   `MEDIA_ROOT` is shared with onegrainofrice and RiceDAO, so a stray write still corrupts three
   products — which is why the websites are not merely *asked* to be read-only, they are **denied
   write access**: the tree is owned `ricebuybot:www-data`, dirs `2750`, files `0640`. nginx (`www-data`)
   reads; `deploy` — the user running both Next apps — has no access at all and reaches the pool over
   HTTP like any other client. `_incoming/` and `_archive/` are `ricebuybot:ricebuybot`, unreadable
   even to nginx, and denied in the nginx config as well. Two locks on that door, because the nginx
   one is a text file someone will edit.

   **Nothing is ever unlinked.** A removal is a move into `_archive/`, which the manifest excludes and
   nginx denies. An admin who deletes the group's best meme from a DM by mistake is one `rice-tier`
   away from having it back; `rm` has no such affordance.

   The bot runs as its own `ricebuybot` system user under systemd — **not** as `deploy`, and not under
   `deploy`'s pm2. The media folder is the least of it: `deploy` runs two public-facing Next apps, so
   sharing that user would put the Telegram bot token and the Helius key one path traversal away from
   an attacker who could then post to every group we ever onboard.
5. The Helius key was public once already. Assume every log line will end up in a screenshot.
6. Float drift in token amounts silently misprices buys, which puts them in the wrong tier, which
   pulls the wrong meme. Integers all the way to `render/`.
7. The only safe way to test message formatting against live chain data.
8. Admin status changes. A cached "yes" is a privilege escalation waiting to happen.
9. A crash between `claimSend` and `markSent` leaves a row in `'claimed'` with no `message_id`. It is
   **not knowable** whether Telegram received that message — the Bot API call may have succeeded and
   the process died before recording it. There are exactly two options, and no third:
   resend (risking a duplicate) or drop (risking a miss). **We drop.** By the time the process is
   back the buy is stale anyway under the 120s staleness rule, and a duplicate post is strictly
   worse than a missed one — it makes the bot look broken to every member of the group, and it is
   the specific failure the entire `sends` ledger exists to prevent.

   This looks like a bug to anyone reading `sweepOrphanedClaims()` cold. It is not. It is the
   deliberate resolution of an unknowable state. **Do not turn the sweep into a retry.**

   One log line is emitted per orphan swept. If that line appears often, the bug is upstream — the
   process is crashing mid-send — and the fix belongs there, not here.
10. The ledger only knows the buys the bot happened to observe; `holdingsUsd` comes from the chain and
   is exact. For any wallet with prior history, **those two describe different quantities**, and a
   percentage computed across them is a confident public lie — wrong by orders of magnitude on exactly
   the whales you most want to get right. The check costs nothing: `balanceAfterRaw` arrives with every
   buy. See "Cost basis and reconciliation" below.

11. A position used to be a mutable row, and **two writers raced on it**: the live ingest path
   (read-modify-write in a transaction) and the backfiller, whose walk takes *seconds* and which ended
   by **overwriting** the row with whatever its walk had found. A live buy landing mid-walk was
   clobbered — its tokens and its cost silently vanished from the ledger.

   The fix is not a lock, and it is not "abort the write if the row moved" (that livelocks: a wallet
   that keeps buying would abort forever and never converge). The fix is to **stop writing state**.
   Every swap is appended to `swaps` as an immutable fact, and the position is recomputed by folding
   that log through `basis.ts`. Two writers cannot clobber each other because **neither of them holds
   any state to clobber**. A live buy landing mid-walk has already inserted its own row, so the walk's
   fold simply picks it up.

   This also makes the ledger *repairable*: a corrupted `positions` row is not lost data, it is a stale
   cache. Delete it and refold. `test/positions.test.ts` proves it with a negative control — the
   read-modify-write ending is reconstructed by hand and shown to lose the mid-walk buy, so the passing
   test above it cannot go quietly vacuous.

12. The backfill used to carry its OWN classifier (`classifyForWallet`), because `normalizeSwap`
   reported transfers as `null` and a backfill cannot see airdrops or outbound sends if the parser
   throws them away. So there were two classifiers reading the same bytes — and the `swaps` PK included
   `kind`.

   Put those together: if the live socket called a transaction a `buy` and the backfill called the same
   transaction a `transfer_in`, the two rows had **different keys**. `INSERT OR IGNORE` ignored nothing,
   and the wallet's tokens were counted **twice** — silently, in the ledger that decides what Position %
   we publish.

   Not-double-counting was therefore *contingent on two code paths agreeing about classification*. That
   is not a property to test for; it is one to **design out**. Both halves are now gone:

   - **`kind` is out of the key.** One transaction moves a wallet's balance of one mint in exactly one
     net direction, so `kind` is *derived from the sign of that delta* — descriptive, not identifying.
     With the key at `(signature, mint, wallet)` the second write collides with the first no matter what
     either side decided the transaction was.
   - **The second parser is deleted.** `normalizeSwap` emits `TransferEvent` as a first-class result, so
     one parser answers both questions. Helius history is now **discovery only** — it says *which*
     signatures touched the wallet; the raw transactions then go through the same `normalizeSwap` the
     live socket uses.

13. Since 4.6 an airdrop and an arb both arrive as `transfer_in` with `usd_value = 0`. They are nothing
   alike. An **airdrop** has no counter-leg: it really was free, and zero cost is *the truth*. An **arb**
   — the wallet acquired the mint by handing over some non-registry token — has a counter-leg we cannot
   price: the wallet **paid**, and zero cost is *a hole where a price should be*.

   Book the second at zero and you manufacture a cost basis of nothing. A wallet that bought 1M tokens
   for $100 and then arbed in 9M more renders **"Position +900%"** while being completely flat. The test
   in `test/positions.test.ts` asserts that exact string, because seeing the number once is the point.

   The fix is **not** to go and price the counterparty token. A USD price for an arbitrary SPL token is a
   guess wearing a decimal point, and dressing a guess up as a percentage is the failure mode, not the
   fix. We **abstain**: the swap is flagged `unpriced`, the position derives `basis_unpriced`, and the
   Position % goes dark. `holdingsUsd` still renders — it comes from the chain and is exact — and the
   whale tier still fires.

   `unpriced` is set **in the parser**, at classification time. That is the only place where every delta
   for the wallet is in one hand; downstream sees a row, not a transaction, and could not recompute it.

   The disagreement test in `test/positions.test.ts` is the one that matters: it forces the two paths to
   classify one real transaction differently and asserts it *still* collapses to one row. It fails
   against the old key. The plain double-count test passes against the old key too — because there, the
   two paths happened to agree. That is precisely the point.

---

## The send ledger

The `sends` table is the idempotency chokepoint. Its state machine is the whole of INVARIANT 2:

| Call | Effect | Re-claimable after? |
| --- | --- | --- |
| `claimSend` | `INSERT … ON CONFLICT DO NOTHING`. Returns true **iff this process now owns the send.** | — |
| `markSent` | `state='sent'`, records `message_id`. | No |
| `releaseSend` | **Retryable** failure (429 exhausted, network). **Deletes the row.** | **Yes** |
| `failSend` | **Permanent** failure (403, kicked, chat not found). Writes a **tombstone**. | No |
| boot sweep | `'claimed'` → `'failed'`, reason `orphaned`. See invariant 9. | No |

`claimSend` returning **false is the normal case** under a reconnect replay. Do nothing with it:
do not queue, do not retry, do not log an error.

The claim MUST stay a single atomic `INSERT`. A read-then-write ("have I sent this?") double-posts —
several callers all read "no" before any of them writes. `test/db.test.ts` proves this with a
negative control: the naive version is run through the same 8-thread barrier and is shown to
double-claim, so the passing test above it cannot go quietly vacuous.

---

## The four tiers

Canonical vocabulary. Use these names everywhere — folder names, DB values, log lines, commands, docs.
**Never say "tier 3" in user-facing copy. Say "Whale."**

| # | Name    | Folder     | Earned when                       | Headline           |
|---|---------|------------|-----------------------------------|--------------------|
| 1 | Regular | `regular/` | anything above `min_buy_usd` ($10)| 🍚 RICE Buy!        |
| 2 | Big     | `big/`     | **buy** ≥ $250                    | 🍚 BIG RICE Buy!    |
| 3 | Whale   | `whale/`   | buyer's **SOL+USDC wallet** ≥ $10,000 | 🐳 WHALE BUY!   |
| 4 | Massive | `massive/` | **buy** ≥ $1,000                  | 💥 MASSIVE BUY!     |

### It is a PRIORITY CHAIN, not a ladder. (Phase 6)

Evaluated top-down, **first match wins**:

```
1. massive   if usdIn       >= buy_floor_massive     ($1,000)
2. whale     if holdingsUsd >= whale_holdings_usd    ($10,000)   <- HOLDINGS
3. big       if usdIn       >= buy_floor_big         ($250)
4. regular   otherwise
```

Below `min_buy_usd` a buy is dropped at fan-out and never reaches here.

**Whale is the buyer's LIQUID WALLET VALUE — SOL + USDC — not their bag of this token.** (Changed
post-launch: the old "holds ≥ $X of the token" valued the bag at the buyer's own trade-implied
price, which a thin trade could fabricate. SOL and USDC are priced at real feeds and can't be
gamed that way.) It costs one RPC read of the buyer's balances per posted buy (`pricing/wallet-value.ts`),
cached per wallet; USDC lives in an account the buy doesn't touch, so unlike the old figure it is
not free in the transaction. `whale_basis` is now dormant — it governed the token bag before/after
the buy, which is no longer the signal.

The rest of this section describes the OLD token-holdings model; the chain shape (priority order,
massive-outranks-whale) is unchanged, only the quantity fed to the whale check.

**Whale was denominated in what the wallet HOLDS of the token, not what it just spent.** This is the whole
point, and it is why the old single ascending array of floors had to go: it could not express
it. A $20 buy from a wallet sitting on $50,000 of the token is the most interesting event the
bot can post — a big bag quietly accumulating — and the ladder called it "Regular" and pulled
a regular meme. Buy size alone never makes a whale: $340 from a $600 holder is **Big**.

**Massive outranks Whale, deliberately.** A $12,000 buy qualifies as both and posts as MASSIVE,
because the event is the *buy*. **Whale outranks Big**, or the tier named for holding a bag
would never fire for anyone who also bought a decent size.

Thresholds are per-chat (`buy_floor_big`, `buy_floor_massive`, `whale_holdings_usd`,
`min_buy_usd`). The names and the count (always four) are **fixed** — a schema constant, not
config. See `src/core/tiers.ts`, the single source of truth. `WHALE_BASIS` decides whether
holdings are measured before or after the buy itself (default `post`).

### Art is decoration; the tier is a fact

`pick()` returns **`earnedTier` and `usedTier` separately**. An empty `whale/` folder makes a
whale buy borrow a `big/` meme — and the card still says **🐳 WHALE BUY!**. The fallback walks
DOWN the folders first (a whale showing a big meme reads as a stocking problem), then UP as a
last resort (a $12 buy showing a hand-curated banger spends the pool's best art on the most
ordinary event there is). With no art at all the post STILL GOES OUT: the chat's
`static_file_id`, then a text-only card. **Never fail a post because a folder is empty.**

### `missing` is an accident; `removed` is an instruction

Both are "gone from the manifest". They are opposites, and the DB tells them apart:

| | means | rotation |
| --- | --- | --- |
| `missing = 1` | the file vanished and nobody meant it to | **stays in** — the cached file_id still sends |
| `removed_at IS NOT NULL` | an admin pressed 🗑 in a DM (Phase 8.5) | **out, immediately** |

Telegram serves an uploaded file long after we lose the local bytes, so a tidied folder must
not cost us working art. That same fact is why removal has to be recorded *explicitly*: "we
still **can** send it" must never quietly become "we still **do** send it", or the 🗑 button is
a lie. A manifest refresh never clears `removed_at` — Phase 8.5 removes in two steps (flag,
then archive the bytes), and a refresh landing between them would otherwise resurrect the meme.

## Architecture

| Concern | Decision |
| --- | --- |
| Telegram | grammY (TS-first; better middleware and rate-limit plugins than Telegraf) |
| Ingestion | Helius Enhanced WebSocket `transactionSubscribe` (Geyser-backed), `accountInclude: [mint]`, `failed: false`, commitment `confirmed`. Webhook adapter behind the same `Ingestor` interface as fallback. |
| Swap detection | DEX-agnostic balance-delta parsing (see invariant 1) |
| DB | SQLite (better-sqlite3, WAL). `Repo` is an interface so Postgres swaps in later. |
| Price | Trade-implied (`quote_in_usd / tokens_out`). SOL/USD from Binance.US WS primary + Coinbase WS secondary + REST bootstrap — same pattern as arbbot. |
| Market cap | `getTokenSupply` (cached, 5 min TTL) × trade price |
| Position % | Weighted-average cost basis per (mint, wallet), maintained locally. Optional Helius backfill. |
| Media pool | One folder on the VPS: `/srv/media/<mint>/{regular,big,whale,massive}/`, owned by the bot (invariant 4). Single source of truth, consumed by RiceBuybot, onegrainofrice and RiceDAO. |
| Media rotation | Tier picked by USD, then a shuffle bag within the tier so no meme repeats until that tier is exhausted. |
| Media manifest | `scripts/build-manifest.ts` walks the tiers and writes `manifest.json` atomically. Deterministic: an unchanged pool yields byte-identical bytes, so there is no `generated_at`. systemd timer every 5 min, plus on every `tier` move. |
| Media primitives | `src/media/pool.ts` — tier constants, content-addressed naming, `locateInTiers`, the manifest schema. Pure + `node:fs`. **No DB, no config/env, no network**, so the timer runs whether or not the bot is installed. Imported by the scripts AND by the bot (Phase 8.5's DM flow needs `locateInTiers`). |
| Media curation | `scripts/tier.ts` for bulk seeding (`tier massive ./gifs/*`), the bot's DMs for ongoing curation (Phase 8.5). Removals move to `_archive/`, never unlinked. |
| Media serving | nginx, straight off disk at `/media/` on both rice vhosts. Bypasses Next entirely: no basePath, no image optimizer, no rebuild to add a meme. `_incoming` and `_archive` denied. |
| Meme bot | **No relationship whatsoever.** There is no sync, no import, no shared file_ids (invariant 3). The pool has no dependency on any other bot. |
| Deploy | systemd on the VPS as the `ricebuybot` user (NOT `deploy`, NOT pm2 — see invariant 4). One instance. Zero telemetry, no Cloudflare. `pm2.config.cjs` is a local-dev convenience. |

**Port 3012** (`/health`). Bound to `127.0.0.1`. NOT 3011 — that is held by a Next.js app listening on `*:3011`, so binding it fails with EADDRINUSE. Verified free on the VPS before Phase 10.

---

## Ingestion (Phase 2)

Two adapters, one interpretation. `HeliusWsIngestor` (default) and
`HeliusWebhookIngestor` (`INGEST_MODE=webhook`) differ ONLY in how bytes arrive. Both funnel into
the same `normalizeSwap()`. A webhook fallback that classified buys differently from the socket
would be a silent, invisible bug — so they share `BaseIngestor` and the transport-specific code
stops at the door.

`normalizeSwap(tx, mint)` is balance-delta only (INVARIANT 1) and reads:

- per-owner token deltas for the mint **and** wSOL,
- native SOL deltas per account, **with `meta.fee` added back for the fee payer** so gas is not
  mistaken for buying pressure,
- account keys **including addresses loaded from address lookup tables** — miss these and every
  ALT-using route (i.e. most of Jupiter) mis-attributes.

A buyer is an owner who **gained the mint AND gave up quote**. No quote outflow means it is a
transfer, an airdrop or a claim — not a buy. When several owners qualify (aggregator routing),
prefer a **signer**: pool authorities are PDAs and can never sign.

### Absolute balances, and why not the ledger

`BuyEvent` carries `balanceBeforeRaw` / `balanceAfterRaw` — the buyer's **absolute** holding, read
straight out of the transaction.

Do NOT re-derive these from the `positions` table. That ledger only knows buys the bot has
observed, so a long-standing whale it has never seen reads as ~zero — exactly the wallet you most
need to catch. And do not add an RPC call for it: the figure is already in the transaction.

**Known limitation:** a holder keeping the mint in a SECOND token account that the transaction does
not touch will under-report. Rare, accepted, and far cheaper than an RPC round-trip on every buy.

**The wrong-whale guard.** `tokensRaw` is derived twice, by two independent passes — one keyed by
owner, one keyed by token-account index. They must agree. If they do not, the balance rows do not
describe one coherent wallet and the event is **dropped rather than posted**. A missed post is
cheap; a fabricated "🐳 WHALE BUY" is not.

Note the shape of that check: it is only meaningful *because* the two derivations are independent.
An earlier version computed `tokensRaw` as `after - before` and then asserted
`after - before === tokensRaw`, which is a tautology that can never fire. If you refactor here,
keep the two passes genuinely separate or the guard silently becomes decoration.

### The quote asset (Phase 2.5)

The quote asset comes from the **registry** in `core/quotes.ts` — native SOL + wSOL, USDC, USDT.
It is **data, not branching**: the normalizer iterates the registry and never names an asset.
Adding a fourth quote asset is a one-line addition to `QUOTE_REGISTRY` and nothing else. If you find
yourself writing `if (mint === ...)` downstream of that file, the design is broken.

A buyer qualifies when `deltaMint > 0` **and at least one registry quote has a negative delta**.

### Transfers are a RESULT, not a null (Phase 4.6)

`normalizeSwap` returns `BuyEvent | SellEvent | TransferEvent | null`. **`null` now means only "this
transaction does not touch the target mint for any wallet."** A transfer — the mint moved, no quote leg
on either side — is a real, classified event; it simply is not a buy.

**One parser, two filters. Never two parsers.**

- the **live** path (`BaseIngestor`) drops transfers on the floor: they have no quote leg, cannot be
  priced, and are never posted;
- the **backfill** path keeps them, because a transfer is *precisely* what makes a wallet unreconciled
  — an airdrop recipient under-counts, a wallet that sent tokens out over-counts. This is the only path
  by which a transfer ever reaches the ledger, which is why an unreconciled wallet must trigger one.

`normalizeSwap(tx, mint, { wallet })` scopes the classification to one wallet — "what did *this* wallet
do here" rather than "who was the buyer". That is a different **question** of the same parser, not a
second parser. See INVARIANT 12 for what happened the last time there were two.

A token-for-token swap (gained the mint, gave up some *non-registry* token) also lands here, booked at
zero cost. It was not free, but we cannot price the leg it was paid in — so the basis is understated and
the wallet stays honest by staying **unreconciled**, rather than by us guessing a number.

**Why this exists:** a Jupiter swap paid from a USDC balance routes through SOL *internally*, but the
BUYER's deltas are USDC down, target-mint up, **SOL flat** — both wSOL and native SOL are exactly
zero. The old SOL-only rule computed `quoteSpent = 0` and dropped it as `no-quote-movement`. That is
not an exotic case; it is an ordinary user paying from the stablecoin they already hold. Those buys
were being silently eaten. `test/fixtures/buy-usdc-quoted.json` is a real one, and there is a test
asserting the buyer's SOL delta really is 0 — i.e. that the old rule genuinely had nothing to see.

**DOMINANT QUOTE — never a sum.** The quote is the single **largest** negative leg by USD value.
Do NOT sum the legs: a buyer paying in USDC also burns a couple of million lamports on ATA rent, and
summing would book that dust as part of what they spent. That corrupts `priceUsd`, which feeds market
cap **and** the whale test — one bad line item poisons three numbers.

If a second leg exceeds **5%** of the dominant one, that is a genuine multi-asset payment and we are
about to under-report it: we log a warning with both legs rather than quoting only the larger in
silence.

`solUsd` is threaded into the normalizer **only** to rank competing legs, never to price a buy —
pricing/ does that. Without a live tick it falls back to `REFERENCE_SOL_USD`, which only ever affects
which of two legs is called dominant.

The boundary is guarded from both sides: `buy-usdc-quoted.json` must classify as a USDC buy, and
`token-to-token-arb.json` (gains RICE by giving up a *different non-quote* token) must still return
null. Widening the quote rule must not turn an arb into a buy.

### Dedup, cursors, reconnects

Dedup has two layers. The in-memory LRU (last 5k signatures) is an **optimisation only** — it is
per-process and dies on restart. The correctness boundary is the DB: the `buys` primary key and,
above all, the atomic claim in `sends` (INVARIANT 2). Never lean on the LRU to prevent a double-post.

Slot gaps are **logged, not backfilled** (backfill is Phase 9). Solana slots are not contiguous, so
only large gaps are worth a line. The WS reconnects with exponential backoff plus **full jitter**
(1s → 30s cap) — a fixed ramp would make every bot on the platform stampede Helius in lockstep after
a blip. Every active mint is re-subscribed on reconnect; old subscription ids are dead.

---

## Pricing (Phase 3)

Every USD figure for a buy comes from **one** price, and that price is **trade-implied** — derived
from the buy itself:

```
quoteUsd    = quoteRaw / 10^quoteDecimals * priceOf(quoteMint)
usdIn       = quoteUsd
priceUsd    = usdIn / (tokensRaw / 10^decimals)        <- execution price, from THIS trade
marketCap   = priceUsd * (supplyRaw / 10^decimals)
holdingsUsd = priceUsd * (balanceAfterRaw / 10^decimals)   <- the whale test
```

`holdingsUsd` uses the **same** `priceUsd` as the buy. Never mix in a second price source here. If
the buy is valued at its executed price but the holdings at some oracle mid, the two disagree and a
wallet can appear to hold more (or less) than the trade it just made implies — which is exactly what
makes a whale call look fabricated.

**Never hardcode pump defaults.** "6 decimals, 1B supply" is a trap: the flagship $RICE is 6
decimals but **982,048,494.78** supply, not 1B. Market cap is computed from this number. Always read
`getTokenSupply` from the chain. Symbol falls back to the mint's first 4 characters.

### The staleness guard is scoped

SOL/USD: Binance.US primary, Coinbase secondary, REST bootstrap on both at boot so `solUsd()` is
never null after `start()`. Primary >10s stale → fail over. Both >30s stale → `solUsd()` returns
null and SOL-quoted buys are **held** in a bounded queue (200, evict-oldest) rather than posted with
a wrong dollar figure. Flushed on recovery.

**The guard applies ONLY to SOL-quoted buys.** A USDC-quoted buy does not need SOL to be priced and
must post while the SOL feed is face-down. One dead websocket must not hold back buys it has no
bearing on.

### Binance.US: bookTicker, not the trade stream

The primary reads `solusdt@bookTicker` and takes the mid. **Do not "fix" this back to
`solusdt@trade`.** Measured live: the trade stream emitted **zero** trades in 30 seconds while
bookTicker emitted 279 updates. On the trade stream the primary crosses the 10s staleness line
within seconds of boot and stays there forever — every buy silently rides the Coinbase failover, and
one Coinbase blip then takes the whole feed to null while Binance was reachable the entire time.

A crossed book (ask < bid) or one wider than 5% is rejected: a bad mark here misprices every buy
that follows it.

### USDC quoting: CLOSED

`ingest/` emits a generic quote asset as of Phase 2.5, so USDC/USDT-quoted buys now reach the pricer
and post normally — including while the SOL feed is down. See "The quote asset" above.

---

## Cost basis and reconciliation (Phase 4)

Weighted-average cost per `(mint, buyer)`. A sell retires cost at the current average, so the
average basis of the remaining tokens is unchanged. Quantities floor at zero — a negative
`tokens_raw` would poison every later percentage.

### The swap log (Phase 4.5) — INVARIANT 11

`positions` is a **materialized view**, not a store. The source of truth is `swaps`:

| Column | Note |
| --- | --- |
| `PRIMARY KEY (signature, mint, wallet)` | **This is what makes replay idempotent.** `INSERT OR IGNORE`, always. `kind` is **not** in the key (INVARIANT 12) — it is derived from the sign of the net delta, so it describes a swap and must never identify one. |
| `kind` | `buy` \| `sell` \| `transfer_in` \| `transfer_out`. Direction lives here — `tokens_raw` is **always positive**. Stored, folded on; never keyed on. |
| `usd_value` | `0` for transfers: **they were free.** |
| `balance_after_raw` | The wallet's absolute holding after this swap. `onchain_raw` is the newest of these by slot, which is what makes the fold **total** — reconciliation rebuilds from the log too. |
| `source` | `live` \| `backfill`. Audit only; it never affects the fold. |

**One door.** `applySwap` (and its batch form `applySwaps`) appends the fact, then recomputes the
position by folding every row for that `(mint, wallet)` through `basis.ts`. Live ingest, hold-queue
flush and backfill all come through it. **There is no other way to move a position** — `basis.ts`
itself did not change, it just stopped being fed by two racing callers.

The fold's order is `(slot, signature, kind)` and must stay **total**: a weighted average is not
commutative across a sell, so an unstable order silently yields a different — wrong — cost basis on
replay.

`reconciled` has **two** inputs, not one. Drift is the arbiter, but `history_truncated` **vetoes it
outright**: on a known-incomplete history (the 1000-signature cap was hit, or a priced leg would not
resolve) drift can read as zero — the missing swaps happened to net out — while the cost basis is
still missing legs. A percentage from a half-basis is exactly the lie INVARIANT 10 exists to prevent.

### INVARIANT 10 — never render a Position % from an unreconciled ledger

**The ledger is checked against the chain on every buy. If it does not agree, NO percentage is
shown.**

Why: `cost_usd / tokens_raw` is built ONLY from buys this bot observed. `holdingsUsd` comes from
`balanceAfterRaw` — exact, on-chain. For any wallet with prior history the bot never saw, **those two
describe different quantities.**

A wallet holding 10M tokens bought at $0.00001 last month buys 200K more today. The card renders the
correct holdings from chain AND "Position +2%" from a cost basis made entirely of today's buy. The
wallet is actually up ~900%. The bot states a specific, confident, public number that is wrong by two
orders of magnitude. That is a screenshot; a missing line is invisible.

Transfers break it both ways and are invisible to the normalizer (which returns null on them, by
design): an airdrop recipient's ledger under-counts, a wallet that sent tokens out over-counts.

**The fix is free.** `balanceAfterRaw` arrives on every buy, so **every buy is a reconciliation
checkpoint**:

```
onchain_raw = balanceAfterRaw
drift_raw   = onchain_raw - tokens_raw       -- signed
reconciled  = abs(drift_raw) <= 1 raw unit   -- dust, for ROUNDING only
```

The dust tolerance is **1 raw unit, not a percentage**. A percentage tolerance would silently accept
a whale whose ledger is off by 1% of an enormous bag — precisely the wallet whose PnL must not be
guessed at.

### The render rule

| State | Renders |
| --- | --- |
| `balanceBeforeRaw = 0`, never seen | `🆕 New Holder` |
| `balanceBeforeRaw = 0`, known wallet | `🔁 Returning` |
| `reconciled = 0` | **nothing** — omit the Position line entirely |
| `reconciled = 1`, `avgCost > 0` | `Position +128%` |
| `reconciled = 1`, `avgCost = 0` | `🎁 Free bag — no cost basis` |
| **whale tier** | `holdingsUsd` **always**, reconciled or not — it comes from the chain and is exact |

The free-bag line is only safe to print **because** `basis_unpriced` keeps arbs out of it. An arb has a
zero basis too, but it never reconciles, so it never reaches that row of the table.

**It carries no number, and must not be given one.** That line sits in the *same slot* as
`Position +128%`, so any figure in it is read on the same scale — a reader comparing `100%` against
`128%` concludes the free bag did *worse*. It did infinitely better. A return against a zero basis is
**undefined**, not 100%. Two incommensurable quantities must never share a slot; state the fact and let
the absence of a figure be the figure.

### `realized_pnl_usd` is NULLABLE, and NULL means UNKNOWABLE

Not zero. Not "not computed yet". The fold writes NULL iff any swap for that `(mint, wallet)` is an
**unpriced SELL** — a `transfer_out` into a token we cannot value. That leg books no realized PnL
because its PnL cannot be known, so the running total is missing a piece it can never learn.

Note the condition is *unpriced SELL*, not merely *unpriced*. They are two different blindnesses and
collapsing them throws away a real figure:

| | corrupts | |
| --- | --- | --- |
| unpriced **buy** (arb in) | the cost **basis** | `basis_unpriced` — realized PnL is untouched, nothing was sold |
| unpriced **sell** (arb out) | **realized PnL** | `realized_pnl_usd = NULL` — the basis may still be fine |

Nothing renders this column today. **That is a comment, not a guarantee** — which is exactly why it is
nullable. A `NOT NULL DEFAULT 0` here is the type system asserting a fact we do not have, and the first
PnL line anyone adds to a whale card would read it, believe it, and publish it. Now the compiler makes
every reader face the NULL. Same lesson as the lying type predicate in `TokenMetaCache`: an invariant
that survives only because everyone remembers a comment is not an invariant.

### `reconciled` has THREE inputs

```
reconciled = abs(drift_raw) <= 1 raw unit          -- the arbiter
             AND NOT history_truncated             -- we do not have all the legs
             AND NOT basis_unpriced                -- we have them all and cannot value one
```

The two vetoes stay **separate** rather than collapsing into one boolean. When a wallet's Position % is
dark you want to know *which kind of blind you are* — and they have opposite remedies:

- `history_truncated` → a backfill might fix it.
- `basis_unpriced` → **nothing** will fix it. Abstaining *is* the answer.

Drift can read as exactly zero in both cases while the cost basis is nonsense, which is why drift alone
was never enough.

### One application path

A swap reaches the ledger two ways: live off the ingestor, or out of the hold queue once the SOL
feed recovers. Those are two **arrival** paths, not two kinds of event, and they fold in through a
single function — `positions/apply.ts`. Same principle as `BaseIngestor`: transport stops at the
door, and there is no second place to forget a case.

There used to be a second place. The flush callback dispatched only `kind === 'buy'`, so a
SOL-quoted **sell** held during a feed outage was flushed straight into the bin — never applied to
cost basis. The ledger then held tokens the wallet had already sold and cost it had already retired.
Reconciliation caught it on that wallet's next buy (drift ≠ 0 → `reconciled = 0` → no Position line),
so it never became a public lie — but the Position % went dark until a backfill rebuilt it, and
realized PnL was wrong in the meantime. **Route both arrival paths through `onSwap`.**

### Backfill

**Its job is to REACH `reconciled=1`, not merely to run.** Replays Helius history for the wallet,
oldest → newest, filtered to the mint. Buys and sells fold into cost basis; **transfers in are
replayed as ZERO-COST tokens** (they were free — this correctly drags avgCost down, so an airdrop
never becomes phantom profit) and **transfers out as quantity-only reductions** at the current
average, booking no realized PnL.

**It does not overwrite anything** (INVARIANT 11). It inserts the swaps it discovers and recomputes.
Transfers reach the log *only* by this path — the live path filters them out — which is precisely why
an unreconciled wallet must trigger a backfill.

**Helius history is DISCOVERY ONLY** (INVARIANT 12). It tells us *which* signatures touched the wallet.
The classification then runs through `normalizeSwap` — the same function, the same code path, the same
classification the live socket uses. There is no mapping from any parsed-history format into a swap row;
if you find one, this patch has been undone.

Raw transactions are heavier than parsed history. That is the price of one parser, and it is worth
paying: fetches go out as **JSON-RPC batch requests** (100 per batch, 2 batches in flight), and a failed
batch falls back to single fetches rather than silently truncating the walk — a truncated walk is a lie.

After the replay, drift is recomputed. `reconciled` flips to 1 **only** if drift is within dust AND
the 1000-signature cap was not hit AND every priced leg resolved. Otherwise it stays 0 and we STOP.
**"Approximate beats absent" is wrong for this field** — a wrong number is worse than no number.

Concurrency 2, 24h per-wallet cache, hard cap 1000 signatures. **Backfill NEVER blocks a send:** if
it has not finished when the card renders, the card posts without the Position line and moves on.
**The message is NOT edited afterwards.**

Historical SOL-quoted buys are priced at the SOL/USD of their *block time* (hourly Binance.US
klines, cached), not today's price — replaying a three-week-old buy at today's SOL price puts the
error straight into the Position %.

---

## Migrations

Numbered, checksummed, each in its own transaction. An applied migration whose file has since changed
is a hard error — add a new one, never edit an applied one.

`positions` is a materialized view (INVARIANT 11), so a migration that changes what the **fold** computes
must refold it once. That is what the marker list in `SqliteRepo#rebuildOnce` is for: add a marker, and
the refold happens on the next boot. It cannot live in the migration SQL — the fold is bigint arithmetic,
and SQLite's `SUM()` over a TEXT u64 rounds through a float and drops the low bits (INVARIANT 6).

### The abstention principle

> **A migration that introduces a new claim must never apply that claim to rows classified before the
> distinction existed. Rows predating a distinction carry no evidence either way — abstain and
> re-derive, never default them into the new claim's happy path.**

This is not abstract; it has already bitten. Phase 4.7 added `unpriced` to tell a free airdrop apart
from an arb the wallet actually paid for, **and** started rendering a reconciled zero basis as a free
bag. Every transfer row already in the log had been classified before that distinction existed, so the
counter-leg was never recorded and the row alone cannot say which it was. Defaulting them to
`unpriced = 0` — the "no, it was free" happy path — would have taken every legacy arb and published
`🎁 Free bag` about a wallet that had paid for its bag. The migration that introduces a claim would have
handed that claim a pile of wallets it was false about.

So migration 006 sets `unpriced = 1` on every pre-existing transfer row: *we do not know, so we do not
say*. It costs a hidden Position % until the wallet's next backfill re-walks its history through the one
parser and settles the question. Migration 007 does the same for `realized_pnl_usd`: it re-derives every
row rather than trusting a single pre-existing number.

The default for "we have no evidence" is **abstain**, never **assume the good case**.

## Layout

```
src/
  config/    zod-validated env loader; fails fast at boot listing EVERY bad var
  core/      domain types + tier constants + integer money. NO I/O.
  ingest/    Ingestor interface (Helius WS impl in Phase 2)
  pricing/   PriceSource interface (SOL/USD feed in Phase 2)
  media/     MediaPool interface (filesystem pool + file_id cache in Phase 3).
             pool.ts = the pool PRIMITIVES, shared with scripts/: tier constants,
             <sha256>.<ext> naming, locateInTiers, manifest schema. Pure + node:fs;
             importing config/, db/ or the network here breaks the systemd timer.
  positions/ cost basis, reconciliation, backfill (discovery-only), and the ONE
             path that folds a priced swap into the ledger (`apply.ts`).
             NO classifier lives here — ingest/normalize.ts is the only one.
  db/        Repo interface (SQLite impl in Phase 1)
  telegram/  grammY surface (Phase 3)
  render/    pure BuyPost -> caption. The render boundary of invariant 6.
  ops/       pino logger (scrubbed), /health server, graceful-shutdown machinery
  index.ts   boot + graceful shutdown; drains in-flight sends

scripts/
  build-manifest.ts   media pool manifest generator. Runs on the VPS UNBUILT, via
                      Node's type stripping, so the systemd timer works with no
                      build step and no bot. Imports src/media/pool.ts — which is
                      pure + fs, so that costs nothing. Run every 5 min, and by
                      tier.ts on every move.
  tier.ts             bulk curation CLI. Moves media into a tier or into _archive
                      and regenerates the manifest, in one command.
  setup-media-pool.sh one-shot, idempotent VPS provisioning: ricebuybot user,
                      /srv/media perms, ffmpeg, systemd timer, nginx include.

deploy/
  nginx/     /media/ location snippet, included by both rice vhosts
  systemd/   manifest timer + service (Phase 10 adds the bot's own unit here)
```

## Commands

```
pnpm build      tsc
pnpm typecheck  tsc --noEmit
pnpm test       vitest run
pnpm start      node dist/index.js

pnpm media:manifest --root ./pool --mint <MINT>   rebuild manifest.json
pnpm media:manifest --check                       exit 1 if it is out of date
pnpm media:tier massive ./gifs/*                  seed a tier in bulk
pnpm media:tier archive old.gif                   retire a meme (never deleted)

sudo bash scripts/setup-media-pool.sh             provision the pool (VPS, once)
rice-tier massive ./banger.gif                    the same tier CLI, on the VPS
```

`build-manifest.ts` and `tier.ts` need **ffprobe** (`apt install ffmpeg`) — it is what
tells an animation from a video, and Telegram treats those differently.

## Conventions

- Never run a second instance, under systemd or pm2. One WS connection, one SQLite writer, one
  writer to the media pool. A second instance double-posts and fights over the WAL.
- On the VPS the bot runs as the `ricebuybot` user, never as `deploy` (invariant 4). `.env` is
  `0600 ricebuybot:ricebuybot`. The websites' user must never be able to read the bot's secrets.
- Anything carrying a URL goes through `scrubUrl()` before it is logged (Helius puts the API key
  in the query string — the key name is innocent, the value is not).
- Raw chain amounts are `bigint`. If you find yourself writing `parseFloat` outside `render/`,
  stop and reread invariant 6.

## The pool tooling imports across `src/` — on purpose

`scripts/build-manifest.ts` and `scripts/tier.ts` import `src/media/pool.ts`, and
`tsconfig.json` has `rootDir: "."` so `scripts/` is type-checked. Emitted output
therefore lands at `dist/src/…` (hence `dist/src/index.js` in package.json and
pm2.config.cjs).

**The property being protected was never "the scripts import nothing from `src/`".**
It is that the pool has **no runtime dependency on the bot's DB, config or network**,
so the manifest timer runs whether or not the bot is installed, built or running. A
hashing function and four `stat` calls do not threaten that; an import of `config/`
(which reads env and fails fast) or `db/` would. Keep `src/media/pool.ts` pure + `fs`
and the guarantee holds.

The scripts run **unbuilt** (`node scripts/build-manifest.ts`), so their imports are
spelled `../src/media/pool.ts` — with the `.ts` extension. Node's type stripping does
NOT resolve a `.js` specifier to a `.ts` file on disk; it throws. `tsc` rewrites the
extension to `.js` on emit (`rewriteRelativeImportExtensions`), so the compiled bot is
unaffected. **Do not "fix" those `.ts` extensions to `.js`** — you will break the
timer, and only the timer, which is the failure nobody is watching.

`setup-media-pool.sh` therefore installs the repo's SHAPE into `/opt/ricebuybot-media/`
(`scripts/` beside `src/`), not a flat directory: `../src/media/pool.ts` has to resolve.

## Zero telemetry: the allowlist (Phase 9)

**The ONLY hosts this process may contact:**

| Host | Why | When |
| --- | --- | --- |
| `api.telegram.org` | the Bot API | always |
| `*.helius-rpc.com` | RPC + the Enhanced WebSocket | always |
| `api.binance.us` | SOL/USD primary (bookTicker) | always |
| `*.coinbase.com` | SOL/USD secondary | always |
| the media host | `manifest.json` + media bytes | **only** when `MEDIA_SOURCE=http` |

Nothing else. No analytics, no crash reporter, no phone-home, in our code **or in any
transitive dependency**. `pnpm audit:network` greps the entire *production* dependency tree
(`pnpm ls --prod`, 63 packages) for outbound hosts and fails on any known telemetry SDK.

Two things it deliberately does NOT flag:

- **devDependencies.** vitest, vite and typescript reference plenty of hosts and none of them
  are ever loaded by the running bot. Scanning them buries the one finding that would matter
  under a hundred that cannot.
- **Link URLs in `core/links.ts`** (dextools, dexscreener, jup.ag). Those are rendered as
  inline-keyboard buttons for a *user* to tap. The bot never fetches them.

### Audit output (Phase 10, final)

```
$ pnpm audit:network
Allowlist (the ONLY hosts this process may contact):
  ✓ api.telegram.org
  ✓ helius-rpc.com
  ✓ helius.xyz
  ✓ binance.us
  ✓ coinbase.com
  ✓ exchange.coinbase.com
  ✓ 1grainofrice.com

✅ PASS — 43 distinct hosts seen, 29 off-allowlist, 0 telemetry references.
```

The off-allowlist hosts are all documentation URLs sitting in comments — `webpack.js.org` in a
better-sqlite3 comment, `www.cl.cam.ac.uk` in ws's UTF-8 validator, spec links in zod, and the
DexTools/DexScreener/Jupiter URLs in `core/links.ts`, which are rendered as inline-keyboard
buttons for a *user* to tap and are never fetched by the process. **Zero telemetry SDK
references across all 63 production packages.**

It is a grep, so it is a smoke alarm and not a firewall — a host built from string
concatenation at runtime would slip past it. The firewall is the VPS. But it catches the
realistic case, which is a package with an analytics endpoint sitting in its source.
