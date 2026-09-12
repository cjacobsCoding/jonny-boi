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
 * The primitive this fixture owns a body for, and the reason it owns one.
 *
 * `dealDamage` is minted by {@link burnDef}, which the pilot-scoring tests lean on
 * constantly, and its behaviour is small enough to state exactly: a player target
 * loses life; a creature target gets marked damage (the engine's SBA destroys it if
 * lethal); no target ⇒ safe no-op. That mirrors `cards`' canonical body, and
 * `test-support-registry.test.ts` FAILS if the two ever disagree — a second copy is
 * only allowed to exist while something proves it has not drifted.
 *
 * Nothing else is copied here, deliberately. `destroyTarget` alone reaches for five
 * `cards`-private helpers (`firstPermanentTarget`, `restrictionParam`,
 * `passesDestroyFilter`, `isLegalTarget`, `destroyPermanent`); a hand-written
 * imitation would be a second answer to the same question with no way to tell which
 * one is right. A test that needs the real bodies passes them in — see
 * {@link createTestRegistry}.
 */
const LOCAL_PRIMITIVE_IDS = ['dealDamage'] as const;

/**
 * An effect registry for the AI fixtures that **refuses what it does not know**.
 *
 * ⚠️ THE DEFECT THIS SHAPE EXISTS TO PREVENT. This factory used to register
 * `dealDamage` and hand back core's plain registry, whose `get` returns `undefined`
 * for an unknown id — so `applyEffectRef` emitted `effectUnsupported` and moved on.
 * In an ENGINE that is right: an unimplemented card must degrade, not crash. In a
 * TEST FIXTURE it is the opposite of right, because nothing in a test consumes that
 * event: the pilot is driven correctly, the ability resolves, **nothing happens, and
 * the assertion still passes**. That is this repo's most-recorded defect shape — a
 * check that reports something other than "I didn't check" (DESIGN §3.143).
 *
 * So `get` THROWS on an id nobody registered. The failure lands at the exact moment
 * the silent no-op used to, and names the primitive. `has`/`ids` stay honest (an
 * unregistered id is simply not there); `get` is the only path core's
 * `applyEffectRef` takes, which is why it is the one that refuses.
 *
 * ⚠️ NOT "register the real bodies here". The real bodies live in `@jonny-boi/cards`
 * and this is `ai` source, which may not depend on it — and copying them would only
 * move the trap: the NEXT primitive a fixture mints would no-op silently all over
 * again, because a table of copies is only ever as current as the day it was
 * written. Refusing the unknown fixes the SHAPE; copying fixes one row.
 *
 * @param bodies optional real primitive bodies to layer underneath the fixture's
 *   own. A `*.test.ts` in this package MAY import `@jonny-boi/cards` (several
 *   already do), so a test that needs removal, pumps or counterspells to actually
 *   resolve passes `createTestRegistry(buildRegistry())` and gets full fidelity
 *   without this file ever naming the `cards` package. The fixture's own bodies are
 *   registered FIRST so a supplied real body wins — real beats imitation.
 */
export function createTestRegistry(bodies?: EffectRegistry): EffectRegistry {
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
  if (bodies) {
    for (const id of bodies.ids) {
      const body = bodies.get(id);
      if (body) registry.register(id, body);
    }
  }
  return {
    register: (id, primitive) => {
      registry.register(id, primitive);
    },
    get: (id) => {
      const found = registry.get(id);
      if (found) return found;
      throw new Error(unregisteredPrimitiveMessage(id, registry.ids));
    },
    has: (id) => registry.has(id),
    get ids() {
      return registry.ids;
    },
  };
}

/**
 * The refusal, written so the next author does not have to find this file to know
 * what to do. Both escapes are one line, and which one is right depends only on
 * whether the caller is a `*.test.ts` (may import `cards`) or not.
 */
function unregisteredPrimitiveMessage(id: string, registered: readonly string[]): string {
  return [
    `createTestRegistry(): no body registered for effect primitive "${id}".`,
    '',
    'This registry REFUSES unknown primitives instead of no-oping them, because a',
    'no-op lets a test drive the pilot correctly, watch the ability resolve, and',
    'assert an effect that never happened (DESIGN §3.143).',
    '',
    'Two ways forward, both one line:',
    "  • in a *.test.ts (which MAY import @jonny-boi/cards) — the real bodies:",
    "      import { buildRegistry } from '@jonny-boi/cards';",
    '      const registry = createTestRegistry(buildRegistry());',
    '  • or register a body yourself:',
    `      const registry = createTestRegistry(); registry.register('${id}', fn);`,
    '',
    `Registered here: ${registered.join(', ')}`,
  ].join('\n');
}

/** The ids this fixture writes bodies for itself — read by the divergence guard. */
export const TEST_REGISTRY_LOCAL_IDS: readonly string[] = LOCAL_PRIMITIVE_IDS;

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

/** A hard counterspell (the real `counterSpell` primitive id). */
export function counterDef(id: string, cost: ManaCost = { U: 2 }): CardDefinition {
  return { id, name: id, types: ['instant'], timing: 'instant', cost, effects: [{ primitive: 'counterSpell' }] };
}

/** A symmetric board sweeper (the real `destroyAll` primitive id). */
export function sweeperDef(id: string, cost: ManaCost = { generic: 2, W: 2 }): CardDefinition {
  return { id, name: id, types: ['sorcery'], timing: 'sorcery', cost, effects: [{ primitive: 'destroyAll' }] };
}

/**
 * Shrink-removal: the pool writes "target creature gets -2/-2" as a NEGATIVE
 * `pumpUntilEndOfTurn`, which is a removal spell wearing a combat trick's clothes.
 */
export function shrinkDef(
  id: string,
  power: number,
  toughness: number,
  cost: ManaCost = { B: 1 },
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
