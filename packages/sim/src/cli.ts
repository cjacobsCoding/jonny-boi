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
import { DEFAULT_SUGGEST_CONFIG } from './suggest-config.js';
import { DEFAULT_SIM_CONFIG, DEFAULT_STATS_CONFIG, FIDELITY_CAVEAT } from './config.js';
import type { ProportionCI } from './stats.js';

const PROGRAM = 'jonny-boi sim';
const DEFAULT_SEED = 0xc0ffee;

const USAGE = `${PROGRAM} — headless MTG gauntlet / A-B card-swap lab

Usage:
  npm run sim -- decks
  npm run sim -- match <deckA> <deckB> [--games N] [--seed S] [--pilot mcts|heuristic|random]
  npm run sim -- gauntlet <deck> [--games N] [--seed S] [--pilot mcts|heuristic|random]
  npm run sim -- swap <deck> --out "<card>" --in "<card>" [--games N] [--seed S] [--pilot id]
  npm run sim -- suggest <deck> [--games N] [--cut "<card>"] [--max-candidates K] [--seed S] [--pilot id]

Notes:
  • Decks and cards may be given by NAME (quote names with spaces) or by id.
  • --pilot defaults to "${DEFAULT_PILOT_ID}", the look-ahead pilot: it searches real
    engine rollouts per decision, so it plays far better but is MUCH slower than
    "heuristic". Use --pilot heuristic for large runs where throughput matters.
  • --games N is games per matchup (default ${DEFAULT_SIM_CONFIG.defaultGames}).
  • suggest: --cut may repeat to focus the cards considered for cutting; omit for
    auto mode (top ${DEFAULT_SUGGEST_CONFIG.maxCandidates} candidates by a cheap color/curve heuristic).
    --max-candidates K caps how many swaps are simulated (default ${DEFAULT_SUGGEST_CONFIG.maxCandidates}).
    Per-candidate games default to ${DEFAULT_SUGGEST_CONFIG.defaultGamesPerCandidate} for suggest.
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
  readonly out?: string;
  readonly in?: string;
  /** suggest: cards to focus the cut on (repeatable). Empty = auto mode. */
  readonly cut: readonly string[];
  /** suggest: cap on candidate swaps simulated. */
  readonly maxCandidates?: number;
  readonly help: boolean;
}

/** A thrown CLI error carries an exit-worthy message (no stack shown). */
class CliError extends Error {}

function parseFlags(args: readonly string[]): Flags {
  const positionals: string[] = [];
  let games: number | undefined;
  let seed: number | undefined;
  let pilot: string | undefined;
  let out: string | undefined;
  let inCard: string | undefined;
  const cut: string[] = [];
  let maxCandidates: number | undefined;
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
      default:
        if (arg.startsWith('--')) throw new CliError(`unknown option "${arg}"`);
        positionals.push(arg);
    }
  }

  return { positionals, games, seed, pilot, out, in: inCard, cut, maxCandidates, help };
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
    });
  } catch (err) {
    if (err instanceof DeckLoadError) throw new CliError(err.message);
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  console.log(
    `Suggestions for "${report.baseDeck}" vs ${gauntletDecks.length} decks — ` +
      `${games} games/candidate, seed ${seed}`,
  );
  console.log(`Base gauntlet win rate: ${ciStr(report.baseGauntletWinRate)}\n`);

  if (report.suggestions.length === 0) {
    console.log('No candidate swaps were evaluated (none legal, or all capped).');
  } else {
    console.log(
      table(
        ['#', 'Out → In', 'Base%', 'Variant%', 'Delta', 'p-value', 'Verdict'],
        report.suggestions.map((s) => {
          const e = s.evaluation;
          const sign = e.delta >= 0 ? '+' : '';
          return [
            String(s.rank),
            `${s.outName} → ${s.inName}`,
            pct(e.baseWinRate.p),
            pct(e.variantWinRate.p),
            `${sign}${pct(e.delta)}`,
            e.pValue.toExponential(2),
            e.verdict.toUpperCase(),
          ];
        }),
      ),
    );
  }

  const n = report.notes;
  console.log(
    `\nEvaluated ${report.candidatesEvaluated} of ${n.candidatesGenerated} candidates` +
      (n.cappedByBudget ? ` (capped at ${maxCandidates})` : ''),
  );
  if (report.skipped.length > 0) {
    const illegal = report.skipped.filter((s) => s.reason === 'illegal').length;
    const capped = report.skipped.filter((s) => s.reason === 'capped').length;
    const parts: string[] = [];
    if (capped > 0) parts.push(`${capped} capped for budget`);
    if (illegal > 0) parts.push(`${illegal} skipped (illegal variant)`);
    console.log(`Coverage: ${parts.join(', ')}.`);
  }
  const gps = n.gamesPerSecond;
  console.log(
    `${n.totalGamesRun} games` +
      (n.elapsedSeconds ? ` in ${n.elapsedSeconds.toFixed(2)}s → ${gps ? gps.toFixed(0) : '?'} games/sec` : ''),
  );
  console.log(FIDELITY_NOTE);
  return 0;
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
