/**
 * THE CAST-ALTERNATIVE FAMILY (DESIGN §3.112) — evoke, dash, blitz, surge,
 * prototype and warp: "you may cast this card by paying [cost] rather than its
 * mana cost", each with a rider that follows the permanent onto the battlefield.
 *
 * ## One casting funnel, one more ROW on the action
 * Every one of these is CR 601.2b's "alternative cost" — the same announcement
 * flashback and madness already make through `applyCastSpell`, with a different
 * price. So it is NOT a second cast path: `CastSpellAction.alternative` names
 * the kind, the engine looks the cost up in `CardDefinition.alternativeCosts`
 * and charges it where it would have charged the printed cost, and the stack
 * object carries the kind into the resolution exactly as `kicked` does. A
 * player "can't apply two alternative costs to a single spell" (CR 601.2b), so
 * an alternative cast is always from the HAND for the printed timing — never
 * stacked on a flashback, a madness window or a free permission.
 *
 * ## The rider is data the compiler hands over, judged by a closed table
 * Dash, blitz and warp each create a DELAYED triggered ability as the permanent
 * enters ("return it / sacrifice it / exile it at the beginning of the next end
 * step", CR 702.109a / 702.152a / 702.185a), and evoke's sacrifice is an
 * enters-the-battlefield trigger (CR 702.74a). All four are the vocabulary
 * `delayed.ts` already speaks — a `TriggerCondition` and an effect list — so the
 * definition carries them as {@link AlternativeCostRider}s, built by the cards
 * package exactly as a cycling body or `SuspendAbility.upkeep` is, and core
 * names no primitive. What core DOES own is the part that is the keyword's
 * rule rather than the card's text: which kinds give haste, which need a turn
 * fact, and which replace the printed face. That is {@link ALTERNATIVE_COSTS},
 * and a seventh keyword of this shape is a row there, not a branch anywhere.
 *
 * ## Why the rider is a delayed ability created AT ENTRY
 * "Sacrifice the permanent this spell becomes" names an object that does not
 * exist until the spell resolves, and CR 400.7 says a bounced-and-recast dash
 * creature is a new object the old rider must not touch. Creating the rider as
 * the permanent enters, with the permanent itself as its source, gives both:
 * `frameSource` finds the card wherever it is, and the body primitives check
 * {@link CardInstance.castWith} — cleared by `resetInstanceForNewZone` the
 * moment the permanent leaves — before acting, so a blinked Kolaghan Skirmisher
 * stays. The evoke rider is created BEFORE the entry's `zoneChange` is emitted,
 * which is what lets a delayed `etb` condition match the very entry that
 * created it (the runtime matches delayed records against every event).
 */

import type { CardDefinition, EffectRef } from './card.js';
import type { ManaCost } from './mana.js';
import type { TurnFact } from './turn-facts.js';
import type { TriggerCondition } from './triggers.js';

/**
 * The printed alternative-cost keywords this engine plays. CLOSED: a kind is
 * a key of {@link ALTERNATIVE_COSTS}, so the compiler cannot write one the
 * engine has no rule for.
 */
export type AlternativeCostKind = 'evoke' | 'dash' | 'blitz' | 'surge' | 'prototype' | 'warp';

/** Every kind, in CR order — the exhaustiveness witness for the table below. */
export const ALTERNATIVE_COST_KINDS: readonly AlternativeCostKind[] = Object.freeze([
  'evoke',
  'dash',
  'blitz',
  'surge',
  'prototype',
  'warp',
]);

/**
 * A rider the permanent gets when its alternative cost was paid — a DELAYED
 * triggered ability (CR 603.7) created as it enters, in the trigger vocabulary
 * a printed card uses. `removesFromBattlefield` is the pilot's warning that the
 * body takes the permanent away (see `DelayedTriggeredAbility`).
 */
export interface AlternativeCostRider {
  readonly condition: TriggerCondition;
  readonly effects: readonly EffectRef[];
  readonly label: string;
  readonly removesFromBattlefield?: boolean;
}

/**
 * One printed alternative cost on a card — see `CardDefinition.alternativeCosts`.
 *
 * `cost` is the mana half; a printed non-mana form ("Evoke—Exile a black card
 * from your hand", "Warp—{B}, Pay 2 life") has no cast-time seam and stays
 * reported by the compiler. `riders` are the keyword's delayed abilities as the
 * cards package built them; `face` is PROTOTYPE's second set of characteristics
 * (CR 702.160a), applied by swapping the definition being cast exactly as a
 * modal DFC's back face is.
 */
export interface AlternativeCastCost {
  readonly cost: ManaCost;
  readonly riders?: readonly AlternativeCostRider[];
  /** Prototype only: the smaller body the card is cast as. */
  readonly face?: { readonly power: number; readonly toughness: number };
}

/** The rules of one kind that are the KEYWORD's, not the card's. */
export interface AlternativeCostSpec {
  /** The CR rule that defines the keyword, for the log and the manifest. */
  readonly rule: string;
  /** "As long as this permanent's [kind] cost was paid, it has haste." */
  readonly haste: boolean;
  /** A turn fact that must hold for the caster before the cost may be paid (surge). */
  readonly requiresTurnFact?: TurnFact;
  /** Whether the card is cast as its `face` (prototype). */
  readonly castsAsFace: boolean;
}

/**
 * The closed table. Haste is here rather than in the rider list because it is
 * a static ability of the keyword ("as long as its cost was paid, it has
 * haste") and this engine models haste as entering unsick (see
 * `SpellStackObject.hasteOnEntry`, §3.106) — no continuous effect to expire.
 */
export const ALTERNATIVE_COSTS: Readonly<Record<AlternativeCostKind, AlternativeCostSpec>> = Object.freeze({
  evoke: { rule: '702.74a', haste: false, castsAsFace: false },
  dash: { rule: '702.109a', haste: true, castsAsFace: false },
  blitz: { rule: '702.152a', haste: true, castsAsFace: false },
  surge: { rule: '702.117a', haste: false, requiresTurnFact: 'castASpell', castsAsFace: false },
  prototype: { rule: '702.160a', haste: false, castsAsFace: true },
  warp: { rule: '702.185a', haste: false, castsAsFace: false },
});

/**
 * The alternative costs a definition prints, in table order, or the shared
 * empty list — so a hand walk over ordinary cards allocates nothing.
 */
export function alternativeCostKindsOf(def: CardDefinition): readonly AlternativeCostKind[] {
  const costs = def.alternativeCosts;
  if (costs === undefined) return NO_KINDS;
  let found: AlternativeCostKind[] | null = null;
  for (let i = 0; i < ALTERNATIVE_COST_KINDS.length; i++) {
    const kind = ALTERNATIVE_COST_KINDS[i] as AlternativeCostKind;
    if (costs[kind] !== undefined) (found ??= []).push(kind);
  }
  return found ?? NO_KINDS;
}

const NO_KINDS: readonly AlternativeCostKind[] = Object.freeze([]);

/**
 * The definition a spell is CAST AS for a given alternative — the card itself
 * for every kind but prototype, whose "different mana cost, color, and size"
 * (CR 702.160a) is a second face: same name, types, abilities and alternative
 * costs, with the prototype's cost and body in place of the printed ones.
 * Colour follows the cost by construction, because `colorsOfDefinition` derives
 * it from `cost` when no printed colour list is present (Goring Warplow cast
 * prototyped is a BLACK 1/1). Memoised per definition, so the face is one
 * object across the offer, the cast and the resolution.
 */
export function definitionCastAs(def: CardDefinition, kind: AlternativeCostKind): CardDefinition {
  const alt = def.alternativeCosts?.[kind];
  if (alt === undefined || !ALTERNATIVE_COSTS[kind].castsAsFace || alt.face === undefined) return def;
  const memo = PROTOTYPE_FACE_MEMO.get(def);
  if (memo !== undefined) return memo;
  const { colors: _printedColors, ...rest } = def;
  void _printedColors;
  const face: CardDefinition = Object.freeze({
    ...rest,
    cost: alt.cost,
    power: alt.face.power,
    toughness: alt.face.toughness,
  });
  PROTOTYPE_FACE_MEMO.set(def, face);
  return face;
}

const PROTOTYPE_FACE_MEMO = new WeakMap<CardDefinition, CardDefinition>();
