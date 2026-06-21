/**
 * Minimal, inline card + state fixtures for the AI pilot tests.
 *
 * Per the parallel-development rule, the `ai` package depends on `@jonny-boi/core`
 * ONLY — not on `@jonny-boi/cards` (built in parallel). So these tests build their
 * own tiny `CardDefinition`s (a couple of vanilla creatures, a burn spell, lands)
 * that the engine resolves, plus helpers to place cards deterministically into a
 * game position. This keeps the suite unblocked and flake-free (no reliance on a
 * shuffle putting the right card in hand).
 *
 * Excluded from the package build (see tsconfig `exclude`) — test support only.
 */

import type {
  CardDefinition,
  CardInstance,
  GameState,
  InstanceId,
  KeywordFlags,
  ManaColor,
  ManaCost,
  PlayerId,
} from '@jonny-boi/core';
import { addMana } from '@jonny-boi/core';

// --- card definitions ----------------------------------------------------------

/** A basic land that taps for one mana of a color. */
export function landDef(id: string, color: ManaColor = 'R'): CardDefinition {
  return { id, name: id, types: ['land'], produces: [color] };
}

/** A vanilla (or keyword-bearing) creature. */
export function creatureDef(
  id: string,
  power: number,
  toughness: number,
  opts: { cost?: ManaCost; keywords?: KeywordFlags } = {},
): CardDefinition {
  return {
    id,
    name: id,
    types: ['creature'],
    power,
    toughness,
    cost: opts.cost ?? { generic: 1 },
    keywords: opts.keywords,
  };
}

/**
 * A burn spell: deals `amount` damage to any target (creature or player). Uses the
 * conventional `dealDamage` primitive id the heuristic recognises. The effect body
 * is owned by `cards`; for AI scoring tests we only need the def's shape.
 */
export function burnDef(id: string, amount: number, cost: ManaCost = { R: 1 }): CardDefinition {
  return {
    id,
    name: id,
    types: ['instant'],
    timing: 'instant',
    cost,
    effects: [{ primitive: 'dealDamage', params: { amount, targets: 'any' } }],
  };
}

/** A sorcery-speed creature-destruction spell (conventional `destroy` primitive). */
export function destroyDef(id: string, cost: ManaCost = { B: 1, generic: 1 }): CardDefinition {
  return {
    id,
    name: id,
    types: ['sorcery'],
    timing: 'sorcery',
    cost,
    effects: [{ primitive: 'destroy', params: { what: 'creature' } }],
  };
}

// --- state placement (deterministic positions) ---------------------------------

/**
 * Put fresh instances of `defs` into a player's hand on an existing state.
 * Returns the created instances in order. Mutates the state — for building test
 * positions only.
 */
export function giveHand(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  const created: CardInstance[] = [];
  for (const def of defs) {
    const inst = newInstance(state, def, player, 'hand');
    state.players[player].hand.push(inst);
    created.push(inst);
  }
  return created;
}

/**
 * Put fresh instances of `defs` onto the battlefield under a player's control.
 * Permanents enter untapped and not summoning-sick (settled board), so combat
 * tests can attack immediately. Returns the created instances in order.
 */
export function putOnBattlefield(
  state: GameState,
  player: PlayerId,
  defs: readonly CardDefinition[],
): CardInstance[] {
  const created: CardInstance[] = [];
  for (const def of defs) {
    const inst = newInstance(state, def, player, 'battlefield');
    inst.summoningSick = false;
    state.battlefield.push(inst);
    created.push(inst);
  }
  return created;
}

/** Add floating mana of one color to a player's pool (so a spell is affordable). */
export function addPool(state: GameState, player: PlayerId, color: ManaColor, amount: number): void {
  state.players[player].manaPool = addMana(state.players[player].manaPool, color, amount);
}

function newInstance(
  state: GameState,
  def: CardDefinition,
  player: PlayerId,
  zone: CardInstance['zone'],
): CardInstance {
  return {
    instanceId: state.nextInstanceId++ as InstanceId,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: true,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}
