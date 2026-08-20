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
  CardType,
  EffectRef,
  KeywordFlags,
  ManaActivationCondition,
  ManaColor,
  ManaCost,
  ManaProduction,
  ProtectionQuality,
  SpellMode,
  StaticAbility,
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
const STATIC_NOUN_TYPES: Readonly<Record<string, CardType | null>> = Object.freeze({
  creature: 'creature',
  permanent: null,
  artifact: 'artifact',
  enchantment: 'enchantment',
  land: 'land',
});

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
 * the compiler emits (`matchesCardFilter` → `hasSubtype`).
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
  // Creature types named by the tutors in the most-played corpus.
  'goblin',
  'dragon',
  'demon',
]);

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
 * subtype. The three bound arguments are the optional "with X N [or less |
 * or greater]" tail; **no** direction word means an EXACT value (Tribute Mage's
 * "with mana value 2"), which is both bounds set to the same number.
 */
function searchFilterFrom(
  noun: string,
  characteristic?: string,
  amount?: string,
  direction?: string,
): Record<string, unknown> | null {
  const filter: Record<string, unknown> = {};
  const type = SPELL_TYPE_WORDS[noun];
  if (type) {
    filter.anyOfTypes = [type];
  } else if (SEARCHABLE_SUBTYPES.has(noun)) {
    filter.anyOfSubtypes = [noun];
  } else {
    return null; // not a restriction this filter can express — report the line
  }

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

/** The regex alternation of the discard restrictions above. */
const DISCARD_RESTRICTION_TOKEN = Object.keys(DISCARD_RESTRICTIONS).join('|');

/** The filter implementing a printed discard restriction, or null if unexpressible. */
function discardFilterFor(word: string): (typeof DISCARD_RESTRICTIONS)[string] | null {
  return DISCARD_RESTRICTIONS[word.trim().toLowerCase()] ?? null;
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
    id: 'create-creature-token',
    description: '"Create N X/Y [color] [subtype] creature token(s) [with KEYWORD]"',
    pattern: new RegExp(
      `^create ${COUNT_TOKEN} (\\d+)\\/(\\d+) ([a-z ]*?)creature tokens?(?: with ${KEYWORD_TOKEN})?$`,
    ),
    build(match) {
      const count = parseCount(match[1]);
      const power = Number.parseInt(match[2] ?? '', 10);
      const toughness = Number.parseInt(match[3] ?? '', 10);
      if (count === null || !Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      // The descriptor is "<colors> <subtypes> " — the last word is the creature
      // type that names the token (e.g. "red elemental" → "Elemental").
      const descriptor = (match[4] ?? '').trim();
      const words = descriptor.split(' ').filter((w) => w.length > 0);
      const typeWord = words[words.length - 1] ?? 'token';
      const name = typeWord.charAt(0).toUpperCase() + typeWord.slice(1);
      // `count` is omitted when it is the primitive's default of one, keeping the
      // emitted data minimal and identical to the hand-authored pool's style.
      const params: Record<string, unknown> = { power, toughness, name };
      if (count !== TOKEN_DEFAULT_COUNT) params.count = count;
      if (match[5]) {
        const keywords = keywordFlag(match[5]);
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
    pattern:
      /^search your library for an? ([a-z]+)(?: or ([a-z]+))? card, put it onto the battlefield( tapped)?(?:, then shuffle)?$/,
    build(match) {
      const subtypes = [match[1], match[2]].filter((s): s is string => Boolean(s));
      // Only LAND subtypes are safe here: a non-land search would need the card
      // to be castable, which this template does not express.
      if (!subtypes.every((subtype) => LAND_SUBTYPES.has(subtype))) return null;
      return effects({
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          filter: { anyOfTypes: ['land'], anyOfSubtypes: subtypes },
          destination: 'battlefield',
          ...(match[3] ? { tapped: true } : {}),
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
    pattern: new RegExp(
      `^search your library for an? ([a-z]+) card(?: with ${SEARCH_BOUND_PHRASE} (\\d+)(?: or (less|greater))?)?, reveal (?:it|that card), put (?:it|that card) into your hand, then shuffle$`,
    ),
    build(match) {
      const filter = searchFilterFrom(match[1] ?? '', match[2], match[3], match[4]);
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
        `(?:(~ or another) creature|(another )?(?:an? )?((?:${Object.keys(COLOR_WORDS).join('|')}) )?([a-z]+)` +
        `( you control| an opponent controls| your opponents control)?)` +
        `(?: with ${SEARCH_BOUND_PHRASE} (\\d+) or (less|greater))? (enters|dies), (.+)$`,
    ),
    build(match, ctx) {
      // "~ or another creature dies" (Cordial Vampire) says EVERY creature's
      // death, this permanent's own included — so no scope and no self-exclusion.
      const selfOrAnother = match[1] !== undefined;
      const noun = selfOrAnother ? 'creature' : (match[4] ?? '');
      const filter = searchFilterFrom(noun, match[6], match[7], match[8]);
      if (filter === null) return null;
      const colorWord = match[3]?.trim();
      if (colorWord !== undefined) {
        const color = COLOR_WORDS[colorWord];
        if (color === undefined) return null;
        filter.anyOfColors = [color];
      }
      const tail = (match[5] ?? '').trim();
      const who = selfOrAnother || tail === '' ? 'any' : tail === 'you control' ? 'you' : 'opponent';
      const another = !selfOrAnother && (match[2] ?? '').trim() === 'another';
      const event = match[9] === 'enters' ? 'permanentEnters' : 'permanentDies';
      const body = match[10] ?? '';
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
            label: `${another ? 'another ' : ''}${noun} (${who}) ${match[9]}: ${body}`,
            ...(compiled.targets ? { targets: compiled.targets } : {}),
          },
        ],
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
    id: 'static-buff-your-creatures',
    description:
      '"[Other] creatures you control get +X/+Y [and have KEYWORD]" / "…have KEYWORD" (Glorious Anthem, Fervor) — a continuous static, core\'s anthem layer',
    pattern: new RegExp(
      `^(other )?((?:${Object.keys(COLOR_WORDS).join('|')}) )?(${Object.keys(STATIC_NOUN_TYPES).join('|')})s you control (?:get ([+-]\\d+)\\/([+-]\\d+)(?: and (?:have|gain) (.+))?|(?:have|gain) (.+))$`,
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
      const power = match[4] === undefined ? 0 : Number.parseInt(match[4], 10);
      const toughness = match[5] === undefined ? 0 : Number.parseInt(match[5], 10);
      if (!Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      // The printed NOUN decides the filter's type. "Permanent" maps to no type
      // entry at all, because an absent filter already matches every permanent -
      // inventing a 'permanent' type word would match nothing.
      const nounType = STATIC_NOUN_TYPES[match[3] ?? ''];
      if (nounType === undefined) return null;
      // "WHITE creatures you control get +1/+1" — the printed colour narrows the
      // filter, which core's shared `CardFilter` can express now
      // (`anyOfColors`, derived from cost pips exactly as protection reads
      // colour). A colour word outside the table rejects the whole line.
      const colorWord = match[2]?.trim();
      const color = colorWord === undefined ? undefined : COLOR_WORDS[colorWord];
      if (colorWord !== undefined && color === undefined) return null;
      const keywordText = match[6] ?? match[7];
      const keywords = keywordText === undefined ? undefined : parseKeywordList(keywordText);
      // A keyword the engine does not model reports the whole line, never a
      // half-granted anthem.
      if (keywordText !== undefined && keywords === null) return null;
      const ability: StaticAbility = {
        affects: {
          ...(nounType === null ? {} : { anyOfTypes: [nounType] }),
          controller: 'you',
          ...(color ? { anyOfColors: [color as never] } : {}),
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
function parseKeywordList(text: string): Record<string, boolean> | null {
  const words = text
    .split(/,| and /)
    .map((word) => word.trim().replace(LEADING_GRANT_VERB, ''))
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  const flags: Record<string, boolean> = {};
  for (const word of words) {
    const field = KEYWORD_FLAGS[word] ?? KEYWORD_PHRASES[word];
    if (!field) return null;
    flags[field] = true;
  }
  return flags;
}

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
  // NOTE: there is still deliberately NO rule for a mana ability whose colours
  // come from somewhere the engine cannot read — "add one mana of any color in
  // your commander's color identity" (no commander here, and never will be, see
  // the completion plan §5) or "of any type that land produced". Nor is there one
  // for a SPEND RESTRICTION ("spend this mana only to cast creature spells"),
  // which needs the mana POOL to carry the restriction, not the source. Those
  // fall through to `missing` (see UNSUPPORTED_HINTS).
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
  // already express, with two exceptions that are still genuinely engine work and
  // say so: the SPEND RESTRICTION (the pool would have to carry it) and a cost
  // component the model has no field for (tapping another permanent).
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
    // Cavern of Souls, Delighted Halfling, Somberwald Sage. STILL A SYSTEM: the
    // restriction belongs to the MANA, not to the source, so the pool would have
    // to carry it and every payment path would have to honour it. Nothing about
    // `manaAbilities` helps — a restricted mana is indistinguishable from an
    // unrestricted one the moment it lands in the pool.
    pattern: /spend this mana only to/,
    missingEngineSystem:
      'a SPEND RESTRICTION on produced mana (the mana pool records colour, not what each mana may pay for)',
  },
  {
    // "…that a land you control could produce" and "…that a land an opponent
    // controls could produce" are read off the live board. What lands here is a
    // derivation from something this engine does not have at all — a COMMANDER's
    // colour identity (§5 of the completion plan rules those out for good), or a
    // remembered "that land".
    pattern:
      /add one mana of any (?:color|type) (?:in|that)|of any type that (?:land|permanent) produced/,
    missingEngineSystem:
      'a mana colour derived from an object this engine has no concept of (a commander, or a remembered permanent)',
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
  {
    // The printed word "you may" IS implemented now, as the `mayEffects`
    // wrapper: "When ~ enters, you may BODY" and "At the beginning of your
    // <step>, you may BODY" compile to a real yes/no whose no is a complete
    // outcome. So this hint no longer claims the system is missing — that would
    // send the next agent to rebuild it. What still lands here is a TEMPLATE:
    // an optional clause whose BODY has no rule (a blink, a copy, a
    // sacrifice-then-if-you-do chain), or a "choose" that is not a yes/no.
    pattern: /\byou may\b|\bchoose\b|\bchooses\b|discards? a card|\bdiscards\b/,
    missingEngineSystem: 'a "you may / choose" template the compiler does not recognize yet',
  },
  {
    // Searches to the BATTLEFIELD (basic lands, fetchland subtypes) and to HAND
    // filtered by type, subtype, mana value, power or toughness all compile.
    // What still lands here is a search whose restriction the shared
    // `CardFilter` cannot say ("a card with the same mana value as this", "an
    // artifact card with a mana ability"), a subtype outside the closed
    // `SEARCHABLE_SUBTYPES` table, or a destination other than hand/battlefield.
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
    // next agent to build something that exists. What still lands here is a
    // template: "Enchant player", "Equip only to a Human", bestow, reconfigure,
    // and anything that moves an attachment other than a plain Equip.
    pattern: /\bequip\b|\battach\b|\benchant\b/,
    missingEngineSystem: 'an aura/equipment template the compiler does not recognize yet',
  },
  {
    // "Target player sacrifices a creature" (the edict shape) and "sacrifice ~"
    // as an activation cost both compile now, so what lands here is some OTHER
    // sacrifice shape: a sacrifice as an additional cast cost, "sacrifice
    // another creature", "at the beginning of your upkeep, sacrifice ~", …
    pattern: /\bsacrifice\b/,
    missingEngineSystem: 'a sacrifice template the compiler does not recognize yet',
  },
  {
    // COUNTERS ARE NOT A MISSING SYSTEM. `CardInstance.counters` exists, the
    // stat pipeline reads +1/+1 and -1/-1 at CR 613.3 layer 7d, `addCounters`
    // puts them on one creature or on a whole filtered group, a static can read
    // "with a +1/+1 counter on it", and the trigger vocabulary now covers ETB,
    // attacks, `permanentEnters`/`permanentDies` (with a controller scope, a
    // `CardFilter` and the printed word "another"), life gain, combat damage to
    // a player, begin-combat and the step-beginning triggers. What lands here
    // is a counters TEMPLATE with no rule — and, named so nobody re-builds
    // finished work: phasing, DOUBLING counters, proliferate
    // (needs a chooser over every permanent and player with a counter), counter
    // kinds the stat layer does not read (charge/quest/time/growth/keyword
    // counters), "each ATTACKING creature", "NONTOKEN" filters (instances carry
    // no token flag), once-per-turn trigger limiters, granting a triggered
    // ability until end of turn, and removing a counter as an activation cost
    // (`ActivationCost` has no counter component).
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
    // What still lands here is two different things, and the hint says which:
    //   - a block REQUIREMENT ("must be blocked if able", "all creatures able to
    //     block ~ do so"). CR 509.1c/d resolves requirements and restrictions
    //     TOGETHER — maximise satisfied requirements without violating any
    //     restriction — which is a solver, not a check, and is not built;
    //   - a restriction whose SELECTOR the engine cannot express: a power or
    //     toughness comparison between the two creatures ("can't be blocked by
    //     creatures with power 3 or greater", skulk), or a filtered set the
    //     static layer deliberately cannot read (Tetsuko's "with power or
    //     toughness 1 or less" — see `statics.ts` on printed characteristics).
    pattern: /\bmust be blocked\b|\bable to block\b|\bblocks? it\b|\bcan't be blocked\b|\bcan't block\b|\bmenace\b|\bskulk\b/,
    missingEngineSystem:
      'a block REQUIREMENT, or a block restriction whose selector compares creatures',
  },
  {
    // Plain `Ward {N}` and `Protection from [color/artifacts/creatures/...]`
    // COMPILE now (source-aware targeting: all four protection halves plus the
    // ward pay-or-counter trigger are engine-enforced). What still lands here
    // is a TEMPLATE outside the closed tables: a ward cost that is not plain
    // generic mana ("Ward-Pay 3 life", "Ward {X}"), or a protection quality
    // with no engine meaning ("protection from Demons", "from instants").
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
]);

/** Find the best explanation for an unimplementable clause. */
export function explainUnsupported(clause: string): string {
  for (const hint of UNSUPPORTED_HINTS) {
    if (hint.pattern.test(clause)) return hint.missingEngineSystem;
  }
  return 'a rules template the compiler does not recognize yet';
}
