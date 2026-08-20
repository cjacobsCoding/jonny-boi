/**
 * The HUMAN affordance for a card with two castable halves.
 *
 * The play board keys everything on an instance id, and until a card could be
 * cast two ways that was enough. A split card breaks it in the worst way — not
 * by missing an option, but by showing ONE button labelled with the CR 709.4
 * COMBINED cost that, when clicked, casts the left half for a different price.
 *
 * So `castOptions()` now returns one option per castable HALF, each describing
 * that half (its own name, its own cost, its own target requirement) and
 * carrying the `face` its action must name. This pins that, and pins the two
 * halves you do not hold in hand: an AFTERMATH half offered from the graveyard,
 * and an adventurer's creature half offered from exile.
 */
import { describe, expect, it } from 'vitest';
import { createGame, type CardDefinition, type CardInstance, type PlayerId } from '@jonny-boi/core';
import { createEffectRegistry } from '@jonny-boi/core';
import { GameSession } from './session.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

const MOUNTAIN: CardDefinition = {
  id: 'mountain',
  name: 'Mountain',
  types: ['land'],
  basic: true,
  subtypes: ['mountain'],
  produces: ['R'],
};

const LEFT: CardDefinition = {
  id: 'left',
  name: 'Snuff',
  types: ['sorcery'],
  cost: { R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 2, targets: 'any' } }],
};
const RIGHT: CardDefinition = {
  id: 'right',
  name: 'Blast',
  types: ['sorcery'],
  cost: { generic: 1, R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 4, targets: 'any' } }],
  isBackFace: true,
};
const SPLIT: CardDefinition = {
  id: 'snuff-blast',
  name: 'Snuff // Blast',
  types: ['sorcery'],
  cost: { generic: 1, R: 2 },
  frontFace: LEFT,
  backFace: RIGHT,
  backFaceCastable: true,
};
const AFTERMATH: CardDefinition = { ...SPLIT, id: 'aftermath', name: 'Snuff // Rise', backFaceCastZones: ['graveyard'] };

const ADVENTURE_HALF: CardDefinition = {
  id: 'adv-half',
  name: 'Stomp',
  types: ['instant'],
  timing: 'instant',
  cost: { R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 1, targets: 'any' } }],
  isBackFace: true,
  adventure: true,
};
const ADVENTURER: CardDefinition = {
  id: 'adventurer',
  name: 'Bonecrusher Giant',
  types: ['creature'],
  cost: { generic: 2, R: 1 },
  power: 5,
  toughness: 5,
  backFace: ADVENTURE_HALF,
  backFaceCastable: true,
};

/** A's precombat main with `mountains` untapped Mountains and an empty hand. */
function sessionAtMain(mountains: number): { session: GameSession; state: ReturnType<typeof buildState> } {
  const state = buildState(mountains);
  const registry = createEffectRegistry();
  return { session: new GameSession(state, [], registry, SEAT_NAMES), state };
}

function buildState(mountains: number): ReturnType<typeof createGame>['state'] {
  const registry = createEffectRegistry();
  const deck = { cards: Array.from({ length: 30 }, () => MOUNTAIN) };
  const { state } = createGame({ seed: 3, decks: { A: deck, B: deck }, registry });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  for (let i = 0; i < mountains; i++) {
    const land: CardInstance = {
      instanceId: state.nextInstanceId++,
      def: MOUNTAIN,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    state.battlefield.push(land);
  }
  return state;
}

/** Put a definition into a zone and return its instance id. */
function place(
  state: ReturnType<typeof buildState>,
  def: CardDefinition,
  zone: 'hand' | 'graveyard' | 'exile',
): number {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller: 'A',
    owner: 'A',
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players.A[zone].push(inst);
  return inst.instanceId;
}

describe('a split card in hand', () => {
  it('offers ONE option per half, each with that half`s own name and cost', () => {
    const { session, state } = sessionAtMain(3);
    const id = place(state, SPLIT, 'hand');
    const options = session.castOptions().filter((o) => o.instanceId === id);
    expect(options).toHaveLength(2);
    const left = options.find((o) => o.face === undefined);
    const right = options.find((o) => o.face === 'back');
    expect(left?.name).toBe('Snuff');
    expect(left?.cost).toEqual({ R: 1 });
    expect(right?.name).toBe('Blast');
    expect(right?.cost).toEqual({ generic: 1, R: 1 });
    // …and NEITHER is the combined object, which is what a board keyed on the
    // instance alone would have shown.
    expect(options.some((o) => o.name === 'Snuff // Blast')).toBe(false);
  });

  it('casts the half the option names, and the engine accepts it', () => {
    const { session, state } = sessionAtMain(3);
    const id = place(state, SPLIT, 'hand');
    const right = session.castOptions().find((o) => o.instanceId === id && o.face === 'back');
    expect(right).toBeDefined();
    const result = session.castWithAutoTap(id, ['B'], 'hand', right!.face);
    expect(result.rejected).toBeNull();
    // The object on the stack IS the right half, which is the whole claim: a
    // face-less cast of the same instance would have put "Snuff" there.
    const spell = result.session.state.stack[0];
    expect(spell?.kind).toBe('spell');
    expect(spell && spell.kind === 'spell' ? spell.card.def.name : undefined).toBe('Blast');
  });
});

describe('an aftermath half', () => {
  it('is NOT offered from hand and IS offered from the graveyard', () => {
    const { session, state } = sessionAtMain(3);
    const inHand = place(state, AFTERMATH, 'hand');
    const inYard = place(state, AFTERMATH, 'graveyard');
    expect(session.castOptions().filter((o) => o.instanceId === inHand)).toHaveLength(1);
    const yardOptions = session.graveyardCastOptions().filter((o) => o.instanceId === inYard);
    expect(yardOptions).toHaveLength(1);
    expect(yardOptions[0]!.face).toBe('back');
    expect(yardOptions[0]!.fromZone).toBe('graveyard');
    expect(yardOptions[0]!.cost).toEqual({ generic: 1, R: 1 });
  });
});

describe('an adventurer waiting in exile', () => {
  it('is offered as a cast from exile once the permission exists', () => {
    const { session, state } = sessionAtMain(4);
    const id = place(state, ADVENTURER, 'exile');
    // No permission yet: the card is simply exiled and nothing may cast it.
    expect(session.exileCastOptions().filter((o) => o.instanceId === id)).toHaveLength(0);
    state.cardGrants = [
      {
        id: 9001,
        targetInstanceId: id,
        sourceInstanceId: id,
        duration: 'permanent',
        zone: 'exile',
        castFace: 'front',
      },
    ];
    const refreshed = new GameSession(state, [], createEffectRegistry(), SEAT_NAMES);
    const options = refreshed.exileCastOptions().filter((o) => o.instanceId === id);
    expect(options).toHaveLength(1);
    expect(options[0]!.name).toBe('Bonecrusher Giant');
    expect(options[0]!.fromZone).toBe('exile');
  });
});
