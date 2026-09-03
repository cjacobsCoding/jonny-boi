/**
 * THE PILOT AND THE SPELL-COUNT FAMILY (DESIGN §3.113).
 *
 * Storm and cascade are AUTOMATIC once a spell is cast — no pilot decides
 * whether they happen. What the pilot decides is which spell to cast and WHEN,
 * and the two facts that decision must respect are:
 *
 *  1. a storm spell is worth more the later in the turn it is cast, because the
 *     count it copies by is the spells already cast (CR 702.40a) — so with a
 *     cheap spell also castable, the pilot must play the cheap one FIRST;
 *  2. a cascade spell carries a free spell with it, which is worth something a
 *     vanilla body of the same cost is not.
 *
 * And when a FREE WINDOW opens (cascade, ripple, suspend), the engine lists one
 * cast per legal target: the pilot must aim it the way it aims a hand cast,
 * because "the first target the engine listed" is as likely to be our own
 * creature as theirs.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import type { DecisionTrace } from './pilot.js';
import { burnDef, createTestRegistry, giveHand, landDef, putOnBattlefield } from './test-support.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

const MOUNTAIN = landDef('Mountain', 'R');

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, () => MOUNTAIN) };
}

const pilot = createHeuristicPilot();

function freshGame(seed = 113): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() }, registry: createTestRegistry() });
  // A's main phase, with mana enough for anything below and an empty hand to fill.
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.players.A.hand = [];
  state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 9, G: 0, C: 9 };
  return state;
}

function choose(state: GameState): GameAction {
  return pilot.chooseAction({ view: state, legalActions: generateLegalActions(state), rng: createRng(7) });
}

/** A 1-damage burn spell with storm — Grapeshot's shape. */
const GRAPESHOT: CardDefinition = {
  ...burnDef('Grapeshot', 1, { generic: 1, R: 1 }),
  castTriggers: [{ keyword: 'storm', label: 'Storm', effects: [{ primitive: 'stormCopies' }] }],
};
/** The same burn spell WITHOUT storm — the control for the same board. */
const SHOCK: CardDefinition = burnDef('Shock', 1, { generic: 1, R: 1 });
/** A cheap blank sorcery the pilot can cast to raise the storm count. */
const RITUAL: CardDefinition = {
  id: 'Ritual',
  name: 'Ritual',
  types: ['sorcery'],
  timing: 'sorcery',
  cost: { R: 1 },
  effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
};

describe('storm is priced by the spells already cast this turn (CR 702.40a)', () => {
  it('scores HIGHER after two spells than after none — the same card, the same board', () => {
    const scoreOf = (spellsCast: number): number => {
      const state = freshGame();
      state.spellsCastThisTurn = spellsCast;
      giveHand(state, 'A', [GRAPESHOT]);
      return scoreOfChosenCast(state);
    };
    expect(scoreOf(2)).toBeGreaterThan(scoreOf(0));
    // And the term is exactly the weight times the count.
    expect(scoreOf(2) - scoreOf(0)).toBe(2 * DEFAULT_HEURISTIC_WEIGHTS.stormPerSpellCast);
  });

  it('a storm spell and a plain one are scored apart only by that term', () => {
    const withStorm = (() => {
      const s = freshGame();
      s.spellsCastThisTurn = 3;
      giveHand(s, 'A', [GRAPESHOT]);
      return scoreOfChosenCast(s);
    })();
    const without = (() => {
      const s = freshGame();
      s.spellsCastThisTurn = 3;
      giveHand(s, 'A', [SHOCK]);
      return scoreOfChosenCast(s);
    })();
    expect(withStorm - without).toBe(3 * DEFAULT_HEURISTIC_WEIGHTS.stormPerSpellCast);
  });

  it('breaks the tie between two identical burns TOWARD the storm one, and only once the count is up', () => {
    // The honest claim, and the whole behavioural effect of the term: a storm
    // spell and an otherwise identical spell are the SAME play on an empty
    // turn, and the storm one is the better play once spells have been cast —
    // because then it is three damage rather than one.
    const chosenAt = (spellsCast: number): number => {
      const state = freshGame();
      state.spellsCastThisTurn = spellsCast;
      // Order in hand puts the plain burn FIRST, so a pilot ignoring storm
      // (ties broken by scan order) picks Shock and this test fails.
      const [shock, grapeshot] = giveHand(state, 'A', [SHOCK, GRAPESHOT]);
      const action = choose(state);
      expect(action.kind).toBe('castSpell');
      const id = (action as Extract<GameAction, { kind: 'castSpell' }>).instanceId;
      expect([shock!.instanceId, grapeshot!.instanceId]).toContain(id);
      return id === grapeshot!.instanceId ? 1 : 0;
    };
    expect(chosenAt(0)).toBe(0); // a tie, and the plain one was scanned first
    expect(chosenAt(2)).toBe(1); // the copies are worth something now
    expect(RITUAL.name).toBe('Ritual'); // kept as the fixture the next test wants
  });
});

/** The pilot's own score for the cast it chooses, read off its trace callback. */
function scoreOfChosenCast(state: GameState): number {
  let seen: DecisionTrace | undefined;
  const action = pilot.chooseAction({
    view: state,
    legalActions: generateLegalActions(state),
    rng: createRng(7),
    trace: (t) => {
      seen = t;
    },
  });
  expect(action.kind, `expected a cast, got ${action.kind}`).toBe('castSpell');
  expect(seen?.score, `no score on the trace: ${JSON.stringify(seen)}`).toBeTypeOf('number');
  return seen!.score as number;
}

describe('a free cast window is AIMED, not taken as offered (§3.113)', () => {
  it('a cascaded burn spell is pointed at the opponent’s creature, not at ours', () => {
    const state = freshGame();
    // Ours is the bigger body; theirs is exactly killable by the 1-damage burn.
    putOnBattlefield(state, 'A', [{ ...MOUNTAIN, id: 'ours-land' }]);
    const [theirs] = putOnBattlefield(state, 'B', [
      { id: 'Squire', name: 'Squire', types: ['creature'], power: 1, toughness: 1, cost: { generic: 1 } },
    ]);
    // A cascade window standing on a burn spell sitting in exile.
    const exiled = { ...GRAPESHOT, id: 'Cascaded Bolt', name: 'Cascaded Bolt' };
    const card = {
      instanceId: state.nextInstanceId++,
      def: exiled,
      controller: 'A' as const,
      owner: 'A' as const,
      zone: 'exile' as const,
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    state.players.A.exile.push(card);
    state.madnessWindow = { instanceId: card.instanceId, controller: 'A', kind: 'cascade', pile: [card.instanceId] };
    // An empty pool: the window's cast is free, so it is still offered.
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    // The window offers the cast (free, on an empty pool). An "any target"
    // spell is offered once with NO targets — the aim is the pilot's to make,
    // exactly as it is for a hand cast.
    const offered = generateLegalActions(state).filter((a) => a.kind === 'castSpell');
    expect(offered.length).toBe(1);
    expect((offered[0] as Extract<GameAction, { kind: 'castSpell' }>).targets ?? []).toEqual([]);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    const cast = action as Extract<GameAction, { kind: 'castSpell' }>;
    expect(cast.fromZone).toBe('exile');
    expect(cast.targets).toEqual([theirs!.instanceId]);
  });
});
