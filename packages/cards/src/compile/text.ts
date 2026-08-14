/**
 * Oracle-text normalization for the compiler. Pure string work, no card
 * knowledge — turning printed rules text into the canonical, lowercased clause
 * form the rule table in `./rules.ts` matches against.
 *
 * The canonical form makes patterns readable and stable:
 *   - reminder text (always parenthesized on real cards) is removed;
 *   - the card's own name — including the legendary short name ("Liliana" for
 *     "Liliana of the Veil") — becomes `~`, so one pattern matches every card;
 *   - whitespace collapses, the trailing period goes, everything lowercases.
 *
 * Nothing here decides what a clause *means*; that is the rule table's job.
 */

/**
 * Number words Oracle text uses for counts, mapped to their values. Oracle never
 * spells out counts above ten in the templates we compile, and "a"/"an" mean one
 * ("draw a card"). Data, not inline literals scattered through the patterns.
 */
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  x: Number.NaN, // "X" is a chosen value — deliberately not a number we can use.
});

/** The regex alternation of every count token a pattern may capture. */
export const COUNT_TOKEN = `(${Object.keys(NUMBER_WORDS).join('|')}|\\d+)`;

/**
 * Resolve a captured count token ("a", "three", "2") to a number. Returns `null`
 * for anything without a fixed value (notably "X"), so a rule can decline to
 * compile rather than guess a magnitude.
 */
export function parseCount(token: string | undefined): number | null {
  if (!token) return null;
  const word = token.trim().toLowerCase();
  if (/^\d+$/.test(word)) return Number.parseInt(word, 10);
  const value = NUMBER_WORDS[word];
  return value !== undefined && Number.isFinite(value) ? value : null;
}

/**
 * Remove reminder text. On real cards reminder text is always fully
 * parenthesized, so dropping balanced parenthetical spans is safe and removes a
 * large amount of text that would otherwise look like unmatched rules.
 */
export function stripReminderText(text: string): string {
  return text.replace(/\([^)]*\)/g, ' ');
}

/**
 * Modern Oracle templating refers to the card as "this creature" / "this
 * permanent" rather than repeating its name (compare Kitchen Finks' printed
 * "When this creature enters…"). These phrases mean exactly what `~` means, so
 * they normalize to the same token — without this, every recently-templated card
 * would look like an unrecognized ability.
 */
const SELF_PHRASES: readonly string[] = [
  'this creature',
  'this permanent',
  'this artifact',
  'this enchantment',
  'this land',
  'this card',
];

/**
 * Replace every reference to the card's own name with `~`. Oracle text refers to
 * a card by its full name; legendary cards also use the short name before the
 * comma or "of" ("Liliana of the Veil" → also "Liliana"); double-faced cards
 * carry a combined "Front // Back" name whose faces are each referenced alone.
 * Longest form first so a full name wins over its own prefix.
 */
export function selfReference(text: string, cardName: string): string {
  const forms = new Set<string>([cardName]);
  for (const face of cardName.split(' // ')) {
    const trimmed = face.trim();
    if (trimmed.length > 0) forms.add(trimmed);
    const shortName = trimmed.split(/,| of /)[0]?.trim();
    if (shortName && shortName.length > 0) forms.add(shortName);
  }
  let out = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    out = out.split(form).join('~');
  }
  // Possessives ("~'s power") and the modern self-phrases both fold into `~`.
  for (const phrase of SELF_PHRASES) {
    out = out.replace(new RegExp(phrase, 'gi'), '~');
  }
  return out;
}

/** The face a combined "Front // Back" card name refers to when played. */
export function frontFaceName(cardName: string): string {
  return cardName.split(' // ')[0]?.trim() ?? cardName;
}

/** Collapse whitespace, lowercase, and drop a trailing period. */
export function normalizeClause(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .toLowerCase();
}

/**
 * Split oracle text into abilities. Each printed ability is its own line on a
 * real card, which is exactly the granularity a trigger or activated ability
 * needs (a trigger's body may itself contain several sentences).
 */
export function splitAbilities(oracleText: string): string[] {
  return oracleText
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Split a non-triggered ability into its individual effect sentences, so
 * "Destroy target creature. You gain 2 life." compiles as two effects. Splits on
 * a period followed by whitespace; abbreviations do not occur in the templates
 * we compile.
 */
export function splitSentences(ability: string): string[] {
  return ability
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Full preparation: strip reminder text, self-reference the name, and split into
 * normalized abilities ready for the rule table.
 */
export function prepareOracle(oracleText: string, cardName: string): string[] {
  const cleaned = selfReference(stripReminderText(oracleText), cardName);
  return splitAbilities(cleaned).map((ability) =>
    ability.replace(/\s+/g, ' ').trim(),
  );
}
