/**
 * THE PILOT AND THE CAST-ALTERNATIVE FAMILY (DESIGN §3.112).
 *
 * The rule this file exists to enforce is the brief's fourth contract: THE
 * PILOT MUST WEIGH EACH CHOICE. Every alternative cast is one more CANDIDATE
 * with its own price in `scoredSpellGoals`, so what is pinned here is that the
 * pilot picks the right one for the board rather than following a reflex:
 *
 *  - EVOKE when the printed cost is out of reach and the ETB is the point
 *    (Mulldrifter evoked is "draw two cards" for {2}{U}) — and NOT when the
 *    whole creature is affordable, because then the body comes free with it.
 *  - DASH when the hasty body can attack this turn, in the precombat main.
 *  - PROTOTYPE as the body it arrives as: the 1/1 when its {1}{B} is all
 *    there is, the 5/4 once {6} is available.
 *  - SURGE only once its turn fact holds (the engine refuses it otherwise, so
 *    a pilot that proposed it would spin).
 *  - CHANNEL / BLOODRUSH scored as the SPELL the body is, and carried out as
 *    a `cycleCard` with the target the scorer chose.
 *  - FORETELL / PLOT a card that cannot be cast this turn, after every real play.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  TARGET_RESTRICTION_PARAM,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, giveHand, landDef } from './test-support.js';

function creature(id: string, power: number, toughness: number, cost: CardDefinition['cost']): CardDefinition {
  return { id, name: id, types: ['creature'], power, toughness, cost };
}

/** Mulldrifter: {4}{U} 2/2 flier, "when this enters, draw two", Evoke {2}{U}. */
const MULLDRIFTER: CardDefinition = {
  ...creature('Mulldrifter', 2, 2, { generic: 4, U: 1 }),
  keywords: { flying: true },
  triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'drawCards', params: { count: 2 } }], label: 'ETB: draw two' }],
  alternativeCosts: {
    evoke: {
      cost: { generic: 2, U: 1 },
      riders: [
        {
          condition: { on: 'etb' },
          effects: [{ primitive: 'sacrificeSelfIfCastWith', params: { castWith: 'evoke' } }],
          label: 'Evoke: sacrifice it',
          removesFromBattlefield: true,
        },
      ],
    },
  },
};

/** Kolaghan Skirmisher: {1}{B} 2/2 with Dash {2}{B} — here {3}{R} / dash {1}{R}. */
const SKIRMISHER: CardDefinition = {
  ...creature('Skirmisher', 3, 2, { generic: 3, R: 1 }),
  alternativeCosts: {
    dash: {
      cost: { generic: 1, R: 1 },
      riders: [
        {
          condition: { on: 'endStep', who: 'any' },
          effects: [{ primitive: 'returnSelfToHand' }],
          label: 'Dash: return it',
          removesFromBattlefield: true,
        },
      ],
    },
  },
};

/** Goring Warplow: {6} 5/4, Prototype {1}{B} — 1/1. */
const WARPLOW: CardDefinition = {
  ...creature('Warplow', 5, 4, { generic: 6 }),
  types: ['artifact', 'creature'],
  alternativeCosts: { prototype: { cost: { generic: 1, B: 1 }, face: { power: 1, toughness: 1 } } },
};

/** Boulder Salvo: a {4}{R} sorcery dealing 4, with Surge {1}{R}. */
const SALVO: CardDefinition = {
  id: 'Salvo',
  name: 'Salvo',
  types: ['sorcery'],
  timing: 'sorcery',
  cost: { generic: 4, R: 1 },
  targets: 'creature',
  effects: [{ primitive: 'dealDamage', params: { amount: 4, [TARGET_RESTRICTION_PARAM]: 'creature' } }],
  alternativeCosts: { surge: { cost: { generic: 1, R: 1 } } },
};

/** Ghost-Lit Raider: a 2/1 whose CHANNEL deals 4 to a creature from hand for {3}{R}. */
const RAIDER: CardDefinition = {
  ...creature('Raider', 2, 1, { generic: 2, R: 1 }),
  cycling: [
    {
      cost: { generic: 3, R: 1 },
      effects: [{ primitive: 'dealDamage', params: { amount: 4, [TARGET_RESTRICTION_PARAM]: 'creature' } }],
      label: 'Channel — {3}{R}',
      kind: 'channel',
    },
  ],
};

/** Kaya's Onslaught-shaped: a {2}{W} instant with Foretell {W}. */
const FORETOLD: CardDefinition = {
  id: 'Foretold',
  name: 'Foretold',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 6, W: 1 },
  foretell: { W: 1 },
  effects: [{ primitive: 'drawCards', params: { count: 1 } }],
};

/** Djinn of Fool's Fall-shaped: a {6}{U} body with Plot {1}{U}. */
const PLOTTED: CardDefinition = {
  ...creature('Plotted', 4, 3, { generic: 6, U: 1 }),
  plot: { generic: 1, U: 1 },
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/**
 * A's main phase with `lands` untapped lands producing every colour the family
 * needs, an empty hand and the land drop spent.
 */
function boardWith(lands: number): GameState {
  const { state } = createGame({ seed: 12, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  const anyLand: CardDefinition = { id: 'Nexus', name: 'Nexus', types: ['land'], producesOptions: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }] };
  const placed = giveHand(state, 'A', Array.from({ length: lands }, () => anyLand));
  state.players.A.hand = [];
  for (const land of placed) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  state.players.A.landsPlayedThisTurn = 1;
  return state;
}

/** Put a creature on the battlefield for a targeting spell to aim at. */
function opposingCreature(state: GameState, def: CardDefinition): number {
  const [card] = giveHand(state, 'B', [def]);
  card!.zone = 'battlefield';
  card!.summoningSick = false;
  state.players.B.hand = [];
  state.battlefield.push(card!);
  return card!.instanceId;
}

/** Drive the pilot until it takes an action of `kind`, applying its taps. */
function driveUntil(state: GameState, kind: GameAction['kind'], plies = 14): GameAction | undefined {
  const reg = createTestRegistry();
  const pilot = createHeuristicPilot();
  let current = state;
  for (let ply = 0; ply < plies; ply++) {
    const action = pilot.chooseAction({ view: current, legalActions: generateLegalActions(current), rng: createRng(5) });
    if (action.kind === kind) return action;
    if (action.kind !== 'tapForMana') return undefined;
    current = applyAction(current, action, undefined, reg).state;
  }
  return undefined;
}

describe('evoke — the ETB is the candidate, and only when the body is out of reach', () => {
  it('evokes Mulldrifter on three lands: "draw two cards" for {2}{U}', () => {
    const state = boardWith(3);
    giveHand(state, 'A', [MULLDRIFTER]);
    const action = driveUntil(state, 'castSpell');
    expect(action, 'the pilot never cast Mulldrifter at all').toBeDefined();
    expect((action as Extract<GameAction, { kind: 'castSpell' }>).alternative).toBe('evoke');
  });

  it('pays the printed {4}{U} on five lands — the body comes with the draw', () => {
    const state = boardWith(5);
    giveHand(state, 'A', [MULLDRIFTER]);
    const action = driveUntil(state, 'castSpell');
    expect(action).toBeDefined();
    expect((action as Extract<GameAction, { kind: 'castSpell' }>).alternative).toBeUndefined();
  });
});

describe('dash — the hasty body, bought in the precombat main', () => {
  it('dashes the Skirmisher on two lands', () => {
    const state = boardWith(2);
    giveHand(state, 'A', [SKIRMISHER]);
    const action = driveUntil(state, 'castSpell');
    expect(action).toBeDefined();
    expect((action as Extract<GameAction, { kind: 'castSpell' }>).alternative).toBe('dash');
  });

  it('pays the printed cost on four lands, keeping the body', () => {
    const state = boardWith(4);
    giveHand(state, 'A', [SKIRMISHER]);
    const action = driveUntil(state, 'castSpell');
    expect(action).toBeDefined();
    expect((action as Extract<GameAction, { kind: 'castSpell' }>).alternative).toBeUndefined();
  });
});

describe('prototype — priced as the body it arrives as', () => {
  it('casts the 1/1 for {1}{B} when {6} is out of reach', () => {
    const state = boardWith(2);
    giveHand(state, 'A', [WARPLOW]);
    const action = driveUntil(state, 'castSpell');
    expect(action).toBeDefined();
    expect((action as Extract<GameAction, { kind: 'castSpell' }>).alternative).toBe('prototype');
  });

  it('casts the 5/4 once {6} is available', () => {
    const state = boardWith(6);
    giveHand(state, 'A', [WARPLOW]);
    const action = driveUntil(state, 'castSpell');
    expect(action).toBeDefined();
    expect((action as Extract<GameAction, { kind: 'castSpell' }>).alternative).toBeUndefined();
  });
});

describe('surge — never proposed before its turn fact holds', () => {
  it('does not cast Boulder Salvo for its surge cost on a fresh turn', () => {
    const state = boardWith(2);
    giveHand(state, 'A', [SALVO]);
    opposingCreature(state, creature('Bear', 2, 2, { generic: 2 }));
    const action = driveUntil(state, 'castSpell');
    // Two lands cannot pay {4}{R}, and the surge cost is not yet payable, so
    // the pilot must NOT be proposing a cast the engine would refuse.
    expect(action).toBeUndefined();
  });
});

describe('channel — the from-hand activation is a scored candidate carried out as a cycleCard', () => {
  it('channels Ghost-Lit Raider at the opposing creature', () => {
    const state = boardWith(4);
    giveHand(state, 'A', [RAIDER]);
    const victim = opposingCreature(state, creature('Bear', 2, 2, { generic: 2 }));
    const action = driveUntil(state, 'cycleCard');
    expect(action, 'the pilot never channelled').toBeDefined();
    const cycle = action as Extract<GameAction, { kind: 'cycleCard' }>;
    expect(cycle.abilityIndex).toBe(0);
    expect(cycle.targets).toEqual([victim]);
  });
});

describe('foretell / plot — a card that cannot be cast this turn, set aside', () => {
  it('foretells the uncastable instant', () => {
    const state = boardWith(2);
    giveHand(state, 'A', [FORETOLD]);
    expect(driveUntil(state, 'foretellCard')).toBeDefined();
  });

  it('plots the uncastable creature', () => {
    const state = boardWith(2);
    giveHand(state, 'A', [PLOTTED]);
    expect(driveUntil(state, 'plotCard')).toBeDefined();
  });

  it('does NOT set aside a card it can simply cast — the spell scorer owns it', () => {
    const state = boardWith(8);
    giveHand(state, 'A', [PLOTTED]);
    expect(driveUntil(state, 'plotCard')).toBeUndefined();
    expect(driveUntil(state, 'castSpell')).toBeDefined();
  });
});
