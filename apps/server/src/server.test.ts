/**
 * Server tests — drive the transport-free `Room`/`MessageRouter` layer directly
 * with `ClientMessage`s and assert on the `ServerMessage`s produced. No real
 * sockets: a `FakeConnection` just records what was sent. Deterministic (the room
 * is seeded) and fast.
 *
 * The load-bearing assertion is the masking-on-relay test: seat A's `state`
 * message must NEVER contain seat B's hand instance ids — we assert on the
 * SERIALIZED message, exactly what would go over the wire.
 */

import { PLAYER_IDS, PLAYER_IDS as _PLAYER_IDS, type GameAction, type PlayerId } from '@jonny-boi/core';
import {
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type DeckList,
  type ServerMessage,
} from '@jonny-boi/protocol';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { describe, expect, it } from 'vitest';
import { MessageRouter } from './handlers.js';
import type { Connection } from './room.js';
import { Room } from './room.js';
import { RoomManager } from './room-manager.js';

/** A fake connection: records every message the server sends it. */
class FakeConnection implements Connection {
  readonly id: string;
  readonly sent: ServerMessage[] = [];
  constructor(id: string) {
    this.id = id;
  }
  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  /** The most recent message of a given tag, or undefined. */
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]!.t === t) return this.sent[i] as Extract<ServerMessage, { t: T }>;
    }
    return undefined;
  }
  has(t: ServerMessage['t']): boolean {
    return this.sent.some((m) => m.t === t);
  }
  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * Does a serialized message mention this exact instance id?
 *
 * The trailing `(?!\d)` is essential: a bare `includes('"instanceId":7')` also matches
 * `"instanceId":75`, so the check used to report a leak whenever one seat's hand id was
 * a digit-prefix of one of the opponent's. That went unnoticed only because the room
 * used a hard-coded seed and therefore always dealt the same two hands.
 */
function mentionsInstanceId(wire: string, id: number): boolean {
  return new RegExp(`"instanceId":${id}(?!\\d)`).test(wire);
}

/** A legal decklist drawn from the bundled gauntlet (guaranteed pool-valid). */
function sampleDeck(index: number): DeckList {
  const d = SAMPLE_DECKS[index]!;
  return { name: d.name, cards: d.cards.map((c) => ({ cardId: c.cardId, count: c.count })) };
}

/** Build a manager + router and walk two players into a started game. */
function startedGame(): {
  manager: RoomManager;
  router: MessageRouter;
  a: FakeConnection;
  b: FakeConnection;
  code: string;
} {
  const manager = new RoomManager();
  const router = new MessageRouter(manager);
  const a = new FakeConnection('a');
  const b = new FakeConnection('b');

  router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
  const code = a.last('roomJoined')!.code;
  router.handle(b, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Bob' });

  router.handle(a, { t: 'chooseDeck', deck: sampleDeck(0) });
  router.handle(b, { t: 'chooseDeck', deck: sampleDeck(1) });
  router.handle(a, { t: 'setReady', ready: true });
  router.handle(b, { t: 'setReady', ready: true });

  // Both keep their opening hand → play begins.
  router.handle(a, { t: 'mulligan', keep: true });
  router.handle(b, { t: 'mulligan', keep: true });

  return { manager, router, a, b, code };
}

describe('lobby flow', () => {
  it('create → join produces a lobby with both players', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    const b = new FakeConnection('b');

    router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    const joined = a.last('roomJoined')!;
    expect(joined.yourSeat).toBe('A');
    expect(joined.spectator).toBe(false);

    router.handle(b, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code: joined.code, name: 'Bob' });
    expect(b.last('roomJoined')!.yourSeat).toBe('B');

    const lobby = b.last('lobby')!;
    expect(lobby.phase).toBe('deckSelect');
    expect(lobby.players.map((p) => p.seat).sort()).toEqual(['A', 'B']);
    expect(lobby.players.find((p) => p.seat === 'A')!.name).toBe('Alice');
  });

  it('rejects a protocol-version mismatch on create and join', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION + 1, name: 'Alice' });
    expect(a.last('error')!.code).toBe('protocolMismatch');
    expect(a.has('roomJoined')).toBe(false);
  });

  it('ACCEPTS an older client down to the compatibility floor', () => {
    // The server used to compare `===`, which made compatibility one-directional:
    // a new client could talk down to an old server, but an old CLIENT was locked
    // out of a new server — and it has no downgrade logic to recover with, because
    // that shipped in the newer version it doesn't have. Restarting the NAS onto a
    // newer bundle would then black out every stale cached PWA. Pin both ends.
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    for (let v = MIN_COMPATIBLE_PROTOCOL_VERSION; v <= PROTOCOL_VERSION; v++) {
      const conn = new FakeConnection(`v${v}`);
      router.handle(conn, { t: 'createRoom', protocolVersion: v, name: `V${v}` });
      expect(conn.has('roomJoined'), `protocol v${v} must be served`).toBe(true);
      expect(conn.has('error')).toBe(false);
    }
  });

  it('rejects versions outside the compatible range, including non-integers', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    for (const bad of [MIN_COMPATIBLE_PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1, 1.5, NaN]) {
      const conn = new FakeConnection(`bad${bad}`);
      router.handle(conn, { t: 'createRoom', protocolVersion: bad, name: 'Nope' });
      expect(conn.last('error')?.code, `v${bad} must be refused`).toBe('protocolMismatch');
      expect(conn.has('roomJoined')).toBe(false);
    }
  });

  it('a third connection becomes a spectator (roomFull → spectator)', () => {
    const { router, a, code } = startedGame();
    void a;
    const c = new FakeConnection('c');
    router.handle(c, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Carol' });
    const joined = c.last('roomJoined')!;
    expect(joined.spectator).toBe(true);
    expect(joined.yourSeat).toBeNull();
  });

  it('joining a bad code → roomNotFound', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    router.handle(a, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code: 'ZZZZZ', name: 'Alice' });
    expect(a.last('error')!.code).toBe('roomNotFound');
  });

  it('an illegal decklist → invalidDeck with a reason', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    router.handle(a, { t: 'chooseDeck', deck: { name: 'Tiny', cards: [{ cardId: 'Mountain', count: 5 }] } });
    const err = a.last('error')!;
    expect(err.code).toBe('invalidDeck');
    expect(err.message.length).toBeGreaterThan(0);
  });
});

describe('game start', () => {
  it('starts (mulliganPrompt then gameStarted) only when both are ready with decks', () => {
    const { a, b } = startedGame();
    expect(a.has('gameStarted')).toBe(true);
    expect(b.has('gameStarted')).toBe(true);
    expect(a.last('gameStarted')!.yourSeat).toBe('A');
    expect(b.last('gameStarted')!.yourSeat).toBe('B');
    // Each got an initial state push.
    expect(a.has('state')).toBe(true);
    expect(b.has('state')).toBe(true);
  });

  it('does not start until BOTH are ready', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    const b = new FakeConnection('b');
    router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    const code = a.last('roomJoined')!.code;
    router.handle(b, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Bob' });
    router.handle(a, { t: 'chooseDeck', deck: sampleDeck(0) });
    router.handle(b, { t: 'chooseDeck', deck: sampleDeck(1) });
    router.handle(a, { t: 'setReady', ready: true });
    // Only A ready → no game yet.
    expect(a.has('mulliganPrompt')).toBe(false);
  });
});

describe('priority enforcement', () => {
  it('a submitAction from the non-priority seat → notYourTurn', () => {
    const { b, router } = startedGame();
    // A is on the play and holds priority at the start. B acting → notYourTurn.
    b.clear();
    const pass: GameAction = { kind: 'passPriority', player: 'B' };
    router.handle(b, { t: 'submitAction', action: pass });
    expect(b.last('error')!.code).toBe('notYourTurn');
  });

  it('a client acting for the OTHER seat → notYourTurn', () => {
    const { a, router } = startedGame();
    a.clear();
    // A tries to pass priority *as B* — not allowed even though A holds priority.
    const pass: GameAction = { kind: 'passPriority', player: 'B' };
    router.handle(a, { t: 'submitAction', action: pass });
    expect(a.last('error')!.code).toBe('notYourTurn');
  });
});

describe('masked relay (anti-cheat)', () => {
  it('seat A never receives seat B hand instance ids over the wire', () => {
    const { a, b } = startedGame();
    const aState = a.last('state')!;
    const bState = b.last('state')!;

    // A's view: A's own hand is present; B's hand is masked to null + a count.
    expect(aState.view.players.A.hand).not.toBeNull();
    expect(aState.view.players.B.hand).toBeNull();
    expect(aState.view.players.B.handCount).toBeGreaterThan(0);

    // The load-bearing check: serialize A's message (what crosses the wire) and
    // confirm none of B's actual hand instance ids appear in it.
    const bHandIds = bState.view.players.B.hand!.map((c) => c.instanceId);
    expect(bHandIds.length).toBeGreaterThan(0);
    const wireA = JSON.stringify(aState);
    for (const id of bHandIds) {
      expect(mentionsInstanceId(wireA, id)).toBe(false);
    }

    // Symmetric: B never sees A's hand ids.
    const aHandIds = aState.view.players.A.hand!.map((c) => c.instanceId);
    const wireB = JSON.stringify(bState);
    for (const id of aHandIds) {
      expect(mentionsInstanceId(wireB, id)).toBe(false);
    }
  });

  it('legalActions + yourTurn are only populated for the priority holder', () => {
    const { a, b } = startedGame();
    const aState = a.last('state')!;
    const bState = b.last('state')!;
    // A is on the play and holds priority initially.
    expect(aState.yourTurn).toBe(true);
    expect(aState.legalActions.length).toBeGreaterThan(0);
    expect(bState.yourTurn).toBe(false);
    expect(bState.legalActions.length).toBe(0);
  });
});

describe('actions advance the game / illegal actions are rejected', () => {
  it('a legal action advances and each seat receives a fresh masked state', () => {
    const { a, b, router } = startedGame();
    a.clear();
    b.clear();
    const pass: GameAction = { kind: 'passPriority', player: 'A' };
    router.handle(a, { t: 'submitAction', action: pass });
    // Both seats got a new state after A's legal pass.
    expect(a.has('state')).toBe(true);
    expect(b.has('state')).toBe(true);
    // Priority moved to B.
    expect(a.last('state')!.view.priorityPlayer).toBe('B');
  });

  it('an illegal action → illegalAction error and the state is left intact', () => {
    const { a, router } = startedGame();
    a.clear();
    // Try to play a land that isn't in hand (nonsense instance id) while holding priority.
    const bogus: GameAction = { kind: 'playLand', player: 'A', instanceId: 999_999 };
    router.handle(a, { t: 'submitAction', action: bogus });
    expect(a.last('error')!.code).toBe('illegalAction');
    // The server re-sent A's (unchanged) state so the client resyncs.
    expect(a.last('state')).toBeDefined();
  });

  it('spectators cannot submit actions', () => {
    const { router, code } = startedGame();
    const c = new FakeConnection('c');
    router.handle(c, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Carol' });
    c.clear();
    const pass: GameAction = { kind: 'passPriority', player: 'A' };
    router.handle(c, { t: 'submitAction', action: pass });
    expect(c.last('error')!.code).toBe('notInRoom');
  });
});

describe('concede / gameOver / rematch', () => {
  it('concede ends the game with the opponent as winner', () => {
    const { a, b, router } = startedGame();
    router.handle(a, { t: 'concede' });
    const over = b.last('gameOver')!;
    expect(over.winner).toBe('B');
    expect(a.has('gameOver')).toBe(true);
  });

  it('rematch after a finished game starts a fresh game', () => {
    const { a, b, router } = startedGame();
    router.handle(a, { t: 'concede' });
    a.clear();
    b.clear();
    router.handle(a, { t: 'rematch' });
    // A fresh mulligan prompt arrives for the new game.
    expect(a.has('mulliganPrompt')).toBe(true);
    expect(b.has('mulliganPrompt')).toBe(true);
  });

  it('rematch before a game ends → illegalAction', () => {
    const { a, router } = startedGame();
    a.clear();
    router.handle(a, { t: 'rematch' });
    expect(a.last('error')!.code).toBe('illegalAction');
  });
});

describe('mulligan flow', () => {
  it('a no-keep redraws a fresh hand and re-prompts; both must settle before play', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    const b = new FakeConnection('b');
    router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    const code = a.last('roomJoined')!.code;
    router.handle(b, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Bob' });
    router.handle(a, { t: 'chooseDeck', deck: sampleDeck(0) });
    router.handle(b, { t: 'chooseDeck', deck: sampleDeck(1) });
    router.handle(a, { t: 'setReady', ready: true });
    router.handle(b, { t: 'setReady', ready: true });

    const firstPrompt = a.last('mulliganPrompt')!;
    a.clear();
    router.handle(a, { t: 'mulligan', keep: false });
    const reprompt = a.last('mulliganPrompt')!;
    expect(reprompt.mulligansTaken).toBe(1);
    // A keeps now, but B hasn't settled → no gameStarted yet.
    router.handle(a, { t: 'mulligan', keep: true });
    expect(a.has('gameStarted')).toBe(false);
    // B keeps → play begins.
    router.handle(b, { t: 'mulligan', keep: true });
    expect(a.has('gameStarted')).toBe(true);
    void firstPrompt;
  });
});

describe('disconnect / reconnect', () => {
  it('a seat drop notifies the opponent and the seat can be reclaimed by token', () => {
    const { a, b, code, router, manager } = startedGame();
    const room = manager.get(code)! as Room;
    const tokenA = room.tokenFor('A');

    b.clear();
    router.handleDisconnect(a);
    expect(b.has('opponentDisconnected')).toBe(true);

    // Reclaim seat A with its token via a fresh connection.
    const a2 = new FakeConnection('a2');
    const reclaimed = room.reconnect(a2, 'A', tokenA);
    expect(reclaimed).toBe('A');
    expect(a2.has('roomJoined')).toBe(true);
    expect(a2.has('state')).toBe(true);
    expect(b.has('opponentReconnected')).toBe(true);
  });

  it('a bad reconnect token is refused', () => {
    const { code, router, manager, a } = startedGame();
    void a;
    void router;
    const room = manager.get(code)! as Room;
    router.handleDisconnect(a);
    const a2 = new FakeConnection('a2');
    expect(room.reconnect(a2, 'A', 'not-the-token')).toBeNull();
  });
});

describe('robustness', () => {
  it('garbage / out-of-room messages never throw', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    // A submitAction with no room yet → notInRoom, no throw.
    expect(() => router.handle(a, { t: 'submitAction', action: { kind: 'passPriority', player: 'A' } as GameAction })).not.toThrow();
    expect(a.last('error')!.code).toBe('notInRoom');
    // ping → pong, always.
    router.handle(a, { t: 'ping' });
    expect(a.has('pong')).toBe(true);
  });

  it('the two seats are exactly the core PLAYER_IDS', () => {
    expect([...PLAYER_IDS]).toEqual([..._PLAYER_IDS]);
    const ids: PlayerId[] = ['A', 'B'];
    expect(ids).toEqual([...PLAYER_IDS]);
  });
});
