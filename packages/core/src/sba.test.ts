import { describe, expect, it } from 'vitest';
import {
  applyAction,
  checkStateBasedActions,
  cloneState,
  createGame,
  DEFAULT_RULES,
  MINUS_ONE_COUNTER,
  NO_COUNTERS,
  PLUS_ONE_COUNTER,
  stateBasedActionsPossible,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type PlayerId,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import {
  creatureDef,
  deck,
  deckOf,
  giveGraveyard,
  giveHand,
  landDef,
  passOrAnswer,
  spellDef,
} from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

function pass(state: GameState, registry = createEffectRegistry()): GameState {
  const r = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, DEFAULT_RULES, registry);
  return r.state;
}

function advanceToStep(state: GameState, target: string, registry = createEffectRegistry(), max = 400): GameState {
  let s = state;
  let g = 0;
  while (s.step !== target && !s.gameOver && g++ < max) s = passOrAnswer(s, DEFAULT_RULES, registry);
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
    // `passOrAnswer`, not a bare pass: a turn ends with the CR 514.1 discard
    // question once a hand is over the maximum, and while it stands every other
    // action is refused — a pass-only loop would spin here without advancing.
    while (!s.gameOver && guard++ < 2000) s = passOrAnswer(s);
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

// --- CR 704.3: the priority boundary, and the cheap gate in front of it ----------

describe('state-based actions at the priority boundary (CR 704.3)', () => {
  /** A settled position: A's precombat main, both hands emptied, nothing in play. */
  function quiet(seed = 41): GameState {
    const g = createGame({ seed, startingPlayer: 'A', decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
    const s = advanceToStep(g.state, 'precombatMain');
    s.players.A.hand = [];
    s.players.B.hand = [];
    return s;
  }

  /** Put a creature straight onto the battlefield as a test POSITION. */
  function place(state: GameState, def: CardDefinition, controller: PlayerId, damage = 0): CardInstance {
    const inst: CardInstance = {
      instanceId: state.nextInstanceId++,
      def,
      controller,
      owner: controller,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: damage,
      markedByDeathtouch: false,
      attachedTo: null,
      counters: NO_COUNTERS,
    };
    state.battlefield.push(inst);
    return inst;
  }

  it('catches a life total that no mutation site announced', () => {
    // The reproduction the conformance suite filed: the condition is written
    // straight onto the state, so none of the dozen explicit call sites runs and
    // only the boundary can catch it.
    const s = quiet();
    s.players.B.life = 0;
    const after = pass(s);
    expect(after.players.B.hasLost).toBe(true);
    expect(after.gameOver).toBe(true);
    expect(after.winner).toBe('A');
  });

  it('catches a creature that was killed with no mutation site behind it', () => {
    const s = quiet();
    const bear = place(s, creatureDef('Bear', 2, 2), 'B');
    bear.damageMarked = 2;
    const after = pass(s);
    expect(after.battlefield.some((c) => c.instanceId === bear.instanceId)).toBe(false);
    expect(after.players.B.graveyard.some((c) => c.instanceId === bear.instanceId)).toBe(true);
  });

  /**
   * THE GATE'S ONE CONTRACT, asserted in the only direction that matters.
   *
   * `stateBasedActionsPossible` is allowed to say YES on a board with nothing to
   * do — that costs one wasted check. It must never say NO on a board where the
   * real check would act, because that silently defers a state-based action,
   * which is the exact defect the boundary check exists to prevent.
   */
  it('the cheap gate never says "nothing to do" on a board that has something to do', () => {
    const positions: ReadonlyArray<readonly [string, (s: GameState) => void]> = [
      ['a player at zero life', (s) => { s.players.B.life = 0; }],
      ['a player at negative life', (s) => { s.players.A.life = -3; }],
      ['a player already flagged as lost', (s) => { s.players.B.hasLost = true; }],
      ['lethal damage marked', (s) => { place(s, creatureDef('Bear', 2, 2), 'A', 2); }],
      ['deathtouch damage below lethal', (s) => {
        const bear = place(s, creatureDef('Bear', 2, 2), 'A', 1);
        bear.markedByDeathtouch = true;
      }],
      ['a printed zero-toughness creature', (s) => { place(s, creatureDef('Nothing', 1, 0), 'A'); }],
      ['a creature shrunk below zero by counters', (s) => {
        const bear = place(s, creatureDef('Bear', 2, 2), 'A');
        bear.counters = { [MINUS_ONE_COUNTER]: 2 };
      }],
      ['both counter kinds on one permanent (CR 704.5q)', (s) => {
        const bear = place(s, creatureDef('Bear', 2, 2), 'A');
        bear.counters = { [PLUS_ONE_COUNTER]: 2, [MINUS_ONE_COUNTER]: 1 };
      }],
      ['two legendary permanents with the same name', (s) => {
        const legend: CardDefinition = { ...creatureDef('Hero', 2, 2), legendary: true };
        place(s, legend, 'A');
        place(s, legend, 'A');
      }],
    ];
    for (const [what, arrange] of positions) {
      const s = quiet();
      arrange(s);
      // The REAL check is what decides whether there was something to do: run it
      // on a copy and see whether the board moved. Asking the gate to agree with
      // a hand-written list of conditions would be a second opinion; asking it to
      // agree with the rule it guards is the contract.
      const copy = cloneState(s);
      // The WHOLE state, not : the inspector view does not carry
      // counters, and CR 704.5q moves nothing else.
      const before = JSON.stringify(copy);
      checkStateBasedActions(copy, () => {});
      const acted = JSON.stringify(copy) !== before;
      expect(acted, `${what}: the real check did nothing, so this position proves nothing`).toBe(true);
      expect(stateBasedActionsPossible(s), `${what}: the gate skipped a live condition`).toBe(true);
    }
  });

  it('says no on a settled board, so the hot path pays one walk and nothing else', () => {
    // Not a correctness claim — a false YES is harmless — but the whole reason
    // the gate exists. If this ever flips, the boundary check is running the full
    // pass on every priority pass of every sim game.
    const s = quiet();
    place(s, creatureDef('Bear', 2, 2), 'A');
    place(s, creatureDef('Wall', 0, 4), 'B', 1);
    expect(stateBasedActionsPossible(s)).toBe(false);
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
