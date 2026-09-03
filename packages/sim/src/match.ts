/**
 * `runMatch` — play ONE full game headlessly via the core loop (DESIGN §3.5).
 *
 * The loop is the §2 contract in action: ask the engine for the priority-holder's
 * legal actions, hand the read-only view + actions + a seeded RNG to that seat's
 * pilot, apply the chosen action, repeat until the game ends. Each seat gets its
 * OWN RNG derived from the game seed so the two pilots' tie-breaks don't share a
 * stream — and the whole thing is reproducible: same seed ⇒ identical game.
 *
 * Termination is guaranteed: a turn cap AND an action cap (config) both bound the
 * loop, so a stalled board records a timeout draw and never hangs (DESIGN §6
 * robustness). The match optionally records a trace (event log + decisions) for
 * the future match viewer, gated off by default to stay allocation-light.
 *
 * The loop is also where a pilot gets to watch the half of the game it does not
 * play: a pilot that implements `createGameObserver` is fed a spectator-level
 * projection of every event, masked by `observation.ts`. See the comment beside
 * `observers` below — the interesting parts are that the feed cannot leak (it
 * contains nothing anybody is entitled to hide) and that it cannot cross a game
 * boundary (the observer's lifetime is this function call).
 */

import type {
  GameAction,
  GameEvent,
  GameState,
  PlayerId,
  RulesConfig,
  Rng,
} from '@jonny-boi/core';
import {
  applyAction,
  applyActionInPlace,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
} from '@jonny-boi/core';
import type { EffectRegistry } from '@jonny-boi/core';
import type { GameObserver, Pilot } from '@jonny-boi/ai';
import type { LoadedDeck } from './deck.js';
import { DEFAULT_SIM_CONFIG, type SimConfig } from './config.js';
import { deliverObservation, type MatchObservers } from './observation.js';

/** Why a game ended — a win by a player, or a draw on the turn/action cap. */
export type MatchOutcome =
  | { readonly kind: 'win'; readonly winner: PlayerId }
  | { readonly kind: 'timeout' }
  /**
   * A draw by CR 104.4b — one turn ran past `maxActionsPerTurn`, which only a
   * mandatory loop does. Its own outcome rather than a `timeout` because the two
   * mean opposite things to anything reading the result: a timeout is "we gave
   * up and the verdict is suspect", while this is "the rules end the game here".
   */
  | { readonly kind: 'loop' };

/** The seat assignment for a match: which deck + pilot sits in A and B. */
export interface MatchSeats {
  readonly deckA: LoadedDeck;
  readonly deckB: LoadedDeck;
  readonly pilotA: Pilot;
  readonly pilotB: Pilot;
  /** The effect registry the pool provides (so cards resolve). */
  readonly registry: EffectRegistry;
}

/** Per-game options. */
export interface MatchOptions {
  readonly config?: RulesConfig;
  readonly sim?: SimConfig;
  /** Who is on the play (takes the first turn). Defaults to 'A'. */
  readonly startingPlayer?: PlayerId;
  /**
   * When true, retain the full event log + decision trace for the match viewer.
   * Off by default — recording is the only per-game cost we can avoid, and the
   * gauntlet runs thousands of games.
   */
  readonly recordTrace?: boolean;
  /**
   * Stream every event to this observer WITHOUT retaining it. Independent of
   * `recordTrace`: use it to watch for one condition across a game cheaply.
   */
  readonly onEvent?: MatchEventObserver;
}

/** One decision a pilot made, captured only when `recordTrace` is on. */
export interface TracedDecision {
  readonly player: PlayerId;
  readonly action: GameAction;
}

/** The compact result of one game. */
export interface MatchResult {
  readonly outcome: MatchOutcome;
  /** Turn number the game reached. */
  readonly turns: number;
  /** Total actions applied (a rough cost/complexity signal). */
  readonly actions: number;
  /**
   * How many of those actions the engine REJECTED. Zero on a healthy run; a
   * non-zero count means a pilot proposed illegal moves, which the harness had to
   * break out of (see `SimConfig.maxConsecutiveRejectedActions`). Surfaced rather
   * than swallowed so a pilot bug can never masquerade as a legitimate draw.
   */
  readonly rejectedActions: number;
  /** Final life totals, handy for sanity-checking and the viewer. */
  readonly finalLife: Readonly<Record<PlayerId, number>>;
  /** Seed this game was played with. */
  readonly seed: number;
  /** Who was on the play. */
  readonly startingPlayer: PlayerId;
  /** Full event log — only present when `recordTrace` was set. */
  readonly events?: readonly GameEvent[];
  /** Decision trace — only present when `recordTrace` was set. */
  readonly decisions?: readonly TracedDecision[];
}

/**
 * An optional per-event observer. Unlike `recordTrace` (which RETAINS the whole
 * log), this streams each event to the caller and retains nothing, so an analysis
 * that only needs to *notice* something — "was this particular card ever drawn?" —
 * costs a function call rather than an array of every event in the game. Used by
 * the suggestion engine's identical-game detector (`paired-arms.ts`).
 */
export type MatchEventObserver = (event: GameEvent) => void;

/**
 * Derive a per-seat RNG seed from the game seed so the two pilots draw from
 * independent, reproducible streams. Mixing in a fixed per-seat salt keeps A and
 * B distinct while staying a pure function of the game seed.
 */
const SEAT_SALT: Readonly<Record<PlayerId, number>> = { A: 0x9e3779b9, B: 0x85ebca6b };

function seatRng(seed: number, seat: PlayerId): Rng {
  return createRng((seed ^ SEAT_SALT[seat]) >>> 0);
}

/**
 * Play one full game. Deterministic in `seed`: the engine shuffles/draws from the
 * game seed, and each pilot tie-breaks from its own seat RNG (also derived from
 * the seed), so the same inputs always reproduce the same `MatchResult`.
 */
export function runMatch(seats: MatchSeats, seed: number, opts: MatchOptions = {}): MatchResult {
  const config = opts.config ?? DEFAULT_RULES;
  const sim = opts.sim ?? DEFAULT_SIM_CONFIG;
  const startingPlayer = opts.startingPlayer ?? 'A';
  const record = opts.recordTrace ?? false;

  const pilots: Record<PlayerId, Pilot> = { A: seats.pilotA, B: seats.pilotB };
  const rngs: Record<PlayerId, Rng> = {
    A: seatRng(seed, 'A'),
    B: seatRng(seed, 'B'),
  };

  const created = createGame({
    seed,
    startingPlayer,
    config,
    registry: seats.registry,
    decks: {
      A: { cards: seats.deckA.library },
      B: { cards: seats.deckB.library },
    },
  });

  // The harness owns this state exclusively from here on: nothing outside the loop
  // keeps a reference to it (the pilot is lent it read-only for the duration of one
  // `chooseAction`, and the look-ahead pilot clones before it mutates). That
  // ownership is what makes `applyActionInPlace` legal below.
  let state: GameState = created.state;
  const events: GameEvent[] | undefined = record ? [...created.events] : undefined;
  const decisions: TracedDecision[] | undefined = record ? [] : undefined;
  const observe = opts.onEvent;
  /*
   * THE OBSERVATION SEAM (`docs/plans/superhuman-ai-program.md` §13–17). A pilot's
   * `chooseAction` runs only while that pilot holds priority, so a pilot could not
   * see the opponent act at all — which blocks every belief-model item in the
   * program brief, since a belief model is an update rule with no evidence to
   * update on.
   *
   * Created ONCE PER GAME and dropped when this function returns, which is the
   * whole of the per-game isolation argument: a pilot instance is reused across
   * hundreds of games (`makeSeats` builds the bundle once) and the Lab shards the
   * game grid across workers, so a belief that outlived a game would make a paired
   * A/B verdict depend on the worker count. The seam gives a pilot nowhere to put
   * cross-game state; `observation.test.ts` proves a game plays identically
   * whether or not other games preceded it.
   *
   * `observers` is `null` unless a pilot actually asked to watch, so the four
   * built-in pilots — none of which implement `createGameObserver` — run this loop
   * exactly as they did before the seam existed.
   */
  const observerA = seats.pilotA.createGameObserver?.({
    seat: 'A',
    opponent: 'B',
    startingPlayer,
  });
  const observerB = seats.pilotB.createGameObserver?.({
    seat: 'B',
    opponent: 'A',
    startingPlayer,
  });
  const observers: MatchObservers | null =
    observerA || observerB ? { A: observerA, B: observerB } : null;
  const observerBySeat: Record<PlayerId, GameObserver | undefined> = { A: observerA, B: observerB };
  if (observe) for (const e of created.events) observe(e);
  if (observers) for (const e of created.events) deliverObservation(observers, e);
  // Chosen ONCE per game, not per action: the branch is in the hot loop.
  const apply = sim.applyActionsInPlace ? applyActionInPlace : applyAction;

  let actions = 0;
  let rejectedActions = 0;
  /*
   * CR 104.4b — actions spent in the CURRENT turn, and the turn they belong to.
   *
   * A mandatory loop (Dualcaster Mage copying a Rite of Replication that makes
   * another Dualcaster Mage) never advances the turn, so a per-turn counter
   * separates it cleanly from a long game. Reset on the turn number changing
   * rather than on a step event, because the loop happens INSIDE one step and
   * the turn number is the only thing it cannot move.
   */
  let turnOfCount = state.turnNumber;
  let actionsThisTurn = 0;
  let loopedOut = false;
  // Consecutive rejections at the *current* decision point. A pilot that keeps
  // proposing a move the engine refuses would otherwise spin until the action cap
  // and bank a fake timeout draw, so after `maxConsecutiveRejectedActions` we pass
  // priority for it and let the game move on (deterministic — state only).
  let consecutiveRejections = 0;
  /*
   * THE PLAN SEAM (§3.108). A pilot answering `chooseActions` hands back its
   * decision AND the actions it promises to take next (the rest of a spell's
   * funding taps, then the cast). Those are queued here and applied one per
   * loop iteration — through every piece of bookkeeping below, exactly as a
   * decided action is — without building a menu or asking the pilot again.
   *
   * ⚠️ The queue is only ever consumed against the state it was planned for:
   * it is dropped the moment priority moves, a choice is parked, the stack
   * changes depth, an action is rejected, or the game ends. Everything a
   * queued action does is still the ENGINE's decision — a queued cast the
   * rules refuse is rejected like any other. The guard is a transcript
   * comparison (`action-plan.test.ts`): whole games with and without the seam
   * must be identical action for action.
   */
  const queued: GameAction[] = [];
  let queuedAt = 0;
  // Bound the loop two independent ways so a pathological state can never hang.
  while (!state.gameOver && state.turnNumber <= sim.maxTurnsPerGame && actions < sim.maxActionsPerGame) {
    const seat = state.priorityPlayer;
    const pilot = pilots[seat];

    let chosen: GameAction;
    if (queuedAt < queued.length) {
      chosen = queued[queuedAt++] as GameAction;
    } else {
      // THE FAST PASS (§3.73). A pilot may declare, from the state alone, that it
      // is going to pass whatever the menu holds — and this pilot passes 81.7% of
      // the 592 windows in a game. Building the menu for those is work enumerated,
      // scored and discarded, so when the seam answers `true` the pass is applied
      // directly and `generateLegalActions` is never called.
      //
      // ⚠️ SAFE ONLY BECAUSE THE ANSWER IS A PROMISE, not a hint — see
      // `Pilot.willPassPriority`, and `fast-pass.test.ts`, which plays whole games
      // with the seam on and off and requires identical transcripts.
      let legal: readonly GameAction[] | undefined;
      if (pilot.willPassPriority?.(state, config) !== true) {
        legal = generateLegalActions(state, config);
        if (legal.length === 0) break; // no moves (shouldn't happen pre-gameOver) — bail safely
      }
      if (legal === undefined) {
        chosen = { kind: 'passPriority', player: seat };
      } else {
        // Thread the pool's effect registry + the active rules config into the decision
        // context so look-ahead pilots (MCTS) roll out hypothetical lines through the
        // *same* forward model the real game uses — spell effects resolve at full
        // fidelity, not as no-ops. Non-simulating pilots simply ignore these fields.
        const ctx = {
          view: state,
          legalActions: legal,
          rng: rngs[seat],
          registry: seats.registry,
          rulesConfig: config,
          // This seat's per-game observer, or `undefined`. Always present as a
          // field so the context keeps ONE object shape across every decision of
          // every pilot — a shape that appeared and disappeared would make this
          // literal polymorphic in the hottest loop in the harness.
          observer: observerBySeat[seat],
        };
        if (pilot.chooseActions) {
          const plan = pilot.chooseActions(ctx);
          chosen = plan[0] as GameAction;
          queued.length = 0;
          queuedAt = 0;
          for (let i = 1; i < plan.length; i++) queued.push(plan[i] as GameAction);
        } else {
          chosen = pilot.chooseAction(ctx);
        }
      }
    }
    // Stuck on rejections → take the one move that always advances the game.
    const action: GameAction =
      consecutiveRejections >= sim.maxConsecutiveRejectedActions
        ? { kind: 'passPriority', player: seat }
        : chosen;
    if (decisions) decisions.push({ player: seat, action });

    // `applyActionInPlace` mutates and returns the SAME object; the pure path
    // returns a fresh one. Reassigning covers both (and a rejected in-place action
    // hands back a clone, so the contracts stay identical either way).
    const stackDepthBefore = state.stack.length;
    const result = apply(state, action, config, seats.registry);
    state = result.state;
    let rejected = false;
    for (const e of result.events) {
      if (e.type === 'actionRejected') rejected = true;
      if (events) events.push(e);
      if (observe) observe(e);
      if (observers) deliverObservation(observers, e);
    }
    if (rejected) {
      rejectedActions++;
      consecutiveRejections++;
    } else {
      consecutiveRejections = 0;
    }
    // A queued continuation survives only while the world is the one it was
    // planned against — see the seam's note above.
    if (
      queuedAt < queued.length &&
      (rejected ||
        state.gameOver ||
        state.priorityPlayer !== seat ||
        state.pendingChoice != null ||
        state.stack.length !== stackDepthBefore)
    ) {
      queued.length = 0;
      queuedAt = 0;
    }
    actions++;
    if (state.turnNumber !== turnOfCount) {
      turnOfCount = state.turnNumber;
      actionsThisTurn = 0;
    }
    actionsThisTurn++;
    if (actionsThisTurn >= sim.maxActionsPerTurn) {
      // The rules end the game here. Breaking out (rather than playing on to the
      // game-wide cap) is what makes the outcome say WHY.
      loopedOut = true;
      break;
    }
  }

  const outcome: MatchOutcome =
    state.gameOver && state.winner !== null
      ? { kind: 'win', winner: state.winner }
      : loopedOut
        ? { kind: 'loop' }
        : { kind: 'timeout' };

  const result: MatchResult = {
    outcome,
    turns: state.turnNumber,
    actions,
    rejectedActions,
    finalLife: { A: state.players.A.life, B: state.players.B.life },
    seed,
    startingPlayer,
    ...(events ? { events } : {}),
    ...(decisions ? { decisions } : {}),
  };
  return result;
}
