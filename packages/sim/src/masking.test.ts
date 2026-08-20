/**
 * THE ONLINE HALF OF THE HIDDEN-INFORMATION GUARANTEE, proved on games the
 * engine really played.
 *
 * `@jonny-boi/protocol`'s `maskStateForSeat` is the twin of
 * `observation.ts`'s policy table: the same promise, the same chokepoint shape,
 * and the side that holds the secret doing the redacting. It is also the half
 * where a leak is a **cheating vector** rather than a biased pilot — the masked
 * view is what travels over a socket to an unauthenticated stranger.
 *
 * `packages/protocol/src/index.test.ts` pins the rule on hand-built fixtures, and
 * `apps/server`'s tests drive real rooms. Neither plays the CARD POOL, and that is
 * exactly the gap that hid a leak on the pilot side for a year: the curated decks
 * never played the mechanic the bug needed. So this file plays full-pool,
 * mechanic-anchored soak decks and masks every state that arises.
 *
 * ## What is checked, precisely
 * For a seat: **no card in the opponent's hand, and no card in EITHER library,
 * may appear anywhere in that seat's view** — at any depth, under any key name
 * (the scan is `collectInstanceIds`, whose vocabulary is derived from core's
 * `INSTANCE_ID_FIELD_NAMES`, so `sourceInstanceId`, `targets`, `attackTargets`'
 * keys and `blocks` pairs all count as naming a card).
 *
 * The one deliberate exception is a question the viewer is **the chooser of**:
 * Thoughtseize's candidate list IS the opponent's hand, and showing it to the
 * caster is the printed card, not a bug. So the chooser's own `pendingChoice` is
 * lifted out before scanning — and the test below immediately checks the other
 * direction, that a NON-chooser and a spectator never see any of it.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
  PLAYER_IDS,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { leakedInstanceIds, maskStateForSeat, maskStateForSpectator } from '@jonny-boi/protocol';
import { loadDeck } from './deck.js';
import { gameSeedFor } from './matchup.js';
import { SOAK_MECHANICS, type SoakMechanicId } from './soak-config.js';
import { buildAnchoredDeck, buildMixedDeck, indexPoolForSoak } from './soak-decks.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const index = indexPoolForSoak(pool.cards);
const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;

/** Hard action cap so a stalled board fails loudly instead of hanging. */
const MAX_ACTIONS = 4000;

/**
 * Matchups anchored on the mechanics that MOVE CARDS BETWEEN HIDDEN AND PUBLIC
 * ZONES, which is where a masking bug can live — plus one unanchored pair as a
 * control. Anchored rather than curated for the reason in the header: a deck list
 * chosen by hand is a deck list that can silently stop reaching the interesting
 * case.
 */
const MATCHUPS: ReadonlyArray<readonly [SoakMechanicId | 'mixed', SoakMechanicId | 'mixed']> = [
  ['buyback', 'graveyard-recursion'],
  ['madness', 'tutor-route'],
  ['mill', 'scry'],
  ['flashback-cast', 'surveil'],
  ['cycling', 'modal-cast'],
  ['mixed', 'mixed'],
];

function deckFor(which: SoakMechanicId | 'mixed', seed: number) {
  const built = which === 'mixed' ? buildMixedDeck(index, seed) : buildAnchoredDeck(index, which, seed);
  // A mechanic the pool cannot anchor is `pool-mechanics.test.ts`'s business, not
  // this file's — but silently falling back would make a green run meaningless.
  expect(built, `${which} could not be anchored — see pool-mechanics.test.ts`).toBeDefined();
  return loadDeck(built!, pool);
}

/** Ids sitting in `player`'s hand. */
function handIds(state: GameState, player: PlayerId): InstanceId[] {
  return state.players[player].hand.map((c) => c.instanceId);
}

/** Ids sitting in either library — hidden from EVERYONE, including their owner. */
function libraryIds(state: GameState): InstanceId[] {
  return PLAYER_IDS.flatMap((id) => state.players[id as PlayerId].library.map((c) => c.instanceId));
}

/** Play one full-pool game, handing every settled state to `onState`. */
function playGame(
  left: SoakMechanicId | 'mixed',
  right: SoakMechanicId | 'mixed',
  seed: number,
  onState: (state: GameState) => void,
): number {
  const deckA = deckFor(left, seed);
  const deckB = deckFor(right, seed ^ 0x27d4eb2f);
  const created = createGame({
    seed,
    decks: { A: { cards: deckA.library }, B: { cards: deckB.library } },
    registry,
  });
  let state = created.state;
  const rngs: Record<PlayerId, ReturnType<typeof createRng>> = {
    A: createRng(seed * 2 + 1),
    B: createRng(seed * 2 + 2),
  };
  let states = 0;
  for (let i = 0; i < MAX_ACTIONS && !state.gameOver; i++) {
    const legal = generateLegalActions(state, DEFAULT_RULES);
    if (legal.length === 0) break;
    const seat = state.priorityPlayer;
    const action = pilot.chooseAction({
      view: state,
      legalActions: legal,
      rng: rngs[seat],
      registry,
      rulesConfig: DEFAULT_RULES,
    });
    state = applyAction(state, action, DEFAULT_RULES, registry).state;
    onState(state);
    states++;
  }
  return states;
}

describe('maskStateForSeat — the online half, over full-pool games', () => {
  it('never carries the opponent’s hand or ANY library into a seat’s view', () => {
    const leaks: string[] = [];
    let statesScanned = 0;
    let choicesSeen = 0;

    MATCHUPS.forEach(([left, right], matchup) => {
      const seed = gameSeedFor(0x4d61736b, matchup);
      statesScanned += playGame(left, right, seed, (state) => {
        if (state.pendingChoice) choicesSeen++;
        for (const id of PLAYER_IDS) {
          const seat = id as PlayerId;
          const view = maskStateForSeat(state, seat);
          const opponent: PlayerId = seat === 'A' ? 'B' : 'A';
          const forbidden = [...handIds(state, opponent), ...libraryIds(state)];
          /*
           * The chooser's own question is lifted out, and ONLY the chooser's:
           * Thoughtseize's candidates ARE the opponent's hand and the card says
           * so. Everything else in the view — battlefield, graveyards, exile,
           * the stack, combat, the manapool — is scanned whole.
           */
          const scannable =
            state.pendingChoice && state.pendingChoice.chooser === seat ? { ...view, pendingChoice: null } : view;
          const leaked = leakedInstanceIds(scannable, forbidden);
          if (leaked.length > 0) {
            leaks.push(`${left} vs ${right} seed ${seed} turn ${state.turnNumber}: seat ${seat} sees ${leaked.join(', ')}`);
          }
        }

        // A spectator is entitled to strictly less than either seat: no hand at
        // all, and never anybody's question.
        const spectator = maskStateForSpectator(state);
        const allHidden = [...handIds(state, 'A'), ...handIds(state, 'B'), ...libraryIds(state)];
        const spectatorLeak = leakedInstanceIds(spectator, allHidden);
        if (spectatorLeak.length > 0) {
          leaks.push(`${left} vs ${right} seed ${seed} turn ${state.turnNumber}: a SPECTATOR sees ${spectatorLeak.join(', ')}`);
        }
      });
    });

    expect(leaks.slice(0, 10)).toEqual([]);
    // A green run must be green because nothing leaked, not because nothing ran.
    expect(statesScanned).toBeGreaterThan(1_000);
    expect(choicesSeen, 'no question was ever parked — the interesting path never ran').toBeGreaterThan(0);
  });

  it('scans decks that really contain the mechanics they are anchored on', () => {
    // The curated-deck failure, blocked here too: if the generator stops reaching
    // a mechanic, this file must say so rather than keep passing over decks where
    // the interesting case cannot arise.
    const problems: string[] = [];
    for (const [left, right] of MATCHUPS) {
      for (const which of [left, right]) {
        if (which === 'mixed') continue;
        const printed = new Set((index.byMechanic.get(which) ?? []).map((c) => c.id));
        if (printed.size === 0) {
          problems.push(`${which}: the pool prints none`);
          continue;
        }
        const deck = buildAnchoredDeck(index, which, 4242);
        if (!deck || !deck.cards.some((e) => printed.has(e.cardId))) {
          problems.push(`${which}: the anchored deck contains none of its ${printed.size} cards`);
        }
      }
    }
    expect(problems).toEqual([]);
    // And the ids named above must still exist in the inventory.
    const known = new Set(SOAK_MECHANICS.map((m) => m.id));
    for (const [left, right] of MATCHUPS) {
      for (const which of [left, right]) {
        if (which !== 'mixed') expect(known.has(which), `${which} is not in SOAK_MECHANICS`).toBe(true);
      }
    }
  });
});
