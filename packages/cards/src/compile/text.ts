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
 * A printed amount that may also be the letter **X** (DESIGN §3.149) — "~ deals
 * X damage to each creature, where X is the number of …" (Chain Reaction),
 * "{X}, {T}: Target player mills X cards" (Sands of Delirium).
 *
 * The SAME alternation as {@link COUNT_TOKEN} plus one letter, so a rule that
 * takes an amount reads one token and the "is it a number or an X" question is
 * asked in exactly one place (`parseAmount` in `rules.ts`). Two tokens with two
 * parsers is how "deals X damage to each creature" would end up legal and
 * "deals X damage to each opponent" reported.
 *
 * A rule keeps {@link COUNT_TOKEN} when an X genuinely cannot appear there — a
 * characteristic-defining P/T offset, a printed counter count, a mana amount.
 */
export const AMOUNT_TOKEN = `(${Object.keys(NUMBER_WORDS).join('|')}|\\d+|x)`;

/**
 * Read a signed integer out of printed text — "+2", "-4", "-0".
 *
 * ⚠️ THE `+ 0` IS THE WHOLE POINT, and it fixes a bug that only a bigger card
 * pool could expose. `Number.parseInt('-0', 10)` is NEGATIVE ZERO, and Befuddle
 * prints "gets -4/-0". Negative zero is the same NUMBER as zero and behaves
 * identically in every arithmetic the engine does — but `JSON.stringify(-0)` is
 * `"0"`, so a definition holding it can never survive being written to the
 * generated pool and read back. The card's stored data said `0`, a fresh compile
 * said `-0`, and the ground-truth test that compares them failed on two values
 * that are equal by `===` and unequal by `Object.is`.
 *
 * Adding zero normalises `-0` to `0` and leaves every other value untouched, so
 * the fix lives at the ONE place printed text becomes a signed number rather
 * than at the twenty rules that read one.
 */
export function parseSignedInt(text: string | undefined): number {
  return Number.parseInt(text ?? '', 10) + 0;
}

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
  return resolveAbilityWords(joinModalBlocks(lines));
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
 * ABILITY WORDS (CR 207.2c) — the italicised label printed in front of a line.
 * It has **no rules meaning**: everything the ability does is spelled out in the
 * line itself, and the word only ties a cycle together for flavour.
 *
 * Derived from the printed corpus rather than from memory — every entry is a
 * label this compiler has actually seen at the head of a real card's line.
 *
 * ⚠️ The table is CLOSED, and what it LEAVES OUT is the point. Plenty of labels
 * print in the same italic-word-then-dash shape while carrying real rules:
 * a Saga's `I` / `II` / `III` are chapter abilities; `Channel`, `Exhaust`,
 * `Boast`, `Bloodrush`, `Forecast` and `Companion` are keyword abilities with
 * their own costs and timing; `Max speed` is a condition on the speed counter;
 * `To solve` / `Solved` are a Case's two halves; `Eminence` works from the
 * command zone. Stripping any of those would delete rules the card depends on
 * and leave a card that looks implemented and is not — so they stay out and
 * keep reporting honestly (CLAUDE.md §2: a value outside the table reports
 * rather than being widened to fit).
 */
export const ABILITY_WORD_LIST: readonly string[] = [
  'addendum',
  'adamant',
  'alliance',
  'battalion',
  'celebration',
  'chroma',
  'cohort',
  'constellation',
  'converge',
  "council's dilemma",
  'corrupted',
  'coven',
  'delirium',
  'domain',
  'eerie',
  'enrage',
  'fateful hour',
  'fathomless descent',
  'ferocious',
  'flurry',
  'formidable',
  'grandeur',
  'hellbent',
  'heroic',
  'imprint',
  'inspired',
  'join forces',
  'kinship',
  'landfall',
  'lieutenant',
  'magecraft',
  'metalcraft',
  'morbid',
  'pack tactics',
  'parley',
  'radiance',
  'raid',
  'rally',
  'revolt',
  'secret council',
  'spell mastery',
  'strive',
  'survival',
  'sweep',
  'tempting offer',
  'threshold',
  'undergrowth',
  'valiant',
  'void',
  'will of the council',
];

/**
 * The label as printed, at the head of a line. Longest-first so "fathomless
 * descent" is never matched as a bare word from a shorter entry, and both
 * apostrophes are accepted because the corpus prints the typographic one while
 * the table is written with the straight one.
 */
const ABILITY_WORD_LABEL = new RegExp(
  `^(?:${[...ABILITY_WORD_LIST]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/'/g, "['’]"))
    .join('|')})\\s*[—–-]\\s*`,
  'i',
);

/**
 * A RIDER is an ability-word line that modifies the line above it instead of
 * standing on its own. Fatal Push is the shape: it prints "Destroy target
 * creature if it has mana value 2 or less." and then, on its own line, "Revolt —
 * Destroy that creature if it has mana value 4 or less **instead** if a
 * permanent left the battlefield under your control this turn."
 *
 * That second line is meaningless alone — "that creature" has no referent and
 * compiling the two independently would destroy twice — so it is joined onto the
 * previous line, exactly as {@link joinModalBlocks} joins a modal header to its
 * bullets, and ONE rule then sees the whole idiom.
 *
 * ⚠️ A rider is the RARE case, and treating every ability-word line as one was a
 * real bug worth remembering: the join used to fire on the WORD alone, so
 * "Revolt — When this creature enters, … you gain 5 life" was glued to the
 * keyword line above it as "Flying. Revolt — When ~ enters, …" — a sentence no
 * rule can ever match, on a card whose body the compiler already understood.
 * Hundreds of ability-word cards were unreachable for that reason alone.
 *
 * So the join is keyed on the line being UNABLE to stand alone. Two markers
 * prove that: a dangling demonstrative with no antecedent ("Destroy THAT
 * creature"), or an "…instead" that must be replacing something already said.
 *
 * ⚠️ "instead" alone is not enough, and reading it that way glued Akoum Hellkite
 * ("Landfall — Whenever a land you control enters, ~ deals 1 damage to any
 * target. If that land is a Mountain, ~ deals 2 damage instead.") to the keyword
 * line above it. That "instead" replaces the line's OWN first sentence, not the
 * line above — so it only counts in the FIRST sentence, and only on a line that
 * does not open an ability of its own.
 */
const DANGLING_DEMONSTRATIVE = /^(?:that|those)\b/i;
const INSTEAD = /\binstead\b/i;

/**
 * The openers that begin a self-contained ability: a triggered ability's
 * "when/whenever/at", an activated ability's cost-then-colon, or a static one
 * whose subject is the card itself. A line starting any of these says what it
 * does without help from the line above, whatever else it goes on to say.
 */
const STANDALONE_OPENER = /^(?:when\b|whenever\b|at\b|~\b|[^.:]{1,80}:)/i;

/**
 * Fold ability-word labels away (CR 207.2c), joining the rare rider onto the
 * line it modifies and stripping the label off every line that stands alone —
 * so the rule table sees the ABILITY, which is all the label was ever hiding.
 *
 * A rider with no line above it is left exactly as found, label included, so it
 * reports as unrecognized rather than silently attaching to nothing.
 */
function resolveAbilityWords(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const label = ABILITY_WORD_LABEL.exec(line);
    if (label === null) {
      out.push(line);
      continue;
    }
    const body = line.slice(label[0].length);
    const firstSentence = body.split(/(?<=\.)\s+/, 1)[0] ?? body;
    const rider =
      DANGLING_DEMONSTRATIVE.test(body) ||
      (INSTEAD.test(firstSentence) && !STANDALONE_OPENER.test(body));
    if (!rider) {
      out.push(body);
      continue;
    }
    // A rider with no line above it is left exactly as found, label included, so
    // it reports as unrecognized rather than silently attaching to nothing.
    if (out.length === 0) {
      out.push(line);
      continue;
    }
    const previous = out[out.length - 1] as string;
    out[out.length - 1] = `${previous.replace(/\.$/, '')}. ${line}`;
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
