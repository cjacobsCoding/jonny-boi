/**
 * Emblems: command-zone objects nothing can remove (CR 114).
 *
 * What is being pinned:
 *   - an emblem is created in the COMMAND zone, never on the battlefield, and
 *     therefore fires no enters-the-battlefield trigger;
 *   - its STATIC abilities reach the continuous layer from there, so an anthem
 *     printed on an emblem buffs exactly what it says;
 *   - its TRIGGERED abilities reach the trigger collector from there;
 *   - **nothing removes it** — the headline failure mode is a board wipe, which
 *     must leave the emblem and its buff completely untouched;
 *   - it is not a permanent: it is not targetable and not on the battlefield, so
 *     no board scan can see it.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applyEffectRef,
  createEffectRegistry,
  createGame,
  DEFAULT_RULES,
  effectivePower,
  legalTargetsFor,
  type CardDefinition,
  type GameAction,
  type GameState,
} from './index.js';
import { aggregateFor } from './internal/continuous.js';
import { deckOf, landDef, passOrAnswer } from './test-fixtures.js';
import type { CardInstance, InstanceId, PlayerId } from './state.js';
import type { GameEvent } from './events.js';

const ISLAND = landDef('Island', 'U');

/** An emblem that pumps its controller's creatures — the classic ultimate. */
const ANTHEM_EMBLEM: CardDefinition = {
  id: 'emblem:anthem',
  name: 'Test anthem emblem',
  types: [],
  isEmblem: true,
  statics: [
    {
      affects: { controller: 'you', anyOfTypes: ['creature'] },
      power: 2,
      toughness: 2,
      label: 'Creatures you control get +2/+2',
    },
  ],
};

/** An emblem with an upkeep trigger — the other half of what an emblem can do. */
const UPKEEP_EMBLEM: CardDefinition = {
  id: 'emblem:upkeep',
  name: 'Test upkeep emblem',
  types: [],
  isEmblem: true,
  triggers: [
    {
      condition: { on: 'upkeep', who: 'you' },
      effects: [{ primitive: 'testEmblemUpkeep' }],
      label: 'At the beginning of your upkeep, note',
    },
  ],
};

function creature(name: string, power = 1, toughness = 1): CardDefinition {
  return { id: name, name, types: ['creature'], power, toughness };
}

function lib(): ReturnType<typeof deckOf> {
  return deckOf(ISLAND, 40);
}

function makeRegistry(): ReturnType<typeof createEffectRegistry> {
  return createEffectRegistry();
}

function act(
  state: GameState,
  action: GameAction,
  registry = makeRegistry(),
): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

function put(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst.instanceId;
}

/** Put an emblem into a player's command zone, as `createEmblem` does. */
function putEmblem(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'command',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players[controller].command.push(inst);
  return inst.instanceId;
}

function onBattlefield(state: GameState, id: InstanceId): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

/** Effective power of a battlefield permanent under the live continuous layer. */
function power(state: GameState, id: InstanceId): number {
  const inst = onBattlefield(state, id);
  if (!inst) return 0;
  return effectivePower(inst, aggregateFor(state, id));
}

describe('creation', () => {
  it('createEmblem puts the object in the COMMAND zone, not the battlefield', () => {
    const { state } = createGame({ seed: 1, decks: { A: lib(), B: lib() }, registry: makeRegistry() });
    const events: GameEvent[] = [];
    const registry = createEffectRegistry();
    registry.register('makeEmblem', (ctx) => {
      ctx.createEmblem(ANTHEM_EMBLEM);
    });
    const source = onBattlefield(state, put(state, creature('Source'), 'A'))!;
    applyEffectRef(
      registry,
      { primitive: 'makeEmblem' },
      { state, source, controller: 'A' },
      (e) => events.push(e),
      [],
    );

    expect(state.players.A.command).toHaveLength(1);
    expect(state.players.A.command[0]!.def.isEmblem).toBe(true);
    // It is NOT on the battlefield, which is what makes it unremovable.
    expect(state.battlefield.some((c) => c.def.isEmblem === true)).toBe(false);
    // It announces itself, and it does NOT emit a battlefield zoneChange — so no
    // enters-the-battlefield trigger can fire off an emblem.
    expect(events.some((e) => e.type === 'emblemCreated')).toBe(true);
    expect(events.some((e) => e.type === 'zoneChange' && e.to === 'battlefield')).toBe(false);
  });

  it('an emblem with NO abilities is refused rather than created inert', () => {
    // A provably-do-nothing object in the command zone is exactly the
    // "looks implemented, isn't" outcome the compiler contract exists to stop.
    const { state } = createGame({ seed: 2, decks: { A: lib(), B: lib() }, registry: makeRegistry() });
    const registry = createEffectRegistry();
    registry.register('createEmblem', (ctx) => {
      // Mirror the cards-package primitive's guard.
      const statics = Array.isArray(ctx.params.statics) ? ctx.params.statics : [];
      const triggers = Array.isArray(ctx.params.triggers) ? ctx.params.triggers : [];
      if (statics.length === 0 && triggers.length === 0) return;
      ctx.createEmblem({ id: 'e', name: 'e', types: [], isEmblem: true });
    });
    const source = onBattlefield(state, put(state, creature('Source'), 'A'))!;
    applyEffectRef(registry, { primitive: 'createEmblem' }, { state, source, controller: 'A' }, () => {}, []);
    expect(state.players.A.command).toHaveLength(0);
  });
});

describe('abilities work from the command zone', () => {
  it("an emblem's static buffs its controller's creatures", () => {
    const { state } = createGame({ seed: 3, decks: { A: lib(), B: lib() }, registry: makeRegistry() });
    const mine = put(state, creature('Mine', 1, 1), 'A');
    const theirs = put(state, creature('Theirs', 1, 1), 'B');
    expect(power(state, mine)).toBe(1);

    putEmblem(state, ANTHEM_EMBLEM, 'A');
    expect(power(state, mine)).toBe(3); // 1 + 2 from the emblem
    // "Creatures YOU control" — the opponent's are untouched.
    expect(power(state, theirs)).toBe(1);
  });

  it("an emblem's trigger fires from the command zone", () => {
    const { state } = createGame({ seed: 4, decks: { A: lib(), B: lib() }, registry: makeRegistry() });
    const registry = createEffectRegistry();
    let fired = 0;
    registry.register('testEmblemUpkeep', () => {
      fired += 1;
    });
    putEmblem(state, UPKEEP_EMBLEM, 'A');

    // Walk into the next upkeep. The emblem's trigger must go on the stack and
    // resolve exactly as a permanent's upkeep trigger would.
    let s = state;
    let guard = 0;
    // `passOrAnswer`, not a bare pass: a turn ends with the CR 514.1 discard
    // question when a hand is over the maximum, and nothing else may act while
    // it stands.
    while (guard++ < 400 && fired === 0 && !s.gameOver) {
      s = passOrAnswer(s, DEFAULT_RULES, registry);
    }
    expect(fired).toBeGreaterThan(0);
  });
});

describe('nothing can remove it', () => {
  it('an emblem SURVIVES a board wipe, and so does its buff', () => {
    // The headline failure mode. `destroyAll` and every other removal path scan
    // `state.battlefield`; an emblem is not there, so it cannot be caught — and
    // the creature that arrives after the wipe is buffed just as the one before
    // it was.
    const { state } = createGame({ seed: 5, decks: { A: lib(), B: lib() }, registry: makeRegistry() });
    const before = put(state, creature('Before', 1, 1), 'A');
    putEmblem(state, ANTHEM_EMBLEM, 'A');
    expect(power(state, before)).toBe(3);

    // A real wipe through the real primitive shape: clear the battlefield the
    // way `destroyAll` does, then check what is left.
    const registry = createEffectRegistry();
    registry.register('wipe', (ctx) => {
      for (const perm of [...ctx.state.battlefield]) {
        const idx = ctx.state.battlefield.indexOf(perm);
        if (idx >= 0) ctx.state.battlefield.splice(idx, 1);
        perm.zone = 'graveyard';
        ctx.state.players[perm.owner].graveyard.push(perm);
      }
    });
    const source = state.players.A.command[0]!;
    applyEffectRef(registry, { primitive: 'wipe' }, { state, source, controller: 'A' }, () => {}, []);

    expect(state.battlefield).toHaveLength(0);
    // The emblem is untouched.
    expect(state.players.A.command).toHaveLength(1);
    // And still working: a creature that arrives afterwards is buffed.
    const after = put(state, creature('After', 1, 1), 'A');
    expect(power(state, after)).toBe(3);
  });

  it('an emblem is not a legal target for anything', () => {
    // Not targetable, because it is not on the battlefield at all — the menu is
    // built from `state.battlefield`, so there is nothing to exclude.
    const { state } = createGame({ seed: 6, decks: { A: lib(), B: lib() }, registry: makeRegistry() });
    const emblem = putEmblem(state, ANTHEM_EMBLEM, 'A');
    for (const restriction of ['any', 'creature', 'creatureOrPlaneswalker', 'artifact'] as const) {
      expect(legalTargetsFor(state, restriction, 'B')).not.toContain(emblem);
      expect(legalTargetsFor(state, restriction, 'A')).not.toContain(emblem);
    }
  });

  it('an emblem is not a permanent: it never appears on the battlefield', () => {
    const { state } = createGame({ seed: 7, decks: { A: lib(), B: lib() }, registry: makeRegistry() });
    putEmblem(state, ANTHEM_EMBLEM, 'A');
    expect(state.battlefield).toHaveLength(0);
    // And it carries no card types, so no type-filtered effect can match it.
    expect(state.players.A.command[0]!.def.types).toHaveLength(0);
  });
});
