/**
 * The compiler's RULE TABLE — printed Oracle templates mapped to real engine
 * behavior, as DATA (DESIGN §1.1: adding coverage is a table edit, not an engine
 * change). Each rule owns one printed template and builds the effect refs /
 * triggers / mana production that faithfully implement it using the primitives
 * registered in `../primitives.ts`.
 *
 * FAITHFULNESS IS THE WHOLE POINT. A rule exists only when the primitives can
 * reproduce the printed effect *as printed*. Where a template needs a system the
 * engine genuinely lacks — a planeswalker's loyalty, a transforming face, a
 * multikicker count — there is deliberately NO rule, and the clause
 * falls through to `missing` with a plain-English explanation from
 * {@link UNSUPPORTED_HINTS}. A rule that "sort of" models a card would silently
 * bias every A/B verdict the deck lab produces, which is worse than saying no.
 */

import type {
  BooleanKeywordName,
  CardFilter,
  CardType,
  ChosenValueSubject,
  CopyAsEntersSpec,
  CopyExceptions,
  EffectRef,
  KeywordFlags,
  ManaActivationCondition,
  ManaColor,
  ManaCost,
  ManaProduction,
  ManaSpendClause,
  ManaSpendRestriction,
  ProtectionQuality,
  ReplacementApplies,
  SpellMode,
  StaticAbility,
  StaticControllerScope,
  TargetRestriction,
  InterveningIf,
  TriggerCondition,
  TriggeredAbility,
  TriggerWho,
} from '@jonny-boi/core';
import { DEFAULT_TARGET_RESTRICTION, PLUS_ONE_COUNTER, formatManaCost, MANA_COLORS } from '@jonny-boi/core';
import type { ClauseContribution, CompileRule, RuleContext } from './types.js';
import { COUNT_TOKEN, normalizeClause, parseCount, parseManaSymbols, splitCostSymbols } from './text.js';
import { BASIC_LAND_NAMES } from '../../data/pool.js';
import { ITS_MANA_COST } from '../primitives.js';

/**
 * The CYCLING words whose search this engine can express, and the filter each
 * one means. A closed table on purpose: typecycling is only implementable when
 * the printed word names something `CardFilter` can select, and every entry here
 * is a printed LAND type (or the generic "land"), which is what the corpus's
 * typecycling cards actually print. A word outside it — a creature-type cycling
 * ("Slivercycling"), a "Wizardcycling" — has no entry, so its clause reports
 * instead of searching for approximately the right card.
 */
const TYPECYCLING_FILTERS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> =
  Object.freeze({
    plains: { anyOfSubtypes: ['plains'] },
    island: { anyOfSubtypes: ['island'] },
    swamp: { anyOfSubtypes: ['swamp'] },
    mountain: { anyOfSubtypes: ['mountain'] },
    forest: { anyOfSubtypes: ['forest'] },
    land: { anyOfTypes: ['land'] },
  });

/** The regex alternation of the cycling words above. */
const TYPECYCLING_TOKEN = Object.keys(TYPECYCLING_FILTERS).join('|');

/** Mana symbols as they appear in normalized (lowercased) Oracle text. */
const MANA_SYMBOL_TO_COLOR: Readonly<Record<string, ManaColor>> = Object.freeze({
  '{w}': 'W',
  '{u}': 'U',
  '{b}': 'B',
  '{r}': 'R',
  '{g}': 'G',
  '{c}': 'C',
});

/** The `makeToken` primitive's default count — omitted from emitted params. */
const TOKEN_DEFAULT_COUNT = 1;

/**
 * The target phrases a single-target damage spell can print, mapped to the
 * {@link TargetRestriction} that reproduces each one exactly.
 *
 * This table is the whole reason Lava Spike and Flame Slash are honest cards. The
 * compiler used to accept every phrase here and emit the SAME unrestricted
 * `dealDamage`, so "deals 4 damage to target **creature**" for one mana played as
 * a one-mana four-damage any-target spell, and "deals 3 damage to target
 * **player** or planeswalker" could kill creatures. Both played strictly better
 * than printed, which silently corrupts every A/B verdict that includes them.
 *
 * The "or planeswalker" variants map to their own restrictions now that
 * planeswalkers exist: "target player or planeswalker" may not hit a creature,
 * "target creature or planeswalker" may not hit a face, and "any target" is all
 * three (CR 115.4).
 *
 * "target **opponent**" now maps to its own `'opponent'` restriction, which the
 * engine evaluates against the caster. It used to be absent here because
 * `TargetRestriction` could say "a player" but not "a player who isn't you", and
 * flattening it to `'player'` would have let the spell be aimed at its own
 * caster — strictly more permissive than printed.
 */
const DAMAGE_TARGET_RESTRICTIONS: Readonly<Record<string, TargetRestriction>> = Object.freeze({
  'any target': 'any',
  'target creature': 'creature',
  'target player': 'player',
  'target opponent': 'opponent',
  'target creature or player': 'any',
  'target player or planeswalker': 'playerOrPlaneswalker',
  'target creature or planeswalker': 'creatureOrPlaneswalker',
  'target creature, player, or planeswalker': 'any',
  'target creature, player or planeswalker': 'any',
});

/**
 * The capturing alternation of the phrases above, longest-first so a phrase is
 * never truncated to a shorter one that happens to prefix it ("target creature"
 * inside "target creature or player"). Built FROM the table so the patterns and
 * the restrictions they mean cannot drift apart.
 */
const DAMAGE_TARGET_PHRASE = `(${Object.keys(DAMAGE_TARGET_RESTRICTIONS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/**
 * The restriction a printed target phrase means, or `null` if it is not one we
 * can reproduce. Never guesses: an unrecognised phrase rejects the whole rule.
 */
function damageRestriction(phrase: string): TargetRestriction | null {
  return DAMAGE_TARGET_RESTRICTIONS[phrase.trim().toLowerCase()] ?? null;
}

/**
 * The params for a targeted damage effect. `targets` is OMITTED when the phrase is
 * the unrestricted default, so an "any target" card compiles to exactly the data it
 * always did (and the hand-authored Lightning Bolt still matches byte for byte).
 */
function damageParams(amount: number, restriction: TargetRestriction): Record<string, unknown> {
  return restriction === DEFAULT_TARGET_RESTRICTION ? { amount } : { amount, targets: restriction };
}

/**
 * The two non-damage {@link TargetRestriction}s the rule table emits, named so the
 * printed phrase they stand for is obvious at every use site.
 *
 * They matter for a different reason than the damage ones. Removal and combat
 * tricks were never *aimed* wrongly — their primitives already refuse a
 * non-creature. What they lacked was MTG's rule that **a spell with no legal
 * target cannot be cast**: "Destroy target creature" was castable into an empty
 * board and simply evaporated, and — worse — "Counter target spell. You gain 3
 * life." was castable with an empty stack for a free three life, i.e. strictly
 * better than the printed card.
 */
const CREATURE_TARGET: TargetRestriction = 'creature';
/** "target creature you control" — never widened to any creature on the table. */
const CREATURE_YOU_CONTROL_TARGET: TargetRestriction = 'creatureYouControl';
const SPELL_TARGET: TargetRestriction = 'spell';
/**
 * "target instant or sorcery spell" — narrower than {@link SPELL_TARGET} and
 * never interchangeable with it: a copy effect that says "instant or sorcery"
 * may not copy a creature spell, and widening it would make the card castable
 * (and useful) in a board state where the printed one is not.
 */
const INSTANT_OR_SORCERY_SPELL_TARGET: TargetRestriction = 'instantOrSorcerySpell';
const PLAYER_TARGET: TargetRestriction = 'player';
const ARTIFACT_TARGET: TargetRestriction = 'artifact';
const PERMANENT_TARGET: TargetRestriction = 'permanent';
/**
 * "Target instant or sorcery card in your graveyard" — the first restriction
 * that aims at a card OUTSIDE the battlefield (Snapcaster Mage). Core resolves
 * it against the acting player's own graveyard; see `targeting.ts`.
 */
const GRAVEYARD_SPELL_TARGET: TargetRestriction = 'instantOrSorceryInYourGraveyard';


/**
 * The controller scope + {@link CardFilter} a printed "each …" group phrase names,
 * or `null` when the phrase says something the filter vocabulary cannot express.
 *
 * This is the whole reason a group counter rule is safe: "put a +1/+1 counter on
 * each **attacking** creature you control" and "on each creature you control"
 * differ by one word and by a lot of power, so a phrase that is not exactly
 * reproducible must reject the line rather than widen to "every creature".
 *
 * A SUBTYPE qualifier ("each Vampire you control") is accepted only when the card
 * being compiled prints that subtype itself — the typal-lord shape. That keeps
 * the compiler from inventing a creature type out of an arbitrary capitalized
 * word it cannot verify: a card naming a type it does not share stays reported.
 */
function groupCreatureScope(
  phrase: string,
  ctx: RuleContext,
): { scope: string; filter: Record<string, unknown> } | null {
  let text = phrase.trim();
  let scope = GROUP_SCOPE_ANY;
  for (const [suffix, named] of Object.entries(GROUP_SCOPE_SUFFIXES)) {
    if (!text.endsWith(suffix)) continue;
    text = text.slice(0, -suffix.length).trim();
    scope = named;
    break;
  }

  const filter: Record<string, unknown> = {};
  // An optional colour word, exactly as the anthem rule reads one.
  const colorMatch = /^([a-z]+) (.+)$/.exec(text);
  if (colorMatch && COLOR_WORDS[colorMatch[1] ?? '']) {
    filter.anyOfColors = [COLOR_WORDS[colorMatch[1] ?? ''] as string];
    text = colorMatch[2] ?? '';
  }
  // An optional card-type adjective ("artifact creature"). The group primitive
  // already requires a creature, so this narrows rather than widens.
  const typeMatch = /^([a-z]+) creature$/.exec(text);
  if (typeMatch) {
    const type = SPELL_TYPE_WORDS[typeMatch[1] ?? ''];
    if (!type || type === 'creature') return null;
    filter.anyOfTypes = [type];
    text = 'creature';
  }
  if (text === 'creature') return { scope, filter };

  // A typal qualifier — accepted only when the compiling card prints it.
  const printed = ctx.card.typeLine.subtypes.find((sub) => sub.toLowerCase() === text);
  if (printed === undefined) return null;
  filter.anyOfSubtypes = [printed];
  return { scope, filter };
}

/** The printed tails that name whose permanents a group phrase reaches. */
const GROUP_SCOPE_SUFFIXES: Readonly<Record<string, string>> = Object.freeze({
  ' you control': 'you',
  ' your opponents control': 'opponent',
  ' an opponent controls': 'opponent',
});
/** No controller tail printed ⇒ everybody's, as "each creature" means. */
const GROUP_SCOPE_ANY = 'any';

/**
 * Every printed modal header, as the COUNT RANGE it means.
 *
 * A range, not a number, because three of the four printed forms are ranges:
 * "one or both" is 1-2, "up to two" is 0-2, and only the bare counts are exact.
 * Reading them as fixed counts is what kept "one or both" reporting for as long
 * as the mode chooser could not express a range.
 */
const MODAL_HEADER_COUNTS: Readonly<Record<string, { min: number; max: number }>> = Object.freeze({
  one: { min: 1, max: 1 },
  two: { min: 2, max: 2 },
  three: { min: 3, max: 3 },
  'one or both': { min: 1, max: 2 },
  'up to one': { min: 0, max: 1 },
  'up to two': { min: 0, max: 2 },
  'up to three': { min: 0, max: 3 },
  'up to four': { min: 0, max: 4 },
});

/** The alternation of every header phrase, longest first so none is truncated. */
const MODAL_HEADER_PHRASE = Object.keys(MODAL_HEADER_COUNTS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * The printed sentence that lets one mode be taken several times. It follows
 * the count and precedes the bullets ("Choose two. You may choose the same mode
 * more than once.") — Fiery Confluence and every other Confluence.
 */
const REPEATED_MODES_PHRASE = 'you may choose the same mode more than once';
const OPPONENT_TARGET: TargetRestriction = 'opponent';


/**
 * Printed "the number of …" phrases → the {@link DerivedCount} that evaluates
 * them. A closed table on purpose: a phrase not listed here is NOT compiled,
 * because a derived value the engine only half-understands would silently make
 * a card stronger or weaker than printed.
 */
const DERIVED_COUNTS: Readonly<Record<string, string>> = Object.freeze({
  'creatures you control': 'creaturesYouControl',
  'creatures your opponents control': 'creaturesOpponentControls',
  'creatures your opponent controls': 'creaturesOpponentControls',
  'creatures on the battlefield': 'creaturesOnBattlefield',
  'lands you control': 'landsYouControl',
  'cards in your hand': 'cardsInYourHand',
  'cards in your graveyard': 'cardsInYourGraveyard',
  // Multikicker's counter. Oracle prints it several ways depending on era and
  // on whether the card is the spell or the permanent it became.
  'times it was kicked': 'timesThisWasKicked',
  'times this spell was kicked': 'timesThisWasKicked',
  'times ~ was kicked': 'timesThisWasKicked',
  // Added with characteristic-defining P/T: Tarmogoyf counts the first, the
  // Boneyard Wurm family the second. They are in the SHARED table on purpose —
  // a spell that deals damage "equal to the number of creature cards in your
  // graveyard" counts the identical set, and one table is what guarantees it.
  'card types among cards in all graveyards': 'cardTypesInAllGraveyards',
  'creature cards in your graveyard': 'creaturesInYourGraveyard',
});

/** The alternation of the phrases above, longest-first so none is truncated. */
const DERIVED_PHRASE = `(${Object.keys(DERIVED_COUNTS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/** The derived descriptor a printed phrase means, or null when unlisted. */
function derivedValue(phrase: string): { countOf: string } | null {
  const countOf = DERIVED_COUNTS[phrase.trim().toLowerCase()];
  return countOf ? { countOf } : null;
}

/** Persist returns the creature with this many -1/-1 counters (the printed value). */
const PERSIST_MINUS_COUNTERS = 1;

/** The scry/surveil primitives' default look depth — omitted from emitted params. */
const SCRY_DEFAULT_COUNT = 1;

/**
 * Scryfall keyword → the core `KeywordFlags` field implementing it. ONLY the
 * keywords core's combat/turn systems genuinely model appear here; anything else
 * (menace, flash, ward, cycling, …) is not a flag core reads, so a card printing
 * it is reported incomplete rather than quietly losing the ability.
 */
export const KEYWORD_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  flying: 'flying',
  vigilance: 'vigilance',
  haste: 'haste',
  'first strike': 'firstStrike',
  'double strike': 'doubleStrike',
  deathtouch: 'deathtouch',
  trample: 'trample',
  reach: 'reach',
  defender: 'defender',
  lifelink: 'lifelink',
  // Timing and targeting keywords, not combat ones, but flags all the same:
  // core reads `flash` in `castTiming` and hexproof/shroud in `isLegalTarget`.
  flash: 'flash',
  hexproof: 'hexproof',
  shroud: 'shroud',
  // Blocking restrictions: menace constrains the whole declaration, and
  // "can't be blocked" is checked per pair. Both are engine-enforced.
  menace: 'menace',
  // Indestructible is a flag like any other here, but what it EXEMPTS is narrow
  // and specific - destruction effects and lethal damage, never 0 toughness or a
  // sacrifice. See `KeywordFlags.indestructible` in core for the whole rule.
  indestructible: 'indestructible',
});

/** The keyword alternation used inside "gains … until end of turn" patterns. */
const KEYWORD_TOKEN = `(${Object.keys(KEYWORD_FLAGS).join('|')})`;

/**
 * The printed nouns an anthem-shaped static may select, mapped to the card type
 * its filter should carry. `null` means NO type entry: "permanents you control"
 * reaches everything, and an absent filter is exactly that.
 *
 * A CLOSED table. A noun outside it ("Zombies you control", "creatures you
 * control with flying") selects by a subtype or by a characteristic the static
 * filter deliberately cannot read, so those lines keep reporting.
 */
/**
 * The printed nouns "As ~ enters, choose …" may name, mapped to the choice
 * SUBJECT core answers with. A CLOSED table: a noun outside it ("choose a
 * number between 1 and 10", Talion) is a naming this engine can store but
 * nothing can yet read, and it reports rather than compiling into a value no
 * printed line consumes.
 */
const AS_ENTERS_SUBJECTS: Readonly<Record<string, ChosenValueSubject>> = Object.freeze({
  'a creature type': 'creatureType',
  'a color': 'color',
  'a player': 'player',
  'a basic land type': 'basicLandType',
});

/**
 * The card-type words an explicit "choose artifact, creature, …" menu may list.
 * Closed for the same reason every other type table here is: a word outside it
 * would become a menu entry no reader could ever match.
 */
const CHOOSABLE_CARD_TYPES: readonly string[] = Object.freeze([
  'artifact',
  'creature',
  'enchantment',
  'instant',
  'sorcery',
  'land',
  'planeswalker',
  'battle',
]);

/**
 * Whether the card being compiled prints an "As ~ enters, choose …" line at all.
 *
 * Every "of the chosen …" reader consults this before compiling, because a
 * reader without a naming is the exact half-card shape this compiler exists to
 * refuse: it would produce an anthem (or a mana ability) over a value nothing
 * ever writes — a card that reports `'complete'` and then does nothing on the
 * board. Reported, never approximated.
 *
 * Read off the RAW oracle text rather than off the assembly so it works whatever
 * order the card prints its lines in (Realmwalker names its type on the second
 * line, Banner of Kinship on the first), and so it does not depend on which
 * clauses have been absorbed yet.
 */
function namesAValueAsItEnters(ctx: RuleContext): boolean {
  return /\bas [^.]*?\benters, choose\b/i.test(ctx.card.oracleText);
}

const STATIC_NOUN_TYPES: Readonly<Record<string, CardType | null>> = Object.freeze({
  creature: 'creature',
  permanent: null,
  artifact: 'artifact',
  enchantment: 'enchantment',
  land: 'land',
});

/**
 * The number words a printed count may use, as a regex alternation. Built from
 * {@link SMALL_NUMBER_WORDS} so the pattern and the parser cannot list different
 * words — a rule that MATCHES "five" and then fails to parse it reports a line it
 * looked like it understood.
 */
const SMALL_NUMBER_WORD_TOKEN = 'one|two|three|four';

/**
 * The printed permanent NOUN of an "unless you control …" condition, as the
 * `CardFilter` it selects.
 *
 * A singular or plural card-type noun ("a legendary CREATURE", "three or more
 * other SWAMPS") or a land SUBTYPE. Anything else — a noun outside both closed
 * tables — yields `undefined` and the line reports rather than compiling a
 * condition that matches the wrong permanents.
 */
function permanentNounFilter(noun: string): CardFilter | undefined {
  const singular = noun.endsWith('s') ? noun.slice(0, -1) : noun;
  const nounType = STATIC_NOUN_TYPES[singular];
  // `null` is the "permanent" entry: no type filter at all, because an absent
  // filter already matches every permanent.
  if (nounType === null) return {};
  if (nounType !== undefined) return { anyOfTypes: [nounType] };
  if (LAND_SUBTYPES.has(singular)) return { anyOfSubtypes: [singular] };
  return undefined;
}

/**
 * The card types in a printed spell-type list — "creature", "creature and
 * enchantment" — as a `CardFilter`'s `anyOfTypes`.
 *
 * Returns `null` for anything outside the closed type table ("noncreature",
 * "multicolored", "legendary"), so a narrowing this engine cannot express reports
 * instead of compiling into a WIDER ability than the card prints — which, for
 * "can't be countered", would be strictly better than printed.
 */
function parseSpellTypeList(text: string): CardType[] | null {
  const words = text
    .replace(/\band\b|\bor\b/g, ' ')
    .split(/[\s,]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  const types: CardType[] = [];
  for (const word of words) {
    const type = STATIC_NOUN_TYPES[word];
    // `null` ("permanent") is not a spell type — a permanent SPELL is every
    // non-instant/sorcery card, which this list cannot say.
    if (type === undefined || type === null) return null;
    if (!types.includes(type)) types.push(type);
  }
  return types;
}

/**
 * Colour words Oracle uses, mapped to colour letters — in removal restrictions
 * ("destroy target red creature") and in a mana ability's activation restriction
 * ("Activate only if you control a red permanent"). Typed as `ManaColor` rather
 * than `string` so a caller that needs a real colour does not have to assert one.
 */
const COLOR_WORDS: Readonly<Record<string, ManaColor>> = Object.freeze({
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
});

/**
 * "A land card", as the `CardFilter` both a reveal and a search use. One object so
 * the compiler and the hand-authored pool cannot drift apart on what "land" means.
 */
const LAND_FILTER = Object.freeze({ anyOfTypes: Object.freeze(['land']) });

/**
 * Every card type that can be a permanent, in the engine's own vocabulary. It is
 * what "all permanents" means; "all NONLAND permanents" is this list with lands
 * excluded, which is how the printed phrase is written rather than as a
 * hand-maintained five-type list that could drift from `isPermanentType`.
 */
const PERMANENT_TYPES: readonly CardType[] = Object.freeze([
  'land',
  'creature',
  'artifact',
  'enchantment',
  'planeswalker',
  'battle',
]);

/**
 * The five basic land types. A fetchland selects by these, and restricting the
 * fetch template to them keeps it from matching a search for some other card
 * type whose retrieval this template does not actually implement.
 */
const LAND_SUBTYPES: ReadonlySet<string> = new Set([
  'plains',
  'island',
  'swamp',
  'mountain',
  'forest',
]);

/**
 * The printed SUBTYPES a library search may name — a closed table, extended one
 * printed card at a time.
 *
 * It is closed on purpose. The template reads "search your library for a ___
 * card", and the blank is either a card TYPE ("artifact") or a subtype
 * ("Goblin"). Accepting any unrecognised word as a subtype would compile a
 * search for "a **legendary** creature card" or "a **colorless** card" into a
 * filter that matches nothing at all — a tutor that can never find, which is
 * strictly worse than the printed card and completely silent about it. A word
 * that is not in here keeps reporting instead.
 *
 * Everything listed is checked case-insensitively against the printed subtypes
 * the compiler emits (`matchesCardFilter` → `permanentHasSubtype`).
 *
 * It is now the compiler's subtype vocabulary generally, not only a search's:
 * the TYPAL anthem ("Goblins you control have haste", "Other Goblin creatures
 * you control get +1/+1") reads the same table, for the same reason — a lord
 * whose subtype nothing recognises would compile to a filter matching nothing,
 * which is an anthem that silently pumps no one. One table, so a subtype the
 * compiler can find in a library is also one it can pump on the battlefield.
 */
const SEARCHABLE_SUBTYPES: ReadonlySet<string> = new Set([
  // Land types (the fetchlands and the basic-land searches).
  'plains',
  'island',
  'swamp',
  'mountain',
  'forest',
  // Artifact/enchantment types.
  'equipment',
  'aura',
  // Creature types named by the tutors and the typal lords in the most-played
  // corpus. Extended one printed card at a time - see the doc comment.
  'goblin',
  'dragon',
  'demon',
  'faerie',
  'zombie',
  'soldier',
  'spirit',
  'elemental',
  'merfolk',
  'elf',
  'human',
  'warrior',
  'wizard',
  'knight',
  'vampire',
  'sliver',
  'construct',
  'thopter',
  'myr',
  'servo',
  'rogue',
  'snake',
  'squirrel',
  'beast',
  'wurm',
  'insect',
  'angel',
  'cat',
  'shaman',
  'druid',
  'cleric',
  'goat',
  'saproling',
  'plant',
  'bird',
  'horror',
]);

/**
 * {@link SEARCHABLE_SUBTYPES} as a regex alternation, longest first so a pattern
 * cannot match a prefix of a longer type and leave the rest of the word behind.
 */
const SUBTYPE_ALTERNATION = [...SEARCHABLE_SUBTYPES]
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * The numeric restriction a search may print — "with mana value 1 or less",
 * "with toughness 2 or less", "with power 4 or greater", "with mana value 2".
 *
 * Each printed characteristic maps to the pair of {@link CardFilter} bound
 * fields it sets, so the bound and the direction cannot drift apart. A
 * characteristic outside this table is not expressible and rejects the rule
 * rather than being dropped — a dropped restriction is a strictly better tutor.
 */
const SEARCH_BOUND_FIELDS: Readonly<Record<string, { readonly min: string; readonly max: string }>> =
  Object.freeze({
    'mana value': Object.freeze({ min: 'minManaValue', max: 'maxManaValue' }),
    power: Object.freeze({ min: 'minPower', max: 'maxPower' }),
    toughness: Object.freeze({ min: 'minToughness', max: 'maxToughness' }),
  });

/** The alternation of the characteristics above, for the search patterns. */
const SEARCH_BOUND_PHRASE = `(${Object.keys(SEARCH_BOUND_FIELDS).join('|')})`;

/**
 * Turn "an artifact card with mana value 1 or less" into the `CardFilter` that
 * finds exactly those cards, or `null` when any part of the phrase is outside
 * what the filter can say.
 *
 * `noun` is the word before "card" — a card type or a {@link SEARCHABLE_SUBTYPES}
 * subtype; `color` is the optional printed colour adjective before it ("a
 * **blue** instant card"). The three bound arguments are the optional "with X N [or less |
 * or greater]" tail; **no** direction word means an EXACT value (Tribute Mage's
 * "with mana value 2"), which is both bounds set to the same number.
 */
function searchFilterFrom(
  noun: string,
  characteristic?: string,
  amount?: string,
  direction?: string,
  color?: string,
): Record<string, unknown> | null {
  const filter: Record<string, unknown> = {};
  if (color !== undefined && color.length > 0) {
    const letter = COLOR_WORDS[color];
    // A colour word outside the five is not a colour — report the line rather
    // than silently fetching from a wider pool than the card prints.
    if (!letter) return null;
    filter.anyOfColors = [letter];
  }
  // A printed UNION ("an instant or sorcery card", "an Aura or Equipment card")
  // is a list of nouns that must all be the same KIND: `CardFilter` ANDs
  // `anyOfTypes` with `anyOfSubtypes`, so a mixed union ("an artifact or Goblin
  // card") would compile into a search for something that is BOTH — a tutor that
  // can never find. Mixed unions therefore report.
  const nouns = noun.split(' or ').map((word) => word.trim()).filter((word) => word.length > 0);
  if (nouns.length === 0) return null;
  const types: CardType[] = [];
  const subtypes: string[] = [];
  for (const word of nouns) {
    const type = SPELL_TYPE_WORDS[word];
    if (type) types.push(type);
    else if (SEARCHABLE_SUBTYPES.has(word)) subtypes.push(word);
    else return null; // not a restriction this filter can express — report the line
  }
  if (types.length > 0 && subtypes.length > 0) return null;
  if (types.length > 0) filter.anyOfTypes = types;
  else filter.anyOfSubtypes = subtypes;

  if (characteristic === undefined) return filter;
  const fields = SEARCH_BOUND_FIELDS[characteristic];
  if (!fields) return null;
  const value = Number.parseInt(amount ?? '', 10);
  if (!Number.isFinite(value)) return null;
  if (direction === 'less') filter[fields.max] = value;
  else if (direction === 'greater') filter[fields.min] = value;
  else {
    filter[fields.min] = value;
    filter[fields.max] = value;
  }
  return filter;
}

/**
 * Turn a printed list of land types ("Swamp, Forest, or Island", "Mountain or
 * Plains") into the individual words, or `null` when any of them is not a land
 * type. The list may be any length — Farseek prints four.
 */
function landTypeList(text: string): readonly string[] | null {
  const words = text
    .split(/,\s*(?:or\s+)?|\s+or\s+/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return words.every((word) => LAND_SUBTYPES.has(word)) ? words : null;
}

/**
 * The BASIC land cards a printed type list names, BY NAME — the same way "a
 * basic land card" is written everywhere else in this table (`CardFilter` has
 * no supertype field; see `restrictToNames` in ../choice-primitives.ts).
 *
 * The name of a basic land IS its land type, which is what makes this exact
 * rather than a heuristic: a card named "Swamp" is a basic Swamp.
 */
function basicNamesFor(types: readonly string[]): readonly string[] {
  const byType = new Map(BASIC_LAND_NAMES.map((name) => [name.toLowerCase(), name]));
  // PRINTED order, not the pool's: the params a card carries should read the way
  // the card reads, which is what makes a diff of two compiled cards legible.
  const names: string[] = [];
  for (const type of types) {
    const name = byType.get(type);
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The optional colour adjective a search may print — "a **blue** instant card"
 * (Merchant Scroll), "a **green** creature card" (Green Sun's Zenith). Written
 * as its own capture rather than folded into the noun so an unrecognised
 * adjective reports instead of being read as a subtype.
 */
const SEARCH_COLOR_PHRASE = `(?:(${Object.keys(COLOR_WORDS).join('|')}) )?`;

/**
 * The printed restrictions a "you choose a ___ card from it" discard may carry,
 * mapped to the `CardFilter` implementing each. Anything outside this table is a
 * restriction the filter cannot express, so the rule declines rather than
 * discarding the wrong kind of card.
 */
const DISCARD_RESTRICTIONS: Readonly<Record<string, { readonly noneOfTypes?: readonly string[]; readonly anyOfTypes?: readonly string[] }>> =
  Object.freeze({
    nonland: { noneOfTypes: Object.freeze(['land']) },
    noncreature: { noneOfTypes: Object.freeze(['creature']) },
    creature: { anyOfTypes: Object.freeze(['creature']) },
    land: { anyOfTypes: Object.freeze(['land']) },
  });

/**
 * The permanent kinds a printed MANDATORY additional cost may sacrifice, mapped
 * to the `CardFilter` selecting each. A CLOSED table: a noun outside it has no
 * faithful filter, and a cost that sacrificed the wrong permanent — or nothing —
 * would be a silently different card.
 *
 * The "or" forms are listed as their own entries rather than parsed, because
 * "an artifact or creature" is ONE printed phrase whose meaning (either type)
 * is a union, and enumerating the two printed unions that actually appear is
 * exact where a general parser would be a guess.
 */
const SACRIFICE_COST_NOUNS: Readonly<Record<string, { readonly anyOfTypes: readonly CardType[] }>> =
  Object.freeze({
    creature: { anyOfTypes: Object.freeze<CardType[]>(['creature']) },
    land: { anyOfTypes: Object.freeze<CardType[]>(['land']) },
    artifact: { anyOfTypes: Object.freeze<CardType[]>(['artifact']) },
    enchantment: { anyOfTypes: Object.freeze<CardType[]>(['enchantment']) },
    'artifact or creature': { anyOfTypes: Object.freeze<CardType[]>(['artifact', 'creature']) },
    'creature or artifact': { anyOfTypes: Object.freeze<CardType[]>(['creature', 'artifact']) },
  });

/** The filter a printed sacrifice-cost noun means, or null if unexpressible. */
function sacrificeCostFilterFor(noun: string): { readonly anyOfTypes: readonly CardType[] } | null {
  return SACRIFICE_COST_NOUNS[noun.replace(/^an? /, '').trim()] ?? null;
}

/**
 * The filter a printed DISCARD-cost noun means. Only the unrestricted "a card"
 * is expressible as no filter at all; the restricted forms reuse the same closed
 * table an effect's discard restriction reads, so "discard a land card" cannot
 * mean two different things in two places. `null` reports the line.
 */
function discardCostFilterFor(noun: string): Record<string, unknown> | null | undefined {
  const word = noun.replace(/^an? /, '').trim();
  if (word === 'card') return undefined; // any card — no filter
  const restricted = word.endsWith(' card') ? word.slice(0, -' card'.length) : word;
  return discardFilterFor(restricted) as Record<string, unknown> | null;
}

/** The regex alternation of the discard restrictions above. */
const DISCARD_RESTRICTION_TOKEN = Object.keys(DISCARD_RESTRICTIONS).join('|');

/** The filter implementing a printed discard restriction, or null if unexpressible. */
function discardFilterFor(word: string): (typeof DISCARD_RESTRICTIONS)[string] | null {
  return DISCARD_RESTRICTIONS[word.trim().toLowerCase()] ?? null;
}

/**
 * The card types a printed token type line may name, in the engine's vocabulary.
 * A CLOSED table: "artifact creature token" and "enchantment creature token" are
 * real printings, but a planeswalker or battle token needs printed loyalty or
 * defense that the token clause never states, so one is refused rather than
 * created without it.
 */
const TOKEN_TYPE_WORDS: Readonly<Record<string, CardType>> = Object.freeze({
  artifact: 'artifact',
  creature: 'creature',
  enchantment: 'enchantment',
  land: 'land',
});

/** The printed word for "no colour at all" — a real, distinct declaration. */
const COLORLESS_WORD = 'colorless';

/** Everything a printed token clause declares about the object it creates. */
interface TokenFace {
  /** The token's name: its subtype line, as CR 111.3 names a token. */
  readonly name: string;
  /** The printed colours; EMPTY for the printed word "colorless". */
  readonly colors: readonly ManaColor[];
  /** The printed subtypes, as printed ("Faerie", "Rogue"). */
  readonly subtypes: readonly string[];
  /** The printed card types, always including `creature` for this rule. */
  readonly types: readonly CardType[];
}

/**
 * Read a printed token descriptor — everything between the P/T and the word
 * "token" — into the whole face: "black faerie rogue creature" →
 * `{ name: 'Faerie Rogue', colors: ['B'], subtypes: ['Faerie','Rogue'],
 * types: ['creature'] }`.
 *
 * The printed grammar is strictly ordered, which is what makes this readable
 * without a parser: **colours, then subtypes, then card types.** So the colours
 * are taken from the FRONT while the words are colour words (joined by the
 * printed "and", as in "blue and black"), the card types are taken from the BACK
 * while the words are type words, and whatever is left in the middle is the
 * subtype line.
 *
 * Returns `null` — refusing the whole clause — for anything it cannot read
 * completely:
 *
 *  - **No colour word.** A token's colour exists ONLY in this sentence, so a
 *    descriptor that does not state one cannot be compiled into a coloured
 *    object; guessing colourless is exactly the infidelity this rule is fixing.
 *    (It also correctly refuses "a TAPPED 1/1 blue Fish creature token", whose
 *    descriptor starts with a word that is not a colour — entering tapped is a
 *    characteristic the primitive cannot express either.)
 *  - **No subtype.** Every printed creature token names its creature type, and a
 *    typeless one would be invisible to every typal effect in the game.
 *  - **A type line without `creature`.** The predefined artifact tokens
 *    (Treasure, Clue, Food) print no P/T here and carry an activated ability
 *    this rule does not build; they stay reported.
 */
function parseTokenFace(descriptor: string): TokenFace | null {
  const words = descriptor
    .trim()
    .split(/[ ,]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;

  // --- colours, from the front -------------------------------------------------
  const colors: ManaColor[] = [];
  let colorless = false;
  let head = 0;
  while (head < words.length) {
    const word = words[head] as string;
    // The printed conjunction between two colour words ("blue and black"). Only
    // accepted BETWEEN colours, never as the first word, so it cannot smuggle a
    // non-colour descriptor past the check below.
    if (word === 'and' && colors.length > 0) {
      head++;
      continue;
    }
    if (word === COLORLESS_WORD) {
      colorless = true;
      head++;
      continue;
    }
    const color = COLOR_WORDS[word];
    if (color === undefined) break;
    if (!colors.includes(color)) colors.push(color);
    head++;
  }
  // "colorless" and a colour word in one descriptor is not a printing anything
  // makes; reading it either way would be a guess.
  if (colorless && colors.length > 0) return null;
  if (!colorless && colors.length === 0) return null;

  // --- card types, from the back -----------------------------------------------
  const types: CardType[] = [];
  let tail = words.length;
  while (tail > head) {
    const type = TOKEN_TYPE_WORDS[words[tail - 1] as string];
    if (type === undefined) break;
    // Unshifted so the emitted type line keeps its PRINTED order ("artifact
    // creature"), which is how a reviewer compares it to the card.
    types.unshift(type);
    tail--;
  }
  if (!types.includes('creature')) return null;

  // --- what is left in the middle is the subtype line --------------------------
  const subtypes = words.slice(head, tail).map(capitalizeWord);
  if (subtypes.length === 0) return null;

  // CR 111.3: a token's name is its subtype line ("Faerie Rogue"), not the last
  // word of it — naming it "Rogue" would make two different tokens share a name
  // and read wrong in every log line.
  return { name: subtypes.join(' '), colors, subtypes, types };
}

/** "goblin" → "Goblin". Subtypes are stored as printed (matching is case-folded). */
function capitalizeWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Build a `KeywordFlags` object from a printed keyword word. */
function keywordFlag(word: string): Record<string, boolean> | null {
  const field = KEYWORD_FLAGS[word.trim().toLowerCase()];
  return field ? { [field]: true } : null;
}

/**
 * The quality words a printed "protection from ..." may name, mapped to the core
 * {@link ProtectionQuality} each means. A CLOSED table: a quality outside it
 * ("protection from Demons", "from instants and from sorceries") has no faithful
 * engine check, so those cards keep reporting rather than compiling a protection
 * that quietly protects from the wrong things.
 */
const PROTECTION_QUALITY_WORDS: Readonly<Record<string, ProtectionQuality>> = Object.freeze({
  white: 'white',
  blue: 'blue',
  black: 'black',
  red: 'red',
  green: 'green',
  colorless: 'colorless',
  multicolored: 'multicolored',
  artifacts: 'artifacts',
  creatures: 'creatures',
  everything: 'everything',
});

/** How a printed protection line separates its qualities ("... and from ..."). */
const PROTECTION_SEPARATOR = /,? and (?:from )?|, /;

/** `Ward {N}` - only the plain generic-cost form; anything else must report. */
const WARD_PATTERN = /^ward \{(\d+)\}$/;

/** `Protection from X[ and from Y...]` - the capturing form of the printed line. */
const PROTECTION_PATTERN = /^protection from (.+)$/;

/**
 * Parse a printed protection quality list ("red", "black and from green") into
 * core qualities, or `null` when ANY word is outside the closed table - a
 * half-understood protection line must report, never protect from less than it
 * says.
 */
function parseProtectionQualities(text: string): readonly ProtectionQuality[] | null {
  const words = text
    .split(PROTECTION_SEPARATOR)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  const qualities: ProtectionQuality[] = [];
  for (const word of words) {
    const quality = PROTECTION_QUALITY_WORDS[word];
    if (!quality) return null;
    if (!qualities.includes(quality)) qualities.push(quality);
  }
  return qualities;
}

/**
 * Compile the two payload-carrying keyword abilities - `Ward {N}` and
 * `Protection from [quality]` - into the keyword fields core enforces, or
 * `null` when the word is neither (or a form outside the closed tables).
 * Shared by the keyword-line compiler and the keyword sweep so the two cannot
 * disagree about which printed forms are real.
 */
export function parseProtectionOrWard(word: string): KeywordFlags | null {
  const text = word.trim().toLowerCase();
  const ward = WARD_PATTERN.exec(text);
  if (ward) {
    const cost = Number.parseInt(ward[1] ?? '', 10);
    return Number.isFinite(cost) && cost > 0 ? { ward: cost } : null;
  }
  const protection = PROTECTION_PATTERN.exec(text);
  if (protection) {
    const qualities = parseProtectionQualities(protection[1] ?? '');
    return qualities === null ? null : { protectionFrom: qualities };
  }
  return null;
}

/**
 * The trigger CONDITIONS a printed spell-type restriction compiles to, or `null`
 * when the phrase is not one we model.
 *
 * Two shapes, because Oracle prints two:
 *   - a POSITIVE list ("instant or sorcery spell") — core's `spellType` takes one
 *     `CardType`, so a multi-type list becomes one trigger per type. This is how
 *     the hand-authored pool has always modelled Young Pyromancer and Kiln Fiend.
 *   - a NEGATIVE list ("**non**creature spell" — prowess) — one trigger carrying
 *     `spellTypeNoneOf`. Flattening this into the positive pair instant+sorcery is
 *     what made Monastery Swiftspear miss every artifact and planeswalker in the
 *     pool, so the negative form is compiled as a negative filter, not guessed at.
 */
function spellFiltersFor(restriction: string): readonly TriggerCondition[] | null {
  const text = restriction.trim().toLowerCase();
  const negated = /^non(.+)$/.exec(text);
  if (negated) {
    const excluded = SPELL_TYPE_WORDS[negated[1] ?? ''];
    return excluded ? [{ on: 'castSpell', who: 'you', spellTypeNoneOf: [excluded] }] : null;
  }
  const positive = text === 'instant or sorcery' ? (['instant', 'sorcery'] as const) : positiveSpellTypes(text);
  return positive === null
    ? null
    : positive.map((spellType) => ({ on: 'castSpell', who: 'you', spellType }));
}

/** A single printed type word → the `CardType` it names. */
const SPELL_TYPE_WORDS: Readonly<Record<string, CardType>> = Object.freeze({
  instant: 'instant',
  sorcery: 'sorcery',
  creature: 'creature',
  artifact: 'artifact',
  enchantment: 'enchantment',
  land: 'land',
  planeswalker: 'planeswalker',
});

/** The single-word positive form, as a one-element list. */
function positiveSpellTypes(text: string): readonly CardType[] | null {
  const type = SPELL_TYPE_WORDS[text];
  return type ? [type] : null;
}

/** How a compiled cast-trigger filter reads in its debug label. */
function describeSpellFilter(condition: TriggerCondition): string {
  if (condition.spellType) return condition.spellType;
  const excluded = condition.spellTypeNoneOf ?? [];
  return excluded.length > 0 ? `non${excluded.join('/')}` : 'spell';
}

/** Parse a run of mana symbols ("{b}{b}{b}") into a color list. */
function manaSymbols(text: string): readonly ManaColor[] | null {
  const matches = text.match(/\{[wubrgc]\}/g);
  if (!matches || matches.length === 0) return null;
  const colors: ManaColor[] = [];
  for (const symbol of matches) {
    const color = MANA_SYMBOL_TO_COLOR[symbol];
    if (!color) return null;
    colors.push(color);
  }
  return colors;
}


/**
 * REPLACEMENT AND PREVENTION EFFECTS (core's CR 614/615 layer) — the printed
 * vocabulary, as data tables, shared by the four rules that read it.
 *
 * The whole family is "if <EVENT> would happen, <MODIFIED EVENT> happens
 * instead", and only three things vary between printed cards: WHOSE source,
 * WHOSE recipient, and WHAT the modification is. Each is a closed table, so a
 * wording outside them reports rather than being widened into a different card —
 * Torbran's "an opponent or a permanent an opponent controls" and Fiery
 * Emancipation's "a permanent or player" are two different cards, and the table
 * is what keeps them that way.
 */

/** The printed phrase naming WHOSE source a damage replacement watches. */
const REPLACEMENT_SOURCE_SCOPES: Readonly<Record<string, StaticControllerScope>> = Object.freeze({
  'a source you control': 'you',
  'a source an opponent controls': 'opponent',
  'a source': 'any',
  'a creature you control': 'you',
});

/** The printed source phrases that also narrow the source by TYPE. */
const REPLACEMENT_SOURCE_TYPES: Readonly<Record<string, CardType | null>> = Object.freeze({
  'a source you control': null,
  'a source an opponent controls': null,
  'a source': null,
  'a creature you control': 'creature',
});

/**
 * The printed phrase naming WHO/WHAT a replacement's event happens to.
 * `kind: 'player'` is the tail that says a permanent can never be the recipient
 * ("…would deal damage to an opponent" — Solphim's clause is about players).
 */
const REPLACEMENT_RECIPIENTS: Readonly<
  Record<string, { readonly controller: StaticControllerScope; readonly kind?: 'player' | 'permanent' }>
> = Object.freeze({
  'a permanent or player': { controller: 'any' },
  'an opponent or a permanent an opponent controls': { controller: 'opponent' },
  'you or a permanent you control': { controller: 'you' },
  'an opponent': { controller: 'opponent', kind: 'player' },
  'a creature you control': { controller: 'you', kind: 'permanent' },
});

/** The alternation of every recipient phrase, longest first so none is truncated. */
const REPLACEMENT_RECIPIENT_TOKEN = `(${Object.keys(REPLACEMENT_RECIPIENTS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/** The alternation of every source phrase, longest first so none is truncated. */
const REPLACEMENT_SOURCE_TOKEN = `(${Object.keys(REPLACEMENT_SOURCE_SCOPES)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/**
 * The printed multiplier words. "That much damage plus N" is captured
 * separately, because adding and scaling are different arithmetic and folding
 * them onto one field would make Torbran and Gratuitous Violence the same card.
 */
const REPLACEMENT_MULTIPLIERS: Readonly<Record<string, number>> = Object.freeze({
  double: 2,
  triple: 3,
  twice: 2,
  'three times': 3,
});


/**
 * The printed NOUN PHRASE a counter replacement watches, mapped to the filter
 * that selects it. `null` means "no filter at all", which is what "a permanent
 * you control" says — inventing a `'permanent'` type word would match nothing.
 */
const REPLACEMENT_COUNTER_SUBJECTS: Readonly<Record<string, CardFilter | null>> = Object.freeze({
  'a creature': { anyOfTypes: ['creature'] },
  'a permanent': null,
  'an artifact or creature': { anyOfTypes: ['artifact', 'creature'] },
});

/** The alternation of the multiplier words, longest first. */
const REPLACEMENT_MULTIPLIER_TOKEN = `(${Object.keys(REPLACEMENT_MULTIPLIERS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/**
 * Whether the card being compiled can carry a printed replacement ability at
 * all. Only a PERMANENT radiates one; an instant or sorcery printing the same
 * shape is a one-shot that creates a floating effect instead (the fog rules in
 * EFFECT_RULES), and compiling it as a static would make a Fog permanent.
 */
function cardIsPermanent(ctx: RuleContext): boolean {
  return ctx.card.typeLine.types.every((type) => !/^(instant|sorcery)$/i.test(type));
}

// --- effect rules ---------------------------------------------------------------
// Matched against a spell's resolution clause AND against a trigger's body (the
// same templates mean the same thing in both places — one mechanism, DESIGN §1.3).

/** Shorthand for a rule whose contribution is a fixed effect list. */
function effects(...refs: EffectRef[]): ClauseContribution {
  return { effects: refs };
}

/**
 * The param value meaning "the X chosen (and paid for) at cast time" — the
 * shape `intParam` in `../effect-helpers.ts` resolves from
 * `EffectContext.xValue`. Mirrored here as data rather than imported so the
 * compiler stays a pure table over the primitives' documented param vocabulary.
 */
const CHOSEN_X_PARAM = Object.freeze({ chosenX: true });

/**
 * Whether the card being compiled actually prints `{X}` in its mana cost. The
 * X-reading effect rules are gated on this: "deals X damage" on a card whose X
 * comes from somewhere OTHER than the cost (a "where X is …" definition) must
 * not silently read the cast-time X — there is none, and the clause defining X
 * will report on its own terms.
 */
function cardHasXCost(ctx: RuleContext): boolean {
  return ctx.card.manaCost.other.some((symbol) => symbol.toUpperCase() === 'X');
}

/**
 * A printed mode's body, tidied into the label a human reads when choosing it:
 * the card's own name restored from `~`, the first letter capitalised, and the
 * compiler's leftover sentence period dropped.
 *
 * Presentation only — nothing downstream matches on it — but it is the text the
 * mode question shows, so "counter target spell." reading as "Counter target
 * spell" is the difference between a UI and a debug dump.
 */
function modeLabel(body: string, cardName: string): string {
  const text = body.replace(/~/g, cardName).replace(/\.$/, '').trim();
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

export const EFFECT_RULES: readonly CompileRule[] = Object.freeze([
  {
    /**
     * THE FOG. "Prevent all combat damage that would be dealt this turn" (Fog,
     * Darkness, Holy Day, Dawn Charm's first mode), and its relatives "Prevent
     * all damage that would be dealt to you this turn" (Riot Control) and
     * "Prevent all combat damage that would be dealt to you this turn".
     *
     * A ONE-SHOT: the spell registers a floating prevention effect that expires
     * in cleanup. The same sentence WITHOUT "this turn", printed on a permanent,
     * is a static instead (`replacement-prevent-all-static`) — the tail is what
     * separates a Fog from a Dolmen Gate, and getting it wrong in either
     * direction is a different card.
     */
    id: 'prevent-all-damage-this-turn',
    description:
      '"Prevent all [combat] damage that would be dealt [to you] this turn" (Fog, Darkness, Riot Control)',
    pattern:
      /^prevent all (combat |noncombat )?damage that would be dealt(?: to (you|creatures you control|attacking creatures you control))? this turn$/,
    build(match) {
      const combatWord = match[1]?.trim();
      const who = match[2];
      return {
        effects: [
          {
            primitive: 'preventDamage',
            params: {
              ...(combatWord === 'combat' ? { combat: true } : {}),
              ...(combatWord === 'noncombat' ? { combat: false } : {}),
              ...(who === undefined ? {} : { scope: 'you' }),
              ...(who === 'you' ? { recipientKind: 'player' } : {}),
              ...(who === 'creatures you control' || who === 'attacking creatures you control'
                ? { recipientKind: 'permanent' }
                : {}),
              ...(who === 'attacking creatures you control' ? { attacking: true } : {}),
              label: match[0],
            },
          },
        ],
      };
    },
  },
  {
    id: 'damage-any-target',
    description:
      '"~ deals N damage to any target / target creature / target player [or planeswalker]" — the printed target phrase becomes the effect\'s `targets` restriction',
    pattern: new RegExp(`^~ deals ${COUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}$`),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[1]);
      const restriction = damageRestriction(match[2] ?? '');
      if (amount === null || restriction === null) return null;
      return effects({ primitive: 'dealDamage', params: damageParams(amount, restriction) });
    },
  },
  {
    id: 'damage-then-gain-life',
    description:
      '"~ deals N damage to any target and you gain N life" (Lightning Helix — printed as one sentence or two)',
    pattern: new RegExp(
      `^~ deals ${COUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}(?:\\.|,)? and you gain ${COUNT_TOKEN} life$|^~ deals ${COUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}\\. you gain ${COUNT_TOKEN} life$`,
    ),
    needsChosenTarget: true,
    build(match) {
      // The pattern has two alternations ("… and you gain" / "…. You gain"), each
      // carrying three groups (count, target phrase, life), so read whichever
      // triple actually matched.
      const damage = parseCount(match[1] ?? match[4]);
      const restriction = damageRestriction(match[2] ?? match[5] ?? '');
      const life = parseCount(match[3] ?? match[6]);
      if (damage === null || life === null || restriction === null) return null;
      return effects(
        { primitive: 'dealDamage', params: damageParams(damage, restriction) },
        { primitive: 'gainLife', params: { amount: life } },
      );
    },
  },
  {
    id: 'damage-then-draw',
    description: '"~ deals N damage to any target and you draw M cards" (Sword of Fire and Ice)',
    // The same compound as `damage-then-gain-life`, with the other half of the
    // pair of things a saboteur trigger most often bolts onto its damage. One
    // rule per printed compound rather than a general "clause and clause"
    // splitter, because the two halves may not each be independently targetable
    // and a generic splitter would quietly aim both at the same object.
    pattern: new RegExp(
      `^~ deals ${COUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}(?:\\.|,)? and you draw ${COUNT_TOKEN} cards?$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const damage = parseCount(match[1]);
      const restriction = damageRestriction(match[2] ?? '');
      const cards = parseCount(match[3]);
      if (damage === null || cards === null || restriction === null) return null;
      return effects(
        { primitive: 'dealDamage', params: damageParams(damage, restriction) },
        { primitive: 'drawCards', params: { count: cards } },
      );
    },
  },
  {
    id: 'damage-equal-to-count',
    description: '"~ deals damage to any target equal to the number of X"',
    pattern: new RegExp(
      `^~ deals damage to ${DAMAGE_TARGET_PHRASE} equal to the number of ${DERIVED_PHRASE}$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const restriction = damageRestriction(match[1]!);
      const amount = derivedValue(match[2]!);
      if (!restriction || !amount) return null;
      return effects({ primitive: 'dealDamage', params: damageParams(amount as never, restriction) });
    },
  },
  {
    id: 'draw-equal-to-count',
    description: '"Draw cards equal to the number of X"',
    pattern: new RegExp(`^draw cards equal to the number of ${DERIVED_PHRASE}$`),
    build(match) {
      const count = derivedValue(match[1]!);
      if (!count) return null;
      return effects({ primitive: 'drawCards', params: { count } });
    },
  },
  {
    id: 'gain-life-equal-to-count',
    description: '"You gain life equal to the number of X"',
    pattern: new RegExp(`^you gain life equal to the number of ${DERIVED_PHRASE}$`),
    build(match) {
      const amount = derivedValue(match[1]!);
      if (!amount) return null;
      return effects({ primitive: 'gainLife', params: { amount } });
    },
  },
  {
    id: 'x-damage',
    description:
      '"~ deals X damage to any target / target creature / target player" — X is the value chosen (and paid for) at cast time',
    pattern: new RegExp(`^~ deals x damage to ${DAMAGE_TARGET_PHRASE}$`),
    needsChosenTarget: true,
    build(match, ctx) {
      if (!cardHasXCost(ctx)) return null; // an X defined elsewhere is not the cast-time X
      const restriction = damageRestriction(match[1] ?? '');
      if (restriction === null) return null;
      return effects({ primitive: 'dealDamage', params: damageParams(CHOSEN_X_PARAM as never, restriction) });
    },
  },
  {
    id: 'x-draw',
    description: '"Draw X cards" — X is the value chosen at cast time (Mind Spring)',
    pattern: /^(?:you )?draw x cards$/,
    build(_match, ctx) {
      if (!cardHasXCost(ctx)) return null;
      return effects({ primitive: 'drawCards', params: { count: CHOSEN_X_PARAM } });
    },
  },
  {
    id: 'x-gain-life',
    description: '"You gain X life" — X is the value chosen at cast time',
    pattern: /^you gain x life$/,
    build(_match, ctx) {
      if (!cardHasXCost(ctx)) return null;
      return effects({ primitive: 'gainLife', params: { amount: CHOSEN_X_PARAM } });
    },
  },
  {
    id: 'kicked-damage-instead',
    description:
      '"~ deals N damage to TARGET. If this spell was kicked, it deals M damage to that target instead." (Burst Lightning, Shivan Fire) — one damage ref whose amount switches on the cast-time kicked flag',
    pattern: new RegExp(
      `^~ deals ${COUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}\\. if this spell was kicked, (?:it|~) deals ${COUNT_TOKEN} damage to (?:that target|that creature|that player|it) instead$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const base = parseCount(match[1]);
      const restriction = damageRestriction(match[2] ?? '');
      const kicked = parseCount(match[3]);
      if (base === null || kicked === null || restriction === null) return null;
      return effects({
        primitive: 'dealDamage',
        params: damageParams({ base, kicked } as never, restriction),
      });
    },
  },
  {
    id: 'kicked-extra-effect',
    description:
      '"MAIN CLAUSE. If this spell was kicked, RIDER." — the rider runs only when the kicker was paid (the rider itself must be a target-free clause the table already compiles)',
    pattern: /^(.+\S)\. if this spell was kicked, (.+)$/,
    build(match, ctx) {
      const main = ctx.compileEffectClause(match[1]!);
      if (!main || main.length === 0) return null;
      // Target-free by construction: the rider runs inside the same resolution
      // and inherits the cast's chosen targets, so a rider that would CHOOSE a
      // new target has no moment to do it — those templates stay reported.
      const rider = ctx.compileEffectClause(match[2]!, { targetFree: true });
      if (!rider || rider.length === 0) return null;
      return effects(...main, { primitive: 'ifKicked', params: { effects: rider } });
    },
  },
  {
    id: 'draw-cards',
    description: '"Draw N cards"',
    pattern: new RegExp(`^(?:you )?draw ${COUNT_TOKEN} cards?$`),
    build(match) {
      const count = parseCount(match[1]);
      return count === null ? null : effects({ primitive: 'drawCards', params: { count } });
    },
  },
  {
    // --- WHO the effect happens to -------------------------------------------
    // The rules below are one family: a printed body that happens to somebody
    // OTHER than the source's controller. They all compile to the same shared
    // "whichPlayer" vocabulary (`playersForParam` in effect-helpers), so "each
    // player", "that player" and "each opponent" mean one thing each wherever
    // they are printed.
    id: 'each-player-draws',
    description: '"Each player draws N cards"',
    pattern: new RegExp(`^each player draws ${COUNT_TOKEN} cards?$`),
    build(match) {
      const count = parseCount(match[1]);
      return count === null
        ? null
        : effects({ primitive: 'drawCards', params: { count, whichPlayer: 'each' } });
    },
  },
  {
    id: 'each-player-draws-and-loses-life',
    description: '"Each player draws N cards and loses M life" (Stormfist Crusader)',
    // Printed as ONE sentence, so the sentence splitter never separates the two
    // halves that would each compile alone — the same reason `draw-and-lose-life`
    // exists for the untargeted "you" form.
    pattern: new RegExp(`^each player draws ${COUNT_TOKEN} cards? and loses ${COUNT_TOKEN} life$`),
    build(match) {
      const count = parseCount(match[1]);
      const life = parseCount(match[2]);
      if (count === null || life === null) return null;
      return effects(
        { primitive: 'drawCards', params: { count, whichPlayer: 'each' } },
        { primitive: 'loseLife', params: { amount: life, whichPlayer: 'each' } },
      );
    },
  },
  {
    id: 'that-player-draws',
    description:
      '"That player draws N [additional] cards" — a trigger body aimed at the TRIGGERING player',
    // Howling Mine, Kami of the Crescent Moon, Dictate of Kruphix, Font of
    // Mythos. "Additional" is descriptive: the extra draw IS the effect, and the
    // turn's own draw happens on its own. Compiling the word into a second draw
    // would double it.
    pattern: new RegExp(`^that player draws ${COUNT_TOKEN} (?:additional )?cards?$`),
    build(match) {
      const count = parseCount(match[1]);
      return count === null
        ? null
        : effects({ primitive: 'drawCards', params: { count, whichPlayer: 'triggering' } });
    },
  },
  {
    id: 'that-player-loses-life',
    description: '"That player loses N life" — a trigger body aimed at the TRIGGERING player',
    pattern: new RegExp(`^that player loses ${COUNT_TOKEN} life$`),
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null
        ? null
        : effects({ primitive: 'loseLife', params: { amount, whichPlayer: 'triggering' } });
    },
  },
  {
    id: 'each-opponent-loses-life',
    description: '"Each opponent loses N life"',
    // The bare form, with none of the "and you gain that much life" tail that
    // `each-opponent-loses-life-you-gain` handles; that rule is declared earlier,
    // so the longer printed line keeps the rule that knows about its second half.
    pattern: new RegExp(`^each opponent loses ${COUNT_TOKEN} life$`),
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null
        ? null
        : effects({ primitive: 'loseLife', params: { amount, whichPlayer: 'opponent' } });
    },
  },
  {
    id: 'draw-additional-cards',
    description: '"Draw an additional card" (The Immortal Sun\'s draw step)',
    // Plain `drawCards`: the word "additional" describes WHY the draw is extra
    // (the draw step already drew one), not a second effect on top of it.
    pattern: new RegExp(`^(?:you )?draw ${COUNT_TOKEN} additional cards?$`),
    build(match) {
      const count = parseCount(match[1]);
      return count === null ? null : effects({ primitive: 'drawCards', params: { count } });
    },
  },
  {
    id: 'that-player-cycles-hand',
    description:
      '"That player puts the cards in their hand on the bottom of their library in any order, then draws that many cards" (Teferi\'s Puzzle Box)',
    pattern:
      /^that player puts the cards in their hand on the bottom of their library in any order, then draws that many cards$/,
    build() {
      return effects({ primitive: 'handToBottomThenDraw', params: { who: 'triggering' } });
    },
  },
  {
    id: 'source-damage-to-that-player',
    description:
      '"~ deals N damage to that player / to them" — UNTARGETED damage at the triggering player',
    // Untargeted on purpose: the printed line names no target, it names the
    // player the trigger was about. Compiling it as targeted damage would ask
    // the controller to aim something the card never asks them to aim, and would
    // subject it to targeting restrictions the printed line does not have.
    pattern: new RegExp(`^~ deals ${COUNT_TOKEN} damage to (?:that player|them)$`),
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null
        ? null
        : effects({ primitive: 'dealDamage', params: { amount, whichPlayer: 'triggering' } });
    },
  },
  {
    id: 'gain-life',
    description: '"You gain N life"',
    pattern: new RegExp(`^you gain ${COUNT_TOKEN} life$`),
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null ? null : effects({ primitive: 'gainLife', params: { amount } });
    },
  },
  {
    id: 'you-lose-life',
    description: '"You lose N life"',
    pattern: new RegExp(`^you lose ${COUNT_TOKEN} life$`),
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null ? null : effects({ primitive: 'loseLife', params: { amount } });
    },
  },
  {
    // "target opponent" is deliberately NOT accepted here, for the same reason it
    // is absent from DAMAGE_TARGET_RESTRICTIONS: the engine can restrict a spell
    // to a player, but not to a player who isn't you.
    id: 'target-player-loses-life',
    description: '"Target player loses N life"',
    pattern: new RegExp(`^target player loses ${COUNT_TOKEN} life$`),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null
        ? null
        : effects({
            primitive: 'loseLife',
            // Without the restriction this spell could be "targeted" at a creature,
            // where `loseLife` finds no player target and falls back to the
            // controller — i.e. the caster would lose the life. The restriction is
            // what makes the printed target the only thing it can be pointed at.
            params: { amount, targetPlayer: true, targets: 'player' },
          });
    },
  },
  {
    id: 'destroy-creature-mana-value-revolt',
    description:
      '"Destroy target creature if it has mana value N or less. Revolt — Destroy that creature if it has mana value M or less instead if a permanent left the battlefield under your control this turn." (Fatal Push)',
    // ONE rule for BOTH printed lines: `text.ts` joins the revolt rider onto the
    // line it modifies, because "that creature" has no referent alone and
    // compiling the halves separately would destroy twice. The two bounds ride
    // a single `destroyTarget` ref as a `{ base, revolt }` switch, read at
    // RESOLUTION against the turn's fact memory — so a permanent that leaves in
    // response to the spell turns revolt on, exactly as printed.
    pattern: new RegExp(
      `^destroy target creature if it has mana value ${COUNT_TOKEN} or less\\. revolt [—-] destroy that creature if it has mana value ${COUNT_TOKEN} or less instead if a permanent left the battlefield under your control this turn$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const base = parseCount(match[1]);
      const revolt = parseCount(match[2]);
      if (base === null || revolt === null) return null;
      return effects({
        primitive: 'destroyTarget',
        params: { targets: CREATURE_TARGET, maxManaValue: { base, revolt } },
      });
    },
  },
  {
    id: 'destroy-creature-if-mana-value',
    description:
      '"Destroy target creature if it has mana value N or less" — the plain (revolt-free) wording of the same restriction',
    pattern: new RegExp(`^destroy target creature if it has mana value ${COUNT_TOKEN} or less$`),
    needsChosenTarget: true,
    build(match) {
      const maxManaValue = parseCount(match[1]);
      if (maxManaValue === null) return null;
      return effects({
        primitive: 'destroyTarget',
        params: { targets: CREATURE_TARGET, maxManaValue },
      });
    },
  },
  {
    id: 'destroy-target-creature',
    description: '"Destroy target [non-COLOR] creature [with mana value N or less]"',
    pattern: new RegExp(
      `^destroy target (non(?:white|blue|black|red|green) )?creature(?: with mana value ${COUNT_TOKEN} or less)?$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const params: Record<string, unknown> = { targets: CREATURE_TARGET };
      if (match[1]) {
        const color = COLOR_WORDS[match[1].trim().replace('non', '')];
        if (!color) return null;
        params.notColor = color;
      }
      if (match[2]) {
        const maxManaValue = parseCount(match[2]);
        if (maxManaValue === null) return null;
        params.maxManaValue = maxManaValue;
      }
      return effects({ primitive: 'destroyTarget', params });
    },
  },
  {
    id: 'destroy-all-creatures',
    description: '"Destroy all creatures"',
    pattern: /^destroy all creatures$/,
    build() {
      return effects({ primitive: 'destroyAll' });
    },
  },
  {
    id: 'tap-all-creatures',
    description:
      '"Tap all creatures your opponents control" / "…you control" — a Falter-style mass tap, and Cryptic Command\'s third mode',
    pattern: /^tap all creatures (your opponents control|your opponent controls|you control)$/,
    build(match) {
      const who = match[1]!.startsWith('you control') ? 'controller' : 'opponent';
      return effects({ primitive: 'tapPermanents', params: { who, types: ['creature'] } });
    },
  },
  {
    id: 'untap-all-permanents',
    description:
      '"Untap all lands you control" / "Untap all nonland permanents you control" (Wilderness Reclamation, Unstoppable Plan)',
    // The mirror of `tap-all-creatures`, on the same primitive: untapping is the
    // same traversal with the flag flipped, so it is data rather than a second
    // mechanism. "Nonland permanents" is the full permanent-type list minus
    // lands — written as an exclusion so it cannot drift from what a permanent is.
    pattern: /^untap all (lands|nonland permanents|creatures) you control$/,
    build(match) {
      const what = match[1] ?? '';
      const params: Record<string, unknown> = { who: 'controller', untap: true };
      if (what === 'lands') params.types = ['land'];
      else if (what === 'creatures') params.types = ['creature'];
      else {
        params.types = [...PERMANENT_TYPES];
        params.excludeTypes = ['land'];
      }
      return effects({ primitive: 'tapPermanents', params });
    },
  },
  {
    id: 'modal-choose',
    description:
      '"Choose one/two/one or both/up to N — • MODE • MODE" (charms, commands, confluences), optionally with "You may choose the same mode more than once" — modes and their targets are chosen AT CAST (CR 601.2b/c)',
    // `text.ts` folds the header and its bullets into one line, so this sees the
    // whole block. Each mode compiles through the ordinary effect rules, which
    // means a modal card can only ever offer modes the engine can really run.
    pattern: new RegExp(
      `^choose\\s+(${MODAL_HEADER_PHRASE})\\s*\\.?\\s*(?:(${REPEATED_MODES_PHRASE})\\s*\\.?\\s*)?[—-]\\s*(•.+)$`,
    ),
    build(match, ctx) {
      const counts = MODAL_HEADER_COUNTS[match[1]!.toLowerCase()];
      if (counts === undefined) return null;
      const allowRepeats = match[2] !== undefined;

      const bodies = match[3]!
        .split('•')
        .map((mode) => mode.trim())
        .filter((mode) => mode.length > 0);
      if (bodies.length < 2) return null; // not really a choice

      const modes: SpellMode[] = [];
      for (const [index, body] of bodies.entries()) {
        // A mode the engine cannot run makes the WHOLE card unsupported. Half a
        // modal spell is not a modal spell — offering only the modes we happen
        // to implement would silently change what the card can do.
        //
        // `compileTriggerBody` is the right compiler here, and not by accident:
        // a mode, like a trigger, has to DECLARE what it may be aimed at rather
        // than inherit a target the caster already named — and it refuses a body
        // wanting two targets, which no printed mode has.
        const compiled = ctx.compileTriggerBody(body);
        if (!compiled || compiled.effects.length === 0) return null;
        modes.push({
          id: `mode${index + 1}`,
          // The bodies arrive from the NORMALIZED clause (lowercased, `~` for
          // the card's own name), and this label is shown to a human choosing a
          // mode — so it is tidied back into a sentence rather than printed as
          // compiler intermediate text.
          label: modeLabel(body, ctx.card.name),
          effects: compiled.effects,
          ...(compiled.targets !== undefined ? { targets: compiled.targets } : {}),
        });
      }
      // A printed count larger than the menu is a malformed record, not a card:
      // clamp so the announced minimum is always satisfiable. (Repeats make any
      // count satisfiable, so they are left alone.)
      const max = allowRepeats ? counts.max : Math.min(counts.max, modes.length);
      return {
        modal: {
          min: Math.min(counts.min, max),
          max,
          ...(allowRepeats ? { allowRepeats: true } : {}),
          modes,
        },
      };
    },
  },
  {
    id: 'destroy-target-artifact',
    description: '"Destroy target artifact"',
    pattern: /^destroy target artifact$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'destroyTarget', params: { targets: ARTIFACT_TARGET } });
    },
  },
  {
    id: 'destroy-target-permanent',
    description: '"Destroy target permanent"',
    // The unrestricted form (Argentum Armor's attack trigger, Vindicate's body).
    // It aims at core's `'permanent'` restriction rather than widening the
    // creature one, because a card that can only ever be pointed at creatures is
    // a strictly narrower card than the one printed.
    pattern: /^destroy target permanent$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'destroyTarget', params: { targets: PERMANENT_TARGET } });
    },
  },
  {
    id: 'target-opponent-loses-life',
    description: '"Target opponent loses N life"',
    // Now expressible: `TargetRestriction` can say "a player who isn't you", so
    // the spell can no longer be offered pointing at its own caster.
    pattern: new RegExp(`^target opponent loses ${COUNT_TOKEN} life$`),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[1]!);
      if (amount === null) return null;
      return effects({
        primitive: 'loseLife',
        params: { amount, targetPlayer: true, targets: OPPONENT_TARGET },
      });
    },
  },
  {
    id: 'put-counters-on-target',
    description: '"Put N +1/+1 counters on target creature"',
    pattern: new RegExp(`^put (?:a|${COUNT_TOKEN}) \\+1/\\+1 counters? on target creature$`),
    needsChosenTarget: true,
    build(match) {
      // "a counter" has no count token to parse — it is exactly one.
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      return effects({
        primitive: 'addCounters',
        params: { amount, targets: CREATURE_TARGET },
      });
    },
  },
  {
    // "…on target creature YOU CONTROL" (Snakeskin Veil). Its own rule rather
    // than a widened one: `'creature'` would let a pilot grow the opponent's
    // board, which is a card playing differently from its printed text.
    id: 'put-counters-on-target-you-control',
    description: '"Put N +1/+1 counters on target creature you control"',
    pattern: new RegExp(
      `^put (?:a|${COUNT_TOKEN}) \\+1/\\+1 counters? on target creature you control$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      return effects({
        primitive: 'addCounters',
        params: { amount, targets: CREATURE_YOU_CONTROL_TARGET },
      });
    },
  },
  {
    /**
     * The whole two-sentence combat trick as ONE rule — "Put a +1/+1 counter on
     * target creature you control. **It** gains hexproof until end of turn."
     * (Snakeskin Veil).
     *
     * One rule rather than a rule per sentence, because "it" means *the creature
     * the sentence before targeted*. A standalone "it gains …" rule would be
     * aimed independently wherever the compiler met it — in a triggered ability
     * core would aim it at any creature on the table — so the two sentences are
     * only trustworthy while they are matched together, with a single target
     * shared by both effects.
     */
    id: 'put-counters-then-grant-keyword',
    description:
      '"Put N +1/+1 counters on target creature [you control]. It gains KEYWORD[, KEYWORD, and KEYWORD] until end of turn"',
    pattern: new RegExp(
      `^put (?:a|${COUNT_TOKEN}) \\+1/\\+1 counters? on target creature( you control)?\\. ` +
        `it gains (.+) until end of turn$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      // A LIST of keywords ("reach, trample, hexproof, and indestructible" —
      // Gaea's Gift, reachable now that `indestructible` is a real flag), read
      // by the same parser the anthem rule uses: it rejects the whole line on
      // any word the engine does not model, so a PARTIAL grant — a card playing
      // weaker than printed — is never emitted.
      const keywords = parseKeywordList(match[3] ?? '');
      if (amount === null || keywords === null) return null;
      const restriction = match[2] ? CREATURE_YOU_CONTROL_TARGET : CREATURE_TARGET;
      return effects(
        { primitive: 'addCounters', params: { amount, targets: restriction } },
        // The grant deliberately carries NO target of its own: it reads the
        // target already chosen for the spell, which is what "it" means.
        { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords } },
      );
    },
  },
  {
    // The same template with -1/-1 counters. Now that the stat layer reads that
    // kind in its own right, this is a faithful compile rather than an
    // approximation stored as a negative +1/+1.
    id: 'put-minus-counters-on-target',
    description: '"Put N -1/-1 counters on target creature"',
    pattern: new RegExp(`^put (?:a|${COUNT_TOKEN}) -1/-1 counters? on target creature$`),
    needsChosenTarget: true,
    build(match) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      return effects({
        primitive: 'addCounters',
        params: { amount: -amount, targets: CREATURE_TARGET },
      });
    },
  },
  {
    // "Put a +1/+1 counter on it" / "on ~" — the SELF form. Extremely common as
    // the payload of an ETB or attack trigger, and it needs no target, which is
    // why the targeted rule above could never match it.
    id: 'put-counters-on-self',
    description: '"Put N +1/+1 counters on ~" (no target)',
    pattern: new RegExp(
      `^put (?:a|${COUNT_TOKEN}) \\+1/\\+1 counters? on (?:~|it|this creature)$`,
    ),
    build(match) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      return effects({ primitive: 'addCounters', params: { amount, self: true } });
    },
  },
  {
    /**
     * A CONJUNCTION whose second half is a plain "you …" effect — "put a +1/+1
     * counter on ~ **and you gain 1 life**" (Sunscorch Regent).
     *
     * Deliberately narrow. Only a second half beginning "you " or "draw " is
     * joined, because such a half is self-contained: it speaks about the
     * controller, not about whatever the first half touched, so running the two
     * in order is exactly what the printed sentence says. A conjunction like "…and it gains
     * flying" refers BACK to the first half's object, and joining those would be
     * the kind of guess this table exists to refuse — so it stays reported.
     *
     * Both halves are compiled TARGET-FREE, which is what makes the composition
     * safe in a triggered ability as well as in a spell: a half needing a chosen
     * target is rejected rather than compiled into a silent no-op.
     */
    id: 'effect-and-you-effect',
    description: '"EFFECT and you EFFECT" (two independent halves in one sentence)',
    pattern: /^(.+?) and ((?:you|draw) .+)$/,
    build(match, ctx) {
      const first = ctx.compileEffectClause(match[1] ?? '', { targetFree: true });
      if (first === null || first.length === 0) return null;
      const second = ctx.compileEffectClause(match[2] ?? '', { targetFree: true });
      if (second === null || second.length === 0) return null;
      return { effects: [...first, ...second] };
    },
  },
  {
    // The GROUP form — "put a +1/+1 counter on EACH creature you control".
    // Gavony Township, Steel Overseer and Cathars' Crusade all print it, and it
    // is the same `addCounters` primitive with a scope + filter instead of a
    // target, so the counters are the same real counters the stat layer reads.
    id: 'put-counters-on-each',
    description: '"Put N +1/-1 counters on each CREATURE-GROUP"',
    pattern: new RegExp(
      `^put (?:a|${COUNT_TOKEN}) (\\+1/\\+1|-1/-1) counters? on each (.+)$`,
    ),
    build(match, ctx) {
      const magnitude = match[1] === undefined ? 1 : parseCount(match[1]);
      if (magnitude === null) return null;
      const group = groupCreatureScope(match[3] ?? '', ctx);
      if (group === null) return null;
      const amount = match[2] === '-1/-1' ? -magnitude : magnitude;
      return effects({
        primitive: 'addCounters',
        params: { amount, each: true, scope: group.scope, filter: group.filter },
      });
    },
  },
  {
    id: 'draw-and-lose-life',
    description: '"You draw N cards and you lose M life" (one sentence, two effects)',
    // Printed as a single sentence, so the sentence splitter never separates it
    // into the two clauses that each already compile. Night's Whisper, Sign in
    // Blood, and the whole black card-draw family read this way.
    pattern: new RegExp(
      `^(?:you )?draws? ${COUNT_TOKEN} cards? and (?:you )?loses? ${COUNT_TOKEN} life$`,
    ),
    build(match) {
      const count = parseCount(match[1]!);
      const life = parseCount(match[2]!);
      if (count === null || life === null) return null;
      return effects(
        { primitive: 'drawCards', params: { count } },
        { primitive: 'loseLife', params: { amount: life } },
      );
    },
  },
  {
    id: 'target-player-draws-and-loses-life',
    description: '"Target player draws N cards and loses M life" (Sign in Blood)',
    // The TARGETED sibling of `draw-and-lose-life`: both halves land on the
    // chosen player (who may be the caster — 'player', not 'opponent').
    pattern: new RegExp(
      `^target player draws ${COUNT_TOKEN} cards? and loses ${COUNT_TOKEN} life$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const count = parseCount(match[1]);
      const life = parseCount(match[2]);
      if (count === null || life === null) return null;
      return effects(
        { primitive: 'drawCards', params: { count, whichPlayer: 'targetPlayer', targets: PLAYER_TARGET } },
        { primitive: 'loseLife', params: { amount: life, targetPlayer: true } },
      );
    },
  },
  {
    id: 'return-target-permanent-to-hand',
    description: '"Return target creature/permanent to its owner\'s hand" (bounce)',
    pattern: /^return target (creature|permanent) to (?:its|their) owner'?s hand$/,
    needsChosenTarget: true,
    build(match) {
      // `returnToHand` has existed in the primitive library the whole time with
      // no rule able to reach it — bounce was reported unsupported purely for
      // want of this pattern.
      //
      // "Target PERMANENT" is its own restriction and is NOT flattened to
      // "creature": Cryptic Command bounces a land, and a bounce that could not
      // would be a strictly weaker card than printed. (It used to flatten,
      // because core had no `'permanent'` restriction to compile into.)
      const restriction = match[1] === 'permanent' ? PERMANENT_TARGET : CREATURE_TARGET;
      return effects({ primitive: 'returnToHand', params: { targets: restriction } });
    },
  },
  {
    id: 'return-chosen-permanent-to-hand',
    description:
      "\"Return a land/creature/artifact/permanent you control to its owner's hand\" — the karoo lands' drawback, chosen at resolution rather than targeted",
    // NOT the same template as `return-target-permanent-to-hand` above, and the
    // difference is not cosmetic: that one AIMS at a permanent (a target, checked
    // for hexproof, lost if it becomes illegal), and this one has its controller
    // PICK one of their own at resolution. Nothing targets, so the ability cannot
    // be fizzled and hexproof is irrelevant — see `returnChosenToHand`.
    //
    // "You may" is deliberately NOT accepted here. No printed card in this family
    // prints it, and the general `mayEffects` wrapper already handles the optional
    // form for any that ever does; matching it here would swallow the word
    // without implementing the option.
    pattern: new RegExp(
      `^return an? (${Object.keys(STATIC_NOUN_TYPES).join('|')}) you control to (?:its|their) owner'?s hand$`,
    ),
    build(match) {
      const filter = permanentNounFilter(match[1] ?? '');
      if (filter === undefined) return null;
      return effects({
        primitive: 'returnChosenToHand',
        // "A permanent" is every type, which `permanentNounFilter` returns as an
        // EMPTY filter — omitted, because an absent filter already matches
        // everything and an empty object in the params would only be noise.
        params: Object.keys(filter).length > 0 ? { filter } : {},
      });
    },
  },
  {
    id: 'creature-fights',
    description: '"~ fights target creature"',
    pattern: /^~ fights target creature$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'fight', params: { targets: CREATURE_TARGET } });
    },
  },
  {
    id: 'target-player-mills',
    description: '"Target player mills N cards"',
    pattern: new RegExp(`^target (player|opponent) mills ${COUNT_TOKEN} cards?$`),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[2]!);
      if (amount === null) return null;
      return effects({ primitive: 'mill', params: { amount, targets: PLAYER_TARGET } });
    },
  },
  {
    id: 'self-mill',
    description: '"You mill N cards" / "Mill N cards"',
    pattern: new RegExp(`^(?:you )?mills? ${COUNT_TOKEN} cards?$`),
    build(match) {
      const amount = parseCount(match[1]!);
      if (amount === null) return null;
      return effects({ primitive: 'mill', params: { amount, self: true } });
    },
  },
  {
    id: 'damage-to-each-creature',
    description: '"~ deals N damage to each creature"',
    pattern: new RegExp(`^~ deals ${COUNT_TOKEN} damage to each creature$`),
    build(match) {
      const amount = parseCount(match[1]!);
      if (amount === null) return null;
      return effects({ primitive: 'dealDamageToEach', params: { amount, creatures: true } });
    },
  },
  {
    id: 'damage-to-each-opponent',
    description: '"~ deals N damage to each opponent"',
    pattern: new RegExp(`^~ deals ${COUNT_TOKEN} damage to each opponent$`),
    build(match) {
      const amount = parseCount(match[1]!);
      if (amount === null) return null;
      return effects({ primitive: 'dealDamageToEach', params: { amount, opponents: true } });
    },
  },
  {
    id: 'damage-to-each-creature-and-player',
    description: '"~ deals N damage to each creature and each player"',
    pattern: new RegExp(`^~ deals ${COUNT_TOKEN} damage to each creature and each player$`),
    build(match) {
      const amount = parseCount(match[1]!);
      if (amount === null) return null;
      return effects({
        primitive: 'dealDamageToEach',
        params: { amount, creatures: true, players: true },
      });
    },
  },
  {
    id: 'gain-control-until-eot',
    description:
      '"Gain control of target creature until end of turn. Untap it. It gains haste."',
    // The riders are optional in the pattern but captured, because they change
    // what the card DOES: without haste a stolen creature cannot attack, so a
    // card that prints them and a card that does not are different cards.
    // "Untap it" and "Untap that creature" are the same instruction — Act of
    // Treason prints the latter — so both fold onto the one `untap` flag.
    pattern:
      /^gain control of target creature until end of turn(?:\. untap (?:it|that creature))?(?:\. it gains haste until end of turn|\. it gains haste)?$/,
    needsChosenTarget: true,
    build(match) {
      const text = match[0];
      return effects({
        primitive: 'gainControl',
        params: {
          targets: CREATURE_TARGET,
          ...(text.includes('untap') ? { untap: true } : {}),
          ...(text.includes('gains haste') ? { haste: true } : {}),
        },
      });
    },
  },
  {
    id: 'exile-target-creature',
    description: '"Exile target creature"',
    pattern: /^exile target creature$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'exileTarget', params: { targets: CREATURE_TARGET } });
    },
  },
  {
    id: 'exile-creature-controller-gains-life',
    description: '"Exile target creature. Its controller gains life equal to its power."',
    pattern: /^exile target creature\. its controller gains life equal to its power$/,
    needsChosenTarget: true,
    build() {
      return effects({
        primitive: 'exileTarget',
        params: { gainLifeEqualPower: true, targets: CREATURE_TARGET },
      });
    },
  },
  {
    // Delver of Secrets' upkeep body, whole-line: the look, the optional
    // reveal, and the conditional transform are ONE primitive
    // (`transformRevealTop`), because splitting them into sentences would leave
    // "You may reveal that card" meaning nothing on its own. Both Oracle
    // wordings of the condition are accepted (the template was retemplated in
    // 2021). Only the instant-or-sorcery filter is reproduced — a different
    // type list is a different card and stays reported rather than guessed.
    id: 'reveal-top-transform',
    description:
      '"Look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform ~" (Delver of Secrets)',
    pattern:
      /^look at the top card of your library\. you may reveal that card\. if (?:an instant or sorcery card is revealed this way|it's an instant or sorcery card), transform ~$/,
    build() {
      return effects({
        primitive: 'transformRevealTop',
        params: { filter: { anyOfTypes: ['instant', 'sorcery'] } },
      });
    },
  },
  {
    id: 'copy-target-spell',
    description:
      `"Copy target instant or sorcery spell[, then return it to its owner's hand]. You may choose new targets for the copy." (Reverberate, Fork, Reiterate, Narset's Reversal) — CR 707.10`,
    // ONE rule for the whole printed idiom, matched on the WHOLE LINE rather
    // than sentence by sentence, because "you may choose new targets for the
    // copy" is not an effect of its own — it is the permission that governs the
    // copy the first sentence makes. Split them and the second sentence is a
    // vacuous rule that contributes nothing, which is exactly the shape this
    // table refuses everywhere else.
    pattern:
      /^copy target instant or sorcery spell(, then return (?:it|that spell) to its owner's hand)?(\. you may choose new targets for the copy)?$/,
    needsChosenTarget: true,
    build(match) {
      const refs: EffectRef[] = [
        {
          primitive: 'copySpell',
          params: {
            targets: INSTANT_OR_SORCERY_SPELL_TARGET,
            // The printed permission, carried as data so a card that does NOT
            // print it (and they exist) keeps the original's aim rather than
            // being handed a free re-aim it never had.
            mayRetarget: match[2] !== undefined,
          },
        },
      ];
      // "…, THEN return it to its owner's hand" (Narset's Reversal). A second
      // ref rather than a flag on the copy, because it is a second printed
      // sentence with its own meaning: the spell is RETURNED, not countered, so
      // "this spell can't be countered" does not stop it. Ordered AFTER the copy
      // because the copy is made while the original is still on the stack.
      if (match[1] !== undefined) {
        refs.push({ primitive: 'returnSpellToHand', params: { targets: INSTANT_OR_SORCERY_SPELL_TARGET } });
      }
      return effects(...refs);
    },
  },
  {
    id: 'create-token-copy',
    description:
      `"Create [N] token[s] that's a copy of <selector>[, except <clauses>][. If this spell was kicked, create five of those tokens instead]" (Rite of Replication, Cackling Counterpart, Giant Adephage) — CR 707.2`,
    // The selector and the "except" tail are parsed by the SAME two closed
    // tables the as-enters copy uses (`parseCopyException`), so "except it has
    // haste" means one thing in this codebase rather than two. A selector or a
    // clause outside them returns null and the card reports.
    pattern: /^create (a|an|one|two|three|four|five) tokens? that(?:'s a copy|s are copies) of (.+)$/,
    build(match, ctx) {
      return buildTokenCopy(match[1] ?? 'a', match[2] ?? '', ctx);
    },
  },
  {
    id: 'counter-target-spell',
    description: '"Counter target spell"',
    pattern: /^counter target spell$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'counterSpell', params: { targets: SPELL_TARGET } });
    },
  },
  {
    id: 'counter-target-spell-unless-pays',
    description: '"Counter target spell unless its controller pays {3}" (Mana Leak)',
    // Anchored to the end ON PURPOSE. Rune Snag's "…pays {2} plus an additional
    // {2} for each card named Rune Snag in each graveyard" must NOT match: its
    // cost is derived from both graveyards, and a rule that quietly charged the
    // flat {2} would make the card strictly weaker than printed.
    pattern: /^counter target spell unless its controller pays ((?:\{[^}]+\})+)$/,
    needsChosenTarget: true,
    build(match) {
      // A cost with a symbol the engine cannot charge ({X}, hybrid, Phyrexian)
      // returns null here, so the clause keeps reporting rather than compiling to
      // a cheaper payment than printed.
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return effects({
        primitive: 'counterUnlessPaid',
        params: { targets: SPELL_TARGET, unlessPaid: cost },
      });
    },
  },
  {
    id: 'counter-target-spell-unless-pays-x',
    description:
      '"Counter target spell unless its controller pays {X}" (Condescend) — the payment is the X chosen and paid for at cast time',
    pattern: /^counter target spell unless its controller pays \{x\}$/,
    needsChosenTarget: true,
    build(_match, ctx) {
      // Gated on the card actually printing {X} in its COST, exactly like the
      // other X rules: an X defined by a "where X is …" clause is not the
      // cast-time X, and charging it as one would price the counter wrongly.
      if (!cardHasXCost(ctx)) return null;
      return effects({
        primitive: 'counterUnlessPaid',
        params: { targets: SPELL_TARGET, unlessPaidX: true },
      });
    },
  },
  {
    id: 'pump-until-eot',
    description: '"Target creature gets +X/+Y until end of turn"',
    pattern: /^target creature gets ([+-]\d+)\/([+-]\d+) until end of turn$/,
    needsChosenTarget: true,
    build(match) {
      const power = Number.parseInt(match[1] ?? '', 10);
      const toughness = Number.parseInt(match[2] ?? '', 10);
      if (!Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      return effects({
        primitive: 'pumpUntilEndOfTurn',
        params: { power, toughness, targets: CREATURE_TARGET },
      });
    },
  },
  {
    // The SELF form, printed on every "grows when you do X" creature (prowess's
    // reminder text, Kiln Fiend, …). It needs no chosen target — the primitive
    // falls back to its own source — which is exactly why it is the only pump a
    // triggered ability may use (see `needsChosenTarget` and `triggerFrom`).
    id: 'self-pump-until-eot',
    description: '"~ gets +X/+Y until end of turn" (the source pumps itself)',
    pattern: /^~ gets ([+-]\d+)\/([+-]\d+) until end of turn$/,
    build(match) {
      const power = Number.parseInt(match[1] ?? '', 10);
      const toughness = Number.parseInt(match[2] ?? '', 10);
      if (!Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      return effects({ primitive: 'pumpUntilEndOfTurn', params: { power, toughness } });
    },
  },
  {
    id: 'pump-and-grant-until-eot',
    description: '"Target creature gets +X/+Y and gains KEYWORD until end of turn"',
    pattern: new RegExp(
      `^target creature gets ([+-]\\d+)\\/([+-]\\d+) and gains ${KEYWORD_TOKEN} until end of turn$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const power = Number.parseInt(match[1] ?? '', 10);
      const toughness = Number.parseInt(match[2] ?? '', 10);
      const keywords = keywordFlag(match[3] ?? '');
      if (!Number.isFinite(power) || !Number.isFinite(toughness) || !keywords) return null;
      return effects(
        { primitive: 'pumpUntilEndOfTurn', params: { power, toughness, targets: CREATURE_TARGET } },
        { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords, targets: CREATURE_TARGET } },
      );
    },
  },
  {
    // The MASS grant: "Creatures you control gain indestructible until end of
    // turn" (Selfless Spirit), "Permanents you control gain hexproof and
    // indestructible until end of turn" (Heroic Intervention).
    //
    // It is its own primitive rather than a flag on the single-target grant
    // because it TARGETS NOTHING: there is no chosen creature and no legality
    // question, and the set it reaches is read off the board at resolution. Nor
    // is it a static - the grant outlives the spell that made it (to cleanup)
    // and reaches only what was on the battlefield when it resolved.
    id: 'mass-grant-keyword-until-eot',
    description: '"Creatures/permanents you control gain KEYWORDS until end of turn"',
    pattern: new RegExp(
      `^(${Object.keys(STATIC_NOUN_TYPES).join('|')})s you control gain (.+) until end of turn$`,
    ),
    build(match) {
      const nounType = STATIC_NOUN_TYPES[match[1] ?? ''];
      if (nounType === undefined) return null;
      const keywords = parseKeywordList(match[2] ?? '');
      // A keyword the engine does not model reports the whole line rather than
      // granting only the half we understood.
      if (keywords === null) return null;
      return effects({
        primitive: 'grantKeywordToYoursUntilEndOfTurn',
        params: { keywords, ...(nounType === null ? {} : { anyOfTypes: [nounType] }) },
      });
    },
  },
  {
    // The SELF form of the evasion grant, with a comparing restriction attached:
    // "~ can't be blocked this turn except by creatures with haste" (Gingerbrute's
    // activated ability). It is the same continuous grant as every other
    // until-end-of-turn keyword — `grantKeywordUntilEndOfTurn` falls back to the
    // SOURCE when no target was chosen, which is what an activated ability on the
    // creature itself gives it — so it expires at cleanup through the one path.
    id: 'grant-self-block-restriction-until-eot',
    description: `"~ can't be blocked this turn except by creatures with haste" (Gingerbrute)`,
    pattern: /^~ can'?t be blocked this turn except by creatures with ([a-z ]+)$/,
    build(match) {
      const keyword = BLOCKER_QUALITY_KEYWORDS[(match[1] ?? '').trim()];
      if (keyword === undefined) return null;
      return effects({
        primitive: 'grantKeywordUntilEndOfTurn',
        params: { keywords: { blockRestriction: { blockerMustHaveAnyOf: [keyword] } } },
      });
    },
  },
  {
    // Evasion granted as a one-shot ("Target creature can't be blocked this
    // turn") - the printed body of Rogue's Passage, Manifold Key, Whirler Rogue,
    // Thassa and the spell Enter the Enigma alike. It is the same continuous
    // grant every other until-end-of-turn keyword uses, so it expires at cleanup
    // through the one path rather than needing a combat-specific memory.
    //
    // "Target creature you control" narrows only WHO may be chosen, which the
    // target restriction already carries; the granted keyword is identical.
    id: 'grant-unblockable-until-eot',
    description: `"Target creature [you control] can't be blocked this turn"`,
    pattern: /^target creature( you control)? can'?t be blocked this turn$/,
    needsChosenTarget: true,
    build(match) {
      return effects({
        primitive: 'grantKeywordUntilEndOfTurn',
        params: {
          keywords: { unblockable: true },
          targets: match[1] ? CREATURE_YOU_CONTROL_TARGET : CREATURE_TARGET,
        },
      });
    },
  },
  {
    id: 'grant-keyword-until-eot',
    description: '"Target creature gains KEYWORD until end of turn"',
    pattern: new RegExp(`^target creature gains ${KEYWORD_TOKEN} until end of turn$`),
    needsChosenTarget: true,
    build(match) {
      const keywords = keywordFlag(match[1] ?? '');
      return keywords === null
        ? null
        : effects({
            primitive: 'grantKeywordUntilEndOfTurn',
            params: { keywords, targets: CREATURE_TARGET },
          });
    },
  },
  {
    // Protection granted as a combat trick ("Gods Willing" without the scry).
    // Compiles to the SAME grant primitive as a keyword grant; the payload is
    // the quality list, which the continuous layer unions onto the printed set
    // - so an until-end-of-turn protection genuinely wears off at cleanup.
    id: 'grant-protection-until-eot',
    description: '"Target creature gains protection from [quality] until end of turn"',
    pattern: /^target creature gains protection from ([a-z, ]+?) until end of turn$/,
    needsChosenTarget: true,
    build(match) {
      const qualities = parseProtectionQualities(match[1] ?? '');
      if (qualities === null) return null;
      return effects({
        primitive: 'grantKeywordUntilEndOfTurn',
        params: { keywords: { protectionFrom: qualities }, targets: CREATURE_TARGET },
      });
    },
  },
  {
    id: 'tap-target-creature',
    description: '"Tap target creature"',
    pattern: /^tap target creature$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'tapTarget', params: { targets: CREATURE_TARGET } });
    },
  },
  {
    /**
     * **"Create N X/Y COLOR [SUBTYPES] [artifact] creature token(s) [with
     * KEYWORDS]"** - the whole printed token face, not just its size.
     *
     * A token has no mana cost and no card behind it, so every characteristic it
     * has is in THIS sentence. The rule used to read only the P/T and the last
     * descriptor word, which meant "a 1/1 **black** **Faerie Rogue** creature
     * token" entered as a colourless creature named Faerie with no creature type
     * at all - invisible to a black anthem, to protection from black, to "destroy
     * target nonblack creature" and to every typal lord, while the card compiled
     * `'complete'`. See {@link parseTokenFace} for the descriptor grammar.
     *
     * A descriptor this rule cannot read COMPLETELY refuses the whole line rather
     * than dropping the part it did not understand - a token missing a printed
     * characteristic is a different card, which is precisely the failure this
     * rule shipped with.
     */
    id: 'create-creature-token',
    description: '"Create N X/Y COLOR [SUBTYPES] [artifact] creature token(s) [with KEYWORDS]"',
    pattern: new RegExp(`^create ${COUNT_TOKEN} (\\d+)\\/(\\d+) ([a-z][a-z ]*?) tokens?(?: with (.+))?$`),
    build(match) {
      const count = parseCount(match[1]);
      const power = Number.parseInt(match[2] ?? '', 10);
      const toughness = Number.parseInt(match[3] ?? '', 10);
      if (count === null || !Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      const face = parseTokenFace(match[4] ?? '');
      if (face === null) return null;
      const params: Record<string, unknown> = {
        power,
        toughness,
        name: face.name,
        colors: face.colors,
        subtypes: face.subtypes,
      };
      // Written only when the token is more than a plain creature, so the
      // overwhelmingly common emitted record stays as short as it reads.
      if (face.types.length !== 1) params.types = face.types;
      // `count` is omitted when it is the primitive's default of one, keeping the
      // emitted data minimal and identical to the hand-authored pool's style.
      if (count !== TOKEN_DEFAULT_COUNT) params.count = count;
      if (match[5]) {
        const keywords = parseKeywordList(match[5]);
        if (!keywords) return null;
        params.keywords = keywords;
      }
      return effects({ primitive: 'makeToken', params });
    },
  },
  {
    id: 'add-mana-spell',
    description: '"Add {B}{B}{B}" (a ritual\'s resolution)',
    pattern: /^add ((?:\{[wubrgc]\})+)$/,
    build(match) {
      const colors = manaSymbols(match[1] ?? '');
      return colors === null ? null : effects({ primitive: 'addMana', params: { mana: [...colors] } });
    },
  },

  // --- templates that ASK the player something (DESIGN §3.11) -------------------
  // These compile to the choice-driven primitives in `../choice-primitives.ts`.
  // They are here for the same reason as every other rule: the engine can now play
  // the printed clause exactly, so refusing it would be the dishonest answer.
  {
    id: 'draw-then-put-back-on-top',
    description: '"Draw N cards, then put M cards from your hand on top of your library in any order" (Brainstorm)',
    pattern: new RegExp(
      `^draw ${COUNT_TOKEN} cards?, then put ${COUNT_TOKEN} cards? from your hand on top of your library in any order$`,
    ),
    build(match) {
      const drawn = parseCount(match[1]);
      const putBack = parseCount(match[2]);
      if (drawn === null || putBack === null) return null;
      return effects(
        { primitive: 'drawCards', params: { count: drawn } },
        { primitive: 'putFromHandOnTop', params: { count: putBack } },
      );
    },
  },
  {
    id: 'look-at-top-and-reorder',
    description: '"Look at the top N cards of your library, then put them back in any order" (Ponder)',
    pattern: new RegExp(`^look at the top ${COUNT_TOKEN} cards? of your library, then put them back in any order$`),
    build(match) {
      const count = parseCount(match[1]);
      return count === null ? null : effects({ primitive: 'reorderTopOfLibrary', params: { count } });
    },
  },
  {
    id: 'scry-n',
    description: '"Scry N" — look at the top N, any split between top (any order) and bottom (any order)',
    pattern: new RegExp(`^scry ${COUNT_TOKEN}$`),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null) return null;
      // `count` is omitted at the primitive's default of one, matching the
      // emitted-data style of every other rule.
      return effects({ primitive: 'scry', ...(count === SCRY_DEFAULT_COUNT ? {} : { params: { count } }) });
    },
  },
  {
    id: 'surveil-n',
    description: '"Surveil N" — look at the top N, any split between top (any order) and the graveyard',
    pattern: new RegExp(`^surveil ${COUNT_TOKEN}$`),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null) return null;
      return effects({ primitive: 'surveil', ...(count === SCRY_DEFAULT_COUNT ? {} : { params: { count } }) });
    },
  },
  {
    id: 'scry-then-effect',
    description:
      '"Scry N, then EFFECT" / "Surveil N, then EFFECT" — the one-sentence rider form (Preordain, Read the Bones). The tail must itself be a target-free clause the table compiles',
    pattern: new RegExp(`^(scry|surveil) ${COUNT_TOKEN}, then (.+)$`),
    build(match, ctx) {
      const count = parseCount(match[2]);
      if (count === null) return null;
      // Target-free by construction, for the same reason as `kicked-extra-effect`:
      // this rule's own id declares no chosen target, so a targeted tail inside a
      // trigger would be aimed at nothing and silently no-op. Refusing keeps a
      // targeted combination reported rather than half-played.
      const tail = ctx.compileEffectClause(match[3]!, { targetFree: true });
      if (!tail || tail.length === 0) return null;
      return effects(
        { primitive: match[1]!, ...(count === SCRY_DEFAULT_COUNT ? {} : { params: { count } }) },
        ...tail,
      );
    },
  },
  {
    id: 'may-shuffle',
    description: '"You may shuffle"',
    pattern: /^you may shuffle(?: your library)?$/,
    build() {
      return effects({ primitive: 'mayShuffleLibrary' });
    },
  },
  {
    id: 'reveal-hand-caster-chooses-discard',
    description:
      '"Target player reveals their hand. You choose a RESTRICTION card from it. That player discards that card." (+ the "You lose N life" rider — Thoughtseize)',
    pattern: new RegExp(
      `^target player reveals their hand\\. you choose a (${DISCARD_RESTRICTION_TOKEN}) card from it\\. that player discards that card(?:\\. you lose ${COUNT_TOKEN} life)?$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const filter = discardFilterFor(match[1] ?? '');
      if (!filter) return null;
      const discard: EffectRef = {
        primitive: 'discardCard',
        // The CASTER chooses — that is what "you choose a card from it" means, and
        // it is the whole difference between Thoughtseize and a random discard.
        params: { count: 1, who: 'targetPlayer', chosenBy: 'controller', filter },
      };
      const lifeLoss = parseCount(match[2]);
      if (match[2] === undefined) return effects(discard);
      return lifeLoss === null
        ? null
        : effects(discard, { primitive: 'loseLife', params: { amount: lifeLoss } });
    },
  },
  {
    id: 'return-target-card-from-graveyard',
    description: '"[You may] return target card from your graveyard to your hand" (Eternal Witness)',
    // No `needsChosenTarget`: the card to return is picked by a CHOICE at
    // resolution, not by a target chosen at cast — which is exactly why this may
    // also be the body of a triggered ability.
    pattern: /^(you may )?return target card from your graveyard to your hand$/,
    build(match) {
      const params: Record<string, unknown> = { count: 1 };
      if (match[1]) params.optional = true;
      return effects({ primitive: 'returnFromGraveyard', params });
    },
  },
  {
    id: 'defending-player-reveals-top-land',
    description:
      '"Defending player reveals the top card of their library. If it\'s a land card, that player puts it into their hand." (Goblin Guide)',
    pattern:
      /^defending player reveals the top card of their library\. if it'?s a land card, that player puts it into their hand$/,
    build() {
      return effects({ primitive: 'revealTopCard', params: { who: 'opponent', filter: LAND_FILTER } });
    },
  },
  {
    id: 'fetch-land-by-subtype',
    description:
      '"Search your library for a Mountain or Plains card, put it onto the battlefield, then shuffle." (the fetchland body)',
    // Matches one or two land subtypes joined by "or", with the optional
    // "tapped" and the optional trailing shuffle both printed forms carry.
    // Selection is by SUBTYPE, so this finds a dual land with those land types
    // exactly as the printed card does — not just a basic.
    // The list may be any length: a fetchland prints two, Farseek prints four
    // ("a Plains, Island, Swamp, or Mountain card"). `landTypeList` refuses any
    // word that is not a land type, so "a basic Swamp … card" falls through to
    // the basic-types rule instead of being read as a subtype search — those are
    // genuinely different cards (this one finds a DUAL), and the printed word
    // "basic" is the only thing that tells them apart.
    pattern:
      /^search your library for an? ([a-z]+(?:,? (?:or )?[a-z]+)*) card, put (?:it|that card) onto the battlefield( tapped)?(?:, then shuffle)?$/,
    build(match) {
      const subtypes = landTypeList(match[1] ?? '');
      // Only LAND subtypes are safe here: a non-land search would need the card
      // to be castable, which this template does not express.
      if (!subtypes) return null;
      return effects({
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          filter: { anyOfTypes: ['land'], anyOfSubtypes: subtypes },
          destination: 'battlefield',
          ...(match[2] ? { tapped: true } : {}),
        },
      });
    },
  },
  {
    id: 'each-player-discards',
    description: '"Each player discards a card" (Liliana of the Veil\'s +1)',
    pattern: new RegExp(`^each player discards ${COUNT_TOKEN} cards?$`),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null) return null;
      // Both seats choose their own discards, APNAP — see `discardCard`'s
      // eachPlayer branch. `count` is omitted at the primitive default of one.
      const params: Record<string, unknown> = { who: 'eachPlayer' };
      if (count !== 1) params.count = count;
      return effects({ primitive: 'discardCard', params });
    },
  },
  {
    id: 'target-player-sacrifices',
    description: '"Target player sacrifices a creature" (the edict template; Liliana\'s −2)',
    pattern: /^target (player|opponent) sacrifices an? (creature|land|artifact|permanent)$/,
    needsChosenTarget: true,
    build(match) {
      const restriction = match[1] === 'opponent' ? OPPONENT_TARGET : PLAYER_TARGET;
      const kind = match[2]!;
      // "a permanent" is any type; the rest narrow by card type. The VICTIM
      // chooses which — that is the whole card (see `sacrificeChosen`).
      const filter = kind === 'permanent' ? undefined : { anyOfTypes: [kind as CardType] };
      return effects({
        primitive: 'sacrificeChosen',
        params: {
          targets: restriction,
          who: 'targetPlayer',
          ...(filter ? { filter } : {}),
        },
      });
    },
  },
  {
    id: 'each-player-sacrifices',
    description:
      '"Each player sacrifices a [nontoken] creature of their choice" (Fleshbag Marauder, Merciless Executioner, Accursed Marauder)',
    // Ordered BEFORE `each-opponent-sacrifices` only for readability — the two
    // patterns are disjoint ("each player" vs "each opponent"/"each other
    // player"). They are separate entries because they are separate CARDS: this
    // one hits its own controller too, and compiling it as the opponent-only
    // form would print a strictly better card.
    //
    // "Of their choice" is the printed reminder that the victim picks, which is
    // what `sacrificeChosen` does by construction; it is optional in the pattern
    // because older printings omit it.
    pattern:
      /^each player sacrifices an? (nontoken )?(creature|land|artifact|permanent)(?: of their choice)?$/,
    build(match) {
      const kind = match[2]!;
      const filter: Record<string, unknown> = {};
      if (kind !== 'permanent') filter.anyOfTypes = [kind as CardType];
      // "Nontoken" is a printed narrowing with an exact `CardFilter` field, so it
      // is expressible rather than reported: a token creature does not qualify.
      if (match[1]) filter.isToken = false;
      return effects({
        primitive: 'sacrificeChosen',
        params: { who: 'each', ...(Object.keys(filter).length > 0 ? { filter } : {}) },
      });
    },
  },
  {
    id: 'each-opponent-sacrifices',
    description:
      '"Each opponent sacrifices a creature of their choice" (Dictate of Erebos; Grave Pact prints "each other player")',
    // UNTARGETED, unlike `target-player-sacrifices` above — which is why it is a
    // separate entry: a trigger body has no chosen target to read.
    //
    // "Each other player" and "each opponent" are the same set here and only
    // here: this engine seats exactly two players, so the printed plural has
    // exactly one referent. Both wordings are accepted for that reason, and for
    // no broader one.
    pattern:
      /^each (?:opponent|other player) sacrifices an? (creature|land|artifact|permanent)(?: of their choice)?$/,
    build(match) {
      const kind = match[1]!;
      const filter = kind === 'permanent' ? undefined : { anyOfTypes: [kind as CardType] };
      return effects({
        primitive: 'sacrificeChosen',
        params: { who: 'opponent', ...(filter ? { filter } : {}) },
      });
    },
  },
  {
    id: 'each-opponent-loses-life-you-gain',
    description:
      '"Each opponent loses N life and you gain M life" (Bastion of Remembrance\'s death trigger)',
    pattern: new RegExp(
      `^each opponent loses ${COUNT_TOKEN} life and you gain ${COUNT_TOKEN} life$`,
    ),
    build(match) {
      const lost = parseCount(match[1]);
      const gained = parseCount(match[2]);
      if (lost === null || gained === null) return null;
      return effects(
        { primitive: 'loseLife', params: { amount: lost, whichPlayer: 'opponent' } },
        { primitive: 'gainLife', params: { amount: gained } },
      );
    },
  },
  {
    id: 'draw-then-discard',
    description: '"Draw N cards. If you do, discard a card" (Mask of Memory)',
    // "If you do" is the printed acknowledgement that the whole clause hangs off
    // an OPTION — it is the body of a "you may", and that option is all-or-
    // nothing, so taking it means both halves happen. Outside a "you may" the
    // phrase is vacuous (the draw always happens), which is the same effects in
    // the same order, so one rule serves both printings.
    pattern: new RegExp(`^draw ${COUNT_TOKEN} cards?\\. if you do, discard ${COUNT_TOKEN} cards?$`),
    build(match) {
      const drawn = parseCount(match[1]);
      const discarded = parseCount(match[2]);
      if (drawn === null || discarded === null) return null;
      return effects(
        { primitive: 'drawCards', params: { count: drawn } },
        // "discard a card" naming no player is the CONTROLLER's own discard,
        // chosen by them — `discardCard`'s default victim is the TARGETED player,
        // which this clause does not have.
        {
          primitive: 'discardCard',
          params: { who: 'controller', ...(discarded === 1 ? {} : { count: discarded }) },
        },
      );
    },
  },
  {
    id: 'each-opponent-loses-life',
    description: '"Each opponent loses N life"',
    // The half of the rule above without the lifegain — the body a saboteur
    // trigger most often prints. UNTARGETED on purpose: "each opponent" names
    // nobody, so it must not compile to the `target opponent` form, which a
    // pilot could aim (and which would refuse to go on the stack with no legal
    // target). `whichPlayer` is what `loseLife` reads for the untargeted case.
    pattern: new RegExp(`^each opponent loses ${COUNT_TOKEN} life$`),
    build(match) {
      const amount = parseCount(match[1]!);
      return amount === null
        ? null
        : effects({ primitive: 'loseLife', params: { amount, whichPlayer: 'opponent' } });
    },
  },
  {
    id: 'gain-life-and-draw',
    description: '"You gain N life and draw a card" (Moldervine Reclamation\'s death trigger)',
    // The compound the sentence splitter cannot split: one printed sentence
    // joining two clauses the table already implements separately.
    pattern: new RegExp(`^you gain ${COUNT_TOKEN} life and draw ${COUNT_TOKEN} cards?$`),
    build(match) {
      const life = parseCount(match[1]);
      const cards = parseCount(match[2]);
      if (life === null || cards === null) return null;
      return effects(
        { primitive: 'gainLife', params: { amount: life } },
        { primitive: 'drawCards', params: { count: cards } },
      );
    },
  },
  {
    id: 'pile-split-sacrifice',
    description:
      '"Separate all permanents target player controls into two piles. That player sacrifices all permanents in the pile of their choice." (Liliana\'s −6)',
    // One whole-line idiom, not two sentences: the second sentence is
    // meaningless without the split the first one made.
    pattern:
      /^separate all permanents target player controls into two piles\. that player sacrifices all permanents in the pile of their choice$/,
    needsChosenTarget: true,
    build() {
      return effects({
        primitive: 'pileSplitSacrifice',
        params: { targets: PLAYER_TARGET, who: 'targetPlayer' },
      });
    },
  },
  {
    id: 'search-basic-land-to-battlefield',
    description:
      '"Search your library for a basic land card, put it onto the battlefield tapped, then shuffle." (Rampant Growth; Sakura-Tribe Elder\'s sacrifice body)',
    // "a basic land card" is expressible the same way Path to Exile expresses it:
    // the land filter narrowed to the five basics BY NAME (`CardFilter` has no
    // supertype field; see `restrictToNames` in ../choice-primitives.ts). Both
    // printed pronouns ("put it" / "put that card") mean the same move.
    pattern:
      /^search your library for a basic land card, put (?:it|that card) onto the battlefield( tapped)?(?:, then shuffle)?$/,
    build(match) {
      return effects({
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          filter: LAND_FILTER,
          nameAnyOf: BASIC_LAND_NAMES,
          destination: 'battlefield',
          ...(match[1] ? { tapped: true } : {}),
        },
      });
    },
  },
  {
    id: 'search-any-card',
    description:
      '"Search your library for a card, put that card into your hand/graveyard, then shuffle" (Diabolic Tutor, Grim Tutor, Vile Entomber)',
    // The UNRESTRICTED tutor: no noun before "card", so no filter at all. It is
    // its own rule rather than an optional capture on the filtered one because
    // "for a card" and "for a creature card" are different sentences, and a
    // pattern loose enough to match both would also match "for a basic land
    // card" and quietly drop the restriction.
    pattern: /^search your library for a card, put (?:it|that card) into your (hand|graveyard), then shuffle$/,
    build(match) {
      return effects({
        primitive: 'searchLibrary',
        params: { who: 'controller', count: 1, destination: match[1] === 'graveyard' ? 'graveyard' : 'hand' },
      });
    },
  },
  {
    id: 'search-to-battlefield-by-filter',
    description:
      '"Search your library for a land card, put it onto the battlefield tapped, then shuffle" (Urza’s Cave, Wood Elves)',
    // The battlefield sibling of `search-to-hand-by-filter`, sharing its noun
    // parser so "an Aura or Equipment card" cannot mean one thing when fetched to
    // hand and another when put onto the battlefield. The land-type list above
    // still runs FIRST, so a multi-type fetchland keeps its own rule.
    pattern: new RegExp(
      `^search your library for an? ${SEARCH_COLOR_PHRASE}([a-z]+(?: or [a-z]+)?) card(?: with ${SEARCH_BOUND_PHRASE} (\\d+)(?: or (less|greater))?)?, (?:reveal (?:it|that card), )?put (?:it|that card) onto the battlefield( tapped)?, then shuffle$`,
    ),
    build(match) {
      const filter = searchFilterFrom(match[2] ?? '', match[3], match[4], match[5], match[1]);
      if (filter === null) return null;
      return effects({
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          filter,
          destination: 'battlefield',
          ...(match[6] ? { tapped: true } : {}),
        },
      });
    },
  },
  {
    id: 'search-to-graveyard-by-filter',
    description: '"Search your library for a creature card, put it into your graveyard, then shuffle" (the entomb family)',
    pattern: new RegExp(
      `^search your library for an? ${SEARCH_COLOR_PHRASE}([a-z]+(?: or [a-z]+)?) card(?: with ${SEARCH_BOUND_PHRASE} (\\d+)(?: or (less|greater))?)?, (?:reveal (?:it|that card), )?put (?:it|that card) into your graveyard, then shuffle$`,
    ),
    build(match) {
      const filter = searchFilterFrom(match[2] ?? '', match[3], match[4], match[5], match[1]);
      if (filter === null) return null;
      return effects({
        primitive: 'searchLibrary',
        params: { who: 'controller', count: 1, filter, destination: 'graveyard' },
      });
    },
  },
  {
    id: 'sacrifice-a-permanent-you-control',
    description: '"Sacrifice a land." — a sacrifice as a RESOLUTION effect, not as a cost (Roiling Regrowth)',
    // The controller chooses which of their own permanents to give up, which is
    // the same question an edict asks of a victim — so it is the same primitive
    // pointed at `'controller'` rather than a second sacrifice implementation.
    // A board with nothing that qualifies sacrifices nothing, exactly as the
    // printed card does.
    pattern: /^sacrifice an? (creature|land|artifact|enchantment|permanent)$/,
    build(match) {
      const kind = match[1]!;
      const filter = kind === 'permanent' ? undefined : { anyOfTypes: [kind as CardType] };
      return effects({
        primitive: 'sacrificeChosen',
        params: { who: 'controller', ...(filter ? { filter } : {}) },
      });
    },
  },
  {
    id: 'search-basic-types-to-battlefield',
    description:
      '"Search your library for a basic Swamp, Forest, or Island card, put it onto the battlefield tapped, then shuffle" (the Landscape cycle)',
    // "a **basic** Swamp card" is a Swamp with the basic supertype, which is
    // exactly the five basics BY NAME — the same way every other basic-land
    // search in this table is written (`CardFilter` has no supertype field).
    // Contrast the fetchland rule above, whose list omits "basic" and therefore
    // finds a DUAL land as well. Dropping the word would print a better card.
    pattern:
      /^search your library for a basic ([a-z]+(?:,? (?:or )?[a-z]+)*) card, put (?:it|that card) onto the battlefield( tapped)?(?:, then shuffle)?$/,
    build(match) {
      const types = landTypeList(match[1] ?? '');
      if (!types) return null;
      const names = basicNamesFor(types);
      if (names.length === 0) return null;
      return effects({
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          filter: LAND_FILTER,
          nameAnyOf: names,
          destination: 'battlefield',
          ...(match[2] ? { tapped: true } : {}),
        },
      });
    },
  },
  {
    id: 'search-basic-lands-to-battlefield-plural',
    description:
      '"Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle" (Explosive Vegetation, Migration Path, Burnished Hart, the Harrow body)',
    // "UP TO N" is a maximum, and `searchLibrary` already implements exactly
    // that: its selection floor is zero, because a search may always fail to
    // find. So a library holding one basic (or none) plays this correctly with
    // no special case — which is the whole reason the count is a parameter and
    // not N copies of a one-card rule.
    pattern: new RegExp(
      `^search your library for up to ${COUNT_TOKEN} basic land cards, put them onto the battlefield( tapped)?, then shuffle$`,
    ),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null || count <= 0) return null;
      return effects({
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count,
          filter: LAND_FILTER,
          nameAnyOf: BASIC_LAND_NAMES,
          destination: 'battlefield',
          ...(match[2] ? { tapped: true } : {}),
        },
      });
    },
  },
  {
    id: 'search-two-basics-split-destination',
    description:
      '"Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle" (Cultivate, Kodamas Reach)',
    // The MULTI-DESTINATION search: the two found cards go to two DIFFERENT
    // zones, and which one goes where is a real decision. It compiles to
    // `searchLibrary`'s `route` param — an ordered list of steps, one per card
    // the search may find — so the answer's order IS the routing and no second
    // question has to be invented (see the primitive).
    //
    // Written as one whole-line idiom rather than two clauses because the second
    // half is meaningless without the first: "put one onto the battlefield" does
    // not say what "one" is.
    pattern:
      /^search your library for up to two basic land cards, reveal those cards, put one onto the battlefield( tapped)? and the other into your hand, then shuffle$/,
    build(match) {
      return effects({
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 2,
          filter: LAND_FILTER,
          nameAnyOf: BASIC_LAND_NAMES,
          route: [
            { destination: 'battlefield', ...(match[1] ? { tapped: true } : {}) },
            { destination: 'hand' },
          ],
        },
      });
    },
  },
  {
    id: 'search-cards-to-graveyard',
    description: '"Search your library for up to three creature cards, put them into your graveyard, then shuffle" (Buried Alive)',
    // A tutor whose destination is the GRAVEYARD — the same primitive, the same
    // filter vocabulary, one more destination. It only reaches a zone
    // `searchLibrary`'s closed destination table names, so a wording that put a
    // card anywhere else still reports.
    pattern: new RegExp(
      `^search your library for up to ${COUNT_TOKEN} ([a-z]+) cards, put them into your graveyard, then shuffle$`,
    ),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null || count <= 0) return null;
      const filter = searchFilterFrom(match[2] ?? '');
      if (filter === null) return null;
      return effects({
        primitive: 'searchLibrary',
        params: { who: 'controller', count, filter, destination: 'graveyard' },
      });
    },
  },
  {
    id: 'search-to-hand-by-filter',
    description:
      '"Search your library for a TYPE card [with CHARACTERISTIC N [or less|or greater]], reveal it, put it into your hand, then shuffle" (the Mage cycle, Goblin Matron, Recruiter of the Guard, Fierce Empath)',
    // The "reveal" is INFORMATION, not a state change: the card goes to hand
    // either way, and nothing in this engine's state can observe the difference
    // (the same reason `revealTopCard` does not log one). Every MECHANICAL
    // consequence of the printed line is exact, which is the bar for a rule.
    //
    // The restriction is not optional decoration — a tutor that ignored "with
    // mana value 1 or less" would fetch the best card in the deck instead of the
    // best cheap one, i.e. a strictly better card. `searchFilterFrom` refuses
    // anything it cannot express, so the line reports rather than over-fetches.
    //
    // The colour adjective and the reveal are both OPTIONAL halves of the same
    // template: "a **blue** instant card" (Merchant Scroll) narrows the search,
    // and a card printing no "reveal" ("…for a Goblin card, put it into your
    // hand, then shuffle") is mechanically identical — the reveal is
    // information, and no engine state can observe it.
    pattern: new RegExp(
      `^search your library for an? ${SEARCH_COLOR_PHRASE}([a-z]+(?: or [a-z]+)?) card(?: with ${SEARCH_BOUND_PHRASE} (\\d+)(?: or (less|greater))?)?, (?:reveal (?:it|that card), )?put (?:it|that card) into your hand, then shuffle$`,
    ),
    build(match) {
      const filter = searchFilterFrom(match[2] ?? '', match[3], match[4], match[5], match[1]);
      if (filter === null) return null;
      return effects({
        primitive: 'searchLibrary',
        params: { who: 'controller', count: 1, filter, destination: 'hand' },
      });
    },
  },
  {
    id: 'grant-flashback-to-graveyard-spell',
    description:
      '"Target instant or sorcery card in your graveyard gains flashback until end of turn. Its flashback cost is equal to its mana cost." (Snapcaster Mage)',
    // The cost sentence is part of THIS idiom, not a clause of its own: without
    // it the line does not say what flashing the card back costs, and a grant
    // with no price would be strictly better than the printed card. Both the
    // 2011 wording ("If that card would be put into a graveyard this turn,
    // exile it instead" is reminder text Scryfall does not print) and the plain
    // modern one are the same single sentence pair.
    needsChosenTarget: true,
    pattern:
      /^target instant or sorcery card in your graveyard gains flashback until end of turn. (?:its flashback cost is equal to its mana cost|the flashback cost is equal to its mana cost)$/,
    build() {
      return effects({
        primitive: 'grantFlashback',
        params: { targets: GRAVEYARD_SPELL_TARGET, cost: ITS_MANA_COST },
      });
    },
  },
  {
    id: 'return-graveyard-card-by-type',
    description:
      '"[You may] return target TYPE card from your graveyard to your hand" (Raise Dead)',
    // The typed sibling of `return-target-card-from-graveyard`: the same
    // resolution-time choice, narrowed by the printed card type. Like that rule
    // it carries no `needsChosenTarget` — the card is picked by a CHOICE when the
    // effect resolves — so it may also be the body of a triggered ability.
    pattern: new RegExp(
      `^(you may )?return target (${Object.keys(SPELL_TYPE_WORDS).join('|')}) card from your graveyard to your hand$`,
    ),
    build(match) {
      const type = SPELL_TYPE_WORDS[match[2] ?? ''];
      if (!type) return null;
      const params: Record<string, unknown> = { count: 1, filter: { anyOfTypes: [type] } };
      if (match[1]) params.optional = true;
      return effects({ primitive: 'returnFromGraveyard', params });
    },
  },
  {
    id: 'target-player-discards',
    description: '"Target player/opponent discards N cards" (Mind Rot)',
    // The victim chooses their own discards — that is what the plain printed
    // form means (`chosenBy` defaults to the victim; contrast the Thoughtseize
    // rule above, where "you choose" hands the pick to the caster).
    pattern: new RegExp(`^target (player|opponent) discards ${COUNT_TOKEN} cards?$`),
    needsChosenTarget: true,
    build(match) {
      const count = parseCount(match[2]);
      if (count === null) return null;
      return effects({
        primitive: 'discardCard',
        params: {
          count,
          who: 'targetPlayer',
          targets: match[1] === 'opponent' ? OPPONENT_TARGET : PLAYER_TARGET,
        },
      });
    },
  },
  {
    id: 'exile-creature-controller-may-fetch-basic',
    description:
      '"Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle." (Path to Exile)',
    // Compiled as ONE template rather than two clauses because the compensation
    // belongs to the exile: it is the exiled creature's controller who searches,
    // and only when the creature really was exiled.
    pattern:
      /^exile target creature\. its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle$/,
    needsChosenTarget: true,
    build() {
      return effects(
        { primitive: 'exileTarget', params: { targets: CREATURE_TARGET } },
        {
          primitive: 'searchLibrary',
          params: {
            who: 'targetController',
            requiresTargetInZone: 'exile',
            optional: true,
            count: 1,
            filter: LAND_FILTER,
            nameAnyOf: BASIC_LAND_NAMES,
            destination: 'battlefield',
            tapped: true,
          },
        },
      );
    },
  },
  {
    /**
     * A planeswalker ultimate's emblem: "You get an emblem with 'BODY'".
     *
     * The emblem's ability compiles through the ORDINARY rule tables, exactly as
     * a permanent's would — so an emblem can only carry abilities the engine
     * genuinely runs, and one whose body has no faithful implementation leaves
     * the whole line reported rather than creating an object that sits in the
     * command zone doing nothing. Same contract a trigger body has, which is why
     * this rule is small.
     *
     * Both halves are attempted: a STATIC body ("creatures you control get
     * +1/+1") reaches the continuous layer, and a TRIGGERED body ("at the
     * beginning of your upkeep, …") reaches the trigger collector. A body that is
     * neither is refused — an emblem with a one-shot ability would do its thing
     * once and be inert forever, and no printed emblem works that way.
     */
    id: 'emblem-with-ability',
    description: '"You get an emblem with “ABILITY”" (a planeswalker ultimate)',
    // Printed text uses typographic quotes; hand-typed text may use straight
    // ones, so both are accepted.
    pattern: /^you get an emblem with ["“‘](.+)["”’]$/,
    build(match, ctx) {
      const body = match[1];
      if (!body) return null;
      const statics = emblemStatics(body, ctx);
      const triggers = emblemTriggers(body, ctx);
      if (statics.length === 0 && triggers.length === 0) return null;
      return effects({
        primitive: 'createEmblem',
        params: {
          name: `${ctx.card.name} emblem`,
          ...(statics.length > 0 ? { statics } : {}),
          ...(triggers.length > 0 ? { triggers } : {}),
        },
      });
    },
  },
]);

/**
 * The STATIC abilities an emblem body compiles to, or an empty list.
 *
 * Reuses {@link STATIC_RULES} — the same table that reads an anthem printed on a
 * permanent — because "creatures you control get +1/+1" means the same thing
 * whichever object radiates it, and a second table would be the thing that
 * eventually disagreed with the first.
 */
function emblemStatics(body: string, ctx: RuleContext): readonly StaticAbility[] {
  const clause = normalizeClause(body);
  for (const rule of STATIC_RULES) {
    const match = clause.match(rule.pattern);
    if (!match) continue;
    const statics = rule.build(match, ctx)?.statics;
    if (statics && statics.length > 0) return statics;
  }
  return [];
}

/**
 * The TRIGGERED abilities an emblem body compiles to, or an empty list. Same
 * argument as the statics half: an emblem's "at the beginning of your upkeep" is
 * the identical ability a permanent prints, so it goes through the identical
 * table and inherits every trigger template the compiler already knows.
 */
function emblemTriggers(body: string, ctx: RuleContext): readonly TriggeredAbility[] {
  const clause = normalizeClause(body);
  for (const rule of TRIGGER_RULES) {
    const match = clause.match(rule.pattern);
    if (!match) continue;
    const triggers = rule.build(match, ctx)?.triggers;
    if (triggers && triggers.length > 0) return triggers;
  }
  return [];
}

// --- trigger rules --------------------------------------------------------------
// Each recognizes a printed trigger prefix and compiles the BODY with the effect
// rules above. If the body has no faithful implementation the whole trigger is
// rejected (returns null) — never a trigger that fires and does nothing.

/**
 * Build a one-condition trigger whose body is compiled from `bodyText`.
 *
 * The body MAY name a target now: core aims a triggered ability as it goes on the
 * stack (`TriggeredAbility.targets` → the engine's `aimPendingTriggers`), so
 * "when ~ enters, it deals 2 damage to any target" is a real card rather than one
 * that resolves pointing at nothing. What the body targets is carried onto the
 * ability, because the ABILITY is what gets aimed — the effects only read the
 * targets it was given.
 *
 * A body with no faithful implementation still rejects the whole trigger (a
 * trigger that fires and does nothing is worse than a reported card), and so does
 * one that would need two separate targets — see `compileTriggerBody`.
 */
function triggerFrom(
  ctx: RuleContext,
  condition: TriggeredAbility['condition'],
  bodyText: string,
  label: string,
): ClauseContribution | null {
  const body = ctx.compileTriggerBody(bodyText);
  if (body === null || body.effects.length === 0) return null;
  return {
    triggers: [
      {
        condition,
        effects: body.effects,
        label,
        ...(body.targets ? { targets: body.targets } : {}),
      },
    ],
  };
}

/**
 * Words that make an optional clause a PRICE rather than a gift — the AI steer
 * for {@link mayEffectsFrom}. "You may destroy target artifact" is upside and a
 * pilot should take it; "you may sacrifice a land" costs the controller
 * something and the default answer should be no.
 *
 * This changes no legality whatsoever: both answers stay available on every
 * "you may", and a searching pilot works out the real answer for itself. It is
 * only what a valence-answering pilot does when it has nothing better.
 */
const OPTIONAL_CLAUSE_COSTS: readonly string[] = Object.freeze([
  'sacrifice',
  'discard',
  'pay ',
  'lose ',
]);

/** `'loss'` when the optional clause charges its controller, else `'gain'`. */
function optionalValence(body: string): 'gain' | 'loss' {
  return OPTIONAL_CLAUSE_COSTS.some((cost) => body.startsWith(cost)) ? 'loss' : 'gain';
}

/**
 * Wrap an already-compiled clause in the printed word **"you may"**.
 *
 * The wrapper is the `mayEffects` primitive, which asks a real yes/no and runs
 * the clause only on a yes. Compiling the yes-half alone would be a different
 * card — a Reclamation Sage that MUST destroy something, a druid that MUST
 * sacrifice a land — so the option is data, never an assumption.
 *
 * Returns `null` when the body compiles to nothing, so the line keeps reporting
 * instead of becoming an empty question the player has to answer for no effect.
 */
function mayEffectsFrom(body: string, compiled: readonly EffectRef[]): readonly EffectRef[] | null {
  if (compiled.length === 0) return null;
  return [
    {
      primitive: 'mayEffects',
      params: {
        prompt: `You may ${body}`,
        valence: optionalValence(body),
        effects: compiled,
      },
    },
  ];
}

/**
 * Build the OPTIONAL ("you may BODY") form of a trigger whose plain form is
 * built by {@link triggerFrom}.
 *
 * A separate builder rather than a branch inside `triggerFrom`, because the two
 * forms compile DIFFERENT TEXT: the plain rule compiles the whole body, and this
 * one compiles only what follows "you may" and wraps it in the `mayEffects`
 * question. Compiling the whole "you may …" string and then wrapping it would
 * ask twice on the bodies that implement their own option.
 *
 * Rules built with this must be ordered AFTER their plain sibling, for the
 * reason spelled out on `trigger-etb-you-may`: a body that implements its own
 * "you may" (Eternal Witness's optional graveyard return) plays better on the
 * rule that knows about it, and this is the general fallback for every other.
 */
function optionalTriggerFrom(
  ctx: RuleContext,
  condition: TriggeredAbility['condition'],
  innerBody: string,
  label: string,
): ClauseContribution | null {
  const compiled = ctx.compileTriggerBody(innerBody);
  if (compiled === null) return null;
  const effects = mayEffectsFrom(innerBody, compiled.effects);
  if (effects === null || effects.length === 0) return null;
  return {
    triggers: [
      {
        condition,
        effects,
        label,
        ...(compiled.targets ? { targets: compiled.targets } : {}),
      },
    ],
  };
}

/**
 * The condition an Equipment's/Aura's "**equipped/enchanted creature** …" line
 * means: the same event, watched on the permanent this one is attached to.
 *
 * A helper rather than an inline object literal at each call site so the two
 * printed families (combat damage and attacking) cannot end up with two
 * different spellings of the same scope.
 */
function hostWatch(on: TriggerCondition['on']): TriggerCondition {
  return { on, watches: 'attachedHost' };
}

/**
 * The printed step names that begin a triggered ability, mapped to the
 * {@link TriggerCondition} event each one means. Closed: a step the engine's
 * turn structure does not have must REPORT, never compile to a trigger that can
 * never fire.
 */
const STEP_TRIGGER_EVENTS: Readonly<Record<string, TriggerCondition['on']>> = Object.freeze({
  upkeep: 'upkeep',
  'draw step': 'drawStep',
  'first main phase': 'precombatMain',
  'end step': 'endStep',
  // "At the beginning of EACH combat" (Unnatural Growth, Sting). The "on your
  // turn" phrasing is a rule of its own because it prints a different tail, but
  // the event is the same one, from the same `STEP_FOR_TRIGGER` table in core.
  combat: 'beginCombat',
});

/**
 * "your …" / "each player's …" / "each opponent's …" / bare "each …" — whose
 * step the trigger watches, in core's `TriggerWho` vocabulary.
 *
 * ⚠️ ORDER IS LOAD-BEARING. The alternation is built from these keys in
 * insertion order, so the two-word scopes must precede the bare `each`; with
 * `each` first, "at the beginning of each player's draw step" would match `each`
 * and leave "player's draw step" as the step word, which is in no table — the
 * card would report despite being fully expressible.
 */
const STEP_TRIGGER_SCOPES: Readonly<Record<string, TriggerWho>> = Object.freeze({
  your: 'you',
  "each player's": 'any',
  "each opponent's": 'opponent',
  // "At the beginning of each upkeep" is every player's upkeep — the same thing
  // "each player's upkeep" says with one word fewer.
  each: 'any',
});

/** The alternation of both tables, built FROM them so they cannot drift. */
const STEP_TRIGGER_PHRASE = `(${Object.keys(STEP_TRIGGER_SCOPES).join('|')}) (${Object.keys(
  STEP_TRIGGER_EVENTS,
).join('|')})`;

/**
 * A printed intervening "if" clause, and the {@link InterveningIf} each one
 * means. A CLOSED table for the same reason `STEP_TRIGGER_EVENTS` is one: a
 * condition the engine cannot decide must make its card REPORT, never compile
 * to a trigger whose condition is quietly always true (a strictly better card)
 * or always false (a dead one).
 */
const INTERVENING_IF_RULES: readonly {
  readonly pattern: RegExp;
  build(match: RegExpMatchArray): InterveningIf | null;
}[] = Object.freeze([
  {
    // "if this artifact is untapped" (Howling Mine). `selfReference` has already
    // folded "this artifact" into `~`.
    pattern: /^~ is untapped$/,
    build: (): InterveningIf => ({ kind: 'sourceUntapped' }),
  },
  {
    // "if you control three or more artifacts" / "an artifact" / "no snakes" /
    // "a creature with power 4 or greater".
    pattern: new RegExp(
      `^you control (no|an?|${COUNT_TOKEN} or more) ([a-z]+?)s?` +
        `(?: with ${SEARCH_BOUND_PHRASE} (\\d+) or (less|greater))?$`,
    ),
    build(match: RegExpMatchArray): InterveningIf | null {
      const quantifier = match[1] ?? '';
      const noun = match[3] ?? '';
      const filter = searchFilterFrom(noun);
      if (filter === null) return null;
      const condition: Record<string, unknown> = { kind: 'controlCount', filter };
      if (quantifier === 'no') condition.max = 0;
      else if (quantifier === 'a' || quantifier === 'an') condition.min = 1;
      else {
        const value = parseCount(match[2]);
        if (value === null) return null;
        condition.min = value;
      }
      const characteristic = match[4];
      if (characteristic !== undefined) {
        // ONLY "with power N or greater", and only as a FLOOR. The bound has to
        // be read against EFFECTIVE power — counters and anthems are what make a
        // creature "power 4 or greater" on the board in front of the player — and
        // `InterveningIf.minPower` is the field that does that. A toughness or
        // mana-value bound has no such field, so it reports rather than being
        // silently answered from the printed box.
        if (characteristic !== 'power' || match[6] !== 'greater') return null;
        const bound = Number.parseInt(match[5] ?? '', 10);
        if (!Number.isFinite(bound)) return null;
        condition.minPower = bound;
      }
      return condition as unknown as InterveningIf;
    },
  },
]);

/**
 * Split a trigger's text into its printed intervening "if" and the body that
 * follows it, or report `null` when there is no such clause.
 *
 * Returns `'unreadable'` — distinct from "no clause" — when the text DOES print
 * an intervening "if" that {@link INTERVENING_IF_RULES} cannot express, so the
 * caller refuses the whole line instead of compiling the body as though the
 * condition were not there. That distinction is the entire safety property here:
 * "at the beginning of your upkeep, if you have 40 or more life, you win the
 * game" must not become "at the beginning of your upkeep, you win the game".
 */
function splitInterveningIf(
  text: string,
): { readonly condition?: InterveningIf; readonly body: string } | 'unreadable' {
  const match = /^if (.+?), (.+)$/.exec(text);
  if (!match) return { body: text };
  for (const rule of INTERVENING_IF_RULES) {
    const found = rule.pattern.exec(match[1] ?? '');
    if (!found) continue;
    const condition = rule.build(found);
    if (condition) return { condition, body: match[2] ?? '' };
  }
  return 'unreadable';
}

export const TRIGGER_RULES: readonly CompileRule[] = Object.freeze([
  {
    id: 'trigger-etb',
    description: '"When ~ enters (the battlefield), BODY"',
    pattern: /^when ~ enters(?: the battlefield)?, (.+)$/,
    build(match, ctx) {
      return triggerFrom(ctx, { on: 'etb' }, match[1] ?? '', `Enters: ${match[1] ?? ''}`);
    },
  },
  {
    id: 'trigger-etb-you-may',
    description: '"When ~ enters, you may BODY" — the optional enters-the-battlefield trigger',
    // Ordered AFTER `trigger-etb`, deliberately. Some bodies print their own
    // "you may" and implement it themselves — "you may return target card from
    // your graveyard to your hand" compiles to `returnFromGraveyard` with
    // `optional: true`, one question, exactly as Eternal Witness plays. Letting
    // that path win first keeps those cards on the rule that knows the most
    // about them; this wrapper is the general fallback for every other body,
    // which without it would report rather than being asked about.
    //
    // The invariant that makes the order safe: a body rule may match a printed
    // "you may" ONLY if it implements the option (both rules that do, do). A
    // rule that swallowed the words and compiled the forced version would turn
    // an optional card into a different one — see the Eternal Witness test.
    pattern: /^when ~ enters(?: the battlefield)?, you may (.+)$/,
    build(match, ctx) {
      const body = match[1] ?? '';
      const compiled = ctx.compileTriggerBody(body);
      if (compiled === null) return null;
      const effectRefs = mayEffectsFrom(body, compiled.effects);
      if (effectRefs === null) return null;
      return {
        triggers: [
          {
            condition: { on: 'etb' },
            effects: effectRefs,
            label: `Enters: you may ${body}`,
            ...(compiled.targets ? { targets: compiled.targets } : {}),
          },
        ],
      };
    },
  },
  {
    id: 'trigger-attacks',
    description: '"Whenever ~ attacks, BODY"',
    pattern: /^whenever ~ attacks, (.+)$/,
    build(match, ctx) {
      return triggerFrom(ctx, { on: 'attacks' }, match[1] ?? '', `Attacks: ${match[1] ?? ''}`);
    },
  },
  {
    id: 'trigger-dies',
    description: '"When ~ dies, BODY"',
    pattern: /^when ~ dies, (.+)$/,
    build(match, ctx) {
      return triggerFrom(ctx, { on: 'dies' }, match[1] ?? '', `Dies: ${match[1] ?? ''}`);
    },
  },
  {
    id: 'trigger-leaves',
    description: '"When ~ leaves the battlefield, BODY"',
    // Core has had the `leaves` trigger event all along; only this pattern was
    // missing, so every leaves-the-battlefield card reported as unsupported.
    pattern: /^when ~ leaves the battlefield, (.+)$/,
    build(match, ctx) {
      return triggerFrom(ctx, { on: 'leaves' }, match[1] ?? '', `Leaves: ${match[1] ?? ''}`);
    },
  },
  {
    id: 'trigger-step-begins',
    description:
      '"At the beginning of [your | each player’s | each opponent’s | each] upkeep / draw step / first main phase / end step / combat, [if CONDITION,] [you may] BODY"',
    // One rule for the whole family, because the printed lines differ only in
    // which step they name, whose it is, and whether an intervening "if" gates
    // it. The step words are a closed table (`STEP_TRIGGER_EVENTS`): a step the
    // engine does not have would otherwise compile to a trigger that silently
    // never fires.
    //
    // ⚠️ THE "EACH PLAYER'S" FORM USED TO REPORT, AND THIS IS WHAT CHANGED.
    // A `who: 'any'` trigger fires on both players' steps but resolves under the
    // SOURCE's controller, so a body reading its controller would make Howling
    // Mine draw its own controller a card on every turn. The triggering player
    // now rides the stack object into `EffectContext.triggeringPlayer` (core's
    // `PendingTrigger.triggeringPlayer`), which is what the bodies that print
    // "that player" read — so the scope is finally expressible instead of being
    // refused.
    pattern: new RegExp(`^at the beginning of ${STEP_TRIGGER_PHRASE}, (.+)$`),
    build(match, ctx) {
      const scope = match[1] ?? '';
      const step = match[2] ?? '';
      const event = STEP_TRIGGER_EVENTS[step];
      if (!event) return null;
      const who = STEP_TRIGGER_SCOPES[scope];
      if (!who) return null;
      // The printed intervening "if", if there is one. `'unreadable'` means the
      // line DOES print a condition this compiler cannot express — refused
      // outright, because compiling the body without it would be a card that
      // always does the thing it only sometimes does.
      const split = splitInterveningIf(match[3] ?? '');
      if (split === 'unreadable') return null;
      const body = split.body;
      const optional = body.startsWith('you may ');
      const inner = optional ? body.slice('you may '.length) : body;
      const compiled = ctx.compileTriggerBody(inner);
      if (compiled === null || compiled.effects.length === 0) return null;
      const effectRefs = optional ? mayEffectsFrom(inner, compiled.effects) : compiled.effects;
      if (effectRefs === null || effectRefs.length === 0) return null;
      return {
        triggers: [
          {
            condition: {
              on: event,
              who,
              ...(split.condition ? { intervening: split.condition } : {}),
            },
            effects: effectRefs,
            label: `${scope} ${step}: ${match[3] ?? ''}`,
            ...(compiled.targets ? { targets: compiled.targets } : {}),
          },
        ],
      };
    },
  },
  {
    id: 'trigger-permanent-enters-or-dies',
    description:
      '"Whenever [another] [COLOR] TYPE [you control / an opponent controls] [with power N or greater] enters/dies, BODY" — incl. landfall, constellation, and "~ or another creature dies"',
    // The whole board-watching family in ONE rule, because it is one concept:
    // an arrival or a death, scoped by WHOSE permanent it is and narrowed by a
    // printed `CardFilter`. Two rules for it is how the engine ended up with two
    // names for the same event in the first place.
    //
    // Every part is optional except the type word, and each optional part is a
    // real fidelity knob:
    //   - "another"  → `excludeSelf`; a source that triggered off its own entry
    //                  when the card says "another" is a different card.
    //   - the colour word and the "with power N or greater" bound → the filter;
    //                  dropping either fires off permanents the card ignores.
    //   - an ABSENT controller tail → `who: 'any'`, which is what "whenever
    //                  another creature enters" (Soul Warden) means. Reading the
    //                  absent tail as "you control" halves the arrivals it sees.
    // The ability words landfall and constellation are the same trigger with a
    // name printed in front of it (CR 207.2c).
    pattern: new RegExp(
      `^(?:landfall — |constellation — )?whenever ` +
        `(?:(~ or another) creature|(another )?(?:an? )?((?:${Object.keys(COLOR_WORDS).join('|')}) )?` +
        // The printed words "token" / "nontoken" (Midnight Reaper's "whenever a
        // NONTOKEN creature you control dies"). Dropping the word would fire the
        // trigger on every token death too, which on a go-wide board is a
        // completely different card.
        `(nontoken |token )?([a-z]+)` +
        `( you control| an opponent controls| your opponents control)?)` +
        `(?: with ${SEARCH_BOUND_PHRASE} (\\d+) or (less|greater))? (enters|dies), (.+)$`,
    ),
    build(match, ctx) {
      // "~ or another creature dies" (Cordial Vampire) says EVERY creature's
      // death, this permanent's own included — so no scope and no self-exclusion.
      const selfOrAnother = match[1] !== undefined;
      const noun = selfOrAnother ? 'creature' : (match[5] ?? '');
      const filter = searchFilterFrom(noun, match[7], match[8], match[9]);
      if (filter === null) return null;
      const colorWord = match[3]?.trim();
      if (colorWord !== undefined) {
        const color = COLOR_WORDS[colorWord];
        if (color === undefined) return null;
        filter.anyOfColors = [color];
      }
      // "nontoken" / "token": one tri-state on the shared `CardFilter`, absent
      // when the card prints neither word.
      const tokenWord = match[4]?.trim();
      if (tokenWord !== undefined) filter.isToken = tokenWord === 'token';
      const tail = (match[6] ?? '').trim();
      const who = selfOrAnother || tail === '' ? 'any' : tail === 'you control' ? 'you' : 'opponent';
      const another = !selfOrAnother && (match[2] ?? '').trim() === 'another';
      const event = match[10] === 'enters' ? 'permanentEnters' : 'permanentDies';
      const body = match[11] ?? '';
      const optional = body.startsWith('you may ');
      const inner = optional ? body.slice('you may '.length) : body;
      const compiled = ctx.compileTriggerBody(inner);
      if (compiled === null || compiled.effects.length === 0) return null;
      const effectRefs = optional ? mayEffectsFrom(inner, compiled.effects) : compiled.effects;
      if (effectRefs === null) return null;
      return {
        triggers: [
          {
            condition: {
              on: event,
              who,
              permanentFilter: filter,
              ...(another ? { excludeSelf: true } : {}),
            },
            effects: effectRefs,
            label: `${another ? 'another ' : ''}${tokenWord ? `${tokenWord} ` : ''}${noun} (${who}) ${match[10]}: ${body}`,
            ...(compiled.targets ? { targets: compiled.targets } : {}),
          },
        ],
      };
    },
  },
  {
    /**
     * **"Whenever you cast a [TYPE] spell OF THE CHOSEN TYPE, BODY"**
     * (Vanquisher's Banner, Chronicle of Victory) — the cast trigger narrowed by
     * the creature type this permanent named as it entered.
     *
     * Ordered ABOVE the plain cast trigger, because "a creature spell of the
     * chosen type" also matches that rule's shape once the tail is ignored — and
     * ignoring the tail would be a card that draws off EVERY creature spell.
     *
     * Refused on a card with no naming line, like every other "of the chosen …"
     * reader: a trigger over a value nothing writes never fires, and a card that
     * reports `'complete'` and then does nothing is the failure this contract
     * exists to prevent.
     */
    id: 'trigger-cast-spell-of-chosen-type',
    description: '"Whenever you cast a [TYPE] spell of the chosen type, BODY"',
    pattern: /^whenever you cast an? (?:([a-z ]+?) )?spell of the chosen type, (.+)$/,
    build(match, ctx) {
      if (!namesAValueAsItEnters(ctx)) return null;
      const typeWord = match[1];
      // An absent type word is "a spell of the chosen type" (Chronicle of
      // Victory) — every card type, narrowed only by the named subtype.
      const base: readonly TriggerCondition[] =
        typeWord === undefined ? [{ on: 'castSpell', who: 'you' }] : (spellFiltersFor(typeWord) ?? []);
      if (base.length === 0) return null;
      const body = ctx.compileEffectClause(match[2] ?? '', { targetFree: true });
      if (body === null || body.length === 0) return null;
      return {
        triggers: base.map((condition) => ({
          condition: { ...condition, spellSubtypeIsChosen: true },
          effects: body,
          label: `Cast ${describeSpellFilter(condition)} of the chosen type: ${match[2] ?? ''}`,
        })),
      };
    },
  },
  {
    id: 'trigger-cast-spell',
    description: '"Whenever you cast a(n) TYPE spell, BODY" (incl. prowess-style text)',
    pattern: /^whenever you cast an? ([a-z ]+?) spell, (.+)$/,
    build(match, ctx) {
      const conditions = spellFiltersFor(match[1] ?? '');
      if (!conditions) return null;
      const body = ctx.compileEffectClause(match[2] ?? '', { targetFree: true });
      if (body === null || body.length === 0) return null;
      return {
        triggers: conditions.map((condition) => ({
          condition,
          effects: body,
          label: `Cast ${describeSpellFilter(condition)}: ${match[2] ?? ''}`,
        })),
      };
    },
  },
  {
    id: 'trigger-draws-card',
    description: '"Whenever you / a player / an opponent draws a card, BODY"',
    // The draw WATCHER, not the draw step. It fires on every draw — the turn's
    // own, a spell's, another trigger's — which is what the printed line says,
    // and it is a different card from "at the beginning of each player's draw
    // step" (Spiteful Visions prints BOTH, one on each line).
    //
    // The body reads the drawing player through the same `triggering` vocabulary
    // every other scoped trigger body uses, so "that player loses 1 life"
    // compiles identically whether the trigger watched a draw, a step or a life
    // gain.
    pattern: /^whenever (you|a player|an opponent) draws a card, (.+)$/,
    build(match, ctx) {
      const printed = match[1] ?? '';
      const who: TriggerWho = printed === 'you' ? 'you' : printed === 'an opponent' ? 'opponent' : 'any';
      return triggerFrom(
        ctx,
        { on: 'drawsCard', who },
        match[2] ?? '',
        `${printed} draws: ${match[2] ?? ''}`,
      );
    },
  },
  {
    id: 'trigger-begin-combat',
    description: '"At the beginning of combat on your turn, BODY"',
    pattern: /^at the beginning of combat on your turn, (.+)$/,
    build(match, ctx) {
      return triggerFrom(
        ctx,
        { on: 'beginCombat', who: 'you' },
        match[1] ?? '',
        `Begin combat: ${match[1] ?? ''}`,
      );
    },
  },
  {
    id: 'trigger-gain-life',
    description: '"Whenever you gain life, BODY"',
    pattern: /^whenever you gain life, (.+)$/,
    build(match, ctx) {
      return triggerFrom(
        ctx,
        { on: 'gainLife', who: 'you' },
        match[1] ?? '',
        `Gain life: ${match[1] ?? ''}`,
      );
    },
  },
  {
    id: 'trigger-combat-damage-to-player',
    description: '"Whenever ~ deals combat damage to a player, BODY"',
    pattern: /^whenever ~ deals combat damage to a player, (.+)$/,
    build(match, ctx) {
      return triggerFrom(
        ctx,
        { on: 'combatDamageToPlayer' },
        match[1] ?? '',
        `Combat damage to a player: ${match[1] ?? ''}`,
      );
    },
  },
  {
    id: 'trigger-combat-damage-to-player-you-may',
    description: '"Whenever ~ deals combat damage to a player, you may BODY"',
    // AFTER the plain rule — see `optionalTriggerFrom`.
    pattern: /^whenever ~ deals combat damage to a player, you may (.+)$/,
    build(match, ctx) {
      const body = match[1] ?? '';
      return optionalTriggerFrom(
        ctx,
        { on: 'combatDamageToPlayer' },
        body,
        `Combat damage to a player: you may ${body}`,
      );
    },
  },
  {
    // The Equipment/Aura copy of the line above. The SAME condition with the
    // watched object moved to the host — see core's `TriggerWatches` for why
    // that is a scope rather than an `equippedDealsCombatDamage` event of its
    // own. The compiler emits it for any card printing the words; the ASSEMBLY
    // refuses it on a card with no "Equip {N}"/"Enchant …" line, because a
    // trigger nothing can ever attach is a trigger that can never fire.
    id: 'trigger-equipped-combat-damage-to-player',
    description: '"Whenever equipped/enchanted creature deals combat damage to a player, BODY"',
    pattern: /^whenever (?:equipped|enchanted) creature deals combat damage to a player, (.+)$/,
    build(match, ctx) {
      const body = match[1] ?? '';
      return triggerFrom(
        ctx,
        hostWatch('combatDamageToPlayer'),
        body,
        `Equipped creature deals combat damage to a player: ${body}`,
      );
    },
  },
  {
    id: 'trigger-equipped-combat-damage-to-player-you-may',
    description: '"Whenever equipped/enchanted creature deals combat damage to a player, you may BODY"',
    pattern: /^whenever (?:equipped|enchanted) creature deals combat damage to a player, you may (.+)$/,
    build(match, ctx) {
      const body = match[1] ?? '';
      return optionalTriggerFrom(
        ctx,
        hostWatch('combatDamageToPlayer'),
        body,
        `Equipped creature deals combat damage to a player: you may ${body}`,
      );
    },
  },
  {
    // The third printed shape of the same scope — Skullclamp's whole card, and
    // the second half of every "protective" Aura. It fires as printed BECAUSE
    // the state-based actions settle attachments and deaths in that order: a
    // pass emits `creatureDied` while the host is still on the battlefield and
    // the Equipment still attached, and only the NEXT pass unattaches it. Core's
    // `equipped-triggers.test.ts` pins that ordering, because reversing it would
    // make this rule compile a trigger that silently never fires.
    id: 'trigger-equipped-dies',
    description: '"When/whenever equipped/enchanted creature dies, BODY"',
    pattern: /^(?:when|whenever) (?:equipped|enchanted) creature dies, (.+)$/,
    build(match, ctx) {
      const body = match[1] ?? '';
      return triggerFrom(ctx, hostWatch('dies'), body, `Equipped creature dies: ${body}`);
    },
  },
  {
    id: 'trigger-equipped-dies-you-may',
    description: '"When/whenever equipped/enchanted creature dies, you may BODY"',
    pattern: /^(?:when|whenever) (?:equipped|enchanted) creature dies, you may (.+)$/,
    build(match, ctx) {
      const body = match[1] ?? '';
      return optionalTriggerFrom(ctx, hostWatch('dies'), body, `Equipped creature dies: you may ${body}`);
    },
  },
  {
    id: 'trigger-equipped-attacks',
    description: '"Whenever equipped/enchanted creature attacks, BODY"',
    pattern: /^whenever (?:equipped|enchanted) creature attacks, (.+)$/,
    build(match, ctx) {
      const body = match[1] ?? '';
      return triggerFrom(ctx, hostWatch('attacks'), body, `Equipped creature attacks: ${body}`);
    },
  },
  {
    id: 'trigger-equipped-attacks-you-may',
    description: '"Whenever equipped/enchanted creature attacks, you may BODY"',
    pattern: /^whenever (?:equipped|enchanted) creature attacks, you may (.+)$/,
    build(match, ctx) {
      const body = match[1] ?? '';
      return optionalTriggerFrom(ctx, hostWatch('attacks'), body, `Equipped creature attacks: you may ${body}`);
    },
  },
  {
    // "Whenever a player casts a spell" / "Whenever an opponent casts a spell" —
    // the same cast trigger with a different `who`, which core has always had.
    // Only the printed shapes were missing, so Managorger Hydra and Sunscorch
    // Regent reported despite the machinery being complete.
    id: 'trigger-cast-spell-by',
    description: '"Whenever a player/an opponent casts a(n) [TYPE] spell, BODY"',
    pattern: /^whenever (a player|an opponent) casts an? (?:([a-z ]+?) )?spell, (.+)$/,
    build(match, ctx) {
      const who = match[1] === 'an opponent' ? 'opponent' : 'any';
      const restriction = match[2];
      // With no type word the trigger watches every spell; with one, it reuses
      // the same filter table the "whenever you cast" rule does — and rejects a
      // phrase that table does not know rather than dropping the restriction.
      const conditions: readonly TriggerCondition[] =
        restriction === undefined
          ? [{ on: 'castSpell', who }]
          : (spellFiltersFor(restriction)?.map((condition) => ({ ...condition, who })) ?? []);
      if (conditions.length === 0) return null;
      const body = ctx.compileEffectClause(match[3] ?? '', { targetFree: true });
      if (body === null || body.length === 0) return null;
      return {
        triggers: conditions.map((condition) => ({
          condition,
          effects: body,
          label: `${match[1] === 'an opponent' ? 'Opponent casts' : 'Any player casts'} ${describeSpellFilter(condition)}: ${match[3] ?? ''}`,
        })),
      };
    },
  },
]);

// --- mana abilities -------------------------------------------------------------

/** Card-level static properties printed as their own ability line. */
export const STATIC_RULES: readonly CompileRule[] = Object.freeze([
  {
    /**
     * "If one or more +1/+1 counters would be put on a creature you control,
     * THAT MANY PLUS ONE / TWICE THAT MANY are put on it instead" — Hardened
     * Scales, Conclave Mentor, Corpsejack Menace, Branching Evolution, Ozolith,
     * Kami of Whispered Hopes; and the effect-first wording Doubling Season
     * prints ("If an effect would put one or more counters on a permanent you
     * control, it puts twice that many of those counters on that permanent
     * instead").
     *
     * The COUNTER KIND is captured, not assumed: a card that says "+1/+1
     * counters" must not multiply a -1/-1 counter, and the two wordings that say
     * "one or more COUNTERS" (Winding Constrictor, Doubling Season) really do
     * mean every kind. Core's layer takes the kind and matches on it.
     */
    id: 'replacement-counters-multiplied',
    description:
      '"If one or more [+1/+1] counters would be put on a creature/permanent you control, that many plus N / twice that many are put on it instead" (Hardened Scales, Corpsejack Menace, Doubling Season)',
    pattern: new RegExp(
      `^if (?:one or more (\\+1/\\+1 )?counters would be put on|an effect would put one or more (\\+1/\\+1 )?counters on) ` +
        `(a creature|a permanent|an artifact or creature) you control, ` +
        `(?:it puts )?(?:that many plus ${COUNT_TOKEN}|${REPLACEMENT_MULTIPLIER_TOKEN} that many) ` +
        `(?:\\+1/\\+1 counters|of each of those kinds of counters|of those counters|counters) ` +
        `(?:are put on |on )?(?:it|that creature|that permanent|that artifact or creature)(?: instead)?$`,
    ),
    build(match, ctx) {
      if (!cardIsPermanent(ctx)) return null;
      const kindPrinted = match[1] ?? match[2];
      const nounPhrase = match[3] ?? '';
      const plus = match[4] === undefined ? undefined : parseCount(match[4]);
      // A "plus X" with no fixed value is not a number this layer can add.
      if (match[4] !== undefined && plus === null) return null;
      const times = match[5] === undefined ? undefined : REPLACEMENT_MULTIPLIERS[match[5]];
      if (match[5] !== undefined && times === undefined) return null;
      if (plus === undefined && times === undefined) return null;
      const recipientFilter = REPLACEMENT_COUNTER_SUBJECTS[nounPhrase];
      if (recipientFilter === undefined) return null;
      return {
        replacements: [
          {
            event: 'counters',
            applies: {
              recipientController: 'you',
              ...(recipientFilter === null ? {} : { recipientFilter }),
              // The printed "+1/+1" narrows the watched kind; its absence really
              // does mean every kind (Doubling Season, Winding Constrictor).
              ...(kindPrinted !== undefined ? { counterKind: PLUS_ONE_COUNTER } : {}),
            },
            outcome: {
              ...(plus !== null && plus !== undefined ? { plus } : {}),
              ...(times !== undefined ? { times } : {}),
            },
            label: match[0],
          },
        ],
      };
    },
  },
  {
    /**
     * "If a [red] source you control would deal [noncombat] damage to RECIPIENT,
     * it deals DOUBLE that damage / that much damage PLUS N instead" — Torbran,
     * Gratuitous Violence, Fiery Emancipation, Angrath's Marauders, Twinflame
     * Tyrant, Dictate of the Twin Gods, Gisela's first clause.
     *
     * Both halves of the source phrase are captured because both are real: a
     * COLOUR word ("a red source") narrows it through the same `anyOfColors`
     * filter protection reads, and "a creature you control" narrows it by type.
     * "A source" with no controller tail is the symmetric card and is NOT
     * quietly read as "yours".
     */
    id: 'replacement-damage-scaled',
    description:
      '"If a [red] source you control would deal [noncombat] damage to X, it deals double/triple that damage / that much damage plus N instead" (Torbran, Gratuitous Violence, Fiery Emancipation)',
    pattern: new RegExp(
      `^if (?:a (${Object.keys(COLOR_WORDS).join('|')}) source(?: you control)?|${REPLACEMENT_SOURCE_TOKEN}) ` +
        `would deal (noncombat |combat )?damage to ${REPLACEMENT_RECIPIENT_TOKEN}, ` +
        `(?:it|that source) deals (?:${REPLACEMENT_MULTIPLIER_TOKEN} that damage|that much damage plus ${COUNT_TOKEN})` +
        `(?: to (?:that permanent or player|that player or permanent|that player|that permanent|it))? instead$`,
    ),
    build(match, ctx) {
      if (!cardIsPermanent(ctx)) return null;
      const colorWord = match[1];
      const sourcePhrase = match[2];
      const combatWord = match[3]?.trim();
      const recipientPhrase = match[4] ?? '';
      const multiplierWord = match[5];
      const plusToken = match[6];

      // A colour phrase always prints "you control" on the cards that use it;
      // the plain-source table covers the rest. Exactly one of the two matched.
      const sourceController: StaticControllerScope =
        colorWord !== undefined ? 'you' : REPLACEMENT_SOURCE_SCOPES[sourcePhrase ?? ''] ?? 'any';
      const sourceType =
        sourcePhrase === undefined ? null : REPLACEMENT_SOURCE_TYPES[sourcePhrase] ?? null;
      const color = colorWord === undefined ? undefined : COLOR_WORDS[colorWord];
      if (colorWord !== undefined && color === undefined) return null;

      const recipient = REPLACEMENT_RECIPIENTS[recipientPhrase];
      if (recipient === undefined) return null;

      const times = multiplierWord === undefined ? undefined : REPLACEMENT_MULTIPLIERS[multiplierWord];
      if (multiplierWord !== undefined && times === undefined) return null;
      const plus = plusToken === undefined ? undefined : parseCount(plusToken);
      if (plusToken !== undefined && plus === null) return null;

      const sourceFilter =
        color !== undefined || sourceType !== null
          ? {
              ...(sourceType !== null ? { anyOfTypes: [sourceType] } : {}),
              ...(color !== undefined ? { anyOfColors: [color as never] } : {}),
            }
          : undefined;

      return {
        replacements: [
          {
            event: 'damage',
            applies: {
              ...(sourceController === 'any' ? {} : { sourceController }),
              ...(sourceFilter !== undefined ? { sourceFilter } : {}),
              ...(combatWord === 'noncombat' ? { combat: false } : {}),
              ...(combatWord === 'combat' ? { combat: true } : {}),
              ...(recipient.controller === 'any' ? {} : { recipientController: recipient.controller }),
              ...(recipient.kind !== undefined ? { recipientKind: recipient.kind } : {}),
            },
            outcome: {
              ...(times !== undefined ? { times } : {}),
              ...(plus !== null && plus !== undefined ? { plus } : {}),
            },
            label: match[0],
          },
        ],
      };
    },
  },
  {
    /**
     * "If a source would deal damage to you or a permanent you control, PREVENT
     * HALF that damage, rounded up" — Gisela's second clause. Its own rule
     * rather than a mode of the one above because halving is prevention, not
     * scaling: it produces a `damagePrevented` amount the log has to report, and
     * the rounding direction is printed and must not be guessed.
     */
    id: 'replacement-damage-prevent-half',
    description: '"If a source would deal damage to X, prevent half that damage, rounded up" (Gisela)',
    pattern: new RegExp(
      `^if ${REPLACEMENT_SOURCE_TOKEN} would deal (noncombat |combat )?damage to ${REPLACEMENT_RECIPIENT_TOKEN}, ` +
        `prevent half that damage, rounded up$`,
    ),
    build(match, ctx) {
      if (!cardIsPermanent(ctx)) return null;
      const sourceController = REPLACEMENT_SOURCE_SCOPES[match[1] ?? ''] ?? 'any';
      const sourceType = REPLACEMENT_SOURCE_TYPES[match[1] ?? ''] ?? null;
      const combatWord = match[2]?.trim();
      const recipient = REPLACEMENT_RECIPIENTS[match[3] ?? ''];
      if (recipient === undefined) return null;
      return {
        replacements: [
          {
            event: 'damage',
            applies: {
              ...(sourceController === 'any' ? {} : { sourceController }),
              ...(sourceType !== null ? { sourceFilter: { anyOfTypes: [sourceType] } } : {}),
              ...(combatWord === 'noncombat' ? { combat: false } : {}),
              ...(combatWord === 'combat' ? { combat: true } : {}),
              ...(recipient.controller === 'any' ? {} : { recipientController: recipient.controller }),
              ...(recipient.kind !== undefined ? { recipientKind: recipient.kind } : {}),
            },
            outcome: { preventHalfRoundedUp: true },
            label: match[0],
          },
        ],
      };
    },
  },
  {
    /**
     * "Prevent all [combat|noncombat] damage that would be dealt to [ATTACKING |
     * OTHER] creatures you control / to you" printed on a PERMANENT — Dolmen
     * Gate, Iroas, Crystal Barricade.
     *
     * The identical sentence on an INSTANT ends "this turn" and is a one-shot
     * (the fog rule in EFFECT_RULES). The two are kept apart by that tail and by
     * the permanent check, because compiling a Fog as a static would make it
     * prevent damage for the rest of the game.
     */
    id: 'replacement-prevent-all-static',
    description:
      '"Prevent all [combat] damage that would be dealt to [attacking|other] creatures you control / to you" on a permanent (Dolmen Gate, Iroas)',
    pattern:
      /^prevent all (combat |noncombat )?damage that would be dealt to (attacking creatures you control|other creatures you control|creatures you control|you)$/,
    build(match, ctx) {
      if (!cardIsPermanent(ctx)) return null;
      const combatWord = match[1]?.trim();
      const who = match[2] ?? '';
      const applies: ReplacementApplies = {
        ...(combatWord === 'combat' ? { combat: true } : {}),
        ...(combatWord === 'noncombat' ? { combat: false } : {}),
        recipientController: 'you',
        ...(who === 'you'
          ? { recipientKind: 'player' as const }
          : {
              recipientKind: 'permanent' as const,
              recipientFilter: { anyOfTypes: ['creature' as CardType] },
              ...(who === 'attacking creatures you control' ? { recipientAttacking: true } : {}),
              ...(who === 'other creatures you control' ? { excludeSource: true } : {}),
            }),
      };
      return { replacements: [{ event: 'damage', applies, outcome: { preventAll: true }, label: match[0] }] };
    },
  },
  {
    /**
     * "If you would draw a card [except the first one you draw in each of your
     * draw steps], draw two cards instead" (Teferi's Ageless Insight,
     * Alhammarret's Archive) and "…while your library has no cards in it, you
     * WIN THE GAME instead" (Laboratory Maniac).
     *
     * The printed exception is implemented EXACTLY, not approximated: core
     * records the `drewInOwnDrawStep` turn fact as the draw-step draw happens,
     * so the second and every later draw in that step really is replaced.
     */
    id: 'replacement-draw',
    description:
      '"If you would draw a card [except the first one each draw step], draw two cards instead" / "…while your library has no cards in it, you win the game instead"',
    pattern: new RegExp(
      `^if you would draw a card(?: (except the first one you draw in each of your draw steps|while your library has no cards in it))?, ` +
        `(?:draw ${COUNT_TOKEN} cards instead|you win the game instead)$`,
    ),
    build(match, ctx) {
      if (!cardIsPermanent(ctx)) return null;
      const clause = match[1];
      const winsGame = match[2] === undefined;
      // "Draw two cards instead" is a MULTIPLIER of the one-card draw it
      // replaces, so anything below two would be a card that draws fewer than it
      // printed — refused rather than compiled.
      const drawCount = winsGame ? 0 : parseCount(match[2]);
      if (!winsGame && (drawCount === null || drawCount < 2)) return null;
      // "You win the game instead" is only buildable when the condition gating
      // it is one core can read; an unconditional form is not a printed card.
      if (winsGame && clause !== 'while your library has no cards in it') return null;
      return {
        replacements: [
          {
            event: 'draw',
            applies: {
              recipientController: 'you',
              ...(clause === 'except the first one you draw in each of your draw steps'
                ? { exceptFirstDrawEachDrawStep: true }
                : {}),
              ...(clause === 'while your library has no cards in it' ? { requiresEmptyLibrary: true } : {}),
            },
            outcome: winsGame ? { winGame: true } : { times: drawCount as number },
            label: match[0],
          },
        ],
      };
    },
  },
  {
    id: 'multikicker-cost',
    description:
      '"Multikicker {COST}" — an additional cost payable ANY NUMBER of times; the engine asks for a count at cast time, bounded by what the board can fund',
    // Tried before `kicker-cost`, whose pattern would otherwise never see this
    // line at all (it anchors on "kicker" at the start) — spelled out because
    // the two rules are one word apart and their order is load-bearing.
    pattern: /^multikicker ((?:\{[^}]+\})+)$/,
    build(match) {
      // Only symbols the engine can charge; a multikicker of {X} or Phyrexian
      // mana would be a cost we cannot ask for, so the line stays reported.
      const cost = parseManaSymbols(match[1]!);
      return cost === null ? null : { multikicker: cost };
    },
  },
  {
    id: 'additional-cast-cost',
    description:
      '"As an additional cost to cast this spell, sacrifice a creature / discard a card" (Village Rites, Thrill of Possibility, Diabolic Intent, Harrow)',
    // A MANDATORY additional cost, and the difference from `kicker-cost` above is
    // the whole reason it compiles to its own field: a kicker may be declined, so
    // a caster who cannot pay it still casts the spell. This one cannot be
    // declined — CR 601.2h makes an unpayable cost an ILLEGAL CAST — so the
    // engine refuses to offer Village Rites with an empty board rather than
    // printing a free two-card draw.
    //
    // The noun is read through a CLOSED table for the same reason every other
    // filter word in this file is: "sacrifice a Clue" or "exile a card from your
    // graveyard" must report, not compile into a cost that sacrifices the wrong
    // thing (or nothing at all, which would be strictly better than printed).
    // "Exile" and "pay N life" additional costs are outside the table on purpose:
    // core's `AdditionalCastCost` performs a sacrifice or a discard, and a cost
    // it cannot perform must never look implemented.
    //
    // The LABEL is the printed phrase itself, capitalized — not a sentence
    // rebuilt from the parsed pieces. A rebuilt label drifts from the card ("a
    // creature" becomes "creature"), and it is what the hotseat prompt and the
    // log show the player, so it should read the way the card reads.
    // The outer group is the printed phrase (the label); the inner ones are the
    // verb, the count and the noun, so nothing has to be recovered by slicing
    // the phrase back apart.
    pattern: new RegExp(
      `^as an additional cost to cast this spell, ((sacrifice|discard) (?:${COUNT_TOKEN} )?([a-z ]+?)s?)$`,
    ),
    build(match) {
      const phrase = match[1] ?? '';
      const kind = match[2] === 'discard' ? 'discard' : 'sacrifice';
      const count = match[3] === undefined ? 1 : parseCount(match[3]);
      if (count === null || count <= 0) return null;
      const noun = (match[4] ?? '').trim();
      const filter = kind === 'discard' ? discardCostFilterFor(noun) : sacrificeCostFilterFor(noun);
      if (filter === null) return null;
      const label = phrase.charAt(0).toUpperCase() + phrase.slice(1);
      return {
        additionalCost: {
          kind,
          ...(count === 1 ? {} : { count }),
          ...(filter ? { filter } : {}),
          label,
        },
      };
    },
  },
  {
    id: 'kicker-cost',
    description:
      '"Kicker {COST}" — an optional additional cost the engine asks about at cast time (single kicker only; multikicker keeps reporting)',
    pattern: /^kicker ((?:\{[^}]+\})+)$/,
    build(match) {
      // Only symbols the engine can charge; a kicker of {X} or Phyrexian mana
      // would be a cost we cannot ask for, so the line stays reported.
      const cost = parseManaSymbols(match[1]!);
      return cost === null ? null : { kicker: cost };
    },
  },
  {
    id: 'enters-with-counters',
    description: '"~ enters with N +1/+1 counters on it"',
    // A whole ability line like "enters tapped", not a split sentence — hence its
    // place in this table and the optional trailing full stop.
    pattern: new RegExp(
      `^~ enters(?: the battlefield)? with (?:a|${COUNT_TOKEN}) \\+1/\\+1 counters? on it\\.?$`,
    ),
    build(match) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      // The permanent's own ETB script counters itself.
      return { effects: [{ primitive: 'addCounters', params: { amount, self: true } }] };
    },
  },
  {
    // "~ enters with X +1/+1 counters on it" (Stonecoil Serpent). Gated on the
    // card actually printing {X} in its cost, exactly like every other X rule:
    // an X defined by a "where X is …" clause is a different number, and
    // reading it as the cast-time X would size the creature wrongly.
    id: 'enters-with-x-counters',
    description: '"~ enters with X +1/+1 counters on it"',
    pattern: /^~ enters(?: the battlefield)? with x \+1\/\+1 counters on it\.?$/,
    build(_match, ctx) {
      if (!cardHasXCost(ctx)) return null;
      return { effects: [{ primitive: 'addCounters', params: { amount: CHOSEN_X_PARAM, self: true } }] };
    },
  },
  {
    id: 'cant-be-blocked',
    description: `"~ can't be blocked"`,
    pattern: /^~ can'?t be blocked$/,
    build() {
      return { keywords: { unblockable: true } };
    },
  },
  {
    // The mirror of the rule above, and a genuinely different one: this creature
    // may not be declared as a BLOCKER (Carrion Feeder, Gravecrawler, Bloodghast).
    // Both halves are printed together often enough to deserve their own pattern,
    // because compiling only the first would leave a recursive threat blocking.
    id: 'cant-block',
    description: `"~ can't block" / "~ can't block and can't be blocked"`,
    pattern: /^~ can'?t block(?: and can'?t be blocked)?$/,
    build(match) {
      const alsoUnblockable = /can'?t be blocked/.test(match[0]);
      return { keywords: { cantBlock: true, ...(alsoUnblockable ? { unblockable: true } : {}) } };
    },
  },
  {
    // Menace generalised: "except by three or more creatures" (Pathrazer of
    // Ulamog). Core folds this with menace by taking the larger requirement, so
    // one declaration-level check serves every printing of the rule.
    id: 'cant-be-blocked-except-by-n',
    description: `"~ can't be blocked except by N or more creatures"`,
    pattern: new RegExp(`^~ can'?t be blocked except by ${COUNT_TOKEN} or more creatures$`),
    build(match) {
      const minimum = parseCount(match[1]);
      // "except by X or more" has no fixed value to enforce - report it.
      if (minimum === null || minimum < 1) return null;
      return { keywords: { minBlockers: minimum } };
    },
  },
  {
    id: 'flashback-cost',
    description:
      '"Flashback {2}{U}", "Flashback {X}{R}{R}" and "Flashback—{1}{U}, Pay 3 life" — the mana half, its {X} count, and a life rider, all charged at cast time',
    // A whole ability line: the keyword, its mana symbols, and optionally a
    // comma-separated "Pay N life". A NON-life additional cost ("Flashback—
    // {1}{U}, Discard a card", "Flashback—Sacrifice a creature") still does
    // NOT match: the engine has no cast-time discard or sacrifice cost, and
    // half-paying one would be strictly better than printed. Those lines fall
    // through to the hint instead.
    pattern: /^flashback[—-]? ?((?:\{[^}]+\})+)(?:, pay (\d+) life)?$/,
    build(match, ctx) {
      // Flashback is printed only on instants and sorceries; anything else
      // reaching here is a card the engine could not cast from a graveyard
      // faithfully, so it stays reported rather than compiling a dead field.
      const types = ctx.card.typeLine.types.map((t) => t.toLowerCase());
      if (!types.includes('instant') && !types.includes('sorcery')) return null;
      const symbols = splitCostSymbols(match[1] ?? '');
      // {X} in a flashback cost is now payable — the value is asked at cast
      // time off THIS count, exactly as a printed {X} cost is. Everything else
      // `parseManaSymbols` refuses (Phyrexian, monocolour hybrid) still reports.
      const xCount = symbols.filter((symbol) => symbol === 'X').length;
      const manaText = symbols.filter((symbol) => symbol !== 'X').map((symbol) => `{${symbol}}`).join('');
      // A flashback cost of nothing but {X} is legal ("Flashback {X}") and pays
      // an empty base cost — `parseManaSymbols` refuses empty input, so that
      // case is handled here rather than by asking it.
      const cost = manaText.length > 0 ? parseManaSymbols(manaText) : {};
      if (!cost) return null;
      const life = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
      if (life !== undefined && !Number.isFinite(life)) return null;
      return {
        flashback: cost,
        ...(xCount > 0 ? { flashbackXCost: xCount } : {}),
        ...(life !== undefined && life > 0 ? { flashbackLifeCost: life } : {}),
      };
    },
  },
  {
    id: 'cycling-cost',
    description: '"Cycling {2}" — pay the cost, discard this card, draw a card',
    // A whole ability line: the keyword followed by nothing but mana symbols.
    // "Cycling {X}{1}{U}" (Shark Typhoon) deliberately does NOT compile — an
    // {X} in an ACTIVATION cost has no answer-and-charge seam the way an {X} in
    // a casting cost does, and cycling for less than printed would be strictly
    // better than the real card. It falls through to the hint instead.
    pattern: /^cycling ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null; // {X}/Phyrexian/hybrid — report, don't approximate
      return {
        cycling: [
          {
            cost,
            effects: [{ primitive: 'drawCards', params: { count: 1 } }],
            label: `Cycling ${formatManaCost(cost)}`,
          },
        ],
      };
    },
  },
  {
    id: 'typecycling-cost',
    description:
      '"Plainscycling {2}" / "Landcycling {2}" — pay, discard, search for a card of that type',
    // TYPECYCLING and LANDCYCLING are cycling with a different reward, which is
    // why they are the same rule and the same engine mechanism: the ability's
    // effects are a library search instead of a draw. The searchable words are a
    // CLOSED table (the five basic land types plus the generic "land"), because
    // each one has to name something `CardFilter` can actually select — a
    // creature-type cycling word the filter cannot express must report, not
    // search for the wrong thing.
    pattern: new RegExp(`^(${TYPECYCLING_TOKEN})cycling ((?:\\{[^}]+\\})+)$`),
    build(match) {
      const word = (match[1] ?? '').toLowerCase();
      const cost = parseManaSymbols(match[2] ?? '');
      if (!cost) return null;
      const filter = TYPECYCLING_FILTERS[word];
      if (!filter) return null;
      const printed = `${word.charAt(0).toUpperCase()}${word.slice(1)}cycling`;
      return {
        cycling: [
          {
            cost,
            effects: [
              {
                primitive: 'searchLibrary',
                // Destination hand, count 1, and the search may always fail to
                // find — which `searchLibrary` already models with a floor of
                // zero, exactly as the printed "search … then shuffle" allows.
                params: { who: 'controller', count: 1, destination: 'hand', filter },
              },
            ],
            label: `${printed} ${formatManaCost(cost)}`,
          },
        ],
      };
    },
  },
  {
    id: 'buyback-cost',
    description: '"Buyback {3}" — an optional additional cost that returns the spell to hand',
    pattern: /^buyback ((?:\{[^}]+\})+)$/,
    build(match, ctx) {
      // Buyback is printed only on instants and sorceries; "put this card into
      // your hand as it resolves" means nothing for a permanent spell, so
      // anything else reaching here reports rather than compiling a dead field.
      const types = ctx.card.typeLine.types.map((t) => t.toLowerCase());
      if (!types.includes('instant') && !types.includes('sorcery')) return null;
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return { buyback: cost };
    },
  },
  {
    id: 'madness-cost',
    description: '"Madness {1}{U}" — discard it to exile, then you may cast it for this cost',
    // The em-dash form ("Madness—Pay six {C}") deliberately does not match: its
    // cost is printed in words, and reading a number out of it would be guessing
    // at what the card costs.
    pattern: /^madness ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return { madness: cost };
    },
  },
  {
    id: 'copy-as-enters',
    description:
      '"You may have ~ enter [tapped] as a copy of <selector>[, except <clauses>]" (Clone, Sculpting Steel, Spark Double, Vesuva, Echoing Deeps) - CR 707',
    // Placed above `enters-tapped` because Vesuva's line contains the word
    // "tapped" and this rule owns the whole clause, tapped-ness included.
    pattern: /^you may have ~ enter( tapped)? as a copy of (.+?)(?:, except (.+))?$/,
    build(match, ctx) {
      const spec = buildCopyAsEnters(match[2] ?? '', match[3], match[1] !== undefined, ctx);
      return spec === null ? null : { copyAsEnters: spec };
    },
  },
  {
    id: 'enters-tapped',
    description: '"~ enters tapped" (the unconditional form only)',
    pattern: /^~ enters(?: the battlefield)? tapped$/,
    build() {
      return { entersTapped: true };
    },
  },
  {
    id: 'enters-tapped-unless-pay-life',
    description:
      '"As ~ enters, you may pay 2 life. If you don\'t, it enters tapped." (the shockland cycle)',
    // Both templatings: the 2018+ "~ enters the battlefield" wording and the
    // 2024+ short "~ enters" one; the second sentence names the card either as
    // "it" or by name (which normalization folds to ~).
    pattern:
      /^as ~ enters(?: the battlefield)?, you may pay (\d+) life\. if you don't, (?:it|~) enters(?: the battlefield)? tapped$/,
    build(match) {
      const life = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(life) || life <= 0) return null;
      return { entersTappedUnlessLifePaid: life };
    },
  },
  {
    id: 'enters-tapped-unless-revealed',
    description:
      `"As ~ enters, you may reveal an Island or Swamp card from your hand. If you don't, this land enters tapped." (the reveal-land cycles)`,
    // A DECISION, like the shockland above and unlike the board-reading
    // conditions below: holding the card does not untap the land, showing it
    // does. The engine raises a real confirm at land-play time and both answers
    // are legal, so the card is not silently compiled as its better half.
    //
    // Only LAND subtypes are accepted. "Reveal a creature card" would read the
    // same and mean something this rule does not implement, so it reports.
    pattern:
      /^as ~ enters(?: the battlefield)?, you may reveal an? (\w+) or (?:an? )?(\w+) card from your hand\. if you don't, (?:it|this land|~) enters(?: the battlefield)? tapped$/,
    build(match) {
      const subtypes = [match[1], match[2]].filter((s): s is string => Boolean(s));
      if (!subtypes.every((subtype) => LAND_SUBTYPES.has(subtype))) return null;
      return { entersTappedUnlessRevealed: { anyOfSubtypes: subtypes } };
    },
  },
  {
    id: 'enters-tapped-unless-few-lands',
    description:
      '"~ enters tapped unless you control two or fewer other lands" (the fastland cycle)',
    pattern:
      /^~ enters(?: the battlefield)? tapped unless you control (\w+) or fewer other lands$/,
    build(match) {
      const max = SMALL_NUMBER_WORDS[match[1]!];
      if (max === undefined) return null; // an unexpected count — report it
      return { entersTappedUnless: { maxOtherLands: max } };
    },
  },
  {
    id: 'enters-tapped-unless-min-other-lands',
    description:
      '"~ enters tapped unless you control two or more other lands" (the slowland cycle)',
    // The mirror of the fastland rule above: a fastland wants FEW other lands,
    // a slowland wants MANY. Same board read, opposite comparison, so they are
    // two entries against one condition record rather than two mechanisms.
    pattern:
      /^~ enters(?: the battlefield)? tapped unless you control (\w+) or more other lands$/,
    build(match) {
      const min = SMALL_NUMBER_WORDS[match[1]!];
      if (min === undefined) return null; // an unexpected count — report it
      return { entersTappedUnless: { minOtherLands: min } };
    },
  },
  {
    id: 'enters-tapped-unless-min-basic-lands',
    description:
      '"~ enters tapped unless you control two or more basic lands" (the battleland cycle)',
    // "Basic" is a SUPERTYPE, not a subtype, and the difference is the whole
    // point: counting land subtypes would count a nonbasic dual as a basic and
    // let the land enter untapped when the printed card would not. The count
    // reads `CardDefinition.basic`, which the compiler emits from the type line.
    pattern:
      /^~ enters(?: the battlefield)? tapped unless you control (\w+) or more basic lands$/,
    build(match) {
      const min = SMALL_NUMBER_WORDS[match[1]!];
      if (min === undefined) return null;
      return { entersTappedUnless: { minBasicLands: min } };
    },
  },
  {
    id: 'enters-tapped-unless-controls-subtype',
    description:
      '"~ enters tapped unless you control a Mountain or a Plains" (the checkland cycle)',
    pattern:
      /^~ enters(?: the battlefield)? tapped unless you control an? (\w+)(?: or an? (\w+))?$/,
    build(match) {
      const subtypes = [match[1], match[2]].filter((s): s is string => Boolean(s));
      // Only LAND subtypes are expressible: "unless you control a creature"
      // reads the same but means something this rule does not implement.
      if (!subtypes.every((subtype) => LAND_SUBTYPES.has(subtype))) return null;
      return { entersTappedUnless: { controlsSubtype: subtypes } };
    },
  },
  {
    id: 'must-be-blocked-if-able',
    description: '"~ must be blocked if able" — a block REQUIREMENT (CR 509.1c)',
    // The other half of declare-blockers from every restriction above. It is not a
    // per-pair rule and cannot be one: "if able" is a question about the whole
    // declaration, which is why core resolves it with a solver.
    pattern: /^~ must be blocked if able\.?$/,
    build() {
      return { keywords: { mustBeBlocked: true } };
    },
  },
  {
    id: 'blocked-by-all-able',
    description: '"All creatures able to block ~ do so" — the Lure requirement',
    // Strictly stronger than "must be blocked": one requirement PER creature that
    // could block, so blocking with only some of them is illegal.
    pattern: /^all creatures able to block ~ do so\.?$/,
    build() {
      return { keywords: { blockedByAllAble: true } };
    },
  },
  {
    id: 'cant-be-blocked-except-by-keyword',
    description: `"~ can't be blocked except by creatures with haste" (Gingerbrute)`,
    // A restriction whose selector reads the BLOCKER — the shape a per-pair check
    // could not express before `blockRestriction` carried the payload. The keyword
    // table is closed: a quality outside it ("except by Walls", "except by
    // artifact creatures") reports rather than compiling a weaker restriction.
    pattern: /^~ can'?t be blocked(?: this turn)? except by creatures with ([a-z ]+)\.?$/,
    build(match) {
      const keyword = BLOCKER_QUALITY_KEYWORDS[(match[1] ?? '').trim()];
      if (keyword === undefined) return null;
      return { keywords: { blockRestriction: { blockerMustHaveAnyOf: [keyword] } } };
    },
  },
  {
    id: 'cant-be-blocked-by-power-or-toughness',
    description: `"~ can't be blocked by creatures with power 2 or less" / "with toughness 3 or greater"`,
    // The bound is inverted as it compiles — "can't be blocked by power 2 or
    // LESS" is the restriction "the blocker's power must be at least 3" — so core
    // never has to reason about the printed polarity, and both printings meet in
    // one pair of fields.
    pattern: new RegExp(
      `^~ can'?t be blocked(?: this turn)? by creatures with (power|toughness) ${COUNT_TOKEN} or (less|greater|more)\\.?$`,
    ),
    build(match) {
      const bound = parseCount(match[2]);
      if (bound === null) return null;
      const stat = match[1];
      const direction = match[3];
      if (direction === 'less') {
        // Excluded up to and including `bound` ⇒ a legal blocker needs bound + 1.
        return stat === 'power'
          ? { keywords: { blockRestriction: { minBlockerPower: bound + 1 } } }
          : { keywords: { blockRestriction: { minBlockerToughness: bound + 1 } } };
      }
      // "greater"/"more": excluded from `bound` upward ⇒ at most bound - 1.
      return stat === 'power'
        ? { keywords: { blockRestriction: { maxBlockerPower: bound - 1 } } }
        : { keywords: { blockRestriction: { maxBlockerToughness: bound - 1 } } };
    },
  },
  {
    id: 'enters-tapped-unless-controls-matching',
    description:
      '"~ enters tapped unless you control a legendary creature / a basic land / three or more other Swamps" — the general "unless you control [N] [permanents]" condition',
    // The GENERAL form of the four fixed conditions above, and the reason the
    // shared `CardFilter` was worth reaching for: a legendary creature, a basic
    // land and "three or more other Swamps" are one board question with three
    // different filters, not three rules.
    //
    // Tried AFTER the fixed cycles (fastland / slowland / battleland / checkland)
    // so those keep compiling to the fields live card data already uses — this
    // rule's pattern would otherwise swallow "two or more basic lands" and
    // silently re-encode a shipped cycle.
    pattern: new RegExp(
      `^~ enters(?: the battlefield)? tapped unless you control ` +
        `(?:(an?|${SMALL_NUMBER_WORD_TOKEN}) )?(?:or more )?(other )?(legendary |basic )?([a-z]+)$`,
    ),
    build(match) {
      const [, countWord, other, supertype, noun] = match;
      // "a"/"an" is one; a number word is itself. Anything else (no count at all)
      // means the line said something this rule did not actually read.
      const minimum =
        countWord === undefined ? null
        : countWord === 'a' || countWord === 'an' ? 1
        : (SMALL_NUMBER_WORDS[countWord] ?? null);
      if (minimum === null || minimum < 1) return null;
      const filter = permanentNounFilter(noun ?? '');
      if (!filter) return null;
      // "OTHER" is already the printed meaning of every enters-tapped condition
      // (the entering land never counts itself), so the word needs no field — but
      // it must be READ, or a line carrying it would fall through to the hint.
      void other;
      const supertyped =
        supertype === 'legendary ' ? { ...filter, legendary: true }
        : supertype === 'basic ' ? { ...filter, basic: true }
        : filter;
      return { entersTappedUnless: { controlsMatching: { filter: supertyped, minimum } } };
    },
  },
  {
    id: 'this-spell-cant-be-countered',
    description: `"This spell can't be countered" (Supreme Verdict, Abrupt Decay, Dovin's Veto)`,
    // A property of the CARD, not a targeting restriction: an uncounterable spell
    // is a legal target for Counterspell, which resolves and does nothing. Core
    // enforces it where a spell actually leaves the stack, so every counter path
    // inherits it. See `countering.ts`.
    pattern: /^this spell can'?t be countered\.?$/,
    build() {
      return { cantBeCountered: true };
    },
  },
  {
    id: 'spells-cant-be-countered',
    description: `"Spells you control can't be countered" / "Creature spells you control can't be countered" / "Spells can't be countered"`,
    // The permanent-side printing of the same rule. The card-type list is read
    // through the shared `CardFilter`, so "creature and enchantment spells" is
    // data rather than a rule of its own, and Lier's unrestricted wording is the
    // same shape with an 'any' scope.
    pattern: /^([a-z, ]+? )?spells( you control)? can'?t be countered\.?$/,
    build(match) {
      const typeWords = match[1];
      const yours = match[2] !== undefined;
      const controller = yours ? ('you' as const) : ('any' as const);
      if (typeWords === undefined) return { spellsCantBeCountered: { controller } };
      const types = parseSpellTypeList(typeWords);
      // A narrowing this engine cannot express as card types ("noncreature",
      // "multicolored") reports rather than compiling a wider ability than the
      // card prints.
      if (!types) return null;
      return { spellsCantBeCountered: { controller, filter: { anyOfTypes: types } } };
    },
  },
  {
    id: 'no-maximum-hand-size',
    description: `"You have no maximum hand size" (Reliquary Tower, Spellbook, Venser's Journal)`,
    // Read by the cleanup step's discard (CR 514.1). The rule it removes is real:
    // without a maximum hand size to lift, this would compile a card that does
    // nothing.
    pattern: /^you have no maximum hand size\.?$/,
    build() {
      return { noMaximumHandSize: true };
    },
  },
  {
    id: 'play-lands-from-zone',
    description:
      '"You may play lands from your graveyard" (Crucible of Worlds) / "from the top of your library" (Courser of Kruphix)',
    // One rule, two zones, because the printed sentence differs by four words and
    // the permission is the same one — `CardDefinition.playLandsFrom`.
    pattern: /^you may play lands from (your graveyard|the top of your library)\.?$/,
    build(match) {
      const zone = match[1] === 'your graveyard' ? ('graveyard' as const) : ('libraryTop' as const);
      return { playLandsFrom: [zone] };
    },
  },
  {
    id: 'characteristic-defining-pt',
    description:
      'the star P/T box: power equals the number of X, toughness that number plus N (Tarmogoyf) — a characteristic-defining P/T, applied in CR 613.3 layer 7a',
    // The ONLY shape compiled: both halves derived from the SAME count, the
    // toughness offset by a printed constant. That is Tarmogoyf and the whole
    // Lhurgoyf family. A card whose two halves count DIFFERENT things, or whose
    // count is not in the closed table, is not matched and keeps reporting —
    // the compiler names the formula it cannot express rather than guessing one.
    pattern: new RegExp(
      `^~'s power is equal to the number of ${DERIVED_PHRASE} and its toughness is equal to that number plus ${COUNT_TOKEN}$`,
    ),
    build(match, ctx) {
      // Only a creature has a P/T box to define.
      if (!ctx.card.typeLine.types.some((type) => type.toLowerCase() === 'creature')) return null;
      const count = derivedValue(match[1]!);
      const plus = parseCount(match[2]);
      if (!count || plus === null) return null;
      return {
        characteristicPT: {
          power: { countOf: count.countOf as never },
          toughness: { countOf: count.countOf as never, plus },
        },
      };
    },
  },
  {
    id: 'characteristic-defining-pt-equal',
    description:
      'the star P/T box: power and toughness each equal the number of X (Boneyard Wurm, Lhurgoyf-style) — both halves the same count, no offset',
    pattern: new RegExp(
      `^~'s power and toughness are each equal to the number of ${DERIVED_PHRASE}$`,
    ),
    build(match, ctx) {
      if (!ctx.card.typeLine.types.some((type) => type.toLowerCase() === 'creature')) return null;
      const count = derivedValue(match[1]!);
      if (!count) return null;
      return {
        characteristicPT: {
          power: { countOf: count.countOf as never },
          toughness: { countOf: count.countOf as never },
        },
      };
    },
  },
  {
    /**
     * **"As ~ enters, choose a creature type / a color / a player / a basic land
     * type"** (CR 614.1c) — the naming a permanent makes on the way in.
     *
     * The rule contributes only the DECLARATION
     * (`CardDefinition.asEntersChoice`); who asks it is decided by what kind of
     * permanent this is, and the assembly (`../compile.ts`) decides that once,
     * in one place: a land is played, so core's land-play path asks; anything
     * else resolves, so the `chooseAsEnters` primitive is prepended to the
     * card's script. A rule that emitted the primitive itself would have to know
     * the card's type line, and would get it wrong for the first card that is
     * both.
     */
    id: 'as-enters-choose-value',
    description:
      '"As ~ enters, choose a creature type / a color / a player / a basic land type" — the CR 614.1c naming, remembered on the permanent',
    pattern: new RegExp(`^as ~ enters, choose (${Object.keys(AS_ENTERS_SUBJECTS).join('|')})$`),
    build(match) {
      const subject = AS_ENTERS_SUBJECTS[match[1] ?? ''];
      if (subject === undefined) return null;
      return { asEntersChoice: { subject } };
    },
  },
  {
    /**
     * The EXPLICIT-MENU form — Cloud Key's "As ~ enters, choose artifact,
     * creature, enchantment, instant, or sorcery." Here the card, not the rules,
     * decides what may be named, so the printed list is parsed into
     * `AsEntersChoice.options` rather than derived from the subject.
     *
     * Kept separate from the rule above because its shape genuinely differs:
     * there is no "a <noun>" to look up, and folding the two would mean one
     * pattern with a dead alternation for every card.
     */
    id: 'as-enters-choose-from-list',
    description: '"As ~ enters, choose artifact, creature, enchantment, instant, or sorcery" (Cloud Key)',
    pattern: /^as ~ enters, choose ((?:[a-z]+, )+or [a-z]+)$/,
    build(match) {
      const words = (match[1] ?? '')
        // ", or" is one separator, not a comma followed by the word "or" — the
        // printed list is "artifact, creature, …, or sorcery".
        .split(/,\s*(?:or\s+)?|\s+or\s+/)
        .map((word) => word.trim())
        .filter(Boolean);
      // A closed table, like every other type-word read in this file: a word
      // outside it would be a menu entry no reader could ever match.
      if (words.length === 0 || !words.every((word) => CHOOSABLE_CARD_TYPES.includes(word))) return null;
      return { asEntersChoice: { subject: 'cardType', options: words } };
    },
  },
  {
    /**
     * **"~ is the chosen type in addition to its other types"** (Adaptive
     * Automaton, Metallic Mimic, Roaming Throne) — the permanent joins the type
     * it named, so the NEXT lord's "of the chosen type" filter can see it.
     *
     * Refused on a card that names nothing: a type-gaining line with no naming
     * line would silently gain nothing, which is exactly the half-card this
     * contract forbids.
     */
    id: 'is-the-chosen-type',
    description: '"~ is the chosen type in addition to its other types"',
    pattern: /^~ is the chosen type in addition to its other types$/,
    build(_match, ctx) {
      if (!namesAValueAsItEnters(ctx)) return null;
      return { isChosenSubtype: true };
    },
  },
  {
    id: 'static-buff-your-creatures',
    description:
      '"[Other] creatures you control get +X/+Y [and have KEYWORD]" / "…have KEYWORD" (Glorious Anthem, Fervor) — a continuous static, core\'s anthem layer',
    pattern: new RegExp(
      `^(other )?((?:${Object.keys(COLOR_WORDS).join('|')}) )?` +
        // The NOUN, in the two printed shapes a typal anthem takes: an
        // adjective before a type word ("Goblin creatures you control") or the
        // subtype used as the noun itself ("Goblins you control").
        `(?:((?:${SUBTYPE_ALTERNATION}) )?(${Object.keys(STATIC_NOUN_TYPES).join('|')})s|(${SUBTYPE_ALTERNATION})s) ` +
        // The scope tail is OPTIONAL because a SYMMETRIC anthem prints none:
        // "Black creatures get +1/+1" (Bad Moon) pumps both teams, and reading
        // an absent tail as "you control" would be a strictly better card.
        `(?:(you control|of the chosen type|of the chosen color)(?: of the chosen (type|color))? )?` +
        `(?:get ([+-]\\d+)\\/([+-]\\d+)(?: and (?:have|gain) (.+))?|(?:have|gain) (.+))$`,
    ),
    build(match, ctx) {
      // Only a PERMANENT can carry a static ability. An instant/sorcery printing
      // this shape would be a one-shot team effect this rule does not implement
      // (the printed until-end-of-turn forms never match this pattern anyway,
      // but the guard keeps a hypothetical durationless spell honest).
      const isPermanent = ctx.card.typeLine.types.every(
        (type) => !/^(instant|sorcery)$/i.test(type),
      );
      if (!isPermanent) return null;
      const power = match[8] === undefined ? 0 : Number.parseInt(match[8], 10);
      const toughness = match[9] === undefined ? 0 : Number.parseInt(match[9], 10);
      if (!Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      // WHOSE creatures, and NARROWED BY THE NAMED VALUE. The two tails are one
      // group because a printed anthem says exactly one of them first: "creatures
      // you control of the chosen type" (Patchwork Banner) narrows a friendly
      // anthem, while "creatures of the chosen color" (Gauntlet of Power) is
      // SYMMETRIC — it pumps the opponent's team too, and reading it as friendly
      // would be a strictly better card than the one printed.
      const scopeWord = match[6] ?? '';
      const narrowWord = match[7] ?? (scopeWord.startsWith('of the chosen ') ? scopeWord.slice('of the chosen '.length) : undefined);
      const scope: 'you' | 'any' = scopeWord === 'you control' ? 'you' : 'any';
      if (narrowWord !== undefined && narrowWord !== 'type' && narrowWord !== 'color') return null;
      // A card can only read a value it also NAMES. Compiling "of the chosen
      // type" on a card with no "As ~ enters, choose…" line would be an anthem
      // over a value nothing ever writes — silently blank rather than wrong, and
      // silently blank is the failure this contract exists to prevent.
      if (narrowWord !== undefined && !namesAValueAsItEnters(ctx)) return null;
      // The printed NOUN decides the filter's type. "Permanent" maps to no type
      // entry at all, because an absent filter already matches every permanent -
      // inventing a 'permanent' type word would match nothing.
      //
      // TYPAL form: the printed subtype is the whole filter when it stands alone
      // ("Goblins you control have haste" - Goblin Warchief), and narrows the
      // type word when it modifies one ("Other Goblin creatures you control get
      // +1/+1" - Goblin Chieftain). The bare form deliberately adds NO card
      // type: a Kindred enchantment ("Kindred Enchantment - Faerie", Bitterblossom)
      // genuinely IS a Faerie without being a creature, so "Faeries you control"
      // reaches it exactly as printed.
      const subtypeWord = (match[3] ?? match[5])?.trim();
      const bareSubtype = match[5] !== undefined;
      const nounType = bareSubtype ? null : STATIC_NOUN_TYPES[match[4] ?? ''];
      if (nounType === undefined) return null;
      // "WHITE creatures you control get +1/+1" — the printed colour narrows the
      // filter, which core's shared `CardFilter` can express now
      // (`anyOfColors`, derived from cost pips exactly as protection reads
      // colour). A colour word outside the table rejects the whole line.
      const colorWord = match[2]?.trim();
      const color = colorWord === undefined ? undefined : COLOR_WORDS[colorWord];
      if (colorWord !== undefined && color === undefined) return null;
      const keywordText = match[10] ?? match[11];
      const keywords = keywordText === undefined ? undefined : parseKeywordList(keywordText);
      // A keyword the engine does not model reports the whole line, never a
      // half-granted anthem.
      if (keywordText !== undefined && keywords === null) return null;
      const ability: StaticAbility = {
        affects: {
          ...(nounType === null ? {} : { anyOfTypes: [nounType] }),
          ...(subtypeWord === undefined ? {} : { anyOfSubtypes: [subtypeWord] }),
          controller: scope,
          ...(color ? { anyOfColors: [color as never] } : {}),
          ...(narrowWord === 'type' ? { ofChosenSubtype: true } : {}),
          ...(narrowWord === 'color' ? { ofChosenColor: true } : {}),
          // The printed word "other": the lord pumps the team, not itself.
          ...(match[1] ? { excludeSource: true } : {}),
        },
        ...(power !== 0 || toughness !== 0 ? { power, toughness } : {}),
        ...(keywords ? { keywords } : {}),
        label: match[0],
      };
      return { statics: [ability] };
    },
  },
  {
    /**
     * A static whose reach depends on COUNTERS — "Creatures you control with
     * +1/+1 counters on them can't be blocked" (Herald of Secret Streams),
     * "Each creature you control with a +1/+1 counter on it has trample"
     * (Duskshell Crawler).
     *
     * Counters are instance state, not a characteristic any static can change,
     * so the filter reads them without the layer-dependency loop that keeps
     * every other non-printed characteristic out of `StaticAffects`.
     */
    id: 'static-counters-grant',
    description: `"Creatures you control with +1/+1 counters on them have KEYWORD / can't be blocked"`,
    pattern: new RegExp(
      `^(?:each creature|creatures) you control with (?:a |one or more )?\\+1/\\+1 counters?` +
        `(?: on (?:it|them))? (?:(?:has|have) ${KEYWORD_TOKEN}|can'?t be blocked)$`,
    ),
    build(match, ctx) {
      // Only a permanent radiates a static; an instant printing this shape would
      // be a one-shot effect this rule does not implement.
      const isPermanent = ctx.card.typeLine.types.every(
        (type) => !/^(instant|sorcery)$/i.test(type),
      );
      if (!isPermanent) return null;
      const keywords = match[1] === undefined ? { unblockable: true } : keywordFlag(match[1]);
      if (keywords === null) return null;
      return {
        statics: [
          {
            affects: {
              anyOfTypes: ['creature'],
              controller: 'you',
              hasCounterKind: PLUS_ONE_COUNTER,
            },
            keywords,
            label: match[0],
          },
        ],
      };
    },
  },
  // --- attachments: Auras and Equipment (one system, two printed forms) --------
  //
  // The three rules below are the whole of "auras and equipment" at the compiler
  // level, and they are deliberately three rather than one, because a real card
  // prints them as separate ability lines:
  //
  //   Rancor        "Enchant creature"                      → attaches-as (Aura)
  //                 "Enchanted creature gets +2/+0 and has  → the modification
  //                  trample."
  //   Bonesplitter  "Equipped creature gets +2/+0."         → the modification
  //                 "Equip {1}"                             → attaches-as + how
  //
  // The assembly (`../compile.ts`) joins whichever pieces a card printed into ONE
  // `CardDefinition.attachment`. A modification line with no attaches-as line is
  // deliberately NOT compiled — see the assembly for why.
  {
    id: 'enchant-permanent',
    description: '"Enchant creature" / "Enchant artifact" — the Aura\'s printed host line',
    pattern: /^enchant (creature|artifact)$/,
    build(match) {
      const restriction = ENCHANT_RESTRICTIONS[match[1]!];
      if (!restriction) return null;
      return {
        attachesAs: {
          attachesTo: { anyOfTypes: [match[1] as CardType] },
          // CR 704.5m. An Aura is the form that DIES when it is not legally
          // attached; that difference is the only thing making it "an aura".
          whenIllegal: 'toGraveyard',
          label: `Enchant ${match[1]}`,
        },
        // An Aura spell targets its host and enters attached to it (CR 303.4f) —
        // which is exactly a resolution script of "attach me to my target".
        effects: [{ primitive: 'attachToTarget', params: { targets: restriction } }],
      };
    },
  },
  {
    id: 'attachment-modification',
    description:
      '"Enchanted/Equipped creature gets +2/+0 and has trample" / "the verbless can-not-be-blocked form (Whispersilk Cloak)"',
    // The third alternative is the VERBLESS form: a printed blocking restriction
    // is a sentence, not a keyword word, so Whispersilk Cloak's "Equipped
    // creature can't be blocked and has shroud" carries no leading "has". It is
    // a catch-all only in shape - `parseKeywordList` still has to recognise every
    // conjunct, so a line naming anything else returns null and keeps reporting.
    pattern:
      /^(?:enchanted|equipped) creature (?:gets ([+-]\d+)\/([+-]\d+)(?: and (?:has|gains) (.+))?|(?:has|gains) (.+)|(.+))$/,
    build(match) {
      const power = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
      const toughness = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
      const keywordText = match[3] ?? match[4] ?? match[5];
      const keywords = keywordText === undefined ? {} : parseKeywordList(keywordText);
      // An unmodelled keyword must report the whole line rather than silently
      // granting only the half we understood.
      if (keywords === null) return null;
      return { attachmentModifies: { power, toughness, keywords } };
    },
  },
  {
    id: 'equip-cost',
    description: '"Equip {2}" — the Equipment\'s printed attach ability',
    // Only the plain mana form. "Equip creature with power 2 or less {1}" and
    // "Equip {1}{W} — Equip only to a Dwarf" narrow the host in ways this rule
    // does not implement, so they must keep reporting.
    pattern: /^equip ((?:\{[^}]+\})+)$/,
    build(match) {
      const mana = parseManaSymbols(match[1]!);
      if (!mana) return null;
      return {
        attachesAs: {
          // "Attach to target creature YOU CONTROL" — the scope is part of the
          // printed ability, and offering the opponent's board would be a card
          // playing differently from its text.
          attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
          // CR 704.5n: an Equipment attached to nothing is just a permanent.
          whenIllegal: 'detach',
          label: `Equip ${match[1]}`,
        },
        activated: [
          {
            cost: { mana },
            effects: [{ primitive: 'attachToTarget', params: { targets: EQUIP_TARGET } }],
            // "Activate only as a sorcery" is part of what `Equip {N}` means, and
            // dropping it would make every Equipment an instant-speed combat trick.
            timing: 'sorcery',
            label: `Equip ${match[1]}`,
          },
        ],
      };
    },
  },
]);

/** The printed "Enchant <type>" words this compiles, and the aim each means. */
const ENCHANT_RESTRICTIONS: Readonly<Record<string, TargetRestriction>> = Object.freeze({
  creature: CREATURE_TARGET,
  artifact: ARTIFACT_TARGET,
});

/** What an `Equip {N}` ability may point at (CR 301.5c). */
const EQUIP_TARGET: TargetRestriction = 'creatureYouControl';

/**
 * Parse a printed keyword list ("trample", "flying and vigilance", "first strike,
 * trample") into keyword flags, or `null` when ANY of them is one the engine does
 * not model — so a partially-understood line is reported rather than compiled into
 * a card that is missing an ability.
 */
function parseKeywordList(text: string): KeywordFlags | null {
  const words = joinPayloadKeywords(
    text
      .split(/,| and /)
      .map((word) => word.trim().replace(LEADING_GRANT_VERB, ''))
      .filter((word) => word.length > 0),
  );
  if (words.length === 0) return null;
  const flags: Record<string, unknown> = {};
  for (const word of words) {
    const field = KEYWORD_FLAGS[word] ?? KEYWORD_PHRASES[word];
    if (field) {
      flags[field] = true;
      continue;
    }
    // The two PAYLOAD keywords — "ward {1}", "protection from black and from
    // green" — carry a value rather than a boolean, and core already models
    // both. They go through the same parser the printed keyword LINE uses
    // (`parseProtectionOrWard`) so an Equipment and a creature cannot end up
    // disagreeing about which forms are real: a quality outside the closed
    // table ("protection from instants") still returns null and the whole
    // line keeps reporting.
    const payload = parseProtectionOrWard(word);
    if (payload === null) return null;
    Object.assign(flags, payload);
  }
  return flags as KeywordFlags;
}

/**
 * Re-join the conjuncts of a printed protection list that the keyword split
 * broke apart.
 *
 * "protection from black and from green" is ONE ability, but the conjunction
 * that separates two keywords is the same word that separates two protection
 * qualities — so the split yields `['protection from black', 'from green']`.
 * Any run of "from …" fragments belongs to the protection phrase before it;
 * putting them back is what lets {@link parseProtectionOrWard} see the whole
 * printed line, which is the only thing that knows how to read it.
 */
function joinPayloadKeywords(words: readonly string[]): string[] {
  const joined: string[] = [];
  for (const word of words) {
    const previous = joined[joined.length - 1];
    if (previous !== undefined && PROTECTION_CONTINUATION.test(word) && previous.startsWith('protection from ')) {
      joined[joined.length - 1] = `${previous} and ${word}`;
      continue;
    }
    joined.push(word);
  }
  return joined;
}

/** A trailing "from …" fragment of a multi-quality protection line. */
const PROTECTION_CONTINUATION = /^from /;

/**
 * A printed conjunction repeats the verb ("can't be blocked AND HAS shroud"), so
 * each conjunct may carry one of its own. Stripped before the lookup rather than
 * being folded into every pattern, because the verb is grammar, not meaning.
 */
const LEADING_GRANT_VERB = /^(?:has|have|gains?) /;

/**
 * Printed PHRASES that name an engine keyword flag without being a keyword word.
 * The two blocking restrictions are printed as sentences rather than as keywords
 * ("Equipped creature can't be blocked"), so a keyword-word table alone reports
 * a rule the engine fully implements. A CLOSED table, exactly like
 * {@link KEYWORD_FLAGS}: a phrase outside it keeps reporting.
 */
const KEYWORD_PHRASES: Readonly<Record<string, string>> = Object.freeze({
  "can't be blocked": 'unblockable',
  "can't block": 'cantBlock',
});

/**
 * The printed QUALITIES an "except by creatures with …" restriction may name,
 * mapped to the engine keyword a blocker must actually have.
 *
 * Closed on purpose, and typed as `BooleanKeywordName` so a word that does not
 * name a real keyword cannot be added by a typo. A quality outside the table —
 * "except by Walls", "except by artifact creatures" — is a filter over card types
 * rather than a keyword, which this payload cannot say, so the line reports.
 */
const BLOCKER_QUALITY_KEYWORDS: Readonly<Record<string, BooleanKeywordName>> = Object.freeze({
  haste: 'haste',
  flying: 'flying',
  reach: 'reach',
  vigilance: 'vigilance',
  defender: 'defender',
  deathtouch: 'deathtouch',
  'first strike': 'firstStrike',
});

/**
 * ---------------------------------------------------------------------------
 * COPY EFFECTS — "You may have ~ enter as a copy of …" (CR 707)
 * ---------------------------------------------------------------------------
 *
 * Two CLOSED tables and two parsers, for the same reason every other closed
 * table in this file exists: a copy card's whole identity is *what it may copy*
 * and *how the copy differs*, so a selector or an "except" clause the compiler
 * only half-read would produce a card that is not the printed one. Anything
 * outside these tables makes the rule return `null`, and the card reports.
 */

/**
 * The printed nouns a copy clause may select, mapped to the `CardFilter` each
 * one means. `{}` (an empty filter) is "any permanent", which is exactly what an
 * absent filter is — spelled out rather than omitted so the table reads as a
 * complete list of what is understood.
 */
const COPY_SELECTOR_FILTERS: Readonly<Record<string, CardFilter>> = Object.freeze({
  creature: { anyOfTypes: ['creature'] },
  artifact: { anyOfTypes: ['artifact'] },
  enchantment: { anyOfTypes: ['enchantment'] },
  planeswalker: { anyOfTypes: ['planeswalker'] },
  land: { anyOfTypes: ['land'] },
  permanent: {},
  'nonland permanent': { noneOfTypes: ['land'] },
  'artifact or creature': { anyOfTypes: ['artifact', 'creature'] },
  'artifact or enchantment': { anyOfTypes: ['artifact', 'enchantment'] },
  'creature or planeswalker': { anyOfTypes: ['creature', 'planeswalker'] },
});

/** The card-type words a copy "except" clause may add to the copied types. */
const COPY_TYPE_WORDS: Readonly<Record<string, CardType>> = Object.freeze({
  artifact: 'artifact',
  creature: 'creature',
  enchantment: 'enchantment',
  land: 'land',
  planeswalker: 'planeswalker',
});

/**
 * Parse the "of …" half of a copy clause: WHICH objects, WHOSE, and WHERE.
 *
 * Understood shapes, and nothing else:
 *   "any creature on the battlefield"   → any, battlefield
 *   "a creature you control"            → yours, battlefield
 *   "any land card in a graveyard"      → any, graveyard   (Echoing Deeps)
 *
 * Returns `null` for every other wording — notably Mockingbird's "…with mana
 * value less than or equal to the amount of mana spent to cast ~", which needs a
 * fact (how much mana was spent) nothing records, and "target land", which is a
 * targeted ability rather than an as-enters choice.
 */
function parseCopySelector(text: string): Partial<Pick<CopyAsEntersSpec, 'filter' | 'from' | 'whose'>> | null {
  const trimmed = text.trim();
  const graveyard = trimmed.match(/^any ([a-z ]+?) card in a graveyard$/);
  if (graveyard) {
    const filter = COPY_SELECTOR_FILTERS[graveyard[1] ?? ''];
    return filter === undefined ? null : { filter, from: 'graveyard' };
  }
  const battlefield = trimmed.match(/^any ([a-z ]+?) on the battlefield$/);
  if (battlefield) {
    const filter = COPY_SELECTOR_FILTERS[battlefield[1] ?? ''];
    return filter === undefined ? null : { filter };
  }
  const yours = trimmed.match(/^an? ([a-z ]+?) you control$/);
  if (yours) {
    const filter = COPY_SELECTOR_FILTERS[yours[1] ?? ''];
    return filter === undefined ? null : { filter, whose: 'you' };
  }
  return null;
}

/**
 * Split the printed "except …" tail into its clauses.
 *
 * Real cards join them with ", " and a final ", and " / " and " (Spark Double
 * prints three, Sakashima three, Phantasmal Image two). Splitting on both
 * separators is safe because every clause the table below accepts is a fixed
 * short phrase containing neither — and a clause that DOES contain one (a quoted
 * granted ability, which always carries commas inside its quotes) simply fails
 * to match any entry, which reports the whole card. That is the right outcome
 * for it anyway.
 */
function splitExceptClauses(text: string): string[] {
  return text
    .split(/,\s*and\s+|,\s*|\s+and\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Read one "except …" clause into a {@link CopyExceptions} patch, or `null` when
 * the compiler does not understand it.
 *
 * A CLOSED table of printed phrasings, and it must be closed for the reason this
 * whole file exists: "except it has 'When this creature becomes the target of a
 * spell or ability, sacrifice it'" (Phantasmal Image) grants a TRIGGERED ABILITY
 * on a condition the engine has no event for, and a copy missing that drawback
 * would be strictly better than the printed card.
 */
function parseCopyException(clause: string, ctx: RuleContext): CopyExceptions | null {
  // "it's an Illusion in addition to its other types" / "it's an artifact …".
  // One printed word may be a card TYPE or a creature SUBTYPE, and a card may
  // print two subtypes at once ("it's a Shapeshifter Rogue in addition…").
  const addition = clause.match(/^it'?s (?:an?|the) ([a-z' ]+?) in addition to its other types$/);
  if (addition) {
    const words = (addition[1] ?? '').split(' ').filter((w) => w.length > 0);
    if (words.length === 0) return null;
    if (words.length === 1 && words[0] === 'legendary') return { legendary: true };
    const types: CardType[] = [];
    const subtypes: string[] = [];
    for (const word of words) {
      const asType = COPY_TYPE_WORDS[word];
      if (asType !== undefined) {
        types.push(asType);
      } else {
        // Anything else is a creature SUBTYPE — which is what these clauses
        // print (Bird, Illusion, Cave, Shapeshifter, Rogue). Subtypes are free
        // text in this engine and compared case-insensitively, so the word is
        // carried verbatim rather than checked against a list that could not be
        // complete.
        subtypes.push(word.charAt(0).toUpperCase() + word.slice(1));
      }
    }
    return {
      ...(types.length > 0 ? { addTypes: types } : {}),
      ...(subtypes.length > 0 ? { addSubtypes: subtypes } : {}),
    };
  }
  // "it's legendary" — the supertype form, which the branch above deliberately
  // does not swallow (a supertype is not "another type").
  if (/^it'?s legendary(?: in addition to its other types)?$/.test(clause)) return { legendary: true };
  // "it isn't legendary" (Spark Double).
  if (/^it isn'?t legendary$/.test(clause)) return { legendary: false };
  // "its name is ~" — the copy keeps the copying card's own printed name
  // (Sakashima the Impostor, Chameleon's "his name is …").
  if (/^(?:its|his|her|their) name is ~$/.test(clause)) return { name: ctx.card.name };
  // "it has flying" — only words that are real engine keyword flags.
  const keyword = clause.match(/^it has ([a-z' ]+)$/);
  if (keyword) {
    const flag = KEYWORD_FLAGS[(keyword[1] ?? '').trim()];
    return flag === undefined ? null : { addKeywords: { [flag]: true } as KeywordFlags };
  }
  // "it enters with an additional +1/+1 counter on it if it's a creature".
  if (/^it enters with an additional \+1\/\+1 counter on it if it'?s a creature$/.test(clause)) {
    return { extraCounters: { [PLUS_ONE_COUNTER]: 1 } };
  }
  // "it enters with an additional loyalty counter on it if it's a planeswalker".
  if (/^it enters with an additional loyalty counter on it if it'?s a planeswalker$/.test(clause)) {
    return { extraLoyalty: 1 };
  }
  return null;
}

/** Merge one parsed exception patch into the accumulating tail. */
function mergeCopyExceptions(base: CopyExceptions, patch: CopyExceptions): CopyExceptions {
  return {
    ...base,
    ...patch,
    ...(base.addTypes || patch.addTypes ? { addTypes: [...(base.addTypes ?? []), ...(patch.addTypes ?? [])] } : {}),
    ...(base.addSubtypes || patch.addSubtypes
      ? { addSubtypes: [...(base.addSubtypes ?? []), ...(patch.addSubtypes ?? [])] }
      : {}),
    ...(base.addKeywords || patch.addKeywords
      ? { addKeywords: { ...base.addKeywords, ...patch.addKeywords } }
      : {}),
    ...(base.extraCounters || patch.extraCounters
      ? { extraCounters: { ...base.extraCounters, ...patch.extraCounters } }
      : {}),
  };
}

/**
 * Build the whole `copyAsEnters` spec from a matched copy clause, or `null` when
 * any part of it is not fully understood.
 *
 * `tapped` is the printed word in "you may have ~ enter **tapped** as a copy of
 * any land on the battlefield" (Vesuva). It is carried as an EXCEPTION rather
 * than as the card's own `entersTapped`, because the copied land replaces this
 * card's characteristics entirely — the copying card's printed word has to
 * survive that replacement or Vesuva enters untapped.
 */
function buildCopyAsEnters(
  selectorText: string,
  exceptText: string | undefined,
  tapped: boolean,
  ctx: RuleContext,
): CopyAsEntersSpec | null {
  const selector = parseCopySelector(selectorText);
  if (selector === null) return null;
  let except: CopyExceptions = tapped ? { entersTapped: true } : {};
  if (exceptText !== undefined && exceptText.trim().length > 0) {
    for (const clause of splitExceptClauses(exceptText)) {
      const patch = parseCopyException(clause, ctx);
      if (patch === null) return null;
      except = mergeCopyExceptions(except, patch);
    }
  }
  return { ...selector, ...(Object.keys(except).length > 0 ? { except } : {}) };
}

/**
 * ---------------------------------------------------------------------------
 * TOKEN COPIES — "create a token that's a copy of …" (CR 707.2 + CR 111)
 * ---------------------------------------------------------------------------
 *
 * The other half of the copy family, and it deliberately reuses this file's
 * existing copy vocabulary rather than growing a rival: the "except …" tail is
 * parsed by {@link parseCopyException}, the very function the as-enters copy
 * uses, so "except it has haste" and "except it isn't legendary" mean exactly
 * one thing in this codebase. What is NEW is only the selector — a token copy
 * points at a TARGET (or at the permanent the source is attached to, or at the
 * source itself), where an as-enters copy chooses from a filtered zone.
 */

/**
 * The printed selectors a token-copy clause may name, mapped to how the
 * primitive finds the permanent.
 *
 * A CLOSED table, for the same reason `COPY_SELECTOR_FILTERS` is closed: a
 * selector the compiler only half-read produces a card that copies something
 * the printed one cannot. "target NONLEGENDARY creature you control"
 * (Kiki-Jiki) is deliberately absent — the engine has no such target
 * restriction, and pretending it were "target creature you control" would let
 * the card copy a legend it may not.
 */
const TOKEN_COPY_SELECTORS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  'target creature': { targets: CREATURE_TARGET },
  'target creature you control': { targets: CREATURE_YOU_CONTROL_TARGET },
  'target artifact': { targets: ARTIFACT_TARGET },
  'target permanent': { targets: PERMANENT_TARGET },
  // "a copy of equipped creature" (Helm of the Host) / "of enchanted artifact"
  // (Mechanized Production): the source's HOST, not a target. One param covers
  // both printings because the engine models both with `attachedTo`.
  'equipped creature': { equipped: true },
  'enchanted creature': { equipped: true },
  'enchanted artifact': { equipped: true },
  'enchanted permanent': { equipped: true },
  // "a copy of this creature" (Giant Adephage, Homunculus Horde) — `~` after the
  // self-reference pass. No target at all, which is what makes it legal inside a
  // triggered ability.
  '~': { self: true },
});

/** How many tokens each printed count word makes. */
const TOKEN_COPY_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
});

/**
 * Build a `createTokenCopy` ref from the tail of a token-copy clause, or `null`
 * when any part of it is not fully understood.
 *
 * `rest` is everything after "… that's a copy of", and it may carry two printed
 * tails that are parsed off the END first, longest-anchored first, so the
 * selector is whatever remains:
 *   ". if this spell was kicked, create five of those tokens instead"
 *   ", except it has haste"
 * Parsing from the end rather than with one greedy regex is what keeps a
 * selector containing a comma from being mistaken for an "except" clause.
 */
function buildTokenCopy(countWord: string, rest: string, ctx: RuleContext): ClauseContribution | null {
  const count = TOKEN_COPY_COUNTS[countWord];
  if (count === undefined) return null;
  let body = rest.trim();

  // "… If this spell was kicked, create FIVE of those tokens INSTEAD" (Rite of
  // Replication). A replacement of the COUNT, so it is one number on the same
  // ref rather than a second `ifKicked`-guarded effect — which would create the
  // base token AND five more.
  let kickedCount = 0;
  const kicked = body.match(/\. if this spell was kicked, create (a|an|one|two|three|four|five) of those tokens instead$/);
  if (kicked) {
    const kickedValue = TOKEN_COPY_COUNTS[kicked[1] ?? ''];
    if (kickedValue === undefined) return null;
    kickedCount = kickedValue;
    body = body.slice(0, body.length - (kicked[0] ?? '').length).trim();
  }

  let except: CopyExceptions = {};
  const exceptAt = body.indexOf(', except ');
  if (exceptAt >= 0) {
    const exceptText = body.slice(exceptAt + ', except '.length);
    body = body.slice(0, exceptAt).trim();
    for (const clause of splitExceptClauses(exceptText)) {
      const patch = parseCopyException(clause, ctx);
      if (patch === null) return null;
      except = mergeCopyExceptions(except, patch);
    }
  }

  const selector = TOKEN_COPY_SELECTORS[body];
  if (selector === undefined) return null;
  return effects({
    primitive: 'createTokenCopy',
    params: {
      ...selector,
      count,
      ...(kickedCount > 0 ? { kickedCount } : {}),
      ...(Object.keys(except).length > 0 ? { except } : {}),
    },
  });
}

/** Number words a printed "N or fewer" uses. */
const SMALL_NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
});

/** The colors "one mana of any color" may be taken as, in canonical order. */
const ANY_COLOR: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** Turn a run of symbols ("{c}{c}") into the single mode one tap adds. */
function productionFromColors(colors: readonly ManaColor[]): ManaProduction {
  const mode: Partial<Record<ManaColor, number>> = {};
  for (const color of colors) mode[color] = (mode[color] ?? 0) + 1;
  return mode;
}

/** Split an "or"-list of mana runs ("{w}, {u}, or {b}") into its alternatives. */
const MANA_ALTERNATIVE_SEPARATOR = /,? or |, /;


/**
 * ABILITY WORDS (CR 207.2c) as they are PRINTED — the italicized label in front
 * of a line, which has no rules meaning of its own. Listed once and read twice:
 * {@link ABILITY_WORDS} skips them in the keyword sweep, and
 * {@link ABILITY_WORD_PREFIX} lets a rule match the line the label sits on
 * (Mox Opal's "Metalcraft — {T}: Add one mana of any color").
 */
const ABILITY_WORD_LIST: readonly string[] = [
  'revolt',
  'morbid',
  'delirium',
  'threshold',
  'metalcraft',
  // Landfall and constellation label the permanent-enters trigger line that
  // `trigger-permanent-enters-or-dies` compiles. Leaving them out would report a
  // keyword one line after implementing the ability it labels — the sweep guard's
  // own rule: a keyword is skipped only when the line it labels actually compiled.
  // They live in this LIST rather than only in the exported set so the ability-word
  // regex prefix below sees them too; one list, one definition.
  'landfall',
  'constellation',
];

/** An optional printed ability-word label, for patterns that must see past one. */
const ABILITY_WORD_PREFIX = `(?:(?:${ABILITY_WORD_LIST.join('|')})\\s*[\\u2014\\u2013-]\\s*)?`;

// --- the rich mana-ability shapes -------------------------------------------
//
// Everything below builds `CardDefinition.manaAbilities`: a mana ability that
// prints more than a colour bundle. Core's model carries the four things a real
// card adds — an additional cost, a rider, an "Activate only if …", and colours
// read off the board — and each rule here transcribes exactly one of them.
//
// They are separate rules rather than one mega-pattern because the printed forms
// combine independently and a single pattern would have to make every part
// optional, which is how a rule quietly matches a wording it does not implement.

/** The "add …" payload of a mana ability, as the modes ONE activation offers. */
function parseManaPayload(payload: string): readonly ManaProduction[] | null {
  const text = payload.trim();
  // "one mana of any color" — five modes of one.
  if (/^one mana of any color$/.test(text)) {
    return ANY_COLOR.map((color) => productionFromColors([color]));
  }
  // "three mana of any one color" — five modes of three. "one color" is what
  // makes it a choice of MODE; a card adding three mana of any colorS would be a
  // different ability, so the printed word is required.
  const multiple = text.match(new RegExp(`^${COUNT_TOKEN} mana of any one color$`));
  if (multiple) {
    const count = parseCount(multiple[1]);
    if (count === null || count < 1) return null;
    return ANY_COLOR.map((color) =>
      productionFromColors(Array.from({ length: count }, () => color)),
    );
  }
  // A printed list of symbol runs: "{W}", "{C}{C}", "{W} or {U}",
  // "{W}{W}, {W}{U}, or {U}{U}" (the filter lands).
  if (!/^[{}wubrgc,or\s]+$/.test(text)) return null;
  const alternatives = text.split(MANA_ALTERNATIVE_SEPARATOR);
  const modes: ManaProduction[] = [];
  for (const alternative of alternatives) {
    const colors = manaSymbols(alternative);
    if (colors === null) return null;
    modes.push(productionFromColors(colors));
  }
  return modes.length > 0 ? modes : null;
}

/** Card types an "Activate only if you control N or more …" clause may count. */
const COUNTABLE_TYPE_WORDS: Readonly<Record<string, CardType>> = Object.freeze({
  artifacts: 'artifact',
  creatures: 'creature',
  enchantments: 'enchantment',
  lands: 'land',
});

/**
 * Parse the condition half of "Activate only if you control …".
 *
 * Returns `null` for any wording not fully understood, so the clause reports
 * rather than compiling into a restriction that is not the printed one — a mana
 * source that is available when it should not be is a strictly better card.
 */
function parseManaActivationCondition(text: string): ManaActivationCondition | null {
  const condition = text.trim();
  // "a red permanent" / "a white or blue permanent".
  const colored = condition.match(/^an? ([a-z]+(?: or [a-z]+)*) permanent$/);
  if (colored) {
    const colors: ManaColor[] = [];
    for (const word of (colored[1] ?? '').split(' or ')) {
      const color = COLOR_WORDS[word];
      if (!color) return null;
      colors.push(color);
    }
    return { controlsColor: colors };
  }
  // Metalcraft and friends: "three or more artifacts".
  const counted = condition.match(new RegExp(`^${COUNT_TOKEN} or more ([a-z]+)$`));
  if (counted) {
    const count = parseCount(counted[1]);
    const type = COUNTABLE_TYPE_WORDS[counted[2] ?? ''];
    if (count === null || count < 1 || !type) return null;
    return { controlsTypeAtLeast: { type, count } };
  }
  // "an Island" / "a Mountain or a Plains" — a land subtype the type line prints.
  const subtyped = condition.match(/^an? ([a-z]+)(?: or an? ([a-z]+))?$/);
  if (subtyped) {
    const wanted = [subtyped[1], subtyped[2]].filter((word): word is string => Boolean(word));
    // Only the five basic land types are safe to read as a subtype here: any
    // other noun ("a creature", "an opponent") is a different question entirely.
    if (wanted.every((word) => BASIC_LAND_SUBTYPES.includes(word))) {
      return { controlsSubtype: wanted };
    }
  }
  return null;
}

/** The five basic land types, lowercased — the only subtypes a Verge/Maze names. */
const BASIC_LAND_SUBTYPES: readonly string[] = ['plains', 'island', 'swamp', 'mountain', 'forest'];

// --- SPEND RESTRICTIONS on produced mana ------------------------------------
//
// "Spend this mana only to cast a creature spell" (Ancient Ziggurat), "…only to
// cast artifact spells or activate abilities of artifacts" (Power Depot). The
// restriction is carried by the MANA rather than by the source, which is why it
// compiles to `ManaAbility.spendRestriction` and is honoured by the POOL — see
// core's spend-restriction.ts.
//
// The parser below REFUSES anything it does not fully understand, because both
// directions of error print a different card: a restriction the engine drops
// makes Ancient Ziggurat a strictly better land, and one the engine invents makes
// it strictly worse. Cavern of Souls' "of the chosen type" is the live refusal —
// it needs a per-INSTANCE remembered creature type, which is the separate
// "As ~ enters, choose a creature type" template, and there is no honest way to
// compile it without one.

/**
 * Whether this card prints "As ~ enters, choose a creature type" — the naming
 * that gives "…of the chosen type" something to refer to.
 *
 * Read off the card's own Oracle text for the same reason `cardHasXCost` reads
 * the printed cost: a rule runs while the assembly is still being built, so the
 * compiled `asEntersChoice` may not exist yet when this line is reached.
 */
function cardNamesACreatureTypeAsItEnters(ctx: RuleContext): boolean {
  return /enters, choose a creature type/i.test(ctx.card.oracleText);
}

/** The printed head nouns a "cast …" restriction ends on. */
const SPEND_HEAD_NOUNS: readonly string[] = ['spell', 'spells', 'source', 'sources'];

/** Type words a spend restriction may name, singular and plural, to `CardType`. */
const SPEND_TYPE_WORDS: Readonly<Record<string, CardType>> = Object.freeze({
  creature: 'creature',
  creatures: 'creature',
  artifact: 'artifact',
  artifacts: 'artifact',
  enchantment: 'enchantment',
  enchantments: 'enchantment',
  instant: 'instant',
  instants: 'instant',
  sorcery: 'sorcery',
  sorceries: 'sorcery',
  land: 'land',
  lands: 'land',
  planeswalker: 'planeswalker',
  planeswalkers: 'planeswalker',
  battle: 'battle',
  battles: 'battle',
});

/**
 * Parse the OBJECT half of one restriction clause — "a creature spell",
 * "colorless eldrazi spells", "artifacts", "a dragon creature spell".
 *
 * Token-driven rather than one regex, because the printed parts stack
 * independently (article, "colorless", "legendary", a colour, a subtype, a type,
 * a head noun) and a regex making each of them optional is exactly how a pattern
 * quietly matches a wording it does not implement. EVERY token must be
 * recognised; one that is not returns `null` and the card reports.
 *
 * `requireHead` is true for "cast …", which always ends in "spell(s)". The
 * "activate abilities of …" form names its objects bare ("of artifacts"), so it
 * does not.
 */
function parseSpendObject(
  spec: string,
  purpose: 'cast' | 'activate',
  requireHead: boolean,
): ManaSpendClause | null {
  const tokens = spec
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  if (tokens[0] === 'a' || tokens[0] === 'an') tokens.shift();
  // "…of the chosen type" trails the head noun ("a creature spell OF THE CHOSEN
  // TYPE"), so it comes off first — otherwise the head-noun test looks at "type"
  // and the whole clause is refused. The flag it sets is a DECLARATION; the value
  // is substituted when the mana is made (core's `resolveSpendRestriction`).
  let subtypeChosenBySource = false;
  if (tokens.slice(-4).join(' ') === 'of the chosen type') {
    tokens.length -= 4;
    subtypeChosenBySource = true;
  }
  if (SPEND_HEAD_NOUNS.includes(tokens[tokens.length - 1] ?? '')) tokens.pop();
  else if (requireHead) return null;

  const types: CardType[] = [];
  const colors: ManaColor[] = [];
  const subtypes: string[] = [];
  let colorless = false;
  let legendary = false;
  for (const token of tokens) {
    if (token === 'colorless') {
      colorless = true;
      continue;
    }
    if (token === 'legendary') {
      legendary = true;
      continue;
    }
    const color = COLOR_WORDS[token];
    if (color) {
      colors.push(color);
      continue;
    }
    const type = SPEND_TYPE_WORDS[token];
    if (type) {
      types.push(type);
      continue;
    }
    // Anything left must be a printed SUBTYPE ("dragon", "eldrazi", "angel",
    // "omen"), and there may be only one — "of the chosen type" and every other
    // unread wording leaves several unrecognised words here and is refused.
    //
    // A PLURAL subtype is refused too: subtypes match the printed word, so
    // "dragons" would match nothing, and mana that can never be spent is as wrong
    // as mana that can be spent on anything. Refusing only ever declines a card;
    // it cannot mis-compile one.
    if (subtypes.length > 0 || !/^[a-z][a-z'-]*$/.test(token) || token.endsWith('s')) return null;
    subtypes.push(token);
  }
  if (
    types.length === 0 &&
    subtypes.length === 0 &&
    colors.length === 0 &&
    !colorless &&
    !legendary &&
    !subtypeChosenBySource
  ) {
    // "…only to cast a spell" restricts nothing this engine can check. No printed
    // card says it, and refusing stops the rule from becoming a way to compile
    // mana whose restriction is silently vacuous.
    return null;
  }
  const clause: {
    purpose: 'cast' | 'activate';
    types?: readonly CardType[];
    subtypes?: readonly string[];
    colors?: readonly ManaColor[];
    colorless?: boolean;
    legendary?: boolean;
    subtypeChosenBySource?: boolean;
  } = { purpose };
  if (types.length > 0) clause.types = types;
  if (subtypes.length > 0) clause.subtypes = subtypes;
  if (colors.length > 0) clause.colors = colors;
  if (colorless) clause.colorless = true;
  if (legendary) clause.legendary = true;
  if (subtypeChosenBySource) clause.subtypeChosenBySource = true;
  return clause as ManaSpendClause;
}

/**
 * Parse the whole "spend this mana only to …" tail into a restriction.
 *
 * The printed "or" is a DISJUNCTION over clauses, and a later alternative may
 * omit the verb ("cast a Dragon spell **or an Omen spell**"), so the previous
 * alternative's verb carries forward — which is how the sentence reads in English
 * and what keeps Maelstrom of the Spirit Dragon from being read as "cast a Dragon
 * spell or activate an Omen".
 */
function parseManaSpendRestriction(text: string): ManaSpendRestriction | null {
  const parts = text.trim().split(' or ');
  const allow: ManaSpendClause[] = [];
  let verb: 'cast' | 'activate' | null = null;
  for (const part of parts) {
    const trimmed = part.trim();
    const activate = trimmed.match(/^activate (?:abilities|an ability) of (.+)$/);
    if (activate) {
      verb = 'activate';
      const clause = parseSpendObject(activate[1] ?? '', 'activate', false);
      if (!clause) return null;
      allow.push(clause);
      continue;
    }
    const cast = trimmed.match(/^cast (.+)$/);
    if (cast) verb = 'cast';
    // A leading alternative with no verb at all is not a printed form; refusing
    // keeps the carry-forward from inventing a reading.
    if (verb === null) return null;
    const clause = parseSpendObject(cast ? (cast[1] ?? '') : trimmed, verb, verb === 'cast');
    if (!clause) return null;
    allow.push(clause);
  }
  return allow.length > 0 ? { label: `only to ${text.trim()}`, allow } : null;
}

/**
 * A printed cost run that MAY contain colour/colour hybrid symbols — the filter
 * lands' "{W/U}". `parseManaSymbols` deliberately refuses a hybrid because most
 * callers cannot pay one; `ManaCost.hybrid` can, and a filter land's whole
 * identity is that its input is either of two colours.
 *
 * Returns `null` for anything else (Phyrexian, {X}, a snow symbol), so an
 * unmodelled cost never compiles as something cheaper than printed.
 */
function parseCostWithHybrids(text: string): ManaCost | null {
  const cost: Record<string, unknown> = {};
  const hybrid: ManaColor[][] = [];
  const symbols = splitCostSymbols(text);
  if (symbols.length === 0) return null;
  for (const symbol of symbols) {
    if (/^\d+$/.test(symbol)) {
      cost.generic = ((cost.generic as number | undefined) ?? 0) + Number.parseInt(symbol, 10);
      continue;
    }
    if ((MANA_COLORS as readonly string[]).includes(symbol)) {
      cost[symbol] = ((cost[symbol] as number | undefined) ?? 0) + 1;
      continue;
    }
    const halves = symbol.split('/');
    if (
      halves.length === 2 &&
      halves.every((half) => (MANA_COLORS as readonly string[]).includes(half) && half !== 'C')
    ) {
      hybrid.push(halves as ManaColor[]);
      continue;
    }
    return null;
  }
  if (hybrid.length > 0) cost.hybrid = hybrid;
  return Object.keys(cost).length > 0 ? (cost as ManaCost) : null;
}

export const MANA_RULES: readonly CompileRule[] = Object.freeze([
  {
    id: 'tap-for-mana',
    description: '"{T}: Add {G}" / "{T}: Add {C}{C}"',
    pattern: /^\{t\}: add ((?:\{[wubrgc]\})+)$/,
    build(match) {
      const colors = manaSymbols(match[1] ?? '');
      return colors === null ? null : { produces: colors };
    },
  },
  {
    // A CHOICE between fixed alternatives — the printed form of every common
    // dual land ("{T}: Add {W} or {U}"). Core models this exactly with
    // `producesOptions`: one tap adds one MODE, chosen at activation. (Writing
    // the alternatives as a `produces` bundle would instead add one of each,
    // turning a dual land into a two-mana land — which is why this rule may only
    // ever build modes, never a bundle.)
    id: 'tap-for-mana-choice',
    description: '"{T}: Add {W} or {U}" / "{T}: Add {W}, {U}, {B}, {R}, or {G}"',
    pattern:
      /^\{t\}: add ((?:\{[wubrgc]\})+(?:,? or (?:\{[wubrgc]\})+|, (?:\{[wubrgc]\})+)+)$/,
    build(match) {
      const alternatives = (match[1] ?? '').split(MANA_ALTERNATIVE_SEPARATOR);
      const producesOptions: ManaProduction[] = [];
      for (const alternative of alternatives) {
        const colors = manaSymbols(alternative);
        if (colors === null) return null;
        producesOptions.push(productionFromColors(colors));
      }
      return producesOptions.length > 1 ? { producesOptions } : null;
    },
  },
  {
    // The same modal ability with a MULTIPLIER: "Add three mana of any one color"
    // is five modes of three, not fifteen mana. "One color" is what makes it a
    // choice of MODE rather than a bundle — a card that added three mana of any
    // colorS would be a different, unmodelled ability, so the rule requires the
    // printed word "one".
    id: 'tap-for-n-of-any-one-color',
    description: '"{T}: Add three mana of any one color" (Gilded Lotus)',
    pattern: new RegExp(`^\\{t\\}: add ${COUNT_TOKEN} mana of any one color$`),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null || count < 1) return null;
      return {
        producesOptions: ANY_COLOR.map((color) =>
          productionFromColors(Array.from({ length: count }, () => color)),
        ),
      };
    },
  },
  {
    // "Add one mana of any color" is the same modal ability with the five colors
    // spelled out in words — Birds of Paradise, Manalith, Alloy Myr.
    id: 'tap-for-any-color',
    description: '"{T}: Add one mana of any color"',
    pattern: /^\{t\}: add one mana of any color$/,
    build() {
      return { producesOptions: ANY_COLOR.map((color) => productionFromColors([color])) };
    },
  },
  {
    // A RIDER: the ability's own resolution does something besides adding mana.
    // Every pain land and Ancient Tomb — "{T}: Add {R} or {W}. ~ deals 1 damage
    // to you." The damage is NOT a cost (it cannot be declined and the land is
    // still usable at 1 life), which is why it compiles to `rider` rather than to
    // a life cost.
    id: 'mana-ability-with-rider',
    description: '"{T}: Add {R} or {W}. ~ deals 1 damage to you" (the pain lands)',
    pattern: new RegExp(
      `^\\{t\\}: add (.+)\\. (?:~|it) deals ${COUNT_TOKEN} damage to you$`,
    ),
    build(match) {
      const produces = parseManaPayload(match[1] ?? '');
      const amount = parseCount(match[2]);
      if (!produces || amount === null || amount < 1) return null;
      return { manaAbilities: [{ produces, rider: { damageToController: amount } }] };
    },
  },
  {
    // An ACTIVATION RESTRICTION: the Verge cycle ("Activate only if you control a
    // red permanent"), Nimbus Maze ("… an Island"), Mox Opal ("… three or more
    // artifacts"). The restriction is checked when the ability is OFFERED, so an
    // unmet one makes the source invisible to the payment planner rather than
    // refusing after it has been counted on.
    id: 'mana-ability-activation-restriction',
    description: '"{T}: Add {R}. Activate only if you control a red permanent" (the Verge cycle)',
    pattern: new RegExp(
      `^${ABILITY_WORD_PREFIX}\\{t\\}: add (.+)\\. activate only if you control (.+)$`,
    ),
    build(match) {
      const produces = parseManaPayload(match[1] ?? '');
      const restriction = parseManaActivationCondition(match[2] ?? '');
      if (!produces || !restriction) return null;
      return { manaAbilities: [{ produces, restriction }] };
    },
  },
  {
    // An ADDITIONAL COST, life half: Mana Confluence, the horizon lands, the
    // Talisman cycle. Charged on activation and gated on having the life
    // (CR 118.4), exactly as an activated ability's "Pay N life" is.
    id: 'mana-ability-life-cost',
    description: '"{T}, Pay 1 life: Add {W} or {B}" (Mana Confluence, the horizon lands)',
    pattern: new RegExp(`^\\{t\\}, pay ${COUNT_TOKEN} life: add (.+)$`),
    build(match) {
      const life = parseCount(match[1]);
      const produces = parseManaPayload(match[2] ?? '');
      if (!produces || life === null || life < 1) return null;
      return { manaAbilities: [{ produces, cost: { life } }] };
    },
  },
  {
    // An ADDITIONAL COST, mana half: the filter lands' "{W/U}, {T}: Add {W}{W},
    // {W}{U}, or {U}{U}". The input is a HYBRID symbol, which is why the cost is
    // parsed by `parseCostWithHybrids` rather than the usual symbol reader.
    id: 'mana-ability-mana-cost',
    description: '"{W/U}, {T}: Add {W}{W}, {W}{U}, or {U}{U}" (the filter lands)',
    pattern: /^((?:\{[^}]+\})+), \{t\}: add (.+)$/,
    build(match) {
      const mana = parseCostWithHybrids(match[1] ?? '');
      const produces = parseManaPayload(match[2] ?? '');
      if (!mana || !produces) return null;
      return { manaAbilities: [{ produces, cost: { mana } }] };
    },
  },
  {
    /**
     * **"{T}: Add one mana of the chosen color."** (Coldsteel Heart, Heraldic
     * Banner, Temple of the Dragon Queen) — the colour is whatever THIS
     * permanent named as it entered.
     *
     * Compiles to `ManaAbility.chosenColor`, which enumerates the five nameable
     * colours as modes and lets the engine gate them per instance — the same
     * shape `derivedColors` uses, so the mode index space stays a property of
     * the definition rather than of the board.
     *
     * Refused on a card with no naming line, for the same reason the "of the
     * chosen type" anthem is: a mana ability that can never produce anything is
     * a blank, and a blank that reports `'complete'` is worse than a report.
     */
    id: 'mana-ability-chosen-color',
    description: '"{T}: Add one mana of the chosen color."',
    pattern: /^\{t\}: add one mana of the chosen color$/,
    build(_match, ctx) {
      if (!namesAValueAsItEnters(ctx)) return null;
      return { manaAbilities: [{ chosenColor: true, label: 'Add one mana of the chosen color' }] };
    },
  },
  {
    // COLOURS DERIVED FROM THE BOARD: Reflecting Pool, Exotic Orchard, Fellwar
    // Stone. The mode list is the five colours either way — which colours are
    // actually AVAILABLE is asked of the live board every time the ability is
    // offered, so the answer is never frozen onto the shared definition.
    id: 'mana-ability-derived-colors',
    description: '"{T}: Add one mana of any color that a land you control could produce"',
    pattern:
      /^\{t\}: add one mana of any (color|type) that a land (you control|an opponent controls) could produce$/,
    build(match) {
      const whose = match[2];
      const derivedColors =
        whose === 'you control'
          ? ('landsYouControl' as const)
          : whose === 'an opponent controls'
            ? ('landsOpponentsControl' as const)
            : null;
      if (!derivedColors) return null;
      // "any TYPE" reaches colourless; "any COLOR" does not (Reflecting Pool vs
      // Exotic Orchard). One printed word, two different cards.
      const derivedIncludesColorless = match[1] === 'type';
      return {
        manaAbilities: [
          derivedIncludesColorless ? { derivedColors, derivedIncludesColorless } : { derivedColors },
        ],
      };
    },
  },
  {
    // A SPEND RESTRICTION on the mana this ability makes: Ancient Ziggurat,
    // Somberwald Sage, Eldrazi Temple, Giada, Power Depot. The restriction rides
    // the MANA into the pool rather than decorating the source, which is why it
    // is the one entry in the mana model that outlives the tap — see core's
    // spend-restriction.ts.
    //
    // The "add" half is the ordinary payload parser, so every production shape
    // the other rules read ("one mana of any color", "three mana of any one
    // color", a printed run) is available here with no second grammar.
    id: 'mana-ability-spend-restriction',
    description: '"{T}: Add one mana of any color. Spend this mana only to cast a creature spell"',
    pattern: /^\{t\}: add (.+?)\. spend this mana only to (.+)$/,
    build(match, ctx) {
      const produces = parseManaPayload(match[1] ?? '');
      const spendRestriction = parseManaSpendRestriction(match[2] ?? '');
      if (!produces || !spendRestriction) return null;
      // "…of the chosen type" only means something on a card that ACTUALLY names
      // a creature type as it enters. Compiling it on a card that does not would
      // print a land whose mana can never be spent — strictly worse than the real
      // one, and just as much a lie as one whose mana pays for anything. The
      // clause is checked against the card's own printed text rather than against
      // the assembly, because rules run before the assembly is complete and a
      // land's naming line may compile after this one.
      if (
        spendRestriction.allow.some((clause) => clause.subtypeChosenBySource === true) &&
        !cardNamesACreatureTypeAsItEnters(ctx)
      ) {
        return null;
      }
      return { manaAbilities: [{ produces, spendRestriction }] };
    },
  },
  // NOTE: there is still deliberately NO rule for a mana ability whose colours
  // come from somewhere the engine cannot read — "add one mana of any color in
  // your commander's color identity" (there is no commander here and no format
  // that has one, see the completion plan §5) or "of any type that land
  // produced" (a REMEMBERED permanent, which is a triggered ability watching a
  // tap, not a mana ability at all). Those fall through to `missing` (see
  // UNSUPPORTED_HINTS), each named for what it actually needs.
]);

/**
 * Riders that reference a mechanic the engine does not have AT ALL, and which
 * therefore change nothing. "They can't be regenerated" only matters in a game
 * with regeneration; since no card can ever regenerate here, honoring the rider
 * is automatic and ignoring the sentence is faithful — not an approximation.
 *
 * This list is strictly for clauses that are *vacuously satisfied*. A clause the
 * engine merely handles badly does NOT belong here; it belongs in `missing`.
 */
export const VACUOUS_CLAUSES: readonly RegExp[] = Object.freeze([
  /^(?:they|it) can'?t be regenerated$/,
  // A Siege's protector line: "As this Siege enters, choose an opponent to
  // protect it. You and others can attack it."
  //
  // Vacuously satisfied at two players, NOT approximated. "Choose an opponent"
  // over a one-opponent table has exactly one legal answer, and the engine gives
  // that answer structurally: `protectorOf` derives a battle's protector as its
  // controller's opponent, so the resulting board is identical to the one the
  // choice would have produced. Asking would be theatre — the same reasoning
  // `isTrivialChoice` applies to any single-option question.
  //
  // The second sentence is a statement of the rules the seam already enforces:
  // the battle's controller and everyone else CAN attack it, because attack
  // legality asks who PROTECTS the object rather than who controls it.
  //
  // If a third seat is ever added this stops being vacuous and must become a
  // real choice, because then the answer genuinely varies.
  // Split into one pattern per SENTENCE, because vacuity is judged per sentence
  // (`compileAbilityLine` splits the line before filtering) — a single combined
  // pattern silently matched neither half.
  /^as ~ enters, choose an opponent to protect it$/,
  /^you and others can attack it$/,
]);

/**
 * ABILITY WORDS (CR 207.2c) — italicized labels that have NO rules meaning of
 * their own. "Revolt", "Morbid", "Delirium" and friends only mark a line whose
 * printed text carries the whole condition, and `text.ts` joins that line onto
 * the one it modifies so a single rule sees the idiom.
 *
 * Scryfall lists them in a card's `keywords`, which the compiler's keyword sweep
 * would otherwise report as an unmodelled ability one line after implementing
 * it — exactly the false report "Kicker" and "Flashback" already have their own
 * skips for. The skip is CONDITIONAL on the labelled line having compiled: if it
 * did not, its text (which contains the word) is in `missing`, and the card
 * keeps reporting.
 */
export const ABILITY_WORDS: ReadonlySet<string> = new Set(ABILITY_WORD_LIST);

/** True when a clause is vacuously satisfied and can safely be skipped. */
export function isVacuousClause(clause: string): boolean {
  return VACUOUS_CLAUSES.some((pattern) => pattern.test(clause));
}

/**
 * Keyword abilities with a real implementation built from primitives, expressed
 * as a direct contribution. Persist is modelled exactly as the hand-authored
 * pool models it: a dies-trigger running `persistReturn`, which brings the
 * creature back with a -1/-1 counter and strips its own persist so it cannot
 * return twice.
 */
export const KEYWORD_ABILITY_BUILDERS: Readonly<Record<string, () => ClauseContribution>> =
  Object.freeze({
    // CHANGELING (CR 702.73a) — "this card is every creature type". It lands here
    // rather than in `KEYWORD_FLAGS` because it is not a `KeywordFlags` boolean:
    // it is a characteristic-defining ability that applies in EVERY zone, which is
    // why core carries it on the definition and answers it inside `hasSubtype`. A
    // continuous-effect flag would be wrong for the Changeling Outcast sitting in
    // a graveyard, which is still a Zombie there.
    //
    // Being a builder also settles the Scryfall keyword sweep for free: the sweep
    // skips any word with a builder, so "Changeling" is not reported a second
    // time after the printed line compiled it.
    changeling: () => ({ changeling: true }),
    // SKULK (CR 702.118a) — "can't be blocked by creatures with greater power".
    // A payload restriction rather than a `KeywordFlags` boolean, because the
    // bound is the ATTACKER'S OWN effective power and is read at declare-blockers
    // time: a skulking creature pumped this turn really is harder to block.
    skulk: () => ({ keywords: { blockRestriction: { blockerPowerAtMostMine: true } } }),
    persist: () => ({
      triggers: [
        {
          condition: { on: 'dies' as const },
          effects: [
            { primitive: 'persistReturn', params: { minusCounters: PERSIST_MINUS_COUNTERS } },
          ],
          label: 'Persist: return with a -1/-1 counter',
        },
      ],
    }),
  });

/**
 * Plain-English explanations for templates we deliberately do NOT implement.
 * These turn "this card didn't compile" into "this card needs X", which is what
 * makes the gap actionable — the import UI shows this text verbatim, and it is
 * the to-do list for the next engine milestone.
 *
 * Order matters: the first matching hint wins, so put specific patterns first.
 */
export const UNSUPPORTED_HINTS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly missingEngineSystem: string;
}> = Object.freeze([
  // --- mana abilities: four shapes SHIPPED, one still engine work -------------
  //
  // Core's mana model now carries a per-ability additional cost, rider,
  // activation restriction and board-derived colours
  // (`CardDefinition.manaAbilities`), and MANA_RULES compiles all four. So the
  // hints below no longer claim those systems are missing — that would send the
  // next contributor to rebuild something that exists. What reaches them is a
  // WORDING the rule table has no entry for yet, inside a shape the engine can
  // already express. The SPEND RESTRICTION has since joined them — the pool
  // carries it now — leaving one cost component the model genuinely has no field
  // for (tapping another permanent), which says so.
  //
  // Order matters: the first matching hint wins, so these sit above the generic
  // mana hint.
  {
    // "{T}: Add {U} or {B}. ~ deals 1 damage to you" compiles. What lands here is
    // a rider with different wording, or one whose "add" half no rule reads.
    pattern: /: add .*\. (?:~|this (?:land|artifact|permanent|creature)) deals \d+ damage to you/,
    missingEngineSystem:
      'a mana-ability RIDER wording the compiler does not recognize yet (riders themselves are implemented — see CardDefinition.manaAbilities)',
  },
  {
    // Subtypes, permanent colours and "N or more <type>" thresholds are read.
    // Anything else ("only during your turn", "only if an opponent lost life")
    // needs a new condition, not a new system.
    pattern: /: add .*\. activate only /,
    missingEngineSystem:
      'an "Activate only if…" CONDITION the compiler cannot read yet (mana-ability restrictions themselves are implemented)',
  },
  {
    // "Pay N life" and a printed mana run (including a hybrid one) are charged.
    // "Tap an untapped creature you control" is a component the cost model has no
    // field for AND a choice of which creature — genuinely missing, not a wording.
    pattern: /^[^:]*,\s*tap an? [^:]*: add /,
    missingEngineSystem:
      'a mana-ability cost that TAPS ANOTHER PERMANENT (the cost model carries life and mana, and choosing which permanent to tap is a question nothing asks)',
  },
  {
    // Any other multi-component cost before ": add".
    pattern: /^[^:]*,[^:]*: add /,
    missingEngineSystem:
      'an ADDITIONAL-COST wording on a mana ability the compiler does not recognize yet (life and mana costs themselves are implemented)',
  },
  {
    // Delighted Halfling and Cavern of Souls print a spend restriction AND make
    // the spell uncounterable. Counterspells are real in this engine, so that
    // second clause is NOT vacuous — it is a live rules effect with no seam, and
    // it must not be silently dropped just because the mana half now compiles.
    pattern: /spend this mana only to .*can'?t be countered/,
    missingEngineSystem:
      'a spell that CANNOT BE COUNTERED (the spend restriction itself is implemented; countering has no "uncounterable" flag yet)',
  },
  {
    // "...of the chosen type" on a card that never NAMES one. Both halves ship —
    // the spend restriction (core's spend-restriction.ts) and the as-entered
    // naming (core's as-enters.ts) — so what lands here is a card whose
    // restriction refers to a choice its own text does not make. Compiling it
    // would print a land whose mana can never be spent, which is as much a lie
    // as one whose mana pays for anything. Order matters: above the generic form.
    pattern: /spend this mana only to .*of the chosen type/,
    missingEngineSystem:
      'a SPEND-RESTRICTION wording the compiler cannot read yet — it names "the chosen type" but the card never chooses one (both restricted mana and the as-entered naming are implemented)',
  },
  {
    pattern: /spend this mana only to/,
    missingEngineSystem:
      'a SPEND-RESTRICTION wording the compiler cannot read yet (restricted mana itself is implemented — the pool carries the restriction)',
  },
  {
    // "…that a land you control could produce" and "…that a land an opponent
    // controls could produce" are read off the live board. What lands here is a
    // derivation from an object this engine does not have.
    //
    // Split in two ON PURPOSE, because the two halves are not the same work and
    // reporting them together hid that: a COMMANDER's colour identity needs a
    // format this engine does not implement and will not fake (completion plan
    // §5 — Command Tower, Arcane Signet), while "any type that land produced"
    // needs a TRIGGERED ABILITY that watches a permanent being tapped for mana
    // and copies what it made (Mirari's Wake, Zendikar Resurgent, Vorinclex,
    // Kinnan, Extraplanar Lens, Incubation Druid). The second is ordinary engine
    // work; the first is a decision.
    pattern: /add one mana of any (?:color|type) in your commander'?s color identity/,
    missingEngineSystem:
      "a mana colour derived from a COMMANDER'S COLOR IDENTITY (this engine has no commander and no format that has one; a fake one would corrupt every verdict touching these cards)",
  },
  {
    pattern:
      /add one mana of any (?:color|type) (?:in|that)|of any type that (?:land|permanent) produced/,
    missingEngineSystem:
      'a mana-DOUBLING trigger that copies what a permanent was just tapped for ("whenever you tap a land for mana, add one mana of any type that land produced" — needs a tapped-for-mana trigger and a remembered production)',
  },
  {
    pattern: /add one mana of any color|add \{[wubrgc]\} or \{[wubrgc]\}|add one mana of any/,
    missingEngineSystem: 'a mana-ability template the compiler does not recognize yet',
  },
  {
    // Plain taplands, fastlands/checklands/slowlands/battlelands
    // (`entersTappedUnless`), shocklands ("you may pay 2 life" →
    // `entersTappedUnlessLifePaid`) AND reveal-lands ("you may reveal an Island
    // or Swamp card from your hand" → `entersTappedUnlessRevealed`) all COMPILE
    // now, so what lands here is only an enters-tapped wording with no rule yet
    // — e.g. a price that is neither life nor a reveal, a condition the board
    // cannot express, or an entry that also does something else.
    pattern: /\benters tapped\b/,
    missingEngineSystem: 'an enters-tapped template the compiler does not recognize yet',
  },
  {
    // EMBLEMS ARE IMPLEMENTED NOW (core's command-zone object + the
    // `emblem-with-ability` rule + the `createEmblem` primitive), so this hint no
    // longer claims the system is missing - that would send the next agent to
    // rebuild something that exists. What lands here is a TEMPLATE: an emblem
    // whose printed ability has no rule of its own.
    //
    // Checked EARLY, above the generic "you may / choose", library-search and
    // scry hints. An emblem's body is arbitrary card text, so it will often
    // contain a word one of those matches first - and being told an emblem line
    // needs "a scry template" names the wrong blocker entirely. The line is an
    // emblem line, and that is what has to be said.
    pattern: /\bemblem\b/,
    missingEngineSystem: 'an emblem template the compiler does not recognize yet',
  },
  {
    // BATTLES ARE IMPLEMENTED NOW (defense counters, the attackable-object seam,
    // damage from combat and from burn, defeat by state-based action). What lands
    // here is a battle TEMPLATE with no rule yet. The reason a real Siege is
    // still reported is different and more specific - its reward is casting the
    // BACK FACE, which the second-castable-face gap names - so this hint must not
    // claim battles are missing, and the Siege reminder line is skipped as
    // vacuous rather than reported at all.
    pattern: /\bdefense counter|\bsiege\b/,
    missingEngineSystem: 'a battle template the compiler does not recognize yet',
  },
  {
    // Modal spells ARE implemented now, as a cast-time system: modes are
    // announced and aimed while the spell is being cast (CR 601.2b/c),
    // `CardDefinition.modal` carries them, and each announced mode resolves
    // against its OWN target. So this hint no longer claims the system is
    // missing — that would send the next agent to rebuild it. What still lands
    // here is a TEMPLATE: a modal header the table does not read (an unusual
    // count phrase), or a modal card one of whose MODES has no implementation,
    // since half a modal spell is not a modal spell.
    pattern: /^choose (?:one|two|three|four|five|up to)\b|^choose one or both\b/,
    missingEngineSystem: 'a modal template the compiler does not recognize yet',
  },
  // --- COPY EFFECTS: the SYSTEM is shipped; what lands here is a residual -----
  //
  // Core applies a copy in LAYER 1 (`CardDefinition.copyAsEnters`, `copy.ts`)
  // and the compiler builds the whole clause including its "except" tail. So
  // none of the three hints below claims copying is missing — that would send
  // the next contributor to rebuild something that exists. Each names the ONE
  // part of a specific card the compiler still cannot read. They sit above the
  // generic "you may / choose" hint, which would otherwise swallow all three.
  {
    // Mockingbird. The selector is a mana-value bound against "the amount of
    // mana spent to cast ~", and nothing records that number: the engine
    // charges a cost and forgets what was spent, so an X-costed copier cannot
    // know its own bound. A different fact, not a different template.
    pattern: /as a copy of .*the amount of mana spent to cast/,
    missingEngineSystem:
      'a copy whose legal targets depend on THE AMOUNT OF MANA SPENT to cast it (copy effects themselves are implemented — nothing records how much mana paid for a spell)',
  },
  {
    // Phantasmal Image and Sakashima the Impostor. Both print an "except … and
    // it has "<ability>" tail that GRANTS an ability to the copy — a
    // triggered ability on "becomes the target of a spell or ability" (an event
    // the engine does not raise for data triggers) and an activated ability
    // with a delayed "at the beginning of the next end step" return. Granting
    // the ability is the missing half, not the copying.
    pattern: /as a copy of .*, except .*\bit has "/,
    missingEngineSystem:
      'a copy that GRANTS AN ABILITY printed in quotes (copy effects and their "except" tail are implemented — an ability granted as text is not)',
  },
  {
    // A DELAYED TRIGGERED ABILITY (CR 603.7) created by a resolving spell or
    // ability: "Sacrifice it at the beginning of the next end step" (Kiki-Jiki,
    // The Fire Crystal, Orthion, Jaxis, Molten Duplication), "Exile those tokens
    // at the beginning of the next end step" (Twinflame). This is the single
    // biggest remaining blocker in the TOKEN-COPY family, and it is NOT the
    // copying: the token copy itself is implemented and plays, so a card that
    // compiled while dropping this clause would be a permanent hasty copy with
    // no drawback — strictly better than printed, which is the one outcome this
    // compiler must never produce.
    //
    // What it needs, precisely: an ability that exists on NO object, created at
    // resolution, which goes on the stack at a named future step and then never
    // again. Every trigger this engine has hangs off a permanent's definition
    // (`triggers.ts` collects them from the battlefield), so there is nowhere
    // for one to live.
    pattern: /\b(?:sacrifice|exile) (?:it|them|those tokens|this token) at the beginning of the (?:next end step|end step)\b/,
    missingEngineSystem:
      'a DELAYED triggered ability created at resolution ("sacrifice it at the beginning of the next end step" — CR 603.7); token copies themselves are implemented, and a copy compiled without this clause would be strictly better than the printed card',
  },
  {
    // What is LEFT of the copy-creating family now that the system is shipped.
    // `copySpell` and `createTokenCopy` are real primitives, so this hint must
    // not say copying is missing — that would send the next contributor to
    // rebuild something that exists. Every card that lands here is blocked on
    // the SELECTOR, or on what kind of object it copies:
    //
    //  - "copy target ACTIVATED OR TRIGGERED ability" (Lithoform Engine, Return
    //    the Favor). An ability on the stack is a `TriggeredStackObject`, which
    //    carries effect refs rather than a card, and nothing can target one:
    //    `TargetRestriction` reaches spells and permanents only.
    //  - "target NONLEGENDARY creature you control" (Kiki-Jiki), "ANOTHER target
    //    creature you control" (Orthion, Jaxis), "target TOKEN you control"
    //    (Caretaker’s Talent), "a card exiled with this artifact" (Mimic Vat) —
    //    selectors outside the closed `TOKEN_COPY_SELECTORS` table, each of
    //    which would need a target restriction of its own.
    //  - "create a TAPPED token that’s a copy of …" (Skyclave Relic, Kambal), and
    //    "tapped and attacking" (Delina, Thousand-Faced Shadow): a token that
    //    arrives already tapped, which no `createToken` path can express.
    //  - "whenever you cast a spell, COPY THAT SPELL" (Reflections of Littjara,
    //    Jin-Gitaxias, Sword of Wealth and Power): the copy is of the spell that
    //    TRIGGERED the ability, and a trigger carries its triggering PLAYER but
    //    not the stack object that set it off.
    //  - a FOLLOW-UP SENTENCE about the object the previous one created — "That
    //    token gains haste" (Helm of the Host), "It gains haste" (Mimic Vat,
    //    Orthion). Deliberately NOT folded into the copy's own keywords, which
    //    would look identical on the board and be wrong one step later: a grant
    //    is layer 6 on THAT object, so it is not among the copiable values a
    //    second copy would take, and "except it has haste" is.
    //  - an "except …" tail on a SPELL copy: "except that the copy is red"
    //    (Fork). `CopyExceptions` is shared with the as-enters copy and models
    //    types, subtypes, keywords, a name and legendary-ness — not colour, and
    //    not a spell's characteristics generally. A token copy's tail is read;
    //    a spell copy is created without one.
    //  - a COUNT that depends on something else: "if this spell was cast from a
    //    graveyard, copy that spell TWICE instead" (Increasing Vengeance). The
    //    count itself is a param on the copy ref; what is missing is a condition
    //    on the zone the spell was cast from.
    pattern: /\bcopy (?:that|target) (?:spell|instant|sorcery|activated)\b|tokens? that(?:'?s| are) (?:a )?cop(?:y|ies)/,
    missingEngineSystem:
      'a COPY-CREATING template outside the compiler’s closed tables (copying a spell on the stack and token copies are BOTH implemented — what is missing is this selector or tail: an activated/triggered ABILITY on the stack, a "nonlegendary"/"another"/"token" target, a token that enters tapped, "copy THAT spell" naming the spell that triggered the ability, a follow-up sentence about the token just created, an "except …" tail on a SPELL copy, or a copy COUNT conditional on where the spell was cast from)',
  },
  {
    // Everything else in the family: a selector or an "except" clause outside
    // the compiler's closed tables (`COPY_SELECTOR_FILTERS`,
    // `parseCopyException`). A rule-table entry, not engine work.
    pattern: /\bas a copy of\b|\bbecomes a copy of\b|\bcopy of (?:target|another target)\b/,
    missingEngineSystem:
      'a COPY template the compiler does not recognize yet (as-enters copies are implemented — this selector or "except" clause is outside the closed tables, or the copy is applied by an activated ability rather than as the permanent enters)',
  },
  {
    // NAMING a value as a permanent enters IS implemented now — the choice, the
    // memory on the instance, and three readers (an anthem, a mana ability and a
    // cast trigger, all narrowed by "of the chosen …"). So a line that mentions
    // the named value and still lands here is a READER with no rule, and calling
    // it "a you may / choose template" would name the wrong blocker entirely:
    // the value IS stored and readable, and what is missing is the printed
    // sentence that consumes it (a cost reduction, a copy effect, an extra
    // trigger instance, a counter formula).
    //
    // Checked BEFORE the generic "you may / choose" hint below, which would
    // otherwise swallow every one of these on the word "chosen".
    pattern: /\bthe chosen (?:type|color|colour|player|number|name)\b/,
    missingEngineSystem:
      'a "the chosen …" READER the compiler does not recognize yet (the named value IS stored on the permanent; this printed line has no rule that reads it)',
  },
  {
    // The printed word "you may" IS implemented now, as the `mayEffects`
    // wrapper: "When ~ enters, you may BODY" and "At the beginning of your
    // <step>, you may BODY" compile to a real yes/no whose no is a complete
    // outcome — and so is "As ~ enters, choose a creature type / a color / a
    // player / a basic land type", which compiles to a naming REMEMBERED on the
    // permanent. So this hint no longer claims either system is missing; that
    // would send the next agent to rebuild something that exists. What still
    // lands here is a TEMPLATE: an optional clause whose BODY has no rule (a
    // blink, a copy, a sacrifice-then-if-you-do chain), a naming this engine
    // could store but no printed line can yet read ("choose a number between 1
    // and 10"), a "choose" that is neither a yes/no nor a naming, or an
    // ADDITIONAL COST offering a CHOICE of payments ("discard a card or pay 3
    // life") — the mandatory single-payment forms compile (see the sacrifice
    // hint below).
    pattern: /\byou may\b|\bchoose\b|\bchooses\b|discards? a card|\bdiscards\b/,
    missingEngineSystem: 'a "you may / choose" template the compiler does not recognize yet',
  },
  {
    // THE TUTOR FAMILY IS CLOSED for every destination the primitive can reach.
    // Searches to HAND, to the BATTLEFIELD (tapped or not) and to the GRAVEYARD
    // compile, filtered by type, a type/subtype UNION ("an instant or sorcery
    // card"), colour, mana value, power or toughness — as do the unrestricted
    // tutor ("for a card"), a printed land-type list of any length (Farseek's
    // four), the "basic X, Y, or Z" form, "up to N" counts, and the
    // MULTI-DESTINATION route ("put one onto the battlefield tapped and the
    // other into your hand").
    //
    // What still lands here is a search whose restriction the shared
    // `CardFilter` cannot say ("a nonlegendary card", "an artifact card with a
    // mana ability", "with mana value X or less" — X is a cast-time value no
    // filter reads), a word outside the closed `SEARCHABLE_SUBTYPES` table, a
    // union mixing a type with a subtype (the filter would AND them, so it could
    // never find), a destination other than hand/battlefield/graveyard ("shuffle
    // and put that card on top"), or a rider on the find ("then if you control
    // four or more lands, untap that land").
    pattern: /\bsearch your library\b|\bsearch their library\b/,
    missingEngineSystem: 'a library-search template the compiler does not recognize yet',
  },
  {
    // Scry N and Surveil N ARE implemented now (the `scry`/`surveil` primitives
    // over core's bottom-of-library placement + the keep-on-top question), and
    // so is the "…, then EFFECT" rider form. What still lands here is a
    // TEMPLATE: a conditional scry ("if you control an artifact, scry 1"), a
    // scry whose count is derived, "look at the top N" wordings with no rule
    // (search-and-reveal shapes), or a surveil rider that needs its own target.
    pattern: /\bscry\b|\bsurveil\b|look at the top/,
    missingEngineSystem: 'a library-look/reorder template the compiler does not recognize yet',
  },
  {
    // Planeswalker loyalty IS a system now: walkers enter with printed loyalty,
    // `[+N]/[−N]` lines compile to loyalty-cost activated abilities, walkers are
    // attackable, and 0 loyalty is death by state-based action. What still lands
    // here is a loyalty-ability BODY with no effect rule of its own.
    pattern: /\bloyalty\b|^[+−-]\d+:/,
    missingEngineSystem: 'a loyalty-ability template the compiler does not recognize yet',
  },
  {
    // Transforming DFCs ARE implemented now (core's second face +
    // `transformPermanent`, the `transformRevealTop` primitive, the
    // `reveal-top-transform` rule), so this hint no longer claims the system is
    // missing — that would send the next agent to rebuild it. What still lands
    // here is a TEMPLATE: a transform instruction with no rule yet ("transform
    // ~" from an activated ability, daybound/nightbound's day-night tracker,
    // Kamigawa flip cards). Modal DFCs report separately: their gap is the
    // cast-time face choice, not the second face itself.
    pattern: /\btransform\b|\bflip\b|double-faced/,
    missingEngineSystem: 'a transform/double-faced template the compiler does not recognize yet',
  },
  // Flash, PLAIN flashback ("Flashback {2}{U}") and GRANTED flashback
  // (Snapcaster Mage's "target instant or sorcery card in your graveyard gains
  // flashback until end of turn") are all real mechanics now — the grant lives
  // in core's `card-grants.ts`, and the cast path reads printed and granted
  // costs through the one `flashbackCostOf` accessor. What still lands here is
  // a flashback the engine cannot PAY — an {X} or additional-cost form
  // ("Flashback—{1}{U}, Discard a card"), which needs the cast-cost-modification
  // system — or a granting template outside the one compiled wording.
  {
    pattern: /\bflashback\b/,
    missingEngineSystem:
      'a flashback template the compiler does not recognize yet (plain "Flashback {cost}" and the Snapcaster-style grant are supported; {X}/additional-cost flashback is not)',
  },
  {
    // Attachment IS implemented now (core's `attachments.ts` + the
    // `enchant-permanent` / `attachment-modification` / `equip-cost` rules), so
    // this hint no longer claims the whole system is missing — that would send the
    // next agent to build something that exists.
    //
    // Nor is the attachment's TRIGGERED half missing any more: "Whenever
    // equipped/enchanted creature deals combat damage to a player, BODY" and
    // "… attacks, BODY" compile, scoped to the host by core's
    // `TriggerCondition.watches` — so a card of that shape reports on its BODY,
    // not on the trigger. Its static half now carries the payload keywords too
    // ("gets +2/+2 and has protection from black and from green", "ward {1}").
    //
    // What still lands here is a template that changes HOW a thing attaches:
    // "Enchant player", a narrowed equip ("Equip legendary creature {3}",
    // "Equip only to a Human", an equip whose cost scales), a second attach
    // ability ("{B}{B}: Attach ~ to target creature you control"), bestow,
    // reconfigure, living weapon, and "whenever ~ becomes unattached".
    pattern: /\bequip\b|\battach\b|\benchant\b/,
    missingEngineSystem: 'an aura/equipment template the compiler does not recognize yet',
  },
  {
    // Four sacrifice shapes compile now: the edict ("target player sacrifices a
    // creature"), "Sacrifice ~" as an ACTIVATION cost, "Sacrifice a land" as a
    // RESOLUTION effect, and the MANDATORY ADDITIONAL CAST COST ("As an
    // additional cost to cast this spell, sacrifice a creature" — a cost that
    // makes the cast illegal when it cannot be paid, CR 601.2h).
    //
    // So what lands here is some OTHER sacrifice shape: "sacrifice another
    // creature" as a cost (nothing asks which OTHER permanent), an additional
    // cost that is a choice between two payments ("sacrifice an artifact or
    // discard a card") or an optional one ("you may sacrifice one or more"),
    // "at the beginning of your upkeep, sacrifice ~", a sacrifice whose noun is
    // outside the closed cost table, or a value derived from what was
    // sacrificed (Fling's "damage equal to the sacrificed creature's power").
    pattern: /\bsacrifice\b/,
    missingEngineSystem: 'a sacrifice template the compiler does not recognize yet',
  },
  {
    // COUNTERS ARE NOT A MISSING SYSTEM. `CardInstance.counters` exists, the
    // stat pipeline reads +1/+1 and -1/-1 at CR 613.3 layer 7d, `addCounters`
    // puts them on one creature or on a whole filtered group, a static can read
    // "with a +1/+1 counter on it", and the trigger vocabulary now covers ETB,
    // attacks, `permanentEnters`/`permanentDies` (with a controller scope, a
    // `CardFilter` and the printed word "another"), life gain, a DRAW
    // ("whenever a player draws a card"), combat damage to a player,
    // begin-combat, and the step-beginning triggers in every printed scope with
    // their intervening "if". What lands here
    // is a counters TEMPLATE with no rule — and, named so nobody re-builds
    // finished work: phasing, DOUBLING counters, proliferate
    // (needs a chooser over every permanent and player with a counter), counter
    // kinds the stat layer does not read (charge/quest/time/growth/keyword
    // counters), "each ATTACKING creature", once-per-turn trigger limiters,
    // granting a triggered ability until end of turn, and removing a counter as
    // an activation cost (`ActivationCost` has no counter component).
    //
    // "NONTOKEN" left this list: token-ness is a real characteristic now
    // (`CardDefinition.isToken`, read by `CardFilter.isToken`), and the printed
    // words "token" / "nontoken" compile on the enters/dies trigger. What is
    // still missing is a nontoken filter on templates that carry no `CardFilter`
    // at all, `destroyAll` chief among them ("Destroy all nontoken creatures").
    pattern: /\bcounters? on\b|\b\+1\/\+1 counter/,
    missingEngineSystem: 'a counters template the compiler does not recognize yet',
  },
  {
    // TARGETING a card in a graveyard is a real system now
    // ('instantOrSorceryInYourGraveyard' in core's targeting.ts), as is a
    // continuous grant ON such a card (`card-grants.ts`), and regrowth ("return
    // target [TYPE] card from your graveyard to your hand") already compiled.
    // What still lands here is a graveyard TEMPLATE with no rule: exiling a
    // card from a graveyard, "for each card in your graveyard", delve,
    // threshold, and the reanimation shapes that put a card from a graveyard
    // onto the battlefield.
    pattern: /\bexiles?\b.*\bgraveyard\b|\bgraveyard\b/,
    missingEngineSystem: 'a graveyard template the compiler does not recognize yet',
  },
  {
    // Plain "target player mills N" and "you mill N" COMPILE now. What still
    // lands here is a mill whose count is derived or conditional, so the hint
    // names the template gap rather than claiming milling is missing entirely.
    pattern: /\bmill\b|puts? the top .* into (?:their|his or her) graveyard/,
    missingEngineSystem: 'a mill template the compiler does not recognize yet',
  },
  {
    // Block RESTRICTIONS are engine-enforced now, in the two places each is
    // expressible: per pair in `canBlock` ("can't be blocked", "~ can't block")
    // and per DECLARATION in `illegalBlockDeclaration` (menace and the general
    // "except by N or more creatures"). Granting evasion for a turn compiles
    // through the ordinary continuous grant.
    //
    // Block REQUIREMENTS are engine-enforced now too, so this hint no longer
    // claims they are missing: "~ must be blocked if able" and "all creatures
    // able to block ~ do so" are keyword flags resolved against the WHOLE
    // declaration by `internal/block-solver.ts`, which does what CR 509.1c/d
    // actually says — satisfy the maximum possible number of requirements without
    // violating any restriction. So are the comparing restrictions:
    // `KeywordFlags.blockRestriction` carries "except by creatures with haste", a
    // power or toughness bound, and skulk's comparison against the attacker's own
    // power, each judged against EFFECTIVE stats.
    //
    // What still lands here is a SELECTOR none of that can express, and the hint
    // names the three shapes rather than a missing system:
    //   - a static whose filter would have to read EFFECTIVE power or toughness
    //     (Tetsuko's "creatures you control with power or toughness 1 or less",
    //     Delney) — `statics.ts` matches PRINTED characteristics by design, which
    //     is what keeps the continuous pass single-pass with no CR 613.8 loop;
    //   - a comparison against ANOTHER permanent's power (Champion of Lambholt's
    //     "power less than ~'s power"), which needs the restriction's threshold
    //     recomputed from its source at declare-blockers time;
    //   - a per-combat TARGETED requirement ("target creature blocks it this
    //     combat if able" — Fighter Class), which is combat state rather than a
    //     characteristic, and a COST to block (Archangel of Tithes).
    pattern: /\bmust be blocked\b|\bable to block\b|\bblocks? it\b|\bcan't be blocked\b|\bcan't block\b|\bmenace\b|\bskulk\b/,
    missingEngineSystem:
      'a block restriction whose SELECTOR compares creatures or reads effective P/T (the CR 509.1c/d requirement solver itself is built)',
  },
  {
    // Plain `Ward {N}` and `Protection from [color/artifacts/creatures/...]`
    // COMPILE now (source-aware targeting: all four protection halves plus the
    // ward pay-or-counter trigger are engine-enforced), and so does the GRANTED
    // form on an attachment — "Equipped creature gets +2/+2 and has protection
    // from black and from green", "gets +1/+0 and has haste and ward {1}" —
    // which reads the same closed tables through `parseProtectionOrWard`.
    // What still lands here is a TEMPLATE outside those tables: a ward cost
    // that is not plain generic mana ("Ward—Pay 3 life", "Ward {X}"), a
    // protection quality with no engine meaning ("protection from Demons",
    // "from instants and from sorceries" — Sword of Wealth and Power), or
    // "hexproof from <quality>", which is protection's shape with only the
    // targeting half.
    pattern: /\bward\b|\bprotection from\b/,
    missingEngineSystem: 'a ward/protection template the compiler does not recognize yet',
  },
  {
    // Turn-scoped fact memory EXISTS now (core's `turn-facts.ts`: revolt,
    // morbid and the lifegain check, fed from the event stream and cleared as
    // each turn begins), and Fatal Push's revolt mode plays as printed. What
    // still lands here is an ability word whose LINE has no rule — a morbid or
    // delirium body the effect table cannot build, or a fact outside the closed
    // vocabulary ("if you've cast two spells this turn").
    pattern: /\brevolt\b|\bmorbid\b|\bdelirium\b|\bthreshold\b|\bmetalcraft\b/,
    missingEngineSystem: 'an ability-word template the compiler does not recognize yet',
  },
  {
    // Multikicker IS implemented now (`CardDefinition.multikicker` + the
    // cast-time COUNT question, charged once, with "for each time it was
    // kicked" reading it through the derived-value channel). What still lands
    // here is a TEMPLATE: a multikicker cost the symbol parser refuses ({X},
    // Phyrexian), or a kicked-count clause with no rule yet.
    pattern: /\bmultikicker\b/,
    missingEngineSystem: 'a multikicker template the compiler does not recognize yet',
  },
  {
    // Kicker ITSELF is implemented now (`CardDefinition.kicker` + the cast-time
    // payMana question + the `ifKicked` branch primitive), so this hint no
    // longer claims the system is missing — that would send the next agent to
    // rebuild it. What still lands here is a TEMPLATE: a kicked clause the
    // effect table cannot compile (a kicked ETB on a permanent, a rider that
    // chooses its own target, "kicked with {COST1} and/or {COST2}").
    pattern: /\bkicker\b|\bkicked\b/,
    missingEngineSystem: 'a kicker template the compiler does not recognize yet',
  },
  {
    // Cycling, buyback and madness are all REAL MECHANICS now — cycling is an
    // activated ability from HAND (`CardDefinition.cycling` + the `cycleCard`
    // action, with typecycling/landcycling the same mechanism searching instead
    // of drawing), buyback is a cast-time payMana whose answer decides where the
    // card goes (`spellLeaveDestination`), and madness replaces the discard and
    // opens a cast-from-exile window. What still lands here is a FORM none of
    // the three can pay or express: an {X} in a cycling cost (Shark Typhoon), a
    // madness cost printed in words ("Madness—Pay six {C}"), a cycling word
    // naming something `CardFilter` cannot select, or a "when you cycle this
    // card" body the effect table cannot build.
    pattern: /\bcycling\b|\bbuyback\b|\bmadness\b/,
    missingEngineSystem:
      'a cycling/buyback/madness template the compiler does not recognize yet (the plain mana-cost forms are supported; an {X} cycling cost, a madness cost printed in words, and a cycling word with no expressible filter are not)',
  },
  {
    // Characteristic-defining P/T IS a system now (CR 613.3 layer 7a: a `*` box
    // compiles to a formula over the closed derived-count vocabulary, applied
    // as the creature's BASE before counters and pumps, re-derived on every
    // read — Tarmogoyf plays as printed). What still lands here is a FORMULA
    // outside that vocabulary, or a P/T that changes by some other rule.
    pattern: /power is equal to|toughness is equal to|power and toughness are each equal/,
    missingEngineSystem: 'a characteristic-defining P/T formula the compiler does not recognize yet',
  },
  {
    // {X} costs ARE payable now (a cast-time chooseNumber the engine charges),
    // and "equal to …" has the derived-value rules. What still lands here is a
    // template: an X divided among targets, an X defined by a "where X is …"
    // clause, an {X} in an activation cost.
    pattern: /\{x\}|\bx damage\b|\bequal to\b/,
    missingEngineSystem: 'an {X} or derived-value template the compiler does not recognize yet',
  },
  { pattern: /\bactivated abilit|\{t\}:|\{\d+\}[,:]/, missingEngineSystem: 'an activated-ability template the compiler does not recognize yet' },
  // --- replacement & prevention: the LAYER SHIPPED, so these name the residual ---
  //
  // Core now has a real CR 614/615 layer (`packages/core/src/replacement.ts`) that
  // damage, counters and draws all consult, and STATIC_RULES compiles the four
  // families that change a QUANTITY or prevent an event. So these hints do not
  // claim the system is missing — that would send the next contributor to rebuild
  // something that exists. What they name is the residual: a replacement whose
  // OUTCOME is a different kind of thing (a different zone, different objects, a
  // whole substituted action), which is genuinely a different vocabulary.
  //
  // Order matters: the first matching hint wins, so these sit above the generic
  // ones below.
  {
    // "…twice that many of those TOKENS are created instead" (Doubling Season,
    // Parallel Lives, Anointed Procession). The layer scales a NUMBER; creating
    // extra objects is a different outcome, and token creation is not one of the
    // three events the layer watches.
    pattern: /would (?:create|be created).*\binstead\b|creates? (?:twice|three times) that many/,
    missingEngineSystem:
      'a TOKEN-count replacement (the CR 614 layer scales damage, counters and draws; creating extra objects is a different outcome)',
  },
  {
    // "If a card would be put into a graveyard from anywhere, exile it instead"
    // (Rest in Peace, Dauthi Voidwalker, Liesa) — a ZONE-CHANGE replacement.
    pattern: /would (?:die|be put into (?:a|an|its owner's|an opponent's) graveyard).*\binstead\b/,
    missingEngineSystem:
      'a ZONE-CHANGE replacement ("if it would die, exile it instead" — the CR 614 layer changes quantities, not destinations)',
  },
  {
    // "prevent that damage AND …" (Vigor, The Mindskinner, Deflecting Palm) — the
    // prevention itself is implemented; what is missing is a RIDER that fires on
    // how much was prevented.
    pattern: /prevent (?:that|the next|all) [^.]*\b(?:and|\.)\s*(?:put|~|each|you|that)/,
    missingEngineSystem:
      'a prevention RIDER ("prevent that damage AND put a +1/+1 counter on it for each 1 prevented") — prevention itself is implemented',
  },
  {
    // "The next time a SOURCE OF YOUR CHOICE would deal damage…" (Deflecting
    // Palm) — a shield bound to a source the player names, which nothing asks.
    pattern: /a source of your choice/,
    missingEngineSystem:
      'a prevention shield bound to a SOURCE OF YOUR CHOICE (choosing a source is a question nothing asks)',
  },
  {
    // "If you would GAIN LIFE, you gain twice that much instead" (Alhammarret's
    // Archive, Rhox Faithmender) and "if an opponent would LOSE LIFE…"
    // (Bloodletter of Aclazotz). One more event kind on the same layer, not a
    // new system — named honestly so whoever adds it knows the size of the job.
    pattern: /if (?:you|an opponent|a player) would (?:gain|lose) life/,
    missingEngineSystem:
      'a LIFE-CHANGE event on the replacement layer (the layer watches damage, counters and draws; life gain/loss is one more event kind)',
  },
  {
    // "instead that player skips that draw and you draw a card" (Notion Thief),
    // "you may instead choose land or nonland and reveal…" (Abundance). The draw
    // event is watched; substituting a whole different ACTION for it is not.
    pattern: /would draw a card.*\binstead\b/,
    missingEngineSystem:
      'a draw replacement whose result is a different ACTION (skip-and-redirect, reveal-until — the layer scales a draw, it does not substitute one)',
  },
  // --- below here: patterns that only refine the DEFAULT explanation. Nothing
  // above changes; these exist so "this card didn't compile" names a buildable
  // engine feature instead of shrugging. They are ordered specific → general,
  // and each one was written because a batch of real cards landed on it (see
  // `../../data/expansion-report.json`).
  {
    pattern: /\bcascade\b|\bevoke\b|\bsuspend\b|\bbattle cry\b|\binvestigate\b|fateful hour/,
    missingEngineSystem: 'named keyword mechanics with their own subsystem',
  },
  {
    pattern: /damage to each (?:creature|player|opponent)|to each of|damage to you\b/,
    missingEngineSystem: 'a group-damage template the compiler does not recognize yet',
  },
  // NOTE: there is deliberately no "bounce" hint any more. Plain bounce compiles
  // (see the `return-target-permanent-to-hand` rule), so a bounce clause that
  // still fails does so for some OTHER reason — most often that it sits inside a
  // trigger, and a triggered ability cannot choose targets. Letting it fall
  // through to that hint names the real blocker instead of a solved one.
  {
    pattern: /gain control of target/,
    missingEngineSystem: 'a gain-control template the compiler does not recognize yet',
  },
  { pattern: /\bfights?\b/, missingEngineSystem: 'a fight template the compiler does not recognize yet' },
  {
    // `TargetRestriction` CAN now say "a player who isn't you" ('opponent'), so
    // what still lands here is an opponent-targeting template with no rule yet —
    // not a missing engine capability.
    pattern: /\btarget opponent\b/,
    missingEngineSystem: 'an opponent-targeting template the compiler does not recognize yet',
  },
  {
    // Optional payment during resolution IS implemented now (core's `payMana`
    // choice kind + the `counterUnlessPaid` primitive), so this hint no longer
    // claims the system is missing — that would send the next agent to rebuild
    // it. What still lands here is a TEMPLATE: a payment attached to some other
    // effect ("destroy … unless its controller pays"), a cost derived from the
    // board (Rune Snag), a sacrifice or discard offered instead of mana, or {X}.
    pattern: /unless (?:its controller|that player|you) pays?/,
    missingEngineSystem: 'an optional-payment template the compiler does not recognize yet',
  },
  {
    pattern: /leaves the battlefield/,
    missingEngineSystem: 'a leaves-the-battlefield template the compiler does not recognize yet',
  },
  {
    // Anthems compile, and they can now be narrowed by COLOUR ("White creatures
    // you control get +1/+1") because the shared `CardFilter` carries
    // `anyOfColors`, read from cost pips by the same reader protection uses.
    // What still lands here is a static whose SELECTOR is outside the filter
    // (by power, by tapped-ness, "as long as you control…") or one that is not
    // a plain P/T-and-keyword modification.
    pattern: /(?:other )?creatures you control (?:get|have)|as long as you control|creatures? you control gets?/,
    missingEngineSystem: 'a static-buff template the compiler does not recognize yet',
  },
  {
    // "Destroy target artifact or creature", "Counter target creature spell",
    // "Destroy target nonlegendary creature" — the effect exists, the FILTER on
    // what may be chosen does not.
    pattern: /^(?:destroy|exile|counter) target \S/,
    missingEngineSystem: 'a filtered-targeting template the compiler does not recognize yet',
  },
  {
    // A trigger body that names a target COMPILES now — core aims a triggered
    // ability as it goes on the stack (`TriggeredAbility.targets`). So this hint
    // no longer claims the system is missing, which would send the next agent to
    // rebuild it. What still lands here is a body whose own template is
    // unrecognised (a filtered target, two separate targets, a targeted mechanic
    // with no rule of its own) — reported by the BODY's shape, not by the fact
    // that it sits inside a trigger.
    pattern: /^(?:when|whenever)\b.*\btarget\b/,
    missingEngineSystem: 'a targeted-trigger template the compiler does not recognize yet',
  },
  {
    pattern: /\bdraws? (?:a|two|three|\d+) cards? and (?:you )?loses? \d+ life/,
    missingEngineSystem: 'a compound draw/lose template the compiler does not recognize yet',
  },
  {
    // THE STEP-BEGINNING TRIGGER IS NOT A MISSING SYSTEM, and this hint says so
    // because the previous wording sent readers to build one that exists.
    //
    // What ships: every printed scope — "your", "each player's", "each
    // opponent's" and the bare "each" — over upkeep, draw step, first main
    // phase, end step and combat; the optional "you may" form; the printed
    // intervening "if" (CR 603.4, checked BOTH when the ability would trigger
    // and again as it resolves); and the TRIGGERING PLAYER, which rides the
    // stack object into the resolution so a body can say "that player".
    //
    // What lands here is therefore a BODY with no rule — not a trigger the
    // engine cannot express. Named so nobody re-builds finished work, the bodies
    // still missing in the corpus are: "you win/lose the game", blink (exile
    // then return), token COPIES of a permanent, the city's blessing/ascend,
    // amass, discover, the Ring, a delayed "at the beginning of your NEXT
    // upkeep", and any count derived from a revealed card's mana value.
    pattern: /^at the beginning of /,
    missingEngineSystem:
      'an "at the beginning of…" trigger BODY the compiler does not recognize yet (the trigger itself — every printed scope, the "you may" form, the intervening "if", and the triggering player a body points at — is implemented)',
  },
]);

/** Find the best explanation for an unimplementable clause. */
export function explainUnsupported(clause: string): string {
  for (const hint of UNSUPPORTED_HINTS) {
    if (hint.pattern.test(clause)) return hint.missingEngineSystem;
  }
  return 'a rules template the compiler does not recognize yet';
}
