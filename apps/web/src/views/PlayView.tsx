import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';
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
import { HOTSEAT_CONFIG } from '../lib/play/play-config.js';
import { buildBoardView } from '../lib/play/view-model.js';
import { SetupScreen } from '../components/play/SetupScreen.js';
import { MulliganScreen } from '../components/play/MulliganScreen.js';
import { HandoffScreen } from '../components/play/HandoffScreen.js';
import { AiMulliganScreen, AutoReady } from '../components/play/AiMulliganScreen.js';
import { handoffIsToComputer, mulliganPresentationFor } from '../lib/play/solo-screen.js';
import { PlayBoard } from '../components/play/PlayBoard.js';
import { EndScreen } from '../components/play/EndScreen.js';
import { OnlinePlay } from '../components/online/OnlinePlay.js';
import './play-resume.css';

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
  readonly startingPlayer: PlayerId;
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
  const [mode, setMode] = useState<PlayMode>(boot.auto && boot.saved ? modeOfRecord(boot.saved) : 'choose');
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
        <LocalPlay decks={decks} {...(localResume ? { resume: localResume } : {})} />
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
}: {
  decks: DecksApi;
  ai?: AiSeatConfig;
  resume?: PlayRecord;
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
        }
      : null,
  );
  const [seed, setSeed] = useState<number>(() => resume?.setup.seed ?? HOTSEAT_CONFIG.defaultSeed);
  const [session, setSession] = useState<GameSession | null>(() => resumed?.session ?? null);
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
    if (session.gameOver) {
      // Game decided (win, loss, draw, concede): nothing to resume any more.
      saver.clear();
      return;
    }
    saver.save(
      buildPlayRecord({
        names: config.names,
        choiceA: config.choiceA,
        choiceB: config.choiceB,
        startingPlayer: config.startingPlayer,
        seed,
        ...(ai ? { ai: { seat: ai.seat, pilotId: ai.pilotId } } : {}),
        mulligans: transcript,
        session,
        ui: { revealed, scrollY: typeof window === 'undefined' ? 0 : window.scrollY },
      }),
    );
  }, [config, session, phase, seed, ai, transcript, revealed, saver]);

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
    (args: { nameA: string; nameB: string; choiceA: DeckChoice; choiceB: DeckChoice; seed: number; startingPlayer: PlayerId }): void => {
      const cfg: GameConfig = {
        names: { A: args.nameA, B: args.nameB },
        choiceA: args.choiceA,
        choiceB: args.choiceB,
        startingPlayer: args.startingPlayer,
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
    setSeed(nextSeed);
    beginGame(config, nextSeed);
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

  // Auto-pass priority windows where the holder provably has no decision.
  //
  // MTG hands both players priority in every step. In pass-and-play each such
  // window costs a physical device handoff, so without this the players spend the
  // game confirming "I have nothing to do" — at upkeep, at draw, at every combat
  // step, at end of turn. We pass for them ONLY when the session reports no
  // meaningful choice (see `hasMeaningfulChoice`), so no real decision is ever
  // skipped. Each pass re-renders and re-runs this, walking the game forward to
  // the next window that actually needs a human.
  useEffect(() => {
    if (phase.kind !== 'play' || !session || session.gameOver) return;
    const advanced = session.autoAdvancePriority();
    // Identity-equal when nothing was skipped, so React bails out and this cannot
    // become a render loop.
    if (advanced !== session) setSession(advanced);
  }, [phase, session]);

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
  }, [ai, aiPilot, aiRng, session, phase]);

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
      <PlayBoard session={session} viewer={viewer} onSubmit={applySubmit} onConcede={concede} />
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
