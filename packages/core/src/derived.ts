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
 *      the creature's base, CR 613.4 layer 7a.
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
import { isCreature, matchesCardFilter } from './card.js';
import type { CardFilter } from './choices.js';
import type { CardInstance, GameState, PlayerId } from './state.js';
import { PLAYER_IDS } from './state.js';
import { devotionTo } from './devotion.js';

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
  // Kindred IS a card type (CR 308), so a Kindred Sorcery in a graveyard counts
  // for two — which is exactly the kind of quietly-wrong number this record
  // exists to prevent.
  kindred: 1 << 8,
});

/** The card-type bits present among the cards of one graveyard. */
function graveyardTypeMask(state: GameState, player: PlayerId): number {
  let mask = 0;
  const graveyard = state.players[player].graveyard;
  for (let i = 0; i < graveyard.length; i++) {
    const types = graveyard[i]!.def.types;
    for (let t = 0; t < types.length; t++) {
      mask |= CARD_TYPE_BIT[types[t]!] ?? 0;
    }
  }
  return mask;
}

/** Popcount over a small mask — a simple loop beats allocating anything. */
function bitCount(mask: number): number {
  let count = 0;
  while (mask !== 0) {
    count += mask & 1;
    mask >>>= 1;
  }
  return count;
}

/** Count distinct card types among cards in BOTH graveyards (Tarmogoyf). */
function cardTypesInAllGraveyards(state: GameState): number {
  let mask = 0;
  for (const pid of PLAYER_IDS) mask |= graveyardTypeMask(state, pid);
  return bitCount(mask);
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
    case 'creaturesYouControlWithDefender': {
      // Axebane Guardian, Doorkeeper, Assault Formation — the wall-tribal count.
      // The keyword is read off the permanent's current definition, the same
      // source `isCreature` above reads; see the type's note for why this module
      // cannot ask the continuous layer.
      let count = 0;
      for (let i = 0; i < battlefield.length; i++) {
        const perm = battlefield[i]!;
        if (perm.controller === you && isCreature(perm.def) && perm.def.keywords?.defender === true) {
          count += 1;
        }
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
    // §3.169 — delirium's count: the same bits, one graveyard.
    case 'cardTypesInYourGraveyard':
      return bitCount(graveyardTypeMask(state, you));
    // §3.163 — CR 700.5, through the same function the gods' type layer reads.
    case 'devotionToWhite':
      return devotionTo(state, you, ['W']);
    case 'devotionToBlue':
      return devotionTo(state, you, ['U']);
    case 'devotionToBlack':
      return devotionTo(state, you, ['B']);
    case 'devotionToRed':
      return devotionTo(state, you, ['R']);
    case 'devotionToGreen':
      return devotionTo(state, you, ['G']);
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
 * WHOSE permanents a FILTERED count reaches — the printed tail of "the number
 * of Mountains **you control**" / "artifacts **they control**" / "Clerics **on
 * the battlefield**".
 */
export type DerivedCountScope = 'you' | 'opponents' | 'any';

/**
 * The BOARD-STATE half of a filtered count — "the number of **tapped** creatures
 * …", "each **untapped** land you control".
 *
 * Its own axis rather than a field on {@link CardFilter}, and that separation is
 * load-bearing. A `CardFilter` reads PRINTED characteristics off a
 * `ChoiceBearingPermanent` (`{ def, chosenAsEntered }`) precisely so the same
 * filter can select a card in a LIBRARY, a HAND or a GRAVEYARD, where "tapped"
 * does not exist and every card would answer the question the same wrong way.
 * Tapped-ness is a fact about a permanent on the battlefield, so it is asked
 * only where the battlefield is — here.
 *
 * CLOSED, like every other vocabulary in this file: a printed board-state word
 * outside these two reports rather than being widened to the nearest one that
 * happens to exist.
 */
export type PermanentStateFilter = 'tapped' | 'untapped';

/**
 * Whether a permanent satisfies a board-state predicate. `undefined` means the
 * count does not care and every permanent passes — the overwhelmingly common
 * case, and the one that costs a single `undefined` check.
 */
function matchesPermanentState(perm: CardInstance, state: PermanentStateFilter | undefined): boolean {
  if (state === undefined) return true;
  return state === 'tapped' ? perm.tapped === true : perm.tapped !== true;
}

/**
 * Count the permanents matching a {@link CardFilter} (DESIGN §3.149).
 *
 * **This is the row that stops the count vocabulary being a row per noun.**
 * Every entry in {@link DerivedCountName} above names one hand-written set, and
 * the printed cards ask for dozens: Mountains, Swamps, Shrines, Equipment,
 * Clerics, artifacts an opponent controls. Written as enum rows that is a core
 * change per card; written as a filter it is a ROW IN THE COMPILER'S PHRASE
 * TABLE (rule 2 — adding the next case must be a row), evaluated by the one
 * `matchesCardFilter` that targeting legality, the statics pass and every
 * search already use, so "Mountain" cannot mean one thing to a fetch and
 * another to a count.
 *
 * It is exactly as FAITHFUL as the enum rows and not one step looser: a
 * `CardFilter` is a closed structure, so a printed noun the compiler cannot turn
 * into one still reports rather than being widened to the nearest noun that
 * happens to exist.
 *
 * PERF: deliberately NOT reachable from {@link evaluateDerivedCount}'s switch,
 * which the characteristic-defining P/T path drives on every stat read. That
 * switch is untouched, so a Tarmogoyf costs exactly what it cost before; only a
 * card that actually prints a filtered count pays for one.
 */
export function countPermanentsMatching(
  state: GameState,
  filter: CardFilter,
  scope: DerivedCountScope,
  you: PlayerId,
  permanentState?: PermanentStateFilter,
): number {
  const battlefield = state.battlefield;
  const them = opponent(you);
  let count = 0;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i]!;
    if (scope === 'you' && perm.controller !== you) continue;
    if (scope === 'opponents' && perm.controller !== them) continue;
    // Board state before the filter: it is one property read, and it rejects
    // most of the battlefield for the counts that ask it at all.
    if (!matchesPermanentState(perm, permanentState)) continue;
    if (matchesCardFilter(perm, filter)) count += 1;
  }
  return count;
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
