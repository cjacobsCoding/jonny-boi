/**
 * Pool-loading tests + end-to-end integration tests that build a real engine via
 * `createEngine`/`createGame` with this package's registry and actually cast
 * cards from the curated pool, asserting the resulting state and events.
 *
 * Determinism: every game is created with a fixed seed.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CardDefinition, CardInstance, GameState, PlayerId } from '@jonny-boi/core';
import { createGame, createEngine, effectivePower, effectiveToughness, indexContinuous, NO_MOD } from '@jonny-boi/core';
import {
  buildRegistry,
  CORE_PRIMITIVE_IDS,
  getCardDefinition,
  getCardWithRegistry,
  loadCardPool,
} from './index.js';
import { CARD_POOL, CURATED_CARD_POOL } from '../data/pool.js';
import { EXPANDED_CARD_POOL } from '../data/expanded-pool.js';

const SEED = 1234;
/** Hand-authored cards (`CURATED_CARD_POOL`) — the reviewed-against-engine set. */
const EXPECTED_CURATED_SIZE = 32;
/** Cards the Oracle compiler built faithfully (`EXPANDED_CARD_POOL`). */
const EXPECTED_COMPILED_SIZE = 521;
const EXPECTED_POOL_SIZE = EXPECTED_CURATED_SIZE + EXPECTED_COMPILED_SIZE;

// --- pool loading + validation -------------------------------------------------

describe('card pool loading', () => {
  it(`loads all ${EXPECTED_POOL_SIZE} pool cards (authored + compiled)`, () => {
    const pool = loadCardPool({ onWarn: () => {} });
    expect(pool.cards).toHaveLength(EXPECTED_POOL_SIZE);
    expect(CURATED_CARD_POOL).toHaveLength(EXPECTED_CURATED_SIZE);
    expect(EXPANDED_CARD_POOL).toHaveLength(EXPECTED_COMPILED_SIZE);
  });

  it('the two halves are disjoint — a compiled card never shadows an authored one', () => {
    const authored = new Set(CURATED_CARD_POOL.map((card) => card.name));
    for (const card of EXPANDED_CARD_POOL) {
      expect(authored.has(card.name), `${card.name} is authored AND compiled`).toBe(false);
    }
  });

  it('every effect ref resolves to a registered primitive (no unsupported refs)', () => {
    const pool = loadCardPool({ onWarn: () => {} });
    expect(pool.unsupportedRefs).toEqual([]);
  });

  it('the registry registers exactly the package primitive ids', () => {
    const registry = buildRegistry();
    for (const id of CORE_PRIMITIVE_IDS) expect(registry.has(id)).toBe(true);
  });

  it('every card id is a unique Scryfall-style id and looks up by id and name', () => {
    const pool = loadCardPool({ onWarn: () => {} });
    const ids = new Set(pool.cards.map((c) => c.id));
    expect(ids.size).toBe(pool.cards.length);
    for (const c of pool.cards) {
      expect(pool.get(c.id)).toBe(c);
      expect(pool.getByName(c.name)).toBe(c);
    }
  });

  it('warns (does not throw) on a card with an unknown primitive ref', () => {
    const warn = vi.fn();
    const pool = loadCardPool({ onWarn: warn, knownPrimitiveIds: [] }); // pretend nothing is registered
    expect(pool.cards).toHaveLength(EXPECTED_POOL_SIZE); // still loads
    expect(pool.unsupportedRefs.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
  });

  it('getCardWithRegistry returns a playable bundle', () => {
    const bolt = getCardDefinition(boltId());
    expect(bolt).toBeDefined();
    const bundle = getCardWithRegistry(bolt!.id);
    expect(bundle?.card.name).toBe('Lightning Bolt');
    expect(bundle?.registry.has('dealDamage')).toBe(true);
  });

  it('basic lands and vanilla creatures need zero effect refs', () => {
    const forest = getByName('Forest');
    expect(forest.effects ?? []).toHaveLength(0);
    expect(forest.produces).toContain('G');
    const serra = getByName('Serra Angel');
    expect(serra.effects ?? []).toHaveLength(0);
    expect(serra.keywords?.flying).toBe(true);
  });
});

// --- helpers to look cards up by name -----------------------------------------

function getByName(name: string): CardDefinition {
  const c = CARD_POOL.find((x) => x.name === name);
  if (!c) throw new Error(`pool missing ${name}`);
  return c;
}
function boltId(): string {
  return getByName('Lightning Bolt').id;
}

// --- test driver: place a card in hand + give a main-phase position ------------

/** Push a fresh hand instance of `def` for `player`, returning its id. */
function giveHand(state: GameState, player: PlayerId, def: CardDefinition): number {
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

/** Push a fresh battlefield permanent for `player`, returning its id. */
function giveBattlefield(state: GameState, player: PlayerId, def: CardDefinition): number {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
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
  state.battlefield.push(inst);
  return inst.instanceId;
}

/** Fill the active player's mana pool so casting never fails on mana. */
function floodMana(state: GameState): void {
  state.players[state.activePlayer].manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
}

/** Resolve the top of the stack by both players passing priority. */
function resolveStack(engine: ReturnType<typeof createEngine>, state: GameState): GameState {
  let s = state;
  // Active passes, then opponent passes → top resolves.
  for (let i = 0; i < 2; i++) {
    const res = engine.applyAction(s, { kind: 'passPriority', player: s.priorityPlayer });
    s = res.state;
  }
  return s;
}

// --- integration: real engine, real cast --------------------------------------

describe('integration — casting pool cards through createEngine', () => {
  it('Lightning Bolt at a 3/3 kills it', () => {
    const registry = buildRegistry();
    const { state } = createGame({
      seed: SEED,
      decks: {
        A: { cards: Array.from({ length: 40 }, () => getByName('Mountain')) },
        B: { cards: Array.from({ length: 40 }, () => getByName('Forest')) },
      },
      registry,
    });
    const engine = createEngine(undefined, registry);
    let s = state;
    floodMana(s);
    const targetId = giveBattlefield(s, 'B', getByName('Serra Angel')); // 4/4 — survives 3
    const bear: CardDefinition = { id: 'x-3-3', name: 'X 3/3', types: ['creature'], power: 3, toughness: 3, cost: { generic: 3 } };
    const dyingId = giveBattlefield(s, 'B', bear);
    const boltId2 = giveHand(s, 'A', getByName('Lightning Bolt'));

    const cast = engine.applyAction(s, { kind: 'castSpell', player: 'A', instanceId: boltId2, targets: [dyingId] });
    s = cast.state;
    expect(cast.events.some((e) => e.type === 'spellCast')).toBe(true);
    s = resolveStack(engine, s);

    // The 3/3 is gone (destroyed by SBA after 3 marked damage); the 4/4 survives.
    expect(s.battlefield.find((c) => c.instanceId === dyingId)).toBeUndefined();
    expect(s.battlefield.find((c) => c.instanceId === targetId)).toBeDefined();
  });

  it('Lightning Bolt to the face drops the opponent to 17', () => {
    const registry = buildRegistry();
    const { state } = createGame({
      seed: SEED,
      decks: {
        A: { cards: Array.from({ length: 40 }, () => getByName('Mountain')) },
        B: { cards: Array.from({ length: 40 }, () => getByName('Forest')) },
      },
      registry,
    });
    const engine = createEngine(undefined, registry);
    let s = state;
    floodMana(s);
    const boltId2 = giveHand(s, 'A', getByName('Lightning Bolt'));
    s = engine.applyAction(s, { kind: 'castSpell', player: 'A', instanceId: boltId2, targets: ['B'] }).state;
    s = resolveStack(engine, s);
    expect(s.players.B.life).toBe(17);
  });

  it('a draw spell (Brainstorm) grows the caster hand by 3', () => {
    const registry = buildRegistry();
    const { state } = createGame({
      seed: SEED,
      decks: {
        A: { cards: Array.from({ length: 40 }, () => getByName('Island')) },
        B: { cards: Array.from({ length: 40 }, () => getByName('Island')) },
      },
      registry,
    });
    const engine = createEngine(undefined, registry);
    let s = state;
    floodMana(s);
    const handBefore = s.players.A.hand.length;
    const bsId = giveHand(s, 'A', getByName('Brainstorm'));
    s = engine.applyAction(s, { kind: 'castSpell', player: 'A', instanceId: bsId, targets: [] }).state;
    s = resolveStack(engine, s);
    // +3 drawn, -1 the Brainstorm itself left the hand to the stack/graveyard.
    expect(s.players.A.hand.length).toBe(handBefore + 3);
  });

  it('Giant Growth pumps a creature via the until-EOT layer (no permanent counter)', () => {
    const registry = buildRegistry();
    const { state } = createGame({
      seed: SEED,
      decks: {
        A: { cards: Array.from({ length: 40 }, () => getByName('Forest')) },
        B: { cards: Array.from({ length: 40 }, () => getByName('Forest')) },
      },
      registry,
    });
    const engine = createEngine(undefined, registry);
    let s = state;
    floodMana(s);
    const bear: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2, cost: { generic: 2 } };
    const bearId = giveBattlefield(s, 'A', bear);
    const ggId = giveHand(s, 'A', getByName('Giant Growth'));
    s = engine.applyAction(s, { kind: 'castSpell', player: 'A', instanceId: ggId, targets: [bearId] }).state;
    s = resolveStack(engine, s);
    const pumped = s.battlefield.find((c) => c.instanceId === bearId)!;
    // The buff is a real until-EOT continuous effect, NOT a permanent +1/+1 counter.
    expect(pumped.counters['+1/+1']).toBeUndefined();
    const mod = indexContinuous(s).get(bearId) ?? NO_MOD;
    expect(effectivePower(pumped, mod)).toBe(5);
    expect(effectiveToughness(pumped, mod)).toBe(5);
    expect(s.continuous.length).toBe(1);
  });
});
