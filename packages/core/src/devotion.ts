/**
 * DEVOTION (CR 700.5) — and the Theros gods' "isn't a creature" type layer
 * (DESIGN §3.163).
 *
 * ## The count
 *
 * "Your devotion to white" is the number of `{W}` symbols among the mana costs
 * of permanents you control; devotion to a colour PAIR counts every symbol that
 * is either colour, each symbol once. A hybrid `{W/U}` counts for white, for
 * blue, and once for the white-and-blue pair; a Phyrexian `{W/P}` counts for
 * white. Read off each permanent's CURRENT definition — the same source every
 * other derived count reads — so a copy of Heliod counts Heliod's cost and a
 * transformed back face counts its own.
 *
 * ## The type layer, and why it is a DEFINITION SWAP
 *
 * "As long as your devotion to white is less than five, Heliod isn't a creature."
 * Twenty-three gods print the shape. `isCreature(def)` is asked at fifty-seven
 * sites across combat, targeting, state-based actions, triggers and the derived
 * counts, and every one of them reads the permanent's `def`. The engine already
 * has two layers that answer "what is this permanent right now" by swapping
 * that field — a transformed face (`printedDef`) and a copy (`uncopiedDef`) —
 * and this is the third, for the same reason: one write, and every reader is
 * right with no second code path.
 *
 * A god whose devotion is short carries its NON-CREATURE FORM: the same
 * definition minus the `creature` type, memoised per base definition so the
 * derived object's identity is stable (the SBA gate and the restriction memos
 * key on definition identity), with `creatureForm` pointing back at the base.
 * The base never points at the form, so the graph stays acyclic and
 * `CardDefinition` stays serialisable data.
 *
 * ## When it is settled
 *
 * Devotion changes when a permanent enters or leaves the battlefield or changes
 * controller, and when a definition changes (copy, transform). {@link
 * settleDevotionForms} therefore runs at the ONE battlefield-entry helper (so an
 * "enters as a creature" question is answered before any trigger reads it), at
 * both leave funnels, at the control-change site, and at the head of every
 * state-based check — the boundary every action already crosses. A board with
 * no god on it pays one property read per permanent and nothing else.
 *
 * ## Both directions
 *
 * The form is derived every time from the BASE, so a god that regains devotion
 * becomes a creature again on the same pass that would have stopped it — and a
 * god that leaves the battlefield is restored to its base form by the zone
 * reset before it is a card in a graveyard or a hand, where it is a creature
 * card again (CR 700.5 is about permanents).
 */

import type { CardDefinition } from './card.js';
import type { ManaColor, ManaCost } from './mana.js';
import type { CardInstance, GameState, PlayerId } from './state.js';

/**
 * The printed condition: the colour(s) devotion is counted in, and the count
 * BELOW which the permanent is not a creature ("less than five" ⇒ `min: 5`).
 */
export interface CreatureUnlessDevotion {
  readonly colors: readonly ManaColor[];
  readonly min: number;
}

/** Mana symbols of any of `colors` in one printed cost, each symbol counted once. */
export function devotionOfCost(cost: ManaCost | undefined, colors: readonly ManaColor[]): number {
  if (cost === undefined) return 0;
  let count = 0;
  for (let i = 0; i < colors.length; i++) count += cost[colors[i] as ManaColor] ?? 0;
  const hybrid = cost.hybrid;
  if (hybrid !== undefined) {
    for (let i = 0; i < hybrid.length; i++) {
      const symbol = hybrid[i]!;
      for (let j = 0; j < symbol.length; j++) {
        const component = symbol[j]!;
        if (typeof component === 'string' && colors.includes(component)) {
          count += 1;
          break; // one symbol, one point, however many of its faces match
        }
      }
    }
  }
  return count;
}

/** CR 700.5 — `player`'s devotion to `colors`, over the permanents they control. */
export function devotionTo(state: GameState, player: PlayerId, colors: readonly ManaColor[]): number {
  let total = 0;
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.controller !== player) continue;
    total += devotionOfCost(perm.def.cost, colors);
  }
  return total;
}

/** The non-creature form of each base definition, made once. */
const NON_CREATURE_FORM = new WeakMap<CardDefinition, CardDefinition>();

/**
 * The definition `def` is when it "isn't a creature": every characteristic it
 * has, minus the creature type, remembering its base in `creatureForm`.
 */
export function nonCreatureFormOf(base: CardDefinition): CardDefinition {
  const cached = NON_CREATURE_FORM.get(base);
  if (cached !== undefined) return cached;
  const form: CardDefinition = {
    ...base,
    types: base.types.filter((type) => type !== 'creature'),
    creatureForm: base,
  };
  NON_CREATURE_FORM.set(base, form);
  return form;
}

/** The base definition a permanent's current one derives from (itself when it is the base). */
export function creatureFormOf(def: CardDefinition): CardDefinition {
  return def.creatureForm ?? def;
}

/** Whether this definition takes part in the layer at all — one property read each. */
function isDevotionConditional(def: CardDefinition): boolean {
  return def.creatureUnlessDevotion !== undefined || def.creatureForm !== undefined;
}

/**
 * Re-derive the form of every devotion-conditional permanent on the battlefield
 * from its base and its controller's devotion. Returns whether any changed.
 *
 * Idempotent, allocation-free when nothing is conditional, and safe to call
 * from any point that has just changed the board.
 */
export function settleDevotionForms(state: GameState): boolean {
  const battlefield = state.battlefield;
  let changed = false;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (!isDevotionConditional(perm.def)) continue;
    const base = creatureFormOf(perm.def);
    const condition = base.creatureUnlessDevotion;
    if (condition === undefined) continue; // a form whose base lost the condition — leave it
    const isCreature = devotionTo(state, perm.controller, condition.colors) >= condition.min;
    const next = isCreature ? base : nonCreatureFormOf(base);
    if (next !== perm.def) {
      perm.def = next;
      changed = true;
    }
  }
  return changed;
}
