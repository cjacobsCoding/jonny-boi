/**
 * **"YOU MAY &lt;do something to&gt; TARGET &lt;thing&gt;" — asked in that order** (pure,
 * DOM-free, unit-tested). §3.143 / UX-6, UX-7.
 *
 * ## What the engine does, and why it is right
 *
 * CR 603.3d chooses a triggered ability's targets **as it goes on the stack**;
 * CR 608.2 settles a printed "you may" **when the ability resolves**. So the
 * engine genuinely asks target-first, may-second, and a client that reversed the
 * SUBMISSION order would be lying about the game — the target is locked in
 * before the opponent may respond, which is a real difference and not a cosmetic
 * one. The engine is correct and stays untouched.
 *
 * What is free is the **presentation** order. So the board asks the player the
 * "may" FIRST, in one prompt, and reveals the target picker only on a yes —
 * submitting nothing to the engine until the player confirms. Backing out of the
 * target step is therefore free and idempotent (UX-7), because nothing has been
 * sent. On a decline the board submits the engine's own default target answer
 * and REMEMBERS the no; when the engine finally parks the "may" a priority round
 * later, the remembered answer settles it with no second modal.
 *
 * ⚠️ **The remembered answer is the whole fix, and its absence was the bug.**
 * The previous version answered the target and then read `session.pendingChoice`
 * SYNCHRONOUSLY, on a comment that asserted the follow-up would already be
 * there. It is not: the trigger is on the stack and needs a full priority round
 * before it resolves and asks. Measured on the real engine (see
 * `optional-trigger.test.ts`, "the engine parks the may a priority round
 * later") — `pendingChoice` is `null` at that moment, every time, so the fold
 * never fired on any of the 24 pool cards it was written for. Hence
 * {@link DeferredMayLedger}, which survives the priority round.
 *
 * ## The signal is DATA, never the prompt's wording
 *
 * A gate qualifies because the compiled ability references a primitive in
 * {@link OPTIONAL_GATE_SHAPES} — which is exactly what a printed "you may"
 * compiles to. Sniffing the label for the words "you may" would break on the
 * next card that phrases it differently and would fire on a card that merely
 * mentions them.
 *
 * ## The table is CLOSED, and a shape outside it REPORTS
 *
 * Sixteen rows, one per primitive in `@jonny-boi/cards` that stops the game to
 * ask (derived from the primitive SOURCE — see the sweep in the test, which
 * fails if a new asking primitive appears with no row). A primitive that is not
 * a row is not a gate: {@link foldedMayPrompt} returns `null` and the board
 * falls back to the engine's own ordering. That refusal is the design. Widening
 * an unknown shape to the nearest one that happens to exist would fold a
 * question the player must actually answer.
 */
import {
  restrictionOfEffects,
  type CardDefinition,
  type EffectRef,
  type InstanceId,
  type PendingChoice,
  type PlayerId,
  type TargetSpec,
} from '@jonny-boi/core';

// ---------------------------------------------------------------------------
// 1. The closed table of gate shapes
// ---------------------------------------------------------------------------

/**
 * What a gate's NO actually means — the reason three different "optional"
 * primitives must not share one rule.
 *
 * - `'may'` — the body simply does not happen. This is Caleb's class, and the
 *   only one the prompt folds.
 * - `'unless'` — declining has a PRINTED consequence (a Pact kills you, ward
 *   counters the spell, cumulative upkeep sacrifices the permanent). Declining
 *   is a real decision with its own stakes and is never folded into a target
 *   prompt, because "don't use it" would be a lie about what happens next.
 * - `'mode'` — the confirm picks between two outcomes, NEITHER of which is
 *   "nothing" (riot: haste or a +1/+1 counter; unleash; fabricate). There is no
 *   "don't" to offer.
 */
export type GateSemantics = 'may' | 'unless' | 'mode';

/** The closed vocabulary, exported so a consumer can iterate it. */
export const GATE_SEMANTICS: readonly GateSemantics[] = Object.freeze(['may', 'unless', 'mode']);

/** The kind of `PendingChoice` a gate raises when the game reaches it. */
export type GateQuestion = 'confirm' | 'payMana' | 'payLife';

/** One row of {@link OPTIONAL_GATE_SHAPES}. */
export interface OptionalGateShape {
  /**
   * The `params` keys holding the gated effect refs, in run order. Empty means
   * the gate is self-contained (its body is inside the primitive, not in data),
   * which is why such a gate can never be shown to consume the source's target.
   */
  readonly bodyParams: readonly string[];
  /**
   * A `params` key that must be exactly `true` for the gate to exist at all.
   * `searchLibrary` is a search whether or not it asks; only `optional: true`
   * makes it a question.
   */
  readonly enabledByParam?: string;
  readonly question: GateQuestion;
  readonly semantics: GateSemantics;
  /** Why this row has this semantics — the sentence a reviewer would ask for. */
  readonly why: string;
}

/**
 * Every primitive in `@jonny-boi/cards` that STOPS THE GAME TO ASK, measured
 * from the primitive source rather than remembered: 101 `EffectPrimitive`
 * declarations scanned, 16 of them call `ctx.confirm` / `ctx.payOrDecline` /
 * `ctx.payLifeOrDecline`. The test re-runs that scan and fails in BOTH
 * directions (an asking primitive with no row; a row naming a primitive that no
 * longer asks), so the table cannot rot silently.
 *
 * Only four of the sixteen were reached by any card in the pool as measured at
 * 5,651 cards AT THE TIME
 * (`mayEffects` 90, `payManaOrElse` 49, `counterUnlessPaid` 28, `mayCostEffects`
 * 16, `cumulativeUpkeep` 13, `mayShuffleLibrary` 3, `searchLibrary{optional}` 1
 * — 200 gate instances in all). The other rows are written anyway BECAUSE they
 * are unreached: a pool-only audit could never have seen them, and the day a
 * card reaches one it must already be classified rather than guessed at.
 */
export const OPTIONAL_GATE_SHAPES: Readonly<Record<string, OptionalGateShape>> = Object.freeze({
  mayEffects: {
    bodyParams: ['effects'],
    question: 'confirm',
    semantics: 'may',
    why: 'The printed words "you may" — the body runs only on a yes, and declining does nothing else.',
  },
  mayCostEffects: {
    bodyParams: ['cost', 'effects'],
    question: 'confirm',
    semantics: 'may',
    why: '"You may <pay>. If you do, <payoff>." Declining costs nothing; the whole clause is skipped.',
  },
  mayShuffleLibrary: {
    bodyParams: [],
    question: 'confirm',
    semantics: 'may',
    why: '"You may shuffle your library" — a complete clause on its own with no consequence for declining.',
  },
  searchLibrary: {
    bodyParams: [],
    enabledByParam: 'optional',
    question: 'confirm',
    semantics: 'may',
    why: 'A search asks only when the card prints "you may search"; without `optional` it is mandatory and asks nothing.',
  },
  revealTopDrawIf: {
    bodyParams: [],
    enabledByParam: 'optional',
    question: 'confirm',
    semantics: 'may',
    why: '"You may reveal the top card…" — the reveal itself is the optional act.',
  },
  ripple: {
    bodyParams: [],
    question: 'confirm',
    semantics: 'may',
    why: '"You may reveal the top N cards" (CR 702.61a) — declining ends the ripple and nothing else happens.',
  },
  learn: {
    bodyParams: [],
    question: 'confirm',
    semantics: 'may',
    why: '"You may discard a card, then draw a card" — the whole learn is declinable at no cost.',
  },
  explore: {
    bodyParams: [],
    question: 'confirm',
    semantics: 'may',
    why: 'The keep-or-bin half of explore is a free choice between two legal outcomes with no penalty.',
  },
  fabricateChoice: {
    bodyParams: [],
    question: 'confirm',
    semantics: 'mode',
    why: 'Counters OR servo tokens — both are something, so there is no "don\'t" to offer.',
  },
  riotChoice: {
    bodyParams: [],
    question: 'confirm',
    semantics: 'mode',
    why: 'Haste OR a +1/+1 counter (CR 702.135a) — a pick between two outcomes, never nothing.',
  },
  unleashChoice: {
    bodyParams: [],
    question: 'confirm',
    semantics: 'mode',
    why: 'Enter with a +1/+1 counter and unable to block, or without — two real boards, not an opt-out.',
  },
  payManaOrElse: {
    bodyParams: ['effects'],
    question: 'payMana',
    semantics: 'unless',
    why: '"Unless you pay…" — declining triggers the printed else-clause, so the no is not free.',
  },
  counterUnlessPaid: {
    bodyParams: [],
    question: 'payMana',
    semantics: 'unless',
    why: 'Declining counters the spell. A "don\'t use it" button over that would be a lie.',
  },
  wardCounterUnlessPaid: {
    bodyParams: [],
    question: 'payMana',
    semantics: 'unless',
    why: 'Ward (CR 702.21) counters the targeting spell on a decline — a consequence, not an opt-out.',
  },
  cumulativeUpkeep: {
    bodyParams: [],
    question: 'payMana',
    semantics: 'unless',
    why: 'Declining sacrifices the permanent (CR 702.24a).',
  },
  payLifeOrElse: {
    bodyParams: [],
    question: 'payLife',
    semantics: 'unless',
    why: 'The life-paying half of the same "unless you pay" shape — the else-clause still happens.',
  },
});

/** Whether a primitive id has a row. A `false` here is a REPORT, not a gap. */
export function isTabulatedGate(primitive: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPTIONAL_GATE_SHAPES, primitive);
}

// ---------------------------------------------------------------------------
// 2. Where a gate can hide — every ability source a definition prints
// ---------------------------------------------------------------------------

/**
 * The ability sources this module walks. The list is the answer to "where could
 * a gate hide?", so it is enumerated once and read by both the scan and the
 * guard test — a new holder added for one is understood by the other in the
 * same edit.
 */
export type AbilitySourceKind =
  | 'spell'
  | 'spellMode'
  | 'trigger'
  | 'triggerMode'
  | 'activated'
  | 'castTrigger'
  | 'cycling'
  | 'graveyardAbility'
  | 'suspendUpkeep'
  | 'alternativeCostRider';

/** The closed vocabulary, in the order {@link abilitySourcesOf} emits them. */
export const ABILITY_SOURCE_KINDS: readonly AbilitySourceKind[] = Object.freeze([
  'spell',
  'spellMode',
  'trigger',
  'triggerMode',
  'activated',
  'castTrigger',
  'cycling',
  'graveyardAbility',
  'suspendUpkeep',
  'alternativeCostRider',
]);

/**
 * How {@link abilitySourcesOf} treats one `CardDefinition` field.
 *
 * - `'scanned'` — its effect refs are enumerated as ability sources.
 * - `'noEffectRefs'` — its declared type cannot reach an `EffectRef` at all.
 * - `'otherObject'` — it DOES carry effect refs, but at runtime they belong to a
 *   different object (a static's granted ability lives on the permanent it is
 *   granted to; an attachment's modification lives on the attached permanent),
 *   so they are not this definition's own asking sources.
 * - `'otherFace'` — a whole other `CardDefinition`. The board passes the def of
 *   the face that is actually live, so walking the other face would enumerate
 *   abilities the object does not have.
 */
export type AbilityFieldTreatment = 'scanned' | 'noEffectRefs' | 'otherObject' | 'otherFace';

/**
 * **The class guard, enforced by the compiler.** A mapped type over
 * `keyof Required<CardDefinition>`: add a field to core's card record and this
 * file stops `tsc` until someone says whether a gate could hide in it. That is
 * the whole shape of the UX-6 bug — a scan that looked at `def.triggers` and
 * nowhere else — expressed so it cannot recur silently.
 *
 * It lives in shipped source, not in a test, deliberately: `tsconfig` excludes
 * `*.test.ts` and Vitest strips types, so a compile-time proof written in a test
 * is never evaluated.
 */
export const CARD_DEFINITION_FIELD_SCAN: {
  readonly [K in keyof Required<CardDefinition>]: AbilityFieldTreatment;
} = Object.freeze({
  // --- the effect-bearing fields ---
  effects: 'scanned',
  modal: 'scanned',
  triggers: 'scanned',
  activated: 'scanned',
  castTriggers: 'scanned',
  cycling: 'scanned',
  graveyardAbilities: 'scanned',
  suspend: 'scanned',
  alternativeCosts: 'scanned',
  // --- effect refs that belong to another object or another face ---
  statics: 'otherObject',
  attachment: 'otherObject',
  backFace: 'otherFace',
  frontFace: 'otherFace',
  // --- everything else: no EffectRef is reachable from the declared type ---
  id: 'noEffectRefs',
  name: 'noEffectRefs',
  types: 'noEffectRefs',
  subtypes: 'noEffectRefs',
  colors: 'noEffectRefs',
  basic: 'noEffectRefs',
  cost: 'noEffectRefs',
  noManaCost: 'noEffectRefs',
  xCost: 'noEffectRefs',
  kicker: 'noEffectRefs',
  multikicker: 'noEffectRefs',
  power: 'noEffectRefs',
  toughness: 'noEffectRefs',
  characteristicPT: 'noEffectRefs',
  loyalty: 'noEffectRefs',
  defense: 'noEffectRefs',
  legendary: 'noEffectRefs',
  changeling: 'noEffectRefs',
  cantBeCountered: 'noEffectRefs',
  spellsCantBeCountered: 'noEffectRefs',
  noMaximumHandSize: 'noEffectRefs',
  playLandsFrom: 'noEffectRefs',
  isEmblem: 'noEffectRefs',
  isToken: 'noEffectRefs',
  keywords: 'noEffectRefs',
  produces: 'noEffectRefs',
  producesOptions: 'noEffectRefs',
  manaAbilities: 'noEffectRefs',
  entersTapped: 'noEffectRefs',
  entersTappedUnless: 'noEffectRefs',
  entersTappedUnlessLifePaid: 'noEffectRefs',
  additionalLandPlays: 'noEffectRefs',
  castCostReduction: 'noEffectRefs',
  costAssist: 'noEffectRefs',
  castCostReductionPerPermanent: 'noEffectRefs',
  entersTappedUnlessRevealed: 'noEffectRefs',
  copyAsEnters: 'noEffectRefs',
  asEntersChoice: 'noEffectRefs',
  isChosenSubtype: 'noEffectRefs',
  timing: 'noEffectRefs',
  flashback: 'noEffectRefs',
  flashbackXCost: 'noEffectRefs',
  flashbackLifeCost: 'noEffectRefs',
  flashbackAdditionalCost: 'noEffectRefs',
  // A graveyard CAST is a permission plus a cost; the spell it casts runs
  // `effects`, which is already scanned.
  graveyardCasts: 'noEffectRefs',
  buyback: 'noEffectRefs',
  additionalCost: 'noEffectRefs',
  madness: 'noEffectRefs',
  entersWithCounters: 'noEffectRefs',
  entwine: 'noEffectRefs',
  foretell: 'noEffectRefs',
  plot: 'noEffectRefs',
  // Measured, not assumed: `ReplacementAbility` is `{event, applies, outcome}`
  // and `packages/core/src/replacement.ts` contains no `EffectRef` at all, so a
  // replacement effect structurally cannot hold a gate.
  replacements: 'noEffectRefs',
  isBackFace: 'noEffectRefs',
  backFaceCastable: 'noEffectRefs',
  backFaceCastZones: 'noEffectRefs',
  backFaceFreeCast: 'noEffectRefs',
  adventure: 'noEffectRefs',
});

/** One ability source: a list of effect refs plus what the engine will aim it at. */
export interface AbilitySource {
  readonly kind: AbilitySourceKind;
  readonly label: string;
  readonly effects: readonly EffectRef[];
  /**
   * The restriction the ENGINE will park a target question for, when there is
   * one. Read from the source's own declaration where it has one (a trigger and
   * a spell mode both declare `targets`), otherwise from core's own
   * `restrictionOfEffects` — never from a second reader of our own.
   */
  readonly targets?: TargetSpec;
  /** How many targets the engine will demand; 0 when the source aims at nothing. */
  readonly targetMin: number;
}

const NO_SOURCES: readonly AbilitySource[] = Object.freeze([]);

/**
 * Memoised per definition. Card definitions are immutable and shared across
 * every instance in every game, so the walk is done once — the same argument
 * `targeting.ts`'s `RESTRICTION_MEMO` makes, and the reason this is safe to call
 * from a render pass.
 */
const SOURCE_MEMO = new WeakMap<CardDefinition, readonly AbilitySource[]>();

/** Every ability source `def` prints, in {@link ABILITY_SOURCE_KINDS} order. */
export function abilitySourcesOf(def: CardDefinition | undefined | null): readonly AbilitySource[] {
  if (!def) return NO_SOURCES;
  const memoized = SOURCE_MEMO.get(def);
  if (memoized) return memoized;
  const out: AbilitySource[] = [];
  const add = (
    kind: AbilitySourceKind,
    label: string,
    effects: readonly EffectRef[] | undefined,
    targets: TargetSpec | undefined,
    targetMin: number | undefined,
  ): void => {
    const refs = effects ?? [];
    if (refs.length === 0) return;
    // A source with no declared restriction may still aim: core reads the
    // narrowest declared `targets` param off the refs themselves, which is
    // exactly what it will validate the cast/aim against.
    const aim = targets ?? restrictionOfEffects(refs);
    out.push({
      kind,
      label,
      effects: refs,
      targets: aim,
      targetMin: aim === undefined ? 0 : (targetMin ?? SINGLE_TARGET),
    });
  };

  add('spell', def.name, def.effects, undefined, undefined);
  for (const mode of def.modal?.modes ?? []) add('spellMode', mode.label, mode.effects, mode.targets, undefined);
  for (const trigger of def.triggers ?? []) {
    add('trigger', trigger.label ?? def.name, trigger.effects, trigger.targets, trigger.targetCount?.min);
    for (const mode of trigger.modal?.modes ?? []) {
      add('triggerMode', mode.label, mode.effects, mode.targets, undefined);
    }
  }
  for (const ability of def.activated ?? []) add('activated', ability.label, ability.effects, undefined, undefined);
  for (const trigger of def.castTriggers ?? []) {
    add('castTrigger', trigger.label, trigger.effects, undefined, undefined);
  }
  for (const ability of def.cycling ?? []) add('cycling', ability.label, ability.effects, undefined, undefined);
  for (const ability of def.graveyardAbilities ?? []) {
    add('graveyardAbility', ability.label, ability.effects, undefined, undefined);
  }
  add('suspendUpkeep', SUSPEND_UPKEEP_LABEL, def.suspend?.upkeep, undefined, undefined);
  for (const alternative of Object.values(def.alternativeCosts ?? {})) {
    for (const rider of alternative?.riders ?? []) {
      add('alternativeCostRider', rider.label, rider.effects, undefined, undefined);
    }
  }

  const frozen = Object.freeze(out);
  SOURCE_MEMO.set(def, frozen);
  return frozen;
}

/** A trigger with no printed `targetCount` aims at exactly one thing. */
const SINGLE_TARGET = 1;

/** Suspend's upkeep trigger prints no label of its own. */
const SUSPEND_UPKEEP_LABEL = 'suspend upkeep';

// ---------------------------------------------------------------------------
// 3. The recursive scan
// ---------------------------------------------------------------------------

/** One gate found somewhere in an effect tree. */
export interface FoundGate {
  readonly primitive: string;
  readonly shape: OptionalGateShape;
  /** 0 = a top level ref of the source's own effects list. */
  readonly depth: number;
  /**
   * Whether the gate's BODY is what consumes the source's target — the printed
   * shape "you may &lt;do X to&gt; target Y".
   *
   * This is the distinction that makes the fold safe. A RIDER — "Deal 6 damage
   * to target creature. You may discard a card. If you do, draw a card"
   * (Incinerating Blast) — has a target AND a may, but the may is a separate
   * printed sentence and is already asked in the right order. Folding it would
   * suppress a question the player must answer. So is Path to Exile, whose "may"
   * belongs to the OPPONENT, not the caster.
   */
  readonly gatesTheTarget: boolean;
}

/** Every effect-ref list reachable from one ref's params, with its param key. */
function nestedRefLists(ref: EffectRef): readonly { readonly key: string; readonly refs: readonly EffectRef[] }[] {
  const out: { key: string; refs: readonly EffectRef[] }[] = [];
  for (const [key, value] of Object.entries(ref.params ?? {})) {
    if (Array.isArray(value) && value.every(isEffectRef)) {
      out.push({ key, refs: value as readonly EffectRef[] });
    } else if (isEffectRef(value)) {
      out.push({ key, refs: [value] });
    }
  }
  return out;
}

function isEffectRef(value: unknown): value is EffectRef {
  return typeof value === 'object' && value !== null && typeof (value as EffectRef).primitive === 'string';
}

/**
 * The restriction an effect TREE aims at, searched depth-first. Each level's
 * answer is core's own `restrictionOfEffects` — one answer to one question, so a
 * restriction core stops enforcing is understood here in the same edit. The
 * recursion is what core's reader deliberately does not do (it only needs the
 * top level, because that is what it validates a cast against) and what this
 * does need: a gate's body is one level down by construction.
 */
function deepRestriction(refs: readonly EffectRef[]): TargetSpec | undefined {
  const here = restrictionOfEffects(refs);
  if (here !== undefined) return here;
  for (const ref of refs) {
    for (const { refs: nested } of nestedRefLists(ref)) {
      const found = deepRestriction(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The effect refs that make up a gate's body, in run order. */
function gateBody(ref: EffectRef, shape: OptionalGateShape): readonly EffectRef[] {
  const out: EffectRef[] = [];
  for (const key of shape.bodyParams) {
    const value = ref.params?.[key];
    if (Array.isArray(value)) out.push(...(value.filter(isEffectRef) as EffectRef[]));
    else if (isEffectRef(value)) out.push(value);
  }
  return out;
}

/**
 * Walk an effect tree and report every tabulated gate in it, at any depth, from
 * any source kind. `aim` is the restriction the engine will ask the source's
 * target question for (absent when the source aims at nothing), and is what
 * decides {@link FoundGate.gatesTheTarget}.
 *
 * MEASURED against the pool at 5,651 cards AT THE TIME: every one of the 200 gate instances
 * sits at depth 0. The recursion is written anyway, because "it happens to be
 * flat today" is exactly the assumption the previous version encoded and was
 * bitten by.
 */
export function findOptionalGates(
  effects: readonly EffectRef[],
  aim?: TargetSpec,
): readonly FoundGate[] {
  const out: FoundGate[] = [];
  const walk = (refs: readonly EffectRef[], depth: number): void => {
    for (const ref of refs) {
      const shape = OPTIONAL_GATE_SHAPES[ref.primitive];
      if (shape !== undefined && gateIsEnabled(ref, shape)) {
        const body = gateBody(ref, shape);
        out.push({
          primitive: ref.primitive,
          shape,
          depth,
          gatesTheTarget: aim !== undefined && body.length > 0 && deepRestriction(body) === aim,
        });
      }
      for (const { refs: nested } of nestedRefLists(ref)) walk(nested, depth + 1);
    }
  };
  walk(effects, 0);
  return out;
}

/** A gate whose `enabledByParam` is not exactly `true` is not a question at all. */
function gateIsEnabled(ref: EffectRef, shape: OptionalGateShape): boolean {
  if (shape.enabledByParam === undefined) return true;
  return ref.params?.[shape.enabledByParam] === true;
}

// ---------------------------------------------------------------------------
// 4. The prompt decision
// ---------------------------------------------------------------------------

/** The copy the folded prompt uses, named so it is data rather than literals. */
export const FOLD_COPY = Object.freeze({
  accept: (source: string): string => `Yes — use ${source}`,
  decline: (source: string): string => `No — don’t use ${source}`,
  back: 'Change my mind',
  fallbackPrompt: (source: string): string => `Use ${source}?`,
});

/** What a folded "may" prompt asks, before any target has been offered. */
export interface FoldedMayPrompt {
  /** Which kind of ability raised it — for the prompt's own framing and for tests. */
  readonly sourceKind: AbilitySourceKind;
  /** The gating primitive, so a consumer can say WHY a fold happened. */
  readonly primitive: string;
  /**
   * The printed "you may …" wording, taken from the card's own compiled prompt.
   * This is what the player is asked FIRST — the whole point of UX-6.
   */
  readonly mayPrompt: string;
  readonly acceptLabel: string;
  readonly declineLabel: string;
  /** The label for going back from the target step to the question (UX-7). */
  readonly backLabel: string;
}

/**
 * The folded prompt for a parked choice, or `null` to use the engine's ordering.
 *
 * Non-null only when EVERY conjunct holds:
 *  - the question is `selectTargets` (the only kind whose order can be wrong);
 *  - `choice.min > 0`. A min-0 "up to" already renders its own "Choose none",
 *    and choosing none for "you may exile up to three target creatures" still
 *    RESOLVES the may — a different answer from declining it. Folding them would
 *    be the silent approximation rule 2 forbids. (Measured: 0 pool cards have a
 *    min-0 target choice behind a may, so this exclusion costs nothing today;
 *    the reason to keep it is semantic, and a test pins the count at zero so
 *    that if the pool grows one, someone re-decides rather than inherits.)
 *  - exactly ONE source of `sourceDef` carries a `'may'`-semantics gate whose
 *    body consumes that source's target. Two such gates would make it ambiguous
 *    which question the fold answers, so the fold REFUSES rather than guessing.
 *
 * `sourceDef` is the definition of the object that asked, looked up by the
 * caller from `choice.sourceInstanceId` — only the board can resolve an
 * instance id. Pass `undefined` for a source the board cannot find (a token, an
 * emblem, an online view) and the answer is an honest `null`.
 */
export function foldedMayPrompt(
  choice: PendingChoice,
  sourceDef: CardDefinition | undefined | null,
): FoldedMayPrompt | null {
  if (choice.kind !== 'selectTargets' || choice.min === 0) return null;
  const hits: { source: AbilitySource; gate: FoundGate; ref: EffectRef }[] = [];
  for (const source of abilitySourcesOf(sourceDef)) {
    if (source.targets === undefined || source.targetMin === 0) continue;
    if (source.targets !== choice.restriction) continue;
    for (const gate of findOptionalGates(source.effects, source.targets)) {
      if (gate.shape.semantics !== 'may' || !gate.gatesTheTarget) continue;
      const ref = findGateRef(source.effects, gate.primitive);
      if (ref) hits.push({ source, gate, ref });
    }
  }
  if (hits.length !== 1) return null; // 0 = not this shape; >1 = ambiguous, so REPORT
  const hit = hits[0] as { source: AbilitySource; gate: FoundGate; ref: EffectRef };
  const printed = hit.ref.params?.['prompt'];
  return {
    sourceKind: hit.source.kind,
    primitive: hit.gate.primitive,
    mayPrompt: typeof printed === 'string' && printed.length > 0 ? printed : FOLD_COPY.fallbackPrompt(choice.sourceName),
    acceptLabel: FOLD_COPY.accept(choice.sourceName),
    declineLabel: FOLD_COPY.decline(choice.sourceName),
    backLabel: FOLD_COPY.back,
  };
}

/** The first ref naming `primitive`, at any depth — for its printed `prompt`. */
function findGateRef(refs: readonly EffectRef[], primitive: string): EffectRef | undefined {
  for (const ref of refs) {
    if (ref.primitive === primitive) return ref;
    for (const { refs: nested } of nestedRefLists(ref)) {
      const found = findGateRef(nested, primitive);
      if (found) return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 5. The deferred-answer ledger — what survives the priority round
// ---------------------------------------------------------------------------

/**
 * One "may" the player settled while aiming, waiting for the engine to ask it.
 *
 * It must survive the PRIORITY ROUND between the target question (asked as the
 * trigger goes on the stack) and the trigger's resolution (where the may is
 * asked). A synchronous read of the next `pendingChoice` does not — that was the
 * bug.
 */
export interface DeferredMayAnswer {
  readonly sourceInstanceId: InstanceId;
  /**
   * The targets submitted for this trigger. The discriminator when ONE permanent
   * has TWO triggers waiting — Aura Shards puts two triggers on the stack when
   * two creatures enter together, and a source-keyed FIFO would apply the first
   * trigger's answer to the second trigger's question.
   */
  readonly targets: readonly (InstanceId | PlayerId)[];
  readonly yes: boolean;
  /** The turn the entry was made on. An entry never outlives its turn. */
  readonly turnNumber: number;
}

export type DeferredMayLedger = readonly DeferredMayAnswer[];

/** The shared empty ledger — one frozen object, so an idle board allocates nothing. */
export const EMPTY_MAY_LEDGER: DeferredMayLedger = Object.freeze([]);

/** Remember an answer. */
export function recordDeferredMay(ledger: DeferredMayLedger, entry: DeferredMayAnswer): DeferredMayLedger {
  return Object.freeze([...ledger, entry]);
}

/**
 * Drop every entry not made this turn.
 *
 * The bound matters: a trigger whose target became illegal is removed from the
 * stack and never asks, so its entry would otherwise sit in the ledger forever
 * waiting for a question that is not coming. A turn is the right granularity
 * because every trigger that was aimed this turn either resolves or leaves the
 * stack within it.
 */
export function expireDeferredMay(ledger: DeferredMayLedger, turnNumber: number): DeferredMayLedger {
  if (ledger.every((entry) => entry.turnNumber === turnNumber)) return ledger;
  return Object.freeze(ledger.filter((entry) => entry.turnNumber === turnNumber));
}

/**
 * The engine's own bookmark for the resolution now in flight, narrowed to the
 * two fields this needs.
 *
 * Narrowed on purpose: `PendingChoice` deliberately carries the SOURCE PERMANENT
 * and not the stack object (engine.ts says so — "it is what a UI draws and what
 * the log names"), so `state.resolution` is the only handle that can pair a
 * parked confirm with the exact ability that raised it. The ONLINE board's
 * masked view carries no resolution frame at all; typing this structurally lets
 * it pass `null` and get an honest refusal instead of a guess.
 */
export interface ResolvingAbility {
  readonly sourceInstanceId?: InstanceId;
  readonly targets?: readonly (InstanceId | PlayerId)[];
}

/** A ledger hit: which entry, and what it said. */
export interface DeferredMayHit {
  readonly index: number;
  readonly yes: boolean;
}

/**
 * The already-settled answer for this parked confirm, or `null`.
 *
 * The match rule is stated because it is load-bearing: the source instance must
 * agree AND the resolution frame's targets must equal the entry's, in order.
 * Among equal matches the LAST recorded wins — the engine aims pending triggers
 * from the BOTTOM of the stack up (`aimPendingTriggers` takes the lowest
 * `awaitingTargets` index) and resolves from the TOP down (`stack.pop()`), so
 * answers pair in reverse.
 *
 * Returns `null` whenever `resolving` is absent: no frame, no honest pairing.
 * Falling back to a source-only match would hand one trigger's answer to
 * another, which is worse than asking the player again.
 */
export function matchDeferredMay(
  ledger: DeferredMayLedger,
  choice: PendingChoice,
  resolving: ResolvingAbility | null | undefined,
): DeferredMayHit | null {
  if (choice.kind !== 'confirm') return null;
  if (!resolving || resolving.sourceInstanceId === undefined) return null;
  if (choice.sourceInstanceId !== resolving.sourceInstanceId) return null;
  const frameTargets = resolving.targets ?? [];
  for (let index = ledger.length - 1; index >= 0; index--) {
    const entry = ledger[index] as DeferredMayAnswer;
    if (entry.sourceInstanceId !== resolving.sourceInstanceId) continue;
    if (!sameTargets(entry.targets, frameTargets)) continue;
    return { index, yes: entry.yes };
  }
  return null;
}

/** Remove a used entry. An answer is spent once, never re-applied. */
export function consumeDeferredMay(ledger: DeferredMayLedger, index: number): DeferredMayLedger {
  if (index < 0 || index >= ledger.length) return ledger;
  return Object.freeze(ledger.filter((_, at) => at !== index));
}

/** Target lists are ORDERED answers, so order is part of the identity. */
function sameTargets(
  a: readonly (InstanceId | PlayerId)[],
  b: readonly (InstanceId | PlayerId)[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
