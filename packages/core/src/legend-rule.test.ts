/**
 * The legend rule (CR 704.5j), as ONE state-based action shared by every
 * legendary permanent kind.
 *
 * What is being pinned, and why each one is a way the rule is usually got wrong:
 *   - it applies PER PLAYER, not globally — each player may control their own
 *     copy of the same legend and nothing happens;
 *   - it is the CONTROLLER's choice which copy survives, so the rule parks a
 *     question instead of deciding (every other SBA decides by itself);
 *   - the losers go to their OWNERS' graveyards, not the chooser's;
 *   - it is SHARED: legendary creatures and legendary planeswalkers go through
 *     the same code, so neither can be right while the other is wrong;
 *   - it CASCADES — answering re-runs the state-based actions, so a second
 *     duplicated name settles without anyone getting priority in between.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  LOYALTY_COUNTER,
  type CardDefinition,
  type GameAction,
  type GameState,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';
import type { CardInstance, InstanceId, PlayerId } from './state.js';

const ISLAND = landDef('Island', 'U');
const registry = createEffectRegistry();

function legendaryCreature(name: string, power = 2, toughness = 2): CardDefinition {
  return { id: name, name, types: ['creature'], legendary: true, power, toughness };
}

function legendaryWalker(name: string): CardDefinition {
  return { id: name, name, types: ['planeswalker'], legendary: true, loyalty: 3 };
}

function plainCreature(name: string): CardDefinition {
  return { id: name, name, types: ['creature'], power: 2, toughness: 2 };
}

function lib(): ReturnType<typeof deckOf> {
  return deckOf(ISLAND, 40);
}

function act(state: GameState, action: GameAction): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

function pass(state: GameState): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer });
}

function advanceToStep(state: GameState, target: string, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== target && !s.gameOver && guard++ < max && !s.pendingChoice) s = pass(s);
  return s;
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
    counters: def.loyalty !== undefined ? { [LOYALTY_COUNTER]: def.loyalty } : {},
  };
  state.battlefield.push(inst);
  return inst.instanceId;
}

/** Drive the game far enough for the state-based actions to run. */
function settle(state: GameState): GameState {
  return advanceToStep(state, 'precombatMain');
}

function onBattlefield(state: GameState, id: InstanceId): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

function inGraveyard(state: GameState, owner: PlayerId, id: InstanceId): boolean {
  return state.players[owner].graveyard.some((c) => c.instanceId === id);
}

describe('when the rule does NOT apply', () => {
  it('one copy each under DIFFERENT players is entirely legal', () => {
    // The per-player half. A global check would bury one of these, and the game
    // would be visibly wrong in a way no rules text supports.
    const { state } = createGame({ seed: 1, decks: { A: lib(), B: lib() }, registry });
    const mine = put(state, legendaryCreature('Sole Legend'), 'A');
    const theirs = put(state, legendaryCreature('Sole Legend'), 'B');
    const s = settle(state);
    expect(s.pendingChoice).toBeFalsy();
    expect(onBattlefield(s, mine)).toBeDefined();
    expect(onBattlefield(s, theirs)).toBeDefined();
  });

  it('two DIFFERENTLY-named legends under one player are legal', () => {
    const { state } = createGame({ seed: 2, decks: { A: lib(), B: lib() }, registry });
    const one = put(state, legendaryCreature('Legend One'), 'A');
    const two = put(state, legendaryCreature('Legend Two'), 'A');
    const s = settle(state);
    expect(s.pendingChoice).toBeFalsy();
    expect(onBattlefield(s, one)).toBeDefined();
    expect(onBattlefield(s, two)).toBeDefined();
  });

  it('two same-named NONlegendary permanents are legal', () => {
    // The flag is what the rule keys on — not the name alone.
    const { state } = createGame({ seed: 3, decks: { A: lib(), B: lib() }, registry });
    const one = put(state, plainCreature('Grizzly Bears'), 'A');
    const two = put(state, plainCreature('Grizzly Bears'), 'A');
    const s = settle(state);
    expect(s.pendingChoice).toBeFalsy();
    expect(onBattlefield(s, one)).toBeDefined();
    expect(onBattlefield(s, two)).toBeDefined();
  });
});

describe('when it applies', () => {
  it('the CONTROLLER is asked which copy to keep, and only they may answer', () => {
    const { state } = createGame({ seed: 4, decks: { A: lib(), B: lib() }, registry });
    const first = put(state, legendaryCreature('Doubled Legend'), 'A');
    const second = put(state, legendaryCreature('Doubled Legend'), 'A');
    const s = settle(state);

    expect(s.pendingChoice).toBeTruthy();
    expect(s.pendingChoice!.chooser).toBe('A');
    expect(s.pendingChoice!.kind).toBe('selectCards');
    expect(s.pendingChoice!.prompt).toMatch(/Doubled Legend/);
    // Exactly one is kept, chosen from exactly the two copies.
    expect(s.pendingChoice!.min).toBe(1);
    expect(s.pendingChoice!.max).toBe(1);

    // The game cannot proceed past the question: the ONLY legal actions are the
    // chooser answering it.
    const actions = generateLegalActions(s, DEFAULT_RULES);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.kind === 'answerChoice' && a.player === 'A')).toBe(true);
    void first;
    void second;
  });

  it('the kept copy stays and the rest go to their owners graveyards', () => {
    const { state } = createGame({ seed: 5, decks: { A: lib(), B: lib() }, registry });
    const keep = put(state, legendaryCreature('Doubled Legend'), 'A');
    const lose = put(state, legendaryCreature('Doubled Legend'), 'A');
    let s = settle(state);
    s = act(s, {
      kind: 'answerChoice',
      player: 'A',
      choiceId: s.pendingChoice!.id,
      answer: { kind: 'selectCards', instanceIds: [keep] },
    });
    expect(s.pendingChoice).toBeFalsy();
    expect(onBattlefield(s, keep)).toBeDefined();
    expect(onBattlefield(s, lose)).toBeUndefined();
    expect(inGraveyard(s, 'A', lose)).toBe(true);
  });

  it('a loser goes to ITS OWNER graveyard, not the chooser', () => {
    // A controls both copies but B OWNS one of them — a stolen legend goes home.
    const { state } = createGame({ seed: 6, decks: { A: lib(), B: lib() }, registry });
    const keep = put(state, legendaryCreature('Doubled Legend'), 'A');
    const stolen = put(state, legendaryCreature('Doubled Legend'), 'A');
    // Re-own the second copy to B while leaving A in control of it.
    const stolenInst = onBattlefield(state, stolen)!;
    stolenInst.owner = 'B';
    let s = settle(state);
    s = act(s, {
      kind: 'answerChoice',
      player: 'A',
      choiceId: s.pendingChoice!.id,
      answer: { kind: 'selectCards', instanceIds: [keep] },
    });
    expect(inGraveyard(s, 'B', stolen)).toBe(true);
    expect(inGraveyard(s, 'A', stolen)).toBe(false);
  });

  it('it applies to legendary PLANESWALKERS by the same shared rule', () => {
    // The whole point of one implementation: walkers are not a special case.
    const { state } = createGame({ seed: 7, decks: { A: lib(), B: lib() }, registry });
    const keep = put(state, legendaryWalker('Doubled Walker'), 'A');
    const lose = put(state, legendaryWalker('Doubled Walker'), 'A');
    let s = settle(state);
    expect(s.pendingChoice).toBeTruthy();
    s = act(s, {
      kind: 'answerChoice',
      player: 'A',
      choiceId: s.pendingChoice!.id,
      answer: { kind: 'selectCards', instanceIds: [keep] },
    });
    expect(onBattlefield(s, keep)).toBeDefined();
    expect(inGraveyard(s, 'A', lose)).toBe(true);
  });

  it('a legendary creature dying to the rule emits creatureDied, so dies-triggers see it', () => {
    const { state } = createGame({ seed: 8, decks: { A: lib(), B: lib() }, registry });
    const keep = put(state, legendaryCreature('Doubled Legend'), 'A');
    put(state, legendaryCreature('Doubled Legend'), 'A');
    const s = settle(state);
    const result = applyAction(
      s,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: s.pendingChoice!.id,
        answer: { kind: 'selectCards', instanceIds: [keep] },
      },
      DEFAULT_RULES,
      registry,
    );
    expect(result.events.some((e) => e.type === 'creatureDied')).toBe(true);
    expect(result.events.some((e) => e.type === 'legendRuleApplied')).toBe(true);
  });

  it('THREE copies leave exactly one', () => {
    const { state } = createGame({ seed: 9, decks: { A: lib(), B: lib() }, registry });
    const keep = put(state, legendaryCreature('Tripled Legend'), 'A');
    const a = put(state, legendaryCreature('Tripled Legend'), 'A');
    const b = put(state, legendaryCreature('Tripled Legend'), 'A');
    let s = settle(state);
    s = act(s, {
      kind: 'answerChoice',
      player: 'A',
      choiceId: s.pendingChoice!.id,
      answer: { kind: 'selectCards', instanceIds: [keep] },
    });
    expect(s.pendingChoice).toBeFalsy();
    expect(onBattlefield(s, keep)).toBeDefined();
    expect(inGraveyard(s, 'A', a)).toBe(true);
    expect(inGraveyard(s, 'A', b)).toBe(true);
  });

  it('TWO duplicated names cascade: answering the first raises the second', () => {
    // The cascade is what makes "check it once at the end of the pass" safe. If
    // answering did not re-run the state-based actions, the second duplicated
    // name would sit there illegally until something else happened to trigger a
    // check — a board that is quietly wrong, which is the worst kind.
    const { state } = createGame({ seed: 10, decks: { A: lib(), B: lib() }, registry });
    const keepOne = put(state, legendaryCreature('Legend Alpha'), 'A');
    const loseOne = put(state, legendaryCreature('Legend Alpha'), 'A');
    const keepTwo = put(state, legendaryCreature('Legend Beta'), 'A');
    const loseTwo = put(state, legendaryCreature('Legend Beta'), 'A');

    let s = settle(state);
    expect(s.pendingChoice).toBeTruthy();
    // First question — whichever name came first in battlefield order.
    const firstPrompt = s.pendingChoice!.prompt;
    const firstKeep = firstPrompt.includes('Alpha') ? keepOne : keepTwo;
    s = act(s, {
      kind: 'answerChoice',
      player: 'A',
      choiceId: s.pendingChoice!.id,
      answer: { kind: 'selectCards', instanceIds: [firstKeep] },
    });

    // The SECOND question was raised by the re-check, with nobody having had
    // priority in between.
    expect(s.pendingChoice).toBeTruthy();
    expect(s.pendingChoice!.prompt).not.toBe(firstPrompt);
    const secondKeep = s.pendingChoice!.prompt.includes('Alpha') ? keepOne : keepTwo;
    s = act(s, {
      kind: 'answerChoice',
      player: 'A',
      choiceId: s.pendingChoice!.id,
      answer: { kind: 'selectCards', instanceIds: [secondKeep] },
    });

    expect(s.pendingChoice).toBeFalsy();
    expect(onBattlefield(s, keepOne)).toBeDefined();
    expect(onBattlefield(s, keepTwo)).toBeDefined();
    expect(inGraveyard(s, 'A', loseOne)).toBe(true);
    expect(inGraveyard(s, 'A', loseTwo)).toBe(true);
  });

  it('BOTH players duplicating settle one after the other, each choosing their own', () => {
    // Per-player, twice over: A answers about A's copies and B about B's. A
    // global implementation cannot express this at all.
    const { state } = createGame({ seed: 11, decks: { A: lib(), B: lib() }, registry });
    const aKeep = put(state, legendaryCreature('Shared Legend'), 'A');
    const aLose = put(state, legendaryCreature('Shared Legend'), 'A');
    const bKeep = put(state, legendaryCreature('Shared Legend'), 'B');
    const bLose = put(state, legendaryCreature('Shared Legend'), 'B');

    let s = settle(state);
    let guard = 0;
    while (s.pendingChoice && guard++ < 8) {
      const chooser = s.pendingChoice.chooser;
      const keep = chooser === 'A' ? aKeep : bKeep;
      s = act(s, {
        kind: 'answerChoice',
        player: chooser,
        choiceId: s.pendingChoice.id,
        answer: { kind: 'selectCards', instanceIds: [keep] },
      });
    }
    expect(s.pendingChoice).toBeFalsy();
    expect(onBattlefield(s, aKeep)).toBeDefined();
    expect(onBattlefield(s, bKeep)).toBeDefined();
    expect(inGraveyard(s, 'A', aLose)).toBe(true);
    expect(inGraveyard(s, 'B', bLose)).toBe(true);
  });
});
