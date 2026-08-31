/**
 * Tests for the in-progress-game persistence (persist.ts): the codec, the
 * deterministic replay restore, the storage failure modes, and the debounced
 * saver. The philosophy is the history-store's — storage is injected so the
 * failures a real localStorage will not perform on cue (quota, corruption,
 * refusal) are exercised rather than hoped about — plus one new obligation:
 * a RESTORED game must equal the live one exactly, which is asserted on the
 * engine's own serialized snapshot, the RNG cursor, and every zone's instance
 * ids, not on a summary.
 */
import { describe, expect, it } from 'vitest';
import { createRng, serializeState, type GameAction, type PlayerId } from '@jonny-boi/core';
import { createDefaultAiRegistry } from '@jonny-boi/ai';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { PLAY_PERSIST_MAX_CHARS, PLAY_RESUME_STORAGE_KEY } from '../config.js';
import { aiAction } from './ai-seat.js';
import {
  PLAY_RECORD_VERSION,
  buildPlayRecord,
  clearSavedGame,
  createGameSaver,
  decodeRecord,
  encodeRecord,
  mulliganReseed,
  readSavedGame,
  rebuildFromRecord,
  writeSavedGame,
  type MulliganStep,
  type PlayRecord,
  type PlayStorage,
} from './persist.js';
import { GameSession } from './session.js';
import { startHotseatGame, type DeckChoice } from './setup.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Resa', B: 'Uma' };

/**
 * The fixture's game: a Selesnya Blink mirror. Chosen because its optional
 * blink triggers park REAL engine choices, so the recorded action log contains
 * `answerChoice` entries — the hardest thing a replay has to get right.
 */
const FIXTURE_DECK_NAME = 'Selesnya Blink';

/**
 * Seed + drive length probed so the pilot-driven fixture (with its mulligan)
 * parks and answers its first choice around action 90 — {@link DRIVEN_ACTIONS}
 * leaves generous slack, and the game is still turns from ending. If a pilot
 * change moves the game enough to break the answerChoice witness below,
 * re-probe: drive seeds 1..10 and pick one whose first answerChoice lands
 * well inside the window.
 */
const GAME_SEED = 5;
const DRIVEN_ACTIONS = 160;

function sampleChoice(): DeckChoice {
  const deck = SAMPLE_DECKS.find((d) => d.name === FIXTURE_DECK_NAME);
  if (!deck) throw new Error(`no sample deck named "${FIXTURE_DECK_NAME}"`);
  return { source: 'sample', deck };
}

/** The driving pilot, present or the fixture cannot exist at all. */
function heuristicPilot() {
  const pilot = createDefaultAiRegistry().getPilot('heuristic');
  if (!pilot) throw new Error('the heuristic pilot should always be registered');
  return pilot;
}

/** Everything a LIVE game accumulates that the record snapshots. */
interface LiveFixture {
  readonly session: GameSession;
  readonly transcript: readonly MulliganStep[];
  readonly choiceA: DeckChoice;
  readonly choiceB: DeckChoice;
}

/**
 * Build the live game EXACTLY the way PlayView does: begin from the base seed,
 * seat A mulligans once (recreating from {@link mulliganReseed}), A keeps
 * bottoming their first card, B keeps everything, then the heuristic pilot
 * drives both seats for {@link DRIVEN_ACTIONS} accepted actions.
 */
function playLiveGame(): LiveFixture {
  const choiceA = sampleChoice();
  const choiceB = sampleChoice();
  const transcript: MulliganStep[] = [];

  // Seat A ships the opening seven: the game is recreated from the derived seed.
  transcript.push({ kind: 'mulligan', seat: 'A' });
  const started = startHotseatGame({
    choiceA,
    choiceB,
    seed: mulliganReseed(GAME_SEED, 1),
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('sample decks should be legal');
  let session = GameSession.fromCreated(started.game.created, started.game.registry, SEAT_NAMES);

  // A keeps, bottoming the first card of the redrawn hand (London owes one).
  const bottomed = [session.state.players.A.hand[0]!.instanceId];
  session = session.bottomCards('A', bottomed);
  transcript.push({ kind: 'keep', seat: 'A', bottomed });
  // B keeps the whole seven.
  transcript.push({ kind: 'keep', seat: 'B', bottomed: [] });

  const pilot = heuristicPilot();
  const rng = createRng(GAME_SEED);
  for (let i = 0; i < DRIVEN_ACTIONS && !session.gameOver; i++) {
    const action = aiAction(session, pilot, rng);
    if (!action) break;
    const result = session.submit(action);
    if (result.rejected) throw new Error(`pilot picked a rejected action: ${result.rejected}`);
    session = result.session;
  }
  return { session, transcript, choiceA, choiceB };
}

/** Snapshot the record the live fixture would persist. */
function recordOf(fixture: LiveFixture, savedAt = 1_756_500_000_000): PlayRecord {
  return buildPlayRecord(
    {
      names: SEAT_NAMES,
      choiceA: fixture.choiceA,
      choiceB: fixture.choiceB,
      startingPlayer: 'A',
      seed: GAME_SEED,
      ai: { seat: 'B', pilotId: 'heuristic' },
      mulligans: fixture.transcript,
      session: fixture.session,
      ui: { revealed: 'A', scrollY: 480 },
    },
    savedAt,
  );
}

/**
 * The equality that "restored exactly" means: the engine's own serialized
 * snapshot (life, zones sizes, battlefield stats, pending choice), the RNG
 * cursor, the step/priority/turn, and the exact instance ids in every hidden
 * zone (the snapshot only carries counts for those).
 */
function digestOf(session: GameSession): unknown {
  const zone = (cards: readonly { instanceId: number; def: { id: string } }[]) =>
    cards.map((c) => `${c.instanceId}:${c.def.id}`);
  return {
    serialized: serializeState(session.state),
    rngState: session.state.rngState,
    step: session.state.step,
    priority: session.state.priorityPlayer,
    turn: session.state.turnNumber,
    pendingChoiceId: session.pendingChoice?.id ?? null,
    battlefield: session.state.battlefield.map((c) => `${c.instanceId}:${c.def.id}:${c.tapped ? 'T' : 'u'}`),
    zones: Object.fromEntries(
      (['A', 'B'] as const).map((p) => [
        p,
        {
          hand: zone(session.state.players[p].hand),
          library: zone(session.state.players[p].library),
          graveyard: zone(session.state.players[p].graveyard),
          exile: zone(session.state.players[p].exile),
        },
      ]),
    ),
  };
}

/** An in-memory `localStorage` whose behaviour a test can bend. */
function fakeStorage(
  options: { readonly failWrites?: boolean; readonly failReads?: boolean } = {},
): { storage: PlayStorage; map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage: PlayStorage = {
    getItem: (key) => {
      if (options.failReads) throw new Error('storage is blocked');
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (options.failWrites) throw new Error('quota exceeded');
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return { storage, map };
}

describe('the record codec', () => {
  const fixture = playLiveGame();
  const record = recordOf(fixture);

  it('round-trips byte-stably: encode → decode → encode is identical', () => {
    const encoded = encodeRecord(record);
    const decoded = decodeRecord(encoded);
    expect(decoded).not.toBeNull();
    expect(encodeRecord(decoded!)).toBe(encoded);
    expect(decoded).toEqual(record);
  });

  it('the fixture is the hard case on purpose: a mulligan AND an answered choice', () => {
    // If either witness fails, the fixture stopped exercising what it claims to
    // (see the seed-probing note on GAME_SEED) — the suite must say so loudly
    // rather than keep passing on an easier game.
    expect(record.mulligans.some((m) => m.kind === 'mulligan')).toBe(true);
    expect(record.mulligans.some((m) => m.kind === 'keep' && m.bottomed.length > 0)).toBe(true);
    expect(record.actions.some((a) => a.kind === 'answerChoice')).toBe(true);
    expect(fixture.session.gameOver).toBe(false);
  });

  it('discards any other version, silently', () => {
    expect(decodeRecord(encodeRecord({ ...record, version: PLAY_RECORD_VERSION + 1 }))).toBeNull();
    expect(decodeRecord(encodeRecord({ ...record, version: 0 }))).toBeNull();
  });

  it('discards garbage, truncation, and shape drift', () => {
    expect(decodeRecord('not json at all')).toBeNull();
    expect(decodeRecord(encodeRecord(record).slice(0, 40))).toBeNull();
    expect(decodeRecord('null')).toBeNull();
    expect(decodeRecord('[]')).toBeNull();
    expect(decodeRecord(JSON.stringify({ version: PLAY_RECORD_VERSION }))).toBeNull();
    const noDeck = { ...record, setup: { ...record.setup, deckA: { name: 'x' } } };
    expect(decodeRecord(JSON.stringify(noDeck))).toBeNull();
    const badStep = { ...record, mulligans: [{ kind: 'mulligan', seat: 'C' }] };
    expect(decodeRecord(JSON.stringify(badStep))).toBeNull();
  });

  it('refuses an oversized blob outright', () => {
    expect(decodeRecord('x'.repeat(PLAY_PERSIST_MAX_CHARS + 1))).toBeNull();
  });
});

describe('replay restore', () => {
  const fixture = playLiveGame();
  const record = recordOf(fixture);

  it('rebuilds the exact live state through the storage round-trip', () => {
    const decoded = decodeRecord(encodeRecord(record));
    expect(decoded).not.toBeNull();
    const rebuilt = rebuildFromRecord(decoded!);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(digestOf(rebuilt.game.session)).toEqual(digestOf(fixture.session));
    // The rebuilt session carries the same replay script forward, so a SECOND
    // save/restore cycle starts from identical footing.
    expect(rebuilt.game.session.actions).toEqual(fixture.session.actions);
    // Mulligan progress replays to the live reducer's outcome.
    expect(rebuilt.game.mulligan).toEqual({
      deciding: 'B',
      taken: { A: 1, B: 0 },
      done: { A: true, B: true },
    });
  });

  it('the restored session keeps playing identically (not just standing still)', () => {
    const rebuilt = rebuildFromRecord(record);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    // Drive both the live and restored sessions with the same continued RNG
    // stream and pilot; they must stay in lockstep — the restored game IS the
    // live game, not a lookalike.
    const pilot = heuristicPilot();
    const continueGame = (start: GameSession, steps: number): GameSession => {
      // A fresh stream for each run keeps the two runs identical to each other.
      const rng = createRng(GAME_SEED ^ 0xbeef);
      let session = start;
      for (let i = 0; i < steps && !session.gameOver; i++) {
        const action = aiAction(session, pilot, rng);
        if (!action) break;
        const result = session.submit(action);
        if (result.rejected) break;
        session = result.session;
      }
      return session;
    };
    const CONTINUE_STEPS = 40;
    const liveOn = continueGame(fixture.session, CONTINUE_STEPS);
    const restoredOn = continueGame(rebuilt.game.session, CONTINUE_STEPS);
    expect(digestOf(restoredOn)).toEqual(digestOf(liveOn));
  });

  it('fails whole, with a reason, when an action no longer replays', () => {
    const tampered: PlayRecord = {
      ...record,
      actions: record.actions.map((a, i) =>
        i === record.actions.length - 1 ? ({ ...a, kind: 'playLand', instanceId: 999_999 } as GameAction) : a,
      ),
    };
    const rebuilt = rebuildFromRecord(tampered);
    expect(rebuilt.ok).toBe(false);
    if (rebuilt.ok) return;
    expect(rebuilt.reason).toContain('replay diverged');
  });

  it('fails whole when the saved decks no longer validate', () => {
    const gutted: PlayRecord = {
      ...record,
      setup: { ...record.setup, deckA: { ...record.setup.deckA, cards: [] } },
    };
    const rebuilt = rebuildFromRecord(gutted);
    expect(rebuilt.ok).toBe(false);
    if (rebuilt.ok) return;
    expect(rebuilt.reason).toContain('no longer validate');
  });
});

describe('storage', () => {
  const fixture = playLiveGame();
  const record = recordOf(fixture);

  it('absent storage → no saved game, no crash', () => {
    expect(readSavedGame(null)).toBeNull();
    writeSavedGame(record, null); // must not throw
    clearSavedGame(null); // must not throw
  });

  it('round-trips through a healthy storage', () => {
    const { storage } = fakeStorage();
    writeSavedGame(record, storage);
    expect(readSavedGame(storage)).toEqual(record);
    clearSavedGame(storage);
    expect(readSavedGame(storage)).toBeNull();
  });

  it('corrupt blob → clean fresh start', () => {
    const { storage, map } = fakeStorage();
    map.set(PLAY_RESUME_STORAGE_KEY, '{"version":1,'); // truncated write
    expect(readSavedGame(storage)).toBeNull();
  });

  it('throwing storage (read or write) degrades silently', () => {
    const blockedReads = fakeStorage({ failReads: true });
    expect(readSavedGame(blockedReads.storage)).toBeNull();
    const blockedWrites = fakeStorage({ failWrites: true });
    writeSavedGame(record, blockedWrites.storage); // must not throw
    expect(blockedWrites.map.size).toBe(0);
  });

  it('never writes what it would refuse to read (the size cap)', () => {
    const { storage, map } = fakeStorage();
    // A record bloated past the cap by a giant name — writeSavedGame must skip it.
    const bloated: PlayRecord = {
      ...record,
      setup: {
        ...record.setup,
        names: { A: 'x'.repeat(PLAY_PERSIST_MAX_CHARS), B: SEAT_NAMES.B },
      },
    };
    writeSavedGame(bloated, storage);
    expect(map.size).toBe(0);
  });
});

describe('the debounced saver', () => {
  const fixture = playLiveGame();
  const record = recordOf(fixture);

  /** A hand-cranked scheduler: the test decides when "later" happens. */
  function crankedScheduler() {
    let pending: (() => void) | null = null;
    return {
      schedule: (fn: () => void) => {
        pending = fn;
        return fn;
      },
      cancel: () => {
        pending = null;
      },
      crank: () => {
        const fn = pending;
        pending = null;
        fn?.();
      },
      hasPending: () => pending !== null,
    };
  }

  it('debounces: nothing hits storage until the window elapses', () => {
    const { storage, map } = fakeStorage();
    const timer = crankedScheduler();
    const saver = createGameSaver({ storage, schedule: timer.schedule, cancel: timer.cancel });
    saver.save(record);
    expect(map.size).toBe(0);
    timer.crank();
    expect(readSavedGame(storage)).toEqual(record);
  });

  it('flush() writes the pending record immediately (the update-reload path)', () => {
    const { storage, map } = fakeStorage();
    const timer = crankedScheduler();
    const saver = createGameSaver({ storage, schedule: timer.schedule, cancel: timer.cancel });
    saver.save(record);
    expect(map.size).toBe(0);
    saver.flush();
    expect(readSavedGame(storage)).toEqual(record);
    // Idempotent: a second flush with nothing pending writes nothing new.
    map.clear();
    saver.flush();
    expect(map.size).toBe(0);
  });

  it('saveScroll patches only the viewport onto the last record', () => {
    const { storage } = fakeStorage();
    const timer = crankedScheduler();
    const saver = createGameSaver({ storage, schedule: timer.schedule, cancel: timer.cancel });
    saver.saveScroll(999); // before any record: nothing to patch, no crash
    saver.save(record);
    saver.saveScroll(1234);
    saver.flush();
    const stored = readSavedGame(storage);
    expect(stored?.ui.scrollY).toBe(1234);
    expect(stored ? { ...stored, ui: { ...stored.ui, scrollY: record.ui.scrollY } } : null).toEqual(record);
  });

  it('clear() cancels the pending write and removes the stored record', () => {
    const { storage, map } = fakeStorage();
    const timer = crankedScheduler();
    const saver = createGameSaver({ storage, schedule: timer.schedule, cancel: timer.cancel });
    saver.save(record);
    saver.flush();
    expect(map.size).toBe(1);
    saver.save({ ...record, savedAt: record.savedAt + 1 });
    saver.clear();
    expect(map.size).toBe(0);
    expect(timer.hasPending()).toBe(false);
    timer.crank(); // even a stray crank after clear writes nothing
    expect(map.size).toBe(0);
  });
});
