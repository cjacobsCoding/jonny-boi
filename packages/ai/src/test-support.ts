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
  EffectRegistry,
  GameState,
  InstanceId,
  KeywordFlags,
  ManaColor,
  ManaCost,
  PlayerId,
} from '@jonny-boi/core';
import { addMana, createEffectRegistry } from '@jonny-boi/core';

// --- a tiny effect registry (full-fidelity rollouts in tests) ------------------

/**
 * A minimal effect registry that resolves the one primitive the AI fixtures use:
 * `dealDamage`. The real primitive bodies live in `@jonny-boi/cards`, which the
 * `ai` package may not depend on — so the tests register their own faithful copy
 * here. With this registry threaded into both the match loop's `applyAction` AND
 * the pilot's `DecisionContext`, burn spells resolve at *full fidelity* (face
 * damage / creature damage), exactly mirroring how the sim harness hands the pool's
 * registry to look-ahead pilots in production. Without it, `dealDamage` no-ops
 * (graceful fallback) — which is what the empty-registry robustness test exercises.
 *
 * Behaviour mirrors `cards`' canonical `dealDamage`: a player target loses life; a
 * creature target gets marked damage (the engine's SBA destroys it if lethal); no
 * target ⇒ safe no-op.
 */
export function createTestRegistry(): EffectRegistry {
  const registry = createEffectRegistry();
  registry.register('dealDamage', (ctx) => {
    const amount = typeof ctx.params.amount === 'number' ? ctx.params.amount : 0;
    if (amount <= 0) return;
    const target = ctx.targets[0];
    if (target === undefined) return;
    if (target === 'A' || target === 'B') {
      const p = ctx.state.players[target];
      p.life -= amount;
      ctx.emit({ type: 'lifeChanged', player: target, delta: -amount, to: p.life });
      return;
    }
    const perm = ctx.state.battlefield.find((c) => c.instanceId === target);
    if (!perm) return; // target fizzled — safe no-op
    perm.damageMarked += amount;
    ctx.emit({ type: 'damageDealt', source: ctx.source.instanceId, target: perm.instanceId, amount, combat: false });
  });
  return registry;
}

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

/**
 * A sorcery-speed creature-destruction spell.
 *
 * The primitive id MUST match the one `cards` actually registers (`destroyTarget`)
 * — these fixtures previously said `destroy`, which no real card uses, so the
 * pilot's removal tests passed against a vocabulary that did not exist while every
 * real removal spell fell through to "generic spell" and fizzled untargeted.
 */
export function destroyDef(id: string, cost: ManaCost = { B: 1, generic: 1 }): CardDefinition {
  return {
    id,
    name: id,
    types: ['sorcery'],
    timing: 'sorcery',
    cost,
    effects: [{ primitive: 'destroyTarget', params: { what: 'creature' } }],
  };
}

/** An instant-speed +X/+Y combat trick (the real `pumpUntilEndOfTurn` primitive). */
export function pumpDef(
  id: string,
  power: number,
  toughness: number,
  cost: ManaCost = { G: 1 },
): CardDefinition {
  return {
    id,
    name: id,
    types: ['instant'],
    timing: 'instant',
    cost,
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power, toughness } }],
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

/**
 * Put a fresh instance of `def` on the stack as a spell a player is casting — the
 * position a counterspell (or a counter MODE) has to be scored against. Returns the
 * created instance so a test can target it.
 */
export function putOnStack(
  state: GameState,
  player: PlayerId,
  def: CardDefinition,
  targets: ReadonlyArray<InstanceId | PlayerId> = [],
): CardInstance {
  const inst = newInstance(state, def, player, 'stack');
  state.stack.push({
    kind: 'spell',
    instanceId: inst.instanceId,
    card: inst,
    controller: player,
    resolvesTo: 'battlefield',
    targets,
  });
  return inst;
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
