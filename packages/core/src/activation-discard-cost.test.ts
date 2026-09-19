/**
 * "DISCARD A CARD" AS AN ACTIVATION COST (DESIGN §3.172) — Patrol Hound's
 * "Discard a card: ~ gains first strike until end of turn", Vampire Hounds'
 * "Discard a creature card: ~ gets +2/+2", Frenetic Ogre's "{R}, Discard a
 * card at random: ~ gets +3/+0". 92 cards on the corpus had one of these as
 * their only blocking clause (66 the plain "a card").
 *
 * The cost is `sacrificeAnother` one zone over, and this pins the same four
 * things that cost pins:
 *  - the OFFER: one action per legal card in hand, filtered by the printed
 *    noun; none at all with no qualifying card, and the gate says so by name;
 *  - the PAYMENT: the named card is in the graveyard while the ability is
 *    still on the stack (CR 602.2b) — never refunded, never asked for later;
 *  - the CHECKS: an action naming a card that is not in hand, or two cards,
 *    is refused by name;
 *  - the FUNNEL: a madness card discarded this way exiles itself and opens its
 *    window, because the payment goes through the one discard path;
 *  - "AT RANDOM": nothing is named, a card leaves, and the same seed discards
 *    the same card (the state-carried RNG).
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, giveHand, landDef } from './test-fixtures.js';

const FOREST = landDef('Forest', 'G');

const BEAR: CardDefinition = {
  id: 'bear-card',
  name: 'Grizzly Bears',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 1, G: 1 },
};
const BOLT: CardDefinition = {
  id: 'bolt-card',
  name: 'Lightning Bolt',
  types: ['instant'],
  cost: { R: 1 },
  effects: [{ primitive: 'testMark', params: { which: 'bolt' } }],
};
const ROOTWALLA: CardDefinition = {
  id: 'madness-card',
  name: 'Basking Rootwalla',
  types: ['creature'],
  power: 1,
  toughness: 1,
  cost: { G: 1 },
  madness: { generic: 0 },
};

/** Patrol Hound's shape: any card. */
const HOUND: CardDefinition = {
  id: 'hound',
  name: 'Patrol Hound',
  types: ['creature'],
  power: 2,
  toughness: 2,
  activated: [
    {
      cost: { discard: { count: 1 } },
      effects: [{ primitive: 'testMark', params: { which: 'hound' } }],
      label: 'Discard a card: mark',
    },
  ],
};
/** Vampire Hounds' shape: a CREATURE card. */
const VAMPIRE_HOUNDS: CardDefinition = {
  id: 'vampire-hounds',
  name: 'Vampire Hounds',
  types: ['creature'],
  power: 2,
  toughness: 2,
  activated: [
    {
      cost: { discard: { count: 1, filter: { anyOfTypes: ['creature'] } } },
      effects: [{ primitive: 'testMark', params: { which: 'vampire' } }],
      label: 'Discard a creature card: mark',
    },
  ],
};
/** Frenetic Ogre's shape: at random. */
const OGRE: CardDefinition = {
  id: 'ogre',
  name: 'Frenetic Ogre',
  types: ['creature'],
  power: 3,
  toughness: 3,
  activated: [
    {
      cost: { discard: { count: 1, random: true } },
      effects: [{ primitive: 'testMark', params: { which: 'ogre' } }],
      label: 'Discard a card at random: mark',
    },
  ],
};

interface Board {
  state: GameState;
  reg: EffectRegistry;
  marks: string[];
}

function setup(def: CardDefinition, seed = 7): Board & { id: InstanceId } {
  const marks: string[] = [];
  const reg = createEffectRegistry();
  reg.register('testMark', (ctx) => void marks.push(String((ctx.params as { which?: string }).which)));
  const { state } = createGame({
    seed,
    startingPlayer: 'A',
    decks: { A: deckOf(FOREST, 40), B: deckOf(FOREST, 40) },
    registry: reg,
  });
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && guard++ < 50) {
    s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, reg).state;
  }
  s.players.A.hand = [];
  const id = s.nextInstanceId++;
  s.battlefield.push({
    instanceId: id,
    def,
    controller: 'A',
    owner: 'A',
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return { state: s, reg, marks, id };
}

type Activate = Extract<GameAction, { kind: 'activateAbility' }>;

function offers(state: GameState, id: InstanceId): Activate[] {
  return generateLegalActions(state).filter(
    (a): a is Activate => a.kind === 'activateAbility' && a.instanceId === id,
  );
}

function rejection(r: ReturnType<typeof applyAction>): string | undefined {
  return (r.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined)?.reason;
}

function settle(state: GameState, reg: EffectRegistry): GameState {
  let s = state;
  for (let guard = 0; guard < 20 && s.stack.length > 0; guard++) {
    s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, reg).state;
  }
  return s;
}

describe('"Discard a card:" as an activation cost', () => {
  it('offers one action per card in hand, each naming its card, and none with an empty hand', () => {
    const board = setup(HOUND);
    expect(offers(board.state, board.id), 'nothing to discard — not offered').toEqual([]);

    const [bear, bolt] = giveHand(board.state, 'A', [BEAR, BOLT]);
    const offered = offers(board.state, board.id);
    expect(offered.map((a) => a.costInstanceIds)).toEqual([[bear!.instanceId], [bolt!.instanceId]]);
  });

  it('pays BEFORE the ability is on the stack: the card is in the graveyard while the ability waits', () => {
    const board = setup(HOUND);
    const [bear, bolt] = giveHand(board.state, 'A', [BEAR, BOLT]);
    const r = applyAction(
      board.state,
      { kind: 'activateAbility', player: 'A', instanceId: board.id, abilityIndex: 0, costInstanceIds: [bolt!.instanceId] },
      DEFAULT_RULES,
      board.reg,
    );
    expect(rejection(r)).toBeUndefined();
    expect(r.state.stack, 'the ability is on the stack').toHaveLength(1);
    expect(r.state.players.A.hand.map((c) => c.instanceId), 'the named card left the hand').toEqual([
      bear!.instanceId,
    ]);
    expect(r.state.players.A.graveyard.map((c) => c.instanceId)).toEqual([bolt!.instanceId]);
    expect(board.marks, 'not resolved yet').toEqual([]);
    const done = settle(r.state, board.reg);
    expect(board.marks).toEqual(['hound']);
    expect(done.players.A.hand).toHaveLength(1);
  });

  it('refuses an action naming a card that is not in hand, or two cards, or none — by name', () => {
    const board = setup(HOUND);
    const [bear, bolt] = giveHand(board.state, 'A', [BEAR, BOLT]);
    const base: Activate = { kind: 'activateAbility', player: 'A', instanceId: board.id, abilityIndex: 0 };
    expect(rejection(applyAction(board.state, { ...base }, DEFAULT_RULES, board.reg))).toMatch(
      /needs 1 legal card\(s\) to discard/,
    );
    expect(
      rejection(
        applyAction(board.state, { ...base, costInstanceIds: [bear!.instanceId, bolt!.instanceId] }, DEFAULT_RULES, board.reg),
      ),
    ).toMatch(/needs 1 legal card\(s\) to discard/);
    expect(
      rejection(applyAction(board.state, { ...base, costInstanceIds: [board.id] }, DEFAULT_RULES, board.reg)),
      'the source itself is on the battlefield, not in hand',
    ).toMatch(/needs 1 legal card\(s\) to discard/);
    // Nothing was paid on a refusal.
    expect(board.state.players.A.hand).toHaveLength(2);
  });

  it('filters the hand by the printed noun: "a creature card" offers the creature, never the instant', () => {
    const board = setup(VAMPIRE_HOUNDS);
    giveHand(board.state, 'A', [BOLT]);
    expect(offers(board.state, board.id), 'an instant is not a creature card').toEqual([]);
    const [bear] = giveHand(board.state, 'A', [BEAR]);
    expect(offers(board.state, board.id).map((a) => a.costInstanceIds)).toEqual([[bear!.instanceId]]);
    const bolt = board.state.players.A.hand[0]!;
    const r = applyAction(
      board.state,
      { kind: 'activateAbility', player: 'A', instanceId: board.id, abilityIndex: 0, costInstanceIds: [bolt.instanceId] },
      DEFAULT_RULES,
      board.reg,
    );
    expect(rejection(r), 'naming the instant is refused even though it is in hand').toMatch(/legal card/);
  });

  it('goes through the one discard funnel: a madness card discarded as the cost exiles itself and opens its window', () => {
    const board = setup(HOUND);
    const [walla] = giveHand(board.state, 'A', [ROOTWALLA]);
    const r = applyAction(
      board.state,
      { kind: 'activateAbility', player: 'A', instanceId: board.id, abilityIndex: 0, costInstanceIds: [walla!.instanceId] },
      DEFAULT_RULES,
      board.reg,
    );
    expect(rejection(r)).toBeUndefined();
    expect(r.state.players.A.exile.map((c) => c.instanceId)).toEqual([walla!.instanceId]);
    expect(r.state.players.A.graveyard).toHaveLength(0);
    expect(r.state.madnessWindow?.controller).toBe('A');
  });

  it('"at random" names no card, takes one, and the same seed takes the same one', () => {
    const run = (seed: number) => {
      const board = setup(OGRE, seed);
      const hand = giveHand(board.state, 'A', [BEAR, BOLT, ROOTWALLA]);
      const offered = offers(board.state, board.id);
      expect(offered, 'one unnamed offer').toHaveLength(1);
      expect(offered[0]!.costInstanceIds).toBeUndefined();
      const r = applyAction(board.state, offered[0]!, DEFAULT_RULES, board.reg);
      expect(rejection(r)).toBeUndefined();
      expect(r.state.players.A.hand).toHaveLength(2);
      const gone = hand.find((c) => !r.state.players.A.hand.some((h) => h.instanceId === c.instanceId))!;
      return gone.def.id;
    };
    expect(run(7)).toBe(run(7));
    // Different seeds do not all agree — the pick really is random, not hand[0].
    const picks = new Set([run(1), run(2), run(3), run(4), run(5), run(6), run(7), run(8)]);
    expect(picks.size).toBeGreaterThan(1);
    // And with nothing in hand it is not offered.
    const empty = setup(OGRE);
    expect(offers(empty.state, empty.id)).toEqual([]);
  });
});
