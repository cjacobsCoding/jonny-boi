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
  LandCondition,
  CardFilter,
  CardType,
  ChosenValueSubject,
  CopyAsEntersSpec,
  CopyExceptions,
  DerivedCountScope,
  PermanentStateFilter,
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
  ReplacementOutcome,
  SourcePowerBlockBound,
  SpellMode,
  StaticAbility,
  StaticAffects,
  StaticControllerScope,
  TargetRestriction,
  // §3.150 - the printed bound on a target selector.
  TargetBound,
  TargetNumericProperty,
  InterveningIf,
  TriggerCondition,
  TriggeredAbility,
  TriggerEvent,
  TriggerWho,
} from '@jonny-boi/core';
import {
  DEFAULT_TARGET_RESTRICTION,
  DEFAULT_TRIGGER_WATCHES,
  PLUS_ONE_COUNTER,
  PROTECTION_SUBTYPE_PREFIX,
  formatManaCost,
  MANA_COLORS,
  // §3.150 - read and narrow the reserved target param through core's own
  // name and validator, never a second spelling of either.
  TARGET_RESTRICTION_PARAM,
  isTargetRestriction,
} from '@jonny-boi/core';
import type { ClauseContribution, CompileRule, RuleContext } from './types.js';
import {
  ABILITY_WORD_LIST,
  AMOUNT_TOKEN,
  COUNT_TOKEN,
  normalizeClause,
  parseCount,
  parseManaSymbols,
  parseSignedInt,
  prepareOracle,
  selfReference,
  splitCostSymbols,
  stripReminderText,
} from './text.js';
import { BASIC_LAND_NAMES } from '../../data/pool.js';
import { ITS_MANA_COST } from '../primitives.js';
// The one name for the filtered-count row, imported rather than re-spelled, so
// the compiler and the reader cannot disagree about what it is called (§3.149).
import { PERMANENTS_MATCHING } from '../effect-helpers.js';

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
  // §3.148 — "When ~ enters, it deals 2 damage to target creature AN OPPONENT
  // CONTROLS" (Oath of Chandra and kin). Its own row, not a flavour of
  // 'creature': a burn trigger that may be pointed at your own board is a
  // strictly worse play offered as though it were legal.
  'target creature an opponent controls': 'creatureAnOpponentControls',
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
/** §3.112 — "target ATTACKING creature", every bloodrush line's aim. */
const ATTACKING_CREATURE_TARGET: TargetRestriction = 'attackingCreature';
/** "target creature you control" — never widened to any creature on the table. */
const CREATURE_YOU_CONTROL_TARGET: TargetRestriction = 'creatureYouControl';
/** "target non-Angel creature you control" — Restoration Angel; see the type's note. */
const NON_ANGEL_CREATURE_YOU_CONTROL_TARGET: TargetRestriction = 'nonAngelCreatureYouControl';
/** "target triggered ability you control" — Strionic Resonator. */
const TRIGGERED_ABILITY_YOU_CONTROL_TARGET: TargetRestriction = 'triggeredAbilityYouControl';
const ACTIVATED_OR_TRIGGERED_ABILITY_YOU_CONTROL_TARGET: TargetRestriction =
  'activatedOrTriggeredAbilityYouControl';
const INSTANT_OR_SORCERY_SPELL_YOU_CONTROL_TARGET: TargetRestriction = 'instantOrSorcerySpellYouControl';
const PERMANENT_SPELL_YOU_CONTROL_TARGET: TargetRestriction = 'permanentSpellYouControl';
const NONLAND_PERMANENT_YOU_CONTROL_TARGET: TargetRestriction = 'nonlandPermanentYouControl';
const TOKEN_YOU_CONTROL_TARGET: TargetRestriction = 'tokenYouControl';
/** "target creature an opponent controls" — Banisher Priest. */
const CREATURE_AN_OPPONENT_CONTROLS_TARGET: TargetRestriction = 'creatureAnOpponentControls';
/** "target artifact, enchantment, or land" — the naturalize family. */
const ARTIFACT_ENCHANTMENT_OR_LAND_TARGET: TargetRestriction = 'artifactEnchantmentOrLand';
/** "creatures from the battlefield and/or creature cards from graveyards" — Angel of Serenity. */
const CREATURE_BATTLEFIELD_OR_GRAVEYARD_TARGET: TargetRestriction = 'creatureOnBattlefieldOrInGraveyard';
/**
 * "target NONLEGENDARY creature you control" (Kiki-Jiki) — never widened to
 * {@link CREATURE_YOU_CONTROL_TARGET}. The printed word is what stops the card
 * copying itself, and dropping it turns a fair rare into an infinite combo with
 * every legend on the table.
 */
const NONLEGENDARY_CREATURE_YOU_CONTROL_TARGET: TargetRestriction = 'nonlegendaryCreatureYouControl';
/**
 * "target artifact or creature you control" (Molten Duplication) — neither
 * {@link CREATURE_YOU_CONTROL_TARGET} widened nor `'permanent'` narrowed, both
 * of which are the wrong set.
 */
const ARTIFACT_OR_CREATURE_YOU_CONTROL_TARGET: TargetRestriction = 'artifactOrCreatureYouControl';
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
const CREATURE_CARD_IN_YOUR_GRAVEYARD_TARGET: TargetRestriction = 'creatureCardInYourGraveyard';
/** §3.149 — "target card from **a** graveyard": either player's, any card type. */
const CARD_IN_ANY_GRAVEYARD_TARGET: TargetRestriction = 'cardInAnyGraveyard';


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
  // "Choose one or more —" (Casualties of War, Sublime Epiphany): the max is
  // every mode on the menu, expressed as an unbounded ceiling the build site
  // already clamps to `modes.length`.
  'one or more': { min: 1, max: Number.MAX_SAFE_INTEGER },
  // "Choose any number —" (Rankle, Master of Pranks): zero is a legal answer.
  'any number': { min: 0, max: Number.MAX_SAFE_INTEGER },
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
const NAMED_DERIVED_COUNTS: Readonly<Record<string, DerivedCountDescriptor>> = Object.freeze({
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
  // The wall-tribal count both halves of that archetype print (Axebane
  // Guardian, Doorkeeper). In the SHARED table for the usual reason: the day a
  // pump or a damage line prints the same phrase it already means this number.
  'creatures you control with defender': 'creaturesYouControlWithDefender',
});

/**
 * FILTERED rows (DESIGN §3.149) — the other half of the same vocabulary.
 *
 * {@link NAMED_DERIVED_COUNTS} names sets core wrote by hand; these carry their
 * set AS DATA, so the next printed noun is one more line here instead of an enum
 * row plus a `case` in core's evaluator. Both halves are read through
 * {@link derivedValue} and land on the same descriptor shape, so a consumer
 * cannot tell them apart and none had to change.
 *
 * Each row is a real printed phrase from the corpus — `dead-rule-sweep.mjs` and
 * `rule-coverage.test.ts` are what stop a remembered wording getting in.
 */
const FILTERED_DERIVED_COUNTS: Readonly<Record<string, DerivedCountDescriptor>> = Object.freeze({
  ...subtypeCounts('mountain', 'Mountain'),
  ...subtypeCounts('swamp', 'Swamp'),
  ...subtypeCounts('forest', 'Forest'),
  ...subtypeCounts('island', 'Island'),
  ...subtypeCounts('plains', 'Plains', { plural: 'plains' }),
  ...subtypeCounts('cleric', 'Cleric'),
  ...subtypeCounts('goblin', 'Goblin'),
  ...subtypeCounts('elf', 'Elf', { plural: 'elves' }),
  ...subtypeCounts('shrine', 'Shrine'),
  ...subtypeCounts('equipment', 'Equipment', { plural: 'equipment' }),
  ...typeCounts('artifact', 'artifact'),
  ...typeCounts('enchantment', 'enchantment'),
  ...typeCounts('land', 'land'),
});

// ===========================================================================
// THE WALKER-RESIDUE FAMILY (DESIGN §3.154) — owned by `feat/walker-residues`.
// Everything between this banner and its closing one is this lane's; siblings
// are live in this file and must not need to read into it to merge.
//
// Two axes the count vocabulary did not have, both measured off Tamiyo, the
// Moon Sage's −2 ("Draw a card for each tapped creature target player
// controls"):
//   1. a BOARD-STATE predicate — "tapped", which `CardFilter` cannot carry;
//   2. a SUBJECT-PLAYER axis — whose seat the printed scope is read from.
// ===========================================================================

/** The word `playersForParam` reads for "the chosen player target". */
const TARGET_PLAYER_SUBJECT = 'targetPlayer';

/**
 * The TAPPED counts, read from the COUNTING PLAYER's own seat.
 *
 * Generated through the same {@link scopedCounts} every other filtered noun uses,
 * so "tapped creatures you control" / "…an opponent controls" / "…on the
 * battlefield" arrive together or not at all — and then narrowed by the board
 * state, which is the one thing a `CardFilter` cannot say (see core's
 * `PermanentStateFilter`).
 *
 * ⚠️ NOTHING IN THIS TABLE NAMES A TARGET, and that is enforced rather than
 * remembered: these rows are read by rules that declare no target, so a phrase
 * like "…target player controls" reaching them would resolve its subject to the
 * CONTROLLER and silently count the wrong player's board. The targeted phrases
 * live in {@link TARGETED_EACH_TO_PLURAL} instead, and
 * `walker-residues.test.ts` fails if a "target" phrase ever appears here.
 *
 * Measured first (rule 11): 8 corpus clauses across 7 shapes print "for each
 * tapped creature", 3 of them sole-blocked. That smaller number is the honest
 * ceiling for this half, and it is reported rather than the 246-clause
 * "tapped creature" headline the row would have offered.
 */
const TAPPED_DERIVED_COUNTS: Readonly<Record<string, DerivedCountDescriptor>> = Object.freeze(
  tappedStateOf(scopedCounts('tapped creatures', { anyOfTypes: ['creature'] }), 'tapped'),
);

/**
 * Narrow a generated scope family by a board state — the one place that turns
 * "creatures you control" rows into "tapped creatures you control" rows.
 *
 * A transform over {@link scopedCounts}' output rather than a parameter on it,
 * so the three printed scopes stay generated in exactly one place and a noun
 * added there is understood here for free.
 */
function tappedStateOf(
  rows: Record<string, DerivedCountDescriptor>,
  permanentState: PermanentStateFilter,
): Record<string, DerivedCountDescriptor> {
  const out: Record<string, DerivedCountDescriptor> = {};
  for (const [phrase, descriptor] of Object.entries(rows)) {
    // Every row `scopedCounts` makes is the object arm; the string arm is the
    // named-core-row half and cannot carry a board state at all.
    if (typeof descriptor === 'string') continue;
    out[phrase] = { ...descriptor, permanentState };
  }
  return out;
}

/**
 * The SINGULAR "for each …" phrases whose subject is a **TARGET**, and the
 * plural row each means.
 *
 * Its own table, deliberately NOT spread into {@link DERIVED_EACH_TO_PLURAL}.
 * A printed "target player" is only honest if the card actually TARGETS a
 * player: with no target chosen, `playersForParam` falls back to the controller,
 * so Tamiyo would count her own tapped creatures with nobody having chosen
 * anything — a different card, and one that never reports. `needsChosenTarget`
 * is a STATIC flag on a rule, so the only way to make the targeting mandatory is
 * to give these phrases a rule of their own; keeping them out of the shared
 * table is what stops a target-free rule from ever reading one.
 *
 * ⚠️ "target OPPONENT controls" is deliberately absent, and its exclusion is the
 * §1a check for this family. The count would be right in a two-seat game
 * (`scope: 'opponents'`), but the engine cannot restrict a chosen target to a
 * player who is not you — the same limitation `target-player-loses-life` already
 * names — so the card would let its controller aim at themselves and still draw
 * off the opponent's board. That is stronger than printed in one direction and
 * weaker in the other, so those three corpus clauses keep reporting.
 */
const TARGETED_EACH_TO_PLURAL: Readonly<Record<string, string>> = Object.freeze({
  'tapped creature target player controls': 'tapped creatures target player controls',
});

/**
 * The PLURAL rows the table above names — the subject-targeted half of the count
 * vocabulary, kept beside it for the same reason.
 *
 * `scope: 'you'` read from the TARGET's seat is exactly "permanents that player
 * controls". The two fields are different questions and compose; see
 * `DerivedValue.subject` for why collapsing them into `'opponents'` would be a
 * different card.
 */
const TARGETED_DERIVED_COUNTS: Readonly<Record<string, DerivedCountDescriptor>> = Object.freeze({
  'tapped creatures target player controls': {
    countOf: PERMANENTS_MATCHING,
    filter: { anyOfTypes: ['creature'] } as CardFilter,
    scope: 'you',
    subject: TARGET_PLAYER_SUBJECT,
    permanentState: 'tapped',
  } as const,
});

/** The alternation of the targeted "for each" phrases, longest-first. */
const TARGETED_EACH_PHRASE = `(${Object.keys(TARGETED_EACH_TO_PLURAL)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/**
 * The descriptor a printed targeted "for each …" phrase means, or null.
 *
 * Mirrors {@link derivedEachValue} exactly — singular spelling in, plural row's
 * answer out — so the two spellings of one count cannot drift apart.
 */
function targetedEachValue(phrase: string): Record<string, unknown> | null {
  const plural = TARGETED_EACH_TO_PLURAL[phrase.trim().toLowerCase()];
  if (plural === undefined) return null;
  const entry = TARGETED_DERIVED_COUNTS[plural];
  return entry === undefined || typeof entry === 'string' ? null : { ...entry };
}

/**
 * Where the pile the controller did NOT take goes — the printed tail mapped to
 * the primitive's closed destination vocabulary.
 *
 * ⚠️ These are the ONLY two tails in the corpus, and the table is closed on
 * purpose: "the other into your graveyard" and "the other on the bottom of your
 * library" are wildly different cards, and a rule that widened one into the
 * other would be the silent approximation the compiler contract forbids. A third
 * printed tail is a ROW here plus a row in `REST_DESTINATIONS`, and the test
 * that compares the two lists is what stops them drifting (rule 12 — the copy is
 * unavoidable because a param can arrive as generated pool data having never
 * passed the compiler).
 */
const PILE_REST_DESTINATIONS: Readonly<Record<string, string>> = Object.freeze({
  'on the bottom of your library in any order': 'libraryBottom',
  'into your graveyard': 'graveyard',
});

/**
 * The primitives whose printed subject may be the object a trigger's event was
 * about — "**it** gets -1/-0 until end of turn" on a per-attacker trigger.
 *
 * A CLOSED table rather than a blanket stamp, and that is the fidelity knob: a
 * body the engine cannot point at the attacker must REPORT, not quietly happen
 * to the source instead. `subjectCreatures` is the one reader of the stamp, so
 * only the primitives that consult it can honestly carry one.
 */
const TRIGGERING_SUBJECT_PRIMITIVES: ReadonlySet<string> = new Set([
  'pumpUntilEndOfTurn',
  'grantKeywordUntilEndOfTurn',
]);

/**
 * Stamp `subject: 'triggering'` onto every ref, or refuse the whole body.
 *
 * All-or-nothing on purpose. A two-sentence body where one half points at the
 * attacker and the other at the source is a card nobody printed, and it is the
 * kind of half-right that compiles `'complete'` and reads perfectly in a diff.
 */
function withTriggeringSubject(refs: readonly EffectRef[]): readonly EffectRef[] | null {
  const out: EffectRef[] = [];
  for (const ref of refs) {
    if (!TRIGGERING_SUBJECT_PRIMITIVES.has(ref.primitive)) return null;
    out.push({ ...ref, params: { ...(ref.params ?? {}), subject: 'triggering' } });
  }
  return out;
}

/** The two tables a guard test reads to prove no targeting phrase leaked into the shared ones. */
export const WALKER_RESIDUE_TABLES = Object.freeze({
  tapped: TAPPED_DERIVED_COUNTS,
  targetedEach: TARGETED_EACH_TO_PLURAL,
  targeted: TARGETED_DERIVED_COUNTS,
  pileRest: PILE_REST_DESTINATIONS,
});

/**
 * The primitive that reads the card a graveyard trigger was about. Named rather
 * than spelled as a bare string at both the rule that emits it and the rule that
 * detects it — two copies of a string are two chances to typo one of them into
 * silence (rule 12).
 */
const RETURN_TRIGGERING_CARD_TO_HAND = 'returnTriggeringCardToHand';

/**
 * Whether a compiled body names the card the trigger's event was about, and so
 * needs `carriesSubject` on the condition.
 *
 * Deliberately NOT {@link readsTriggeringObject}: that one looks for a
 * `{ readOf: 'triggering' }` PARAM, which is how a body reads a triggering
 * permanent's power. This body names no param at all — the whole referent IS the
 * primitive — so asking the same question the same way would answer "no" and the
 * emblem would resolve against an empty `triggeringInstances` and silently
 * return nothing. One question, two shapes of evidence; a single reader that
 * accepted both would be a reader that cannot say which it found.
 *
 * It recurses through `mayEffects`' nested refs, because "you MAY return it"
 * wraps the body one level deep and an unrecursed check reads the wrapper only.
 */
function readsTriggeringCard(refs: readonly EffectRef[]): boolean {
  for (const ref of refs) {
    if (ref.primitive === RETURN_TRIGGERING_CARD_TO_HAND) return true;
    const nested = ref.params?.effects;
    if (Array.isArray(nested) && readsTriggeringCard(nested as readonly EffectRef[])) return true;
  }
  return false;
}

// === end of the walker-residue count tables ================================

/**
 * The whole vocabulary, one table, read by every consumer.
 *
 * ⚠️ **NAMED ROWS WIN, and that precedence is load-bearing.** The generated rows
 * include "lands you control", which the named half already answers as
 * `landsYouControl` — and `landsYouControl` is the row core's
 * CHARACTERISTIC-DEFINING P/T evaluator knows. Spreading the generated half last
 * silently replaced it with a filtered descriptor, and eight `*`/`*` creatures —
 * Molimo, Maro-Sorcerer and its family — dropped out of the pool with nothing
 * failing: `namedDerivedValue` correctly refused a filtered count in a star box,
 * so the cards reported instead of compiling. The two counts mean the same
 * number; only one of them is spellable in a P/T box. `xvalue-templates.test.ts`
 * pins the precedence, and `playable-set.mjs` is what caught it — a +55 that was
 * really a +47 with eight silent losses.
 */
const DERIVED_COUNTS: Readonly<Record<string, DerivedCountDescriptor>> = Object.freeze({
  ...FILTERED_DERIVED_COUNTS,
  // §3.154 — the walker-residue rows. Spread with the FILTERED half and BEFORE
  // the named one, so the precedence the comment above protects is untouched:
  // every phrase below carries the word "tapped", which no named row spells, so
  // this spread can neither shadow a named row nor be shadowed by one.
  ...TAPPED_DERIVED_COUNTS,
  ...NAMED_DERIVED_COUNTS,
});

/** What a phrase in {@link DERIVED_COUNTS} means: a named core row, or a set carried as data. */
type DerivedCountDescriptor =
  | string
  | {
      readonly countOf: typeof PERMANENTS_MATCHING;
      readonly filter: CardFilter;
      readonly scope: DerivedCountScope;
      /** §3.154 — WHOSE seat `scope` is read from. Absent means the controller. */
      readonly subject?: string;
      /** §3.154 — the board-state predicate ("tapped"). Absent means it does not care. */
      readonly permanentState?: PermanentStateFilter;
    };

/**
 * The three printed scopes of a filtered count, as the rows they generate.
 *
 * ⚠️ "N you control" / "N they control" / "N on the battlefield" are DIFFERENT
 * NUMBERS, and a table that carried only the first would quietly make "artifacts
 * an opponent controls" count yours. Generated from one place so a noun added
 * below gets all three spellings or none — the class of omission that otherwise
 * shows up as one card in the pool and its sibling reported.
 */
function scopedCounts(
  plural: string,
  filter: CardFilter,
): Record<string, DerivedCountDescriptor> {
  const row = (scope: DerivedCountScope) => ({ countOf: PERMANENTS_MATCHING, filter, scope }) as const;
  return {
    [`${plural} you control`]: row('you'),
    [`${plural} an opponent controls`]: row('opponents'),
    [`${plural} your opponents control`]: row('opponents'),
    [`${plural} they control`]: row('opponents'),
    [`${plural} on the battlefield`]: row('any'),
  };
}

/** A SUBTYPE noun ("Mountains you control", "Clerics on the battlefield"). */
function subtypeCounts(
  plural: string,
  subtype: string,
  options?: { readonly plural?: string },
): Record<string, DerivedCountDescriptor> {
  return scopedCounts(options?.plural ?? `${plural}s`, { anyOfSubtypes: [subtype] });
}

/** A CARD-TYPE noun ("artifacts you control"). */
function typeCounts(plural: string, type: CardType): Record<string, DerivedCountDescriptor> {
  return scopedCounts(`${plural}s`, { anyOfTypes: [type] });
}

/**
 * The printed subject **"you "**, made optional.
 *
 * Every "you may …" wrapper in this file — `mayEffectsFrom`, the inline
 * `optional` branches, `optionalTriggerFrom` — hands the effect table what is
 * left after the words "you may " are removed. Oracle text writes the life
 * clauses with an explicit subject ("You gain 1 life"), so Soul's Attendant's
 * "you may gain 1 life" arrives here as the bare "gain 1 life" and a pattern
 * anchored on "^you " refuses a card whose only unread word is one the wrapper
 * itself removed.
 *
 * ONE fragment rather than a `(?:you )?` typed into each rule, so the set of
 * clauses that accept a dropped subject is a single readable list. It is spent
 * ONLY on clauses whose printed subject is literally "you" — an imperative like
 * "Draw a card" prints no subject to drop, and widening it would accept text no
 * card prints.
 */
const OPTIONAL_YOU = '(?:you )?';

/** The alternation of the phrases above, longest-first so none is truncated. */
const DERIVED_PHRASE = `(${Object.keys(DERIVED_COUNTS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/**
 * The derived descriptor a printed phrase means, or null when unlisted.
 *
 * Both halves of {@link DERIVED_COUNTS} land on ONE shape — a named row becomes
 * `{ countOf }`, a filtered row is already the descriptor — so every consumer
 * reads one thing and none of them learned that filtered counts exist.
 */
function derivedValue(phrase: string): Record<string, unknown> | null {
  const entry = DERIVED_COUNTS[phrase.trim().toLowerCase()];
  if (entry === undefined) return null;
  return typeof entry === 'string' ? { countOf: entry } : { ...entry };
}

/**
 * The same lookup for the two CHARACTERISTIC-DEFINING P/T rules, which may take
 * only a NAMED row.
 *
 * A `*` box is evaluated by core's `characteristicValue` → `evaluateDerivedCount`,
 * whose switch deliberately has no filter arm (see `countPermanentsMatching`'s
 * PERF note: that switch runs on every stat read and is kept untouched). So a
 * filtered count in a P/T box would silently be zero — "~'s power is equal to
 * the number of Goblins you control" reading 0/0 — and the honest answer is to
 * report the card until the CDA path can carry a filter.
 */
function namedDerivedValue(phrase: string): { countOf: string } | null {
  const entry = DERIVED_COUNTS[phrase.trim().toLowerCase()];
  return typeof entry === 'string' ? { countOf: entry } : null;
}

/**
 * The SINGULAR half of the same vocabulary — the phrase a card prints after
 * "**for each**". "You gain 1 life for each *card in your hand*" counts exactly
 * the set "the number of *cards in your hand*" counts.
 *
 * A row is the singular spelling and the PLURAL ROW IT MEANS, never a second
 * copy of the count: the answer still has exactly one definition
 * ({@link DERIVED_COUNTS}), so the two spellings cannot drift into different
 * numbers, and `derived-count-vocabulary.test.ts` fails the build if a row here
 * ever names a plural row that does not exist.
 *
 * A table and not a de-pluralising regex, for the reason every table in this
 * file is closed: "creature card in your graveyard" de-pluralises cleanly and
 * "card types among cards in all graveyards" does not, and a rule that
 * half-understands a count makes a card quietly stronger or weaker than printed.
 * The resolution-facing counts (`timesThisWasKicked`, `triggeringAmount`) are
 * absent because they print their own "for each" wording, already handled where
 * multikicker is.
 */
const DERIVED_EACH_TO_PLURAL: Readonly<Record<string, string>> = Object.freeze({
  'creature you control': 'creatures you control',
  'creature your opponents control': 'creatures your opponents control',
  'creature your opponent controls': 'creatures your opponent controls',
  'creature on the battlefield': 'creatures on the battlefield',
  'land you control': 'lands you control',
  'card in your hand': 'cards in your hand',
  'card in your graveyard': 'cards in your graveyard',
  'creature card in your graveyard': 'creature cards in your graveyard',
  // §3.154 — the walker-residue family's target-FREE singulars. Safe in this
  // shared table precisely because none of them names a target; the targeted
  // spelling lives in `TARGETED_EACH_TO_PLURAL` and is read by one rule that
  // declares the target.
  'tapped creature you control': 'tapped creatures you control',
  'tapped creature an opponent controls': 'tapped creatures an opponent controls',
  'tapped creature your opponents control': 'tapped creatures your opponents control',
  'tapped creature they control': 'tapped creatures they control',
  'tapped creature on the battlefield': 'tapped creatures on the battlefield',
});

/** The alternation of the "for each" phrases, longest-first. */
const DERIVED_EACH_PHRASE = `(${Object.keys(DERIVED_EACH_TO_PLURAL)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/** The derived descriptor a printed "for each …" phrase means, or null. */
function derivedEachValue(phrase: string): Record<string, unknown> | null {
  const plural = DERIVED_EACH_TO_PLURAL[phrase.trim().toLowerCase()];
  return plural === undefined ? null : derivedValue(plural);
}

/** Persist returns the creature with this many -1/-1 counters (the printed value). */
const PERSIST_MINUS_COUNTERS = 1;

// --- the counter keyword family (DESIGN §3.110) — the printed numbers, spelled once --
/** Undying returns the creature with this many +1/+1 counters (CR 702.93a). */
const UNDYING_RETURN_COUNTERS = 1;
/** Evolve puts this many +1/+1 counters on the source (CR 702.100a). */
const EVOLVE_COUNTERS = 1;
/** Dethrone puts this many +1/+1 counters on the attacker (CR 702.105a). */
const DETHRONE_COUNTERS = 1;
/** Outlast's activation puts this many +1/+1 counters on the source (CR 702.107a). */
const OUTLAST_COUNTERS = 1;
/**
 * The creature-type words a printed "Amass [type] N" names, mapped to the
 * SINGULAR subtype the Army becomes (CR 701.47a: "It's also a Zombie"). A
 * CLOSED table of the printed plurals: a word outside it reports rather than
 * being singularised by a rule that "Elves" and "Dwarves" would both break.
 */
const AMASS_ARMY_TYPES: Readonly<Record<string, string>> = Object.freeze({
  zombies: 'Zombie',
  orcs: 'Orc',
  goblins: 'Goblin',
});
/**
 * What a printed "Devour [noun] N" may sacrifice (CR 702.82a), as the shared
 * `CardFilter`. The bare keyword is creatures; the typed forms name a card
 * type or the Food subtype. Closed for the reason every noun table here is.
 */
const DEVOUR_NOUNS: Readonly<Record<string, CardFilter>> = Object.freeze({
  '': { anyOfTypes: ['creature'] },
  artifact: { anyOfTypes: ['artifact'] },
  land: { anyOfTypes: ['land'] },
  food: { anyOfSubtypes: ['food'] },
});
/** Afterlife's Spirit (CR 702.135a), as the token rule reads it: "a 1/1 white and black Spirit creature token with flying". */
const AFTERLIFE_TOKEN_FACE = '1/1 white and black spirit creature';

/** A printed count as Oracle prints it inside a token line — "a", "two", "three" — for a generated body. */
function countWord(count: number): string {
  const words = ['zero', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return words[count] ?? String(count);
}

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
  // poison family (§3.105): infect (CR 702.90) and wither (CR 702.80) are read
  // at core's CR 120.3 damage-result funnel. Being rows HERE also puts both into
  // `KEYWORD_TOKEN`, so "gains infect until end of turn" (Tainted Strike) and
  // "creatures you control have infect" compile as grants with no further rule.
  // Toxic carries a NUMBER and parses through `parsePayloadKeyword` instead.
  infect: 'infect',
  wither: 'wither',
  // The combat keyword family (DESIGN §3.107).
  // Shadow (CR 702.28b) is the symmetric block rule `canBlock` reads.
  // Split second (CR 702.61a) is the timing lock the offer pass reads.
  // Each is a flag, exactly as flash is.
  shadow: 'shadow',
  'split second': 'splitSecond',
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
 * The printed COMPARISON in "creatures with power {less,greater} than this
 * creature's power can't block …", mapped to the bound of the granted block
 * restriction that the source's own power fills.
 *
 * "Less than X can't block" means a legal blocker has power AT LEAST X; the
 * mirror means at most it. Typed as `SourcePowerBlockBound` so a direction core
 * cannot honour is a type error rather than a silently inverted card, and read
 * by BOTH the rule's pattern and its body, so a word the table does not carry
 * cannot even match.
 */
const SOURCE_POWER_BLOCK_BOUNDS: Readonly<Record<string, SourcePowerBlockBound>> = Object.freeze({
  less: 'minBlockerPower',
  greater: 'maxBlockerPower',
});

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
 * The SUBTYPE nouns a printed "Affinity for …" may name (CR 702.40a lets the
 * keyword name any object quality), as the `CardFilter` each counts — a CLOSED
 * table seeded from every affinity line in the corpus. "Outlaws" is the one
 * printed word that is a defined GROUP (CR 205.3d: Assassins, Mercenaries,
 * Pirates, Rogues and Warlocks), so its row is the five subtypes, and
 * "planeswalkers" is a card type the static-noun table above does not carry.
 * Kept apart from `permanentNounFilter` so the "unless you control …" template
 * that table serves keeps exactly the scope it was measured with.
 */
const AFFINITY_SUBTYPE_NOUNS: Readonly<Record<string, CardFilter>> = Object.freeze({
  allies: { anyOfSubtypes: ['Ally'] },
  auras: { anyOfSubtypes: ['Aura'] },
  birds: { anyOfSubtypes: ['Bird'] },
  cats: { anyOfSubtypes: ['Cat'] },
  citizens: { anyOfSubtypes: ['Citizen'] },
  daleks: { anyOfSubtypes: ['Dalek'] },
  elves: { anyOfSubtypes: ['Elf'] },
  equipment: { anyOfSubtypes: ['Equipment'] },
  foods: { anyOfSubtypes: ['Food'] },
  frogs: { anyOfSubtypes: ['Frog'] },
  gates: { anyOfSubtypes: ['Gate'] },
  humans: { anyOfSubtypes: ['Human'] },
  knights: { anyOfSubtypes: ['Knight'] },
  lizards: { anyOfSubtypes: ['Lizard'] },
  outlaws: { anyOfSubtypes: ['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'] },
  planeswalkers: { anyOfTypes: ['planeswalker'] },
  slivers: { anyOfSubtypes: ['Sliver'] },
  spirits: { anyOfSubtypes: ['Spirit'] },
  towns: { anyOfSubtypes: ['Town'] },
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
  // The predefined artifact tokens, countable now that the engine mints them
  // ("if you control ten or more Treasures" — Revel in Riches).
  'treasure',
  'clue',
  'food',
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
  const value = parseSignedInt(amount ?? '');
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
 *    this rule does not build; the `create-predefined-token` rule handles them
 *    as a data lookup, and any OTHER non-creature token stays reported.
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
 * ("protection from mana value 3 or less", "from the chosen color") has no
 * faithful engine check, so those cards keep reporting rather than compiling a
 * protection that quietly protects from the wrong things.
 */
const PROTECTION_QUALITY_WORDS: Readonly<Record<string, ProtectionQuality>> = Object.freeze({
  white: 'white',
  blue: 'blue',
  black: 'black',
  red: 'red',
  green: 'green',
  colorless: 'colorless',
  monocolored: 'monocolored',
  multicolored: 'multicolored',
  artifacts: 'artifacts',
  creatures: 'creatures',
  enchantments: 'enchantments',
  lands: 'lands',
  planeswalkers: 'planeswalkers',
  instants: 'instants',
  sorceries: 'sorceries',
  everything: 'everything',
});

/**
 * "Protection from EACH COLOR" (Iridescent Angel, Spectra Ward, Akroma's Will)
 * is the five colour qualities at once — CR 702.16j says exactly that — so it
 * expands to them rather than becoming a sixth colour word the engine would
 * then have to define.
 */
const PROTECTION_EACH_COLOR = 'each color';
const EVERY_COLOR_QUALITY: readonly ProtectionQuality[] = Object.freeze(['white', 'blue', 'black', 'red', 'green']);

/**
 * The SUBTYPES a printed protection line may name, lower-cased as Oracle's
 * plural and mapped to the subtype the engine compares (`hasSubtype` folds
 * case, so the value is the printed singular). A CLOSED table seeded from the
 * corpus — every plural printed on a real card — rather than a strip-the-s
 * rule, because "protection from haste", "from snow" and "from spells" would
 * all pass a generic rule and mean nothing to the engine.
 */
const PROTECTION_SUBTYPE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  angels: 'Angel',
  archons: 'Archon',
  arcane: 'Arcane',
  assassins: 'Assassin',
  beasts: 'Beast',
  clerics: 'Cleric',
  coyotes: 'Coyote',
  demons: 'Demon',
  dogs: 'Dog',
  dragons: 'Dragon',
  elves: 'Elf',
  goblins: 'Goblin',
  gorgons: 'Gorgon',
  humans: 'Human',
  kavu: 'Kavu',
  rats: 'Rat',
  robots: 'Robot',
  salamanders: 'Salamander',
  spirits: 'Spirit',
  vampires: 'Vampire',
  werewolves: 'Werewolf',
  wizards: 'Wizard',
  zombies: 'Zombie',
});

/**
 * How a printed protection line separates its qualities: "X and from Y",
 * "X, from Y, and from Z" (Elite Inquisitor), or a plain comma list. The
 * optional "from" is stripped on BOTH separator shapes; the comma form used to
 * keep it and refused every three-quality line.
 */
const PROTECTION_SEPARATOR = /,? and (?:from )?|, (?:from )?/;

/** `Ward {N}` - only the plain generic-cost form; anything else must report. */
const WARD_PATTERN = /^ward \{(\d+)\}$/;

/** `Protection from X[ and from Y...]` - the capturing form of the printed line. */
const PROTECTION_PATTERN = /^protection from (.+)$/;

// --- BEGIN targeting-protection family (DESIGN §3.152) -------------------------
// Owned by `feat/targeting-protection`. Everything between this marker and its
// END marker is the hexproof-from family; neighbours are untouched on purpose so
// the concurrent lanes in this file merge textually.

/**
 * `Hexproof from X[, Y, and Z]` (CR 702.11e) — the MODERN printing of the
 * targeting quarter, and the capturing form of the printed keyword line.
 *
 * It reads the SAME quality list as {@link PROTECTION_PATTERN}, through the same
 * {@link parseProtectionQualities}, because "which sources count as black" is
 * one question. What differs is the FIELD it lands in, and that difference is
 * the whole point: see `KeywordFlags.hexproofFrom`.
 */
const HEXPROOF_FROM_PATTERN = /^hexproof from (.+)$/;

/**
 * Fiendslayer Paladin's printing — the same ability spelled as a sentence,
 * before `hexproof from` existed as a keyword (2013 vs 2018).
 *
 * `~ can't be the target of black or red spells your opponents control.`
 *
 * ⚠️ **The "your opponents control" tail is load-bearing and is REQUIRED by
 * this pattern, not optional.** The older wording without it — "can't be the
 * target of red spells **or abilities from red sources**" (Suq'Ata Firewalker,
 * Mercenary Informer, Rebel Informer, Raiding Party) — binds against the
 * controller's own spells too, which is shroud's scope, not hexproof's. Making
 * the tail optional would compile four cards into a keyword that lets their
 * controller target them, i.e. playing them differently from printed. Those
 * cards keep REPORTING; see DESIGN §3.152's residue table.
 */
const CANT_BE_TARGETED_SENTENCE =
  /^(?:~|this (?:creature|permanent|enchantment|artifact|land)) can't be the target of (.+?) spells your opponents control\.?$/;

/**
 * How that sentence separates its qualities — "black or red", "black, red, or
 * green". A different separator from {@link PROTECTION_SEPARATOR} because the
 * sentence form spells the list in English ("or") while the keyword form repeats
 * the preposition ("and from"); both are normalised into the same word list, so
 * the closed quality table stays the single answer to which words are real.
 */
const SENTENCE_QUALITY_SEPARATOR = /,? or |, /;

/**
 * Compile the sentence printing into the same qualities the keyword printing
 * yields, or `null` when any word is outside the closed table.
 */
function parseCantBeTargetedSentence(text: string): KeywordFlags | null {
  const match = CANT_BE_TARGETED_SENTENCE.exec(text);
  if (!match) return null;
  const words = (match[1] ?? '')
    .split(SENTENCE_QUALITY_SEPARATOR)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  // Rejoin into the keyword form's own separator so ONE parser owns the closed
  // quality vocabulary. A second copy of that table is the DRY failure this
  // repo's rule 12 names.
  const qualities = parseProtectionQualities(words.join(' and from '));
  return qualities === null ? null : { hexproofFrom: qualities };
}

// --- END targeting-protection family ------------------------------------------

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
  const add = (quality: ProtectionQuality): void => {
    if (!qualities.includes(quality)) qualities.push(quality);
  };
  for (const word of words) {
    if (word === PROTECTION_EACH_COLOR) {
      EVERY_COLOR_QUALITY.forEach(add);
      continue;
    }
    const quality = PROTECTION_QUALITY_WORDS[word];
    if (quality) {
      add(quality);
      continue;
    }
    const subtype = PROTECTION_SUBTYPE_WORDS[word];
    if (subtype === undefined) return null;
    add(`${PROTECTION_SUBTYPE_PREFIX}${subtype}`);
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
    const cost = parseSignedInt(ward[1] ?? '');
    return Number.isFinite(cost) && cost > 0 ? { ward: cost } : null;
  }
  const protection = PROTECTION_PATTERN.exec(text);
  if (protection) {
    const qualities = parseProtectionQualities(protection[1] ?? '');
    return qualities === null ? null : { protectionFrom: qualities };
  }
  // §3.152 — the targeting quarter, in its two printings. Both land in
  // `hexproofFrom`, never in `protectionFrom`: see the field's own note.
  const hexproofFrom = HEXPROOF_FROM_PATTERN.exec(text);
  if (hexproofFrom) {
    const qualities = parseProtectionQualities(hexproofFrom[1] ?? '');
    return qualities === null ? null : { hexproofFrom: qualities };
  }
  return parseCantBeTargetedSentence(text);
}

// --- poison family (§3.105) -----------------------------------------------------

/** `Toxic N` (CR 702.164a) — "written 'toxic N,' where N is a number". */
const TOXIC_PATTERN = /^toxic (\d+)$/;

/**
 * The third payload keyword. Toxic's whole payload is its number, so it parses
 * like ward rather than like a flag; a form outside the pattern ("toxic X")
 * returns `null` and the line reports, exactly as an odd ward cost does.
 */
function parseToxic(word: string): KeywordFlags | null {
  const toxic = TOXIC_PATTERN.exec(word.trim().toLowerCase());
  if (!toxic) return null;
  const value = parseSignedInt(toxic[1] ?? '');
  return Number.isFinite(value) && value > 0 ? { toxic: value } : null;
}

/**
 * Every payload-carrying keyword the compiler reads — ward, protection AND
 * toxic — behind one door, so the keyword-line compiler and the grant parser
 * cannot disagree about which printed forms are real. `parseProtectionOrWard`
 * keeps its name and its callers' meaning; this is the superset.
 */
export function parsePayloadKeyword(word: string): KeywordFlags | null {
  return parseProtectionOrWard(word) ?? parseToxic(word);
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
 * §3.151 — THE STATIC PREVENTION SHIELD, as a table of SUBJECTS read by BOTH
 * sides of the sentence.
 *
 * A printed static shield says which damage it stops in three printed
 * directions — "dealt **to** X", "dealt **by** X", and "dealt to **and dealt
 * by** X" (Fog Bank, Gaseous Form, Heart of Light). The subject X is the same
 * noun phrase in all three, so it is ONE table and the direction chooses which
 * projection of a row to read. Two tables — one for recipients and one for
 * dealers — is how "enchanted creature" ends up meaning two different creatures
 * in the same sentence (rule 12).
 *
 * `dealer: null` is a REFUSAL, not an omission: it says this subject has no
 * printed "…dealt by" form the engine can express, so a card printing one
 * reports instead of compiling into a shield that guards the wrong side. A
 * player deals no damage, and "attacking creatures you control" has no printed
 * by-form in the corpus — a projection that fires on no real card is exactly
 * what `dead-rule-sweep.mjs` exists to catch.
 *
 * Every row is a real printed card, named. Adding a subject is a ROW.
 */
const PREVENTION_STATIC_SUBJECTS: Readonly<
  Record<string, { readonly recipient: ReplacementApplies; readonly dealer: ReplacementApplies | null }>
> = Object.freeze({
  // "~" — the ability's own permanent. Fog Bank, Cho-Manno Revolutionary, Dawn
  // Elemental, Guard Gomazoa, Seraph of the Sword, Everdawn Champion.
  '~': { recipient: { recipientAnchor: 'source' }, dealer: { dealerAnchor: 'source' } },
  // The permanent an Aura or Equipment is attached to. Gaseous Form, Sandskin,
  // Ghostly Possession, Heart of Light, Inviolability (to); Muzzle, Defang,
  // Temporal Isolation, Candletrap, Demonic Torment (by).
  'enchanted creature': { recipient: { recipientAnchor: 'attached' }, dealer: { dealerAnchor: 'attached' } },
  // General's Kabuto. Same anchor, different printed word — `attachedTo` does
  // not care which kind of attachment it is, and neither does the card.
  'equipped creature': { recipient: { recipientAnchor: 'attached' }, dealer: { dealerAnchor: 'attached' } },
  // Crystal Barricade and kin. A PLAYER is never a damage source, so there is
  // no dealer projection to write.
  you: { recipient: { recipientController: 'you', recipientKind: 'player' }, dealer: null },
  // Statecraft is the only printed card that uses this subject on BOTH sides,
  // and it is why the dealer projection exists at all.
  'creatures you control': {
    recipient: {
      recipientController: 'you',
      recipientKind: 'permanent',
      recipientFilter: { anyOfTypes: ['creature' as CardType] },
    },
    dealer: { sourceController: 'you', sourceFilter: { anyOfTypes: ['creature' as CardType] } },
  },
  // Vigor's shape — the printed word "other" (Crystal Barricade).
  'other creatures you control': {
    recipient: {
      recipientController: 'you',
      recipientKind: 'permanent',
      recipientFilter: { anyOfTypes: ['creature' as CardType] },
      excludeSource: true,
    },
    dealer: null,
  },
  // Dolmen Gate, Iroas.
  'attacking creatures you control': {
    recipient: {
      recipientController: 'you',
      recipientKind: 'permanent',
      recipientFilter: { anyOfTypes: ['creature' as CardType] },
      recipientAttacking: true,
    },
    dealer: null,
  },
  // Emmara Tandris.
  'creature tokens you control': {
    recipient: {
      recipientController: 'you',
      recipientKind: 'permanent',
      recipientFilter: { anyOfTypes: ['creature' as CardType], isToken: true },
    },
    dealer: null,
  },
  // Bubble Matrix — symmetric, both players' creatures.
  creatures: {
    recipient: { recipientKind: 'permanent', recipientFilter: { anyOfTypes: ['creature' as CardType] } },
    dealer: null,
  },
});

/** The alternation of every prevention subject, longest first so none is truncated. */
const PREVENTION_STATIC_SUBJECT_TOKEN = `(${Object.keys(PREVENTION_STATIC_SUBJECTS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/**
 * §3.151 — the optional printed tail narrowing WHICH SOURCES a static shield
 * stops: "prevent all damage that would be dealt to ~ **by creatures**"
 * (Champion Lancer, Uncle Istvan, Istvan Butcher of Eln), "**by artifact
 * sources**" (Argothian Treefolk), "**by sources you control**" (Light of
 * Sanction).
 *
 * CLOSED, and deliberately short. The tails left OUT are the ones core cannot
 * express faithfully, and each is REPORTED rather than widened (§3.151):
 *   - "by artifact creatures" — a CONJUNCTION of two types, and `anyOfTypes` is
 *     a disjunction. Compiling it as `['artifact','creature']` would stop damage
 *     from every creature, which is a strictly better card.
 *   - "by creatures with first strike" — `CardFilter` has no keyword field.
 *   - "by creatures it's blocking" / "by enchanted creatures" — a RELATION
 *     between two permanents, which no filter can state.
 */
const PREVENTION_SOURCE_CLASSES: Readonly<Record<string, ReplacementApplies>> = Object.freeze({
  creatures: { sourceFilter: { anyOfTypes: ['creature' as CardType] } },
  'artifact sources': { sourceFilter: { anyOfTypes: ['artifact' as CardType] } },
  'sources you control': { sourceController: 'you' },
});

/** The alternation of every source-class tail, longest first. */
const PREVENTION_SOURCE_CLASS_TOKEN = `(${Object.keys(PREVENTION_SOURCE_CLASSES)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/**
 * §3.151 — WHO a printed life-gain replacement watches. "If **you** would gain
 * life" (Rhox Faithmender, Boon Reflection, Alhammarret's Archive, The Wind
 * Crystal, Knight of Dawn's Light) and "if **a player** would gain life"
 * (Sulfuric Vortex), which is the symmetric card.
 *
 * "An opponent" is deliberately ABSENT. It is printed — Tainted Remedy, Plague
 * Drone — but only ever with the outcome "that player **loses** that much life
 * instead", which turns a gain into a LOSS: a different event, not a scaled
 * quantity, and one core's layer does not watch. A row here would be a branch
 * that fires on no card the outcome table can finish, which is precisely the
 * dead rule `dead-rule-sweep.mjs` exists to catch.
 */
const LIFEGAIN_SUBJECTS: Readonly<Record<string, StaticControllerScope>> = Object.freeze({
  you: 'you',
  'a player': 'any',
});

/** The alternation of every life-gain subject, longest first. */
const LIFEGAIN_SUBJECT_TOKEN = `(${Object.keys(LIFEGAIN_SUBJECTS)
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
 * The nouns an edict may name — "target player sacrifices a **creature**".
 *
 * ONE alternation read by all four "… sacrifices a NOUN" rules (target player,
 * each opponent, each player, that player) and by the sacrifice half of
 * `may-cost-then-effect`, so a noun added for one of them is understood by all
 * of them in the same edit. Four copies of the list is how they end up
 * disagreeing about what an edict may take.
 */
const SACRIFICE_NOUNS = 'creature|land|artifact|permanent';

/**
 * The `filter` param a printed sacrifice noun means — the one answer every
 * edict rule reads.
 *
 * Returns the params to SPREAD rather than a bare filter, because "a permanent"
 * is every type and its rule must emit no `filter` key at all: an empty filter
 * object would be a second way to spell "everything" sitting in the compiled
 * card.
 *
 * "Nontoken" (Accursed Marauder) is a printed narrowing with an exact
 * `CardFilter` field, so it is expressible rather than reported — a token
 * creature does not qualify.
 */
function sacrificeNounFilter(noun: string, nontoken: boolean): { filter?: CardFilter } {
  const filter: Record<string, unknown> = {};
  if (noun !== 'permanent') filter.anyOfTypes = [noun as CardType];
  if (nontoken) filter.isToken = false;
  return Object.keys(filter).length > 0 ? { filter: filter as CardFilter } : {};
}

/**
 * The param value meaning "the X chosen (and paid for) at cast time" — the
 * shape `intParam` in `../effect-helpers.ts` resolves from
 * `EffectContext.xValue`. Mirrored here as data rather than imported so the
 * compiler stays a pure table over the primitives' documented param vocabulary.
 */
const CHOSEN_X_PARAM = Object.freeze({ chosenX: true });

// --- object-characteristic amounts (DESIGN §3.149) -------------------------------
//
// The printed ways a card names ONE OBJECT whose power/toughness/mana value is
// the amount, and the CLOSED table mapping each to the subject the engine reads.
// Two tables rather than one regex alternation for the usual reason (rule 2):
// adding "the equipped creature's power" is a ROW here, not a new branch, and a
// spelling outside the table reports rather than being widened to the nearest
// thing that happens to exist.
//
// ⚠️ The bare word "**its**" is deliberately ABSENT. Its referent depends on the
// sentence around it — the entering creature in "whenever another creature you
// control enters, you gain life equal to its toughness", but the source itself
// in "{R}, {T}: ~ deals damage equal to its power to any target". A rule that
// guessed would make one of those two cards play wrong, silently. It is resolved
// at the two seams where the referent is PROVABLE instead — see
// {@link resolveItsReferent}.

/** Printed possessive → the object {@link ObjectCharacteristicValue} reads. */
const OBJECT_CHARACTERISTIC_SUBJECTS: Readonly<Record<string, 'triggering' | 'source'>> = Object.freeze({
  "that creature's": 'triggering',
  "that permanent's": 'triggering',
  "~'s": 'source',
});

/** Printed characteristic word → the characteristic read. */
const OBJECT_CHARACTERISTIC_WORDS: Readonly<Record<string, 'power' | 'toughness' | 'manaValue'>> =
  Object.freeze({
    power: 'power',
    toughness: 'toughness',
    'mana value': 'manaValue',
  });

/** The characteristic-word alternation alone, longest-first so none is truncated. */
const OBJECT_CHARACTERISTIC_WORD_PHRASE = Object.keys(OBJECT_CHARACTERISTIC_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/** `(<possessive>) (<characteristic>)` — two capture groups, longest-first so none is truncated. */
const OBJECT_CHARACTERISTIC_PHRASE = `(${Object.keys(OBJECT_CHARACTERISTIC_SUBJECTS)
  .sort((a, b) => b.length - a.length)
  .join('|')}) (${OBJECT_CHARACTERISTIC_WORD_PHRASE})`;

/**
 * The descriptor a printed "<possessive> <characteristic>" means, or `null`.
 *
 * Refuses a `source` reading on a card that is not a permanent: a SPELL's
 * `ctx.source` is the spell on the stack, so "~'s power" there would read zero
 * forever. No printed card asks it, and refusing keeps it that way.
 */
function objectCharacteristic(
  possessive: string,
  characteristic: string,
  ctx: RuleContext,
): { readOf: 'triggering' | 'source'; characteristic: 'power' | 'toughness' | 'manaValue' } | null {
  const readOf = OBJECT_CHARACTERISTIC_SUBJECTS[possessive.trim().toLowerCase()];
  const read = OBJECT_CHARACTERISTIC_WORDS[characteristic.trim().toLowerCase()];
  if (readOf === undefined || read === undefined) return null;
  if (readOf === 'source' && !cardIsPermanent(ctx)) return null;
  return { readOf, characteristic: read };
}

/**
 * Rewrite the bare "**its** <characteristic>" to an explicit possessive, but
 * ONLY where the sentence names exactly one object it could refer to.
 *
 * Called from the two seams where the referent is provable: a board-watching
 * ENTERS trigger (the permanent that entered is the only object named, and it
 * is still on the battlefield) and an activated ability's body (the source is
 * the only object named, and it was on the battlefield a moment ago to be
 * activated). Everywhere else "its" is left alone and the clause reports.
 *
 * The guard is what makes this safe rather than clever: a body that also says
 * "target", "that creature" or "equipped creature" has a SECOND candidate, so
 * nothing is rewritten and the card reports instead of playing a coin-flip.
 */
const SECOND_OBJECT_WORDS = /\btarget\b|\bthat (?:creature|permanent|card|spell|player)\b|\bequipped\b|\benchanted\b/;
export function resolveItsReferent(body: string, referent: "that creature's" | "~'s"): string {
  if (!/\bits (?:power|toughness|mana value)\b/.test(body)) return body;
  if (SECOND_OBJECT_WORDS.test(body)) return body;
  return body.replace(/\bits (power|toughness|mana value)\b/g, `${referent} $1`);
}

/**
 * Whether any of these effect refs reads the TRIGGERING object's characteristics
 * — the question a board-watching trigger has to ask before deciding whether to
 * carry its subject (`TriggerCondition.carriesSubject`).
 *
 * Shallow by design: the compiler emits the descriptor as a direct param value,
 * exactly as `restrictionOfEffects` reads `targets`. A nested body that needed
 * it would show up as an unread param and report, not as a silent zero.
 */
function readsTriggeringObject(refs: readonly EffectRef[]): boolean {
  for (const ref of refs) {
    for (const value of Object.values(ref.params ?? {})) {
      if (typeof value === 'object' && value !== null && (value as { readOf?: unknown }).readOf === 'triggering') {
        return true;
      }
    }
  }
  return false;
}

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
 * Whether a printed `X` in THIS clause has a value the engine actually charged
 * for — the one question every X-reading rule asks.
 *
 * Two sources, one reader (§3.149): the card's own `{X}` mana cost (a cast-time
 * choice), and an `{X}` in the ACTIVATION cost of the ability whose body this
 * clause is (`RuleContext.xFromActivationCost`). Before the second existed,
 * Kessig Wolf Run's "+X/+0" was refused by a rule looking at the wrong cost, and
 * a rule that checked NEITHER would read a cast-time X nobody was ever asked
 * for. An X defined by a "where X is …" clause is neither of these and still
 * reports on its own terms.
 */
function xIsBound(ctx: RuleContext): boolean {
  return ctx.xFromActivationCost === true || cardHasXCost(ctx);
}

/**
 * WHAT `X` MEANS IN THIS CLAUSE — the one answer, read by every X rule.
 *
 * Three sources, in priority order, and each is a different printed thing:
 *  1. a `where X is …` clause that DEFINED it (§3.149) — a derived count;
 *  2. the card's own `{X}` mana cost — the value chosen and charged at cast;
 *  3. the `{X}` in the ACTIVATION cost that put this body on the stack.
 * `null` when nothing bound one, which is the refusal that keeps "deals X
 * damage" on a card with no X anywhere out of the pool.
 *
 * The where-clause WINS over a cast-time X on purpose: a card printing both
 * ("Suspend X—{X}{W}{W}") says two different numbers, and the clause that
 * defines X in this sentence is the one this sentence means.
 */
function xParamValue(ctx: RuleContext): Record<string, unknown> | null {
  if (ctx.xDerivedBinding !== undefined) return ctx.xDerivedBinding;
  return xIsBound(ctx) ? CHOSEN_X_PARAM : null;
}

/**
 * Read an {@link AMOUNT_TOKEN} slot: a printed number, a number word, or `X`.
 *
 * The ONE place the "number or X" question is asked, so every rule that takes
 * an amount learned X in the same edit — and a card that spells its amount X on
 * one line and 3 on another compiles both through one reader.
 *
 * `null` for an X nothing bound, exactly as {@link parseCount} is null for a
 * word it does not know: the clause reports rather than dealing zero.
 */
function parseAmount(token: string | undefined, ctx: RuleContext): number | Record<string, unknown> | null {
  if ((token ?? '').trim().toLowerCase() === 'x') return xParamValue(ctx);
  return parseCount(token);
}

/**
 * The trailing "**, where X is <PHRASE>**" that DEFINES a sentence's X, split
 * into the sentence and the phrase.
 *
 * Anchored to the end and non-greedy on the left so it takes the LAST such
 * clause and cannot swallow a body. The optional comma is real: some cards
 * print "…, where X is …" and a few print it without.
 */
export const WHERE_X_IS_CLAUSE = /^(.+?),? where x is ([^.]+?)\.?$/;

/**
 * The derived descriptor a "where X is <PHRASE>" tail means, or `null`.
 *
 * Reads the SAME {@link DERIVED_COUNTS} table as "equal to the number of …",
 * because they are the same quantity said two ways — one table, so the two
 * spellings can never drift into different numbers, and a noun added for one is
 * understood by the other in the same edit.
 */
export function whereXBinding(phrase: string): Record<string, unknown> | null {
  const text = phrase.trim().toLowerCase();
  for (const form of WHERE_X_ARITHMETIC) {
    const match = form.pattern.exec(text);
    if (!match) continue;
    const count = derivedValue(match[form.countGroup]!);
    if (!count) return null;
    return { ...count, ...form.offset(Number.parseInt(match[form.constantGroup] ?? '0', 10)) };
  }
  // Only the "the number of …" spellings above are read. "where X is your
  // devotion to black", "where X is the greatest power among creatures you
  // control" and "where X is twice the number of …" are different quantities
  // with no row in the count vocabulary, and each reports rather than being read
  // as a count it is not.
  return null;
}

/**
 * The printed ARITHMETIC around a "where X is …" count, as a closed table.
 *
 * Four rows, in the order a card prints them, each saying which capture is the
 * COUNT and which the CONSTANT, and what offset that shape means. A table
 * because the next shape is a ROW (rule 2) — and because the reversed form is
 * where the sign is easy to get backwards: "**3 minus** the number of cards in
 * their hand" is `3 − count`, not `count − 3`, and those are different cards.
 *
 * Every subtracting row carries `min: 0` (CR 107.1b — a quantity that would be
 * negative is zero), which the plain and adding rows do not need.
 */
const WHERE_X_ARITHMETIC: readonly {
  readonly pattern: RegExp;
  readonly countGroup: number;
  readonly constantGroup: number;
  readonly offset: (n: number) => Record<string, unknown>;
}[] = Object.freeze([
  // "3 plus the number of artifacts you control" (Welding Sparks)
  { pattern: /^(\d+) plus the number of (.+)$/, countGroup: 2, constantGroup: 1, offset: (n) => ({ plus: n }) },
  // "3 minus the number of cards in their hand" (Rackling, Wheel of Torture)
  {
    pattern: /^(\d+) minus the number of (.+)$/,
    countGroup: 2,
    constantGroup: 1,
    offset: (n) => ({ times: -1, plus: n, min: 0 }),
  },
  // "the number of cards in their hand minus 4" (Viseling, Iron Maiden)
  {
    pattern: /^the number of (.+) minus (\d+)$/,
    countGroup: 1,
    constantGroup: 2,
    offset: (n) => ({ plus: -n, min: 0 }),
  },
  // the plain form
  { pattern: /^the number of (.+)$/, countGroup: 1, constantGroup: 0, offset: () => ({}) },
]);

/**
 * A printed P/T slot in a pump: `+3`, `-2`, `+X`, `-X`.
 *
 * ONE token read by every pump rule, so the day "+X/+0" became payable both the
 * plain pump and the pump-and-grant learned it in the same edit — two nearly
 * identical patterns is exactly how "+X/+0" would have ended up legal on one
 * card and reported on its sibling.
 */
const PUMP_AMOUNT = '([+-](?:\\d+|x))';

/**
 * The value a {@link PUMP_AMOUNT} slot means: a plain signed number, or the
 * chosen X (negated for a minus slot through the shared `times` multiplier, so
 * "gets -X/+X" reaches the adding primitive as the two numbers it prints).
 *
 * `null` when the slot says X and nothing in this clause bound one — the same
 * refusal every other X rule makes, so a Kessig-shaped line on a card with no X
 * anywhere reports instead of pumping by zero.
 */
function parsePumpAmount(token: string, ctx: RuleContext): number | Record<string, unknown> | null {
  const text = token.trim().toLowerCase();
  if (text.endsWith('x')) {
    const x = xParamValue(ctx);
    if (x === null) return null;
    return text.startsWith('-') ? { ...x, times: -1 } : x;
  }
  const value = parseSignedInt(text);
  return Number.isFinite(value) ? value : null;
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

/**
 * The printed PERMANENT nouns a targeted removal line may name, mapped to the
 * core restriction each one means.
 *
 * DATA, not an alternation baked into each rule (DESIGN §1.2): "destroy target
 * X", "exile target X" and "return target X to its owner's hand" all print the
 * same noun vocabulary, so a noun lives here ONCE and every verb that reads
 * this table gains it at the same moment. Adding the next printed noun is a row
 * here plus its core restriction — never a new rule per verb.
 *
 * The table stays CLOSED for the reason the restriction union is closed: a noun
 * that is not here reports, rather than being widened to the nearest thing the
 * engine happens to have.
 */
export const TARGET_NOUN_RESTRICTIONS: Readonly<Record<string, TargetRestriction>> = Object.freeze({
  creature: 'creature',
  artifact: 'artifact',
  enchantment: 'enchantment',
  land: 'land',
  planeswalker: 'planeswalker',
  permanent: 'permanent',
  'artifact or enchantment': 'artifactOrEnchantment',
  'artifact or creature': 'artifactOrCreature',
  'creature or enchantment': 'creatureOrEnchantment',
  'creature or planeswalker': 'creatureOrPlaneswalker',
  'nonartifact creature': 'nonartifactCreature',
  'nonland permanent': 'nonlandPermanent',
  // §3.112 — bloodrush's aim (read off the live combat record by core).
  'attacking creature': 'attackingCreature',
  // §3.148 — the most-printed narrowing in the targeted-trigger backlog, and
  // the one core could already say (`creatureAnOpponentControls`, added for
  // Banisher Priest). One row, and destroy/exile/bounce gain it together.
  'creature an opponent controls': 'creatureAnOpponentControls',
  // ⚠️ "artifact, enchantment, or land" is deliberately NOT here: Oracle prints
  // it with and without the serial comma, and `destroy-target-artifact-
  // enchantment-or-land` owns both spellings. A row here would take one
  // spelling and leave the other to a rule that then looks dead.
});

/**
 * §3.112 — the nouns a PUMP may name, as a closed table.
 *
 * Separate from {@link TARGET_NOUN_RESTRICTIONS} on purpose: that table is
 * every noun a removal or bounce verb may point at, and "target land gets
 * +3/+3" is not a printed sentence. These two are, and the second is every
 * bloodrush line in the game ("Target attacking creature gets +3/+3 until end
 * of turn"). Adding the next pump noun is a ROW read by BOTH pump rules, so
 * the plain and the keyword-granting forms cannot disagree about which nouns
 * are real.
 */
const PUMP_TARGET_NOUNS: Readonly<Record<string, TargetRestriction>> = Object.freeze({
  creature: CREATURE_TARGET,
  'attacking creature': ATTACKING_CREATURE_TARGET,
  // §3.148 — "When ~ enters, target creature AN OPPONENT CONTROLS gets -2/-0
  // until end of turn" is a whole printed family (Eyeblight Assassin and kin),
  // and the shrink is only ever aimed at the other side. Widening it to
  // `creature` would offer a pilot its own board as a legal target for a
  // penalty, which is a card playing differently from its text.
  'creature an opponent controls': CREATURE_AN_OPPONENT_CONTROLS_TARGET,
});

/** The pump nouns as an alternation, longest first so "creature" cannot truncate the pair. */
const PUMP_TARGET_PHRASE = Object.keys(PUMP_TARGET_NOUNS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/** The table's nouns as a regex alternation, longest first so none is truncated. */
const TARGET_NOUN_PHRASE = Object.keys(TARGET_NOUN_RESTRICTIONS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * The nouns an UNTAP (or a bare TAP) may name, as a closed table.
 *
 * Separate from {@link TARGET_NOUN_RESTRICTIONS} for the reason
 * {@link PUMP_TARGET_NOUNS} is separate: that table is what a REMOVAL verb may
 * point at, and "destroy target Forest" is not a printed sentence while "untap
 * target Forest" is (Arbor Elf). These two verbs share one vocabulary — the
 * things a permanent-state change can be aimed at — so a row added here is
 * understood by `untap-target-noun`, `untap-another-target-noun` and
 * `tap-target-noun` in the same edit, and the three cannot drift into
 * disagreeing about which nouns are real.
 *
 * ⚠️ The five BASIC LAND TYPES are rows rather than one `land`: Arbor Elf may
 * untap a Forest and may not untap an Island, and widening the printed word to
 * "land" is a card playing wider than printed. Core's restriction union carries
 * them for exactly this reason.
 *
 * Deliberately NOT here: "creature you control", "permanent you control" and the
 * snow/legendary/colour narrowings ("untap target legendary permanent",
 * "untap another target snow permanent"). Each needs a restriction core cannot
 * say yet, and a closed table REPORTS rather than widening to the nearest thing
 * that happens to exist. The CONTROLLER narrowing core CAN say is the row
 * below — the test for membership is whether `TargetRestriction` carries the
 * word, never whether the nearest thing would be close enough.
 */
const UNTAP_TARGET_NOUNS: Readonly<Record<string, TargetRestriction>> = Object.freeze({
  creature: 'creature',
  land: 'land',
  artifact: 'artifact',
  permanent: 'permanent',
  plains: 'plains',
  island: 'island',
  swamp: 'swamp',
  mountain: 'mountain',
  forest: 'forest',
  // §3.148 — "When ~ enters, TAP target creature an opponent controls" (Frost
  // Lynx and the whole freeze family). Printed on the tap verb only, and a row
  // here rather than a rule of its own precisely so the pair cannot drift.
  'creature an opponent controls': CREATURE_AN_OPPONENT_CONTROLS_TARGET,
});

/** The untap nouns as an alternation, longest first so none is truncated. */
const UNTAP_TARGET_NOUN_PHRASE = Object.keys(UNTAP_TARGET_NOUNS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * The printed SPELL nouns a counter line may name. Separate from the permanent
 * table because the objects live in different zones and no printed line mixes
 * them; same closed-table discipline.
 */
export const COUNTER_NOUN_RESTRICTIONS: Readonly<Record<string, TargetRestriction>> = Object.freeze({
  spell: 'spell',
  'noncreature spell': 'noncreatureSpell',
  'instant spell': 'instantSpell',
  'instant or sorcery spell': 'instantOrSorcerySpell',
});

const COUNTER_NOUN_PHRASE = Object.keys(COUNTER_NOUN_RESTRICTIONS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * The printed nouns an ADDITIONAL mana-ability cost may name, mapped to the
 * {@link CardFilter} each means — "tap an untapped **creature** you control",
 * "sacrifice a **Food**".
 *
 * Closed and shared for the same reason {@link TARGET_NOUN_RESTRICTIONS} is:
 * the next printed filter is a ROW here, understood by EVERY cost parser at
 * once — the mana ability's tap/sacrifice forms and the ACTIVATED ability's
 * "Sacrifice a <noun>" (`parseActivationCost`) all read this one table, so
 * "a Treasure" cannot mean one thing on Gilded Goose and another on
 * Professional Face-Breaker. A noun that is not here reports rather than being
 * widened to "any permanent you control".
 */
export const COST_NOUNS: Readonly<Record<string, CardFilter>> = Object.freeze({
  creature: { anyOfTypes: ['creature'] },
  artifact: { anyOfTypes: ['artifact'] },
  land: { anyOfTypes: ['land'] },
  permanent: {},
  'legendary creature': { anyOfTypes: ['creature'], legendary: true },
  food: { anyOfSubtypes: ['Food'] },
  treasure: { anyOfSubtypes: ['Treasure'] },
  // §3.111 — the basic land types, for "Flashback—Sacrifice a Mountain" (Lava
  // Dart). Subtype filters, so a Mountain-typed dual pays exactly as printed.
  plains: { anyOfSubtypes: ['Plains'] },
  island: { anyOfSubtypes: ['Island'] },
  swamp: { anyOfSubtypes: ['Swamp'] },
  mountain: { anyOfSubtypes: ['Mountain'] },
  forest: { anyOfSubtypes: ['Forest'] },
  clue: { anyOfSubtypes: ['Clue'] },
  goblin: { anyOfSubtypes: ['Goblin'] },
  desert: { anyOfSubtypes: ['Desert'] },
  token: { isToken: true },
});

/**
 * §3.111 — the PLURAL forms a counted cost prints ("Sacrifice three
 * creatures", "Tap three untapped white creatures you control"), mapped to
 * the {@link COST_NOUNS} row each means. Closed on purpose: a plural outside
 * it ("Sacrifice X Mountains" is refused for its X first) reports.
 */
const COST_NOUN_PLURALS: Readonly<Record<string, string>> = Object.freeze({
  creatures: 'creature',
  artifacts: 'artifact',
  lands: 'land',
  permanents: 'permanent',
  mountains: 'mountain',
  islands: 'island',
  swamps: 'swamp',
  forests: 'forest',
});

/** §3.111 — eternalize's token is "a 4/4" whatever the card printed (CR 702.129a). */
const ETERNALIZED_POWER = 4;
const ETERNALIZED_TOUGHNESS = 4;

/** The cost nouns as an alternation, longest first so none is truncated. */
export const COST_NOUN_PHRASE = Object.keys(COST_NOUNS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * The printed bodies that read "**that much**" / "**that many**" — the SIZE of
 * the event that set the trigger off (Exquisite Blood, Vito, Sanguine Bond,
 * Mindcrank).
 *
 * A table rather than a chain of ifs, for the reason every other cost/noun
 * table here is one: the next printed body is a ROW. Each entry names the
 * primitive, which param carries the amount, and the player scope — the amount
 * itself is always the same derived descriptor, so "that much" cannot come to
 * mean two different quantities.
 */
const TRIGGERING_AMOUNT_BODIES: Readonly<
  Record<string, { primitive: string; amountKey: string; params: Readonly<Record<string, unknown>> }>
> = Object.freeze({
  'you gain that much life': { primitive: 'gainLife', amountKey: 'amount', params: {} },
  'you lose that much life': { primitive: 'loseLife', amountKey: 'amount', params: {} },
  'target opponent loses that much life': {
    primitive: 'loseLife',
    amountKey: 'amount',
    params: { targetPlayer: true, targets: OPPONENT_TARGET },
  },
  'each opponent loses that much life': {
    primitive: 'loseLife',
    amountKey: 'amount',
    params: { whichPlayer: 'opponent' },
  },
  'that player loses that much life': {
    primitive: 'loseLife',
    amountKey: 'amount',
    params: { whichPlayer: 'triggering' },
  },
  // "That many" is the same quantity with the printed word a count demands.
  'that player mills that many cards': {
    primitive: 'mill',
    amountKey: 'count',
    params: { whichPlayer: 'triggering' },
  },
  'you mill that many cards': { primitive: 'mill', amountKey: 'count', params: {} },
  'you draw that many cards': { primitive: 'drawCards', amountKey: 'count', params: {} },
});

/** The bodies as an alternation, longest first so none is truncated. */
const TRIGGERING_AMOUNT_PHRASE = Object.keys(TRIGGERING_AMOUNT_BODIES)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * Who a printed GROUP phrase reaches — "creatures you control", "lands you
 * control", "all Slivers" — as the {@link StaticAffects} it means.
 *
 * Built on the closed tables this file already has: {@link STATIC_NOUN_TYPES}
 * for a card-type noun, and the compiling card's OWN printed subtypes for a
 * typal phrase — the same rule the typal anthem follows, which is what stops
 * "all Slivers" compiling on a card that never says Sliver.
 */
function groupStaticAffects(
  noun: string,
  scopeWords: string | undefined,
  ctx: RuleContext,
): StaticAffects | null {
  const scope = scopeWords === undefined ? 'any' : scopeWords.includes('you control') ? 'you' : 'opponent';
  const singular = noun.endsWith('s') ? noun.slice(0, -1) : noun;
  const type = STATIC_NOUN_TYPES[singular];
  if (type !== undefined) {
    return { ...(type === null ? {} : { anyOfTypes: [type] }), controller: scope };
  }
  const printed = ctx.card.typeLine.subtypes.find((sub) => sub.toLowerCase() === singular);
  if (printed === undefined) return null;
  return { anyOfSubtypes: [printed], controller: scope };
}

// --- the spell-count family (DESIGN §3.113): the closed noun tables -------------
/**
 * "Investigate TWICE / THREE TIMES" — the printed repeat words. Its own table
 * and not `REPLACEMENT_MULTIPLIERS` (which also lists "double"): a repeat count
 * and a damage multiplier are different arithmetic that happen to share two words.
 */
const REPEAT_COUNT_WORDS: Readonly<Record<string, number>> = Object.freeze({
  twice: 2,
  'three times': 3,
  'four times': 4,
});

/**
 * The card nouns a mill-then-return line may name, mapped to the filter that
 * selects them. CLOSED: "a land card or Elf card" (Roots of Wisdom) and
 * "an instant, sorcery, or Faerie card" (Free the Fae) are outside it and the
 * lines report. "Permanent card" is a card with a permanent type — every card
 * that is not an instant or a sorcery (CR 110.4).
 */
const MILL_RETURN_NOUNS: Readonly<Record<string, CardFilter>> = Object.freeze({
  creature: { anyOfTypes: ['creature'] },
  land: { anyOfTypes: ['land'] },
  permanent: { noneOfTypes: ['instant', 'sorcery'] },
  'instant or sorcery': { anyOfTypes: ['instant', 'sorcery'] },
  'creature or land': { anyOfTypes: ['creature', 'land'] },
});

/** The alternation of every mill-return noun, longest first so none is truncated. */
const MILL_RETURN_NOUN_TOKEN = Object.keys(MILL_RETURN_NOUNS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * "Double all damage that SOURCES would deal" — the printed source phrases of
 * the whole-sentence form of the damage-scaling replacement, mapped to the
 * same `applies` the "if a source you control would deal damage" form builds.
 * CLOSED: "sources you control of the chosen type" (Collective Inferno) names
 * an as-enters choice the replacement layer cannot read, and reports.
 */
const DOUBLE_ALL_DAMAGE_SOURCES: Readonly<
  Record<string, { readonly sourceController: StaticControllerScope; readonly sourceFilter?: CardFilter }>
> = Object.freeze({
  'sources you control': { sourceController: 'you' },
  'creature sources you control': { sourceController: 'you', sourceFilter: { anyOfTypes: ['creature'] } },
  'creatures you control': { sourceController: 'you', sourceFilter: { anyOfTypes: ['creature'] } },
});

/**
 * THE SHIELD FAMILY — the recipient phrases a printed "**prevent the next N
 * damage that would be dealt to ___ this turn**" line may name.
 *
 * Measured, not guessed: this shape is the single largest printed BODY in the
 * activated-ability backlog (`activated-blame.mjs`) — 114 clauses across the
 * corpus, 78 of them on cards whose ONLY unread sentence is this one, and the
 * six rows below are every phrase that appears more than once. The primitive
 * already existed (`preventDamage` with a `preventUpTo` ceiling); what was
 * missing was the sentence.
 *
 * TWO tables rather than one, split by whether the printed phrase AIMS:
 * a rule's `needsChosenTarget` is a static flag, and "dealt to you" must stay
 * usable inside a trigger body while "dealt to target creature" must not.
 *
 * Both are CLOSED. The narrowings this cannot say — "target cleric or wizard
 * creature", "target creature and each other creature that shares a color with
 * it", "a source of your choice" — REPORT rather than being widened to the
 * nearest restriction that happens to exist: a shield that guards more than the
 * printed one is a card playing better than printed.
 */
const PREVENTION_TARGET_RECIPIENTS: Readonly<Record<string, TargetRestriction>> = Object.freeze({
  // Read off the SHARED damage-target vocabulary's members, because a printed
  // "dealt to any target" guards exactly the set "deals damage to any target"
  // reaches (Heal, Barrenton Medic, Master Apothecary).
  'any target': 'any',
  'target creature': 'creature',
  // Noble Vestige, Wandering Mage.
  'target player or planeswalker': 'playerOrPlaneswalker',
  // Argivian Blacksmith, Abuna Acolyte.
  'target artifact creature': 'artifactCreature',
});

/** The aiming recipients as an alternation, longest first so none is truncated. */
const PREVENTION_TARGET_PHRASE = Object.keys(PREVENTION_TARGET_RECIPIENTS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * The recipients that name NO target — the shield's guard is fixed by the
 * printed word. `self` binds it to the ability's own source (Rock Hydra,
 * Opal-Eye); the other row is the controller's face (Conservator, Shield of the
 * Ages).
 */
const PREVENTION_FIXED_RECIPIENTS: Readonly<
  Record<string, { readonly self?: true; readonly scope?: 'you'; readonly recipientKind?: 'player' }>
> = Object.freeze({
  '~': { self: true },
  you: { scope: 'you', recipientKind: 'player' },
});

const PREVENTION_FIXED_PHRASE = Object.keys(PREVENTION_FIXED_RECIPIENTS)
  .sort((a, b) => b.length - a.length)
  .join('|');

// =============================================================================
// §3.149 — THE NAMED-COUNTER VOCABULARY
// =============================================================================

/**
 * The counter kinds a card may PUT ON and this engine may store as plain
 * instance state — a CLOSED table, and the closure is the whole safety argument.
 *
 * `counters-blame.mjs` measured the "counters template" backlog row and found
 * that it is the §3.120 aggregation artifact a third time (2,598 clauses across
 * 2,303 distinct shapes — 1.13 clauses per shape), with ONE real seam inside it:
 * 207 clauses compile the moment the counter KIND is one the engine can hold,
 * and their templates already exist. This table is that seam, restricted to the
 * kinds where holding the counter is the FULL meaning of the printed line.
 *
 * ⚠️ WHAT IS DELIBERATELY ABSENT, and why each absence is load-bearing. CR 122.1
 * attaches behaviour to some counters, and a card whose counter is stored but
 * whose rule is not honoured plays WEAKER than printed — which biases an A/B
 * verdict exactly as badly as one playing stronger:
 *   - `shield` — CR 122.1c: removes itself instead of the permanent being
 *     destroyed or dealt damage. 25 clauses want it; all of them keep reporting.
 *   - `stun`   — CR 122.1d: removes itself instead of the permanent untapping.
 *     71 clauses want it; all of them keep reporting.
 *   - `time` / `fade` / `age` — suspend, fading and cumulative upkeep drive
 *     these, and §3.106 already implements those keywords. A bare "put a time
 *     counter on ~" outside that machinery is NOT the same thing, so it reports.
 *   - `loyalty` / `defense` / `level` / `lore` — whole card types (planeswalkers,
 *     battles, levelers, Sagas) read these; none is inert.
 *   - `poison` / `energy` / `experience` — PLAYER counters, not permanent state.
 *   - `keyword` counters (CR 122.1e) — a flying counter GRANTS flying. Storing
 *     one silently would drop the grant.
 *
 * A kind outside this table has no rule, so its card reports by name rather than
 * being widened into the nearest row that happens to exist.
 */
const INERT_COUNTER_KINDS: readonly string[] = Object.freeze([
  'blood', 'bounty', 'brick', 'charge', 'depletion', 'divinity', 'flood',
  'gold', 'growth', 'hatchling', 'healing', 'hoofprint', 'ice', 'intervention',
  'ki', 'lodestone', 'luck', 'matrix', 'music', 'net', 'oil', 'page', 'plague',
  'pressure', 'quest', 'rust', 'scream', 'slime', 'soul', 'spore', 'storage',
  'study', 'tide', 'training', 'verse', 'wish',
]);

/** The alternation, built FROM the table so the two cannot drift apart. */
const INERT_COUNTER_KIND_TOKEN = INERT_COUNTER_KINDS.join('|');

/**
 * The counter kind a printed word names, or `null` when the word is outside
 * {@link INERT_COUNTER_KINDS}. The lookup exists so every rule reading a counter
 * word asks ONE question in ONE place — a second `includes` somewhere else is
 * how a kind ends up inert in one rule and reported in another.
 */
function inertCounterKind(word: string): string | null {
  const kind = word.trim().toLowerCase();
  return INERT_COUNTER_KINDS.includes(kind) ? kind : null;
}

/**
 * Whether the card being compiled is something a counter can sit ON.
 *
 * Counters live on PERMANENTS (CR 122.1 — and on players, which is a different
 * system). An instant or sorcery is on the stack and then in a graveyard; it is
 * never a permanent, so a clause that would put counters "on it" cannot be
 * talking about the spell itself. Used to refuse a bare "it" whose referent is
 * the previous sentence's target rather than the source — see the rule that
 * calls it for the card that proved the difference.
 */
function sourceCanHoldCounters(ctx: RuleContext): boolean {
  return ctx.card.typeLine.types.some((printed) => {
    const type = printed.toLowerCase();
    return type !== 'instant' && type !== 'sorcery';
  });
}

// --- §3.148, the O-Ring pair: an exile that must LINK, and the guard that says so ---

/**
 * The printed line that gives an O-Ring's exiled card back.
 *
 * ONE pattern, TWO readers: the effect rule that compiles the line, and
 * {@link printsLinkedReturn}, which asks whether the card prints it at all. A
 * second copy for the second question is the drift rule 12 names — the day the
 * wording gains a spelling, only one copy would learn it and the disagreement
 * would look like a card bug.
 */
const RETURN_EXILED_TO_BATTLEFIELD =
  /^return (?:the exiled cards?|that exiled card) to the battlefield under (?:its|their) owners?['\u2019]?s? control$/;

/** Angel of Serenity's destination — the same line, the same two readers. */
const RETURN_EXILED_TO_HAND = /^return the exiled cards? to (?:its|their) owners?['\u2019]?s? hands?$/;

/** The leaves-trigger prefix the return line is always printed under. */
const LEAVES_TRIGGER_PREFIX = /^when ~ leaves the battlefield, (.+)$/;

/**
 * Does this card print the OTHER half of an O-Ring — a "when ~ leaves the
 * battlefield, return the exiled card…" line?
 *
 * ⚠️ A GUARD, NOT A CONVENIENCE, and a shipped card is why it exists.
 * "Exile target creature" compiles to a plain `exileTarget`, which records NO
 * link back to the exiler, while `returnExiledByThis` returns only what the
 * source's own link names (`CardInstance.exiledUntilLeavesBy`). Journey to
 * Nowhere prints exactly those two sentences and compiled to that unlinked
 * pair: the creature was exiled for ever and destroying the enchantment gave
 * back nothing — removal with no drawback, a strictly BETTER card than the one
 * printed, which is precisely the bias the pool exists to keep out.
 *
 * The exile half cannot see the pair from inside its own sentence, so it asks
 * the card. Reads the SAME `prepareOracle` + `normalizeClause` the compiler
 * reads the card with, so "this enchantment", "this creature" and the card's own
 * name are already `~` and a printing wording cannot make the guard miss.
 */
function printsLinkedReturn(ctx: RuleContext): boolean {
  for (const line of prepareOracle(ctx.card.oracleText, ctx.card.name)) {
    const body = LEAVES_TRIGGER_PREFIX.exec(normalizeClause(line))?.[1];
    if (body === undefined) continue;
    if (RETURN_EXILED_TO_BATTLEFIELD.test(body) || RETURN_EXILED_TO_HAND.test(body)) return true;
  }
  return false;
}

export const EFFECT_RULES: readonly CompileRule[] = Object.freeze([
  {
    /**
     * THE SHIELD, aimed. "Prevent the next N damage that would be dealt to any
     * target this turn" (Heal, Barrenton Medic), "…to target creature this
     * turn" (Sacred Boon, Test of Faith), "…to target artifact creature…"
     * (Argivian Blacksmith).
     *
     * A CEILING, not a fog: `preventUpTo: N` absorbs at most N and then stops,
     * which is the whole difference between Heal and Holy Day. Compiling it as
     * a blanket prevention would make every one of these 78 cards strictly
     * better than printed.
     */
    id: 'prevent-next-damage-targeted',
    description:
      '"Prevent the next N damage that would be dealt to <TARGET> this turn" for every row in PREVENTION_TARGET_RECIPIENTS (Heal, Sacred Boon, Noble Vestige, Argivian Blacksmith)',
    pattern: new RegExp(
      `^prevent the next ${COUNT_TOKEN} (combat )?damage that would be dealt to (${PREVENTION_TARGET_PHRASE}) this turn$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[1]);
      if (amount === null) return null;
      const restriction = PREVENTION_TARGET_RECIPIENTS[match[3] ?? ''];
      if (restriction === undefined) return null;
      return effects({
        primitive: 'preventDamage',
        params: {
          amount,
          targeted: true,
          targets: restriction,
          ...(match[2] !== undefined ? { combat: true } : {}),
          label: match[0],
        },
      });
    },
  },
  {
    /**
     * THE SHIELD, unaimed. "Prevent the next N damage that would be dealt to
     * you this turn" (Conservator, Esper Battlemage) and "…to ~ this turn"
     * (Rock Hydra, Ursine Fylgja, Opal-Eye).
     *
     * Its own rule rather than a row of the aimed one because it must NOT be
     * `needsChosenTarget`: these lines name no target, so they are legal inside
     * a trigger body and must never fizzle for want of one.
     */
    id: 'prevent-next-damage-fixed-recipient',
    description:
      '"Prevent the next N damage that would be dealt to you / to ~ this turn" (Conservator, Decorated Griffin, Rock Hydra, Opal-Eye, Konda\'s Yojimbo)',
    pattern: new RegExp(
      `^prevent the next ${COUNT_TOKEN} (combat )?damage that would be dealt to (${PREVENTION_FIXED_PHRASE}) this turn$`,
    ),
    build(match) {
      const amount = parseCount(match[1]);
      if (amount === null) return null;
      const who = PREVENTION_FIXED_RECIPIENTS[match[3] ?? ''];
      if (who === undefined) return null;
      return effects({
        primitive: 'preventDamage',
        params: {
          amount,
          ...(who.self ? { selfShield: true } : {}),
          ...(who.scope ? { scope: who.scope } : {}),
          ...(who.recipientKind ? { recipientKind: who.recipientKind } : {}),
          ...(match[2] !== undefined ? { combat: true } : {}),
          label: match[0],
        },
      });
    },
  },
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
      '"~ deals N/X damage to any target / target creature / target player [or planeswalker]" — the printed target phrase becomes the effect\'s `targets` restriction',
    // ⚠️ Stays on {@link COUNT_TOKEN} while its X sibling `x-damage` exists.
    // The DRY answer is one rule over the shared AMOUNT token — they are the
    // same sentence with the same recipient table and two parsers — but that
    // deletes `x-damage`, and `apps/web/src/lib/about/mechanics.ts` names that
    // id as the {X} mechanic's WITNESS with a test that fails when a witness
    // stops resolving. It is a two-file fix for whoever owns both; §3.149 did
    // not own `apps/web` and left the duplicate rather than break that page.
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
      `^~ deals ${AMOUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}(?:\\.|,)? and you gain ${AMOUNT_TOKEN} life$|^~ deals ${AMOUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}\\. you gain ${AMOUNT_TOKEN} life$`,
    ),
    needsChosenTarget: true,
    build(match, ctx) {
      // The pattern has two alternations ("… and you gain" / "…. You gain"), each
      // carrying three groups (count, target phrase, life), so read whichever
      // triple actually matched. §3.149 — both halves are AMOUNT slots, because
      // Tendrils of Corruption prints "deals X damage … and you gain X life".
      const damage = parseAmount(match[1] ?? match[4], ctx);
      const restriction = damageRestriction(match[2] ?? match[5] ?? '');
      const life = parseAmount(match[3] ?? match[6], ctx);
      if (damage === null || life === null || restriction === null) return null;
      return effects(
        { primitive: 'dealDamage', params: damageParams(damage as never, restriction) },
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
    id: 'gain-life-for-each',
    description: '"[You] gain 1 life for each X" (Venser\'s Journal, Riot Control)',
    // The "for each" spelling of `gain-life-equal-to-count` one rule down, and
    // it compiles to the IDENTICAL descriptor — one derived count, read by
    // `intParam`.
    //
    // ⚠️ ONLY the multiplier of ONE compiles. "Gain 2 life for each creature you
    // control" is `2 × count`, and a `DerivedValue` carries a count with no
    // scale factor — so there is no honest way to emit it and the card reports
    // instead. Emitting the bare count would print a card that gains HALF the
    // life it says, which is the class of infidelity nothing would ever notice.
    pattern: new RegExp(`^${OPTIONAL_YOU}gain ${COUNT_TOKEN} life for each ${DERIVED_EACH_PHRASE}$`),
    build(match) {
      if (parseCount(match[1]) !== 1) return null;
      const amount = derivedEachValue(match[2] ?? '');
      if (!amount) return null;
      return effects({ primitive: 'gainLife', params: { amount } });
    },
  },
  // --- the walker-residue family (DESIGN §3.154) ----------------------------
  {
    id: 'until-your-next-turn-attack-trigger',
    description:
      '"Until your next turn, whenever a creature [you control / an opponent controls] attacks, BODY" (Jace, Architect of Thought’s +1)',
    /**
     * A DURATION-SCOPED delayed trigger, which is a third lifetime beside the
     * two the engine already had: it fires an unbounded number of times and
     * stops at a MOMENT rather than by being spent.
     *
     * ⚠️ §1a, the stronger-than-printed direction. A delayed ability that
     * outlives its printed duration is the same class of defect as an emblem
     * that should never have existed, and it is completely silent — the card
     * simply keeps working. Core takes the duration as ONE field
     * (`untilTurnOf`) that writes both halves of the lifetime, so this rule
     * cannot install a repeating ability with no expiry even by omission.
     *
     * ⚠️ The BODY is compiled target-free. A delayed ability resolves with an
     * empty target list, so a body needing a chosen target would silently
     * no-op — the same gate every trigger body already passes through.
     */
    pattern: new RegExp(
      `^until your next turn, whenever a creature ` +
        `(you control|an opponent controls|your opponents control) attacks, (.+)$`,
    ),
    build(match, ctx) {
      const tail = (match[1] ?? '').trim();
      const who = tail === 'you control' ? 'you' : 'opponent';
      const body = match[2] ?? '';
      // "IT gets -1/-0" — the object is the ATTACKER that fired this firing, not
      // the source and not a target.
      //
      // The pronoun is rewritten to `~` so the body compiles through the ONE
      // existing self-pump rule rather than a second copy of its `+N/+M` parser
      // (rule 12), and the resulting ref is then stamped with the same
      // `subject: 'triggering'` exalted and flanking use — `subjectCreatures` is
      // the single reader that turns the stamp into the attacker. The stamp is
      // safe only because {@link TRIGGERING_SUBJECT_PRIMITIVES} is closed: a body
      // whose primitive does not consult that reader is refused rather than
      // silently happening to the source instead.
      const compiled = ctx.compileEffectClause(body.replace(/^it /, '~ '), { targetFree: true });
      if (compiled === null || compiled.length === 0) return null;
      const stamped = withTriggeringSubject(compiled);
      if (stamped === null) return null;
      return effects({
        primitive: 'installUntilYourNextTurnTrigger',
        params: {
          condition: { on: 'creatureAttacks', who },
          effects: stamped,
          label: `Until your next turn: a creature (${who}) attacks — ${body}`,
        },
      });
    },
  },
  {
    id: 'reveal-opponent-splits-piles',
    description:
      '"Reveal the top N cards of your library. An opponent separates those cards into two piles. Put one pile into your hand and the other DESTINATION." (Jace, Architect of Thought’s −2; Fact or Fiction)',
    /**
     * ONE whole-line idiom, not three sentences: the second and third are
     * meaningless without the reveal the first made, exactly as
     * `pile-split-sacrifice` is one line rather than two.
     *
     * ⚠️ §3.150 filed this clause as "a prompt-seam question" — whether the
     * engine can ask a NON-CONTROLLING player something mid-resolution at all.
     * It can, and it already did: `pileSplitSacrifice` has asked its VICTIM
     * which pile to sacrifice since Liliana's −6 landed. So the residue was
     * never the seam; it was this sentence and the DESTINATION table below.
     *
     * The destination is data ({@link PILE_REST_DESTINATIONS}) because two
     * printed cards give the leftover pile two different homes, and a branch per
     * card is how the next one becomes a code change instead of a row.
     */
    pattern: new RegExp(
      `^reveal the top ${COUNT_TOKEN} cards of your library\\. an opponent separates those cards into two piles\\. ` +
        `put one pile into your hand and the other (${Object.keys(PILE_REST_DESTINATIONS).join('|')})$`,
    ),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null || count <= 0) return null;
      const rest = PILE_REST_DESTINATIONS[(match[2] ?? '').trim()];
      if (rest === undefined) return null;
      return effects({ primitive: 'revealAndOpponentSplitsPiles', params: { count, rest } });
    },
  },
  {
    id: 'return-triggering-card-to-hand',
    description:
      '"Return it to your hand" — the card a graveyard trigger was about (the Moon Sage emblem)',
    /**
     * "IT" is the card the TRIGGER's event was about, not a target and not the
     * source. That referent only exists inside a trigger whose condition asked
     * for it (`carriesSubject`), which is why the rule that installs the trigger
     * detects this primitive by name and sets the flag — `readsTriggeringCard`.
     *
     * ⚠️ `needsChosenTarget` is deliberately ABSENT and must stay absent: this
     * body needs no target, and it is compiled from inside a trigger, where the
     * target-free table is the one in force. Adding the flag would make the
     * emblem's own body unreachable from the emblem's own trigger.
     */
    pattern: /^return it to your hand$/,
    build() {
      return effects({ primitive: RETURN_TRIGGERING_CARD_TO_HAND });
    },
  },
  {
    id: 'draw-for-each-targeted',
    description:
      '"Draw a card for each tapped creature target player controls." (Tamiyo, the Moon Sage\'s −2)',
    /**
     * The same sentence as `draw-for-each` below with ONE difference that has to
     * be a different rule: the count's subject is a TARGET, so the card must
     * actually aim at a player. `needsChosenTarget` is a static flag, and
     * setting it on `draw-for-each` would refuse Shamanic Revelation's plain
     * "draw a card for each creature you control" inside every trigger body —
     * so the targeting form is its own row, ABOVE the plain one, reading the
     * table the plain one deliberately cannot see.
     *
     * The target restriction is what makes the printed word "target" true:
     * without it the resolution carries no player target, `playersForParam`
     * falls back to the controller, and the card counts the wrong board with
     * nothing to notice.
     */
    pattern: new RegExp(`^${OPTIONAL_YOU}draw a card for each ${TARGETED_EACH_PHRASE}$`),
    needsChosenTarget: true,
    build(match) {
      const count = targetedEachValue(match[1] ?? '');
      if (!count) return null;
      return effects({ primitive: 'drawCards', params: { count, targets: PLAYER_TARGET } });
    },
  },
  {
    id: 'draw-for-each',
    description: '"Draw a card for each X" — the draw half of Shamanic Revelation',
    // Same shape, same restriction as `gain-life-for-each`: one card PER thing
    // counted, never two — a `DerivedValue` has no multiplier to carry.
    pattern: new RegExp(`^${OPTIONAL_YOU}draw a card for each ${DERIVED_EACH_PHRASE}$`),
    build(match) {
      const count = derivedEachValue(match[1] ?? '');
      if (!count) return null;
      return effects({ primitive: 'drawCards', params: { count } });
    },
  },
  {
    id: 'gain-life-equal-to-count',
    description: '"[You] gain life equal to the number of X"',
    pattern: new RegExp(`^${OPTIONAL_YOU}gain life equal to the number of ${DERIVED_PHRASE}$`),
    build(match) {
      const amount = derivedValue(match[1]!);
      if (!amount) return null;
      return effects({ primitive: 'gainLife', params: { amount } });
    },
  },
  {
    /**
     * "~ deals **X** damage to <TARGET>" — the X spelling of `damage-any-target`
     * above. The two are one sentence written twice, and the right fix is one
     * rule over the shared AMOUNT token; see that rule's note for why §3.149
     * did not make it (the id is a witness in `apps/web`, which this lane does
     * not own). The AMOUNT it reads is {@link xParamValue}'s, so all three
     * sources of an X — cast cost, activation cost, `where X is …` — reach it.
     */
    id: 'x-damage',
    description:
      '"~ deals X damage to <TARGET>" — X from the cast cost, the activation cost, or a "where X is …" clause',
    pattern: new RegExp(`^~ deals x damage to ${DAMAGE_TARGET_PHRASE}$`),
    needsChosenTarget: true,
    build(match, ctx) {
      const amount = xParamValue(ctx);
      const restriction = damageRestriction(match[1] ?? '');
      if (amount === null || restriction === null) return null;
      return effects({ primitive: 'dealDamage', params: damageParams(amount as never, restriction) });
    },
  },
  {
    id: 'x-draw',
    description:
      '"[You] draw X cards" — X is the value chosen at cast time (Mind Spring) or at activation time (Bruce Banner)',
    pattern: new RegExp(`^${OPTIONAL_YOU}draw x cards$`),
    build(_match, ctx) {
      const count = xParamValue(ctx);
      if (count === null) return null;
      return effects({ primitive: 'drawCards', params: { count } });
    },
  },
  {
    id: 'x-gain-life',
    description:
      '"[You] gain X life" — X is the value chosen at cast time, or at activation time (Oracle of Nectars)',
    pattern: new RegExp(`^${OPTIONAL_YOU}gain x life$`),
    build(_match, ctx) {
      const amount = xParamValue(ctx);
      if (amount === null) return null;
      return effects({ primitive: 'gainLife', params: { amount } });
    },
  },
  // ===========================================================================
  // === OBJECT-CHARACTERISTIC AMOUNTS (DESIGN §3.149) =========================
  // ===========================================================================
  //
  // "…equal to THAT CREATURE'S toughness" / "…equal to ~'S POWER" — the third
  // printed spelling of a variable amount, beside `{X}` and "equal to the
  // number of …". All of these emit one descriptor
  // ({@link ObjectCharacteristicValue}) read at the ONE `intParam` seam, so
  // life, draws and damage learned it in a single edit and cannot disagree
  // about what "that creature's toughness" means.
  //
  // ⚠️ ONLY THE SPELLINGS WHOSE OBJECT IS STILL ON THE BATTLEFIELD are here.
  // "When ~ **dies**, you gain life equal to its power", "**Destroy** target
  // creature. You lose life equal to that creature's toughness" and "equal to
  // **the sacrificed** creature's power" all mean CR 608.2h LAST KNOWN
  // INFORMATION, and this engine keeps no LKI snapshot of P/T — so they keep
  // reporting rather than compiling into a silent zero. `xvalue-templates.test.ts`
  // pins one card per refused family with the reason.
  {
    id: 'object-characteristic-gain-lose-life',
    description:
      '"[You] gain/lose life equal to THAT CREATURE\'S / ~\'S power|toughness|mana value" (Trostani, Angelic Chorus, Wolverine Riders)',
    pattern: new RegExp(`^${OPTIONAL_YOU}(gain|lose) life equal to ${OBJECT_CHARACTERISTIC_PHRASE}$`),
    build(match, ctx) {
      const amount = objectCharacteristic(match[2]!, match[3]!, ctx);
      if (!amount) return null;
      return effects({
        primitive: match[1] === 'gain' ? 'gainLife' : 'loseLife',
        params: { amount },
      });
    },
  },
  {
    id: 'object-characteristic-draw',
    description: '"Draw cards equal to ~\'S / THAT CREATURE\'S power" (Gregor, Shrewd Magistrate)',
    pattern: new RegExp(`^${OPTIONAL_YOU}draw cards equal to ${OBJECT_CHARACTERISTIC_PHRASE}$`),
    build(match, ctx) {
      const count = objectCharacteristic(match[1]!, match[2]!, ctx);
      if (!count) return null;
      return effects({ primitive: 'drawCards', params: { count } });
    },
  },
  {
    id: 'object-characteristic-damage',
    description:
      '"~ deals damage equal to ITS power to <TARGET>" (Spikeshot Goblin, Spikeshot Elder, Sif\'s Spearmaster)',
    // The printed order is amount-then-recipient here and recipient-then-amount
    // in `damage-equal-to-count`; both orders are real and both route to the one
    // `dealDamage` ref, so the recipient table is read once either way.
    //
    // "ITS" is accepted HERE and nowhere else in this family, and the PATTERN is
    // what earns it: the sentence names its dealer, `~`, before the word, so the
    // referent is printed rather than inferred. The dangerous sibling — "TARGET
    // CREATURE YOU CONTROL deals damage equal to its power to …", where "its"
    // is the first target — does not match this pattern and keeps reporting.
    pattern: new RegExp(
      `^~ deals damage equal to (~'s|its) (${OBJECT_CHARACTERISTIC_WORD_PHRASE}) to ${DAMAGE_TARGET_PHRASE}$`,
    ),
    needsChosenTarget: true,
    build(match, ctx) {
      const amount = objectCharacteristic(match[1] === 'its' ? "~'s" : match[1]!, match[2]!, ctx);
      const restriction = damageRestriction(match[3] ?? '');
      if (!amount || restriction === null) return null;
      return effects({ primitive: 'dealDamage', params: damageParams(amount as never, restriction) });
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
    description:
      '"That player loses N life" / "have that player lose N life" (Suture Priest, Blood Seeker) — a trigger body aimed at the TRIGGERING player',
    // TWO printed spellings of ONE clause, so ONE rule. The causative "have that
    // player lose 1 life" is what a card prints when the sentence needs a verb
    // the controller performs (it is always printed under a "you may"); the loss
    // it causes is the same loss, aimed at the same seat. A second rule would be
    // a second answer to the question of what "that player" means.
    pattern: new RegExp(`^(?:that player loses|have that player lose) ${COUNT_TOKEN} life$`),
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
    pattern: new RegExp(`^each opponent loses ${AMOUNT_TOKEN} life$`),
    build(match, ctx) {
      const amount = parseAmount(match[1], ctx);
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
    description: '"[You] gain N life" (Soul Warden prints the subject; Soul\'s Attendant\'s "you may gain 1 life" reaches here without it)',
    pattern: new RegExp(`^${OPTIONAL_YOU}gain ${COUNT_TOKEN} life$`),
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null ? null : effects({ primitive: 'gainLife', params: { amount } });
    },
  },
  {
    id: 'you-lose-life',
    description: '"[You] lose N life"',
    pattern: new RegExp(`^${OPTIONAL_YOU}lose ${COUNT_TOKEN} life$`),
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
      `^choose\\s+(${MODAL_HEADER_PHRASE})( that hasn't been chosen(?: this turn)?)?\\s*\\.?\\s*(?:(${REPEATED_MODES_PHRASE})\\s*\\.?\\s*)?[—-]\\s*(•.+)$`,
    ),
    build(match, ctx) {
      const counts = MODAL_HEADER_COUNTS[match[1]!.toLowerCase()];
      if (counts === undefined) return null;
      // "…that hasn't been chosen THIS TURN" is a per-permanent memory the
      // engine keeps (`CardInstance.modesChosenThisTurn`). The TURNLESS form
      // is a game-long memory nothing models, so it refuses rather than
      // silently resetting every turn — a strictly wider card.
      const memory = match[2]?.trim();
      if (memory !== undefined && !memory.endsWith('this turn')) return null;
      const notChosenThisTurn = memory !== undefined;
      const allowRepeats = match[3] !== undefined;

      const bodies = match[4]!
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
          ...(notChosenThisTurn ? { notChosenThisTurn: true } : {}),
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
    id: 'destroy-target-simple-permanent',
    description:
      `"Destroy target <NOUN>" for every noun in TARGET_NOUN_RESTRICTIONS (Stone Rain, Naturalize, Hero's Downfall, Go for the Throat, Putrefy, Mortify, Void Rend)`,
    // ONE rule over the shared noun table: the printed word is the whole of what
    // may be aimed at, and adding the next noun is a row in that table rather
    // than a new alternation here.
    pattern: new RegExp(`^destroy target (${TARGET_NOUN_PHRASE})$`),
    needsChosenTarget: true,
    build(match) {
      const kind = TARGET_NOUN_RESTRICTIONS[match[1] ?? ''];
      return kind === undefined ? null : effects({ primitive: 'destroyTarget', params: { targets: kind } });
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
  // --- the counter keyword family (DESIGN §3.110) — the keyword ACTIONS ------------
  {
    // AMASS [type] N (CR 701.47a) — "Put N +1/+1 counters on an Army you
    // control. It's also a [type]. If you don't control an Army, create a 0/0
    // black [type] Army creature token first." The type word is a row of the
    // closed `AMASS_ARMY_TYPES` table; "Amass Orcs X" reads the cast-time X
    // only on a card that prints {X} in its cost, like every other X rule.
    id: 'amass',
    description: '"Amass Orcs N" / "Amass Zombies X" — grow an Army you control, making one first if you have none',
    pattern: /^amass ([a-z]+) (?:([0-9]+)|x)$/,
    build(match, ctx) {
      const subtype = AMASS_ARMY_TYPES[match[1] ?? ''];
      if (subtype === undefined) return null;
      if (match[2] === undefined) {
        const amount = xParamValue(ctx);
        if (amount === null) return null;
        return effects({ primitive: 'amass', params: { subtype, amount } });
      }
      const amount = Number.parseInt(match[2], 10);
      if (!Number.isFinite(amount)) return null;
      return effects({ primitive: 'amass', params: { subtype, amount } });
    },
  },
  {
    // BOLSTER N (CR 701.39a) — "Choose a creature with the least toughness
    // among creatures you control and put N +1/+1 counters on it." "Bolster X,
    // where X is …" defines X by a clause this table does not read: reports.
    id: 'bolster',
    description: '"Bolster N" — N +1/+1 counters on your least-toughness creature',
    pattern: /^bolster ([0-9]+)$/,
    build(match) {
      const amount = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(amount)) return null;
      return effects({ primitive: 'bolster', params: { amount } });
    },
  },
  {
    // EXPLORE (CR 701.44a) — "it explores" / "~ explores": reveal the top card;
    // a land goes to hand, otherwise a +1/+1 counter and an optional bin. The
    // self form only — "target creature explores" would need the explorer as a
    // target, which no printed body in the measured set prints.
    id: 'explore-self',
    description: '"~ explores" / "it explores" — the source explores (CR 701.44)',
    pattern: /^(?:~|it|this creature) explores$/,
    build() {
      return effects({ primitive: 'explore' });
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
      `^put (?:a|${COUNT_TOKEN}) \\+1/\\+1 counters? on (~|it|this creature)$`,
    ),
    build(match, ctx) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      // §3.151 — THE BARE-"IT" GATE, landed with the pool regeneration that
      // made it landable. A bare "it" is only the SOURCE when the source is a
      // thing that can carry counters; on an instant or sorcery "it" is the
      // previous sentence's target, and compiling that as a self-counter makes
      // the card do something it does not print.
      //
      // This gate could not land alone. It refuses the clause on Big Play and
      // Miraculous Recovery, both rules-defective in the shipped pool, and
      // `pool-mechanics.test.ts`'s round-trip guard is absolute by design — its
      // own comment says "a card dropped from the pool to make a test pass is
      // the failure mode this guards". So the fix and the regeneration are one
      // change: the two cards leave the pool as a CORRECTION, not a regression.
      //
      // The named-counter sibling (line ~5601) carries the same gate for the
      // same reason — one question, one answer (rule 12).
      if (!sourceCanHoldCounters(ctx)) return null;
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
    id: 'put-counters-on-each-then-grant',
    description:
      '"Put a +1/+1 counter on each creature you control. Those creatures gain KEYWORDS until end of turn." (Felidar Retreat)',
    // ONE rule for the sentence pair because "those creatures" is the previous
    // sentence's set — and both sets are read off the board at the SAME
    // resolution moment, so "each creature you control" twice IS the printed
    // meaning, exactly (nothing can enter or leave between the two).
    pattern: /^put a (\+1\/\+1) counter on each creature you control\. those creatures gain (.+) until end of turn$/,
    build(match) {
      const keywords = parseKeywordList(match[2] ?? '');
      if (keywords === null) return null;
      return effects(
        { primitive: 'addCounters', params: { amount: 1, each: true, scope: 'you' } },
        { primitive: 'grantKeywordToYoursUntilEndOfTurn', params: { keywords, anyOfTypes: ['creature'] } },
      );
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
    description:
      '"Return target <NOUN> to its owner\'s hand" (bounce) for every noun in TARGET_NOUN_RESTRICTIONS (Unsummon, Boomerang, Stingscourger)',
    pattern: new RegExp(`^return target (${TARGET_NOUN_PHRASE}) to (?:its|their) owner'?s hand$`),
    needsChosenTarget: true,
    build(match) {
      // `returnToHand` has existed in the primitive library the whole time with
      // no rule able to reach it — bounce was reported unsupported purely for
      // want of this pattern.
      //
      // §3.148 — the noun comes from the SHARED table now, not from a private
      // `(creature|permanent)` alternation. Bounce is a removal verb like
      // destroy and exile, it prints the same noun vocabulary, and keeping a
      // second list meant "target creature an opponent controls" was understood
      // by two verbs and refused by the third: one answer, one question (rule
      // 12). "Target PERMANENT" is still its own restriction and is NOT
      // flattened to "creature" — Cryptic Command bounces a land, and a bounce
      // that could not would be a strictly weaker card than printed.
      const restriction = TARGET_NOUN_RESTRICTIONS[match[1] ?? ''];
      if (restriction === undefined) return null;
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
    /**
     * "Target player mills **X** cards", with or without a where-clause — the X of the
     * card's own `{X}` cost (Traumatize's cousins) or of the ACTIVATION cost
     * that put this body on the stack, "{X}, {T}: Target player mills X cards"
     * (Sands of Delirium, Whetwheel). §3.149.
     *
     * Its own rule rather than an `x` row inside {@link COUNT_TOKEN}, because
     * the two need different gates: a plain number is always readable and an X
     * is only readable when something bound it ({@link xParamValue}).
     *
     * It REPLACED a second rule that spelled out "…, where X is the number of
     * <COUNT>" for Doorkeeper alone. The where-clause is now stripped by the
     * binding pre-pass in `applyRules` before any rule sees the sentence, so
     * Doorkeeper and Sands of Delirium reach the same rule with the same X — two
     * rules for one question was exactly the drift rule 12 warns about.
     */
    id: 'target-player-mills-x',
    description: '"Target player mills X cards" (Doorkeeper, Sands of Delirium, Whetwheel)',
    pattern: /^target (player|opponent) mills x cards?$/,
    needsChosenTarget: true,
    build(_match, ctx) {
      const amount = xParamValue(ctx);
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
    pattern: new RegExp(`^~ deals ${AMOUNT_TOKEN} damage to each creature$`),
    build(match, ctx) {
      const amount = parseAmount(match[1], ctx);
      if (amount === null) return null;
      return effects({ primitive: 'dealDamageToEach', params: { amount, creatures: true } });
    },
  },
  {
    id: 'damage-to-each-opponent',
    description: '"~ deals N damage to each opponent"',
    pattern: new RegExp(`^~ deals ${AMOUNT_TOKEN} damage to each opponent$`),
    build(match, ctx) {
      const amount = parseAmount(match[1], ctx);
      if (amount === null) return null;
      return effects({ primitive: 'dealDamageToEach', params: { amount, opponents: true } });
    },
  },
  {
    id: 'damage-to-each-creature-and-player',
    description: '"~ deals N damage to each creature and each player"',
    pattern: new RegExp(`^~ deals ${AMOUNT_TOKEN} damage to each creature and each player$`),
    build(match, ctx) {
      const amount = parseAmount(match[1], ctx);
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
    id: 'destroy-target-artifact-enchantment-or-land',
    description: '"Destroy target artifact, enchantment, or land" (Acidic Slime, the naturalize family)',
    /*
     * One target with three acceptable types, which is why it is one restriction
     * rather than three rules. Written to accept the Oracle comma-or spelling
     * with and without the serial comma, because both printings exist.
     */
    pattern: /^destroy target artifact,? enchantment,? or land$/,
    needsChosenTarget: true,
    build() {
      return effects({
        primitive: 'destroyTarget',
        params: { targets: ARTIFACT_ENCHANTMENT_OR_LAND_TARGET },
      });
    },
  },
  {
    id: 'return-exiled-by-this-to-battlefield',
    description:
      'Return the exiled card to the battlefield under its owner’s control (the second half of Fiend Hunter)',
    /*
     * The other half of an O-Ring. It names no target: what comes back is
     * whatever THIS permanent exiled, which the exile half recorded. Accepts the
     * singular and plural printings so Angel of Serenity's "cards" reads too.
     */
    pattern: RETURN_EXILED_TO_BATTLEFIELD,
    build() {
      return effects({ primitive: 'returnExiledByThis', params: { to: 'battlefield' } });
    },
  },
  {
    id: 'return-exiled-by-this-to-hand',
    description: 'Return the exiled cards to their owners’ hands (Angel of Serenity)',
    pattern: RETURN_EXILED_TO_HAND,
    build() {
      return effects({ primitive: 'returnExiledByThis', params: { to: 'hand' } });
    },
  },
  {
    id: 'exile-target-creature',
    description:
      '"Exile target <NOUN>" for every noun in TARGET_NOUN_RESTRICTIONS (Utter End)',
    // Reads the SAME shared noun table the destroy family does, which is the
    // whole reason that table exists: a noun added for one verb is understood
    // by the other in the same edit, and the two verbs can never drift into
    // meaning different things by "artifact or creature".
    pattern: new RegExp(`^exile target (${TARGET_NOUN_PHRASE})$`),
    needsChosenTarget: true,
    build(match) {
      const kind = TARGET_NOUN_RESTRICTIONS[match[1] ?? ''];
      return kind === undefined ? null : effects({ primitive: 'exileTarget', params: { targets: kind } });
    },
  },
  {
    id: 'blink-target-non-angel-creature-you-control',
    description:
      '"Exile target non-Angel creature you control, then return that card to the battlefield under your control" (Restoration Angel)',
    /*
     * Restoration Angel's printed line, and the exclusion is load-bearing rather
     * than flavour: the Angel is itself a creature you control, so a blink that
     * could name it would re-trigger its own enters ability for ever. See
     * `TargetRestriction.nonAngelCreatureYouControl`.
     */
    pattern:
      /^exile target non-angel creature you control, then return (?:that card|it) to the battlefield under your control$/,
    needsChosenTarget: true,
    build() {
      return effects({
        primitive: 'blinkTarget',
        params: { targets: NON_ANGEL_CREATURE_YOU_CONTROL_TARGET },
      });
    },
  },
  {
    id: 'blink-target-creature-you-control',
    description:
      '"Exile target creature you control, then return that card to the battlefield under your control" (blink)',
    /*
     * ONE rule, three cards, because the two wrappers already exist: the step
     * prefix ("At the beginning of your end step, …") makes it Conjurer's Closet
     * and the `you may` wrapper makes it optional, while the bare clause is
     * Cloudshift. Written against the printed comma-then form rather than as two
     * chained clauses (exile + return) on purpose — "then return **that card**"
     * is one effect on one object, and splitting it would let the exile half
     * resolve while the return half found nothing.
     *
     * `it` is accepted alongside `that card` because Oracle has used both
     * wordings for the same effect over the years, and a rule that matched only
     * today's phrasing would silently reject the other printing.
     */
    // "up to one" (Thassa, Teleportation Circle) rides the ref as `upToTargets`
    // — the trigger-body compiler lifts it onto the ability as a `targetCount`
    // of 0..1, so declining is a real answer. "other" is the same
    // `excludeSelf` lift Extravagant Replication uses. "under its owner's
    // control" (Teleportation Circle) is a DIFFERENT return for a permanent you
    // control but do not own, carried as `ownerControl` — see `blinkOne`.
    pattern:
      /^exile (up to one )?(other )?target (creature|artifact or creature) you control, then return (?:that card|it) to the battlefield under (your|its owner's) control$/,
    needsChosenTarget: true,
    build(match) {
      const restriction =
        match[3] === 'artifact or creature' ? ARTIFACT_OR_CREATURE_YOU_CONTROL_TARGET : CREATURE_YOU_CONTROL_TARGET;
      return effects({
        primitive: 'blinkTarget',
        params: {
          targets: restriction,
          ...(match[1] !== undefined ? { upToTargets: 1 } : {}),
          ...(match[2] !== undefined ? { excludeSelf: true } : {}),
          ...(match[4] === "its owner's" ? { ownerControl: true } : {}),
        },
      });
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
    id: 'copy-target-triggered-ability',
    description:
      '"Copy target triggered ability you control. You may choose new targets for the copy." (Strionic Resonator) — CR 707.10',
    /*
     * The OTHER kind of stack object. Written beside the spell-copy rule and in
     * the same shape — the trailing "you may choose new targets" sentence is an
     * optional capture rather than a second rule, because CR 707.10 attaches it
     * to the copy itself and the primitive implements it either way.
     *
     * The activation cost is NOT part of this pattern: the generic activated
     * -ability compiler has already split `{2}, {T}:` off the front and handed
     * this rule only the effect. A rule that re-parsed the cost would work for
     * Strionic Resonator and fail for the next card that prints the ability at a
     * different price.
     */
    pattern:
      /^copy target triggered ability you control(\. you may choose new targets for the copy)?$/,
    needsChosenTarget: true,
    build() {
      return effects({
        primitive: 'copyTriggeredAbility',
        params: { targets: TRIGGERED_ABILITY_YOU_CONTROL_TARGET, count: 1 },
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
    id: 'copy-target-spell-you-control',
    description:
      '"Copy target instant or sorcery spell you control. You may choose new targets for the copy." (Lithoform Engine, Kitsa)',
    // The controller scope is the whole card: widening it to any spell would let
    // a pilot fork the opponent's removal, which the printed text cannot do.
    pattern:
      /^copy target instant or sorcery spell you control(\. you may choose new targets for the copy)?$/,
    needsChosenTarget: true,
    build(match) {
      return effects({
        primitive: 'copySpell',
        params: {
          targets: INSTANT_OR_SORCERY_SPELL_YOU_CONTROL_TARGET,
          mayRetarget: match[1] !== undefined,
        },
      });
    },
  },
  {
    id: 'copy-target-permanent-spell-you-control',
    description:
      '"Copy target permanent spell you control. (The copy becomes a token.)" (Lithoform Engine) — CR 707.10a',
    // The reminder sentence is reminder text and has already been stripped; the
    // token-ness it reminds about is `spell-copy.ts`'s own behaviour for every
    // permanent-spell copy, so this rule adds nothing but the restriction.
    pattern:
      /^copy target permanent spell you control(\. you may choose new targets for the copy)?$/,
    needsChosenTarget: true,
    build(match) {
      return effects({
        primitive: 'copySpell',
        params: {
          targets: PERMANENT_SPELL_YOU_CONTROL_TARGET,
          mayRetarget: match[1] !== undefined,
        },
      });
    },
  },
  {
    id: 'copy-target-activated-or-triggered-ability',
    description:
      '"Copy target activated or triggered ability you control. You may choose new targets for the copy." (Lithoform Engine) — CR 707.10',
    // Both kinds sit on the stack as one object kind here, so the primitive is
    // the SAME one Strionic Resonator uses — what differs is only the
    // restriction, which accepts the `origin: 'activated'` objects the
    // triggered-only wording must refuse.
    pattern:
      /^copy target activated or triggered ability you control(\. you may choose new targets for the copy)?$/,
    needsChosenTarget: true,
    build() {
      return effects({
        primitive: 'copyTriggeredAbility',
        params: { targets: ACTIVATED_OR_TRIGGERED_ABILITY_YOU_CONTROL_TARGET, count: 1 },
      });
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
    // "a TAPPED token that's a copy" (Kambal) / "two tapped tokens that are
    // copies" (Skyclave Relic): the adjective becomes the same `entersTapped`
    // exception Vesuva's printed "enter tapped" already uses, so tapped-ness has
    // one meaning across every copy the compiler makes.
    pattern:
      /^create (a|an|one|two|three|four|five) (tapped )?(?:tokens? that's a copy|tokens that are copies) of (.+)$/,
    build(match, ctx) {
      return buildTokenCopy(match[1] ?? 'a', match[3] ?? '', ctx, match[2] !== undefined);
    },
  },
  {
    id: 'for-each-token-copy',
    description:
      `"For each token you control, create a token that's a copy of that permanent." (Second Harvest) — CR 707.2, one copy per original`,
    // An ITERATION, not a target: no aiming step, one copy of EACH matching
    // permanent. The primitive snapshots the match list before creating
    // anything, so the copies are never themselves copied.
    pattern: /^for each token you control, create a token that's a copy of that permanent$/,
    build() {
      return effects({ primitive: 'createTokenCopy', params: { forEachTokenYouControl: true } });
    },
  },
  {
    id: 'create-token-conditional-instead',
    description:
      `"Create <token>. If you control N or more <noun>, create <other token> instead." (Scute Swarm) — a resolution-time substitution`,
    // The word "instead" makes the two sentences ONE instruction: exactly one
    // branch runs, decided as the ability resolves. Both halves must themselves
    // compile — a half this table cannot read reports the whole line, never a
    // card that always (or never) makes the better token.
    pattern: new RegExp(`^(create .+?)\\. if you control ${COUNT_TOKEN} or more ([a-z]+?)s?, (create .+?) instead$`),
    build(match, ctx) {
      const min = parseCount(match[2]);
      const filter = searchFilterFrom(match[3] ?? '');
      if (min === null || filter === null) return null;
      // Target-free by construction: the substitute runs inside a resolution
      // with no aiming step of its own, so a targeted half would aim at nothing.
      const base = ctx.compileEffectClause(match[1]!, { targetFree: true });
      const instead = ctx.compileEffectClause(match[4]!, { targetFree: true });
      if (!base || base.length === 0 || !instead || instead.length === 0) return null;
      return effects({
        primitive: 'substituteIf',
        params: {
          condition: { kind: 'controlCount', filter, min },
          effects: [...instead],
          otherwise: [...base],
        },
      });
    },
  },
  {
    id: 'return-chosen-land-you-control',
    description:
      '"Return a land you control to its owner\'s hand" (the karoo lands\' ETB) — a chosen permanent, not a target',
    // No printed "target", so this is a resolution-time CHOICE by the
    // controller — which is exactly what lets it sit inside a trigger with no
    // aiming step, and what makes bouncing the karoo itself legal.
    pattern: /^return an? (land|creature|permanent) you control to its owner's hand$/,
    build(match) {
      const noun = match[1] ?? '';
      const filter =
        noun === 'permanent' ? {} : { anyOfTypes: [noun as CardType] };
      return effects({
        primitive: 'returnChosenToHand',
        params: { count: 1, ...(Object.keys(filter).length > 0 ? { filter } : {}) },
      });
    },
  },
  {
    id: 'counter-target-spell',
    description: '"Counter target spell / noncreature spell / instant spell / instant or sorcery spell" (Cancel, Negate, Dispel, Muddle the Mixture)',
    // Same shared-table discipline as the destroy family one table up: the
    // printed spell noun decides what may be countered, and a noun outside the
    // table reports rather than being widened to "any spell".
    pattern: new RegExp(`^counter target (${COUNTER_NOUN_PHRASE})$`),
    needsChosenTarget: true,
    build(match) {
      const kind = COUNTER_NOUN_RESTRICTIONS[match[1] ?? ''];
      return kind === undefined ? null : effects({ primitive: 'counterSpell', params: { targets: kind } });
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
    description:
      '"Target creature gets +X/+Y until end of turn" / "Target ATTACKING creature gets +X/+Y until end of turn" (§3.112 — every bloodrush line)',
    // The NOUN is a row in `PUMP_TARGET_NOUNS`, not a second nearly identical
    // rule: bloodrush prints exactly this sentence with one word more, and a
    // copy of the rule for it is the thing that drifts.
    pattern: new RegExp(`^target (${PUMP_TARGET_PHRASE}) gets ${PUMP_AMOUNT}\\/${PUMP_AMOUNT} until end of turn$`),
    needsChosenTarget: true,
    build(match, ctx) {
      const restriction = PUMP_TARGET_NOUNS[(match[1] ?? '').trim()];
      const power = parsePumpAmount(match[2] ?? '', ctx);
      const toughness = parsePumpAmount(match[3] ?? '', ctx);
      if (restriction === undefined || power === null || toughness === null) return null;
      return effects({
        primitive: 'pumpUntilEndOfTurn',
        params: { power, toughness, targets: restriction },
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
      const power = parseSignedInt(match[1] ?? '');
      const toughness = parseSignedInt(match[2] ?? '');
      if (!Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      return effects({ primitive: 'pumpUntilEndOfTurn', params: { power, toughness } });
    },
  },
  {
    id: 'pump-and-grant-until-eot',
    description:
      '"Target creature gets +X/+Y and gains KEYWORD until end of turn" — and the ATTACKING form (§3.112: "Bloodrush — {R}{G}, Discard this card: Target attacking creature gets +4/+4 and gains trample")',
    pattern: new RegExp(
      `^target (${PUMP_TARGET_PHRASE}) gets ${PUMP_AMOUNT}\\/${PUMP_AMOUNT} and gains ${KEYWORD_TOKEN} until end of turn$`,
    ),
    needsChosenTarget: true,
    build(match, ctx) {
      const restriction = PUMP_TARGET_NOUNS[(match[1] ?? '').trim()];
      const power = parsePumpAmount(match[2] ?? '', ctx);
      const toughness = parsePumpAmount(match[3] ?? '', ctx);
      const keywords = keywordFlag(match[4] ?? '');
      if (restriction === undefined || power === null || toughness === null || !keywords) return null;
      return effects(
        { primitive: 'pumpUntilEndOfTurn', params: { power, toughness, targets: restriction } },
        { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords, targets: restriction } },
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
    id: 'tap-target-noun',
    description:
      `"Tap target <NOUN>" for every noun in UNTAP_TARGET_NOUNS (Auriok Transfixer, Relic Barrier, Icy Manipulator)`,
    // The tap half of the untap family, off the SAME noun table: a printed
    // ability that can tap an artifact and one that can untap it name the same
    // set of things, so one row serves both verbs (DESIGN §1.12).
    pattern: new RegExp(`^tap target (${UNTAP_TARGET_NOUN_PHRASE})$`),
    needsChosenTarget: true,
    build(match) {
      const kind = UNTAP_TARGET_NOUNS[match[1] ?? ''];
      return kind === undefined ? null : effects({ primitive: 'tapTarget', params: { targets: kind } });
    },
  },
  {
    id: 'untap-self',
    description: '"Untap ~" (Morphling, Grim Monolith, Staff of Compleation)',
    // No target is named, so this is not `needsChosenTarget`: it works inside a
    // trigger body and inside a granted ability exactly as printed.
    pattern: /^untap ~$/,
    build() {
      return effects({ primitive: 'untapSelf', params: {} });
    },
  },
  {
    id: 'untap-target-noun',
    description:
      `"Untap target <NOUN>" for every noun in UNTAP_TARGET_NOUNS (Arbor Elf, Voltaic Key, Blossom Dryad, Jandor's Saddlebags, Kiora's Follower)`,
    // ONE rule over the noun table, the shape `destroy-target-simple-permanent`
    // established: the printed word is the whole of what may be aimed at, and
    // the next noun is a ROW rather than a new rule.
    pattern: new RegExp(`^untap target (${UNTAP_TARGET_NOUN_PHRASE})$`),
    needsChosenTarget: true,
    build(match) {
      const kind = UNTAP_TARGET_NOUNS[match[1] ?? ''];
      return kind === undefined ? null : effects({ primitive: 'untapTarget', params: { targets: kind } });
    },
  },
  // ⚠️ "Untap ANOTHER target permanent" (Kiora's Follower, Manifold Key) stays
  // REPORTED. Core carries the exclusion for a TRIGGER's aim
  // (`TriggerBodyResult.targetsExcludeSelf`) but an ACTIVATED ability has no
  // field for it, so the only rule that could be written here is one that drops
  // the word "another" — a Kiora's Follower that may untap itself for an
  // arbitrarily large mana loop, which is a card playing wider than printed.
  // The honest move is the empty one until `ActivatedAbility` can say it.
  //
  // ===========================================================================
  // §3.150 — THE DOES-NOT-UNTAP FAMILY, one-shot half (`freezeTarget`).
  //
  // Measured before writing (rule 11): 246 corpus cards print "doesn't untap
  // during", ALL of them blocked, 99 blocked SOLELY by such a clause. Unlike the
  // loyalty row that led here (641 shapes / 668 clauses) these shapes CONCENTRATE.
  //
  // Off the SAME `UNTAP_TARGET_NOUNS` table the tap and untap verbs read — the
  // things an ability may FREEZE are the same things it may tap, and §3.148
  // already put `creature an opponent controls` in that table for the freeze
  // family's ETB printing. One table, three verbs, so the next noun is a ROW.
  //
  // The CONTINUOUS half is not here: "enchanted/equipped creature doesn't untap
  // during its controller's untap step" is ONE ROW in `KEYWORD_PHRASES`, which
  // is what makes the Aura, the Equipment and the "gets +2/+0 AND doesn't untap"
  // printings all work without a rule each.
  // ===========================================================================
  {
    id: 'tap-target-noun-and-freeze',
    description:
      `"Tap target <NOUN>. It doesn't untap during its controller's next untap step" (Ojutai's Breath, Crippling Chill, Tamiyo's +1)`,
    // TWO effects, not one primitive that does both: Skyline Cascade prints the
    // freeze with no tap at all, so a combined primitive would have to carry a
    // "do not actually tap" flag — a parameter that exists only because two
    // printed sentences were forced into one rule.
    //
    // ⚠️ The sentence break is `\\.` — a LITERAL dot. In a template literal a
    // lone `\.` is a non-escape and collapses to `.`, which silently makes the
    // regex match ANY character there: "Tap target creature, it doesn't untap…"
    // and worse would compile. `template-gaps.test.ts` pins the literal form.
    //
    // The second sentence's PRONOUN varies with what was tapped — "It" on
    // Crippling Chill, "That creature" on Frost Trickster's trigger body — and
    // every printing means the object the first sentence just aimed at. A closed
    // alternation rather than `.+`: a pronoun this list does not name might refer
    // to something else entirely, and freezing the wrong permanent is a card
    // playing differently from the one printed.
    pattern: new RegExp(
      `^tap target (${UNTAP_TARGET_NOUN_PHRASE})\\. (?:it|that creature|that permanent|that artifact|that land) doesn'?t untap during its controller'?s next untap step$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const kind = UNTAP_TARGET_NOUNS[match[1] ?? ''];
      if (kind === undefined) return null;
      return effects(
        { primitive: 'tapTarget', params: { targets: kind } },
        // No `targets` on the freeze: both sentences aim at the SAME chosen
        // permanent ("It"), and a second restriction here would let the two
        // halves disagree about what was legal to aim at.
        { primitive: 'freezeTarget', params: {} },
      );
    },
  },
  {
    id: 'freeze-target-noun',
    description:
      `"Target <NOUN> doesn't untap during its controller's next untap step" — the freeze with NO tap (Skyline Cascade, House Guildmage, Elvish Hunter)`,
    pattern: new RegExp(
      `^target (${UNTAP_TARGET_NOUN_PHRASE}) doesn'?t untap during its controller'?s next untap step$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const kind = UNTAP_TARGET_NOUNS[match[1] ?? ''];
      return kind === undefined
        ? null
        : effects({ primitive: 'freezeTarget', params: { targets: kind } });
    },
  },
  // ⚠️ "…during its controller's untap step FOR AS LONG AS you control ~"
  // (Dungeon Geists, Icefall Regent, Ty Lee) stays REPORTED. Its lifetime is
  // neither of the two this family models: it is continuous but radiates onto
  // ANOTHER permanent chosen once, which needs a static whose `affects` names a
  // remembered instance — a thing `StaticAffects` cannot say. Compiling it as
  // the one-shot freeze would unfreeze the creature a turn later while the
  // Dungeon Geists is still on the battlefield, which is a strictly weaker card
  // than the printed one; compiling it as the permanent flag would never
  // unfreeze it at all. Both are wrong in a direction nothing would report.
  // ⚠️ "…doesn't untap during its controller's next TWO untap steps"
  // (Telekinesis) is expressible — `freezeTarget` takes a `count` — but its
  // other two sentences are not, so the card keeps reporting anyway and no rule
  // was written for a line nothing would reach (`dead-rule-sweep`).
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
    // The printed ENTRY WORDS sit between the count and the size — "create two
    // **tapped** 1/1 white Soldier tokens" (Kambal), "a **tapped and attacking**
    // …" (Mobilize) — so they are read as their own group rather than being left
    // to the colour/subtype descriptor, which would refuse the whole line.
    pattern: new RegExp(
      `^create ${COUNT_TOKEN} ((?:tapped(?: and attacking)? )?)(\\d+)\\/(\\d+) ([a-z][a-z ]*?) tokens?(?: with (.+))?$`,
    ),
    build(match) {
      const count = parseCount(match[1]);
      const entry = tokenEntryWords(match[2]);
      const power = parseSignedInt(match[3] ?? '');
      const toughness = parseSignedInt(match[4] ?? '');
      if (count === null || entry === null || !Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      const face = parseTokenFace(match[5] ?? '');
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
      // Likewise written only when the line prints them, so every token-maker
      // already in the pool emits byte-identical data.
      if (entry.tapped) params.tapped = true;
      if (entry.attacking) params.attacking = true;
      if (match[6]) {
        const keywords = parseKeywordList(match[6]);
        if (!keywords) return null;
        params.keywords = keywords;
      }
      return effects({ primitive: 'makeToken', params });
    },
  },
  {
    id: 'exile-graveyard',
    description:
      `"Exile target player's graveyard" (Bojuka Bog, Tormod's Crypt, Rakdos Charm's mode) / "Exile all graveyards" (Scavenger Grounds) / "Exile each opponent's graveyard"`,
    // WHOSE graveyards is the only variable, and it reads the same
    // `whichPlayer` vocabulary every other player-scoped primitive reads — so a
    // printed scope this table does not carry reports, rather than being
    // widened to "everyone's" (which would be a strictly wider card).
    pattern: /^exile (target player's|all|each opponent's|all opponents') graveyards?$/,
    // "target player's" is the only scope that aims; the others name no target.
    needsChosenTarget: false,
    build(match) {
      const printed = match[1] ?? '';
      const whichPlayer =
        printed === "target player's"
          ? 'targetPlayer'
          : printed === 'all'
            ? 'each'
            : 'opponent';
      return effects({
        primitive: 'exileGraveyard',
        params: {
          whichPlayer,
          ...(whichPlayer === 'targetPlayer' ? { targets: PLAYER_TARGET } : {}),
        },
      });
    },
  },
  {
    id: 'regenerate-self',
    description: '"Regenerate ~" — the effect half of the printed regeneration ability (CR 701.15)',
    // The COST half is the ordinary activated-ability cost parser; this is only
    // the effect, so "{B}: Regenerate ~", "{1}{G}: Regenerate ~" and a
    // regeneration inside any other body all compile through one rule.
    pattern: /^regenerate ~$/,
    build() {
      return effects({ primitive: 'regenerate' });
    },
  },
  {
    id: 'proliferate',
    description:
      '"Proliferate" (CR 701.27) — permanents only, which is EXACT here: this engine gives players no counter record at all',
    pattern: /^proliferate$/,
    build() {
      return effects({ primitive: 'proliferate' });
    },
  },
  // =========================================================================
  // POPULATE (CR 701.32) — the copy-selector family's one keyword action.
  // Written as ONE bounded block beside its sibling keyword actions; nothing
  // around it is re-ordered. See `populateSourceFor` in `../copy-primitives.ts`
  // for why populate is a SELECTOR on `createTokenCopy` and not a primitive.
  // =========================================================================
  {
    id: 'populate',
    description:
      '"Populate" (CR 701.32a) — choose a creature token you control and create a token that\'s a copy of it (Trostani, Selesnya\'s Voice; Wake the Reflections; Growing Ranks; Vitu-Ghazi Guildmage; Song of the Worldsoul)',
    /**
     * The bare keyword, which is the whole printed clause on every card that
     * prints it alone — the reminder text that spells it out is removed by
     * `stripReminderText` before any rule is tried, so what reaches the table is
     * the single word.
     *
     * ⚠️ **This is the ONLY home for populate's selector, and deliberately not a
     * row in `TOKEN_COPY_SELECTORS`.** That table maps printed SELECTOR TEXT to
     * a lookup, and no card in the corpus prints "a creature token you control"
     * outside reminder text (measured: 0). A row there would be a rule that can
     * never fire — the Gatecreeper Vine class `dead-rule-sweep.mjs` exists to
     * catch — so the selector is named where the printed word that means it is.
     */
    pattern: /^populate$/,
    build() {
      return effects({ primitive: 'createTokenCopy', params: { chooseCreatureTokenYouControl: true, count: 1 } });
    },
  },
  {
    id: 'populate-with-token-tail',
    description:
      '"Populate. The token enters tapped and attacking." (Ghired, Conclave Exile) · "Populate. The token created this way gains haste. Sacrifice it at the beginning of the next end step." (Determined Iteration) — CR 701.32a plus the printed sentences ABOUT the token it made',
    /**
     * The same keyword action, followed by sentences that talk about the object
     * it just created. Separate from the bare rule above only because the bare
     * one is anchored — one rule with an optional tail would match "populate X
     * times" with the tail empty and quietly drop the "X times".
     *
     * ⚠️ Every tail here is read through the vocabulary the TOKEN-COPY family
     * already owns — `TOKEN_COPY_DELAYED_REMOVAL`, `TOKEN_COPY_GRANT_SENTENCE`
     * and `tokenEntryWords` — and NOT through a private copy. These sentences
     * mean the same thing on Kiki-Jiki and on Determined Iteration; two readings
     * would drift the day one of them learns a new wording (rule 12). The params
     * they produce are the ones `createTokenCopy` already honours, so populate
     * gets the haste grant, the delayed sacrifice and the entry words for free.
     *
     * ⚠️ The GRANT stays a layer-6 grant and is NOT folded into the copy — a
     * second copy taken of Determined Iteration's token must not inherit the
     * haste. That distinction is `grantToCreated`'s, and reusing it is how
     * populate inherits it rather than re-deciding it.
     */
    pattern: /^populate\. (.+)$/,
    build(match) {
      let body = `. ${(match[1] ?? '').trim()}`;
      const params: Record<string, unknown> = { chooseCreatureTokenYouControl: true, count: 1 };

      // Parsed from the END, longest-anchored first, in the SAME order
      // `buildTokenCopy` parses them — the delayed removal is the last printed
      // sentence, the grant the one before it.
      const delayed = body.match(TOKEN_COPY_DELAYED_REMOVAL);
      if (delayed) {
        params.delayedRemoval = delayed[1] === 'exile' ? 'exile' : 'sacrifice';
        body = body.slice(0, body.length - (delayed[0] ?? '').length);
      }
      const grant = body.match(TOKEN_COPY_GRANT_SENTENCE);
      if (grant) {
        const flag = KEYWORD_FLAGS[(grant[1] ?? '').trim()];
        if (flag === undefined) return null;
        params.grantKeywords = { [flag]: true };
        if (grant[2] !== undefined) params.grantUntilEndOfTurn = true;
        body = body.slice(0, body.length - (grant[0] ?? '').length);
      }
      // "The token enters tapped and attacking." (Ghired) — the same closed set
      // of entry words a "create a TAPPED token" clause prints before the noun,
      // read by the same function, so a wording nobody has read is REPORTED
      // rather than silently making an untapped token.
      const entry = body.match(TOKEN_COPY_ENTRY_SENTENCE);
      if (entry) {
        const words = tokenEntryWords(entry[1]);
        if (words === null) return null;
        if (words.tapped) params.tapped = true;
        if (words.attacking) params.attacking = true;
        body = body.slice(0, body.length - (entry[0] ?? '').length);
      }
      // Anything the closed tails did not consume is a sentence with no rule.
      if (body.trim().length > 0) return null;
      return effects({ primitive: 'createTokenCopy', params });
    },
  },
  {
    id: 'investigate',
    description: '"Investigate" (CR 701.51) — exactly "create a Clue token", as the rules define it',
    pattern: /^investigate$/,
    build() {
      return effects({ primitive: 'createPredefinedToken', params: { token: 'clue' } });
    },
  },
  {
    id: 'win-the-game',
    description: '"You win the game" (Revel in Riches, Hellkite Tyrant) — CR 104.2a',
    // The sentence alone; the printed condition in front of it is the trigger's
    // intervening "if" (CR 603.4), which the trigger compiler already checks
    // twice. Compiling the sentence unconditionally here is therefore SAFE only
    // because an unreadable condition refuses the whole line before this runs.
    pattern: /^you win the game$/,
    build() {
      return effects({ primitive: 'winTheGame' });
    },
  },
  // --- §3.106 upkeep costs and time counters: the printed templates ------------
  {
    // "Sacrifice ~ unless you pay {COST}" — the body of "At the beginning of
    // your upkeep, sacrifice this creature unless you pay {U}" (Phantasmal
    // Forces, Sunken City, Justice); the step-trigger rule hands the body here.
    // The same pay-or-else the Pact bill uses, with the source declared as
    // the stake so a pilot prices the bill against the permanent.
    id: 'sacrifice-self-unless-paid',
    description: '"Sacrifice ~ unless you pay {COST}"',
    pattern: /^sacrifice ~ unless you pay ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return effects({
        primitive: 'payManaOrElse',
        params: { cost, effects: [{ primitive: 'sacrificeSelf' }], stake: 'source' },
      });
    },
  },
  {
    // The LIFE form — "sacrifice this enchantment unless you pay 2 life"
    // (Season of the Witch). "Unless you pay {1} for each card in your hand"
    // and the non-mana "unless you discard a card / sacrifice a land / return
    // an Island" forms do not match and stay reported.
    id: 'sacrifice-self-unless-life-paid',
    description: '"Sacrifice ~ unless you pay N life"',
    pattern: new RegExp(`^sacrifice ~ unless you pay ${COUNT_TOKEN} life$`),
    build(match) {
      const amount = parseCount(match[1]);
      if (amount === null || amount <= 0) return null;
      return effects({
        primitive: 'payLifeOrElse',
        params: { amount, effects: [{ primitive: 'sacrificeSelf' }] },
      });
    },
  },
  {
    // "Sacrifice ~" as a RESOLUTION effect — "when the token leaves the
    // battlefield, sacrifice this enchantment" (Dance of Many), and the
    // unconditional "at the beginning of your upkeep, sacrifice ~". Distinct
    // from "Sacrifice ~:" the ACTIVATION COST, which the cost parser owns.
    id: 'sacrifice-self',
    description: '"Sacrifice ~" (as an effect)',
    pattern: /^sacrifice ~$/,
    build() {
      return effects({ primitive: 'sacrificeSelf' });
    },
  },
  {
    // "Draw a card at the beginning of the next turn's upkeep." — the Ice Age
    // cantrip rider (Heal, Jolt, Clairvoyance, and "when this Aura enters, draw
    // a card at …" on Ritual of Steel). A DELAYED triggered ability (CR 603.7)
    // on whoever's upkeep comes next (`who: 'any'`), resolving under the
    // caster (CR 603.7d) so the CASTER draws on the opponent's upkeep.
    id: 'draw-at-next-turns-upkeep',
    description: `"Draw N cards at the beginning of the next turn's upkeep"`,
    pattern: new RegExp(`^(?:you )?draw (a|${COUNT_TOKEN}) cards? at the beginning of the next turn'?s upkeep$`),
    build(match) {
      const count = match[1] === 'a' ? 1 : parseCount(match[1]);
      if (count === null || count <= 0) return null;
      return effects({
        primitive: 'scheduleDelayedEffects',
        params: {
          on: 'upkeep',
          who: 'any',
          effects: [{ primitive: 'drawCards', params: { count } }],
          label: `Draw ${count === 1 ? 'a card' : `${count} cards`} at the beginning of the next turn's upkeep`,
        },
      });
    },
  },
  {
    id: 'lose-the-game',
    description: '"You lose the game" (Pact of Negation\'s unpaid upkeep) — CR 104.3a',
    pattern: /^you lose the game$/,
    build() {
      return effects({ primitive: 'loseTheGame' });
    },
  },
  {
    id: 'create-predefined-token',
    description:
      '"Create [N] [tapped] Treasure/Clue/Food token(s)" (CR 111.10) — the rules-defined artifact tokens, as one data lookup',
    // The face is defined by the RULES, not the card, so the whole sentence is
    // a lookup into `PREDEFINED_TOKEN_DEFS` — abilities included. Blood, Map,
    // Incubator and the rest stay OUT of the alternation until their
    // definitions (and the systems those need) exist; matching the noun without
    // the face would create a nameless brick.
    pattern: new RegExp(`^create ${COUNT_TOKEN} (tapped )?(treasure|clue|food) tokens?$`),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null) return null;
      return effects({
        primitive: 'createPredefinedToken',
        params: {
          token: match[3],
          ...(count !== TOKEN_DEFAULT_COUNT ? { count } : {}),
          ...(match[2] !== undefined ? { tapped: true } : {}),
        },
      });
    },
  },
  {
    id: 'life-swing-that-much',
    description:
      '"You gain that much life" / "Target opponent loses that much life" / "Each opponent loses that much life" — the printed "that much" of a life trigger (Exquisite Blood, Vito, Sanguine Bond)',
    // "That much" is the SIZE of the event that set the trigger off, which the
    // ability carries on its resolution (`triggeringAmount`). Emitted as the
    // ordinary derived-value descriptor every numeric param already understands,
    // so no primitive changes and the same word cannot mean two things.
    pattern: new RegExp(`^(${TRIGGERING_AMOUNT_PHRASE})$`),
    build(match) {
      const body = TRIGGERING_AMOUNT_BODIES[match[1] ?? ''];
      if (body === undefined) return null;
      return effects({
        primitive: body.primitive,
        params: { [body.amountKey]: { countOf: 'triggeringAmount' }, ...body.params },
      });
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
    id: 'move-target-from-graveyard',
    description:
      '"Put target creature card from your graveyard on top of your library" (Mortuary Mire) / "Return target creature card from your graveyard to your hand" (Unearth)',
    // TARGETED (an opponent may respond; a card that leaves the yard fizzles
    // it), unlike the chosen `returnFromGraveyard` family — the printed word
    // "target" is the whole difference. ⚠️ Deliberately ONLY the
    // top-of-library form: the "…to your hand" wording (Raise Dead) already
    // compiles through `returnFromGraveyard`, and a whole pool of pilots and
    // fixtures pin that shape — re-routing it to a targeted primitive is its
    // own change, not a rider on this rule.
    pattern:
      /^(?:put target creature card from your graveyard (on top of your library)|(?:return|put) target creature card from your graveyard (?:to|onto) the battlefield)$/,
    needsChosenTarget: true,
    build(match) {
      return effects({
        primitive: 'moveTargetFromGraveyard',
        params: {
          targets: CREATURE_CARD_IN_YOUR_GRAVEYARD_TARGET,
          // The reanimate form (Unburial Rites' wording) or Mortuary Mire's top.
          to: match[1] !== undefined ? 'libraryTop' : 'battlefield',
        },
      });
    },
  },
  {
    id: 'may-cost-then-effect',
    description:
      '"You may sacrifice a land / discard a card. If you do, EFFECT" (Springbloom Druid, Formidable Speaker) — a cost-gated option, all-or-nothing',
    // The COST alternation is CLOSED to the two shapes the wrapper primitive
    // can pre-check for payability (see `mayCostEffects`): a cost it could not
    // check would let "you may sacrifice a land" grant the payoff on an empty
    // board. The payoff must itself compile, target-free — it runs inside the
    // resolution with no aiming step of its own.
    pattern: new RegExp(
      `^you may (sacrifice an? (?:${SACRIFICE_NOUNS})|discard a card)\\. if you do, (.+)$`,
    ),
    build(match, ctx) {
      const costText = match[1]!;
      const sacrifice = new RegExp(`^sacrifice an? (${SACRIFICE_NOUNS})$`).exec(costText);
      const cost =
        sacrifice !== null
          ? {
              primitive: 'sacrificeChosen',
              params: { who: 'controller', ...sacrificeNounFilter(sacrifice[1]!, false) },
            }
          : { primitive: 'discardCard', params: { who: 'controller' } };
      const payoff = ctx.compileEffectClause(match[2]!, { targetFree: true });
      if (!payoff || payoff.length === 0) return null;
      return effects({
        primitive: 'mayCostEffects',
        params: {
          cost: [cost],
          effects: [...payoff],
          prompt: `You may ${costText}. If you do, ${match[2]}`,
        },
      });
    },
  },
  {
    id: 'target-player-sacrifices',
    description: '"Target player sacrifices a creature" (the edict template; Liliana\'s −2)',
    pattern: new RegExp(`^target (player|opponent) sacrifices an? (${SACRIFICE_NOUNS})$`),
    needsChosenTarget: true,
    build(match) {
      const restriction = match[1] === 'opponent' ? OPPONENT_TARGET : PLAYER_TARGET;
      // "a permanent" is any type; the rest narrow by card type. The VICTIM
      // chooses which — that is the whole card (see `sacrificeChosen`).
      return effects({
        primitive: 'sacrificeChosen',
        params: {
          targets: restriction,
          who: 'targetPlayer',
          ...sacrificeNounFilter(match[2]!, false),
        },
      });
    },
  },
  {
    id: 'that-player-sacrifices',
    description:
      '"That player sacrifices a [nontoken] NOUN of their choice" (Sheoldred, Whispering One) — an edict aimed at the TRIGGERING player',
    // The triggering-player sibling of `each-player-sacrifices` below, reading
    // the same `triggering` vocabulary `that-player-loses-life` reads: "at the
    // beginning of EACH OPPONENT'S upkeep" resolves under its source's
    // controller on both turns, so a body that read `ctx.controller` would make
    // Sheoldred sacrifice her own creatures.
    pattern: new RegExp(
      `^that player sacrifices an? (nontoken )?(${SACRIFICE_NOUNS})(?: of their choice)?$`,
    ),
    build(match) {
      return effects({
        primitive: 'sacrificeChosen',
        params: { who: 'triggering', ...sacrificeNounFilter(match[2]!, match[1] !== undefined) },
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
    // "Of their choice" is the printed reminder that the VICTIM picks, which is
    // what `sacrificeChosen` does by construction; it is optional in the pattern
    // because older printings omit it.
    pattern: new RegExp(
      `^each player sacrifices an? (nontoken )?(${SACRIFICE_NOUNS})(?: of their choice)?$`,
    ),
    build(match) {
      return effects({
        primitive: 'sacrificeChosen',
        // Same spelling of the word as `discardCard`'s branch — one vocabulary
        // for "both seats answer this" across the choice primitives.
        params: { who: 'eachPlayer', ...sacrificeNounFilter(match[2]!, match[1] !== undefined) },
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
    pattern: new RegExp(
      `^each (?:opponent|other player) sacrifices an? (nontoken )?(${SACRIFICE_NOUNS})(?: of their choice)?$`,
    ),
    build(match) {
      return effects({
        primitive: 'sacrificeChosen',
        params: { who: 'opponent', ...sacrificeNounFilter(match[2]!, match[1] !== undefined) },
      });
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
    pattern: new RegExp(`^each opponent loses ${AMOUNT_TOKEN} life$`),
    build(match, ctx) {
      const amount = parseAmount(match[1], ctx);
      return amount === null
        ? null
        : effects({ primitive: 'loseLife', params: { amount, whichPlayer: 'opponent' } });
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
    id: 'search-basic-land-or-subtype-to-hand',
    description:
      '"Search your library for a basic land card or a Gate card, reveal it, put it into your hand, then shuffle" (Gatecreeper Vine)',
    /*
     * A two-branch search: the basic lands by NAME, plus one printed SUBTYPE.
     * `CardFilter` already spells the second half (`anyOfSubtypes`), and the
     * primitive already unions a name list with a filter — Path to Exile's
     * basic-land fetch uses the same pair — so this is a template gap rather
     * than an engine one.
     *
     * The subtype is captured, not hard-coded to Gate: the same sentence is
     * printed with other land types, and a rule that read only "Gate" would
     * report the next one as an unknown template.
     */
    pattern:
      // ⚠️ The article before the SUBTYPE is optional, because Oracle does not
      // print one: Gatecreeper Vine reads "a basic land card **or Gate card**".
      // Requiring "or a Gate card" made this rule match the wording nothing is
      // printed with — the card reported for as long as the rule existed.
      /^search your library for a basic land card or (?:an? )?([a-z]+) card, reveal (?:it|that card), put (?:it|that card) into your hand, then shuffle$/,
    build(match) {
      const subtype = match[1];
      if (subtype === undefined || subtype.length === 0) return null;
      return effects({
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          // A true OR (§3.55): the old encoding intersected a Gate-subtype filter
          // with a basic-name list — the empty set — so the picker auto-answered
          // an empty selection and the search silently found nothing.
          filter: { anyOf: [{ anyOfTypes: ['land'], basic: true }, { anyOfSubtypes: [subtype] }] },
          destination: 'hand',
          reveal: true,
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
      '"Search your library for a land card, put it onto the battlefield tapped, then shuffle" (Urza’s Cave)',
    // The battlefield sibling of `search-to-hand-by-filter`, sharing its noun
    // parser so "an Aura or Equipment card" cannot mean one thing when fetched to
    // hand and another when put onto the battlefield. The land-type list above
    // still runs FIRST, so a multi-type fetchland keeps its own rule.
    //
    // ⚠️ Which is why Wood Elves ("search your library for a FOREST card") is
    // NOT this rule's card, though the description used to claim it:
    // `fetch-land-by-subtype` matches the printed land type first. The
    // rule-coverage guard fails on a description that cites a card another rule
    // owns, because that is how a reader ends up debugging the wrong rule.
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
    // §3.111 widened by the corpus: "up to two target creature cards" (a count
    // the chooser may fall short of — `optional` with the count as the max)
    // and "target instant or sorcery card" (a two-type filter). Same primitive,
    // same choice; two more rows of the printed shape.
    pattern: new RegExp(
      `^(you may )?return (?:target|up to ${COUNT_TOKEN} target) (${Object.keys(SPELL_TYPE_WORDS).join('|')})(?: or (${Object.keys(SPELL_TYPE_WORDS).join('|')}))? cards? from your graveyard to your hand$`,
    ),
    build(match) {
      const type = SPELL_TYPE_WORDS[match[3] ?? ''];
      if (!type) return null;
      const second = match[4] === undefined ? undefined : SPELL_TYPE_WORDS[match[4]];
      if (match[4] !== undefined && second === undefined) return null;
      const upTo = match[2] === undefined ? null : parseCount(match[2]);
      if (match[2] !== undefined && (upTo === null || upTo <= 0)) return null;
      const types = second === undefined ? [type] : [type, second];
      const params: Record<string, unknown> = { count: upTo ?? 1, filter: { anyOfTypes: types } };
      if (match[1] || upTo !== null) params.optional = true;
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
      const whole = match[1];
      if (!whole) return null;
      // §3.150 — an emblem may print SEVERAL quoted abilities, joined by "and"
      // (Tamiyo the Moon Sage, Saheeli Filigree Master, Sarkhan the
      // Dragonspeaker, Teferi Who Slows the Sunset). The old greedy `(.+)`
      // swallowed the join and handed the tables one unparseable run, so every
      // multi-ability emblem reported. Splitting is not optional generosity:
      // compiling only the first quoted ability would put an emblem on the
      // battlefield missing half of what it says.
      const bodies = splitQuotedEmblemAbilities(whole);
      if (bodies.length === 0) return null;
      const statics: StaticAbility[] = [];
      const triggers: TriggeredAbility[] = [];
      const definitionFields: Record<string, unknown> = {};
      for (const body of bodies) {
        // EVERY quoted ability must compile, or the whole line reports. An
        // emblem carrying two of its three abilities is exactly the silent
        // approximation the compiler contract exists to prevent.
        if (!foldEmblemAbility(body, ctx, statics, triggers, definitionFields)) return null;
      }
      if (statics.length === 0 && triggers.length === 0 && Object.keys(definitionFields).length === 0) {
        return null;
      }
      return effects({
        primitive: 'createEmblem',
        params: {
          name: `${ctx.card.name} emblem`,
          ...(statics.length > 0 ? { statics } : {}),
          ...(triggers.length > 0 ? { triggers } : {}),
          ...(Object.keys(definitionFields).length > 0 ? { definitionFields } : {}),
        },
      });
    },
  },
  // --- the spell-count family (DESIGN §3.113): learn, investigate N times, the
  // loot template, the mill shapes, doubling power, reveal-the-top draws ------
  {
    id: 'learn',
    description: '"Learn" (CR 701.48a) — the discard-to-draw half; the outside-the-game Lesson half has no zone here (Pop Quiz, Field Trip)',
    pattern: /^learn$/,
    build() {
      return effects({ primitive: 'learn' });
    },
  },
  {
    id: 'investigate-n-times',
    description: '"Investigate twice / three times" (CR 701.16a, Confirm Suspicions) — that many Clue tokens in one create',
    pattern: new RegExp(`^investigate (${Object.keys(REPEAT_COUNT_WORDS).join('|')})$`),
    build(match) {
      const count = REPEAT_COUNT_WORDS[match[1] ?? ''];
      if (count === undefined) return null;
      return effects({ primitive: 'createPredefinedToken', params: { token: 'clue', count } });
    },
  },
  {
    id: 'draw-then-discard-loot',
    description: '"Draw N cards, then discard N cards" — the loot template (Owl Familiar, Merfolk Looter)',
    pattern: new RegExp(`^draw ${COUNT_TOKEN} cards?, then discard ${COUNT_TOKEN} cards?$`),
    build(match) {
      const drawn = parseCount(match[1]);
      const discarded = parseCount(match[2]);
      if (drawn === null || discarded === null) return null;
      return effects(
        { primitive: 'drawCards', params: { count: drawn } },
        // The CONTROLLER's own discard, chosen by them — `discardCard`'s default
        // victim is a targeted player, which this clause never has.
        { primitive: 'discardCard', params: { who: 'controller', ...(discarded === 1 ? {} : { count: discarded }) } },
      );
    },
  },
  {
    id: 'mill-then-return-from-graveyard',
    description:
      '"Mill N cards, then [you may] return a NOUN card [and a NOUN card] from your graveyard to your hand" (Corpse Churn, Grapple with the Past, Sudden Reclamation)',
    pattern: new RegExp(
      `^mill ${COUNT_TOKEN} cards?, then (you may )?return an? (${MILL_RETURN_NOUN_TOKEN}) card(?: and an? (${MILL_RETURN_NOUN_TOKEN}) card)? from your graveyard to your hand$`,
    ),
    build(match) {
      const amount = parseCount(match[1]);
      if (amount === null) return null;
      const optional = match[2] !== undefined;
      const returns: EffectRef[] = [];
      for (const noun of [match[3], match[4]]) {
        if (noun === undefined) continue;
        const filter = MILL_RETURN_NOUNS[noun];
        if (filter === undefined) return null;
        returns.push({
          primitive: 'returnFromGraveyard',
          params: { count: 1, filter, ...(optional ? { optional: true } : {}) },
        });
      }
      if (returns.length === 0) return null;
      return effects({ primitive: 'mill', params: { amount, self: true } }, ...returns);
    },
  },
  {
    id: 'mill-then-put-from-among',
    description:
      '"Mill N cards[, then / .] [you may] put/return a NOUN card from among them / the milled cards / the cards milled this way into your hand[. EFFECT]" (Seed of Hope, Wasteful Harvest, Midnight Tilling)',
    pattern: new RegExp(
      `^mill ${COUNT_TOKEN} cards?(?:\\. |, then )(you may )?(?:put|return) an? (${MILL_RETURN_NOUN_TOKEN}) card from among (?:them|the milled cards|the cards milled this way) (?:into|to) your hand(?:\\. (.+))?$`,
    ),
    build(match, ctx) {
      const amount = parseCount(match[1]);
      if (amount === null) return null;
      const filter = MILL_RETURN_NOUNS[match[3] ?? ''];
      if (filter === undefined) return null;
      // A trailing sentence ("You gain 2 life") must itself compile, target-free,
      // for the reason `scry-then-effect` gives; a tail outside the table
      // (Cache Grab's Squirrel clause) refuses the whole line.
      const tail = match[4] === undefined ? [] : ctx.compileEffectClause(match[4], { targetFree: true });
      if (tail === null || tail === undefined) return null;
      return effects(
        {
          primitive: 'millThenReturn',
          params: { amount, filter, ...(match[2] !== undefined ? { optional: true } : {}) },
        },
        ...tail,
      );
    },
  },
  {
    id: 'double-target-power',
    description: '"Double the power of target creature / target creature\'s power until end of turn" (CR 701.10b — Unleash Fury, Bulk Up)',
    pattern: /^double (?:the power of target creature|target creature's power) until end of turn$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'doublePower', params: { targets: CREATURE_TARGET } });
    },
  },
  {
    id: 'double-each-power',
    description: '"Double the power of each creature you control until end of turn" (CR 701.10b — Double Trouble)',
    pattern: /^double the power of each creature you control until end of turn$/,
    build() {
      return effects({ primitive: 'doublePower', params: { each: 'yours' } });
    },
  },
  {
    id: 'reveal-top-draw-if',
    description:
      '"[You may] reveal the top card of your library. If it\'s a NOUN card / If a NOUN card is revealed this way, draw a card" — the tail of Track Down and Elven Farsight',
    pattern: new RegExp(
      `^(you may )?reveal the top card of your library\\. if (?:it's an? (${MILL_RETURN_NOUN_TOKEN}) card|an? (${MILL_RETURN_NOUN_TOKEN}) card is revealed this way), draw a card$`,
    ),
    build(match) {
      const filter = MILL_RETURN_NOUNS[match[2] ?? match[3] ?? ''];
      if (filter === undefined) return null;
      return effects({
        primitive: 'revealTopDrawIf',
        params: { filter, ...(match[1] !== undefined ? { optional: true } : {}) },
      });
    },
  },
  // ===========================================================================
  // §3.149 — THE NAMED-COUNTER RULES. Kept as one contiguous region at the tail
  // of this table because three lanes edited this file at once; nothing above
  // is reformatted, and the whole family moves or merges as a block.
  // ===========================================================================
  {
    /**
     * "Put a **charge** counter on ~" / "Put two **quest** counters on ~" — a
     * counter of a kind the rules attach no behaviour to (§3.149).
     *
     * Only the kinds in {@link INERT_COUNTER_KINDS} reach this rule, and that
     * table is the whole safety argument: an inert counter's ONLY meaning comes
     * from the card's own other printed lines, so storing it is exactly what the
     * card says. A shield or stun counter — where CR 122.1 attaches behaviour to
     * the counter itself — would be a card playing WEAKER than printed if it
     * were stored and nothing honoured it, so those kinds are absent from the
     * table and their cards keep reporting.
     *
     * The card is NOT thereby made playable on its own: a line that READS the
     * counter ("Remove three charge counters from ~: …") still has to compile,
     * or the card stays `incomplete` and never enters the pool. This rule closes
     * the write half of the family; the read half reports until it is built.
     */
    id: 'put-named-counter-on-self',
    description: '"Put N <inert-kind> counters on ~" — a counter the rules attach no behaviour to',
    pattern: new RegExp(
      `^put (?:an?|${COUNT_TOKEN}) (${INERT_COUNTER_KIND_TOKEN}) counters? on (~|it|this creature)$`,
    ),
    build(match, ctx) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      const kind = inertCounterKind(match[2] ?? '');
      if (amount === null || amount <= 0 || kind === null) return null;
      // ⚠️ A SPELL CANNOT HOLD COUNTERS, so no self form of this clause is
      // implementable on an instant or a sorcery — neither "on ~" nor "on it".
      //
      // Two cards made the point from opposite directions. Free from Flesh
      // ("Target creature gets +2/+2 until end of turn. Put two oil counters on
      // **it**.") showed that a bare "it" is whatever the PREVIOUS sentence
      // named — the splitter hands the second half over alone — so reading it as
      // the source put the counters nowhere. And `counters.test.ts` has asserted
      // since the +1/+1 work that "Put a charge counter on **~**" printed on an
      // Instant must report: `~` on a spell is the spell, and counters live on
      // permanents (CR 122.1). Both are the same refusal.
      //
      // On a PERMANENT both readings are the source and both compile, which is
      // what a creature's own "put an oil counter on it" trigger body means.
      if (!sourceCanHoldCounters(ctx)) return null;
      return effects({ primitive: 'addCounters', params: { amount, kind, self: true } });
    },
  },
  {
    /**
     * "Exile target card from a graveyard." — 62 cards print it (Crypt Creeper,
     * Relic of Progenitus, Scavenging Ooze) — with the optional printed rider
     * "**If it was a creature card, …**".
     *
     * ONE rule for both sentences, because "it" is the card the FIRST sentence
     * exiled and "was" is past tense: the type has to be read before the move.
     * A standalone rider rule would be aimed at whatever target happened to be
     * around, which is the trap `put-counters-then-grant-keyword` documents for
     * the same reason.
     *
     * The rider's body goes through the ordinary effect rules TARGET-FREE, so it
     * can only do what the engine already implements and a body needing a chosen
     * target is refused rather than compiled into a silent no-op. Scavenging
     * Ooze's body ("put a +1/+1 counter on ~ and you gain 1 life") rides the
     * existing `effect-and-you-effect` conjunction.
     *
     * ⚠️ ONLY the "creature card" rider is read. "If it was a land card", "if it
     * was an instant or sorcery card" and the "…, you gain 1 life" tails that
     * are NOT gated on a type are different sentences with different meanings,
     * and they keep reporting rather than being widened into this one.
     */
    id: 'exile-target-card-from-graveyard',
    description:
      '"Exile target card from a graveyard[. If it was a creature card, EFFECT]" (Crypt Creeper, Scavenging Ooze)',
    pattern: /^exile target card from a graveyard(?:\. if it was a creature card, (.+))?$/,
    needsChosenTarget: true,
    build(match, ctx) {
      const rider = match[1];
      if (rider === undefined) {
        return effects({
          primitive: 'exileTargetCardFromGraveyard',
          params: { targets: CARD_IN_ANY_GRAVEYARD_TARGET },
        });
      }
      const body = ctx.compileEffectClause(rider, { targetFree: true });
      if (body === null || body.length === 0) return null;
      return effects({
        primitive: 'exileTargetCardFromGraveyard',
        params: {
          targets: CARD_IN_ANY_GRAVEYARD_TARGET,
          ifWasType: 'creature',
          effects: [...body],
        },
      });
    },
  },
]);

/**
 * §3.150 — split an emblem's quoted ability list into its abilities.
 *
 * `You get an emblem with "A" and "B"` prints two abilities, and the ONLY
 * reliable delimiter is the quotation marks themselves: an emblem body is
 * arbitrary card text and routinely contains the word "and", commas, and full
 * stops of its own ("Whenever a card is put into your graveyard from anywhere,
 * you may return it to your hand"). So this reads the QUOTES and never the
 * prose.
 *
 * The match handed in has already had the OUTER pair stripped by the rule's
 * pattern, so what arrives is either one bare body (the common case, and the
 * one printing that contains no quotes at all) or a run like
 * `A" and "B`. Splitting on a quote-run keeps both cases in one code path.
 *
 * ⚠️ Returns an EMPTY list rather than a guess when the run does not partition
 * cleanly — an odd number of quote marks means the text is something this does
 * not understand, and inventing a body from it would put an ability on the
 * battlefield that no card prints.
 */
function splitQuotedEmblemAbilities(whole: string): readonly string[] {
  // The join between two quoted abilities: a closing quote, "and" (or a comma
  // list), an opening quote. A CLOSED set of separators, for the same reason
  // every other table here is closed.
  const parts = whole
    .split(/["”’]\s*(?:,\s*)?(?:and\s+)?["“‘]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // A stray quote left inside any part means the split did not partition the
  // run — report rather than compile half a sentence as a whole ability.
  if (parts.some((part) => /["“”‘’]/.test(part))) return [];
  return parts;
}

/**
 * §3.150 — fold ONE quoted emblem ability into the emblem being built, and say
 * whether it was fully understood.
 *
 * Three channels, because an emblem's ability may be any of three shapes and
 * the first two were the only ones the original rule could carry:
 *  1. a STATIC ("Artifact creatures you control get +1/+1");
 *  2. a TRIGGER ("At the beginning of your draw step, draw two additional cards");
 *  3. a DEFINITION-LEVEL flag — "You have no maximum hand size", which is not a
 *     {@link StaticAbility} at all but `CardDefinition.noMaximumHandSize`, the
 *     field `player-statics.ts` was built around and whose own header says an
 *     emblem is the case it exists for. Without this channel the compiler read
 *     the body correctly, produced the right contribution, and then dropped it
 *     on the floor because the emblem only looked at `.statics`.
 *
 * {@link EMBLEM_DEFINITION_FIELDS} is CLOSED, and a contribution carrying any
 * field outside it REFUSES — which is the whole point of writing this as a
 * table. A rule that grows a new contribution field would otherwise be silently
 * half-applied here, and an emblem is unremovable: a wrong one is wrong for the
 * rest of the game with nothing to destroy.
 */
function foldEmblemAbility(
  body: string,
  ctx: RuleContext,
  statics: StaticAbility[],
  triggers: TriggeredAbility[],
  definitionFields: Record<string, unknown>,
): boolean {
  const fromStatics = emblemStatics(body, ctx);
  if (fromStatics.length > 0) {
    statics.push(...fromStatics);
    return true;
  }
  const fromTriggers = emblemTriggers(body, ctx);
  if (fromTriggers.length > 0) {
    triggers.push(...fromTriggers);
    return true;
  }
  const clause = normalizeClause(body);
  for (const rule of STATIC_RULES) {
    const matched = clause.match(rule.pattern);
    if (!matched) continue;
    const contribution = rule.build(matched, ctx);
    if (!contribution) continue;
    const keys = Object.keys(contribution);
    if (keys.length === 0 || !keys.every((key) => EMBLEM_DEFINITION_FIELDS.has(key))) continue;
    for (const key of keys) definitionFields[key] = (contribution as Record<string, unknown>)[key];
    return true;
  }
  return false;
}

/**
 * The CLOSED set of compiler contribution fields an emblem may carry straight
 * onto its own {@link CardDefinition}.
 *
 * One row so far, and it is deliberately one row: `noMaximumHandSize` is the
 * field `hasNoMaximumHandSize` reads from the command zone, so an emblem
 * carrying it genuinely works today. Every other contribution field either
 * describes a PERMANENT an emblem is not (power, toughness, attachment) or
 * needs a reader that does not look at the command zone — and the difference is
 * not visible in the shape of the contribution, which is exactly why this is a
 * named table and not a spread.
 */
export const EMBLEM_DEFINITION_FIELDS: ReadonlySet<string> = new Set(['noMaximumHandSize']);

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

// --- §3.148, the targeted-trigger row: the body's leading pronoun ---------------

/**
 * The trigger EVENTS whose printed SUBJECT is the source itself, so a body that
 * opens with the pronoun "it" is talking about `~`.
 *
 * "When this creature enters, **it** deals 2 damage to any target" (Skeleton
 * Archer) is the single largest one-clause shape in the targeted-trigger
 * backlog. The effect rule for it already exists — `damage-any-target` reads
 * "~ deals N damage to <RECIPIENT>" over the whole {@link DAMAGE_TARGET_RESTRICTIONS}
 * table — so what was missing is only that the body says "it" where the rule
 * says "~".
 *
 * A CLOSED TABLE rather than a blanket rewrite, because "it" means a DIFFERENT
 * object on the events left out and getting that wrong is silent:
 *  - `permanentEnters` / `permanentDies` are about some OTHER permanent
 *    ("whenever a creature you control dies, it deals…") — resolving "it" to the
 *    source would make the wrong object deal the damage;
 *  - `castSpell`, the step triggers and the life events have no subject at all.
 * A `watches` other than the default is the same problem wearing a flag: an
 * Equipment's "whenever equipped creature attacks, **it** deals…" is about the
 * equipped creature, never the Equipment.
 */
const SOURCE_SUBJECT_EVENTS: ReadonlySet<TriggerEvent> = new Set<TriggerEvent>([
  'etb',
  'attacks',
  'blocks',
  'becomesBlocked',
  'blocksOrBecomesBlocked',
  'becomesBlockedByCreature',
  'dies',
  'leaves',
  'putIntoGraveyardFromBattlefield',
  'combatDamageToPlayer',
]);

/**
 * Rewrite a trigger body's LEADING "it" to `~`, and only where the trigger's
 * subject IS the source.
 *
 * Leading only, deliberately: a later "it" in the same body is about whatever
 * the earlier sentence just named ("exile target creature. return **it**…"), and
 * that pronoun is the sentence's business, not this one's.
 */
function resolveSourcePronoun(condition: TriggeredAbility['condition'], bodyText: string): string {
  if ((condition.watches ?? DEFAULT_TRIGGER_WATCHES) !== DEFAULT_TRIGGER_WATCHES) return bodyText;
  if (!SOURCE_SUBJECT_EVENTS.has(condition.on)) return bodyText;
  return bodyText.replace(/^it\b/i, '~');
}

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
  const body = ctx.compileTriggerBody(resolveSourcePronoun(condition, bodyText));
  // A MODAL body has empty effects on purpose — the chosen modes' effects
  // replace them as the ability goes on the stack.
  if (body === null || (body.effects.length === 0 && body.modal === undefined)) return null;
  return {
    triggers: [
      {
        condition,
        effects: body.effects,
        label,
        ...(body.targets ? { targets: body.targets } : {}),
        ...(body.targetsExcludeSelf ? { targetsExcludeSelf: true } : {}),
        ...(body.targetCount ? { targetCount: body.targetCount } : {}),
        ...(body.modal ? { modal: body.modal } : {}),
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
  // The same pronoun resolution the forced funnel does, for the reason DRY
  // exists: two funnels that answer "what does 'it' mean here?" separately will
  // eventually answer it differently, and only one of them will be right.
  const body = resolveSourcePronoun(condition, innerBody);
  const compiled = ctx.compileTriggerBody(body);
  if (compiled === null) return null;
  const effects = mayEffectsFrom(body, compiled.effects);
  if (effects === null || effects.length === 0) return null;
  return {
    triggers: [
      {
        condition,
        effects,
        label,
        ...(compiled.targets ? { targets: compiled.targets } : {}),
            ...(compiled.targetsExcludeSelf ? { targetsExcludeSelf: true } : {}),
        ...(compiled.targetCount ? { targetCount: compiled.targetCount } : {}),
            ...(compiled.modal ? { modal: compiled.modal } : {}),
            ...(compiled.modal ? { modal: compiled.modal } : {}),
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
    // "if it was kicked" (Skyclave Relic's ETB). The kicked entry wrote
    // `timesKicked` onto the permanent for exactly this reader.
    pattern: /^(?:it|~) was kicked$/,
    build: (): InterveningIf => ({ kind: 'sourceKicked' }),
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
        const bound = parseSignedInt(match[5] ?? '');
        if (!Number.isFinite(bound)) return null;
        condition.minPower = bound;
      }
      return condition as unknown as InterveningIf;
    },
  },
  {
    // §3.149 — "if you didn't lose life this turn" (Luminarch Ascension). The
    // ONLY card in the 32,414-card corpus that prints this phrase, and it is
    // here because Caleb's own deck needs it (ALL-CARDS-CAMPAIGN §4a phase 2),
    // not because the family is large. Read off the `youLostLife` turn fact,
    // which damage feeds — which is exactly what the card's own reminder text
    // ("Damage causes loss of life.") insists on.
    pattern: /^you didn'?t lose life this turn$/,
    build: (): InterveningIf => ({ kind: 'didNotLoseLifeThisTurn' }),
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
  // === THE WALKER-RESIDUE FAMILY (DESIGN §3.154) — owned by `feat/walker-residues` ===
  {
    id: 'trigger-card-into-graveyard-from-anywhere',
    description:
      '"Whenever [another] [TYPE] card is put into your/a graveyard from anywhere, BODY" (Tamiyo\'s emblem; Crawling Sensation; Ultron\'s Auxiliary)',
    /**
     * The whole "from anywhere" family in ONE rule, because it is one
     * occurrence: a card reached a graveyard, from wherever it was. Splitting it
     * per source zone is how the engine would end up with a mill trigger that
     * does not fire on a discard.
     *
     * ⚠️ It is NOT `permanentDies`. That event is the battlefield → graveyard
     * move alone, so a rule built on it would compile this printed line into a
     * card that ignores every mill, every discard and every countered spell —
     * strictly weaker than printed, and completely silent.
     *
     * ⚠️ "your graveyard" vs "a graveyard" is a real fidelity knob and not a
     * synonym: `who: 'you'` against the card's OWNER for the first (CR 404.3),
     * `'any'` for the second. Reading "a graveyard" as "yours" halves what the
     * card sees; reading "yours" as "a" doubles it.
     *
     * The body is compiled by the shared trigger-body compiler, so every effect
     * the engine already has is available here without a rule each, and the
     * printed "you may" wrapper is the shared one.
     */
    pattern: new RegExp(
      `^whenever (another |an? )?((?:${Object.keys(SPELL_TYPE_WORDS).join('|')}) )?card is put into ` +
        `(your|a) graveyard from anywhere, (.+)$`,
    ),
    build(match, ctx) {
      const typeWord = match[2]?.trim();
      const filter: Record<string, unknown> = {};
      if (typeWord !== undefined && typeWord.length > 0) {
        const types = positiveSpellTypes(typeWord);
        if (types === null) return null;
        filter.anyOfTypes = types;
      }
      const who = match[3] === 'your' ? 'you' : 'any';
      const another = (match[1] ?? '').trim() === 'another';
      const body = match[4] ?? '';
      const optional = body.startsWith('you may ');
      const inner = optional ? body.slice('you may '.length) : body;
      const compiled = ctx.compileTriggerBody(inner);
      if (compiled === null || compiled.effects.length === 0) return null;
      // A MODAL body's effects are replaced by the chosen modes; this family has
      // no printed modal member, and admitting one would wrap a question in a
      // question.
      if (compiled.modal !== undefined) return null;
      const effectRefs = optional ? mayEffectsFrom(inner, compiled.effects) : compiled.effects;
      if (effectRefs === null) return null;
      // "…return IT to your hand" needs the card the event was about carried to
      // the resolution. Opt-in per body, so a trigger whose body never names the
      // moved card compiles byte-identically to one written before this axis.
      const carriesSubject = readsTriggeringCard(effectRefs);
      return {
        triggers: [
          {
            condition: {
              on: 'cardPutIntoGraveyardFromAnywhere' as TriggerEvent,
              who,
              ...(Object.keys(filter).length > 0 ? { permanentFilter: filter as CardFilter } : {}),
              ...(another ? { excludeSelf: true } : {}),
              ...(carriesSubject ? { carriesSubject: true } : {}),
            },
            effects: effectRefs,
            label: `card into ${match[3]} graveyard from anywhere: ${body}`,
          },
        ],
      };
    },
  },
  {
    id: 'trigger-etb-exile-up-to-three-until-this-leaves',
    description:
      '"When ~ enters, you may exile up to three other target creatures from the battlefield and/or creature cards from graveyards" (Angel of Serenity)',
    /*
     * The O-Ring pattern at its largest: THREE targets, spanning TWO zones, and
     * "up to" — so choosing none is a legal answer and the ability must stay on
     * the stack rather than being removed for want of a target.
     *
     * Only the exile half is emitted here; the card's second printed line
     * ("return the exiled cards to their owners' hands") compiles through
     * `trigger-leaves` into `returnExiledByThis` with `to: 'hand'`.
     *
     * "OTHER" is load-bearing exactly as it is on Fiend Hunter — an Angel that
     * exiled itself would leave, return itself, and trigger again forever.
     */
    pattern:
      /^when ~ enters(?: the battlefield)?, you may exile up to three other target creatures from the battlefield and\/or creature cards from graveyards$/,
    needsChosenTarget: true,
    build() {
      return {
        triggers: [
          {
            condition: { on: 'etb' },
            effects: [
              {
                primitive: 'exileUntilLeaves',
                params: { targets: CREATURE_BATTLEFIELD_OR_GRAVEYARD_TARGET, max: 3 },
              },
            ],
            label: 'Enters: exile up to three other creatures until this leaves',
            targets: CREATURE_BATTLEFIELD_OR_GRAVEYARD_TARGET,
            targetsExcludeSelf: true,
            targetCount: { min: 0, max: 3 },
          },
        ],
      };
    },
  },
  {
    id: 'trigger-etb-exile-another-target-creature',
    description: '"When ~ enters, you may exile another target creature" (Fiend Hunter)',
    /*
     * The OLDER O-Ring wording: the exile and the return are printed as two
     * separate abilities, so this rule emits only the first and the card's own
     * second line compiles through `trigger-leaves` into `returnExiledByThis`.
     *
     * "ANOTHER" is load-bearing and is why this is its own rule rather than the
     * generic optional-enters wrapper: let Fiend Hunter name itself and it
     * exiles itself, which makes it leave, which returns it, which triggers it
     * again — unbounded, the shape of DESIGN §3.33's copy mirror. The exclusion
     * rides the ability as `targetsExcludeSelf`, which the engine applies when it
     * builds the candidate list.
     */
    pattern:
      /^when ~ enters(?: the battlefield)?, you may exile another target creature$/,
    needsChosenTarget: true,
    build() {
      return {
        triggers: [
          {
            condition: { on: 'etb' },
            effects: [
              {
                primitive: 'mayEffects',
                params: {
                  prompt: 'You may exile another target creature',
                  valence: 'gain',
                  effects: [
                    { primitive: 'exileUntilLeaves', params: { targets: CREATURE_TARGET, max: 1 } },
                  ],
                },
              },
            ],
            label: 'Enters: you may exile another target creature',
            targets: CREATURE_TARGET,
            targetsExcludeSelf: true,
          },
        ],
      };
    },
  },
  {
    id: 'trigger-etb-exile-until-this-leaves',
    description:
      '"When ~ enters, exile target creature an opponent controls until this creature leaves the battlefield" (Banisher Priest)',
    /*
     * ONE printed sentence, TWO abilities (CR 603.6c). The modern O-Ring wording
     * folds the return into the exile clause, so this rule emits both halves:
     * the enters trigger that exiles, and the leaves trigger that gives it back.
     * A body rule could not do it — a body contributes effects to ONE ability,
     * and the whole point of this template is that the second one exists.
     *
     * Ordered before `trigger-etb` so the generic enters rule does not match the
     * sentence first and compile only the exile, which would be a strictly
     * better card than the one printed: removal with no drawback.
     */
    pattern:
      /^when ~ enters(?: the battlefield)?, exile target creature an opponent controls until (?:~|this creature) leaves the battlefield$/,
    needsChosenTarget: true,
    build() {
      return {
        triggers: [
          {
            condition: { on: 'etb' },
            effects: [
              {
                primitive: 'exileUntilLeaves',
                params: { targets: CREATURE_AN_OPPONENT_CONTROLS_TARGET, max: 1 },
              },
            ],
            label: 'Enters: exile target creature an opponent controls until this leaves',
            targets: CREATURE_AN_OPPONENT_CONTROLS_TARGET,
          },
          {
            condition: { on: 'leaves' },
            effects: [{ primitive: 'returnExiledByThis', params: { to: 'battlefield' } }],
            label: 'Leaves: return the exiled card',
          },
        ],
      };
    },
  },
  {
    id: 'trigger-etb-exile-target-noun-linked',
    description:
      '"When ~ enters, exile [another] target <NOUN>" on a card that ALSO prints the return line — every noun in TARGET_NOUN_RESTRICTIONS (Oblivion Ring, Journey to Nowhere, Faceless Butcher)',
    /*
     * §3.148. The OLDEST O-Ring wording, and the one the compiler read wrong.
     *
     * Three printed sentences make one machine: the ETB exile, the leaves-return,
     * and the LINK between them (`exileUntilLeaves` stamps
     * `CardInstance.exiledUntilLeavesBy`; `returnExiledByThis` reads it). Without
     * this rule the sentence fell through to `trigger-etb` and compiled to a bare
     * `exileTarget` — no link — so the card's own return half gave back nothing.
     * Journey to Nowhere shipped in the pool that way.
     *
     * Ordered before `trigger-etb` for the reason the Banisher Priest rule is:
     * the generic enters rule matches this sentence too, and what it builds is a
     * strictly better card than the one printed.
     *
     * The PAIR is the condition, not the noun. A card that prints this sentence
     * with NO return line ("Galactus, Devourer of Worlds") is a plain exile and
     * must keep compiling to one, so the rule declines and lets `trigger-etb`
     * have it — the same sentence means two different cards, and only the card
     * knows which.
     *
     * "ANOTHER" is load-bearing exactly as it is on Fiend Hunter: an Oblivion
     * Ring that could name itself would exile itself, leave, return itself and
     * trigger again for ever (DESIGN §3.33's mirror). It rides the ability as
     * `targetsExcludeSelf`, which the aiming pass reads when it builds the menu.
     */
    pattern: new RegExp(`^when ~ enters(?: the battlefield)?, exile (another )?target (${TARGET_NOUN_PHRASE})$`),
    needsChosenTarget: true,
    build(match, ctx) {
      if (!printsLinkedReturn(ctx)) return null;
      const restriction = TARGET_NOUN_RESTRICTIONS[match[2] ?? ''];
      if (restriction === undefined) return null;
      const excludeSelf = match[1] !== undefined;
      return {
        triggers: [
          {
            condition: { on: 'etb' },
            effects: [{ primitive: 'exileUntilLeaves', params: { targets: restriction, max: 1 } }],
            label: `Enters: exile ${excludeSelf ? 'another ' : ''}target ${match[2] ?? ''}`,
            targets: restriction,
            ...(excludeSelf ? { targetsExcludeSelf: true } : {}),
          },
        ],
      };
    },
  },
  {
    id: 'trigger-etb',
    description: '"When ~ enters (the battlefield), [if COND,] BODY"',
    pattern: /^when ~ enters(?: the battlefield)?, (.+)$/,
    build(match, ctx) {
      // The printed intervening "if" (CR 603.4), split with the same closed
      // vocabulary the step-trigger family uses — "if it was kicked, create two
      // tapped tokens…" (Skyclave Relic). `'unreadable'` refuses the whole line:
      // compiling the body as though the condition were not there would fire the
      // trigger on every unkicked entry, a strictly better card than printed.
      const split = splitInterveningIf(match[1] ?? '');
      if (split === 'unreadable') return null;
      return triggerFrom(
        ctx,
        { on: 'etb', ...(split.condition ? { intervening: split.condition } : {}) },
        split.body,
        `Enters: ${match[1] ?? ''}`,
      );
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
            ...(compiled.targetsExcludeSelf ? { targetsExcludeSelf: true } : {}),
        ...(compiled.targetCount ? { targetCount: compiled.targetCount } : {}),
            ...(compiled.modal ? { modal: compiled.modal } : {}),
            ...(compiled.modal ? { modal: compiled.modal } : {}),
          },
        ],
      };
    },
  },
  // --- the counter keyword family (DESIGN §3.110) — the parametrised members ----
  // Pattern rules and not `KEYWORD_ABILITY_BUILDERS` entries for bushido's
  // reason: those builders take no argument and each of these carries a
  // number, a cost or a noun. Every rule refuses a card whose printed form is
  // outside its closed shape ("Modular—Sunburst", "Bloodthirst X", "Devour X")
  // by matching nothing, so the line reports through the sweep.
  {
    // MODULAR N (CR 702.43a) — "This creature enters with N +1/+1 counters on
    // it. When it dies, you may put its +1/+1 counters on target artifact
    // creature." The entry half is the definition field (CR 614.1c — applied
    // on EVERY entry path, so a reanimated 0/0 Arcbound Worker is a 1/1 and
    // not a state-based death); the death half is a `dies` trigger that
    // SNAPSHOTS the counters as it dies (last-known information) and aims at
    // UP TO one artifact creature — choosing none is the printed "may".
    // Creatures only: the current wording is "when this PERMANENT is put into
    // a graveyard", and a land with modular (Power Depot) would need a
    // death event this engine's `dies` does not emit for noncreatures — so it
    // keeps reporting rather than compiling a trigger that never fires.
    id: 'keyword-modular',
    description: '"Modular N" — enters with N +1/+1 counters; on death, may move them to target artifact creature',
    pattern: /^modular ([0-9]+)$/,
    build(match, ctx) {
      const amount = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(amount) || !ctx.card.typeLine.types.some((t) => /^creature$/i.test(t))) return null;
      return {
        entersWithCounters: [{ kind: PLUS_ONE_COUNTER, count: amount }],
        triggers: [
          {
            condition: { on: 'dies', snapshotsCounters: PLUS_ONE_COUNTER },
            effects: [{ primitive: 'modularMove' }],
            targets: 'artifactCreature',
            targetCount: { min: 0, max: 1 },
            label: `Modular ${amount}`,
          },
        ],
      };
    },
  },
  {
    // RENOWN N (CR 702.112a) — "When this creature deals combat damage to a
    // player, if it isn't renowned, put N +1/+1 counters on it and it becomes
    // renowned." The once-only designation is the intervening "if" reading the
    // `renowned` stamp the body writes.
    id: 'keyword-renown',
    description: '"Renown N" — the once-only combat-damage-to-a-player growth',
    pattern: /^renown ([0-9]+)$/,
    build(match) {
      const amount = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(amount)) return null;
      return {
        triggers: [
          {
            condition: { on: 'combatDamageToPlayer', intervening: { kind: 'sourceNotRenowned' } },
            effects: [{ primitive: 'becomeRenowned', params: { amount } }],
            label: `Renown ${amount}`,
          },
        ],
      };
    },
  },
  {
    // BLOODTHIRST N (CR 702.54a) — "If an opponent was dealt damage this turn,
    // this creature enters with N +1/+1 counters on it." An ENTRY-SCRIPT body
    // reading the turn-fact memory as the spell resolves. "Bloodthirst X"
    // (X = the damage dealt) is a count this memory does not keep: reports.
    id: 'keyword-bloodthirst',
    description: '"Bloodthirst N" — enters with N +1/+1 counters if an opponent was dealt damage this turn',
    pattern: /^bloodthirst ([0-9]+)$/,
    build(match, ctx) {
      const amount = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(amount) || !cardIsPermanent(ctx)) return null;
      return { effects: [{ primitive: 'bloodthirstCounters', params: { amount } }] };
    },
  },
  {
    // FABRICATE N (CR 702.123a) — "When this creature enters, you may put N
    // +1/+1 counters on it. If you don't, create N 1/1 colorless Servo
    // artifact creature tokens." ONE enters trigger whose body asks the
    // printed question AT RESOLUTION — see `fabricateChoice` for why this is
    // not a `ModalSpec` (CR 603.3c would lock the answer a window early).
    id: 'keyword-fabricate',
    description: '"Fabricate N" — an enters trigger offering N +1/+1 counters or, if declined, N Servos',
    pattern: /^fabricate ([0-9]+)$/,
    build(match) {
      const amount = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(amount)) return null;
      return {
        triggers: [
          {
            condition: { on: 'etb' },
            effects: [{ primitive: 'fabricateChoice', params: { amount } }],
            label: `Fabricate ${amount}`,
          },
        ],
      };
    },
  },
  {
    // BACKUP N (CR 702.165a/b) — "When this creature enters, put N +1/+1
    // counters on target creature. If that's another creature, it gains the
    // following abilities until end of turn." "The following abilities" are the
    // lines printed BELOW the backup line, read off the card's own text; the
    // rule compiles only when every one of them is a KEYWORD GRANT the
    // continuous layer can hand to another creature (a keyword list, or a
    // printed block restriction). A following activated or triggered ability
    // (Scorn-Blade Berserker, Archpriest of Shadows) has no grant seam yet, so
    // the whole line reports rather than granting half of what is printed.
    id: 'keyword-backup',
    description: '"Backup N" — N +1/+1 counters on target creature, and the abilities below it until end of turn',
    pattern: /^backup ([0-9]+)$/,
    build(match, ctx) {
      const amount = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(amount)) return null;
      const keywords = backupGrantedKeywords(ctx);
      if (keywords === null) return null;
      return {
        triggers: [
          {
            condition: { on: 'etb' },
            effects: [{ primitive: 'backup', params: { amount, keywords } }],
            targets: 'creature',
            label: `Backup ${amount}`,
          },
        ],
      };
    },
  },
  {
    // AFTERLIFE N (CR 702.135a) — "When this creature dies, create N 1/1 white
    // and black Spirit creature tokens with flying." Handed to the compiler as
    // the Oracle sentence it stands for, so the tokens come from the same
    // `create-creature-token` rule every printed token line uses.
    id: 'keyword-afterlife',
    description: '"Afterlife N" — the dies trigger making N 1/1 white and black flying Spirits',
    pattern: /^afterlife ([0-9]+)$/,
    build(match, ctx) {
      const amount = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(amount)) return null;
      return triggerFrom(
        ctx,
        { on: 'dies' },
        `create ${countWord(amount)} ${AFTERLIFE_TOKEN_FACE} token${amount === 1 ? '' : 's'} with flying`,
        `Afterlife ${amount}`,
      );
    },
  },
  {
    // DEVOUR [noun] N (CR 702.82a) — "As this creature enters, you may
    // sacrifice any number of [creatures]. It enters with N times that many
    // +1/+1 counters on it." An entry-script question; the noun is a row of
    // the closed `DEVOUR_NOUNS` table. "Devour X" (Thromok — X per creature
    // devoured, a square) is a count no row expresses: reports.
    id: 'keyword-devour',
    description: '"Devour N" / "Devour artifact N" / "Devour Food N" — the as-enters sacrifice-for-counters choice',
    pattern: /^devour (?:([a-z]+) )?([0-9]+)$/,
    build(match, ctx) {
      const amount = Number.parseInt(match[2] ?? '', 10);
      const filter = DEVOUR_NOUNS[match[1] ?? ''];
      if (!Number.isFinite(amount) || filter === undefined || !cardIsPermanent(ctx)) return null;
      return { effects: [{ primitive: 'devourChoice', params: { amount, filter } }] };
    },
  },
  {
    // OUTLAST {cost} (CR 702.107a) — "{cost}, {T}: Put a +1/+1 counter on this
    // creature. Activate only as a sorcery." An ordinary activated ability with
    // sorcery timing; a hybrid or {X} cost the mana parser refuses reports.
    id: 'keyword-outlast',
    description: '"Outlast {cost}" — the sorcery-speed tap-and-pay for a +1/+1 counter',
    pattern: /^outlast ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        activated: [
          {
            cost: { mana: cost, tap: true },
            effects: [{ primitive: 'addCounters', params: { amount: OUTLAST_COUNTERS, self: true } }],
            timing: 'sorcery',
            label: `Outlast ${formatManaCost(cost)}`,
          },
        ],
      };
    },
  },
  {
    // BUSHIDO N (CR 702.45a) — "Whenever this creature blocks or becomes
    // blocked, it gets +N/+N until end of turn."
    //
    // A PATTERN rule and not a `KEYWORD_ABILITY_BUILDERS` entry, because those
    // builders take no argument and bushido's entire payload is its number.
    // The body is handed back to the compiler as the Oracle sentence it stands
    // for, so the pump resolves to `self-pump-until-eot` — the same primitive
    // every other "~ gets +N/+N" line uses, rather than a second answer to the
    // same question.
    id: 'keyword-bushido',
    description: '"Bushido N" — the blocks-or-becomes-blocked self-pump',
    pattern: /^bushido ([0-9]+)$/,
    build(match, ctx) {
      const amount = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(amount)) return null;
      return triggerFrom(
        ctx,
        { on: 'blocksOrBecomesBlocked' },
        `~ gets +${amount}/+${amount} until end of turn`,
        `Bushido ${amount}`,
      );
    },
  },
  {
    // SOULSHIFT N (CR 702.46a, DESIGN §3.122) — "When this creature dies, you
    // may return target Spirit card with mana value N or less from your
    // graveyard to your hand."
    //
    // A pattern rule like bushido: the number is the whole payload. And it needs
    // nothing new — the return is the same `returnFromGraveyard` choice every
    // regrowth effect uses, narrowed by the `CardFilter` the primitive already
    // takes, so "Spirit card with mana value N or less" is two filter fields
    // rather than a second graveyard path (rule 12).
    //
    // `optional: true` is the printed "you MAY", and it matters: forced, a lone
    // Spirit in the graveyard would be returned even when the controller wants
    // it left for a later Soulshift or a graveyard cost.
    id: 'keyword-soulshift',
    description: '"Soulshift 4" — the dies trigger returning a cheap Spirit from the graveyard (Hundred-Talon Kami)',
    pattern: /^soulshift ([0-9]+)$/,
    build(match) {
      const limit = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(limit) || limit <= 0) return null;
      return {
        triggers: [
          {
            condition: { on: 'dies' as const },
            effects: [
              {
                primitive: 'returnFromGraveyard',
                params: {
                  count: 1,
                  optional: true,
                  filter: { anyOfSubtypes: ['Spirit'], maxManaValue: limit },
                },
              },
            ],
            label: `Soulshift ${limit}`,
          },
        ],
      };
    },
  },
  // --- the combat keyword family (DESIGN §3.107) --------------------------------
  {
    // RAMPAGE N (CR 702.23a) — "Whenever this creature becomes blocked, it gets
    // +N/+N until end of turn for each creature blocking it beyond the first."
    //
    // A pattern rule like bushido (the number is the payload), but NOT built
    // through `triggerFrom`: no Oracle sentence compiles to a count-scaled pump,
    // so the effect is authored directly — the same `pumpUntilEndOfTurn` every
    // pump uses, with a DERIVED power/toughness whose `times` is N. The count is
    // read as the ability resolves (CR 702.23b), off the live block map.
    id: 'keyword-rampage',
    description: '"Rampage N" — the becomes-blocked pump scaling with blockers beyond the first',
    pattern: /^rampage ([0-9]+)$/,
    build(match) {
      const amount = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(amount)) return null;
      const perBlocker = { countOf: 'creaturesBlockingThisBeyondFirst' as const, times: amount };
      return {
        triggers: [
          {
            condition: { on: 'becomesBlocked' },
            effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: perBlocker, toughness: perBlocker } }],
            label: `Rampage ${amount}`,
          },
        ],
      };
    },
  },
  {
    // "Whenever ~ blocks a creature with FLYING, ~ gets +2/+0 until end of
    // turn" (Netcaster Spider). The quality is a CONDITION on the other creature
    // in the pair, judged by the runtime against its effective keywords — so a
    // flier by anthem counts — and the nameable qualities are the closed
    // `BLOCKER_QUALITY_KEYWORDS` table.
    id: 'trigger-blocks-creature-with',
    description: '"Whenever ~ blocks a creature with KEYWORD, BODY"',
    pattern: /^whenever ~ blocks a creature with ([a-z ]+), (.+)$/,
    build(match, ctx) {
      const keyword = BLOCKER_QUALITY_KEYWORDS[(match[1] ?? '').trim()];
      if (keyword === undefined) return null;
      const body = selfBody(match[2] ?? '');
      return triggerFrom(ctx, { on: 'blocks', counterpartHasKeyword: keyword }, body, `Blocks a creature with ${match[1]}: ${body}`);
    },
  },
  {
    id: 'trigger-blocks',
    description: '"Whenever ~ blocks, BODY" — the blocker\'s half alone (Shu Defender)',
    pattern: /^whenever ~ blocks, (.+)$/,
    build(match, ctx) {
      const body = selfBody(match[1] ?? '');
      return triggerFrom(ctx, { on: 'blocks' }, body, `Blocks: ${body}`);
    },
  },
  {
    id: 'trigger-becomes-blocked',
    description: '"Whenever ~ becomes blocked, BODY" — the attacker\'s half alone (Deeproot Warrior)',
    pattern: /^whenever ~ becomes blocked, (.+)$/,
    build(match, ctx) {
      const body = selfBody(match[1] ?? '');
      return triggerFrom(ctx, { on: 'becomesBlocked' }, body, `Becomes blocked: ${body}`);
    },
  },
  {
    // The printed union bushido's reminder text spells out, on a card that
    // prints it directly rather than as the keyword.
    id: 'trigger-blocks-or-becomes-blocked',
    description: '"Whenever ~ blocks or becomes blocked, BODY"',
    pattern: /^whenever ~ blocks or becomes blocked, (.+)$/,
    build(match, ctx) {
      const body = selfBody(match[1] ?? '');
      return triggerFrom(ctx, { on: 'blocksOrBecomesBlocked' }, body, `Blocks or becomes blocked: ${body}`);
    },
  },
  // --- §3.106 upkeep costs and time counters -----------------------------------
  // Four keywords that are each "at the beginning of your upkeep, <bill or tick>"
  // (CR 702.30a, 702.24a, 702.63a, 702.32a). Pattern rules like bushido, because
  // each one's payload is its number or its cost; their labels start with the
  // keyword, which is what `TRIGGER_BACKED_KEYWORDS` reads as the evidence
  // that the printed line compiled.
  {
    // ECHO {cost} (CR 702.30a) — "At the beginning of your upkeep, if this
    // permanent came under your control since the beginning of your last
    // upkeep, sacrifice it unless you pay [cost]." The intervening "if" is a
    // real condition (checked twice, CR 603.4) reading the control stamp the
    // entry funnel writes; the body is the same pay-or-else the Pact bill uses,
    // with the sacrifice as its consequence and the source declared as the
    // stake for the pilot. "Echo—Discard a card" / "Echo—Sacrifice two lands"
    // print a non-mana cost outside the closed table and stay reported.
    id: 'keyword-echo',
    description: '"Echo {2}{R}" — the came-under-your-control upkeep bill, sacrifice unless paid',
    pattern: /^echo ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        triggers: [
          {
            condition: { on: 'upkeep', who: 'you', intervening: { kind: 'sourceControlledSinceLastUpkeep' } },
            effects: [
              {
                primitive: 'payManaOrElse',
                params: { cost, effects: [{ primitive: 'sacrificeSelf' }], stake: 'source' },
              },
            ],
            label: `Echo ${formatManaCost(cost)}`,
          },
        ],
      };
    },
  },
  {
    // CUMULATIVE UPKEEP {cost} (CR 702.24a) — an age counter, then a bill of
    // [cost] per age counter, else sacrifice. The mana form; `{S}` and "{W} or
    // {U}" are refused by the symbol parser / the pattern and stay reported.
    id: 'keyword-cumulative-upkeep-mana',
    description: '"Cumulative upkeep {1}" — an age counter, then pay the cost once per counter or sacrifice',
    pattern: /^cumulative upkeep[—-]? ?((?:\{[^}]+\})+)$/,
    build(match) {
      const mana = parseManaSymbols(match[1] ?? '');
      if (!mana) return null;
      return {
        triggers: [
          {
            condition: { on: 'upkeep', who: 'you' },
            effects: [{ primitive: 'cumulativeUpkeep', params: { mana } }],
            label: `Cumulative upkeep ${formatManaCost(mana)}`,
          },
        ],
      };
    },
  },
  {
    // The LIFE form — "Cumulative upkeep—Pay 1 life." (Gallowbraid, Morinfen,
    // Inner Sanctum). The other printed costs (a -1/-1 counter, a sacrifice,
    // a card from a graveyard) are outside the closed cost table and report.
    id: 'keyword-cumulative-upkeep-life',
    description: '"Cumulative upkeep—Pay N life." — the life-cost form',
    pattern: new RegExp(`^cumulative upkeep[—-] ?pay ${COUNT_TOKEN} life\\.?$`),
    build(match) {
      const life = parseCount(match[1]);
      if (life === null || life <= 0) return null;
      return {
        triggers: [
          {
            condition: { on: 'upkeep', who: 'you' },
            effects: [{ primitive: 'cumulativeUpkeep', params: { life } }],
            label: `Cumulative upkeep—Pay ${life} life`,
          },
        ],
      };
    },
  },
  {
    // VANISHING N (CR 702.63a) — enters with N time counters; at the beginning
    // of your upkeep, IF it has a time counter, remove one; when the last is
    // removed, sacrifice it. The bare "Vanishing" (Tidewalker, whose count is
    // a separate sentence) does not match and stays reported.
    id: 'keyword-vanishing',
    description: '"Vanishing 3" — enters with N time counters, one leaves each upkeep, sacrificed with the last',
    pattern: new RegExp(`^vanishing ${COUNT_TOKEN}$`),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null || count <= 0) return null;
      return {
        entersWithCounters: [{ kind: 'time', count }],
        triggers: [
          {
            condition: { on: 'upkeep', who: 'you', intervening: { kind: 'sourceHasCounter', counter: 'time' } },
            effects: [{ primitive: 'tickDownCounter', params: { counter: 'time', sacrificeWhen: 'lastRemoved' } }],
            label: `Vanishing ${count}`,
          },
        ],
      };
    },
  },
  {
    // FADING N (CR 702.32a) — enters with N fade counters; at the beginning of
    // your upkeep remove one, and if you can't, sacrifice it. No intervening
    // "if": the trigger fires with none left, which is exactly when it kills.
    id: 'keyword-fading',
    description: '"Fading 2" — enters with N fade counters, one leaves each upkeep, sacrificed when none can',
    pattern: new RegExp(`^fading ${COUNT_TOKEN}$`),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null || count <= 0) return null;
      return {
        entersWithCounters: [{ kind: 'fade', count }],
        triggers: [
          {
            condition: { on: 'upkeep', who: 'you' },
            effects: [{ primitive: 'tickDownCounter', params: { counter: 'fade', sacrificeWhen: 'noneToRemove' } }],
            label: `Fading ${count}`,
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
      // "it gets +0/+2" is the source pumping itself — see `selfBody` (§3.107).
      const body = selfBody(match[1] ?? '');
      return triggerFrom(ctx, { on: 'attacks' }, body, `Attacks: ${body}`);
    },
  },
  {
    // §3.111 — the card that RETURNS ITSELF from the graveyard as it arrives
    // there. Rancor's wording is "put into a graveyard from the battlefield",
    // which is neither `dies` (creatures only) nor `leaves` (an exiled Rancor
    // must not come back) — it is its own `TriggerEvent`. The body is the one
    // primitive the "{cost}: Return ~ from your graveyard to your hand"
    // template runs, so the two cannot disagree about which hand it goes to.
    // Whole-line rather than a body rule, so "return it to its owner's hand"
    // as a spell's second sentence (about a target) is never mistaken for it.
    id: 'trigger-returns-self-to-hand-from-graveyard',
    description:
      `"When ~ is put into a graveyard from the battlefield, return it to its owner's hand." (Rancor) / "When ~ dies, return it to its owner's hand."`,
    pattern: /^when ~ (dies|is put into a graveyard from the battlefield), return it to its owner['’]s hand$/,
    build(match) {
      const on: TriggerCondition['on'] = match[1] === 'dies' ? 'dies' : 'putIntoGraveyardFromBattlefield';
      return {
        triggers: [
          {
            condition: { on },
            effects: [{ primitive: 'returnSourceFromGraveyard', params: { to: 'hand' } }],
            label: match[1] === 'dies' ? "Dies: return it to its owner's hand" : "Put into a graveyard: return it to its owner's hand",
          },
        ],
      };
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
    id: 'trigger-dies-you-may',
    description: '"When ~ dies, you may BODY" (Solemn Simulacrum, Pilgrim\'s Eye)',
    // Ordered AFTER `trigger-dies`, for the reason spelled out on
    // `trigger-etb-you-may`: a body that implements its own option plays better
    // on the rule that knows about it, and this is the general fallback. The
    // plain rule above is tried first and returns null when the whole
    // "you may …" string compiles to nothing, which is what lets this one see
    // the card at all.
    pattern: /^when ~ dies, you may (.+)$/,
    build(match, ctx) {
      const body = match[1] ?? '';
      return optionalTriggerFrom(ctx, { on: 'dies' }, body, `Dies: you may ${body}`);
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
    id: 'pact-upkeep-bill',
    description:
      `"At the beginning of your next upkeep, pay {COST}. If you don't, you lose the game." (the Pact cycle: Pact of Negation, Slaughter Pact, Summoner's Pact)`,
    /*
     * A DELAYED triggered ability (CR 603.7) created as the free spell
     * RESOLVES, not a static on a permanent — the Pact is an instant that is
     * already in the graveyard when the bill comes due, so nothing on the
     * battlefield could carry this trigger. That is exactly what
     * `createDelayedTrigger` is for, and why this rule is possible at all now.
     *
     * "YOUR NEXT upkeep" is `{ on: 'upkeep', who: 'you' }` on a delayed ability,
     * which fires ONCE and is then removed — the engine's delayed matcher does
     * that for every delayed ability, so "next" needs no extra machinery.
     *
     * The consequence is compiled through the ordinary table rather than
     * hard-coded to losing: `payManaOrElse` takes effect refs, so a printed
     * "if you don't, sacrifice it" costs a rule-table entry and no engine work.
     */
    // A plain regex literal, not a template: the cost run needs no
    // interpolation, and the template form forced double-escaping that lint
    // (rightly) flagged as useless.
    pattern: /^at the beginning of your next upkeep, pay ((?:\{[^}]+\})+)\. if you don't, (.+)$/,
    build(match, ctx) {
      const cost = parseManaSymbols(match[1] ?? '');
      // A cost with a symbol the engine cannot pay from a pool (hybrid, {X},
      // Phyrexian) reports the whole line: a Pact whose bill is unpayable-by-
      // parsing would be a free spell with no drawback at all.
      if (!cost) return null;
      const consequence = ctx.compileEffectClause(match[2] ?? '', { targetFree: true });
      if (!consequence || consequence.length === 0) return null;
      return effects({
        primitive: 'scheduleDelayedPayment',
        params: {
          cost,
          effects: [...consequence],
          label: match[0],
        },
      });
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
      // A MODAL body has empty effects on purpose (the chosen modes replace
      // them); it is never optional-wrapped here.
      if (compiled === null || (compiled.effects.length === 0 && compiled.modal === undefined)) return null;
      if (compiled.modal !== undefined && optional) return null;
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
            ...(compiled.targetsExcludeSelf ? { targetsExcludeSelf: true } : {}),
        ...(compiled.targetCount ? { targetCount: compiled.targetCount } : {}),
            ...(compiled.modal ? { modal: compiled.modal } : {}),
            ...(compiled.modal ? { modal: compiled.modal } : {}),
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
      // "…you gain life equal to ITS toughness" (§3.149). On an ENTERS trigger
      // the only object the body names is the permanent that just arrived, and
      // it is still on the battlefield when the ability resolves — so "its" is
      // provable here and is spelled out for the effect table. On a DIES trigger
      // it is NOT: the object has left and its P/T would need CR 608.2h last
      // known information, which this engine does not keep. Leaving "its" alone
      // there is what makes those cards report instead of reading zero.
      const raw = optional ? body.slice('you may '.length) : body;
      const inner = event === 'permanentEnters' ? resolveItsReferent(raw, "that creature's") : raw;
      const compiled = ctx.compileTriggerBody(inner);
      // A MODAL body has empty effects on purpose (the chosen modes replace
      // them); it is never optional-wrapped here.
      if (compiled === null || (compiled.effects.length === 0 && compiled.modal === undefined)) return null;
      if (compiled.modal !== undefined && optional) return null;
      const effectRefs = optional ? mayEffectsFrom(inner, compiled.effects) : compiled.effects;
      if (effectRefs === null) return null;
      // A body that reads "that creature's toughness" needs the event's SUBJECT
      // carried to the resolution (`triggeringInstances`). Opt-in, exactly as
      // evolve's is: a trigger whose body never asks stays byte-identical, so
      // this cannot change what any already-compiled card does.
      const carriesSubject = readsTriggeringObject(effectRefs);
      // A DIES trigger can never carry a live subject — the guard above should
      // already have kept "its power" unresolved there, and this is the second
      // lock on the same door: a printed "that creature's power" on a death
      // reports rather than resolving against a permanent that is not there.
      if (carriesSubject && event !== 'permanentEnters') return null;
      return {
        triggers: [
          {
            condition: {
              on: event,
              who,
              permanentFilter: filter,
              ...(another ? { excludeSelf: true } : {}),
              ...(carriesSubject ? { carriesSubject: true } : {}),
            },
            effects: effectRefs,
            label: `${another ? 'another ' : ''}${tokenWord ? `${tokenWord} ` : ''}${noun} (${who}) ${match[10]}: ${body}`,
            ...(compiled.targets ? { targets: compiled.targets } : {}),
            ...(compiled.targetsExcludeSelf ? { targetsExcludeSelf: true } : {}),
        ...(compiled.targetCount ? { targetCount: compiled.targetCount } : {}),
            ...(compiled.modal ? { modal: compiled.modal } : {}),
            ...(compiled.modal ? { modal: compiled.modal } : {}),
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
    id: 'trigger-cast-spell-you-may',
    description:
      '"Whenever you cast a(n) TYPE spell, you may BODY" (Mesa Enchantress, Verduran Enchantress)',
    // Ordered AFTER `trigger-cast-spell`, the same way every other optional
    // sibling in this table is.
    //
    // It cannot use `optionalTriggerFrom`, which builds ONE trigger: a printed
    // type word can mean SEVERAL engine filters (`spellFiltersFor` returns a
    // list), and each of those conditions gets its OWN `mayEffects` wrapper. A
    // card whose filter expands to two conditions therefore asks exactly once
    // per occurrence rather than once for the card.
    pattern: /^whenever you cast an? ([a-z ]+?) spell, you may (.+)$/,
    build(match, ctx) {
      const conditions = spellFiltersFor(match[1] ?? '');
      if (!conditions) return null;
      const body = match[2] ?? '';
      const compiled = ctx.compileTriggerBody(body);
      if (compiled === null) return null;
      const effectRefs = mayEffectsFrom(body, compiled.effects);
      if (effectRefs === null || effectRefs.length === 0) return null;
      return {
        triggers: conditions.map((condition) => ({
          condition,
          effects: effectRefs,
          label: `Cast ${describeSpellFilter(condition)}: you may ${body}`,
          ...(compiled.targets ? { targets: compiled.targets } : {}),
          ...(compiled.targetCount ? { targetCount: compiled.targetCount } : {}),
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
    id: 'trigger-draws-card-you-may',
    description:
      '"Whenever you / a player / an opponent draws a card, you may BODY" (Consecrated Sphinx)',
    // Ordered AFTER `trigger-draws-card`, like every other optional sibling.
    pattern: /^whenever (you|a player|an opponent) draws a card, you may (.+)$/,
    build(match, ctx) {
      const printed = match[1] ?? '';
      const who: TriggerWho = printed === 'you' ? 'you' : printed === 'an opponent' ? 'opponent' : 'any';
      const body = match[2] ?? '';
      return optionalTriggerFrom(
        ctx,
        { on: 'drawsCard', who },
        body,
        `${printed} draws: you may ${body}`,
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
    id: 'trigger-life-loss',
    description:
      '"Whenever an opponent loses life, BODY" / "Whenever you lose life, BODY" (Exquisite Blood, Bloodthirsty Conqueror)',
    // The mirror of `trigger-gain-life`, on core's `lifeLoss` event — which is
    // keyed on a NEGATIVE `lifeChanged`, so damage counts as life loss exactly
    // as CR 118.3 says it does.
    pattern: /^whenever (an opponent|a player|you) loses? life, (.+)$/,
    build(match, ctx) {
      const printed = match[1] ?? '';
      const who = printed === 'an opponent' ? 'opponent' : printed === 'a player' ? 'any' : 'you';
      return triggerFrom(
        ctx,
        { on: 'lifeLoss', who },
        match[2] ?? '',
        `${printed} loses life: ${match[2] ?? ''}`,
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
    id: 'trigger-creature-combat-damage-to-player',
    description: '"Whenever a creature you control deals combat damage to a player, [you may] BODY" (Bident of Thassa)',
    // PER-CREATURE: three connecting creatures fire it three times — the group
    // "one or more" wording one rule down is the once-per-batch sibling.
    pattern: /^whenever a creature you control deals combat damage to a player, (you may )?(.+)$/,
    build(match, ctx) {
      const body = match[2] ?? '';
      const condition = { on: 'creatureCombatDamageToPlayer' } as const;
      const label = `A creature you control deals combat damage to a player: ${match[1] ?? ''}${body}`;
      return match[1] !== undefined
        ? optionalTriggerFrom(ctx, condition, body, label)
        : triggerFrom(ctx, condition, body, label);
    },
  },
  {
    id: 'trigger-group-combat-damage-to-player',
    description: '"Whenever one or more creatures you control deal combat damage to a player, BODY"',
    // A GROUP trigger: fires once per damage batch however many creatures
    // connected — core's `groupCombatDamageToPlayer` and its runtime dedup.
    pattern: /^whenever one or more creatures you control deal combat damage to a player, (.+)$/,
    build(match, ctx) {
      return triggerFrom(
        ctx,
        { on: 'groupCombatDamageToPlayer' },
        match[1] ?? '',
        `Your creatures deal combat damage to a player: ${match[1] ?? ''}`,
      );
    },
  },
  {
    id: 'trigger-combat-damage-to-player',
    description: '"Whenever ~ deals combat damage to a player, BODY" (Gregor, Shrewd Magistrate)',
    pattern: /^whenever ~ deals combat damage to a player, (.+)$/,
    build(match, ctx) {
      // §3.149 — the THIRD seam where the bare word "its" is provable: this
      // trigger names `~` as its subject and nothing else, and `~` is on the
      // battlefield (it just dealt combat damage). "…, draw cards equal to its
      // power" is Gregor. `resolveItsReferent` still declines any body that
      // names a second object, so nothing here is a guess.
      const body = resolveItsReferent(match[1] ?? '', "~'s");
      return triggerFrom(
        ctx,
        { on: 'combatDamageToPlayer' },
        body,
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
  // --- the spell-count family (DESIGN §3.113): the cast-trigger keywords -------
  // Each is a `keyword-` rule so the keyword-line compiler tries it on a word
  // of a list ("Cascade, cascade" is two words, hence two triggers — CR
  // 702.85a is one ability per instance; 702.40b / 702.60b say so for storm
  // and ripple). The body is a cards-package primitive handed to core as data,
  // exactly as a suspend tick is; core pushes the trigger as the spell is cast.
  {
    id: 'keyword-storm',
    description: '"Storm" (CR 702.40a) — copy the spell once per spell cast before it this turn (Grapeshot, Empty the Warrens)',
    pattern: /^storm$/,
    build() {
      return { castTriggers: [{ keyword: 'storm', label: 'Storm', effects: [{ primitive: 'stormCopies' }] }] };
    },
  },
  {
    id: 'keyword-cascade',
    description:
      '"Cascade" (CR 702.85a) — exile from the top until a cheaper nonland card, cast it free, bottom the rest at random (Bloodbraid Elf, Shardless Agent)',
    pattern: /^cascade$/,
    build() {
      return { castTriggers: [{ keyword: 'cascade', label: 'Cascade', effects: [{ primitive: 'cascade' }] }] };
    },
  },
  {
    id: 'keyword-ripple',
    description: '"Ripple N" (CR 702.60a) — reveal the top N, cast the same-name ones free, bottom the rest (Surging Flame)',
    pattern: /^ripple ([0-9]+)$/,
    build(match) {
      const count = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(count) || count <= 0) return null;
      return {
        castTriggers: [
          { keyword: 'ripple', label: `Ripple ${count}`, effects: [{ primitive: 'ripple', params: { count } }] },
        ],
      };
    },
  },
]);

// --- mana abilities -------------------------------------------------------------

/** Card-level static properties printed as their own ability line. */
/**
 * The spell scopes a printed cost reduction may name, each as the `CardFilter`
 * the engine's `castManaCostFor` matches the CAST FACE against. Closed for the
 * usual reason: a scope read loosely reduces spells the printed card does not.
 */
const CAST_REDUCTION_SCOPES: Readonly<Record<string, CardFilter>> = Object.freeze({
  'instant and sorcery': { anyOfTypes: ['instant', 'sorcery'] },
  creature: { anyOfTypes: ['creature'] },
  noncreature: { noneOfTypes: ['creature'] },
  artifact: { anyOfTypes: ['artifact'] },
  enchantment: { anyOfTypes: ['enchantment'] },
  white: { anyOfColors: ['W'] },
  blue: { anyOfColors: ['U'] },
  black: { anyOfColors: ['B'] },
  red: { anyOfColors: ['R'] },
  green: { anyOfColors: ['G'] },
});

export const STATIC_RULES: readonly CompileRule[] = Object.freeze([
  {
    // COST ASSISTANCE — Convoke (CR 702.51), Improvise (CR 702.126), Delve
    // (CR 702.66). Three names for one shape: a resource other than mana pays
    // part of this spell, and the closed `COST_ASSISTS` table in core says which
    // resource and whether it can cover a coloured pip.
    //
    // Each prints as a bare keyword line with the mechanic in reminder text,
    // which is stripped before we see it — so the line IS the whole ability, and
    // one rule reads all three rather than three rules that could drift.
    //
    // ⚠️ "Convoke, delve" (one card prints both) does NOT match, and reports.
    // The field names ONE kind, and the honest failure is a card that says so
    // rather than one that silently convokes and forgets to delve.
    id: 'cost-assist-keyword',
    description: '"Convoke" / "Improvise" / "Delve" (Chord of Calling, Reverse Engineer, Treasure Cruise)',
    pattern: /^(convoke|improvise|delve)$/,
    build(match) {
      const kind = match[1];
      if (kind !== 'convoke' && kind !== 'improvise' && kind !== 'delve') return null;
      return { costAssist: kind };
    },
  },
  {
    // AFFINITY (CR 702.40). Scryfall prints the keyword line and puts the whole
    // rule in reminder text, which is stripped before we get here — so the two
    // printings of one mechanic are matched by ONE rule with two spellings of
    // the same idea, rather than by two rules that could drift apart.
    //
    // The noun goes through `permanentNounFilter`, the same closed table every
    // other selector reads, and then through `AFFINITY_SUBTYPE_NOUNS`, the
    // closed list of SUBTYPES a printed affinity names — so "affinity for
    // Dwarves" (not printed on any card) REPORTS rather than quietly compiling
    // into "for each creature", which would make the spell far cheaper than
    // printed, while "affinity for Slivers" counts Slivers through the same
    // `anyOfSubtypes` filter every lord and typal search reads.
    id: 'affinity-cost-reduction',
    description:
      '"Affinity for artifacts" / "This spell costs {1} less to cast for each artifact you control" (Myr Enforcer, Frogmite; Thrumming Hivepool for a subtype)',
    pattern:
      /^(?:affinity for ([a-z]+)|(?:this spell|~) costs \{(\d+)\} less to cast for each ([a-z]+) you control)$/,
    build(match) {
      const noun = match[1] ?? match[3] ?? '';
      const filter = permanentNounFilter(noun) ?? AFFINITY_SUBTYPE_NOUNS[noun];
      if (filter === undefined) return null;
      const amount = match[2] === undefined ? 1 : parseSignedInt(match[2]);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      return { castCostReductionPerPermanent: { amount, filter } };
    },
  },
  {
    id: 'cast-cost-reduction',
    description:
      '"Instant and sorcery spells you cast cost {1} less to cast." (Goblin Electromancer; the Medallion cycle prints the colour form)',
    // A CLOSED list of spell scopes, each mapping to the shared `CardFilter`.
    // "Spells your opponents cast cost more" is a different system (a tax on the
    // other seat) and deliberately does not match.
    pattern:
      /^(instant and sorcery|creature|artifact|enchantment|noncreature|white|blue|black|red|green) spells you cast cost \{(\d+)\} less to cast$/,
    build(match) {
      const amount = parseSignedInt(match[2] ?? '');
      if (!Number.isFinite(amount) || amount <= 0) return null;
      const scope = match[1] ?? '';
      const filter = CAST_REDUCTION_SCOPES[scope];
      if (filter === undefined) return null;
      return { castCostReduction: { amount, ...(Object.keys(filter).length > 0 ? { filter } : {}) } };
    },
  },
  {
    id: 'additional-land-plays',
    description:
      '"You may play an additional land on each of your turns." (Exploration, Dryad of the Ilysian Grove) / "…two additional lands" (Azusa)',
    pattern: /^you may play (an|two|three) additional lands? on each of your turns$/,
    build(match) {
      const counts: Record<string, number> = { an: 1, two: 2, three: 3 };
      const extra = counts[match[1] ?? ''];
      if (extra === undefined) return null;
      return { additionalLandPlays: extra };
    },
  },
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
    id: 'replacement-token-doubling',
    description:
      '"If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead." (Anointed Procession, Parallel Lives, Doubling Season) / "If one or more [creature] tokens would be created under your control, twice/three times that many…" (Mondrak, Ojer Taq)',
    // MULTIPLICATIVE outcomes only, structurally: token creation runs one
    // funnel call per token and `times` composes per call, while a "plus one"
    // would compound per token instead of per batch — so no plus alternation
    // appears in this pattern at all, and such a card keeps reporting.
    pattern: new RegExp(
      `^if (?:an effect would create one or more|one or more (creature )?tokens would be created under your control, ` +
        `${REPLACEMENT_MULTIPLIER_TOKEN} that many of those tokens are created instead|an effect would create one or more tokens under your control, it creates ` +
        `${REPLACEMENT_MULTIPLIER_TOKEN} that many of those tokens instead)$`,
    ),
    build(match, ctx) {
      if (!cardIsPermanent(ctx)) return null;
      const creatureOnly = match[1] !== undefined;
      const times = REPLACEMENT_MULTIPLIERS[match[2] ?? match[3] ?? ''];
      if (times === undefined) return null;
      return {
        replacements: [
          {
            event: 'tokens',
            applies: {
              recipientController: 'you',
              ...(creatureOnly ? { recipientFilter: { anyOfTypes: ['creature'] } } : {}),
            },
            outcome: { times },
            label: match[0],
          },
        ],
      };
    },
  },
  {
    /**
     * "If an effect would create one or more tokens under your control, it
     * creates TWICE THAT MANY of those tokens instead" (Doubling Season's other
     * half, Parallel Lives, Anointed Procession) and the passive wording "If one
     * or more tokens would be created under your control, twice that many of
     * those tokens are created instead" (Mondrak, Elspeth Storm Slayer, Exalted
     * Sunborn).
     *
     * ⚠️ WHAT THIS RULE REFUSES, and why each refusal is the contract working
     * rather than a gap in the layer:
     *  - "…those tokens **plus an additional Food token**" (Peregrin Took) and
     *    "…plus **that many 1/1 green Squirrel** tokens" (Chatterfang): the
     *    replacement creates a DIFFERENT object, not more of the same one.
     *  - "…**instead create one of each**" (Academy Manufactor) — likewise.
     *  - "…that many **4/4 white Angel** tokens are created instead" (Divine
     *    Visitation): the tokens are replaced, not counted.
     *  - "If one or more **creature** tokens…" (Ojer Taq): the clause narrows by
     *    what the token IS, and the replaced event is a count under a player —
     *    the tokens do not exist yet, so there is no object to filter on.
     * Each is a genuinely different outcome and stays reported.
     */
    id: 'replacement-tokens-multiplied',
    description:
      '"If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead" (Doubling Season, Parallel Lives, Anointed Procession, Mondrak) — CR 614',
    pattern: new RegExp(
      `^if (?:an effect would create one or more tokens|one or more tokens would be created) ` +
        `under (your|a player's) control, ` +
        `(?:it creates ${REPLACEMENT_MULTIPLIER_TOKEN} that many of those tokens|` +
        `${REPLACEMENT_MULTIPLIER_TOKEN} that many of those tokens are created) instead$`,
    ),
    build(match, ctx) {
      if (!cardIsPermanent(ctx)) return null;
      const times = REPLACEMENT_MULTIPLIERS[match[2] ?? match[3] ?? ''];
      if (times === undefined) return null;
      return {
        replacements: [
          {
            event: 'tokens',
            applies: {
              // "under YOUR control" is the ability's own controller; "under A
              // PLAYER'S control" (Primal Vigor) is the symmetric card and must
              // not be quietly read as "yours" — the same rule the damage
              // clause's missing controller tail follows.
              recipientController: match[1] === 'your' ? 'you' : 'any',
            },
            outcome: { times },
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
      '"Prevent all [combat|noncombat] damage that would be dealt TO / BY / TO AND DEALT BY <subject> [by <source class>]" on a permanent — every row of PREVENTION_STATIC_SUBJECTS (Fog Bank, Gaseous Form, Dolmen Gate, Cho-Manno, Muzzle, General\'s Kabuto, Champion Lancer)',
    pattern: new RegExp(
      `^prevent all (combat |noncombat )?damage that would be dealt (to and dealt by|to|by) ${PREVENTION_STATIC_SUBJECT_TOKEN}` +
        `(?: by ${PREVENTION_SOURCE_CLASS_TOKEN})?$`,
    ),
    build(match, ctx) {
      if (!cardIsPermanent(ctx)) return null;
      const combatWord = match[1]?.trim();
      const direction = match[2] ?? '';
      const subject = PREVENTION_STATIC_SUBJECTS[match[3] ?? ''];
      if (subject === undefined) return null;
      // "…by artifact creatures" and kin are OUTSIDE the closed table; the
      // optional group simply does not match them, so the whole clause reports.
      const sourceClass = match[4] === undefined ? undefined : PREVENTION_SOURCE_CLASSES[match[4]];
      if (match[4] !== undefined && sourceClass === undefined) return null;
      const combat: ReplacementApplies =
        combatWord === 'combat' ? { combat: true } : combatWord === 'noncombat' ? { combat: false } : {};

      // "TO AND DEALT BY" is TWO replacement effects, not one with two filters,
      // and that is the faithful reading: CR 615 lets each be applied to its own
      // event independently, and a single entry would have to admit an event
      // matching EITHER side, which is a conjunction the filter cannot state.
      // Fog Bank is exactly this card, and each half is an ordinary row.
      const sides: ReplacementApplies[] = [];
      if (direction === 'to' || direction === 'to and dealt by') {
        sides.push({ ...combat, ...subject.recipient, ...(sourceClass ?? {}) });
      }
      if (direction === 'by' || direction === 'to and dealt by') {
        // A subject with no dealer projection has no printed by-form the engine
        // can express — refuse the clause rather than guess which side it meant.
        if (subject.dealer === null) return null;
        // "…dealt BY X by <source class>" is not a printed sentence — the tail
        // narrows the DEALER, and the dealer is already pinned. Refuse rather
        // than silently dropping one of the two narrowings.
        if (sourceClass !== undefined) return null;
        sides.push({ ...combat, ...subject.dealer });
      }
      if (sides.length === 0) return null;
      return {
        replacements: sides.map((applies) => ({
          event: 'damage' as const,
          applies,
          outcome: { preventAll: true },
          label: match[0],
        })),
      };
    },
  },
  {
    /**
     * §3.151 — "If you would gain life, you gain twice that much life instead"
     * (Rhox Faithmender, Boon Reflection, Alhammarret's Archive, The Wind
     * Crystal), "…that much life plus N instead" (Knight of Dawn's Light), and
     * "if a player would gain life, that player gains no life instead"
     * (Sulfuric Vortex).
     *
     * A fifth EVENT KIND on a layer that already existed — it scales a quantity
     * exactly as the counter and token doublers do, so it adds no field to
     * `ReplacementApplies` and no branch to the engine loop.
     *
     * ⚠️ "No life instead" compiles to `times: 0`, and that is exact rather than
     * approximate: `fold` multiplies, the amount becomes zero, and core's life
     * funnel emits NOTHING for a gain of zero (CR 118.5) — so "whenever you gain
     * life" correctly does not fire. A `preventAll` would have been the wrong
     * verb: prevention is CR 615 and applies to damage, and it would have
     * reported a `prevented` quantity in the log for an event that deals none.
     *
     * What this rule deliberately does NOT match, each REPORTED with its count
     * in §3.151 rather than widened to fit:
     *   - "…draw that many cards instead" — a different ACTION, not a scaled
     *     quantity (the vocabulary `replacement.ts`'s header excludes).
     *   - "…that player loses that much life instead" (Tainted Remedy, Plague
     *     Drone) — turns a gain into a LOSS, a different event.
     *   - "…while you have N or less life" — a life-total condition the filter
     *     has no field for.
     */
    id: 'replacement-lifegain',
    description:
      '"If you / a player would gain life, … twice that much / that much plus N / no life instead" (Rhox Faithmender, Knight of Dawn\'s Light, Sulfuric Vortex)',
    pattern: new RegExp(
      `^if ${LIFEGAIN_SUBJECT_TOKEN} would gain life, (?:you|that player) gains? ` +
        `(?:${REPLACEMENT_MULTIPLIER_TOKEN} that much life|that much life plus ${COUNT_TOKEN}|no life) instead$`,
    ),
    build(match, ctx) {
      if (!cardIsPermanent(ctx)) return null;
      const scope = LIFEGAIN_SUBJECTS[match[1] ?? ''];
      if (scope === undefined) return null;
      const multiplierWord = match[2];
      const plusWord = match[3];
      // Exactly one of the three printed outcomes. "No life" is the form that
      // matched neither capture group.
      const outcome: ReplacementOutcome =
        multiplierWord !== undefined
          ? { times: REPLACEMENT_MULTIPLIERS[multiplierWord] as number }
          : plusWord !== undefined
            ? { plus: parseCount(plusWord) as number }
            : { times: 0 };
      if (outcome.times !== undefined && Number.isNaN(outcome.times)) return null;
      if (outcome.plus !== undefined && (outcome.plus === null || outcome.plus <= 0)) return null;
      return {
        replacements: [
          {
            event: 'lifegain',
            applies: scope === 'any' ? {} : { recipientController: scope },
            outcome,
            label: match[0],
          },
        ],
      };
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
    // §3.110 — "If ~ was kicked, it enters with N +1/+1 counters on it"
    // (Aether Figment, Academy Drake, Viashino Branchrider). The kicked entry
    // script's own counters, gated on the cast-time answer through the same
    // `ifKicked` wrapper every "if this spell was kicked" body rides — read off
    // the resolution frame, which is exactly when the printed replacement
    // asks (CR 614.1c, 702.33d).
    id: 'enters-with-counters-if-kicked',
    description: '"If ~ was kicked, it enters with N +1/+1 counters on it"',
    pattern: new RegExp(
      `^if (?:~|it) was kicked, (?:~|it) enters(?: the battlefield)? with (?:a|${COUNT_TOKEN}) \\+1/\\+1 counters? on it\\.?$`,
    ),
    build(match) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      return {
        effects: [
          {
            primitive: 'ifKicked',
            params: { effects: [{ primitive: 'addCounters', params: { amount, self: true } }] },
          },
        ],
      };
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
    // §3.149 — "~ enters with three CHARGE counters on it" (Trigon of
    // Corruption, Blast Zone, Surge Node), "with three WISH counters" (Ring of
    // Three Wishes). The +1/+1 sibling above with the kind read from the closed
    // {@link INERT_COUNTER_KINDS} table; CR 614.1c puts these on as the
    // permanent enters, which `addCounters`' self path already handles for a
    // card still resolving into play.
    //
    // ⚠️ The counters are REAL but INERT: this rule alone does not make the card
    // playable, because the line that spends them ("{T}, Remove three charge
    // counters from ~: …") still has to compile. That is the intended outcome —
    // the card reports until both halves exist, and never enters the pool with
    // half its text.
    id: 'enters-with-named-counters',
    description: '"~ enters with N <inert-kind> counters on it"',
    pattern: new RegExp(
      `^~ enters(?: the battlefield)? with (?:an?|${COUNT_TOKEN}) (${INERT_COUNTER_KIND_TOKEN}) counters? on it\\.?$`,
    ),
    build(match) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      const kind = inertCounterKind(match[2] ?? '');
      if (amount === null || amount <= 0 || kind === null) return null;
      return { effects: [{ primitive: 'addCounters', params: { amount, kind, self: true } }] };
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
    // §3.150 — the does-not-untap family's SELF printing (Basalt Monolith, Grim
    // Monolith, Battered Golem, Spectral Force): 35 corpus clauses, 9 of them the
    // card's only blocker. A printed keyword on the card itself, so it needs no
    // static at all — the continuous layer reads `def.keywords` as the base set
    // that every grant ORs onto, which is why one flag serves the self, the Aura
    // and the Equipment printings from three different places.
    id: 'self-does-not-untap',
    description: `"~ doesn't untap during your untap step" (Basalt Monolith, Grim Monolith)`,
    // "during YOUR untap step" when the card prints it about itself, "during ITS
    // CONTROLLER'S" when a granted line does; both name the same step, because a
    // permanent only ever untaps in its own controller's.
    pattern: /^~ doesn'?t untap during (?:your|its controller'?s) untap step$/,
    build() {
      return { keywords: { doesNotUntap: true } };
    },
  },
  // ⚠️ "~ doesn't untap during your untap step IF IT HAS A DEPLETION COUNTER ON
  // IT" (Veldt, Lava Tubes) stays REPORTED: `KeywordFlags` is unconditional, and
  // a conditional continuous ability needs a static whose `affects` can read a
  // counter on the SOURCE. Dropping the condition makes a land that never
  // untaps.
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
  // --- the combat keyword family (DESIGN §3.107): one-clause combat templates ----
  {
    // The dual of the rule above: a CAP on blockers rather than a minimum,
    // judged at the same declaration-level site (Norwood Riders, Charging Rhino).
    id: 'cant-be-blocked-by-more-than-n',
    description: `"~ can't be blocked by more than one creature"`,
    pattern: new RegExp(`^~ can'?t be blocked by more than ${COUNT_TOKEN} creatures?$`),
    build(match) {
      const cap = parseCount(match[1]);
      if (cap === null || cap < 1) return null;
      return { keywords: { maxBlockers: cap } };
    },
  },
  {
    // The BLOCKER'S own restriction on what it may block (Welkin Tern, Cloud
    // Sprite): the attacker must carry one of the named keywords. The nameable
    // qualities are the closed `BLOCKER_QUALITY_KEYWORDS` table, exactly as for
    // "except by creatures with …" — "can block only Walls" keeps reporting.
    id: 'can-block-only-creatures-with',
    description: `"~ can block only creatures with flying"`,
    pattern: /^~ can block only creatures with ([a-z ]+)$/,
    build(match) {
      const keyword = BLOCKER_QUALITY_KEYWORDS[(match[1] ?? '').trim()];
      if (keyword === undefined) return null;
      return { keywords: { blockOnly: { attackerMustHaveAnyOf: [keyword] } } };
    },
  },
  {
    // An attack REQUIREMENT (CR 508.1d) — the attacker-side mirror of "must be
    // blocked if able" (Goblin Brigand, Bloodrock Cyclops). Judged by core's
    // `attack-requirements.ts`, which also performs the forced declaration when
    // the active player passes the step.
    id: 'attacks-each-combat-if-able',
    description: '"~ attacks each combat if able" — an attack REQUIREMENT (CR 508.1d)',
    pattern: /^~ attacks each combat if able$/,
    build() {
      return { keywords: { mustAttack: true } };
    },
  },
  {
    // An attack RESTRICTION (CR 508.1c) reading the defender's lands through
    // the same closed table landwalk uses (Sea Monster, Red Cliffs Armada).
    id: 'cant-attack-unless-defender-controls',
    description: `"~ can't attack unless defending player controls an Island"`,
    pattern: /^~ can'?t attack unless defending player controls (an? [a-z ]+)$/,
    build(match) {
      const condition = LAND_CONDITION_PHRASES[(match[1] ?? '').trim()];
      if (condition === undefined) return null;
      return { keywords: { cantAttackUnlessDefenderControls: [condition] } };
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
      const life = match[2] === undefined ? undefined : parseSignedInt(match[2]);
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
    // §3.106 — SUSPEND N—{cost} (CR 702.62a). The static half is the engine's
    // `suspendCard` special action, read off `CardDefinition.suspend`; the
    // exile-side upkeep tick is handed over as a body exactly as cycling's is,
    // so core never names a primitive. "Suspend X—{X}{W}{W}. X can't be 0."
    // does not match — the count is a cast-time choice this record cannot
    // hold — and the cards that give the exiled card further abilities report
    // through those lines.
    id: 'suspend-cost',
    description: '"Suspend 4—{1}{U}" — exile from hand with N time counters, tick each upkeep, cast free when the last leaves',
    pattern: new RegExp(`^suspend ${COUNT_TOKEN}[—-] ?((?:\\{[^}]+\\})+)$`),
    build(match) {
      const count = parseCount(match[1]);
      if (count === null || count <= 0) return null;
      const cost = parseManaSymbols(match[2] ?? '');
      if (!cost) return null;
      return { suspend: { count, cost, upkeep: [{ primitive: 'suspendTick' }] } };
    },
  },
  // --- §3.112 the cast-alternative family --------------------------------------------
  //
  // Every rule below is a whole printed ability line whose payload is a MANA
  // cost, read through `parseManaSymbols` so a cost the engine cannot charge
  // ({X}, Phyrexian, a printed "—Exile a black card from your hand" / "—{B},
  // Pay 2 life" / "—Sacrifice three lands" form) leaves the line reported
  // rather than compiling a cost the cast path would then not collect.
  {
    id: 'channel-ability',
    description:
      '"Channel — {3}{R}, Discard this card: EFFECT" / "Bloodrush — {R}, Discard this card: Target attacking creature gets +3/+3 until end of turn" — the ability-word (CR 207.2c) siblings of cycling: a from-hand discard activation with a spell-shaped body',
    // The body goes through the ordinary effect table, so a channel line can
    // only do what the engine already runs; "activate only as a sorcery" is
    // the one trailing sentence read as timing, exactly as `compileActivatedAbility`
    // reads it. A body opening "It deals …" is the card naming itself.
    pattern: /^(channel|bloodrush) [—-] ((?:\{[^}]+\})+), discard (?:this card|~): (.+?)(\.? ?activate only as a sorcery\.?)?$/,
    build(match, ctx) {
      const kind = match[1] as 'channel' | 'bloodrush';
      const cost = parseManaSymbols(match[2] ?? '');
      if (!cost) return null;
      const body = (match[3] ?? '').replace(/^it /, '~ ');
      const effects = ctx.compileEffectClause(body);
      if (!effects || effects.length === 0) return null;
      const printedKind = kind.charAt(0).toUpperCase() + kind.slice(1);
      return {
        cycling: [
          {
            cost,
            effects,
            label: `${printedKind} — ${formatManaCost(cost)}`,
            kind,
            ...(match[4] !== undefined ? { timing: 'sorcery' as const } : {}),
          },
        ],
      };
    },
  },
  // --- §3.111 the graveyard-casting family --------------------------------------
  // Every rule below compiles a printed keyword LINE into one of the two
  // shapes core's `graveyard-casting.ts` defines: an activated ability of a
  // card in a graveyard (`graveyardAbilities`) or a cast from the graveyard
  // (`graveyardCasts` / `flashbackAdditionalCost`). The reminder text is
  // stripped before the table sees the line, so each pattern is the keyword
  // and its cost and nothing else — and each cost table is CLOSED: a form
  // outside it ("Unearth—Pay eight {E}", "Eternalize—{3}{U}{U}, Discard a
  // card", "Flashback—{R}{R}, Discard X cards") matches nothing and reports.
  {
    id: 'unearth-cost',
    description:
      '"Unearth {2}{W}" (Scrapwork Cohort, Dregscape Zombie, Mishra\'s Research Desk) — CR 702.84a: return it to the battlefield with haste, exile it at the next end step or if it would leave',
    pattern: /^unearth ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        graveyardAbilities: [
          {
            kind: 'unearth',
            cost: { mana: cost },
            effects: [{ primitive: 'unearthReturn' }],
            timing: 'sorcery',
            label: `Unearth ${formatManaCost(cost)}`,
          },
        ],
      };
    },
  },
  {
    id: 'transmute-cost',
    description:
      '"Transmute {1}{U}{U}" (CR 702.53a) — discard this card as a sorcery: search for a card with the same mana value as it',
    pattern: /^transmute ((?:\{[^}]+\})+)$/,
    build(match, ctx) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      // The discarded card's mana value in hand: generic plus one per pip; an
      // {X} counts zero anywhere but the stack (CR 107.3), a hybrid or
      // Phyrexian symbol one. A card with no mana cost (Tolaria West) is 0.
      const printed = ctx.card.manaCost;
      const manaValue =
        printed.generic +
        printed.W +
        printed.U +
        printed.B +
        printed.R +
        printed.G +
        printed.C +
        printed.other.filter((symbol) => symbol.toUpperCase() !== 'X').length;
      return {
        cycling: [
          {
            cost,
            effects: [
              {
                primitive: 'searchLibrary',
                params: {
                  who: 'controller',
                  count: 1,
                  destination: 'hand',
                  filter: { minManaValue: manaValue, maxManaValue: manaValue },
                },
              },
            ],
            label: `Transmute ${formatManaCost(cost)}`,
            kind: 'transmute',
            timing: 'sorcery',
          },
        ],
      };
    },
  },
  {
    id: 'scavenge-cost',
    description:
      '"Scavenge {4}{G}{G}" (Deadbridge Goliath, Slitherhead) — CR 702.96a: exile it from your graveyard, +1/+1 counters equal to its power on target creature',
    pattern: /^scavenge ((?:\{[^}]+\})+)$/,
    build(match, ctx) {
      // "Equal to this card's power" is the PRINTED power; a `*` box (Boneyard
      // Mycodrax) is a number this rule cannot read and stays reported.
      if (typeof ctx.card.power !== 'number' || !Number.isInteger(ctx.card.power)) return null;
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        graveyardAbilities: [
          {
            kind: 'scavenge',
            cost: { mana: cost },
            exileSelf: true,
            effects: [{ primitive: 'scavengeCounters', params: { targets: CREATURE_TARGET } }],
            timing: 'sorcery',
            label: `Scavenge ${formatManaCost(cost)}`,
          },
        ],
      };
    },
  },
  {
    id: 'embalm-cost',
    description:
      '"Embalm {3}{U}" (Tah-Crop Skirmisher, Sacred Cat) — CR 702.128a: exile it from your graveyard, a token copy that is a white Zombie with no mana cost',
    pattern: /^embalm ((?:\{[^}]+\})+)$/,
    build(match, ctx) {
      // Printed only on creatures; the token is "a copy of it" and the
      // exceptions below are the whole of CR 702.128a's "except" tail.
      if (!ctx.card.typeLine.types.map((t) => t.toLowerCase()).includes('creature')) return null;
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        graveyardAbilities: [
          {
            kind: 'embalm',
            cost: { mana: cost },
            exileSelf: true,
            effects: [
              {
                primitive: 'graveyardTokenCopy',
                params: { except: { colors: ['W'], addSubtypes: ['zombie'], noManaCost: true } },
              },
            ],
            timing: 'sorcery',
            label: `Embalm ${formatManaCost(cost)}`,
          },
        ],
      };
    },
  },
  {
    id: 'eternalize-cost',
    description:
      '"Eternalize {4}{U}{U}" (Proven Combatant, Adorned Pouncer) — CR 702.129a: exile it from your graveyard, a token copy that is a 4/4 black Zombie with no mana cost',
    // "Eternalize—{3}{U}{U}, Discard a card." (Sinuous Striker) prints a
    // discard rider the graveyard-ability cost has no field for, and stays
    // reported. Lazotep Archway (a LAND that eternalizes into a creature and
    // "loses all other card types") is a type change this tail cannot say.
    pattern: /^eternalize ((?:\{[^}]+\})+)$/,
    build(match, ctx) {
      if (!ctx.card.typeLine.types.map((t) => t.toLowerCase()).includes('creature')) return null;
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        graveyardAbilities: [
          {
            kind: 'eternalize',
            cost: { mana: cost },
            exileSelf: true,
            effects: [
              {
                primitive: 'graveyardTokenCopy',
                params: {
                  except: {
                    colors: ['B'],
                    addSubtypes: ['zombie'],
                    noManaCost: true,
                    power: ETERNALIZED_POWER,
                    toughness: ETERNALIZED_TOUGHNESS,
                  },
                },
              },
            ],
            timing: 'sorcery',
            label: `Eternalize ${formatManaCost(cost)}`,
          },
        ],
      };
    },
  },
  {
    id: 'evoke-cost',
    description:
      '"Evoke {2}{U}" (CR 702.74a) — cast for this cost and it is sacrificed as it enters; its enters-the-battlefield trigger still fires (Mulldrifter)',
    pattern: /^evoke ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        alternativeCosts: {
          evoke: {
            cost,
            riders: [
              {
                condition: { on: 'etb' },
                effects: [{ primitive: 'sacrificeSelfIfCastWith', params: { castWith: 'evoke' } }],
                label: 'Evoke: sacrifice it when it enters',
                removesFromBattlefield: true,
              },
            ],
          },
        },
      };
    },
  },
  {
    id: 'dash-cost',
    description:
      '"Dash {1}{R}" (CR 702.109a) — cast for this cost: haste, and returned to hand at the beginning of the next end step',
    pattern: /^dash ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        alternativeCosts: {
          dash: {
            cost,
            riders: [
              {
                condition: { on: 'endStep', who: 'any' },
                effects: [{ primitive: 'returnSelfToHand' }],
                label: 'Dash: return it to hand at the beginning of the next end step',
                removesFromBattlefield: true,
              },
            ],
          },
        },
      };
    },
  },
  {
    id: 'blitz-cost',
    description:
      '"Blitz {2}{R}" (CR 702.152a) — cast for this cost: haste, "when it dies, draw a card", sacrificed at the beginning of the next end step',
    pattern: /^blitz ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        alternativeCosts: {
          blitz: {
            cost,
            riders: [
              {
                condition: { on: 'endStep', who: 'any' },
                effects: [{ primitive: 'sacrificeSelfIfCastWith', params: { castWith: 'blitz' } }],
                label: 'Blitz: sacrifice it at the beginning of the next end step',
                removesFromBattlefield: true,
              },
              {
                condition: { on: 'dies' },
                effects: [{ primitive: 'drawCards', params: { count: 1 } }],
                label: 'Blitz: when it dies, draw a card',
              },
            ],
          },
        },
      };
    },
  },
  {
    id: 'surge-cost',
    description: '"Surge {1}{R}" (CR 702.117a) — cast for this cost if you have cast another spell this turn',
    pattern: /^surge ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return { alternativeCosts: { surge: { cost } } };
    },
  },
  {
    id: 'prototype-cost',
    description:
      '"Prototype {1}{B} — 1/1" (CR 702.160a) — cast as a smaller body with a different cost and colour; it keeps its abilities and types',
    pattern: /^prototype ((?:\{[^}]+\})+) [—-] (\d+)\/(\d+)$/,
    build(match, ctx) {
      // Prototype is printed only on creatures; anything else could not be
      // cast "as a 1/1" and stays reported.
      if (!ctx.card.typeLine.types.some((type) => type.toLowerCase() === 'creature')) return null;
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      const power = parseSignedInt(match[2]);
      const toughness = parseSignedInt(match[3]);
      if (!Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      return { alternativeCosts: { prototype: { cost, face: { power, toughness } } } };
    },
  },
  {
    id: 'warp-cost',
    description:
      '"Warp {1}{U}" (CR 702.185a) — cast from hand for this cost; exiled at the beginning of the next end step, then castable from exile on a later turn',
    pattern: /^warp ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        alternativeCosts: {
          warp: {
            cost,
            riders: [
              {
                condition: { on: 'endStep', who: 'any' },
                effects: [{ primitive: 'warpExile' }],
                label: 'Warp: exile it at the beginning of the next end step',
                removesFromBattlefield: true,
              },
            ],
          },
        },
      };
    },
  },
  {
    id: 'encore-cost',
    description:
      '"Encore {4}{B}" (Exquisite Huntmaster, Impulsive Pilferer) — CR 702.141a: exile it from your graveyard; for each opponent a hasty token copy that attacks that opponent, sacrificed at the next end step',
    pattern: /^encore ((?:\{[^}]+\})+)$/,
    build(match, ctx) {
      if (!ctx.card.typeLine.types.map((t) => t.toLowerCase()).includes('creature')) return null;
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        graveyardAbilities: [
          {
            kind: 'encore',
            cost: { mana: cost },
            exileSelf: true,
            effects: [
              {
                primitive: 'graveyardTokenCopy',
                // "Attacks that opponent this turn if able" is `mustAttack`:
                // with one opponent there is nobody else the token could
                // attack, so the printed sentence and the flag are the same
                // rule. "They gain haste" is the Kiki-Jiki grant.
                params: { perOpponent: true, grantKeywords: { haste: true, mustAttack: true }, delayedRemoval: 'sacrifice' },
              },
            ],
            timing: 'sorcery',
            label: `Encore ${formatManaCost(cost)}`,
          },
        ],
      };
    },
  },
  {
    id: 'foretell-cost',
    description:
      '"Foretell {1}{W}" (CR 702.143a) — pay {2} on your turn to exile it face down; cast it on a later turn for this cost',
    pattern: /^foretell ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return { foretell: cost };
    },
  },
  {
    id: 'plot-cost',
    description:
      '"Plot {1}{G}" (CR 702.170a) — pay this cost as a sorcery to exile it; cast it free, as a sorcery, on a later turn',
    pattern: /^plot ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return { plot: cost };
    },
  },
  {
    id: 'entwine-cost',
    description: '"Entwine {3}{R}" (CR 702.42a) — pay the additional cost to choose ALL of a modal spell\'s modes',
    pattern: /^entwine ((?:\{[^}]+\})+)$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return { entwine: cost };
    },
  },
  {
    id: 'return-self-from-graveyard-to-hand',
    description:
      '"{2}{B}: Return ~ from your graveyard to your hand." (Reassembling Skeleton\'s hand-bound cousins) — an activated ability that functions in the graveyard, CR 602.2',
    // Matched here, ahead of the generic activated-ability parser, because that
    // parser builds a BATTLEFIELD activation and this line's source is never on
    // the battlefield when it can be activated.
    pattern: /^((?:\{[^}]+\})+): return ~ from your graveyard to your hand$/,
    build(match) {
      const cost = parseManaSymbols(match[1] ?? '');
      if (!cost) return null;
      return {
        graveyardAbilities: [
          {
            kind: 'returnToHand',
            cost: { mana: cost },
            effects: [{ primitive: 'returnSourceFromGraveyard', params: { to: 'hand' } }],
            label: `${formatManaCost(cost)}: Return this card from your graveyard to your hand`,
          },
        ],
      };
    },
  },
  {
    id: 'escape-cost',
    description:
      '"Escape—{2}{U}, Exile five other cards from your graveyard." (Glimpse of Freedom, Fruit of Tizerus) — CR 702.138a: cast from the graveyard for the escape cost, and NOT exiled afterwards',
    // "Exile any number of other cards … with four or more card types among
    // them" (Nethergoyf) and "Exile a land you control, Exile five other cards"
    // (Lunar Hatchling) are cost shapes outside the table and stay reported.
    // "~ escapes with a +1/+1 counter" is its own printed line and reports on
    // its own; the cast itself compiles.
    pattern: new RegExp(`^escape[—-] ?((?:\\{[^}]+\\})+), exile ${COUNT_TOKEN} other cards? from your graveyard$`),
    build(match, ctx) {
      if (ctx.card.typeLine.types.map((t) => t.toLowerCase()).includes('land')) return null;
      const cost = parseManaSymbols(match[1] ?? '');
      const count = parseCount(match[2]);
      if (!cost || count === null || count <= 0) return null;
      return {
        graveyardCasts: [
          {
            kind: 'escape',
            cost,
            additional: {
              kind: 'exileFromGraveyard',
              count,
              label: `Exile ${count} other card${count === 1 ? '' : 's'} from your graveyard`,
            },
          },
        ],
      };
    },
  },
  {
    id: 'flashback-nonmana-cost',
    description:
      '"Flashback—Sacrifice three creatures." (Dread Return) / "Flashback—Sacrifice a Mountain." (Lava Dart) / "Flashback—Tap three untapped white creatures you control." (Battle Screech) — a flashback whose whole cost is a sacrifice or a tap',
    // The mana half is EMPTY and the rider is the same closed `AdditionalCastCost`
    // shape "as an additional cost" prints, paid by the same cast-time question.
    // The noun goes through `COST_NOUNS` (singular) via the plural table below;
    // a noun outside it reports rather than widening to "any permanent".
    pattern: new RegExp(
      `^flashback[—-] ?(sacrifice|tap) (an?|${COUNT_TOKEN}) (untapped )?(white |blue |black |red |green )?([a-z ]+?)( you control)?$`,
    ),
    build(match, ctx) {
      const types = ctx.card.typeLine.types.map((t) => t.toLowerCase());
      if (!types.includes('instant') && !types.includes('sorcery')) return null;
      // `COUNT_TOKEN` is itself a capture group, so the groups after it sit one
      // index further along than the pattern reads: 2 = the whole count word,
      // 3 = its inner capture, 4 = "untapped ", 5 = the colour, 6 = the noun,
      // 7 = " you control".
      const verb = match[1] as 'sacrifice' | 'tap';
      const count = match[2] === 'a' || match[2] === 'an' ? 1 : parseCount(match[2]);
      if (count === null || count <= 0) return null;
      // A tap cost names UNTAPPED permanents by definition; the printed word is
      // required so a wording this rule has not seen ("tap three creatures")
      // does not silently pass.
      if (verb === 'tap' && match[4] === undefined) return null;
      const nounWord = (match[6] ?? '').trim();
      const noun = count === 1 ? nounWord : (COST_NOUN_PLURALS[nounWord] ?? nounWord);
      const base = COST_NOUNS[noun];
      if (base === undefined) return null;
      const colorWord = (match[5] ?? '').trim();
      const color = colorWord.length > 0 ? COLOR_WORDS[colorWord] : undefined;
      if (colorWord.length > 0 && color === undefined) return null;
      const filter: CardFilter = color === undefined ? base : { ...base, anyOfColors: [color] };
      const printed = `${verb === 'tap' ? 'Tap' : 'Sacrifice'} ${match[2]} ${match[4] ?? ''}${match[5] ?? ''}${nounWord}${match[7] ?? ''}`;
      return {
        flashback: {},
        flashbackAdditionalCost: { kind: verb, count, filter, label: printed },
      };
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
      const life = parseSignedInt(match[1] ?? '');
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
      // A NAMED row only — see `namedDerivedValue`: core's CDA path has no
      // filter arm, so a filtered count here would read 0/0 forever.
      const count = namedDerivedValue(match[1]!);
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
      const count = namedDerivedValue(match[1]!); // named rows only — see the sibling rule
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
      const power = match[8] === undefined ? 0 : parseSignedInt(match[8]);
      const toughness = match[9] === undefined ? 0 : parseSignedInt(match[9]);
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
     * A GRANTED ACTIVATED ABILITY on a GROUP — "Creatures you control **have**
     * "{T}: Add one mana of any color."" (Cryptolith Rite), "Lands you control
     * have "…"" (Chromatic Lantern), "All Slivers have "…"".
     *
     * The quoted ability is compiled by the compiler's OWN activated-ability
     * parser (`compileQuotedAbility`), so a granted ability can only ever do
     * what a printed one could and the two share one grammar. Core folds it
     * through the same continuous layer an anthem uses and `effectiveActivated`
     * reads it — activated by the ordinary path, with no second mechanism.
     */
    id: 'static-grant-activated-ability',
    description:
      `"Creatures/Lands you control have <ABILITY>" / "All SUBTYPEs have <ABILITY>" (Cryptolith Rite, Chromatic Lantern)`,
    pattern: /^(?:all |each )?([a-z]+) ?(you control|your opponents control)? ?have "(.+)"$/,
    build(match, ctx) {
      const isPermanent = ctx.card.typeLine.types.every((type) => !/^(instant|sorcery)$/i.test(type));
      if (!isPermanent) return null;
      const ability = ctx.compileQuotedAbility(match[3] ?? '');
      if (!ability) return null;
      const affects = groupStaticAffects(match[1] ?? '', match[2], ctx);
      if (affects === null) return null;
      return { statics: [{ affects, activated: [ability], label: match[0] }] };
    },
  },
  {
    /**
     * The ATTACHMENT form of the same grant — "Enchanted creature has "{T}: Add
     * one mana of any color."" (Paradise Mantle), "Equipped creature has "…"".
     *
     * Same parser, same core field: an attachment's modification is the very
     * shape a static's is, so the grant needs no second implementation.
     */
    id: 'attachment-grant-activated-ability',
    description: `"Enchanted/Equipped creature has <ABILITY>" (Paradise Mantle)`,
    pattern: /^(?:enchanted|equipped) creature has "(.+)"$/,
    build(match, ctx) {
      const ability = ctx.compileQuotedAbility(match[1] ?? '');
      return ability === null ? null : { attachmentModifies: { activated: [ability] } };
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
    /**
     * A static whose reach depends on EFFECTIVE P/T — "Creatures you control
     * with power or toughness 1 or less can't be blocked" (Tetsuko Umezawa),
     * "Creatures you control with power 2 or less can't be blocked by
     * creatures with power 3 or greater" (Delney, Streetwise Lookout).
     *
     * KEYWORD-GRANTING ONLY, and the restriction is load-bearing: core folds
     * these against SETTLED P/T after every P/T layer (see
     * `StaticAffects.maxEffectivePower`), so an anthem correctly lifts a
     * creature out of the selector — and a P/T delta here would need its own
     * output as input.
     */
    id: 'static-effective-pt-evasion',
    description:
      `"Creatures you control with power[ or toughness] N or less can't be blocked[ by creatures with power M or greater]"`,
    pattern: new RegExp(
      `^creatures you control with power( or toughness)? ${COUNT_TOKEN} or less can'?t be blocked` +
        `(?: by creatures with power ${COUNT_TOKEN} or (?:greater|more))?$`,
    ),
    build(match, ctx) {
      const isPermanent = ctx.card.typeLine.types.every((type) => !/^(instant|sorcery)$/i.test(type));
      if (!isPermanent) return null;
      const bound = parseCount(match[2]);
      if (bound === null) return null;
      const blockerBound = match[3] === undefined ? null : parseCount(match[3]);
      if (match[3] !== undefined && blockerBound === null) return null;
      // No blocker clause ⇒ plain unblockable. With one, the printed exclusion
      // inverts exactly as `cant-be-blocked-by-power-or-toughness` inverts it:
      // "by power M or greater" excluded ⇒ a legal blocker has at most M - 1.
      const keywords =
        blockerBound === null
          ? { unblockable: true }
          : { blockRestriction: { maxBlockerPower: blockerBound - 1 } };
      return {
        statics: [
          {
            affects: {
              anyOfTypes: ['creature'],
              controller: 'you',
              ...(match[1] === undefined
                ? { maxEffectivePower: bound }
                : { maxEffectivePowerOrToughness: bound }),
            },
            keywords,
            label: match[0],
          },
        ],
      };
    },
  },
  {
    /**
     * A block restriction whose BOUND is the source's OWN power — "Creatures
     * with power less than this creature's power can't block creatures you
     * control" (Champion of Lambholt, whose power climbs by a +1/+1 counter
     * every time another creature enters).
     *
     * This is the shape §3.17 and §3.25 both deferred as "a restriction whose
     * threshold is ANOTHER permanent's power". It is expressible now because
     * core resolves such a static in its SETTLED-P/T pass, after every P/T
     * layer has folded — so the bound is the Champion's real power at
     * declare-blockers time, and the keyword-only rule on that pass is what
     * keeps the continuous layer a single exact pass (see
     * `StaticAbility.blockBoundFromSourcePower`).
     *
     * The printed COMPARISON is read, never inferred: "less than" means a legal
     * blocker needs AT LEAST the source's power, "greater than" means at most
     * it, and the two map through a closed table so the next printing is a row.
     */
    id: 'static-block-bound-from-source-power',
    description:
      `"Creatures with power less/greater than ~'s power can't block creatures you control" (Champion of Lambholt)`,
    pattern: new RegExp(
      `^creatures with power (${Object.keys(SOURCE_POWER_BLOCK_BOUNDS).join('|')}) than ~'?s power` +
        ` can'?t block creatures you control$`,
    ),
    build(match, ctx) {
      // Only a permanent radiates a static; an instant printing this shape would
      // be a one-shot effect this rule does not implement.
      const isPermanent = ctx.card.typeLine.types.every((type) => !/^(instant|sorcery)$/i.test(type));
      if (!isPermanent) return null;
      const bound = SOURCE_POWER_BLOCK_BOUNDS[match[1] ?? ''];
      if (bound === undefined) return null;
      return {
        statics: [
          {
            // The restriction rides on the ATTACKERS — "can't block creatures
            // you control" is a property of what they may be blocked BY, which
            // is exactly what `KeywordFlags.blockRestriction` says. Champion
            // itself is one of them: the printed line has no "other".
            affects: { anyOfTypes: ['creature'], controller: 'you' },
            blockBoundFromSourcePower: bound,
            label: match[0],
          },
        ],
      };
    },
  },
  {
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
    // §3.150 — the grant verb after "and" is OPTIONAL for the same reason the
    // third alternative exists at all: "gets +4/+2 AND DOESN'T UNTAP during its
    // controller's untap step" (Vulshok Gauntlets, Dance of the Dead, Leaden
    // Fists) prints a sentence where a keyword word would carry "has". Without
    // this the whole line fell to the verbless catch-all, which then handed
    // `parseKeywordList` the conjunct "gets +4/+2" and was refused. Nothing is
    // widened: every conjunct still has to be a phrase the closed tables name.
    pattern:
      /^(?:enchanted|equipped) creature (?:gets ([+-]\d+)\/([+-]\d+)(?: and (?:(?:has|gains) )?(.+))?|(?:has|gains) (.+)|(.+))$/,
    build(match) {
      const power = match[1] === undefined ? 0 : parseSignedInt(match[1]);
      const toughness = match[2] === undefined ? 0 : parseSignedInt(match[2]);
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
  // --- the spell-count family (DESIGN §3.113): "Double all damage …" ------------
  {
    /**
     * The whole-sentence form of `replacement-damage-scaled`: "Double all
     * damage that creature sources you control would deal" (Absorbing Man and
     * Titania) is the same CR 614 replacement as "If a creature you control
     * would deal damage …, it deals double that damage instead" — one outcome
     * (`times: 2`), one `applies`, printed without a recipient. Same shape of
     * data, so the layer that scales Torbran's damage scales this.
     */
    id: 'replacement-double-all-damage',
    description: '"Double all damage that [creature] sources you control would deal" (Absorbing Man and Titania)',
    pattern: new RegExp(`^double all damage that (${Object.keys(DOUBLE_ALL_DAMAGE_SOURCES).join('|')}) would deal$`),
    build(match, ctx) {
      if (!cardIsPermanent(ctx)) return null;
      const source = DOUBLE_ALL_DAMAGE_SOURCES[match[1] ?? ''];
      if (source === undefined) return null;
      return {
        replacements: [
          {
            event: 'damage',
            applies: {
              sourceController: source.sourceController,
              ...(source.sourceFilter !== undefined ? { sourceFilter: source.sourceFilter } : {}),
            },
            outcome: { times: REPLACEMENT_MULTIPLIERS.double! },
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
    // The PAYLOAD keywords — "ward {1}", "protection from black and from
    // green", "toxic 1" (§3.105) — carry a value rather than a boolean, and
    // core models all three. They go through the same parser the printed
    // keyword LINE uses (`parsePayloadKeyword`) so an Equipment and a creature
    // cannot end up disagreeing about which forms are real: a quality outside
    // the closed table ("protection from instants") still returns null and the
    // whole line keeps reporting.
    const payload = parsePayloadKeyword(word);
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
export function joinPayloadKeywords(words: readonly string[]): string[] {
  const joined: string[] = [];
  for (const word of words) {
    const previous = joined[joined.length - 1];
    if (previous !== undefined && QUALITY_PHRASE_PREFIX.test(previous) && isQualityContinuation(word)) {
      joined[joined.length - 1] = `${previous} and ${word.replace(/^and /, '')}`;
      continue;
    }
    joined.push(word);
  }
  return joined;
}

/** A trailing "from …" fragment of a multi-quality protection line. */
const PROTECTION_CONTINUATION = /^(?:and )?from /;

/**
 * §3.152 — the two printed phrases whose tail is a QUALITY LIST. Both spell the
 * list the same way, so both need the same re-join.
 */
const QUALITY_PHRASE_PREFIX = /^(?:protection|hexproof) from /;

/**
 * Whether a split fragment continues the quality list before it.
 *
 * Two shapes, because Oracle prints two. The protection line repeats the
 * preposition ("black and FROM green"), which is unambiguous. The hexproof-from
 * line does NOT — Nevinyrral prints "Hexproof from artifacts, creatures, and
 * enchantments", so the fragments arrive as bare words and there is nothing
 * grammatical to recognise them by.
 *
 * ⚠️ So a bare fragment is admitted ONLY when the CLOSED quality tables already
 * name it. That is what keeps this from swallowing a real second keyword: "and
 * lifelink" is not a quality word, so it stays its own conjunct and the line
 * compiles as two abilities, which is what it is. Widening this to "any bare
 * word after a protection phrase" is the silent-approximation failure rule 2
 * names — it would read "protection from black and vigilance" as protection
 * from a quality called vigilance and quietly drop the keyword.
 */
function isQualityContinuation(word: string): boolean {
  if (PROTECTION_CONTINUATION.test(word)) return true;
  const bare = word.replace(/^and /, '').trim();
  if (bare.length === 0) return false;
  return (
    bare === PROTECTION_EACH_COLOR ||
    PROTECTION_QUALITY_WORDS[bare] !== undefined ||
    PROTECTION_SUBTYPE_WORDS[bare] !== undefined
  );
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
  // §3.150 — the CONTINUOUS half of the does-not-untap family, as ONE ROW.
  // This single entry is what makes every Aura and Equipment printing work:
  // `attachment-modification` already routes "Enchanted creature <anything>"
  // and "Equipped creature gets +2/+0 and <anything>" through this parser, so
  // Waterknot, Cement Shoes, Dance of the Dead and Vulshok Gauntlets are all
  // served by the row rather than by a rule each. The printed subject varies
  // ("its controller's" on a granted line) and is not part of the key: the
  // grant lands on the host, whose own untap step is the only one it could
  // mean.
  "doesn't untap during its controller's untap step": 'doesNotUntap',
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
  // "it isn't legendary" (Spark Double) / "THE TOKEN isn't legendary" (Helm of
  // the Host). The two nouns name the same object in these clauses — a token
  // copy's "except" tail is about the token it is making — so they are one rule
  // rather than two entries that could drift apart.
  if (/^(?:it|the token) isn'?t legendary$/.test(clause)) return { legendary: false };
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
 * the printed one cannot.
 *
 * ⚠️ "ANOTHER target creature you control" (Orthion, Jaxis, The Jolly Balloon
 * Man) is still deliberately absent, and the blocker is specific: the printed
 * word "another" excludes the ASKING INSTANCE, while core's target vocabulary is
 * checked against a source DEFINITION (`isLegalTarget(state, restriction, ref,
 * controller, sourceDef)`) and never learns which object is asking. Compiling it
 * as plain "target creature you control" would let Orthion copy itself, which is
 * a card playing wider than printed.
 */
const TOKEN_COPY_SELECTORS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  'target creature': { targets: CREATURE_TARGET },
  // "a copy of ANOTHER target nonland permanent you control" (Extravagant
  // Replication). "Another" rides as `excludeSelf`, which the trigger-body
  // compiler lifts onto the ability so the aiming pass never offers the source.
  'another target nonland permanent you control': {
    targets: NONLAND_PERMANENT_YOU_CONTROL_TARGET,
    excludeSelf: true,
  },
  'target creature you control': { targets: CREATURE_YOU_CONTROL_TARGET },
  // "target NONLEGENDARY creature you control" (Kiki-Jiki, Fable of the
  // Mirror-Breaker). Its own restriction rather than an approximation: the
  // printed word is the entire reason Kiki-Jiki cannot copy itself.
  'target nonlegendary creature you control': { targets: NONLEGENDARY_CREATURE_YOU_CONTROL_TARGET },
  'target artifact': { targets: ARTIFACT_TARGET },
  // "a copy of target TOKEN you control" (Caretaker's Talent). Its own
  // restriction, reading the CR 111.1 token-ness stamp — "token" is a property
  // of how the object was made, which no type-line filter can express.
  'target token you control': { targets: TOKEN_YOU_CONTROL_TARGET },
  'target artifact or creature you control': { targets: ARTIFACT_OR_CREATURE_YOU_CONTROL_TARGET },
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
function buildTokenCopy(
  countWord: string,
  rest: string,
  ctx: RuleContext,
  tapped = false,
): ClauseContribution | null {
  const count = TOKEN_COPY_COUNTS[countWord];
  if (count === undefined) return null;
  let body = rest.trim();

  // "… **Sacrifice it at the beginning of the next end step**" (Kiki-Jiki, The
  // Fire Crystal, Orthion, Molten Duplication) / "**Exile those tokens** at the
  // beginning of the next end step" (Twinflame, Mimic Vat) — CR 603.7, a DELAYED
  // triggered ability. Parsed FIRST because it is the last printed sentence.
  //
  // It is a param on the SAME ref rather than a second effect, and that is not a
  // shortcut: the delayed ability has to name the tokens this ref creates, and
  // nothing but this ref will ever know their ids.
  let delayedRemoval: 'sacrifice' | 'exile' | undefined;
  const delayed = body.match(TOKEN_COPY_DELAYED_REMOVAL);
  if (delayed) {
    delayedRemoval = delayed[1] === 'exile' ? 'exile' : 'sacrifice';
    body = body.slice(0, body.length - (delayed[0] ?? '').length).trim();
  }

  // "… **It gains haste.**" (Orthion, Mimic Vat) / "**It gains haste until end
  // of turn.**" (Molten Duplication) / "**That token gains haste.**" (Helm of
  // the Host) — a FOLLOW-UP SENTENCE about the object the first one created.
  //
  // Carried as its own param and NOT merged into the "except" tail, because a
  // grant is layer 6 on that object and is therefore not among the copiable
  // values a second copy would take, while "except it has haste" is. They look
  // identical on the board and differ exactly one copy later.
  let grantKeywords: KeywordFlags | undefined;
  let grantUntilEndOfTurn = false;
  const grant = body.match(TOKEN_COPY_GRANT_SENTENCE);
  if (grant) {
    const flag = KEYWORD_FLAGS[(grant[1] ?? '').trim()];
    if (flag === undefined) return null;
    grantKeywords = { [flag]: true } as KeywordFlags;
    grantUntilEndOfTurn = grant[2] !== undefined;
    body = body.slice(0, body.length - (grant[0] ?? '').length).trim();
  }

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

  // The printed word "tapped" is an exception in core's own vocabulary, exactly
  // as it is for Vesuva's as-enters copy.
  let except: CopyExceptions = tapped ? { entersTapped: true } : {};
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
      ...(grantKeywords !== undefined ? { grantKeywords } : {}),
      ...(grantUntilEndOfTurn ? { grantUntilEndOfTurn: true } : {}),
      ...(delayedRemoval !== undefined ? { delayedRemoval } : {}),
    },
  });
}

/**
 * "Sacrifice it / them at the beginning of the next end step" · "Exile it /
 * them / those tokens at the beginning of the next end step" — the printed
 * delayed triggered ability (CR 603.7), anchored to the END of the clause.
 *
 * Both verbs are captured because they are two outcomes, not two spellings: a
 * sacrifice is a DEATH that a dies-trigger sees and that lands in a graveyard,
 * an exile is neither.
 */
const TOKEN_COPY_DELAYED_REMOVAL =
  /\. (sacrifice|exile) (?:it|them|that token|those tokens|this token) at the beginning of the next end step$/;

/**
 * "It gains haste." / "They gain haste." / "That token gains haste." /
 * "It gains haste until end of turn." — the follow-up sentence about the object
 * the previous one created, anchored to the END of what remains.
 */
const TOKEN_COPY_GRANT_SENTENCE =
  /\. (?:it|they|that token|those tokens|the token created this way|the tokens created this way) gains? ([a-z' ]+?)( until end of turn)?$/;

/**
 * "**The token enters tapped and attacking.**" (Ghired, Conclave Exile) — the
 * entry words printed as a trailing SENTENCE about the token that was just made,
 * rather than as adjectives in front of the noun ("create a **tapped** token").
 *
 * The captured phrase goes through {@link tokenEntryWords}, the very function
 * the in-front-of-the-noun form uses, so "tapped and attacking" means one thing
 * in this codebase and a phrase outside that closed set is REPORTED from both
 * spellings alike — never quietly turned into an ordinary untapped token, which
 * would be a card playing better than printed.
 */
const TOKEN_COPY_ENTRY_SENTENCE = /\. (?:the|that) tokens? enters? ([a-z ]+?)$/;

/** The printed words a "create … token" clause may put in front of "token". */
interface TokenEntryWords {
  readonly tapped: boolean;
  readonly attacking: boolean;
}

/**
 * Read the "tapped" / "tapped and attacking" words a create-token clause prints
 * before the noun (Skyclave Relic, Kambal, Delina, Mobilize).
 *
 * `null` for a phrase outside the closed set, so a wording nobody has read is
 * REPORTED rather than silently creating an untapped token — which would be a
 * card playing better than printed.
 */
function tokenEntryWords(phrase: string | undefined): TokenEntryWords | null {
  const words = (phrase ?? '').trim();
  if (words.length === 0) return NO_TOKEN_ENTRY_WORDS;
  if (words === 'tapped') return { tapped: true, attacking: false };
  if (words === 'tapped and attacking') return { tapped: true, attacking: true };
  return null;
}

/** Shared "the clause printed no extra entry words" answer. */
const NO_TOKEN_ENTRY_WORDS: TokenEntryWords = Object.freeze({ tapped: false, attacking: false });

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
 * An optional printed ability-word label, for a pattern that must see past one.
 *
 * `splitAbilities` already folds the label away before the rule table ever sees
 * a card's own line, so on that path this prefix never fires. It stays because
 * the rule table is also handed text that never went through that funnel — a
 * quoted ability granted by another card — and a pattern that silently stops
 * matching in one of its two callers is the kind of quiet gap this compiler is
 * built to refuse.
 */
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
      cost.generic = ((cost.generic as number | undefined) ?? 0) + parseSignedInt(symbol);
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
    /**
     * An ADDITIONAL COST that names ANOTHER permanent — "{T}, **Tap an
     * untapped creature you control**: Add one mana of any color" (Springleaf
     * Drum, Scene of the Crime, Survivors' Encampment, Relic of Legends) and
     * "{T}, **Sacrifice a Food**: Add one mana of any color" (Gilded Goose,
     * Phyrexian Tower, Skirk Prospector).
     *
     * The payer is named by the ACTION rather than chosen mid-resolution,
     * because a mana ability resolves immediately and may not park a question
     * (CR 605.3a) — see `ManaAbilityCost.tapAnother`.
     *
     * The NOUN comes from the shared cost-noun table below, so the next
     * printed filter is a row rather than another rule.
     */
    id: 'mana-ability-cost-another-permanent',
    description:
      '"{T}, Tap an untapped creature you control: Add …" (Springleaf Drum) / "{T}, Sacrifice a Food: Add …" (Gilded Goose)',
    pattern: new RegExp(
      `^(?:([{]t[}]), )?(tap an untapped|sacrifice a) (${COST_NOUN_PHRASE})(?: you control)?: add (.+)$`,
    ),
    build(match) {
      const filter = COST_NOUNS[match[3] ?? ''];
      const produces = parseManaPayload(match[4] ?? '');
      if (filter === undefined || !produces) return null;
      const taps = match[1] !== undefined;
      // The printed {T} is optional in this family, and its ABSENCE is the whole
      // difference between a once-a-turn source and Skirk Prospector. Tapping is
      // the DEFAULT, so only the absence is recorded — `ManaAbilityCost` has a
      // `noTap` and no `tap`, and the `tap: true` this once emitted was a key
      // nothing read. It survived because the generated pool's array literal had
      // no contextual type, so TypeScript never excess-property-checked the data
      // it was inferring from; giving that array a type (§3.71) is what found it.
      const tapWords = taps ? {} : { noTap: true };
      const cost =
        match[2] === 'tap an untapped'
          ? { ...tapWords, tapAnother: filter }
          : { ...tapWords, sacrificeAnother: filter };
      return { manaAbilities: [{ produces, cost }] };
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
 * Why myriad compiles to nothing here — worded for the result's `vacuous`
 * list, where a future multiplayer engine will read it (DESIGN §3.107).
 */
export const MYRIAD_VACUOUS_REASON =
  'myriad (CR 702.116a) creates token copies attacking each opponent OTHER THAN the defending player; ' +
  'this engine is strictly two-player, so that set is empty and the ability does nothing — ' +
  'the printed rule, not an approximation. Re-examine the moment a third seat exists.';

/** A landwalk contribution for one row of the closed `LandCondition` table. */
function landwalkOf(condition: LandCondition): ClauseContribution {
  return { keywords: { landwalk: [condition] } };
}

/**
 * The printed land phrases a "can't attack unless defending player controls …"
 * line may name, mapped to the closed `LandCondition` table — the SAME table
 * landwalk compiles to, so "an Island" cannot mean two things (DESIGN §3.107).
 * A phrase outside it ("a Desert", "two Islands") keeps reporting.
 */
const LAND_CONDITION_PHRASES: Readonly<Record<string, LandCondition>> = Object.freeze({
  'a plains': { kind: 'subtype', subtype: 'plains' },
  'an island': { kind: 'subtype', subtype: 'island' },
  'a swamp': { kind: 'subtype', subtype: 'swamp' },
  'a mountain': { kind: 'subtype', subtype: 'mountain' },
  'a forest': { kind: 'subtype', subtype: 'forest' },
  'a legendary land': { kind: 'legendary' },
  'a nonbasic land': { kind: 'nonbasic' },
});

/**
 * Rewrite the pronoun a SELF-REFERENTIAL trigger's body opens with — "whenever
 * ~ attacks, IT gets +0/+2" — to the compiler's `~`, so the body compiles
 * through the same self-pump rule "~ gets +0/+2" does (DESIGN §3.107).
 *
 * Only the self-watching trigger rules call this (attacks / blocks / becomes
 * blocked), where "it" can mean nothing but the source. It is deliberately NOT
 * a general normalisation: a spell's second sentence "It gets +1/+1" refers to
 * the spell's target, and rewriting that would pump the caster's own card.
 */
function selfBody(body: string): string {
  return body.replace(/^it (gets|gains|deals)\b/, '~ $1');
}

/**
 * §3.110 — the abilities a BACKUP line grants (CR 702.165b): every printed
 * line BELOW it, each read as a keyword grant, or `null` when any of them is
 * something the continuous layer cannot hand to another creature.
 *
 * Read off the raw Oracle text (the assembly does not know line order), with
 * reminder text stripped by the same normaliser every line goes through. Two
 * shapes are grants: a keyword list ("Flying, first strike, lifelink" —
 * `parseKeywordList`) and a printed line a STATIC rule compiles to NOTHING BUT
 * `keywords` ("~ can't be blocked by creatures with power 2 or less" → a
 * `blockRestriction`). Anything else — an activated ability, a trigger, a
 * static with a filter — refuses the whole backup line.
 */
function backupGrantedKeywords(ctx: RuleContext): KeywordFlags | null {
  const lines = stripReminderText(selfReference(ctx.card.oracleText, ctx.card.name))
    .split('\n')
    .map((line) => normalizeClause(line));
  const at = lines.findIndex((line) => /^backup [0-9]+/.test(line));
  if (at < 0) return null;
  const following = lines.slice(at + 1).filter((line) => line.length > 0);
  if (following.length === 0) return null;
  const granted: Record<string, unknown> = {};
  for (const line of following) {
    const list = parseKeywordList(line);
    if (list !== null) {
      Object.assign(granted, list);
      continue;
    }
    let asStatic: ClauseContribution | null = null;
    for (const rule of STATIC_RULES) {
      const found = rule.pattern.exec(line);
      if (!found) continue;
      asStatic = rule.build(found, ctx);
      if (asStatic) break;
    }
    if (asStatic === null || asStatic.keywords === undefined || Object.keys(asStatic).length !== 1) return null;
    Object.assign(granted, asStatic.keywords);
  }
  return granted as KeywordFlags;
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
    // LIVING WEAPON (CR 702.92a) — "When this Equipment enters, create a 0/0
    // black Phyrexian Germ creature token, then attach this to it."
    //
    // A builder rather than a rule-table row because the printed line is the
    // bare keyword: the whole rule lives in reminder text, which is stripped
    // before the rule table sees the clause (the same reason affinity, convoke
    // and devoid are builders). Being a builder also settles the Scryfall
    // keyword sweep for free.
    //
    // The token's NAME is its subtype line, per CR 111.3 — "Phyrexian Germ",
    // not "Germ" — so it reads correctly in a log line and is selected by a
    // "sacrifice a Germ" cost. `colors: ['B']` is stated rather than derived:
    // a token has no mana cost, so an absent colour list would read colourless
    // and a black Germ would stop being a legal target for half the cards that
    // care (see `tokenDefFromParams`).
    'living weapon': () => ({
      triggers: [
        {
          condition: { on: 'etb' as const },
          effects: [
            {
              primitive: 'livingWeaponGerm',
              params: {
                name: 'Phyrexian Germ',
                power: 0,
                toughness: 0,
                colors: ['B'],
                types: ['creature'],
                subtypes: ['Phyrexian', 'Germ'],
              },
            },
          ],
          label: 'Living weapon: create a 0/0 black Phyrexian Germ and attach this to it',
        },
      ],
    }),
    // DEVOID (CR 702.114a) — "this card has no color". A builder and not a
    // `KeywordFlags` boolean for the same reason changeling is one: it is a
    // characteristic-defining ability that changes what the object IS, not a
    // combat or timing permission. Its whole payload is the empty colour
    // list, which `CardDefinition.colors` already defines as "printed
    // colourless" — so devoid needs no new concept, only the words for it.
    devoid: () => ({ colorless: true }),
    // SKULK (CR 702.118a) — "can't be blocked by creatures with greater power".
    // A payload restriction rather than a `KeywordFlags` boolean, because the
    // bound is the ATTACKER'S OWN effective power and is read at declare-blockers
    // time: a skulking creature pumped this turn really is harder to block.
    skulk: () => ({ keywords: { blockRestriction: { blockerPowerAtMostMine: true } } }),
    // THE EVASION KEYWORDS WHOSE EXCEPTION NAMES A QUALITY, not a keyword. All
    // three are `blockRestriction` payloads for the same reason skulk is: the
    // rule is a per-pair legality test, which is exactly what that structure is.
    //
    // FEAR (CR 702.36a) — "can't be blocked except by artifact creatures and/or
    // black creatures". The printed "and/or" is a disjunction, so a blocker
    // qualifies by matching EITHER entry.
    fear: () => ({
      keywords: {
        blockRestriction: {
          blockerMustMatchAnyOf: [{ kind: 'artifact' as const }, { kind: 'color' as const, color: 'B' as const }],
        },
      },
    }),
    // INTIMIDATE (CR 702.13a) — the same shape with "shares a color with it" in
    // place of a named colour. A COLOURLESS intimidator shares a colour with
    // nothing, so the line correctly degrades to "except by artifact creatures".
    intimidate: () => ({
      keywords: {
        blockRestriction: {
          blockerMustMatchAnyOf: [{ kind: 'artifact' as const }, { kind: 'sharesColorWithAttacker' as const }],
        },
      },
    }),
    // HORSEMANSHIP (CR 702.31a) — flying's Portal Three Kingdoms cousin, and
    // modelled the same way: the FLAG is what a blocker is checked for, and the
    // restriction is what names it. Carrying both is why a horseman blocks a
    // horseman.
    horsemanship: () => ({
      keywords: { horsemanship: true, blockRestriction: { blockerMustHaveAnyOf: ['horsemanship' as const] } },
    }),
    // --- the combat keyword family (DESIGN §3.107) ------------------------------
    // EXALTED (CR 702.83a) — "Whenever a creature you control attacks alone,
    // that creature gets +1/+1 until end of turn." The trigger is NOT
    // self-referential (the source may be a land — Cathedral of War), and the
    // pumped creature is the ATTACKER: `subject: 'triggering'` reads the lone
    // attacker the runtime carried to the body. One instance of exalted is one
    // trigger, so a board of three exalted permanents pumps +3/+3 by firing
    // three separate abilities — exactly CR 702.90b.
    exalted: () => ({
      triggers: [
        {
          condition: { on: 'creatureAttacksAlone' as const },
          effects: [
            { primitive: 'pumpUntilEndOfTurn', params: { power: 1, toughness: 1, subject: 'triggering' } },
          ],
          label: 'Exalted',
        },
      ],
    }),
    // FLANKING (CR 702.25a) — "Whenever a creature without flanking blocks this
    // creature, the blocking creature gets -1/-1 until end of turn." The FLAG is
    // what the counterpart filter reads (a flanking blocker is exempt), and the
    // trigger fires once PER qualifying blocker (CR 702.25b) with that blocker
    // as its subject.
    flanking: () => ({
      keywords: { flanking: true },
      triggers: [
        {
          condition: { on: 'becomesBlockedByCreature' as const, counterpartLacksKeyword: 'flanking' as const },
          effects: [
            { primitive: 'pumpUntilEndOfTurn', params: { power: -1, toughness: -1, subject: 'triggering' } },
          ],
          label: 'Flanking',
        },
      ],
    }),
    // MYRIAD (CR 702.116a) — "for each opponent OTHER THAN defending player,
    // create a token copy attacking that player". This engine is strictly
    // two-player, so that set is EMPTY and the ability does nothing: the exact
    // rule, not an approximation. The flag is still recorded on the definition
    // and the vacuity on the result, so a third seat cannot forget these cards.
    myriad: () => ({
      keywords: { myriad: true },
      vacuous: { text: 'Myriad', reason: MYRIAD_VACUOUS_REASON },
    }),
    // LANDWALK (CR 702.14b) — one builder per printed walk, all rows of the
    // closed `LandCondition` table core's `canBlock` reads. "Legendary
    // landwalk" and "nonbasic landwalk" are real printed lines and so real
    // rows; a walk outside the table has no builder and keeps reporting.
    plainswalk: () => landwalkOf({ kind: 'subtype', subtype: 'plains' }),
    islandwalk: () => landwalkOf({ kind: 'subtype', subtype: 'island' }),
    swampwalk: () => landwalkOf({ kind: 'subtype', subtype: 'swamp' }),
    mountainwalk: () => landwalkOf({ kind: 'subtype', subtype: 'mountain' }),
    forestwalk: () => landwalkOf({ kind: 'subtype', subtype: 'forest' }),
    'legendary landwalk': () => landwalkOf({ kind: 'legendary' }),
    'nonbasic landwalk': () => landwalkOf({ kind: 'nonbasic' }),
    // --- §3.111 the graveyard-casting family --------------------------------
    // RETRACE (CR 702.81a) — "You may cast this card from your graveyard by
    // discarding a land card in addition to paying its other costs." The
    // printed cost plus a discard rider in the additional-cost shape; the
    // spell goes back to the graveyard afterwards (no exile clause), which is
    // the closed `GRAVEYARD_CAST_EXIT` table's row for it.
    retrace: () => ({
      graveyardCasts: [
        {
          kind: 'retrace' as const,
          additional: { kind: 'discard' as const, filter: { anyOfTypes: ['land' as const] }, label: 'Discard a land card' },
        },
      ],
    }),
    // JUMP-START (CR 702.133a) — the same shape with "discard a card", and
    // "then exile this card" (the flashback exit).
    'jump-start': () => ({
      graveyardCasts: [{ kind: 'jumpStart' as const, additional: { kind: 'discard' as const, label: 'Discard a card' } }],
    }),
    // --- the counter keyword family (DESIGN §3.110) ------------------------------
    // UNDYING (CR 702.93a) — "When this creature dies, if it had no +1/+1
    // counters on it, return it to the battlefield under its owner's control
    // with a +1/+1 counter on it." Persist's +1/+1 mirror, modelled the way the
    // printed card is and NOT the way persist is: the "if" is a real
    // intervening "if" over the counters the creature HAD (last-known
    // information, snapshotted by the runtime as the death is emitted), so a
    // Young Wolf that grew from a Hardened Scales does not come back, and one
    // whose counter was proliferated away does. Persist strips its own trigger
    // instead; the two mechanisms are different on purpose (see `persistReturn`).
    undying: () => ({
      triggers: [
        {
          condition: {
            on: 'dies' as const,
            snapshotsCounters: PLUS_ONE_COUNTER,
            intervening: { kind: 'sourceDiedWithoutCounter' as const, counter: PLUS_ONE_COUNTER },
          },
          effects: [{ primitive: 'undyingReturn', params: { amount: UNDYING_RETURN_COUNTERS } }],
          label: 'Undying',
        },
      ],
    }),
    // EVOLVE (CR 702.100a) — "Whenever a creature you control enters, if that
    // creature has greater power or toughness than this creature, put a +1/+1
    // counter on this creature." A board-watching trigger that CARRIES its
    // subject, so the intervening "if" can compare the entering creature to the
    // source (both effective — CR 702.100c). The source's own entry fires the
    // trigger and fails the comparison, exactly as the rules have it.
    evolve: () => ({
      triggers: [
        {
          condition: {
            on: 'permanentEnters' as const,
            who: 'you' as const,
            permanentFilter: { anyOfTypes: ['creature' as const] },
            carriesSubject: true,
            intervening: { kind: 'triggeringCreatureLargerThanSource' as const },
          },
          effects: [{ primitive: 'addCounters', params: { amount: EVOLVE_COUNTERS, self: true } }],
          label: 'Evolve',
        },
      ],
    }),
    // RIOT (CR 702.136a) — "enters with your choice of a +1/+1 counter or
    // haste": an as-enters choice, so it sits in the ENTRY SCRIPT beside
    // "~ enters with N +1/+1 counters", asked as the spell resolves.
    riot: () => ({ effects: [{ primitive: 'riotChoice' }] }),
    // UNLEASH (CR 702.98a) — "You may have this creature enter with a +1/+1
    // counter on it. It can't block as long as it has a +1/+1 counter on it."
    // The choice is an entry-script question; the restriction is a SELF-ONLY
    // static keyed on the counter, read wherever blockers are declared.
    unleash: () => ({
      effects: [{ primitive: 'unleashChoice' }],
      statics: [
        {
          affects: { onlySource: true, hasCounterKind: PLUS_ONE_COUNTER },
          keywords: { cantBlock: true },
          label: "Unleash: can't block while it has a +1/+1 counter",
        },
      ],
    }),
    // DETHRONE (CR 702.105a) — "Whenever this creature attacks the player with
    // the most life or tied for most life, put a +1/+1 counter on it." In a
    // two-player game the defending player is the opponent, and "most or tied"
    // is the intervening "if" `opponentHasMostLife`.
    dethrone: () => ({
      triggers: [
        {
          condition: { on: 'attacks' as const, intervening: { kind: 'opponentHasMostLife' as const } },
          effects: [{ primitive: 'addCounters', params: { amount: DETHRONE_COUNTERS, self: true } }],
          label: 'Dethrone',
        },
      ],
    }),
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
      'a COPY-CREATING template outside the compiler’s closed tables (spell/ability copies with the "you control" scopes, token copies — tapped, "nonlegendary"/"artifact or creature" targets, a haste-grant follow-up sentence and a delayed "sacrifice/exile it at the beginning of the next end step" are ALL implemented; so are the "token you control" target, the "for each token you control" iteration and the "create a copy … instead" board-conditional substitution; what is missing is this selector or tail: "copy THAT spell" naming the spell that triggered the ability, an "except …" tail on a SPELL copy, or a copy COUNT conditional on where the spell was cast from)',
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
    // wrapper, and so is "As ~ enters, choose a creature type / a color / a
    // player / a basic land type", which compiles to a naming REMEMBERED on the
    // permanent. So this hint no longer claims either system is missing; that
    // would send the next agent to rebuild something that exists.
    //
    // ⚠️ THE WRAPPER IS MISSING ON NO TRIGGER FAMILY. It ships as a sibling rule
    // ordered after each plain form (so a body implementing its OWN option still
    // wins) for: enters, DIES, leaves-scoped equipment/aura hosts, attacks,
    // combat damage to a player, CAST-A-SPELL, DRAWS-A-CARD, the board-watching
    // arrival/death trigger and every "at the beginning of…" step. A clause
    // reaching this hint with "you may" in it is one whose INNER BODY has no
    // rule — a different piece of work from the wrapper, and it must not be
    // reported as one.
    //
    // What still lands here is therefore a TEMPLATE: an optional clause whose
    // BODY has no rule (a blink, a copy, a sacrifice-then-if-you-do chain), a
    // naming this engine could store but no printed line can yet read ("choose a
    // number between 1 and 10"), a "choose" that is neither a yes/no nor a
    // naming, or an ADDITIONAL COST offering a CHOICE of payments ("discard a
    // card or pay 3 life") — the mandatory single-payment forms compile (see the
    // sacrifice hint below).
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
      'a flashback template the compiler does not recognize yet (plain "Flashback {cost}", "Flashback—Sacrifice/Tap …" and the Snapcaster-style grant are supported; a discard or {X}-scaled flashback rider is not)',
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
    // "sacrifice ~ unless you discard a card / return an Island" (§3.106 took
    // the plain "sacrifice ~" and the mana/life "unless you pay" forms), a
    // sacrifice whose noun is outside the closed cost table, or a value derived from what was
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
    // finished work: phasing, DOUBLING counters, counter
    // kinds the stat layer does not read (charge/quest/growth/keyword counters —
    // time, fade and age counters are §3.106's, read by vanishing, fading and
    // cumulative upkeep), "each ATTACKING creature", once-per-turn trigger limiters,
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
    // protection quality with no engine meaning ("protection from mana value
    // 3 or less" — Reaver Titan; "from the chosen color" — Voice of All), or
    // "hexproof from <quality>", which is protection's shape with only the
    // targeting half. Card types, subtypes, "monocolored" and "each color"
    // all compile now (see `PROTECTION_QUALITY_WORDS` and its subtype table).
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
    // engine cannot express. A further round of BODIES has since shipped and is
    // named here for the same reason: the triggering-player edict ("that player
    // sacrifices a [nontoken] NOUN of their choice"), its each-player sibling,
    // the causative life loss ("have that player lose N life"), and a "FOR EACH
    // <counted thing>" count behind "gain 1 life" / "draw a card".
    //
    // Named so nobody re-builds finished work, the bodies STILL missing in the
    // corpus are: "you win/lose the game" behind an intervening "if" this table
    // cannot express ("if you have 40 or more life", "if you have exactly
    // thirteen cards in your hand" — the BODY compiles; the CONDITION is the
    // gap), blink (exile then return), token COPIES of a permanent, the city's
    // blessing/ascend, amass, discover, the Ring, a delayed "at the beginning of
    // your NEXT upkeep", any count derived from a revealed card's mana value,
    // and a "for each" count with a MULTIPLIER above one (a `DerivedValue`
    // carries a count with no scale factor, so "gain 2 life for each …" has no
    // honest encoding and is refused rather than halved).
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

// ===========================================================================
// §3.150 — THE PRINTED TARGET BOUND. One pre-pass, not a rule per verb.
//
// Measured on a 32,414-card corpus: 233 blocked cards are held out by a bound
// on a target selector alone, and the printed vocabulary is SMALL — four bound
// families across six verbs (destroy 75, return 23, "deals N damage to" 19,
// exile 17, counter 9, gain control of 4).
//
// A rule per verb would have re-spelled the whole noun vocabulary six times and
// left the seventh verb still broken, which is the "two places answer one
// question" failure rule 12 names. So this is ONE pre-pass in `applyRules`,
// exactly where §3.149 put the "where X is …" binding and for the same reason:
// the SENTENCES were never missing. "Destroy target creature." already
// compiles; it refuses only because the printed words "with flying" follow the
// noun. Strip the bound, let the ordinary rule compile the clause it always
// could, then narrow the restriction that rule declared.
//
// So every verb — present and future — gains bounded targets in one edit, and
// adding the next printed bound is a ROW in the tables below.
// ===========================================================================

/** The printed comparison words, as the {@link TargetBound} field each means. */
const TARGET_BOUND_DIRECTIONS: Readonly<Record<string, 'atLeast' | 'atMost'>> = Object.freeze({
  'or greater': 'atLeast',
  'or more': 'atLeast',
  'or less': 'atMost',
  'or fewer': 'atMost',
});

/** The printed numeric properties a bound may compare, as core's own property names. */
const TARGET_BOUND_PROPERTIES: Readonly<Record<string, TargetNumericProperty>> = Object.freeze({
  power: 'power',
  toughness: 'toughness',
  'mana value': 'manaValue',
  // Pre-2021 Oracle wording for the same number (CR 202.3). Both spellings are
  // in the corpus, so both are rows — never one spelling matched and the other
  // left to look like a different family.
  'converted mana cost': 'manaValue',
});

/**
 * The printed keywords a "with …"/"without …" bound may name, mapped to the
 * core keyword flag each one is.
 *
 * CLOSED, and the refusals matter: a keyword the engine does not model is NOT
 * quietly dropped from the selector, because "destroy target creature with
 * shadow" compiled as "destroy target creature" is a strictly better card. A
 * keyword outside this table makes the whole clause report.
 */
const TARGET_BOUND_KEYWORDS: Readonly<Record<string, keyof KeywordFlags>> = Object.freeze({
  flying: 'flying',
  trample: 'trample',
  vigilance: 'vigilance',
  haste: 'haste',
  'first strike': 'firstStrike',
  'double strike': 'doubleStrike',
  deathtouch: 'deathtouch',
  lifelink: 'lifelink',
  defender: 'defender',
  reach: 'reach',
  menace: 'menace',
  hexproof: 'hexproof',
  indestructible: 'indestructible',
  flash: 'flash',
});

/** The printed colour words a "target <colour> …" selector may name. */
const TARGET_BOUND_COLOURS: Readonly<Record<string, 'W' | 'U' | 'B' | 'R' | 'G'>> = Object.freeze({
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
});

const TARGET_BOUND_KEYWORD_PHRASE = Object.keys(TARGET_BOUND_KEYWORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');
const TARGET_BOUND_PROPERTY_PHRASE = Object.keys(TARGET_BOUND_PROPERTIES)
  .sort((a, b) => b.length - a.length)
  .join('|');
const TARGET_BOUND_DIRECTION_PHRASE = Object.keys(TARGET_BOUND_DIRECTIONS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * The printed bound TAIL, anchored to the word "target" so only a TARGET
 * selector is narrowed.
 *
 * ⚠️ Anchored deliberately: the same words follow a GROUP selector ("destroy
 * each creature with mana value 3 or less"), and that is a different consumer
 * with a different filter. Narrowing a group selector through the targeting
 * seam would police a target that does not exist and leave the group
 * unfiltered — a card playing wider than printed, in the half nobody looked at.
 */
const BOUND_TAIL = new RegExp(
  `\\b(target [a-z][a-z ]*?)\\s+((?:with|without) (?:${TARGET_BOUND_KEYWORD_PHRASE})|with (?:${TARGET_BOUND_PROPERTY_PHRASE}) \\d+ (?:${TARGET_BOUND_DIRECTION_PHRASE}))\\b`,
  'gi',
);

/** The printed COLOUR form, which sits before the noun rather than after it. */
const BOUND_COLOUR = new RegExp(`\\btarget (${Object.keys(TARGET_BOUND_COLOURS).join('|')}) (?=[a-z])`, 'gi');

/**
 * Read one printed bound phrase into a {@link TargetBound}, or `null`.
 *
 * CLOSED (engineering rule 2): a phrase no row understands returns null and the
 * clause reports with its real number, rather than being widened to the nearest
 * bound that happens to exist.
 */
function parseBoundPhrase(phrase: string): TargetBound | null {
  const keyword = new RegExp(`^(with|without) (${TARGET_BOUND_KEYWORD_PHRASE})$`, 'i').exec(phrase);
  if (keyword) {
    const flag = TARGET_BOUND_KEYWORDS[(keyword[2] ?? '').toLowerCase()];
    if (flag === undefined) return null;
    return (keyword[1] ?? '').toLowerCase() === 'with' ? { withKeyword: flag } : { withoutKeyword: flag };
  }
  const numeric = new RegExp(
    `^with (${TARGET_BOUND_PROPERTY_PHRASE}) (\\d+) (${TARGET_BOUND_DIRECTION_PHRASE})$`,
    'i',
  ).exec(phrase);
  if (numeric) {
    const property = TARGET_BOUND_PROPERTIES[(numeric[1] ?? '').toLowerCase()];
    const direction = TARGET_BOUND_DIRECTIONS[(numeric[3] ?? '').toLowerCase()];
    if (property === undefined || direction === undefined) return null;
    const value = Number(numeric[2]);
    if (!Number.isInteger(value)) return null;
    return direction === 'atLeast' ? { atLeast: { property, value } } : { atMost: { property, value } };
  }
  return null;
}

/** What {@link stripTargetBound} found: the clause without its bound, and the bound. */
export interface StrippedTargetBound {
  readonly clause: string;
  readonly bound: TargetBound;
}

/**
 * Take the printed bound off a clause's target selector, so the ordinary rules
 * can compile the sentence they always could.
 *
 * Refuses (returns null) when the clause carries MORE THAN ONE bounded
 * selector: a clause with two aims has no single restriction to narrow, and
 * guessing which one the bound belongs to is how a closed table stops being
 * closed. Those cards keep reporting, with their number.
 */
export function stripTargetBound(clause: string): StrippedTargetBound | null {
  const tails = [...clause.matchAll(BOUND_TAIL)];
  const colours = [...clause.matchAll(BOUND_COLOUR)];
  if (tails.length + colours.length !== 1) return null;
  if (tails.length === 1) {
    const hit = tails[0] as RegExpMatchArray;
    const bound = parseBoundPhrase((hit[2] ?? '').trim());
    if (bound === null) return null;
    return { clause: clause.replace(hit[0], hit[1] ?? ''), bound };
  }
  const hit = colours[0] as RegExpMatchArray;
  const colour = TARGET_BOUND_COLOURS[(hit[1] ?? '').toLowerCase()];
  if (colour === undefined) return null;
  return { clause: clause.replace(hit[0], 'target '), bound: { colour } };
}

/**
 * Narrow every target restriction a compiled clause declared by `bound`.
 *
 * Returns null — refusing the whole clause — when the compiled effects declare
 * NO restriction, or declare more than one distinct one, or declare one that is
 * already bounded. All three mean the printed bound has no single unambiguous
 * home, and attaching it to a guess would produce a card that targets something
 * its printed text does not allow. Refusing keeps the card REPORTED with its
 * number, which is the project's whole acceptance rule.
 */
export function applyTargetBound(effects: readonly EffectRef[], bound: TargetBound): EffectRef[] | null {
  const declared = new Set<string>();
  for (const ref of effects) {
    const value = ref.params?.[TARGET_RESTRICTION_PARAM];
    if (value === undefined) continue;
    if (!isTargetRestriction(value)) return null; // already bounded, or not a restriction at all
    declared.add(value);
  }
  if (declared.size !== 1) return null;
  const base = [...declared][0] as TargetRestriction;
  return effects.map((ref) =>
    ref.params?.[TARGET_RESTRICTION_PARAM] === undefined
      ? ref
      : { ...ref, params: { ...ref.params, [TARGET_RESTRICTION_PARAM]: { base, bound } } },
  );
}
// ============================ end §3.150 ==================================
