import { describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@jonny-boi/protocol';
import {
  OnlineConnection,
  parseServerMessage,
  serializeClientMessage,
  type SocketLike,
  type TimerApi,
} from './connection.js';

/** A controllable mock WebSocket. */
class MockSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({});
  }
  // Test helpers.
  open(): void {
    this.onopen?.({});
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
  error(): void {
    this.onerror?.({});
  }
}

/** A manual timer harness: collects scheduled callbacks; tests fire them. */
function manualTimers(): TimerApi & { flushTimeouts(): void; intervals: Array<() => void> } {
  const timeouts: Array<() => void> = [];
  const intervals: Array<() => void> = [];
  return {
    intervals,
    setTimeout: (fn) => {
      timeouts.push(fn);
      return timeouts.length;
    },
    clearTimeout: () => {},
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: () => {},
    flushTimeouts() {
      const pending = timeouts.splice(0);
      for (const fn of pending) fn();
    },
  };
}

describe('parseServerMessage', () => {
  it('parses a valid server message by its tag', () => {
    const msg: ServerMessage = { t: 'pong' };
    expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it('parses a roomJoined message preserving its payload', () => {
    const msg: ServerMessage = { t: 'roomJoined', code: 'ABC123', yourSeat: 'A', spectator: false };
    expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it('drops non-JSON input', () => {
    expect(parseServerMessage('not json {{{')).toBeNull();
  });

  it('drops JSON with an unknown tag', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'totallyMadeUp' }))).toBeNull();
  });

  it('drops JSON with no tag / wrong shape', () => {
    expect(parseServerMessage(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify(42))).toBeNull();
    expect(parseServerMessage(JSON.stringify(null))).toBeNull();
  });

  it('ignores non-string raw input', () => {
    expect(parseServerMessage(123 as unknown)).toBeNull();
  });
});

describe('serializeClientMessage', () => {
  it('round-trips a client message through JSON', () => {
    const wire = serializeClientMessage({ t: 'setReady', ready: true });
    expect(JSON.parse(wire)).toEqual({ t: 'setReady', ready: true });
  });
});

describe('OnlineConnection status transitions', () => {
  it('goes connecting → open on socket open and emits the open status', () => {
    let socket!: MockSocket;
    const conn = new OnlineConnection({
      socketFactory: () => (socket = new MockSocket()),
      timers: manualTimers(),
    });
    const statuses: string[] = [];
    conn.onStatus((s) => statuses.push(s));
    conn.connect();
    expect(conn.status).toBe('connecting');
    socket.open();
    expect(conn.status).toBe('open');
    // onStatus fires the current status immediately, then transitions.
    expect(statuses).toEqual(['closed', 'connecting', 'open']);
  });

  it('delivers parsed server messages to subscribers and drops malformed ones', () => {
    let socket!: MockSocket;
    const conn = new OnlineConnection({
      socketFactory: () => (socket = new MockSocket()),
      timers: manualTimers(),
    });
    const received: ServerMessage[] = [];
    conn.onMessage((m) => received.push(m));
    conn.connect();
    socket.open();
    socket.receive(JSON.stringify({ t: 'opponentDisconnected' }));
    socket.receive('garbage');
    socket.receive(JSON.stringify({ t: 'nope' }));
    expect(received).toEqual([{ t: 'opponentDisconnected' }]);
  });

  it('only sends when open; send() reports failure otherwise', () => {
    let socket!: MockSocket;
    const conn = new OnlineConnection({
      socketFactory: () => (socket = new MockSocket()),
      timers: manualTimers(),
    });
    conn.connect();
    expect(conn.send({ t: 'ping' })).toBe(false); // not open yet
    socket.open();
    expect(conn.send({ t: 'ping' })).toBe(true);
    expect(JSON.parse(socket.sent[0]!)).toEqual({ t: 'ping' });
  });

  it('schedules a reconnect on an unexpected close', () => {
    const timers = manualTimers();
    const factory = vi.fn(() => new MockSocket());
    const conn = new OnlineConnection({ socketFactory: factory, timers });
    conn.connect();
    const first = factory.mock.results[0]!.value as MockSocket;
    first.open();
    // Simulate a drop NOT initiated by dispose().
    first.onclose?.({});
    expect(conn.status).toBe('closed');
    // Firing the scheduled reconnect opens a brand-new socket.
    timers.flushTimeouts();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(conn.status).toBe('connecting');
  });

  it('does NOT reconnect after dispose()', () => {
    const timers = manualTimers();
    const factory = vi.fn(() => new MockSocket());
    const conn = new OnlineConnection({ socketFactory: factory, timers });
    conn.connect();
    (factory.mock.results[0]!.value as MockSocket).open();
    conn.dispose();
    expect(conn.status).toBe('closed');
    timers.flushTimeouts();
    expect(factory).toHaveBeenCalledTimes(1); // no reconnect socket created
  });

  it('starts a keepalive ping interval once open', () => {
    let socket!: MockSocket;
    const timers = manualTimers();
    const conn = new OnlineConnection({
      socketFactory: () => (socket = new MockSocket()),
      timers,
    });
    conn.connect();
    socket.open();
    expect(timers.intervals.length).toBe(1);
    timers.intervals[0]!(); // fire the ping
    expect(JSON.parse(socket.sent[0]!)).toEqual({ t: 'ping' });
  });

  it('surfaces error status on socket error', () => {
    let socket!: MockSocket;
    const conn = new OnlineConnection({
      socketFactory: () => (socket = new MockSocket()),
      timers: manualTimers(),
    });
    conn.connect();
    socket.error();
    expect(conn.status).toBe('error');
  });

  it('queues a send issued before open and flushes it on open (tunnel-latency race)', () => {
    let socket!: MockSocket;
    const conn = new OnlineConnection({
      socketFactory: () => (socket = new MockSocket()),
      timers: manualTimers(),
    });
    conn.connect();
    // Socket is 'connecting', not open yet — like clicking Create over a slow tunnel.
    expect(conn.status).toBe('connecting');
    const queued = conn.send({ t: 'createRoom', protocolVersion: 1, name: 'P1' });
    expect(queued).toBe(true);
    expect(socket.sent).toHaveLength(0); // nothing sent on a not-yet-open socket
    socket.open();
    // On open the queued createRoom is flushed in order.
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({ t: 'createRoom', protocolVersion: 1, name: 'P1' });
  });
});
