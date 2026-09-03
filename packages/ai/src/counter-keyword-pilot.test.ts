/**
 * THE PILOT PLAYS THE COUNTER KEYWORD FAMILY (§3.110).
 *
 * The family asks the pilot four questions a valence cannot answer, and each is
 * read off the board the way a player reads it:
 *
 *  1. **RIOT** — haste when the creature can attack PROFITABLY right now, the
 *     counter otherwise. A permanent +1/+1 beats a haste that will never be used.
 *  2. **UNLEASH** — the counter while we are racing (our board is at least
 *     theirs, so the creature attacks rather than blocks); no counter when we
 *     are behind and will need it to block.
 *  3. **EXPLORE** — the surveil judgement one card wide, through the SAME
 *     `cardValue` and threshold a scry look uses. On the default weights that
 *     means it always keeps, and the test says why that is honest rather than
 *     tuning around it.
 *  4. **DEVOUR** — feed a body worth less than the counters it becomes, and
 *     never feed one worth more.
 *  5. **FABRICATE** — the counters or the Servos, compared through the same
 *     rulers `effect-value` prices the ref with. On the default weights that
 *     comes out Servos: N 1/1 bodies price above 2N stat points, which is also
 *     how the mechanic plays.
 *
 * Plus the pricing invariant that keeps every counter-placing body on ONE
 * ruler: each is worth the permanent stat change it makes
 * (`modeCounterPerStatValue` per stat point), so a fabricate's counter mode and
 * a plain "put a +1/+1 counter" line cannot be priced two ways.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, ChoiceRequest, GameState, PendingChoice } from '@jonny-boi/core';
import { createGame, normalizeChoiceRequest } from '@jonny-boi/core';
import { answerChoiceHeuristically } from './choices.js';
import { resolutionValueContext, valueOfEffect } from './effect-value.js';
import { cardValueContext } from './card-value.js';
import { creatureDef, landDef, putOnBattlefield } from './test-support.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

const W = DEFAULT_HEURISTIC_WEIGHTS;
const MOUNTAIN = landDef('Mountain', 'R');
const BEAR: CardDefinition = creatureDef('Bear', 2, 2);
const GIANT: CardDefinition = creatureDef('Hill Giant', 3, 3);
const WALL: CardDefinition = creatureDef('Wall', 0, 6);
const SQUIRREL: CardDefinition = creatureDef('Squirrel', 1, 1);
/** A fat body nobody should feed to a devour 1 (its `cardValue` is well over 6). */
const DRAGON: CardDefinition = creatureDef('Dragon', 5, 5);

/** A started game with an empty-ish board — every position below is built by hand. */
function newGame(): GameState {
  const { state } = createGame({
    seed: 3110,
    decks: {
      A: { cards: Array.from({ length: 30 }, () => MOUNTAIN) },
      B: { cards: Array.from({ length: 30 }, () => MOUNTAIN) },
    },
  });
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

function park(request: ChoiceRequest, sourceInstanceId = 1): PendingChoice {
  const choice = normalizeChoiceRequest(request, { id: 7, sourceInstanceId, sourceName: 'Zhur-Taa Goblin' });
  if (!choice) throw new Error('expected a normalised choice');
  return choice;
}

/** The pilot's yes/no, unwrapped from the action it returns. */
function confirmed(state: GameState, choice: PendingChoice): boolean {
  const action = answerChoiceHeuristically(state, choice, W);
  if (action.kind !== 'answerChoice' || action.answer.kind !== 'confirm') {
    throw new Error(`expected a confirm answer, got ${action.kind}`);
  }
  return action.answer.yes;
}

/** The cards the pilot picks, unwrapped. */
function picked(state: GameState, choice: PendingChoice): readonly number[] {
  const action = answerChoiceHeuristically(state, choice, W);
  if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') {
    throw new Error(`expected a selectCards answer, got ${action.kind}`);
  }
  return action.answer.instanceIds;
}

const RIOT_REQUEST = { kind: 'confirm', chooser: 'A', prompt: 'Riot', valence: 'neutral', context: 'riot' } as const;
const UNLEASH_REQUEST = { kind: 'confirm', chooser: 'A', prompt: 'Unleash', valence: 'neutral', context: 'unleash' } as const;
const EXPLORE_REQUEST = { kind: 'confirm', chooser: 'A', prompt: 'Explore', valence: 'neutral', context: 'explore' } as const;

describe('riot — haste when the swing is profitable, the counter otherwise', () => {
  /** The riot creature ON THE STACK, which is where it is while its script runs. */
  function withEnteringGoblin(state: GameState): number {
    const goblin = { ...creatureDef('Zhur-Taa Goblin', 2, 2) };
    const [inst] = putOnBattlefield(state, 'A', [goblin]);
    return inst!.instanceId;
  }

  it('takes HASTE into an empty board on our own precombat main — the swing is free', () => {
    const state = newGame();
    state.activePlayer = 'A';
    state.step = 'precombatMain';
    const id = withEnteringGoblin(state);
    expect(confirmed(state, park(RIOT_REQUEST, id))).toBe(false); // false = haste
  });

  it('takes the COUNTER when a bigger untapped blocker would eat the attacker', () => {
    const state = newGame();
    state.activePlayer = 'A';
    state.step = 'precombatMain';
    const id = withEnteringGoblin(state);
    putOnBattlefield(state, 'B', [GIANT]);
    expect(confirmed(state, park(RIOT_REQUEST, id))).toBe(true); // true = the counter
  });

  it('takes the COUNTER on the OPPONENT’s turn — haste buys nothing this turn', () => {
    const state = newGame();
    state.activePlayer = 'B';
    state.step = 'precombatMain';
    const id = withEnteringGoblin(state);
    expect(confirmed(state, park(RIOT_REQUEST, id))).toBe(true);
  });

  it('a TAPPED big blocker does not deter it — a tapped creature cannot block', () => {
    const state = newGame();
    state.activePlayer = 'A';
    state.step = 'precombatMain';
    const id = withEnteringGoblin(state);
    const [giant] = putOnBattlefield(state, 'B', [GIANT]);
    giant!.tapped = true;
    expect(confirmed(state, park(RIOT_REQUEST, id))).toBe(false);
  });
});

describe('unleash — the counter while racing, none while behind', () => {
  it('takes the counter with the board even', () => {
    const state = newGame();
    putOnBattlefield(state, 'A', [BEAR]);
    putOnBattlefield(state, 'B', [BEAR]);
    expect(confirmed(state, park(UNLEASH_REQUEST))).toBe(true);
  });

  it('declines when the opponent has more creatures — it will have to block', () => {
    const state = newGame();
    putOnBattlefield(state, 'A', [BEAR]);
    putOnBattlefield(state, 'B', [BEAR, BEAR, WALL]);
    expect(confirmed(state, park(UNLEASH_REQUEST))).toBe(false);
  });
});

describe('explore — the surveil judgement, one card wide', () => {
  /** Put `def` on top of A's library and nothing else there. */
  function withTopCard(state: GameState, def: CardDefinition): void {
    state.players.A.library = [];
    const [inst] = putOnBattlefield(state, 'A', [def]);
    state.battlefield.length = 0;
    inst!.zone = 'library';
    state.players.A.library.push(inst!);
  }

  /** The pilot's yes/no under a named weight set, so the threshold seam is testable. */
  function binsUnder(state: GameState, weights: typeof W): boolean {
    const action = answerChoiceHeuristically(state, park(EXPLORE_REQUEST), weights);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'confirm') throw new Error('expected a confirm');
    return action.answer.yes;
  }

  it('KEEPS every revealed card on the default weights — and that is the honest default, not a bug', () => {
    // Explore only ever asks about a NONLAND (a land goes straight to hand),
    // and every nonland prices at or above `choiceSpellBaseValue` = 8, over the
    // keep threshold of 5. Binning a card the deck could draw is a loss unless
    // the graveyard is worth something, which this value model does not price.
    const small = newGame();
    withTopCard(small, SQUIRREL);
    expect(binsUnder(small, W)).toBe(false);
    const big = newGame();
    withTopCard(big, DRAGON);
    expect(binsUnder(big, W)).toBe(false);
  });

  it('the THRESHOLD is the live seam — raise it above a 1/1 and the same board bins it, while the Dragon still stays', () => {
    // Not a tuning knob turned to make a test pass: this is what proves the
    // reader READS the card rather than answering a constant. A 1/1 prices 14,
    // a 5/5 prices 30, so a threshold of 20 separates them.
    const between = { ...W, scryKeepValueThreshold: 20 };
    const small = newGame();
    withTopCard(small, SQUIRREL);
    expect(binsUnder(small, between)).toBe(true);
    const big = newGame();
    withTopCard(big, DRAGON);
    expect(binsUnder(big, between)).toBe(false);
  });

  it('an empty library keeps rather than throwing — nothing was revealed', () => {
    const state = newGame();
    state.players.A.library = [];
    expect(binsUnder(state, W)).toBe(false);
  });
});

describe('devour — feed what is worth less than the counters it becomes', () => {
  /** The devouring creature, on the battlefield with the `devourChoice` ref on its def. */
  function withDevourer(state: GameState, perSacrifice: number): number {
    const def: CardDefinition = {
      ...creatureDef('Gorger Wurm', 5, 5),
      effects: [{ primitive: 'devourChoice', params: { amount: perSacrifice, filter: { anyOfTypes: ['creature'] } } }],
    };
    const [inst] = putOnBattlefield(state, 'A', [def]);
    return inst!.instanceId;
  }

  function devourRequest(chooser: 'A', candidates: readonly { instanceId: number; cardId: string; name: string }[]) {
    return {
      kind: 'selectCards',
      chooser,
      prompt: 'Devour 1: sacrifice any number',
      candidates: candidates.map((c) => ({ ...c, zone: 'battlefield' as const, controller: 'A' as const })),
      min: 0,
      max: candidates.length,
      valence: 'neutral',
      fromZone: 'battlefield',
      context: 'devour',
    } as const;
  }

  it('feeds a 1/1 to a devour 3 and refuses to feed the Dragon', () => {
    const state = newGame();
    const wurm = withDevourer(state, 3);
    const [squirrel, dragon] = putOnBattlefield(state, 'A', [SQUIRREL, DRAGON]);
    const choice = park(
      devourRequest('A', [
        { instanceId: squirrel!.instanceId, cardId: SQUIRREL.id, name: SQUIRREL.name },
        { instanceId: dragon!.instanceId, cardId: DRAGON.id, name: DRAGON.name },
      ]),
      wurm,
    );
    const fed = picked(state, choice);
    expect(fed).toContain(squirrel!.instanceId);
    expect(fed).not.toContain(dragon!.instanceId);
  });

  it('a devour 1 feeds NOTHING — one counter is not worth a body', () => {
    const state = newGame();
    const wurm = withDevourer(state, 1);
    const [squirrel] = putOnBattlefield(state, 'A', [SQUIRREL]);
    const choice = park(
      devourRequest('A', [{ instanceId: squirrel!.instanceId, cardId: SQUIRREL.id, name: SQUIRREL.name }]),
      wurm,
    );
    expect(picked(state, choice)).toEqual([]);
  });
});

describe('fabricate — counters or Servos, whichever the board wants', () => {
  /** The fabricating creature on the battlefield, with its own trigger ref on the def. */
  function withFabricator(state: GameState, count: number): number {
    const def: CardDefinition = {
      ...creatureDef('Glint-Sleeve Artisan', 2, 2),
      triggers: [
        {
          condition: { on: 'etb' },
          effects: [{ primitive: 'fabricateChoice', params: { amount: count } }],
          label: `Fabricate ${count}`,
        },
      ],
    };
    const [inst] = putOnBattlefield(state, 'A', [def]);
    return inst!.instanceId;
  }

  const FABRICATE_REQUEST = { kind: 'confirm', chooser: 'A', prompt: 'Fabricate', valence: 'neutral', context: 'fabricate' } as const;

  /** The pilot's yes/no under a named weight set, so the price seam is testable. */
  function takesCountersUnder(state: GameState, id: number, weights: typeof W): boolean {
    const action = answerChoiceHeuristically(state, park(FABRICATE_REQUEST, id), weights);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'confirm') throw new Error('expected a confirm');
    return action.answer.yes;
  }

  it('takes the SERVOS on the default weights — N 1/1 bodies price above 2N stat points, and that is how it plays', () => {
    const state = newGame();
    const id = withFabricator(state, 2);
    expect(takesCountersUnder(state, id, W)).toBe(false);
  });

  it('the PRICE is the live seam — make a stat point dear enough and the same board takes the counters', () => {
    // Not a knob turned to force a pass: it is what proves the answer is a
    // comparison of the two printed halves rather than a constant.
    const state = newGame();
    const id = withFabricator(state, 2);
    expect(takesCountersUnder(state, id, { ...W, modeCounterPerStatValue: 50 })).toBe(true);
  });
});

describe('one ruler for every counter the family places', () => {
  const ctx = (state: GameState) => resolutionValueContext(state, 'A', W, cardValueContext(state));

  it('prices a placed counter, a riot counter and an amass counter identically per counter', () => {
    const state = newGame();
    putOnBattlefield(state, 'A', [BEAR]);
    const perCounter = 2 * W.modeCounterPerStatValue;
    expect(valueOfEffect({ primitive: 'riotChoice' }, ctx(state))).toBe(perCounter);
    expect(valueOfEffect({ primitive: 'unleashChoice' }, ctx(state))).toBe(perCounter);
    expect(valueOfEffect({ primitive: 'amass', params: { subtype: 'Zombie', amount: 3 } }, ctx(state))).toBe(3 * perCounter);
    expect(valueOfEffect({ primitive: 'bolster', params: { amount: 2 } }, ctx(state))).toBe(2 * perCounter);
    expect(valueOfEffect({ primitive: 'becomeRenowned', params: { amount: 2 } }, ctx(state))).toBe(2 * perCounter);
    // Fabricate carries BOTH printed halves in one ref, so it is worth
    // whichever a rational chooser takes — never less than the counters.
    expect(valueOfEffect({ primitive: 'fabricateChoice', params: { amount: 2 } }, ctx(state))).toBeGreaterThanOrEqual(2 * perCounter);
  });

  it('bloodthirst is worth NOTHING until an opponent has been dealt damage this turn', () => {
    const state = newGame();
    const ref = { primitive: 'bloodthirstCounters', params: { amount: 2 } };
    expect(valueOfEffect(ref, ctx(state))).toBe(0);
    // The turn fact is what turns it on (core's `setTurnFact`, via any damage).
    state.turnFactsA = 1 << 4;
    expect(valueOfEffect(ref, ctx(state))).toBe(2 * 2 * W.modeCounterPerStatValue);
  });

  it('bolster is worth nothing with no creature to bolster', () => {
    const state = newGame();
    expect(valueOfEffect({ primitive: 'bolster', params: { amount: 3 } }, ctx(state))).toBe(0);
  });

  it('undying’s return is a creature plus its counter, never a shrink', () => {
    const state = newGame();
    const value = valueOfEffect({ primitive: 'undyingReturn', params: { amount: 1 } }, ctx(state));
    expect(value).toBeGreaterThan(W.castCreatureBaseScore);
  });
});
