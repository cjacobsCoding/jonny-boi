/**
 * The WebSocket transport — the ONLY socket-aware layer. It is deliberately thin:
 *   1. Wrap each socket in a `Connection` (id + JSON-serializing `send`).
 *   2. Parse each inbound frame into a `ClientMessage` (defensively; garbage is
 *      ignored with an `error`, never a crash).
 *   3. Forward it to the transport-free `MessageRouter`.
 *   4. Serialize each outgoing `ServerMessage` to JSON over the socket.
 *
 * All game/room logic lives in `Room`/`MessageRouter` (no socket dependency), which
 * is what makes the whole flow unit-testable without real sockets. A dropped socket
 * or a bad frame never takes down the process or another room (DESIGN §6).
 */

import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerMessage } from '@jonny-boi/protocol';
import { DEFAULT_PORT, HEARTBEAT_INTERVAL_MS } from './config.js';
import { MessageRouter } from './handlers.js';
import type { Connection } from './room.js';
import { RoomManager } from './room-manager.js';
import { parseClientMessage } from './validate.js';

/** Resolve the listen port from the environment, falling back to the named default. */
function resolvePort(): number {
  const fromEnv = process.env.PORT;
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_PORT;
}

/** A live socket plus its liveness flag (for the heartbeat sweep). */
interface SocketConnection extends Connection {
  readonly socket: WebSocket;
}

/** ws clients carry a liveness flag we toggle each heartbeat sweep. */
type LivenessSocket = WebSocket & { isAlive?: boolean };

/** Start the server. Exported so a harness/test can boot it on an ephemeral port. */
export function startServer(port: number = resolvePort()): WebSocketServer {
  const manager = new RoomManager();
  const router = new MessageRouter(manager);
  const wss = new WebSocketServer({ port });

  wss.on('connection', (socket: WebSocket) => {
    (socket as LivenessSocket).isAlive = true;
    const conn: SocketConnection = {
      id: randomUUID(),
      socket,
      send(message: ServerMessage) {
        // Only write to an open socket; a closed one is a no-op, never an error.
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
    };

    socket.on('message', (raw) => {
      // `raw` may be a Buffer / ArrayBuffer / Buffer[]; normalize to a string.
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : raw.toString();
      const msg = parseClientMessage(text);
      if (!msg) {
        conn.send({ t: 'error', code: 'internal', message: 'malformed message' });
        return;
      }
      try {
        router.handle(conn, msg);
      } catch (err) {
        // A handler bug must never crash the process or other rooms.
        // eslint-disable-next-line no-console
        console.error('[server] handler error:', err);
        conn.send({ t: 'error', code: 'internal', message: 'server error handling message' });
      }
    });

    socket.on('pong', () => {
      (socket as LivenessSocket).isAlive = true;
    });

    socket.on('close', () => {
      router.handleDisconnect(conn);
    });

    socket.on('error', () => {
      // ws surfaces transport errors here; closing follows. Swallow so one bad
      // socket can't take down the server.
      router.handleDisconnect(conn);
    });
  });

  // Heartbeat: each sweep terminates sockets that didn't answer the previous ping
  // (half-open detection), then pings the rest. The per-socket `pong` handler above
  // flips `isAlive` back to true. `unref` so the interval never holds the process up.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const live = client as LivenessSocket;
      if (live.isAlive === false) {
        client.terminate();
        continue;
      }
      live.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  wss.on('listening', () => {
    // eslint-disable-next-line no-console
    console.log(`[server] jonny-boi game server listening on ws://localhost:${port}`);
  });

  return wss;
}

// This module is a pure library (no import side-effects) so tests can import
// `startServer` and boot on an ephemeral port. The executable entry is `main.ts`.
