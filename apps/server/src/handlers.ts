/**
 * Message routing — transport-free. Given a `Connection`, a `RoomManager`, and a
 * parsed `ClientMessage`, route it to the right `Room` operation. This is the layer
 * the WS server calls per inbound frame, and the layer tests drive directly with
 * fake connections (no sockets). It also tracks which room each connection is in.
 *
 * Protocol-version is checked here at create/join (the handshake), per the contract.
 */

import { assertNever, type ClientMessage } from '@jonny-boi/protocol';
import type { Connection, Room } from './room.js';
import { Room as RoomImpl } from './room.js';
import type { RoomManager } from './room-manager.js';

/** Per-connection session state the router maintains (which room it joined). */
export interface Session {
  room: Room | null;
}

/**
 * The router: holds the manager + a per-connection session map. One instance per
 * server process; the WS layer creates a `Connection` per socket and forwards every
 * decoded message to `handle`.
 */
export class MessageRouter {
  constructor(private readonly manager: RoomManager) {}

  private readonly sessions = new WeakMap<Connection, Session>();

  private sessionFor(conn: Connection): Session {
    let s = this.sessions.get(conn);
    if (!s) {
      s = { room: null };
      this.sessions.set(conn, s);
    }
    return s;
  }

  /** Route one validated client message. Never throws (callers can't crash us). */
  handle(conn: Connection, msg: ClientMessage): void {
    const session = this.sessionFor(conn);
    switch (msg.t) {
      case 'createRoom': {
        if (!RoomImpl.protocolMatches(msg.protocolVersion)) {
          conn.send({ t: 'error', code: 'protocolMismatch', message: 'client/server protocol versions differ' });
          return;
        }
        const created = this.manager.create(conn, msg.name, msg.deck);
        if (!created) {
          conn.send({ t: 'error', code: 'internal', message: 'unable to create a room (server at capacity)' });
          return;
        }
        session.room = created.room;
        return;
      }
      case 'joinRoom': {
        if (!RoomImpl.protocolMatches(msg.protocolVersion)) {
          conn.send({ t: 'error', code: 'protocolMismatch', message: 'client/server protocol versions differ' });
          return;
        }
        const joined = this.manager.join(conn, msg.code, msg.name, msg.deck);
        if (!joined) {
          conn.send({ t: 'error', code: 'roomNotFound', message: `no room with code "${msg.code}"` });
          return;
        }
        session.room = joined.room;
        return;
      }
      case 'chooseDeck':
        this.requireRoom(conn, session)?.chooseDeck(conn, msg.deck);
        return;
      case 'setReady':
        this.requireRoom(conn, session)?.setReady(conn, msg.ready);
        return;
      case 'mulligan':
        this.requireRoom(conn, session)?.mulligan(conn, msg.keep);
        return;
      case 'submitAction':
        this.requireRoom(conn, session)?.submitAction(conn, msg.action);
        return;
      case 'concede':
        this.requireRoom(conn, session)?.concede(conn);
        return;
      case 'rematch':
        this.requireRoom(conn, session)?.rematch(conn);
        return;
      case 'ping':
        conn.send({ t: 'pong' });
        return;
      default:
        return assertNever(msg);
    }
  }

  /** A connection's current room, or an `error` + `undefined` if it has none. */
  private requireRoom(conn: Connection, session: Session): Room | undefined {
    if (!session.room) {
      conn.send({ t: 'error', code: 'notInRoom', message: 'join or create a room first' });
      return undefined;
    }
    return session.room;
  }

  /** Notify the connection's room of a disconnect (idempotent), then prune. */
  handleDisconnect(conn: Connection): void {
    const session = this.sessions.get(conn);
    if (session?.room) {
      session.room.handleDisconnect(conn);
    }
    this.manager.pruneEmpty();
  }

  /** Associate a connection with a room directly (used by the reconnect path). */
  bindRoom(conn: Connection, room: Room): void {
    this.sessionFor(conn).room = room;
  }
}
