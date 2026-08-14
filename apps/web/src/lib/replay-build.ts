/**
 * Build a serializable `MatchTrace` for the replay viewer by playing ONE game and
 * snapshotting the board after every applied action.
 *
 * This lives WORKER-SIDE (imported only by `sim.worker.ts`) because it drives the
 * pure core engine, which is heavy. It deliberately mirrors `runMatch`'s loop
 * (DESIGN §3.5) rather than calling it: `runMatch` returns only the final state +
 * event log, but the viewer needs the board *at every checkpoint* with effective
 * P/T (which the engine computes via the continuous-effects layer). So we compose
 * the same public core primitives `runMatch` uses — `createGame`,
 * `generateLegalActions`, `applyAction`, the pilots — and capture a render-ready
 * snapshot after each action (DESIGN §2: orchestrate over the seams, reuse the
 * tested engine, don't re-implement its rules). The seat-RNG salts match
 * `runMatch` so the same seed reproduces the same game across surfaces.
 */
import type {
  CardInstance,
  GameAction,
  GameEvent,
  GameState,
  PlayerId,
  Rng,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  effectivePower,
  effectiveToughness,
  generateLegalActions,
  indexContinuous,
  isCreature,
  isLand,
  MANA_COLORS,
} from '@jonny-boi/core';
import type { EffectRegistry } from '@jonny-boi/core';
import type { Pilot } from '@jonny-boi/ai';
import type { LoadedDeck } from '@jonny-boi/sim';
import { DEFAULT_SIM_CONFIG } from '@jonny-boi/sim';
import type {
  MatchTrace,
  ReplayFrame,
  ReplayPermanent,
  ReplaySeat,
  ReplaySide,
} from './replay-types.js';

/** Per-seat RNG salts — identical to `match.ts` so replays match sim games. */
const SEAT_SALT: Readonly<Record<PlayerId, number>> = { A: 0x9e3779b9, B: 0x85ebca6b };

function seatRng(seed: number, seat: PlayerId): Rng {
  return createRng((seed ^ SEAT_SALT[seat]) >>> 0);
}

/** Inputs to build a trace: the two loaded decks, the pilots, and the registry. */
export interface TraceMatchInput {
  readonly deckA: LoadedDeck;
  readonly deckB: LoadedDeck;
  readonly pilotA: Pilot;
  readonly pilotB: Pilot;
  readonly registry: EffectRegistry;
  readonly seatNames: Readonly<Record<PlayerId, ReplaySeat>>;
}

/** Snapshot one permanent into render-ready, serializable data. */
function snapPermanent(inst: CardInstance, mod: ReturnType<typeof indexContinuous>): ReplayPermanent {
  const aggregate = mod.get(inst.instanceId);
  const creature = isCreature(inst.def);
  return {
    instanceId: inst.instanceId,
    name: inst.def.name,
    cardId: inst.def.id,
    power: creature ? effectivePower(inst, aggregate) : null,
    toughness: creature ? effectiveToughness(inst, aggregate) : null,
    tapped: inst.tapped,
    summoningSick: inst.summoningSick,
    damageMarked: inst.damageMarked,
    isCreature: creature,
    isLand: isLand(inst.def),
  };
}

/** Snapshot one player's render-ready side. */
function snapSide(state: GameState, player: PlayerId): ReplaySide {
  const p = state.players[player];
  const mod = indexContinuous(state);
  const board = state.battlefield
    .filter((inst) => inst.controller === player)
    .map((inst) => snapPermanent(inst, mod));
  return {
    life: p.life,
    handCount: p.hand.length,
    libraryCount: p.library.length,
    graveyardCount: p.graveyard.length,
    hand: p.hand.map((inst) => inst.instanceId),
    library: p.library.map((inst) => inst.instanceId),
    graveyard: p.graveyard.map((inst) => inst.instanceId),
    manaPool: snapManaPool(p.manaPool),
    board,
  };
}

/** Copy the pool as a plain record, dropping zeroes so the UI shows only mana. */
function snapManaPool(pool: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const symbol of MANA_COLORS) {
    const amount = pool[symbol] ?? 0;
    if (amount > 0) out[symbol] = amount;
  }
  return out;
}

/** Capture a full frame (both sides + turn/step) at the current state. */
function snapFrame(state: GameState, eventIndex: number): ReplayFrame {
  return {
    eventIndex,
    turn: state.turnNumber,
    step: state.step,
    activePlayer: state.activePlayer,
    sides: { A: snapSide(state, 'A'), B: snapSide(state, 'B') },
    stackSize: state.stack.length,
    gameOver: state.gameOver,
    winner: state.winner,
  };
}

/**
 * Play one game and produce a serialized `MatchTrace`, capped at `maxEvents`
 * recorded events (and a proportional frame cap). Deterministic in `seed`.
 */
export function buildMatchTrace(input: TraceMatchInput, seed: number, maxEvents: number): MatchTrace {
  const config = DEFAULT_RULES;
  const sim = DEFAULT_SIM_CONFIG;
  const startingPlayer: PlayerId = 'A';
  const pilots: Record<PlayerId, Pilot> = { A: input.pilotA, B: input.pilotB };
  const rngs: Record<PlayerId, Rng> = { A: seatRng(seed, 'A'), B: seatRng(seed, 'B') };

  const created = createGame({
    seed,
    startingPlayer,
    config,
    registry: input.registry,
    decks: { A: { cards: input.deckA.library }, B: { cards: input.deckB.library } },
  });

  let state: GameState = created.state;
  const events: GameEvent[] = [...created.events];
  const names: Record<number, string> = {};
  const cardIds: Record<number, string> = {};
  const frames: ReplayFrame[] = [];
  let truncated = false;

  // Remember every instance we ever see, so the log can name an id even after the
  // permanent has left the battlefield (events like `damageDealt` carry only ids).
  const remember = (s: GameState): void => {
    for (const inst of s.battlefield) {
      names[inst.instanceId] = inst.def.name;
      cardIds[inst.instanceId] = inst.def.id;
    }
    for (const player of ['A', 'B'] as const) {
      // The library is indexed too: the viewer reveals it, so every card in the
      // deck needs a name from the very first frame, not just once it is drawn.
      for (const zone of [
        s.players[player].hand,
        s.players[player].library,
        s.players[player].graveyard,
        s.players[player].exile,
      ]) {
        for (const inst of zone) {
          names[inst.instanceId] = inst.def.name;
          cardIds[inst.instanceId] = inst.def.id;
        }
      }
    }
  };
  remember(state);

  // Opening frame (no actions applied yet); eventIndex points at the last setup event.
  frames.push(snapFrame(state, events.length - 1));

  let actions = 0;
  while (
    !state.gameOver &&
    state.turnNumber <= sim.maxTurnsPerGame &&
    actions < sim.maxActionsPerGame
  ) {
    if (events.length >= maxEvents) {
      truncated = true;
      break;
    }
    const legal = generateLegalActions(state, config);
    if (legal.length === 0) break;

    const seat = state.priorityPlayer;
    const action: GameAction = pilots[seat].chooseAction({
      view: state,
      legalActions: legal,
      rng: rngs[seat],
    });
    const result = applyAction(state, action, config, input.registry);
    state = result.state;
    for (const e of result.events) events.push(e);
    remember(state);
    frames.push(snapFrame(state, events.length - 1));
    actions++;
  }

  const outcome =
    state.gameOver && state.winner !== null
      ? ({ kind: 'win', winner: state.winner } as const)
      : ({ kind: 'timeout' } as const);

  return {
    seats: input.seatNames,
    events,
    frames,
    names,
    cardIds,
    outcome,
    seed,
    turns: state.turnNumber,
    actions,
    truncated,
  };
}
