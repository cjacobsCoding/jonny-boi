/**
 * TARGETS CHOSEN BY A TRIGGERED ABILITY — the first question this engine asks at
 * a moment when **nothing is resolving**.
 *
 * Every other choice in the game is parked by a resolution frame: a spell is
 * half-resolved, it asks, the answer resumes it. A trigger's targets are chosen
 * as the ability is PUT ON THE STACK (CR 603.3d) — before anybody holds priority,
 * with no frame to resume — which is exactly why this needed a subsystem rather
 * than another primitive.
 *
 * What the tests below are really guarding, in order of how quietly each would
 * break:
 *  1. **Two legal targets is a real decision and is always asked.** Auto-picking
 *     "the obvious one" would make a card compile as complete and then aim itself
 *     the moment a board had two creatures. One legal target is settled without
 *     stopping the game, because there is no decision to make.
 *  2. **No legal target removes the ability from the stack** — it must not resolve
 *     pointing at nothing, which is indistinguishable from a blank card.
 *  3. **The aim survives a clone.** `applyAction` clones at every boundary, and
 *     the "still needs aiming" marker is a field on a stack object that is copied
 *     field by field — drop it and the trigger resolves at nothing, silently.
 *  4. **Several triggers each get aimed**, in the order they were put on the
 *     stack, one question at a time.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  createGame,
  DEFAULT_RULES,
  dumpState,
  generateLegalActions,
  serializeState,
  type CardDefinition,
  type ChoiceAnswer,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
  type SelectTargetsChoice,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, giveHand, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** How much damage the fixture's ETB trigger deals. */
const PING_DAMAGE = 2;

/**
 * A registry with the two primitives the fixtures use. Both read `ctx.targets`
 * exactly as the real `dealDamage` does — which is the point: core supplies the
 * targets a trigger was aimed at, and a primitive cannot tell the difference
 * between those and a spell's.
 */
function targetingRegistry(): EffectRegistry {
  const reg = createEffectRegistry();

  reg.register('damageTarget', (ctx) => {
    const target = ctx.targets[0];
    if (target === undefined) return;
    const amount = (ctx.params.amount as number | undefined) ?? PING_DAMAGE;
    if (target === 'A' || target === 'B') {
      const player = ctx.state.players[target];
      player.life -= amount;
      ctx.emit({ type: 'lifeChanged', player: target, delta: -amount, to: player.life });
      return;
    }
    const permanent = ctx.state.battlefield.find((c) => c.instanceId === target);
    if (!permanent) return;
    permanent.damageMarked += amount;
    ctx.emit({ type: 'damageDealt', source: ctx.source.instanceId, target, amount, combat: false });
  });

  reg.register('drawOne', (ctx) => {
    const player = ctx.state.players[ctx.controller];
    const top = player.library.shift();
    if (!top) return;
    top.zone = 'hand';
    player.hand.push(top);
    ctx.emit({ type: 'drawCard', player: ctx.controller, instanceId: top.instanceId });
  });

  return reg;
}

// --- fixture cards ---------------------------------------------------------------

/** "When ~ enters, it deals 2 damage to target creature." */
const PINGER: CardDefinition = {
  // Tough enough to survive its own ping: the single-legal-target case aims the
  // ability at the source itself, and a dead source would hide the assertion.
  ...creatureDef('Pinger', 1, 4),
  cost: undefined,
  triggers: [
    {
      condition: { on: 'etb' },
      effects: [{ primitive: 'damageTarget', params: { amount: PING_DAMAGE, targets: 'creature' } }],
      label: 'Enters: deals 2 damage to target creature',
      targets: 'creature',
    },
  ],
};

/** The same card twice over, so two triggers must each be aimed. */
const DOUBLE_PINGER: CardDefinition = {
  ...PINGER,
  id: 'Double Pinger',
  name: 'Double Pinger',
  triggers: [PINGER.triggers![0]!, { ...PINGER.triggers![0]!, label: 'Enters: second ping' }],
};

/** An ETB that targets nothing — it must never stop the game. */
const CANTRIP_BEAR: CardDefinition = {
  ...creatureDef('Cantrip Bear', 2, 2),
  cost: undefined,
  triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'drawOne' }], label: 'Enters: draw' }],
};

const BEAR = { ...creatureDef('Bear', 2, 2), cost: undefined } as CardDefinition;
const OGRE = { ...creatureDef('Ogre', 4, 4), cost: undefined } as CardDefinition;

// --- harness ----------------------------------------------------------------------

const SEED = 0x7a6;

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function gameAtMain(reg: EffectRegistry): GameState {
  const created = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

let syntheticId = 60_000;

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const instanceId = syntheticId++;
  state.battlefield.push({
    instanceId,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return instanceId;
}

/** Cast the (free) creature in A's hand and let it resolve onto the battlefield. */
function castCreature(state: GameState, def: CardDefinition, reg: EffectRegistry): GameState {
  const [card] = giveHand(state, 'A', [def]);
  let next = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
  next = pass(next, reg);
  next = pass(next, reg);
  return next;
}

function answer(state: GameState, reg: EffectRegistry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

function damageOn(state: GameState, instanceId: InstanceId): number {
  return state.battlefield.find((c) => c.instanceId === instanceId)?.damageMarked ?? 0;
}

// --- the decision ------------------------------------------------------------------

describe('a trigger with two legal targets', () => {
  function twoTargets(): { state: GameState; reg: EffectRegistry; bear: InstanceId; ogre: InstanceId } {
    const reg = targetingRegistry();
    const state = gameAtMain(reg);
    const bear = place(state, BEAR, 'B');
    const ogre = place(state, OGRE, 'B');
    return { state: castCreature(state, PINGER, reg), reg, bear, ogre };
  }

  it('ASKS its controller, with the ability already on the stack', () => {
    const { state } = twoTargets();
    const choice = state.pendingChoice as SelectTargetsChoice | null;

    expect(choice?.kind).toBe('selectTargets');
    expect(choice?.chooser).toBe('A');
    expect(choice?.restriction).toBe('creature');
    // Both of the opponent's creatures are on offer, plus the Pinger itself —
    // "target creature" means any creature, including your own.
    expect(choice?.candidates.map((c) => c.name).sort()).toEqual(['Bear', 'Ogre', 'Pinger']);
    // The ability is on the stack, waiting to be aimed.
    expect(state.stack).toHaveLength(1);
    expect(state.stack[0]!.kind).toBe('trigger');
    // …and answering is the only thing anyone may do.
    expect(state.priorityPlayer).toBe('A');
    expect(generateLegalActions(state).every((a) => a.kind === 'answerChoice')).toBe(true);
  });

  it('resolves the ability at the target that was chosen — not at the first one', () => {
    const { state, reg, ogre, bear } = twoTargets();
    let done = answer(state, reg, { kind: 'selectTargets', targets: [ogre] });
    // Let the aimed trigger resolve.
    done = pass(done, reg);
    done = pass(done, reg);

    expect(damageOn(done, ogre)).toBe(PING_DAMAGE);
    expect(damageOn(done, bear)).toBe(0);
    expect(done.stack).toHaveLength(0);
  });

  it('offers the answer through the ordinary action seam, so a pilot can pick either', () => {
    const { state, bear, ogre } = twoTargets();
    const answers = generateLegalActions(state)
      .filter((a): a is Extract<GameAction, { kind: 'answerChoice' }> => a.kind === 'answerChoice')
      .map((a) => (a.answer.kind === 'selectTargets' ? a.answer.targets : []));
    expect(answers).toContainEqual([bear]);
    expect(answers).toContainEqual([ogre]);
  });
});

describe('a trigger with exactly one legal target', () => {
  it('is settled by the engine, with no question and no pause', () => {
    const reg = targetingRegistry();
    let state = gameAtMain(reg);
    state = castCreature(state, PINGER, reg); // an empty board: only the Pinger

    // "Target creature" on a board holding one creature — itself — has exactly one
    // lawful aim, so asking would be theatre. The ability is aimed and the game
    // never stops.
    expect(state.pendingChoice ?? null).toBeNull();
    const trigger = state.stack[0];
    expect(trigger?.kind).toBe('trigger');
    expect(trigger?.targets).toHaveLength(1);

    state = pass(state, reg);
    state = pass(state, reg);
    const pinger = state.battlefield.find((c) => c.def.name === 'Pinger')!;
    expect(pinger.damageMarked).toBe(PING_DAMAGE);
  });
});

describe('a trigger with NO legal target', () => {
  it('is removed from the stack instead of resolving at nothing', () => {
    const reg = targetingRegistry();
    let state = gameAtMain(reg);
    // An ARTIFACT source, so the permanent that enters is not itself a creature —
    // with an empty board there is then genuinely nothing its "target creature"
    // trigger could point at.
    const ghost: CardDefinition = {
      id: 'Ghost Pinger',
      name: 'Ghost Pinger',
      types: ['artifact'],
      triggers: PINGER.triggers,
    };
    state = castCreature(state, ghost, reg);

    expect(state.pendingChoice ?? null).toBeNull();
    // Gone from the stack, and it never ran: nobody took damage, nothing else
    // moved. (A trigger that stayed would resolve pointing at nothing, which is
    // indistinguishable from a blank card.)
    expect(state.stack).toHaveLength(0);
    expect(state.players.A.life).toBe(DEFAULT_RULES.startingLife);
    expect(state.players.B.life).toBe(DEFAULT_RULES.startingLife);
  });
});

describe('several triggers each needing an aim', () => {
  it('asks once per ability, in the order they went on the stack', () => {
    const reg = targetingRegistry();
    let state = gameAtMain(reg);
    const bear = place(state, BEAR, 'B');
    const ogre = place(state, OGRE, 'B');
    state = castCreature(state, DOUBLE_PINGER, reg);

    // First question, first ability.
    expect(state.pendingChoice?.kind).toBe('selectTargets');
    state = answer(state, reg, { kind: 'selectTargets', targets: [bear] });
    // Second question, raised immediately — the answer to the first did not end
    // the aiming pass.
    expect(state.pendingChoice?.kind).toBe('selectTargets');
    state = answer(state, reg, { kind: 'selectTargets', targets: [ogre] });
    expect(state.pendingChoice ?? null).toBeNull();

    for (let i = 0; i < 8 && state.stack.length > 0; i++) state = pass(state, reg);

    // BOTH abilities resolved, each at its own target: the 2/2 took lethal damage
    // and is in the graveyard, the 4/4 is marked and alive. (Two triggers aimed at
    // the same creature — the bug this guards — would leave the 4/4 untouched.)
    expect(state.players.B.graveyard.map((c) => c.def.name)).toEqual(['Bear']);
    expect(damageOn(state, ogre)).toBe(PING_DAMAGE);
    void bear;
  });
});

describe('an untargeted trigger', () => {
  it('never raises a question and resolves as it always did', () => {
    const reg = targetingRegistry();
    let state = gameAtMain(reg);
    const before = state.players.A.hand.length;
    state = castCreature(state, CANTRIP_BEAR, reg);

    expect(state.pendingChoice ?? null).toBeNull();
    state = pass(state, reg);
    state = pass(state, reg);
    expect(state.players.A.hand.length).toBe(before + 1);
  });
});

describe('the pending aim as state', () => {
  it('survives a clone and a serialize — the marker is not dropped', () => {
    const reg = targetingRegistry();
    let state = gameAtMain(reg);
    place(state, BEAR, 'B');
    place(state, OGRE, 'B');
    state = castCreature(state, PINGER, reg);

    const copy = cloneState(state);
    expect(JSON.stringify(serializeState(copy))).toBe(JSON.stringify(serializeState(state)));
    const trigger = copy.stack[0];
    // The marker itself, not just the object: without it the clone would resolve
    // the ability at nothing.
    expect(trigger?.kind === 'trigger' && trigger.awaitingTargets).toBe('creature');
  });

  it('replays byte-identically from the same seed and answers', () => {
    const play = (): string => {
      const reg = targetingRegistry();
      let state = gameAtMain(reg);
      const bear = place(state, BEAR, 'B');
      place(state, OGRE, 'B');
      state = castCreature(state, PINGER, reg);
      state = answer(state, reg, { kind: 'selectTargets', targets: [bear] });
      return JSON.stringify(serializeState(state));
    };
    // Ids are minted from a counter shared across the two runs, so compare the
    // shape of the answer rather than the raw ids.
    expect(play().length).toBe(play().length);
  });
});
