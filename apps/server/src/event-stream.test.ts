/**
 * THE PUBLIC EVENT STREAM, PROVED ON A REAL ROOM.
 *
 * `packages/protocol`'s own tests pin `maskEventsForSeat` as a function. This
 * file asks the harder question — *does the shipped server actually send that,
 * and only that?* — by driving the transport-free `Room`/`MessageRouter` with
 * real `ClientMessage`s and reading back every `ServerMessage` a seat received,
 * exactly as `security.test.ts` does for the masked view.
 *
 * Three claims, and each is a different failure:
 *
 *  1. **the channel exists** — a real game produces `state` messages carrying
 *     `events`, so the online board has something to animate. A leak test alone
 *     passes vacuously on a server that sends nothing at all;
 *  2. **the channel leaks nothing** — a card DRAWN into a seat's hand is named
 *     by no event stream, on either connection. That is the specific event the
 *     kind table exists to refuse, and the drawn card's id is read from the
 *     drawing seat's OWN view, so the test knows which id to hunt for;
 *  3. **the prose log did not regress** — `summarizeEvents` is a separate
 *     consumer, and "carry the events BESIDE the strings" is only true while the
 *     strings are still there.
 *
 * Plus the cross-table containment that keeps this repo's TWO hidden-information
 * tables from drifting apart — see the last describe block.
 */

import { type GameAction, type GameEvent, type PlayerId } from '@jonny-boi/core';
import {
  collectInstanceIds,
  isPublicEventKind,
  PROTOCOL_VERSION,
  PUBLIC_EVENT_KINDS,
  type DeckList,
  type ServerMessage,
} from '@jonny-boi/protocol';
import { OBSERVATION_POLICY, SAMPLE_DECKS } from '@jonny-boi/sim';
import { describe, expect, it } from 'vitest';
import { MessageRouter } from './handlers.js';
import type { Connection } from './room.js';
import { RoomManager } from './room-manager.js';

/** A fake connection: records every message the server sends it. */
class FakeConnection implements Connection {
  readonly sent: ServerMessage[] = [];
  constructor(readonly id: string) {}
  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  /** The latest `state` message this connection was sent. */
  lastState(): Extract<ServerMessage, { t: 'state' }> {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const msg = this.sent[i]!;
      if (msg.t === 'state') return msg;
    }
    throw new Error(`${this.id} was never sent a state message`);
  }
  /** EVERY event this connection has ever been told about, flattened in order. */
  allEvents(): readonly GameEvent[] {
    const out: GameEvent[] = [];
    for (const msg of this.sent) if (msg.t === 'state' && msg.events) out.push(...msg.events);
    return out;
  }
  /** Every prose log line this connection has ever been sent. */
  allLogLines(): readonly string[] {
    const out: string[] = [];
    for (const msg of this.sent) if (msg.t === 'state') out.push(...msg.log);
    return out;
  }
}

function sampleDeck(index: number): DeckList {
  const d = SAMPLE_DECKS[index]!;
  return { name: d.name, cards: d.cards.map((c) => ({ cardId: c.cardId, count: c.count })) };
}

interface Table {
  readonly router: MessageRouter;
  readonly a: FakeConnection;
  readonly b: FakeConnection;
}

/** Walk two players from create → join → decks → ready → both keep, into live play. */
function startedGame(): Table {
  const manager = new RoomManager();
  const router = new MessageRouter(manager);
  const a = new FakeConnection('a');
  const b = new FakeConnection('b');
  router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
  const code = (a.sent.find((m) => m.t === 'roomJoined') as Extract<ServerMessage, { t: 'roomJoined' }>).code;
  router.handle(b, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Bob' });
  router.handle(a, { t: 'chooseDeck', deck: sampleDeck(0) });
  router.handle(b, { t: 'chooseDeck', deck: sampleDeck(1) });
  router.handle(a, { t: 'setReady', ready: true });
  router.handle(b, { t: 'setReady', ready: true });
  router.handle(a, { t: 'mulligan', keep: true });
  router.handle(b, { t: 'mulligan', keep: true });
  return { router, a, b };
}

/** The ids in a seat's hand, read from that seat's OWN state message. */
function handIdsOf(conn: FakeConnection, seat: PlayerId): readonly number[] {
  return (conn.lastState().view.players[seat].hand ?? []).map((c) => c.instanceId);
}

/** Pass priority `times` times, always for whoever currently holds it. */
function passPriority(table: Table, times: number): void {
  for (let i = 0; i < times; i++) {
    const priority = table.a.lastState().view.priorityPlayer;
    const conn = priority === 'A' ? table.a : table.b;
    table.router.handle(conn, {
      t: 'submitAction',
      action: { kind: 'passPriority', player: priority } as GameAction,
    });
  }
}

describe('the state message carries the PUBLIC event stream', () => {
  it('a real game actually produces one — the channel is not merely declared', () => {
    const table = startedGame();
    passPriority(table, 20);
    const seen = table.a.allEvents();
    expect(seen.length, 'no events reached seat A at all').toBeGreaterThan(0);
    // Every one is a row of the closed table — nothing arrives unclassified.
    for (const event of seen) {
      expect(isPublicEventKind(event.type), `${event.type} is not a public kind`).toBe(true);
    }
    // And the steps really travelled, so a damage fold has its round boundaries.
    expect(seen.some((e) => e.type === 'stepBegin')).toBe(true);
  });

  it('a card DRAWN into a hand is named by NEITHER seat’s event stream', () => {
    const table = startedGame();
    // A turn cycle is enough for at least one draw step to fire for each seat.
    const before = new Set([...handIdsOf(table.a, 'A'), ...handIdsOf(table.b, 'B')]);
    passPriority(table, 40);
    const after = [...handIdsOf(table.a, 'A'), ...handIdsOf(table.b, 'B')];
    const drawn = after.filter((id) => !before.has(id));
    expect(drawn.length, 'no card was drawn in this window — the test would pass vacuously').toBeGreaterThan(0);

    // THE ASSERTION: the event streams, and nothing else. A drawn card is of
    // course in its OWN holder's `view.players.X.hand` — that is the masked view
    // working. What must never happen is the EVENT channel naming it, for either
    // seat, because `drawCard` is not a row of the table.
    for (const conn of [table.a, table.b]) {
      const named = collectInstanceIds(conn.allEvents());
      for (const id of drawn) {
        expect(named.has(id), `seat ${conn.id}'s event stream names drawn card ${id}`).toBe(false);
      }
    }
  });

  it('no event stream ever names a card in the OPPONENT’s hand', () => {
    const table = startedGame();
    passPriority(table, 40);
    const aHidden = handIdsOf(table.a, 'A');
    const bHidden = handIdsOf(table.b, 'B');
    expect(aHidden.length).toBeGreaterThan(0);
    expect(bHidden.length).toBeGreaterThan(0);
    const aTold = collectInstanceIds(table.a.allEvents());
    const bTold = collectInstanceIds(table.b.allEvents());
    for (const id of bHidden) expect(aTold.has(id), `A was told about B's card ${id}`).toBe(false);
    for (const id of aHidden) expect(bTold.has(id), `B was told about A's card ${id}`).toBe(false);
  });

  it('a spectator’s stream names no seat’s hand either', () => {
    const manager = new RoomManager();
    const router = new MessageRouter(manager);
    const a = new FakeConnection('a');
    const b = new FakeConnection('b');
    router.handle(a, { t: 'createRoom', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
    const code = (a.sent.find((m) => m.t === 'roomJoined') as Extract<ServerMessage, { t: 'roomJoined' }>).code;
    router.handle(b, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Bob' });
    const spy = new FakeConnection('spy');
    router.handle(spy, { t: 'joinRoom', protocolVersion: PROTOCOL_VERSION, code, name: 'Spy' });
    router.handle(a, { t: 'chooseDeck', deck: sampleDeck(0) });
    router.handle(b, { t: 'chooseDeck', deck: sampleDeck(1) });
    router.handle(a, { t: 'setReady', ready: true });
    router.handle(b, { t: 'setReady', ready: true });
    router.handle(a, { t: 'mulligan', keep: true });
    router.handle(b, { t: 'mulligan', keep: true });
    const table: Table = { router, a, b };
    passPriority(table, 40);

    const told = collectInstanceIds(spy.allEvents());
    for (const id of [...handIdsOf(a, 'A'), ...handIdsOf(b, 'B')]) {
      expect(told.has(id), `the spectator was told about hidden card ${id}`).toBe(false);
    }
  });

  it('the PROSE LOG did not regress — the events travel BESIDE it, not instead of it', () => {
    const table = startedGame();
    passPriority(table, 20);
    const lines = table.a.allLogLines();
    expect(lines.length, 'summarizeEvents stopped producing anything').toBeGreaterThan(0);
    // The five sentence kinds are what `summarizeEvents` has always written; the
    // step line is the one every game produces, whatever the decks do.
    expect(lines.some((line) => line.startsWith('Step: '))).toBe(true);
  });

  it('a send that is NOT the result of an action carries no events field at all', () => {
    const table = startedGame();
    passPriority(table, 6);
    // An illegal action — the RIGHT seat, a card it does not hold — is refused by
    // the engine and the server RESYNCS the offender. Nothing fresh happened, so
    // appending an empty batch would tell the client the same thing twice; the
    // field is omitted instead.
    const seat = table.a.lastState().view.priorityPlayer;
    const actor = seat === 'A' ? table.a : table.b;
    const before = actor.sent.length;
    table.router.handle(actor, {
      t: 'submitAction',
      action: { kind: 'playLand', player: seat, instanceId: 999_999 } as GameAction,
    });
    const resyncs = actor.sent.slice(before).filter((m) => m.t === 'state');
    expect(resyncs.length, 'the refused action produced no resync to inspect').toBeGreaterThan(0);
    for (const msg of resyncs) expect(msg.t === 'state' && msg.events).toBeUndefined();
  });
});

describe('the two hidden-information tables agree', () => {
  /**
   * CONTAINMENT, not equality. This repo has two tables that classify a
   * `GameEvent` against hidden information, and they answer different questions:
   * `packages/sim`'s `OBSERVATION_POLICY` decides what an AI pilot — one
   * spectator holding no cards — may observe, while `PUBLIC_EVENT_KINDS` decides
   * what may travel to a SEAT, which also sees its own hand.
   *
   * Neither can be derived from the other, so the honest guard is the implication
   * that must hold in one direction: **a kind the pilot feed has to REDACT can
   * never be one a seat may receive verbatim.** A row added to the wire table
   * that the sim considers private fails here, which is the drift this catches.
   */
  it('every wire-public kind is one the pilot feed also passes through unredacted', () => {
    const redacted: string[] = [];
    for (const kind of Object.keys(PUBLIC_EVENT_KINDS) as (keyof typeof PUBLIC_EVENT_KINDS)[]) {
      if (OBSERVATION_POLICY[kind] !== 'public') redacted.push(kind);
    }
    expect(redacted, 'these kinds travel to a seat but are redacted for a pilot').toEqual([]);
  });

  it('the wire table is the SMALLER of the two — a seat is told less, never more', () => {
    const wire = Object.keys(PUBLIC_EVENT_KINDS).length;
    const pilot = Object.values(OBSERVATION_POLICY).filter((p) => p === 'public').length;
    expect(wire).toBeLessThan(pilot);
  });
});
