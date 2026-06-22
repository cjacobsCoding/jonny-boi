/**
 * The WebSocket client for online play — the ONE connection module (DRY).
 *
 * Responsibilities:
 *   - Open a socket to the authoritative game server and keep it open.
 *   - Serialize `ClientMessage`s to JSON (`send`) and parse incoming JSON into
 *     `ServerMessage`s, validating the discriminant so a malformed/unknown frame is
 *     ignored gracefully (never an unhandled rejection or a thrown render).
 *   - Expose a typed event stream (subscribe to messages + status changes) and the
 *     current connection status.
 *   - Auto-reconnect with exponential backoff on an unexpected drop, and a
 *     `ping`/`pong` keepalive while open.
 *
 * It is transport-pure: the actual `WebSocket` constructor is injected (defaulting to
 * the global), so unit tests drive it with a mock socket — no real network.
 *
 * The set of valid `ServerMessage` tags is derived structurally (a single source of
 * truth keyed off the protocol union) so adding a server message can't silently slip
 * past validation without a type error here.
 */
import type { ClientMessage, ServerMessage, ServerMessageTag } from '@jonny-boi/protocol';
import {
  PING_INTERVAL_MS,
  RECONNECT_CONFIG,
  reconnectDelayMs,
  SERVER_URL,
  type ReconnectConfig,
} from './online-config.js';

/** The lifecycle status the UI reflects in its connection indicator. */
export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';

/** A minimal WebSocket surface — lets tests supply a mock without `lib.dom`'s full type. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Factory for a socket (defaults to the global `WebSocket`). Injectable for tests. */
export type SocketFactory = (url: string) => SocketLike;

const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

/** Listener signatures. */
export type MessageListener = (msg: ServerMessage) => void;
export type StatusListener = (status: ConnectionStatus) => void;

/** The complete set of valid server-message tags, derived from the protocol union. */
const SERVER_MESSAGE_TAGS: Readonly<Record<ServerMessageTag, true>> = {
  roomJoined: true,
  lobby: true,
  gameStarted: true,
  mulliganPrompt: true,
  state: true,
  gameOver: true,
  opponentDisconnected: true,
  opponentReconnected: true,
  error: true,
  pong: true,
};

/**
 * Validate that a parsed value is a `ServerMessage` we recognize. We only check the
 * discriminant `t` is a known tag; the per-variant payloads are trusted from the
 * authoritative server (and consumed through the typed union). An unknown/garbage
 * frame returns `null` and is dropped — robustness over a crash.
 */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const tag = (parsed as { t?: unknown }).t;
  if (typeof tag !== 'string' || !(tag in SERVER_MESSAGE_TAGS)) return null;
  return parsed as ServerMessage;
}

/** Serialize a client message for the wire. */
export function serializeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

/** Options for an `OnlineConnection`. */
export interface ConnectionOptions {
  readonly url?: string;
  readonly socketFactory?: SocketFactory;
  readonly reconnect?: ReconnectConfig;
  readonly pingIntervalMs?: number;
  /** Timer seam (defaults to the global setTimeout/clearTimeout/setInterval). */
  readonly timers?: TimerApi;
}

/** Pluggable timers so tests can run without real clocks. */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * A reconnecting WebSocket client speaking the jonny-boi protocol. Construct it,
 * `onMessage`/`onStatus` to subscribe, `connect()` to open, `send()` to transmit, and
 * `dispose()` to tear down (cancels reconnects + keepalive, closes the socket).
 */
export class OnlineConnection {
  private readonly url: string;
  private readonly socketFactory: SocketFactory;
  private readonly reconnectCfg: ReconnectConfig;
  private readonly pingIntervalMs: number;
  private readonly timers: TimerApi;

  private socket: SocketLike | null = null;
  private statusValue: ConnectionStatus = 'closed';
  private attempt = 0;
  private reconnectHandle: unknown = null;
  private pingHandle: unknown = null;
  /** True once the consumer asks to disconnect — suppresses auto-reconnect. */
  private disposed = false;

  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor(opts: ConnectionOptions = {}) {
    this.url = opts.url ?? SERVER_URL;
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
    this.reconnectCfg = opts.reconnect ?? RECONNECT_CONFIG;
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.timers = opts.timers ?? defaultTimers;
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  /** Subscribe to server messages; returns an unsubscribe function. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** Subscribe to status changes; immediately fires the current status. */
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.statusValue);
    return () => this.statusListeners.delete(listener);
  }

  /** Open the socket (idempotent: a no-op if one is already connecting/open). */
  connect(): void {
    if (this.disposed) return;
    if (this.socket) return;
    this.setStatus('connecting');
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      this.startKeepalive();
    };
    socket.onmessage = (ev) => {
      const msg = parseServerMessage(ev.data);
      if (msg) this.emitMessage(msg);
    };
    socket.onerror = () => {
      // An error is followed by a close; surface 'error' so the UI can hint.
      this.setStatus('error');
    };
    socket.onclose = () => {
      this.teardownSocket();
      if (this.disposed) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Send a client message (no-op + status hint if the socket isn't open). */
  send(msg: ClientMessage): boolean {
    if (!this.socket || this.statusValue !== 'open') return false;
    try {
      this.socket.send(serializeClientMessage(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Permanently close the connection and cancel all timers. */
  dispose(): void {
    this.disposed = true;
    this.cancelReconnect();
    this.stopKeepalive();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
    this.teardownSocket();
    this.setStatus('closed');
  }

  // --- internals ---------------------------------------------------------------

  private scheduleReconnect(): void {
    this.setStatus(this.statusValue === 'error' ? 'error' : 'closed');
    if (this.reconnectCfg.maxAttempts > 0 && this.attempt >= this.reconnectCfg.maxAttempts) {
      this.setStatus('error');
      return;
    }
    const delay = reconnectDelayMs(this.attempt, this.reconnectCfg);
    this.attempt += 1;
    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = null;
      this.setStatus('connecting');
      this.connect();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectHandle !== null) {
      this.timers.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.pingHandle = this.timers.setInterval(() => {
      this.send({ t: 'ping' });
    }, this.pingIntervalMs);
  }

  private stopKeepalive(): void {
    if (this.pingHandle !== null) {
      this.timers.clearInterval(this.pingHandle);
      this.pingHandle = null;
    }
  }

  private teardownSocket(): void {
    this.stopKeepalive();
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const l of this.statusListeners) l(status);
  }

  private emitMessage(msg: ServerMessage): void {
    for (const l of this.messageListeners) l(msg);
  }
}
