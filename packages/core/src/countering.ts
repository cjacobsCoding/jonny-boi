/**
 * "CAN'T BE COUNTERED" (CR 701.5) — the two printings of one rule, and the single
 * question every counter path asks before it removes a spell from the stack.
 *
 * ## It is NOT a targeting restriction
 * The classic wrong implementation makes an uncounterable spell an illegal target
 * for Counterspell. That is a different card: CR 701.5a makes *countering* the
 * thing that fails, not the targeting, so Counterspell may target Supreme Verdict,
 * resolves, and does nothing — and the counterspell is still spent. Enforcing it
 * in `targeting.ts` would hand the caster their card back.
 *
 * ## One enforcement point, every path
 * The rule is asked exactly where a spell actually leaves the stack to be
 * countered (`counterSpellOnStack` in the cards package), so the plain
 * counterspell, "counter unless its controller pays", every modal counter mode and
 * the ward trigger inherit it without a second copy to keep in step. A new
 * counter-shaped primitive gets it for free, which is the same argument
 * `destroyPermanent` makes for indestructible.
 *
 * ## Two printings, one question
 *   - on the SPELL: `CardDefinition.cantBeCountered` — "This spell can't be
 *     countered" (Supreme Verdict, Abrupt Decay, Dovin's Veto).
 *   - on a PERMANENT: `CardDefinition.spellsCantBeCountered` — "Spells you control
 *     can't be countered" (Chimil), "Creature spells you control can't be
 *     countered" (Rhythm of the Wild), "Spells can't be countered" (Lier).
 *
 * The second is a continuous ability with no home in `statics.ts`, for the same
 * reason `player-statics.ts` exists: a {@link StaticAbility} filters PERMANENTS and
 * contributes a P/T-and-keyword modification, and the subject here is a spell on
 * the stack. Its lifetime is derived from the board on every read, so it ends the
 * instant its source does — a Chimil destroyed in response really does let the
 * counterspell through.
 */

import type { CardDefinition } from './card.js';
import type { CardFilter } from './choices.js';
import { matchesCardFilter } from './choices.js';
import type { StaticControllerScope } from './statics.js';
import { DEFAULT_STATIC_SCOPE } from './statics.js';
import type { GameState, PlayerId } from './state.js';

/**
 * "Spells [matching this] can't be countered", as declared by a permanent.
 *
 * Reuses the shared {@link CardFilter} so "creature spells" and "creature and
 * enchantment spells" are one field with different data rather than a rule each,
 * and reuses {@link StaticControllerScope} so Lier's unrestricted "Spells can't be
 * countered" is the same shape at `'any'`.
 */
export interface UncounterableSpellsAbility {
  /**
   * Which spells it covers. Absent means EVERY spell, which is what "Spells you
   * control can't be countered" says — the filter narrows to a card type only
   * when the card prints one.
   */
  readonly filter?: CardFilter;
  /** Whose spells. Defaults to {@link DEFAULT_STATIC_SCOPE} ("you control"). */
  readonly controller?: StaticControllerScope;
}

/**
 * Whether a spell on the stack can currently be countered.
 *
 * `caster` is the spell's controller, which is what the `'you'` / `'opponent'`
 * scopes are measured against — a Chimil protects its controller's spells, not
 * everyone's.
 *
 * The board walk happens only when the spell does not already say it is
 * uncounterable, and only on the rare occasion something tries to counter a spell
 * at all; this is not on any hot path.
 */
export function spellCanBeCountered(state: GameState, def: CardDefinition, caster: PlayerId): boolean {
  if (def.cantBeCountered === true) return false;
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const permanent = battlefield[i]!;
    const ability = permanent.def.spellsCantBeCountered;
    if (ability === undefined) continue;
    if (!abilityCovers(ability, permanent.controller, def, caster)) continue;
    return false;
  }
  // Emblems say it too (a planeswalker ultimate), from the command zone, exactly
  // as they radiate anthems there.
  for (const owner of ['A', 'B'] as const) {
    const command = state.players[owner].command;
    for (let i = 0; i < command.length; i++) {
      const ability = command[i]!.def.spellsCantBeCountered;
      if (ability === undefined) continue;
      if (!abilityCovers(ability, owner, def, caster)) continue;
      return false;
    }
  }
  return true;
}

/** Whether one "spells can't be countered" ability reaches this spell. */
function abilityCovers(
  ability: UncounterableSpellsAbility,
  source: PlayerId,
  def: CardDefinition,
  caster: PlayerId,
): boolean {
  const scope = ability.controller ?? DEFAULT_STATIC_SCOPE;
  if (scope === 'you' && caster !== source) return false;
  if (scope === 'opponent' && caster === source) return false;
  // The filter reads PRINTED characteristics of the card on the stack, which is
  // all a spell has — the continuous layer reaches permanents, not stack objects.
  return matchesCardFilter({ def }, ability.filter);
}
