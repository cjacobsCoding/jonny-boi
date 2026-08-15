/**
 * Arm 1 — the payment planner EXACTLY as shipped: `packages/core`'s own
 * `planManaPayment`, called with the object shapes the engine really hands it.
 *
 * Nothing is reimplemented here. This arm is the baseline every other number is a
 * multiple of, and it is the real function so the baseline cannot be accidentally
 * flattered by a simplified stand-in.
 *
 * The engine's inputs are an object graph — a `ManaPlanView` (battlefield of card
 * instances, per-player pools) plus the offered `tapForMana` actions — so this arm
 * has NO separable marshalling step: the objects are its native form. That
 * asymmetry is the point, and it is reported rather than hidden.
 */

import type { GameAction, CardInstance, ManaCost, ManaProduction, PlayerId } from '@jonny-boi/core';
import { planManaPayment, MANA_COLORS } from '@jonny-boi/core';
import type { ChosenTap, PlanResult } from './kernel.js';
import type { PaymentCase } from './corpus.js';

/** The object-shaped inputs one case presents to the shipped planner. */
export interface ObjectCase {
  readonly view: { readonly battlefield: readonly CardInstance[]; readonly players: Record<PlayerId, { readonly manaPool: Record<string, number> }> };
  readonly actions: readonly GameAction[];
  readonly cost: ManaCost;
  /** Instance id → index into the case's source list, for comparing plans. */
  readonly indexById: ReadonlyMap<number, number>;
}

const PLAYER: PlayerId = 'A';

function productionOf(vector: readonly number[]): ManaProduction {
  const out: Record<string, number> = {};
  for (let c = 0; c < MANA_COLORS.length; c++) {
    const v = vector[c] ?? 0;
    if (v !== 0) out[MANA_COLORS[c] as string] = v;
  }
  return out as ManaProduction;
}

/**
 * Build the object graph for one recorded case: the permanents, their production
 * modes, the floating pool, and the `tapForMana` actions the engine would offer.
 */
export function toObjectCase(c: PaymentCase): ObjectCase {
  const battlefield: CardInstance[] = [];
  const actions: GameAction[] = [];
  const indexById = new Map<number, number>();
  for (let s = 0; s < c.sources.length; s++) {
    const id = c.sourceIds[s] as number;
    indexById.set(id, s);
    const modes = (c.sources[s] as readonly (readonly number[])[]).map(productionOf);
    battlefield.push({
      instanceId: id,
      def: { id: `src-${id}`, name: `src-${id}`, types: ['land'], producesOptions: modes },
      controller: PLAYER,
      owner: PLAYER,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    } as unknown as CardInstance);
    for (let m = 0; m < modes.length; m++) {
      actions.push({ kind: 'tapForMana', player: PLAYER, instanceId: id, mode: m });
    }
  }
  const manaPool: Record<string, number> = {};
  for (let i = 0; i < MANA_COLORS.length; i++) manaPool[MANA_COLORS[i] as string] = c.pool[i] ?? 0;
  return {
    view: { battlefield, players: { A: { manaPool }, B: { manaPool } } as never },
    actions,
    cost: c.cost,
    indexById,
  };
}

/** Run the shipped planner on a prepared object case and normalise the result. */
export function planShipped(oc: ObjectCase): PlanResult {
  const plan = planManaPayment(oc.view as never, PLAYER, oc.cost, oc.actions);
  if (plan === undefined) return null;
  const out: ChosenTap[] = [];
  for (const tap of plan) {
    out.push({ sourceIndex: oc.indexById.get(tap.instanceId) ?? -1, modeIndex: tap.mode });
  }
  return out;
}
