/**
 * UPKEEP COSTS AND TIME COUNTERS (§3.106) — the two entry-time facts core owes
 * the family, pinned on the REAL engine paths that write them.
 *
 *  1. `controlledSinceTurn` — echo's "came under your control since the
 *     beginning of your last upkeep" (CR 702.30a). Written on entry and on
 *     every control change, only for definitions that ask, read by the
 *     `sourceControlledSinceLastUpkeep` intervening "if".
 *  2. `entersWithCounters` — vanishing's and fading's "enters with N counters"
 *     (CR 702.63a / 702.32a), applied by EVERY entry path: a resolving spell, a
 *     land play, a token, a card put onto the battlefield.
 *
 * Each assertion here would go red if one path forgot the helper, which is the
 * class of bug the module header names (a reanimated Blastoderm with no fade
 * counters is a card playing stronger than printed).
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cameUnderControlSinceLastUpkeep,
  cloneState,
  createGame,
  DEFAULT_RULES,
  definitionTracksControlSince,
  FADE_COUNTER,
  interveningIfHolds,
  resetInstanceForNewZone,
  TIME_COUNTER,
  TURNS_BETWEEN_OWN_UPKEEPS,
  type CardDefinition,
  type CardInstance,
  type EffectContext,
  type GameAction,
  type GameState,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, giveHand, landDef, spellDef } from './test-fixtures.js';

const FOREST = landDef('Forest', 'G');

/** A creature that prints echo's question — the intervening "if" is what asks for the stamp. */
const ECHO_BEAR: CardDefinition = {
  ...creatureDef('echo-bear', 2, 2, { cost: { generic: 1, G: 1 }, name: 'Echo Bear' }),
  triggers: [
    {
      condition: { on: 'upkeep', who: 'you', intervening: { kind: 'sourceControlledSinceLastUpkeep' } },
      effects: [{ primitive: 'noteBill' }],
      label: 'Echo {1}{G}',
    },
  ],
};

/** The same creature with no such question: it must keep the plain object shape. */
const PLAIN_BEAR: CardDefinition = creatureDef('plain-bear', 2, 2, { cost: { generic: 1, G: 1 }, name: 'Plain Bear' });

/** Vanishing 3 and fading 2, as the compiler emits them. */
const VANISHING_BEAST: CardDefinition = {
  ...creatureDef('vanishing-beast', 5, 5, { cost: { generic: 1, G: 1 }, name: 'Vanishing Beast' }),
  entersWithCounters: [{ kind: TIME_COUNTER, count: 3 }],
};
const FADING_LAND: CardDefinition = {
  ...landDef('Fading Land', 'G'),
  entersWithCounters: [{ kind: FADE_COUNTER, count: 2 }],
};

function registry(billed: string[]): EffectRegistry {
  const reg = createEffectRegistry();
  reg.register('noteBill', (ctx: EffectContext) => {
    billed.push(`turn ${ctx.state.turnNumber}`);
  });
  // "Gain control of target creature until end of turn" — the one control-change
  // funnel, driven as a spell so the revert at cleanup is the real one.
  reg.register('steal', (ctx: EffectContext) => {
    const target = ctx.targets[0];
    if (typeof target !== 'number') return;
    ctx.addContinuousEffect({ target, takeControl: true });
  });
  // A token made from a definition that enters with counters.
  reg.register('makeVanishingToken', (ctx: EffectContext) => {
    ctx.createToken({ ...VANISHING_BEAST, id: 'vanishing-token', isToken: true });
  });
  return reg;
}

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** Pass until `done` holds; a parked question or a finished game fails loudly. */
function until(state: GameState, reg: EffectRegistry, done: (s: GameState) => boolean): GameState {
  let s = state;
  for (let guard = 0; guard < 600; guard++) {
    if (done(s)) return s;
    if (s.gameOver) throw new Error('game ended first');
    if (s.pendingChoice) throw new Error('a question parked the game first');
    s = pass(s, reg);
  }
  throw new Error(`never reached the condition (turn ${s.turnNumber} ${s.step})`);
}

function gameAtMain(reg: EffectRegistry): GameState {
  const { state } = createGame({
    seed: 7,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(FOREST, 40), B: deckOf(FOREST, 40) },
  });
  const s = until(state, reg, (x) => x.step === 'precombatMain');
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

function fund(state: GameState, player: 'A' | 'B', g: number): void {
  state.players[player].manaPool = { W: 0, U: 0, B: 0, R: 0, G: g, C: 0 };
}

/** Cast `def` from A's hand at A's main phase and let it resolve. */
function castAndResolve(state: GameState, reg: EffectRegistry, def: CardDefinition, targets?: number[]): GameState {
  const [card] = giveHand(state, 'A', [def]);
  fund(state, 'A', 6);
  let s = act(
    state,
    { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, ...(targets ? { targets } : {}) },
    reg,
  );
  s = pass(s, reg);
  s = pass(s, reg);
  return s;
}

function onBattlefield(state: GameState, name: string): CardInstance | undefined {
  return state.battlefield.find((c) => c.def.name === name);
}

describe('the control stamp (CR 702.30a — "came under your control since the beginning of your last upkeep")', () => {
  it('is written by a resolving spell ONLY for a definition that asks the question', () => {
    const reg = registry([]);
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, ECHO_BEAR);
    state = castAndResolve(state, reg, PLAIN_BEAR);
    expect(definitionTracksControlSince(ECHO_BEAR)).toBe(true);
    expect(definitionTracksControlSince(PLAIN_BEAR)).toBe(false);
    expect(onBattlefield(state, 'Echo Bear')?.controlledSinceTurn).toBe(1);
    // The plain permanent keeps the object shape `cloneInstance` was measured on.
    expect('controlledSinceTurn' in onBattlefield(state, 'Plain Bear')!).toBe(false);
  });

  it('survives the per-action clone and is cleared as the permanent leaves the battlefield (CR 400.7)', () => {
    const reg = registry([]);
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, ECHO_BEAR);
    const copied = cloneState(state);
    const bear = copied.battlefield.find((c) => c.def.name === 'Echo Bear')!;
    expect(bear.controlledSinceTurn).toBe(1);
    resetInstanceForNewZone(bear);
    expect(bear.controlledSinceTurn).toBeUndefined();
  });

  it('answers the question by the turn clock: owed on the first upkeep after entry, not the second', () => {
    const reg = registry([]);
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, ECHO_BEAR);
    const bear = onBattlefield(state, 'Echo Bear')!;
    // A's next upkeep is turn 3; its last upkeep before that was turn 1.
    const atTurn = (turn: number): GameState => ({ ...state, turnNumber: turn }) as GameState;
    expect(cameUnderControlSinceLastUpkeep(atTurn(1 + TURNS_BETWEEN_OWN_UPKEEPS), bear)).toBe(true);
    expect(cameUnderControlSinceLastUpkeep(atTurn(1 + 2 * TURNS_BETWEEN_OWN_UPKEEPS), bear)).toBe(false);
    // A permanent nobody stamped never owes — the honest inert default.
    expect(cameUnderControlSinceLastUpkeep(atTurn(3), onBattlefield(state, 'Echo Bear')!)).toBe(true);
    expect(cameUnderControlSinceLastUpkeep(atTurn(3), { ...bear, controlledSinceTurn: undefined })).toBe(false);
  });

  it('fires the echo trigger on the first upkeep after entry and NOT on the one after (the intervening "if", CR 603.4)', () => {
    const billed: string[] = [];
    const reg = registry(billed);
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, ECHO_BEAR);
    state = until(state, reg, (s) => s.turnNumber === 1 + 2 * TURNS_BETWEEN_OWN_UPKEEPS && s.step === 'draw');
    expect(billed).toEqual(['turn 3']);
    expect(interveningIfHolds(state, { kind: 'sourceControlledSinceLastUpkeep' }, onBattlefield(state, 'Echo Bear')!.instanceId, 'A')).toBe(false);
  });

  it('a control change re-stamps in BOTH directions, so a stolen-and-returned echo creature owes echo again', () => {
    const reg = registry([]);
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, ECHO_BEAR);
    const bearId = onBattlefield(state, 'Echo Bear')!.instanceId;
    // B's turn (turn 2): B steals the bear until end of turn.
    state = until(state, reg, (s) => s.turnNumber === 2 && s.step === 'precombatMain');
    const [steal] = giveHand(state, 'B', [spellDef('steal', 'sorcery', [{ primitive: 'steal' }], { generic: 1 })]);
    fund(state, 'B', 3);
    state = act(state, { kind: 'castSpell', player: 'B', instanceId: steal!.instanceId, targets: [bearId] }, reg);
    state = pass(state, reg);
    state = pass(state, reg);
    const stolen = state.battlefield.find((c) => c.instanceId === bearId)!;
    expect(stolen.controller).toBe('B');
    expect(stolen.controlledSinceTurn).toBe(2);
    // The revert at cleanup hands it back: coming under A's control again.
    state = until(state, reg, (s) => s.turnNumber === 3 && s.step === 'upkeep');
    const returned = state.battlefield.find((c) => c.instanceId === bearId)!;
    expect(returned.controller).toBe('A');
    expect(returned.controlledSinceTurn).toBe(2);
    expect(cameUnderControlSinceLastUpkeep(state, returned)).toBe(true);
  });
});

describe('"enters with N counters" (CR 614.1c) is applied by every battlefield-entry path', () => {
  it('a resolving creature spell enters counted', () => {
    const reg = registry([]);
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, VANISHING_BEAST);
    expect(onBattlefield(state, 'Vanishing Beast')?.counters[TIME_COUNTER]).toBe(3);
  });

  it('a played LAND enters counted (Omenpath to Naya is a land with vanishing)', () => {
    const reg = registry([]);
    const state = gameAtMain(reg);
    const [land] = giveHand(state, 'A', [FADING_LAND]);
    const after = act(state, { kind: 'playLand', player: 'A', instanceId: land!.instanceId }, reg);
    expect(onBattlefield(after, 'Fading Land')?.counters[FADE_COUNTER]).toBe(2);
  });

  it('a TOKEN made from such a definition enters counted', () => {
    const reg = registry([]);
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, spellDef('maker', 'sorcery', [{ primitive: 'makeVanishingToken' }], { generic: 1 }));
    const token = state.battlefield.find((c) => c.def.isToken === true);
    expect(token?.counters[TIME_COUNTER]).toBe(3);
  });

  it('the "has a counter" intervening "if" reads the live count and fails off the battlefield', () => {
    const reg = registry([]);
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, VANISHING_BEAST);
    const beast = onBattlefield(state, 'Vanishing Beast')!;
    expect(interveningIfHolds(state, { kind: 'sourceHasCounter', counter: TIME_COUNTER }, beast.instanceId, 'A')).toBe(true);
    beast.counters = {};
    expect(interveningIfHolds(state, { kind: 'sourceHasCounter', counter: TIME_COUNTER }, beast.instanceId, 'A')).toBe(false);
    expect(interveningIfHolds(state, { kind: 'sourceHasCounter', counter: TIME_COUNTER }, 999_999, 'A')).toBe(false);
  });
});
