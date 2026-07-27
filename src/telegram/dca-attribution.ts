import type { BuyEvent } from '../core/types.js';
import type { Logger } from '../ops/logger.js';

/**
 * PHASE 7 — IS THIS BUY A DCA? One question, one answer, one place.
 *
 * Phase 16 asked it as "does this signature have an execution row" and used the answer twice: to
 * keep the buy off an organic card, and to roll it into the window aggregate. Wallet mode adds a
 * second way for a buy to be a DCA — a Jupiter recurring order the user's OWN wallet signed, which
 * the bot never sent and has no execution row for — and the whole point of this phase is that the
 * second way reaches the same card by the same path.
 *
 * So the two halves are joined HERE, above both consumers, rather than in the fan-out check and
 * again in the flush query. A split answer is how a buy ends up suppressed from the organic feed
 * by one rule and dropped from the aggregate by another, which is worse than either behaviour on
 * its own: the buy vanishes.
 *
 * The disclosure consequence is the reason this is careful. A DCA buy that is neither carded nor
 * aggregated is an automated buy the group was never told about.
 */

export interface DcaAttributionRepo {
  /** Phase 16: the buy is one of OUR sends. No state filter — submitted and UNKNOWN count. */
  isDcaSignature(signature: string): Promise<boolean>;
  /** Phase 7: the buyer is an allowlisted, unlocked, wallet-mode member's PROVEN address. */
  isWalletModeAddress(wallet: string): Promise<boolean>;
  /** Phase 7: we have ALREADY attributed this buy. A past attribution is permanent — see below. */
  isWalletDcaBuy(signature: string): Promise<boolean>;
  /** Phase 7: attribute a wallet-mode fill so the flush query can find it. Idempotent. */
  recordWalletDcaBuy(signature: string, mint: string, buyer: string, atMs: number): Promise<void>;
}

export interface DcaAttributionDeps {
  readonly repo: DcaAttributionRepo;
  readonly log: Logger;
  /** Observation time, used only when the chain gave us no block time. */
  readonly now?: () => number;
}

/**
 * The window a wallet-mode fill belongs to.
 *
 * BLOCK TIME FIRST, and our own clock only as a fallback. The aggregate is a statement about when
 * buys HAPPENED, and a backlog flushed after a reconnect would otherwise pile hours of real buys
 * into the single window in which we happened to notice them. Block time is seconds; the rest of
 * the DCA machinery is milliseconds.
 *
 * Stamped ONCE, at write time, and stored — never recomputed at flush. A replay that re-derived
 * the bucket could move an already-flushed buy into a later window and post it twice.
 */
function windowTimeFor(e: BuyEvent, nowMs: number): number {
  return e.blockTime !== null && e.blockTime !== undefined ? e.blockTime * 1000 : nowMs;
}

export interface DcaAttribution {
  /**
   * True iff this buy must be kept off the organic feed and rolled into the DCA aggregate.
   *
   * Has the side effect of recording a wallet-mode fill when it finds one — deliberately, because
   * the two must not be able to disagree. Recording without suppressing double-posts (an organic
   * card AND an aggregate line for one buy); suppressing without recording loses it entirely.
   */
  isDca(e: BuyEvent): Promise<boolean>;
}

export function makeDcaAttribution(deps: DcaAttributionDeps): DcaAttribution {
  const { repo, log } = deps;
  const now = deps.now ?? Date.now;

  return {
    async isDca(e: BuyEvent): Promise<boolean> {
      // HALF ONE — a custodial execution of ours. Checked first and on its own: it needs no
      // identity link, no program id and no config, so the phases 12-16 path keeps working
      // exactly as it did even with wallet-mode attribution switched off entirely.
      if (await repo.isDcaSignature(e.signature)) return true;

      // ALREADY ATTRIBUTED — and that is PERMANENT, exactly as an `executions` row is.
      //
      // This is not an optimisation, it closes a real hole. The live test below re-reads the
      // allowlist every time (deliberately — a revoked member must stop being attributed at once),
      // so a gap-recovery replay of a buy made BEFORE the member was revoked would re-evaluate to
      // "not a DCA" and fan out as an organic card — for a buy that is already sitting in a
      // published aggregate. One buy, disclosed twice, in two different shapes.
      //
      // The row is the record that we already told the group about this buy in the DCA card. What
      // changes on revocation is what happens to their FUTURE buys, not what we said about a past
      // one.
      if (await repo.isWalletDcaBuy(e.signature)) return true;

      // HALF TWO — a wallet-mode recurring order. BOTH conditions are required, and the cheap
      // local one is checked first so an ordinary buy costs no query at all.
      //
      // THE JUDGEMENT CALL, stated where it is made: only Jupiter-recurring-program buys count as
      // DCA. A linked villager who opens their wallet and apes in by hand has not automated
      // anything, and rolling that trade into a card headed "automatic" would be the bot asserting
      // something false about a person's behaviour — while also robbing them of the organic buy
      // card their manual buy has every right to. Under-attributing costs a roll-up; over-
      // attributing publishes a lie. We take the first.
      if (e.viaRecurringProgram !== true) return false;
      if (!(await repo.isWalletModeAddress(e.buyer))) return false;

      await repo.recordWalletDcaBuy(e.signature, e.mint, e.buyer, windowTimeFor(e, now()));
      log.info(
        { signature: e.signature, mint: e.mint, buyer: e.buyer },
        'buy attributed as a WALLET-MODE DCA — suppressed from organic fan-out, rolled into the aggregate',
      );
      return true;
    },
  };
}
