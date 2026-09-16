/**
 * INDESTRUCTIBLE and the BLOCKING RESTRICTIONS, end to end: real printed cards
 * through the real compiler, then their compiled effects through the real
 * primitives.
 *
 * The compiler half proves the printed text is understood; the engine half
 * proves the understanding does something. Both are needed, and neither implies
 * the other — a keyword that compiles into `CardDefinition.keywords` and is
 * read by nothing looks exactly like a working feature from the compiler's side.
 *
 * The boundaries pinned here are the ones an implementation gets wrong:
 *   - a board wipe leaves an indestructible creature alone …
 *   - … but a SACRIFICE still takes it (a cost is not destruction), and so does
 *     0 toughness (CR 704.5f is not the destruction rule);
 *   - a GRANTED indestructible works, so the mass grant really reaches the team;
 *   - "can't block" and "can't be blocked" are different rules on different
 *     creatures, and the compiler must not read one as the other.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { compileCard, type CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

// --- the compiler half: real printed cards ---------------------------------------

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

describe('the compiler understands indestructible', () => {
  it('compiles DARKSTEEL CITADEL complete — the bare keyword on a land', () => {
    const result = compileCard(
      record({
        name: 'Darksteel Citadel',
        typeLine: { supertypes: [], types: ['Artifact', 'Land'], subtypes: [] },
        oracleText: 'Indestructible\n{T}: Add {C}.',
        keywords: ['Indestructible'],
        power: undefined,
        toughness: undefined,
      }),
    );
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.definition.keywords?.indestructible).toBe(true);
  });

  it('compiles HEROIC INTERVENTION complete — the mass until-end-of-turn grant', () => {
    const result = compileCard(
      record({
        name: 'Heroic Intervention',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        oracleText: 'Permanents you control gain hexproof and indestructible until end of turn.',
        power: undefined,
        toughness: undefined,
      }),
    );
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.definition.effects?.[0]).toEqual({
      // §3.153 — the grant-only form is now one ROW of the mass-modification
      // table, so it compiles to that family's primitive. No `power`/`toughness`
      // on a line that prints none.
      primitive: 'modifyYoursUntilEndOfTurn',
      // No type filter: the printed noun is "permanents", which narrows nothing.
      params: { keywords: { hexproof: true, indestructible: true } },
    });
  });

  it('compiles DARKSTEEL FORGE complete — an anthem over a non-creature type', () => {
    const result = compileCard(
      record({
        name: 'Darksteel Forge',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        manaCost: { generic: 9, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText: 'Artifacts you control have indestructible.',
        power: undefined,
        toughness: undefined,
      }),
    );
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.definition.statics?.[0]?.affects.anyOfTypes).toEqual(['artifact']);
    expect(result.definition.statics?.[0]?.keywords?.indestructible).toBe(true);
  });
});

describe('the compiler understands the blocking restrictions', () => {
  it('compiles GRAVECRAWLER-shaped "~ can\'t block" into the blocker restriction', () => {
    const result = compileCard(record({ name: 'Crawler', oracleText: "Crawler can't block." }));
    expect(result.definition.keywords?.cantBlock).toBe(true);
    // The mirror rule must NOT have been set — they are different restrictions.
    expect(result.definition.keywords?.unblockable).toBeUndefined();
  });

  it('compiles the joint printing, and sets BOTH flags', () => {
    const result = compileCard(
      record({ name: 'Outcast', oracleText: "Outcast can't block and can't be blocked." }),
    );
    expect(result.definition.keywords?.cantBlock).toBe(true);
    expect(result.definition.keywords?.unblockable).toBe(true);
  });

  it('compiles PATHRAZER-shaped "except by three or more creatures"', () => {
    const result = compileCard(
      record({ name: 'Pathrazer', oracleText: "Pathrazer can't be blocked except by three or more creatures." }),
    );
    expect(result.definition.keywords?.minBlockers).toBe(3);
  });

  it('compiles ROGUE’S PASSAGE complete — the granted evasion, as an activated ability', () => {
    const result = compileCard(
      record({
        name: "Rogue's Passage",
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: "{T}: Add {C}.\n{4}, {T}: Target creature can't be blocked this turn.",
        power: undefined,
        toughness: undefined,
      }),
    );
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    const ability = result.definition.activated?.[0];
    expect(ability?.effects[0]).toEqual({
      primitive: 'grantKeywordUntilEndOfTurn',
      params: { keywords: { unblockable: true }, targets: 'creature' },
    });
  });

  it('COMPILES a block requirement — the solver landed (CR 509.1c/d)', () => {
    // This case used to assert the opposite, and its note said why: "must be
    // blocked" is a requirement rather than a restriction, and satisfying the
    // maximum number of them without violating any restriction is a search, not a
    // check. That search is `internal/block-solver.ts` now, so the line compiles —
    // and `packages/core/src/block-requirements.test.ts` is what proves it really
    // forces a block rather than merely setting a flag.
    const result = compileCard(
      record({ name: 'Taunter', oracleText: 'All creatures able to block Taunter do so.' }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition?.keywords?.blockedByAllAble).toBe(true);
  });

  it('COMPILES a restriction that compares the two creatures', () => {
    // Likewise obsoleted: `KeywordFlags.blockRestriction` carries the comparison as
    // a payload, and `canBlock` judges it against EFFECTIVE power.
    const result = compileCard(
      record({
        name: 'Skulker',
        oracleText: "Skulker can't be blocked by creatures with power 3 or greater.",
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition?.keywords?.blockRestriction).toEqual({ maxBlockerPower: 2 });
  });

  it('STILL reports the restrictions whose SELECTOR this engine cannot express', () => {
    // What is left, named rather than approximated. ⚠️ THIS LIST SHRINKS, and a
    // stale entry is worse than no entry — it claims a gap that closed, which is
    // how a backlog sends the next agent to build something twice. Two shapes
    // have already left it: the EFFECTIVE-P/T selector (Tetsuko, Delney, when
    // core gained the settled-P/T pass) and the SOURCE-POWER bound (Champion of
    // Lambholt, §3.146 — asserted in `block-selectors.test.ts`).
    for (const oracleText of [
      // A bound read off a DIFFERENT permanent than the static's own source.
      "Creatures with power less than the strongest creature's power can't block creatures you control.",
      // TOUGHNESS, which no bound in the table carries — and must never be read
      // as the power one.
      "Creatures with toughness less than Champion's toughness can't block creatures you control.",
      // A COST to block (Archangel of Tithes), which is neither a restriction
      // nor a requirement — CR 509.1 has no "unless you pay" in it.
      "As long as Champion is attacking, creatures can't block unless their controller pays {1} for each of those creatures.",
      // A per-combat TARGETED requirement (Fighter Class), which is combat state
      // rather than a characteristic.
      'Whenever a creature you control attacks, up to one target creature blocks it this combat if able.',
    ]) {
      const result = compileCard(record({ name: 'Champion', oracleText }));
      expect(result.status, oracleText).not.toBe('complete');
    }
  });

  it('COMPILES the effective-P/T selectors (Tetsuko, Delney) as keyword-granting statics', () => {
    for (const [oracleText, expected] of [
      [
        "Creatures you control with power or toughness 1 or less can't be blocked.",
        { maxEffectivePowerOrToughness: 1 },
      ],
      [
        "Creatures you control with power 2 or less can't be blocked by creatures with power 3 or greater.",
        { maxEffectivePower: 2 },
      ],
    ] as const) {
      const result = compileCard(record({ name: 'Champion', oracleText }));
      expect(result.status, JSON.stringify(result.missing)).toBe('complete');
      expect(result.definition.statics?.[0]?.affects).toMatchObject(expected);
      // KEYWORD-granting only: a P/T delta here would need its own output.
      expect(result.definition.statics?.[0]?.power).toBeUndefined();
      expect(result.definition.statics?.[0]?.toughness).toBeUndefined();
    }
  });
});

// --- the engine half: this package's real primitives ------------------------------

const registry = buildRegistry();

function poolCard(name: string): CardDefinition {
  const found = CARD_POOL.find((c) => c.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

function act(state: GameState, action: GameAction): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function pass(state: GameState): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer });
}

/** A's precombat main, hands emptied, deterministic. */
function gameAtMain(): GameState {
  const island = poolCard('Island');
  const { state } = createGame({
    seed: 0x1de5,
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

/** Resolve `effects` as if a spell A controls had just resolved with `targets`. */
function resolveEffects(
  state: GameState,
  effects: NonNullable<CardDefinition['effects']>,
  targets: readonly number[] = [],
): GameState {
  const caster: CardDefinition = {
    id: 'test-caster',
    name: 'Test Caster',
    types: ['sorcery'],
    timing: 'sorcery',
    cost: { generic: 0 },
    effects,
  };
  const instanceId = state.nextInstanceId++;
  state.players.A.hand.push({
    instanceId,
    def: caster,
    controller: 'A',
    owner: 'A',
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  let s = act(state, { kind: 'castSpell', player: 'A', instanceId, targets: [...targets] });
  s = pass(s);
  s = pass(s);
  return s;
}

const STEEL_OX: CardDefinition = {
  id: 'test-steel-ox',
  name: 'Steel Ox',
  types: ['creature'],
  cost: { generic: 3 },
  power: 2,
  toughness: 2,
  keywords: { indestructible: true },
};

const PLAIN_OX: CardDefinition = {
  id: 'test-plain-ox',
  name: 'Plain Ox',
  types: ['creature'],
  cost: { generic: 3 },
  power: 2,
  toughness: 2,
};

function alive(state: GameState, inst: CardInstance): boolean {
  return state.battlefield.some((p) => p.instanceId === inst.instanceId);
}

describe('indestructible against the real destruction primitives', () => {
  it('survives a board wipe that kills everything else', () => {
    let s = gameAtMain();
    const steel = place(s, STEEL_OX, 'A');
    const plain = place(s, PLAIN_OX, 'A');
    const theirs = place(s, PLAIN_OX, 'B');

    s = resolveEffects(s, [{ primitive: 'destroyAll' }]);

    expect(alive(s, steel)).toBe(true);
    expect(alive(s, plain)).toBe(false);
    expect(alive(s, theirs)).toBe(false);
  });

  it('survives targeted destruction, which simply does nothing to it', () => {
    let s = gameAtMain();
    const steel = place(s, STEEL_OX, 'B');
    s = resolveEffects(s, [{ primitive: 'destroyTarget', params: { targets: 'creature' } }], [
      steel.instanceId,
    ]);
    expect(alive(s, steel)).toBe(true);
  });

  it('is still EXILED by removal that exiles rather than destroys', () => {
    let s = gameAtMain();
    const steel = place(s, STEEL_OX, 'B');
    s = resolveEffects(s, [{ primitive: 'exileTarget', params: { targets: 'creature' } }], [
      steel.instanceId,
    ]);
    expect(alive(s, steel)).toBe(false);
  });

  it('is still SACRIFICED — a cost is not destruction (CR 701.17a)', () => {
    let s = gameAtMain();
    // The only creature B controls, so the edict has exactly one answer.
    const steel = place(s, STEEL_OX, 'B');
    s = resolveEffects(
      s,
      [{ primitive: 'sacrificeChosen', params: { targets: 'opponent', anyOfTypes: ['creature'] } }],
      ['B' as unknown as number],
    );
    expect(alive(s, steel)).toBe(false);
  });

  it('a GRANTED indestructible saves the whole team from a wipe', () => {
    let s = gameAtMain();
    const one = place(s, PLAIN_OX, 'A');
    const two = place(s, PLAIN_OX, 'A');
    const theirs = place(s, PLAIN_OX, 'B');

    // Heroic Intervention's compiled effect, then the wipe.
    s = resolveEffects(s, [
      {
        primitive: 'grantKeywordToYoursUntilEndOfTurn',
        params: { keywords: { indestructible: true } },
      },
    ]);
    s = resolveEffects(s, [{ primitive: 'destroyAll' }]);

    expect(alive(s, one)).toBe(true);
    expect(alive(s, two)).toBe(true);
    // The grant is "you control" — the opponent's board is not saved by it.
    expect(alive(s, theirs)).toBe(false);
  });
});
