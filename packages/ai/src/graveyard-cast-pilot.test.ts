/**
 * THE PILOT PLAYS THE GRAVEYARD-CASTING FAMILY (§3.111) — the wiring that
 * keeps the mechanics from being inert. A mechanic the engine allows but no
 * pilot ever uses silently corrupts every A/B verdict that swaps such a card
 * in, so this pins the whole loop for each shape:
 *
 *  1. **Unearth** — with mana to spare and an attack ahead, the pilot funds and
 *     activates the ability from its graveyard; after combat it does not.
 *  2. **Scavenge** — the counters go on the pilot's BEST attacker.
 *  3. **Retrace / escape** — the graveyard cast rides the same `scoredSpellGoals`
 *     seam flashback does: the pilot taps toward it and submits the cast with
 *     its KIND, when the graveyard has the fuel and the spell is worth it.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, giveHand, landDef } from './test-support.js';

function creature(id: string, power: number, toughness: number, cost: CardDefinition['cost']): CardDefinition {
  return { id, name: id, types: ['creature'], power, toughness, cost };
}

/** Dregscape Zombie's shape: a 2/1 with Unearth {B}. */
const ZOMBIE: CardDefinition = {
  ...creature('Dregscape Zombie', 2, 1, { generic: 1, B: 1 }),
  graveyardAbilities: [
    { kind: 'unearth', cost: { mana: { B: 1 } }, effects: [{ primitive: 'unearthReturn' }], timing: 'sorcery', label: 'Unearth {B}' },
  ],
};
/** Deadbridge Goliath's shape: a 5/5 with Scavenge {1}{G}. */
const GOLIATH: CardDefinition = {
  ...creature('Deadbridge Goliath', 5, 5, { generic: 2, G: 2 }),
  graveyardAbilities: [
    {
      kind: 'scavenge',
      cost: { mana: { generic: 1, B: 1 } },
      exileSelf: true,
      effects: [{ primitive: 'scavengeCounters', params: { targets: 'creature' } }],
      timing: 'sorcery',
      label: 'Scavenge {1}{B}',
    },
  ],
};
/** Flame Jab's shape: {B} sorcery, 1 damage anywhere, retrace. */
const JAB: CardDefinition = {
  id: 'Flame Jab',
  name: 'Flame Jab',
  types: ['sorcery'],
  cost: { B: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 1, targets: 'any' } }],
  graveyardCasts: [{ kind: 'retrace', additional: { kind: 'discard', filter: { anyOfTypes: ['land'] }, label: 'Discard a land card' } }],
};
/** A Glimpse-shaped {1}{B} instant: 2 damage anywhere, Escape—{B}, exile two other cards. */
const ESCAPE_BOLT: CardDefinition = {
  id: 'Escape Bolt',
  name: 'Escape Bolt',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 1, B: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 2, targets: 'any' } }],
  graveyardCasts: [
    { kind: 'escape', cost: { B: 1 }, additional: { kind: 'exileFromGraveyard', count: 2, label: 'Exile two other cards from your graveyard' } },
  ],
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'B')) };
}

/** A's main phase with `landCount` untapped Swamps, an empty hand, no land drop left. */
function boardWith(landCount: number, step: 'precombatMain' | 'postcombatMain' = 'precombatMain'): GameState {
  const { state } = createGame({ seed: 13, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = step;
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  const swamps = giveHand(state, 'A', Array.from({ length: landCount }, (_, i) => landDef(`S${i}`, 'B')));
  state.players.A.hand = [];
  for (const land of swamps) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  state.players.A.landsPlayedThisTurn = 1;
  return state;
}

function toGraveyard(state: GameState, defs: readonly CardDefinition[]): CardInstance[] {
  const cards = giveHand(state, 'A', defs);
  state.players.A.hand = [];
  for (const card of cards) {
    card.zone = 'graveyard';
    state.players.A.graveyard.push(card);
  }
  return cards;
}

function onBattlefield(state: GameState, def: CardDefinition): CardInstance {
  const [card] = giveHand(state, 'A', [def]);
  state.players.A.hand = [];
  card!.zone = 'battlefield';
  card!.summoningSick = false;
  state.battlefield.push(card as CardInstance);
  return card as CardInstance;
}

/** Drive the pilot until it submits an action of `kind`; anything but a tap toward it fails. */
function driveUntil(state: GameState, kind: GameAction['kind'], plies = 12): GameAction | undefined {
  const reg = createTestRegistry();
  const pilot = createHeuristicPilot();
  let s = state;
  for (let ply = 0; ply < plies; ply++) {
    const legal = generateLegalActions(s);
    const action = pilot.chooseAction({ view: s, legalActions: legal, rng: createRng(5) });
    if (action.kind === kind) return action;
    if (action.kind !== 'tapForMana') return undefined;
    s = applyAction(s, action, undefined, reg).state;
  }
  return undefined;
}

describe('the pilot plays the graveyard-casting family', () => {
  it('unearths a creature from its graveyard when it has the mana and an attack ahead — and not once combat is behind it', () => {
    const state = boardWith(2);
    const [zombie] = toGraveyard(state, [ZOMBIE]);
    const activation = driveUntil(state, 'activateGraveyardAbility');
    expect(activation).toMatchObject({ kind: 'activateGraveyardAbility', instanceId: zombie!.instanceId, abilityIndex: 0 });

    const after = boardWith(2, 'postcombatMain');
    toGraveyard(after, [ZOMBIE]);
    expect(driveUntil(after, 'activateGraveyardAbility')).toBeUndefined();
  });

  it('scavenges onto its BEST attacker, not the first legal target', () => {
    const state = boardWith(3);
    onBattlefield(state, creature('Runt', 1, 1, { B: 1 }));
    const brute = onBattlefield(state, creature('Brute', 4, 4, { generic: 3, B: 1 }));
    onBattlefield(state, creature('Runt 2', 1, 1, { B: 1 }));
    toGraveyard(state, [GOLIATH]);
    const activation = driveUntil(state, 'activateGraveyardAbility');
    expect(activation).toMatchObject({ kind: 'activateGraveyardAbility', targets: [brute.instanceId] });
  });

  it('retraces a lethal Flame Jab out of the graveyard, pitching the land in hand, and names the kind on the cast', () => {
    const state = boardWith(2);
    const [jab] = toGraveyard(state, [JAB]);
    giveHand(state, 'A', [landDef('Spare Swamp', 'B')]);
    state.players.B.life = 1;
    const cast = driveUntil(state, 'castSpell');
    expect(cast).toMatchObject({ kind: 'castSpell', instanceId: jab!.instanceId, fromZone: 'graveyard', graveyardCast: 'retrace', targets: ['B'] });
  });

  it('escapes a lethal bolt when the graveyard has the fuel, and never proposes it when it does not', () => {
    const state = boardWith(2);
    const [bolt] = toGraveyard(state, [ESCAPE_BOLT, landDef('Dead Swamp 1', 'B'), landDef('Dead Swamp 2', 'B')]);
    state.players.B.life = 2;
    const cast = driveUntil(state, 'castSpell');
    expect(cast).toMatchObject({ kind: 'castSpell', instanceId: bolt!.instanceId, fromZone: 'graveyard', graveyardCast: 'escape', targets: ['B'] });

    const thin = boardWith(2);
    toGraveyard(thin, [ESCAPE_BOLT, landDef('Dead Swamp 1', 'B')]);
    thin.players.B.life = 2;
    expect(driveUntil(thin, 'castSpell')).toBeUndefined();
  });
});
