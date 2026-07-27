import { exposureWarning } from './wallet.js';

/**
 * PHASE 7 — THE MODE. Which half of the autotrader a member is in, and the rules for crossing.
 *
 * PURE. No I/O, no clock, no repo. It answers "may this switch happen, and what must the user be
 * told" from facts the caller has already gathered, so every branch is exhaustively testable and
 * the Telegram layer holds no policy of its own.
 *
 * The distinction is not a feature flag. It is WHO HOLDS THE KEY:
 *
 *   wallet — the bot holds NOTHING. The user's DCA runs as Jupiter recurring orders signed by
 *            their own wallet, from the Mini App or the site. No keystore, no scheduler tick, no
 *            signature, ever. This is the DEFAULT for a new member.
 *   key    — the phases 12-16 custodial scheduler, unchanged. The bot holds an encrypted key and
 *            spends from it on a timer.
 *
 * The mode is shown at the top of /trade for one reason: a person must ALWAYS be able to see
 * whether the bot is holding a key for them, without asking and without inferring it from the
 * absence of something.
 */

export type TraderMode = 'wallet' | 'key';

/**
 * A new member is a WALLET-mode member, and this constant only restates what migration 019 makes
 * true in the schema (`DEFAULT 'wallet'`). Sending a key must never be the path of least
 * resistance — it has to be chosen, on purpose, against a warning.
 */
export const DEFAULT_MODE: TraderMode = 'wallet';

/** The typed acknowledgement for wallet -> key. Same phrase as /wallet import's, for the same act. */
export const CUSTODY_ACK_PHRASE = 'I UNDERSTAND';

export function isTraderMode(v: unknown): v is TraderMode {
  return v === 'wallet' || v === 'key';
}

/** Parse a user-typed mode word. Null for anything else — never guess which one they meant. */
export function parseMode(raw: string): TraderMode | null {
  const w = raw.trim().toLowerCase();
  return w === 'wallet' || w === 'key' ? w : null;
}

/**
 * THE CUSTODY WARNING, verbatim from Phase 12.
 *
 * It is not re-typed here, it is CALLED. Two copies of a custody warning is two things to update
 * and one of them will be missed; the one in `wallet.ts` is the one /wallet import has always
 * shown, so switching into key mode shows exactly that and cannot drift from it.
 */
export function custodyWarning(): string {
  return exposureWarning();
}

/**
 * Why a switch was refused. A refusal always names the thing standing in the way — a user told
 * "no" without being told what to fix will simply try again and get the same "no".
 */
export type ModeSwitch =
  | { readonly ok: true; readonly from: TraderMode; readonly to: TraderMode }
  | { readonly ok: false; readonly reason: 'same-mode'; readonly mode: TraderMode }
  | { readonly ok: false; readonly reason: 'active-schedules'; readonly activeSchedules: number };

/**
 * May this user move from `from` to `to`?
 *
 * KEY -> WALLET IS REFUSED WHILE A CUSTODIAL SCHEDULE IS ACTIVE. Not paused-on-their-behalf,
 * REFUSED: the switch locks the key, and a running schedule that suddenly cannot sign is a
 * schedule failing in a way its owner did not ask for and would have to debug. Stopping their own
 * schedules first is one command, and it makes the ordering explicit — they turn the trading off,
 * then they take the key back.
 *
 * WALLET -> KEY has no such precondition. There is nothing running to interrupt; the whole cost
 * of that direction is the custody itself, which is why it is gated on the warning and a typed
 * acknowledgement rather than on state.
 */
export function checkModeSwitch(from: TraderMode, to: TraderMode, activeSchedules: number): ModeSwitch {
  if (from === to) return { ok: false, reason: 'same-mode', mode: from };
  if (to === 'wallet' && activeSchedules > 0) {
    return { ok: false, reason: 'active-schedules', activeSchedules };
  }
  return { ok: true, from, to };
}

/**
 * What the user is told after key -> wallet completes.
 *
 * NEVER SILENTLY ORPHAN A KEY. The keystore is locked, not destroyed — it is their key and
 * withdrawing from a service is not authority to destroy someone's property (INVARIANT 14) — but
 * a locked key they have forgotten about is a wallet whose funds quietly become unreachable. So
 * the message that confirms the switch is also the message that tells them how to get the money
 * out, and it names `purge` as the deliberate destroy path rather than pretending none exists.
 */
export function keyToWalletNotice(hadKeystore: boolean): string {
  const lines = [
    '✅ You are now in WALLET mode.',
    '',
    'I hold no key for you, run no schedule for you, and sign nothing for you.',
    'Your DCA lives in your own wallet as Jupiter recurring orders — open the',
    'Mini App from /trade to manage it.',
  ];
  if (hadKeystore) {
    lines.push(
      '',
      '🔒 YOUR OLD KEYSTORE IS LOCKED, NOT DELETED.',
      '',
      'If that wallet still holds funds, get them out — /wallet export gives you',
      'the secret key back (you need your passphrase), and you can withdraw from',
      'it in any wallet app. I am not going to touch it again either way.',
      '',
      'When you no longer need it, the operator can destroy it for good with',
      '/trader purge. That is the only thing that deletes it.',
    );
  }
  return lines.join('\n');
}

/** What the user is told after wallet -> key completes: what the bot now holds, and how to undo. */
export function walletToKeyNotice(): string {
  return [
    '✅ You are now in KEY mode.',
    '',
    'Nothing has been imported yet — /wallet generate for a fresh low-exposure',
    'wallet, or /wallet import to bring your own. Until you do, I still hold',
    'nothing of yours.',
    '',
    'Once a key is in, my scheduler spends from that wallet on your timer.',
    '/mode wallet takes it back (stop your schedules first).',
  ].join('\n');
}

/**
 * Why /wallet import and /wallet generate are REFUSED in wallet mode.
 *
 * Both are refused, not just import: the point of wallet mode is that no key of theirs is on this
 * server, and a key the bot generated and kept is exactly as custodial as one they pasted in. A
 * refusal that covered only the scarier-looking half would leave the quieter half as the path of
 * least resistance into custody, which is the thing this phase exists to prevent.
 *
 * The refusal SAYS HOW TO OPT IN. Silence here would be a different bug from the silence
 * INVARIANT 14 asks for: this person is a member, they are talking to a surface they can see, and
 * a dead-end refusal just makes the bot look broken.
 */
export function importRefusedInWalletMode(what: 'import' | 'generate'): string {
  return [
    `🚫 Not in wallet mode — nothing was ${what === 'import' ? 'imported' : 'generated'}.`,
    '',
    'You are in WALLET mode, which means I hold no key for you. Your DCA runs',
    'from your own wallet as Jupiter recurring orders — open the Mini App from',
    '/trade and nothing secret ever leaves your device.',
    '',
    'If you genuinely want me holding a key and trading for you, that is a',
    'deliberate switch: /mode key. It shows you what you are giving up and',
    'asks you to type an acknowledgement first.',
  ].join('\n');
}
