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
import { manaExtrasOf, manaModesOf } from './card.js';
import type { ManaColor, ManaCost, ManaPool, ManaProduction } from './mana.js';
import { canPay, MANA_COLORS, payCost } from './mana.js';
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
 * ## Why this function keeps its working set in module-level scratch buffers
 *
 * `planManaPayment` is the hottest primitive the hybrid search touches — it runs
 * once per castable card per search node — and its cost was NOT where the code
 * assumed. Measured on 600 real mid-game positions (Mono-Red Aggro vs Boros
 * Aggro, interleaved A/B in one process), the dominant cost was not the number of
 * comparisons but the SHAPE of the objects being compared:
 *
 *  - A `ManaCost` and a `ManaProduction` are sparse partial records — `{R:1}`,
 *    `{generic:2, W:1}`, `{}` — so every card in a deck presents a DIFFERENT
 *    hidden class. Reading `cost[color]` in the ranking loop is therefore a
 *    megamorphic property load, and the loop performed six of them per candidate
 *    tap per step of the plan.
 *  - `for (const color of MANA_COLORS)` allocated an array iterator per pass, in
 *    the same loop `canPayFixed` had already been converted away from for exactly
 *    this reason (see mana.ts).
 *
 * Both are fixed by reading each sparse record ONCE into a dense, fixed-length
 * `Int32Array` in the colour order of `MANA_COLORS`, and doing all of the ranking
 * arithmetic against those. The buffers are module-level and reused so the fix
 * does not simply move the cost into the allocator.
 *
 * ⚠️ SAFETY OF THE SHARED BUFFERS. This is a pure function and must stay one, so
 * the buffers may never outlive a call or be observable from outside it:
 *  - `planManaPayment` is fully synchronous and calls nothing that can re-enter
 *    it (`canPay` and `manaModesOf` are leaves), so no second call can interleave.
 *  - Every buffer slot is WRITTEN before it is read on each call; nothing is
 *    carried over between calls.
 *  - Nothing backed by a buffer escapes: the returned plans are fresh objects and
 *    the `production` they carry is the definition's own frozen mode record.
 * A module instance is per-realm, so a Web Worker gets its own set.
 */
const COLOR_COUNT = MANA_COLORS.length;
/** Taps a board is expected to offer before the production buffer has to grow. */
const INITIAL_TAP_CAPACITY = 16;

/** The colour amounts of a sparse record, dense and in `MANA_COLORS` order. */
function densifyInto(record: Partial<Record<ManaColor, number>>, into: Int32Array, at: number): void {
  for (let i = 0; i < COLOR_COUNT; i++) into[at + i] = record[MANA_COLORS[i] as ManaColor] ?? 0;
}

/** {@link distanceToPayable} over dense colour arrays — the ranking hot loop. */
function denseDistanceToPayable(pool: Int32Array, cost: Int32Array, generic: number): number {
  let short = 0;
  let spare = 0;
  for (let i = 0; i < COLOR_COUNT; i++) {
    const need = cost[i] as number;
    const have = pool[i] as number;
    if (have < need) short += need - have;
    else spare += have - need;
  }
  return short + (generic > spare ? generic - spare : 0);
}

/**
 * The reused working set. Grouped in one object so the invariant above ("written
 * before read, never escapes") has a single place to hold.
 */
const scratch = {
  /** Dense colour amounts, one row of `COLOR_COUNT` per offered tap. */
  production: new Int32Array(COLOR_COUNT * INITIAL_TAP_CAPACITY),
  /**
   * The MANA a tap itself costs, one entry per offered tap, parallel to
   * `production` — the filter lands' "{R/W}, {T}: Add {R}{R}". `undefined` for
   * every ordinary source, and never read at all unless some source on the board
   * has one.
   *
   * Kept as the printed `ManaCost` rather than densified like everything else
   * because a filter land's input is a HYBRID symbol ({R/W}), which a per-colour
   * row cannot express — `canPay`/`payCost` are the only things that understand
   * one, and a second opinion here would silently disagree with the engine about
   * whether the land is usable at all.
   */
  tapCost: [] as (ManaCost | undefined)[],
  /** Dense forms of the cost being paid, the running pool, and one trial tap. */
  cost: new Int32Array(COLOR_COUNT),
  pool: new Int32Array(COLOR_COUNT),
  trial: new Int32Array(COLOR_COUNT),
  /** Per offered tap, parallel to `production`'s rows. */
  tapSource: [] as InstanceId[],
  tapMode: [] as number[],
  tapProduction: [] as ManaProduction[],
  tapGroup: [] as number[],
  /** Per source permanent (a "group" — its modes are alternatives). */
  sourceId: [] as InstanceId[],
  sourceUntapped: [] as boolean[],
  /** Tap indices ordered by group, so a group's modes are contiguous. */
  order: [] as number[],
  groupBegin: [] as number[],
  groupSize: [] as number[],
};

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
  // recorded corpus of real games is 44% "no untapped sources at all". So both
  // trivial answers are returned before anything is allocated — no pool copy, no
  // per-mode objects. The planning below is unchanged.
  const current: ManaPool = view.players[player].manaPool;
  // `canPay` is the authority on "done"; the distance heuristic only orders taps.
  // Checked against the LIVE pool: `canPay` only reads, so the copy can wait until
  // we know we are going to mutate one.
  if (canPay(current, cost)) return [];

  // Nothing to tap ⇒ nothing can change ⇒ unpayable. Returning here skips the
  // grouping pass entirely for nearly half of all calls. Indexed rather than
  // `for...of`, which allocates an array iterator on every call.
  let hasTap = false;
  for (let i = 0; i < legalActions.length; i++) {
    const action = legalActions[i] as GameAction;
    if (action.kind === 'tapForMana' && action.player === player) {
      hasTap = true;
      break;
    }
  }
  if (!hasTap) return undefined;

  // Collect the offered activations, grouped by permanent: the modes of one source
  // are alternatives, and tapping it spends the whole permanent.
  //
  // The battlefield lookup stays a linear scan ON PURPOSE. Indexing the battlefield
  // into a Map first was tried again here and is still a net LOSS — it measured
  // 0.81x at 2,272 B/call against 1,854 for the scan, because a board offers a
  // handful of tappable sources (mean 3.4 in real games) against a battlefield of
  // ~13, so the index costs more inserts than the scans it saves. What DID pay was
  // making the scan allocation-free: `Array.prototype.find` needs a closure over
  // the action, so it allocated one per offered tap. Measure before "optimising" a
  // scan away at this scale.
  const bf = view.battlefield;
  const s = scratch;
  let tapCount = 0;
  let sourceCount = 0;
  // The engine offers every mode of one permanent consecutively, so remembering the
  // last permanent resolves a modal source (a dual land, an any-colour rock) with
  // one scan instead of one per mode.
  let lastSource: InstanceId | undefined;
  let lastModes: readonly ManaProduction[] | undefined;
  let lastExtras: ReturnType<typeof manaExtrasOf>;
  // Stays false on every board with no cost-carrying source — which is nearly all
  // of them — and keeps the whole cost apparatus below out of the ranking loop.
  let anyTapCost = false;
  for (let i = 0; i < legalActions.length; i++) {
    const action = legalActions[i] as GameAction;
    if (action.kind !== 'tapForMana' || action.player !== player) continue;
    let modes: readonly ManaProduction[] | undefined;
    if (action.instanceId === lastSource) {
      modes = lastModes;
    } else {
      const perm = findOnBattlefield(bf, action.instanceId);
      modes = perm ? manaModesOf(perm.def) : undefined;
      lastExtras = perm ? manaExtrasOf(perm.def) : undefined;
      lastSource = action.instanceId;
      lastModes = modes;
    }
    if (!modes) continue;
    const mode = action.mode ?? 0;
    const production = modes[mode];
    if (!production) continue;

    if ((tapCount + 1) * COLOR_COUNT > s.production.length) {
      const grown = new Int32Array(s.production.length * 2);
      grown.set(s.production);
      s.production = grown;
    }
    densifyInto(production, s.production, tapCount * COLOR_COUNT);
    // A tap that itself costs mana (a filter land).
    const tapMana = lastExtras?.[mode]?.ability.cost?.mana;
    s.tapCost[tapCount] = tapMana;
    if (tapMana) anyTapCost = true;
    s.tapSource[tapCount] = action.instanceId;
    s.tapMode[tapCount] = mode;
    s.tapProduction[tapCount] = production;
    let group = -1;
    for (let g = 0; g < sourceCount; g++) {
      if (s.sourceId[g] === action.instanceId) {
        group = g;
        break;
      }
    }
    if (group < 0) {
      group = sourceCount;
      s.sourceId[sourceCount] = action.instanceId;
      s.sourceUntapped[sourceCount] = true;
      sourceCount += 1;
    }
    s.tapGroup[tapCount] = group;
    tapCount += 1;
  }

  // Lay the taps out grouped, keeping offer order inside each group, so the ranking
  // below sees a source's modes together and ties break exactly as they always have.
  let placed = 0;
  for (let g = 0; g < sourceCount; g++) {
    s.groupBegin[g] = placed;
    for (let t = 0; t < tapCount; t++) {
      if (s.tapGroup[t] === g) s.order[placed++] = t;
    }
    s.groupSize[g] = placed - (s.groupBegin[g] as number);
  }

  densifyInto(cost, s.cost, 0);
  densifyInto(current, s.pool, 0);
  const genericOwed = cost.generic ?? 0;
  // `canPay` is the authority on "done" and reads a `ManaPool`, so one mutable pool
  // object tracks the dense running total for it. It is this function's own copy.
  const pool: ManaPool = { ...current };
  const plan: ManaTapPlan[] = [];

  while (!canPay(pool, cost)) {
    // At least one pip is still owed (canPay said so). Flooring at 1 matters when
    // the heuristic can't see the shortfall — a hybrid symbol reads as satisfied
    // by either colour — so a useful tap is still accepted instead of the planner
    // concluding the cost is unpayable.
    const owed = Math.max(denseDistanceToPayable(s.pool, s.cost, genericOwed), 1);
    let bestTap = -1;
    let bestGroup = -1;
    let bestDistance = owed;
    let bestFlexibility = Infinity;
    let bestSize = Infinity;

    for (let g = 0; g < sourceCount; g++) {
      if (!s.sourceUntapped[g]) continue;
      const flexibility = s.groupSize[g] as number; // how many colours this source could have made
      const begin = s.groupBegin[g] as number;
      for (let k = 0; k < flexibility; k++) {
        const tap = s.order[begin + k] as number;
        const at = tap * COLOR_COUNT;
        // A tap that costs mana of its own (a filter land) is only a candidate
        // once the RUNNING pool can pay it — the plan is executed in order, so a
        // funding tap earlier in the plan is what makes this one legal by the
        // time it happens, exactly as the engine's own offer gate requires.
        const tapMana = anyTapCost ? s.tapCost[tap] : undefined;
        let afterCost: ManaPool | undefined;
        if (tapMana) {
          const paid = payCost(pool, tapMana);
          if (!paid.ok) continue;
          afterCost = paid.pool;
        }
        let size = 0;
        for (let i = 0; i < COLOR_COUNT; i++) {
          const color = MANA_COLORS[i] as ManaColor;
          const have = afterCost ? afterCost[color] : (s.pool[i] as number);
          const add = s.production[at + i] as number;
          s.trial[i] = have + add;
          // "Size" ranks a tap by how much it actually commits, so a filter land
          // that spends one to make two counts as the net one — otherwise the
          // planner would prefer it to a plain land for a single pip.
          size += add - (afterCost ? (s.pool[i] as number) - have : 0);
        }
        const distance = denseDistanceToPayable(s.trial, s.cost, genericOwed);
        if (distance >= owed) continue; // buys us nothing — never make this tap
        const better =
          distance < bestDistance ||
          (distance === bestDistance && flexibility < bestFlexibility) ||
          (distance === bestDistance && flexibility === bestFlexibility && size < bestSize);
        if (better) {
          bestTap = tap;
          bestGroup = g;
          bestDistance = distance;
          bestFlexibility = flexibility;
          bestSize = size;
        }
      }
    }

    if (bestTap < 0) return undefined; // nothing left that helps — the cost is unpayable
    s.sourceUntapped[bestGroup] = false; // spending the permanent spends all of its modes
    const at = bestTap * COLOR_COUNT;
    // Charge the tap's own mana cost before crediting its production, which is
    // the order `applyTapForMana` uses too — a filter land is a filter, not two
    // free mana.
    const chosenCost = anyTapCost ? s.tapCost[bestTap] : undefined;
    if (chosenCost) {
      const paid = payCost(pool, chosenCost);
      // Unreachable: the candidate was only accepted after this same payment
      // succeeded a moment ago against the same pool. Refusing rather than
      // half-applying keeps the plan's invariant ("every tap in it is legal in
      // order") true even if that ever stops holding.
      if (!paid.ok) return undefined;
      for (let i = 0; i < COLOR_COUNT; i++) {
        const color = MANA_COLORS[i] as ManaColor;
        pool[color] = paid.pool[color];
        s.pool[i] = paid.pool[color];
      }
    }
    for (let i = 0; i < COLOR_COUNT; i++) {
      const total = (s.pool[i] as number) + (s.production[at + i] as number);
      s.pool[i] = total;
      pool[MANA_COLORS[i] as ManaColor] = total;
    }
    plan.push({
      instanceId: s.tapSource[bestTap] as InstanceId,
      mode: s.tapMode[bestTap] as number,
      production: s.tapProduction[bestTap] as ManaProduction,
    });
  }
  return plan;
}

/**
 * The battlefield permanent with this id, by indexed scan.
 *
 * Spelled out rather than `battlefield.find(...)`: the predicate has to close over
 * the id, and V8 allocates that closure on every offered tap — which is per source
 * per castable card per search node.
 */
function findOnBattlefield(battlefield: readonly CardInstance[], id: InstanceId): CardInstance | undefined {
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.instanceId === id) return perm;
  }
  return undefined;
}
