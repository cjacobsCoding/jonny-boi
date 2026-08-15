/**
 * THE PAIRED ARM RUNNER — the machinery that lets the suggestion engine test many
 * candidate swaps *incrementally* and cheaply, without weakening the statistics.
 *
 * `evaluateSwap` (§3.5) answers one question with a fixed budget: play N paired
 * games, return a verdict. The adaptive search (§3.6) needs three more things:
 *
 *   1. **Resumable evaluation.** A candidate is given a small batch of games, then
 *      possibly more, then possibly more again. Its statistics must be identical
 *      to having played that many games in one go.
 *   2. **A shared base arm.** Every candidate is compared against the SAME base
 *      deck on the SAME games. Under common random numbers the base arm's outcome
 *      for a given (opponent, game index) does not depend on which candidate we
 *      happen to be testing, so it is played ONCE and reused by all of them.
 *      `evaluateSwap` replays it per candidate — with 12 candidates that is 12
 *      identical gauntlets, i.e. half of all the games run were redundant.
 *   3. **Free games.** With common random numbers, base and variant differ in
 *      exactly one library slot. A game that never touches that slot plays out
 *      *identically* in both arms, so the base result IS the variant result. We
 *      detect that exactly (never approximately) and skip the replay.
 *
 * ### Balanced prefixes
 * Games are enumerated round-robin over the gauntlet — slot k is opponent
 * `k % opponents`, game `floor(k / opponents)` — so ANY prefix of the sequence is
 * spread evenly over the whole gauntlet. That matters for an adaptive scheduler: a
 * candidate eliminated after 21 games was judged against all seven opponents, not
 * measured three times against the one matchup it happens to hate. The per-game
 * seed and on-the-play assignment are computed exactly as `evaluateSwap` computes
 * them, so a candidate played to the full budget sees precisely the same multiset
 * of games — only the order differs, and a 2x2 tally does not care about order.
 */

import {
  createGame,
  type CardDefinition,
  type EffectRegistry,
  type GameEvent,
  type PlayerId,
} from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck, LoadedDeck } from './deck.js';
import { loadDeck } from './deck.js';
import type { MatchupPilots, RunOptions } from './matchup.js';
import { gameSeedFor, makeSeats, onPlayFor } from './matchup.js';
import { runMatch, type MatchSeats } from './match.js';
import type { CardSwap, SwapEvaluation } from './swap.js';
import { applySwap, summarizePairedSwap } from './swap.js';
import { DEFAULT_DECK_RULES, type DeckRules } from './config.js';
import type { PairedTable } from './stats.js';
import {
  HERO_FIRST_INSTANCE_ID,
  HERO_SEAT,
  LIBRARY_READING_PRIMITIVES,
  PILOTS_THAT_READ_HIDDEN_LIBRARY,
} from './paired-arms-config.js';

/** One paired game slot: which gauntlet opponent, and which game against them. */
export interface PairedSlot {
  readonly opponentIndex: number;
  readonly gameIndex: number;
}

/**
 * Map a flat slot index onto (opponent, game) round-robin, so every prefix of the
 * slot sequence covers the gauntlet as evenly as the count allows. Pure.
 */
export function pairedSlotAt(slot: number, opponentCount: number): PairedSlot {
  return { opponentIndex: slot % opponentCount, gameIndex: Math.floor(slot / opponentCount) };
}

/** A mutable 2x2 accumulator; frozen into a `PairedTable` when read. */
interface PairedTally {
  bothWon: number;
  baseOnly: number;
  variantOnly: number;
  neither: number;
}

/** What one base game tells us, beyond who won. */
interface BaseGameRecord {
  /** Did the hero (base deck) win this game? */
  readonly heroWon: boolean;
  /**
   * Instance ids of hero cards that LEFT a library this game (drawn, milled,
   * revealed, tutored). A swapped slot whose id is absent was never seen.
   * `undefined` when identical-game detection is switched off.
   */
  readonly leftLibrary?: ReadonlySet<number>;
  /**
   * True when something happened that could make the two arms diverge even without
   * the swapped card being drawn — a library was read or written by an effect. When
   * set, no game may be claimed identical.
   */
  readonly libraryDisturbed: boolean;
}

/** A candidate swap being evaluated incrementally. */
export interface SwapArm {
  readonly swap: CardSwap;
  readonly outName: string;
  readonly inName: string;
  readonly variantDeck: Deck;
  /** Paired games played so far. */
  readonly gamesPlayed: number;
  /** Variant games answered for free by an identical base game. */
  readonly variantGamesSkipped: number;
  /** The running paired table (a valid table at every point). */
  readonly paired: PairedTable;
}

/** Internal, mutable arm state. */
interface ArmState {
  readonly swap: CardSwap;
  readonly outName: string;
  readonly inName: string;
  readonly variantDeck: Deck;
  readonly variantLoaded: LoadedDeck;
  readonly seatsByOpponent: (MatchSeats | undefined)[];
  /**
   * The instance id the variant replaces, in the BASE game — or `undefined` when
   * we could not establish it and must therefore always replay the variant.
   */
  readonly swappedInstanceId: number | undefined;
  gamesPlayed: number;
  variantGamesSkipped: number;
  tally: PairedTally;
}

/** Everything the runner needs to play games. */
export interface PairedArmsOptions {
  readonly gauntletDecks: readonly LoadedDeck[];
  readonly pilots: MatchupPilots;
  readonly pool: CardPool;
  readonly registry: EffectRegistry;
  /** The seed all arms share — the source of the common random numbers. */
  readonly seed: number;
  readonly runOptions?: RunOptions;
  readonly deckRules?: DeckRules;
  /**
   * Reuse base results for variant games that provably could not differ. Exact,
   * but only sound for pilots that decide from public information (see
   * {@link PILOTS_THAT_READ_HIDDEN_LIBRARY}); the runner disables it by itself
   * when a look-ahead pilot is seated, and says so in `identicalGameSkipEnabled`.
   */
  readonly reuseUnseenCardGames?: boolean;
}

/** Throughput bookkeeping the report prints — no silent accounting. */
export interface PairedArmsUsage {
  /** Base-deck games actually played (once for the whole run, not per candidate). */
  readonly baseGamesPlayed: number;
  /** Variant games actually played. */
  readonly variantGamesPlayed: number;
  /** Variant games answered for free because the swapped card was never seen. */
  readonly variantGamesSkipped: number;
  /** Every game the sim actually ran. */
  readonly totalGamesPlayed: number;
  /** Whether the identical-game optimisation was live this run. */
  readonly identicalGameSkipEnabled: boolean;
  /** Why it was off, when it was off. */
  readonly identicalGameSkipDisabledReason?: string;
}

/** The incremental evaluator the scheduler drives. */
export interface PairedArmRunner {
  /** Total paired slots available at `gamesPerMatchup` games per opponent. */
  readonly slotCapacity: (gamesPerMatchup: number) => number;
  /** Create an arm for a candidate swap. Throws if the swap is illegal. */
  readonly openArm: (swap: CardSwap, outName: string, inName: string) => ArmHandle;
  /** Play an arm forward until it has `targetGames` paired games. */
  readonly advance: (arm: ArmHandle, targetGames: number) => SwapArm;
  /** Read an arm without playing anything. */
  readonly read: (arm: ArmHandle) => SwapArm;
  /** Turn an arm into the §3.5 verdict over the games it actually played. */
  readonly summarize: (arm: ArmHandle) => SwapEvaluation;
  readonly usage: () => PairedArmsUsage;
}

/** An opaque handle to an arm (its mutable state stays inside the runner). */
export type ArmHandle = { readonly __arm: unique symbol } & object;

/**
 * Build the runner for one base deck + gauntlet + seed.
 *
 * The base arm is lazy: a slot's base game is played the first time ANY candidate
 * needs it and remembered for every candidate after that.
 */
export function createPairedArmRunner(baseDeck: Deck, options: PairedArmsOptions): PairedArmRunner {
  const rules = options.deckRules ?? DEFAULT_DECK_RULES;
  const baseLoaded = loadDeck(baseDeck, options.pool, rules);
  const opponents = options.gauntletDecks;
  const opponentCount = opponents.length;

  const baseSeatsByOpponent: (MatchSeats | undefined)[] = new Array(opponentCount).fill(undefined);
  const baseRecords = new Map<number, BaseGameRecord>();

  let baseGamesPlayed = 0;
  let variantGamesPlayed = 0;
  let variantGamesSkipped = 0;

  const skipDecision = decideIdenticalGameSkip(options, baseLoaded, opponents, rules);
  const trackLibrary = skipDecision.enabled;

  function baseSeats(opponentIndex: number): MatchSeats {
    const cached = baseSeatsByOpponent[opponentIndex];
    if (cached) return cached;
    const seats = makeSeats(baseLoaded, opponents[opponentIndex] as LoadedDeck, options.pilots, options.registry);
    baseSeatsByOpponent[opponentIndex] = seats;
    return seats;
  }

  function seedForSlot(slot: PairedSlot): number {
    // Identical to `evaluateSwap`'s per-game seed, so the two paths play the very
    // same games (only the order in which they are visited differs).
    return gameSeedFor(gameSeedFor(options.seed, slot.opponentIndex), slot.gameIndex);
  }

  function matchOptionsFor(slot: PairedSlot): { config?: RunOptions['config']; sim?: RunOptions['sim']; startingPlayer: PlayerId } {
    return {
      config: options.runOptions?.config,
      sim: options.runOptions?.sim,
      startingPlayer: onPlayFor(slot.gameIndex),
    };
  }

  function baseRecordFor(slotIndex: number): BaseGameRecord {
    const cached = baseRecords.get(slotIndex);
    if (cached) return cached;

    const slot = pairedSlotAt(slotIndex, opponentCount);
    const leftLibrary = trackLibrary ? new Set<number>() : undefined;
    let libraryDisturbed = false;
    const observer = trackLibrary
      ? (event: GameEvent): void => {
          if (event.type === 'drawCard') {
            (leftLibrary as Set<number>).add(event.instanceId);
          } else if (event.type === 'zoneChange') {
            if (event.from === 'library') (leftLibrary as Set<number>).add(event.instanceId);
            // A card put back INTO a library shifts the slot we are reasoning about.
            else if (event.to === 'library') libraryDisturbed = true;
          } else if (event.type === 'effectApplied' && LIBRARY_READING_PRIMITIVES.has(event.primitive)) {
            // An effect looked at library contents; what it saw could differ.
            libraryDisturbed = true;
          } else if (event.type === 'choiceAbandoned') {
            // An unrepresentable question — do not reason about this game at all.
            libraryDisturbed = true;
          }
        }
      : undefined;

    const result = runMatch(baseSeats(slot.opponentIndex), seedForSlot(slot), {
      ...matchOptionsFor(slot),
      ...(observer ? { onEvent: observer } : {}),
    });
    baseGamesPlayed++;

    const record: BaseGameRecord = {
      heroWon: result.outcome.kind === 'win' && result.outcome.winner === HERO_SEAT,
      ...(leftLibrary ? { leftLibrary } : {}),
      libraryDisturbed,
    };
    baseRecords.set(slotIndex, record);
    return record;
  }

  const arms = new Map<ArmHandle, ArmState>();

  function stateOf(handle: ArmHandle): ArmState {
    const state = arms.get(handle);
    if (!state) throw new Error('unknown arm handle — it was not opened by this runner');
    return state;
  }

  function snapshot(state: ArmState): SwapArm {
    return {
      swap: state.swap,
      outName: state.outName,
      inName: state.inName,
      variantDeck: state.variantDeck,
      gamesPlayed: state.gamesPlayed,
      variantGamesSkipped: state.variantGamesSkipped,
      paired: { ...state.tally },
    };
  }

  return {
    slotCapacity: (gamesPerMatchup) => gamesPerMatchup * opponentCount,

    openArm(swap, outName, inName) {
      const variantDeck = applySwap(baseDeck, swap, options.pool);
      const variantLoaded = loadDeck(variantDeck, options.pool, rules);
      const handle = {} as ArmHandle;
      arms.set(handle, {
        swap,
        outName,
        inName,
        variantDeck,
        variantLoaded,
        seatsByOpponent: new Array(opponentCount).fill(undefined),
        swappedInstanceId: trackLibrary
          ? swappedInstanceIdFor(baseLoaded.library, variantLoaded.library)
          : undefined,
        gamesPlayed: 0,
        variantGamesSkipped: 0,
        tally: { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 },
      });
      return handle;
    },

    advance(handle, targetGames) {
      const state = stateOf(handle);
      for (let slotIndex = state.gamesPlayed; slotIndex < targetGames; slotIndex++) {
        const slot = pairedSlotAt(slotIndex, opponentCount);
        const base = baseRecordFor(slotIndex);

        const variantWon = playVariantGame(state, slot, base);
        if (base.heroWon && variantWon) state.tally.bothWon++;
        else if (base.heroWon) state.tally.baseOnly++;
        else if (variantWon) state.tally.variantOnly++;
        else state.tally.neither++;
        state.gamesPlayed++;
      }
      return snapshot(state);
    },

    read: (handle) => snapshot(stateOf(handle)),

    summarize(handle) {
      const state = stateOf(handle);
      return summarizePairedSwap({
        baseDeckName: baseDeck.name,
        variantDeckName: state.variantDeck.name,
        swap: state.swap,
        outName: state.outName,
        inName: state.inName,
        paired: { ...state.tally },
        ...(options.runOptions?.stats ? { stats: options.runOptions.stats } : {}),
      });
    },

    usage: () => ({
      baseGamesPlayed,
      variantGamesPlayed,
      variantGamesSkipped,
      totalGamesPlayed: baseGamesPlayed + variantGamesPlayed,
      identicalGameSkipEnabled: skipDecision.enabled,
      ...(skipDecision.reason ? { identicalGameSkipDisabledReason: skipDecision.reason } : {}),
    }),
  };

  /** Play (or provably skip) one variant game; returns whether the hero won it. */
  function playVariantGame(state: ArmState, slot: PairedSlot, base: BaseGameRecord): boolean {
    if (canReuseBaseGame(state, base)) {
      state.variantGamesSkipped++;
      variantGamesSkipped++;
      return base.heroWon;
    }
    let seats = state.seatsByOpponent[slot.opponentIndex];
    if (!seats) {
      seats = makeSeats(state.variantLoaded, opponents[slot.opponentIndex] as LoadedDeck, options.pilots, options.registry);
      state.seatsByOpponent[slot.opponentIndex] = seats;
    }
    const result = runMatch(seats, seedForSlot(slot), matchOptionsFor(slot));
    variantGamesPlayed++;
    return result.outcome.kind === 'win' && result.outcome.winner === HERO_SEAT;
  }
}

/**
 * Is the variant's game PROVABLY the base's game?
 *
 * The two decks are identical apart from one library slot, and (equal lengths,
 * same seed) the shuffle permutes positions independently of contents, so they stay
 * identical apart from that one slot for the whole game. If the card in that slot
 * never left the library and nothing read or rewrote a library, then every action,
 * every RNG draw and every pilot decision saw byte-identical information — the two
 * games ARE the same game. This is an exactness argument, not a heuristic: when it
 * does not hold we simply play the game.
 */
function canReuseBaseGame(state: ArmState, base: BaseGameRecord): boolean {
  if (state.swappedInstanceId === undefined) return false;
  // The degenerate case: the "variant" library is the base library card for card
  // (a swap of a card for itself). Then there is no differing slot to reason about
  // and EVERY game is the same game — which is exactly why the self-swap sanity
  // check (delta 0, no discordant pairs, p = 1) must come out perfect.
  if (state.swappedInstanceId === IDENTICAL_LIBRARIES) return true;
  if (base.libraryDisturbed) return false;
  const left = base.leftLibrary;
  if (!left) return false;
  return !left.has(state.swappedInstanceId);
}

/**
 * The instance id, in the base game, of the one card the variant replaces.
 *
 * `createGame` mints instance ids sequentially over the hero's pre-shuffle library
 * (the hero is seated first), so the card at pre-shuffle index i always carries id
 * `i + HERO_FIRST_INSTANCE_ID` — a fact this module VERIFIES at startup rather than
 * assumes (see `verifyHeroInstanceIdMapping`). Finding i is a diff of the two flat
 * libraries: `applySwap` rewrites a single slot in place, so exactly one index
 * differs. Anything else (different lengths, several differences, none at all)
 * returns `undefined` and simply switches the optimisation off for that arm.
 */
export function swappedInstanceIdFor(
  baseLibrary: readonly CardDefinition[],
  variantLibrary: readonly CardDefinition[],
): number | undefined {
  if (baseLibrary.length !== variantLibrary.length) return undefined;
  let found = -1;
  for (let i = 0; i < baseLibrary.length; i++) {
    if ((baseLibrary[i] as CardDefinition).id === (variantLibrary[i] as CardDefinition).id) continue;
    if (found >= 0) return undefined; // more than one difference — not a single-slot swap
    found = i;
  }
  return found < 0 ? IDENTICAL_LIBRARIES : found + HERO_FIRST_INSTANCE_ID;
}

/**
 * Sentinel for "the two libraries are identical" — a card swapped for itself. Zero
 * is safe to use because core mints instance ids from
 * {@link HERO_FIRST_INSTANCE_ID} (1), so no real card can carry it.
 */
export const IDENTICAL_LIBRARIES = 0;

/**
 * Confirm empirically that hero instance ids index the pre-shuffle library. One
 * game creation (a shuffle, no play) proves it for this engine build; if the engine
 * ever changes how it mints ids, the identical-game optimisation switches itself
 * off instead of returning a wrong answer.
 */
export function verifyHeroInstanceIdMapping(
  hero: LoadedDeck,
  opponent: LoadedDeck,
  registry: EffectRegistry,
  seed: number,
  config?: RunOptions['config'],
): boolean {
  const created = createGame({
    seed,
    startingPlayer: HERO_SEAT,
    ...(config ? { config } : {}),
    registry,
    decks: { A: { cards: hero.library }, B: { cards: opponent.library } },
  });
  const heroState = created.state.players[HERO_SEAT];
  const all = [...heroState.library, ...heroState.hand];
  if (all.length !== hero.library.length) return false;
  for (const instance of all) {
    if (hero.library[instance.instanceId - HERO_FIRST_INSTANCE_ID] !== instance.def) return false;
  }
  return true;
}

/** Whether the identical-game skip may run, and the honest reason when it may not. */
function decideIdenticalGameSkip(
  options: PairedArmsOptions,
  baseLoaded: LoadedDeck,
  opponents: readonly LoadedDeck[],
  _rules: DeckRules,
): { readonly enabled: boolean; readonly reason?: string } {
  if (options.reuseUnseenCardGames === false) {
    return { enabled: false, reason: 'disabled by configuration' };
  }
  const first = opponents[0];
  if (!first) return { enabled: false, reason: 'no gauntlet opponents' };

  for (const pilot of [options.pilots.pilotA, options.pilots.pilotB]) {
    if (PILOTS_THAT_READ_HIDDEN_LIBRARY.has(pilot.id)) {
      return {
        enabled: false,
        reason:
          `pilot "${pilot.id}" reasons over hidden library contents (it rolls out real draws), ` +
          'so a game can differ even when the swapped card is never drawn',
      };
    }
  }

  if (!verifyHeroInstanceIdMapping(baseLoaded, first, options.registry, options.seed, options.runOptions?.config)) {
    return {
      enabled: false,
      reason: 'hero instance ids no longer index the pre-shuffle library (engine change)',
    };
  }
  return { enabled: true };
}
