/**
 * Card model SEAM. Core defines the minimal interfaces it needs to resolve cards;
 * package `cards` (§3.2) owns the actual card pool and the effect-primitive
 * *implementations*. The split:
 *
 *   - A **CardDefinition** is immutable data: cost, types, P/T, keyword flags, and
 *     an opaque ordered list of effect references. Core never hard-codes a card.
 *   - An **effect reference** (`EffectRef`) names a primitive by id plus a params
 *     blob. Core looks the id up in the **EffectRegistry** (which `cards` populates)
 *     and runs it against an **EffectContext**. Unknown id → safe no-op + event.
 *   - A **PermanentInstance** is the runtime object on the battlefield: a reference
 *     to its definition plus mutable per-object state (tapped, sick, damage, …).
 *
 * Composition over inheritance: there is no class-per-card-type. A "creature" is
 * just a definition whose `types` includes `'creature'`.
 */

import type { ManaColor, ManaCost, ManaProduction } from './mana.js';
import { MANA_COLORS } from './mana.js';

/** Broad card types core needs to enforce timing and zone transitions. */
export type CardType = 'land' | 'creature' | 'instant' | 'sorcery' | 'artifact' | 'enchantment' | 'planeswalker';

/**
 * Keyword ability flags the combat/turn systems read as data. Core implements the
 * pure-combat keywords; broader-system keywords are present as flags so `cards`
 * can author them now, with engine hooks landing later.
 */
export interface KeywordFlags {
  readonly flying?: boolean;
  readonly vigilance?: boolean;
  readonly haste?: boolean;
  readonly firstStrike?: boolean;
  readonly doubleStrike?: boolean;
  readonly deathtouch?: boolean;
  readonly trample?: boolean;
  readonly reach?: boolean;
  readonly defender?: boolean;
  readonly lifelink?: boolean;
}

/**
 * A reference to an effect primitive: an id resolved against the EffectRegistry,
 * plus an opaque params bag the primitive interprets. Core treats params as
 * unknown data — only the primitive (owned by `cards`) knows its shape.
 */
export interface EffectRef {
  readonly primitive: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** When a spell/ability may legally be cast/activated. */
export type CastTiming = 'sorcery' | 'instant';

/**
 * Immutable card data. Authored by `cards` as plain records; core only reads it.
 * `power`/`toughness` are present only for creatures. `produces` lets a land/mana
 * source declare what tapping it yields without a bespoke primitive.
 */
export interface CardDefinition {
  /** Stable id, unique within the pool (e.g. a Scryfall-derived slug). */
  readonly id: string;
  readonly name: string;
  readonly types: readonly CardType[];
  /** Mana cost. Absent for lands and other free-to-play cards. */
  readonly cost?: ManaCost;
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: KeywordFlags;
  /**
   * Printed subtypes, lowercased ("mountain", "human", "equipment").
   *
   * Carried because some cards select by subtype rather than by type or name: a
   * fetchland searches for "a Mountain or Plains card", which finds a dual land
   * with those land types and not just a basic. Without this the only options
   * are an unfaithful name match or reporting the card as unsupported.
   */
  readonly subtypes?: readonly string[];
  /**
   * Ordered effects run when this spell resolves (instants/sorceries) or as the
   * permanent's enters-the-battlefield script. Opaque to core.
   */
  readonly effects?: readonly EffectRef[];
  /**
   * For *fixed-bundle* mana sources: tapping adds one mana of **each** listed
   * color at once. `['G']` is a Forest; `['C', 'C']` is Sol Ring's {C}{C}.
   *
   * This form cannot express a *choice*, so a source that adds "one mana of any
   * color" must NOT be written as `['W','U','B','R','G']` — that would produce
   * all five at once. Use {@link producesOptions} for modal sources instead.
   */
  readonly produces?: readonly import('./mana.js').ManaColor[];
  /**
   * For *modal* mana sources: tapping adds the mana of exactly **one** of these
   * modes, chosen by the controller (`TapForManaAction.mode` indexes this list).
   * Birds of Paradise is the five single-color modes; a dual land is two.
   *
   * Supersedes {@link produces}, which is the single-mode shorthand: when both
   * are present this wins. Core normalises the two into one mode list, so a
   * fixed bundle is simply a source with exactly one mode.
   */
  readonly producesOptions?: readonly import('./mana.js').ManaProduction[];
  /**
   * When true this permanent arrives on the battlefield already tapped, exactly
   * as printed ("~ enters tapped"). It is the defining drawback of the common
   * dual lands, so without it those lands would play a full turn faster than
   * they really do and every deck containing them would simulate too fast.
   *
   * Only the UNCONDITIONAL form is modelled here. A conditional entry ("enters
   * tapped unless you control two or fewer other lands") or a paid choice
   * (shocklands' "you may pay 2 life") needs the choice system, so those cards
   * stay unimplemented rather than being flattened into always-tapped.
   */
  readonly entersTapped?: boolean;
  /**
   * A board condition that lets this permanent enter UNTAPPED — the "unless"
   * half of the common dual lands: "enters tapped unless you control two or
   * fewer other lands" (a fastland), "unless you control a Mountain or a
   * Plains" (a checkland).
   *
   * Present ⇒ the permanent enters tapped whenever the condition is NOT met.
   * Only conditions that read the board are expressible here; a land that
   * charges a PRICE to enter untapped (a shockland's "you may pay 2 life") asks
   * its controller a question at land-play time, which nothing in the engine
   * can do yet, so those stay unimplemented rather than being flattened into
   * always-tapped or always-untapped — either would misprice the card.
   */
  readonly entersTappedUnless?: EntersUntappedCondition;
  /** Casting timing; defaults to `'sorcery'` when omitted. */
  readonly timing?: CastTiming;
  /**
   * Triggered abilities (DESIGN §3.9), as data: each is a condition (what event
   * sets it off) + an effect-ref list run when it resolves. Opaque to most of core
   * — the trigger machinery (triggers.ts) matches conditions against the event log
   * and the engine resolves the effects via the same registry as spells. Omit for
   * cards with no triggers.
   */
  readonly triggers?: readonly import('./triggers.js').TriggeredAbility[];
  /**
   * Abilities the controller may ACTIVATE by paying a cost — the `Cost: Effect`
   * line printed on fetchlands ("{T}, Pay 1 life, Sacrifice ~: Search…"),
   * sacrifice outlets, and mana rocks with a second ability.
   *
   * Mana abilities are NOT here: a permanent that only taps for mana declares
   * {@link produces}/{@link producesOptions} and resolves without using the
   * stack, exactly as the rules require. Everything in this list uses the stack.
   */
  readonly activated?: readonly ActivatedAbility[];
}

/**
 * What activating an ability costs. Every field is optional and they combine —
 * a fetchland pays all three of tap, life, and sacrifice.
 *
 * Costs are PAID ON ACTIVATION, before the ability goes on the stack, and are
 * not refunded if the ability is later countered or fizzles (rule 602.2).
 */
export interface ActivationCost {
  /** Mana component, paid from the controller's floating pool. */
  readonly mana?: ManaCost;
  /** The `{T}` symbol: tap this permanent (and obey summoning sickness). */
  readonly tap?: boolean;
  /** "Sacrifice ~": this permanent goes to its owner's graveyard. */
  readonly sacrificeSelf?: boolean;
  /** "Pay N life". Payable only while the controller's life exceeds it. */
  readonly life?: number;
}

/**
 * One activated ability: a cost, the effects it puts on the stack, and when it
 * may be activated.
 *
 * `timing` defaults to `'instant'` because that is the rules default — an
 * activated ability may be activated whenever its controller has priority
 * unless its text says otherwise (rule 602.2). A `'sorcery'` ability is the
 * exception ("Activate only as a sorcery").
 */
export interface ActivatedAbility {
  readonly cost: ActivationCost;
  readonly effects: readonly EffectRef[];
  readonly timing?: CastTiming;
  /** Human-readable text for the log, the inspector, and the replay viewer. */
  readonly label: string;
}

/** Convenience predicates over a definition's type line. */
export function hasType(def: CardDefinition, type: CardType): boolean {
  return def.types.includes(type);
}

export function isLand(def: CardDefinition): boolean {
  return hasType(def, 'land');
}

export function isPermanentType(def: CardDefinition): boolean {
  return (
    hasType(def, 'land') ||
    hasType(def, 'creature') ||
    hasType(def, 'artifact') ||
    hasType(def, 'enchantment') ||
    hasType(def, 'planeswalker')
  );
}

export function isCreature(def: CardDefinition): boolean {
  return hasType(def, 'creature');
}

/** No mana modes — shared frozen empty list so the hot path allocates nothing. */
const NO_MANA_MODES: readonly ManaProduction[] = Object.freeze([]);

/**
 * Memo for the legacy-form normalisation below. Card definitions are immutable and
 * shared (the pool is frozen and every instance points at the same object), so the
 * folded mode list can be computed once per definition and reused forever.
 *
 * This matters: `manaModesOf` is called for every permanent on every
 * `generateLegalActions`, which is the engine's hottest read and runs millions of
 * times across a sim. Folding `['C','C']` into `{C:2}` on each call allocated a
 * fresh object every time and measurably cut sim throughput. A WeakMap keyed on
 * the definition keeps it allocation-free without pinning definitions in memory.
 */
const MANA_MODE_MEMO = new WeakMap<CardDefinition, readonly ManaProduction[]>();

/**
 * The mana-ability modes of a definition, as ONE normalised list regardless of
 * which authoring form was used: `producesOptions` verbatim when present, else
 * the legacy `produces` bundle folded into a single mode (`['C','C']` → one mode
 * of `{ C: 2 }`). A non-source yields an empty list.
 *
 * Every consumer (legal-action generation, payment, the AI's mana math) reads
 * modes through here, so "how many mana is one tap worth" has exactly one
 * answer in the codebase.
 */
export function manaModesOf(def: CardDefinition): readonly ManaProduction[] {
  if (def.producesOptions && def.producesOptions.length > 0) return def.producesOptions;
  const bundle = def.produces;
  if (!bundle || bundle.length === 0) return NO_MANA_MODES;
  const memoized = MANA_MODE_MEMO.get(def);
  if (memoized) return memoized;
  const single: Partial<Record<string, number>> = {};
  for (const color of bundle) single[color] = (single[color] ?? 0) + 1;
  const modes: readonly ManaProduction[] = Object.freeze([single as ManaProduction]);
  MANA_MODE_MEMO.set(def, modes);
  return modes;
}

/** Whether tapping this permanent for mana is a thing it can do at all. */
export function isManaSource(def: CardDefinition): boolean {
  return manaModesOf(def).length > 0;
}

/**
 * The distinct mana colours this source could produce, across all of its modes —
 * what a UI shows as "this can make {G}" / "this can make any colour".
 *
 * Derived from normalised modes, so it is correct for both authoring forms. A UI
 * reading `produces` directly renders a modal source as producing nothing at all.
 */
export function manaColorsOffered(def: CardDefinition): ManaColor[] {
  const seen = new Set<ManaColor>();
  for (const mode of manaModesOf(def)) {
    for (const color of MANA_COLORS) {
      if ((mode[color] ?? 0) > 0) seen.add(color);
    }
  }
  return [...seen];
}

/** Memo for {@link bestManaYield} — same immutability argument as the mode memo. */
const MANA_YIELD_MEMO = new WeakMap<CardDefinition, number>();

/**
 * The most mana ONE activation of this source can add — i.e. what tapping it is
 * worth. A modal source is worth its BEST mode, never the sum of its modes: an
 * any-colour source yields one mana, not five.
 *
 * Memoized because AI mana math reads this for every permanent on every decision,
 * which put it squarely on the sim's hot path.
 */
export function bestManaYield(def: CardDefinition): number {
  const memoized = MANA_YIELD_MEMO.get(def);
  if (memoized !== undefined) return memoized;
  let best = 0;
  for (const mode of manaModesOf(def)) {
    let total = 0;
    for (const color of MANA_COLORS) total += mode[color] ?? 0;
    if (total > best) best = total;
  }
  MANA_YIELD_MEMO.set(def, best);
  return best;
}

/**
 * A board condition under which a permanent enters UNTAPPED. Both forms are
 * evaluated the instant the permanent enters, counting only OTHER permanents —
 * the entering one is not yet on the battlefield when the check happens.
 */
export interface EntersUntappedCondition {
  /**
   * "unless you control two or fewer other lands" — a fastland. Satisfied when
   * the controller's other lands number at most this.
   */
  readonly maxOtherLands?: number;
  /**
   * "unless you control a Mountain or a Plains" — a checkland. Satisfied when
   * the controller has another permanent with any of these subtypes.
   */
  readonly controlsSubtype?: readonly string[];
}

/**
 * The slice of the board an enters-tapped condition reads.
 *
 * Declared structurally rather than as `GameState` so `card.ts` stays free of a
 * cycle back through `state.ts`, which imports this module.
 */
export interface EntersTappedContext {
  readonly controller: string;
  readonly battlefield: readonly {
    readonly controller: string;
    readonly def: CardDefinition;
  }[];
  /** The entering permanent, excluded from its own condition when present. */
  readonly self?: unknown;
}

/**
 * Whether a permanent of this definition arrives tapped. One accessor so every
 * battlefield-entry path (resolving a permanent spell, playing a land, creating
 * a token) asks the same question the same way.
 *
 * `context` is required to answer a CONDITIONAL entry. Omitting it answers only
 * the unconditional flag — which is correct for a token or a test fixture with
 * no board, and deliberately conservative everywhere else.
 */
export function entersTapped(def: CardDefinition, context?: EntersTappedContext): boolean {
  if (def.entersTapped === true) return true;
  const condition = def.entersTappedUnless;
  if (!condition) return false;
  // With no board to read we cannot evaluate the condition. Entering tapped is
  // the printed default (the "unless" is the exception), so that is the safe answer.
  if (!context) return true;
  return !conditionMet(condition, context);
}

/** Whether the "enters untapped" condition holds on the current board. */
function conditionMet(
  condition: EntersUntappedCondition,
  context: EntersTappedContext,
): boolean {
  const others = context.battlefield.filter(
    (permanent) => permanent.controller === context.controller && permanent !== context.self,
  );

  if (condition.maxOtherLands !== undefined) {
    const lands = others.filter((permanent) => permanent.def.types.includes('land')).length;
    if (lands > condition.maxOtherLands) return false;
  }

  if (condition.controlsSubtype !== undefined) {
    const wanted = condition.controlsSubtype;
    const has = others.some((permanent) =>
      (permanent.def.subtypes ?? []).some((subtype) => wanted.includes(subtype)),
    );
    if (!has) return false;
  }

  return true;
}

/** Resolve a definition's casting timing, defaulting to sorcery-speed. */
export function castTiming(def: CardDefinition): CastTiming {
  if (def.timing) return def.timing;
  // Instants are instant-speed by type; everything else is sorcery-speed.
  return hasType(def, 'instant') ? 'instant' : 'sorcery';
}
