/**
 * "WHEN THIS EQUIPMENT ENTERS, ATTACH IT TO TARGET CREATURE YOU CONTROL" —
 * Maul of the Skyclaves, Bramble Armor, Scavenged Blade, Squire's Lightblade,
 * Meltstrider's Gear … (DESIGN §3.170). 44 cards print the sentence; 28 had it
 * as their only blocking clause.
 *
 * One effect-rule row: the trigger's body is the Equip ability's own primitive
 * aimed at the Equip ability's own target, so an Equipment that enters
 * attached and one that is equipped by hand go through one attach path. Pinned
 * here on the real card, played:
 *  - the trigger is offered its printed targets (a creature YOU control, never
 *    the opponent's);
 *  - resolving it leaves the Equipment attached and the host wearing the
 *    Equipment's grant, without paying the Equip cost;
 *  - with no legal target the trigger simply does not attach — the Equipment
 *    sits on the battlefield unattached (CR 704.5n never fires: it was never
 *    attached to anything illegal).
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  effectiveKeywords,
  effectivePower,
  indexContinuous,
} from '@jonny-boi/core';
import { compileCard } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;
const SEED = 41170;
const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] } as const;

function fromPool(name: string): CardDefinition {
  const found = CARD_POOL.find((entry) => entry.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

/** Maul of the Skyclaves — real printed text (corpus 2026-09-19). */
const MAUL_RESULT = compileCard({
  id: 'test:Maul of the Skyclaves',
  name: 'Maul of the Skyclaves',
  manaCost: { ...NO_MANA, generic: 2, W: 1 },
  typeLine: { supertypes: [], types: ['Artifact'], subtypes: ['Equipment'] },
  power: null,
  toughness: null,
  keywords: ['Equip'],
  oracleText:
    'When Maul of the Skyclaves enters, attach it to target creature you control.\n' +
    'Equipped creature gets +2/+2 and has flying and first strike.\n' +
    'Equip {2}{W}{W}',
} as CompilableCard);
const MAUL: CardDefinition = MAUL_RESULT.definition;

const BEAR: CardDefinition = {
  id: 'bear',
  name: 'Test Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
};

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected') as
    | { reason?: string }
    | undefined;
  if (rejected) throw new Error(`unexpected rejection: ${rejected.reason ?? '?'}`);
  return result.state;
}

type Question = NonNullable<GameState['pendingChoice']>;

function settle(
  state: GameState,
  reg: Registry,
  answer: (question: Question) => unknown = defaultAnswerFor,
): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && guard++ < 80) {
    const question = s.pendingChoice;
    s = question
      ? act(
          s,
          {
            kind: 'answerChoice',
            player: question.chooser,
            choiceId: question.id,
            answer: answer(question),
          } as GameAction,
          reg,
        )
      : act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  return s;
}

function toMain(reg: Registry): GameState {
  const forest = fromPool('Forest');
  const { state } = createGame({
    seed: SEED,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => forest) },
      B: { cards: Array.from({ length: 60 }, () => forest) },
    },
    registry: reg,
  });
  let s = state;
  let guard = 0;
  while (
    (s.step !== 'precombatMain' ||
      s.priorityPlayer !== 'A' ||
      s.stack.length > 0 ||
      s.pendingChoice) &&
    guard++ < 600
  ) {
    s = settle(s, reg);
    if (s.stack.length === 0 && s.pendingChoice == null)
      s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return s;
}

function put(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  zone: 'battlefield' | 'hand',
): InstanceId {
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

const onBoard = (state: GameState, id: InstanceId) =>
  state.battlefield.find((c) => c.instanceId === id);

describe('Maul of the Skyclaves', () => {
  it('compiles whole: the enters trigger aims at a creature you control with the Equip primitive', () => {
    expect(MAUL_RESULT.status, JSON.stringify(MAUL_RESULT.missing)).toBe('complete');
    expect(MAUL.triggers?.[0]).toEqual(
      expect.objectContaining({
        targets: 'creatureYouControl',
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
      }),
    );
    expect(MAUL.attachment?.attachesTo).toEqual({ anyOfTypes: ['creature'], controller: 'you' });
  });

  it('enters, asks for a creature you control, and is attached to it — no Equip cost paid', () => {
    const reg = buildRegistry();
    let s = toMain(reg);
    // TWO creatures of yours, so the aim is a real question (one legal target is
    // taken without asking — `isTrivialChoice`), and one of the opponent's.
    const mine = put(s, BEAR, 'A', 'battlefield');
    const mineToo = put(s, BEAR, 'A', 'battlefield');
    const theirs = put(s, BEAR, 'B', 'battlefield');
    const maul = put(s, MAUL, 'A', 'hand');
    const poolBefore = { ...s.players.A.manaPool };

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: maul, targets: [] }, reg);
    // The spell resolves; the enters trigger goes on the stack and asks.
    const offered: InstanceId[][] = [];
    s = settle(s, reg, (question) => {
      if (question.kind === 'selectTargets') {
        offered.push(question.candidates.map((c) => c.ref as InstanceId));
        return { kind: 'selectTargets', targets: [mine] };
      }
      return defaultAnswerFor(question);
    });

    expect(offered.length, 'the trigger asked once').toBe(1);
    expect(offered[0]).toContain(mine);
    expect(offered[0]).toContain(mineToo);
    expect(offered[0], "the opponent's creature is not a legal target").not.toContain(theirs);
    expect(onBoard(s, maul)?.attachedTo).toBe(mine);
    const index = indexContinuous(s);
    const host = onBoard(s, mine)!;
    expect(effectivePower(host, index.get(mine) ?? undefined)).toBe(4);
    expect(effectiveKeywords(host, index.get(mine) ?? undefined).flying).toBe(true);
    // The Equip cost ({2}{W}{W}) was not paid — only the spell's own {2}{W}.
    expect(s.players.A.manaPool.W).toBe(poolBefore.W - 1);
  });

  it('with no creature of yours it enters unattached and stays on the battlefield', () => {
    const reg = buildRegistry();
    let s = toMain(reg);
    put(s, BEAR, 'B', 'battlefield');
    const maul = put(s, MAUL, 'A', 'hand');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: maul, targets: [] }, reg);
    s = settle(s, reg);
    expect(
      onBoard(s, maul),
      'an unattached Equipment is just a permanent (CR 704.5n)',
    ).toBeDefined();
    expect(onBoard(s, maul)?.attachedTo ?? null).toBeNull();
  });
});
