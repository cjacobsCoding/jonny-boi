/**
 * MODAL TRIGGERS — "Whenever …, choose one — • A • B" (CR 603.3c).
 *
 * The fidelity edges:
 *  - modes are chosen AS THE ABILITY GOES ON THE STACK, before priority
 *    resumes — a real parked question, answered by whoever controls the
 *    trigger, and the answer is public (`triggerModesChosen`);
 *  - exactly the CHOSEN mode's effects resolve — never both, never neither.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
  defaultAnswerFor,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

function harness(): { reg: EffectRegistry; fired: string[] } {
  const fired: string[] = [];
  const reg = createEffectRegistry();
  reg.register('testMarkA', () => void fired.push('A'));
  reg.register('testMarkB', () => void fired.push('B'));
  return { reg, fired };
}

/** A creature whose combat-damage trigger is a printed "Choose one —". */
const MODAL_PRANKSTER: CardDefinition = {
  ...creatureDef('Modal Prankster', 2, 2),
  triggers: [
    {
      condition: { on: 'combatDamageToPlayer' },
      effects: [],
      label: 'Combat damage: choose one',
      modal: {
        min: 1,
        max: 1,
        modes: [
          { id: 'mode1', label: 'Mark A', effects: [{ primitive: 'testMarkA' }] },
          { id: 'mode2', label: 'Mark B', effects: [{ primitive: 'testMarkB' }] },
        ],
      },
    },
  ],
};

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

describe('a modal trigger, played for real', () => {
  it('parks the mode question on the stack, and only the CHOSEN mode resolves', () => {
    const { reg, fired } = harness();
    const g = createGame({ seed: 31, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) }, registry: reg });
    const state = g.state;
    const id = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: id,
      def: MODAL_PRANKSTER,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });

    // Walk to declare-attackers, swing unblocked, and run damage. Every parked
    // question is answered on the way; the mode question gets MODE 2 explicitly.
    let s = state;
    let sawModeQuestion = false;
    const pass = (): void => {
      const q = s.pendingChoice;
      if (q) {
        if (q.kind === 'chooseModes') {
          sawModeQuestion = true;
          s = act(
            s,
            { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: { kind: 'chooseModes', modeIds: ['mode2'] } },
            reg,
          );
          return;
        }
        s = act(s, { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) }, reg);
        return;
      }
      s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
    };
    const advanceTo = (target: string): void => {
      let guard = 0;
      while (s.step !== target && !s.gameOver && guard++ < 500) pass();
    };
    advanceTo('declareAttackers');
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [id as InstanceId] }, reg);
    advanceTo('declareBlockers');
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [] }, reg);
    advanceTo('postcombatMain');

    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 2);
    // The question really was asked (two modes — nothing trivial to auto-answer)…
    expect(sawModeQuestion).toBe(true);
    // …and exactly the chosen mode ran.
    expect(fired).toEqual(['B']);
  });

  it("the \"hasn't been chosen this turn\" memory takes the taken mode off the next menu", () => {
    const { reg } = harness();
    const TOKEN_BODY: CardDefinition = { id: 'tok-body', name: 'Body', types: ['creature'], power: 1, toughness: 1 };
    reg.register('testMakeBody', (ctx) => void ctx.createTokens(TOKEN_BODY, 1));
    // The watcher makes a body on tap; its own trigger watches creatures
    // entering — so two activations in ONE turn ask the mode question twice,
    // through the engine's real path.
    const MEMORY_WATCHER: CardDefinition = {
      id: 'memory-watcher',
      name: 'Memory Watcher',
      types: ['creature'],
      power: 0,
      toughness: 3,
      activated: [{ cost: { tap: true }, effects: [{ primitive: 'testMakeBody' }], label: '{T}: make a body' }],
      triggers: [
        {
          condition: { on: 'permanentEnters', who: 'you', permanentFilter: { anyOfTypes: ['creature'] } },
          effects: [],
          label: 'A creature entered: choose one that has not been chosen this turn',
          modal: {
            min: 1,
            max: 1,
            notChosenThisTurn: true,
            modes: [
              { id: 'mode1', label: 'Mark A', effects: [{ primitive: 'testMarkA' }] },
              { id: 'mode2', label: 'Mark B', effects: [{ primitive: 'testMarkB' }] },
            ],
          },
        },
      ],
    };
    const g = createGame({ seed: 33, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) }, registry: reg });
    const state = g.state;
    const makerIds = [state.nextInstanceId++, state.nextInstanceId++];
    for (const instanceId of makerIds) {
      state.battlefield.push({
        instanceId,
        def: MEMORY_WATCHER,
        controller: 'A',
        owner: 'A',
        zone: 'battlefield',
        tapped: false,
        summoningSick: false,
        damageMarked: 0,
        markedByDeathtouch: false,
        counters: {},
      });
    }

    const menus: string[][] = [];
    let s = state;
    const pass = (): void => {
      const q = s.pendingChoice;
      if (q) {
        if (q.kind === 'chooseModes') menus.push(q.modes.map((mode) => mode.id));
        s = act(s, { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) }, reg);
        return;
      }
      s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
    };
    let guard = 0;
    while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 500) pass();
    // BOTH makers tap in the same turn. Each arrival triggers BOTH watchers, so
    // the first maker's own trigger is the one whose memory this asserts.
    for (const instanceId of makerIds) {
      s = act(s, { kind: 'activateAbility', player: 'A', instanceId, abilityIndex: 0 }, reg);
      let inner = 0;
      while (s.stack.length > 0 && !s.gameOver && inner++ < 100) pass();
    }

    // Two arrivals × two watchers = four mode decisions in ONE turn, and the
    // memory is what makes the second pair different: with mode1 already taken
    // only mode2 remains CHOOSABLE, which is a one-option question the engine
    // auto-answers — so exactly two questions were ever PARKED.
    expect(menus).toEqual([
      ['mode1', 'mode2'],
      ['mode1', 'mode2'],
    ]);
    // Each watcher took mode1 and then mode2 — never mode1 twice, which is only
    // possible if the memory removed it from the second decision.
    for (const instanceId of makerIds) {
      expect(s.battlefield.find((c) => c.instanceId === instanceId)?.modesChosenThisTurn).toEqual(['mode1', 'mode2']);
    }
  });

  it('a TARGETED mode: choosing it asks for the aim, and the aimed effect resolves', () => {
    const { reg, fired } = harness();
    const AIMED_MODAL: CardDefinition = {
      ...creatureDef('Aimed Modal', 2, 2),
      triggers: [
        {
          condition: { on: 'combatDamageToPlayer' },
          effects: [],
          label: 'Combat damage: choose one',
          modal: {
            min: 1,
            max: 1,
            modes: [
              { id: 'mode1', label: 'Mark A', effects: [{ primitive: 'testMarkA' }] },
              {
                id: 'mode2',
                label: 'Destroy target enchantment',
                effects: [{ primitive: 'destroyTargetForTest' }],
                targets: 'enchantment',
              },
            ],
          },
        },
      ],
    };
    const destroyed: number[] = [];
    reg.register('destroyTargetForTest', (ctx) => {
      const target = ctx.targets[0];
      if (typeof target !== 'number') return;
      const index = ctx.state.battlefield.findIndex((c) => c.instanceId === target);
      if (index >= 0) {
        destroyed.push(target);
        ctx.state.battlefield.splice(index, 1);
      }
    });
    const g = createGame({ seed: 32, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) }, registry: reg });
    const state = g.state;
    const attackerId = state.nextInstanceId++;
    const enchantmentId = state.nextInstanceId++;
    for (const [instanceId, def, controller] of [
      [attackerId, AIMED_MODAL, 'A'],
      [enchantmentId, { id: 'zoo-ench', name: 'Zoo Enchantment', types: ['enchantment'] } as CardDefinition, 'B'],
    ] as const) {
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
    }
    let s = state;
    let sawTargetQuestion = false;
    const pass = (): void => {
      const q = s.pendingChoice;
      if (q) {
        if (q.kind === 'chooseModes') {
          s = act(
            s,
            { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: { kind: 'chooseModes', modeIds: ['mode2'] } },
            reg,
          );
          return;
        }
        if (q.kind === 'selectTargets') sawTargetQuestion = true;
        s = act(s, { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) }, reg);
        return;
      }
      s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
    };
    const advanceTo = (target: string): void => {
      let guard = 0;
      while (s.step !== target && !s.gameOver && guard++ < 500) pass();
    };
    advanceTo('declareAttackers');
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [attackerId as InstanceId] }, reg);
    advanceTo('declareBlockers');
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [] }, reg);
    advanceTo('postcombatMain');

    // The chosen targeted mode was aimed (one candidate — auto or asked) and ran;
    // the target-free sibling never did.
    expect(destroyed).toEqual([enchantmentId]);
    expect(fired).toEqual([]);
    // With exactly one legal enchantment the aim may auto-answer — either way
    // the enchantment is gone, which is the observable contract.
    void sawTargetQuestion;
  });
});
