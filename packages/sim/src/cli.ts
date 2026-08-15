#!/usr/bin/env node
/**
 * `npm run sim` — the headless gauntlet / A-B card-swap lab CLI (DESIGN §3.5).
 *
 * Subcommands:
 *   decks                                   list bundled sample decks
 *   match <deckA> <deckB> [opts]            n games A vs B, win-rate + CI
 *   gauntlet <deck> [opts]                  deck vs every sample deck
 *   swap <deck> --out X --in Y [opts]       the paired A/B single-card-swap verdict
 *   suggest <deck> [opts]                   rank candidate swaps that improve the deck
 *
 * Common options: --games N, --seed S, --pilot <id> (heuristic|random).
 * Decks and cards are accepted by NAME or id. The CLI is robust: a bad arg or an
 * unknown deck/card prints a clear one-line error and exits non-zero — never a
 * raw stack trace. `--help` (and no args) prints usage.
 *
 * Determinism + throughput: every run is seeded; the CLI reports observed
 * games/sec (DESIGN §1.6 — instrument the hot path).
 */

import { performance } from 'node:perf_hooks';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import type { CardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID, SELECTABLE_PILOT_IDS } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import type { EffectRegistry } from '@jonny-boi/core';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import type { Deck, LoadedDeck } from './deck.js';
import { loadDeck, DeckLoadError } from './deck.js';
import { makeSeats, runMatchup, type MatchupPilots, type MatchupResult } from './matchup.js';
import { runGauntlet, type GauntletResult } from './gauntlet.js';
import { evaluateSwap, type SwapEvaluation } from './swap.js';
import { suggestSwaps, type SuggestionReport } from './suggest.js';
import type { SuggestionHistory } from './suggest-history.js';
import { DEFAULT_SUGGEST_CONFIG } from './suggest-config.js';
import { DEFAULT_SIM_CONFIG, DEFAULT_STATS_CONFIG, DEFAULT_SWAP_SCOPE, FIDELITY_CAVEAT, type SwapScope } from './config.js';
import type { ProportionCI } from './stats.js';

const PROGRAM = 'jonny-boi sim';
const DEFAULT_SEED = 0xc0ffee;

const USAGE = `${PROGRAM} — headless MTG gauntlet / A-B card-swap lab

Usage:
  npm run sim -- decks
  npm run sim -- match <deckA> <deckB> [--games N] [--seed S] [--pilot mcts|heuristic|random]
  npm run sim -- gauntlet <deck> [--games N] [--seed S] [--pilot mcts|heuristic|random]
  npm run sim -- swap <deck> --out "<card>" --in "<card>" [--games N] [--seed S] [--pilot id] [--scope one|playset]
  npm run sim -- suggest <deck> [--games N] [--cut "<card>"] [--max-candidates K] [--seed S]
                               [--pilot id] [--history <file>] [--no-adaptive]

Notes:
  • Decks and cards may be given by NAME (quote names with spaces) or by id.
  • --pilot defaults to "${DEFAULT_PILOT_ID}", the look-ahead pilot: it searches real
    engine rollouts per decision, so it plays far better but is MUCH slower than
    "heuristic". Use --pilot heuristic for large runs where throughput matters.
  • --games N is games per matchup (default ${DEFAULT_SIM_CONFIG.defaultGames}).
  • swap --scope controls HOW MANY copies move (default "${DEFAULT_SWAP_SCOPE}"):
      playset — replace every copy: "does this card belong in the deck at all?"
      one     — replace a single copy: "is the last copy earning its slot?"
    They answer different questions; "one" is a much smaller effect and needs far
    more games before it can clear significance.
  • suggest searches ADAPTIVELY: every candidate gets a cheap scout batch, then the
    budget concentrates on the ones still plausibly better and clear losers are
    dropped early, so only finalists are played to full depth. Verdicts are
    corrected for multiple comparisons (testing many cards at once otherwise
    manufactures ~1 false "better" in 20).
  • suggest: --cut may repeat to focus the cards considered for cutting; omit for
    auto mode (a scout roster of ${DEFAULT_SUGGEST_CONFIG.maxCandidates} by a cheap color/curve heuristic).
    --max-candidates K sets that roster size (default ${DEFAULT_SUGGEST_CONFIG.maxCandidates}).
    --games N is the depth a FINALIST reaches (default ${DEFAULT_SUGGEST_CONFIG.defaultGamesPerCandidate}), not what everyone gets.
  • --history <file> makes the search PROGRESSIVE: it reads what earlier runs
    already covered, skips settled losers, spends the budget on untried candidates,
    and writes the updated record back. Without it, every run re-tests the same
    shortlist and prints the same answer.
  • --no-adaptive runs the legacy fixed-budget sweep (every candidate, same games)
    for comparison.
  • Fidelity (DESIGN §3.9, done): the engine models triggered abilities & "until
    end of turn" effects. A few advanced mechanics remain unimplemented (transform/
    DFC, dynamic P/T, planeswalker loyalty, flash/flashback) — cards using them play
    as a simplified subset. The statistics are exact.`;

/** A parsed flag bag. */
interface Flags {
  readonly positionals: readonly string[];
  readonly games?: number;
  readonly seed?: number;
  readonly pilot?: string;
  /** Swap one copy or the whole playset (A/B test). */
  readonly scope?: SwapScope;
  readonly out?: string;
  readonly in?: string;
  /** suggest: cards to focus the cut on (repeatable). Empty = auto mode. */
  readonly cut: readonly string[];
  /** suggest: cap on candidate swaps simulated. */
  readonly maxCandidates?: number;
  /** suggest: file the cross-run search record is read from and written back to. */
  readonly history?: string;
  /** suggest: use the legacy fixed-budget sweep instead of the adaptive search. */
  readonly noAdaptive: boolean;
  readonly help: boolean;
}

/** A thrown CLI error carries an exit-worthy message (no stack shown). */
class CliError extends Error {}

function parseFlags(args: readonly string[]): Flags {
  const positionals: string[] = [];
  let games: number | undefined;
  let seed: number | undefined;
  let pilot: string | undefined;
  let scope: SwapScope | undefined;
  let out: string | undefined;
  let inCard: string | undefined;
  const cut: string[] = [];
  let maxCandidates: number | undefined;
  let history: string | undefined;
  let noAdaptive = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--games':
        games = parseIntFlag(arg, args[++i]);
        break;
      case '--seed':
        seed = parseIntFlag(arg, args[++i]);
        break;
      case '--pilot':
        pilot = requireValue(arg, args[++i]);
        break;
      case '--scope': {
        const value = requireValue(arg, args[++i]);
        if (value !== 'one' && value !== 'playset') {
          throw new CliError(`option "--scope" must be "one" or "playset", got "${value}"`);
        }
        scope = value;
        break;
      }
      case '--out':
        out = requireValue(arg, args[++i]);
        break;
      case '--in':
        inCard = requireValue(arg, args[++i]);
        break;
      case '--cut':
        cut.push(requireValue(arg, args[++i]));
        break;
      case '--max-candidates':
        maxCandidates = parseIntFlag(arg, args[++i]);
        break;
      case '--history':
        history = requireValue(arg, args[++i]);
        break;
      case '--no-adaptive':
        noAdaptive = true;
        break;
      default:
        if (arg.startsWith('--')) throw new CliError(`unknown option "${arg}"`);
        positionals.push(arg);
    }
  }

  return { positionals, games, seed, pilot, scope, out, in: inCard, cut, maxCandidates, history, noAdaptive, help };
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new CliError(`option "${flag}" needs a value`);
  return value;
}

function parseIntFlag(flag: string, value: string | undefined): number {
  const raw = requireValue(flag, value);
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new CliError(`option "${flag}" needs an integer, got "${raw}"`);
  return n;
}

// --- shared resolution ---------------------------------------------------------

interface Lab {
  readonly pool: CardPool;
  readonly registry: EffectRegistry;
}

function makeLab(): Lab {
  // Silence pool validation warnings on the CLI (the pool is healthy; stubbed
  // mechanics are an intentional, documented condition — not CLI noise).
  const pool = loadCardPool({ onWarn: () => {} });
  const registry = buildRegistry();
  return { pool, registry };
}

/** Resolve a deck selector (name or id-ish) against the sample decks. */
function resolveDeck(selector: string): Deck {
  const byName = SAMPLE_DECKS.find((d) => d.name.toLowerCase() === selector.toLowerCase());
  if (byName) return byName;
  // Allow a loose contains-match for convenience (e.g. "red" → Mono-Red Aggro).
  const matches = SAMPLE_DECKS.filter((d) => d.name.toLowerCase().includes(selector.toLowerCase()));
  if (matches.length === 1) return matches[0] as Deck;
  if (matches.length > 1) {
    throw new CliError(
      `deck "${selector}" is ambiguous — matches: ${matches.map((d) => `"${d.name}"`).join(', ')}`,
    );
  }
  throw new CliError(
    `unknown deck "${selector}". Available: ${SAMPLE_DECKS.map((d) => `"${d.name}"`).join(', ')}`,
  );
}

function loadOrThrow(deck: Deck, pool: CardPool): LoadedDeck {
  try {
    return loadDeck(deck, pool);
  } catch (err) {
    if (err instanceof DeckLoadError) throw new CliError(err.message);
    throw err;
  }
}

function resolvePilots(flags: Flags): MatchupPilots {
  const id = flags.pilot ?? DEFAULT_PILOT_ID;
  const registry = createDefaultAiRegistry();
  const known = new Set(SELECTABLE_PILOT_IDS);
  if (!known.has(id)) {
    throw new CliError(`unknown pilot "${id}". Available: ${[...known].map((p) => `"${p}"`).join(', ')}`);
  }
  const pilotA = registry.getPilot(id);
  const pilotB = registry.getPilot(id);
  if (!pilotA || !pilotB) throw new CliError(`could not instantiate pilot "${id}"`);
  return { pilotA: pilotA as Pilot, pilotB: pilotB as Pilot };
}

// --- formatting ----------------------------------------------------------------

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function ciStr(ci: ProportionCI): string {
  return `${pct(ci.p)} (${pct(ci.low)}–${pct(ci.high)})`;
}

/** Render a simple left-aligned table from a header + rows. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: readonly string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i] as number)).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(header), sep, ...rows.map(fmt)].join('\n');
}

// The fidelity note printed under every subcommand's output. One shared wording
// (DESIGN §1: no duplicated strings) sourced from the sim config.
const FIDELITY_NOTE = FIDELITY_CAVEAT;

// --- subcommands ---------------------------------------------------------------

function cmdDecks(): number {
  const lab = makeLab();
  const rows = SAMPLE_DECKS.map((d) => {
    const problems = (() => {
      try {
        const loaded = loadDeck(d, lab.pool);
        return `${loaded.size} cards`;
      } catch (err) {
        return err instanceof DeckLoadError ? 'INVALID' : 'ERROR';
      }
    })();
    return [d.name, d.archetype, problems];
  });
  console.log(table(['Deck', 'Archetype', 'Size'], rows));
  return 0;
}

function cmdMatch(flags: Flags): number {
  const [a, b] = flags.positionals;
  if (!a || !b) throw new CliError('match needs two decks: match <deckA> <deckB>');
  const lab = makeLab();
  const deckA = loadOrThrow(resolveDeck(a), lab.pool);
  const deckB = loadOrThrow(resolveDeck(b), lab.pool);
  const pilots = resolvePilots(flags);
  const games = flags.games ?? DEFAULT_SIM_CONFIG.defaultGames;
  const seed = flags.seed ?? DEFAULT_SEED;

  const seats = makeSeats(deckA, deckB, pilots, lab.registry);
  const start = performance.now();
  const result: MatchupResult = runMatchup(seats, games, seed);
  const elapsed = (performance.now() - start) / 1000;

  console.log(`Matchup: "${deckA.name}" (A) vs "${deckB.name}" (B) — ${games} games, seed ${seed}`);
  console.log(
    table(
      ['Deck', 'Wins', 'Win rate (95% CI)'],
      [
        [deckA.name, String(result.winsA), ciStr(result.winRateA)],
        [deckB.name, String(result.winsB), `${result.winsB}/${games}`],
      ],
    ),
  );
  if (result.draws > 0) console.log(`Timeout draws: ${result.draws}`);
  console.log(`\n${games} games in ${elapsed.toFixed(2)}s → ${(games / elapsed).toFixed(0)} games/sec`);
  console.log(FIDELITY_NOTE);
  return 0;
}

function cmdGauntlet(flags: Flags): number {
  const [heroSel] = flags.positionals;
  if (!heroSel) throw new CliError('gauntlet needs a deck: gauntlet <deck>');
  const lab = makeLab();
  const heroDeck = resolveDeck(heroSel);
  const hero = loadOrThrow(heroDeck, lab.pool);
  const pilots = resolvePilots(flags);
  const games = flags.games ?? DEFAULT_SIM_CONFIG.defaultGames;
  const seed = flags.seed ?? DEFAULT_SEED;

  // The gauntlet is every sample deck except the hero itself.
  const gauntletDecks = SAMPLE_DECKS.filter((d) => d.name !== heroDeck.name).map((d) =>
    loadOrThrow(d, lab.pool),
  );

  const start = performance.now();
  const result: GauntletResult = runGauntlet(hero, gauntletDecks, pilots, games, seed, lab.registry);
  const elapsed = (performance.now() - start) / 1000;

  console.log(`Gauntlet: "${hero.name}" vs ${gauntletDecks.length} decks — ${games} games each, seed ${seed}\n`);
  console.log(
    table(
      ['Opponent', 'Wins', 'Win rate (95% CI)'],
      result.matchups.map((m) => [m.deckB, `${m.winsA}/${m.games}`, ciStr(m.winRateA)]),
    ),
  );
  console.log(
    `\nOverall: ${result.totalWins}/${result.totalGames} = ${ciStr(result.overallWinRate)}` +
      (result.totalDraws > 0 ? `  (${result.totalDraws} timeout draws)` : ''),
  );
  console.log(`${result.totalGames} games in ${elapsed.toFixed(2)}s → ${(result.totalGames / elapsed).toFixed(0)} games/sec`);
  console.log(FIDELITY_NOTE);
  return 0;
}

function cmdSwap(flags: Flags): number {
  const [heroSel] = flags.positionals;
  if (!heroSel) throw new CliError('swap needs a deck: swap <deck> --out X --in Y');
  if (!flags.out || !flags.in) throw new CliError('swap needs --out <card> and --in <card>');
  const lab = makeLab();
  const baseDeck = resolveDeck(heroSel);
  const pilots = resolvePilots(flags);
  const games = flags.games ?? DEFAULT_SIM_CONFIG.defaultGames;
  const seed = flags.seed ?? DEFAULT_SEED;

  const gauntletDecks = SAMPLE_DECKS.filter((d) => d.name !== baseDeck.name).map((d) =>
    loadOrThrow(d, lab.pool),
  );

  let evaluation: SwapEvaluation;
  const start = performance.now();
  try {
    evaluation = evaluateSwap(
      baseDeck,
      { out: flags.out, in: flags.in },
      gauntletDecks,
      pilots,
      games,
      seed,
      lab.pool,
      lab.registry,
      { swapScope: flags.scope },
    );
  } catch (err) {
    if (err instanceof DeckLoadError) throw new CliError(err.message);
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  const elapsed = (performance.now() - start) / 1000;
  // Each paired game plays the base AND the variant → twice nGames matches.
  const matchesPlayed = evaluation.nGames * 2;

  console.log(`A/B swap on "${evaluation.baseDeck}": −${evaluation.outName} +${evaluation.inName}`);
  console.log(`Gauntlet of ${gauntletDecks.length} decks, ${games} games each (${evaluation.nGames} paired games), seed ${seed}\n`);
  console.log(
    table(
      ['Deck', 'Win rate (95% CI)'],
      [
        ['Base', ciStr(evaluation.baseWinRate)],
        ['Variant', ciStr(evaluation.variantWinRate)],
      ],
    ),
  );
  const sign = evaluation.delta >= 0 ? '+' : '';
  console.log(`\nDelta (variant − base): ${sign}${pct(evaluation.delta)}`);
  console.log(
    `Paired games — both win: ${evaluation.paired.bothWon}, base only: ${evaluation.paired.baseOnly}, ` +
      `variant only: ${evaluation.paired.variantOnly}, neither: ${evaluation.paired.neither}`,
  );
  console.log(`McNemar p-value: ${evaluation.pValue.toExponential(2)} (discordant pairs: ${evaluation.mcNemar.discordant})`);
  console.log(`\nVERDICT: the swap is ${evaluation.verdict.toUpperCase()} (alpha ${DEFAULT_STATS_CONFIG.alpha}, n=${evaluation.nGames})`);
  console.log(`\n${matchesPlayed} matches in ${elapsed.toFixed(2)}s → ${(matchesPlayed / elapsed).toFixed(0)} games/sec`);
  console.log(FIDELITY_NOTE);
  return 0;
}

function cmdSuggest(flags: Flags): number {
  const [heroSel] = flags.positionals;
  if (!heroSel) throw new CliError('suggest needs a deck: suggest <deck> [--cut "<card>"] [--max-candidates K]');
  const lab = makeLab();
  const baseDeck = resolveDeck(heroSel);
  const pilots = resolvePilots(flags);
  const games = flags.games ?? DEFAULT_SUGGEST_CONFIG.defaultGamesPerCandidate;
  const maxCandidates = flags.maxCandidates ?? DEFAULT_SUGGEST_CONFIG.maxCandidates;
  if (maxCandidates < 1) throw new CliError('--max-candidates must be at least 1');
  const seed = flags.seed ?? DEFAULT_SEED;

  const gauntletDecks = SAMPLE_DECKS.filter((d) => d.name !== baseDeck.name).map((d) =>
    loadOrThrow(d, lab.pool),
  );

  const priorHistory = flags.history ? readHistoryFile(flags.history) : undefined;

  let report: SuggestionReport;
  try {
    report = suggestSwaps(baseDeck, {
      gauntletDecks,
      pilots,
      pool: lab.pool,
      registry: lab.registry,
      baseSeed: seed,
      gamesPerCandidate: games,
      suggestConfig: { ...DEFAULT_SUGGEST_CONFIG, maxCandidates },
      cutOnly: flags.cut.length > 0 ? flags.cut : undefined,
      adaptive: !flags.noAdaptive,
      ...(priorHistory ? { history: priorHistory } : {}),
    });
  } catch (err) {
    if (err instanceof DeckLoadError) throw new CliError(err.message);
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const n = report.notes;
  const mode = flags.noAdaptive ? 'fixed-budget' : 'adaptive';
  console.log(
    `Suggestions for "${report.baseDeck}" vs ${gauntletDecks.length} decks — ` +
      `${mode} search, up to ${games} games/matchup, seed ${seed}`,
  );
  console.log(
    `Run #${(n.runIndex ?? 0) + 1} for this deck` +
      (priorHistory ? ` (continuing a search that already covered ${priorHistory.candidates.length} candidates)` : '') +
      (n.historyRejected ? ` — supplied history IGNORED (${n.historyRejected})` : ''),
  );
  console.log(`Base gauntlet win rate: ${ciStr(report.baseGauntletWinRate)}\n`);

  if (report.suggestions.length === 0) {
    console.log('No candidate swaps were evaluated (none legal, all settled, or all capped).');
  } else {
    console.log(
      table(
        ['#', 'Out → In', 'Games', 'Base%', 'Variant%', 'Delta', 'p (raw)', 'p (adj)', 'Verdict', 'Note'],
        report.suggestions.map((s) => {
          const e = s.evaluation;
          const sign = e.delta >= 0 ? '+' : '';
          return [
            String(s.rank),
            `${s.outName} → ${s.inName}`,
            String(s.gamesPlayed ?? s.evaluation.nGames),
            pct(e.baseWinRate.p),
            pct(e.variantWinRate.p),
            `${sign}${pct(e.delta)}`,
            (s.rawPValue ?? e.pValue).toExponential(2),
            (s.adjustedPValue ?? e.pValue).toExponential(2),
            e.verdict.toUpperCase(),
            s.elimination ? `dropped w${s.elimination.wave}: ${s.elimination.reason}` : 'full depth',
          ];
        }),
      ),
    );
  }

  // The waves: what each one played, dropped and pulled in. No silent scheduling.
  const waves = report.waves ?? [];
  if (waves.length > 0) {
    console.log('\nSearch waves (successive halving — budget concentrates on survivors):');
    console.log(
      table(
        ['Wave', 'Games/cand', 'Played', 'Survived', 'Dropped', 'New leads'],
        waves.map((w) => [
          String(w.wave),
          String(w.cumulativeGames),
          String(w.candidatesPlayed),
          String(w.survivors),
          String(w.eliminated.length),
          w.offspring.length > 0 ? w.offspring.join('; ') : '-',
        ]),
      ),
    );
    const futile = waves.flatMap((w) => w.eliminated).filter((e) => e.reason === 'futile');
    for (const e of futile.slice(0, MAX_FUTILITY_LINES_PRINTED)) {
      console.log(`  dropped early: ${e.outName} → ${e.inName} — ${e.detail}`);
    }
    if (futile.length > MAX_FUTILITY_LINES_PRINTED) {
      console.log(`  …and ${futile.length - MAX_FUTILITY_LINES_PRINTED} more dropped by the futility rule.`);
    }
  }

  const mc = report.multipleComparisons;
  if (mc)
    console.log(
    `\nMultiple comparisons: ${mc.method} correction over a family of ${mc.familySize} ` +
      `(${mc.testedThisRun} tested this run` +
      (mc.familySize > mc.testedThisRun ? `, ${mc.familySize - mc.testedThisRun} from previous runs` : '') +
      `). ${mc.demotedByCorrection} verdict(s) demoted to INCONCLUSIVE by the correction.`,
  );

  console.log(
    `\nEvaluated ${report.candidatesEvaluated} of ${n.candidatesGenerated} candidates` +
      (n.cappedByBudget ? ` (roster capped at ${maxCandidates})` : ''),
  );
  if (report.skipped.length > 0) {
    const counts = { illegal: 0, capped: 0, settled: 0 };
    for (const s of report.skipped) counts[s.reason]++;
    const parts: string[] = [];
    if (counts.capped > 0) parts.push(`${counts.capped} never tried (budget)`);
    if (counts.settled > 0) parts.push(`${counts.settled} settled by earlier runs`);
    if (counts.illegal > 0) parts.push(`${counts.illegal} skipped (illegal variant)`);
    console.log(`Coverage: ${parts.join(', ')}.`);
  }

  const gps = n.gamesPerSecond;
  console.log(
    `${n.totalGamesRun} games (${n.baseGamesPlayed ?? 0} base + ${n.variantGamesPlayed ?? 0} variant)` +
      (n.elapsedSeconds ? ` in ${n.elapsedSeconds.toFixed(2)}s → ${gps ? gps.toFixed(0) : '?'} games/sec` : ''),
  );
  console.log(
    `Saved ${n.gamesAvoided ?? 0} games vs a fixed sweep of the same candidates at the same depths` +
      ((n.variantGamesSkipped ?? 0) > 0
        ? `; ${n.variantGamesSkipped} variant games were provably identical to the base game and were not replayed`
        : '') +
      (n.identicalGameSkipEnabled ? '' : ` (identical-game skip off: ${n.identicalGameSkipDisabledReason ?? 'n/a'})`) +
      '.',
  );

  if (flags.history && report.history) {
    writeHistoryFile(flags.history, report.history);
    console.log(
      `Search record written to ${flags.history} (${report.history.candidates.length} candidates known). ` +
        'Pass --history again to continue exploring instead of repeating this run.',
    );
  }
  console.log(FIDELITY_NOTE);
  return 0;
}

/** Futility lines printed before the rest are summarised — output stays readable. */
const MAX_FUTILITY_LINES_PRINTED = 5;

/**
 * Read a previously-written search record. A missing file is the normal "first
 * run" case, and a corrupt one degrades to "no history" with a warning rather than
 * killing a long run (CLAUDE.md rule 6).
 */
function readHistoryFile(path: string): SuggestionHistory | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SuggestionHistory;
  } catch (err) {
    console.warn(`warning: could not read history "${path}" (${err instanceof Error ? err.message : String(err)}); starting fresh`);
    return undefined;
  }
}

/** Persist the record for the next run. */
function writeHistoryFile(path: string, history: SuggestionHistory): void {
  writeFileSync(path, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

// --- entry ---------------------------------------------------------------------

function run(argv: readonly string[]): number {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.log(USAGE);
    return 0;
  }
  const [command, ...rest] = args;
  const flags = parseFlags(rest);
  if (flags.help || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case 'decks':
      return cmdDecks();
    case 'match':
      return cmdMatch(flags);
    case 'gauntlet':
      return cmdGauntlet(flags);
    case 'swap':
      return cmdSwap(flags);
    case 'suggest':
      return cmdSuggest(flags);
    default:
      throw new CliError(`unknown command "${command}". Run with --help for usage.`);
  }
}

function main(): number {
  try {
    return run(process.argv);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    // Unexpected: surface a one-line message, not a raw stack dump.
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exit(main());


