/**
 * Transforming double-faced cards — the core face-swap seam (CR 701.28, 712).
 *
 * What these tests pin, and why each matters:
 *  - the swap routes EVERY characteristic read through the active face (name,
 *    types, P/T, keywords, triggers) because `inst.def` IS the active face;
 *  - transforming is NOT a zone change: counters, damage, tapped state,
 *    attachments and continuous effects persist, and no `zoneChange` is emitted
 *    (so no ETB trigger can fire off a transform);
 *  - a permanent that LEAVES the battlefield turns front-face-up again
 *    (CR 712.8a) — a bounced/killed DFC is its printed front everywhere else;
 *  - the transformed state SURVIVES the action-boundary clone (`applyAction`
 *    clones every instance; a dropped `printedDef`/`def` pair would silently
 *    untransform or freeze the permanent one action later);
 *  - a back face can never be cast or played (CR 712.8b);
 *  - the trigger collector tracks the ACTIVE face even mid-action: a permanent
 *    that transforms away from a triggerful face stops triggering, and one that
 *    transforms onto a triggerful face starts.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameEvent, GameState, InstanceId, PlayerId } from './index.js';
import {
  applyAction,
  createEffectRegistry,
  createGame,
  DEFAULT_RULES,
  faceUpOf,
  generateLegalActions,
  transformPermanent,
  transformTargetOf,
} from './index.js';
import type { CardInstance } from './state.js';
import { deckOf, giveHand, landDef } from './test-fixtures.js';

const SEED = 20260817;

/** The back face used across these tests: a bigger flyer, no triggers. */
const BACK_FACE: CardDefinition = {
  id: 'dfc-test#back',
  name: 'Test Aberration',
  isBackFace: true,
  types: ['creature'],
  power: 3,
  toughness: 2,
  keywords: { flying: true },
};

/** The front face: a vanilla 1/1 whose card transforms into {@link BACK_FACE}. */
const FRONT_FACE: CardDefinition = {
  id: 'dfc-test',
  name: 'Test Delver',
  types: ['creature'],
  cost: { U: 1 },
  power: 1,
  toughness: 1,
  backFace: BACK_FACE,
};

/** A game parked in A's main phase with empty hands and a permissive pool. */
function mainPhase(registry = createEffectRegistry()): { state: GameState; registry: typeof registry } {
  const land = landDef('Plains', 'W');
  const { state } = createGame({
    seed: SEED,
    decks: { A: deckOf(land, 30), B: deckOf(land, 30) },
    registry,
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return { state, registry };
}

/** Put a fresh permanent of `def` onto the battlefield under `controller`. */
function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
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
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

function onBattlefield(state: GameState, id: InstanceId): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

describe('transformPermanent — the face swap itself', () => {
  it('swaps every characteristic to the back face and says so in the log', () => {
    const { state } = mainPhase();
    const perm = place(state, FRONT_FACE, 'A');
    const events: GameEvent[] = [];

    expect(transformPermanent(state, perm.instanceId, (e) => events.push(e))).toBe(true);

    expect(perm.def.name).toBe('Test Aberration');
    expect(perm.def.power).toBe(3);
    expect(perm.def.toughness).toBe(2);
    expect(perm.def.keywords?.flying).toBe(true);
    expect(faceUpOf(perm)).toBe('back');
    expect(perm.printedDef).toBe(FRONT_FACE);
    expect(events).toEqual([
      {
        type: 'transformed',
        instanceId: perm.instanceId,
        fromName: 'Test Delver',
        toName: 'Test Aberration',
        faceUp: 'back',
      },
    ]);
    // CR 712.8: NOT a zone change — nothing an ETB/leaves trigger could see.
    expect(events.some((e) => e.type === 'zoneChange')).toBe(false);
  });

  it('transforms back to the front face (a werewolf turning back)', () => {
    const { state } = mainPhase();
    const perm = place(state, FRONT_FACE, 'A');
    const events: GameEvent[] = [];
    transformPermanent(state, perm.instanceId, (e) => events.push(e));

    expect(transformPermanent(state, perm.instanceId, (e) => events.push(e))).toBe(true);
    expect(perm.def).toBe(FRONT_FACE);
    expect(perm.printedDef).toBeNull();
    expect(faceUpOf(perm)).toBe('front');
  });

  it('does nothing to a permanent that is not a transforming DFC (CR 701.28.2)', () => {
    const { state } = mainPhase();
    const vanilla = place(state, { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 }, 'A');
    const events: GameEvent[] = [];
    expect(transformPermanent(state, vanilla.instanceId, (e) => events.push(e))).toBe(false);
    expect(events).toHaveLength(0);
    expect(vanilla.def.name).toBe('Bear');
  });

  it('does nothing when the permanent is not on the battlefield', () => {
    const { state } = mainPhase();
    const [inHand] = giveHand(state, 'A', [FRONT_FACE]);
    const events: GameEvent[] = [];
    expect(transformPermanent(state, inHand!.instanceId, (e) => events.push(e))).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('transformTargetOf names the other face from either side', () => {
    const { state } = mainPhase();
    const perm = place(state, FRONT_FACE, 'A');
    expect(transformTargetOf(perm)).toBe(BACK_FACE);
    transformPermanent(state, perm.instanceId, () => {});
    expect(transformTargetOf(perm)).toBe(FRONT_FACE);
  });
});

describe('CR 712 — transforming is not a zone change', () => {
  it('counters, damage, tapped state and attachments all persist across the swap', () => {
    const { state } = mainPhase();
    const perm = place(state, FRONT_FACE, 'A');
    const aura = place(
      state,
      {
        id: 'test-aura',
        name: 'Test Aura',
        types: ['enchantment'],
        attachment: { attachesTo: { anyOfTypes: ['creature'] }, whenIllegal: 'destroy', label: 'Enchant creature' },
      },
      'A',
    );
    aura.attachedTo = perm.instanceId;
    perm.counters = { '+1/+1': 2 };
    perm.damageMarked = 1;
    perm.tapped = true;
    perm.summoningSick = true;
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: perm.instanceId,
      sourceInstanceId: perm.instanceId,
      duration: 'endOfTurn',
      power: 2,
      toughness: 2,
    });

    transformPermanent(state, perm.instanceId, () => {});

    expect(perm.counters).toEqual({ '+1/+1': 2 });
    expect(perm.damageMarked).toBe(1);
    expect(perm.tapped).toBe(true);
    expect(perm.summoningSick).toBe(true);
    expect(aura.attachedTo).toBe(perm.instanceId);
    expect(state.continuous.some((c) => c.targetInstanceId === perm.instanceId)).toBe(true);
  });

  it('a transformed permanent that DIES goes to the graveyard front-face-up (CR 712.8a)', () => {
    const registry = createEffectRegistry();
    registry.register('zap', (ctx) => {
      const victim = ctx.state.battlefield.find((c) => c.instanceId === (ctx.params.victim as InstanceId));
      if (victim) victim.damageMarked = 99;
    });
    const { state } = mainPhase(registry);
    const perm = place(state, FRONT_FACE, 'A');
    transformPermanent(state, perm.instanceId, () => {});
    // Kill it through a real resolution, so the ordinary SBA sweep runs.
    const [spell] = giveHand(state, 'A', [
      {
        id: 'zap-spell',
        name: 'Zap',
        types: ['sorcery'],
        cost: { generic: 1 },
        effects: [{ primitive: 'zap', params: { victim: perm.instanceId } }],
      },
    ]);
    let after = applyAction(
      state,
      { kind: 'castSpell', player: 'A', instanceId: spell!.instanceId, targets: [] },
      DEFAULT_RULES,
      registry,
    );
    let guard = 0;
    while (after.state.stack.length > 0 && guard++ < 10) {
      after = applyAction(after.state, { kind: 'passPriority', player: after.state.priorityPlayer }, DEFAULT_RULES, registry);
    }

    const grave = after.state.players.A.graveyard.find((c) => c.instanceId === perm.instanceId);
    expect(grave).toBeDefined();
    expect(grave!.def).toBe(FRONT_FACE);
    expect(grave!.printedDef ?? null).toBeNull();
  });

  it('the transformed state survives the applyAction clone boundary', () => {
    const { state, registry } = mainPhase();
    const perm = place(state, FRONT_FACE, 'A');
    transformPermanent(state, perm.instanceId, () => {});

    // Two boundaries, because the first clone's OUTPUT is the second's input —
    // this is what catches a clone that drops `printedDef` (untransforming the
    // card) or re-derives `def` (freezing it).
    let s = applyAction(state, { kind: 'passPriority', player: 'A' }, DEFAULT_RULES, registry).state;
    s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, registry).state;

    const cloned = onBattlefield(s, perm.instanceId);
    expect(cloned).toBeDefined();
    expect(cloned!.def).toBe(BACK_FACE);
    expect(cloned!.printedDef).toBe(FRONT_FACE);
  });
});

describe('CR 712.8b — a back face can never be cast or played', () => {
  it('is not offered and is rejected if forced', () => {
    const { state, registry } = mainPhase();
    const [backInHand] = giveHand(state, 'A', [BACK_FACE]);

    const offers = generateLegalActions(state, DEFAULT_RULES).filter(
      (a) => (a.kind === 'castSpell' || a.kind === 'playLand') && a.instanceId === backInHand!.instanceId,
    );
    expect(offers).toHaveLength(0);

    const forced = applyAction(
      state,
      { kind: 'castSpell', player: 'A', instanceId: backInHand!.instanceId, targets: [] },
      DEFAULT_RULES,
      registry,
    );
    expect(forced.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });

  it('a back-face LAND cannot be played from hand either', () => {
    const { state, registry } = mainPhase();
    const backLand: CardDefinition = { id: 'mdfc#back', name: 'Back Land', isBackFace: true, types: ['land'], produces: ['U'] };
    const [inHand] = giveHand(state, 'A', [backLand]);
    const forced = applyAction(
      state,
      { kind: 'playLand', player: 'A', instanceId: inHand!.instanceId },
      DEFAULT_RULES,
      registry,
    );
    expect(forced.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });
});

describe('the trigger collector follows the ACTIVE face', () => {
  /** Front face with a dies-trigger; the back face is triggerless. */
  const FRONT_WITH_DIES: CardDefinition = {
    id: 'dfc-dies',
    name: 'Doomed Front',
    types: ['creature'],
    power: 1,
    toughness: 1,
    triggers: [{ condition: { on: 'dies' }, effects: [{ primitive: 'markDied' }], label: 'front dies trigger' }],
    backFace: { id: 'dfc-dies#back', name: 'Quiet Back', isBackFace: true, types: ['creature'], power: 3, toughness: 2 },
  };

  /** Front is triggerless; the BACK face carries the dies-trigger. */
  const FRONT_QUIET: CardDefinition = {
    id: 'dfc-quiet',
    name: 'Quiet Front',
    types: ['creature'],
    power: 1,
    toughness: 1,
    backFace: {
      id: 'dfc-quiet#back',
      name: 'Loud Back',
      isBackFace: true,
      types: ['creature'],
      power: 3,
      toughness: 2,
      triggers: [{ condition: { on: 'dies' }, effects: [{ primitive: 'markDied' }], label: 'back dies trigger' }],
    },
  };

  /**
   * A spell that transforms its target-by-param permanent and then deals it
   * lethal damage IN THE SAME RESOLUTION — so the same action's collector must
   * re-read the (swapped) active face when the death event lands. This is the
   * shape CR 603.10's last-known-information rules care about: the face the
   * permanent showed WHEN IT DIED is the one whose triggers apply.
   */
  function castTransformThenKill(variant: 'frontTrigger' | 'backTrigger'): {
    events: GameEvent[];
    stackLabels: string[];
  } {
    const registry = createEffectRegistry();
    registry.register('xform', (ctx) => {
      transformPermanent(ctx.state, ctx.params.victim as InstanceId, ctx.emit);
    });
    registry.register('zap', (ctx) => {
      const victim = ctx.state.battlefield.find((c) => c.instanceId === (ctx.params.victim as InstanceId));
      if (victim) victim.damageMarked = 99;
    });
    registry.register('markDied', () => {});

    const { state } = mainPhase(registry);
    // Rebuild the permanent under test inside THIS state (ids must line up).
    const def = variant === 'frontTrigger' ? FRONT_WITH_DIES : FRONT_QUIET;
    const perm = place(state, def, 'A');
    const [spell] = giveHand(state, 'A', [
      {
        id: 'xform-zap',
        name: 'Transform Then Zap',
        types: ['sorcery'],
        cost: { generic: 1 },
        effects: [
          { primitive: 'xform', params: { victim: perm.instanceId } },
          { primitive: 'zap', params: { victim: perm.instanceId } },
        ],
      },
    ]);

    let s = state;
    const events: GameEvent[] = [];
    const drive = (action: Parameters<typeof applyAction>[1]): void => {
      const result = applyAction(s, action, DEFAULT_RULES, registry);
      events.push(...result.events);
      s = result.state;
    };
    drive({ kind: 'castSpell', player: 'A', instanceId: spell!.instanceId, targets: [] });
    let guard = 0;
    while (s.stack.length > 0 && !s.gameOver && guard++ < 20) {
      drive({ kind: 'passPriority', player: s.priorityPlayer });
    }
    return {
      events,
      stackLabels: events.filter((e) => e.type === 'triggerPutOnStack').map((e) => e.label),
    };
  }

  it('a front-face trigger does NOT fire once the permanent has transformed away from it', () => {
    const { events, stackLabels } = castTransformThenKill('frontTrigger');
    expect(events.some((e) => e.type === 'transformed')).toBe(true);
    expect(events.some((e) => e.type === 'creatureDied')).toBe(true);
    expect(stackLabels).not.toContain('front dies trigger');
  });

  it('a BACK-face trigger fires after transforming onto it, in the same action', () => {
    const { events, stackLabels } = castTransformThenKill('backTrigger');
    expect(events.some((e) => e.type === 'transformed')).toBe(true);
    expect(events.some((e) => e.type === 'creatureDied')).toBe(true);
    expect(stackLabels).toContain('back dies trigger');
  });
});
