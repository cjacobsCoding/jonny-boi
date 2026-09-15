/**
 * THE DAMAGE-RESULT FUNNEL — what damage DOES once it has been dealt (CR 120.3).
 * §3.105.
 *
 * Dealing damage is two questions asked in order. The first — HOW MUCH lands,
 * after protection and the replacement/prevention layer — is answered once, in
 * `replacement.ts`. The second — WHAT that damage does to its recipient — used
 * to be answered in five places: combat here in core, and `dealDamage`,
 * `dealDamageToEach` and `fight` in the cards package, each with its own copy of
 * "player loses life / walker loses loyalty / creature marks damage". Three of
 * those copies had already drifted: noncombat damage from a lifelink or
 * deathtouch source neither gained life nor destroyed (CR 702.15b and 702.2b
 * both say "damage", not "combat damage").
 *
 * Infect and wither are the reason the second question now has ONE answer. CR
 * 120.3 lists the results of damage as a closed table keyed on the recipient
 * and the source's keywords:
 *
 *   120.3a  player,  source without infect      → loses that much life
 *   120.3b  player,  source with infect         → that many POISON counters
 *   120.3c  planeswalker                        → that many loyalty counters removed
 *   120.3d  creature, source with wither/infect → that many -1/-1 counters
 *   120.3e  creature, source with neither       → that much damage marked
 *   120.3f  source with lifelink                → controller gains that much (in addition)
 *   120.3g  player, COMBAT damage, toxic N      → N more poison counters (in addition)
 *   120.3h  battle                              → that many defense counters removed
 *
 * That table is this function, and nothing else in the engine restates a row
 * of it. A second copy is how an infect creature that FIGHTS would deal marked
 * damage while one that attacks dealt counters — and both are "damage dealt by
 * a source with infect" (CR 702.90e: from any zone, by any means).
 *
 * ## What is deliberately NOT here
 * Protection and the replacement layer run BEFORE this, at the call site, so a
 * prevented hit never reaches it; and the `damagePrevented` event is emitted
 * there, where the prevented amount is known. This function trusts `amount` to
 * be what actually lands.
 */

import type { CardInstance, GameState, PlayerId } from '../state.js';
import type { GameEvent } from '../events.js';
import { isBattle, isPlaneswalker } from '../card.js';
import {
  MINUS_ONE_COUNTER,
  defenseOf,
  effectiveKeywords,
  loyaltyOf,
  removeDefense,
  removeLoyalty,
} from './stats.js';
import type { ContinuousIndex } from './continuous.js';
import { NO_MOD } from './continuous.js';
import { indexReplacements, replaceCounters } from './replacement.js';
import { addPoisonCounters } from '../poison.js';
import { gainLifeAmount } from '../life.js';

/**
 * Apply the results of `amount` damage dealt by `source` to `target` (CR 120.3).
 *
 * `combat` is read by exactly one row — toxic (120.3g) — and carried on the
 * `damageDealt` event for the replay. The continuous `index` is the one the
 * calling decision already built; the source's keywords are read through it so
 * a granted infect ("gains infect until end of turn" — Tainted Strike) is
 * infect, and a source that is not on the battlefield at all (a wither SPELL —
 * Puncture Blast) falls through to its printed keywords, which is what CR
 * 702.80c/702.90e mean by "from any zone".
 */
export function applyDamageResult(
  state: GameState,
  source: CardInstance,
  target: CardInstance | PlayerId,
  amount: number,
  combat: boolean,
  index: ContinuousIndex,
  emit: (e: GameEvent) => void,
): void {
  if (amount <= 0) return;
  const sourceKeywords = effectiveKeywords(source, index.get(source.instanceId) ?? NO_MOD);
  if (typeof target === 'string') {
    emit({ type: 'damageDealt', source: source.instanceId, target, amount, combat });
    if (sourceKeywords.infect === true) {
      // CR 120.3b / 702.90b — poison INSTEAD of life loss. Still damage: the
      // `damageDealt` event above is what "deals damage" triggers match on.
      addPoisonCounters(state, target, amount, emit);
    } else {
      const player = state.players[target];
      player.life -= amount;
      emit({ type: 'lifeChanged', player: target, delta: -amount, to: player.life });
    }
    // CR 120.3g / 702.164c — toxic is IN ADDITION to the row above, and only
    // for combat damage: a toxic creature that fights gives no poison.
    const toxic = sourceKeywords.toxic ?? 0;
    if (combat && toxic > 0) addPoisonCounters(state, target, toxic, emit);
  } else if (isPlaneswalker(target.def)) {
    // CR 120.3c — loyalty is a walker's life total, removed immediately rather
    // than marked; the 0-loyalty death is the SBA pass that follows.
    const removed = removeLoyalty(target, amount);
    emit({ type: 'damageDealt', source: source.instanceId, target: target.instanceId, amount, combat });
    if (removed > 0) {
      emit({ type: 'loyaltyChanged', instanceId: target.instanceId, delta: -removed, to: loyaltyOf(target) });
    }
  } else if (isBattle(target.def)) {
    // CR 120.3h — the exact shape of walker loyalty, on defense counters.
    const removed = removeDefense(target, amount);
    emit({ type: 'damageDealt', source: source.instanceId, target: target.instanceId, amount, combat });
    if (removed > 0) {
      emit({ type: 'defenseChanged', instanceId: target.instanceId, delta: -removed, to: defenseOf(target) });
    }
  } else {
    if (sourceKeywords.infect === true || sourceKeywords.wither === true) {
      // CR 120.3d / 702.80a / 702.90c — -1/-1 counters INSTEAD of marked
      // damage. They go through the CR 614 counter site, so a counter doubler
      // or a Solemnity applies to infect damage exactly as to a placed counter.
      placeMinusOneCounters(state, source, target, amount, emit);
    } else {
      // CR 120.3e — ordinary marked damage, cleared at cleanup.
      target.damageMarked += amount;
    }
    // CR 702.2b — "dealt damage by a source with deathtouch" is destroyed. It
    // says DAMAGE, so it holds whether that damage landed as marks or as
    // counters; the state-based check reads this flag on its own.
    if (sourceKeywords.deathtouch === true) target.markedByDeathtouch = true;
    emit({ type: 'damageDealt', source: source.instanceId, target: target.instanceId, amount, combat });
  }
  if (sourceKeywords.lifelink === true) {
    // CR 120.3f / 702.15b — in addition to every row above, for any damage.
    //
    // The AMOUNT goes through `life.ts`'s one question, because a life-gain
    // replacement (Rhox Faithmender, Boon Reflection) does not care that this
    // life came from lifelink rather than from a resolving spell. The cards
    // package asks the same question for its own gain primitives; this is
    // core's call site, and `core/src/life.test.ts` fails if the two ever
    // disagree ("LIFELINK asks the same question as a resolving effect") — the
    // same arrangement, for the same reason, as the counters funnel two rows
    // above.
    const gained = gainLifeAmount(state, source.controller, amount, emit);
    // CR 118.5 — a gain of nothing is NOT a life-gain event, so "that player
    // gains no life instead" (Sulfuric Vortex) must emit neither event or
    // "whenever you gain life" fires on a gain that did not happen.
    if (gained > 0) {
      const controller = state.players[source.controller];
      controller.life += gained;
      emit({ type: 'gainLife', player: source.controller, amount: gained });
      emit({ type: 'lifeChanged', player: source.controller, delta: gained, to: controller.life });
    }
  }
}

/**
 * Put `amount` -1/-1 counters on a creature through the ONE CR 614 counter site
 * (`replaceCounters`), honouring the counters replace-never-mutate contract
 * (`CardInstance.counters` may be the shared frozen `NO_COUNTERS`).
 *
 * The cards package has the same funnel for its own counter primitives
 * (`addCountersOfKind`); this is core's copy because combat damage cannot reach
 * into a primitive, and the two are kept identical by `damage-result.test.ts`
 * asserting a counter doubler scales infect damage.
 */
function placeMinusOneCounters(
  state: GameState,
  source: CardInstance,
  target: CardInstance,
  amount: number,
  emit: (e: GameEvent) => void,
): void {
  const magnitude = replaceCounters(state, indexReplacements(state), source, target, MINUS_ONE_COUNTER, amount, emit);
  if (magnitude <= 0) return;
  target.counters = {
    ...target.counters,
    [MINUS_ONE_COUNTER]: (target.counters[MINUS_ONE_COUNTER] ?? 0) + magnitude,
  };
  emit({ type: 'counterAdded', instanceId: target.instanceId, kind: MINUS_ONE_COUNTER, amount: magnitude });
}
