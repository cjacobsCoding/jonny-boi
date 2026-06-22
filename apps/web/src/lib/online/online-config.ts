/**
 * Named configuration for the ONLINE play client (DESIGN.md §1: no magic numbers —
 * every behavior/feel constant lives here so it is tunable from one place).
 *
 * Nothing in this module reads the DOM or opens a socket; it only declares the knobs
 * the connection layer and the online UI consume.
 */

/**
 * The authoritative game server's WebSocket URL.
 *
 * Read from Vite's `import.meta.env.VITE_SERVER_URL` so it can be set per
 * environment WITHOUT a code change:
 *   - DEV (no env var): defaults to `ws://localhost:8787` — the port the server
 *     defaults to, so `npm run dev` + a local server "just work" together.
 *   - PRODUCTION: the integrator sets `VITE_SERVER_URL` to the deployed secure host,
 *     e.g. `VITE_SERVER_URL=wss://play.example.com` at build time (Vite inlines it).
 *
 * We resolve it once here so the rest of the app references a single named value.
 */
export const DEFAULT_DEV_SERVER_URL = 'ws://localhost:8787';

/** The resolved server URL (env override → dev default). */
export const SERVER_URL: string =
  (import.meta.env?.VITE_SERVER_URL as string | undefined)?.trim() || DEFAULT_DEV_SERVER_URL;

/**
 * Auto-reconnect backoff. On an unexpected socket drop we retry with exponential
 * backoff (capped), so a flaky network self-heals without hammering the server.
 */
export interface ReconnectConfig {
  /** Delay before the first reconnect attempt (ms). */
  readonly baseDelayMs: number;
  /** Multiplier applied to the delay after each failed attempt. */
  readonly factor: number;
  /** Upper bound on the delay (ms) so backoff never grows unbounded. */
  readonly maxDelayMs: number;
  /** Give up after this many consecutive failures (0 = retry forever). */
  readonly maxAttempts: number;
}

export const RECONNECT_CONFIG: ReconnectConfig = Object.freeze({
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 30_000,
  maxAttempts: 8,
});

/** Compute the backoff delay (ms) for a given zero-based attempt number. */
export function reconnectDelayMs(attempt: number, cfg: ReconnectConfig = RECONNECT_CONFIG): number {
  const raw = cfg.baseDelayMs * Math.pow(cfg.factor, Math.max(0, attempt));
  return Math.min(raw, cfg.maxDelayMs);
}

/**
 * Keepalive: the client sends `ping` on this interval and expects a `pong`. This
 * keeps NAT/proxy paths warm and lets us notice a half-open socket.
 */
export const PING_INTERVAL_MS = 20_000;

/** How long an `error` toast stays on screen before auto-dismissing (ms). */
export const ERROR_TOAST_MS = 4_000;

/** Length of the room code the UI expects (display/validation only — server is authoritative). */
export const ROOM_CODE_LENGTH = 6;
