/**
 * Named server constants (DESIGN §1.1 — no magic numbers). Every value that
 * affects behaviour or feel is named here and imported where used, so a tuning
 * change is a single edit and the call sites stay self-documenting.
 */

/** Default TCP port the WebSocket server binds when `process.env.PORT` is unset. */
export const DEFAULT_PORT = 8787;

/**
 * Room-code alphabet: uppercase letters + digits with the visually ambiguous
 * characters removed (no O/0, I/1, etc.) so a code is unambiguous when read aloud
 * or typed. DRY: the code generator and any validation derive length/charset here.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Number of characters in a generated room code. */
export const ROOM_CODE_LENGTH = 5;

/**
 * How many distinct codes we'll try to generate before giving up (defends against
 * the astronomically unlikely case of a saturated code space — we never spin
 * forever). 32^5 ≈ 33M codes, so collisions are vanishingly rare in practice.
 */
export const ROOM_CODE_MAX_ATTEMPTS = 16;

/** Hard cap on concurrent rooms; a `createRoom` beyond this is refused (internal error). */
export const MAX_ROOMS = 1000;

/**
 * Heartbeat: the server sends a low-level WebSocket ping every interval and drops
 * a socket that didn't answer the previous one, so a half-open connection is
 * detected and cleaned up instead of lingering. (Distinct from the application
 * `ping`/`pong` messages, which a client drives itself.)
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Length (bytes of entropy) of a per-seat reconnect token. */
export const RECONNECT_TOKEN_BYTES = 16;

// Note: the two seats are the core `PlayerId`s — the room logic iterates the
// canonical `PLAYER_IDS` from `@jonny-boi/core` rather than re-declaring 'A'/'B'
// here, so there is a single source of truth for seat identity (DRY).

/** Per-game seed source. Online games are seeded so a room is reproducible/debuggable. */
export const DEFAULT_GAME_SEED = 0xc0ffee;
