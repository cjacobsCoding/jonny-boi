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

  /**
   * Route one validated client message. NEVER throws: whatever happens downstream is
   * reported to the one client that caused it. A throw escaping here would unwind
   * through the socket's `message` handler, so this guarantee is what keeps one
   * hostile client from disturbing any other room — or the process.
   */
  handle(conn: Connection, msg: ClientMessage): void {
    try {
      this.dispatch(conn, msg);
    } catch (err) {
      console.error('[router] handler error:', err);
      conn.send({ t: 'error', code: 'internal', message: 'server error handling message' });
    }
  }

  private dispatch(conn: Connection, msg: ClientMessage): void {
    const session = this.sessionFor(conn);
    switch (msg.t) {
      case 'createRoom': {
        if (!RoomImpl.protocolMatches(msg.protocolVersion)) {
          conn.send({ t: 'error', code: 'protocolMismatch', message: 'client/server protocol versions differ' });
          return;
        }
        this.leaveCurrentRoom(conn, session);
        const created = this.manager.create(conn, msg.name, msg.deck, msg.startingPlayer);
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
        this.leaveCurrentRoom(conn, session);
        const joined = this.manager.join(conn, msg.code, msg.name, msg.deck);
        if (!joined) {
          conn.send({ t: 'error', code: 'roomNotFound', message: 'no room with that code' });
          return;
        }
        // A refused joiner (no seat AND no spectator slot) was already told why; do
        // not bind it to the room, or a room it never entered would never go empty.
        if (joined.result.refused) return;
        session.room = joined.room;
        return;
      }
      case 'reconnect': {
        if (!RoomImpl.protocolMatches(msg.protocolVersion)) {
          conn.send({ t: 'error', code: 'protocolMismatch', message: 'client/server protocol versions differ' });
          return;
        }
        this.leaveCurrentRoom(conn, session);
        const room = this.manager.get(msg.code);
        // A wrong code, a wrong seat and a wrong token all answer identically: a
        // failed reclaim must teach an attacker nothing about which rooms or seats exist.
        if (!room || room.reconnect(conn, msg.seat, msg.token) === null) {
          conn.send({ t: 'error', code: 'notInRoom', message: 'could not reclaim that seat' });
          return;
        }
        session.room = room;
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

  /**
   * Detach a connection from the room it is currently in, before it enters another.
   *
   * A socket is only ever in ONE room. Without this, a client that sent a second
   * `createRoom`/`joinRoom` stayed registered in the first room forever: the room kept
   * a live-looking connection, so it never counted as empty, was never pruned, and
   * kept receiving broadcasts. One socket could quietly pin every room slot on the
   * server (MAX_ROOMS) and lock everyone else out — permanently, since the leaked
   * rooms outlived the socket that made them.
   */
  private leaveCurrentRoom(conn: Connection, session: Session): void {
    if (!session.room) return;
    session.room.handleDisconnect(conn);
    session.room = null;
    this.manager.pruneEmpty();
  }

  /** Notify the connection's room of a disconnect (idempotent), then prune. Never throws. */
  handleDisconnect(conn: Connection): void {
    const session = this.sessions.get(conn);
    try {
      if (session?.room) {
        session.room.handleDisconnect(conn);
        // Drop the association too, so a post-close frame from a half-dead socket can
        // never reach a room this connection has already left.
        session.room = null;
      }
    } catch (err) {
      console.error('[router] disconnect error:', err);
    }
    this.manager.pruneEmpty();
  }

  /** Associate a connection with a room directly (used by the reconnect path). */
  bindRoom(conn: Connection, room: Room): void {
    this.sessionFor(conn).room = room;
  }
}
