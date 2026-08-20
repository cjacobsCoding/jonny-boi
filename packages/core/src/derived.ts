/**
 * DERIVED COUNTS — the one evaluator behind every "equal to the number of …"
 * value in the engine.
 *
 * Two consumers, deliberately sharing one vocabulary ({@link DerivedCountName},
 * declared in card.ts so definitions can carry it as data):
 *
 *   1. **Derived effect params** — "deals damage equal to the number of
 *      creatures you control". The `cards` package's `intParam` chokepoint
 *      resolves those descriptors through {@link evaluateDerivedCount}.
 *   2. **Characteristic-defining P/T** — Tarmogoyf's star-power box. The continuous
 *      layer (`internal/continuous.ts`) folds {@link characteristicValue} in as
 *      the creature's base, CR 613.3 layer 7a.
 *
 * Both re-derive from the CURRENT state on every read — nothing is stored, so
 * nothing can go stale: a graveyard filling MID-combat changes a Tarmogoyf's
 * size before the state-based actions run, exactly as printed.
 *
 * PERF: this runs inside the stat pipeline, which combat, SBAs, legality and
 * serialization all drive. Every branch is an indexed loop with no closure and
 * no allocation; the graveyard type-count uses a small bitmask, not a Set.
 */

import type { CardType, CharacteristicFormula, DerivedCountName } from './card.js';
import { isCreature } from './card.js';
import type { GameState, PlayerId } from './state.js';
import { PLAYER_IDS } from './state.js';

/** The other seat (local copy — this module sits below the zone helpers). */
function opponent(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/**
 * Bit assigned to each card type for the graveyard type-count. A fixed record
 * (not an array `indexOf`) so the per-card cost is one property read; the
 * engine's card types fit comfortably in one small integer.
 *
 * `Record<CardType, number>` is EXHAUSTIVE on purpose: adding a card type to
 * core makes this record fail to compile until the new type is given a bit,
 * which is exactly what happened when battles landed. Tarmogoyf counts card
 * types in graveyards, and a type silently missing from this table would make
 * him quietly smaller than printed — the class of infidelity that is hardest
 * to notice, since nothing errors and the number is merely wrong.
 */
const CARD_TYPE_BIT: Readonly<Record<CardType, number>> = Object.freeze({
  land: 1 << 0,
  creature: 1 << 1,
  instant: 1 << 2,
  sorcery: 1 << 3,
  artifact: 1 << 4,
  enchantment: 1 << 5,
  planeswalker: 1 << 6,
  battle: 1 << 7,
});

/** Count distinct card types among cards in BOTH graveyards (Tarmogoyf). */
function cardTypesInAllGraveyards(state: GameState): number {
  let mask = 0;
  for (const pid of PLAYER_IDS) {
    const graveyard = state.players[pid].graveyard;
    for (let i = 0; i < graveyard.length; i++) {
      const types = graveyard[i]!.def.types;
      for (let t = 0; t < types.length; t++) {
        mask |= CARD_TYPE_BIT[types[t]!] ?? 0;
      }
    }
  }
  // Popcount over a 7-bit mask — a simple loop beats allocating anything.
  let count = 0;
  while (mask !== 0) {
    count += mask & 1;
    mask >>>= 1;
  }
  return count;
}

/** Count creature CARDS in one player's graveyard (Boneyard Wurm). */
function creaturesInGraveyard(state: GameState, player: PlayerId): number {
  const graveyard = state.players[player].graveyard;
  let count = 0;
  for (let i = 0; i < graveyard.length; i++) {
    if (isCreature(graveyard[i]!.def)) count += 1;
  }
  return count;
}

/**
 * Evaluate one derived count against the CURRENT state. `you` is the player the
 * count is relative to — an effect's controller, a CDA permanent's controller.
 *
 * A count outside the closed vocabulary evaluates to 0; the compiler never
 * emits one, so the branch exists only as the safe degradation for hand-built
 * data (rule 6: a clear no-op, never a crash).
 */
export function evaluateDerivedCount(state: GameState, countOf: DerivedCountName, you: PlayerId): number {
  const battlefield = state.battlefield;
  switch (countOf) {
    case 'creaturesYouControl': {
      let count = 0;
      for (let i = 0; i < battlefield.length; i++) {
        const perm = battlefield[i]!;
        if (perm.controller === you && isCreature(perm.def)) count += 1;
      }
      return count;
    }
    case 'creaturesOpponentControls': {
      const them = opponent(you);
      let count = 0;
      for (let i = 0; i < battlefield.length; i++) {
        const perm = battlefield[i]!;
        if (perm.controller === them && isCreature(perm.def)) count += 1;
      }
      return count;
    }
    case 'creaturesOnBattlefield': {
      let count = 0;
      for (let i = 0; i < battlefield.length; i++) {
        if (isCreature(battlefield[i]!.def)) count += 1;
      }
      return count;
    }
    case 'landsYouControl': {
      let count = 0;
      for (let i = 0; i < battlefield.length; i++) {
        const perm = battlefield[i]!;
        if (perm.controller === you && perm.def.types.includes('land')) count += 1;
      }
      return count;
    }
    case 'cardsInYourHand':
      return state.players[you].hand.length;
    case 'cardsInYourGraveyard':
      return state.players[you].graveyard.length;
    case 'creaturesInYourGraveyard':
      return creaturesInGraveyard(state, you);
    case 'cardTypesInAllGraveyards':
      return cardTypesInAllGraveyards(state);
    // `timesThisWasKicked` is deliberately absent: it is a fact about the
    // RESOLUTION, not about the board, so this board-only evaluator genuinely
    // cannot answer it and falls through to zero. The one caller that can —
    // `intParam` in `packages/cards/effect-helpers.ts`, which holds the effect
    // context — answers it before reaching here.
    default:
      return 0;
  }
}

/**
 * The value of one characteristic-defining formula, right now: the count plus
 * the printed offset (Tarmogoyf's toughness is "that number plus 1").
 */
export function characteristicValue(
  state: GameState,
  formula: CharacteristicFormula,
  controller: PlayerId,
): number {
  return evaluateDerivedCount(state, formula.countOf, controller) + (formula.plus ?? 0);
}
