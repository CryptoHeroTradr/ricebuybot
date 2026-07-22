/**
 * The Telegram entity shapes we emit. PURE — `render/` never imports grammY.
 *
 * WHY ENTITIES AND NOT `parse_mode: 'HTML'`.
 *
 * Telegram accepts EITHER a parse_mode OR an explicit entities array, never both. The
 * emoji ladder needs `custom_emoji` entities, so the whole caption is built as plain
 * text plus offsets. That also kills a class of bug outright: with HTML, a token symbol
 * or a group's headline containing `<` or `&` silently corrupts the markup (or gets the
 * message rejected). With entities there is nothing to escape, because there is no
 * markup — the text is the text.
 *
 * EVERY OFFSET AND LENGTH IS IN UTF-16 CODE UNITS. See utf16Length().
 */
export type MessageEntity =
  | { readonly type: 'bold'; readonly offset: number; readonly length: number }
  | { readonly type: 'text_link'; readonly offset: number; readonly length: number; readonly url: string }
  | {
      readonly type: 'custom_emoji';
      readonly offset: number;
      readonly length: number;
      readonly custom_emoji_id: string;
    };

/**
 * A caption under construction: text, plus entities whose offsets track it.
 *
 * The offsets are the entire reason this exists. Building the string first and then
 * hunting for substrings to decorate (`text.indexOf('$23.29')`) is how you decorate the
 * WRONG "$23.29" when the same figure appears twice on a card. Here an entity's offset
 * is recorded at the moment its text is appended, so it cannot be wrong.
 */
export class Caption {
  #text = '';
  readonly #entities: MessageEntity[] = [];

  /** Current UTF-16 length — i.e. the offset the next appended text will start at. */
  get offset(): number {
    return this.#text.length;
  }

  get text(): string {
    return this.#text;
  }

  get entities(): readonly MessageEntity[] {
    return this.#entities;
  }

  /** Plain text. */
  add(s: string): this {
    this.#text += s;
    return this;
  }

  /** Text, wrapped in a bold entity. */
  bold(s: string): this {
    this.#entities.push({ type: 'bold', offset: this.offset, length: s.length });
    return this.add(s);
  }

  /** Text, wrapped in a link entity. */
  link(s: string, url: string): this {
    this.#entities.push({ type: 'text_link', offset: this.offset, length: s.length, url });
    return this.add(s);
  }

  /** Pre-built entities (the ladder), whose offsets the caller computed from `offset`. */
  addWithEntities(s: string, entities: readonly MessageEntity[]): this {
    this.#entities.push(...entities);
    return this.add(s);
  }

  nl(): this {
    return this.add('\n');
  }
}
