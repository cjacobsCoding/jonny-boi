/**
 * FLASHBACK at the cards level: the compiler's "Flashback {cost}" rule, its
 * refusals (anything beyond a plain mana cost stays reported — the compiler
 * never approximates), and the mechanic played end-to-end through the REAL
 * engine + this package's primitives — including the failure mode that decides
 * whether the exile replacement was actually implemented: a flashback spell
 * that gets COUNTERED is exiled, not returned to the graveyard (CR 702.34a —
 * being countered is leaving the stack).
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  GameAction,
  GameState,
  SpellStackObject,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { compileCard, type CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

// --- the compiler half ----------------------------------------------------------

/** A Think-Twice-shaped card record, as the importer would hand it over. */
function flashbackCard(oracleText: string, keywords: readonly string[] = ['Flashback']): CompilableCard {
  return {
    id: 'test-think-twice',
    name: 'Think Twice',
    manaCost: { generic: 1, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    oracleText,
    power: null,
    toughness: null,
    keywords,
  };
}

describe('compiling "Flashback {cost}"', () => {
  it('compiles the plain form COMPLETE, with the cost on the definition', () => {
    const result = compileCard(
      flashbackCard(
        'Draw a card.\nFlashback {2}{U} (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
      ),
    );
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.definition.flashback).toEqual({ generic: 2, U: 1 });
    expect(result.matchedRules).toContain('flashback-cost');
  });

  it('compiles an {X} flashback cost — the X is asked (and charged) at cast time', () => {
    const result = compileCard(flashbackCard('Draw a card.\nFlashback {X}{U}'));
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.flashback).toEqual({ U: 1 });
    // The {X} is NOT folded into the mana cost — X is 0 off the stack (CR
    // 107.3), so it is a separate count the cast-time question reads.
    expect(result.definition.flashbackXCost).toBe(1);
  });

  it('compiles the Deep-Analysis shape: a flashback cost with a life rider', () => {
    const result = compileCard(flashbackCard('Draw a card.\nFlashback—{1}{U}, Pay 3 life.'));
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.flashback).toEqual({ generic: 1, U: 1 });
    expect(result.definition.flashbackLifeCost).toBe(3);
  });

  it('still refuses a flashback rider the engine has no cast-time cost for', () => {
    // A DISCARD rider is not a cost kind the cast pipeline can charge, so the
    // line stays reported rather than being cast for the mana alone — which
    // would be strictly cheaper than printed.
    const result = compileCard(flashbackCard('Draw a card.\nFlashback—{1}{U}, Discard a card.'));
    expect(result.status).toBe('incomplete');
    expect(result.definition.flashback).toBeUndefined();
  });

  it('still reports flashback-GRANTING text (the Snapcaster shape)', () => {
    const granting = compileCard({
      ...flashbackCard(
        'When this creature enters, target instant or sorcery card in your graveyard gains flashback until end of turn.',
        ['Flash'],
      ),
      typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Wizard'] },
      power: 2,
      toughness: 1,
    });
    expect(granting.status).toBe('incomplete');
  });
});

// --- the engine half, with this package's real primitives ------------------------

const PRINTED_COST = { R: 1 } as const;
const FLASHBACK_COST = { generic: 4, R: 1 } as const;

/** A Firebolt-shaped sorcery: {R} deal 2 damage; Flashback {4}{R}. */
const FIREBOLT: CardDefinition = {
  id: 'test-firebolt',
  name: 'Firebolt',
  types: ['sorcery'],
  cost: PRINTED_COST,
  flashback: FLASHBACK_COST,
  effects: [{ primitive: 'dealDamage', params: { amount: 2 } }],
};

function getByName(name: string): CardDefinition {
  const c = CARD_POOL.find((x) => x.name === name);
  if (!c) throw new Error(`pool missing ${name}`);
  return c;
}

function deck(def: CardDefinition, n = 40): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function act(state: GameState, action: GameAction, reg: ReturnType<typeof buildRegistry>): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

function pass(state: GameState, reg: ReturnType<typeof buildRegistry>): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** A's precombat main on turn 1, hands emptied, seeded + deterministic. */
function gameAtMain(reg: ReturnType<typeof buildRegistry>): GameState {
  const mountain = getByName('Mountain');
  const created = createGame({
    seed: 0xf1eb,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deck(mountain), B: deck(mountain) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

/** Put a fresh instance of `def` into a zone by hand (test-position building). */
function place(state: GameState, player: 'A' | 'B', zone: 'hand' | 'graveyard', def: CardDefinition): number {
  const instanceId = state.nextInstanceId++;
  state.players[player][zone].push({
    instanceId,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  });
  return instanceId;
}

describe('flashback played through the real engine + primitives', () => {
  it('cast from hand → graveyard, then flashed back → resolves and is EXILED', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const bolt = place(state, 'A', 'hand', FIREBOLT);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };

    // From hand: ordinary cast, resolves to the graveyard.
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: bolt, targets: ['B'] }, reg);
    state = pass(pass(state, reg), reg);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toEqual([bolt]);
    expect(state.players.B.life).toBe(DEFAULT_RULES.startingLife - 2);

    // From the graveyard: the flashback cast the engine itself offers.
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 4 };
    const offer = generateLegalActions(state, DEFAULT_RULES).find(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> =>
        a.kind === 'castSpell' && a.fromZone === 'graveyard' && a.instanceId === bolt,
    );
    expect(offer, 'the engine should offer the flashback cast').toBeDefined();
    state = act(state, { ...offer!, targets: ['B'] }, reg);
    state = pass(pass(state, reg), reg);

    expect(state.players.B.life).toBe(DEFAULT_RULES.startingLife - 4);
    expect(state.players.A.exile.map((c) => c.instanceId)).toEqual([bolt]);
    expect(state.players.A.graveyard).toHaveLength(0);
    // And it is gone for good: no further flashback offer exists.
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 4 };
    expect(
      generateLegalActions(state, DEFAULT_RULES).some(
        (a) => a.kind === 'castSpell' && a.fromZone === 'graveyard',
      ),
    ).toBe(false);
  });

  it('a COUNTERED flashback spell is exiled, not returned to the graveyard (CR 702.34a)', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const bolt = place(state, 'A', 'graveyard', FIREBOLT);
    const counter = place(state, 'B', 'hand', getByName('Counterspell'));
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 4 };
    state.players.B.manaPool = { W: 0, U: 2, B: 0, R: 0, G: 0, C: 0 };

    state = act(
      state,
      { kind: 'castSpell', player: 'A', instanceId: bolt, targets: ['B'], fromZone: 'graveyard' },
      reg,
    );
    const spell = state.stack[0] as SpellStackObject;
    expect(spell.castFrom).toBe('graveyard');

    // A holds priority after casting; pass to B, who counters it.
    state = pass(state, reg);
    state = act(state, { kind: 'castSpell', player: 'B', instanceId: counter, targets: [bolt] }, reg);
    state = pass(pass(state, reg), reg); // Counterspell resolves

    // The countered flashback spell is EXILED; the Counterspell itself (an
    // ordinary from-hand cast) goes to ITS owner's graveyard as ever.
    expect(state.players.A.exile.map((c) => c.instanceId)).toEqual([bolt]);
    expect(state.players.A.graveyard).toHaveLength(0);
    expect(state.players.B.graveyard.map((c) => c.instanceId)).toEqual([counter]);
    expect(state.players.B.life).toBe(DEFAULT_RULES.startingLife); // it never resolved
  });
});
