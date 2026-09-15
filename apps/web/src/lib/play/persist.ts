/**
 * IN-PROGRESS GAME PERSISTENCE — how a Solo / pass-and-play game survives a
 * reload, a tab kill, or an app update, and comes back EXACTLY as it was.
 *
 * ## What is stored (and what deliberately is not)
 *
 * The engine is deterministic: the RNG lives inside `GameState`, so
 * `createGame(seed, decks)` + the ordered list of accepted actions replays to
 * the exact same state, bit for bit (the sim's determinism suite pins this).
 * So the record stores the game's INPUTS — resolved decklists, seed, starting
 * player, the mulligan transcript, and `GameSession.actions` — and restore is
 * a REPLAY through the very same code path the live game took. `GameState`
 * itself is never serialized: its card definitions are huge, its shape moves
 * with every engine feature, and any drift between a stored snapshot and the
 * running engine would resurrect a game the rules no longer agree with.
 *
 * Two flows live OUTSIDE the engine's action log and therefore ride their own
 * transcript here:
 *   - a MULLIGAN re-creates the whole game from a derived seed
 *     ({@link mulliganReseed}), and
 *   - a KEEP bottoms cards via `GameSession.bottomCards`, a pre-game library
 *     manipulation, not an action.
 * Both are replayed by {@link rebuildFromRecord} through the same
 * `startHotseatGame`/`bottomCards` calls the live PlayView makes, so the
 * transcript cannot mean something different on restore than it did live.
 *
 * ## Storage discipline (the imported-cards store's rules, kept on purpose)
 *
 * localStorage, one key, best-effort: a full quota, private browsing, or a
 * corrupt/oversized/alien blob degrades to "no saved game" — never a crash and
 * never a half-restored one. Every read is validated (version field + shape),
 * and the deep validator is the replay itself: a record whose actions the
 * engine refuses is discarded with a reason rather than trusted part-way.
 *
 * Decks are stored RESOLVED (the exact `{cardId, count}` list the game started
 * from), not as references to saved decks — editing a deck in the builder must
 * not rewrite history under an in-progress game.
 */
import type { GameAction, InstanceId, PlayerId } from '@jonny-boi/core';
import type { Deck as SimDeck } from '@jonny-boi/sim';
import {
  PLAY_PERSIST_DEBOUNCE_MS,
  PLAY_PERSIST_MAX_CHARS,
  PLAY_RESUME_STORAGE_KEY,
} from '../config.js';
import {
  removeStorage,
  writeStorage,
  type StorageWriteResult,
} from '../persistence/write.js';
import { GameSession } from './session.js';
import { startHotseatGame, toSimDeck, type DeckChoice } from './setup.js';

/**
 * The record-shape version. Bump ONLY on an incompatible change, together with
 * the storage key's `.vN` suffix in config.ts; {@link decodeRecord} discards
 * any other version silently (a stale save is worth less than a clean start).
 */
export const PLAY_RECORD_VERSION = 1;

/** The computer's seat in a persisted solo game (absent = pass-and-play). */
export interface PersistedAiSeat {
  readonly seat: PlayerId;
  readonly pilotId: string;
}

/** Everything `startHotseatGame` needs to re-create turn zero. */
export interface PersistedSetup {
  readonly names: Readonly<Record<PlayerId, string>>;
  /** Seat A's decklist, RESOLVED at game start (see the module doc). */
  readonly deckA: SimDeck;
  /** Seat B's decklist, RESOLVED at game start. */
  readonly deckB: SimDeck;
  readonly startingPlayer: PlayerId;
  /** The BASE game seed ({@link mulliganReseed} derives reshuffles from it). */
  readonly seed: number;
  /** Present exactly when the game is Solo vs the computer. */
  readonly ai?: PersistedAiSeat;
}

/**
 * One step of the pre-game mulligan flow, in the order it happened. These are
 * NOT engine actions (see the module doc), which is exactly why they need
 * their own transcript.
 */
export type MulliganStep =
  | { readonly kind: 'mulligan'; readonly seat: PlayerId }
  | { readonly kind: 'keep'; readonly seat: PlayerId; readonly bottomed: readonly InstanceId[] };

/**
 * Where the two seats are in the mulligan flow — the same shape PlayView keeps
 * as component state, exported from here so the live reducer and the replay
 * reducer ({@link rebuildFromRecord}) share one definition and cannot drift.
 */
export interface MulliganProgress {
  /** Seat currently deciding (meaningful until both are done). */
  readonly deciding: PlayerId;
  /** How many mulligans each seat has taken so far. */
  readonly taken: Record<PlayerId, number>;
  /** Seats that have finalized their keep. */
  readonly done: Record<PlayerId, boolean>;
}

/** Screen-restore hints — everything "where was I" that replay cannot rebuild. */
export interface PersistedUi {
  /** Who last confirmed they were looking (pass-and-play privacy gate). */
  readonly revealed: PlayerId | null;
  /** `window.scrollY` at save time, restored after the board mounts. */
  readonly scrollY: number;
  /** Turn number at save time — display only (the resume banner's summary). */
  readonly turn: number;
}

/** The one persisted in-progress game. */
export interface PlayRecord {
  readonly version: number;
  /** Epoch ms at save time — display only ("saved 5 minutes ago"). */
  readonly savedAt: number;
  readonly setup: PersistedSetup;
  readonly mulligans: readonly MulliganStep[];
  /** `GameSession.actions` — the deterministic replay script. */
  readonly actions: readonly GameAction[];
  readonly ui: PersistedUi;
}

// --- the mulligan reshuffle seed ---------------------------------------------------

/**
 * Knuth's multiplicative-hash constant (2^32 / φ): spreads consecutive
 * mulligan counts across the seed space so reshuffle N+1 shares nothing
 * recognisable with reshuffle N.
 */
const RESEED_MULTIPLIER = 2654435761;

/**
 * The seed for a seat's `nth` mulligan reshuffle, derived from the game's base
 * seed. Extracted from PlayView (which now imports it) because the REPLAY in
 * {@link rebuildFromRecord} must derive the identical seed or restore a
 * different opening hand — one formula, two callers, zero drift.
 */
export function mulliganReseed(baseSeed: number, nth: number): number {
  return (baseSeed * RESEED_MULTIPLIER + nth) >>> 0;
}

// --- codec -------------------------------------------------------------------------

/** Serialize a record for storage. Plain `JSON.stringify` — see decode. */
export function encodeRecord(record: PlayRecord): string {
  return JSON.stringify(record);
}

/** True when `value` is a plain object (the only container the codec trusts). */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One seat id, exactly. */
function isPlayerId(value: unknown): value is PlayerId {
  return value === 'A' || value === 'B';
}

/** Shape-check one mulligan step (deep enough to replay safely). */
function isMulliganStep(value: unknown): value is MulliganStep {
  if (!isRecordObject(value) || !isPlayerId(value.seat)) return false;
  if (value.kind === 'mulligan') return true;
  return value.kind === 'keep' && Array.isArray(value.bottomed);
}

/** Shape-check a resolved decklist. */
function isSimDeck(value: unknown): value is SimDeck {
  return (
    isRecordObject(value) &&
    typeof value.name === 'string' &&
    Array.isArray(value.cards) &&
    value.cards.every((c: unknown) => isRecordObject(c) && typeof c.cardId === 'string')
  );
}

/**
 * Decode + validate a stored record. Returns null for anything that is not a
 * well-formed CURRENT-version record: wrong/missing version (an older or newer
 * app wrote it), truncated JSON, or a shape that would not replay. Validation
 * here is structural; the SEMANTIC validation is the replay itself, which
 * refuses a record whose actions the engine rejects.
 *
 * The parsed object is returned as-is (not rebuilt), so
 * `encode(decode(encode(r)))` is byte-identical to `encode(r)` — JSON.parse
 * preserves key order and stringify re-emits it — which is what makes the
 * round-trip testable as an equality of strings.
 */
export function decodeRecord(raw: string): PlayRecord | null {
  if (raw.length > PLAY_PERSIST_MAX_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecordObject(parsed)) return null;
  if (parsed.version !== PLAY_RECORD_VERSION) return null;
  const setup = parsed.setup;
  if (!isRecordObject(setup)) return null;
  if (!isSimDeck(setup.deckA) || !isSimDeck(setup.deckB)) return null;
  if (!isPlayerId(setup.startingPlayer) || typeof setup.seed !== 'number') return null;
  if (!isRecordObject(setup.names) || typeof setup.names.A !== 'string' || typeof setup.names.B !== 'string') {
    return null;
  }
  if (setup.ai !== undefined) {
    if (!isRecordObject(setup.ai) || !isPlayerId(setup.ai.seat) || typeof setup.ai.pilotId !== 'string') {
      return null;
    }
  }
  if (!Array.isArray(parsed.mulligans) || !parsed.mulligans.every(isMulliganStep)) return null;
  if (!Array.isArray(parsed.actions) || !parsed.actions.every(isRecordObject)) return null;
  const ui = parsed.ui;
  if (!isRecordObject(ui) || typeof ui.scrollY !== 'number' || typeof ui.turn !== 'number') return null;
  if (ui.revealed !== null && !isPlayerId(ui.revealed)) return null;
  return parsed as unknown as PlayRecord;
}

// --- building a record from the live game ------------------------------------------

/** The live-game inputs {@link buildPlayRecord} snapshots. */
export interface PlayRecordInputs {
  readonly names: Readonly<Record<PlayerId, string>>;
  readonly choiceA: DeckChoice;
  readonly choiceB: DeckChoice;
  readonly startingPlayer: PlayerId;
  readonly seed: number;
  readonly ai?: PersistedAiSeat;
  readonly mulligans: readonly MulliganStep[];
  readonly session: GameSession;
  readonly ui: Omit<PersistedUi, 'turn'>;
}

/** Snapshot the live game as a persistable record. Pure — no storage here. */
export function buildPlayRecord(inputs: PlayRecordInputs, now: number = Date.now()): PlayRecord {
  return {
    version: PLAY_RECORD_VERSION,
    savedAt: now,
    setup: {
      names: { A: inputs.names.A, B: inputs.names.B },
      deckA: toSimDeck(inputs.choiceA),
      deckB: toSimDeck(inputs.choiceB),
      startingPlayer: inputs.startingPlayer,
      seed: inputs.seed,
      ...(inputs.ai ? { ai: inputs.ai } : {}),
    },
    mulligans: inputs.mulligans,
    actions: inputs.session.actions,
    ui: { ...inputs.ui, turn: inputs.session.state.turnNumber },
  };
}

// --- rebuilding the game from a record ----------------------------------------------

/** A fully rebuilt game, ready to hand to the Play view's state. */
export interface RebuiltGame {
  readonly session: GameSession;
  readonly mulligan: MulliganProgress;
  /** The `DeckChoice`s the view keeps for rematch — resolved lists, source 'sample'. */
  readonly choiceA: DeckChoice;
  readonly choiceB: DeckChoice;
  readonly record: PlayRecord;
}

export type RebuildResult =
  | { readonly ok: true; readonly game: RebuiltGame }
  | { readonly ok: false; readonly reason: string };

/**
 * Replay a record back into a live `GameSession` + mulligan progress.
 *
 * The steps are EXACTLY the live ones: `startHotseatGame` with the base seed,
 * each 'mulligan' step re-creating the game from {@link mulliganReseed}, each
 * 'keep' bottoming through `GameSession.bottomCards`, then every action
 * through `GameSession.submit`. Anything the engine refuses — a decklist that
 * no longer validates (an imported card since deleted), an action the rules no
 * longer accept — fails the WHOLE rebuild with a reason; a partially replayed
 * game is a different game, not a restored one.
 *
 * `throughAction` replays only the first N actions (§3.66's scrubber and fork).
 * That is NOT the partial replay the paragraph above refuses: this one stops at
 * a point the caller ASKED for, so the result is an exact earlier state of this
 * same game rather than an accidental truncation of it. Omit it to replay the
 * whole record, which is what resuming does.
 */
export function rebuildFromRecord(record: PlayRecord, throughAction?: number): RebuildResult {
  const choiceA: DeckChoice = { source: 'sample', deck: record.setup.deckA };
  const choiceB: DeckChoice = { source: 'sample', deck: record.setup.deckB };
  const base = {
    choiceA,
    choiceB,
    startingPlayer: record.setup.startingPlayer,
  };

  const started = startHotseatGame({ ...base, seed: record.setup.seed });
  if (!started.ok) {
    const problems = [...started.problems.a, ...started.problems.b].join(' · ');
    return { ok: false, reason: `the saved decks no longer validate: ${problems}` };
  }
  let session = GameSession.fromCreated(started.game.created, started.game.registry, record.setup.names);

  const taken: Record<PlayerId, number> = { A: 0, B: 0 };
  const done: Record<PlayerId, boolean> = { A: false, B: false };
  let deciding: PlayerId = record.setup.startingPlayer;

  for (const step of record.mulligans) {
    if (step.kind === 'mulligan') {
      const nth = taken[step.seat] + 1;
      const restarted = startHotseatGame({ ...base, seed: mulliganReseed(record.setup.seed, nth) });
      if (!restarted.ok) return { ok: false, reason: 'the saved decks no longer validate' };
      session = GameSession.fromCreated(restarted.game.created, restarted.game.registry, record.setup.names);
      taken[step.seat] = nth;
    } else {
      session = session.bottomCards(step.seat, step.bottomed);
      done[step.seat] = true;
      const other: PlayerId = step.seat === 'A' ? 'B' : 'A';
      // Mirror the live reducer: hand the decision over only while the other
      // seat still owes one; once both kept, `deciding` stops mattering.
      if (!done[other]) deciding = other;
    }
  }

  const stopAt =
    throughAction === undefined
      ? record.actions.length
      : Math.max(0, Math.min(Math.floor(throughAction), record.actions.length));
  for (let i = 0; i < stopAt; i++) {
    const result = session.submit(record.actions[i] as GameAction);
    if (result.rejected) {
      return {
        ok: false,
        reason: `replay diverged at action ${i + 1}/${record.actions.length}: ${result.rejected}`,
      };
    }
    session = result.session;
  }

  return {
    ok: true,
    game: { session, mulligan: { deciding, taken, done }, choiceA, choiceB, record },
  };
}

// --- storage -----------------------------------------------------------------------

/** The slice of the Web Storage API this module uses — injectable for tests. */
export interface PlayStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The real localStorage, or null where storage is unavailable (private mode). */
function defaultStorage(): PlayStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some embedders THROW on the accessor itself; that is "no storage", not a crash.
    return null;
  }
}

/** Read + validate the saved game, or null. Never throws. */
export function readSavedGame(storage: PlayStorage | null = defaultStorage()): PlayRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PLAY_RESUME_STORAGE_KEY);
    return raw === null ? null : decodeRecord(raw);
  } catch {
    return null;
  }
}

/**
 * Write the saved game.
 *
 * NO LONGER SILENT. This used to swallow quota failures on the reasoning that
 * "persistence is a convenience, not a prerequisite" — true of the game you are
 * looking at, and false of the user's belief that it will still be there
 * tomorrow. The same swallow in `storage.ts` is what lost two imported decks, so
 * the whole class routes through one funnel now: the result comes back, and the
 * funnel raises the banner.
 *
 * The size cap comes from `persistence/budget.ts` rather than from this
 * module's own literal — four features each sizing themselves against the whole
 * origin is the root cause, not a detail.
 */
export function writeSavedGame(
  record: PlayRecord,
  storage: PlayStorage | null = defaultStorage(),
): StorageWriteResult {
  return writeStorage('play-in-progress', PLAY_RESUME_STORAGE_KEY, encodeRecord(record), {
    storage,
  });
}

/** Remove the saved game (game over, concede, discard, new game). */
export function clearSavedGame(storage: PlayStorage | null = defaultStorage()): void {
  // A failed remove is genuinely harmless: decode still guards what is left.
  removeStorage('play-in-progress', PLAY_RESUME_STORAGE_KEY, { storage });
}

// --- the debounced saver -------------------------------------------------------------

/** Injectable timer seams (tests drive them synchronously). */
export interface GameSaverDeps {
  readonly storage?: PlayStorage | null;
  readonly debounceMs?: number;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

/**
 * The per-game writer the Play view holds: debounced (one write per burst of
 * actions), force-flushable (before an update reload / on page hide), and the
 * single owner of "clear on game end".
 */
export interface GameSaver {
  /** Schedule `record` to be written after the debounce window. */
  save(record: PlayRecord): void;
  /** Patch ONLY the scroll position onto the last saved record (cheap, debounced). */
  saveScroll(scrollY: number): void;
  /** Write any pending record NOW (update reload, page hide, unmount). */
  flush(): void;
  /** Drop the pending write AND the stored record (game over / discard). */
  clear(): void;
  /** The record that would be written next, for tests and callers that patch. */
  pending(): PlayRecord | null;
}

/** Build a {@link GameSaver}. All dependencies injectable; defaults are real. */
export function createGameSaver(deps: GameSaverDeps = {}): GameSaver {
  const storage = deps.storage !== undefined ? deps.storage : defaultStorage();
  const debounceMs = deps.debounceMs ?? PLAY_PERSIST_DEBOUNCE_MS;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let last: PlayRecord | null = null;
  let dirty = false;
  let handle: unknown = null;

  const cancelPending = (): void => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
  };
  const flush = (): void => {
    cancelPending();
    if (!dirty || last === null) return;
    dirty = false;
    writeSavedGame(last, storage);
  };
  const scheduleFlush = (): void => {
    cancelPending();
    handle = schedule(flush, debounceMs);
  };

  return {
    save(record) {
      last = record;
      dirty = true;
      scheduleFlush();
    },
    saveScroll(scrollY) {
      if (last === null || last.ui.scrollY === scrollY) return;
      last = { ...last, ui: { ...last.ui, scrollY } };
      dirty = true;
      scheduleFlush();
    },
    flush,
    clear() {
      cancelPending();
      last = null;
      dirty = false;
      clearSavedGame(storage);
    },
    pending: () => last,
  };
}
