/**
 * CHARACTERISTIC PROVENANCE (DESIGN §3.143 / UX-17) — "the board says this creature
 * is a 5/6. WHERE did each point come from?"
 *
 * ## Why this file exists at all
 * `internal/continuous.ts` folds every continuous modification into ONE
 * {@link AggregatedMod} per instance — a sum and a set of ORs — and throws the
 * ATTRIBUTION away. That is exactly the right shape for the rules engine (combat,
 * state-based actions, legality and serialization all want the number, never the
 * story) and exactly the wrong shape for a player, who is looking at a 5/6 and
 * wants to know which enchantment is responsible.
 *
 * A UI cannot honestly reconstruct the story from the sum. Subtracting counters out
 * of a delta to guess "how much of this came from an aura" is the two-places-one-
 * question failure CLAUDE.md rule 12 forbids — it answers correctly right up until
 * a third source appears, and then it is confidently wrong. So core answers it,
 * once, here, and every surface reads this one list.
 *
 * ## Performance: attribution costs ZERO when nobody asks (rule 7)
 * `indexContinuous` runs from 20+ call sites across combat, SBAs, targeting,
 * legality and serialization, several times per action, across thousands of
 * simulated games. Nothing in this file is on that path:
 *   - no field was added to `AggregatedMod` (a new optional key changes the hidden
 *     class of an object read at ~73 ns/call);
 *   - no parameter was added to `indexContinuous` (that forks `ContinuousIndex`
 *     into two kinds, one of which silently lacks attribution — the same failure
 *     in a different costume);
 *   - the aggregation body is untouched.
 * {@link explainCharacteristics} is a SECOND walk over the same sources, run only
 * when a human hovers something.
 *
 * ## Two walks, one answer (rule 12's escape clause)
 * A second walk can drift from the first. Two things stop it:
 *   1. The headline numbers are NOT re-derived. `power`, `toughness`, `keywords`
 *      and `activated` come from `effectivePower` / `effectiveToughness` /
 *      `effectiveKeywords` / `effectiveActivated` over the index `indexContinuous`
 *      built — the same accessors combat reads. Only the BREAKDOWN is re-walked.
 *   2. The breakdown RECONCILES against those numbers before it is returned. Any
 *      part of the effective value the walk could not attribute comes back as an
 *      explicit `'unexplained'` row rather than being dropped, because a missing
 *      row reads to a player as "nothing changed it", which is a lie. See
 *      {@link UNEXPLAINED_SOURCE_NAME}.
 * `provenance.test.ts` pins both directions.
 *
 * ## Honest about CR 613
 * This engine has no layer system — `conformance/rules-manifest.ts` section 613
 * declares that a GAP, not an oversight: no layer objects, no timestamps, no
 * dependency resolution. {@link CONTRIBUTION_LAYERS} is therefore a READING ORDER
 * for a human, labelled with the CR 613 layer each row would belong to, not a
 * claim that the engine sorted anything into layers. Within a layer, rows are in
 * APPLICATION order (battlefield array order, then `state.continuous` insertion
 * order) — deliberately NOT called timestamp order, because there are no
 * timestamps. That is safe for the same reason the missing layer system is exact:
 * every fold is a sum or an OR, so order provably cannot change an answer.
 */

import type {
  ActivatedAbility,
  CardDefinition,
  KeywordFlags,
} from './card.js';
import { colorsOfDefinition } from './card.js';
import { chosenSubtypeOf } from './as-enters.js';
import { formatManaCost } from './mana.js';
import type { CardInstance, GameState, InstanceId, ZoneName } from './state.js';
import { PLAYER_IDS } from './state.js';
import type { AggregatedMod, ContinuousEffect, ContinuousIndex } from './internal/continuous.js';
import { indexContinuous, NO_MOD, readsSettledStats, withinEffectiveBounds } from './internal/continuous.js';
import {
  effectiveActivated,
  effectiveKeywords,
  effectivePower,
  effectiveToughness,
  MINUS_ONE_COUNTER,
  PLUS_ONE_COUNTER,
} from './internal/stats.js';
import type { PermanentModification, StaticAbility } from './statics.js';
import { modificationIsInert, staticAppliesTo, staticIsInert, staticsOf } from './statics.js';
import { findInstance } from './internal/zones.js';

// --- the closed tables ------------------------------------------------------------

/**
 * WHICH printed characteristic a contribution changes.
 *
 * CLOSED. A characteristic this engine cannot currently change is still a ROW
 * here, and {@link CHARACTERISTIC_SUPPORT} says in words what can and cannot touch
 * it — because a UI that silently omits "name" cannot be told apart from a UI that
 * checked and found nothing.
 */
export const CHARACTERISTIC_KINDS = [
  'power',
  'toughness',
  'keyword',
  'activatedAbility',
  'controller',
  'name',
  'types',
  'subtypes',
  'colors',
  'manaCost',
] as const;

export type CharacteristicKind = (typeof CHARACTERISTIC_KINDS)[number];

/**
 * HOW a contribution changes its characteristic. CLOSED.
 *
 * `'remove'` is declared and is currently NEVER emitted. That is not an oversight:
 * `grantInto` (internal/continuous.ts) only ORs, `internal/stats.ts` states that a
 * grant "can set a flag, never clear one", and `MODIFICATION_IS_PURELY_ADDITIVE`
 * (conformance/rules-manifest.ts) stops the build if a setting or clearing field is
 * added to `PermanentModification`. The row exists so the struck-through rendering
 * Caleb asked for is written ONCE, the day removal lands, rather than being
 * retrofitted across every surface — and `CHARACTERISTIC_SUPPORT.removable` says,
 * in the data, that nothing produces one yet.
 */
export const CONTRIBUTION_MODES = ['add', 'grant', 'replace', 'remove'] as const;

export type ContributionMode = (typeof CONTRIBUTION_MODES)[number];

/**
 * The reading order for a breakdown, labelled with the CR 613 layer each row would
 * belong to if this engine had layers. **THE ARRAY IS THE SORT ORDER** — a row's
 * index in this list is its sort key, so there is one table and no second ordering
 * that can fall out of step with it.
 *
 * ⚠️ Cite CR 613.1 / 613.2 / 613.4 only. `conformance/rules-manifest.ts` records
 * that 24 citations in this repo were wrong, layer 7's sublayers among them — they
 * are 613.4, not 613.3.
 *
 * Layers 3 (text-changing) and 5 (colour) are absent because NOTHING in this engine
 * can emit a row in them, and a sort key nothing ever occupies reads like a
 * capability. What the engine can do to a colour or a type line is stated in
 * {@link CHARACTERISTIC_SUPPORT} instead.
 */
export const CONTRIBUTION_LAYERS = [
  /**
   * Not a CR 613 layer at all: WHICH FACE of a double-faced card is up (CR 712.8a).
   * A transformed permanent's characteristics are its back face's, and the front
   * face is still recoverable from `CardInstance.printedDef` — so the difference is
   * attributable, and it is the first thing a player should read.
   */
  'face',
  /** CR 613.2 — LAYER 1, copy effects. Expressed as a whole-definition swap (copy.ts). */
  'copy',
  /** LAYER 2 — control. Applied eagerly by writing `CardInstance.controller`. */
  'control',
  /** LAYER 4 — type-changing. Only "as ~ enters, choose a type" reaches it here. */
  'type',
  /** LAYER 6 — ability-adding: granted keywords and granted activated abilities. */
  'ability',
  /** CR 613.4 sublayer 7a — a characteristic-defining P/T box (Tarmogoyf's `*`). */
  'basePT',
  /** CR 613.4 sublayer 7c — P/T modifications: anthems, auras, equipment, pumps. */
  'modifyPT',
  /** CR 613.4 sublayer 7d — +1/+1 and -1/-1 counters. */
  'counters',
  /**
   * NOT a layer. Part of the effective value that this walk could not place in one
   * at all — the reconciliation's remainder, which arrives with no idea of what
   * route produced it. Sorts last, so it reads as the remainder it is.
   *
   * ⚠️ Distinct from the `'unexplained'` SOURCE KIND, and the two are separate
   * axes on purpose. An unattributed control change knows its layer (2) and not its
   * source; a P/T residue knows neither. Collapsing them would throw away the half
   * of the answer that is known.
   */
  'unknown',
] as const;

export type ContributionLayer = (typeof CONTRIBUTION_LAYERS)[number];

/** WHERE a contribution comes from. CLOSED. */
export const CONTRIBUTION_SOURCE_KINDS = [
  /** The permanent's own box — a `*` P/T formula, a copy, a transformed face. */
  'self',
  /** An Aura or Equipment attached to this permanent. */
  'attachment',
  /** An anthem/lord radiating from the battlefield. */
  'static',
  /** The same, radiating from the command zone (CR 114) — an emblem. */
  'emblem',
  /** A layer-4 `ContinuousEffect`: a resolved pump, keyword grant or theft. */
  'temporary',
  /** Counters on the permanent itself. */
  'counter',
  /** Nothing could be named. See {@link UNEXPLAINED_SOURCE_NAME}. */
  'unexplained',
] as const;

export type ContributionSourceKind = (typeof CONTRIBUTION_SOURCE_KINDS)[number];

/**
 * The name an `'unexplained'` row carries. A player-facing string on purpose: the
 * tooltip renders it beside a real number, and "+2/+0 from (source unknown)" is a
 * true statement a player can act on, where showing nothing is a false one.
 */
export const UNEXPLAINED_SOURCE_NAME = '(source unknown)';

/** The name a row carries when its source instance exists in no zone (CR 111.7). */
export const VANISHED_SOURCE_NAME = '(source no longer exists)';

// --- the honest-closure table -----------------------------------------------------

/** What this engine can and cannot do to one printed characteristic. */
export interface CharacteristicSupport {
  /** Whether ANY effect this engine can express changes this characteristic. */
  readonly modifiable: boolean;
  /**
   * Whether any effect can REMOVE it — strike an ability out, take a type away.
   * All false today; see {@link CONTRIBUTION_MODES}. A UI reads this to decide
   * whether a struck-through rendering is even reachable.
   */
  readonly removable: boolean;
  /**
   * The layers a SOURCED contribution for this characteristic can appear in. The
   * honest-refusal `'unknown'` bucket is always possible and is deliberately not
   * listed: it is the absence of a layer, not one of them.
   */
  readonly layers: readonly ContributionLayer[];
  /**
   * ONE player-facing sentence saying exactly what can change it — required for
   * every row, including the modifiable ones, so the UI never has to infer the
   * shape of the answer from an empty list (rule 2: a value outside the table
   * REPORTS honestly rather than being widened to the nearest thing that exists).
   */
  readonly note: string;
}

/**
 * What the engine can do to each characteristic, as DATA.
 *
 * A MAPPED TYPE over {@link CharacteristicKind}, in the same default-deny shape as
 * `KEYWORD_LIST_IS_EXHAUSTIVE` and `RULES_MANIFEST`: adding a characteristic kind
 * stops `tsc` until this table says what can change it.
 */
export const CHARACTERISTIC_SUPPORT: { readonly [K in CharacteristicKind]: CharacteristicSupport } = {
  power: {
    modifiable: true,
    removable: false,
    layers: ['copy', 'face', 'basePT', 'modifyPT', 'counters'],
    note: 'Changed by +1/+1 and -1/-1 counters, auras and equipment, anthems and emblems, and until-end-of-turn pumps. A `*` box is recomputed from the board every read.',
  },
  toughness: {
    modifiable: true,
    removable: false,
    layers: ['copy', 'face', 'basePT', 'modifyPT', 'counters'],
    note: 'Changed by the same sources as power.',
  },
  keyword: {
    modifiable: true,
    removable: false,
    layers: ['copy', 'face', 'ability'],
    note: 'Keywords can be GRANTED by auras, equipment, anthems, emblems and until-end-of-turn effects. Nothing in this engine can remove one: a grant sets a flag and never clears it.',
  },
  activatedAbility: {
    modifiable: true,
    removable: false,
    layers: ['copy', 'face', 'ability'],
    note: 'Activated abilities can be granted ("Enchanted creature has “{T}: …”"). Printed abilities always come first and a grant can never renumber or remove one. A modification whose ONLY content is a granted ability is live and IS reported here (it was wrongly judged inert until §3.143 GAP-14, and this walk reads the same `modificationIsInert` / `staticIsInert` gate the engine does, so the two agree). One grant is reported and NOT offered as an activation: a granted ability that only adds mana is a mana ability (CR 605.1a), so the board offers it as a tap for mana rather than as an activation — see `manaAbilityFromActivated`.',
  },
  controller: {
    modifiable: true,
    removable: false,
    layers: ['control'],
    note: 'Control changes are applied by writing the permanent’s controller, with the previous controller recorded so the effect can hand it back when it ends.',
  },
  name: {
    modifiable: true,
    removable: false,
    layers: ['copy', 'face'],
    note: 'A name changes ONLY by becoming a copy of another card or by transforming to the other face. No effect renames a permanent in place.',
  },
  types: {
    modifiable: true,
    removable: false,
    layers: ['copy', 'face'],
    note: 'The card-type line changes ONLY by copy or transform. No effect in this engine adds or removes a card type in place ("becomes an artifact creature" is unsupported).',
  },
  subtypes: {
    modifiable: true,
    removable: false,
    layers: ['copy', 'face', 'type'],
    note: 'Subtypes change by copy or transform, and one subtype can be ADDED by "as ~ enters, choose a creature type". Nothing removes a subtype.',
  },
  colors: {
    modifiable: true,
    removable: false,
    layers: ['copy', 'face'],
    note: 'Colour changes ONLY by copy or transform — the colour is read off the copied card’s pips. There are no colour-changing effects ("becomes blue" is unsupported).',
  },
  manaCost: {
    modifiable: true,
    removable: false,
    layers: ['copy', 'face'],
    note: 'The printed mana cost changes ONLY by copy or transform. Cost REDUCTION is not a characteristic of an object at all — it is computed when the spell is cast (CR 601.2f) and never appears here.',
  },
};

// --- the compile-time coverage guards ---------------------------------------------

/**
 * Every field of {@link PermanentModification} mapped to the characteristic it
 * changes.
 *
 * THIS IS THE GUARD, and it is the reason a new kind of continuous modification
 * cannot be added and silently go unattributed. `PermanentModification` is the ONE
 * shape a static ability or an attachment may take; this is a mapped type over its
 * keys, so adding `setPower` / `becomesType` / `losesAllAbilities` to it stops
 * `tsc` here until this table says which characteristic the new field changes —
 * and the author is then standing in the file that has to emit a row for it.
 *
 * It lives in shipped source, not in a test: `packages/core/tsconfig.json` excludes
 * `*.test.ts`, and Vitest strips types without checking them, so a proof written in
 * a test would never be evaluated by anything. Same reasoning, and same shape, as
 * `MODIFICATION_IS_PURELY_ADDITIVE`.
 */
export const MODIFICATION_CHARACTERISTICS: {
  readonly [K in keyof Required<PermanentModification>]: CharacteristicKind;
} = {
  power: 'power',
  toughness: 'toughness',
  keywords: 'keyword',
  activated: 'activatedAbility',
};

/**
 * The fields of a layer-4 {@link ContinuousEffect} that MODIFY something, each
 * mapped to the characteristic it changes. Identity and lifetime fields are
 * excluded by name, so they are the only thing this table forgives.
 *
 * The second half of the same guard: a new modifying field on `ContinuousEffect`
 * stops `tsc` here. (`controlChange` is in the list because a control change IS a
 * modification a player can see — it is applied eagerly to `CardInstance.controller`
 * rather than layered, and the record is what lets this file attribute it.)
 */
type ContinuousEffectModificationKey = Exclude<
  keyof ContinuousEffect,
  'id' | 'targetInstanceId' | 'sourceInstanceId' | 'duration'
>;

export const CONTINUOUS_EFFECT_CHARACTERISTICS: {
  readonly [K in ContinuousEffectModificationKey]: CharacteristicKind;
} = {
  power: 'power',
  toughness: 'toughness',
  keywords: 'keyword',
  controlChange: 'controller',
};

/**
 * The counter kinds that SHIFT power and toughness, and by how much each.
 *
 * A TABLE because adding the next one must be a ROW. It mirrors `counterShift` in
 * `internal/stats.ts`, which is the one place the rules read these — and the
 * reconciliation below is what keeps the two honest: a counter kind added to
 * `counterShift` and not to this table shows up immediately as an `'unexplained'`
 * row rather than as a silently wrong breakdown.
 *
 * Other counter kinds (loyalty, defense, and whatever a card names) are deliberately
 * absent: they are instance state that no characteristic reads, so they belong to
 * the inspector, not to a characteristic breakdown.
 */
const PT_COUNTER_KINDS = [
  { kind: PLUS_ONE_COUNTER, power: 1, toughness: 1 },
  { kind: MINUS_ONE_COUNTER, power: -1, toughness: -1 },
] as const;

// --- the records ------------------------------------------------------------------

/** The object supplying one contribution. */
export interface ContributionSource {
  readonly kind: ContributionSourceKind;
  /**
   * The instance that supplies it — the explained permanent itself for `'self'`
   * and `'counter'`, and for `'unexplained'`, where there is nothing else to name.
   */
  readonly instanceId: InstanceId;
  /**
   * `CardDefinition.id`. Resolve art and oracle text through the app's existing
   * card funnel (`apps/web/src/lib/cards.ts` already strips `#copy` / `#back`).
   * Empty when the source could not be found in any zone.
   */
  readonly cardId: string;
  /** The source card's name, or {@link VANISHED_SOURCE_NAME} / {@link UNEXPLAINED_SOURCE_NAME}. */
  readonly name: string;
  /**
   * The zone the source sits in RIGHT NOW — a resolved Giant Growth's source is in
   * a graveyard, an emblem's is `'command'`. `'unknown'` when the instance is in no
   * zone at all, which is the graceful degradation for a token source that ceased
   * to exist (CR 111.7). Never an error, never a thrown lookup, never a dropped row
   * — dropping it would make the contributions stop summing, and the reconciliation
   * would then blame the arithmetic.
   */
  readonly zone: ZoneName | 'unknown';
  /**
   * The printed wording the source declares for this modification —
   * `StaticAbility.label` or `AttachmentSpec.label`. Absent when the card declared
   * none.
   */
  readonly label?: string;
}

/** ONE row of the breakdown. */
export interface CharacteristicContribution {
  readonly characteristic: CharacteristicKind;
  readonly layer: ContributionLayer;
  readonly mode: ContributionMode;
  /**
   * The signed NUMBER: a power/toughness delta on an `'add'` row, the new base on a
   * `'basePT'` replace row, or the value of a numeric keyword payload (`ward 2`,
   * `toxic 1`). Absent for a plain boolean keyword or a granted ability.
   *
   * ⚠️ Only `mode === 'add'` rows participate in the P/T sum. A `'replace'` row
   * states a base, not a delta.
   */
  readonly amount?: number;
  /**
   * The NAMED thing: the raw `keyof KeywordFlags` key for a keyword
   * (`'firstStrike'`, `'protectionFrom'`), `ActivatedAbility.label` for a granted
   * ability, the counter kind (`'+1/+1'`) for a counter row, or the NEW value for a
   * `'replace'` row.
   *
   * The keyword key is deliberately the raw flag name rather than display prose, so
   * a glossary keyed on `keyof KeywordFlags` can be a mapped type and break the
   * build when core adds a keyword. Two vocabularies for one set of keywords is how
   * a granted keyword ends up rendering with no tooltip, silently.
   */
  readonly detail?: string;
  /** The value BEFORE, on a `'replace'` row. Absent on every other mode. */
  readonly previous?: string;
  /**
   * A LIST payload for a granted keyword — protection qualities, for instance.
   *
   * Present only when the payload is a list of plain strings. A payload with a
   * richer shape (a landwalk's `{kind:'subtype', subtype:'island'}` record) leaves
   * this absent and the row carries the keyword name alone: an honest refusal, not
   * an approximate rendering (rule 2).
   */
  readonly values?: readonly string[];
  readonly source: ContributionSource;
}

/** Everything a hover tooltip needs about one object, in one call. */
export interface CharacteristicExplanation {
  readonly instanceId: InstanceId;
  /** `CardDefinition.id` of the ACTIVE face / copied card — what the player sees. */
  readonly cardId: string;
  readonly name: string;
  readonly zone: ZoneName;
  /**
   * The BASE the additive contributions are layered over: `mod.basePower ??
   * def.power ?? 0` — i.e. after layer 1 (a copy's box, not the copier's) and after
   * CR 613.4's layer 7a.
   *
   * ⚠️ This is NOT `def.power`. Every characteristic-defining card in the pool
   * prints no number at all, so reading `def.power` renders a 4/5 Tarmogoyf as
   * "0/0" with the whole formula shown as a "+4/+5" badge.
   */
  readonly basePower: number;
  readonly baseToughness: number;
  /** The effective values, from the SAME accessors combat and state-based actions read. */
  readonly power: number;
  readonly toughness: number;
  readonly keywords: KeywordFlags;
  /** The printed set, so a UI can tell granted words from printed ones. */
  readonly printedKeywords: KeywordFlags;
  /** Effective activated abilities: printed first, then granted (index-stable). */
  readonly activated: readonly ActivatedAbility[];
  readonly printedActivated: readonly ActivatedAbility[];
  /**
   * Every contribution, sorted by {@link CONTRIBUTION_LAYERS} order and, WITHIN a
   * layer, in APPLICATION order — battlefield array order for attachments and
   * statics, `state.continuous` insertion order for temporaries.
   *
   * ⚠️ Application order, NOT CR 613.7 timestamp order: this engine has no
   * timestamps (section 613 is a declared gap). It is deterministic, and it cannot
   * change any number, because every fold is a sum or an OR.
   */
  readonly contributions: readonly CharacteristicContribution[];
  /**
   * False when any row is `'unexplained'` — i.e. part of the effective value could
   * not be traced to a source. A UI must say so rather than presenting a partial
   * breakdown as a complete one.
   */
  readonly fullyAttributed: boolean;
}

// --- the ONE entry point ----------------------------------------------------------

/**
 * The full characteristic breakdown for one object, built ON DEMAND.
 *
 * ONE list answers every characteristic. A per-characteristic API (`explainPower`,
 * `explainKeywords`, …) would be the parallel-vocabulary failure rule 12 forbids:
 * the board tile, the hover card, the stack card and the prompt card all read this
 * same array and filter it.
 *
 * Returns `undefined` only when no instance with this id exists in any zone. An
 * object with nothing modifying it returns an explanation with an EMPTY contribution
 * list — a card in hand is a legitimate question whose answer is "nothing has been
 * done to this", not an error.
 *
 * `index` is the same optional-cache parameter every effective-stat accessor in this
 * engine takes: a caller rendering a whole board has already built one per pass and
 * should hand it over rather than making this build N of them. ⚠️ It MUST be
 * `indexContinuous(state)` for THIS state — a stale index makes every number here
 * self-consistently wrong, which is the worst kind.
 *
 * ⚠️ NOT on the hot path, and that is the whole design — see the module header.
 */
export function explainCharacteristics(
  state: GameState,
  instanceId: InstanceId,
  index?: ContinuousIndex,
): CharacteristicExplanation | undefined {
  const inst = findInstance(state, instanceId);
  if (inst === undefined) return undefined;

  // The AUTHORITATIVE aggregate. `indexContinuous` rather than `aggregateFor`
  // deliberately: the bulk path is what combat, state-based actions, legality and
  // serialization all read, so the headline numbers here are the numbers the player
  // is looking at on the board. (The two are meant to agree; where they do not, the
  // one with 20 call sites is the one a breakdown must match.)
  const mod = (index ?? indexContinuous(state)).get(instanceId) ?? NO_MOD;

  const rows: CharacteristicContribution[] = [];
  collectFaceAndCopyRows(inst, rows);
  collectControlRows(state, inst, rows);
  collectChosenSubtypeRow(inst, rows);
  collectBasePTRow(inst, mod, rows);
  collectAttachmentRows(state, inst, rows);
  collectStaticRows(state, inst, mod, rows);
  collectTemporaryRows(state, inst, rows);
  collectCounterRows(inst, rows);

  const basePower = mod.basePower ?? inst.def.power ?? 0;
  const baseToughness = mod.baseToughness ?? inst.def.toughness ?? 0;
  const power = effectivePower(inst, mod);
  const toughness = effectiveToughness(inst, mod);

  reconcile(inst, mod, { basePower, baseToughness, power, toughness }, rows);

  // The array IS the sort order, so the sort key is an index lookup into it. Stable
  // (V8's sort is), which is what preserves APPLICATION order within a layer.
  rows.sort((a, b) => CONTRIBUTION_LAYERS.indexOf(a.layer) - CONTRIBUTION_LAYERS.indexOf(b.layer));

  return {
    instanceId,
    cardId: inst.def.id,
    name: inst.def.name,
    zone: inst.zone,
    basePower,
    baseToughness,
    power,
    toughness,
    keywords: effectiveKeywords(inst, mod),
    printedKeywords: inst.def.keywords ?? {},
    activated: effectiveActivated(inst, mod),
    printedActivated: inst.def.activated ?? [],
    contributions: rows,
    fullyAttributed: !rows.some((row) => row.source.kind === 'unexplained'),
  };
}

// --- source descriptors -----------------------------------------------------------

/** Describe an instance that is definitely in hand as a contribution source. */
function sourceOf(
  kind: ContributionSourceKind,
  inst: CardInstance,
  label?: string,
): ContributionSource {
  return {
    kind,
    instanceId: inst.instanceId,
    cardId: inst.def.id,
    name: inst.def.name,
    zone: inst.zone,
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Describe a source by ID, across EVERY zone — a resolved Giant Growth's source is
 * in a graveyard, an emblem's is the command zone, and a token that pumped and then
 * died is in no zone at all (CR 111.7).
 *
 * `internal/continuous.ts` deliberately keeps its own battlefield-only lookup to
 * stay free of an import cycle with the zone code; this file has no such constraint
 * and is not on the hot path, so it asks the real cross-zone finder and DEGRADES to
 * a named-but-vanished row rather than dropping one.
 */
function sourceById(state: GameState, kind: ContributionSourceKind, id: InstanceId): ContributionSource {
  const found = findInstance(state, id);
  if (found !== undefined) return sourceOf(kind, found);
  return { kind, instanceId: id, cardId: '', name: VANISHED_SOURCE_NAME, zone: 'unknown' };
}

/** The source descriptor an `'unexplained'` row carries. */
function unexplainedSource(inst: CardInstance): ContributionSource {
  return {
    kind: 'unexplained',
    instanceId: inst.instanceId,
    cardId: '',
    name: UNEXPLAINED_SOURCE_NAME,
    zone: 'unknown',
  };
}

// --- layer 'face' and layer 1 (copy) ----------------------------------------------

/**
 * Rows for the two whole-definition swaps this engine performs: transforming to the
 * other face (CR 712.8a) and becoming a copy (CR 613.2 layer 1).
 *
 * These are the ONLY way a name, a type line, a colour or a mana cost ever changes
 * here, and they are attributable because the instance keeps the way back —
 * `printedDef` for the face that was up, `uncopiedDef` for the card it really is.
 * Without this, four of the characteristics Caleb asked about would render as "we
 * checked and nothing changed", which is false for every Clone on the board.
 */
function collectFaceAndCopyRows(inst: CardInstance, rows: CharacteristicContribution[]): void {
  const front = inst.printedDef;
  if (front != null) diffDefinitions(front, inst.def, 'face', sourceOf('self', inst), rows);
  const uncopied = inst.uncopiedDef;
  if (uncopied != null) diffDefinitions(uncopied, inst.def, 'copy', sourceOf('self', inst), rows);
}

/**
 * The characteristics a whole-definition swap can change, as a TABLE: each row is a
 * characteristic and the function that renders one definition's value for it.
 * Adding a characteristic to the swap is a ROW.
 *
 * P/T are included and emitted as `'replace'` rows — a copy states a base, it does
 * not add to one — so they are visible in the breakdown without entering the sum.
 */
const DEFINITION_CHARACTERISTICS: readonly {
  readonly characteristic: CharacteristicKind;
  readonly read: (def: CardDefinition) => string;
}[] = [
  { characteristic: 'name', read: (def) => def.name },
  { characteristic: 'types', read: (def) => def.types.join(' ') },
  { characteristic: 'subtypes', read: (def) => (def.subtypes ?? []).join(' ') },
  { characteristic: 'colors', read: (def) => colorsOfDefinition(def).join('') },
  { characteristic: 'manaCost', read: (def) => (def.cost === undefined ? '' : formatManaCost(def.cost)) },
  { characteristic: 'power', read: (def) => (def.power === undefined ? '' : String(def.power)) },
  { characteristic: 'toughness', read: (def) => (def.toughness === undefined ? '' : String(def.toughness)) },
];

/** One `'replace'` row per characteristic that actually differs between two definitions. */
function diffDefinitions(
  previous: CardDefinition,
  current: CardDefinition,
  layer: ContributionLayer,
  source: ContributionSource,
  rows: CharacteristicContribution[],
): void {
  for (const entry of DEFINITION_CHARACTERISTICS) {
    const was = entry.read(previous);
    const now = entry.read(current);
    if (was === now) continue;
    rows.push({
      characteristic: entry.characteristic,
      layer,
      mode: 'replace',
      detail: now,
      previous: was,
      source,
    });
  }
}

// --- layer 2 (control) ------------------------------------------------------------

/**
 * Rows for a control change.
 *
 * Control is NOT a layered read in this engine: `applyControlChange` writes
 * `CardInstance.controller` directly and records the previous controller on the
 * effect so expiry can hand it back. That record is what makes the change
 * attributable here.
 *
 * A permanent whose controller is not its owner with NO such record is reported as
 * an `'unexplained'` control change rather than not reported at all — it happens
 * (a blink drops the effect and keeps the theft), and "this is not yours and we
 * cannot say why" is the true statement.
 */
function collectControlRows(state: GameState, inst: CardInstance, rows: CharacteristicContribution[]): void {
  let attributed = false;
  for (const eff of state.continuous) {
    const change = eff.controlChange;
    if (change === undefined || change.instanceId !== inst.instanceId) continue;
    attributed = true;
    rows.push({
      characteristic: 'controller',
      layer: 'control',
      mode: 'replace',
      detail: change.to,
      previous: change.from,
      source: sourceById(state, 'temporary', eff.sourceInstanceId),
    });
  }
  if (!attributed && inst.controller !== inst.owner) {
    rows.push({
      characteristic: 'controller',
      layer: 'control',
      mode: 'replace',
      detail: inst.controller,
      previous: inst.owner,
      source: unexplainedSource(inst),
    });
  }
}

// --- layer 4 (type) ---------------------------------------------------------------

/**
 * The one type-line change the engine models on an instance: "as ~ enters, choose a
 * creature type", read back by `permanentHasSubtype`. A source that named nothing
 * adds nothing — the same matches-nothing rule the static filters use, never a
 * widening to "every type".
 */
function collectChosenSubtypeRow(inst: CardInstance, rows: CharacteristicContribution[]): void {
  if (inst.def.isChosenSubtype !== true) return;
  const chosen = chosenSubtypeOf(inst);
  if (chosen === undefined) return;
  rows.push({
    characteristic: 'subtypes',
    layer: 'type',
    mode: 'add',
    detail: chosen,
    source: sourceOf('self', inst),
  });
}

// --- CR 613.4 layer 7a (characteristic-defining P/T) ------------------------------

/**
 * The `*` box row. `'replace'`, not `'add'`: a characteristic-defining P/T states
 * the base that counters and pumps then modify, which is what makes the layering
 * right and what stops a 4/5 Tarmogoyf rendering as "0/0, +4/+5".
 *
 * Emitted ONLY when the aggregate actually carries a computed base — which is to
 * say, only for a permanent in play. `indexContinuous` evaluates a formula for
 * battlefield permanents and nothing else, and `effectivePower` answers 0 for a
 * `*` card read without one. Computing the formula here anyway would put a number
 * in the breakdown that the board does not show (rule 12: the headline and the
 * rows must have one answer, even when that answer is "this box has no value yet").
 */
function collectBasePTRow(
  inst: CardInstance,
  mod: AggregatedMod,
  rows: CharacteristicContribution[],
): void {
  const power = mod.basePower;
  const toughness = mod.baseToughness;
  if (power === undefined || toughness === undefined) return;
  const source = sourceOf('self', inst);
  rows.push(
    { characteristic: 'power', layer: 'basePT', mode: 'replace', amount: power, detail: String(power), source },
    {
      characteristic: 'toughness',
      layer: 'basePT',
      mode: 'replace',
      amount: toughness,
      detail: String(toughness),
      source,
    },
  );
}

// --- layer 3a (attachments) and 3b (statics) --------------------------------------

/**
 * Rows for every Aura / Equipment attached to this permanent.
 *
 * The `modificationIsInert` gate is the SAME one `applyAttachment` applies, read
 * from the same funnel rather than restated. That matters in both directions: a
 * modification the aggregation skips must not appear in the breakdown (a tooltip
 * promising a grant the board does not have is worse than no tooltip), and the day
 * the inertness rule changes, both paths change in one edit.
 */
function collectAttachmentRows(state: GameState, inst: CardInstance, rows: CharacteristicContribution[]): void {
  for (const attachment of state.battlefield) {
    if (attachment.attachedTo !== inst.instanceId) continue;
    const spec = attachment.def.attachment;
    const modifies = spec?.modifies;
    if (spec === undefined || modifies === undefined || modificationIsInert(modifies)) continue;
    pushModification(modifies, sourceOf('attachment', attachment, spec.label), rows);
  }
}

/**
 * Rows for every static ability that reaches this permanent — from the battlefield
 * and from BOTH command zones.
 *
 * The emblem half is not optional. `internal/continuous.ts` records that wiring
 * emblems into only the bulk path once made an emblem's anthem "real in combat and
 * invisible to a one-off read"; this walk is the THIRD reader of the same sources
 * and would under-report on exactly the boards the other two get right.
 */
function collectStaticRows(
  state: GameState,
  inst: CardInstance,
  mod: AggregatedMod,
  rows: CharacteristicContribution[],
): void {
  // Statics only reach permanents in play — the same rule `aggregateFor` states.
  if (inst.zone !== 'battlefield') return;
  eachStaticSource(state, (source, kind) => {
    for (const ability of staticsOf(source.def)) {
      if (staticIsInert(ability)) continue;
      if (!staticAppliesTo(ability, source, inst)) continue;
      pushStatic(ability, inst, mod, sourceOf(kind, source, ability.label), rows);
    }
  });
}

/**
 * Visit every object that radiates a static: the battlefield, then both command
 * zones (CR 114 — an emblem's anthem is the same continuous modification, differing
 * only in where its source sits).
 *
 * Written with the ordinary iterators the hot path deliberately avoids. That is a
 * considered difference, not an oversight: `indexContinuous` hand-rolls indexed
 * loops because it runs several times per action across thousands of games, and
 * this runs when a human hovers a card.
 */
function eachStaticSource(
  state: GameState,
  visit: (source: CardInstance, kind: ContributionSourceKind) => void,
): void {
  for (const perm of state.battlefield) {
    if (staticsOf(perm.def).length > 0) visit(perm, 'static');
  }
  for (const pid of PLAYER_IDS) {
    for (const object of state.players[pid].command) {
      if (staticsOf(object.def).length > 0) visit(object, 'emblem');
    }
  }
}

/**
 * One static's rows, honouring the ONE rule that makes the aggregation pass exact:
 * a static that reads a SETTLED value — in its selector ("power 2 or less") or in
 * the bound it grants (Champion of Lambholt's source-power block restriction) — is
 * applied against the settled numbers and may grant KEYWORDS ONLY.
 *
 * Both halves are imported from `internal/continuous.ts` rather than restated, so
 * the bound and the keywords-only rule have one answer (rule 12). Restating them
 * here would make an anthem lift a creature out of the selector on the board and
 * not in the tooltip.
 *
 * A COMPUTED bound is deliberately not reconstructed here: its value is the SOURCE'S
 * settled power, which this walk does not aggregate, so it falls through to the
 * reconciliation and reports as an unattributed grant rather than as a guessed one
 * (rule 2 — an honest refusal beats a silent approximation).
 */
function pushStatic(
  ability: StaticAbility,
  candidate: CardInstance,
  mod: AggregatedMod,
  source: ContributionSource,
  rows: CharacteristicContribution[],
): void {
  if (!readsSettledStats(ability)) {
    pushModification(ability, source, rows);
    return;
  }
  if (!withinEffectiveBounds(ability.affects, candidate, mod)) return;
  const keywords = ability.keywords;
  if (keywords === undefined) return;
  pushKeywordRows(keywords, 'ability', source, rows);
}

// --- layer 4 (until end of turn) --------------------------------------------------

/** Rows for every until-end-of-turn effect aimed at this permanent. */
function collectTemporaryRows(state: GameState, inst: CardInstance, rows: CharacteristicContribution[]): void {
  for (const eff of state.continuous) {
    if (eff.targetInstanceId !== inst.instanceId) continue;
    const source = sourceById(state, 'temporary', eff.sourceInstanceId);
    pushPTRows(eff.power, eff.toughness, source, rows);
    if (eff.keywords !== undefined) pushKeywordRows(eff.keywords, 'ability', source, rows);
    // `controlChange` is handled by `collectControlRows`, which also covers the
    // change whose effect has since been dropped. One funnel per characteristic.
  }
}

// --- CR 613.4 layer 7d (counters) -------------------------------------------------

/**
 * Rows for the counters that shift P/T.
 *
 * Counters never touch the continuous layer at all — `counterShift` reads them
 * straight off the instance inside `effectivePower` — so a breakdown built only
 * from continuous effects under-sums by exactly the counter shift on every creature
 * carrying one. From a player's point of view a counter and an anthem are the same
 * question, which is why they are rows here and not a separate concept.
 */
function collectCounterRows(inst: CardInstance, rows: CharacteristicContribution[]): void {
  for (const entry of PT_COUNTER_KINDS) {
    const count = inst.counters[entry.kind] ?? 0;
    if (count === 0) continue;
    const source: ContributionSource = {
      kind: 'counter',
      instanceId: inst.instanceId,
      cardId: inst.def.id,
      name: inst.def.name,
      zone: inst.zone,
    };
    pushPTRows(count * entry.power, count * entry.toughness, source, rows, 'counters', entry.kind);
  }
}

// --- shared row builders ----------------------------------------------------------

/**
 * Rows for one {@link PermanentModification} — the shape a static, an attachment
 * and (minus `activated`) a temporary effect all share. One builder, so an aura's
 * +1/+1 and an anthem's +1/+1 cannot be described two different ways.
 */
function pushModification(
  modifies: PermanentModification,
  source: ContributionSource,
  rows: CharacteristicContribution[],
): void {
  pushPTRows(modifies.power, modifies.toughness, source, rows);
  if (modifies.keywords !== undefined) pushKeywordRows(modifies.keywords, 'ability', source, rows);
  for (const ability of modifies.activated ?? []) {
    rows.push({
      characteristic: 'activatedAbility',
      layer: 'ability',
      mode: 'grant',
      detail: ability.label,
      source,
    });
  }
}

/** The `'add'` power/toughness rows for one source, skipping the zeroes. */
function pushPTRows(
  power: number | undefined,
  toughness: number | undefined,
  source: ContributionSource,
  rows: CharacteristicContribution[],
  layer: ContributionLayer = 'modifyPT',
  detail?: string,
): void {
  if (power !== undefined && power !== 0) {
    rows.push({ characteristic: 'power', layer, mode: 'add', amount: power, ...(detail !== undefined ? { detail } : {}), source });
  }
  if (toughness !== undefined && toughness !== 0) {
    rows.push({
      characteristic: 'toughness',
      layer,
      mode: 'add',
      amount: toughness,
      ...(detail !== undefined ? { detail } : {}),
      source,
    });
  }
}

/**
 * One row per keyword a grant actually sets.
 *
 * `detail` carries the raw `keyof KeywordFlags` key. A numeric payload (`ward 2`)
 * goes in `amount`; a list of plain strings (`protectionFrom`) goes in `values`; any
 * richer payload leaves both absent and the row names the keyword alone — an honest
 * refusal rather than an approximate rendering (rule 2).
 */
function pushKeywordRows(
  grant: KeywordFlags,
  layer: ContributionLayer,
  source: ContributionSource,
  rows: CharacteristicContribution[],
): void {
  for (const key of Object.keys(grant)) {
    const value = (grant as Record<string, unknown>)[key];
    if (value === undefined || value === false || value === null) continue;
    if (typeof value === 'number' && value === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const row: {
      characteristic: CharacteristicKind;
      layer: ContributionLayer;
      mode: ContributionMode;
      detail: string;
      amount?: number;
      values?: readonly string[];
      source: ContributionSource;
    } = { characteristic: 'keyword', layer, mode: 'grant', detail: key, source };
    if (typeof value === 'number') row.amount = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      row.values = value as readonly string[];
    }
    rows.push(row);
  }
}

// --- reconciliation: the honest-closure step --------------------------------------

/** The settled numbers a breakdown must add up to. */
interface SettledStats {
  readonly basePower: number;
  readonly baseToughness: number;
  readonly power: number;
  readonly toughness: number;
}

/**
 * Compare the breakdown against the effective values and emit an `'unexplained'`
 * row for anything the walk could not attribute.
 *
 * THIS IS THE POINT OF THE MODULE, not a safety net. Requirement 3 of the brief: a
 * characteristic the engine can modify but this walk cannot attribute must report
 * itself as changed-with-an-unknown-source, never be silently omitted and never be
 * guessed at — because a missing row reads to a player as "nothing changed it".
 *
 * It is also what stops this decaying. The compile-time tables above catch a new
 * field on `PermanentModification` or `ContinuousEffect`; this catches a new route
 * to the effective value that bypasses both — which is exactly what counters are,
 * and exactly what the next one will be.
 */
function reconcile(
  inst: CardInstance,
  mod: AggregatedMod,
  settled: SettledStats,
  rows: CharacteristicContribution[],
): void {
  const source = unexplainedSource(inst);

  let addedPower = 0;
  let addedToughness = 0;
  const namedKeywords = new Set<string>();
  const namedAbilities = new Map<string, number>();
  for (const row of rows) {
    if (row.mode === 'add' && row.amount !== undefined) {
      if (row.characteristic === 'power') addedPower += row.amount;
      else if (row.characteristic === 'toughness') addedToughness += row.amount;
    }
    if (row.characteristic === 'keyword' && row.detail !== undefined) namedKeywords.add(row.detail);
    if (row.characteristic === 'activatedAbility' && row.detail !== undefined) {
      namedAbilities.set(row.detail, (namedAbilities.get(row.detail) ?? 0) + 1);
    }
  }

  const powerResidue = settled.power - (settled.basePower + addedPower);
  if (powerResidue !== 0) {
    rows.push({ characteristic: 'power', layer: 'unknown', mode: 'add', amount: powerResidue, source });
  }
  const toughnessResidue = settled.toughness - (settled.baseToughness + addedToughness);
  if (toughnessResidue !== 0) {
    rows.push({ characteristic: 'toughness', layer: 'unknown', mode: 'add', amount: toughnessResidue, source });
  }

  // `mod.keywords` IS the granted set — everything the layers added on top of the
  // printed box. Every key in it must have been named by some row.
  for (const key of Object.keys(mod.keywords)) {
    const value = (mod.keywords as Record<string, unknown>)[key];
    if (value === undefined || value === false || value === null) continue;
    if (namedKeywords.has(key)) continue;
    rows.push({ characteristic: 'keyword', layer: 'unknown', mode: 'grant', detail: key, source });
  }

  for (const ability of mod.activated ?? []) {
    const remaining = namedAbilities.get(ability.label) ?? 0;
    if (remaining > 0) {
      namedAbilities.set(ability.label, remaining - 1);
      continue;
    }
    rows.push({
      characteristic: 'activatedAbility',
      layer: 'unknown',
      mode: 'grant',
      detail: ability.label,
      source,
    });
  }
}
