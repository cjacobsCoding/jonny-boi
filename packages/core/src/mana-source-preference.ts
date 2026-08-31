/**
 * WHICH source should pay, when several could — the policy half of mana payment.
 *
 * `planManaPayment` already ranks candidate taps by how much of the shortfall
 * they close, what they cost in life, whether their mana is restricted, how many
 * colours the source could have made, and how big the bundle is. Five terms, and
 * not one of them knows the thing every human player knows: **tapping a Forest
 * costs you nothing, and tapping a Llanowar Elves costs you a blocker.** With
 * every other term tied — same colour, same size, same flexibility — the ladder
 * fell through to enumeration order, so a board of `Llanowar Elves + Forest`
 * paying `{G}` tapped whichever the engine happened to offer first. That is the
 * reported defect, and this module is the term that decides it.
 *
 * ## Why it is a PARAMETER and not simply the new behaviour
 *
 * This planner is shared: both AI pilots fund every spell through it, and the
 * sim's seeded baselines are pinned byte-identical (DESIGN §7, engineering rule
 * 7). Changing the ranking for everyone changes how the AI plays, silently, in
 * every recorded measurement. So the preference is an explicit, named, DEFAULTED
 * policy — {@link MANA_SOURCE_PREFERENCE_DEFAULT} reproduces the pre-§3.60
 * ranking exactly, and a caller that wants the new behaviour asks for it by
 * name. The human cast path asks; the pilots' answer is a measured decision
 * recorded in DESIGN §3.60, not an assumption.
 *
 * ## What "collateral" means
 *
 * The cost of tapping a source BEYOND the mana it makes, read off the permanent
 * as it is RIGHT NOW rather than off the printed card — {@link CardInstance.def}
 * is the active face and the copied card (a transformed DFC, a Clone), so a
 * permanent that is not a creature right now does not pay the creature price.
 */
import type { CardDefinition } from './card.js';
import { isCreature } from './card.js';
import type { CardInstance } from './state.js';

/**
 * What each kind of collateral costs, in one shared unit. Data, not literals at
 * the comparison site (engineering rule 1), so the ordering between "I lose a
 * body" and "I lose a {T} ability" is one tunable decision in one place.
 */
export interface ManaCollateralWeights {
  /**
   * The source is a CREATURE right now: tapping it for mana spends the body —
   * it cannot attack this turn and cannot block until it untaps. The dearest
   * collateral there is, which is exactly the reported case (a mana elf tapped
   * while a basic land sat untapped beside it).
   */
  readonly creatureBody: number;
  /**
   * The source prints a non-mana activated ability that costs `{T}`: tapping it
   * for mana spends that ability until it untaps. Cheaper than a body because
   * the ability comes back next untap step and a dead creature does not, but
   * plainly dearer than a plain land, which loses nothing at all.
   */
  readonly tapAbility: number;
}

/**
 * The default collateral prices. A creature body is worth two of a spent `{T}`
 * ability: the body is BOTH an attacker this turn and a blocker until it untaps,
 * where the ability is one use that returns on the next untap step. The absolute
 * scale is arbitrary — only the ORDER between them is observable, because the
 * term is a tie-break and never competes with mana, life, or colour.
 */
export const MANA_COLLATERAL_WEIGHTS: ManaCollateralWeights = Object.freeze({
  creatureBody: 2,
  tapAbility: 1,
});

/**
 * WHERE the collateral term sits in `planManaPayment`'s tie-break ladder.
 *
 *  - `'off'` — not consulted at all. The ladder is exactly
 *    `distance → pain → restricted → flexibility → size`, byte-identical to
 *    every plan made before §3.60. **The default.**
 *  - `'belowFlexibility'` — `… → flexibility → collateral → size`. The
 *    conservative placement: it only ever decides a tie the old ladder decided
 *    by enumeration order, which is precisely the reported bug and nothing else.
 *  - `'aboveFlexibility'` — `… → restricted → collateral → flexibility → size`.
 *    Keeping a body outranks keeping a colour option. Offered so the placement
 *    is a MEASURABLE question rather than an argued one; the measurement is
 *    recorded in DESIGN §3.60.
 *
 * Both ranks stay strictly BELOW `pain` and `restricted`: "keep my blocker" must
 * never outrank "do not kill myself", and never strand a restricted mana that
 * would otherwise go unspent.
 */
export type ManaCollateralRank = 'off' | 'belowFlexibility' | 'aboveFlexibility';

/** A complete source-choice policy: where the term sits, and what it prices. */
export interface ManaSourcePreference {
  readonly collateralRank: ManaCollateralRank;
  readonly collateral: ManaCollateralWeights;
}

/**
 * THE DEFAULT — no collateral term. Every caller that does not opt in plans
 * exactly the payment it planned before §3.60, which is what keeps the pilots
 * and every recorded sim baseline untouched by construction.
 */
export const MANA_SOURCE_PREFERENCE_DEFAULT: ManaSourcePreference = Object.freeze({
  collateralRank: 'off',
  collateral: MANA_COLLATERAL_WEIGHTS,
});

/**
 * SPEND THE EXPENDABLE SOURCE FIRST — the human cast path's policy, and the fix
 * for the report. Ties that the old ladder left to enumeration order now go to
 * the source that costs its controller the least to lose: the Forest, not the
 * Llanowar Elves.
 */
export const SPARE_USEFUL_MANA_SOURCES: ManaSourcePreference = Object.freeze({
  collateralRank: 'belowFlexibility',
  collateral: MANA_COLLATERAL_WEIGHTS,
});

/**
 * The same preference with the collateral term promoted ABOVE flexibility — the
 * second arm of the placement measurement (see {@link ManaCollateralRank}).
 * Exported for the same reason `LAND_SEQUENCING_OFF_WEIGHTS` is: it is how both
 * placements run head-to-head in ONE process, forever.
 */
export const SPARE_USEFUL_MANA_SOURCES_FIRST: ManaSourcePreference = Object.freeze({
  collateralRank: 'aboveFlexibility',
  collateral: MANA_COLLATERAL_WEIGHTS,
});

/**
 * Memo of "does this definition print a non-mana activated ability that taps?",
 * keyed by the definition. Same argument as `card.ts`'s mana memos: definitions
 * are immutable and shared across every instance, and this question is asked
 * inside the hottest function in the engine.
 */
const TAP_ABILITY_MEMO = new WeakMap<CardDefinition, boolean>();

/**
 * Whether tapping this permanent for mana would also spend a printed `{T}`
 * ability. Mana abilities live in `manaAbilities`/`produces`/`producesOptions`
 * and are NOT in `activated`, so this cannot mistake the source's own mana
 * ability for a second, lost one.
 */
function hasTapActivatedAbility(def: CardDefinition): boolean {
  const memo = TAP_ABILITY_MEMO.get(def);
  if (memo !== undefined) return memo;
  let found = false;
  const abilities = def.activated;
  if (abilities !== undefined) {
    for (let i = 0; i < abilities.length; i++) {
      if (abilities[i]?.cost.tap === true) {
        found = true;
        break;
      }
    }
  }
  TAP_ABILITY_MEMO.set(def, found);
  return found;
}

/**
 * What tapping `permanent` for mana costs its controller BEYOND the mana — the
 * collateral. `0` for a basic land, which is the whole point: an expendable
 * source scores lowest and therefore gets spent first.
 *
 * Read off `permanent.def`, which is the permanent's CURRENT identity (the face
 * that is up, the card it is copying), never the printed front face. A land that
 * is not a creature right now is not charged for a body it does not have.
 */
export function manaSourceCollateral(
  permanent: CardInstance,
  weights: ManaCollateralWeights = MANA_COLLATERAL_WEIGHTS,
): number {
  const def = permanent.def;
  let cost = 0;
  if (isCreature(def)) cost += weights.creatureBody;
  if (hasTapActivatedAbility(def)) cost += weights.tapAbility;
  return cost;
}
