/**
 * THE GUARD ON THE FIXTURE ITSELF (DESIGN §3.143).
 *
 * `createTestRegistry` spent its whole life registering `dealDamage` and no-oping
 * every other primitive, because core's plain registry answers an unknown id with
 * `undefined` and `applyEffectRef` turns that into an `effectUnsupported` event
 * nobody in a test is listening for. The result is this repo's most-recorded defect
 * shape: a test drives the pilot correctly, watches the ability resolve, asserts the
 * effect happened, and passes while nothing happened at all.
 *
 * The fixture now refuses what it does not know. This file is what stops it
 * quietly going back — a fix nothing pins is a fix the next person undoes.
 *
 * It is also the DIVERGENCE GUARD required by the one hand-written primitive body
 * the fixture still owns. `dealDamage` exists twice — here and in `@jonny-boi/cards`
 * — because `packages/ai` may not depend on `cards`. Two answers to one question
 * eventually answer it differently, so the second copy is only allowed to exist
 * while something fails when it drifts. That is `behaves identically to the real
 * body` below, and it compares BEHAVIOUR on real positions, not source text.
 *
 * This is a `*.test.ts`, which is the side of the package boundary that MAY import
 * `@jonny-boi/cards` — several sibling suites already do.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry } from '@jonny-boi/cards';
import {
  applyAction,
  applyEffectRef,
  createEffectRegistry,
  createGame,
  type CardDefinition,
  type DeckList,
  type EffectRegistry,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import {
  addPool,
  burnDef,
  counterDef,
  createTestRegistry,
  creatureDef,
  destroyDef,
  giveHand,
  landDef,
  pumpDef,
  putOnBattlefield,
  shrinkDef,
  sweeperDef,
  TEST_REGISTRY_LOCAL_IDS,
} from './test-support.js';

/**
 * Every primitive id the fixture's own `*Def` helpers mint, as a TABLE rather than
 * a list of assertions — adding a helper should be a ROW here, and the coverage
 * test below turns a missing row into a failure rather than into a silent gap.
 *
 * `helper` builds a definition; `primitive` is the id that definition resolves.
 * The pairing is checked against the definition itself, so a helper whose primitive
 * id is edited without editing this table fails immediately.
 */
const FIXTURE_PRIMITIVES: ReadonlyArray<{
  readonly helper: string;
  readonly primitive: string;
  readonly def: CardDefinition;
}> = [
  { helper: 'burnDef', primitive: 'dealDamage', def: burnDef('B', 3) },
  { helper: 'destroyDef', primitive: 'destroyTarget', def: destroyDef('D') },
  { helper: 'pumpDef', primitive: 'pumpUntilEndOfTurn', def: pumpDef('P', 2, 2) },
  { helper: 'shrinkDef', primitive: 'pumpUntilEndOfTurn', def: shrinkDef('S', -2, -2) },
  { helper: 'counterDef', primitive: 'counterSpell', def: counterDef('C') },
  { helper: 'sweeperDef', primitive: 'destroyAll', def: sweeperDef('W') },
];

describe('the AI test fixture registry is honest about what it does not know', () => {
  /**
   * ⚠️ THE LOAD-BEARING ONE. If this ever goes green-by-no-op again, every test in
   * the package that resolves an unregistered primitive silently stops checking
   * anything, and nothing else in the suite would notice.
   */
  it('THROWS on an unregistered primitive instead of returning undefined', () => {
    const registry = createTestRegistry();
    expect(() => registry.get('destroyTarget')).toThrow(/no body registered/);
    expect(() => registry.get('aPrimitiveNobodyWillEverWrite')).toThrow(/no body registered/);
  });

  /**
   * The message is part of the fix, not decoration. The whole cost of this defect
   * was an author who could not tell that anything had gone wrong; an error that
   * does not say what to do next just moves the confusion.
   */
  it('names the primitive and both one-line escapes in the failure', () => {
    let message = '';
    try {
      createTestRegistry().get('loseLife');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('loseLife');
    expect(message).toContain('buildRegistry()');
    expect(message).toContain("registry.register('loseLife', fn)");
    expect(message).toContain('dealDamage'); // what IS registered
  });

  /**
   * The contrast that makes the choice deliberate rather than accidental: core's
   * own registry is RIGHT to answer `undefined`, because an engine must degrade an
   * unimplemented card rather than crash a game. A fixture has the opposite duty.
   * If this ever fails, core changed its contract and this file's reasoning needs
   * rereading — not silencing.
   */
  it("does not change core's registry, which is correct to stay quiet", () => {
    expect(createEffectRegistry().get('destroyTarget')).toBeUndefined();
  });

  /** `has`/`ids` describe what is really there; only `get` refuses. */
  it('keeps has() and ids honest — an unregistered id is simply absent', () => {
    const registry = createTestRegistry();
    expect(registry.has('destroyTarget')).toBe(false);
    expect(registry.has('dealDamage')).toBe(true);
    expect([...registry.ids]).toEqual([...TEST_REGISTRY_LOCAL_IDS]);
  });

  it('accepts a body registered by the caller, and stops refusing that id', () => {
    const registry = createTestRegistry();
    let ran = false;
    registry.register('loseLife', () => {
      ran = true;
    });
    expect(() => registry.get('loseLife')).not.toThrow();
    registry.get('loseLife')?.(undefined as never);
    expect(ran).toBe(true);
  });

  it('layers real bodies underneath when a test supplies them', () => {
    const registry = createTestRegistry(buildRegistry());
    for (const { primitive } of FIXTURE_PRIMITIVES) {
      expect(registry.has(primitive), `real bodies should cover ${primitive}`).toBe(true);
      expect(() => registry.get(primitive)).not.toThrow();
    }
  });
});

describe('the fixture cannot mint a card its own registry refuses without saying so', () => {
  /**
   * Every `*Def` helper's declared primitive must be one the REAL pool implements.
   * This is the guard the `destroyDef` comment records the need for: the fixtures
   * once said `destroy`, which no card registers, so the pilot's removal tests
   * passed against a vocabulary that did not exist. A helper inventing vocabulary
   * now fails here rather than in a soak six weeks later.
   */
  it('every primitive a fixture helper mints is one the real pool implements', () => {
    const real = buildRegistry();
    for (const { helper, primitive } of FIXTURE_PRIMITIVES) {
      expect(real.has(primitive), `${helper} mints "${primitive}", which no real card registers`).toBe(true);
    }
  });

  /** The table above must describe the helpers, not a stale memory of them. */
  it('the table matches what the helpers actually declare', () => {
    for (const { helper, primitive, def } of FIXTURE_PRIMITIVES) {
      expect(def.effects?.map((e) => e.primitive), `${helper}'s declared effects`).toEqual([primitive]);
    }
  });

  /**
   * The honest statement of the gap: the fixture writes ONE body itself, and every
   * other helper needs the real bodies passed in. Somebody widening the local set
   * has to come here and add the parity case below with it.
   */
  it('writes exactly one primitive body of its own', () => {
    expect([...TEST_REGISTRY_LOCAL_IDS]).toEqual(['dealDamage']);
  });
});

// --- the divergence guard: the one copied body must behave like the real one ------

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/** A settled main phase. Fresh per case so no case can leak into another. */
function position(): GameState {
  const { state } = createGame({ seed: 7, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

/** Everything `dealDamage` is able to change, rendered as one comparable string. */
function snapshot(state: GameState): string {
  const marks = state.battlefield
    .map((c) => `${c.def.id}#${c.instanceId}:${c.damageMarked}`)
    .sort()
    .join(',');
  return `A=${state.players.A.life} B=${state.players.B.life} [${marks}]`;
}

/**
 * Resolve `dealDamage` DIRECTLY through core's `applyEffectRef`, rather than by
 * casting a spell.
 *
 * ⚠️ This is the second draft and the reason matters. The first went through
 * `applyAction`, which meant two of the copied body's branches — the `amount <= 0`
 * early return and the fizzled-target return — were never reached by any case, so
 * sabotaging either of them left this suite GREEN. A sabotage that escapes is a
 * claim about the test before it is a claim about the code; driving the primitive
 * itself reaches every branch it has.
 */
function runDealDamage(
  registry: EffectRegistry,
  amount: number,
  pickTarget: (state: GameState) => InstanceId | PlayerId | undefined,
  withCreature: boolean,
): { readonly after: string; readonly events: readonly string[] } {
  const state = position();
  const source = putOnBattlefield(state, 'A', [creatureDef('Source', 1, 1)])[0]!;
  if (withCreature) putOnBattlefield(state, 'B', [creatureDef('Bear', 2, 2)]);
  const target = pickTarget(state);
  const events: string[] = [];
  applyEffectRef(
    registry,
    { primitive: 'dealDamage', params: { amount } },
    { state, source, controller: 'A', xValue: 0, kicked: false, kickCount: 0 },
    (event) => events.push(event.type),
    target === undefined ? [] : [target],
  );
  // `applyEffectRef` emits its own `effectApplied` bookkeeping around EVERY
  // primitive it runs, including one that does nothing. That belongs to the
  // wrapper, not to the body under comparison, so it is dropped here — otherwise
  // "this branch says nothing" could never be stated.
  return { after: snapshot(state), events: events.filter((type) => type !== 'effectApplied') };
}

const BEAR = (state: GameState): InstanceId | undefined =>
  state.battlefield.find((c) => c.def.id === 'Bear')?.instanceId;

/**
 * ⚠️ THE DRY GUARD. `dealDamage` exists in two places — here and in
 * `@jonny-boi/cards` — for a package-boundary reason that is not going away, so the
 * only acceptable price is that a drift between them fails a test (universal rule
 * 3). The table covers every branch the copied body has, including the two that do
 * NOTHING: a no-op branch that stops being a no-op is exactly the drift nobody
 * notices.
 */
const DRIFT_CASES: ReadonlyArray<{
  readonly label: string;
  readonly amount: number;
  readonly target: (state: GameState) => InstanceId | PlayerId | undefined;
  readonly withCreature: boolean;
  /** True for the branches whose whole contract is "change nothing, say nothing". */
  readonly silent: boolean;
}> = [
  { label: 'damage to the face', amount: 3, target: () => 'B', withCreature: false, silent: false },
  { label: 'non-lethal damage to a creature', amount: 1, target: BEAR, withCreature: true, silent: false },
  { label: 'lethal damage to a creature', amount: 2, target: BEAR, withCreature: true, silent: false },
  { label: 'zero damage changes nothing and says nothing', amount: 0, target: BEAR, withCreature: true, silent: true },
  { label: 'negative damage changes nothing and says nothing', amount: -3, target: () => 'B', withCreature: false, silent: true },
  // The instance id of a permanent that is not on the battlefield — the shape a
  // target takes after it has already left. Both bodies must fizzle quietly.
  { label: 'a fizzled target changes nothing and says nothing', amount: 3, target: () => 9999 as InstanceId, withCreature: true, silent: true },
  { label: 'no target at all changes nothing and says nothing', amount: 3, target: () => undefined, withCreature: true, silent: true },
];

describe("the fixture's hand-written dealDamage has not drifted from the real one", () => {
  for (const { label, amount, target, withCreature, silent } of DRIFT_CASES) {
    it(label, () => {
      const copied = runDealDamage(createTestRegistry(), amount, target, withCreature);
      const real = runDealDamage(createTestRegistry(buildRegistry()), amount, target, withCreature);
      expect(copied.after, `fixture copy vs @jonny-boi/cards — ${label}`).toBe(real.after);
      if (silent) {
        // Stated on BOTH so the case cannot pass by both bodies being broken the
        // same way, and so "did nothing" is checked rather than assumed.
        expect(copied.events, `the fixture copy should stay silent — ${label}`).toEqual([]);
        expect(real.events, `the real body should stay silent — ${label}`).toEqual([]);
      } else {
        expect(copied.events.length, `the fixture copy should report — ${label}`).toBeGreaterThan(0);
      }
    });
  }

  /**
   * The copy is reached through the ENGINE too, not only through `applyEffectRef` —
   * otherwise this whole file could pass with the registry never wired into a real
   * cast, which is the wiring the §3.143 defect was about in the first place.
   */
  it('is the body a real cast actually resolves', () => {
    let state = position();
    const [spell] = giveHand(state, 'A', [burnDef('Bolt', 3)]);
    addPool(state, 'A', 'R', 1);
    const registry = createTestRegistry();
    state = applyAction(
      state,
      { kind: 'castSpell', player: 'A', instanceId: spell!.instanceId, targets: ['B'] },
      undefined,
      registry,
    ).state;
    for (const player of ['A', 'B'] as const) {
      state = applyAction(state, { kind: 'passPriority', player }, undefined, registry).state;
    }
    expect(state.players.B.life).toBe(17);
  });
});
