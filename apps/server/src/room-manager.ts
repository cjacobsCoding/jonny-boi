/**
 * `RoomManager` — the registry of live `Room`s. Transport-free like `Room`: it
 * owns room creation (code generation + the max-rooms cap), lookup, and cleanup of
 * empty rooms. The WS layer routes a parsed `createRoom`/`joinRoom` here; everything
 * else routes to the connection's current `Room` directly.
 */

import type { Connection, Room } from './room.js';
import { Room as RoomImpl } from './room.js';
import { EMPTY_ROOM_GRACE_MS, MAX_ROOMS, ROOM_CODE_MAX_ATTEMPTS } from './config.js';
import { generateUniqueRoomCode } from './room-code.js';

/** What a successful create returns: the room, the seat, and its reconnect token. */
export interface CreateResult {
  readonly room: Room;
  readonly seat: 'A';
  readonly token: string;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** When each currently-empty room became empty (absent = the room has occupants). */
  private readonly emptySince = new Map<string, number>();

  /** Number of live rooms (for tests / diagnostics). */
  get size(): number {
    return this.rooms.size;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  /**
   * Create a fresh room and seat the creator as A. Returns `null` if the server is
   * at capacity or the code space is exhausted (the caller emits an `internal`
   * error); the creator's connection is sent `roomJoined`/`lobby` by the room.
   */
  create(
    conn: Connection,
    name: string,
    deck?: Parameters<Room['createSeat']>[2],
    startingPlayer?: Parameters<Room['createSeat']>[3],
  ): CreateResult | null {
    // Reclaim anything already abandoned before declaring the server full, so a burst
    // of short-lived rooms can never leave capacity permanently consumed.
    if (this.rooms.size >= MAX_ROOMS) this.pruneEmpty();
    if (this.rooms.size >= MAX_ROOMS) return null;
    const code = generateUniqueRoomCode(new Set(this.rooms.keys()), ROOM_CODE_MAX_ATTEMPTS);
    if (!code) return null;
    const room = new RoomImpl(code);
    this.rooms.set(code, room);
    const result = room.createSeat(conn, name, deck, startingPlayer);
    return { room, seat: 'A', token: result.token };
  }

  /**
   * Join an existing room by code. Returns the room + join result on success, or
   * `null` if no room has that code (the caller emits `roomNotFound`).
   */
  join(
    conn: Connection,
    code: string,
    name: string,
    deck?: Parameters<Room['join']>[2],
  ): { room: Room; result: ReturnType<Room['join']> } | null {
    const room = this.get(code);
    if (!room) return null;
    const result = room.join(conn, name, deck);
    return { room, result };
  }

  /** Remove a room (called once it has no live connections). */
  remove(code: string): void {
    const key = code.toUpperCase();
    this.rooms.delete(key);
    this.emptySince.delete(key);
  }

  /**
   * Drop rooms with no seated nor spectating socket: at once if no game was ever
   * dealt there, otherwise once the grace period has elapsed. Splitting the two is
   * what keeps the grace window from being abusable (see below). The window itself
   * is what makes reconnect possible when BOTH players
   * drop at once (a shared-network blip would otherwise destroy the match instantly);
   * the periodic sweep in the WS layer guarantees the room is still reaped afterwards,
   * so retention stays bounded. `now` is injectable so tests need no timers.
   */
  pruneEmpty(now: number = Date.now()): void {
    for (const [code, room] of this.rooms) {
      if (!room.isEmpty()) {
        this.emptySince.delete(code);
        continue;
      }
      // A room where no cards were ever dealt holds no match to reconnect to (a
      // lobby drop already vacates the seat and voids its token), so it is reclaimed
      // at once rather than held for the grace window. Without this split the grace
      // period is an amplifier: one socket can open MAX_ROOMS empty lobbies in a
      // burst and pin the server's entire capacity for the whole window, refusing
      // every legitimate `createRoom` — and simply keep doing it.
      if (!room.hasGame()) {
        this.rooms.delete(code);
        this.emptySince.delete(code);
        continue;
      }
      const since = this.emptySince.get(code) ?? now;
      if (now - since >= EMPTY_ROOM_GRACE_MS) {
        this.rooms.delete(code);
        this.emptySince.delete(code);
      } else {
        this.emptySince.set(code, since);
      }
    }
  }
}
