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
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck, LoadedDeck } from './deck.js';
import { loadDeck } from './deck.js';
import type { MatchupPilots, RunOptions } from './matchup.js';
import { gameSeedFor, makeSeats, onPlayFor } from './matchup.js';
import { runMatch, type MatchResult, type MatchSeats } from './match.js';
import type { CardSwap, SwapEvaluation } from './swap.js';
import { applySwap, copiesSwappedBy, summarizePairedSwap } from './swap.js';
import { DEFAULT_DECK_RULES, DEFAULT_SWAP_SCOPE, type DeckRules } from './config.js';
import type { PairedTable } from './stats.js';
import {
  acquiresForeignAbilities,
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

/**
 * One base game's result, in a shape that survives `postMessage`.
 *
 * The parallel Lab plays the shared base arm on its own workers and hands the
 * records back to the workers that play the variant arms, so this is the wire
 * form of {@link BaseGameRecord}: a plain array instead of a `Set`, and an
 * explicit `null` (rather than an absent field) when library tracking was off.
 */
export interface PairedBaseRecord {
  /** Did the hero (base deck) win this game? */
  readonly heroWon: boolean;
  /** Instance ids that left a library this game; `null` when tracking is off. */
  readonly leftLibrary: readonly number[] | null;
  /** True when the hero's library was read or rewritten — nothing may be reused. */
  readonly libraryDisturbed: boolean;
  /**
   * What the run's game watch (`PairedArmsOptions.watchGames`) reported for this
   * game. Absent when the run watches nothing — every record before §3.175 —
   * and carried on the wire because a variant game the skip answers from this
   * record IS this game, observation included.
   */
  readonly observed?: PairedGameObservation;
}

/**
 * Anything a per-game watch reports about ONE game: plain JSON (numbers,
 * booleans, `null`), so it survives `postMessage` beside the rest of the record
 * and a host can aggregate it without knowing which watch produced it.
 */
export type PairedGameObservation = Readonly<Record<string, number | boolean | null>>;

/**
 * A per-game WATCH — the optional seam that lets a run measure something about
 * every game it plays (base and variant alike) without the runner knowing what.
 *
 * Built fresh for every game by `PairedArmsOptions.watchGames`, fed the game's
 * settled states and events as it is played, and asked to `finish` once when the
 * game ends; whatever it returns rides the game's record. §3.175's reliability
 * metrics (missed land drops, colour screw, lands by turn four) are one such
 * watch. A variant game the identical-game skip answers from the base record
 * inherits the base game's observation, because it IS that game.
 */
export interface PairedGameWatch {
  /** Every settled decision state, in order — see `MatchOptions.onState`. */
  readonly onState?: (state: GameState) => void;
  /** Every event, in order — see `MatchOptions.onEvent`. */
  readonly onEvent?: (event: GameEvent) => void;
  /** Called once when the game ends; the result is kept beside the outcome. */
  readonly finish: (result: MatchResult) => PairedGameObservation;
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
  /** The game watch's report, when the run has one. */
  readonly observed?: PairedGameObservation;
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
  /**
   * Whether the hero won this arm's variant game at each slot, indexed by slot.
   * Every arm plays identical slots, so two arms' arrays line up element for
   * element — see `pairedBetweenArms`, which is what makes ranking two candidates
   * against EACH OTHER free rather than a second experiment.
   */
  readonly variantWonBySlot: readonly boolean[];
  /**
   * The game watch's report for each variant game, indexed by slot — present
   * only when the run has a watch. `null` for a slot whose game was answered
   * from a base record that carried no observation.
   */
  readonly observedBySlot?: readonly (PairedGameObservation | null)[];
}

/**
 * An arm built from a CALLER-SUPPLIED variant deck rather than a single-card
 * swap (§3.175). The deck must be the base deck rewritten IN PLACE — the same
 * length, differing in some slots — for the paired statistics and the
 * identical-game skip to hold; `applyManabase` builds exactly that.
 */
export interface VariantArmSpec {
  /** Stable identity for the arm (a manabase variant's key). */
  readonly key: string;
  /** What to call the variant in reports and evaluations (`inName`). */
  readonly label: string;
  readonly variantDeck: Deck;
  /** How many library slots differ from the base — reported as `copiesSwapped`. */
  readonly slotsChanged: number;
}

/**
 * The `out` side of a variant arm's `CardSwap`: there is no single card cut, so
 * the swap names the base deck on its out side and the variant's key on its in
 * side. A `SwapEvaluation` built for such an arm therefore reads
 * `swap: { out: 'base', in: <variant key> }`.
 */
export const VARIANT_ARM_BASE_REF = 'base';

/** Internal, mutable arm state. */
interface ArmState {
  readonly swap: CardSwap;
  readonly outName: string;
  readonly inName: string;
  readonly variantDeck: Deck;
  readonly variantLoaded: LoadedDeck;
  /** What `summarize` reports as `copiesSwapped` — fixed when the arm is built. */
  readonly copiesMoved: number;
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
  /**
   * Did the hero win THIS arm's variant game, slot by slot?
   *
   * ⚠️ WHY THIS IS KEPT RATHER THAN FOLDED AWAY. Every arm of a run plays the
   * SAME slots from the SAME seeds — slot i is the same opponent, the same game
   * index and the same base game for all of them. So two arms' per-slot outcomes
   * are directly comparable, and a paired ARM-VS-ARM table costs no extra games:
   * it is a cross-tabulation of data already in hand. The 2x2 `tally` cannot give
   * that, because it has already summed each arm against the BASE and thrown the
   * slot away — which is exactly why §3.96 had to decline the saving it wanted.
   */
  readonly variantWonBySlot: boolean[];
  /** The watch's report per variant slot, kept only when the run has a watch. */
  readonly observedBySlot: (PairedGameObservation | null)[];
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
  /**
   * Base games somebody else already played, looked up by slot index.
   *
   * This is what keeps base-arm reuse intact when the run is spread over a
   * worker pool: the pool plays each base slot ONCE on some worker, then hands
   * the record to every worker that plays a variant arm over that slot. A slot
   * this returns a record for costs nothing and is not counted in
   * `usage.baseGamesPlayed` — the worker that actually played it counted it.
   */
  readonly baseRecords?: (slot: number) => PairedBaseRecord | undefined;
  /** Ticked with games actually played, so a long slice can report progress. */
  readonly onGame?: (games: number) => void;
  /**
   * OPTIONAL — build a fresh {@link PairedGameWatch} for every game the runner
   * plays. Absent by default, and then nothing about a run changes: no state
   * observer is attached, no observation is recorded. When present, every base
   * record and every variant slot carries the watch's report, and a variant
   * game the identical-game skip answers inherits the base game's.
   */
  readonly watchGames?: () => PairedGameWatch;
}

/** One arm's results over a contiguous slice of slots — the pool's unit of work. */
export interface PairedSlice {
  /** The 2×2 table for THIS slice alone; callers sum slices themselves. */
  readonly paired: PairedTable;
  /**
   * Whether the hero won the variant game at each slot of THIS SLICE, in slot
   * order from `fromSlot`. The host splices these into the arm's own per-slot
   * array so a pooled run can compare two arms exactly as a local one does —
   * see `pairedBetweenArms`.
   */
  readonly variantWonBySlot: readonly boolean[];
  /**
   * The watch's report per slot of THIS SLICE, in slot order — present only
   * when the run has a watch (`PairedArmsOptions.watchGames`).
   */
  readonly observedBySlot?: readonly (PairedGameObservation | null)[];
  /** Paired games the slice covered (played or provably skipped). */
  readonly gamesPlayed: number;
  /** Variant games actually run. */
  readonly variantGamesPlayed: number;
  /** Variant games answered for free by an identical base game. */
  readonly variantGamesSkipped: number;
  /**
   * Base games this slice had to play itself. Zero when the caller supplied every
   * base record it needed — which is the point of the base phase, so a non-zero
   * value here means the schedule under-supplied and double-counted work.
   */
  readonly baseGamesPlayed: number;
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
  /**
   * Play (or read from cache) the SHARED base game for one slot. The base phase
   * of a pooled run is exactly a loop over this, and the records it returns are
   * what let variant slices keep the identical-game skip.
   */
  readonly baseRecordAt: (slot: number) => PairedBaseRecord;
  /** Whether the identical-game skip is live for this run, and why not when not. */
  readonly identicalGameSkip: { readonly enabled: boolean; readonly reason?: string };
  /**
   * Play slots `[fromSlot, toSlot)` for one candidate swap and return THAT
   * slice's tally on its own — the handle-free, resumable-from-anywhere form
   * `advance` cannot offer, because a pooled run splits one arm's slots across
   * several workers and no worker sees the whole arm.
   */
  readonly playSlice: (
    swap: CardSwap,
    outName: string,
    inName: string,
    fromSlot: number,
    toSlot: number,
  ) => PairedSlice;
  /**
   * Open an arm for a caller-built variant deck (§3.175 manabases) — the same
   * arm as `openArm` gives a swap, with the same shared base games, the same
   * identical-game skip over however many slots differ, and the same verdict.
   * Throws if the deck is illegal or not the base deck's length.
   */
  readonly openVariantArm: (spec: VariantArmSpec) => ArmHandle;
  /** `playSlice` for a caller-built variant deck. */
  readonly playVariantSlice: (spec: VariantArmSpec, fromSlot: number, toSlot: number) => PairedSlice;
}


/**
 * COMPARE TWO CANDIDATES AGAINST EACH OTHER, FROM GAMES ALREADY PLAYED (§3.97).
 *
 * ⚠️ WHY THIS IS FREE, AND WHY IT MATTERS. Every arm of a run plays the SAME
 * slots from the SAME seeds: slot i is the same opponent, the same game index and
 * the same shared base game for all of them. So "did A win slot i?" and "did B win
 * slot i?" are two answers about ONE game, and cross-tabulating them is a proper
 * paired comparison of A against B — with no extra games played.
 *
 * The 2x2 `paired` tally cannot give this. It has already summed each arm against
 * the BASE and discarded the slot, so two arms that both beat the base by 10% are
 * indistinguishable in it whether they win the same games or opposite ones. That
 * loss is exactly why §3.96 had to decline the 27% saving it found: `suggest`
 * ranks candidates, and "decided against the base" says nothing about "better than
 * the runner-up".
 *
 * The returned table reads A as the "base" side and B as the "variant" side, so
 * `mcNemarTest` on it answers "does B differ from A?" — `variantOnly` is B's
 * advantage, `baseOnly` is A's.
 *
 * ⚠️ COMPARED OVER THE COMMON PREFIX ONLY. Arms can sit at different depths (a
 * leader advances while an eliminated rival stopped), and slots past the shallower
 * arm's depth have no outcome for it. Counting those as losses would invent games
 * that were never played, so the comparison ends where the shorter arm ends.
 */
export function pairedBetweenArms(
  a: Pick<SwapArm, 'variantWonBySlot' | 'gamesPlayed'>,
  b: Pick<SwapArm, 'variantWonBySlot' | 'gamesPlayed'>,
): PairedTable {
  const depth = Math.min(a.gamesPlayed, b.gamesPlayed, a.variantWonBySlot.length, b.variantWonBySlot.length);
  // Built through the mutable tally shape, returned as the readonly table.
  const table: PairedTally = { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 };
  for (let slot = 0; slot < depth; slot++) {
    const aWon = a.variantWonBySlot[slot] === true;
    const bWon = b.variantWonBySlot[slot] === true;
    if (aWon && bWon) table.bothWon++;
    else if (aWon) table.baseOnly++;
    else if (bWon) table.variantOnly++;
    else table.neither++;
  }
  return table;
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

    // Somebody else already played this slot (the pool's base phase): adopt it
    // verbatim rather than replaying the game. This is base-arm reuse extended
    // across workers, and it is why a pooled run plays exactly as many base
    // games as the single-threaded one.
    const supplied = options.baseRecords?.(slotIndex);
    if (supplied) {
      const adopted = fromWireRecord(supplied);
      baseRecords.set(slotIndex, adopted);
      return adopted;
    }

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

    // The run's game watch, if any, sees the same events the library observer
    // does — composed here so neither seam knows about the other.
    const watch = options.watchGames?.();
    const watchEvents = watch?.onEvent;
    const onEvent =
      observer && watchEvents
        ? (event: GameEvent): void => {
            observer(event);
            watchEvents(event);
          }
        : (observer ?? watchEvents);
    const result = runMatch(baseSeats(slot.opponentIndex), seedForSlot(slot), {
      ...matchOptionsFor(slot),
      ...(onEvent ? { onEvent } : {}),
      ...(watch?.onState ? { onState: watch.onState } : {}),
    });
    baseGamesPlayed++;
    options.onGame?.(1);

    const record: BaseGameRecord = {
      heroWon: result.outcome.kind === 'win' && result.outcome.winner === HERO_SEAT,
      ...(leftLibrary ? { leftLibrary } : {}),
      libraryDisturbed,
      ...(watch ? { observed: watch.finish(result) } : {}),
    };
    baseRecords.set(slotIndex, record);
    return record;
  }

  const arms = new Map<ArmHandle, ArmState>();
  /** Arm state for the handle-free `playSlice` path, reused across slices. */
  const sliceArms = new Map<string, ArmState>();

  /** Build the per-arm state (variant deck, seats, swapped slots) for a swap. */
  function newArmState(swap: CardSwap, outName: string, inName: string): ArmState {
    const variantDeck = applySwap(baseDeck, swap, options.pool, swapScope);
    return armStateFor(variantDeck, swap, outName, inName, copiesSwappedBy(baseDeck, swap, options.pool, swapScope));
  }

  /**
   * The per-arm state for a caller-built variant deck (§3.175). A deck of another
   * length is refused outright: the seed-shares-the-permutation argument every
   * paired number rests on needs equal lengths, and a silently unpaired arm would
   * report a verdict with none of the variance reduction the verdict assumes.
   */
  function variantArmState(spec: VariantArmSpec): ArmState {
    const size = spec.variantDeck.cards.reduce((sum, entry) => sum + entry.count, 0);
    if (size !== baseLoaded.size) {
      throw new Error(
        `variant "${spec.label}" has ${size} cards but the base deck has ${baseLoaded.size} — ` +
          'a paired arm must be the base deck rewritten in place',
      );
    }
    return armStateFor(
      spec.variantDeck,
      { out: VARIANT_ARM_BASE_REF, in: spec.key },
      baseDeck.name,
      spec.label,
      spec.slotsChanged,
    );
  }

  /** The ONE constructor behind both arm kinds, so they can never differ in shape. */
  function armStateFor(variantDeck: Deck, swap: CardSwap, outName: string, inName: string, copiesMoved: number): ArmState {
    const variantLoaded = loadDeck(variantDeck, options.pool, rules);
    return {
      swap,
      outName,
      inName,
      variantDeck,
      variantLoaded,
      copiesMoved,
      seatsByOpponent: new Array(opponentCount).fill(undefined),
      swappedInstanceIds: trackLibrary
        ? swappedInstanceIdsFor(baseLoaded.library, variantLoaded.library)
        : undefined,
      gamesPlayed: 0,
      variantGamesSkipped: 0,
      variantWonBySlot: [],
      observedBySlot: [],
      tally: { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 },
    };
  }

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
      // A copy: the caller may hold the arm across further advances.
      variantWonBySlot: [...state.variantWonBySlot],
      ...(options.watchGames ? { observedBySlot: [...state.observedBySlot] } : {}),
    };
  }

  return {
    slotCapacity: (gamesPerMatchup) => gamesPerMatchup * opponentCount,

    openArm(swap, outName, inName) {
      const handle = {} as ArmHandle;
      arms.set(handle, newArmState(swap, outName, inName));
      return handle;
    },

    openVariantArm(spec) {
      const handle = {} as ArmHandle;
      arms.set(handle, variantArmState(spec));
      return handle;
    },

    advance(handle, targetGames) {
      const state = stateOf(handle);
      for (let slotIndex = state.gamesPlayed; slotIndex < targetGames; slotIndex++) {
        tallySlot(state.tally, state, slotIndex);
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
        scope: swapScope,
        copiesSwapped: state.copiesMoved,
      });
    },

    baseRecordAt: (slot) => toWireRecord(baseRecordFor(slot)),

    identicalGameSkip: skipDecision,

    playSlice(swap, outName, inName, fromSlot, toSlot) {
      const key = `${swap.out}>${swap.in}`;
      let state = sliceArms.get(key);
      if (!state) {
        state = newArmState(swap, outName, inName);
        sliceArms.set(key, state);
      }
      return playSliceOf(state, fromSlot, toSlot);
    },

    playVariantSlice(spec, fromSlot, toSlot) {
      // Its own key space, so a variant can never collide with a swap's `out>in`.
      const key = `variant:${spec.key}`;
      let state = sliceArms.get(key);
      if (!state) {
        state = variantArmState(spec);
        sliceArms.set(key, state);
      }
      return playSliceOf(state, fromSlot, toSlot);
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

  /** Slots `[fromSlot, toSlot)` for one arm state — the body both slice kinds share. */
  function playSliceOf(state: ArmState, fromSlot: number, toSlot: number): PairedSlice {
    const tally: PairedTally = { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 };
    const basedBefore = baseGamesPlayed;
    const playedBefore = variantGamesPlayed;
    const skippedBefore = variantGamesSkipped;
    for (let slotIndex = Math.max(0, fromSlot); slotIndex < toSlot; slotIndex++) {
      tallySlot(tally, state, slotIndex);
    }
    const from = Math.max(0, fromSlot);
    return {
      paired: tally,
      // Slot order from `from`, so the host can splice it straight in.
      variantWonBySlot: state.variantWonBySlot.slice(from, toSlot),
      ...(options.watchGames ? { observedBySlot: state.observedBySlot.slice(from, toSlot) } : {}),
      gamesPlayed: Math.max(0, toSlot - from),
      variantGamesPlayed: variantGamesPlayed - playedBefore,
      variantGamesSkipped: variantGamesSkipped - skippedBefore,
      baseGamesPlayed: baseGamesPlayed - basedBefore,
    };
  }

  /**
   * Play one slot for an arm and fold the paired outcome into `tally`. The one
   * place a (base, variant) pair becomes a 2×2 cell, shared by the handle-based
   * `advance` and the handle-free `playSlice` so the two can never disagree.
   */
  function tallySlot(tally: PairedTally, state: ArmState, slotIndex: number): void {
    const slot = pairedSlotAt(slotIndex, opponentCount);
    const base = baseRecordFor(slotIndex);
    const variant = playVariantGame(state, slot, base);
    state.variantWonBySlot[slotIndex] = variant.heroWon;
    if (options.watchGames) state.observedBySlot[slotIndex] = variant.observed ?? null;
    if (base.heroWon && variant.heroWon) tally.bothWon++;
    else if (base.heroWon) tally.baseOnly++;
    else if (variant.heroWon) tally.variantOnly++;
    else tally.neither++;
  }

  /**
   * Play (or provably skip) one variant game; returns whether the hero won it
   * and what the watch saw. A skipped game IS the base game, so it inherits the
   * base record's observation.
   */
  function playVariantGame(
    state: ArmState,
    slot: PairedSlot,
    base: BaseGameRecord,
  ): { readonly heroWon: boolean; readonly observed?: PairedGameObservation } {
    if (canReuseBaseGame(state, base)) {
      state.variantGamesSkipped++;
      variantGamesSkipped++;
      return { heroWon: base.heroWon, ...(base.observed ? { observed: base.observed } : {}) };
    }
    let seats = state.seatsByOpponent[slot.opponentIndex];
    if (!seats) {
      seats = makeSeats(state.variantLoaded, opponents[slot.opponentIndex] as LoadedDeck, options.pilots, options.registry);
      state.seatsByOpponent[slot.opponentIndex] = seats;
    }
    const watch = options.watchGames?.();
    const result = runMatch(seats, seedForSlot(slot), {
      ...matchOptionsFor(slot),
      ...(watch?.onEvent ? { onEvent: watch.onEvent } : {}),
      ...(watch?.onState ? { onState: watch.onState } : {}),
    });
    variantGamesPlayed++;
    options.onGame?.(1);
    return {
      heroWon: result.outcome.kind === 'win' && result.outcome.winner === HERO_SEAT,
      ...(watch ? { observed: watch.finish(result) } : {}),
    };
  }
}

/** Internal record → wire form (a `Set` cannot survive `postMessage`). */
function toWireRecord(record: BaseGameRecord): PairedBaseRecord {
  return {
    heroWon: record.heroWon,
    leftLibrary: record.leftLibrary ? [...record.leftLibrary] : null,
    libraryDisturbed: record.libraryDisturbed,
    ...(record.observed ? { observed: record.observed } : {}),
  };
}

/** Wire form → internal record. */
function fromWireRecord(record: PairedBaseRecord): BaseGameRecord {
  return {
    heroWon: record.heroWon,
    ...(record.leftLibrary ? { leftLibrary: new Set(record.leftLibrary) } : {}),
    libraryDisturbed: record.libraryDisturbed,
    ...(record.observed ? { observed: record.observed } : {}),
  };
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

/**
 * Every effect a card can run, wherever it is authored.
 *
 * "Wherever" is load-bearing: an effect this scan cannot see is one the
 * identical-game argument silently assumes does not read the library. CYCLING is
 * the newest such place and the sharpest example — a landcycling card's ability
 * IS a `searchLibrary`, reading the very library the paired arms differ in, and
 * it is authored on `def.cycling` rather than on `def.effects`.
 */
function allEffectRefs(def: CardDefinition): readonly EffectRef[] {
  const refs: EffectRef[] = [...(def.effects ?? [])];
  for (const trigger of def.triggers ?? []) refs.push(...trigger.effects);
  for (const ability of def.activated ?? []) refs.push(...ability.effects);
  for (const ability of def.cycling ?? []) refs.push(...ability.effects);
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

  // A COPY effect (CR 707) detaches a permanent's abilities from its decklist
  // row, which is the map `peekCouldReadHeroLibrary` reasons through. See
  // `ABILITY_ACQUIRING_DEFINITION_FIELDS` for why this is withdrawn wholesale
  // rather than handled per instance.
  for (const deck of [baseLoaded, ...opponents]) {
    const copier = deck.library.find((def) => acquiresForeignAbilities(def));
    if (copier) {
      return {
        enabled: false,
        reason:
          `"${copier.name}" can enter as a COPY of another permanent, so its abilities are not the ones ` +
          'its decklist row prints and a library read through them would be invisible to the skip',
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
