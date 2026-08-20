import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  type GameAction,
  type GameState,
  type PlayerId,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { creatureDef, deck, deckOf, giveHand, landDef, spellDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/**
 * Pass priority — or, when a turn-based action has parked a question (the cleanup
 * step's discard down to maximum hand size, CR 514.1), ANSWER it. A seat with a
 * question outstanding may do nothing else, so a helper that only ever passes
 * would wedge the moment any rule stops to ask something.
 */
function pass(state: GameState, registry = createEffectRegistry()): GameState {
  const question = state.pendingChoice;
  const action: GameAction = question
    ? {
        kind: 'answerChoice',
        player: question.chooser,
        choiceId: question.id,
        answer: defaultAnswerFor(question),
      }
    : { kind: 'passPriority', player: state.priorityPlayer };
  const r = applyAction(state, action, DEFAULT_RULES, registry);
  return r.state;
}

function advanceToStep(state: GameState, target: string, registry = createEffectRegistry(), max = 400): GameState {
  let s = state;
  let g = 0;
  while (s.step !== target && !s.gameOver && g++ < max) s = pass(s, registry);
  return s;
}

describe('state-based actions: decking', () => {
  it('a player who must draw from an empty library loses', () => {
    // B has a tiny library; advance turns until B must draw with an empty library.
    const g = createGame({
      seed: 1,
      decks: { A: deckOf(ISLAND, 60), B: deck([ISLAND, ISLAND, ISLAND, ISLAND, ISLAND, ISLAND, ISLAND, ISLAND]) },
    });
    // B starts with 7 in hand, 1 in library. On B's first turn it draws (library→0).
    // On B's second turn the draw fails → decking loss.
    let s = g.state;
    let guard = 0;
    // Through the choice-aware `pass`: a hand over the maximum size parks the
    // cleanup discard, and a loop that only ever passes priority would stall on it.
    while (!s.gameOver && guard++ < 2000) s = pass(s);
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBe('A');
    expect(s.players.B.hasLost).toBe(true);
  });
});

describe('state-based actions: life loss via an effect primitive', () => {
  it('a "loseLife" spell can reduce a player to 0 and end the game', () => {
    const registry = createEffectRegistry();
    // A minimal life-loss primitive (the kind `cards` will author for real).
    registry.register('loseLifeTarget', (ctx) => {
      const amount = Number(ctx.params.amount ?? 0);
      const targetId = ctx.targets[0];
      if (typeof targetId === 'string') {
        const player = ctx.state.players[targetId as PlayerId];
        player.life -= amount;
        ctx.emit({ type: 'lifeChanged', player: targetId as PlayerId, delta: -amount, to: player.life });
      }
    });
    const Bolt = spellDef('Bolt', 'instant', [{ primitive: 'loseLifeTarget', params: { amount: 30 } }], {
      generic: 0,
    });
    const g = createGame({ seed: 2, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
    let s = advanceToStep(g.state, 'precombatMain', registry);
    const [bolt] = giveHand(s, 'A', [Bolt]);
    const cast = applyAction(
      s,
      { kind: 'castSpell', player: 'A', instanceId: bolt!.instanceId, targets: ['B'] },
      DEFAULT_RULES,
      registry,
    );
    s = cast.state;
    // Resolve.
    s = pass(s, registry);
    s = pass(s, registry);
    expect(s.players.B.life).toBeLessThanOrEqual(0);
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBe('A');
  });
});

describe('state-based actions: zero-toughness death', () => {
  it('a creature reduced to 0 toughness dies on the next SBA check', () => {
    // Use a 0/0-after-counters style: place a 1/1 and a primitive that removes its toughness.
    const registry = createEffectRegistry();
    registry.register('shrinkToDeath', (ctx) => {
      const target = ctx.state.battlefield.find((c) => c.instanceId === ctx.targets[0]);
      if (target) {
        // Mark lethal damage equal to its toughness to simulate -X/-X to 0.
        target.damageMarked += (target.def.toughness ?? 0) + 5;
      }
    });
    const Shrink = spellDef('Shrink', 'instant', [{ primitive: 'shrinkToDeath' }], { generic: 0 });
    const g = createGame({ seed: 3, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
    let s = advanceToStep(g.state, 'precombatMain', registry);
    const [shrink, bear] = giveHand(s, 'A', [Shrink, creatureDef('Bear', 2, 2, { cost: { generic: 0 } })]);
    // Cast the free Bear and resolve it.
    s = applyAction(s, { kind: 'castSpell', player: 'A', instanceId: bear!.instanceId }, DEFAULT_RULES, registry).state;
    s = pass(s, registry);
    s = pass(s, registry);
    const bearOnField = s.battlefield.find((c) => c.def.id === 'Bear')!;
    expect(bearOnField).toBeDefined();
    // Now cast Shrink targeting the bear.
    s = applyAction(
      s,
      { kind: 'castSpell', player: 'A', instanceId: shrink!.instanceId, targets: [bearOnField.instanceId] },
      DEFAULT_RULES,
      registry,
    ).state;
    s = pass(s, registry);
    s = pass(s, registry);
    expect(s.battlefield.some((c) => c.def.id === 'Bear')).toBe(false);
    expect(s.players.A.graveyard.some((c) => c.def.id === 'Bear')).toBe(true);
  });
});
