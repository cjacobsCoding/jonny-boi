/**
 * TOKEN-COUNT REPLACEMENTS — "if one or more tokens would be created under your
 * control, twice that many…" (Anointed Procession, Parallel Lives, Doubling
 * Season's token half, Mondrak, Ojer Taq's creature-only triple).
 *
 * What is pinned, in order of how quietly each would break:
 *  1. **The replacement sits at the ONE token funnel** (`ctx.createToken`), so
 *     every token-creating primitive doubles — including the legacy
 *     `createToken`, which used to hand-build instances past the funnel and
 *     would have silently dodged every Procession printed.
 *  2. **Controller scope**: your doubler doubles YOUR tokens only. An
 *     opponent's Procession changes nothing about yours.
 *  3. **Copies multiply** (two doublers = x4), the CR 616.1 consequence of two
 *     independent "twice" effects.
 *  4. **A printed "creature tokens" filter reads the definition being created**
 *     — Ojer's triple leaves a Treasure alone.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState, PlayerId } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 7777;

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 3, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

const PROCESSION: CardDefinition = compileCard(
  makeCard({
    name: 'Anointed Procession',
    oracleText:
      'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.',
  }),
).definition;

const OJER_LINE: CardDefinition = compileCard(
  makeCard({
    name: 'Ojer Line',
    oracleText:
      'If one or more creature tokens would be created under your control, three times that many of those tokens are created instead.',
  }),
).definition;

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const ISLAND = poolCard('Island');

let syntheticId = 99_000;

function instance(def: CardDefinition, player: PlayerId): CardInstance {
  return {
    instanceId: syntheticId++,
    def,
    controller: player,
    owner: player,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

/** A game at main phase; returns state + a way to run one effect primitive. */
function harness(): { state: GameState; reg: Registry } {
  const reg = buildRegistry(CARD_POOL);
  const { state: created } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => ISLAND) },
      B: { cards: Array.from({ length: 40 }, () => ISLAND) },
    },
  });
  let state = created;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) {
    const result = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, DEFAULT_RULES, reg);
    const rejected = result.events.find((e) => e.type === 'actionRejected');
    if (rejected) throw new Error(`setup rejection\n${dumpState(state)}`);
    state = result.state;
  }
  const source = instance(ISLAND, 'A');
  state.battlefield.push(source);
  return { state, reg };
}

function tokensNamed(state: GameState, name: string): number {
  return state.battlefield.filter((c) => c.def.name === name && c.def.isToken === true).length;
}

/**
 * Run `makeToken` through the REAL resolution path (applyEffectRef wires the
 * real `ctx.createToken`), so what is tested is the funnel, not a stub.
 */
async function runMakeToken(state: GameState, reg: Registry, params: Record<string, unknown>): Promise<void> {
  const { applyEffectRef } = await import('@jonny-boi/core');
  const source = state.battlefield[0]!;
  applyEffectRef(
    reg,
    { primitive: 'makeToken', params },
    { state, source, controller: 'A' },
    () => {},
    [],
  );
}

describe('the token-count replacement at the funnel', () => {
  it('doubles YOUR tokens under your own Procession', async () => {
    const { state, reg } = harness();
    state.battlefield.push(instance(PROCESSION, 'A'));
    await runMakeToken(state, reg, { count: 2, name: 'Soldier', power: 1, toughness: 1 });
    expect(tokensNamed(state, 'Soldier')).toBe(4);
  });

  it("an OPPONENT'S Procession changes nothing about yours", async () => {
    const { state, reg } = harness();
    state.battlefield.push(instance(PROCESSION, 'B'));
    await runMakeToken(state, reg, { count: 2, name: 'Soldier', power: 1, toughness: 1 });
    expect(tokensNamed(state, 'Soldier')).toBe(2);
  });

  it('two doublers multiply — CR 616.1 for two independent "twice" effects', async () => {
    const { state, reg } = harness();
    state.battlefield.push(instance(PROCESSION, 'A'), instance(PROCESSION, 'A'));
    await runMakeToken(state, reg, { count: 1, name: 'Soldier', power: 1, toughness: 1 });
    expect(tokensNamed(state, 'Soldier')).toBe(4);
  });

  it('a "creature tokens" triple reads the definition being created', async () => {
    const { state, reg } = harness();
    state.battlefield.push(instance(OJER_LINE, 'A'));
    await runMakeToken(state, reg, { count: 1, name: 'Warrior', power: 2, toughness: 2 });
    expect(tokensNamed(state, 'Warrior')).toBe(3);
  });
});
