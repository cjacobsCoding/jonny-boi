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
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
} from '@jonny-boi/core';
import type { EffectRegistry } from '@jonny-boi/core';
import type { Pilot } from '@jonny-boi/ai';
import type { LoadedDeck } from './deck.js';
import { DEFAULT_SIM_CONFIG, type SimConfig } from './config.js';

/** Why a game ended — a win by a player, or a draw on the turn/action cap. */
export type MatchOutcome =
  | { readonly kind: 'win'; readonly winner: PlayerId }
  | { readonly kind: 'timeout' };

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

  let state: GameState = created.state;
  const events: GameEvent[] | undefined = record ? [...created.events] : undefined;
  const decisions: TracedDecision[] | undefined = record ? [] : undefined;

  let actions = 0;
  // Bound the loop two independent ways so a pathological state can never hang.
  while (!state.gameOver && state.turnNumber <= sim.maxTurnsPerGame && actions < sim.maxActionsPerGame) {
    const legal = generateLegalActions(state, config);
    if (legal.length === 0) break; // no moves (shouldn't happen pre-gameOver) — bail safely

    const seat = state.priorityPlayer;
    const pilot = pilots[seat];
    // Thread the pool's effect registry + the active rules config into the decision
    // context so look-ahead pilots (MCTS) roll out hypothetical lines through the
    // *same* forward model the real game uses — spell effects resolve at full
    // fidelity, not as no-ops. Non-simulating pilots simply ignore these fields.
    const action = pilot.chooseAction({
      view: state,
      legalActions: legal,
      rng: rngs[seat],
      registry: seats.registry,
      rulesConfig: config,
    });
    if (decisions) decisions.push({ player: seat, action });

    const result = applyAction(state, action, config, seats.registry);
    state = result.state;
    if (events) for (const e of result.events) events.push(e);
    actions++;
  }

  const outcome: MatchOutcome =
    state.gameOver && state.winner !== null
      ? { kind: 'win', winner: state.winner }
      : { kind: 'timeout' };

  const result: MatchResult = {
    outcome,
    turns: state.turnNumber,
    actions,
    finalLife: { A: state.players.A.life, B: state.players.B.life },
    seed,
    startingPlayer,
    ...(events ? { events } : {}),
    ...(decisions ? { decisions } : {}),
  };
  return result;
}
