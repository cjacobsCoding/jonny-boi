import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type PlayerId,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { creatureDef, deck, deckOf, giveGraveyard, giveHand, landDef, spellDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

function pass(state: GameState, registry = createEffectRegistry()): GameState {
  const r = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, DEFAULT_RULES, registry);
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
    while (!s.gameOver && guard++ < 2000) {
      const r = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer });
      s = r.state;
    }
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

/**
 * STATE-BASED ACTIONS AFTER A SPELL IS *ANNOUNCED*, not only after one resolves.
 *
 * The caster receives priority the instant a spell is announced, and CR 704.3
 * checks state-based actions at every point a player would receive priority. It
 * is easy to read casting as exempt — nothing has resolved yet, so what could
 * have died? — and the answer is that **casting moves a card between zones, and
 * characteristic-defining P/T reads zones.**
 *
 * A flashback cast takes the last instant OUT of a graveyard; every Tarmogoyf on
 * the board loses a point of toughness; one already shrunk by a Weakness is at 0
 * and must go to the graveyard. Before this, the engine handed priority back to
 * a player looking at a creature that should already be dead — targetable,
 * blockable, spendable. Found by the full-pool soak (`@jonny-boi/sim`'s
 * `soak.ts`) at turn 8 of seed 1727114651: once in ~5,000 games and 3.2 million
 * actions, which is exactly the kind of thing a unit test never lines up.
 */
describe('state-based actions run when a spell is CAST, not only when one resolves', () => {
  /** Tarmogoyf's box: */ /* power = card types in all graveyards, toughness = that + 1. */
  const GOYF: CardDefinition = {
    id: 'Goyf',
    name: 'Goyf',
    types: ['creature'],
    cost: { G: 1 },
    characteristicPT: {
      power: { countOf: 'cardTypesInAllGraveyards' },
      toughness: { countOf: 'cardTypesInAllGraveyards', plus: 1 },
    },
  };
  /** The only card in any graveyard, and it can leave by being flashed back. */
  const FLASHBACK_INSTANT: CardDefinition = {
    id: 'FbInstant',
    name: 'Fb Instant',
    types: ['instant'],
    timing: 'instant',
    cost: { U: 1 },
    flashback: { generic: 0 },
  };

  it('a Tarmogoyf whose last graveyard card is flashed back dies THERE, not one action later', () => {
    const registry = createEffectRegistry();
    const g = createGame({ seed: 11, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
    let s = advanceToStep(g.state, 'precombatMain', registry);

    // A's Goyf, wearing a -0/-1 (a Weakness, minus the power half so the only
    // thing keeping it alive is the graveyard).
    const goyf: CardInstance = {
      instanceId: s.nextInstanceId++,
      def: GOYF,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    s.battlefield.push(goyf);
    s.continuous.push({
      id: s.nextInstanceId++,
      targetInstanceId: goyf.instanceId,
      sourceInstanceId: goyf.instanceId,
      power: 0,
      toughness: -1,
      duration: 'permanent',
    });

    // ONE card in any graveyard — an instant — so the Goyf is a 1/2 minus the
    // Weakness: a 1/1, alive.
    const [fb] = giveGraveyard(s, 'B', [FLASHBACK_INSTANT]);
    expect(s.battlefield.some((c) => c.instanceId === goyf.instanceId), 'the Goyf should start alive').toBe(true);

    // B flashes it back for {0}. The graveyard empties, the Goyf becomes a 0/0,
    // and B is about to receive priority.
    s = pass(s, registry); // priority to B, still A's main
    const result = applyAction(
      s,
      { kind: 'castSpell', player: 'B', instanceId: fb!.instanceId, fromZone: 'graveyard' },
      DEFAULT_RULES,
      registry,
    );
    expect(result.events.find((e) => e.type === 'actionRejected')).toBeUndefined();
    s = result.state;

    expect(s.stack, 'the flashback spell is on the stack').toHaveLength(1);
    expect(
      s.battlefield.some((c) => c.instanceId === goyf.instanceId),
      'a 0-toughness creature was still on the battlefield with a player holding priority',
    ).toBe(false);
    expect(s.players.A.graveyard.some((c) => c.instanceId === goyf.instanceId)).toBe(true);
  });
});
