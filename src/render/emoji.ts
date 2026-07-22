import type { MessageEntity } from './entities.js';

/**
 * The emoji ladder. PURE.
 *
 * count = clamp(floor(usdIn / stepUsd), 1, maxEmojis)
 *
 * At the $10 default step: $23.29 -> 2, $94 -> 9. The floor is 1, not 0 — a buy that
 * cleared min_buy_usd always gets at least one grain, or the signature feature just
 * silently isn't there on the smallest cards.
 */
export function ladderCount(usdIn: number, stepUsd: number, maxEmojis: number): number {
  if (!Number.isFinite(usdIn) || !Number.isFinite(stepUsd) || stepUsd <= 0) return 1;
  const raw = Math.floor(usdIn / stepUsd);
  return Math.max(1, Math.min(maxEmojis, raw));
}

/**
 * UTF-16 code units, which is the ONLY length Telegram's entity offsets are measured in.
 *
 * `'🍚'.length === 2`. `[...'🍚'].length === 1`. A grapheme like '👨‍👩‍👧' is 8. If you
 * count characters (or code points) and hand Telegram the result, every entity after the
 * first multi-unit emoji lands on the wrong slice of the string — and the failure is
 * SILENT: the message sends, the custom emoji just render over the wrong characters, or
 * bleed into the text after the ladder.
 *
 * `String.prototype.length` IS the UTF-16 count in JS. That is the whole trick, and the
 * bug is writing anything cleverer.
 */
export function utf16Length(s: string): number {
  return s.length;
}

export interface LadderOpts {
  readonly usdIn: number;
  readonly stepUsd: number;
  readonly maxEmojis: number;
  /** The unicode emoji. ALWAYS used as the literal text — see below. */
  readonly emoji: string;
  /** When set, a custom_emoji entity is laid over each repetition. */
  readonly customEmojiId?: string | null;
  /**
   * UTF-16 units the ladder may occupy. The caller computes this from what is LEFT of
   * the caption budget once the stats are laid out — the stats are never truncated.
   */
  readonly budgetUtf16: number;
  /** UTF-16 offset of the ladder within the finished caption. */
  readonly offset: number;
}

export interface Ladder {
  readonly text: string;
  readonly entities: readonly MessageEntity[];
  readonly count: number;
  /** True when the caption budget forced a shorter ladder than the buy earned. */
  readonly truncated: boolean;
}

/**
 * Build the ladder text and its entities.
 *
 * THE UNICODE EMOJI IS ALWAYS THE TEXT, custom or not. A `custom_emoji` entity does not
 * replace text; it decorates it. Telegram renders the custom emoji over the underlying
 * character, and any client that cannot render it — an old app, a web preview, a
 * notification, a screenshot bot — shows the underlying character instead. So the
 * fallback is not a code path we maintain, it is simply what the text already says. Emit
 * a placeholder like '.' underneath and every non-premium surface shows a row of dots.
 *
 * TRUNCATION SHORTENS THE LADDER, NEVER THE STATS. A 1024-char caption ceiling with a
 * $1M buy at a $1 step would otherwise push the market cap off the end of the card. The
 * numbers are the message; the ladder is the flourish.
 */
export function buildLadder(opts: LadderOpts): Ladder {
  const wanted = ladderCount(opts.usdIn, opts.stepUsd, opts.maxEmojis);
  const unit = utf16Length(opts.emoji);

  // How many repetitions actually fit? At least one: a ladder of zero emoji is not a
  // shorter ladder, it is a missing feature, and one emoji costs at most a few units.
  const affordable = unit > 0 ? Math.floor(opts.budgetUtf16 / unit) : wanted;
  const count = Math.max(1, Math.min(wanted, affordable));

  const text = opts.emoji.repeat(count);

  const entities: MessageEntity[] = [];
  if (opts.customEmojiId) {
    // One entity PER repetition, each exactly `unit` UTF-16 units wide. Telegram
    // requires a custom_emoji entity to cover exactly one emoji — a single entity
    // spanning the whole ladder is rejected.
    for (let i = 0; i < count; i++) {
      entities.push({
        type: 'custom_emoji',
        offset: opts.offset + i * unit, // <- UTF-16, cumulative. The trap.
        length: unit,
        custom_emoji_id: opts.customEmojiId,
      });
    }
  }

  return { text, entities, count, truncated: count < wanted };
}
