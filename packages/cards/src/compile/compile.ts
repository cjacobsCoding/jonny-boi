/**
 * The Oracle-text → `CardDefinition` compiler.
 *
 * Given a normalized Scryfall card, produce the engine definition that genuinely
 * plays it — cost, types, P/T, keyword flags, mana production, triggered
 * abilities and spell scripts — by matching each printed ability against the
 * rule table in `./rules.ts`.
 *
 * The compiler is deliberately STRICT. Every printed ability must be consumed by
 * a rule; anything left over is reported in `missing` and the result is
 * `'incomplete'`, which callers must treat as "not playable yet" (see
 * `./types.ts`). This is what lets the deck lab import arbitrary real cards
 * without quietly degrading the fidelity its statistical verdicts depend on.
 *
 * Pure and synchronous: no I/O, no network, no globals — the caller supplies the
 * card record (DESIGN §2.1).
 */

import type {
  ActivatedAbility,
  ActivationCost,
  AdditionalCastCost,
  AttachmentSpec,
  CardDefinition,
  CardFilter,
  CardType,
  EffectRef,
  ManaColor,
  ManaCost,
  ManaProduction,
  PermanentModification,
  TargetRestriction,
  TriggeredAbility,
} from '@jonny-boi/core';
import { DEFAULT_TARGET_RESTRICTION, restrictionOfEffects } from '@jonny-boi/core';
import type {
  ClauseContribution,
  CompilableCard,
  CompileResult,
  CompileRule,
  RuleContext,
  TriggerBodyResult,
  UnsupportedClause,
  VacuousClause,
} from './types.js';
import {
  EFFECT_RULES,
  KEYWORD_ABILITY_BUILDERS,
  joinPayloadKeywords,
  KEYWORD_FLAGS,
  MANA_RULES,
  STATIC_RULES,
  TRIGGER_RULES,
  ABILITY_WORDS,
  explainUnsupported,
  isVacuousClause,
  parsePayloadKeyword,
  COST_NOUNS,
  COST_NOUN_PHRASE,
} from './rules.js';
import { mergeKeywordGrant } from '@jonny-boi/core';
import type { CastZone, KeywordFlags } from '@jonny-boi/core';
import { frontFaceName, normalizeClause, parseManaSymbols, prepareOracle, splitSentences } from './text.js';
import { AS_ENTERS_PRIMITIVE } from '../choice-primitives.js';

/**
 * Scryfall's keyword names for the two printed attachment abilities. They are
 * modelled by the rule table (`enchant-permanent` / `equip-cost`) rather than by a
 * keyword flag, so the keyword sweep must not report them a second time.
 */
const ATTACHMENT_KEYWORDS: ReadonlySet<string> = new Set(['enchant', 'equip']);

/**
 * Scryfall keywords that this compiler models as effect PRIMITIVES matched by the
 * rule table rather than as keyword flags or dedicated assembly fields.
 *
 * Scry, Surveil and Mill each compile from their printed line (`scry-n`,
 * `surveil-n`, `scry-then-effect`, `self-mill`, `target-player-mills`) into an
 * `EffectRef` whose `primitive` is the name below. The keyword sweep therefore has
 * to look at the compiled OUTPUT to decide whether the line was implemented — the
 * same question `flashback`/`kicker` answer with a single assembly field.
 *
 * The guard is deliberately evidence-based, not a blanket skip: a wording the rule
 * table does NOT match (a derived or conditional count, "look at the top N …")
 * produces no such primitive, so that card still reports honestly.
 */
/**
 * Scryfall's keyword names for a damage-SCALING replacement ability. They are
 * modelled by the rule table (`replacement-damage-scaled`) as
 * `CardDefinition.replacements` data rather than as a keyword flag, so the sweep
 * must not report them a second time — see the guard's own comment for why it is
 * keyed on the compiled outcome rather than on the word.
 */
const SCALING_KEYWORDS: ReadonlySet<string> = new Set(['double', 'triple']);

/**
 * Scryfall names for the three COST-ASSISTANCE keywords, modelled as one
 * costAssist kind by the rule table rather than as a keyword flag — so the
 * sweep must not report them a second time. Keyed on the compiled outcome for
 * the same reason every other guard here is.
 */
const COST_ASSIST_KEYWORDS: ReadonlySet<string> = new Set(['convoke', 'improvise', 'delve']);


/**
 * Keywords whose whole implementation is a TRIGGERED ABILITY compiled from the
 * printed line — bushido and the combat-declaration family beside it.
 *
 * Scryfall lists the bare word ("Bushido") while the printed line carries the
 * payload ("Bushido 1"), so without this the sweep reports the keyword as
 * unmodelled one line after implementing it — the same false report Kicker,
 * Flashback and Affinity each have a guard for. This is the TABLE those guards
 * should have been: adding the next such keyword is a ROW, not a branch.
 *
 * Keyed on the compiled trigger LABEL rather than on its condition, for two
 * reasons. It is per-keyword precise — flanking and rampage watch the SAME
 * event as bushido, and a condition key would let one that compiled absolve a
 * sibling that did not. And it keeps the evidence-based contract every guard
 * here holds to: a line the rule table did not match compiles no trigger, so
 * the card still reports honestly through that line’s own `missing` entry.
 */
const TRIGGER_BACKED_KEYWORDS: ReadonlySet<string> = new Set([
  'bushido',
  // SOULSHIFT N (§3.122): a dies trigger labelled "Soulshift N", so a printed
  // line the rule table matched is the evidence the sweep reads. A 'Soulshift X'
  // form (none is printed) would compile no trigger and still report.
  'soulshift',
  // RAMPAGE N (CR 702.23a, DESIGN §3.107): the same shape as bushido — the
  // number is the whole payload, so it is a pattern rule labelled "Rampage N".
  'rampage',
  // §3.106 — the upkeep-cost family: each compiles to an `upkeep` trigger whose
  // label starts with the keyword ("Echo {2}{R}", "Cumulative upkeep {1}",
  // "Vanishing 3", "Fading 2"). A cost form outside the closed table (an echo
  // paid in cards, a cumulative upkeep paid in sacrifices) compiles no trigger
  // and reports through its own line.
  'echo',
  'cumulative upkeep',
  'vanishing',
  'fading',
  // §3.110 — the counter keyword family's PARAMETRISED members, each a pattern
  // rule whose trigger label starts with the keyword ("Modular 2", "Renown 1",
  // "Fabricate 2", "Backup 1", "Afterlife 2"). The argument-less members
  // (undying, evolve, riot, unleash, dethrone) are `KEYWORD_ABILITY_BUILDERS`
  // rows and need no evidence here; a form outside the table ("Modular—
  // Sunburst") compiles no trigger and reports through its own line.
  'modular',
  'renown',
  'backup',
  'afterlife',
]);

/**
 * §3.110 — a keyword whose whole implementation is an ACTIVATED ability the
 * printed line compiled (outlast: "{cost}, {T}: put a +1/+1 counter on this
 * creature. Activate only as a sorcery"). The evidence is an activated ability
 * whose label starts with the keyword — the activated-side twin of
 * {@link TRIGGER_BACKED_KEYWORDS}, and a table for the same reason.
 */
const ACTIVATED_BACKED_KEYWORDS: ReadonlySet<string> = new Set(['outlast']);

/**
 * Scryfall's tag for EVERY landwalk printing is the bare word "Landwalk" beside
 * the printed one ("Islandwalk", "Legendary landwalk") — so a compiled
 * `keywords.landwalk` payload answers for any tag ending in the word, exactly
 * as a compiled `cycling` list answers for "Plainscycling" (DESIGN §3.107).
 * Evidence-based like every guard here: a walk outside the closed
 * `LandCondition` table compiles no payload and still reports through its own
 * line.
 */
function isLandwalkKeyword(word: string): boolean {
  return word.endsWith('landwalk');
}

/**
 * Keywords whose PAYLOAD lives in a keyword FIELD rather than a flag — Scryfall
 * lists the bare word ("Ward", "Protection", "Toxic") while the printed line
 * carries the value ("Ward {2}", "Protection from red", "Toxic 1"). The sweep
 * treats the compiled field as the evidence that the line was implemented; a
 * line the closed tables could not read leaves the field unset, so the keyword
 * still reports through that line's own `missing` entry. The same table shape
 * as {@link TRIGGER_BACKED_KEYWORDS}, and for the same reason (§3.105): the
 * next payload keyword is a ROW here, not another `if (word === …)`.
 */
const PAYLOAD_KEYWORD_EVIDENCE: Readonly<Record<string, keyof KeywordFlags>> = Object.freeze({
  ward: 'ward',
  protection: 'protectionFrom',
  toxic: 'toxic',
});

/**
 * §3.111 — Scryfall's names for the GRAVEYARD-ACTIVATED keywords, each mapped
 * to the `GraveyardAbilityKind` its printed line compiles into. Evidence-based
 * like every guard here: a line the closed cost table could not read
 * ("Unearth—Pay eight {E}") compiles no ability of that kind and the keyword
 * still reports through the line's own `missing` entry.
 */
const GRAVEYARD_ABILITY_KEYWORDS: Readonly<Record<string, import('@jonny-boi/core').GraveyardAbilityKind>> =
  Object.freeze({
    unearth: 'unearth',
    scavenge: 'scavenge',
    embalm: 'embalm',
    eternalize: 'eternalize',
    encore: 'encore',
  });

/** §3.111 — the same table for the GRAVEYARD-CAST keywords (`GraveyardCastKind`). */
const GRAVEYARD_CAST_KEYWORDS: Readonly<Record<string, import('@jonny-boi/core').GraveyardCastKind>> = Object.freeze({
  retrace: 'retrace',
  'jump-start': 'jumpStart',
  // Scryfall tags every jump-start card with BOTH "Jump-start" and a phantom
  // "Jump" (Direct Current: `["Jump","Jump-start"]`). No such keyword exists;
  // it is the same printed line, so the same compiled cast is its evidence —
  // the §3.109 shape (a tag the engine HAS was still blocking cards), one row.
  jump: 'jumpStart',
  escape: 'escape',
});


const PRIMITIVE_BACKED_KEYWORDS: Readonly<Record<string, string | readonly string[]>> = Object.freeze({
  scry: 'scry',
  surveil: 'surveil',
  // §3.113 — "from among the milled cards" mills through its own primitive
  // (the same funnel), so either is the evidence the line compiled.
  mill: ['mill', 'millThenReturn'],
  // §3.113 — Scryfall tags "Learn" and "Double" (the power-doubling verb, CR
  // 701.10b — the damage-doubling replacement is `SCALING_KEYWORDS`' guard).
  learn: 'learn',
  double: 'doublePower',
  // Scryfall tags a card "Treasure" / "Food" / "Investigate" when its text
  // creates the predefined token; the compiled evidence is the lookup
  // primitive. A wording the create rule did not match compiles none and
  // still reports through its own missing entry.
  treasure: 'createPredefinedToken',
  food: 'createPredefinedToken',
  investigate: 'createPredefinedToken',
  proliferate: 'proliferate',
  // §3.110 — the counter keyword family's ACTION and ENTRY-SCRIPT members:
  // amass (CR 701.47) and bolster (701.39) are keyword actions printed as
  // spell text, explore (701.44) is a trigger body, and bloodthirst (702.54),
  // devour (702.82), riot (702.136) and unleash (702.98) compile to the
  // permanent's own entry script. Same evidence contract: a form the rule table
  // could not read ("Bloodthirst X", "Devour X") compiles no primitive and
  // reports through its own line.
  amass: 'amass',
  bolster: 'bolster',
  explore: 'explore',
  bloodthirst: 'bloodthirstCounters',
  devour: 'devourChoice',
  fabricate: 'fabricateChoice',
  // Scryfall tags the card "Regenerate"; the compiled evidence is the shield
  // primitive the printed ability built (CR 701.19).
  regenerate: 'regenerate',
  // §3.113 — Scryfall ALSO tags every regenerate card "Heal", after the word in
  // its reminder text ("…and heal all damage on it"). Measured over the whole
  // corpus: 33 cards carry the tag, 32 print regenerate, and NONE prints a
  // "Heal" line of its own — so the compiled regenerate is the evidence, and a
  // real Heal keyword line, should one ever be printed, compiles none and
  // still reports through its own missing entry.
  heal: 'regenerate',
});

/**
 * §3.113 — the keywords whose printed line compiles to a CAST TRIGGER
 * (`CardDefinition.castTriggers`): storm, cascade, ripple. The sweep's
 * evidence is a trigger tagged with the keyword, the same evidence-based
 * contract as every guard above.
 */
const CAST_TRIGGER_KEYWORDS: ReadonlySet<string> = new Set(['storm', 'cascade', 'ripple']);

/**
 * Every effect-primitive name reachable in a compiled assembly.
 *
 * Primitives nest: a scry can sit inside a triggered ability's effect list (the
 * Theros temples), inside an activated ability (Castle Vantress), or inside another
 * primitive's params (`scry-then-effect`, the "you may" wrappers). A shallow look at
 * `assembly.effects` would miss all three and report the keyword anyway, so the walk
 * is a deep one over the assembled data.
 */
function compiledPrimitives(assembly: Assembly): ReadonlySet<string> {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.primitive === 'string') found.add(record.primitive);
    for (const value of Object.values(record)) visit(value);
  };
  visit(assembly.effects);
  visit(assembly.triggers);
  visit(assembly.activated);
  visit(assembly.statics);
  // §3.113 — two more homes a primitive can have, found by the sweep reporting
  // "Scry" on Oracle's Insight ("Enchanted creature has '{T}: Scry 1, then draw
  // a card.'") and "Surveil" on Spellgyre (a MODE prints it): the granted
  // ability lives on the attachment's modification, and a mode's effects live
  // on the modal spec. Both compiled; neither was walked.
  visit(assembly.attachmentModifies);
  visit(assembly.modal);
  return found;
}

/** Scryfall card types → the core `CardType`s the engine understands. */
const TYPE_MAP: Readonly<Record<string, CardType>> = Object.freeze({
  land: 'land',
  creature: 'creature',
  instant: 'instant',
  sorcery: 'sorcery',
  artifact: 'artifact',
  enchantment: 'enchantment',
  planeswalker: 'planeswalker',
  battle: 'battle',
  // Kindred (CR 308, printed as "Tribal" before 2024) — a real card type with a
  // real, small meaning: it never appears alone, and it makes the card's
  // subtypes CREATURE types without making the card a creature. Mapped rather
  // than reported because core models exactly that (see `CardType`), so a
  // Kindred Sorcery is a sorcery with Eldrazi among its subtypes, which is what
  // the printed card is.
  kindred: 'kindred',
});

/**
 * Card types the engine has no system for, with the reason. Exported so the
 * About view's TODO list can name these gaps from the same record the compiler
 * judges by.
 *
 * The record is EMPTY, and that is the honest state of the world: every printed
 * card type the engine can meet now has a system behind it. `planeswalker` left
 * when loyalty landed; `battle` left when battles did — a battle enters with its
 * printed defense counters, is attacked through the same attackable-object seam
 * as a walker, loses defense to combat and to burn, and is put into its owner's
 * graveyard by a state-based action at zero.
 *
 * ⚠️ A battle CARD is still usually reported, and by design: every printed battle
 * is a Siege, whose reward is casting its BACK FACE, and that needs the
 * castable-second-face system (`SECOND_CASTABLE_FACE_GAP`). The subsystem being
 * complete is not the same claim as the cards being playable, and the compiler
 * says so per card rather than letting a type-level "supported" imply it.
 */
export const TYPES_WITHOUT_SYSTEM: Readonly<Record<string, string>> = Object.freeze({});

/**
 * A Kindred card ALWAYS prints a second card type (CR 308.1), and the second
 * one is what decides how the card is played. A record that somehow carried
 * `Kindred` alone would therefore be malformed rather than unsupported — it is
 * reported through the generic "a card type the engine can represent" check
 * below rather than being given a system-shaped excuse.
 */
const KINDRED_TYPE = 'kindred';

/** Basic land subtypes → the mana they tap for. */
const LAND_SUBTYPE_MANA: Readonly<Record<string, ManaColor>> = Object.freeze({
  plains: 'W',
  island: 'U',
  swamp: 'B',
  mountain: 'R',
  forest: 'G',
});

/**
 * Keyword abilities that are not a simple combat flag but DO have a faithful
 * implementation built from primitives. Prowess is the canonical case: it is
 * modelled exactly as the hand-authored pool models it — a cast trigger per
 * noncreature spell type that pumps the source until end of turn.
 */
const KEYWORD_ABILITY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  // Prowess's own reminder text, in the compiler's canonical form: the SOURCE
  // gets the buff. (It must be the self template, not "target creature" — a
  // triggered ability resolves with no chosen targets, so only a self-referring
  // pump is faithful inside one. See `triggerFrom` in ./rules.ts.)
  prowess: 'whenever you cast a noncreature spell, ~ gets +1/+1 until end of turn',
});

/**
 * A color/color hybrid symbol as the Scryfall parser leaves it in `other`
 * (e.g. `G/W`). Monocolour hybrid (`2/W`) and Phyrexian (`W/P`) deliberately do
 * not match — the engine cannot pay those, so they must stay reported.
 */
const HYBRID_SYMBOL = /^([WUBRGC])\/([WUBRGC])$/;

/** Fold a fixed bundle of colors ({C}{C}) into the single mode one tap adds. */
function bundleAsMode(bundle: readonly ManaColor[]): ManaProduction {
  const mode: Partial<Record<ManaColor, number>> = {};
  for (const color of bundle) mode[color] = (mode[color] ?? 0) + 1;
  return mode;
}

/** Split `other` cost symbols into payable hybrids, `{X}` symbols, and genuinely unpayable ones. */
function partitionOtherSymbols(symbols: readonly string[]): {
  hybrid: ManaColor[][];
  /** How many `{X}` symbols the cost prints — payable now (chosen at cast time). */
  xCount: number;
  unpayable: string[];
} {
  const hybrid: ManaColor[][] = [];
  const unpayable: string[] = [];
  let xCount = 0;
  for (const symbol of symbols) {
    // Canonical `other` entries are brace-free ('X', 'G/W'), but a hand-built
    // record may carry the printed form ('{X}') — fold both to one shape.
    const upper = symbol.replace(/[{}]/g, '').toUpperCase();
    if (upper === 'X') {
      xCount += 1;
      continue;
    }
    const match = HYBRID_SYMBOL.exec(upper);
    if (match) hybrid.push([match[1] as ManaColor, match[2] as ManaColor]);
    else unpayable.push(symbol);
  }
  return { hybrid, xCount, unpayable };
}

/** Convert a data-tools mana cost to the core cost shape (omitting zeroes). */
function toCoreCost(card: CompilableCard, hybrid: readonly (readonly ManaColor[])[]): ManaCost | undefined {
  const source = card.manaCost;
  const cost: Record<string, unknown> = {};
  if (source.generic > 0) cost.generic = source.generic;
  for (const color of ['W', 'U', 'B', 'R', 'G', 'C'] as const) {
    const count = source[color];
    if (count > 0) cost[color] = count;
  }
  if (hybrid.length > 0) cost.hybrid = hybrid;
  return Object.keys(cost).length > 0 ? (cost as ManaCost) : undefined;
}

/**
 * Whether the rule with this id declares that its effects need a target chosen by
 * somebody. Looked up by id (rather than threaded through every call site)
 * because it is asked once per trigger body, off any hot path — and looking it up
 * in the SAME table `applyRules` matched against is what stops the two from
 * disagreeing about which rules target.
 */
function ruleNeedsChosenTarget(ruleId: string): boolean {
  return EFFECT_RULES.some((rule) => rule.id === ruleId && rule.needsChosenTarget === true);
}

/**
 * Try every rule in a table against one clause; return the first contribution.
 *
 * `targetFree` restricts the table to rules whose effects work without a
 * caster-chosen target — the mode trigger bodies compile in, since core resolves
 * triggered abilities with no targets.
 */
function applyRules(
  rules: readonly CompileRule[],
  clause: string,
  ctx: RuleContext,
  targetFree = false,
): { contribution: ClauseContribution; ruleId: string } | null {
  for (const rule of rules) {
    if (targetFree && rule.needsChosenTarget) continue;
    const match = clause.match(rule.pattern);
    if (!match) continue;
    const contribution = rule.build(match, ctx);
    // A rule that recognized the shape but cannot implement this instance
    // returns null — keep looking, then fall through to `missing`.
    if (contribution) return { contribution, ruleId: rule.id };
  }
  return null;
}

/** Accumulator for the pieces a card's clauses contribute. */
interface Assembly {
  readonly effects: EffectRef[];
  readonly triggers: TriggeredAbility[];
  readonly produces: ManaColor[];
  readonly producesOptions: ManaProduction[];
  /** Mana abilities that print a cost, a rider, a restriction or derived colours. */
  readonly manaAbilities: import('@jonny-boi/core').ManaAbility[];
  readonly activated: ActivatedAbility[];
  readonly statics: import('@jonny-boi/core').StaticAbility[];
  /** Printed replacement/prevention abilities (core's CR 614/615 layer). */
  readonly replacements: import('@jonny-boi/core').ReplacementAbility[];
  keywords: KeywordFlags;
  entersTapped: boolean;
  entersTappedUnless?: import('@jonny-boi/core').EntersUntappedCondition;
  entersTappedUnlessLifePaid?: number;
  additionalLandPlays?: number;
  castCostReduction?: CardDefinition['castCostReduction'];
  castCostReductionPerPermanent?: CardDefinition['castCostReductionPerPermanent'];
  costAssist?: CardDefinition['costAssist'];
  entersTappedUnlessRevealed?: import('@jonny-boi/core').RevealFromHandCondition;
  copyAsEnters?: import('@jonny-boi/core').CopyAsEntersSpec;
  /** The printed "As ~ enters, choose a…" naming, once some line prints it. */
  asEntersChoice?: import('@jonny-boi/core').AsEntersChoice;
  /** "~ is the chosen type in addition to its other types". */
  isChosenSubtype?: boolean;
  /** The printed "Kicker {COST}", once some line prints it. */
  kicker?: ManaCost;
  /**
   * The printed "As an additional cost to cast this spell, …" — a MANDATORY cost
   * that makes the cast illegal when it cannot be paid (CR 601.2h).
   */
  additionalCost?: AdditionalCastCost;
  /** The printed "Multikicker {COST}" — an additional cost paid any number of times. */
  multikicker?: ManaCost;
  /** The printed modal header + modes ("Choose one — • … • …"). */
  modal?: import('@jonny-boi/core').ModalSpec;
  /** The printed flashback cost, once a "Flashback {…}" line compiles. */
  flashback?: ManaCost;
  /** How many {X} symbols the flashback cost prints. */
  flashbackXCost?: number;
  /** The "Pay N life" rider on a flashback cost. */
  flashbackLifeCost?: number;
  // --- §3.111 the graveyard-casting family --------------------------------------
  /** A non-mana flashback cost, once a "Flashback—Sacrifice …" / "—Tap …" line compiles. */
  flashbackAdditionalCost?: import('@jonny-boi/core').AdditionalCastCost;
  /** Retrace / jump-start / escape, accumulated (created on first use). */
  graveyardCasts?: import('@jonny-boi/core').GraveyardCastAbility[];
  /** Unearth / scavenge / embalm / eternalize / encore / the return template, accumulated. */
  graveyardAbilities?: import('@jonny-boi/core').GraveyardAbility[];
  /** Cycling abilities, accumulated — a card may print cycling AND landcycling. */
  readonly cycling: import('@jonny-boi/core').CyclingAbility[];
  /** The printed buyback cost, once a "Buyback {…}" line compiles. */
  buyback?: ManaCost;
  /** The printed madness cost, once a "Madness {…}" line compiles. */
  madness?: ManaCost;
  /** §3.106 — the printed suspend, once a "Suspend N—{…}" line compiles. */
  suspend?: import('@jonny-boi/core').SuspendAbility;
  /** §3.113 — the printed cast triggers (storm / cascade / ripple), accumulated. */
  castTriggers?: import('@jonny-boi/core').CastTriggeredAbility[];
  /** §3.106 — counters the permanent enters with (vanishing / fading), accumulated. */
  readonly entersWithCounters: import('@jonny-boi/core').EnteringCounters[];
  /** The formula behind a `*` P/T box, once a line compiles one. */
  characteristicPT?: import('@jonny-boi/core').CharacteristicPT;
  /** The "Enchant …" / "Equip {N}" half of an attachment, once some line prints it. */
  attachesAs?: ClauseContribution['attachesAs'];
  /** The "Enchanted/Equipped creature gets …" half, accumulated across lines. */
  attachmentModifies?: PermanentModification;
  /** Set once a line prints the keyword **Changeling**. */
  changeling?: boolean;
  colorless?: boolean;
  /** Set once a line prints "This spell can't be countered". */
  cantBeCountered?: boolean;
  /** Set once a line prints "Spells [you control] can't be countered". */
  spellsCantBeCountered?: import('@jonny-boi/core').UncounterableSpellsAbility;
  /** Set once a line prints "You have no maximum hand size". */
  noMaximumHandSize?: boolean;
  /** Land-play zones this card unlocks, accumulated across lines. */
  playLandsFrom?: import('@jonny-boi/core').LandPlayZone[];
  /** Clauses implemented by doing nothing, with their reasons (DESIGN §3.107). */
  vacuous?: VacuousClause[];
  readonly matchedRules: string[];
  readonly missing: UnsupportedClause[];
}

/**
 * Whether a Scryfall keyword name is a CYCLING one. Matched by suffix rather
 * than against a list, because Scryfall names the typed variants BOTH generically
 * ("Typecycling") and by the printed word ("Plainscycling", "Islandcycling",
 * "Landcycling") — and a list would have to enumerate every land, creature and
 * artifact type that has ever been printed with the word attached. All of them
 * compile to the same `CardDefinition.cycling` list, so all of them are answered
 * by the same guard.
 */
function isCyclingKeyword(word: string): boolean {
  return word === 'cycling' || word.endsWith('cycling');
}

/** Merge one clause contribution into the assembly. */
function absorb(assembly: Assembly, contribution: ClauseContribution, ruleId: string): void {
  if (contribution.effects) assembly.effects.push(...contribution.effects);
  if (contribution.triggers) assembly.triggers.push(...contribution.triggers);
  if (contribution.produces) assembly.produces.push(...contribution.produces);
  if (contribution.producesOptions) assembly.producesOptions.push(...contribution.producesOptions);
  if (contribution.manaAbilities) assembly.manaAbilities.push(...contribution.manaAbilities);
  if (contribution.keywords) {
    // Folded by the same merge rule the engine layers with: boolean flags OR,
    // protection lists UNION, ward costs ADD (`mergeKeywordGrant`).
    assembly.keywords = mergeKeywordGrant(assembly.keywords, contribution.keywords);
  }
  if (contribution.activated) assembly.activated.push(...contribution.activated);
  if (contribution.statics) assembly.statics.push(...contribution.statics);
  if (contribution.replacements) assembly.replacements.push(...contribution.replacements);
  if (contribution.entersTapped) assembly.entersTapped = true;
  if (contribution.entersTappedUnless) assembly.entersTappedUnless = contribution.entersTappedUnless;
  if (contribution.entersTappedUnlessLifePaid !== undefined) {
    assembly.entersTappedUnlessLifePaid = contribution.entersTappedUnlessLifePaid;
  }
  if (contribution.additionalLandPlays !== undefined) {
    assembly.additionalLandPlays = (assembly.additionalLandPlays ?? 0) + contribution.additionalLandPlays;
  }
  if (contribution.castCostReduction !== undefined) assembly.castCostReduction = contribution.castCostReduction;
  if (contribution.castCostReductionPerPermanent !== undefined)
    assembly.castCostReductionPerPermanent = contribution.castCostReductionPerPermanent;
  if (contribution.costAssist !== undefined) assembly.costAssist = contribution.costAssist;
  if (contribution.copyAsEnters !== undefined) assembly.copyAsEnters = contribution.copyAsEnters;
  if (contribution.entersTappedUnlessRevealed !== undefined) {
    assembly.entersTappedUnlessRevealed = contribution.entersTappedUnlessRevealed;
  }
  if (contribution.asEntersChoice !== undefined) assembly.asEntersChoice = contribution.asEntersChoice;
  if (contribution.isChosenSubtype) assembly.isChosenSubtype = true;
  if (contribution.kicker) assembly.kicker = contribution.kicker;
  if (contribution.additionalCost) assembly.additionalCost = contribution.additionalCost;
  if (contribution.multikicker) assembly.multikicker = contribution.multikicker;
  if (contribution.modal) assembly.modal = contribution.modal;
  if (contribution.cycling) assembly.cycling.push(...contribution.cycling);
  if (contribution.buyback) assembly.buyback = contribution.buyback;
  if (contribution.madness) assembly.madness = contribution.madness;
  // §3.106
  if (contribution.suspend) assembly.suspend = contribution.suspend;
  // §3.113 — accumulated: "Cascade, cascade" is two triggers (CR 702.85a per instance).
  if (contribution.castTriggers) (assembly.castTriggers ??= []).push(...contribution.castTriggers);
  if (contribution.entersWithCounters) assembly.entersWithCounters.push(...contribution.entersWithCounters);
  if (contribution.characteristicPT) assembly.characteristicPT = contribution.characteristicPT;
  if (contribution.flashback !== undefined) assembly.flashback = contribution.flashback;
  if (contribution.flashbackXCost !== undefined) assembly.flashbackXCost = contribution.flashbackXCost;
  if (contribution.flashbackLifeCost !== undefined) {
    assembly.flashbackLifeCost = contribution.flashbackLifeCost;
  }
  // §3.111 — the graveyard-casting family. Lists are created on first use so
  // the ordinary card's assembly keeps the shape it had.
  if (contribution.flashbackAdditionalCost !== undefined) {
    assembly.flashbackAdditionalCost = contribution.flashbackAdditionalCost;
  }
  if (contribution.graveyardCasts) (assembly.graveyardCasts ??= []).push(...contribution.graveyardCasts);
  if (contribution.graveyardAbilities) {
    (assembly.graveyardAbilities ??= []).push(...contribution.graveyardAbilities);
  }
  if (contribution.changeling) assembly.changeling = true;
  if (contribution.colorless) assembly.colorless = true;
  if (contribution.cantBeCountered) assembly.cantBeCountered = true;
  if (contribution.spellsCantBeCountered) assembly.spellsCantBeCountered = contribution.spellsCantBeCountered;
  if (contribution.noMaximumHandSize) assembly.noMaximumHandSize = true;
  // A vacuous clause is RECORDED, never dropped (DESIGN §3.107).
  if (contribution.vacuous !== undefined) (assembly.vacuous ??= []).push(contribution.vacuous);
  if (contribution.playLandsFrom) {
    // Accumulated, not replaced: Bolas's Citadel prints one zone and a second
    // line could print another, and both permissions are real at once.
    const zones = assembly.playLandsFrom ?? (assembly.playLandsFrom = []);
    for (const zone of contribution.playLandsFrom) if (!zones.includes(zone)) zones.push(zone);
  }
  if (contribution.attachesAs) assembly.attachesAs = contribution.attachesAs;
  if (contribution.attachmentModifies) {
    // Merged rather than replaced: a card may print the P/T line and the keyword
    // line separately ("Equipped creature gets +1/+1." / "Equipped creature has
    // vigilance."), and both are the same one modification.
    assembly.attachmentModifies = mergeModifications(assembly.attachmentModifies, contribution.attachmentModifies);
  }
  assembly.matchedRules.push(ruleId);
}

/** Sum two attachment modifications (P/T adds, keyword grants OR together). */
function mergeModifications(
  existing: PermanentModification | undefined,
  incoming: PermanentModification,
): PermanentModification {
  if (!existing) return incoming;
  // Every field of a modification is ADDITIVE (the conformance witness in
  // `rules-manifest.ts` proves it), so merging is field-wise addition: deltas
  // sum, keyword flags union, and granted ABILITIES concatenate — a Sword that
  // grants two of them grants both.
  const activated = [...(existing.activated ?? []), ...(incoming.activated ?? [])];
  return {
    power: (existing.power ?? 0) + (incoming.power ?? 0),
    toughness: (existing.toughness ?? 0) + (incoming.toughness ?? 0),
    keywords: { ...existing.keywords, ...incoming.keywords },
    ...(activated.length > 0 ? { activated } : {}),
  };
}

/**
 * The `attachment` data a card's clauses added up to, or `undefined`.
 *
 * A modification with no "Enchant …"/"Equip {N}" line is deliberately REFUSED
 * (returns `undefined`, and the caller reports the clause): "Enchanted creature
 * gets +2/+0" alone tells us what the card does but nothing about how it ever
 * becomes attached, and compiling it would produce a permanent that sits on the
 * battlefield doing nothing — precisely the "looks implemented, isn't" failure the
 * compiler exists to prevent.
 */
function assembleAttachment(assembly: Assembly): AttachmentSpec | undefined {
  if (!assembly.attachesAs) return undefined;
  return {
    ...assembly.attachesAs,
    ...(assembly.attachmentModifies ? { modifies: assembly.attachmentModifies } : {}),
  };
}

/** Whether an ability watches the permanent its source is ATTACHED TO. */
function watchesTheHost(ability: TriggeredAbility): boolean {
  return ability.condition.watches === 'attachedHost';
}

/**
 * Compile a body printed as ONE sentence joined by the word "and" - "you lose 1
 * life **and** create a 1/1 black Faerie Rogue creature token with flying".
 *
 * Tried only AFTER the whole body and the sentence split have both failed, so
 * nothing that compiles today compiles differently.
 *
 * **Splitting on a word cannot invent a card here, and that is the whole safety
 * argument:** a split is accepted only when the left half is a complete rule AND
 * the right half compiles in turn, so a cut in the wrong place simply fails.
 * "create a 1/1 **blue and black** Faerie creature token" is exactly that case -
 * cutting at that "and" leaves "create a 1/1 blue", which matches no rule, so
 * the cut is abandoned and the earlier one ("you lose 1 life" / "create a 1/1
 * blue and black Faerie creature token with flying") is the one that stands.
 *
 * Left-to-right and recursive, so "A and B and C" is handled by the same walk,
 * and the first split whose halves BOTH compile wins.
 */
function compileConjunction(
  clause: string,
  ctx: RuleContext,
): NonNullable<ReturnType<typeof applyRules>>[] | null {
  const CONJUNCTION = ' and ';
  let at = clause.indexOf(CONJUNCTION);
  while (at >= 0) {
    const left = applyRules(EFFECT_RULES, clause.slice(0, at).trim(), ctx);
    if (left) {
      const rest = clause.slice(at + CONJUNCTION.length).trim();
      const whole = applyRules(EFFECT_RULES, rest, ctx);
      const right = whole ? [whole] : compileConjunction(rest, ctx);
      if (right) return [left, ...right];
    }
    at = clause.indexOf(CONJUNCTION, at + CONJUNCTION.length);
  }
  return null;
}

/**
 * Compile an activated ability line — the printed `COST: EFFECT` shape.
 *
 * The cost half is parsed here (it is a small closed vocabulary of symbols and
 * stock phrases), while the effect half goes through the ordinary effect rules,
 * so an activated ability can only do things the engine already implements. If
 * either half is not fully understood the whole line is left unmatched and gets
 * reported in `missing` — the compiler never ships an ability with a cost it
 * silently dropped, which would make the card strictly better than printed.
 *
 * Returns true when the line was consumed.
 */
function compileActivatedAbility(clause: string, assembly: Assembly, ctx: RuleContext): boolean {
  const split = splitCostAndEffect(clause);
  if (!split) return false;

  const cost = parseActivationCost(split.cost, ctx);
  if (!cost) return false;

  // "**Activate only as a sorcery**" (Orthion, Whip of Erebos, The Jolly Balloon
  // Man) — a TIMING restriction printed as the last sentence of the EFFECT half,
  // which is why the cost parser never saw it. Stripped here and turned into
  // core's `timing: 'sorcery'`, the same field a loyalty ability carries and the
  // same one `applyActivateAbility` already enforces.
  //
  // ⚠️ Stripped only when it is the trailing sentence and only for the SORCERY
  // wording. "Activate only if …" and "Activate only during …" are conditions
  // this engine cannot check, and they stay reported: an ability whose
  // restriction was dropped is activatable in windows the printed one is not.
  const sorceryOnly = SORCERY_SPEED_ONLY.exec(split.effect);
  const effectText = sorceryOnly ? split.effect.slice(0, sorceryOnly.index).trim() : split.effect;

  const effects = ctx.compileEffectClause(effectText);
  if (!effects || effects.length === 0) return false;

  assembly.activated.push({
    cost,
    effects,
    // Printed activated abilities are instant-speed unless they say otherwise —
    // and the one wording that says otherwise is stripped above.
    ...(sorceryOnly ? { timing: 'sorcery' as const } : {}),
    label: capitalizeFirst(split.raw),
  });
  assembly.matchedRules.push('activated-ability');
  return true;
}

/**
 * "Activate only as a sorcery", as the trailing sentence of an activated
 * ability's effect half. Anchored to the end so it cannot swallow a body, and
 * deliberately NOT matching "activate only if …" / "activate only during …",
 * which are conditions this engine cannot check and must keep reporting.
 */
const SORCERY_SPEED_ONLY = /\.\s*activate only as a sorcery\.?$/;

/**
 * Split `COST: EFFECT` on the FIRST colon, rejecting lines whose colon is not an
 * activation cost separator (a loyalty ability's `+2:`, a reminder-text colon).
 */
function splitCostAndEffect(
  clause: string,
): { cost: string; effect: string; raw: string } | null {
  const colon = clause.indexOf(':');
  if (colon <= 0) return null;
  const cost = clause.slice(0, colon).trim();
  const effect = clause.slice(colon + 1).trim();
  if (cost.length === 0 || effect.length === 0) return null;
  // Planeswalker loyalty costs are their own system and must stay reported.
  if (/^[+−-]?\d+$/.test(cost)) return null;
  return { cost, effect, raw: clause };
}

/**
 * A planeswalker loyalty-ability line: `+1: BODY`, `−2: BODY`, `0: BODY`. The
 * printed minus is U+2212 (`−`); a plain hyphen is accepted for hand-typed text.
 */
const LOYALTY_LINE = /^([+−-]?\d+): (.+)$/;

/**
 * Compile a loyalty ability into an activated ability with a SIGNED loyalty
 * cost, sorcery-speed — which, with the engine's once-per-turn rule keyed on the
 * cost kind, is exactly what CR 606 makes a loyalty ability. The body goes
 * through the ordinary effect rules (targets and questions included), so a
 * walker can only print abilities the engine genuinely runs; any body without a
 * faithful implementation leaves the line unmatched and reported.
 *
 * Only planeswalkers get this reading: on anything else a leading `+2:` is not
 * a loyalty cost, and the line falls through to the normal tables. Returns true
 * when the line was consumed.
 */
function compileLoyaltyAbility(clause: string, assembly: Assembly, ctx: RuleContext): boolean {
  if (!ctx.card.typeLine.types.some((printed) => printed.toLowerCase() === 'planeswalker')) return false;
  const match = LOYALTY_LINE.exec(clause);
  if (!match) return false;
  const value = Number.parseInt(match[1]!.replace('−', '-'), 10);
  if (!Number.isFinite(value)) return false;
  const effects = ctx.compileEffectClause(match[2]!);
  if (!effects || effects.length === 0) return false;
  assembly.activated.push({
    cost: { loyalty: value },
    effects,
    timing: 'sorcery',
    label: capitalizeFirst(clause),
  });
  assembly.matchedRules.push('loyalty-ability');
  return true;
}

/** A cost component the parser understands, as printed. */
const TAP_SYMBOL = '{t}';
/** "Pay N life" / "pay 1 life". */
const PAY_LIFE = /^pay (\d+) life$/;
/** "Sacrifice ~" — only sacrificing the ability's own source is supported. */
const SACRIFICE_SELF = /^sacrifice ~$/;

/**
 * "Sacrifice a creature" / "Sacrifice ANOTHER creature" / "Sacrifice a
 * Treasure" — an additional activation cost naming some OTHER permanent. The
 * noun itself is looked up in the shared {@link COST_NOUNS} table.
 */
const SACRIFICE_ANOTHER = new RegExp(`^sacrifice (a|an|another) (${COST_NOUN_PHRASE})$`);
/** A mana symbol run, e.g. `{1}{g}` or `{u}`. */
const MANA_SYMBOLS = /^(?:\{[^}]+\})+$/;

/**
 * Parse an activation cost into the engine's `ActivationCost`, or `null` when
 * any component is one we cannot pay faithfully.
 */
function parseActivationCost(text: string, ctx: RuleContext): ActivationCost | null {
  const cost: {
    mana?: ManaCost;
    tap?: boolean;
    sacrificeSelf?: boolean;
    sacrificeAnother?: CardFilter;
    sacrificeExcludesSelf?: boolean;
    life?: number;
  } = {};

  for (const partRaw of text.split(',')) {
    const part = partRaw.trim();
    if (part.length === 0) continue;

    if (part === TAP_SYMBOL) {
      cost.tap = true;
      continue;
    }
    const life = PAY_LIFE.exec(part);
    if (life) {
      cost.life = Number.parseInt(life[1]!, 10);
      continue;
    }
    if (SACRIFICE_SELF.test(part) || part === `sacrifice ${ctx.card.name.toLowerCase()}`) {
      cost.sacrificeSelf = true;
      continue;
    }
    // "Sacrifice a creature" / "Sacrifice another creature" / "Sacrifice a
    // Treasure" — the SAME closed noun table the mana-ability costs read, so a
    // noun means one thing across every cost parser in the compiler.
    //
    // ⚠️ Only a count of ONE is accepted. The action carries a list, and the
    // engine could charge two, but the OFFER path enumerates a single payer —
    // so "Sacrifice two artifacts" would silently narrow the player's choice to
    // the first legal pair. Refusing keeps that card reported until the menu
    // can express it.
    const sacrificeOther = SACRIFICE_ANOTHER.exec(part);
    if (sacrificeOther) {
      const filter = COST_NOUNS[(sacrificeOther[2] ?? '').trim()];
      if (!filter) return null;
      cost.sacrificeAnother = filter;
      if (sacrificeOther[1] === 'another') cost.sacrificeExcludesSelf = true;
      continue;
    }
    if (MANA_SYMBOLS.test(part)) {
      const mana = parseManaSymbols(part);
      if (!mana) return null; // a symbol we cannot pay (hybrid, {X}, Phyrexian)
      cost.mana = mana;
      continue;
    }
    return null; // an unrecognised cost component — report the whole line
  }

  return Object.keys(cost).length > 0 ? (cost as ActivationCost) : null;
}

/** Capitalize the first character, for a readable ability label. */
function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * Compile a keyword-only ability line ("Flying", "Trample, haste", "Prowess").
 * Returns false when any listed keyword has no faithful implementation, so the
 * line is reported rather than silently dropping an ability.
 */
function compileKeywordLine(line: string, assembly: Assembly, ctx: RuleContext): boolean {
  // Oracle separates keywords with a comma, EXCEPT where one of them carries a
  // comma of its own — then the whole line switches to semicolons ("Flying;
  // trample; rampage 4", "Trample; haste; shroud"). Thirty printed cards use
  // the semicolon form, and every one of them was reported as an unmodelled
  // "Flying" until both separators were read.
  // The comma split also breaks a multi-quality protection line apart
  // ("protection from Vampires, from Werewolves, and from Zombies" — Elite
  // Inquisitor); `joinPayloadKeywords` hands the fragments back to the
  // protection phrase before them, as the grant parser already does.
  const words = joinPayloadKeywords(
    line
      .split(/[,;]/)
      .map((word) => normalizeClause(word))
      .filter((word) => word.length > 0),
  );
  if (words.length === 0) return false;

  let flags: KeywordFlags = {};
  for (const word of words) {
    const field = KEYWORD_FLAGS[word];
    if (field) {
      flags = mergeKeywordGrant(flags, { [field]: true });
      continue;
    }
    // The payload keywords - `Ward {N}`, `Protection from ...` and `Toxic N`
    // (§3.105) - are not boolean flags, so they parse through their own closed
    // tables. A form outside them ("Ward-Pay 3 life") falls through and
    // reports the line.
    const special = parsePayloadKeyword(word);
    if (special) {
      flags = mergeKeywordGrant(flags, special);
      continue;
    }
    // A keyword with a real primitive-built implementation, either as a direct
    // contribution (persist) or by compiling its printed meaning through the
    // ordinary trigger rules (prowess).
    const builder = KEYWORD_ABILITY_BUILDERS[word];
    if (builder) {
      absorb(assembly, builder(), `keyword:${word}`);
      continue;
    }
    const expansion = KEYWORD_ABILITY_TEXT[word];
    if (expansion) {
      const result = applyRules(TRIGGER_RULES, expansion, ctx);
      if (!result) return false;
      absorb(assembly, result.contribution, `keyword:${word}`);
      continue;
    }
    // A PARAMETRISED keyword inside a list ("trample; rampage 2", "haste,
    // bushido 1") — the pattern rules that compile it as a whole line
    // (`keyword-bushido`, `keyword-rampage`) are tried on the one word, so a
    // list is compiled exactly as its members would be alone (DESIGN §3.107).
    // A word no rule matches still returns false and reports the line.
    const parametrised = applyRules(TRIGGER_RULES, word, ctx);
    if (parametrised && parametrised.ruleId.startsWith('keyword-')) {
      absorb(assembly, parametrised.contribution, parametrised.ruleId);
      continue;
    }
    return false; // not a keyword we model — report the line
  }
  if (Object.keys(flags).length > 0) {
    assembly.keywords = mergeKeywordGrant(assembly.keywords, flags);
    assembly.matchedRules.push('keyword-flags');
  }
  return true;
}

/**
 * Compile one printed ability line. Order matters: triggers and mana abilities
 * are whole-line shapes; a spell's script may be one clause or several
 * sentences. A permanent's bare sentence is NOT treated as an effect — that
 * would be a static ability the engine does not model — so it is reported.
 */
function compileAbilityLine(
  rawLine: string,
  assembly: Assembly,
  ctx: RuleContext,
  isSpell: boolean,
): void {
  // Drop vacuously-satisfied riders first ("They can't be regenerated"), so a
  // fully-implementable ability isn't reported over a sentence that cannot
  // change anything in this engine.
  const kept = splitSentences(rawLine).filter(
    (sentence) => !isVacuousClause(normalizeClause(sentence)),
  );
  const line = kept.length > 0 ? kept.join(' ') : '';
  if (line.trim().length === 0) return;

  const clause = normalizeClause(line);
  if (clause.length === 0) return;

  const trigger = applyRules(TRIGGER_RULES, clause, ctx);
  if (trigger) {
    absorb(assembly, trigger.contribution, trigger.ruleId);
    return;
  }

  const mana = applyRules(MANA_RULES, clause, ctx);
  if (mana) {
    absorb(assembly, mana.contribution, mana.ruleId);
    return;
  }

  // Card-level static properties ("~ enters tapped").
  const staticRule = applyRules(STATIC_RULES, clause, ctx);
  if (staticRule) {
    absorb(assembly, staticRule.contribution, staticRule.ruleId);
    return;
  }

  // A planeswalker's loyalty ability: "+1: EFFECT" / "−2: EFFECT". Tried before
  // the generic activated-ability parser, whose cost vocabulary deliberately
  // refuses a bare number.
  if (compileLoyaltyAbility(clause, assembly, ctx)) return;

  // An activated ability: "COST: EFFECT". Handled before the effect rules so the
  // cost is never mistaken for part of the effect text.
  if (compileActivatedAbility(clause, assembly, ctx)) return;

  if (isSpell) {
    // Whole-line first (compound idioms like "…deals 3 damage… You gain 3 life"),
    // then sentence-by-sentence for plain sequences of effects.
    const whole = applyRules(EFFECT_RULES, clause, ctx);
    if (whole) {
      absorb(assembly, whole.contribution, whole.ruleId);
      return;
    }
    const sentences = splitSentences(line).map(normalizeClause);
    if (sentences.length > 1) {
      const results = sentences.map((sentence) => applyRules(EFFECT_RULES, sentence, ctx));
      if (results.every((result) => result !== null)) {
        for (const result of results) absorb(assembly, result!.contribution, result!.ruleId);
        return;
      }
    }
    // ONE printed sentence joining two clauses the table already implements —
    // "Draw two cards and create two Treasure tokens" (Big Score). The SAME
    // helper a trigger body uses (`compileConjunction`), so "A and B" cannot
    // mean one thing inside a trigger and another on a spell's own line.
    const joined = compileConjunction(clause, ctx);
    if (joined) {
      for (const part of joined) absorb(assembly, part.contribution, part.ruleId);
      return;
    }
  }

  // Keyword-only lines ("Flying", "First strike, lifelink", "Prowess").
  if (compileKeywordLine(line, assembly, ctx)) return;

  assembly.missing.push({ text: line.trim(), missingEngineSystem: explainUnsupported(clause) });
}

/**
 * Compile a normalized Scryfall card into an engine definition.
 *
 * @param card A card record (a `NormalizedCard` from `@jonny-boi/data-tools`
 *   satisfies the required shape structurally).
 * @returns The definition plus an honest completeness verdict — see
 *   {@link CompileResult}. Never throws: a malformed record yields an
 *   `'incomplete'` result explaining what was wrong.
 */
/**
 * An empty {@link Assembly}. One constructor, because the quoted-ability
 * compiler (`RuleContext.compileQuotedAbility`) needs a scratch one and a
 * second literal is a second thing to keep in step.
 */
function newAssembly(): Assembly {
  return {
    effects: [],
    triggers: [],
    produces: [],
    producesOptions: [],
    manaAbilities: [],
    activated: [],
    statics: [],
    replacements: [],
    keywords: {},
    cycling: [],
    entersWithCounters: [],
    entersTapped: false,
    matchedRules: [],
    missing: [],
  };
}

export function compileCard(card: CompilableCard): CompileResult {
  // A TRANSFORMING double-faced card is compiled as two linked faces — see
  // `compileTransformDfc`. Detected by Scryfall's `layout` when the record
  // carries it, else by the `Transform` keyword Scryfall stamps on every
  // transforming DFC (the committed index predates the layout field). Other
  // multi-faced layouts (modal DFC, split, adventure) fall through: their
  // second face is CASTABLE, which needs the cast-time face choice the engine
  // does not have, and they are reported as exactly that below.
  // A SIEGE is a transforming layout by Scryfall's reckoning, but its back face
  // is CASTABLE - from exile, once the battle has been defeated - so it is
  // compiled by the second-half path, not the transform one.
  if (isSiege(card)) return compileSiege(card);
  if (isTransformDfc(card)) return compileTransformDfc(card);
  // A MODAL double-faced card is compiled as two linked faces too, but with the
  // opposite castability rule: BOTH halves are cast (or played) from hand, each
  // for its own cost. That is `backFaceCastable`, and it is the whole
  // difference between the two DFC layouts.
  if (isModalDfc(card)) return compileModalDfc(card);
  // A SPLIT card (CR 709) and an ADVENTURER card (CR 715) are one card with two
  // HALVES rather than two faces, and each half has its own cast path - see the
  // two compilers below for the difference that makes.
  if (isSplitLayout(card)) return compileSplitCard(card);
  if (isAdventureLayout(card)) return compileAdventure(card);

  const assembly: Assembly = newAssembly();

  // --- type line -------------------------------------------------------------
  // SUPERTYPES were parsed but never read until the legend rule needed one.
  // Two of them now carry engine meaning: **Legendary** (CR 704.5j) and
  // **Basic**, which the battlelands' "unless you control two or more basic
  // lands" counts and which no other characteristic can answer (a nonbasic dual
  // prints the same land subtypes as two basics). "Snow" still has none — no
  // card in reach cares — so it is ignored rather than reported, which changes
  // nothing a game could observe.
  const supertypes = card.typeLine.supertypes.map((printed) => printed.toLowerCase());
  const isLegendary = supertypes.includes('legendary');
  const isBasic = supertypes.includes('basic');
  const types: CardType[] = [];
  for (const printed of card.typeLine.types) {
    const key = printed.toLowerCase();
    const mapped = TYPE_MAP[key];
    const noSystem = TYPES_WITHOUT_SYSTEM[key];
    if (noSystem) {
      assembly.missing.push({ text: printed, missingEngineSystem: noSystem });
    }
    if (mapped) {
      types.push(mapped);
    } else if (!noSystem) {
      // A card type core has no representation for at all (e.g. Battle, Kindred).
      assembly.missing.push({
        text: printed,
        missingEngineSystem: `the "${printed}" card type`,
      });
    }
  }
  // A Kindred card that prints NOTHING else is not a card this engine (or the
  // rules) can play: CR 308.1 requires a second card type, and the second one is
  // what decides the zone, the timing and the stack behaviour. Reported rather
  // than played as a typeless object.
  if (types.length === 0 || (types.length === 1 && types[0] === KINDRED_TYPE)) {
    assembly.missing.push({
      text: `${card.typeLine.types.join(' ') || '(no type line)'}`,
      missingEngineSystem: 'a card type the engine can represent',
    });
  }

  // A card whose NAME names two halves but which reached this far is one the
  // compiler could not route to a half-aware path above: a layout it does not
  // know (meld, flip), or a record carrying the combined name with no per-face
  // data to compile. Reported rather than played as its first half only, which
  // would be a strictly weaker card than the one printed.
  if (card.name.includes(' // ')) {
    assembly.missing.push({
      text: card.name,
      missingEngineSystem: SECOND_CASTABLE_FACE_GAP,
    });
  }

  // --- mana cost -------------------------------------------------------------
  // Colour/colour hybrid symbols are payable (the mana system tries each
  // assignment) and `{X}` is payable now too — its value is a cast-time choice
  // the engine charges (`CardDefinition.xCost`). What remains in `other` —
  // Phyrexian, monocolour hybrid, snow — genuinely cannot be paid, and a card
  // we would mis-cost is never complete.
  const { hybrid, xCount, unpayable } = partitionOtherSymbols(card.manaCost.other);
  if (unpayable.length > 0) {
    assembly.missing.push({
      text: unpayable.map((symbol) => `{${symbol}}`).join(''),
      missingEngineSystem: 'Phyrexian and monocolour hybrid mana costs',
    });
  }
  const cost = toCoreCost(card, hybrid);
  // §3.106 — a NONLAND card with no printed mana cost (CR 202.1b) is marked
  // so the engine refuses to cast it by paying nothing. `toCoreCost` folds
  // `{0}` and "no cost" into the same `undefined`, which is right for the
  // pool's `{0}` cards and wrong for Ancestral Vision; the parse keeps the
  // difference and this is where it lands on the definition.
  const noManaCost = card.manaCost.absent === true && !types.includes('land');

  const isCreatureCard = types.includes('creature');

  // --- planeswalkers: printed starting loyalty --------------------------------
  // A walker without a usable loyalty number cannot enter at the right value, so
  // it is never complete — whether the printed box is variable (`X`, parsed to
  // null) or the record simply predates loyalty capture in the data pipeline.
  const isWalkerCard = types.includes('planeswalker');
  const printedLoyalty =
    typeof card.loyalty === 'number' && Number.isFinite(card.loyalty) && card.loyalty > 0
      ? card.loyalty
      : undefined;
  if (isWalkerCard && printedLoyalty === undefined) {
    assembly.missing.push({
      text: 'loyalty',
      missingEngineSystem:
        'a printed starting-loyalty number in the card record (variable/X loyalty, or a cached record from before loyalty was captured)',
    });
  }

  // --- battles: printed starting defense --------------------------------------
  // The same contract, for the same reason: a battle that entered with the wrong
  // number of defense counters would take the wrong number of attacks to defeat,
  // which is a different card. No number in the record ⇒ reported, never guessed.
  const isBattleCard = types.includes('battle');
  const printedDefense =
    typeof card.defense === 'number' && Number.isFinite(card.defense) && card.defense > 0
      ? card.defense
      : undefined;
  if (isBattleCard && printedDefense === undefined) {
    assembly.missing.push({
      text: 'defense',
      missingEngineSystem:
        'a printed starting-defense number in the card record (variable defense, or a cached record from before defense was captured)',
    });
  }

  // --- lands: basic land types produce their mana without any printed text ----
  //
  // Rule 305.6: EACH basic land type is its own "{T}: Add {X}" ability, so a
  // land with two of them (a shockland's Swamp Mountain, a true dual) offers a
  // CHOICE of one mana per tap — `producesOptions` — not a bundle. Pushing both
  // into `produces` would make one tap add both colours, the exact "Birds taps
  // for five" bug the compiler was built to refuse. A single basic type stays
  // the plain fixed bundle it always was.
  {
    const landColors: ManaColor[] = [];
    for (const subtype of card.typeLine.subtypes) {
      const color = LAND_SUBTYPE_MANA[subtype.toLowerCase()];
      if (color && types.includes('land')) {
        landColors.push(color);
        assembly.matchedRules.push('basic-land-type');
      }
    }
    if (landColors.length === 1) assembly.produces.push(landColors[0]!);
    else if (landColors.length > 1) {
      assembly.producesOptions.push(...landColors.map((color) => ({ [color]: 1 }) as ManaProduction));
    }
  }

  // --- printed abilities -----------------------------------------------------
  const isSpell = types.includes('instant') || types.includes('sorcery');
  /**
   * Record an INNER rule match — one matched inside a trigger body, a modal
   * bullet or a nested clause. Without this `matchedRules` lists only the
   * outer line's rule, so a rule that exists to compile a BODY (every
   * "…, draw a card" tail) reads as dead to anything inspecting coverage. The
   * list is a set-like append: duplicates are dropped so a card printing the
   * same body twice is not double-counted.
   */
  const noteInner = (ruleId: string | undefined): void => {
    if (ruleId !== undefined && !assembly.matchedRules.includes(ruleId)) {
      assembly.matchedRules.push(ruleId);
    }
  };
  const ctx: RuleContext = {
    card,
    compileEffectClause(
      text: string,
      options?: { readonly targetFree?: boolean },
    ): readonly EffectRef[] | null {
      const targetFree = options?.targetFree === true;
      const clause = normalizeClause(text);
      const whole = applyRules(EFFECT_RULES, clause, ctx, targetFree);
      if (whole) {
        noteInner(whole.ruleId);
        return whole.contribution.effects ?? [];
      }
      // A multi-sentence trigger body: every sentence must compile.
      const sentences = splitSentences(text).map(normalizeClause);
      if (sentences.length > 1) {
        const refs: EffectRef[] = [];
        for (const sentence of sentences) {
          const result = applyRules(EFFECT_RULES, sentence, ctx, targetFree);
          if (!result) return null;
          noteInner(result.ruleId);
          refs.push(...(result.contribution.effects ?? []));
        }
        return refs;
      }
      // Same conjunction helper again — a nested clause ("you may sacrifice a
      // land. If you do, <A and B>") reads "and" exactly as the outer line does.
      const joined = compileConjunction(clause, ctx);
      if (joined) {
        const refs: EffectRef[] = [];
        for (const part of joined) {
          noteInner(part.ruleId);
          refs.push(...(part.contribution.effects ?? []));
        }
        return refs;
      }
      return null;
    },
    compileQuotedAbility(text: string): ActivatedAbility | null {
      // A SCRATCH assembly: `compileActivatedAbility` pushes into whatever it
      // is handed, so borrowing it here costs one throwaway object and keeps
      // ONE parser for printed and granted abilities alike. Anything it also
      // records (its `matchedRules` entry) is carried over deliberately, so
      // coverage tooling still sees that the ability parser ran.
      const scratch = newAssembly();
      if (!compileActivatedAbility(normalizeClause(text), scratch, ctx)) return null;
      if (scratch.activated.length !== 1) return null;
      for (const id of scratch.matchedRules) {
        if (!assembly.matchedRules.includes(id)) assembly.matchedRules.push(id);
      }
      return scratch.activated[0] ?? null;
    },
    compileTriggerBody(text: string): TriggerBodyResult | null {
      // Compiled WITH targeting allowed (core aims a trigger as it goes on the
      // stack now), so what this has to work out is what may be aimed at.
      const clauses = [normalizeClause(text)];
      const whole = applyRules(EFFECT_RULES, clauses[0]!, ctx);
      noteInner(whole?.ruleId);
      // A "Choose one —" body IS a ModalSpec, not an effect list: hand it up so
      // the trigger assembly can put it on the ability (CR 603.3c). TARGETED
      // modes are accepted only on a CHOOSE-ONE spec: with exactly one pick,
      // the chosen mode's aim can ride the trigger's single target list, and a
      // mode with no legal target is simply not offered (CR 603.3d). A wider
      // spec with a targeted mode would need per-pick aims the trigger stack
      // object cannot carry yet — those cards stay reported.
      if (whole?.contribution.modal !== undefined) {
        const spec = whole.contribution.modal;
        const hasTargetedMode = spec.modes.some((mode) => mode.targets !== undefined);
        if (hasTargetedMode && (spec.max !== 1 || spec.allowRepeats === true)) return null;
        return { effects: [], modal: spec };
      }
      const matched = whole ? [whole] : null;
      const parts =
        matched ??
        (() => {
          const sentences = splitSentences(text).map(normalizeClause);
          if (sentences.length <= 1) return null;
          const out: NonNullable<ReturnType<typeof applyRules>>[] = [];
          for (const sentence of sentences) {
            const result = applyRules(EFFECT_RULES, sentence, ctx);
            if (!result) return null;
            noteInner(result.ruleId);
            out.push(result);
          }
          return out;
        })() ??
        // A body printed as ONE sentence joined by "and" - "you lose 1 life AND
        // create a 1/1 black Faerie Rogue creature token with flying"
        // (Bitterblossom). See {@link compileConjunction} for why splitting on a
        // word cannot invent a card here.
        compileConjunction(clauses[0]!, ctx);
      if (!parts) return null;

      const refs: EffectRef[] = [];
      let restriction: TargetRestriction | undefined;
      let excludeSelf = false;
      let upToCount: number | undefined;
      let targetingParts = 0;
      for (const part of parts) {
        const partEffects = part.contribution.effects ?? [];
        refs.push(...partEffects);
        // A part targets when its RULE says so — or when its effects DECLARE a
        // restriction even though the rule is unflagged. The second arm exists
        // for `create-token-copy`: its selectors include self-referential forms
        // that target nothing, so the rule cannot carry the flag, but "a copy of
        // another target nonland permanent you control" declares its restriction
        // in the ref and must be aimed like any other targeted body.
        const declared = restrictionOfEffects(partEffects);
        if (!ruleNeedsChosenTarget(part.ruleId) && declared === undefined) continue;
        targetingParts += 1;
        // `restrictionOfEffects` deliberately reports nothing for the default
        // "any target" (core does not police it), but a trigger still has to be
        // AIMED at something — so the default is what "any target" means.
        restriction = declared ?? DEFAULT_TARGET_RESTRICTION;
        // A printed "ANOTHER target …" rides the effect ref as `excludeSelf` and
        // is lifted onto the ABILITY here, because the ability is what gets
        // aimed — the aiming pass reads `targetsExcludeSelf` when it builds the
        // candidate menu, and a flag left on the ref alone would exclude nothing.
        excludeSelf = partEffects.some((ref) => ref.params?.excludeSelf === true);
        // A printed "UP TO N target …" rides the effect ref as `upToTargets`
        // and is lifted onto the ability the same way: the aiming pass reads
        // `targetCount` when it collects the chosen targets, and a number left
        // on the ref alone would clamp nothing.
        for (const ref of partEffects) {
          const upTo = ref.params?.upToTargets;
          if (typeof upTo === 'number' && Number.isFinite(upTo) && upTo > 0) {
            upToCount = upTo;
          }
        }
      }
      // Two targets in one trigger is a template of its own; refusing keeps the
      // card reported rather than silently aiming both halves at one object.
      if (targetingParts > 1) return null;
      if (refs.length === 0) return null;
      if (restriction === undefined) return { effects: refs };
      return {
        effects: refs,
        targets: restriction,
        ...(excludeSelf ? { targetsExcludeSelf: true } : {}),
        ...(upToCount !== undefined ? { targetCount: { min: 0, max: upToCount } } : {}),
      };
    },
  };

  for (const line of prepareOracle(card.oracleText, card.name)) {
    compileAbilityLine(line, assembly, ctx, isSpell);
  }

  // --- power / toughness -----------------------------------------------------
  // Checked AFTER the ability lines, because the answer depends on them: a `*`
  // box (Scryfall parses it to null) is faithful exactly when some line
  // compiled the FORMULA that defines it. The blanket refusal this replaces
  // reported every such card; the refusal itself is kept for every card whose
  // defining sentence the rule table cannot express, which is the honest half —
  // a formula we cannot reproduce must be named, never approximated.
  if (isCreatureCard && (card.power === null || card.toughness === null)) {
    if (assembly.characteristicPT === undefined) {
      assembly.missing.push({
        text: 'power/toughness',
        missingEngineSystem:
          'a characteristic-defining P/T formula the compiler does not recognize yet (the star box is supported; this card defines it by a rule outside the closed count vocabulary)',
      });
    }
  } else if (assembly.characteristicPT !== undefined) {
    // A card printing NUMBERS and a defining sentence would be two answers to
    // one question. No real card does it; refusing keeps the invariant that
    // `characteristicPT` and printed P/T never coexist.
    assembly.missing.push({
      text: 'power/toughness',
      missingEngineSystem: 'a card printing both a fixed P/T and a characteristic-defining formula',
    });
  }

  // --- keyword flags printed on the type line but not in the text ------------
  // Scryfall lists a card's keywords separately; anything it lists that we did
  // not already pick up from the text must still be modelled or reported.
  const primitivesCompiled = compiledPrimitives(assembly);
  for (const keyword of card.keywords) {
    const word = keyword.toLowerCase();
    const field = KEYWORD_FLAGS[word];
    if (field) {
      assembly.keywords = { ...assembly.keywords, [field]: true };
      continue;
    }
    // Keywords with a real implementation are compiled from the printed line
    // (prowess via its template, persist via a direct builder) — Scryfall
    // listing them again is not a second, unmodelled ability.
    if (KEYWORD_ABILITY_TEXT[word] || KEYWORD_ABILITY_BUILDERS[word]) continue;
    // Scryfall lists ward, protection and toxic by their bare names; the
    // printed line carries the payload ("Ward {2}", "Protection from red",
    // "Toxic 1") and has already compiled it into the keyword FIELD the table
    // names - or already reported the line, in which case the missing-scan
    // below still refuses a duplicate entry (see PAYLOAD_KEYWORD_EVIDENCE).
    const payloadField = PAYLOAD_KEYWORD_EVIDENCE[word];
    if (payloadField !== undefined && assembly.keywords[payloadField] !== undefined) continue;
    // "Enchant" and "Equip" are Scryfall's names for the attachment ability the
    // card's own printed line already compiled (see `assembleAttachment`). Without
    // this, every Aura and Equipment would report its central ability as missing
    // one line after implementing it.
    if (ATTACHMENT_KEYWORDS.has(word) && assembly.attachesAs !== undefined) continue;
    // Same story for "Kicker": Scryfall lists it as a keyword, and the printed
    // "Kicker {COST}" line has already compiled into `CardDefinition.kicker`.
    if (word === 'kicker' && assembly.kicker !== undefined) continue;
    // Scryfall lists BOTH "Kicker" and "Multikicker" on a multikicker card (the
    // mechanic is a kicker), so a compiled multikicker answers for either name.
    if ((word === 'multikicker' || word === 'kicker') && assembly.multikicker !== undefined) continue;
    // "Modal" is not printed as an ability — it is the shape of the card, and
    // the "Choose one —" line has already compiled into `assembly.modal`.
    if (word === 'modal' && assembly.modal !== undefined) continue;
    // Same shape for "Flashback": the printed "Flashback {…}" line compiled into
    // `assembly.flashback`, and Scryfall listing the keyword again is not a
    // second, unmodelled ability. A flashback line that did NOT compile (an {X}
    // or additional-cost form) leaves `flashback` unset, so the keyword still
    // reports through the line's own `missing` entry.
    if (word === 'flashback' && assembly.flashback !== undefined) continue;
    // Scry / Surveil / Mill: modelled as effect primitives, so the evidence that
    // the printed line compiled is the primitive's presence in the assembled card
    // rather than a dedicated field. Same contract as the guards above — skip the
    // sweep entry ONLY when the line really was implemented; a wording the rules do
    // not match compiles no primitive and still reports through its own `missing`
    // entry (the scry/mill template hints).
    const backingPrimitive = PRIMITIVE_BACKED_KEYWORDS[word];
    if (
      backingPrimitive !== undefined &&
      (typeof backingPrimitive === 'string'
        ? primitivesCompiled.has(backingPrimitive)
        : backingPrimitive.some((primitive) => primitivesCompiled.has(primitive)))
    ) {
      continue;
    }
    // A keyword whose implementation IS a triggered ability: the evidence is a
    // compiled trigger labelled with the keyword (see TRIGGER_BACKED_KEYWORDS).
    if (
      TRIGGER_BACKED_KEYWORDS.has(word) &&
      assembly.triggers.some((t) => t.label?.toLowerCase().startsWith(word))
    ) {
      continue;
    }
    // §3.110 — a keyword whose implementation IS an activated ability (outlast):
    // the evidence is a compiled activation labelled with the keyword.
    if (
      ACTIVATED_BACKED_KEYWORDS.has(word) &&
      assembly.activated.some((a) => a.label.toLowerCase().startsWith(word))
    ) {
      continue;
    }
    // LANDWALK (DESIGN §3.107): "Landwalk", "Islandwalk", "Legendary landwalk"
    // are all answered by the compiled payload — see `isLandwalkKeyword`.
    if (isLandwalkKeyword(word) && assembly.keywords.landwalk !== undefined) continue;
    // Cycling and its typed variants: Scryfall lists "Cycling", "Typecycling"
    // and "Landcycling" as keywords, and the printed line has already compiled
    // into `assembly.cycling`. A cycling line that did NOT compile (an {X}
    // cycling cost, a cycling word this engine cannot search for) leaves the
    // list empty for that line, so the keyword still reports through the line's
    // own `missing` entry — which is why this is keyed on the list, not on the
    // keyword's presence.
    if (isCyclingKeyword(word) && assembly.cycling.length > 0) continue;
    // "Double" / "Triple" are Scryfall's keyword names for a DAMAGE-SCALING
    // REPLACEMENT ability ("it deals double that damage instead" — Gratuitous
    // Violence, Fiery Emancipation, Torbran's family). The printed line has
    // already compiled into `assembly.replacements`, and the keyword being
    // listed again is not a second, unmodelled ability. Same evidence-based
    // contract as the scry/mill guard above: the skip is keyed on a compiled
    // replacement that actually SCALES, so a card whose line the rule table did
    // not match compiles none and still reports through its own `missing` entry.
    if (SCALING_KEYWORDS.has(word) && assembly.replacements.some((r) => r.outcome.times !== undefined)) {
      continue;
    }
    // AFFINITY: Scryfall lists the keyword and the printed line carries the
    // whole rule in reminder text, which is stripped before the rule table sees
    // it. The compiled evidence is the per-permanent reduction the line built —
    // an affinity whose noun is outside the closed table compiles none and still
    // reports through its own missing entry.
    if (word === 'affinity' && assembly.castCostReductionPerPermanent !== undefined) continue;

    // CONVOKE / IMPROVISE / DELVE: the printed line carries the mechanic in
    // reminder text, which is stripped, so the compiled evidence is the assist
    // kind the line built. A card printing TWO of them compiles none and still
    // reports through its own missing entry.
    if (COST_ASSIST_KEYWORDS.has(word) && assembly.costAssist !== undefined) continue;
    if (word === 'buyback' && assembly.buyback !== undefined) continue;
    if (word === 'madness' && assembly.madness !== undefined) continue;
    // §3.111 — the graveyard-casting family: the evidence is a compiled
    // ability/cast OF THAT KIND (see the two tables), never the keyword's
    // presence. "Retrace" and "Jump-start" are builders and never reach here.
    const graveyardAbilityKind = GRAVEYARD_ABILITY_KEYWORDS[word];
    if (
      graveyardAbilityKind !== undefined &&
      assembly.graveyardAbilities?.some((ability) => ability.kind === graveyardAbilityKind) === true
    ) {
      continue;
    }
    const graveyardCastKind = GRAVEYARD_CAST_KEYWORDS[word];
    if (
      graveyardCastKind !== undefined &&
      assembly.graveyardCasts?.some((cast) => cast.kind === graveyardCastKind) === true
    ) {
      continue;
    }
    // §3.106 — same shape as madness: the printed "Suspend N—{…}" line compiled
    // into `assembly.suspend`; a "Suspend X" line leaves it unset and reports.
    if (word === 'suspend' && assembly.suspend !== undefined) continue;
    // §3.113 — storm / cascade / ripple: the evidence is a compiled CAST
    // TRIGGER tagged with the keyword. Keyed on the tag, not the label, so a
    // "Ripple 4" line that did not compile leaves no trigger and still reports.
    if (CAST_TRIGGER_KEYWORDS.has(word) && assembly.castTriggers?.some((t) => t.keyword === word)) continue;
    // An ABILITY WORD (Revolt, Morbid, …) is a label, not an ability — CR
    // 207.2c. It is skipped only when the line it labels actually compiled;
    // a line that failed put its own text (word included) into `missing`, so
    // the card still reports through that entry.
    if (
      ABILITY_WORDS.has(word) &&
      !assembly.missing.some((entry) => entry.text.toLowerCase().includes(word))
    ) {
      continue;
    }
    if (!assembly.missing.some((m) => m.text.toLowerCase().includes(word))) {
      assembly.missing.push({
        text: keyword,
        missingEngineSystem: `the "${keyword}" keyword ability`,
      });
    }
  }

  // --- attachments -----------------------------------------------------------
  const attachment = assembleAttachment(assembly);
  if (attachment === undefined && assembly.attachmentModifies !== undefined) {
    assembly.missing.push({
      text: 'enchanted/equipped creature gets …',
      missingEngineSystem: 'auras and equipment attachment (no "Enchant …" or "Equip {N}" line to attach it)',
    });
  }
  // The same argument, for the OTHER thing an attachment line can print. A
  // trigger that watches "equipped creature" fires on the permanent this one is
  // attached to — so on a card with no "Equip {N}"/"Enchant …" line it is
  // attached to nothing, forever, and can never fire. Reported for the same
  // reason a lone modification is: a permanent that sits there doing nothing is
  // the "looks implemented, isn't" failure this compiler exists to prevent.
  if (attachment === undefined && assembly.triggers.some(watchesTheHost)) {
    assembly.missing.push({
      text: 'whenever enchanted/equipped creature …',
      missingEngineSystem: 'auras and equipment attachment (no "Enchant …" or "Equip {N}" line to attach it)',
    });
  }

  // --- assemble --------------------------------------------------------------
  // Mana production has two authoring forms and a card uses exactly one of them:
  // a fixed bundle (`produces`, one tap adds all of it) or a list of modes
  // (`producesOptions`, one tap adds one). A card printing BOTH shapes has two
  // mana abilities, and since it can only be tapped once they are simply more
  // modes of the same choice — so the bundle folds in as one extra mode.
  const manaModes: readonly ManaProduction[] =
    assembly.producesOptions.length > 0
      ? [
          ...(assembly.produces.length > 0 ? [bundleAsMode(assembly.produces)] : []),
          ...assembly.producesOptions,
        ]
      : [];

  // A card that prints a RICH mana ability (a cost, a rider, an "Activate only
  // if …", derived colours) emits `manaAbilities` and NOTHING ELSE — core treats
  // that field as superseding both shorthands, so a plain line on the same card
  // ("{T}: Add {C}" on a pain land, the basic land types on a filter land) has to
  // come along as one more entry or it would vanish. It leads the list because it
  // is printed first on every real card of this shape.
  const richManaAbilities: readonly import('@jonny-boi/core').ManaAbility[] =
    assembly.manaAbilities.length > 0
      ? [
          ...(manaModes.length > 0
            ? [{ produces: manaModes }]
            : assembly.produces.length > 0
              ? [{ produces: [bundleAsMode(assembly.produces)] }]
              : []),
          ...assembly.manaAbilities,
        ]
      : [];

  /**
   * The card's resolution script, with the "As ~ enters, choose a…" NAMING
   * prepended when this permanent is one the engine cannot ask at play time.
   *
   * A LAND is played, not cast, so its script never runs at all — core's
   * `raiseLandEntryChoice` asks there instead, from the same `asEntersChoice`
   * declaration. Every other permanent resolves, so the naming is the first
   * thing its resolution does: the card is `ctx.source` and not yet on the
   * battlefield at that moment, which is exactly the printed timing (CR 614.1c),
   * the same moment "enters with N +1/+1 counters" applies.
   *
   * Prepended HERE rather than by the rule that matched the line, because the
   * printed naming can appear on any line (Realmwalker prints it second) and it
   * must run before every other effect regardless.
   */
  const entryScript: EffectRef[] =
    assembly.asEntersChoice !== undefined && !types.includes('land')
      ? [{ primitive: AS_ENTERS_PRIMITIVE, params: {} }, ...assembly.effects]
      : assembly.effects;

  const definition: CardDefinition = {
    id: card.id,
    // A double-faced card is played as its front face; the back is a separate
    // face the engine cannot transform into (reported in `missing` above).
    name: frontFaceName(card.name),
    types,
    ...(cost ? { cost } : {}),
    ...(isCreatureCard && card.power !== null ? { power: card.power } : {}),
    ...(isCreatureCard && card.toughness !== null ? { toughness: card.toughness } : {}),
    // A `*` box: the FORMULA replaces the numbers (never both — refused above).
    ...(assembly.characteristicPT ? { characteristicPT: assembly.characteristicPT } : {}),
    ...(isWalkerCard && printedLoyalty !== undefined ? { loyalty: printedLoyalty } : {}),
    ...(isBattleCard && printedDefense !== undefined ? { defense: printedDefense } : {}),
    // The printed **Legendary** supertype, carried because the legend rule
    // (CR 704.5j) is keyed on exactly this — it is not decoration. Read from the
    // supertype list rather than from the raw type line so a card whose name
    // happens to contain the word is not mistaken for one.
    ...(isLegendary ? { legendary: true } : {}),
    // The printed **Basic** supertype — read by the battlelands' enters-untapped
    // condition (see `EntersUntappedCondition.minBasicLands`).
    ...(isBasic ? { basic: true } : {}),
    // Changeling is a characteristic-defining ability that applies in EVERY zone,
    // so it rides the definition rather than the keyword-flag bag.
    ...(assembly.changeling ? { changeling: true } : {}),
    // `[]` is meaningful and distinct from the field being absent: it says
    // "printed colourless" where absent says "read my pips" (see
    // `CardDefinition.colors`). Devoid is the only thing that sets it today.
    ...(assembly.colorless ? { colors: [] } : {}),
    ...(assembly.cantBeCountered ? { cantBeCountered: true } : {}),
    ...(assembly.spellsCantBeCountered ? { spellsCantBeCountered: assembly.spellsCantBeCountered } : {}),
    ...(assembly.noMaximumHandSize ? { noMaximumHandSize: true } : {}),
    ...(assembly.playLandsFrom && assembly.playLandsFrom.length > 0
      ? { playLandsFrom: assembly.playLandsFrom }
      : {}),
    ...(Object.keys(assembly.keywords).length > 0 ? { keywords: assembly.keywords } : {}),
    // Printed subtypes, lowercased, so subtype-selecting effects ("a Mountain
    // or Plains card") match a dual land the way the printed card does.
    ...(card.typeLine.subtypes.length > 0
      ? { subtypes: card.typeLine.subtypes.map((subtype) => subtype.toLowerCase()) }
      : {}),
    ...(assembly.entersTapped ? { entersTapped: true } : {}),
    ...(assembly.entersTappedUnless ? { entersTappedUnless: assembly.entersTappedUnless } : {}),
    ...(assembly.copyAsEnters !== undefined ? { copyAsEnters: assembly.copyAsEnters } : {}),
    ...(assembly.entersTappedUnlessRevealed !== undefined
      ? { entersTappedUnlessRevealed: assembly.entersTappedUnlessRevealed }
      : {}),
    ...(assembly.entersTappedUnlessLifePaid !== undefined
      ? { entersTappedUnlessLifePaid: assembly.entersTappedUnlessLifePaid }
      : {}),
    ...(assembly.additionalLandPlays !== undefined
      ? { additionalLandPlays: assembly.additionalLandPlays }
      : {}),
    ...(assembly.castCostReduction !== undefined ? { castCostReduction: assembly.castCostReduction } : {}),
    ...(assembly.castCostReductionPerPermanent !== undefined
      ? { castCostReductionPerPermanent: assembly.castCostReductionPerPermanent }
      : {}),
    ...(assembly.costAssist !== undefined ? { costAssist: assembly.costAssist } : {}),
    ...(assembly.asEntersChoice !== undefined ? { asEntersChoice: assembly.asEntersChoice } : {}),
    ...(assembly.isChosenSubtype ? { isChosenSubtype: true } : {}),
    ...(xCount > 0 ? { xCost: xCount } : {}),
    ...(assembly.kicker ? { kicker: assembly.kicker } : {}),
    ...(assembly.additionalCost ? { additionalCost: assembly.additionalCost } : {}),
    ...(assembly.multikicker ? { multikicker: assembly.multikicker } : {}),
    ...(assembly.modal ? { modal: assembly.modal } : {}),
    ...(assembly.cycling.length > 0 ? { cycling: assembly.cycling } : {}),
    ...(assembly.buyback ? { buyback: assembly.buyback } : {}),
    ...(assembly.madness ? { madness: assembly.madness } : {}),
    // §3.106
    ...(noManaCost ? { noManaCost: true } : {}),
    ...(assembly.suspend ? { suspend: assembly.suspend } : {}),
    // §3.113
    ...(assembly.castTriggers !== undefined && assembly.castTriggers.length > 0
      ? { castTriggers: assembly.castTriggers }
      : {}),
    ...(assembly.entersWithCounters.length > 0 ? { entersWithCounters: assembly.entersWithCounters } : {}),
    ...(assembly.flashback !== undefined ? { flashback: assembly.flashback } : {}),
    ...(assembly.flashbackXCost !== undefined ? { flashbackXCost: assembly.flashbackXCost } : {}),
    // §3.111
    ...(assembly.flashbackAdditionalCost !== undefined
      ? { flashbackAdditionalCost: assembly.flashbackAdditionalCost }
      : {}),
    ...(assembly.graveyardCasts !== undefined && assembly.graveyardCasts.length > 0
      ? { graveyardCasts: assembly.graveyardCasts }
      : {}),
    ...(assembly.graveyardAbilities !== undefined && assembly.graveyardAbilities.length > 0
      ? { graveyardAbilities: assembly.graveyardAbilities }
      : {}),
    ...(assembly.flashbackLifeCost !== undefined
      ? { flashbackLifeCost: assembly.flashbackLifeCost }
      : {}),
    ...(entryScript.length > 0 ? { effects: entryScript } : {}),
    ...(richManaAbilities.length > 0
      ? { manaAbilities: richManaAbilities }
      : manaModes.length > 0
        ? { producesOptions: manaModes }
        : assembly.produces.length > 0
          ? { produces: assembly.produces }
          : {}),
    ...(assembly.triggers.length > 0 ? { triggers: assembly.triggers } : {}),
    ...(assembly.activated.length > 0 ? { activated: assembly.activated } : {}),
    ...(assembly.statics.length > 0 ? { statics: assembly.statics } : {}),
    ...(assembly.replacements.length > 0 ? { replacements: assembly.replacements } : {}),
    ...(attachment ? { attachment } : {}),
  };

  return {
    status: assembly.missing.length === 0 ? 'complete' : 'incomplete',
    definition,
    matchedRules: assembly.matchedRules,
    missing: assembly.missing,
    // Present only when a clause was implemented by doing nothing (DESIGN
    // §3.107), so every other card's result is byte-for-byte what it was.
    ...(assembly.vacuous !== undefined ? { vacuous: assembly.vacuous } : {}),
  };
}

// --- transforming double-faced cards ---------------------------------------------

/**
 * What a two-halved card reports when the compiler cannot tell WHICH kind it is.
 *
 * The four printed shapes are all built now - split and aftermath (CR 709 /
 * 702.127), adventure (CR 715), Siege (CR 310.4) and the modal DFC that came
 * before them - and each is recognised by Scryfall's `layout` plus its face
 * data. What is left under this name is the residual: a record that carries a
 * combined `A // B` name with no per-face data to compile, or a multi-faced
 * layout with no cast path at all (meld, flip). Those are reported, never
 * played as their first half.
 */
export const SECOND_CASTABLE_FACE_GAP =
  'a two-halved card whose layout the compiler cannot read (split, aftermath, adventure, Siege and modal-DFC halves are all cast today; a meld or flip layout, or a record carrying only the combined name with no per-face data, is not)';

/**
 * FUSE (CR 702.102): "You may cast one or both halves of this card from your
 * hand" - a single spell that is BOTH halves at once, with a combined cost, a
 * combined script and a combined set of targets chosen at announcement.
 *
 * It is not the split-card cast path with an extra flag: everything downstream
 * of the announcement (one stack object carrying two effect lists, per-half
 * targets that must each still be legal on resolution) is a second shape of
 * spell. Reported by name rather than approximated as "cast the left half".
 */
export const FUSE_GAP =
  'the FUSE keyword (CR 702.102 - casting BOTH halves of a split card as one spell, with one combined cost and both scripts)';

/**
 * ROOMS (CR 714) share Scryfall's `split` layout and share nothing else: both
 * halves are Enchantment - Room, the card enters the battlefield as a permanent
 * with one door unlocked, and the other door is unlocked later by paying its
 * mana cost as a sorcery. That is a permanent with two independently-active
 * halves, not a card with two castable ones, so it is a different system and
 * says so rather than being played as an ordinary enchantment.
 */
export const ROOM_DOOR_GAP =
  'the Room / door system (CR 714 - a permanent with two doors, the second unlocked on the battlefield by paying its mana cost as a sorcery)';

/** The id suffix a compiled back-face definition carries (`<frontId>#back`). */
export const BACK_FACE_ID_SUFFIX = '#back';

/** Scryfall's layout value / keyword for Innistrad-style transforming DFCs. */
const TRANSFORM_LAYOUT = 'transform';
const TRANSFORM_KEYWORD = 'transform';

/** Scryfall's layout value for a Zendikar-Rising-style MODAL double-faced card. */
const MODAL_DFC_LAYOUT = 'modal_dfc';

/** The number of faces a transforming DFC prints — a front and a back. */
const DFC_FACE_COUNT = 2;

/**
 * Whether this record is a TRANSFORMING double-faced card (front castable, back
 * never castable, a transform instruction flips between them) — as opposed to a
 * modal DFC / split / adventure, whose second half is castable.
 */
function isTransformDfc(card: CompilableCard): boolean {
  if (!card.faces || card.faces.length !== DFC_FACE_COUNT) return false;
  if (card.layout !== undefined) return card.layout === TRANSFORM_LAYOUT;
  return card.keywords.some((keyword) => keyword.toLowerCase() === TRANSFORM_KEYWORD);
}

/**
 * Compile one face of a transforming DFC by wrapping it as an ordinary
 * single-faced record and running it through {@link compileCard} — the whole
 * rule table, the keyword sweep, the P/T checks, everything, applies to each
 * face with no second compiler.
 *
 * `keywords` is the subset of the card's Scryfall keywords attributable to this
 * face (see {@link compileTransformDfc} for how attribution works).
 */
function compileFace(
  face: NonNullable<CompilableCard['faces']>[number],
  id: string,
  keywords: readonly string[],
  extras?: { readonly oracleText?: string; readonly defense?: number | null; readonly loyalty?: number | null },
): CompileResult {
  return compileCard({
    id,
    name: face.name,
    manaCost: face.manaCost,
    typeLine: face.typeLine,
    // A caller may hand over TEXT it has already edited - the bare `Aftermath` /
    // `Fuse` keyword line a half prints once its parenthesised reminder has been
    // stripped, which is layout machinery rather than an ability. Nothing else
    // may be rewritten here: a half's abilities go through the whole rule table
    // exactly as a single-faced card's do.
    oracleText: extras?.oracleText ?? face.oracleText,
    power: face.power,
    toughness: face.toughness,
    // Scryfall prints loyalty/defense at the CARD level, not per face, so a
    // Siege's starting defense has to be handed down or its front face compiles
    // as a battle with no number and reports itself missing one.
    ...(extras?.defense !== undefined ? { defense: extras.defense } : {}),
    ...(extras?.loyalty !== undefined ? { loyalty: extras.loyalty } : {}),
    keywords,
    // No `faces` on the wrapped record — each face is single-faced, which is
    // also what terminates the recursion.
  });
}

/**
 * Compile a transforming DFC: BOTH faces in full, linked as one definition.
 *
 * THE CONTRACT DOES NOT BEND HERE: the card is `'complete'` only when every
 * printed ability of BOTH faces compiled — a DFC whose back face is
 * half-modelled would sit on the battlefield playing wrong after the first
 * transform, which is worse than reporting it. The front face's definition
 * carries the back nested as `CardDefinition.backFace` (back marked
 * `isBackFace`, id `<frontId>#back` so the UI can look up per-face art); which
 * face is UP is per-permanent state owned by core (`transformPermanent`).
 *
 * Scryfall's card-level `keywords` list is the UNION of both faces' keywords
 * (Delver's says `Flying`, printed only on the back). Each keyword (minus
 * `Transform` itself, which is the machinery, not an ability) is attributed to
 * every face whose own oracle text prints it; one attributable to NEITHER face
 * is reported, never guessed onto a face.
 */
function compileTransformDfc(card: CompilableCard): CompileResult {
  const faces = card.faces as NonNullable<CompilableCard['faces']>;
  const [frontFace, backFace] = faces as [typeof faces[number], typeof faces[number]];

  const missing: UnsupportedClause[] = [];
  const keywordsFor = (face: typeof frontFace): string[] => {
    const text = face.oracleText.toLowerCase();
    return card.keywords.filter((keyword) => {
      const word = keyword.toLowerCase();
      return word !== TRANSFORM_KEYWORD && text.includes(word);
    });
  };
  for (const keyword of card.keywords) {
    const word = keyword.toLowerCase();
    if (word === TRANSFORM_KEYWORD) continue;
    const printedSomewhere = faces.some((face) => face.oracleText.toLowerCase().includes(word));
    if (!printedSomewhere) {
      missing.push({
        text: keyword,
        missingEngineSystem: `the "${keyword}" keyword ability (not attributable to either face's text)`,
      });
    }
  }

  const front = compileFace(frontFace, card.id, keywordsFor(frontFace));
  const back = compileFace(backFace, `${card.id}${BACK_FACE_ID_SUFFIX}`, keywordsFor(backFace));
  missing.push(...front.missing, ...back.missing);

  const definition: CardDefinition = {
    ...front.definition,
    backFace: { ...back.definition, isBackFace: true },
  };
  return {
    status: missing.length === 0 ? 'complete' : 'incomplete',
    definition,
    matchedRules: [...front.matchedRules, ...back.matchedRules, 'transforming-dfc'],
    missing,
  };
}

/**
 * Whether this record is a MODAL double-faced card — a card whose SECOND FACE
 * is castable (or playable, when it is a land), as opposed to a transforming
 * DFC whose back face is only ever reached by a transform instruction.
 *
 * Detected by Scryfall's `layout` alone, with no keyword fallback: modal DFCs
 * print no keyword that names the layout, and guessing one from a "//" name
 * would sweep in split and adventure cards, which are NOT two faces and must
 * keep reporting.
 */
function isModalDfc(card: CompilableCard): boolean {
  return card.layout === MODAL_DFC_LAYOUT && (card.faces?.length ?? 0) === DFC_FACE_COUNT;
}

/**
 * Compile a modal DFC: BOTH faces in full, linked as one definition whose back
 * face is marked CASTABLE.
 *
 * The contract does not bend here either — the card is `'complete'` only when
 * every printed ability of BOTH faces compiled. A modal DFC whose back half is
 * half-modelled would be a card whose value is precisely the choice between two
 * halves, one of which lies.
 *
 * Two things differ from `compileTransformDfc`, and both follow from the
 * layout: the back face is stamped `isBackFace` AND the front stamps
 * `backFaceCastable`, so core offers both halves at cast/play time; and each
 * face keeps its OWN mana cost (a transforming back face has none, because it
 * is never cast). Keyword attribution is shared with the transform path — a
 * keyword is attributed to every face whose own text prints it, never guessed.
 */
function compileModalDfc(card: CompilableCard): CompileResult {
  const faces = card.faces as NonNullable<CompilableCard['faces']>;
  const [frontFace, backFace] = faces as [typeof faces[number], typeof faces[number]];

  const missing: UnsupportedClause[] = [];
  for (const keyword of card.keywords) {
    const word = keyword.toLowerCase();
    if (!faces.some((face) => face.oracleText.toLowerCase().includes(word))) {
      missing.push({
        text: keyword,
        missingEngineSystem: `the "${keyword}" keyword ability (not attributable to either face's text)`,
      });
    }
  }
  const keywordsFor = (face: typeof frontFace): string[] =>
    card.keywords.filter((keyword) => face.oracleText.toLowerCase().includes(keyword.toLowerCase()));

  const front = compileFace(frontFace, card.id, keywordsFor(frontFace));
  const back = compileFace(backFace, `${card.id}${BACK_FACE_ID_SUFFIX}`, keywordsFor(backFace));
  missing.push(...front.missing, ...back.missing);

  const definition: CardDefinition = {
    ...front.definition,
    backFace: { ...back.definition, isBackFace: true },
    backFaceCastable: true,
  };
  return {
    status: missing.length === 0 ? 'complete' : 'incomplete',
    definition,
    matchedRules: [...front.matchedRules, ...back.matchedRules, 'modal-dfc'],
    missing,
  };
}

// --- split cards, adventurer cards and Sieges ------------------------------------

/** Scryfall's layout value for a two-halved SPLIT card (CR 709). */
const SPLIT_LAYOUT = 'split';
/** Scryfall's layout value for an ADVENTURER card (CR 715). */
const ADVENTURE_LAYOUT = 'adventure';
/** The subtype every adventure half prints; the whole of how one is spotted. */
const ADVENTURE_SUBTYPE = 'adventure';
/** The subtype a battle prints when it carries the exile-and-cast reward. */
const SIEGE_SUBTYPE = 'siege';
/** The subtype both halves of a Room print (CR 714) - a different system. */
const ROOM_SUBTYPE = 'room';
/** CR 702.127: "cast this spell only from your graveyard. Then exile it." */
const AFTERMATH_KEYWORD = 'aftermath';
/** CR 702.102: "you may cast one or both halves of this card from your hand." */
const FUSE_KEYWORD = 'fuse';

/** The zones an AFTERMATH half may be cast from - the graveyard, and only it. */
const AFTERMATH_CAST_ZONES: readonly CastZone[] = ['graveyard'];
/** The zones a defeated Siege's reward half may be cast from. */
const SIEGE_REWARD_CAST_ZONES: readonly CastZone[] = ['exile'];

/** Whether a face prints `subtype` (case-insensitively). */
function faceHasSubtype(face: NonNullable<CompilableCard['faces']>[number], subtype: string): boolean {
  return face.typeLine.subtypes.some((printed) => printed.toLowerCase() === subtype);
}

/** Whether this record is a two-halved SPLIT card (which includes Rooms). */
function isSplitLayout(card: CompilableCard): boolean {
  return card.layout === SPLIT_LAYOUT && (card.faces?.length ?? 0) === DFC_FACE_COUNT;
}

/** Whether this record is an ADVENTURER card - a creature (or land, or
 * enchantment) whose second half is an instant or sorcery with the Adventure
 * subtype. Detected by the SUBTYPE rather than by the reminder text, because
 * Scryfall omits the reminder on some printings and the subtype is never absent.
 */
function isAdventureLayout(card: CompilableCard): boolean {
  const faces = card.faces;
  if (card.layout !== ADVENTURE_LAYOUT || faces?.length !== DFC_FACE_COUNT) return false;
  return faceHasSubtype(faces[1] as NonNullable<CompilableCard['faces']>[number], ADVENTURE_SUBTYPE);
}

/**
 * Whether this record is a SIEGE - a battle whose back face is the reward cast
 * from exile once its last defense counter comes off (CR 310.4). Scryfall files
 * it under the `transform` layout, so the front face's Siege subtype is what
 * separates it from an Innistrad werewolf.
 */
function isSiege(card: CompilableCard): boolean {
  const faces = card.faces;
  if (faces?.length !== DFC_FACE_COUNT) return false;
  if (card.layout !== undefined && card.layout !== TRANSFORM_LAYOUT) return false;
  return faceHasSubtype(faces[0] as NonNullable<CompilableCard['faces']>[number], SIEGE_SUBTYPE);
}

/**
 * Drop a bare LAYOUT KEYWORD line (`Aftermath`, `Fuse`) from a face's text.
 *
 * On the printed card those words head a parenthesised reminder that
 * `stripReminderText` already removes, leaving the word alone on its own line.
 * It is not an ability - it is the name of the layout, which this compiler has
 * already read from `card.keywords` - so leaving it in would have every
 * aftermath half report its own layout as an unrecognised template.
 */
function withoutLayoutKeywordLine(text: string, keyword: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const bare = line.replace(/\([^)]*\)/g, '').trim().toLowerCase();
      return bare !== keyword;
    })
    .join('\n');
}

/**
 * Sum two printed costs - CR 709.4's combined mana value AND combined colours in
 * one operation, because a mana cost is both. The hybrid lists concatenate
 * rather than add: each entry is one printed symbol with a choice of colours,
 * and two halves that each print one contribute two.
 */
function combinedCost(left: ManaCost | undefined, right: ManaCost | undefined): ManaCost | undefined {
  if (!left) return right;
  if (!right) return left;
  const sum: {
    generic?: number;
    W?: number;
    U?: number;
    B?: number;
    R?: number;
    G?: number;
    C?: number;
    hybrid?: readonly (readonly import('@jonny-boi/core').ManaColor[])[];
  } = {};
  for (const symbol of COMBINABLE_COST_SYMBOLS) {
    const total = (left[symbol] ?? 0) + (right[symbol] ?? 0);
    if (total > 0) sum[symbol] = total;
  }
  const hybrid = [...(left.hybrid ?? []), ...(right.hybrid ?? [])];
  if (hybrid.length > 0) sum.hybrid = hybrid;
  return sum;
}

/** The numeric components of a mana cost, in the order a cost prints them. */
const COMBINABLE_COST_SYMBOLS = ['generic', 'W', 'U', 'B', 'R', 'G', 'C'] as const;

/**
 * The keywords attributable to one face - a keyword whose own text prints it -
 * minus the LAYOUT words, which name the machinery rather than an ability.
 */
function faceKeywords(card: CompilableCard, text: string, layoutWords: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return card.keywords.filter((keyword) => {
    const word = keyword.toLowerCase();
    return !layoutWords.includes(word) && lower.includes(word);
  });
}

/**
 * Compile a SPLIT card (CR 709): ONE card, TWO halves, either castable.
 *
 * The shape is the whole design. A split card in a hand, graveyard or library is
 * neither half - CR 709.4 gives it the COMBINED characteristics - so THIS
 * definition carries those (the full `A // B` name, the union of the type lines,
 * and a cost that is the sum of both halves, which is simultaneously the right
 * mana value and the right colour set), and the two halves hang off it as
 * `frontFace` and `backFace`. Core's `playableFaceOf` then answers "which object
 * am I casting?" for a split card, a modal DFC and an ordinary spell alike.
 *
 * Two split-layout shapes are NOT this and say so instead of being approximated:
 * a ROOM (CR 714, a permanent whose second door unlocks on the battlefield) and
 * FUSE (CR 702.102, one spell that is both halves at once). Aftermath is not one
 * of them: "cast this spell only from your graveyard" is exactly a per-half list
 * of legal cast zones, which the engine reads.
 */
function compileSplitCard(card: CompilableCard): CompileResult {
  const faces = card.faces as NonNullable<CompilableCard['faces']>;
  const [leftFace, rightFace] = faces as [typeof faces[number], typeof faces[number]];
  const missing: UnsupportedClause[] = [];

  const words = card.keywords.map((keyword) => keyword.toLowerCase());
  const aftermath = words.includes(AFTERMATH_KEYWORD);
  const fused = words.includes(FUSE_KEYWORD);
  const isRoom = faces.some((face) => faceHasSubtype(face, ROOM_SUBTYPE));

  if (isRoom) missing.push({ text: card.name, missingEngineSystem: ROOM_DOOR_GAP });
  if (fused) missing.push({ text: FUSE_KEYWORD, missingEngineSystem: FUSE_GAP });

  const layoutWords = [AFTERMATH_KEYWORD, FUSE_KEYWORD];
  for (const keyword of card.keywords) {
    const word = keyword.toLowerCase();
    if (layoutWords.includes(word)) continue;
    if (!faces.some((face) => face.oracleText.toLowerCase().includes(word))) {
      missing.push({
        text: keyword,
        missingEngineSystem: `the "${keyword}" keyword ability (not attributable to either half's text)`,
      });
    }
  }

  const textFor = (face: typeof leftFace): string =>
    layoutWords.reduce((text, word) => withoutLayoutKeywordLine(text, word), face.oracleText);
  const left = compileFace(leftFace, card.id, faceKeywords(card, leftFace.oracleText, layoutWords), {
    oracleText: textFor(leftFace),
  });
  const right = compileFace(
    rightFace,
    `${card.id}${BACK_FACE_ID_SUFFIX}`,
    faceKeywords(card, rightFace.oracleText, layoutWords),
    { oracleText: textFor(rightFace) },
  );
  missing.push(...left.missing, ...right.missing);

  // The CR 709.4 combined object. It has no script of its own and is never cast:
  // `frontFace` being present is precisely what tells core so.
  const combinedTypes = [...new Set([...left.definition.types, ...right.definition.types])];
  const cost = combinedCost(left.definition.cost, right.definition.cost);
  const definition: CardDefinition = {
    id: card.id,
    name: card.name,
    types: combinedTypes,
    ...(cost ? { cost } : {}),
    frontFace: left.definition,
    backFace: { ...right.definition, isBackFace: true },
    backFaceCastable: true,
    // AFTERMATH (CR 702.127a) is the one printed restriction on WHERE a half may
    // be cast from, and it is data: the right half is offered from the graveyard
    // and nowhere else. Everything after that - paying its own printed cost, and
    // exiling the card when it leaves the stack - the graveyard cast path
    // already does for flashback.
    ...(aftermath ? { backFaceCastZones: AFTERMATH_CAST_ZONES } : {}),
  };
  return {
    status: missing.length === 0 ? 'complete' : 'incomplete',
    definition,
    matchedRules: [...left.matchedRules, ...right.matchedRules, aftermath ? 'aftermath-card' : 'split-card'],
    missing,
  };
}

/**
 * Compile an ADVENTURER card (CR 715): a creature (or land, or enchantment)
 * whose second half is an instant or sorcery you may cast first.
 *
 * Unlike a split card this one's own definition IS the primary half, because CR
 * 715.2 gives an adventurer card in every zone but the stack only its normal
 * characteristics - a Bonecrusher Giant in your graveyard is a creature card,
 * full stop. So `frontFace` stays absent and the adventure hangs off the back,
 * marked `adventure` so that resolving it exiles the card and grants its owner
 * permission to play the primary half from exile (CR 715.3d).
 */
function compileAdventure(card: CompilableCard): CompileResult {
  const faces = card.faces as NonNullable<CompilableCard['faces']>;
  const [mainFace, adventureFace] = faces as [typeof faces[number], typeof faces[number]];
  const missing: UnsupportedClause[] = [];

  for (const keyword of card.keywords) {
    const word = keyword.toLowerCase();
    if (!faces.some((face) => face.oracleText.toLowerCase().includes(word))) {
      missing.push({
        text: keyword,
        missingEngineSystem: `the "${keyword}" keyword ability (not attributable to either half's text)`,
      });
    }
  }

  const main = compileFace(mainFace, card.id, faceKeywords(card, mainFace.oracleText, []));
  const adventure = compileFace(
    adventureFace,
    `${card.id}${BACK_FACE_ID_SUFFIX}`,
    faceKeywords(card, adventureFace.oracleText, []),
  );
  missing.push(...main.missing, ...adventure.missing);

  const definition: CardDefinition = {
    ...main.definition,
    backFace: { ...adventure.definition, isBackFace: true, adventure: true },
    backFaceCastable: true,
  };
  return {
    status: missing.length === 0 ? 'complete' : 'incomplete',
    definition,
    matchedRules: [...main.matchedRules, ...adventure.matchedRules, 'adventurer-card'],
    missing,
  };
}

/**
 * Compile a SIEGE (CR 310.4): a battle whose back face is a REWARD its
 * controller may cast, free, from exile, once the last defense counter has been
 * removed and the battle exiled.
 *
 * Structurally it is the transform layout - Scryfall files it there and the two
 * faces are compiled the same way - with one difference that changes everything
 * about how the card plays: the back face is castable, from exile only, without
 * paying its mana cost. The engine's state-based action does the exiling and
 * writes the permission; this only has to say the reward exists.
 */
function compileSiege(card: CompilableCard): CompileResult {
  const faces = card.faces as NonNullable<CompilableCard['faces']>;
  const [battleFace, rewardFace] = faces as [typeof faces[number], typeof faces[number]];
  const missing: UnsupportedClause[] = [];

  const layoutWords = [TRANSFORM_KEYWORD];
  for (const keyword of card.keywords) {
    const word = keyword.toLowerCase();
    if (layoutWords.includes(word)) continue;
    if (!faces.some((face) => face.oracleText.toLowerCase().includes(word))) {
      missing.push({
        text: keyword,
        missingEngineSystem: `the "${keyword}" keyword ability (not attributable to either face's text)`,
      });
    }
  }

  // The printed starting defense lives on the CARD, not on the battle face.
  const battle = compileFace(battleFace, card.id, faceKeywords(card, battleFace.oracleText, layoutWords), {
    defense: card.defense ?? null,
  });
  const reward = compileFace(
    rewardFace,
    `${card.id}${BACK_FACE_ID_SUFFIX}`,
    faceKeywords(card, rewardFace.oracleText, layoutWords),
  );
  missing.push(...battle.missing, ...reward.missing);

  const definition: CardDefinition = {
    ...battle.definition,
    backFace: { ...reward.definition, isBackFace: true },
    backFaceCastable: true,
    backFaceCastZones: SIEGE_REWARD_CAST_ZONES,
    backFaceFreeCast: true,
  };
  return {
    status: missing.length === 0 ? 'complete' : 'incomplete',
    definition,
    matchedRules: [...battle.matchedRules, ...reward.matchedRules, 'siege-battle'],
    missing,
  };
}

/**
 * Compile many cards, partitioning them into the ones that are genuinely
 * playable and the ones that need engine work. This is the shape the importer
 * consumes: it imports `playable` and shows `blocked` to the user verbatim.
 */
export function compileCards(cards: readonly CompilableCard[]): {
  readonly playable: readonly CardDefinition[];
  readonly blocked: ReadonlyArray<{ readonly card: CompilableCard; readonly missing: readonly UnsupportedClause[] }>;
} {
  const playable: CardDefinition[] = [];
  const blocked: Array<{ card: CompilableCard; missing: readonly UnsupportedClause[] }> = [];
  for (const card of cards) {
    const result = compileCard(card);
    if (result.status === 'complete') playable.push(result.definition);
    else blocked.push({ card, missing: result.missing });
  }
  return { playable, blocked };
}
