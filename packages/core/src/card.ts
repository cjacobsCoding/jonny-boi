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

/** Resolve a definition's casting timing, defaulting to sorcery-speed. */
export function castTiming(def: CardDefinition): CastTiming {
  if (def.timing) return def.timing;
  // Instants are instant-speed by type; everything else is sorcery-speed.
  return hasType(def, 'instant') ? 'instant' : 'sorcery';
}
