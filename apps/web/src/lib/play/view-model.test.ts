/**
 * The board view-model's COMBAT and P/T facts (§3.119).
 *
 * Bug report 20260901_204957 — "Monastery Swiftspear killed my Gatecreeper Vine
 * even though it is a 1/2 and mine was a 0/2". The engine was right: a
 * Lightning Strike cast that turn had triggered prowess, so the Swiftspear was
 * a 2/3 in combat. The defect was VISIBILITY, and the view-model is where the
 * board learns what to show: the effective stats AND the printed ones, so a
 * tile can say "2/3 (+1/+1)" rather than a bare number the player reads as the
 * printed card.
 *
 * Bug report 20260901_204854 — "It needs to be way more clear who is attacking":
 * the view now carries each permanent's combat role, read off the engine's own
 * combat state.
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createGame, type CardDefinition, type CardInstance, type GameState, type PlayerId } from '@jonny-boi/core';
import { buildBoardView } from './view-model.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

function fresh(): GameState {
  const forest = card('Forest');
  return createGame({
    seed: 3,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
    },
    registry,
  }).state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
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
  state.battlefield.push(inst);
  return inst;
}

describe('effective vs printed power/toughness', () => {
  it('the reported board: a prowess-pumped Swiftspear reads 2/3 with a +1/+1 delta, printed 1/2', () => {
    const state = fresh();
    const swiftspear = place(state, card('Monastery Swiftspear'), 'B');
    const vine = place(state, card('Gatecreeper Vine'), 'A');
    // The prowess trigger's own continuous effect, exactly as the engine registers it.
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: swiftspear.instanceId,
      sourceInstanceId: swiftspear.instanceId,
      duration: 'endOfTurn',
      power: 1,
      toughness: 1,
    });
    const view = buildBoardView(state, 'A', NAMES);
    const shown = view.opponent.permanents.find((p) => p.instanceId === swiftspear.instanceId)!;
    expect(shown.power).toBe(2);
    expect(shown.toughness).toBe(3);
    expect(shown.printedPower).toBe(1);
    expect(shown.printedToughness).toBe(2);
    expect(shown.ptDelta).toEqual({ power: 1, toughness: 1 });
    // The unpumped 0/2 carries no delta at all — a badge on every creature would say nothing.
    const mine = view.self.permanents.find((p) => p.instanceId === vine.instanceId)!;
    expect(mine.ptDelta).toBeNull();
    expect(mine.printedToughness).toBe(2);
  });

  it('a +1/+1 counter is a delta too — the printed card is not what is on the table', () => {
    const state = fresh();
    const bear = place(state, card('Gatecreeper Vine'), 'A');
    bear.counters = { '+1/+1': 2 };
    const view = buildBoardView(state, 'A', NAMES);
    const shown = view.self.permanents.find((p) => p.instanceId === bear.instanceId)!;
    expect(shown.ptDelta).toEqual({ power: 2, toughness: 2 });
  });

  it('a non-creature has no P/T and no delta', () => {
    const state = fresh();
    const land = place(state, card('Forest'), 'A');
    const view = buildBoardView(state, 'A', NAMES);
    const shown = view.self.permanents.find((p) => p.instanceId === land.instanceId)!;
    expect(shown.ptDelta).toBeNull();
    expect(shown.printedPower).toBe(0);
  });
});

describe('combat roles', () => {
  it('marks attackers and blockers straight off the engine combat state, and nothing after combat', () => {
    const state = fresh();
    const attacker = place(state, card('Monastery Swiftspear'), 'B');
    const bystander = place(state, card('Goblin Guide'), 'B');
    const blocker = place(state, card('Gatecreeper Vine'), 'A');
    state.step = 'declareBlockers';
    state.combat = {
      attackers: [attacker.instanceId],
      blocks: { [blocker.instanceId]: attacker.instanceId },
      attackersDeclared: true,
      blockersDeclared: true,
    };
    const view = buildBoardView(state, 'A', NAMES);
    const by = (id: number) => [...view.self.permanents, ...view.opponent.permanents].find((p) => p.instanceId === id)!;
    expect(by(attacker.instanceId).attacking).toBe(true);
    expect(by(bystander.instanceId).attacking).toBe(false);
    expect(by(blocker.instanceId).blocking).toBe(attacker.instanceId);
    expect(by(attacker.instanceId).blocking).toBeNull();

    state.combat = null; // the turn moved on
    const later = buildBoardView(state, 'A', NAMES);
    expect(later.opponent.permanents.find((p) => p.instanceId === attacker.instanceId)!.attacking).toBe(false);
  });
});
