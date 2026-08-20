/**
 * THE COPY FAMILY, PLAYED — Reverberate, Narset's Reversal, Rite of Replication
 * and Giant Adephage, in real seeded games driven through `applyAction`.
 *
 * `pool-mechanics.test.ts` is the inventory; this is the proof. The claim
 * "the pool has a card that copies a spell" and the claim "a pool card copies a
 * spell and the copy resolves and leaves nothing behind" are different claims,
 * and only the second is worth anything.
 *
 * ⚠️ THE ASSERTION THAT MATTERS IS A CARD CENSUS. A copy of a spell is not a
 * card (CR 704.5e), so after a Reverberate resolves the game must hold exactly
 * the cards it held before — one Reverberate and one Bolt in a graveyard, and no
 * third object anywhere. A test that only checked "six damage was dealt" would
 * pass just as happily while the graveyard quietly grew a phantom Lightning Bolt
 * that delirium counts, that Tarmogoyf reads and that flashback could recast.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, defaultAnswerFor, generateLegalActions } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so a failure is always reproducible. */
const SEEDS = { spellCopy: 3301, reversal: 3302, tokenCopy: 3303, kicked: 3304, adephage: 3305 } as const;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');

function deck(def: CardDefinition, n = 60): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  const question = state.pendingChoice;
  if (question) {
    return act(
      state,
      { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: defaultAnswerFor(question) },
      reg,
    );
  }
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function advanceToMain(state: GameState, reg: Registry, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && guard++ < max) s = pass(s, reg);
  return s;
}

function answer(state: GameState, value: ChoiceAnswer, reg: Registry): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('no pending choice to answer');
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

/** Pass until the stack is empty, answering questions with the given answers in order. */
function settle(state: GameState, reg: Registry, answers: readonly ChoiceAnswer[] = []): GameState {
  let s = state;
  const queue = [...answers];
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 60) {
    if (s.pendingChoice != null) {
      const next = queue.shift();
      s = next ? answer(s, next, reg) : act(s, generateLegalActions(s).find((a) => a.kind === 'answerChoice')!, reg);
      continue;
    }
    s = pass(s, reg);
  }
  return s;
}

function floodMana(state: GameState): void {
  state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  state.players.B.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
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
  return id;
}

function giveHand(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller: player,
    owner: player,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players[player].hand.push(inst);
  return inst.instanceId;
}

function openGame(seed: number): { s: GameState; reg: Registry } {
  const reg = buildRegistry();
  const { state } = createGame({ seed, decks: { A: deck(FOREST), B: deck(FOREST) }, registry: reg });
  const s = advanceToMain(state, reg);
  floodMana(s);
  return { s, reg };
}

/**
 * How many CARD OBJECTS the game can see, anywhere — the census that catches a
 * phantom. Counts the stack too: an object stuck there forever is just as wrong
 * as one in a graveyard, and a census that skipped it would call that clean.
 */
function totalObjects(state: GameState): number {
  let total = state.battlefield.length + state.stack.length;
  for (const pid of ['A', 'B'] as const) {
    const p = state.players[pid];
    total += p.hand.length + p.library.length + p.graveyard.length + p.exile.length + p.command.length;
  }
  return total;
}

describe('copying a SPELL on the stack (CR 707.10)', () => {
  it('Reverberate copies a Bolt, the copy deals its damage, and NO card is left behind', () => {
    const { s: opened, reg } = openGame(SEEDS.spellCopy);
    let s = opened;
    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    const revId = giveHand(s, 'A', getByName('Reverberate'));

    const before = totalObjects(s);
    const lifeBefore = s.players.B.life;

    // Bolt at the opponent's face, then Reverberate at the Bolt while it is
    // still on the stack — the only window in which the copy is even legal.
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    expect(s.stack).toHaveLength(1);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: revId, targets: [boltId] }, reg);
    expect(s.stack).toHaveLength(2);

    // The re-aim question is asked from inside Reverberate's RESOLUTION, and the
    // only legal answer here is the same face the Bolt already points at.
    s = settle(s, reg, [{ kind: 'selectTargets', targets: ['B'] }]);

    // SIX damage, not three: the copy resolved as a real Bolt.
    expect(lifeBefore - s.players.B.life).toBe(6);
    // The census is the point. Two cards were cast; two cards are in a
    // graveyard; the copy left nothing.
    expect(totalObjects(s)).toBe(before);
    expect(s.players.A.graveyard.map((c) => c.def.name).sort()).toEqual(['Lightning Bolt', 'Reverberate']);
    // Nothing anywhere is a second Lightning Bolt — the phantom this whole
    // system exists to prevent.
    const everywhere = [
      ...s.battlefield,
      ...s.players.A.graveyard,
      ...s.players.A.exile,
      ...s.players.A.hand,
      ...s.players.B.graveyard,
      ...s.players.B.exile,
      ...s.players.B.hand,
    ];
    expect(everywhere.filter((c) => c.def.name === 'Lightning Bolt')).toHaveLength(1);
  });

  it("Narset's Reversal returns the ORIGINAL to its owner's hand and the copy still resolves", () => {
    const { s: opened, reg } = openGame(SEEDS.reversal);
    let s = opened;
    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    const narsetId = giveHand(s, 'A', getByName("Narset's Reversal"));

    const before = totalObjects(s);
    const lifeBefore = s.players.B.life;

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: narsetId, targets: [boltId] }, reg);
    s = settle(s, reg, [{ kind: 'selectTargets', targets: ['B'] }]);

    // THE ORIGINAL NEVER RESOLVED: it is back in its owner's HAND, not in a
    // graveyard — and it was RETURNED, not countered, which is a distinction
    // nothing else in the engine could express.
    expect(s.players.A.hand.some((c) => c.instanceId === boltId)).toBe(true);
    expect(s.players.A.graveyard.some((c) => c.instanceId === boltId)).toBe(false);
    // Exactly THREE damage — the copy's. Six would mean the original resolved
    // too; zero would mean the copy was thrown away with it.
    expect(lifeBefore - s.players.B.life).toBe(3);
    // Narset's own card is the only thing in the graveyard, and the census is
    // unchanged: the copy left nothing behind.
    expect(s.players.A.graveyard.map((c) => c.def.name)).toEqual(["Narset's Reversal"]);
    expect(totalObjects(s)).toBe(before);
  });
});

describe('a TOKEN COPY of a permanent (CR 707.2 + CR 111)', () => {
  it('Rite of Replication copies a creature, and the token is a TOKEN', () => {
    const { s: opened, reg } = openGame(SEEDS.tokenCopy);
    let s = opened;
    const bearDef = getByName('Grizzly Bears');
    const bearId = place(s, bearDef, 'A');
    const riteId = giveHand(s, 'A', getByName('Rite of Replication'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: riteId, targets: [bearId] }, reg);
    // DECLINE the kicker explicitly. `settle`'s default answer would have PAID
    // it (the first legal answer to a `payMana` question is "yes"), and the test
    // would then have been measuring the kicked mode while claiming otherwise.
    s = settle(s, reg, [{ kind: 'payMana', pay: false }]);

    const copies = s.battlefield.filter((c) => c.def.name === bearDef.name);
    expect(copies).toHaveLength(2);
    const token = copies.find((c) => c.instanceId !== bearId);
    // TOKEN-NESS IS THE TRAP. A token copy built from another card's copiable
    // values still has to answer "yes" to every nontoken filter and still has to
    // cease to exist when it leaves the battlefield (CR 704.5d) — which it does
    // because `createToken` stamps the flag, not because this primitive did.
    expect(token?.def.isToken).toBe(true);
    // And it is the real body, not a blank: P/T, types and subtypes all copied.
    expect(token?.def.power).toBe(bearDef.power);
    expect(token?.def.toughness).toBe(bearDef.toughness);
    expect(token?.def.types).toEqual(bearDef.types);
    // The ORIGINAL is untouched and still a card.
    expect(s.battlefield.find((c) => c.instanceId === bearId)?.def.isToken).toBeUndefined();
  });

  it('KICKED, it makes FIVE — the printed count REPLACES the base one, never adds to it', () => {
    const { s: opened, reg } = openGame(SEEDS.kicked);
    let s = opened;
    const bearDef = getByName('Grizzly Bears');
    const bearId = place(s, bearDef, 'A');
    const riteId = giveHand(s, 'A', getByName('Rite of Replication'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: riteId, targets: [bearId] }, reg);
    // The kicker is a cast-time question; paying it is the whole test.
    const kickQuestion = s.pendingChoice;
    expect(kickQuestion?.kind, 'the kicker should be asked at cast time').toBe('payMana');
    s = answer(s, { kind: 'payMana', pay: true }, reg);
    s = settle(s, reg);

    // FIVE tokens plus the original = six bodies. Not seven, which is what
    // "create one, and if kicked create five more" would have produced.
    expect(s.battlefield.filter((c) => c.def.name === bearDef.name)).toHaveLength(6);
    expect(s.battlefield.filter((c) => c.def.name === bearDef.name && c.def.isToken === true)).toHaveLength(5);
  });

  it('a token copy of a permanent wearing counters copies the PRINTED body (CR 707.2)', () => {
    const { s: opened, reg } = openGame(SEEDS.tokenCopy + 1);
    let s = opened;
    const bearDef = getByName('Grizzly Bears');
    const bearId = place(s, bearDef, 'A');
    // Three +1/+1 counters: the original is a 5/5 on the board.
    const bear = s.battlefield.find((c) => c.instanceId === bearId) as CardInstance;
    bear.counters = { '+1/+1': 3 };
    const riteId = giveHand(s, 'A', getByName('Rite of Replication'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: riteId, targets: [bearId] }, reg);
    s = settle(s, reg, [{ kind: 'payMana', pay: false }]);

    const token = s.battlefield.find((c) => c.def.name === bearDef.name && c.instanceId !== bearId);
    // The COPIABLE values are the printed card, and counters are not among them.
    expect(token?.def.power).toBe(2);
    expect(token?.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('Giant Adephage copies ITSELF off a combat-damage trigger — no target involved', () => {
    const { s: opened, reg } = openGame(SEEDS.adephage);
    let s = opened;
    const adephageDef = getByName('Giant Adephage');
    const id = place(s, adephageDef, 'A');
    const permanent = s.battlefield.find((c) => c.instanceId === id) as CardInstance;
    permanent.summoningSick = false;

    // Swing at an empty board; combat damage to a player fires the trigger.
    let guard = 0;
    while (s.step !== 'declareAttackers' && !s.gameOver && guard++ < 40) s = pass(s, reg);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [id] }, reg);
    guard = 0;
    while (s.step !== 'postcombatMain' && !s.gameOver && guard++ < 60) s = pass(s, reg);

    const bodies = s.battlefield.filter((c) => c.def.name === adephageDef.name);
    expect(bodies).toHaveLength(2);
    expect(bodies.filter((c) => c.def.isToken === true)).toHaveLength(1);
  });
});
