/**
 * Mana PAYMENT PLANNING — "which sources do I tap, in which colour, to pay this?"
 *
 * This lives in core because *every* seat needs the same answer: the AI pilots
 * fund their chosen spell with it, and the hotseat/online UI auto-taps with it.
 * Two implementations would drift, and they already had — the UI's auto-tap
 * grabbed the first untapped permanent with no colour reasoning, so a two-colour
 * board could fail to cast a spell it could obviously afford.
 *
 * The plan is built from the engine's OWN offered `tapForMana` actions, so it can
 * only ever contain legal activations (summoning-sick creatures are already
 * excluded upstream) and each carries the chosen colour as its `mode`.
 */

import type { GameAction } from './actions.js';
import { manaModesOf } from './card.js';
import type { ManaCost, ManaPool, ManaProduction } from './mana.js';
import { canPay, MANA_COLORS } from './mana.js';
import type { CardInstance, InstanceId, PlayerId } from './state.js';

/**
 * The minimum a caller must expose to plan a payment: the public battlefield and
 * each player's floating pool.
 *
 * Deliberately narrower than `GameState` so the ONLINE client can plan too — it
 * only ever holds a redacted view of the game, and both that view and the full
 * `GameState` satisfy this shape structurally. Without it the online seat had no
 * way to tap mana at all, which meant it could never cast a spell.
 */
export interface ManaPlanView {
  readonly battlefield: readonly CardInstance[];
  readonly players: Readonly<Record<PlayerId, { readonly manaPool: ManaPool }>>;
}

/** One activation in a funding plan: which permanent to tap, in which mode. */
export interface ManaTapPlan {
  readonly instanceId: InstanceId;
  readonly mode: number;
  /** The mana this activation adds — handy for logs and UI hints. */
  readonly production: ManaProduction;
}

/**
 * A cheap, allocation-free estimate of how far `pool` is from paying `cost`,
 * counted in pips still unfunded.
 *
 * This RANKS candidate taps (it runs for every source × mode on every step of the
 * plan, so it must not allocate); it is deliberately NOT the authority on whether
 * a cost is payable. `canPay` is, and the planner defers to it — a cost model can
 * grow symbols this simple per-colour subtraction doesn't understand (hybrid
 * symbols payable by either of two colours being the live example), and a second
 * opinion baked in here would silently disagree with the engine.
 */
export function distanceToPayable(pool: ManaPool, cost: ManaCost): number {
  let short = 0;
  let spare = 0;
  for (const color of MANA_COLORS) {
    const need = cost[color] ?? 0;
    const have = pool[color];
    if (have < need) short += need - have;
    else spare += have - need;
  }
  const generic = cost.generic ?? 0;
  return short + Math.max(0, generic - spare);
}

/**
 * Plan the taps that fund `cost`, or undefined when this board cannot pay it.
 *
 * An EMPTY plan means the floating pool already covers the cost — i.e. stop
 * tapping. That distinction is the whole point: without it a caller keeps tapping
 * past what it needs and strands the excess (pools empty at end of step).
 *
 * One tap at a time, always the one that closes the most of the remaining
 * shortfall, breaking ties toward the LEAST flexible source (spend the Forest,
 * keep the any-colour Bird) and then the smallest producer (don't crack a 2-mana
 * rock for a single pip). Tapping a permanent removes it from the candidate pool,
 * so the loop always terminates.
 */
export function planManaPayment(
  view: ManaPlanView,
  player: PlayerId,
  cost: ManaCost,
  legalActions: readonly GameAction[],
): ManaTapPlan[] | undefined {
  // ALLOCATION NOTE. This is the hottest function in the sim profile (8.7% of self
  // time), and it is dominated by the cheap cases rather than the hard ones: the
  // recorded corpus of real games is 44% "no untapped sources at all" and mean 1.4
  // sources. So both trivial answers are returned before anything is allocated —
  // no pool copy, no Map, no per-mode objects. The planning below is unchanged.
  const current: ManaPool = view.players[player].manaPool;
  // `canPay` is the authority on "done"; the distance heuristic only orders taps.
  // Checked against the LIVE pool: `canPay` only reads, so the copy can wait until
  // we know we are going to mutate one.
  if (canPay(current, cost)) return [];

  // Nothing to tap ⇒ nothing can change ⇒ unpayable. Returning here skips the
  // grouping pass entirely for nearly half of all calls.
  let hasTap = false;
  for (const action of legalActions) {
    if (action.kind === 'tapForMana' && action.player === player) {
      hasTap = true;
      break;
    }
  }
  if (!hasTap) return undefined;

  let pool: ManaPool = { ...current };

  // Group the offered activations by permanent: the modes of one source are
  // alternatives, and tapping it spends the whole permanent.
  //
  // The lookup stays a linear `find` ON PURPOSE. Indexing the battlefield into a
  // Map first was tried and is a net LOSS at this size: real games offer a mean of
  // 1.4 tappable sources against a battlefield of ~10-20, so building the index
  // costs more inserts than the scans it saves — the same trap the WASM spike
  // recorded when 23 typed arrays lost to a deep copy. Measure before "optimising"
  // a scan away at this scale.
  const candidates = new Map<InstanceId, ManaTapPlan[]>();
  for (const action of legalActions) {
    if (action.kind !== 'tapForMana' || action.player !== player) continue;
    const perm = view.battlefield.find((c) => c.instanceId === action.instanceId);
    if (!perm) continue;
    const production = manaModesOf(perm.def)[action.mode ?? 0];
    if (!production) continue;
    const tap: ManaTapPlan = { instanceId: action.instanceId, mode: action.mode ?? 0, production };
    const list = candidates.get(action.instanceId);
    if (list) list.push(tap);
    else candidates.set(action.instanceId, [tap]);
  }

  const plan: ManaTapPlan[] = [];
  // One reusable scratch pool: this inner loop runs for every source × mode on
  // every step of the plan, and the AI calls it on its hot path.
  const scratch: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

  while (!canPay(pool, cost)) {
    // At least one pip is still owed (canPay said so). Flooring at 1 matters when
    // the heuristic can't see the shortfall — a hybrid symbol reads as satisfied
    // by either colour — so a useful tap is still accepted instead of the planner
    // concluding the cost is unpayable.
    const current = Math.max(distanceToPayable(pool, cost), 1);
    let best: ManaTapPlan | undefined;
    let bestDistance = current;
    let bestFlexibility = Infinity;
    let bestSize = Infinity;

    for (const taps of candidates.values()) {
      const flexibility = taps.length; // how many colours this source could have made
      for (const tap of taps) {
        let size = 0;
        for (const color of MANA_COLORS) {
          const add = tap.production[color] ?? 0;
          scratch[color] = pool[color] + add;
          size += add;
        }
        const distance = distanceToPayable(scratch, cost);
        if (distance >= current) continue; // buys us nothing — never make this tap
        const better =
          distance < bestDistance ||
          (distance === bestDistance && flexibility < bestFlexibility) ||
          (distance === bestDistance && flexibility === bestFlexibility && size < bestSize);
        if (better) {
          best = tap;
          bestDistance = distance;
          bestFlexibility = flexibility;
          bestSize = size;
        }
      }
    }

    if (!best) return undefined; // nothing left that helps — the cost is unpayable
    candidates.delete(best.instanceId);
    const chosen = best;
    const next: ManaPool = { ...pool };
    for (const color of MANA_COLORS) next[color] += chosen.production[color] ?? 0;
    pool = next;
    plan.push(chosen);
  }
  return plan;
}
