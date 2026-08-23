/**
 * Adversarial server tests — one per bug found in the network bug-pass.
 *
 * The live server is reachable by anyone with the URL and is UNAUTHENTICATED: every
 * frame here is one a stranger can send. These tests therefore assert the two things
 * that actually matter under those conditions:
 *   1. **Confidentiality** — no message, on any path, carries a seat's hidden cards to
 *      anyone else (the opposing seat, a spectator, or a reconnecting stranger).
 *   2. **Containment** — one hostile client can be refused, but can never crash the
 *      process, corrupt its room, or degrade any OTHER room.
 *
 * Like `server.test.ts` these drive the transport-free `Room`/`MessageRouter` layer
 * with `ClientMessage`s and read back the `ServerMessage`s, so the whole hostile flow
 * is exercised with no sockets.
 */

import { PLAYER_IDS, type CardInstance, type GameAction, type PlayerId } from '@jonny-boi/core';
import {
  collectInstanceIds,
  PROTOCOL_VERSION,
  type ClientMessage,
  type DeckList,
  type ServerMessage,
} from '@jonny-boi/protocol';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ROOM_GRACE_MS,
  MAX_DECK_ENTRY_COUNT,
  MAX_DECK_TOTAL_CARDS,
  MAX_MULLIGANS_PER_GAME,
  MAX_NAME_LENGTH,
  MAX_SPECTATORS_PER_ROOM,
} from './config.js';
import { MessageRouter } from './handlers.js';
import type { Connection } from './room.js';
import { Room } from './room.js';
import { RoomManager } from './room-manager.js';
import { parseClientMessage } from './validate.js';

/** A fake connection: records every message the server sends it. */
class FakeConnection implements Connection {
  readonly sent: ServerMessage[] = [];
  constructor(readonly id: string) {}
  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]!.t === t) return this.sent[i] as Extract<ServerMessage, { t: T }>;
    }
    return undefined;
  }
  has(t: ServerMessage['t']): boolean {
    return this.sent.some((m) => m.t === t);
  }
  /** EVERYTHING this connection has ever been sent, as it would cross the wire. */
  wire(): string {
    return JSON.stringify(this.sent);
  }
  clear(): void {
    this.sent.length = 0;
  }
}

function sampleDeck(index: number): DeckList {
  const d = SAMPLE_DECKS[index]!;
  return { name: d.name, cards: d.cards.map((c) => ({ cardId: c.cardId, count: c.count })) };
}

/*
 * ⚠️ There used to be a LOCAL `collectInstanceIds` here, and it was the weaker of
 * the repo's two copies: it recognised keys named exactly `instanceId`, and it
 * stopped descending as soon as it matched one. The engine names cards under a
 * dozen other keys (`sourceInstanceId`, `targets`, `attackTargets`, `blocks`,
 * `instanceIds` …), every one of which this file's strongest assertion walked
 * straight past — on the ONE path where a leak is a cheating vector rather than a
 * biased pilot.
 *
 * It now uses `@jonny-boi/protocol`'s, whose key vocabulary is derived from a
 * mapped type over every field of every `GameEvent` in core. Two copies of an
 * anti-cheat check is two checks that can disagree, and the weaker one is the one
 * that gets believed.
 */

/** Whether `id` appears ANYWHERE in everything this connection was ever sent. */
function mentionsInstanceId(conn: FakeConnection, id: number): boolean {
  return collectInstanceIds(conn.sent).has(id);
}

interface Table {
  manager: RoomManager;
  router: MessageRouter;
  a: FakeConnection;
  b: FakeConnection;
  code: string;
  room: Room;
}

/** Walk two players from create → join → decks → ready → both keep, into live play. */
function startedGame(): Table {
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
  router.handle(a, { t: 'mulligan', keep: true });
  router.handle(b, { t: 'mulligan', keep: true });
  return { manager, router, a, b, code, room: manager.get(code)! };
}

/**
 * The instance ids a seat is holding in hand right now, read from that seat's OWN
 * state message — i.e. exactly the ids nobody else may ever see.
 */
function handIdsOf(seatConn: FakeConnection, seat: PlayerId): number[] {
  const own = seatConn.last('state')!.view.players[seat].hand as readonly CardInstance[];
  return own.map((c) => c.instanceId);
}

// ---------------------------------------------------------------------------
// Anti-cheat: hidden information must not reach anyone else, on ANY path.
// ---------------------------------------------------------------------------

describe('anti-cheat: no hidden information leaves its seat', () => {
  it('no message EVER sent to a seat mentions the opponent hand — across the whole session', () => {
    const { a, b, router } = startedGame();
    // Play a few turns' worth of passes so state, log and gameOver paths all fire.
    for (let i = 0; i < 8; i++) {
      const priority = a.last('state')!.view.priorityPlayer;
      const conn = priority === 'A' ? a : b;
      router.handle(conn, { t: 'submitAction', action: { kind: 'passPriority', player: priority } as GameAction });
    }
    const aHidden = handIdsOf(a, 'A');
    const bHidden = handIdsOf(b, 'B');
    expect(aHidden.length).toBeGreaterThan(0);
    expect(bHidden.length).toBeGreaterThan(0);

    // The whole transcript each side received, not just its latest state message.
    for (const id of bHidden) expect(mentionsInstanceId(a, id)).toBe(false);
    for (const id of aHidden) expect(mentionsInstanceId(b, id)).toBe(false);
  });

  it('a spectator receives no hand contents and no mulligan prompt, ever', () => {
    const table = startedGame();
    const aHidden = handIdsOf(table.a, 'A');
    const bHidden = handIdsOf(table.b, 'B');

    const spy = new FakeConnection('spy');
    table.router.handle(spy, {
      t: 'joinRoom',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      name: 'Spy',
    });
    table.router.handle(table.a, {
      t: 'submitAction',
      action: { kind: 'passPriority', player: 'A' } as GameAction,
    });

    const view = spy.last('state')!.view;
    expect(view.players.A.hand).toBeNull();
    expect(view.players.B.hand).toBeNull();
    expect(spy.has('mulliganPrompt')).toBe(false);
    for (const id of [...aHidden, ...bHidden]) expect(mentionsInstanceId(spy, id)).toBe(false);
  });

  it('the mulligan prompt goes only to its own seat', () => {
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

    const aPromptIds = a.last('mulliganPrompt')!.hand.map((c) => c.instanceId);
    expect(aPromptIds.length).toBeGreaterThan(0);
    for (const id of aPromptIds) expect(mentionsInstanceId(b, id)).toBe(false);
  });

  it('a rejected action does not reveal whose cards an instance id belongs to', () => {
    const { a, b, router } = startedGame();
    const bHidden = handIdsOf(b, 'B');
    a.clear();
    // A holds priority and probes an instance id it knows is in B's hand.
    router.handle(a, {
      t: 'submitAction',
      action: { kind: 'castSpell', player: 'A', instanceId: bHidden[0]! } as GameAction,
    });
    const probed = a.last('error')!.message;
    a.clear();
    // ...and an id that exists nowhere at all.
    router.handle(a, {
      t: 'submitAction',
      action: { kind: 'castSpell', player: 'A', instanceId: 9_999_999 } as GameAction,
    });
    // Identical answers: the reply is not an oracle for the opponent's hand.
    expect(a.last('error')!.message).toBe(probed);
  });

  it('two rooms with identical decks do not deal the same game (no fixed seed)', () => {
    const openingOf = (): string => {
      const manager = new RoomManager();
      const router = new MessageRouter(manager);
      const a = new FakeConnection('a');
      const b = new FakeConnection('b');
      router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
      const code = a.last('roomJoined')!.code;
      router.handle(b, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Bob' });
      router.handle(a, { t: 'chooseDeck', deck: sampleDeck(0) });
      router.handle(b, { t: 'chooseDeck', deck: sampleDeck(0) });
      router.handle(a, { t: 'setReady', ready: true });
      router.handle(b, { t: 'setReady', ready: true });
      return a
        .last('mulliganPrompt')!
        .hand.map((c) => c.def.name)
        .join('|');
    };
    // A fixed seed made EVERY room deal the identical opening from the same decklist,
    // so a player could learn their own (and a known opponent's) draws by replaying.
    const openings = new Set([openingOf(), openingOf(), openingOf(), openingOf()]);
    expect(openings.size).toBeGreaterThan(1);
  });

  it('a seat reclaimed by reconnect sees only its OWN hand', () => {
    const table = startedGame();
    const tokenA = table.a.last('roomJoined')!.reconnectToken!;
    const bHidden = handIdsOf(table.b, 'B');
    table.router.handleDisconnect(table.a);

    const a2 = new FakeConnection('a2');
    table.router.handle(a2, {
      t: 'reconnect',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      seat: 'A',
      token: tokenA,
    });
    const view = a2.last('state')!.view;
    expect(view.players.A.hand).not.toBeNull();
    expect(view.players.B.hand).toBeNull();
    for (const id of bHidden) expect(mentionsInstanceId(a2, id)).toBe(false);
  });

  it("a seat's reconnect token is never sent to the other seat or to a spectator", () => {
    const table = startedGame();
    const tokenA = table.a.last('roomJoined')!.reconnectToken!;
    const tokenB = table.b.last('roomJoined')!.reconnectToken!;
    expect(tokenA).not.toBe(tokenB);

    const spy = new FakeConnection('spy');
    table.router.handle(spy, {
      t: 'joinRoom',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      name: 'Spy',
    });
    expect(spy.last('roomJoined')!.reconnectToken).toBeUndefined();
    expect(table.b.wire()).not.toContain(tokenA);
    expect(table.a.wire()).not.toContain(tokenB);
    expect(spy.wire()).not.toContain(tokenA);
    expect(spy.wire()).not.toContain(tokenB);
  });
});

// ---------------------------------------------------------------------------
// Authorization.
// ---------------------------------------------------------------------------

describe('authorization', () => {
  it('an action without a `player` field is refused (fail-closed), not passed to the engine', () => {
    const { a, router } = startedGame();
    a.clear();
    router.handle(a, { t: 'submitAction', action: { kind: 'passPriority' } as unknown as GameAction });
    expect(a.last('error')!.code).toBe('notYourTurn');
  });

  it('a stranger cannot reclaim a seat, and one seat token cannot claim the other seat', () => {
    const table = startedGame();
    const tokenA = table.a.last('roomJoined')!.reconnectToken!;
    table.router.handleDisconnect(table.a);
    table.router.handleDisconnect(table.b);

    // Seat A's token aimed at seat B — a token authorizes exactly ONE seat.
    const thief = new FakeConnection('thief');
    table.router.handle(thief, {
      t: 'reconnect',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      seat: 'B',
      token: tokenA,
    });
    expect(thief.last('error')!.code).toBe('notInRoom');
    expect(thief.has('state')).toBe(false);

    // A guessed token is refused too.
    table.router.handle(thief, {
      t: 'reconnect',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      seat: 'A',
      token: 'f'.repeat(tokenA.length),
    });
    expect(thief.has('state')).toBe(false);

    // The rightful holder still gets in afterwards.
    const a2 = new FakeConnection('a2');
    table.router.handle(a2, {
      t: 'reconnect',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      seat: 'A',
      token: tokenA,
    });
    expect(a2.last('roomJoined')!.yourSeat).toBe('A');
  });

  it('a live seat cannot be reclaimed out from under the player sitting in it', () => {
    const table = startedGame();
    const tokenA = table.a.last('roomJoined')!.reconnectToken!;
    const thief = new FakeConnection('thief');
    table.router.handle(thief, {
      t: 'reconnect',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      seat: 'A',
      token: tokenA,
    });
    expect(thief.last('error')!.code).toBe('notInRoom');
    expect(table.room.seatOf(table.a)).toBe('A');
  });

  it('a client in room 1 cannot act in room 2', () => {
    const one = startedGame();
    const intruder = new FakeConnection('intruder');
    // The intruder is a spectator of its OWN room; its messages route only there.
    one.router.handle(intruder, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Mallory' });
    intruder.clear();
    one.router.handle(intruder, {
      t: 'submitAction',
      action: { kind: 'passPriority', player: 'A' } as GameAction,
    });
    // Rejected by its own (unstarted) room; room one is untouched and still A's turn.
    expect(intruder.last('error')!.code).toBe('illegalAction');
    expect(one.a.last('state')!.view.priorityPlayer).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// Room lifecycle + resource safety.
// ---------------------------------------------------------------------------

describe('room lifecycle and resource safety', () => {
  it('one socket creating many rooms leaks none of them (MAX_ROOMS exhaustion)', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const mallory = new FakeConnection('mallory');
    const burst = 25;
    for (let i = 0; i < burst; i++) {
      router.handle(mallory, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Mallory' });
    }
    router.handleDisconnect(mallory);
    // Previously only the LAST room was pruned: the other 24 kept a connection that
    // had long since gone, so they were never empty and never collected — one socket
    // could permanently consume the server's whole room capacity.
    manager.pruneEmpty(Date.now() + EMPTY_ROOM_GRACE_MS);
    expect(manager.size).toBe(0);
  });

  it('leaving a room for another one tells the opponent, and does not disturb the first game', () => {
    const table = startedGame();
    table.b.clear();
    // A "leaves" by creating a fresh room on the same socket.
    table.router.handle(table.a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    expect(table.b.has('opponentDisconnected')).toBe(true);
    expect(table.room.seatOf(table.a)).toBeNull();
    // B's game is intact and still answers.
    table.b.clear();
    table.router.handle(table.b, { t: 'concede' });
    expect(table.b.last('gameOver')!.winner).toBe('A');
  });

  it('an empty room survives briefly (so both players can reconnect) then is reaped', () => {
    const table = startedGame();
    table.router.handleDisconnect(table.a);
    table.router.handleDisconnect(table.b);
    // Still there right after the drop — a shared-network blip must not destroy a match.
    expect(table.manager.size).toBe(1);
    table.manager.pruneEmpty(Date.now() + EMPTY_ROOM_GRACE_MS + 1);
    expect(table.manager.size).toBe(0);
  });

  it('a lobby drop frees the seat so the room stays joinable', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    const b = new FakeConnection('b');
    router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    const code = a.last('roomJoined')!.code;
    router.handle(b, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Bob' });
    router.handleDisconnect(b);
    // Before cards are dealt a seat holds nothing secret, so a newcomer may take it.
    // Otherwise a lobby drop stranded the remaining player in an unjoinable room.
    const c = new FakeConnection('c');
    router.handle(c, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Carol' });
    expect(c.last('roomJoined')!.yourSeat).toBe('B');
    expect(c.last('roomJoined')!.spectator).toBe(false);
  });

  it('an in-game drop does NOT free the seat (a stranger must not inherit a live hand)', () => {
    const table = startedGame();
    table.router.handleDisconnect(table.a);
    const stranger = new FakeConnection('stranger');
    table.router.handle(stranger, {
      t: 'joinRoom',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      name: 'Stranger',
    });
    const joined = stranger.last('roomJoined')!;
    expect(joined.spectator).toBe(true);
    expect(joined.yourSeat).toBeNull();
    expect(stranger.last('state')!.view.players.A.hand).toBeNull();
  });

  it('spectators are capped, and a refused joiner is not bound to the room', () => {
    const table = startedGame();
    for (let i = 0; i < MAX_SPECTATORS_PER_ROOM; i++) {
      const s = new FakeConnection(`spec${i}`);
      table.router.handle(s, {
        t: 'joinRoom',
        protocolVersion: PROTOCOL_VERSION,
        code: table.code,
        name: `Spec${i}`,
      });
      expect(s.last('roomJoined')!.spectator).toBe(true);
    }
    const overflow = new FakeConnection('overflow');
    table.router.handle(overflow, {
      t: 'joinRoom',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      name: 'TooMany',
    });
    expect(overflow.last('error')!.code).toBe('roomFull');
    expect(overflow.has('roomJoined')).toBe(false);
    // Not bound: a later message finds no room rather than reaching this one.
    overflow.clear();
    table.router.handle(overflow, { t: 'concede' });
    expect(overflow.last('error')!.message).toContain('join or create a room first');
  });

  it('a mulligan storm is capped instead of redrawing forever', () => {
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

    // Each "no keep" costs the server a reshuffle, a redraw and a fresh prompt.
    for (let i = 0; i < 500; i++) router.handle(a, { t: 'mulligan', keep: false });
    expect(a.last('mulliganPrompt')!.mulligansTaken).toBe(MAX_MULLIGANS_PER_GAME);
    // Capped means settled: B keeping is enough to start the game.
    router.handle(b, { t: 'mulligan', keep: true });
    expect(a.has('gameStarted')).toBe(true);
  });

  it('rematch into an absent opponent is refused instead of wedging the room', () => {
    const table = startedGame();
    table.router.handle(table.a, { t: 'concede' });
    table.router.handleDisconnect(table.b);
    table.a.clear();
    table.router.handle(table.a, { t: 'rematch' });
    // It used to restart into a mulligan phase the missing seat could never settle,
    // leaving the room permanently stuck with no game and no way back to the lobby.
    expect(table.a.last('error')!.code).toBe('illegalAction');
    expect(table.a.has('mulliganPrompt')).toBe(false);

    // Once B is back the rematch works.
    const tokenB = table.b.last('roomJoined')!.reconnectToken!;
    const b2 = new FakeConnection('b2');
    table.router.handle(b2, {
      t: 'reconnect',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      seat: 'B',
      token: tokenB,
    });
    table.router.handle(table.a, { t: 'rematch' });
    expect(table.a.has('mulliganPrompt')).toBe(true);
    expect(b2.has('mulliganPrompt')).toBe(true);
  });

  it('a drop during the mulligan step is survivable: reconnect re-issues the prompt', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    const b = new FakeConnection('b');
    router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    const code = a.last('roomJoined')!.code;
    const tokenA = a.last('roomJoined')!.reconnectToken!;
    router.handle(b, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Bob' });
    router.handle(a, { t: 'chooseDeck', deck: sampleDeck(0) });
    router.handle(b, { t: 'chooseDeck', deck: sampleDeck(1) });
    router.handle(a, { t: 'setReady', ready: true });
    router.handle(b, { t: 'setReady', ready: true });

    router.handleDisconnect(a);
    const a2 = new FakeConnection('a2');
    router.handle(a2, { t: 'reconnect', protocolVersion: PROTOCOL_VERSION, code, seat: 'A', token: tokenA });

    // The mulligan step is driven by `mulliganPrompt`. Reconnecting into only a
    // `state` left the client with no hand to answer, so its mulligan could never
    // settle and the room wedged forever with no game and no way back to the lobby.
    const prompt = a2.last('mulliganPrompt');
    expect(prompt).toBeDefined();
    expect(prompt!.hand.length).toBeGreaterThan(0);
    // ...and it is still only THIS seat's hand.
    expect(a2.has('state')).toBe(false);
    const bHidden = b.last('mulliganPrompt')!.hand.map((c) => c.instanceId);
    for (const id of bHidden) expect(mentionsInstanceId(a2, id)).toBe(false);

    // The match now proceeds normally.
    router.handle(a2, { t: 'mulligan', keep: true });
    router.handle(b, { t: 'mulligan', keep: true });
    expect(a2.has('gameStarted')).toBe(true);
    expect(a2.last('state')!.view.players.B.hand).toBeNull();
  });

  it('empty never-started rooms are reclaimed at once (capacity cannot be pinned)', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const mallory = new FakeConnection('mallory');
    for (let i = 0; i < 50; i++) {
      router.handle(mallory, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Mallory' });
    }
    router.handleDisconnect(mallory);
    // The reconnect grace period must not apply to a lobby that never dealt a card:
    // it held 50 rooms (scaled: all of MAX_ROOMS) alive for the whole window, so one
    // socket could refuse every legitimate createRoom indefinitely.
    manager.pruneEmpty();
    expect(manager.size).toBe(0);
  });

  it('a real match still gets its reconnect grace period', () => {
    const table = startedGame();
    table.router.handleDisconnect(table.a);
    table.router.handleDisconnect(table.b);
    // A dealt game is exactly what the grace window exists for — it must survive an
    // immediate sweep so both players can come back from a shared-network blip.
    table.manager.pruneEmpty();
    expect(table.manager.size).toBe(1);
    table.manager.pruneEmpty(Date.now() + EMPTY_ROOM_GRACE_MS + 1);
    expect(table.manager.size).toBe(0);
  });

  it('a concede is recorded in the state, not just announced', () => {
    const table = startedGame();
    table.router.handle(table.a, { t: 'concede' });
    // A spectator arriving after the concede must see a finished game, not a live one.
    const late = new FakeConnection('late');
    table.router.handle(late, {
      t: 'joinRoom',
      protocolVersion: PROTOCOL_VERSION,
      code: table.code,
      name: 'Late',
    });
    const view = late.last('state')!.view;
    expect(view.gameOver).toBe(true);
    expect(view.winner).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// Hostile input at the parse boundary.
// ---------------------------------------------------------------------------

describe('hostile input is refused at the wire boundary', () => {
  const garbage: string[] = [
    '',
    'not json at all',
    '[]',
    'null',
    '123',
    '"a string"',
    '{}',
    '{"t":42}',
    '{"t":"unknownTag"}',
    '{"t":"__proto__"}',
    '{"t":"createRoom"}',
    '{"t":"createRoom","protocolVersion":"1","name":"x"}',
    '{"t":"createRoom","protocolVersion":1,"name":123}',
    '{"t":"createRoom","protocolVersion":1,"name":""}',
    '{"t":"createRoom","protocolVersion":1,"name":"   "}',
    '{"t":"joinRoom","protocolVersion":1,"name":"x"}',
    '{"t":"setReady","ready":"yes"}',
    '{"t":"mulligan"}',
    '{"t":"submitAction"}',
    '{"t":"submitAction","action":[]}',
    '{"t":"submitAction","action":{"kind":123}}',
    '{"t":"chooseDeck","deck":{"name":"x","cards":"lots"}}',
    '{"t":"reconnect","protocolVersion":1,"code":"AAAAA","seat":"C","token":"aa"}',
    '{"t":"reconnect","protocolVersion":1,"code":"AAAAA","seat":"A"}',
  ];

  it('every malformed frame parses to null and never throws', () => {
    for (const raw of garbage) {
      expect(() => parseClientMessage(raw), raw).not.toThrow();
      expect(parseClientMessage(raw), raw).toBeNull();
    }
  });

  it('deeply nested and oversized payloads are refused, not processed', () => {
    const deep = `{"t":"submitAction","action":{"kind":"passPriority","player":${'['.repeat(2000)}1${']'.repeat(2000)}}}`;
    expect(() => parseClientMessage(deep)).not.toThrow();
    const huge = JSON.stringify({ t: 'createRoom', protocolVersion: 1, name: 'x'.repeat(MAX_NAME_LENGTH + 1) });
    expect(parseClientMessage(huge)).toBeNull();
    const longCode = JSON.stringify({ t: 'joinRoom', protocolVersion: 1, code: 'A'.repeat(5000), name: 'x' });
    expect(parseClientMessage(longCode)).toBeNull();
  });

  it('a decklist that would explode into memory is refused (remote OOM)', () => {
    // `loadDeck` materializes one library entry per copy, so an unbounded `count`
    // allocated until the process died — killing every other room with it.
    const bombs: unknown[] = [
      { name: 'bomb', cards: [{ cardId: 'Mountain', count: 1e9 }] },
      { name: 'bomb', cards: [{ cardId: 'Mountain', count: MAX_DECK_ENTRY_COUNT + 1 }] },
      { name: 'bomb', cards: [{ cardId: 'Mountain', count: Number.MAX_SAFE_INTEGER }] },
      { name: 'bomb', cards: [{ cardId: 'Mountain', count: Infinity }] },
      { name: 'bomb', cards: [{ cardId: 'Mountain', count: NaN }] },
      { name: 'bomb', cards: [{ cardId: 'Mountain', count: 1.5 }] },
      { name: 'bomb', cards: [{ cardId: 'Mountain', count: -1 }] },
      { name: 'bomb', cards: new Array(5000).fill({ cardId: 'Mountain', count: 1 }) },
      { name: 'bomb', cards: [] },
    ];
    for (const deck of bombs) {
      const raw = JSON.stringify({ t: 'chooseDeck', deck });
      expect(parseClientMessage(raw), raw.slice(0, 80)).toBeNull();
    }
  });

  it('the room itself also refuses an oversized decklist (defence in depth)', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    // Bypass the parser exactly as a future non-WS transport might.
    const started = Date.now();
    router.handle(a, {
      t: 'chooseDeck',
      deck: { name: 'bomb', cards: [{ cardId: 'Mountain', count: 1e9 }] },
    } as ClientMessage);
    expect(a.last('error')!.code).toBe('invalidDeck');
    // Refused by inspection, not by expanding a billion cards first.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(a.last('lobby')!.players[0]!.hasDeck).toBe(false);
  });

  it('a well-formed decklist at the size cap still loads', () => {
    const legal = sampleDeck(0);
    const total = legal.cards.reduce((n, c) => n + c.count, 0);
    expect(total).toBeLessThanOrEqual(MAX_DECK_TOTAL_CARDS);
    expect(parseClientMessage(JSON.stringify({ t: 'chooseDeck', deck: legal }))).not.toBeNull();
  });

  it('an action whose fields explode on access is contained, not propagated', () => {
    const { a, router } = startedGame();
    a.clear();
    const booby = {
      kind: 'passPriority',
      get player(): PlayerId {
        throw new Error('boom');
      },
    };
    // The router's promise is absolute: a throw anywhere downstream becomes an error
    // for this one client, never an exception escaping into the socket handler.
    expect(() => router.handle(a, { t: 'submitAction', action: booby as unknown as GameAction })).not.toThrow();
    expect(a.last('error')!.code).toBe('internal');
  });

  it('one client misbehaving does not disturb another room', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const victimA = new FakeConnection('va');
    const victimB = new FakeConnection('vb');
    router.handle(victimA, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    const code = victimA.last('roomJoined')!.code;
    router.handle(victimB, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Bob' });
    router.handle(victimA, { t: 'chooseDeck', deck: sampleDeck(0) });
    router.handle(victimB, { t: 'chooseDeck', deck: sampleDeck(1) });

    const mallory = new FakeConnection('mallory');
    const hostile: ClientMessage[] = [
      { t: 'concede' },
      { t: 'rematch' },
      { t: 'setReady', ready: true },
      { t: 'mulligan', keep: false },
      { t: 'submitAction', action: { kind: 'passPriority', player: 'A' } as GameAction },
      { t: 'chooseDeck', deck: { name: 'x', cards: [{ cardId: 'nope', count: 1 }] } },
      { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code: 'ZZZZZ', name: 'Mallory' },
      { t: 'reconnect', protocolVersion: PROTOCOL_VERSION, code, seat: 'A', token: 'deadbeef' },
      { t: 'createRoom', protocolVersion: PROTOCOL_VERSION + 99, name: 'Mallory' },
    ];
    for (let round = 0; round < 3; round++) {
      for (const msg of hostile) expect(() => router.handle(mallory, msg)).not.toThrow();
    }
    router.handleDisconnect(mallory);

    // The victims' room is untouched and still starts normally.
    router.handle(victimA, { t: 'setReady', ready: true });
    router.handle(victimB, { t: 'setReady', ready: true });
    router.handle(victimA, { t: 'mulligan', keep: true });
    router.handle(victimB, { t: 'mulligan', keep: true });
    expect(victimA.has('gameStarted')).toBe(true);
    expect(victimA.last('state')!.view.players.B.hand).toBeNull();
  });

  it('a blank display name cannot make an occupied seat look vacant', () => {
    // Occupancy used to be inferred from `name !== ''`, so a creator with an empty
    // name left seat A "open" and the next joiner overwrote them.
    const room = new Room('TESTX');
    const a = new FakeConnection('a');
    const b = new FakeConnection('b');
    room.createSeat(a, '');
    const joined = room.join(b, 'Mallory');
    expect(joined.seat).toBe('B');
    expect(room.seatOf(a)).toBe('A');
    // ...and the wire boundary refuses a blank name outright.
    for (const name of ['', '   ', '\t\n']) {
      expect(parseClientMessage(JSON.stringify({ t: 'createRoom', protocolVersion: 1, name }))).toBeNull();
    }
  });

  it('a message arriving after game over is refused, not applied', () => {
    const table = startedGame();
    table.router.handle(table.a, { t: 'concede' });
    table.a.clear();
    for (const msg of [
      { t: 'submitAction', action: { kind: 'passPriority', player: 'A' } as GameAction },
      { t: 'mulligan', keep: false },
    ] satisfies ClientMessage[]) {
      table.router.handle(table.a, msg);
      expect(table.a.last('error')!.code).toBe('illegalAction');
    }
    // Conceding twice is idempotent, not a second gameOver announcement.
    table.b.clear();
    table.router.handle(table.a, { t: 'concede' });
    expect(table.b.has('gameOver')).toBe(false);
  });

  it('duplicate setReady and duplicate keeps do not start the game twice', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    const b = new FakeConnection('b');
    router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    const code = a.last('roomJoined')!.code;
    router.handle(b, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Bob' });
    router.handle(a, { t: 'chooseDeck', deck: sampleDeck(0) });
    router.handle(b, { t: 'chooseDeck', deck: sampleDeck(1) });
    for (let i = 0; i < 5; i++) {
      router.handle(a, { t: 'setReady', ready: true });
      router.handle(b, { t: 'setReady', ready: true });
    }
    expect(a.sent.filter((m) => m.t === 'mulliganPrompt')).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      router.handle(a, { t: 'mulligan', keep: true });
      router.handle(b, { t: 'mulligan', keep: true });
    }
    expect(a.sent.filter((m) => m.t === 'gameStarted')).toHaveLength(1);
  });

  it('seats stay exactly the two core PLAYER_IDS', () => {
    expect([...PLAYER_IDS]).toEqual(['A', 'B']);
  });
});
