import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { createRng, type InstanceId, type PlayerId } from '@jonny-boi/core';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type { DecksApi } from '../lib/useDecks.js';
import { GameSession, type SubmitResult } from '../lib/play/session.js';
import {
  startHotseatGame,
  type DeckChoice,
} from '../lib/play/setup.js';
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
import { PlayBoard } from '../components/play/PlayBoard.js';
import { EndScreen } from '../components/play/EndScreen.js';
import { OnlinePlay } from '../components/online/OnlinePlay.js';

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

/** Mulligan progress for both seats. */
interface MulliganState {
  /** Seat currently deciding (we resolve A then B, each behind a handoff). */
  readonly deciding: PlayerId;
  /** How many mulligans each seat has taken so far. */
  readonly taken: Record<PlayerId, number>;
  /** Seats that have finalized their keep. */
  readonly done: Record<PlayerId, boolean>;
}

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

/**
 * The Play tab: a landing that lets the player choose Local (pass-and-play on one
 * device) or Online (two devices over the internet). Local reuses the full hotseat
 * flow (`LocalPlay`); Online drops into the networked client (`OnlinePlay`). Both
 * reuse the same board components and theme.
 */
export function PlayView({ decks }: { decks: DecksApi }): ReactElement {
  const [mode, setMode] = useState<PlayMode>('choose');
  // Which pilot the computer plays. Held HERE rather than inside the game so it
  // survives "back to the menu" and a rematch — a player who picked Hybrid once
  // should not be silently demoted to the default on their next game.
  const [pilotId, setPilotId] = useState<string>(DEFAULT_PILOT_ID);

  if (mode === 'solo') {
    return (
      <>
        <div className="play-view play-view--mode-bar">
          <button type="button" className="btn btn--ghost play-mode__back" onClick={() => setMode('choose')}>
            ← Play menu
          </button>
        </div>
        <LocalPlay decks={decks} ai={{ seat: AI_SEAT, pilotId }} />
      </>
    );
  }
  if (mode === 'local') {
    return (
      <>
        <div className="play-view play-view--mode-bar">
          <button type="button" className="btn btn--ghost play-mode__back" onClick={() => setMode('choose')}>
            ← Play menu
          </button>
        </div>
        <LocalPlay decks={decks} />
      </>
    );
  }
  if (mode === 'online') {
    return (
      <>
        <div className="play-view play-view--mode-bar">
          <button type="button" className="btn btn--ghost play-mode__back" onClick={() => setMode('choose')}>
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

/**
 * The local game — pass-and-play by default, or SOLO when `ai` names a seat.
 *
 * Deliberately ONE component rather than a solo fork. The two modes differ in
 * exactly three places (which transport, whether a handoff screen appears, and
 * who supplies seat B's actions) and every other line — mulligans, the board,
 * the log, rematch, concede — is identical. A forked `SoloPlay` would have been
 * a second copy of all of it, drifting the first time either was touched.
 */
function LocalPlay({ decks, ai }: { decks: DecksApi; ai?: AiSeatConfig }): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [seed, setSeed] = useState<number>(HOTSEAT_CONFIG.defaultSeed);
  const [session, setSession] = useState<GameSession | null>(null);
  const [transport, setTransport] = useState<SeatTransport | null>(null);
  const [mulligan, setMulligan] = useState<MulliganState | null>(null);
  // Who last confirmed they're looking at the screen (for play-phase handoffs).
  const [revealed, setRevealed] = useState<PlayerId | null>(null);

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
  }, [ai]);

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
    setSession(null);
    setMulligan(null);
    setConfig(null);
    setPhase({ kind: 'setup' });
  }, []);

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
    const reSeed = (seed * 2654435761 + nextTaken) >>> 0;
    const started = startHotseatGame({
      choiceA: config.choiceA,
      choiceB: config.choiceB,
      seed: reSeed,
      startingPlayer: config.startingPlayer,
    });
    if (!started.ok) return; // decks were already validated; defensive no-op
    setSession(GameSession.fromCreated(started.game.created, started.game.registry, config.names));
    setMulligan({ ...mulligan, taken: { ...mulligan.taken, [seat]: nextTaken } });
  }, [config, mulligan, session, seed]);

  const onKeep = useCallback(
    (bottomed: readonly InstanceId[]): void => {
      if (!mulligan || !session || !config) return;
      const seat = mulligan.deciding;
      const kept = session.bottomCards(seat, bottomed);
      setSession(kept);
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
  // other seeded thing here. Rebuilt per game, not per action.
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
    return (
      <div className="play-view">
        <HandoffScreen
          toName={config.names[to]}
          context={phase.context}
          onReady={() => {
            setRevealed(to);
            setPhase(phase.next === 'mulligan' ? { kind: 'mulligan' } : { kind: 'play' });
          }}
        />
      </div>
    );
  }

  if (phase.kind === 'mulligan' && mulligan) {
    const seat = mulligan.deciding;
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
