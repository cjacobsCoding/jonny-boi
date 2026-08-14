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
 * Cap on spectators per room. Every spectator receives a full `state` broadcast on
 * every action, so an unbounded set is an amplification vector: N spectators turn one
 * action into N serializations. Beyond this a joiner is refused rather than admitted.
 */
export const MAX_SPECTATORS_PER_ROOM = 16;

// --- hostile-input bounds --------------------------------------------------
// The wire is unauthenticated and public: every inbound field needs an explicit
// bound, because anything unbounded is a memory/CPU amplifier for one bad client.

/** Largest inbound WebSocket frame we accept (ws would otherwise allow 100 MB). */
export const MAX_FRAME_BYTES = 256 * 1024;

/** Longest accepted display name; longer names are rejected at the parse boundary. */
export const MAX_NAME_LENGTH = 32;

/** Longest accepted room code on the wire (generated codes are `ROOM_CODE_LENGTH`). */
export const MAX_ROOM_CODE_LENGTH = 16;

/** Longest accepted deck name. */
export const MAX_DECK_NAME_LENGTH = 64;

/** Longest accepted card id/name reference inside a decklist entry. */
export const MAX_CARD_ID_LENGTH = 128;

/** Most distinct entries a submitted decklist may contain. */
export const MAX_DECK_ENTRIES = 250;

/** Most copies a single decklist entry may request. */
export const MAX_DECK_ENTRY_COUNT = 100;

/**
 * Most physical cards a submitted decklist may expand to. The deck loader expands
 * `count` copies per entry into a flat library, so without this an entry of
 * `count: 1e9` allocates until the process dies — taking every other room with it.
 */
export const MAX_DECK_TOTAL_CARDS = 1000;

/**
 * Most mulligans a seat may take in one game. Each "no keep" reshuffles a library and
 * redraws, so an unbounded stream of them is a free CPU/bandwidth amplifier; at the cap
 * the seat is force-settled with the hand it has.
 */
export const MAX_MULLIGANS_PER_GAME = 6;

/**
 * How long a room with no live connections is kept before it is reaped. A brief grace
 * period is what makes reconnect possible when BOTH players drop (a shared-network
 * blip); the periodic sweep guarantees the room is still collected soon after.
 */
export const EMPTY_ROOM_GRACE_MS = 60_000;

/** How often the server sweeps for grace-expired empty rooms. */
export const ROOM_SWEEP_INTERVAL_MS = 30_000;

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

/**
 * Fallback per-game seed. A room seeds itself from `randomGameSeed()` so shuffles are
 * unpredictable; this constant exists only so a test (or a debug session) can pin a
 * room to a reproducible game by passing it explicitly.
 *
 * ⚠️ Never make this the default for live rooms: a fixed seed means every game with the
 * same two decklists deals the same opening hands and the same library order, which a
 * player can learn by replaying and then use to read the opponent's draws.
 */
export const DEFAULT_GAME_SEED = 0xc0ffee;

/** Upper bound (exclusive) of the seed space — the core RNG consumes a uint32. */
export const GAME_SEED_SPACE = 0x1_0000_0000;
