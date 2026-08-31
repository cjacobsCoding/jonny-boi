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
 * Nothing here decides what a clause *means*; that is the rule table's job. The
 * one structured reader that lives here — {@link parseManaSymbols} — is still pure
 * transcription: `{1}{G}` into the cost the engine charges, with no opinion about
 * what the cost is for.
 */

import type { ManaCost } from '@jonny-boi/core';
import { MANA_COLORS } from '@jonny-boi/core';

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
  // Printed one card at a time, like the subtype table: "twenty or more
  // artifacts" (Hellkite Tyrant), "thirteen cards in your hand" (Triskaidekaphile).
  thirteen: 13,
  twenty: 20,
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
 * Parse a printed run of mana symbols (`{1}{G}`, `{3}`) into a `ManaCost`.
 *
 * Returns `null` for ANY symbol the engine cannot pay from a pool — hybrid,
 * Phyrexian, `{X}` — so a cost containing one is never half-read into something
 * cheaper than printed; the clause carrying it stays reported instead.
 *
 * One parser, three callers (equip costs, activation costs, "unless its
 * controller pays {N}"). It used to be two identical private copies, one in
 * `./rules` and one in `./compile`, which is precisely the shape a rule gains in
 * one place and not the other.
 */
/**
 * The bare symbols of a printed cost run, uppercased: `{X}{R}{R}` becomes
 * `['X','R','R']`.
 *
 * Transcription only, with no opinion about payability — which is exactly why
 * it is separate from {@link parseManaSymbols}. A caller that CAN pay a symbol
 * that parser refuses (a flashback cost's `{X}`, whose value is a cast-time
 * question) partitions the run here first and hands the rest on.
 */
export function splitCostSymbols(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\{([^}]+)\}/g)) out.push(match[1]!.toUpperCase());
  return out;
}

export function parseManaSymbols(text: string): ManaCost | null {
  const cost: Record<string, number> = {};
  for (const match of text.matchAll(/\{([^}]+)\}/g)) {
    const symbol = match[1]!.toUpperCase();
    if (/^\d+$/.test(symbol)) {
      cost.generic = (cost.generic ?? 0) + Number.parseInt(symbol, 10);
      continue;
    }
    if ((MANA_COLORS as readonly string[]).includes(symbol)) {
      cost[symbol] = (cost[symbol] ?? 0) + 1;
      continue;
    }
    return null;
  }
  return Object.keys(cost).length > 0 ? (cost as ManaCost) : null;
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
  // An Aura or an Equipment names itself by its SUBTYPE, not by its card type
  // ("When this Aura enters, draw a card" — Angelic Gift). Without these two the
  // phrase survives normalization and the line looks like an ability about some
  // other object, so an otherwise plain Aura reports its trigger as unknown.
  'this aura',
  'this equipment',
  'this enchantment',
  'this land',
  'this card',
  // A BATTLE names itself by its subtype in exactly the same way an Aura does
  // ("As this Siege enters, choose an opponent to protect it"). Without these the
  // phrase survives normalization, the line reads as an ability about some other
  // object, and every printed battle reports its own reminder text as unknown.
  'this siege',
  'this battle',
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
  return (
    text
      .replace(/\s+/g, ' ')
      // Scryfall's oracle text uses the straight apostrophe, but text arriving
      // from other sources (a pasted card, a test) may carry the typographic
      // one; the rule table is written with straight quotes, so fold them.
      .replace(/’/g, "'")
      .trim()
      .replace(/\.$/, '')
      .toLowerCase()
  );
}

/**
 * Split oracle text into abilities. Each printed ability is its own line on a
 * real card, which is exactly the granularity a trigger or activated ability
 * needs (a trigger's body may itself contain several sentences).
 */
export function splitAbilities(oracleText: string): string[] {
  const lines = oracleText
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return joinRevoltRiders(joinModalBlocks(lines));
}

/**
 * A modal header: "Choose one —", "Choose one or both —", "Choose up to two —",
 * and the Confluence form "Choose three. You may choose the same mode more than
 * once." — which prints a full stop instead of the dash, and is why the dash is
 * optional here rather than required.
 */
const MODAL_HEADER =
  /^choose\s+(?:one or both|one or more|any number|up to \w+|one|two|three|four|five)(?:\s+that hasn't been chosen(?:\s+this turn)?)?\s*\.?\s*(?:you may choose the same mode more than once\s*\.?\s*)?[—-]?\s*$/i;

/** The same header printed at the END of a trigger line. */
const MODAL_HEADER_AT_END =
  /,\s*choose\s+(?:one or both|one or more|any number|up to \w+|one|two|three|four|five)(?:\s+that hasn't been chosen(?:\s+this turn)?)?\s*\.?\s*[—-]\s*$/i;

/** A printed mode line, which Oracle text bullets. */
const MODE_BULLET = /^[•·]\s*/;

/**
 * Fold a modal block into ONE ability line.
 *
 * A modal card prints its header and each mode on separate lines, so the plain
 * newline split hands the compiler "Choose one —" with no modes attached and
 * then a series of orphan bullets. Neither half means anything alone. Joining
 * them lets a single rule see the header and its modes together, which is the
 * only way to build the mode list the `modal` primitive needs.
 *
 * Modes are joined with their bullet retained as the separator, so the rule can
 * split them back apart unambiguously — a mode's own text may contain anything
 * else, but never a bullet.
 */
function joinModalBlocks(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // A modal TRIGGER prints its header at the END of the trigger line
    // ("Whenever a land you control enters, choose one —") — same fold, so
    // one rule can see the trigger, its header and its modes together.
    if (!MODAL_HEADER.test(line) && !MODAL_HEADER_AT_END.test(line)) {
      out.push(line);
      continue;
    }
    const modes: string[] = [];
    let j = i + 1;
    while (j < lines.length && MODE_BULLET.test(lines[j]!)) {
      modes.push(lines[j]!.replace(MODE_BULLET, '').trim());
      j += 1;
    }
    // A header with no bullets is not a modal block — leave it exactly as found
    // so it reports as unrecognized rather than compiling to an empty choice.
    if (modes.length === 0) {
      out.push(line);
      continue;
    }
    // The rule table's pattern wants the header, a dash, then the bullets. A
    // header printed WITHOUT a dash (the Confluence form) gets one supplied
    // here, so one rule reads both printings rather than two nearly-identical
    // patterns drifting apart.
    const header = /[—-]\s*$/.test(line.trim()) ? line.trim() : `${line.trim()} —`;
    out.push(`${header} ${modes.map((mode) => `• ${mode}`).join(' ')}`);
    i = j - 1;
  }
  return out;
}

/**
 * An ability-word rider that MODIFIES the line above it rather than standing on
 * its own. Revolt is the shape: Fatal Push prints "Destroy target creature if
 * it has mana value 2 or less." and then, on its own line, "Revolt — Destroy
 * that creature if it has mana value 4 or less **instead** if a permanent left
 * the battlefield under your control this turn."
 *
 * The second line is meaningless alone — "that creature" has no referent, and
 * compiling the two independently would destroy twice. So it is joined onto the
 * previous line, exactly as {@link joinModalBlocks} joins a modal header to its
 * bullets, and ONE rule then sees the whole idiom.
 *
 * A rider with no line above it is left exactly as found, so it reports as
 * unrecognized rather than silently attaching to nothing.
 */
const RIDER_PREFIX = /^(?:revolt|morbid|delirium|threshold|metalcraft)\s*[—-]\s*/i;

function joinRevoltRiders(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (RIDER_PREFIX.test(line) && out.length > 0) {
      const previous = out[out.length - 1] as string;
      out[out.length - 1] = `${previous.replace(/\.$/, '')}. ${line}`;
      continue;
    }
    out.push(line);
  }
  return out;
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
