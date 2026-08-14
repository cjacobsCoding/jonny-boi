import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createEngine,
  generateLegalActions,
  DEFAULT_RULES,
  serializeState,
  type GameAction,
  type GameState,
  type PlayerId,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { creatureDef, deck, deckOf, giveHand, landDef, spellDef } from './test-fixtures.js';

const FOREST = landDef('Forest', 'G');
const ISLAND = landDef('Island', 'U');

/** A neutral 40-card library that never decks during these short tests. */
function lib(): ReturnType<typeof deckOf> {
  return deckOf(ISLAND, 40);
}

/** Apply an action with default config; assert no rejection, return new state. */
function act(state: GameState, action: GameAction, registry = createEffectRegistry()): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

/** Pass priority for whoever currently holds it. */
function pass(state: GameState): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer });
}

function advanceToStep(state: GameState, target: string, maxPasses = 300): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== target && !s.gameOver && guard++ < maxPasses) s = pass(s);
  return s;
}

/** Advance whole turns until the given player is active. */
function advanceUntilActive(state: GameState, player: PlayerId, maxPasses = 600): GameState {
  let s = state;
  let guard = 0;
  while (s.activePlayer !== player && !s.gameOver && guard++ < maxPasses) s = pass(s);
  return s;
}

describe('game setup', () => {
  it('deals opening hands, shuffles deterministically, begins turn 1 in upkeep', () => {
    const setup = { seed: 1, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } };
    const g1 = createGame(setup);
    const g2 = createGame(setup);
    expect(g1.state.players.A.hand.length).toBe(DEFAULT_RULES.startingHandSize);
    expect(g1.state.players.A.library.length).toBe(40 - DEFAULT_RULES.startingHandSize);
    expect(g1.state.turnNumber).toBe(1);
    expect(g1.state.step).toBe('upkeep');
    expect(g1.state.players.A.life).toBe(DEFAULT_RULES.startingLife);
    expect(serializeState(g1.state)).toEqual(serializeState(g2.state));
    expect(g1.events.some((e) => e.type === 'gameStart')).toBe(true);
  });

  it('different seeds shuffle differently', () => {
    const mixed = deck([
      FOREST,
      ISLAND,
      creatureDef('Bear', 2, 2),
      FOREST,
      ISLAND,
      creatureDef('Elf', 1, 1),
      FOREST,
      ISLAND,
      creatureDef('Ox', 3, 3),
      FOREST,
    ]);
    const a = createGame({ seed: 1, decks: { A: mixed, B: mixed } });
    const b = createGame({ seed: 999, decks: { A: mixed, B: mixed } });
    const orderA = a.state.players.A.library.map((c) => c.def.id).join(',');
    const orderB = b.state.players.A.library.map((c) => c.def.id).join(',');
    expect(orderA).not.toBe(orderB);
  });
});

describe('turn progression and the on-the-play draw skip', () => {
  it('player on the play skips their first draw; later turns draw', () => {
    const g = createGame({ seed: 5, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } });
    let s = g.state;
    const handBefore = s.players.A.hand.length;
    s = advanceToStep(s, 'precombatMain');
    expect(s.players.A.hand.length).toBe(handBefore); // skipped first draw
    expect(s.activePlayer).toBe('A');

    const bHandBefore = s.players.B.hand.length;
    s = advanceUntilActive(s, 'B');
    s = advanceToStep(s, 'precombatMain');
    expect(s.activePlayer).toBe('B');
    expect(s.players.B.hand.length).toBe(bHandBefore + 1);
  });

  it('untaps the active player\'s permanents at the start of their turn', () => {
    const g = createGame({ seed: 2, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } });
    let s = advanceToStep(g.state, 'precombatMain');
    const land = s.players.A.hand.find((c) => c.def.id === 'Forest')!;
    s = act(s, { kind: 'playLand', player: 'A', instanceId: land.instanceId });
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId });
    expect(s.battlefield.find((c) => c.instanceId === land.instanceId)!.tapped).toBe(true);
    s = advanceUntilActive(s, 'B');
    s = advanceUntilActive(s, 'A');
    s = advanceToStep(s, 'upkeep');
    expect(s.battlefield.find((c) => c.instanceId === land.instanceId)!.tapped).toBe(false);
  });
});

describe('lands and mana', () => {
  it('plays one land per turn, rejects a second', () => {
    const g = createGame({ seed: 3, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } });
    let s = advanceToStep(g.state, 'precombatMain');
    const lands = s.players.A.hand.filter((c) => c.def.types.includes('land'));
    expect(lands.length).toBeGreaterThanOrEqual(2);
    s = act(s, { kind: 'playLand', player: 'A', instanceId: lands[0]!.instanceId });
    expect(s.battlefield.length).toBe(1);
    const r = applyAction(s, { kind: 'playLand', player: 'A', instanceId: lands[1]!.instanceId });
    expect(r.events.some((e) => e.type === 'actionRejected')).toBe(true);
    expect(r.state.battlefield.length).toBe(1);
  });

  it('tapping a land adds mana of its color', () => {
    const g = createGame({ seed: 4, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } });
    let s = advanceToStep(g.state, 'precombatMain');
    const forest = s.players.A.hand.find((c) => c.def.id === 'Forest')!;
    s = act(s, { kind: 'playLand', player: 'A', instanceId: forest.instanceId });
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: forest.instanceId });
    expect(s.players.A.manaPool.G).toBe(1);
  });
});

describe('casting and the stack', () => {
  const Bear = creatureDef('Bear', 2, 2, { cost: { G: 1 } });

  /** Game where A has, in hand, a Forest + the given extra cards (deterministic). */
  function gameWithHand(seed: number, extras: Parameters<typeof giveHand>[2]) {
    const g = createGame({ seed, decks: { A: lib(), B: lib() } });
    const s = advanceToStep(g.state, 'precombatMain');
    const [forest, ...rest] = giveHand(s, 'A', [FOREST, ...extras]);
    return { s, forest: forest!, rest };
  }

  it('casting a creature → stack → resolves to battlefield summoning-sick', () => {
    const { s: s0, forest, rest } = gameWithHand(10, [Bear]);
    const bear = rest[0]!;
    let s = act(s0, { kind: 'playLand', player: 'A', instanceId: forest.instanceId });
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: forest.instanceId });
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: bear.instanceId });
    expect(s.stack.length).toBe(1);
    expect(s.players.A.hand.find((c) => c.instanceId === bear.instanceId)).toBeUndefined();
    s = pass(s); // A
    s = pass(s); // B → resolves
    expect(s.stack.length).toBe(0);
    const onField = s.battlefield.find((c) => c.instanceId === bear.instanceId);
    expect(onField).toBeDefined();
    expect(onField!.zone).toBe('battlefield');
    expect(onField!.summoningSick).toBe(true);
  });

  it('rejects casting a creature without mana', () => {
    const { s, rest } = gameWithHand(11, [Bear]);
    const bear = rest[0]!;
    const r = applyAction(s, { kind: 'castSpell', player: 'A', instanceId: bear.instanceId });
    expect(r.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });

  it('resolves the stack LIFO', () => {
    const log: string[] = [];
    const registry = createEffectRegistry();
    registry.register('log', (ctx) => {
      log.push(String(ctx.params.tag));
    });
    const First = spellDef('First', 'instant', [{ primitive: 'log', params: { tag: 'first' } }], { generic: 0 });
    const Second = spellDef('Second', 'instant', [{ primitive: 'log', params: { tag: 'second' } }], { generic: 0 });
    const g = createGame({ seed: 12, decks: { A: lib(), B: lib() } });
    let s = advanceToStep(g.state, 'precombatMain');
    const [first, second] = giveHand(s, 'A', [First, Second]);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: first!.instanceId }, registry);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: second!.instanceId }, registry);
    expect(s.stack.length).toBe(2);
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, registry);
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, registry); // resolves 'second'
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, registry);
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, registry); // resolves 'first'
    expect(log).toEqual(['second', 'first']);
    expect(s.players.A.graveyard.map((c) => c.def.id).sort()).toEqual(['First', 'Second']);
  });

  it('unknown effect primitive is a safe no-op with an effectUnsupported event', () => {
    const Mystery = spellDef('Mystery', 'instant', [{ primitive: 'no-such-primitive' }], { generic: 0 });
    const g = createGame({ seed: 13, decks: { A: lib(), B: lib() } });
    const s = advanceToStep(g.state, 'precombatMain');
    const [card] = giveHand(s, 'A', [Mystery]);
    const r1 = applyAction(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId });
    const r2 = applyAction(r1.state, { kind: 'passPriority', player: 'A' });
    const r3 = applyAction(r2.state, { kind: 'passPriority', player: 'B' });
    const allEvents = [...r1.events, ...r2.events, ...r3.events];
    expect(allEvents.some((e) => e.type === 'effectUnsupported')).toBe(true);
    expect(r3.state.gameOver).toBe(false);
  });

  it('enforces sorcery-speed: a creature cannot be cast on the opponent\'s turn', () => {
    const g = createGame({ seed: 14, decks: { A: lib(), B: lib() } });
    let s = advanceToStep(g.state, 'precombatMain');
    const [forest, bear] = giveHand(s, 'A', [FOREST, Bear]);
    s = act(s, { kind: 'playLand', player: 'A', instanceId: forest!.instanceId });
    // Move to B's turn; A still has the bear and (untapped next turn) mana, but it's not A's main.
    s = advanceUntilActive(s, 'B');
    s = advanceToStep(s, 'precombatMain');
    // A taps for mana at instant speed is fine, but casting a sorcery-speed creature is not.
    const r = applyAction(s, { kind: 'castSpell', player: 'A', instanceId: bear!.instanceId });
    expect(r.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });
});

describe('robustness', () => {
  it('rejects an action from a player without priority, without mutating state', () => {
    const g = createGame({ seed: 20, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } });
    const s = advanceToStep(g.state, 'precombatMain');
    const before = serializeState(s);
    const r = applyAction(s, { kind: 'passPriority', player: 'B' });
    expect(r.events.some((e) => e.type === 'actionRejected')).toBe(true);
    expect(serializeState(r.state)).toEqual(before);
  });

  it('rejects actions once the game is over', () => {
    const g = createGame({ seed: 21, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } });
    const dead: GameState = { ...g.state, gameOver: true, winner: 'A' };
    const r = applyAction(dead, { kind: 'passPriority', player: dead.priorityPlayer });
    expect(r.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });

  it('applyAction never mutates the input state (purity)', () => {
    const g = createGame({ seed: 22, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } });
    const s = advanceToStep(g.state, 'precombatMain');
    const snapshotBefore = JSON.stringify(serializeState(s));
    const land = s.players.A.hand.find((c) => c.def.types.includes('land'))!;
    applyAction(s, { kind: 'playLand', player: 'A', instanceId: land.instanceId });
    expect(JSON.stringify(serializeState(s))).toBe(snapshotBefore);
  });
});

describe('legal-action generation', () => {
  it('always offers passPriority and playLand in a main phase', () => {
    const g = createGame({ seed: 30, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } });
    let s = advanceToStep(g.state, 'precombatMain');
    let actions = generateLegalActions(s);
    expect(actions.some((a) => a.kind === 'passPriority')).toBe(true);
    expect(actions.some((a) => a.kind === 'playLand')).toBe(true);
    const land = s.players.A.hand.find((c) => c.def.types.includes('land'))!;
    s = act(s, { kind: 'playLand', player: 'A', instanceId: land.instanceId });
    actions = generateLegalActions(s);
    expect(actions.some((a) => a.kind === 'tapForMana')).toBe(true);
  });

  it('offers castSpell only when affordable', () => {
    const Bear = creatureDef('Bear', 2, 2, { cost: { G: 1 } });
    const g = createGame({ seed: 31, decks: { A: lib(), B: lib() } });
    let s = advanceToStep(g.state, 'precombatMain');
    const [forest] = giveHand(s, 'A', [FOREST, Bear]);
    expect(generateLegalActions(s).some((a) => a.kind === 'castSpell')).toBe(false);
    s = act(s, { kind: 'playLand', player: 'A', instanceId: forest!.instanceId });
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: forest!.instanceId });
    expect(generateLegalActions(s).some((a) => a.kind === 'castSpell')).toBe(true);
  });

  it('returns no actions when the game is over', () => {
    const g = createGame({ seed: 32, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } });
    const over: GameState = { ...g.state, gameOver: true };
    expect(generateLegalActions(over)).toEqual([]);
  });
});

describe('engine handle', () => {
  it('createEngine binds config + registry and exposes applyAction/legalActions', () => {
    const engine = createEngine();
    const g = createGame({ seed: 40, decks: { A: deckOf(FOREST, 40), B: deckOf(ISLAND, 40) } });
    const s = advanceToStep(g.state, 'precombatMain');
    const actions = engine.legalActions(s);
    expect(actions.length).toBeGreaterThan(0);
    const r = engine.applyAction(s, { kind: 'passPriority', player: s.priorityPlayer });
    expect(r.state).toBeDefined();
  });
});
