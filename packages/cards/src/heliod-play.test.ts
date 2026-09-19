/**
 * HELIOD, SUN-CROWNED — PLAYED (DESIGN §3.163).
 *
 * "Also add Heliod, Sun-Crowned and all required mechanics." The card compiles
 * whole now: indestructible, the devotion type layer, the lifegain trigger aimed
 * at "target creature or enchantment you control", and "{1}{W}: Another target
 * creature gains lifelink". Compiled here from its printed text and driven
 * through the real action loop, so what is pinned is the BOARD:
 *
 *  - cast onto a board with white devotion below five, Heliod ENTERS as an
 *    enchantment: Soul Warden does not see a creature enter, and it is offered
 *    no attack;
 *  - the fifth white pip makes it a 5/5 creature on the same action;
 *  - its lifegain trigger may grow Heliod itself while it is an enchantment —
 *    the printed "creature OR ENCHANTMENT you control" is the whole point;
 *  - the lifelink grant never offers Heliod to itself.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  devotionTo,
  generateLegalActions,
  isCreature,
  PLUS_ONE_COUNTER,
  settleDevotionForms,
} from '@jonny-boi/core';
import { compileCard } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;
type Question = NonNullable<GameState['pendingChoice']>;

const SEED = 31163;

function fromPool(name: string): CardDefinition {
  const found = CARD_POOL.find((entry) => entry.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

const HELIOD = (() => {
  const result = compileCard({
    id: 'test:heliod',
    name: 'Heliod, Sun-Crowned',
    manaCost: { generic: 2, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: ['Legendary'], types: ['Enchantment', 'Creature'], subtypes: ['God'] },
    power: 5,
    toughness: 5,
    keywords: ['Indestructible'],
    oracleText:
      'Indestructible\n' +
      "As long as your devotion to white is less than five, Heliod isn't a creature.\n" +
      'Whenever you gain life, put a +1/+1 counter on target creature or enchantment you control.\n' +
      '{1}{W}: Another target creature gains lifelink until end of turn.',
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

function settle(state: GameState, reg: Registry, answer: (q: Question) => unknown = defaultAnswerFor): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && guard++ < 80) {
    const q = s.pendingChoice;
    s = q
      ? act(s, { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: answer(q) } as GameAction, reg)
      : act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  return s;
}

function toMain(reg: Registry): GameState {
  const plains = fromPool('Plains');
  const { state } = createGame({
    seed: SEED,
    decks: { A: { cards: Array.from({ length: 60 }, () => plains) }, B: { cards: Array.from({ length: 60 }, () => plains) } },
    registry: reg,
  });
  let s = state;
  let guard = 0;
  while ((s.step !== 'precombatMain' || s.priorityPlayer !== 'A' || s.stack.length > 0 || s.pendingChoice) && guard++ < 600) {
    s = settle(s, reg);
    if (s.stack.length === 0 && s.pendingChoice == null) s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  s.players.B.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
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

const onBoard = (s: GameState, id: InstanceId) => s.battlefield.find((c) => c.instanceId === id);

function cast(s: GameState, def: CardDefinition, reg: Registry, answer?: (q: Question) => unknown): { state: GameState; id: InstanceId } {
  const id = put(s, def, 'A', 'hand');
  let next = act(s, { kind: 'castSpell', player: 'A', instanceId: id, targets: [] }, reg);
  next = settle(next, reg, answer);
  return { state: next, id };
}

describe('Heliod, Sun-Crowned', () => {
  it('enters as an ENCHANTMENT below five devotion — Soul Warden sees no creature — and wakes at the fifth pip', () => {
    const reg = buildRegistry();
    let s = toMain(reg);
    put(s, fromPool('Soul Warden'), 'A', 'battlefield'); // {W}: devotion 1, and the witness
    const lifeBefore = s.players.A.life;
    const heliodCast = cast(s, HELIOD, reg); // {2}{W}: devotion 2
    s = heliodCast.state;
    const heliod = heliodCast.id;
    expect(onBoard(s, heliod), 'Heliod resolved').toBeDefined();
    expect(isCreature(onBoard(s, heliod)!.def), 'devotion 2 — not a creature').toBe(false);
    expect(s.players.A.life, "Soul Warden's 'another creature enters' did not fire for an enchantment").toBe(lifeBefore);

    // Voice of the Blessed is {W}{W}: devotion 4 — still short.
    s = cast(s, fromPool('Voice of the Blessed'), reg, pickHeliodIfAsked(heliod)).state;
    expect(devotionTo(s, 'A', ['W'])).toBe(4);
    expect(isCreature(onBoard(s, heliod)!.def), 'four is short').toBe(false);
    // …and Soul Warden DID see the Voice enter, which gained life, which
    // triggered Heliod: the counter went onto Heliod itself, an ENCHANTMENT you
    // control, exactly as the printed noun allows.
    expect(s.players.A.life).toBe(lifeBefore + 1);
    expect(onBoard(s, heliod)!.counters[PLUS_ONE_COUNTER], 'grown while an enchantment').toBe(1);

    // A second Voice: devotion 6. Heliod is a creature on the same action.
    s = cast(s, fromPool('Voice of the Blessed'), reg, pickHeliodIfAsked(heliod)).state;
    expect(devotionTo(s, 'A', ['W'])).toBe(6);
    expect(isCreature(onBoard(s, heliod)!.def), 'a 5/5 creature now').toBe(true);
    expect(onBoard(s, heliod)!.def.types).toEqual(['enchantment', 'creature']);
  });

  it('as a creature it is offered an attack; as an enchantment it is not', () => {
    const reg = buildRegistry();
    // Devotion 5 from the start: Heliod + two Voices.
    const withGod = (devotionCards: readonly CardDefinition[]) => {
      const s = toMain(reg);
      for (const def of devotionCards) put(s, def, 'A', 'battlefield');
      const heliod = put(s, HELIOD, 'A', 'battlefield');
      // Settle through the engine's own boundary — a priority pass runs the
      // state-based check, which settles the forms.
      let t = act(s, { kind: 'passPriority', player: 'A' }, reg);
      t = act(t, { kind: 'passPriority', player: 'B' }, reg);
      for (let guard = 0; guard < 30 && t.step !== 'declareAttackers'; guard++) {
        t = act(t, { kind: 'passPriority', player: t.priorityPlayer }, reg);
      }
      const offer = generateLegalActions(t).find(
        (a) => a.kind === 'declareAttackers' && (a as { attackers: readonly InstanceId[] }).attackers.includes(heliod),
      );
      return { attackOffered: offer !== undefined, creature: isCreature(onBoard(t, heliod)!.def) };
    };
    const asleep = withGod([]);
    expect(asleep.creature).toBe(false);
    expect(asleep.attackOffered, 'an enchantment cannot attack').toBe(false);
    const awake = withGod([fromPool('Voice of the Blessed'), fromPool('Voice of the Blessed')]);
    expect(awake.creature).toBe(true);
    expect(awake.attackOffered, 'a 5/5 indestructible attacker').toBe(true);
  });

  it('the lifelink grant is offered for ANOTHER creature and never for Heliod itself', () => {
    const reg = buildRegistry();
    const s = toMain(reg);
    put(s, fromPool('Voice of the Blessed'), 'A', 'battlefield');
    put(s, fromPool('Voice of the Blessed'), 'A', 'battlefield');
    const heliod = put(s, HELIOD, 'A', 'battlefield');
    const bear = put(s, fromPool('Grizzly Bears'), 'A', 'battlefield');
    // `put` bypasses the entry funnel, so settle the forms the way the engine
    // does at every boundary (a priority pass would empty the pool that funds
    // the {1}{W}).
    settleDevotionForms(s);
    expect(isCreature(onBoard(s, heliod)!.def), 'devotion 5 — a creature').toBe(true);
    const offers = generateLegalActions(s).filter(
      (a) => a.kind === 'activateAbility' && a.instanceId === heliod,
    ) as Array<{ targets?: readonly (InstanceId | PlayerId)[] }>;
    const aims = offers.map((a) => a.targets?.[0]);
    expect(aims).toContain(bear);
    expect(aims, 'never itself').not.toContain(heliod);
  });
});

/** Answer Heliod's lifegain trigger by aiming it at Heliod; anything else by default. */
function pickHeliodIfAsked(heliod: InstanceId) {
  return (q: Question) =>
    q.kind === 'selectTargets' && q.candidates.some((c) => c.ref === heliod)
      ? { kind: 'selectTargets', targets: [heliod] }
      : defaultAnswerFor(q);
}
