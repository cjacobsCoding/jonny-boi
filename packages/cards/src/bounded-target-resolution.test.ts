/**
 * A BOUNDED TARGET IS RE-CHECKED WITH ITS BOUND WHEN THE SPELL RESOLVES
 * (CR 608.2b) — DESIGN §3.162.
 *
 * `restrictionParam`, the one reader every targeting primitive uses for its
 * resolution-time legality re-check, returned only a BARE restriction and
 * handed a §3.150 bounded spec back as the unrestricted default. So "destroy
 * target creature with power 4 or greater", aimed at a 4/4 and answered with a
 * shrink, still destroyed the 3/4 — the aiming pass had policed the bound and
 * the resolution had not. The printed spell fizzles: its only target is no
 * longer legal.
 *
 * Two runs, one board, so the discriminator is the response and nothing else:
 * without the shrink the creature dies (the bound is satisfied and the spell
 * must resolve), with it the creature lives.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, defaultAnswerFor, MINUS_ONE_COUNTER } from '@jonny-boi/core';
import { compileCard } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

function fromPool(name: string): CardDefinition {
  const found = CARD_POOL.find((entry) => entry.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

const SMITE_THE_MIGHTY = (() => {
  const result = compileCard({
    id: 'test:smite',
    name: 'Smite the Mighty',
    manaCost: { generic: 1, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
    oracleText: 'Destroy target creature with power 4 or greater.',
    power: null,
    toughness: null,
    keywords: [],
  } as CompilableCard);
  expect(result.status, JSON.stringify(result.missing)).toBe('complete');
  return result.definition;
})();

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined;
  if (rejected) throw new Error(`unexpected rejection: ${rejected.reason ?? '?'}`);
  return result.state;
}

function settle(state: GameState, reg: Registry): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && guard++ < 40) {
    const q = s.pendingChoice;
    s = q
      ? act(s, { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) } as GameAction, reg)
      : act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  return s;
}

function toMain(reg: Registry): GameState {
  const forest = fromPool('Forest');
  const { state } = createGame({
    seed: 7,
    decks: { A: { cards: Array.from({ length: 60 }, () => forest) }, B: { cards: Array.from({ length: 60 }, () => forest) } },
    registry: reg,
  });
  let s = state;
  let guard = 0;
  while ((s.step !== 'precombatMain' || s.priorityPlayer !== 'A' || s.stack.length > 0 || s.pendingChoice) && guard++ < 600) {
    s = settle(s, reg);
    if (s.stack.length === 0 && s.pendingChoice == null) s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return s;
}

function put(state: GameState, def: CardDefinition, controller: PlayerId, zone: 'battlefield' | 'hand'): InstanceId {
  const id = state.nextInstanceId++;
  const instance = {
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  } as never;
  if (zone === 'hand') (state.players[controller].hand as unknown[]).push(instance);
  else (state.battlefield as unknown[]).push(instance);
  return id;
}

/** Cast the bounded removal at Serra Angel (a 4/4), optionally shrinking her in response. */
function run(shrinkInResponse: boolean): { angelSurvives: boolean } {
  const reg = buildRegistry();
  let s = toMain(reg);
  const angel = put(s, fromPool('Serra Angel'), 'B', 'battlefield');
  const smite = put(s, SMITE_THE_MIGHTY, 'A', 'hand');
  s = act(s, { kind: 'castSpell', player: 'A', instanceId: smite, targets: [angel] }, reg);
  expect(s.stack).toHaveLength(1);
  if (shrinkInResponse) {
    // The response: a -1/-1 counter lands on the Angel while the spell waits —
    // the same instance state a resolved shrink leaves, and what the
    // resolution-time re-check has to read.
    const target = s.battlefield.find((c) => c.instanceId === angel)!;
    target.counters = { ...target.counters, [MINUS_ONE_COUNTER]: 1 };
  }
  s = settle(s, reg);
  return { angelSurvives: s.battlefield.some((c) => c.instanceId === angel) };
}

describe('a bounded target, re-checked at resolution WITH its bound', () => {
  it('control: with the bound still met, the spell resolves and the creature dies', () => {
    expect(run(false).angelSurvives).toBe(false);
  });

  it('shrunk below the bound in response, the only target is illegal and the spell fizzles', () => {
    // ⚠️ THE DISCRIMINATOR: with `restrictionParam` handing back the bare
    // default, the re-check passes ("any target") and the 3/4 Angel dies.
    expect(run(true).angelSurvives).toBe(true);
  });
});
