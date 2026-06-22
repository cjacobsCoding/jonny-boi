import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameState,
  ManaPool,
  PlayerId,
  PlayerState,
} from '@jonny-boi/core';
import {
  maskStateForSeat,
  assertNever,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from './index.js';

// --- minimal fixtures ----------------------------------------------------------

const emptyMana: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
const bear: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2, cost: { generic: 2 } };

function inst(id: number, owner: PlayerId, zone: CardInstance['zone']): CardInstance {
  return {
    instanceId: id,
    def: bear,
    controller: owner,
    owner,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

function player(id: PlayerId, handIds: number[], libIds: number[]): PlayerState {
  return {
    id,
    life: 20,
    manaPool: emptyMana,
    landsPlayedThisTurn: 0,
    hasLost: false,
    library: libIds.map((i) => inst(i, id, 'library')),
    hand: handIds.map((i) => inst(i, id, 'hand')),
    graveyard: [],
    exile: [],
    command: [],
  };
}

function makeState(): GameState {
  return {
    nextInstanceId: 1000,
    turnNumber: 3,
    activePlayer: 'A',
    priorityPlayer: 'A',
    step: 'precombatMain',
    players: {
      // A's secret card ids are 1xx; B's are 9xx so we can scan the serialized view for leaks.
      A: player('A', [101, 102, 103], [110, 111, 112, 113]),
      B: player('B', [901, 902], [910, 911, 912, 913, 914]),
    },
    battlefield: [inst(500, 'A', 'battlefield')],
    stack: [],
    continuous: [],
    combat: null,
    winner: null,
    gameOver: false,
    consecutivePasses: 0,
    seed: 1,
    rngState: 1,
  };
}

describe('maskStateForSeat', () => {
  it("reveals the viewer's own hand and hides the opponent's", () => {
    const view = maskStateForSeat(makeState(), 'A');
    expect(view.viewer).toBe('A');
    expect(view.players.A.hand).not.toBeNull();
    expect(view.players.A.hand).toHaveLength(3);
    expect(view.players.B.hand).toBeNull();
    // counts are always public
    expect(view.players.B.handCount).toBe(2);
    expect(view.players.B.libraryCount).toBe(5);
    expect(view.players.A.libraryCount).toBe(4);
    // public scalars + zones present for both
    expect(view.players.B.life).toBe(20);
    expect(view.battlefield).toHaveLength(1);
  });

  it('NEVER leaks the opponent hidden-card instance ids into the serialized view (anti-cheat)', () => {
    const json = JSON.stringify(maskStateForSeat(makeState(), 'A'));
    // B's hand (901/902) and library (910–914) ids must not appear anywhere in A's view.
    for (const hidden of [901, 902, 910, 911, 912, 913, 914]) {
      expect(json).not.toContain(String(hidden));
    }
    // A's own hand ids DO appear.
    expect(json).toContain('101');
  });

  it('is symmetric for seat B', () => {
    const view = maskStateForSeat(makeState(), 'B');
    expect(view.players.B.hand).toHaveLength(2);
    expect(view.players.A.hand).toBeNull();
    expect(view.players.A.handCount).toBe(3);
  });
});

describe('message contract', () => {
  it('has a protocol version', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });

  // Compile-time exhaustiveness: these switches fail to compile if a variant is
  // added without being handled, so adding a message tag can't silently slip through.
  it('every ClientMessage tag is handled', () => {
    const tagOf = (m: ClientMessage): string => {
      switch (m.t) {
        case 'createRoom':
        case 'joinRoom':
        case 'chooseDeck':
        case 'setReady':
        case 'mulligan':
        case 'submitAction':
        case 'concede':
        case 'rematch':
        case 'ping':
          return m.t;
        default:
          return assertNever(m);
      }
    };
    expect(tagOf({ t: 'ping' })).toBe('ping');
  });

  it('every ServerMessage tag is handled', () => {
    const tagOf = (m: ServerMessage): string => {
      switch (m.t) {
        case 'roomJoined':
        case 'lobby':
        case 'gameStarted':
        case 'mulliganPrompt':
        case 'state':
        case 'gameOver':
        case 'opponentDisconnected':
        case 'opponentReconnected':
        case 'error':
        case 'pong':
          return m.t;
        default:
          return assertNever(m);
      }
    };
    expect(tagOf({ t: 'pong' })).toBe('pong');
  });
});
