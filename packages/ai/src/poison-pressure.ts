/**
 * LETHAL PRESSURE — the two clocks a player can be killed on, kept apart
 * (§3.105).
 *
 * Before poison, "how much damage is coming" and "is that lethal" were one
 * number compared with one life total. Infect (CR 702.90) splits the question:
 * an infect attacker's power is POISON, which never touches life, and ten
 * poison counters lose the game (CR 704.5c) on a clock of their own. Toxic
 * (CR 702.164) adds poison ON TOP of ordinary damage. A pilot that summed an
 * infect 3/3 into its life arithmetic would refuse a block that saves the game
 * at nine poison, and — worse — would declare an "alpha strike for lethal" that
 * gives the opponent three counters and loses every attacker to the crack-back.
 *
 * So the pressure of a set of attackers is a PAIR, and lethal is asked of each
 * clock separately ({@link pressureIsLethal}). The single life-equivalent
 * number ({@link lifeEquivalent}) exists only for RANKING — which attacker to
 * block first, what a fog is worth — where the two clocks genuinely have to be
 * priced on one scale, and it uses the weights' exchange rate rather than a
 * literal so a format with a different starting life re-prices itself.
 *
 * ⚠️ Deliberately CONSERVATIVE in the direction a wrong answer must fall: the
 * blended number can over-state a threat (a defender blocking too eagerly loses
 * a creature), but lethal itself is never claimed from the blend, because a
 * false "lethal" throws the game where a false "not lethal" only delays it.
 */

import {
  POISON_LOSS_THRESHOLD,
  indexReplacements,
  poisonOf,
  projectDamage,
  type CardInstance,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import type { PilotView } from './pilot.js';
import type { HeuristicWeights } from './weights.js';
import type { ContinuousIndex } from './board-stats.js';
import { keywordsOf, power } from './board-stats.js';

/** Damage headed for a life total, and poison headed for the ten-counter clock. */
export interface LethalPressure {
  readonly damage: number;
  readonly poison: number;
}

export const NO_PRESSURE: LethalPressure = Object.freeze({ damage: 0, poison: 0 });

/** Poison counters this player can still take before CR 704.5c takes the game. */
export function poisonRemaining(view: PilotView, player: PlayerId): number {
  const seat = view.players[player];
  return Math.max(0, POISON_LOSS_THRESHOLD - (seat ? poisonOf(seat) : 0));
}

/**
 * What ONE attacker's `amount` of combat damage does to the defending player,
 * read through the SAME keyword table core's damage-result funnel reads:
 * infect turns the whole amount into poison (CR 120.3b), toxic adds its value
 * as poison in addition (CR 120.3g), everything else is life.
 */
export function attackerPressure(attacker: CardInstance, amount: number, index: ContinuousIndex): LethalPressure {
  if (amount <= 0) return NO_PRESSURE;
  const kw = keywordsOf(attacker, index);
  const toxic = kw.toxic ?? 0;
  if (kw.infect === true) return { damage: 0, poison: amount + toxic };
  return toxic > 0 ? { damage: amount, poison: toxic } : { damage: amount, poison: 0 };
}

/**
 * The pressure a set of attackers puts on `defender` if every one connects —
 * `totalIncomingDamage`'s generalisation, with the same replacement-layer
 * projection (asked once, never applied) so a fog on the stack or a damage
 * doubler on their side is read before the pair is built.
 */
export function attackPressure(
  view: PilotView,
  attackerIds: readonly InstanceId[],
  defender: PlayerId,
  index: ContinuousIndex,
): LethalPressure {
  const replacements = indexReplacements(view as GameState);
  let damage = 0;
  let poison = 0;
  for (const id of attackerIds) {
    const a = view.battlefield.find((c) => c.instanceId === id);
    if (!a) continue;
    const printed = power(a, index);
    const projected =
      replacements.length === 0 || printed <= 0
        ? printed
        : projectDamage(view as GameState, replacements, a, a.controller, undefined, defender, printed, true).amount;
    const p = attackerPressure(a, projected, index);
    damage += p.damage;
    poison += p.poison;
  }
  return { damage, poison };
}

/**
 * Whether this pressure kills `defender` — each clock asked its OWN question.
 * Poison is judged only when some is actually coming: a player at nine counters
 * facing a vanilla attack is not facing lethal poison.
 */
export function pressureIsLethal(view: PilotView, defender: PlayerId, pressure: LethalPressure): boolean {
  const seat = view.players[defender];
  if (!seat) return false;
  if (pressure.damage > 0 && pressure.damage >= seat.life) return true;
  return pressure.poison > 0 && pressure.poison >= poisonRemaining(view, defender);
}

/**
 * The two clocks on ONE scale, for ranking and valuation only — never for the
 * lethal question itself (see the file comment). One poison counter is worth
 * `weights.poisonCounterLifeEquivalent` life.
 */
export function lifeEquivalent(pressure: LethalPressure, weights: HeuristicWeights): number {
  return pressure.damage + pressure.poison * weights.poisonCounterLifeEquivalent;
}

/** Ranking helper: one attacker's whole power, priced on the life scale. */
export function faceThreat(attacker: CardInstance, index: ContinuousIndex, weights: HeuristicWeights): number {
  return lifeEquivalent(attackerPressure(attacker, power(attacker, index), index), weights);
}
