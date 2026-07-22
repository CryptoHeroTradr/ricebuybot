import type { Keystore } from './keystore.js';
import type { AutotraderAccessRepo } from './access.js';
import type { Logger } from '../ops/logger.js';

/**
 * THE UNLOCK MODEL.
 *
 * With one user this was a free choice. With several it is not: the passphrases in play are
 * OTHER PEOPLE'S, and where they may live stops being a matter of operator taste.
 *
 * DM_UNLOCK (default). Each user sends their own passphrase in a DM; the bot decrypts to
 * memory and deletes the message. A restart locks EVERY wallet and pauses every schedule until
 * each person re-unlocks. That cost is real — a 3am restart stops DCA for everyone until they
 * notice — and it is mitigated by telling them (`bootNotices`), not by weakening the model.
 *
 * It is the default BECAUSE the bot holds other people's keys. A stolen disk image should be
 * inert, and no env file should contain a secret that opens someone else's wallet.
 *
 * ENV_UNLOCK. The OWNER'S OWN keystore only, and the restriction is structural: `envUnlock`
 * takes the owner id and compares it to the user it is asked about, so there is no argument you
 * can pass that unlocks somebody else from the environment. Nobody else's passphrase belongs in
 * your env file — not as a convenience, not temporarily.
 */

export type UnlockMode = 'dm' | 'env';

export interface UnlockConfig {
  /** Owner's Telegram id. The ONLY id for which env unlock is permissible. */
  readonly ownerUserId: number | undefined;
  /** Owner's own passphrase, from env. Never anyone else's. */
  readonly ownerPassphrase: string | undefined;
}

/**
 * Which mode applies to a given user. /wallet renders this, always: a person should never
 * have to guess whether their key is at rest or in memory.
 */
export function unlockModeFor(cfg: UnlockConfig, userId: number): UnlockMode {
  if (cfg.ownerUserId !== undefined && cfg.ownerUserId === userId && cfg.ownerPassphrase !== undefined) {
    return 'env';
  }
  return 'dm';
}

/**
 * Unlock at boot from the environment — owner only.
 *
 * Returns the ids actually unlocked, which is at most one. A caller that passes some other
 * user id gets nothing: the comparison is against `cfg.ownerUserId`, not against a parameter.
 */
export function envUnlock(keystore: Keystore, cfg: UnlockConfig, log: Logger): readonly number[] {
  const { ownerUserId, ownerPassphrase } = cfg;
  if (ownerUserId === undefined || ownerPassphrase === undefined) return [];
  if (!keystore.has(ownerUserId)) return [];

  try {
    keystore.unlock(ownerUserId, ownerPassphrase);
    log.info({ userId: ownerUserId }, 'autotrader: owner wallet unlocked from env');
    return [ownerUserId];
  } catch {
    // Never echo the failure detail: it is about a passphrase.
    log.error({ userId: ownerUserId }, 'autotrader: owner env passphrase did not open the keystore');
    return [];
  }
}

export interface BootNotice {
  readonly userId: number;
  readonly text: string;
}

/**
 * WHO TO TELL, AND WHAT, AFTER A RESTART.
 *
 * A restart locked every wallet and paused every schedule. The failure mode this exists to
 * prevent is silent: a user whose DCA stopped at 3am and who finds out days later by looking
 * at a chart. Telling them is the mitigation that makes DM_UNLOCK's cost acceptable.
 *
 * Pure — it computes the notices and sends nothing, so the boot path can be tested without a
 * Telegram client and so a send failure cannot take the boot down with it.
 */
export async function bootNotices(
  repo: AutotraderAccessRepo,
  keystore: Keystore,
  alreadyUnlocked: readonly number[],
): Promise<readonly BootNotice[]> {
  const members = await repo.listAutotraderUsers();
  const unlocked = new Set(alreadyUnlocked);
  const notices: BootNotice[] = [];

  for (const m of members) {
    if (m.locked) continue; // revoked: not our news to deliver
    if (unlocked.has(m.userId)) continue;
    if (!keystore.has(m.userId)) continue; // nothing to unlock

    notices.push({
      userId: m.userId,
      text: [
        '🔄 RiceBuybot restarted — your wallet is locked and your schedules are paused.',
        '',
        'Send /unlock to resume. Nothing traded while it was down.',
      ].join('\n'),
    });
  }
  return notices;
}
