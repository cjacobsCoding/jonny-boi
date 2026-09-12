/**
 * BLOCK SELECTORS THAT READ A LIVE NUMBER — the half of "can't be blocked by …"
 * whose bound is not printed on the card at all.
 *
 * Champion of Lambholt reads "Creatures with power less than this creature's
 * power can't block creatures you control." The bound is the CHAMPION'S OWN
 * EFFECTIVE POWER, which climbs by a +1/+1 counter every time another creature
 * enters — so a restriction compiled against the printed 3 is a different card
 * from the one in the box by the second turn it is on the battlefield.
 *
 * DESIGN §3.17 and §3.25 both deferred this shape by name ("a restriction whose
 * threshold is ANOTHER permanent's power"), because asking a static about a
 * value the continuous layer produces is a CR 613.8 dependency. §3.143's answer
 * is the settled-P/T pass: read the powers after every P/T layer has folded, and
 * write KEYWORDS ONLY, so the pass's output can never change its own input.
 *
 * Both halves are proved here, and neither implies the other:
 *   - the COMPILER half — the printed line becomes the right static, and a
 *     comparison the closed table does not carry still REPORTS;
 *   - the ENGINE half — the restriction changes which block the engine accepts,
 *     and a pump ON THE CHAMPION mid-combat flips a block that was legal a
 *     moment earlier. A static that compiles and does nothing looks exactly like
 *     a working feature from the compiler's side, which is why the play test is
 *     not optional.
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
} from '@jonny-boi/core';
import { compileCard, type CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { EXPANDED_CARD_POOL } from '../data/expanded-pool.js';

// --- the compiler half ------------------------------------------------------------

function record(over: Partial<CompilableCard> & Pick<CompilableCard, 'name' | 'oracleText'>): CompilableCard {
  return {
    id: `test-${over.name.toLowerCase().replace(/\W+/g, '-')}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
    power: 2,
    toughness: 2,
    keywords: [],
    ...over,
  } as CompilableCard;
}

describe('the compiler reads a bound taken from the static source itself', () => {
  it("compiles CHAMPION OF LAMBHOLT complete — the card's REAL printed text", () => {
    const result = compileCard(
      record({
        name: 'Champion of Lambholt',
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 2, C: 0, other: [] },
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Warrior'] },
        power: 2,
        toughness: 2,
        oracleText:
          "Creatures with power less than this creature's power can't block creatures you control.\n" +
          'Whenever another creature you control enters, put a +1/+1 counter on this creature.',
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.status).toBe('complete');
    const ability = result.definition.statics?.[0];
    // "Less than X can't block" ⇒ a legal blocker needs power AT LEAST X.
    expect(ability?.blockBoundFromSourcePower).toBe('minBlockerPower');
    expect(ability?.affects).toMatchObject({ anyOfTypes: ['creature'], controller: 'you' });
    // The printed line has no "other": the Champion is one of the creatures the
    // restriction rides on.
    expect(ability?.affects.excludeSource).toBeUndefined();
  });

  it('reads the printed COMPARISON rather than inferring it — "greater" is the other bound', () => {
    const result = compileCard(
      record({
        name: 'Mirror Champion',
        oracleText: "Creatures with power greater than this creature's power can't block creatures you control.",
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.statics?.[0]?.blockBoundFromSourcePower).toBe('maxBlockerPower');
  });

  it('a comparison the closed table does not carry still REPORTS', () => {
    for (const oracleText of [
      // A bound read off a DIFFERENT permanent's power, not the source's.
      "Creatures with power less than the strongest creature's power can't block creatures you control.",
      // TOUGHNESS, which the table does not carry — and must not be read as power.
      "Creatures with toughness less than this creature's toughness can't block creatures you control.",
    ]) {
      const result = compileCard(record({ name: 'Champ', oracleText }));
      expect(result.status, oracleText).not.toBe('complete');
    }
  });

  it('the static is KEYWORD-GRANTING ONLY — the rule that makes one settled pass exact', () => {
    // ⚠️ THE POOL-WIDE GUARD, and the reason it is pool-wide rather than one
    // card: core folds a settled-stats static AFTER every P/T layer, so a P/T
    // delta on one would need its own output as input. Core drops such a delta
    // silently (it has no way to report), which means the only place this can be
    // caught is here, over everything the compiler has actually emitted.
    const offenders: string[] = [];
    for (const card of EXPANDED_CARD_POOL) {
      for (const ability of card.statics ?? []) {
        const readsSettled =
          ability.affects.maxEffectivePower !== undefined ||
          ability.affects.maxEffectivePowerOrToughness !== undefined ||
          ability.blockBoundFromSourcePower !== undefined;
        if (!readsSettled) continue;
        if ((ability.power ?? 0) !== 0 || (ability.toughness ?? 0) !== 0) {
          offenders.push(`${card.name}: a settled-stats static carries a P/T delta`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// --- the engine half --------------------------------------------------------------

const REGISTRY = buildRegistry();

const FOREST: CardDefinition = {
  id: 'test-forest',
  name: 'Forest',
  types: ['land'],
  subtypes: ['forest'],
  manaAbility: { produces: { G: 1 } },
};

/** Champion of Lambholt, exactly as the compiler above emits it. */
const CHAMPION: CardDefinition = {
  id: 'test-champion',
  name: 'Champion of Lambholt',
  types: ['creature'],
  cost: { generic: 1, G: 2 },
  power: 2,
  toughness: 2,
  statics: [
    {
      affects: { anyOfTypes: ['creature'], controller: 'you' },
      blockBoundFromSourcePower: 'minBlockerPower',
      label: "creatures with power less than ~'s power can't block creatures you control",
    },
  ],
};

function creature(name: string, power: number, toughness: number): CardDefinition {
  return {
    id: `test-${name.toLowerCase().replace(/\W+/g, '-')}`,
    name,
    types: ['creature'],
    cost: { generic: 2 },
    power,
    toughness,
  };
}

/** Giant Growth's shape, so the pump goes through the REAL primitive. */
const GIANT_GROWTH: CardDefinition = {
  id: 'test-giant-growth',
  name: 'Giant Growth',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 0 },
  effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 3, toughness: 3, targets: 'creature' } }],
};

function act(state: GameState, action: GameAction): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, REGISTRY);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

/** Why this action was refused, or `undefined` if it was accepted. */
function rejection(state: GameState, action: GameAction): string | undefined {
  const result = applyAction(state, action, DEFAULT_RULES, REGISTRY);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  return rejected === undefined ? undefined : (rejected as { reason: string }).reason;
}

function passUntil(state: GameState, done: (s: GameState) => boolean): GameState {
  let s = state;
  let guard = 0;
  while (!done(s) && !s.gameOver && guard++ < 60) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer });
  }
  return s;
}

function place(state: GameState, def: CardDefinition, controller: 'A' | 'B'): InstanceId {
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

/** A SEEDED game at A's declare-attackers step, both hands empty. */
function atDeclareAttackers(): GameState {
  const { state } = createGame({
    seed: 0x3143,
    startingPlayer: 'A',
    registry: REGISTRY,
    decks: {
      A: { cards: Array.from({ length: 30 }, () => FOREST) },
      B: { cards: Array.from({ length: 30 }, () => FOREST) },
    },
  });
  state.players.A.hand = [];
  state.players.B.hand = [];
  return passUntil(state, (s) => s.step === 'declareAttackers');
}

/** Declare attackers and stop while A still holds priority in that step. */
function attackWith(state: GameState, ids: readonly InstanceId[]): GameState {
  return act(state, { kind: 'declareAttackers', player: 'A', attackers: [...ids] });
}

function toDeclareBlockers(state: GameState): GameState {
  return passUntil(state, (s) => s.stack.length === 0 && s.step === 'declareBlockers');
}

function blockAction(blocks: ReadonlyArray<{ blocker: InstanceId; attacker: InstanceId }>): GameAction {
  return { kind: 'declareBlockers', player: 'B', blocks: [...blocks] };
}

/** Cast an instant from A's hand at the given target, and let it resolve. */
function castAt(state: GameState, def: CardDefinition, target: InstanceId): GameState {
  const instanceId = state.nextInstanceId++;
  state.players.A.hand.push({
    instanceId,
    def,
    controller: 'A',
    owner: 'A',
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  const cast = act(state, { kind: 'castSpell', player: 'A', instanceId, targets: [target] });
  return passUntil(cast, (s) => s.stack.length === 0);
}

describe("Champion of Lambholt's restriction, played through the real engine", () => {
  it('a 1/1 cannot block while the Champion is a 2/2 — the bound is the live power', () => {
    const state = atDeclareAttackers();
    const champion = place(state, CHAMPION, 'A');
    const weakling = place(state, creature('Weakling', 1, 1), 'B');
    const blockers = toDeclareBlockers(attackWith(state, [champion]));
    const defending = act(blockers, { kind: 'passPriority', player: 'A' });
    // The EXACT refusal, naming both creatures: a loose /block/ match would
    // also pass on a rejection about flying, a tapped blocker, or the wrong
    // step, and would keep passing if the restriction stopped working.
    expect(rejection(defending, blockAction([{ blocker: weakling, attacker: champion }]))).toBe(
      'Weakling cannot block Champion of Lambholt',
    );
  });

  it('a 2/2 CAN block a 2/2 Champion — the bound is "less than", not "at most"', () => {
    const state = atDeclareAttackers();
    const champion = place(state, CHAMPION, 'A');
    const peer = place(state, creature('Peer', 2, 2), 'B');
    const blockers = toDeclareBlockers(attackWith(state, [champion]));
    const defending = act(blockers, { kind: 'passPriority', player: 'A' });
    expect(rejection(defending, blockAction([{ blocker: peer, attacker: champion }]))).toBeUndefined();
  });

  it('⚠️ A PUMP MID-COMBAT FLIPS IT: the same 2/2 block, refused after Giant Growth', () => {
    // The whole fidelity claim in one test. The block below is legal on the
    // board as declared — the test above proves it — and becomes illegal because
    // the CHAMPION grew between the attack and the block. A restriction compiled
    // against the printed 2 would accept it, and the card would be playing as
    // something other than what is printed on it.
    const state = atDeclareAttackers();
    const champion = place(state, CHAMPION, 'A');
    const peer = place(state, creature('Peer', 2, 2), 'B');
    const attacking = attackWith(state, [champion]);
    const pumped = castAt(attacking, GIANT_GROWTH, champion);
    const blockers = toDeclareBlockers(pumped);
    const defending = blockers.priorityPlayer === 'B' ? blockers : act(blockers, { kind: 'passPriority', player: 'A' });
    expect(rejection(defending, blockAction([{ blocker: peer, attacker: champion }]))).toBe(
      'Peer cannot block Champion of Lambholt',
    );
  });

  it('it protects the WHOLE team, not just the Champion — "creatures you control"', () => {
    const state = atDeclareAttackers();
    const champion = place(state, CHAMPION, 'A');
    const bear = place(state, creature('Bear', 2, 2), 'A');
    const weakling = place(state, creature('Weakling', 1, 1), 'B');
    const blockers = toDeclareBlockers(attackWith(state, [champion, bear]));
    const defending = act(blockers, { kind: 'passPriority', player: 'A' });
    expect(rejection(defending, blockAction([{ blocker: weakling, attacker: bear }]))).toBe(
      'Weakling cannot block Bear',
    );
  });

  it("it does NOT reach the opponent's creatures — the restriction is one-sided", () => {
    // B attacks into A. A's 1/1 may block B's creature freely: the Champion's
    // line reads "creatures YOU control", and a symmetric reading would hand the
    // opponent an evasion the card never printed.
    const state = atDeclareAttackers();
    place(state, CHAMPION, 'A');
    const mine = place(state, creature('Mine', 1, 1), 'A');
    const theirs = place(state, creature('Theirs', 3, 3), 'B');
    // Walk to B's turn's declare-blockers, with A defending.
    let s = passUntil(state, (x) => x.step === 'declareAttackers' && x.activePlayer === 'B');
    s = act(s, { kind: 'declareAttackers', player: 'B', attackers: [theirs] });
    s = passUntil(s, (x) => x.stack.length === 0 && x.step === 'declareBlockers');
    const defending = s.priorityPlayer === 'A' ? s : act(s, { kind: 'passPriority', player: 'B' });
    expect(
      rejection(defending, { kind: 'declareBlockers', player: 'A', blocks: [{ blocker: mine, attacker: theirs }] }),
    ).toBeUndefined();
  });

  it('the restriction dies with its source — destroy the Champion and the 1/1 may block', () => {
    const state = atDeclareAttackers();
    const champion = place(state, CHAMPION, 'A');
    const bear = place(state, creature('Bear', 2, 2), 'A');
    const weakling = place(state, creature('Weakling', 1, 1), 'B');
    const attacking = attackWith(state, [champion, bear]);
    // Lifetime is DERIVED from the board, never stored: the instant the source
    // leaves, the very next legality read no longer sees the restriction.
    const killed = {
      ...attacking,
      battlefield: attacking.battlefield.filter((c) => c.instanceId !== champion),
    };
    const blockers = toDeclareBlockers(killed);
    const defending = blockers.priorityPlayer === 'B' ? blockers : act(blockers, { kind: 'passPriority', player: 'A' });
    expect(rejection(defending, blockAction([{ blocker: weakling, attacker: bear }]))).toBeUndefined();
  });
});
