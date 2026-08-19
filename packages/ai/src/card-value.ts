/**
 * What a CARD is worth to the player who holds it — the one place the pilot puts a
 * number on "which of these would I rather keep".
 *
 * It lives in its own module (rather than inside `choices.ts`) because two things
 * now need it: answering a card-selection choice ("discard your worst card") and
 * scoring what an EFFECT is worth (`effect-value.ts` prices a countered spell or a
 * regrown card by exactly the same ruler). One ranking, two consumers, no second
 * scoring vocabulary.
 *
 * Deliberately coarse and fully weight-driven (DESIGN §1: no magic numbers); it
 * only has to ORDER cards, not price them.
 */

import type { CardInstance, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  convertedManaCost,
  isCreature,
  isLand,
  PLAYER_IDS,
  playerZone,
} from '@jonny-boi/core';
import type { ContinuousIndex } from './board-stats.js';
import { boardIndex, OFF_BOARD_INDEX, statTotal } from './board-stats.js';
import type { HeuristicWeights } from './weights.js';

/**
 * The board facts that change what a card in hand is worth.
 *
 * A land is the card you pitch first *once your mana is built*, and the card you
 * would never give up while you are still short of it — pitching your only land on
 * turn two is how a pilot loses a game to its own Brainstorm. So the ranking needs
 * one piece of context: how much mana the card's controller has already got.
 *
 * Both seats are precomputed because a single choice can rank the OPPONENT's cards
 * (Thoughtseize picks from the victim's hand), and the right ruler there is still
 * the victim's board, not the caster's.
 */
export interface CardValueContext {
  /** Lands each player controls on the battlefield. */
  readonly landsInPlay: Readonly<Record<PlayerId, number>>;
  /**
   * The board's continuous aggregate, built once with the land counts. A card
   * being ranked can be a PERMANENT (a choice that picks something to sacrifice),
   * and an anthem, an Equipment or a `*` P/T box changes what that permanent is
   * worth — so the ruler reads the same numbers combat does.
   */
  readonly index: ContinuousIndex;
}

/**
 * Read the land counts a {@link CardValueContext} needs off a live state.
 *
 * `index` is accepted rather than always built because a caller that is already
 * holding this position's continuous index (every pilot decision is) would
 * otherwise pay for a second identical pass over the battlefield.
 */
export function cardValueContext(state: GameState, index: ContinuousIndex = boardIndex(state)): CardValueContext {
  const landsInPlay: Record<PlayerId, number> = { A: 0, B: 0 };
  for (const perm of state.battlefield) {
    if (isLand(perm.def)) landsInPlay[perm.controller] += 1;
  }
  return { landsInPlay, index };
}

/**
 * What a card is worth to its controller.
 *
 * An unknown instance (already gone from the zone it was offered from — a choice
 * can outlive its candidates) scores zero rather than blowing up. Passing no
 * `context` keeps the pure, board-independent ranking (bigger creature > small
 * creature ≈ expensive spell > cheap spell > land), which is what a caller with no
 * state in hand wants.
 */
export function cardValue(
  card: CardInstance | undefined,
  weights: HeuristicWeights,
  context?: CardValueContext,
): number {
  if (!card) return 0;
  const def = card.def;
  if (isLand(def)) return landValue(card.controller, weights, context);
  if (isCreature(def)) {
    // No context ⇒ the caller has no board (ranking cards in the abstract), so the
    // read is printed-plus-counters and says so through `OFF_BOARD_INDEX`.
    const stats = statTotal(card, context?.index ?? OFF_BOARD_INDEX);
    return weights.choiceCreatureBaseValue + stats * weights.choiceCreaturePerStatValue;
  }
  const manaValue = def.cost ? convertedManaCost(def.cost) : 0;
  return weights.choiceSpellBaseValue + manaValue * weights.choiceSpellPerManaValue;
}

/** A land is chaff on a built board and a lifeline on an unbuilt one. */
function landValue(controller: PlayerId, weights: HeuristicWeights, context?: CardValueContext): number {
  if (!context) return weights.choiceLandValue;
  const short = context.landsInPlay[controller] < weights.choiceLandsWanted;
  return short ? weights.choiceLandShortValue : weights.choiceLandValue;
}

/** Find a card instance anywhere in the state (battlefield, any player's zones). */
export function findInstance(state: GameState, id: InstanceId): CardInstance | undefined {
  for (const card of state.battlefield) if (card.instanceId === id) return card;
  for (const pid of PLAYER_IDS) {
    const player = state.players[pid];
    for (const zone of ['hand', 'library', 'graveyard', 'exile', 'command'] as const) {
      const cards = playerZone(player, zone);
      if (!cards) continue;
      for (const card of cards) if (card.instanceId === id) return card;
    }
  }
  return undefined;
}
