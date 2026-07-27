import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * PHASE 8 — verifying a Telegram Mini App's `initData`.
 *
 * WHY THIS LIVES ON THE BOT AND NOWHERE ELSE. `initData` is signed with a key derived from the BOT
 * TOKEN. Validating it therefore requires the token, and the token is the one secret that lets you
 * *be* the bot — post to every group we have ever onboarded, DM every member. It exists on this
 * host, in a 0600 file readable only by the `ricebuybot` user (INVARIANT 5). It does not go to the
 * website, it does not go to the browser, and no amount of "it would be simpler if the site could
 * check this itself" changes that. The site forwards an opaque string; the bot answers a question.
 *
 * WHAT THIS BUYS. The Mini App runs in a webview the user can open dev tools on. Anything the page
 * *claims* about who it is — a user id in a query param, a wallet in localStorage — is a claim the
 * user typed. `initData` is the one thing on that page Telegram signed, so it is the only basis on
 * which the bot may say "this really is user 12345" and hand back the wallet linked to them.
 *
 * WHAT IT DOES NOT BUY. It proves a Telegram identity, not a wallet. The wallet still comes from
 * the Phase 6 link, which required an ed25519 signature from the wallet itself. Two independent
 * proofs meet in `site_links`, and this file is only the first of them.
 *
 * The algorithm is Telegram's documented one:
 *   secret       = HMAC_SHA256(key = "WebAppData", data = bot_token)
 *   expected     = HMAC_SHA256(key = secret,       data = data_check_string)
 *   data_check_string = every field except `hash`, as "k=v", sorted by k, joined with "\n"
 */

/** How old an initData may be. Telegram stamps `auth_date`; a stale blob is a replayed one. */
export const MAX_INIT_DATA_AGE_MS = 24 * 60 * 60 * 1000;

export interface InitDataResult {
  readonly ok: boolean;
  /** Telegram user id, only when `ok`. */
  readonly userId?: number;
  /** Why it failed. For the LOG, never for the response body — see the route. */
  readonly reason?: 'malformed' | 'no-hash' | 'bad-signature' | 'stale' | 'no-user';
}

/**
 * Verify an initData query string and extract the user id.
 *
 * Returns a verdict rather than throwing: every failure here is an untrusted input, and an
 * exception path would be one refactor away from a 500 that says which part was wrong.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = MAX_INIT_DATA_AGE_MS,
): InitDataResult {
  if (typeof initData !== 'string' || initData.length === 0 || botToken.length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no-hash' };

  // The data-check string: every field EXCEPT `hash`, sorted, joined by newlines. Values are used
  // decoded — URLSearchParams has already done that, which is what Telegram's spec expects.
  const pairs: string[] = [];
  for (const [k, v] of params) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  // Constant-time. A byte-by-byte early exit on a MAC check is a timing oracle, and this one
  // guards the identity the wallet lookup is keyed on.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };

  // FRESHNESS IS PART OF VALIDITY. A signature stays valid forever; a captured initData would
  // otherwise be a permanent credential for reading that user's linked wallet.
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: 'stale' };
  if (nowMs - authDate * 1000 > maxAgeMs) return { ok: false, reason: 'stale' };

  // `user` is a JSON blob inside the signed payload, so it is as trustworthy as the signature.
  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'no-user' };
  let userId: unknown;
  try {
    userId = (JSON.parse(userRaw) as { id?: unknown }).id;
  } catch {
    return { ok: false, reason: 'no-user' };
  }
  if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0) {
    return { ok: false, reason: 'no-user' };
  }

  return { ok: true, userId };
}
