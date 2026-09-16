/**
 * §3.153 — THE MASS UNTIL-END-OF-TURN MODIFICATION FAMILY, compiled AND PLAYED.
 *
 * Acceptance card: **Craterhoof Behemoth**, one of the five cards keeping the
 * "Tamiyo + Jace Surge" deck out of the pool (`docs/ALL-CARDS-CAMPAIGN.md` §7a).
 * Its row was re-blamed before this was scoped, and the row was right to expect a
 * cheaper card than it said: the derived count — *"where X is the number of
 * creatures you control"* — was already a row of `DERIVED_COUNTS` from §3.149, so
 * the whole residue was the MASS half. The compiler had a mass keyword grant and
 * **no mass P/T change at all**.
 *
 * The compiler half proves the printed text is understood. The ENGINE half proves
 * the understanding does something, and it is the half this repo has shipped
 * green without: §8a item 7 — a lane gutted a primitive and all 21 of its tests
 * stayed green, because every one of them called core's side directly instead of
 * crossing the seam a card actually crosses. So the four assertions that matter
 * here are played, not compiled:
 *
 *   1. every creature you control really has the buff and the keyword;
 *   2. the opponent's board does NOT;
 *   3. a creature that enters AFTER the trigger resolves does NOT — the set is
 *      read at resolution, which is the difference between this and a static;
 *   4. it is gone at end of turn.
 *
 * ⚠️ §1a — THE POOL RULE HAS TWO DIRECTIONS. Nine lanes guarded "weaker than
 * printed"; a mass effect is the shape that fails the other way. Every refusal
 * below is a card whose printed set is NARROWER than this family's pattern would
 * reach ("OTHER creatures you control", "ATTACKING creatures you control",
 * "Dinosaurs you control"), and each must keep reporting rather than being
 * widened into a card that plays stronger than it reads.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  effectiveKeywords,
  effectivePower,
  effectiveToughness,
  indexContinuous,
  NO_MOD,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';
import { CARD_POOL } from '../../data/pool.js';

const registry = buildRegistry();

/**
 * A Scryfall-shaped record. The MANA COST is zero on purpose and on every card
 * here: what is under test is the printed ORACLE TEXT, and a test that has to
 * assemble eight mana before it can read a trigger is a test about mana. This is
 * the same idiom `attachments-play.test.ts` uses.
 */
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

/**
 * The printed text of Craterhoof Behemoth, verbatim from the 32,341-card corpus
 * (`corpus-fixed.json`, md5 718eae40bfdbfa5ae3db5adbc1590c88). ⚠️ The compiler
 * sees `~` for the card's own name; the corpus prints "this creature".
 */
const CRATERHOOF_TEXT =
  'Haste\nWhen this creature enters, creatures you control gain trample and get +X/+X until end of turn, ' +
  'where X is the number of creatures you control.';

const CRATERHOOF = record({
  name: 'Craterhoof Behemoth',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Beast'] },
  oracleText: CRATERHOOF_TEXT,
  keywords: ['Haste'],
  power: 5,
  toughness: 5,
});

// --- the compiler half ------------------------------------------------------------

describe('§3.153 the compiler reads a mass until-end-of-turn modification', () => {
  it('compiles CRATERHOOF BEHEMOTH complete — the acceptance card', () => {
    const result = compileCard(CRATERHOOF);
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.status).toBe('complete');
    const body = result.definition.triggers?.[0]?.effects?.[0];
    expect(body).toEqual({
      primitive: 'modifyYoursUntilEndOfTurn',
      params: {
        keywords: { trample: true },
        // The derived count §3.149 landed — NOT re-invented by this lane.
        power: { countOf: 'creaturesYouControl' },
        toughness: { countOf: 'creaturesYouControl' },
        anyOfTypes: ['creature'],
      },
    });
  });

  it('compiles OVERRUN complete — the other printed order, pump first', () => {
    const result = compileCard(
      record({
        name: 'Overrun',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Creatures you control get +3/+3 and gain trample until end of turn.',
        power: undefined,
        toughness: undefined,
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.definition.effects?.[0]).toEqual({
      primitive: 'modifyYoursUntilEndOfTurn',
      params: { keywords: { trample: true }, power: 3, toughness: 3, anyOfTypes: ['creature'] },
    });
  });

  it('compiles MOONSHAKER CAVALRY complete — the same shape with a different keyword', () => {
    const result = compileCard(
      record({
        name: 'Moonshaker Cavalry',
        oracleText:
          'Flying\nWhen this creature enters, creatures you control gain flying and get +X/+X until end of turn, ' +
          'where X is the number of creatures you control.',
        keywords: ['Flying'],
        power: 5,
        toughness: 5,
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.status).toBe('complete');
  });

  it('compiles CRATERCLAW COLOSSUS complete — an asymmetric derived pump, +X/+0', () => {
    const result = compileCard(
      record({
        name: 'Craterclaw Colossus',
        typeLine: { supertypes: [], types: ['Artifact', 'Creature'], subtypes: ['Beast', 'Construct'] },
        oracleText:
          'Haste\nWhen this creature enters, creatures you control gain trample and get +X/+0 until end of turn, ' +
          'where X is the number of artifacts you control.',
        keywords: ['Haste'],
        power: 6,
        toughness: 6,
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    const body = result.definition.triggers?.[0]?.effects?.[0];
    // The toughness half is a printed ZERO, not an absent half — the card says +X/+0.
    expect(body?.params?.toughness).toBe(0);
  });

  it('compiles the PUMP-ONLY order, which had no rule at all before §3.153', () => {
    const result = compileCard(
      record({
        name: 'Gnawing Crescendo Fragment',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Creatures you control get +2/+0 until end of turn.',
        power: undefined,
        toughness: undefined,
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.definition.effects?.[0]).toEqual({
      primitive: 'modifyYoursUntilEndOfTurn',
      // No `keywords` key at all: a line that grants none must not carry an empty
      // grant object, or `isEmptyKeywords` and the AI's keyword count disagree
      // about whether this card does anything.
      params: { power: 2, toughness: 0, anyOfTypes: ['creature'] },
    });
  });

  it('still compiles the GRANT-ONLY order the superseded rule owned (Selfless Spirit)', () => {
    const result = compileCard(
      record({
        name: 'Selfless Spirit',
        oracleText: 'Flying\nSacrifice this creature: Creatures you control gain indestructible until end of turn.',
        keywords: ['Flying'],
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.status).toBe('complete');
  });

  it('reads the printed noun as a TYPE — "permanents you control" narrows nothing', () => {
    const result = compileCard(
      record({
        name: 'Heroic Intervention Fragment',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        oracleText: 'Permanents you control gain hexproof and indestructible until end of turn.',
        power: undefined,
        toughness: undefined,
      }),
    );
    expect(result.definition.effects?.[0]?.params).toEqual({
      keywords: { hexproof: true, indestructible: true },
    });
  });
});

// --- §1a: the refusals, which are the STRONGER-THAN-PRINTED guard ------------------

describe('§1a a mass modification must never reach more than it prints', () => {
  /** Compile one printed line on a sorcery and hand back what the compiler refused. */
  function refusalFor(name: string, oracleText: string): readonly string[] {
    const result = compileCard(
      record({
        name,
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText,
        power: undefined,
        toughness: undefined,
      }),
    );
    return (result.missing ?? []).map((m) => m.text);
  }

  // The denominator, printed before anything is asserted about it — §8a item 8: a
  // check shaped "for each X, assert…" passes vacuously when X is empty, and this
  // suite would otherwise prove nothing if `refusalFor` silently returned [].
  const NARROWER_THAN_THE_PATTERN: readonly (readonly [string, string])[] = [
    // Umaro, Raging Yeti — "OTHER" excludes the source. Reaching it would buff a
    // creature the card deliberately leaves out.
    ['Umaro Fragment', 'Other creatures you control get +3/+0 and gain trample until end of turn.'],
    // Tourach's Gate — only the attackers, and only this combat.
    ['Tourach Fragment', 'Attacking creatures you control get +2/-1 until end of turn.'],
    // Huatli, Dinosaur Knight — a SUBTYPE, which `STATIC_NOUN_TYPES` has no row for.
    ['Huatli Fragment', 'Dinosaurs you control get +4/+4 until end of turn.'],
    // Pathbreaker Ibex — a real printed card whose "where X is" phrase is NOT a
    // row of `DERIVED_COUNTS`. Widening the count vocabulary to swallow it is the
    // one thing §7b item 4 says a lane must not do.
    [
      'Pathbreaker Fragment',
      'Creatures you control gain trample and get +X/+X until end of turn, where X is the greatest power among creatures you control.',
    ],
    // A keyword the engine does not model: the whole line reports rather than the
    // pump landing and the grant being dropped.
    ['Unknown Keyword Fragment', 'Creatures you control get +1/+1 and gain frobnication until end of turn.'],
  ];

  it('has refusals to check at all', () => {
    expect(NARROWER_THAN_THE_PATTERN.length).toBeGreaterThan(0);
  });

  for (const [name, text] of NARROWER_THAN_THE_PATTERN) {
    it(`refuses rather than widening: ${text}`, () => {
      const refused = refusalFor(name, text);
      expect(refused.length, `${name} compiled when it should have reported`).toBeGreaterThan(0);
    });
  }
});

// --- the engine half: PLAY the card -----------------------------------------------

function act(state: GameState, action: GameAction): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function pass(state: GameState): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer });
}

function poolCard(name: string): CardDefinition {
  const found = CARD_POOL.find((c) => c.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

/** A's precombat main, hands emptied, deterministic. */
function gameAtMain(): GameState {
  const island = poolCard('Island');
  const { state } = createGame({
    seed: 0x400f,
    startingPlayer: 'A',
    registry,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => island) },
      B: { cards: Array.from({ length: 40 }, () => island) },
    },
  });
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 50) s = pass(s);
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

function place(state: GameState, def: CardDefinition, controller: 'A' | 'B'): CardInstance {
  const instance: CardInstance = {
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
  state.battlefield.push(instance);
  return instance;
}

/** Put `def` into A's hand and cast it, letting both players pass so it resolves. */
function castFromHand(state: GameState, def: CardDefinition): GameState {
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
  let s = act(state, { kind: 'castSpell', player: 'A', instanceId, targets: [] });
  s = pass(s);
  s = pass(s);
  // The permanent resolved; its ETB trigger is now on the stack. Let it resolve too.
  let guard = 0;
  while (s.stack.length > 0 && guard++ < 10) {
    s = pass(s);
    s = pass(s);
  }
  return s;
}

/** The effective box and keyword set of one instance, read the way combat reads them. */
function statsOf(state: GameState, id: number): { power: number; toughness: number; trample: boolean } {
  const inst = state.battlefield.find((p) => p.instanceId === id);
  if (!inst) throw new Error(`instance ${id} is not on the battlefield`);
  const mod = indexContinuous(state).get(inst.instanceId) ?? NO_MOD;
  return {
    power: effectivePower(inst, mod),
    toughness: effectiveToughness(inst, mod),
    trample: effectiveKeywords(inst, mod).trample === true,
  };
}

const OX: CardDefinition = {
  id: 'test-ox',
  name: 'Ox',
  types: ['creature'],
  cost: { generic: 0 },
  power: 2,
  toughness: 2,
};

/** Advance to the next turn, which takes the game through cleanup. */
function endTheTurn(state: GameState): GameState {
  let s = state;
  const turn = s.turn;
  let guard = 0;
  while (s.turn === turn && !s.gameOver && guard++ < 200) s = pass(s);
  return s;
}

describe('§3.153 Craterhoof Behemoth, PLAYED', () => {
  const HOOF = (() => {
    const result = compileCard(CRATERHOOF);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    return result.definition;
  })();

  it('buffs every creature you control by the number of creatures you control, with trample', () => {
    let s = gameAtMain();
    const mine1 = place(s, OX, 'A');
    const mine2 = place(s, OX, 'A');
    const mine3 = place(s, OX, 'A');
    const theirs = place(s, OX, 'B');

    s = castFromHand(s, HOOF);

    // Four creatures you control once the Behemoth itself has entered, so +4/+4.
    const hoof = s.battlefield.find((p) => p.def.name === 'Craterhoof Behemoth');
    expect(hoof, 'Craterhoof never reached the battlefield').toBeDefined();

    for (const id of [mine1.instanceId, mine2.instanceId, mine3.instanceId]) {
      expect(statsOf(s, id)).toEqual({ power: 6, toughness: 6, trample: true });
    }
    // The source counts itself: it was on the battlefield when its own ETB
    // trigger resolved (CR 603.6a), so a 5/5 becomes a 9/9.
    expect(statsOf(s, hoof!.instanceId)).toEqual({ power: 9, toughness: 9, trample: true });

    // …and the opponent's board is untouched in both halves.
    expect(statsOf(s, theirs.instanceId)).toEqual({ power: 2, toughness: 2, trample: false });
  });

  it('does NOT reach a creature that enters AFTER it resolved — the set is read at resolution', () => {
    let s = gameAtMain();
    const before = place(s, OX, 'A');
    s = castFromHand(s, HOOF);
    // Two creatures at resolution, so +2/+2 for the ones that were there.
    expect(statsOf(s, before.instanceId)).toEqual({ power: 4, toughness: 4, trample: true });

    const after = place(s, OX, 'A');
    expect(statsOf(s, after.instanceId)).toEqual({ power: 2, toughness: 2, trample: false });
  });

  it('wears off at end of turn — it is a duration, not a static and not a counter', () => {
    let s = gameAtMain();
    const mine = place(s, OX, 'A');
    s = castFromHand(s, HOOF);
    expect(statsOf(s, mine.instanceId).power).toBe(4);

    s = endTheTurn(s);

    expect(statsOf(s, mine.instanceId)).toEqual({ power: 2, toughness: 2, trample: false });
  });
});

describe('§3.153 Overrun, PLAYED — the printed-number order reaches the board too', () => {
  const OVERRUN = (() => {
    const result = compileCard(
      record({
        name: 'Overrun',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Creatures you control get +3/+3 and gain trample until end of turn.',
        power: undefined,
        toughness: undefined,
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    return result.definition;
  })();

  it('gives every creature you control +3/+3 and trample, and the opponent nothing', () => {
    let s = gameAtMain();
    const mine = place(s, OX, 'A');
    const theirs = place(s, OX, 'B');

    s = castFromHand(s, OVERRUN);

    expect(statsOf(s, mine.instanceId)).toEqual({ power: 5, toughness: 5, trample: true });
    expect(statsOf(s, theirs.instanceId)).toEqual({ power: 2, toughness: 2, trample: false });
  });
});
