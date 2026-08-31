/**
 * Which mana-source preference a pilot plans its payments under (§3.60).
 *
 * One line, its own module, on purpose: `planManaPayment` is called from nine
 * places across `heuristic.ts` and `land-sequencing.ts`, and a pilot that spared
 * its mana elves when funding a spell but not when checking whether a land drop
 * unlocks one would be two pilots wearing one id. Every call site reads the
 * answer from here, so there is exactly one.
 */
import {
  MANA_SOURCE_PREFERENCE_DEFAULT,
  SPARE_USEFUL_MANA_SOURCES,
  type ManaSourcePreference,
} from '@jonny-boi/core';
import type { HeuristicWeights } from './weights.js';

/**
 * The preference `weights` asks for. Both answers are frozen module constants,
 * so this allocates nothing on the hottest path in the sim.
 */
export function manaPreferenceOf(weights: HeuristicWeights): ManaSourcePreference {
  return weights.spareUsefulManaSources ? SPARE_USEFUL_MANA_SOURCES : MANA_SOURCE_PREFERENCE_DEFAULT;
}

/**
 * THE §3.60 ABLATION PRESET — merge over any weight set to make the pilot spare
 * its useful mana sources (spend the Forest, keep the Llanowar Elves).
 *
 * Exported for the same reason `LAND_SEQUENCING_OFF_WEIGHTS` and
 * `LEDGER_PRICING_OFF_WEIGHTS` are: it is how the strength comparison behind the
 * §3.60 default runs BOTH arms in one process, and how anyone re-checks it
 * later without editing code.
 */
export const SPARE_MANA_SOURCES_WEIGHTS: Partial<HeuristicWeights> = Object.freeze({
  spareUsefulManaSources: true,
});
