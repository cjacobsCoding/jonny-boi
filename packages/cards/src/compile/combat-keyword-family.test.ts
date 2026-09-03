/**
 * THE COMBAT KEYWORD FAMILY, COMPILED FROM PRINTED TEXT (DESIGN §3.107).
 *
 * Every Oracle line here is a real card's, as the corpus prints it — pinned by
 * name so a drift in the rule table shows up against a card and not against a
 * remembered wording (the §3.57 lesson). Two layers:
 *   - what each line COMPILES TO (the definition), and
 *   - what the compiled card DOES in a real game through the real registry —
 *     an Aven Squire attacking alone connects for 2, a Bear blocking Benalish
 *     Cavalry dies, a triple-blocked Craw Giant swings for 10.
 *
 * Plus the guards: provoke still reports, a walk outside the closed land table
 * reports, and myriad compiles to a RECORDED vacuity rather than a dropped line.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  DEFAULT_RULES,
  aggregateFor,
  applyAction,
  createGame,
  effectivePower,
  effectiveToughness,
} from '@jonny-boi/core';
import { compileCard } from './compile.js';
import { MYRIAD_VACUOUS_REASON } from './rules.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
    oracleText: '',
    power: 2,
    toughness: 2,
    keywords: [],
    ...overrides,
  };
}

/** Compile a printed creature and insist it is COMPLETE — the whole contract. */
function creature(name: string, oracleText: string, keywords: readonly string[], power = 2, toughness = 2): CardDefinition {
  const result = compileCard(makeCard({ name, oracleText, keywords, power, toughness }));
  expect(result.status, `${name} missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

// --- what the lines compile to -------------------------------------------------------

describe('the keywords compile to exactly their engine payloads', () => {
  it('Exalted → a creatureAttacksAlone trigger pumping the TRIGGERING creature (Aven Squire)', () => {
    const squire = creature('Aven Squire', 'Flying\nExalted', ['Flying', 'Exalted'], 1, 1);
    expect(squire.keywords).toMatchObject({ flying: true });
    expect(squire.triggers).toEqual([
      {
        condition: { on: 'creatureAttacksAlone' },
        effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 1, toughness: 1, subject: 'triggering' } }],
        label: 'Exalted',
      },
    ]);
  });

  it('Exalted on a LAND compiles too (Cathedral of War)', () => {
    const result = compileCard(
      makeCard({
        name: 'Cathedral of War',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        power: null,
        toughness: null,
        oracleText: 'This land enters tapped.\nExalted\n{T}: Add {C}.',
        keywords: ['Exalted'],
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers?.[0]?.condition.on).toBe('creatureAttacksAlone');
  });

  it('Flanking → the flag plus a per-blocker trigger filtered on the counterpart (Benalish Cavalry)', () => {
    const cavalry = creature('Benalish Cavalry', 'Flanking', ['Flanking']);
    expect(cavalry.keywords).toMatchObject({ flanking: true });
    expect(cavalry.triggers).toEqual([
      {
        condition: { on: 'becomesBlockedByCreature', counterpartLacksKeyword: 'flanking' },
        effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: -1, toughness: -1, subject: 'triggering' } }],
        label: 'Flanking',
      },
    ]);
  });

  it('Rampage N → a becomesBlocked trigger whose pump SCALES by N per blocker beyond the first (Craw Giant)', () => {
    const giant = creature('Craw Giant', 'Trample\nRampage 2', ['Trample', 'Rampage'], 6, 4);
    expect(giant.keywords).toMatchObject({ trample: true });
    const perBlocker = { countOf: 'creaturesBlockingThisBeyondFirst', times: 2 };
    expect(giant.triggers).toEqual([
      {
        condition: { on: 'becomesBlocked' },
        effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: perBlocker, toughness: perBlocker } }],
        label: 'Rampage 2',
      },
    ]);
  });

  it('a SEMICOLON keyword list compiles every member ("Flying; trample; rampage 4" — Teeka\'s Dragon)', () => {
    const dragon = creature("Teeka's Dragon", 'Flying; trample; rampage 4', ['Flying', 'Trample', 'Rampage'], 5, 5);
    expect(dragon.keywords).toMatchObject({ flying: true, trample: true });
    expect(dragon.triggers?.[0]?.label).toBe('Rampage 4');
  });

  it('Shadow → the symmetric flag (Dauthi Mercenary)', () => {
    const mercenary = creature(
      'Dauthi Mercenary',
      'Shadow\n{1}{B}: This creature gets +1/+0 until end of turn.',
      ['Shadow'],
      2,
      1,
    );
    expect(mercenary.keywords).toMatchObject({ shadow: true });
  });

  it('Landwalk → one row of the closed land table per printed walk', () => {
    expect(creature('Pale Bears', 'Islandwalk', ['Landwalk', 'Islandwalk']).keywords?.landwalk).toEqual([
      { kind: 'subtype', subtype: 'island' },
    ]);
    expect(
      creature('Ayumi, the Last Visitor', 'Legendary landwalk', ['Landwalk', 'Legendary landwalk'], 7, 3).keywords?.landwalk,
    ).toEqual([{ kind: 'legendary' }]);
    expect(
      creature('Dryad Sophisticate', 'Nonbasic landwalk', ['Landwalk', 'Nonbasic landwalk'], 2, 1).keywords?.landwalk,
    ).toEqual([{ kind: 'nonbasic' }]);
  });

  it('⚠️ a walk outside the closed table keeps reporting', () => {
    const result = compileCard(makeCard({ name: 'Desert Walker', oracleText: 'Desertwalk', keywords: ['Landwalk', 'Desertwalk'] }));
    expect(result.status).toBe('incomplete');
  });

  it('Split second → the timing flag on the spell (Sudden Shock)', () => {
    const result = compileCard(
      makeCard({
        name: 'Sudden Shock',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        power: null,
        toughness: null,
        oracleText: 'Split second\nSudden Shock deals 2 damage to any target.',
        keywords: ['Split second'],
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.keywords).toMatchObject({ splitSecond: true });
  });

  it('Myriad → the flag is RECORDED and the vacuity is REPORTED, never dropped (Wyrm\'s Crossing Patrol)', () => {
    const result = compileCard(makeCard({ name: "Wyrm's Crossing Patrol", oracleText: 'Myriad', keywords: ['Myriad'], power: 4, toughness: 4 }));
    expect(result.status).toBe('complete');
    expect(result.definition.keywords).toMatchObject({ myriad: true });
    expect(result.vacuous).toEqual([{ text: 'Myriad', reason: MYRIAD_VACUOUS_REASON }]);
    // Every other card's result carries no such field — byte-for-byte as before.
    expect(compileCard(makeCard({ name: 'Plain Bear', oracleText: '' })).vacuous).toBeUndefined();
  });

  it('"Myriad, myriad" compiles both instances (Scurry of Squirrels)', () => {
    const result = compileCard(makeCard({ name: 'Scurry of Squirrels', oracleText: 'Myriad, myriad', keywords: ['Myriad'] }));
    expect(result.status).toBe('complete');
    expect(result.vacuous).toHaveLength(2);
  });

  it('⚠️ Provoke keeps reporting — its untap-and-block requirement has no seam yet (Goblin Grappler)', () => {
    const result = compileCard(makeCard({ name: 'Goblin Grappler', oracleText: 'Provoke', keywords: ['Provoke'], power: 1, toughness: 1 }));
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((m) => m.text)).toContain('Provoke');
  });
});

describe('the one-clause combat templates compile to their payloads', () => {
  it('"~ attacks each combat if able" → mustAttack (Goblin Brigand)', () => {
    expect(creature('Goblin Brigand', 'This creature attacks each combat if able.', []).keywords).toEqual({ mustAttack: true });
  });

  it('"~ can\'t attack unless defending player controls an Island" → the shared land table (Sea Monster)', () => {
    expect(
      creature('Sea Monster', "This creature can't attack unless defending player controls an Island.", [], 6, 6).keywords,
    ).toEqual({ cantAttackUnlessDefenderControls: [{ kind: 'subtype', subtype: 'island' }] });
  });

  it('"~ can block only creatures with flying" → blockOnly (Welkin Tern)', () => {
    const tern = creature('Welkin Tern', 'Flying\nThis creature can block only creatures with flying.', ['Flying'], 2, 1);
    expect(tern.keywords).toEqual({ flying: true, blockOnly: { attackerMustHaveAnyOf: ['flying'] } });
  });

  it('⚠️ "can block only Walls" keeps reporting — the quality table is closed', () => {
    const result = compileCard(makeCard({ name: 'Wall Watcher', oracleText: 'This creature can block only Walls.' }));
    expect(result.status).toBe('incomplete');
  });

  it('"~ can\'t be blocked by more than one creature" → maxBlockers (Norwood Riders)', () => {
    expect(creature('Norwood Riders', "This creature can't be blocked by more than one creature.", [], 3, 3).keywords).toEqual({
      maxBlockers: 1,
    });
  });

  it('"Whenever ~ attacks, it gets +0/+2" — "it" is the source (Steadfast Cathar)', () => {
    const cathar = creature('Steadfast Cathar', 'Whenever this creature attacks, it gets +0/+2 until end of turn.', []);
    expect(cathar.triggers).toEqual([
      { condition: { on: 'attacks' }, effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 0, toughness: 2 } }], label: 'Attacks: ~ gets +0/+2 until end of turn' },
    ]);
  });

  it('"Whenever ~ blocks, it gets +0/+2" → the blocks half (Shu Defender)', () => {
    const defender = creature('Shu Defender', 'Whenever this creature blocks, it gets +0/+2 until end of turn.', [], 2, 3);
    expect(defender.triggers?.[0]?.condition).toEqual({ on: 'blocks' });
    expect(defender.triggers?.[0]?.effects).toEqual([{ primitive: 'pumpUntilEndOfTurn', params: { power: 0, toughness: 2 } }]);
  });

  it('"Whenever ~ becomes blocked, it gets +1/+1" → the becomes-blocked half (Deeproot Warrior)', () => {
    const warrior = creature('Deeproot Warrior', 'Whenever this creature becomes blocked, it gets +1/+1 until end of turn.', []);
    expect(warrior.triggers?.[0]?.condition).toEqual({ on: 'becomesBlocked' });
  });

  it('"Whenever ~ blocks a creature with flying, ~ gets +2/+0" → a counterpart filter (Netcaster Spider)', () => {
    const spider = creature(
      'Netcaster Spider',
      'Reach\nWhenever this creature blocks a creature with flying, this creature gets +2/+0 until end of turn.',
      ['Reach'],
      2,
      3,
    );
    expect(spider.triggers?.[0]?.condition).toEqual({ on: 'blocks', counterpartHasKeyword: 'flying' });
    expect(spider.triggers?.[0]?.effects).toEqual([{ primitive: 'pumpUntilEndOfTurn', params: { power: 2, toughness: 0 } }]);
  });
});

// --- what the compiled cards DO ------------------------------------------------------

const FOREST: CardDefinition = { id: 'forest', name: 'Forest', types: ['land'], subtypes: ['Forest'], produces: ['G'] };
const BEAR: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 };
const SQUIRREL: CardDefinition = { id: 'squirrel', name: 'Squirrel', types: ['creature'], power: 1, toughness: 1 };

function act(state: GameState, action: GameAction, registry = REGISTRY): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`rejected ${action.kind}: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function passUntil(state: GameState, done: (s: GameState) => boolean): GameState {
  let s = state;
  for (let guard = 0; guard < 400 && !done(s) && !s.gameOver; guard++) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer });
  }
  if (!done(s)) throw new Error(`never reached the target (at ${s.step}, turn ${s.turnNumber})`);
  return s;
}

const REGISTRY = buildRegistry();

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

function stats(state: GameState, id: InstanceId): { power: number; toughness: number } {
  const inst = state.battlefield.find((c) => c.instanceId === id)!;
  const mod = aggregateFor(state, id);
  return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
}

/** A game at A's declare-attackers step, both hands empty. */
function atDeclareAttackers(): GameState {
  const { state } = createGame({
    seed: 3107,
    startingPlayer: 'A',
    registry: REGISTRY,
    decks: { A: { cards: Array.from({ length: 30 }, () => FOREST) }, B: { cards: Array.from({ length: 30 }, () => FOREST) } },
  });
  state.players.A.hand = [];
  state.players.B.hand = [];
  return passUntil(state, (s) => s.step === 'declareAttackers');
}

function attackWith(state: GameState, ids: readonly InstanceId[]): GameState {
  const declared = act(state, { kind: 'declareAttackers', player: 'A', attackers: [...ids] });
  return passUntil(declared, (s) => s.stack.length === 0 && s.step === 'declareBlockers');
}

function blockWith(state: GameState, blocks: ReadonlyArray<{ blocker: InstanceId; attacker: InstanceId }>): GameState {
  const defending = state.priorityPlayer === 'B' ? state : act(state, { kind: 'passPriority', player: 'A' });
  const declared = act(defending, { kind: 'declareBlockers', player: 'B', blocks: [...blocks] });
  return passUntil(declared, (s) => s.stack.length === 0 && s.step === 'declareBlockers' && s.combat?.blockersDeclared === true);
}

describe('the compiled cards, played through the real engine and registry', () => {
  it('an Aven Squire attacking alone is +1/+1 and connects for 2', () => {
    const squire = creature('Aven Squire', 'Flying\nExalted', ['Flying', 'Exalted'], 1, 1);
    const state = atDeclareAttackers();
    const id = place(state, squire, 'A');
    const lifeBefore = state.players.B.life;
    const blockers = attackWith(state, [id]);
    expect(stats(blockers, id)).toEqual({ power: 2, toughness: 2 });
    const after = passUntil(blockers, (s) => s.step === 'postcombatMain');
    expect(after.players.B.life).toBe(lifeBefore - 2);
  });

  it('a Bear that blocks Benalish Cavalry shrinks to 1/1 and dies; the Cavalry lives', () => {
    const cavalry = creature('Benalish Cavalry', 'Flanking', ['Flanking']);
    const state = atDeclareAttackers();
    const cavalryId = place(state, cavalry, 'A');
    const bearId = place(state, BEAR, 'B');
    const blocked = blockWith(attackWith(state, [cavalryId]), [{ blocker: bearId, attacker: cavalryId }]);
    expect(stats(blocked, bearId)).toEqual({ power: 1, toughness: 1 });
    const after = passUntil(blocked, (s) => s.step === 'postcombatMain');
    expect(after.battlefield.some((c) => c.instanceId === bearId)).toBe(false);
    expect(after.battlefield.some((c) => c.instanceId === cavalryId)).toBe(true);
  });

  it('a Craw Giant blocked by three Squirrels is +4/+4 (rampage 2, two blockers beyond the first)', () => {
    const giant = creature('Craw Giant', 'Trample\nRampage 2', ['Trample', 'Rampage'], 6, 4);
    const state = atDeclareAttackers();
    const giantId = place(state, giant, 'A');
    const squirrels = [place(state, SQUIRREL, 'B'), place(state, SQUIRREL, 'B'), place(state, SQUIRREL, 'B')];
    const blocked = blockWith(
      attackWith(state, [giantId]),
      squirrels.map((blocker) => ({ blocker, attacker: giantId })),
    );
    expect(stats(blocked, giantId)).toEqual({ power: 10, toughness: 8 });
  });

  it('a Craw Giant blocked by ONE Squirrel gets nothing — "beyond the first"', () => {
    const giant = creature('Craw Giant', 'Trample\nRampage 2', ['Trample', 'Rampage'], 6, 4);
    const state = atDeclareAttackers();
    const giantId = place(state, giant, 'A');
    const squirrel = place(state, SQUIRREL, 'B');
    const blocked = blockWith(attackWith(state, [giantId]), [{ blocker: squirrel, attacker: giantId }]);
    expect(stats(blocked, giantId)).toEqual({ power: 6, toughness: 4 });
  });

  it('a Netcaster Spider blocking a flier is +2/+0; blocking a Bear it is not', () => {
    const spider = creature(
      'Netcaster Spider',
      'Reach\nWhenever this creature blocks a creature with flying, this creature gets +2/+0 until end of turn.',
      ['Reach'],
      2,
      3,
    );
    const FLIER: CardDefinition = { ...BEAR, id: 'flier', name: 'Flier', keywords: { flying: true } };
    for (const [attackerDef, expected] of [
      [FLIER, 4],
      [BEAR, 2],
    ] as const) {
      const state = atDeclareAttackers();
      const attacker = place(state, attackerDef, 'A');
      const spiderId = place(state, spider, 'B');
      const blocked = blockWith(attackWith(state, [attacker]), [{ blocker: spiderId, attacker }]);
      expect(stats(blocked, spiderId).power).toBe(expected);
    }
  });
});
