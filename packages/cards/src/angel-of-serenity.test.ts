/**
 * ANGEL OF SERENITY - the O-Ring at its largest, and the pool's only card that
 * targets across TWO ZONES at once.
 *
 * "When this creature enters, you may exile up to three other target creatures
 * from the battlefield and/or creature cards from graveyards. When this creature
 * leaves the battlefield, return the exiled cards to their owners' hands."
 *
 * Three things make it different from every other trigger in the pool, and each
 * is pinned below because each is a way it silently plays as a lesser card:
 *
 *  1. THREE targets, not one. Trigger targeting was single-target everywhere; an
 *     Angel that exiled one creature would be a strictly worse card.
 *  2. TWO zones in ONE target list - "up to three" is three in TOTAL, and a
 *     graveyard card is not a permanent, so the battlefield leave-funnel does not
 *     apply to it.
 *  3. "UP TO" - choosing none is a legal answer. A trigger that NEEDS a target is
 *     removed from the stack when none exists; this one must stay and resolve
 *     doing nothing, or the rest of its text would be silently deleted.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { isLegalTarget, legalTargetsFor } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

function byName(name: string): CardDefinition {
  const c = CARD_POOL.find((e) => e.name === name);
  if (!c) throw new Error('pool missing ' + name);
  return c;
}

const ANGEL = byName('Angel of Serenity');
const BEAR = byName('Grizzly Bears');
const WOLF = byName('Runeclaw Bear');

function emptyState(): GameState {
  const seat = () => ({
    life: 20,
    hand: [] as CardInstance[],
    library: [] as CardInstance[],
    graveyard: [] as CardInstance[],
    exile: [] as CardInstance[],
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    landsPlayedThisTurn: 0,
    hasLost: false,
    // `anyContinuousModification` reads both of these before it will even decide
    // whether a keyword index is needed; a fixture without them crashes the
    // enumerator rather than failing an assertion.
    command: [] as CardInstance[],
  });
  return {
    battlefield: [] as CardInstance[],
    players: { A: seat(), B: seat() },
    nextInstanceId: 100,
    stack: [],
    continuous: [],
    turnNumber: 1,
    step: 'precombatMain',
    activePlayer: 'A',
    priorityPlayer: 'A',
    gameOver: false,
  } as unknown as GameState;
}

function makeCard(
  state: GameState,
  def: CardDefinition,
  owner: PlayerId,
  zone: 'battlefield' | 'graveyard',
): InstanceId {
  const id = state.nextInstanceId++;
  const inst = {
    instanceId: id,
    def,
    controller: owner,
    owner,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  } as unknown as CardInstance;
  if (zone === 'battlefield') state.battlefield.push(inst);
  else state.players[owner].graveyard.push(inst);
  return id;
}

function runPrimitive(
  state: GameState,
  name: string,
  source: CardInstance,
  targets: readonly (InstanceId | PlayerId)[],
  params: Record<string, unknown>,
): void {
  const reg = buildRegistry();
  const fn = reg.get(name);
  expect(fn, name + ' must be registered').toBeDefined();
  fn!({
    state,
    source,
    controller: source.controller,
    targets,
    params,
    emit: () => {},
    ask: () => undefined,
  } as never);
}

describe('Angel of Serenity', () => {
  it('offers creatures from the battlefield AND both graveyards as one target list', () => {
    const s = emptyState();
    const angel = makeCard(s, ANGEL, 'A', 'battlefield');
    const onBoard = makeCard(s, BEAR, 'B', 'battlefield');
    const inMyYard = makeCard(s, WOLF, 'A', 'graveyard');
    const inTheirYard = makeCard(s, BEAR, 'B', 'graveyard');

    const offered = legalTargetsFor(s, 'creatureOnBattlefieldOrInGraveyard', 'A', ANGEL, angel);
    expect(offered).toContain(onBoard);
    expect(offered, 'it does not say YOUR graveyard').toContain(inMyYard);
    expect(offered).toContain(inTheirYard);
    expect(offered, 'an Angel that exiled itself would loop for ever').not.toContain(angel);
  });

  it('legality agrees with the offer for a graveyard card', () => {
    const s = emptyState();
    const inYard = makeCard(s, WOLF, 'B', 'graveyard');
    expect(isLegalTarget(s, 'creatureOnBattlefieldOrInGraveyard', inYard, 'A', ANGEL)).toBe(true);
  });

  it('exiles three across both zones, then hands them BACK when it leaves', () => {
    const s = emptyState();
    const angelId = makeCard(s, ANGEL, 'A', 'battlefield');
    const angel = s.battlefield.find((c) => c.instanceId === angelId)!;
    const onBoard = makeCard(s, BEAR, 'B', 'battlefield');
    const yardA = makeCard(s, WOLF, 'A', 'graveyard');
    const yardB = makeCard(s, BEAR, 'B', 'graveyard');

    runPrimitive(s, 'exileUntilLeaves', angel, [onBoard, yardA, yardB], {
      targets: 'creatureOnBattlefieldOrInGraveyard',
      max: 3,
    });

    expect(s.battlefield.some((c) => c.instanceId === onBoard), 'the battlefield one left').toBe(false);
    expect(s.players.A.graveyard.some((c) => c.instanceId === yardA), 'the graveyard one left').toBe(false);
    expect(s.players.B.exile.map((c) => c.instanceId).sort()).toEqual([onBoard, yardB].sort());
    expect(s.players.A.exile.map((c) => c.instanceId)).toEqual([yardA]);

    runPrimitive(s, 'returnExiledByThis', angel, [], { to: 'hand' });
    expect(s.players.A.hand.map((c) => c.instanceId)).toEqual([yardA]);
    expect(s.players.B.hand.map((c) => c.instanceId).sort()).toEqual([onBoard, yardB].sort());
    expect(s.players.A.exile.length + s.players.B.exile.length, 'exile is emptied').toBe(0);
    expect(
      s.battlefield.some((c) => c.instanceId === onBoard),
      'to HAND - returning it to the battlefield would be a different, better card',
    ).toBe(false);
  });

  it('takes at most three even when handed more', () => {
    const s = emptyState();
    const angelId = makeCard(s, ANGEL, 'A', 'battlefield');
    const angel = s.battlefield.find((c) => c.instanceId === angelId)!;
    const four = [0, 1, 2, 3].map(() => makeCard(s, BEAR, 'B', 'battlefield'));
    runPrimitive(s, 'exileUntilLeaves', angel, four, {
      targets: 'creatureOnBattlefieldOrInGraveyard',
      max: 3,
    });
    expect(s.players.B.exile.length).toBe(3);
    expect(s.battlefield.filter((c) => c.def.name === BEAR.name).length, 'the fourth stays').toBe(1);
  });

  it('is printed as "up to", so choosing none is legal', () => {
    const etb = (ANGEL.triggers ?? []).find((t) => t.condition.on === 'etb');
    expect(etb?.targetCount).toEqual({ min: 0, max: 3 });
    expect(etb?.targetsExcludeSelf, 'OTHER target creatures').toBe(true);
    const leaves = (ANGEL.triggers ?? []).find((t) => t.condition.on === 'leaves');
    expect(leaves, 'the return half must exist or this is unconditional removal').toBeDefined();
  });
});
