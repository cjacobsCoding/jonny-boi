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
  type EffectRef,
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
import { DEFAULT_DECK_RULES, DEFAULT_SWAP_SCOPE, type DeckRules } from './config.js';
import type { PairedTable } from './stats.js';
import {
  CONTROL_CHANGING_PRIMITIVES,
  HERO_FIRST_INSTANCE_ID,
  HERO_SEAT,
  LIBRARY_READING_PRIMITIVES,
  LIBRARY_TARGET_PARAM,
  OPPONENT_LIBRARY_TARGET,
  PILOTS_THAT_READ_HIDDEN_LIBRARY,
  SELF_LIBRARY_TARGET,
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
   * The instance ids the variant replaces, in the BASE game — one for a single-copy
   * swap, the whole playset otherwise. `undefined` when we could not establish them
   * and must therefore always replay the variant.
   */
  readonly swappedInstanceIds: readonly number[] | undefined;
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
  // Match `evaluateSwap`'s scope exactly, or the two would build different variants.
  const swapScope = options.runOptions?.swapScope ?? DEFAULT_SWAP_SCOPE;
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

  // Instance ids are minted sequentially, hero library first (verified by
  // `verifyHeroInstanceIdMapping`), so a card's OWNER is readable straight off its
  // id. Ownership — unlike targeting — is fixed at creation and cannot be
  // redirected, which is what makes it a sound thing to scope on.
  const heroLibrarySize = baseLoaded.library.length;
  const heroLastInstanceId = HERO_FIRST_INSTANCE_ID + heroLibrarySize - 1;

  // Owner is only a proxy for controller while nothing can steal a permanent.
  const controlCanChange = [baseLoaded, ...opponents].some((deck) =>
    deck.library.some((def) => allEffectRefs(def).some((ref) => CONTROL_CHANGING_PRIMITIVES.has(ref.primitive))),
  );

  function isHeroOwned(instanceId: number): boolean {
    return instanceId >= HERO_FIRST_INSTANCE_ID && instanceId <= heroLastInstanceId;
  }

  /** True only for a card that started in THIS opponent's deck (never a token). */
  function isOpponentOwned(instanceId: number, opponentIndex: number): boolean {
    const opponent = opponents[opponentIndex];
    if (!opponent) return false;
    return instanceId > heroLastInstanceId && instanceId <= heroLastInstanceId + opponent.library.length;
  }

  /**
   * Could THIS peek have read the hero's library?
   *
   * Answered per source card from authored data, not per deck and not from the
   * event alone. Every library primitive resolves its victim through
   * `playerParam(ctx, 'who', 'controller')`, so the `who` on the source card's own
   * effect ref decides who gets read:
   *
   *   - absent / `'controller'` → the source's controller. An OPPONENT's Ponder
   *     reads the opponent's library, which is byte-identical in both arms.
   *   - `'opponent'`            → the other player. The HERO's Goblin Guide reveals
   *     the opponent's top card — also identical in both arms.
   *   - `'targetPlayer'` / `'targetController'` → decided at runtime by targeting,
   *     which the event does not carry. UW Control's Path to Exile is exactly this
   *     and genuinely does search the hero's library, so it stays conservative.
   *
   * Per-deck scanning was too coarse to be useful: one Path to Exile would have
   * disqualified every Ponder in the same deck, and the hero's own Goblin Guide
   * (which only ever looks at the opponent) would have disqualified nearly every
   * game in the gauntlet.
   */
  function peekCouldReadHeroLibrary(sourceInstanceId: number, opponentIndex: number): boolean {
    if (controlCanChange) return true; // owner is no longer a proxy for controller
    const source = sourceCardFor(sourceInstanceId, opponentIndex);
    if (!source) return true; // a token or an id we cannot place — stay conservative
    for (const ref of allEffectRefs(source.def)) {
      if (!LIBRARY_READING_PRIMITIVES.has(ref.primitive)) continue;
      const who = ref.params?.[LIBRARY_TARGET_PARAM];
      if (who === undefined || who === SELF_LIBRARY_TARGET) {
        if (source.ownedByHero) return true; // reads its controller's = the hero's
      } else if (who === OPPONENT_LIBRARY_TARGET) {
        if (!source.ownedByHero) return true; // the opponent's "opponent" is the hero
      } else {
        return true; // target-driven — unknowable from the event, so assume the worst
      }
    }
    return false;
  }

  /** Place an instance id back on the card it was minted from, and whose deck. */
  function sourceCardFor(
    instanceId: number,
    opponentIndex: number,
  ): { readonly def: CardDefinition; readonly ownedByHero: boolean } | undefined {
    if (isHeroOwned(instanceId)) {
      const def = baseLoaded.library[instanceId - HERO_FIRST_INSTANCE_ID];
      return def ? { def, ownedByHero: true } : undefined;
    }
    const opponent = opponents[opponentIndex];
    if (!opponent || !isOpponentOwned(instanceId, opponentIndex)) return undefined;
    const def = opponent.library[instanceId - heroLastInstanceId - 1];
    return def ? { def, ownedByHero: false } : undefined;
  }

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
    // Ownership is decided by the instance id, not by targeting: ids are minted
    // hero-first over the hero's pre-shuffle library, so `1..heroLibrarySize` is
    // the hero's deck and the opponent's follows. A token minted mid-game falls
    // outside BOTH ranges and is treated conservatively.
    const observer = trackLibrary
      ? (event: GameEvent): void => {
          if (event.type === 'drawCard') {
            (leftLibrary as Set<number>).add(event.instanceId);
          } else if (event.type === 'zoneChange') {
            // Every card that leaves ANY library announces its instance id here
            // (`moveOwnedCard` always emits this), which is what lets mills,
            // tutors and reveals be tracked exactly rather than feared in bulk.
            if (event.from === 'library') (leftLibrary as Set<number>).add(event.instanceId);
            // A card put back into the HERO's library shifts the slot we reason
            // about. Into the opponent's, it cannot: their deck and their seed are
            // identical in both arms, so their Brainstorm plays out the same way.
            else if (event.to === 'library' && isHeroOwned(event.instanceId)) libraryDisturbed = true;
          } else if (event.type === 'effectApplied' && LIBRARY_READING_PRIMITIVES.has(event.primitive)) {
            // An effect READ library contents without necessarily moving anything
            // (a search that found nothing, a reveal that missed its filter), so
            // there is no instance id to reason about — only "could this have been
            // the hero's library?". `playerParam` picks the victim at RUNTIME from
            // targets, so neither the primitive id nor the source's controller
            // settles it; what settles it is whether the opponent's DECK contains
            // any library effect aimed at someone other than its own controller.
            if (peekCouldReadHeroLibrary(event.sourceInstanceId, slot.opponentIndex)) {
              libraryDisturbed = true;
            }
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
      const variantDeck = applySwap(baseDeck, swap, options.pool, swapScope);
      const variantLoaded = loadDeck(variantDeck, options.pool, rules);
      const handle = {} as ArmHandle;
      arms.set(handle, {
        swap,
        outName,
        inName,
        variantDeck,
        variantLoaded,
        seatsByOpponent: new Array(opponentCount).fill(undefined),
        swappedInstanceIds: trackLibrary
          ? swappedInstanceIdsFor(baseLoaded.library, variantLoaded.library)
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
 * The two decks are identical apart from the swapped slots, and (equal lengths,
 * same seed) the shuffle permutes positions independently of contents, so they stay
 * identical apart from those slots for the whole game. If no card in those slots
 * ever left the library, and nothing read or rewrote the HERO's library, then every
 * action, every RNG draw and every pilot decision saw byte-identical information —
 * the two games ARE the same game. This is an exactness argument, not a heuristic:
 * when it does not hold we simply play the game.
 */
function canReuseBaseGame(state: ArmState, base: BaseGameRecord): boolean {
  const swapped = state.swappedInstanceIds;
  if (swapped === undefined) return false;
  // The degenerate case: the "variant" library is the base library card for card
  // (a swap of a card for itself). There is no differing slot to reason about, so
  // EVERY game is the same game — which is why the self-swap sanity check
  // (delta 0, no discordant pairs, p = 1) must come out perfect and cost nothing.
  if (swapped.length === 0) return true;
  if (base.libraryDisturbed) return false;
  const left = base.leftLibrary;
  if (!left) return false;
  for (const id of swapped) {
    if (left.has(id)) return false;
  }
  return true;
}

/**
 * The instance ids, in the base game, of every card the variant replaces.
 *
 * `createGame` mints instance ids sequentially over the hero's pre-shuffle library
 * (the hero is seated first), so the card at pre-shuffle index i always carries id
 * `i + HERO_FIRST_INSTANCE_ID` — a fact this module VERIFIES at startup rather than
 * assumes (see `verifyHeroInstanceIdMapping`). Finding the slots is a diff of the
 * two flat libraries: `applySwap` rewrites them in place, so the differing indices
 * are exactly the copies that moved.
 *
 * A **playset** swap rewrites four slots, not one — and since `DEFAULT_SWAP_SCOPE`
 * became `'playset'` (replacing every copy is what a person usually means when
 * comparing two cards), a single-slot detector silently switched this optimisation
 * off for every candidate. The argument never depended on there being exactly one
 * differing card, only on NONE of them being touched, so it generalises to a set.
 *
 * Returns an empty array when the libraries are identical (a card swapped for
 * itself), and `undefined` when the two cannot be compared at all.
 */
export function swappedInstanceIdsFor(
  baseLibrary: readonly CardDefinition[],
  variantLibrary: readonly CardDefinition[],
): readonly number[] | undefined {
  if (baseLibrary.length !== variantLibrary.length) return undefined;
  const ids: number[] = [];
  for (let i = 0; i < baseLibrary.length; i++) {
    if ((baseLibrary[i] as CardDefinition).id === (variantLibrary[i] as CardDefinition).id) continue;
    ids.push(i + HERO_FIRST_INSTANCE_ID);
  }
  return ids;
}

/** Every effect a card can run, wherever it is authored. */
function allEffectRefs(def: CardDefinition): readonly EffectRef[] {
  const refs: EffectRef[] = [...(def.effects ?? [])];
  for (const trigger of def.triggers ?? []) refs.push(...trigger.effects);
  for (const ability of def.activated ?? []) refs.push(...ability.effects);
  return refs;
}

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
