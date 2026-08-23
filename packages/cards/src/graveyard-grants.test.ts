/**
 * SNAPCASTER MAGE, end to end — the compiler half and the engine half of
 * "granting flashback to a card in a graveyard".
 *
 * This is the card the `STUBBED_MECHANICS` list named for two engine systems at
 * once (targeting a graveyard card; a continuous effect on a non-battlefield
 * card), so the bar for un-stubbing it is that the WHOLE printed card plays:
 * flash timing, the ETB aimed as it goes on the stack, the granted cost being
 * the target's own mana cost, the recast, and the exile that follows it.
 *
 * The failure modes pinned alongside the happy path, because each one is a way
 * the card could look implemented and not be:
 *   - the ETB aimed at a card that LEFT the graveyard in response does nothing;
 *   - the grant is gone after end of turn, so the recast window really is one turn;
 *   - a creature or an opponent's spell in a graveyard is never a legal target;
 *   - the granted recast EXILES (CR 702.34a), so the card cannot be looped.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  flashbackCostOf,
  generateLegalActions,
  hasCardGrants,
  type CardDefinition,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { compileCard, type CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';
import { STUBBED_MECHANICS } from './index.js';

/** Snapcaster's real printed record, as the importer hands it over. */
function snapcasterRecord(oracleText?: string): CompilableCard {
  return {
    id: 'test-snapcaster',
    name: 'Snapcaster Mage',
    manaCost: { generic: 1, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Wizard'] },
    oracleText:
      oracleText ??
      'Flash\nWhen this creature enters, target instant or sorcery card in your graveyard gains flashback until end of turn. The flashback cost is equal to its mana cost. (You may cast that card from your graveyard for its flashback cost. Then exile it.)',
    power: 2,
    toughness: 1,
    keywords: ['Flash'],
  };
}

describe('compiling the flashback GRANT', () => {
  it('compiles Snapcaster Mage COMPLETE — flash, the aimed ETB, and the grant', () => {
    const result = compileCard(snapcasterRecord());
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.matchedRules).toContain('trigger-etb');

    const trigger = result.definition.triggers?.[0];
    expect(result.definition.keywords?.flash).toBe(true);
    expect(trigger?.condition.on).toBe('etb');
    // The ability is AIMED — targets are chosen as it goes on the stack, which
    // is the half that makes it a real card rather than an auto-picked one.
    expect(trigger?.targets).toBe('instantOrSorceryInYourGraveyard');
    expect(trigger?.effects[0]).toEqual({
      primitive: 'grantFlashback',
      params: { targets: 'instantOrSorceryInYourGraveyard', cost: 'itsManaCost' },
    });
  });

  it('is no longer on the stubbed list', () => {
    expect(STUBBED_MECHANICS.map((s) => s.card)).not.toContain('Snapcaster Mage');
  });

  it('carries the whole printed card in the curated pool', () => {
    const pooled = CARD_POOL.find((c) => c.name === 'Snapcaster Mage');
    expect(pooled?.keywords?.flash).toBe(true);
    expect(pooled?.triggers?.[0]?.targets).toBe('instantOrSorceryInYourGraveyard');
  });

  it('still refuses a grant whose cost clause is missing', () => {
    // Without "the flashback cost is equal to its mana cost" the line does not
    // say what the recast costs — and a free recast would be strictly better
    // than the printed card, so the compiler must report rather than guess.
    const result = compileCard(
      snapcasterRecord(
        'Flash\nWhen this creature enters, target instant or sorcery card in your graveyard gains flashback until end of turn.',
      ),
    );
    expect(result.status).toBe('incomplete');
  });
});

// --- the engine half, with this package's real primitives ------------------------

/** A plain instant with no printed flashback — the natural grant target. */
const SHOCKBOLT: CardDefinition = {
  id: 'test-shockbolt',
  name: 'Test Bolt',
  types: ['instant'],
  cost: { R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 2 } }],
};

/** A creature card in the graveyard — never a legal target for this ability. */
const CORPSE: CardDefinition = {
  id: 'test-corpse',
  name: 'Test Corpse',
  types: ['creature'],
  cost: { G: 1 },
  power: 1,
  toughness: 1,
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
  const island = getByName('Island');
  const created = createGame({
    seed: 0x50a9,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deck(island), B: deck(island) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

/** Put a fresh instance of `def` into a zone by hand (test-position building). */
function place(
  state: GameState,
  player: 'A' | 'B',
  zone: 'hand' | 'graveyard',
  def: CardDefinition,
): number {
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

/** Enough mana for anything these tests cast. */
function fund(state: GameState): void {
  state.players.A.manaPool = { W: 0, U: 2, B: 0, R: 1, G: 0, C: 4 };
}

/** Resolve everything on the stack, answering nothing (all choices are trivial). */
function settle(state: GameState, reg: ReturnType<typeof buildRegistry>): GameState {
  let next = state;
  for (let i = 0; i < 12 && next.stack.length > 0 && !next.pendingChoice; i++) next = pass(next, reg);
  return next;
}

describe('Snapcaster Mage played through the real engine + primitives', () => {
  it('grants flashback to a graveyard instant, which is then cast and EXILED', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const snapcaster = getByName('Snapcaster Mage');
    const bolt = place(state, 'A', 'graveyard', SHOCKBOLT);
    const snap = place(state, 'A', 'hand', snapcaster);
    fund(state);

    // The bolt is uncastable from the graveyard before the ETB — the control.
    expect(
      generateLegalActions(state, DEFAULT_RULES).some(
        (a) => a.kind === 'castSpell' && a.fromZone === 'graveyard',
      ),
    ).toBe(false);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: snap }, reg);
    state = settle(state, reg);

    // One legal target, so the engine aims it without stopping the game.
    const granted = state.players.A.graveyard.find((c) => c.instanceId === bolt)!;
    expect(flashbackCostOf(state, granted)).toEqual(SHOCKBOLT.cost);

    // And the engine now OFFERS the recast, for the card's own mana cost.
    fund(state);
    const offer = generateLegalActions(state, DEFAULT_RULES).find(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> =>
        a.kind === 'castSpell' && a.fromZone === 'graveyard' && a.instanceId === bolt,
    );
    expect(offer, 'the engine should offer the granted flashback cast').toBeDefined();

    const lifeBefore = state.players.B.life;
    state = act(state, { ...offer!, targets: ['B'] }, reg);
    state = settle(state, reg);

    expect(state.players.B.life).toBe(lifeBefore - 2);
    // CR 702.34a — a spell cast from the graveyard is exiled as it leaves the
    // stack, so a granted recast cannot be looped.
    expect(state.players.A.exile.map((c) => c.instanceId)).toContain(bolt);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).not.toContain(bolt);
  });

  it('has nothing to aim at when the graveyard holds only a creature', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    place(state, 'A', 'graveyard', CORPSE);
    const snap = place(state, 'A', 'hand', getByName('Snapcaster Mage'));
    fund(state);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: snap }, reg);
    state = settle(state, reg);

    // The 2/1 still arrives; the ability simply left the stack for want of a
    // target (CR 603.3d), granting nothing.
    expect(state.battlefield.some((c) => c.def.name === 'Snapcaster Mage')).toBe(true);
    expect(hasCardGrants(state)).toBe(false);
  });

  it('cannot aim at an instant in the OPPONENT graveyard', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const theirs = place(state, 'B', 'graveyard', SHOCKBOLT);
    const snap = place(state, 'A', 'hand', getByName('Snapcaster Mage'));
    fund(state);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: snap }, reg);
    state = settle(state, reg);

    expect(hasCardGrants(state)).toBe(false);
    expect(flashbackCostOf(state, state.players.B.graveyard.find((c) => c.instanceId === theirs)!)).toBeUndefined();
  });

  it('grants nothing when its target leaves the graveyard in response', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const bolt = place(state, 'A', 'graveyard', SHOCKBOLT);
    const snap = place(state, 'A', 'hand', getByName('Snapcaster Mage'));
    fund(state);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: snap }, reg);
    // Resolve the creature so the ETB is on the stack, aimed at the bolt…
    state = pass(pass(state, reg), reg);
    expect(state.stack.some((o) => o.kind === 'trigger')).toBe(true);

    // …then the bolt leaves the graveyard before the ability resolves.
    const card = state.players.A.graveyard.find((c) => c.instanceId === bolt)!;
    state.players.A.graveyard = state.players.A.graveyard.filter((c) => c.instanceId !== bolt);
    card.zone = 'exile';
    state.players.A.exile.push(card);

    state = settle(state, reg);
    expect(hasCardGrants(state)).toBe(false);
    expect(flashbackCostOf(state, card)).toBeUndefined();
  });

  it('grants only until end of turn — the recast window is one turn wide', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const bolt = place(state, 'A', 'graveyard', SHOCKBOLT);
    const snap = place(state, 'A', 'hand', getByName('Snapcaster Mage'));
    fund(state);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: snap }, reg);
    state = settle(state, reg);
    expect(hasCardGrants(state)).toBe(true);

    const turn = state.turnNumber;
    for (let i = 0; i < 100 && state.turnNumber === turn && !state.gameOver; i++) state = pass(state, reg);

    expect(state.turnNumber).toBeGreaterThan(turn);
    expect(hasCardGrants(state)).toBe(false);
    expect(flashbackCostOf(state, state.players.A.graveyard.find((c) => c.instanceId === bolt)!)).toBeUndefined();
  });
});
