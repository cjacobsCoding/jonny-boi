/**
 * THE A/B SINGLE-CARD-SWAP TEST (DESIGN §3.5) — the product's core promise.
 *
 * Build a variant deck by swapping ONE card (remove one `out`, add one `in`), run
 * BOTH the base deck and the variant against the SAME gauntlet using IDENTICAL
 * seeds per game — *common random numbers*. Because every paired game shares the
 * opponent, the on-the-play assignment, and the game seed, the only systematic
 * difference between the two runs is the swapped card. That pairing slashes
 * variance: instead of comparing two noisy independent win-rates, we look at the
 * games where base and variant *disagreed* and ask whether that disagreement is
 * lopsided enough to be real. We answer with **McNemar's paired test**.
 *
 * Honesty about fidelity (DESIGN §3.9, done): a card reaches the pool only if
 * the Oracle-text compiler reported it COMPLETE, so nothing being swapped plays
 * as a simplified subset — see `FIDELITY_CAVEAT`, the one wording every surface
 * prints. (This comment used to list flashback-granted-by-another-card and
 * cast-time modes as missing, years after both landed; the caveat's own
 * authority, `STUBBED_MECHANICS`, has been empty for as long.) The swap
 * machinery and statistics are exact.
 */

import type { EffectRegistry, PlayerId, CardDefinition } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck, LoadedDeck } from './deck.js';
import { loadDeck } from './deck.js';
import type { MatchupPilots, RunOptions } from './matchup.js';
import { gameSeedFor, makeSeats, onPlayFor, resolveRunRange } from './matchup.js';
import { runMatch } from './match.js';
import {
  copiesForScope,
  DEFAULT_DECK_RULES,
  DEFAULT_STATS_CONFIG,
  DEFAULT_SWAP_SCOPE,
  type StatsConfig,
  type SwapScope,
} from './config.js';
import {
  mcNemarTest,
  wilsonInterval,
  type McNemarResult,
  type PairedTable,
  type ProportionCI,
} from './stats.js';

/**
 * Games actually played per PAIRED game: the base arm's and the variant arm's.
 * Named because every progress denominator in the product depends on it.
 */
export const GAMES_PER_PAIRED_GAME = 2;

/** The single-card swap to evaluate: one card out, one card in (id or name). */
export interface CardSwap {
  readonly out: string;
  readonly in: string;
}

/**
 * THE "IN" OF A CUT — a swap that adds NOTHING (DESIGN §3.174, the Lab's trim).
 *
 * A removal is a swap whose in-card does not exist, and the whole paired A/B
 * machinery — the arm runner, the slice shards, the wave ladder, the Holm
 * correction — is written over `CardSwap`. Rather than widen every one of those
 * types to `in: string | null`, the in-card of a cut is this one NAMED value,
 * and `applySwap` (the one place a variant deck is built) is the one place it
 * is interpreted. Every other consumer keeps treating `in` as an opaque string:
 * candidate keys stay `out>in`, arm caches stay keyed the same way, and nothing
 * resolves it against the pool (no card is named this, and no Scryfall id is).
 *
 * The identical-game skip switches itself off for a cut by construction — the
 * variant library is shorter, so `swappedInstanceIdsFor` returns `undefined`
 * and every variant game is replayed. Which is also the honest cost of the
 * question: the engine shuffles a 62-card library into a different permutation
 * than a 63-card one under the same seed (one fewer Fisher–Yates draw, and the
 * opponent's shuffle shifts with it), so a cut arm keeps the unbiased pairing
 * (same opponent, same seed, same player on the play) but not the matched-shuffle
 * variance reduction a swap enjoys. McNemar remains valid — it tests the
 * marginal win rates — it simply needs more games for the same confidence.
 */
export const SWAP_IN_NOTHING = '(nothing)';

/**
 * Separates the ids of a MULTI-CARD cut in `CardSwap.out` — the trim's
 * nonland+land PAIRS (§3.174). A pair is one arm (one variant deck, one paired
 * table), so it has to travel as one `CardSwap`; `out` carries every card to
 * cut, joined by this. Never a character a card name or a Scryfall id contains.
 * Decoded in exactly one place (`cutOutRefs`), read by the two functions below.
 */
export const CUT_OUT_SEPARATOR = '|';

/** Is this swap a CUT — one or more cards out, nothing in? */
export function isCut(swap: CardSwap): boolean {
  return swap.in === SWAP_IN_NOTHING;
}

/** The card refs a cut removes, in the order they were named. */
export function cutOutRefs(swap: CardSwap): readonly string[] {
  return swap.out.split(CUT_OUT_SEPARATOR).filter((ref) => ref.length > 0);
}

/** The 'better' / 'worse' / 'inconclusive' call. */
export type SwapVerdict = 'better' | 'worse' | 'inconclusive';

/** The full verdict the lab returns for a swap. */
export interface SwapEvaluation {
  readonly baseDeck: string;
  readonly variantDeck: string;
  readonly swap: CardSwap;
  /** Human-readable names of the resolved out/in cards. */
  readonly outName: string;
  readonly inName: string;
  /** Base deck's gauntlet win-rate + CI. */
  readonly baseWinRate: ProportionCI;
  /** Variant deck's gauntlet win-rate + CI. */
  readonly variantWinRate: ProportionCI;
  /** variant − base, in win-rate proportion ([-1, 1]). */
  readonly delta: number;
  /** Wilson CI for the variant's win proportion (the headline interval). */
  readonly ci: ProportionCI;
  /** McNemar p-value on the paired discordant games. */
  readonly pValue: number;
  /** The full paired 2x2 table (for display / the inspector). */
  readonly paired: PairedTable;
  /** The McNemar detail. */
  readonly mcNemar: McNemarResult;
  /** The verdict. */
  readonly verdict: SwapVerdict;
  /** Paired games actually played (per opponent × games). */
  readonly nGames: number;
  /** Whether one copy or the whole playset was swapped. */
  readonly scope: SwapScope;
  /** How many copies actually moved — 1, or the out card's full count. */
  readonly copiesSwapped: number;
}


/**
 * Construct the variant `Deck` by applying a single-card swap to a base `Deck`.
 * Resolves `out`/`in` by id OR name against the pool so the CLI can accept either.
 * Throws a clear `Error` (caught upstream) when `out` isn't in the deck or a card
 * id is unknown — never a silent miss.
 *
 * **The swap replaces the out card IN PLACE**, and that positioning is load-bearing
 * for the whole paired A/B test, not cosmetic tidiness. `loadDeck` expands entries
 * in order into the flat library, and the engine shuffles that library with a
 * Fisher–Yates driven purely by the game seed: for two libraries of equal length
 * the same seed produces the same *permutation*, so a variant library that differs
 * from the base in exactly ONE slot yields a shuffled deck that also differs in
 * exactly one slot. That is the common-random-numbers property the McNemar test
 * lives on.
 *
 * Removing the out copy and appending the in copy at the END (as this once did)
 * shifts every card after the cut by one position, so the two arms draw completely
 * different games. The comparison stays unbiased but the variance reduction — the
 * entire reason a single-card swap is detectable in hundreds rather than tens of
 * thousands of games — evaporates. Worse, a self-swap of a 1-of card removed the
 * entry and re-appended it, moving it to the end of the decklist, so "swap a card
 * for itself" produced a non-zero delta: the lab's own sanity check, broken.
 */
export function applySwap(
  base: Deck,
  swap: CardSwap,
  pool: CardPool,
  scope: SwapScope = DEFAULT_SWAP_SCOPE,
): Deck {
  // §3.174 — a CUT is a swap whose in-card is nothing. Same funnel, same entry
  // point, so an arm runner that only knows `applySwap` builds a removal too.
  if (isCut(swap)) return applyCut(base, swap, pool, scope);
  const outDef = resolve(pool, swap.out);
  const inDef = resolve(pool, swap.in);
  if (!outDef) throw new Error(`swap "out" card not found in pool: "${swap.out}"`);
  if (!inDef) throw new Error(`swap "in" card not found in pool: "${swap.in}"`);

  // Find the deck entry holding the out card (match on the resolved id).
  const entries = base.cards.map((e) => ({ ...e }));
  const outIdx = entries.findIndex((e) => entryMatches(e, outDef, pool));
  if (outIdx < 0) throw new Error(`"${outDef.name}" is not in deck "${base.name}" — nothing to swap out`);

  const outEntry = entries[outIdx];
  if (outEntry === undefined) throw new Error(`"${outDef.name}" is not in deck "${base.name}"`);

  // §3.136 — ONE path for every scope. `copiesForScope` decides how many copies
  // move (the whole line, a single copy, or an asked-for count clamped into the
  // line), and the rewrite below is the same shape it always was:
  //
  //  - the whole line: EVERY copy becomes the in card, in the same entry at the
  //    same index with the same count, so the expanded library differs at exactly
  //    those slots and nowhere else — the cleanest common-random-numbers pairing;
  //  - fewer than the whole line: the line is shortened and an in-card line sits
  //    immediately after it, which expands to the base library with exactly those
  //    slots rewritten. (`loadDeck` totals copies per card across entries, so the
  //    4-of rule still catches an in card already maxed elsewhere.)
  const copies = copiesForScope(outEntry.count, scope);
  if (copies >= outEntry.count) {
    entries.splice(outIdx, 1, { cardId: inDef.id, count: outEntry.count });
  } else {
    entries.splice(
      outIdx,
      1,
      { ...outEntry, count: outEntry.count - copies },
      { cardId: inDef.id, count: copies },
    );
  }

  return {
    // The name records HOW MANY copies moved, so a result is never ambiguous
    // about what was actually tested.
    name: `${base.name} (−${copies}× ${outDef.name} +${copies}× ${inDef.name})`,
    archetype: base.archetype,
    cards: entries,
  };
}

/**
 * Build the variant of a CUT: remove `copiesForScope` copies of every card the
 * swap names, and add nothing (§3.174).
 *
 * The line is shortened IN PLACE (and dropped when it reaches zero) so the
 * decklist stays readable after repeated cuts. Unlike `applySwap`'s replace-in-
 * place, positioning buys no pairing here — a shorter library shuffles into a
 * different permutation whatever order its entries are in (see
 * `SWAP_IN_NOTHING`) — so this is tidiness, not a statistical property.
 *
 * Throws, exactly as the swap path does, when a named card is not in the pool or
 * not in the deck: a cut of a card the deck does not hold is a caller bug, never
 * a silent no-op that would make base and variant identical.
 */
function applyCut(base: Deck, swap: CardSwap, pool: CardPool, scope: SwapScope): Deck {
  const refs = cutOutRefs(swap);
  if (refs.length === 0) throw new Error(`cut names no card to remove (out: "${swap.out}")`);
  const entries = base.cards.map((e) => ({ ...e }));
  const removed: string[] = [];
  for (const ref of refs) {
    const outDef = resolve(pool, ref);
    if (!outDef) throw new Error(`cut card not found in pool: "${ref}"`);
    const outIdx = entries.findIndex((e) => entryMatches(e, outDef, pool));
    if (outIdx < 0) throw new Error(`"${outDef.name}" is not in deck "${base.name}" — nothing to cut`);
    const outEntry = entries[outIdx] as Deck['cards'][number];
    const copies = copiesForScope(outEntry.count, scope);
    if (copies >= outEntry.count) entries.splice(outIdx, 1);
    else entries[outIdx] = { ...outEntry, count: outEntry.count - copies };
    removed.push(`−${copies}× ${outDef.name}`);
  }
  return {
    // The name records what left, so a result is never ambiguous about what
    // was actually tested — the same contract as a swap's name.
    name: `${base.name} (${removed.join(' ')})`,
    archetype: base.archetype,
    cards: entries,
  };
}

function resolve(pool: CardPool, ref: string): CardDefinition | undefined {
  return pool.get(ref) ?? pool.getByName(ref);
}

function entryMatches(entry: { cardId: string }, def: CardDefinition, pool: CardPool): boolean {
  const resolved = resolve(pool, entry.cardId);
  return resolved?.id === def.id;
}


/**
 * How many copies applying `swap` to `base` would actually move.
 *
 * The one place this is decided, so `applySwap` (which does the moving),
 * `evaluateSwap` (which reports it) and the suggestion engine's candidate
 * generator (which stamps it on every candidate so a pooled run can describe a
 * result without the card pool at hand) can never disagree. Reads the FIRST
 * decklist line holding the out card — the same line `applySwap` rewrites — and
 * degrades to 1 for an unresolvable card rather than throwing.
 */
export function copiesSwappedBy(
  base: Deck,
  swap: CardSwap,
  pool: CardPool,
  scope: SwapScope = DEFAULT_SWAP_SCOPE,
): number {
  // §3.174 — a cut moves `copiesForScope` of EVERY card it names (a pair: two).
  if (isCut(swap)) {
    let total = 0;
    for (const ref of cutOutRefs(swap)) {
      const def = resolve(pool, ref);
      const line = def ? base.cards.find((entry) => entryMatches(entry, def, pool)) : undefined;
      total += copiesForScope(line?.count ?? 1, scope);
    }
    return Math.max(1, total);
  }
  const outDef = resolve(pool, swap.out);
  if (!outDef) return 1;
  const line = base.cards.find((entry) => entryMatches(entry, outDef, pool));
  return copiesForScope(line?.count ?? 1, scope);
}

/**
 * Run the paired A/B swap evaluation.
 *
 * For each gauntlet opponent and each game index we compute one shared game seed
 * and one shared on-the-play assignment, then play the base hero AND the variant
 * hero against that opponent under those identical conditions. The two outcomes
 * form a paired observation. We tally the 2x2 paired table across all games and
 * run McNemar's test; the verdict is 'better'/'worse' only when p < alpha AND we
 * have at least `minGamesForVerdict` games, else 'inconclusive'.
 *
 * Sanity property: swapping a card for ITSELF yields a variant identical to the
 * base, so every paired game agrees, the discordant count is 0, p = 1, delta = 0
 * → 'inconclusive'. A great unbiasedness check (and a test).
 *
 * ### Running only a slice
 * `opts.range` restricts the run to some opponents and some game indices — one
 * shard of a parallel evaluation. Because both the per-game seed and the
 * on-the-play alternation are functions of the ABSOLUTE (opponent, game) indices,
 * a slice plays byte-identical games to that stretch of the whole evaluation, and
 * summing the slices' paired 2×2 tables reconstructs the whole run's table
 * exactly (integer addition — order cannot matter). That is the seam the web
 * Lab's worker pool runs on, so it never has to restate this loop.
 */
export function evaluateSwap(
  baseDeck: Deck,
  swap: CardSwap,
  gauntletDecks: readonly LoadedDeck[],
  pilots: MatchupPilots,
  gamesPerMatchup: number,
  baseSeed: number,
  pool: CardPool,
  registry: EffectRegistry,
  opts: RunOptions & {
    /** Ticked with the games played so far, so a long slice can report progress. */
    readonly onGame?: (games: number) => void;
  } = {},
): SwapEvaluation {
  const stats = opts.stats ?? DEFAULT_STATS_CONFIG;
  const scope: SwapScope = opts.swapScope ?? DEFAULT_SWAP_SCOPE;
  const slice = resolveRunRange(opts.range, gauntletDecks.length, gamesPerMatchup);

  const variantDeck = applySwap(baseDeck, swap, pool, scope);
  // Load under the CALLER's legality rules. Falling back to the defaults here would
  // reject a variant the caller's own rules (and its candidate generator) called
  // legal — the suggestion engine would then report every candidate as illegal.
  const deckRules = opts.deckRules ?? DEFAULT_DECK_RULES;
  const baseLoaded = loadDeck(baseDeck, pool, deckRules);
  const variantLoaded = loadDeck(variantDeck, pool, deckRules);

  const outDef = resolve(pool, swap.out);
  const inDef = resolve(pool, swap.in);

  // How many copies actually moved, reported so a result is self-describing.
  const copiesSwapped = copiesSwappedBy(baseDeck, swap, pool, scope);


  // Paired 2x2 table accumulators (a "win" here = the hero won; timeout = no win).
  // The two arms' win counts and the game count are the table's margins, so the
  // table alone is a sufficient statistic — `summarizePairedSwap` derives them.
  let bothWon = 0;
  let baseOnly = 0;
  let variantOnly = 0;
  let neither = 0;

  for (let opp = slice.opponentStart; opp < slice.opponentEnd; opp++) {
    const opponent = gauntletDecks[opp] as LoadedDeck;
    const matchupSeed = gameSeedFor(baseSeed, opp);
    const baseSeats = makeSeats(baseLoaded, opponent, pilots, registry);
    const variantSeats = makeSeats(variantLoaded, opponent, pilots, registry);

    for (let g = slice.gameStart; g < slice.gameEnd; g++) {
      const seed = gameSeedFor(matchupSeed, g);
      const startingPlayer: PlayerId = onPlayFor(g);
      const matchOpts = { config: opts.config, sim: opts.sim, startingPlayer };

      const baseResult = runMatch(baseSeats, seed, matchOpts);
      const variantResult = runMatch(variantSeats, seed, matchOpts);

      const baseWon = baseResult.outcome.kind === 'win' && baseResult.outcome.winner === 'A';
      const variantWon = variantResult.outcome.kind === 'win' && variantResult.outcome.winner === 'A';

      if (baseWon && variantWon) bothWon++;
      else if (baseWon && !variantWon) baseOnly++;
      else if (!baseWon && variantWon) variantOnly++;
      else neither++;
      // Two games are actually played per pair — tick both, so a progress bar
      // built from this cannot claim a run is half done at a quarter of the work.
      opts.onGame?.(GAMES_PER_PAIRED_GAME);
    }
  }

  return summarizePairedSwap({
    baseDeckName: baseDeck.name,
    variantDeckName: variantDeck.name,
    swap,
    outName: outDef?.name ?? swap.out,
    inName: inDef?.name ?? swap.in,
    paired: { bothWon, baseOnly, variantOnly, neither },
    stats,
    scope,
    copiesSwapped,
  });
}

/** Everything `summarizePairedSwap` needs beyond the paired 2x2 table itself. */
export interface PairedSwapSummaryInput {
  readonly baseDeckName: string;
  readonly variantDeckName: string;
  readonly swap: CardSwap;
  readonly outName: string;
  readonly inName: string;
  /** The paired 2x2 table accumulated over the games actually played. */
  readonly paired: PairedTable;
  readonly stats?: StatsConfig;
  /** How many copies the swap moved — one, or the whole playset. */
  readonly scope?: SwapScope;
  /** The copy count that scope worked out to, so a result self-describes. */
  readonly copiesSwapped?: number;
}

/**
 * Turn a paired 2x2 table into the full `SwapEvaluation` — win-rates, Wilson CIs,
 * McNemar, delta and verdict.
 *
 * This is the ONE place the verdict is computed, shared by the fixed-budget
 * `evaluateSwap` above and the adaptive suggestion engine's wave scheduler
 * (`paired-arms.ts`), so the two paths can never drift into computing a verdict
 * two subtly different ways. The table's margins ARE the two arms' win counts —
 * base won `bothWon + baseOnly`, the variant won `bothWon + variantOnly`, over
 * `bothWon + baseOnly + variantOnly + neither` paired games — so no extra
 * bookkeeping is needed to reconstruct them (a timeout draw is a non-win for both
 * and lands in `neither`, exactly as the loop counts it).
 */
export function summarizePairedSwap(input: PairedSwapSummaryInput): SwapEvaluation {
  const stats = input.stats ?? DEFAULT_STATS_CONFIG;
  const paired = input.paired;
  const n = paired.bothWon + paired.baseOnly + paired.variantOnly + paired.neither;
  const baseWins = paired.bothWon + paired.baseOnly;
  const variantWins = paired.bothWon + paired.variantOnly;

  const mcNemar = mcNemarTest(paired);
  const baseWinRate = wilsonInterval(baseWins, n, stats.z);
  const variantWinRate = wilsonInterval(variantWins, n, stats.z);
  const delta = variantWinRate.p - baseWinRate.p;
  const verdict = decideVerdict(delta, mcNemar.pValue, n, stats.alpha, stats.minGamesForVerdict);

  return {
    baseDeck: input.baseDeckName,
    variantDeck: input.variantDeckName,
    swap: input.swap,
    outName: input.outName,
    inName: input.inName,
    baseWinRate,
    variantWinRate,
    delta,
    ci: variantWinRate,
    pValue: mcNemar.pValue,
    paired,
    mcNemar,
    verdict,
    nGames: n,
    scope: input.scope ?? DEFAULT_SWAP_SCOPE,
    copiesSwapped: input.copiesSwapped ?? 1,
  };
}

/**
 * Decide the verdict from the paired test. We require BOTH statistical
 * significance (p < alpha) AND a minimum sample before claiming better/worse; the
 * sign of the win-rate delta picks the direction. Otherwise 'inconclusive' — the
 * honest default the product never overclaims past.
 */
export function decideVerdict(
  delta: number,
  pValue: number,
  nGames: number,
  alpha: number,
  minGames: number,
): SwapVerdict {
  if (nGames < minGames) return 'inconclusive';
  if (pValue >= alpha) return 'inconclusive';
  if (delta > 0) return 'better';
  if (delta < 0) return 'worse';
  return 'inconclusive';
}
