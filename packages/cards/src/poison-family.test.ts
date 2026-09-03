/**
 * THE POISON FAMILY at the card layer (§3.105) — infect, wither, toxic and
 * poison counters, pinned by the REAL printed cards the keyword-cards tool
 * listed as sole-blocked, and by the noncombat damage sites core's combat
 * tests cannot reach: `dealDamage` (Puncture Blast is a wither SPELL), `fight`
 * (an infect creature fighting) and proliferate's player half.
 *
 * Two of the tests here pin a CLASS fix that came free with the one damage
 * funnel: noncombat damage from a lifelink or deathtouch source now gains life
 * and destroys, which CR 702.15b / 702.2b always said and the four copies of
 * "what damage does" had each forgotten.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameEvent, GameState, PlayerId } from '@jonny-boi/core';
import { MINUS_ONE_COUNTER, poisonOf } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

const CREATURE = { supertypes: [], types: ['Creature'], subtypes: ['Phyrexian'] };

describe('compiling the printed keyword lines', () => {
  it('Glistener Elf — "Infect" is a keyword flag, and the card is complete', () => {
    const r = compileCard(
      makeCard({
        name: 'Glistener Elf',
        typeLine: CREATURE,
        power: '1',
        toughness: '1',
        oracleText:
          'Infect (This creature deals damage to creatures in the form of -1/-1 counters and to players in the form of poison counters.)',
        keywords: ['Infect'],
      }),
    );
    expect(r.status, JSON.stringify(r.missing)).toBe('complete');
    expect(r.definition.keywords?.infect).toBe(true);
  });

  it('Boggart Ram-Gang — "Wither" beside haste compiles both flags', () => {
    const r = compileCard(
      makeCard({
        name: 'Boggart Ram-Gang',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Goblin', 'Warrior'] },
        power: '3',
        toughness: '3',
        oracleText: 'Haste\nWither (This deals damage to creatures in the form of -1/-1 counters.)',
        keywords: ['Haste', 'Wither'],
      }),
    );
    expect(r.status, JSON.stringify(r.missing)).toBe('complete');
    expect(r.definition.keywords).toMatchObject({ haste: true, wither: true });
  });

  it('Puncture Blast — wither on an INSTANT compiles beside its damage primitive', () => {
    const r = compileCard(
      makeCard({
        name: 'Puncture Blast',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        oracleText:
          'Wither (This deals damage to creatures in the form of -1/-1 counters.)\nPuncture Blast deals 3 damage to any target.',
        keywords: ['Wither'],
      }),
    );
    expect(r.status, JSON.stringify(r.missing)).toBe('complete');
    expect(r.definition.keywords?.wither).toBe(true);
    expect(r.definition.effects?.[0]?.primitive).toBe('dealDamage');
  });

  it('Tyrranax Atrocity — "Toxic 3" is a NUMBER payload, and Scryfall’s bare "Toxic" tag is not a second gap', () => {
    const r = compileCard(
      makeCard({
        name: 'Tyrranax Atrocity',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Phyrexian', 'Dinosaur'] },
        power: '4',
        toughness: '4',
        oracleText: 'Haste\nToxic 3 (Players dealt combat damage by this creature also get three poison counters.)',
        keywords: ['Haste', 'Toxic'],
      }),
    );
    expect(r.status, JSON.stringify(r.missing)).toBe('complete');
    expect(r.definition.keywords?.toxic).toBe(3);
  });

  it('Plague Nurse — a bare "Toxic 2" line with no reminder text compiles the same way', () => {
    const r = compileCard(
      makeCard({
        name: 'Plague Nurse (line only)',
        typeLine: CREATURE,
        power: '3',
        toughness: '3',
        oracleText: 'Toxic 2',
        keywords: ['Toxic'],
      }),
    );
    expect(r.status, JSON.stringify(r.missing)).toBe('complete');
    expect(r.definition.keywords?.toxic).toBe(2);
  });

  it('a toxic form outside the closed pattern ("Toxic X") reports rather than compiling a guess', () => {
    const r = compileCard(
      makeCard({
        name: 'Imaginary Toxic X',
        typeLine: CREATURE,
        power: '1',
        toughness: '1',
        oracleText: 'Toxic X',
        keywords: ['Toxic'],
      }),
    );
    expect(r.status).toBe('incomplete');
    expect(r.definition.keywords?.toxic).toBeUndefined();
  });

  it('Tainted Strike — "gains infect until end of turn" is a keyword GRANT through the same row', () => {
    const r = compileCard(
      makeCard({
        name: 'Tainted Strike',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        oracleText: 'Target creature gets +1/+0 and gains infect until end of turn.',
        keywords: [],
      }),
    );
    expect(r.status, JSON.stringify(r.missing)).toBe('complete');
  });

  it('Core Prowler — "When this creature dies, proliferate" now compiles with infect', () => {
    const r = compileCard(
      makeCard({
        name: 'Core Prowler',
        typeLine: { supertypes: [], types: ['Artifact', 'Creature'], subtypes: ['Phyrexian', 'Horror'] },
        power: '2',
        toughness: '2',
        oracleText:
          'Infect (This creature deals damage to creatures in the form of -1/-1 counters and to players in the form of poison counters.)\nWhen this creature dies, proliferate. (Choose any number of permanents and/or players, then give each another counter of each kind already there.)',
        keywords: ['Infect', 'Proliferate'],
      }),
    );
    expect(r.status, JSON.stringify(r.missing)).toBe('complete');
  });
});

// --- the primitives, resolved for real --------------------------------------------

function creature(
  id: number,
  controller: PlayerId,
  power: number,
  toughness: number,
  keywords: CardDefinition['keywords'] = {},
): Record<string, unknown> {
  return {
    instanceId: id,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
    def: { id: `c${id}`, name: `Creature ${id}`, types: ['creature'], power, toughness, keywords } as CardDefinition,
  };
}

function player(life = 20) {
  return { life, exile: [], hand: [], graveyard: [], library: [], command: [], hasLost: false };
}

function board(battlefield: Record<string, unknown>[]): GameState {
  return {
    nextInstanceId: 100,
    battlefield,
    stack: [],
    continuous: [],
    players: { A: player(), B: player() },
  } as unknown as GameState;
}

function run(
  primitive: string,
  state: GameState,
  source: Record<string, unknown>,
  targets: readonly (number | PlayerId)[],
  params: Record<string, unknown> = {},
  choices: Record<string, unknown> = {},
): GameEvent[] {
  const registry = buildRegistry();
  const fn = registry.get(primitive);
  expect(fn, primitive).toBeDefined();
  const events: GameEvent[] = [];
  fn!({
    state,
    source,
    controller: 'A' as PlayerId,
    targets,
    params,
    emit: (e: GameEvent) => events.push(e),
    ask: () => undefined,
    ...choices,
  } as never);
  return events;
}

describe('wither on a SPELL — Puncture Blast through `dealDamage`', () => {
  it('3 damage to a 4/4 lands as three -1/-1 counters and no marked damage', () => {
    const target = creature(1, 'B', 4, 4);
    const state = board([target]);
    const spell = {
      instanceId: 50,
      controller: 'A',
      def: { id: 'pb', name: 'Puncture Blast', types: ['instant'], keywords: { wither: true } },
    };
    run('dealDamage', state, spell, [1], { amount: 3 });
    expect((target.counters as Record<string, number>)[MINUS_ONE_COUNTER]).toBe(3);
    expect(target.damageMarked).toBe(0);
  });

  it('the same spell at a player is ordinary life loss (wither has no player half)', () => {
    const state = board([]);
    const spell = {
      instanceId: 50,
      controller: 'A',
      def: { id: 'pb', name: 'Puncture Blast', types: ['instant'], keywords: { wither: true } },
    };
    run('dealDamage', state, spell, ['B'], { amount: 3 });
    expect(state.players.B.life).toBe(17);
    expect(poisonOf(state.players.B)).toBe(0);
  });
});

describe('an infect creature that FIGHTS (CR 702.90e — from any zone, by any means)', () => {
  it('its damage lands as -1/-1 counters; the damage it takes is ordinary', () => {
    const infecter = creature(1, 'A', 2, 3, { infect: true });
    const other = creature(2, 'B', 2, 4);
    const state = board([infecter, other]);
    run('fight', state, infecter, [2]);
    expect((other.counters as Record<string, number>)[MINUS_ONE_COUNTER]).toBe(2);
    expect(other.damageMarked).toBe(0);
    expect(infecter.damageMarked).toBe(2);
  });
});

describe('the class fix the one funnel brought — noncombat lifelink and deathtouch', () => {
  it('a lifelink creature that fights gains its controller life (CR 702.15b says damage, not combat damage)', () => {
    const linker = creature(1, 'A', 2, 2, { lifelink: true });
    const other = creature(2, 'B', 1, 5);
    const state = board([linker, other]);
    const events = run('fight', state, linker, [2]);
    expect(state.players.A.life).toBe(22);
    expect(events).toContainEqual({ type: 'gainLife', player: 'A', amount: 2 });
  });

  it('a deathtouch creature that fights marks its victim for the CR 702.2b destruction', () => {
    const toucher = creature(1, 'A', 1, 1, { deathtouch: true });
    const big = creature(2, 'B', 1, 9);
    const state = board([toucher, big]);
    run('fight', state, toucher, [2]);
    expect(big.markedByDeathtouch).toBe(true);
  });

  it('a toxic creature that FIGHTS gives no poison — toxic is combat damage only (CR 702.164c)', () => {
    const toxic = creature(1, 'A', 2, 2, { toxic: 2 });
    const other = creature(2, 'B', 1, 5);
    const state = board([toxic, other]);
    run('fight', state, toxic, [2]);
    expect(poisonOf(state.players.B)).toBe(0);
  });

  it('a toxic source dealing NONCOMBAT damage to a player gives no poison — the row reads `combat`', () => {
    // The sabotage anchor for toxic: the fight above only ever reaches the
    // creature row, so a toxic rule that forgot the word "combat" would pass it.
    // "~ deals 2 damage to target player" from a toxic creature is the player
    // row with combat=false, and that is the one CR 702.164c excludes.
    const toxic = creature(1, 'A', 2, 2, { toxic: 2 });
    const state = board([toxic]);
    run('dealDamage', state, toxic, ['B'], { amount: 2 });
    expect(state.players.B.life).toBe(18);
    expect(poisonOf(state.players.B)).toBe(0);
  });

  it('`dealDamageToEach` on players now emits `damageDealt` for its player half', () => {
    const state = board([]);
    const source = { instanceId: 50, controller: 'A', def: { id: 's', name: 'Sweeper', types: ['sorcery'] } };
    const events = run('dealDamageToEach', state, source, [], { amount: 2, opponents: true });
    expect(state.players.B.life).toBe(18);
    expect(events).toContainEqual({ type: 'damageDealt', source: 50, target: 'B', amount: 2, combat: false });
  });
});

describe('proliferate’s player half (CR 701.34a — "permanents and/or players")', () => {
  it('offers only POISONED players, and each chosen one gets one more counter', () => {
    const state = board([]);
    state.players.B.poison = 3;
    let offered: PlayerId[] = [];
    let askedForCards = false;
    const source = { instanceId: 50, controller: 'A', def: { id: 's', name: 'Spread', types: ['instant'] } };
    const events = run(
      'proliferate',
      state,
      source,
      [],
      {},
      {
        chooseCards() {
          askedForCards = true;
          return [];
        },
        choosePlayers(request: { candidates: PlayerId[] }) {
          offered = request.candidates;
          return offered;
        },
      },
    );
    expect(askedForCards).toBe(false); // no countered permanent → no permanent question
    expect(offered).toEqual(['B']);
    expect(poisonOf(state.players.B)).toBe(4);
    expect(poisonOf(state.players.A)).toBe(0);
    expect(events).toContainEqual({ type: 'poisonChanged', player: 'B', delta: 1, to: 4 });
  });

  it('a PARKED player question mutates nothing — ask everything first, then write', () => {
    const countered = creature(1, 'A', 1, 1);
    (countered.counters as Record<string, number>)['+1/+1'] = 1;
    const state = board([countered]);
    state.players.B.poison = 1;
    run(
      'proliferate',
      state,
      { instanceId: 50, controller: 'A', def: { id: 's', name: 'Spread', types: ['instant'] } },
      [],
      {},
      {
        chooseCards: () => [1],
        choosePlayers: () => undefined, // parked
      },
    );
    expect((countered.counters as Record<string, number>)['+1/+1']).toBe(1);
    expect(poisonOf(state.players.B)).toBe(1);
  });
});
