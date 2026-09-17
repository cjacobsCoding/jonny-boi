/**
 * WHERE A DECK CAME FROM, and how every surface that lists decks says so.
 *
 * ## The defect this exists for
 *
 * A user renamed their copy of "Selesnya Blink" to "Acidic Angels" and filed a
 * bug: *the app duplicated my deck*. Nothing duplicated. Selesnya Blink is one
 * of the six BUILT-IN gauntlet decks; it is always listed, it was always there,
 * and the copy they renamed was a seventh deck they had made minutes earlier.
 *
 * The reason that was indistinguishable from a duplication bug is that the
 * built-in list was deliberately styled to look like the user's own — the old
 * `gauntlet-decks.css` header said so in as many words: *"reuses `.saved-decks`
 * … so it sits visually with the user's own decks rather than looking like a new
 * region."* Two different kinds of thing, rendered identically, in one column.
 *
 * ## The rule this module encodes
 *
 * A built-in deck is REFERENCE DATA you can copy. A saved deck is YOURS: you can
 * rename it, edit it, delete it. Those are different nouns and they must never
 * again be rendered the same way. Because the ambiguity appeared on more than one
 * surface (the builder's list AND the Play/online deck pickers), the answer lives
 * in ONE closed table that every surface reads — add a surface, read this row,
 * and it is marked correctly by construction (CLAUDE.md rules 2 and 12).
 *
 * Nothing here removes a capability: a built-in deck is still copyable, and still
 * directly PLAYABLE from the Play setup. This is about identity, not access.
 */

/**
 * The kinds of deck a list can hold. Closed on purpose — see
 * {@link originPresentation}.
 *
 * ⚠️ **There are TWO, and a third was tried and rejected.** An `owner` origin
 * was added for the owner's transcribed paper decks, which gave them their own
 * region, their own badge and their own legality rules. His verdict: *"why is
 * there a 'your paper decks' and 'your decks' - this is dumb. I just want one
 * collection of decks and I must be able to edit all of them, regardless of
 * whether scanned in."*
 *
 * He is right, and the rule generalises: **how a deck arrived is not a kind of
 * deck.** Scanned, transcribed, imported, pasted or built card by card, the
 * result is a deck he owns — `mine`. The only genuine second noun is the
 * built-in gauntlet, which he does not own and which the Lab measures every
 * verdict against. A transcription now seeds a `mine` deck at first run
 * (`decklist/paperDecks.ts`); it never becomes a row here.
 */
export type DeckOrigin = 'builtin' | 'mine';

/** How one origin presents itself, everywhere it is shown. */
export interface DeckOriginPresentation {
  readonly origin: DeckOrigin;
  /**
   * Short badge text rendered beside the deck's name. Empty for decks that are
   * the user's own: badging every one of your decks "Yours" is noise, and the
   * distinction only has to be carried by the thing that is NOT yours.
   */
  readonly badge: string;
  /** Glyph shown with the badge. Empty when {@link badge} is. */
  readonly glyph: string;
  /** Why the badge is there — the title/aria text, so the answer is one hover away. */
  readonly explanation: string;
  /** Heading for the group when both origins share one list or one `<select>`. */
  readonly groupLabel: string;
  /**
   * Suffix appended to a deck's label in a flat `<option>`, where a badge cannot
   * be rendered at all — an `<option>` may only contain text.
   */
  readonly labelSuffix: string;
  /**
   * The sentence shown UNDER a deck `<select>` once this kind of deck is the
   * current pick. A collapsed `<select>` shows only the chosen label, and the
   * `<optgroup>` heading that made it unambiguous is no longer on screen — this
   * is what keeps the pick from being a surprise.
   *
   * Empty for the user's own decks: there is nothing to explain about picking
   * your own deck, and a note under every choice would be noise.
   */
  readonly pickerNote: string;
}

/**
 * The closed table. A new kind of deck (a shared deck, a downloaded one) is a
 * ROW here plus its `DeckOrigin` member, never a branch at a call site.
 *
 * ⚠️ **KEY ORDER IS RENDER ORDER.** `DeckMenuOptions` walks `Object.keys` of this
 * object to lay out the `<optgroup>`s, so moving a row moves a group in every
 * deck picker in the app. `mine` sits first deliberately: his own decks are the
 * ones he is reaching for, and burying them under nine gauntlet decks is the
 * same mistake in a smaller place.
 */
export const DECK_ORIGINS: Readonly<Record<DeckOrigin, DeckOriginPresentation>> = Object.freeze({
  mine: Object.freeze({
    origin: 'mine',
    badge: '',
    glyph: '',
    explanation: 'One of your own decks — rename, edit or delete it freely.',
    groupLabel: 'Your decks',
    labelSuffix: 'yours',
    pickerNote: '',
  }),
  builtin: Object.freeze({
    origin: 'builtin',
    badge: 'Built-in',
    glyph: '🔒',
    explanation:
      'A built-in gauntlet deck that ships with the app. It is not one of your decks: ' +
      'it cannot be renamed, edited or deleted — copy it to get one of your own.',
    groupLabel: 'Built-in gauntlet decks',
    labelSuffix: 'built-in',
    pickerNote: 'You can play it as-is. To tune it, copy it in the Deck Builder.',
  }),
});

/**
 * The DOM attribute every deck row and option carries, naming its origin.
 *
 * One constant read by the components, by the CSS (`[data-deck-origin='builtin']`)
 * and by the guard tests, so "is this row marked?" has exactly one answer. A
 * marker in the MARKUP rather than a class name alone because the guard has to be
 * able to assert that a user's deck does NOT carry the built-in treatment, and a
 * missing class is indistinguishable from a renamed one.
 */
export const DECK_ORIGIN_ATTR = 'data-deck-origin';

/**
 * Look up an origin's presentation.
 *
 * CLOSED: an origin outside the table REPORTS rather than being widened to the
 * nearest row that happens to exist. Falling back to `mine` would silently label
 * reference data as the user's own, which is the exact defect this module was
 * written to stop.
 */
export function originPresentation(origin: DeckOrigin): DeckOriginPresentation {
  const row = DECK_ORIGINS[origin];
  if (!row) {
    throw new Error(
      `Unknown deck origin "${String(origin)}" — add a row to DECK_ORIGINS rather than defaulting it.`,
    );
  }
  return row;
}

/**
 * The `origin` of a deck, from its id.
 *
 * Deliberately id-based and not name-based: the user in the bug report RENAMED
 * their copy, and a name-based answer would have called "Acidic Angels" a deck of
 * their own only until they happened to name one "Selesnya Blink".
 */
export function originOfDeckId(id: string, isBuiltinId: (id: string) => boolean): DeckOrigin {
  return isBuiltinId(id) ? 'builtin' : 'mine';
}
