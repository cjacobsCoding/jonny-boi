import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { createRng, type InstanceId, type PlayerId } from '@jonny-boi/core';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type { DecksApi } from '../lib/useDecks.js';
import { GameSession, type SubmitResult } from '../lib/play/session.js';
import {
  startHotseatGame,
  type DeckChoice,
} from '../lib/play/setup.js';
import {
  buildPlayRecord,
  clearSavedGame,
  createGameSaver,
  mulliganReseed,
  readSavedGame,
  rebuildFromRecord,
  type MulliganProgress,
  type MulliganStep,
  type PlayRecord,
  type RebuildResult,
  type RebuiltGame,
} from '../lib/play/persist.js';
import { appUpdater, markUpdateResumeHandled, updateResumeFlag } from '../lib/update/updater.js';
import {
  createLocalHotseatTransport,
  createSoloVsAiTransport,
  type SeatInfo,
  type SeatTransport,
} from '../lib/play/seat.js';
import { aiAction, aiMustAct, type AiSeatConfig } from '../lib/play/ai-seat.js';
import { PilotPicker } from '../components/lab/PilotControls.js';
import { COMBAT_HOLD_CONFIG, HOTSEAT_CONFIG, SPELL_HOLD_CONFIG } from '../lib/play/play-config.js';
import { stackEntries } from '../lib/play/stack-view.js';
import {
  extendPressure,
  holdDurationMs,
  NO_HOLD_PRESSURE,
  pointerPressure,
  spellHoldDecision,
  type HoldPressure,
  type SpellHold,
} from '../lib/play/spell-hold.js';
import {
  combatHoldDecision,
  combatWindowFactsOf,
  type CombatHold,
  type CombatHoldKind,
} from '../lib/play/combat-hold.js';
import { usePrefersReducedMotion } from '../components/play/AnimationLayer.js';
import { buildBoardView } from '../lib/play/view-model.js';
import { SetupScreen } from '../components/play/SetupScreen.js';
import { MulliganScreen } from '../components/play/MulliganScreen.js';
import { HandoffScreen } from '../components/play/HandoffScreen.js';
import { AiMulliganScreen, AutoReady } from '../components/play/AiMulliganScreen.js';
import { handoffIsToComputer, mulliganPresentationFor } from '../lib/play/solo-screen.js';
import { PlayBoard } from '../components/play/PlayBoard.js';
import { EndScreen } from '../components/play/EndScreen.js';
import { OnlinePlay } from '../components/online/OnlinePlay.js';
import {
  resolveStartingPlayer,
  type StarterPreference,
} from '../lib/play/first-player.js';
import {
  deleteEntry,
  readHistory,
  updateHistory,
  upsertEntry,
  type HistoryEntry,
  type HistoryOutcome,
} from '../lib/play/history.js';
import { libraryRows } from '../lib/play/library-view.js';
import { shouldStopForPriority, type PriorityStops } from '../lib/play/priority-stops.js';
import { stopContextFor } from '../lib/play/priority-stops-session.js';
import { loadPriorityStops, savePriorityStops } from '../lib/play/priority-stops-pref.js';
import { GameLibrary } from '../components/play/GameLibrary.js';
import { ReviewScrubber } from '../components/play/ReviewScrubber.js';
import './play-resume.css';

/**
 * A fresh library id for a game. `randomUUID` where the platform has it, and a
 * time+random fallback where it does not (older embedded webviews) — an id only
 * has to be unique within one browser's library, so this is ample.
 */
function newGameId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `g${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * No combat beat has been spent yet. Shared and frozen-by-convention, so the
 * common case (every turn that is not the one a beat was booked in) allocates
 * nothing on a path the priority walker runs hundreds of times.
 */
const NO_BEATS_SPENT: ReadonlySet<CombatHoldKind> = new Set<CombatHoldKind>();

/** The high-level phase the hotseat is in. */
type Phase =
  | { kind: 'setup' }
  | { kind: 'mulligan' }
  | { kind: 'handoff'; to: PlayerId; context: string; next: 'mulligan' | 'play' }
  | { kind: 'play' }
  | { kind: 'error'; message: string };

/** The parameters chosen at setup, retained for rematch (with a new seed). */
interface GameConfig {
  readonly names: Readonly<Record<PlayerId, string>>;
  readonly choiceA: DeckChoice;
  readonly choiceB: DeckChoice;
  /** THIS game's first player — always concrete, so the saved record is exact. */
  readonly startingPlayer: PlayerId;
  /**
   * What was PICKED at setup, which is not the same thing: 'random' means the
   * next rematch flips again rather than repeating this game's toss (§3.63).
   */
  readonly starterPreference: StarterPreference;
}

/**
 * Mulligan progress for both seats — persist.ts's shape, shared so the live
 * flow and the saved-game replay can never disagree about what it means.
 */
type MulliganState = MulliganProgress;

/**
 * The Play view: a self-contained pass-and-play (hotseat) MTG game on one device.
 *
 * It is a small state machine over the `GameSession` (the single source of game
 * truth). Hidden-info is enforced two ways: (1) the board always renders from the
 * masked `buildBoardView` for the CURRENT viewer, and (2) a `HandoffScreen`
 * interstitial gates every transfer of control between the two humans (mulligan
 * order, turn changes, and priority passing to the other player to respond), so a
 * player never glimpses the opponent's hand. The seat/transport seam
 * (`SeatTransport`) decides when a handoff is required, so an online transport could
 * drop in later (handoffs off, each peer sees only their own seat) without touching
 * this component's rendering.
 */
/**
 * The seat the computer plays in a solo game.
 *
 * Seat B, so the human is seat A and takes the first turn by default — the same
 * orientation the board already renders for a local player, which means the solo
 * mode needs no new "which way round am I" handling anywhere.
 */
const AI_SEAT: PlayerId = 'B';

/** The seat the HUMAN holds, given which one the computer took. */
function humanSeatOf(ai: AiSeatConfig): PlayerId {
  return ai.seat === 'A' ? 'B' : 'A';
}

/** Solo vs the computer, Local (pass-and-play), or Online play. */
type PlayMode = 'choose' | 'solo' | 'local' | 'online';

/** The Play mode a saved record belongs to (solo iff it names an AI seat). */
function modeOfRecord(record: PlayRecord): PlayMode {
  return record.setup.ai ? 'solo' : 'local';
}

/** A short "when" for the resume banner without a date-formatting dependency. */
function savedAgo(savedAt: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - savedAt) / 60_000));
  if (minutes < 1) return 'moments ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * The Play tab: a landing that lets the player choose Local (pass-and-play on one
 * device) or Online (two devices over the internet). Local reuses the full hotseat
 * flow (`LocalPlay`); Online drops into the networked client (`OnlinePlay`). Both
 * reuse the same board components and theme.
 *
 * RESUME lives here: an in-progress Solo/local game persists itself (persist.ts),
 * so the menu offers "Resume game" — and when this page load was caused by an app
 * UPDATE applying itself (the updater's flag), the game is resumed automatically,
 * with no menu stop, because the user never chose to leave it.
 */
export function PlayView({ decks }: { decks: DecksApi }): ReactElement {
  // One boot-time read: the saved game (if any) and whether THIS load is an
  // update-resume. useState (not useMemo) so StrictMode's double-invoke reads
  // the memoized flag, and the values stay put for the life of the mount.
  //
  // Auto-resume requires the flag to say a game was LIVE at the moment the
  // update reloaded — merely being on the Play tab is not enough, or an update
  // applied on the menu would teleport the user back into a game they had
  // already left. (Under the deferral policy a live-game reload cannot happen
  // today, so this arm is exact-by-construction rather than load-bearing; the
  // menu's "Resume game" banner below is the everyday path.)
  const [boot] = useState(() => {
    const saved = readSavedGame();
    const flag = updateResumeFlag();
    const auto = flag?.view === 'play' && flag.gameLive && saved !== null;
    return { saved, auto };
  });
  // The saved game the MENU offers (re-read when returning to the menu).
  const [savedGame, setSavedGame] = useState<PlayRecord | null>(boot.saved);
  // The record a mounted LocalPlay should restore, when the user chose (or the
  // update flow chose for them) to resume rather than start fresh.
  const [resumeRecord, setResumeRecord] = useState<PlayRecord | null>(boot.auto ? boot.saved : null);
  /** Which library row the pending resume belongs to, so play CONTINUES it. */
  const [resumeEntryId, setResumeEntryId] = useState<string | null>(null);
  /** True when the pending open is a REVIEW rather than a continuation. */
  const [openForReview, setOpenForReview] = useState(false);
  const [mode, setMode] = useState<PlayMode>(boot.auto && boot.saved ? modeOfRecord(boot.saved) : 'choose');
  /**
   * The library as the menu shows it, DERIVED rather than mirrored in state.
   * The play surface writes to storage while this menu is not on screen, so the
   * list is re-read when the menu is shown (`mode`) and when this component
   * itself changed it (`libraryEdits`). An effect that copied storage into
   * state would be a second source of truth for something localStorage already
   * holds — and would fire a render for every read.
   */
  const [libraryEdits, setLibraryEdits] = useState(0);
  const library = useMemo<readonly HistoryEntry[]>(
    () => (mode === 'choose' ? readHistory() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- libraryEdits is the re-read trigger
    [mode, libraryEdits],
  );

  const forgetGame = useCallback((id: string): void => {
    updateHistory((entries) => deleteEntry(entries, id));
    setLibraryEdits((n) => n + 1);
  }, []);

  // Which pilot the computer plays. Held HERE rather than inside the game so it
  // survives "back to the menu" and a rematch — a player who picked Hybrid once
  // should not be silently demoted to the default on their next game. Seeded
  // from the saved game so a resumed solo game faces the SAME opponent.
  const [pilotId, setPilotId] = useState<string>(boot.saved?.setup.ai?.pilotId ?? DEFAULT_PILOT_ID);

  // The auto-resume is a one-shot: once the Play view has acted on the update
  // flag, a LATER visit must not force the user back into a game they left.
  useEffect(() => {
    markUpdateResumeHandled();
  }, []);

  // An ONLINE game's state is the server's (out of scope for persistence), but
  // the update policy must still defer while one may be underway: the surface
  // being mounted IS the game's lifetime (the socket dies with it).
  useEffect(() => {
    if (mode !== 'online') return undefined;
    appUpdater.reportGameLive('online-play', 'online-game');
    return () => appUpdater.reportGameLive('online-play', null);
  }, [mode]);

  const backToMenu = useCallback((): void => {
    setMode('choose');
    setResumeRecord(null);
    // Re-read: a game left mid-way was just saved by LocalPlay's unmount flush,
    // a finished one just cleared itself — the banner must reflect that.
    setSavedGame(readSavedGame());
  }, []);

  const resumeSaved = useCallback((): void => {
    if (!savedGame) return;
    setResumeRecord(savedGame);
    if (savedGame.setup.ai) setPilotId(savedGame.setup.ai.pilotId);
    setMode(modeOfRecord(savedGame));
  }, [savedGame]);

  /**
   * Resume any game in the library — the user's "regardless of why they weren't
   * finished". It is the same path the single-slot banner takes; the only extra
   * is carrying the entry's id so play continues that row.
   */
  const openFromLibrary = useCallback((id: string, forReview: boolean): void => {
    const entry = readHistory().find((e) => e.id === id);
    if (!entry) return;
    setResumeEntryId(entry.id);
    setOpenForReview(forReview);
    setResumeRecord(entry.record);
    if (entry.record.setup.ai) setPilotId(entry.record.setup.ai.pilotId);
    setMode(modeOfRecord(entry.record));
  }, []);

  const resumeFromLibrary = useCallback((id: string): void => openFromLibrary(id, false), [openFromLibrary]);
  const reviewFromLibrary = useCallback((id: string): void => openFromLibrary(id, true), [openFromLibrary]);

  const discardSaved = useCallback((): void => {
    clearSavedGame();
    setSavedGame(null);
  }, []);

  if (mode === 'solo') {
    const soloResume = resumeRecord?.setup.ai ? resumeRecord : undefined;
    return (
      <>
        <div className="play-view play-view--mode-bar">
          <button type="button" className="btn btn--ghost play-mode__back" onClick={backToMenu}>
            ← Play menu
          </button>
        </div>
        <LocalPlay
          decks={decks}
          ai={{ seat: soloResume?.setup.ai?.seat ?? AI_SEAT, pilotId: soloResume?.setup.ai?.pilotId ?? pilotId }}
          {...(soloResume ? { resume: soloResume } : {})}
          {...(resumeEntryId ? { resumeEntryId } : {})}
          {...(openForReview ? { review: true } : {})}
          {...(openForReview ? { review: true } : {})}
        />
      </>
    );
  }
  if (mode === 'local') {
    const localResume = resumeRecord && !resumeRecord.setup.ai ? resumeRecord : undefined;
    return (
      <>
        <div className="play-view play-view--mode-bar">
          <button type="button" className="btn btn--ghost play-mode__back" onClick={backToMenu}>
            ← Play menu
          </button>
        </div>
        <LocalPlay
          decks={decks}
          {...(localResume ? { resume: localResume } : {})}
          {...(resumeEntryId ? { resumeEntryId } : {})}
        />
      </>
    );
  }
  if (mode === 'online') {
    return (
      <>
        <div className="play-view play-view--mode-bar">
          <button type="button" className="btn btn--ghost play-mode__back" onClick={backToMenu}>
            ← Play menu
          </button>
        </div>
        <div className="play-view">
          <OnlinePlay decks={decks} />
        </div>
      </>
    );
  }

  return (
    <div className="play-view">
      <div className="play-mode">
        <h2 className="play-setup__title">Play Magic</h2>
        <p className="play-setup__intro">Choose how you want to play.</p>
        {savedGame && (
          <div className="play-resume" role="status">
            <div className="play-resume__summary">
              <strong>Game in progress</strong> — {savedGame.setup.names.A} vs {savedGame.setup.names.B},
              turn {savedGame.ui.turn} ({savedGame.setup.ai ? 'Solo' : 'pass-and-play'}), saved{' '}
              {savedAgo(savedGame.savedAt)}.
            </div>
            <div className="play-resume__actions">
              <button type="button" className="btn" onClick={resumeSaved}>
                Resume game
              </button>
              <button type="button" className="btn btn--ghost" onClick={discardSaved}>
                Discard
              </button>
            </div>
          </div>
        )}
        <GameLibrary
          rows={libraryRows(library)}
          onResume={resumeFromLibrary}
          onReview={reviewFromLibrary}
          onDelete={forgetGame}
        />
        <div className="play-mode__choices">
          <button type="button" className="play-mode__card" onClick={() => setMode('solo')}>
            <span className="play-mode__icon" aria-hidden="true">🤖</span>
            <span className="play-mode__title">Solo (vs the computer)</span>
            <span className="play-mode__desc">
              Play against an AI pilot on this device. Pick how it thinks below — the same pilots the
              Lab uses to test decks.
            </span>
          </button>
          <button type="button" className="play-mode__card" onClick={() => setMode('local')}>
            <span className="play-mode__icon" aria-hidden="true">🛋️</span>
            <span className="play-mode__title">Local (pass-and-play)</span>
            <span className="play-mode__desc">
              Two players share one device. Pass it back and forth — each sees only their own hand.
            </span>
          </button>
          <button type="button" className="play-mode__card" onClick={() => setMode('online')}>
            <span className="play-mode__icon" aria-hidden="true">🌐</span>
            <span className="play-mode__title">Online</span>
            <span className="play-mode__desc">
              Play a friend on another device over the internet. Create a room and share the code.
            </span>
          </button>
        </div>
        {/*
          The pilot picker lives on the MENU, next to the tile it configures,
          rather than inside the solo game: choosing your opponent is part of
          choosing to play one, and burying it behind "start" would mean
          discovering it only after the first game.
        */}
        <div className="play-mode__pilot">
          <PilotPicker pilotId={pilotId} onPilot={setPilotId} label="Computer opponent" />
        </div>
      </div>
    </div>
  );
}

/** The phase a REBUILT game re-enters at (mirrors the live flow's gates). */
function restoredPhase(game: RebuiltGame, ai?: AiSeatConfig): Phase {
  if (game.mulligan.done.A && game.mulligan.done.B) return { kind: 'play' };
  return ai
    ? { kind: 'mulligan' }
    : {
        kind: 'handoff',
        to: game.mulligan.deciding,
        context: 'to decide on your opening hand',
        next: 'mulligan',
      };
}

/**
 * The local game — pass-and-play by default, or SOLO when `ai` names a seat.
 *
 * Deliberately ONE component rather than a solo fork. The two modes differ in
 * exactly three places (which transport, whether a handoff screen appears, and
 * who supplies seat B's actions) and every other line — mulligans, the board,
 * the log, rematch, concede — is identical. A forked `SoloPlay` would have been
 * a second copy of all of it, drifting the first time either was touched.
 *
 * PERSISTENCE: every committed change (an accepted action, a mulligan step, a
 * reveal, a scroll) debounce-writes one localStorage record (persist.ts), and
 * `resume` rebuilds a mount from such a record by deterministic replay — same
 * seed, same decks, same actions, exact same state. The record clears itself
 * on game over / concede / new game.
 */
function LocalPlay({
  decks,
  ai,
  resume,
  resumeEntryId,
  review,
}: {
  decks: DecksApi;
  ai?: AiSeatConfig;
  resume?: PlayRecord;
  /**
   * The library id this mount is CONTINUING (§3.66). Without it a resumed game
   * would be filed as a brand-new entry on its first autosave, so the library
   * would grow a second row for a game you never stopped playing.
   */
  resumeEntryId?: string;
  /**
   * Open the record for REVIEW: the same board, plus a scrubber over the game's
   * own action log. Playing while scrubbed back forks (§3.66).
   */
  review?: boolean;
}): ReactElement {
  // Rebuild once per mount, in the initializer so the first paint is already
  // the restored game (no flash of the setup screen). Pure, so StrictMode's
  // double-invoke merely replays twice.
  const [restored] = useState<RebuildResult | null>(() => (resume ? rebuildFromRecord(resume) : null));
  const resumed = restored?.ok === true ? restored.game : null;

  const [phase, setPhase] = useState<Phase>(() => {
    if (restored && !restored.ok) {
      return { kind: 'error', message: `Couldn't resume the saved game — ${restored.reason}` };
    }
    return resumed ? restoredPhase(resumed, ai) : { kind: 'setup' };
  });
  const [config, setConfig] = useState<GameConfig | null>(() =>
    resumed && resume
      ? {
          names: resume.setup.names,
          choiceA: resumed.choiceA,
          choiceB: resumed.choiceB,
          startingPlayer: resume.setup.startingPlayer,
          // A resumed game inherits its starter as an EXPLICIT seat: the saved
          // record stores who actually started (it must, for the replay to be
          // exact) and not what was picked to get there. The cost is small and
          // worth stating — rematch after a resume keeps that seat instead of
          // flipping again. Persisting the preference too would mean versioning
          // §3.58's record for a nicety, which is the wrong trade.
          starterPreference: resume.setup.startingPlayer,
        }
      : null,
  );
  const [seed, setSeed] = useState<number>(() => resume?.setup.seed ?? HOTSEAT_CONFIG.defaultSeed);
  const [session, setSession] = useState<GameSession | null>(() => resumed?.session ?? null);

  /**
   * This game's identity in the library. Minted when a game begins and carried
   * for its whole life, so every save UPDATES one entry instead of littering
   * the library with a row per autosave. A resumed or forked game arrives with
   * its id already set, which is what makes "keep playing the same game" and
   * "this is a different playthrough" distinguishable at all.
   */
  const gameIdRef = useRef<string>(resumeEntryId ?? newGameId());
  /** Lineage for the game currently open, if it was forked from another. */
  const forkOfRef = useRef<{ readonly parentId: string; readonly forkedAt: number } | null>(null);


  const [transport, setTransport] = useState<SeatTransport | null>(() => {
    if (!resumed || !resume) return null;
    const seats: Record<PlayerId, SeatInfo> = {
      A: { id: 'A', name: resume.setup.names.A },
      B: { id: 'B', name: resume.setup.names.B },
    };
    return ai ? createSoloVsAiTransport(seats, humanSeatOf(ai)) : createLocalHotseatTransport(seats);
  });
  const [mulligan, setMulligan] = useState<MulliganState | null>(() => resumed?.mulligan ?? null);
  // Who last confirmed they're looking at the screen (for play-phase handoffs).
  const [revealed, setRevealed] = useState<PlayerId | null>(() =>
    resumed && resume ? (resume.ui.revealed ?? (ai ? humanSeatOf(ai) : null)) : null,
  );
  /**
   * REVIEW (§3.66). `scrub` is how many of the record's actions are replayed;
   * null means "not reviewing — this is a live game". The reviewed record stays
   * put while `scrub` moves, so stepping is a pure re-derivation of a state this
   * game genuinely passed through, never an edit of it.
   */
  const [scrub, setScrub] = useState<number | null>(() =>
    review && resume ? resume.actions.length : null,
  );
  const reviewing = scrub !== null && resume !== undefined;
  const scrubMax = resume?.actions.length ?? 0;

  const scrubTo = useCallback(
    (next: number) => {
      if (!resume) return;
      const clamped = Math.max(0, Math.min(Math.round(next), resume.actions.length));
      const rebuilt = rebuildFromRecord(resume, clamped);
      if (!rebuilt.ok) return; // a record that will not replay is not scrubbable
      setScrub(clamped);
      setSession(rebuilt.game.session);
      setRevealed(rebuilt.game.session.state.priorityPlayer);
    },
    [resume],
  );

  /**
   * Leave review and keep playing from where the scrubber sits. At the end of
   * the log that is simply resuming; anywhere earlier it FORKS — a new library
   * entry sharing this game's seed, with the parent's actions up to this point,
   * so the two playthroughs differ only in what happens next.
   */
  const playFromHere = useCallback(() => {
    if (!resume || scrub === null) return;
    if (scrub < resume.actions.length) {
      const parentId = gameIdRef.current;
      gameIdRef.current = newGameId();
      forkOfRef.current = { parentId, forkedAt: scrub };
    }
    setScrub(null);
  }, [resume, scrub]);

  // The mulligan TRANSCRIPT — every re-shuffle and keep, in order. Not derivable
  // from `mulligan` (counts lose the order and the bottomed ids), and not engine
  // actions (see persist.ts) — this is the record's third replay ingredient.
  const [transcript, setTranscript] = useState<readonly MulliganStep[]>(() =>
    resumed && resume ? resume.mulligans : [],
  );

  // A rebuild failure means the record is poison (deck deleted, actions from an
  // older rules build) — clear it so every later visit starts clean.
  useEffect(() => {
    if (restored && !restored.ok) clearSavedGame();
  }, [restored]);

  // --- persistence -----------------------------------------------------------------
  const saver = useMemo(() => createGameSaver(), []);

  /**
   * File this game in the library. The surface WRITES; the menu that lists and
   * deletes reads its own copy — keeping one shared list in React state across
   * that boundary would be a second source of truth for something localStorage
   * already holds.
   */
  const fileInLibrary = useCallback((record: PlayRecord, outcome: HistoryOutcome): void => {
    const id = gameIdRef.current;
    const lineage = forkOfRef.current;
    updateHistory((entries) => {
      const existing = entries.find((e) => e.id === id);
      const now = record.savedAt;
      return upsertEntry(entries, {
        id,
        record,
        outcome,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(lineage ? { parentId: lineage.parentId, forkedAt: lineage.forkedAt } : {}),
      });
    });
  }, []);
  const liveId = useId();

  // The updater force-flushes pending writes before any update-triggered reload.
  useEffect(() => appUpdater.registerFlush(() => saver.flush()), [saver]);

  // Report this surface's liveness so a waiting update DEFERS during the game
  // (including its end screen — leaving is the user's moment, not ours) and
  // applies the moment the surface is gone or back at setup.
  useEffect(() => {
    if (!session || phase.kind === 'setup' || phase.kind === 'error') {
      appUpdater.reportGameLive(liveId, null);
      return undefined;
    }
    appUpdater.reportGameLive(liveId, session.gameOver ? 'game-over' : 'game');
    return () => appUpdater.reportGameLive(liveId, null);
  }, [liveId, session, phase]);

  // THE SAVE: one debounced record per committed change. Everything the record
  // needs is in deps, so no committed state can be missed; the saver collapses
  // bursts (auto-tap chains, AI turns) into one write.
  useEffect(() => {
    if (!config || !session) return;
    if (phase.kind === 'setup' || phase.kind === 'error') return;
    // ⚠️ A REVIEWED game is read-only. While the scrubber is engaged the session
    // is an EARLIER state of a real game, and saving it would file that game
    // with its own future deleted — scrubbing back through a game would destroy
    // the very thing being reviewed. Writing resumes only once the player takes
    // it over, at which point a fork id is already in place if they rewound.
    if (reviewing) return;
    const record = buildPlayRecord({
      names: config.names,
      choiceA: config.choiceA,
      choiceB: config.choiceB,
      startingPlayer: config.startingPlayer,
      seed,
      ...(ai ? { ai: { seat: ai.seat, pilotId: ai.pilotId } } : {}),
      mulligans: transcript,
      session,
      ui: { revealed, scrollY: typeof window === 'undefined' ? 0 : window.scrollY },
    });

    // THE LIBRARY (§3.66) files EVERY game, decided or not, off the same record
    // the resume slot uses — one snapshot, two readers, so a game can never be
    // in one and not the other. A finished game is exactly what the library is
    // for, which is why this runs before the game-over return below.
    const outcome: HistoryOutcome = !session.gameOver
      ? { kind: 'unfinished' }
      : session.winner
        ? { kind: 'win', winner: session.winner, reason: 'the game ended' }
        : { kind: 'draw', reason: 'the game ended' };
    fileInLibrary(record, outcome);

    if (session.gameOver) {
      // Game decided: nothing to RESUME any more — but the library keeps it.
      saver.clear();
      return;
    }
    saver.save(record);
  }, [config, session, phase, seed, ai, transcript, revealed, saver, fileInLibrary, reviewing]);

  // Scroll rides the record too ("where your view was on the screen"), and the
  // pending write is flushed on hide/unmount so a tab kill or a navigation away
  // loses at most the debounce window.
  useEffect(() => {
    const onScroll = (): void => saver.saveScroll(window.scrollY);
    const onHide = (): void => saver.flush();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      saver.flush();
    };
  }, [saver]);

  // Put the viewport back where it was, once, after the restored game painted.
  const restoredScrollY = resumed && resume ? resume.ui.scrollY : null;
  useEffect(() => {
    if (restoredScrollY !== null) window.scrollTo(0, restoredScrollY);
    // Once per mount, deliberately: later scrolling is the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- start / rematch -----------------------------------------------------------
  const beginGame = useCallback((cfg: GameConfig, gameSeed: number): void => {
    const started = startHotseatGame({
      choiceA: cfg.choiceA,
      choiceB: cfg.choiceB,
      seed: gameSeed,
      startingPlayer: cfg.startingPlayer,
    });
    if (!started.ok) {
      const msg = [...started.problems.a, ...started.problems.b].join(' · ') || 'Both decks must be legal.';
      setPhase({ kind: 'error', message: msg });
      return;
    }
    // A new game supersedes whatever record was stored (there is one slot).
    saver.clear();
    setTranscript([]);
    const seats: Record<PlayerId, SeatInfo> = {
      A: { id: 'A', name: cfg.names.A },
      B: { id: 'B', name: cfg.names.B },
    };
    setTransport(ai ? createSoloVsAiTransport(seats, humanSeatOf(ai)) : createLocalHotseatTransport(seats));
    setSession(GameSession.fromCreated(started.game.created, started.game.registry, cfg.names));
    setMulligan({
      deciding: cfg.startingPlayer,
      taken: { A: 0, B: 0 },
      done: { A: false, B: false },
    });
    setRevealed(ai ? humanSeatOf(ai) : null);
    // First mulligan decision is behind a handoff so only the right player looks —
    // unless there is nobody to hand the device TO (solo), in which case the
    // interstitial is pure friction and we go straight in.
    setPhase(
      ai
        ? { kind: 'mulligan' }
        : { kind: 'handoff', to: cfg.startingPlayer, context: 'to decide on your opening hand', next: 'mulligan' },
    );
  }, [ai, saver]);

  const onStart = useCallback(
    (args: {
      nameA: string;
      nameB: string;
      choiceA: DeckChoice;
      choiceB: DeckChoice;
      seed: number;
      startingPlayer: PlayerId;
      starterPreference: StarterPreference;
    }): void => {
      const cfg: GameConfig = {
        names: { A: args.nameA, B: args.nameB },
        choiceA: args.choiceA,
        choiceB: args.choiceB,
        startingPlayer: args.startingPlayer,
        starterPreference: args.starterPreference,
      };
      setConfig(cfg);
      setSeed(args.seed);
      beginGame(cfg, args.seed);
    },
    [beginGame],
  );

  const rematch = useCallback((): void => {
    if (!config) return;
    const nextSeed = (seed + 1) >>> 0;
    // A rematch is a new game, so a player who asked to flip for the first turn
    // gets a new flip — repeating the old toss would make "Random" mean "random
    // once, then fixed forever". An explicit seat passes through unchanged.
    const next: GameConfig = { ...config, startingPlayer: resolveStartingPlayer(config.starterPreference) };
    setConfig(next);
    setSeed(nextSeed);
    beginGame(next, nextSeed);
  }, [config, seed, beginGame]);

  const newGame = useCallback((): void => {
    saver.clear();
    setSession(null);
    setMulligan(null);
    setConfig(null);
    setTranscript([]);
    setPhase({ kind: 'setup' });
  }, [saver]);

  // --- mulligan flow -------------------------------------------------------------
  // A mulligan reshuffles: rebuild the game from a derived seed so the engine does
  // the shuffle/draw, preserving determinism. We only advance the deciding seat's
  // mulligan count; the other seat's count is unaffected by the reshuffle since each
  // keeps its OWN drawn hand from the same fresh deal (London: both redraw from the
  // new shuffle, but only the mulliganing seat owes bottomed cards).
  const onMulligan = useCallback((): void => {
    if (!config || !mulligan || !session) return;
    const seat = mulligan.deciding;
    const nextTaken = mulligan.taken[seat] + 1;
    // Derive a fresh seed per mulligan so the reshuffle differs deterministically.
    // The formula lives in persist.ts because a saved game's replay must derive
    // the IDENTICAL seed (one formula, two callers, zero drift).
    const reSeed = mulliganReseed(seed, nextTaken);
    const started = startHotseatGame({
      choiceA: config.choiceA,
      choiceB: config.choiceB,
      seed: reSeed,
      startingPlayer: config.startingPlayer,
    });
    if (!started.ok) return; // decks were already validated; defensive no-op
    setSession(GameSession.fromCreated(started.game.created, started.game.registry, config.names));
    setMulligan({ ...mulligan, taken: { ...mulligan.taken, [seat]: nextTaken } });
    setTranscript((t) => [...t, { kind: 'mulligan', seat }]);
  }, [config, mulligan, session, seed]);

  const onKeep = useCallback(
    (bottomed: readonly InstanceId[]): void => {
      if (!mulligan || !session || !config) return;
      const seat = mulligan.deciding;
      const kept = session.bottomCards(seat, bottomed);
      setSession(kept);
      setTranscript((t) => [...t, { kind: 'keep', seat, bottomed }]);
      const nextDone = { ...mulligan.done, [seat]: true };
      const other: PlayerId = seat === 'A' ? 'B' : 'A';
      if (!nextDone[other]) {
        setMulligan({ ...mulligan, done: nextDone, deciding: other });
        // Hand off to the other player — unless the other player is the computer,
        // which needs no interstitial and keeps its own hand hidden anyway.
        setPhase(
          ai
            ? { kind: 'mulligan' }
            : { kind: 'handoff', to: other, context: 'to decide on your opening hand', next: 'mulligan' },
        );
      } else {
        // Both kept — start the game proper. Hand to the starting player's turn.
        setMulligan({ ...mulligan, done: nextDone });
        const starter = config.startingPlayer;
        if (ai) {
          setRevealed(humanSeatOf(ai));
          setPhase({ kind: 'play' });
        } else {
          setRevealed(null);
          setPhase({ kind: 'handoff', to: starter, context: 'to take the first turn', next: 'play' });
        }
      }
    },
    [mulligan, session, config, ai],
  );

  // --- play flow -----------------------------------------------------------------
  const applySubmit = useCallback(
    (run: () => SubmitResult): void => {
      const result = run();
      if (result.rejected) return; // PlayBoard already toasts; keep state.
      setSession(result.session);
    },
    [],
  );

  /**
   * §3.119 — THE PRIORITY STOPS. Owned here, beside the auto-pass effect that
   * obeys them, and handed DOWN to the board that renders their controls: one
   * value, so the bar can never promise a stop the walker passes through.
   */
  const [stops, setStops] = useState<PriorityStops>(loadPriorityStops);
  const changeStops = useCallback((next: PriorityStops): void => {
    setStops(next);
    savePriorityStops(next);
  }, []);

  // Auto-pass priority windows where the holder has nothing worth stopping for.
  //
  // MTG hands both players priority in every step. In pass-and-play each such
  // window costs a physical device handoff, so without this the players spend the
  // game confirming "I have nothing to do" — at upkeep, at draw, at every combat
  // step, at end of turn.
  //
  // ⚠️ §3.119 REPLACED THE RULE. It used to pass only when the session reported
  // no meaningful choice at all — and an INSTANT IN HAND makes every window
  // meaningful, so a player holding one Cloudshift was asked to pass a dozen
  // times a turn (report 20260901_211359), including through their own triggers,
  // which then looked stuck (reports 212245, 213414). The stop rule is now the
  // Arena-style `shouldStopForPriority`: real decisions always stop, empty
  // windows never do, and in between a per-step table the player owns decides.
  // Each pass re-renders and re-runs this, walking the game forward to the next
  // window that actually wants a human.
  /**
   * §3.143 / UX-16 — HOLDING AN OPPONENT'S SPELL ON SCREEN.
   *
   * It lives HERE, beside the two effects it gates, for the same reason the
   * priority stops do: the hold's entire job is to stop the auto-passer and the
   * AI seat for a beat, and a hold the board owned would be a pause the walker
   * could not see. The RULE is the pure, tested `spellHoldDecision`; this is
   * only its timer.
   *
   * ⚠️ NOT A CHANGE TO `shouldStopForPriority`. That predicate returning false
   * on `!ctx.hasAnyPlay` is correct and §3.119 removed the alternative on
   * purpose (report 20260901_211359). A hold grants no priority and answers no
   * question — it just declines to advance for a moment.
   */
  const [hold, setHold] = useState<SpellHold | null>(null);
  const [holdPressure, setHoldPressure] = useState<HoldPressure>(NO_HOLD_PRESSURE);
  const announcedRef = useRef<Set<InstanceId>>(new Set());
  const holdTurnRef = useRef<{ turn: number; spent: number }>({ turn: 0, spent: 0 });

  useEffect(() => {
    if (phase.kind !== 'play' || !session) return;
    if (hold) return; // one at a time; the timer below is what ends it
    const turnNumber = session.state.turnNumber;
    // The per-turn budget resets with the turn, not with the game.
    if (holdTurnRef.current.turn !== turnNumber) holdTurnRef.current = { turn: turnNumber, spent: 0 };
    // The TOP of the stack, through lane A's own producer — so "is this an
    // activated ability or a trigger?" is answered in exactly one place, the
    // place the stack panel answers it (rule 12). The resolvers are trivial
    // because this path needs the kind and the controller, not the words.
    const top =
      stackEntries(session.state.stack, { nameOf: () => '', faceOf: () => null })[0] ?? null;
    const decision = spellHoldDecision(
      {
        viewer: revealed ?? session.state.priorityPlayer,
        stackTop: top,
        viewerWillStop: shouldStopForPriority(stopContextFor(session), stops),
        announced: announcedRef.current,
        holdsThisTurn: holdTurnRef.current.spent,
        gameOver: session.gameOver,
      },
      SPELL_HOLD_CONFIG,
    );
    if (decision.kind !== 'hold') return;
    announcedRef.current.add(decision.hold.instanceId);
    holdTurnRef.current = { turn: turnNumber, spent: holdTurnRef.current.spent + 1 };
    setHoldPressure(NO_HOLD_PRESSURE);
    setHold(decision.hold);
  }, [phase, session, stops, hold, revealed]);

  // The timer. Re-armed whenever the pressure changes, so moving the pointer
  // onto the card lengthens the hold that is already running rather than
  // needing a second one.
  useEffect(() => {
    if (!hold) return undefined;
    const handle = window.setTimeout(
      () => setHold(null),
      holdDurationMs(holdPressure, SPELL_HOLD_CONFIG),
    );
    return () => window.clearTimeout(handle);
  }, [hold, holdPressure]);

  /**
   * §3.143 / §10 — HOLDING COMBAT ON SCREEN.
   *
   * The same shape as the spell hold above, and here for the same reason: the
   * pause's entire job is to stop the auto-passer and the AI seat, so it is
   * owned by the component that runs both.
   *
   * ⚠️ WHY THE GATE IS INSIDE `shouldStop` AND NOT ONLY AN EARLY RETURN.
   * `autoAdvancePriority` walks MANY priority windows inside ONE effect — that
   * is its whole job — so a gate outside the loop cannot stop it partway. §10's
   * measurement is exactly that failure: 260 ms after "Confirm 1 block" the rig
   * sampled `blocking=0 staged=0 arcs=0` at Main Phase 1 of the NEXT turn,
   * because blocks, combat damage and end-of-combat had all been walked through
   * before a frame was ever painted. The predicate below makes the walker STOP
   * at the window a beat is owed to; the early return then keeps it stopped
   * while the beat runs.
   */
  const reducedMotion = usePrefersReducedMotion();
  /**
   * The beat on screen, and WHICH TURN'S combat it belongs to. The turn travels
   * with it so releasing can book the beat against the right combat without
   * closing over the session (see {@link releaseCombatHold}).
   */
  const [combatHold, setCombatHold] = useState<{
    readonly hold: CombatHold;
    readonly turn: number;
  } | null>(null);
  /**
   * Which beats a combat has already spent, and whose combat it was.
   *
   * ⚠️ RESOLVED AT READ TIME, never by a reset effect. `autoAdvancePriority`
   * can walk across a turn boundary inside a single call, so a reset that
   * happened between renders would arrive too late and the NEXT turn's combat
   * would be skipped as "already held" — the same invisible-combat bug wearing
   * a new hat. Comparing the stored turn to the candidate's is one read and
   * cannot be out of date.
   */
  const combatHoldSpentRef = useRef<{ turn: number; spent: Set<CombatHoldKind> }>({
    turn: 0,
    spent: new Set(),
  });

  /**
   * THE ONE PLACE the combat-hold rule is asked. Both the arming effect and the
   * walker's own stop predicate call this, so the pause and the walker can never
   * disagree about whether the game is moving (rule 12, and the rule §3.119 set
   * for the priority stops).
   */
  const combatHoldFor = useCallback(
    (candidate: GameSession): ReturnType<typeof combatHoldDecision> => {
      const booked = combatHoldSpentRef.current;
      const spent = booked.turn === candidate.state.turnNumber ? booked.spent : NO_BEATS_SPENT;
      return combatHoldDecision(
        {
          step: candidate.state.step,
          combat: combatWindowFactsOf(candidate.state.combat),
          spent,
          reducedMotion,
          gameOver: candidate.gameOver,
        },
        COMBAT_HOLD_CONFIG,
      );
    },
    [reducedMotion],
  );

  /**
   * End the beat now — the equivalent of UX-16's "Let it resolve", so nobody is
   * trapped behind a delay every combat. The timer calls it too: expiring and
   * skipping are the same event, which is why there is one funnel for both.
   */
  const releaseCombatHold = useCallback((): void => {
    if (!combatHold) return;
    // Booked on RELEASE, never on ARM: while the beat is running the walker's
    // predicate must still answer "stop here", because that predicate — not the
    // effect's early return — is what holds the line INSIDE the walk.
    if (combatHoldSpentRef.current.turn !== combatHold.turn) {
      combatHoldSpentRef.current = { turn: combatHold.turn, spent: new Set() };
    }
    combatHoldSpentRef.current.spent.add(combatHold.hold.kind);
    setCombatHold(null);
  }, [combatHold]);

  useEffect(() => {
    if (phase.kind !== 'play' || !session) return;
    if (combatHold) return; // one at a time; the timer below is what ends it
    const decision = combatHoldFor(session);
    if (decision.kind !== 'hold') return;
    setCombatHold({ hold: decision.hold, turn: session.state.turnNumber });
  }, [phase, session, combatHold, combatHoldFor]);

  // The beat's timer. Its length came from the decision, so the beat the board
  // announces and the beat actually waited out are the same number.
  useEffect(() => {
    if (!combatHold) return undefined;
    const handle = window.setTimeout(releaseCombatHold, combatHold.hold.ms);
    return () => window.clearTimeout(handle);
  }, [combatHold, releaseCombatHold]);

  useEffect(() => {
    if (phase.kind !== 'play' || !session || session.gameOver) return;
    // A hold is up: the board is showing the opponent's spell, or the combat
    // that just happened, and the game must not walk out from under it.
    if (hold || combatHold) return;
    const advanced = session.autoAdvancePriority(undefined, (candidate) =>
      shouldStopForPriority(stopContextFor(candidate), stops) ||
      // ⚠️ THE LOAD-BEARING GATE. Without this the walk below runs from declared
      // blockers to the next turn's main phase in one synchronous burst and
      // there is no frame in which `state.combat.blockersDeclared` is true for
      // the board to render from (§10).
      combatHoldFor(candidate).kind === 'hold',
    );
    // Identity-equal when nothing was skipped, so React bails out and this cannot
    // become a render loop.
    if (advanced !== session) setSession(advanced);
  }, [phase, session, stops, hold, combatHold, combatHoldFor]);

  // --- the computer's seat -------------------------------------------------------
  //
  // One effect drives every AI decision, because the engine presents them all the
  // same way: a parked question arrives as an `answerChoice` in `legalActions`,
  // exactly as it does for the headless sim's match loop. So there is no branch
  // per situation here that could drift from how the sim plays the same board.
  //
  // The timer is what makes it watchable AND what keeps a long AI turn off the
  // main thread in one burst; it is cleared on every re-render so a stale pilot
  // decision can never be applied to a board that has already moved on.
  const aiPilot = useMemo(
    () => (ai ? createDefaultAiRegistry().getPilot(ai.pilotId) : undefined),
    [ai],
  );
  // Seeded from the game seed so a solo game replays identically, like every
  // other seeded thing here. Rebuilt per game, not per action. (After a RESUME
  // the stream restarts from the top — the restored STATE is exact, but the
  // pilot's future tie-breaks may draw different randomness than the unreloaded
  // session would have. Future choices are not part of "restore exactly".)
  const aiRng = useMemo(() => createRng((seed ^ 0x5bf03635) >>> 0), [seed]);

  useEffect(() => {
    if (!ai || !aiPilot || !session || phase.kind !== 'play') return;
    // §3.143 / UX-16 — while an opponent's spell is held on screen the computer
    // does not get to move either. Gating only the auto-passer would let the AI
    // pass priority underneath the announce card and resolve the very spell the
    // player is being shown, which is the bug wearing a new hat.
    // …and the combat hold does the same job for the combat that just happened:
    // the AI passing priority underneath the beat would resolve combat damage
    // and end the step while the player is still looking at the blockers.
    if (hold || combatHold) return;
    if (!aiMustAct(session, ai.seat)) return;
    const handle = window.setTimeout(() => {
      const action = aiAction(session, aiPilot, aiRng);
      if (!action) return;
      const result = session.submit(action);
      // A rejected AI action must not wedge the game: pass instead, which is the
      // one move that always advances it. Same guard the sim harness keeps for
      // the same reason (`maxConsecutiveRejectedActions`).
      setSession(result.rejected ? session.passPriority().session : result.session);
    }, HOTSEAT_CONFIG.aiThinkMs);
    return () => window.clearTimeout(handle);
  }, [ai, aiPilot, aiRng, session, phase, hold, combatHold]);

  // The computer keeps its opening hand. It has no mulligan policy of its own —
  // pilots decide in-game actions, not whether to ship a seven — so it always
  // keeps rather than pretending to a judgement it does not make.
  useEffect(() => {
    if (!ai || phase.kind !== 'mulligan' || !mulligan) return;
    if (mulligan.deciding !== ai.seat || mulligan.done[ai.seat]) return;
    const handle = window.setTimeout(() => onKeep([]), HOTSEAT_CONFIG.aiThinkMs);
    return () => window.clearTimeout(handle);
  }, [ai, phase, mulligan, onKeep]);

  const concede = useCallback((): void => {
    // A concede ends the game: the conceding player (the current viewer) loses.
    // Realize it by repeatedly passing priority isn't a concede; instead we mark
    // the result directly via a synthetic end — simplest faithful path is to set the
    // winner to the opponent. We do this by recreating a finished view through the
    // session's state clone.
    if (!session || !revealed) return;
    const loser = revealed;
    const winner: PlayerId = loser === 'A' ? 'B' : 'A';
    const ended = session.concede(loser, winner);
    setSession(ended);
  }, [session, revealed]);

  // --- render --------------------------------------------------------------------
  if (phase.kind === 'setup') {
    return (
      <div className="play-view">
        <SetupScreen decks={decks} onStart={onStart} {...(ai ? { aiSeat: ai.seat } : {})} />
      </div>
    );
  }

  if (phase.kind === 'error') {
    return (
      <div className="play-view">
        <div className="lab-alert lab-alert--error" role="alert">
          <strong>Couldn't start the game:</strong> {phase.message}
        </div>
        <button type="button" className="btn" onClick={newGame}>
          Back to setup
        </button>
      </div>
    );
  }

  if (!session || !config) {
    return <div className="play-view" />;
  }

  // Game over (reached via normal play or concede) takes precedence over everything.
  if (session.gameOver) {
    return (
      <div className="play-view">
        <EndScreen
          winner={session.winner}
          names={config.names}
          reason={endReason(session, config.names)}
          onRematch={rematch}
          onNewGame={newGame}
        />
      </div>
    );
  }

  if (phase.kind === 'handoff') {
    const to = phase.to;
    const acknowledge = (): void => {
      setRevealed(to);
      setPhase(phase.next === 'mulligan' ? { kind: 'mulligan' } : { kind: 'play' });
    };
    // A handoff addressed to the COMPUTER is acknowledged before paint — there is
    // no human to pick up the device, and every frame of that screen reads as a
    // hang (solo-screen.ts owns the rule; report 20260825_210108 is why).
    if (handoffIsToComputer(to, ai?.seat)) {
      return <AutoReady onReady={acknowledge} />;
    }
    return (
      <div className="play-view">
        <HandoffScreen toName={config.names[to]} context={phase.context} onReady={acknowledge} />
      </div>
    );
  }

  if (phase.kind === 'mulligan' && mulligan) {
    const seat = mulligan.deciding;
    // THE LEAK FIX (report 20260825_210108): while the COMPUTER decides its
    // mulligan, render backs only. `AiMulliganScreen` takes a hand COUNT — the
    // card identities never reach the screen that shows during the think delay.
    if (mulliganPresentationFor(seat, ai?.seat).kind === 'aiDeciding') {
      const handSize = session.state.players[seat].hand.length;
      return (
        <div className="play-view">
          <AiMulliganScreen name={config.names[seat]} handCount={handSize} />
        </div>
      );
    }
    const view = buildBoardView(session.state, seat, config.names);
    return (
      <div className="play-view">
        <MulliganScreen
          seat={seat}
          name={config.names[seat]}
          hand={view.self.hand ?? []}
          mulligansTaken={mulligan.taken[seat]}
          maxMulligans={HOTSEAT_CONFIG.maxMulligans}
          onKeep={onKeep}
          onMulligan={onMulligan}
        />
      </div>
    );
  }

  // Play phase. If priority has moved to the OTHER human since the last reveal, gate
  // behind a handoff (transport decides). The active player remains revealed across
  // their own priority passes; only a change of controlling human triggers a handoff.
  const priority = session.priorityPlayer;
  if (transport && revealed !== null && revealed !== priority && transport.requiresHandoff(revealed, priority)) {
    // A parked question moves priority to its CHOOSER, who may be the opponent of
    // the spell's controller — so the handoff has to name the question, not the
    // turn, or the player picking up the device has no idea why it is their move.
    const pending = session.pendingChoice;
    const context = pending
      ? `to answer ${pending.sourceName}`
      : session.state.activePlayer === priority
        ? 'to take your turn'
        : 'to respond (you have priority)';
    if (handoffIsToComputer(priority, ai?.seat)) {
      return <AutoReady onReady={() => setRevealed(priority)} />;
    }
    return (
      <div className="play-view">
        <HandoffScreen
          toName={config.names[priority]}
          context={context}
          onReady={() => setRevealed(priority)}
        />
      </div>
    );
  }

  // Ensure someone is revealed (first entry into play).
  const viewer: PlayerId = revealed ?? priority;

  return (
    <div className="play-view">
      {reviewing && (
        <ReviewScrubber
          at={scrub}
          total={scrubMax}
          turn={session.state.turnNumber}
          onScrub={scrubTo}
          onPlayFromHere={playFromHere}
        />
      )}
      <PlayBoard
        session={session}
        viewer={viewer}
        onSubmit={applySubmit}
        onConcede={concede}
        stops={stops}
        onStops={changeStops}
        hold={hold}
        onHoldPointer={(over) => setHoldPressure((p) => pointerPressure(p, over))}
        onHoldExtend={() => setHoldPressure(extendPressure)}
        onHoldRelease={() => setHold(null)}
        combatHold={combatHold ? combatHold.hold : null}
        onCombatHoldSkip={releaseCombatHold}
      />
    </div>
  );
}

/** A short concluding reason line for the end screen. */
function endReason(session: GameSession, names: Readonly<Record<PlayerId, string>>): string | undefined {
  const lost = session.events.filter((e) => e.type === 'playerLost');
  const last = lost[lost.length - 1];
  if (last && last.type === 'playerLost') {
    return `${names[last.player]} ${last.reason}.`;
  }
  return undefined;
}
