import { z } from 'zod';

/**
 * INVARIANT 5: secrets only from env. This module is the ONLY place that reads
 * `process.env`. It never puts a value into an error message — validation
 * failures report the variable name and the reason, never what was in it.
 */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const boolVar = (dflt: boolean) =>
  z
    .enum(['true', 'false', '1', '0'], { message: 'must be true or false' })
    .transform((v) => v === 'true' || v === '1')
    .default(dflt ? 'true' : 'false');

const EnvSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z
      .string({ message: 'is required' })
      .min(1, 'is required')
      .regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'is not a valid bot token (expected "<id>:<secret>")'),

    HELIUS_API_KEY: z.string({ message: 'is required' }).min(1, 'is required'),
    HELIUS_RPC_URL: z
      .string({ message: 'is required' })
      .url('must be a URL')
      .refine((v) => v.startsWith('https://'), 'must be https://'),
    HELIUS_WS_URL: z
      .string({ message: 'is required' })
      .url('must be a URL')
      .refine((v) => v.startsWith('wss://'), 'must be wss://'),

    DEFAULT_MINT: z
      .string({ message: 'is required' })
      .regex(BASE58, 'must be a base58 mint address (32-44 chars)'),

    DB_PATH: z.string({ message: 'is required' }).min(1, 'is required'),

    HTTP_PORT: z.coerce
      .number({ message: 'must be a number' })
      .int('must be an integer')
      .min(1, 'must be 1-65535')
      .max(65535, 'must be 1-65535')
      .default(3012),

    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'], {
        message: 'must be one of trace|debug|info|warn|error|fatal',
      })
      .default('info'),

    /** INVARIANT 4: read-only to this process. The sync job owns this folder. */
    MEDIA_ROOT: z.string({ message: 'is required' }).min(1, 'is required'),
    MEDIA_SOURCE: z.enum(['local', 'http'], { message: 'must be local or http' }).default('local'),
    MEDIA_MANIFEST_URL: z.string().url('must be a URL').optional(),
    /** Private chat the bot uploads media into once, to mint a reusable file_id. */
    MEDIA_VAULT_CHAT_ID: z.coerce
      .number({ message: 'must be a numeric Telegram chat id' })
      .int('must be an integer')
      .optional(),

    /** ws = Enhanced WebSocket (default). webhook = Helius POSTs to us. */
    INGEST_MODE: z.enum(['ws', 'webhook'], { message: 'must be ws or webhook' }).default('ws'),
    /** Shared secret Helius sends in the Authorization header. Required for webhook mode. */
    WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 chars').optional(),

    /** What a stablecoin quote is worth in USD. A depeg is not ours to paper over. */
    STABLE_USD: z.coerce.number({ message: 'must be a number' }).positive('must be > 0').default(1.0),
    /** Value whale holdings on the post-trade balance (default) or the pre-trade one. */
    WHALE_BASIS: z.enum(['post', 'pre'], { message: 'must be post or pre' }).default('post'),

    /**
     * The bot owner's Telegram user id. May curate every mint, and is the only identity
     * that can when no group has been configured yet (the bootstrap case).
     * Optional: without it, only verified group admins can curate — which is the safe
     * default, not a degraded one.
     */
    OWNER_USER_ID: z.coerce.number({ message: 'must be a numeric Telegram user id' }).int().optional(),

    /**
     * Optional per-chat daily card cap. OFF by default, and deliberately so: a cap that
     * silently stops posting is indistinguishable, from inside the group, from a bot that
     * has broken. It exists for the operator who explicitly wants it.
     */
    DAILY_SEND_CAP: z.coerce.number({ message: 'must be a number' }).int().positive().optional(),

    /**
     * Chat ids that are ALWAYS treated as paid, regardless of what the DB says.
     * Comma-separated, e.g. `PLAN_WHITELIST=-1001234567890,-1009876543210`.
     *
     * For your own groups, partners, and anyone you have decided does not pay. It is an
     * OVERRIDE, not a grant: it is not written to the DB, so removing an id from this list
     * removes the entitlement on the next restart, cleanly and with no state to unpick.
     *
     * Use /grant for a plan somebody actually bought — that IS recorded, with who and when,
     * because a sale is a fact and this is a policy.
     */
    PLAN_WHITELIST: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? '')
          .split(',')
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isInteger(n) && n !== 0),
      ),

    BACKFILL_POSITIONS: boolVar(true),
    /** INVARIANT 7: render to stdout, send nothing. */
    DRY_RUN: boolVar(false),

    // --- Autotrader, phase 12 (INVARIANTS 14-18) -------------------------------------------
    //
    // OFF unless explicitly enabled. Holding other people's signing keys is not something an
    // operator should acquire by upgrading.
    AUTOTRADER: boolVar(false),

    /**
     * Where per-user keystores live. One encrypted file per user, 0600, owned by the bot's
     * own system user — which is the whole reason the bot does not run as `deploy` (see
     * INVARIANT 4's note): `deploy` runs two public-facing Next apps.
     */
    KEYSTORE_DIR: z.string().min(1).default('/var/lib/ricebuybot/keystores'),

    /**
     * ENV_UNLOCK, and ONLY for the owner's own keystore (INVARIANT 16).
     *
     * Nobody else's passphrase belongs in your environment file — not as a convenience and not
     * temporarily. The restriction is enforced structurally in `trade/unlock.ts`, which
     * compares against OWNER_USER_ID rather than taking a parameter; this variable is just
     * where the owner's own secret is read from.
     *
     * Leaving it unset is the safer configuration: every wallet, including the owner's, then
     * requires a DM unlock after a restart.
     */
    OWNER_KEYSTORE_PASSPHRASE: z.string().min(8, 'must be at least 8 chars').optional(),
  })
  .superRefine((env, ctx) => {
    if (env.INGEST_MODE === 'webhook' && !env.WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEBHOOK_SECRET'],
        message: 'is required when INGEST_MODE=webhook (the endpoint is public)',
      });
    }
    if (env.MEDIA_SOURCE === 'http' && !env.MEDIA_MANIFEST_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MEDIA_MANIFEST_URL'],
        message: 'is required when MEDIA_SOURCE=http',
      });
    }
    // A passphrase in the env with no owner to own it is a secret sitting there for nothing.
    if (env.OWNER_KEYSTORE_PASSPHRASE !== undefined && env.OWNER_USER_ID === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OWNER_USER_ID'],
        message: 'is required when OWNER_KEYSTORE_PASSPHRASE is set (env unlock is owner-only)',
      });
    }
    if (!env.DRY_RUN && env.MEDIA_VAULT_CHAT_ID === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MEDIA_VAULT_CHAT_ID'],
        message: 'is required unless DRY_RUN=true (needed to upload media and mint file_ids)',
      });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

/**
 * In an env file, `FOO=` means "not set", not "set to empty string". Node's
 * --env-file parser (and most shells) hand us `''`, which would otherwise fail
 * optional-field validation and defeat every `.default()` below.
 */
function dropEmpty(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v.trim() !== '') out[k] = v.trim();
  }
  return out;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Validate an env bag. Throws ConfigError listing EVERY problem at once — a boot
 * with five missing vars reports five, not the first one.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(dropEmpty(source));
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `${name} ${issue.message}`;
    })
    .sort();

  throw new ConfigError([...new Set(problems)]);
}

let cached: Config | null = null;

/** Process-wide config. Validated once, on first call. */
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test-only. Clears the memoized config so a fresh env can be loaded. */
export function resetConfigForTests(): void {
  cached = null;
}
