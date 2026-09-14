/**
 * CHARACTERISTIC-DEFINING P/T (CR 613.4 layer 7a) + TURN-SCOPED FACT MEMORY.
 *
 * The two claims worth proving are the ones that are easy to get subtly wrong:
 *
 *  1. **A star box is a BASE, not a bonus.** It has to be applied before
 *     counters and pumps, so a Tarmogoyf carrying a +1/+1 counter is
 *     (types)+1 / (types)+2 — never (printed 0) + counter with the formula
 *     added as a delta afterwards, which produces the same number today and the
 *     wrong one the moment anything sets a value.
 *  2. **It re-derives on every read.** The size changes MID-COMBAT as graveyards
 *     fill, before state-based actions run — which is exactly the interaction
 *     the real card is famous for and the one a cached value would break.
 *
 * Facts are tested through the same public surface: false at the start of a
 * turn, true once a permanent has left the battlefield, cleared next turn.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateFor,
  applyAction,
  createGame,
  effectivePower,
  effectiveToughness,
  indexContinuous,
  serializeState,
  turnFactHolds,
  NO_MOD,
  PLUS_ONE_COUNTER,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type PlayerId,
} from './index.js';
import { creatureDef, deckOf, giveGraveyard, landDef } from './test-fixtures.js';

const FOREST = landDef('Forest', 'G');

/** Tarmogoyf, as the compiler builds it: no printed numbers, a formula instead. */
const TARMOGOYF: CardDefinition = {
  id: 'Tarmogoyf',
  name: 'Tarmogoyf',
  types: ['creature'],
  cost: { generic: 1, G: 1 },
  characteristicPT: {
    power: { countOf: 'cardTypesInAllGraveyards' },
    toughness: { countOf: 'cardTypesInAllGraveyards', plus: 1 },
  },
};

/** Boneyard Wurm's shape: both halves the same count, no offset. */
const BONEYARD_WURM: CardDefinition = {
  id: 'BoneyardWurm',
  name: 'Boneyard Wurm',
  types: ['creature'],
  cost: { generic: 2, G: 1 },
  characteristicPT: {
    power: { countOf: 'creaturesInYourGraveyard' },
    toughness: { countOf: 'creaturesInYourGraveyard' },
  },
};

const BEAR = creatureDef('Bear', 2, 2);
const SORCERY: CardDefinition = { id: 'Sorc', name: 'Sorc', types: ['sorcery'], cost: { R: 1 } };
const INSTANT: CardDefinition = { id: 'Inst', name: 'Inst', types: ['instant'], cost: { U: 1 } };

function game(): GameState {
  const { state } = createGame({
    seed: 7,
    decks: { A: deckOf(FOREST, 30), B: deckOf(FOREST, 30) },
  });
  return state;
}

/** Pass priority once, failing loudly if the engine rejected the action. */
function pass(state: GameState): GameState {
  const result = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer });
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
    attachedTo: null,
  };
  state.battlefield.push(inst);
  return inst;
}

/**
 * Pass priority until `instanceId` has left the battlefield. State-based actions
 * run at step transitions, not on every pass, so a single pass is not enough to
 * bury a creature carrying lethal damage.
 */
function passUntilGone(start: GameState, instanceId: number): GameState {
  let s = start;
  for (let i = 0; i < 40 && !s.gameOver; i++) {
    if (!s.battlefield.some((c) => c.instanceId === instanceId)) return s;
    s = pass(s);
  }
  return s;
}

/** Size as every RULES path reads it: through the aggregation index. */
function sizeOf(state: GameState, inst: CardInstance): [number, number] {
  const mod = indexContinuous(state).get(inst.instanceId) ?? NO_MOD;
  return [effectivePower(inst, mod), effectiveToughness(inst, mod)];
}

describe('characteristic-defining P/T — the formula IS the base', () => {
  it('is 0/1 with both graveyards empty, and grows one type at a time', () => {
    const state = game();
    const goyf = place(state, TARMOGOYF, 'A');
    expect(sizeOf(state, goyf)).toEqual([0, 1]);

    giveGraveyard(state, 'A', [FOREST]); // land
    expect(sizeOf(state, goyf)).toEqual([1, 2]);

    giveGraveyard(state, 'A', [SORCERY]); // land + sorcery
    expect(sizeOf(state, goyf)).toEqual([2, 3]);

    // A SECOND card of a type already present adds nothing — it counts TYPES.
    giveGraveyard(state, 'A', [SORCERY]);
    expect(sizeOf(state, goyf)).toEqual([2, 3]);
  });

  it('counts types across ALL graveyards, not just its own controller', () => {
    const state = game();
    const goyf = place(state, TARMOGOYF, 'A');
    giveGraveyard(state, 'A', [FOREST]);
    giveGraveyard(state, 'B', [INSTANT, BEAR]);
    // land (A) + instant (B) + creature (B) = 3
    expect(sizeOf(state, goyf)).toEqual([3, 4]);
  });

  it('a +1/+1 counter adds ON TOP of the formula (layer 7a before 7d)', () => {
    const state = game();
    const goyf = place(state, TARMOGOYF, 'A');
    giveGraveyard(state, 'A', [FOREST, SORCERY]); // 2 types -> 2/3
    expect(sizeOf(state, goyf)).toEqual([2, 3]);

    goyf.counters = { [PLUS_ONE_COUNTER]: 1 };
    expect(sizeOf(state, goyf)).toEqual([3, 4]);

    // …and the formula still moves underneath the counter.
    giveGraveyard(state, 'A', [INSTANT]); // 3 types
    expect(sizeOf(state, goyf)).toEqual([4, 5]);
  });

  it('stacks with an until-end-of-turn pump and an anthem, in one aggregate', () => {
    const state = game();
    const goyf = place(state, TARMOGOYF, 'A');
    giveGraveyard(state, 'A', [FOREST]); // 1 type -> 1/2
    const anthem: CardDefinition = {
      id: 'Anthem',
      name: 'Anthem',
      types: ['enchantment'],
      statics: [{ affects: { controller: 'you', anyOfTypes: ['creature'] }, power: 1, toughness: 1 }],
    };
    place(state, anthem, 'A');
    state.continuous.push({
      id: 999,
      targetInstanceId: goyf.instanceId,
      sourceInstanceId: goyf.instanceId,
      duration: 'endOfTurn',
      power: 3,
      toughness: 3,
    });
    // formula 1/2 + anthem 1/1 + pump 3/3
    expect(sizeOf(state, goyf)).toEqual([5, 6]);
  });

  it('the single-instance aggregate agrees with the batch index', () => {
    const state = game();
    const goyf = place(state, TARMOGOYF, 'A');
    giveGraveyard(state, 'A', [FOREST, SORCERY, BEAR]);
    const single = aggregateFor(state, goyf.instanceId);
    expect([effectivePower(goyf, single), effectiveToughness(goyf, single)]).toEqual(
      sizeOf(state, goyf),
    );
  });

  it('serialization reports the derived size, not zero', () => {
    const state = game();
    place(state, TARMOGOYF, 'A');
    giveGraveyard(state, 'A', [FOREST, SORCERY]);
    const row = serializeState(state).battlefield.find((b) => b.name === 'Tarmogoyf');
    expect(row?.power).toBe(2);
    expect(row?.toughness).toBe(3);
  });

  it('Boneyard Wurm counts only creature cards, only in its own graveyard', () => {
    const state = game();
    const wurm = place(state, BONEYARD_WURM, 'A');
    giveGraveyard(state, 'A', [FOREST, SORCERY]);
    expect(sizeOf(state, wurm)).toEqual([0, 0]);
    giveGraveyard(state, 'A', [BEAR, BEAR]);
    expect(sizeOf(state, wurm)).toEqual([2, 2]);
    giveGraveyard(state, 'B', [BEAR]); // the opponent's graveyard is not ours
    expect(sizeOf(state, wurm)).toEqual([2, 2]);
  });

  it('a board with no star creature builds no index at all (the fast path holds)', () => {
    const state = game();
    place(state, BEAR, 'A');
    expect(indexContinuous(state).size).toBe(0);
  });

  it('GROWS MID-COMBAT as a graveyard fills, before state-based actions run', () => {
    // The interaction the real card is famous for, and the one a cached value
    // would break: a Tarmogoyf carrying damage that is lethal at its CURRENT
    // size survives once something else hits a graveyard in the same window.
    const state = game();
    const goyf = place(state, TARMOGOYF, 'A');
    giveGraveyard(state, 'A', [FOREST]); // 1/2
    expect(sizeOf(state, goyf)).toEqual([1, 2]);

    goyf.damageMarked = 2; // lethal against toughness 2

    // A creature card and an instant hit a graveyard mid-combat.
    giveGraveyard(state, 'B', [BEAR, INSTANT]); // land + creature + instant = 3
    const [power, toughness] = sizeOf(state, goyf);
    expect([power, toughness]).toEqual([3, 4]);
    // 2 damage no longer kills a toughness-4 creature — the re-read saves it.
    expect(toughness - goyf.damageMarked).toBeGreaterThan(0);
  });
});

describe('turn-scoped fact memory', () => {
  it('revolt is FALSE at the start of a turn', () => {
    const state = game();
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'A')).toBe(false);
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'B')).toBe(false);
  });

  it('a state that predates the record answers false rather than throwing', () => {
    const state = game();
    delete state.turnFactsA;
    delete state.turnFactsB;
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'A')).toBe(false);
    expect(turnFactHolds(state, 'creatureDied', 'B')).toBe(false);
  });

  it('turns TRUE for the controller when their permanent leaves, and RESETS next turn', () => {
    // Driven through the public engine surface so the fact is proved to be fed
    // by the real event stream, not by a test poking the record.
    const state = game();
    const bear = place(state, BEAR, 'A');
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'A')).toBe(false);

    // Kill it the way the engine does: mark lethal damage and let the
    // state-based actions move it, so a real `zoneChange` is emitted. SBAs run
    // at step transitions, so pass until the board actually settles.
    bear.damageMarked = 99;
    const after = passUntilGone(state, bear.instanceId);
    expect(after.battlefield.some((c) => c.instanceId === bear.instanceId)).toBe(false);
    expect(after.turnNumber).toBe(state.turnNumber); // still the SAME turn
    expect(turnFactHolds(after, 'permanentLeftBattlefield', 'A')).toBe(true);
    // …and it is B's permanent that did NOT leave.
    expect(turnFactHolds(after, 'permanentLeftBattlefield', 'B')).toBe(false);
    // A creature died, so morbid is on.
    expect(turnFactHolds(after, 'creatureDied', 'A')).toBe(true);

    // Run the game forward until the turn number changes; the facts clear.
    let s = after;
    for (let i = 0; i < 400 && s.turnNumber === after.turnNumber && !s.gameOver; i++) {
      s = pass(s);
    }
    expect(s.turnNumber).toBeGreaterThan(after.turnNumber);
    expect(turnFactHolds(s, 'permanentLeftBattlefield', 'A')).toBe(false);
    expect(turnFactHolds(s, 'creatureDied', 'A')).toBe(false);
  });

  it('survives the clone at every action boundary, without aliasing', () => {
    const state = game();
    const bear = place(state, BEAR, 'A');
    bear.damageMarked = 99;
    const after = passUntilGone(state, bear.instanceId);
    expect(turnFactHolds(after, 'permanentLeftBattlefield', 'A')).toBe(true);
    // The previous state must NOT have been mutated through a shared record.
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'A')).toBe(false);

    const next = pass(after);
    expect(turnFactHolds(next, 'permanentLeftBattlefield', 'A')).toBe(true);
  });
});
