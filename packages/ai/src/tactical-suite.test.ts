import { describe, expect, it } from 'vitest';
import { createHeuristicPilot } from './heuristic.js';
import { createHybridPilot } from './hybrid.js';
import { DEFAULT_HYBRID_CONFIG, TACTICAL_HYBRID_CONFIG } from './hybrid-config.js';
import { DEFAULT_EVALUATION_WEIGHTS, evaluatePosition, TACTICAL_EVALUATION_WEIGHTS } from './evaluator.js';
import {
  EVALUATION_PUZZLES,
  runEvaluationSuite,
  runTacticalSuite,
  TACTICAL_PUZZLES,
  type TacticalSuiteReport,
} from './tactical-suite.js';

/**
 * THE CURATED TACTICAL SUITE, run against every pilot (brief §48).
 *
 * The value of these numbers is comparative. A pilot's win rate over 120 games
 * carries a ±9-point interval; a change that fixes one blunder class and breaks
 * another moves it by nothing. Here a regression names itself — "lethal 4/4 → 2/4"
 * — which is the whole reason the brief asks for this alongside the win rate.
 *
 * The heuristic is scored too, deliberately. It is the shipped default pilot, and
 * the suite is only trustworthy if the puzzles are hard enough that a good pilot
 * can miss some. A suite everything passes measures nothing.
 */

const pilots = [
  { label: 'heuristic', make: () => createHeuristicPilot() },
  { label: 'hybrid (default)', make: () => createHybridPilot(DEFAULT_HYBRID_CONFIG) },
  { label: 'hybrid (tactical)', make: () => createHybridPilot(TACTICAL_HYBRID_CONFIG) },
];

const reports = new Map<string, TacticalSuiteReport>(
  pilots.map((p) => [p.label, runTacticalSuite(p.make())] as const),
);

function report(label: string): TacticalSuiteReport {
  const found = reports.get(label);
  if (!found) throw new Error(`no report for ${label}`);
  return found;
}

function solvedIds(label: string): Set<string> {
  return new Set(
    report(label)
      .results.filter((r) => r.solved)
      .map((r) => r.puzzle.id),
  );
}

describe('curated tactical suite', () => {
  it('covers every category the brief names for this engine', () => {
    const categories = new Set(TACTICAL_PUZZLES.map((p) => p.category));
    // Counterspell / sacrifice / stack / bluff puzzles are NOT here and their
    // absence is deliberate rather than an oversight: the graded answer would be
    // "hold this card", which is indistinguishable from "did nothing" without an
    // opponent model the pilots do not have yet (brief §13-17).
    expect([...categories].sort()).toEqual([
      'anti-lethal',
      'combat',
      'lethal',
      'mana',
      'removal',
      'sequencing',
    ]);
  });

  it('every puzzle carries the reasoning that makes its answer right', () => {
    for (const puzzle of TACTICAL_PUZZLES) {
      expect(puzzle.question.length).toBeGreaterThan(0);
      expect(puzzle.why.length).toBeGreaterThan(0);
    }
  });

  it('is discriminating — it separates the pilots and no pilot sweeps it', () => {
    // Both properties matter and they are different. "Separates" means the suite
    // can see a difference in playing strength at all; "nobody sweeps" means it
    // still has headroom, so a future improvement has somewhere to show up. A
    // suite that everything passes has stopped being an instrument.
    for (const { label } of pilots) {
      expect(report(label).solved, `${label} solves everything — the suite needs harder puzzles`).toBeLessThan(
        report(label).total,
      );
    }
    expect(report('hybrid (tactical)').solved).toBeGreaterThan(report('heuristic').solved);
  });

  /**
   * A LIVE DEFECT THE SUITE FOUND, pinned as a failing-behaviour test rather than
   * silently tolerated.
   *
   * Every pilot — including the shipped `heuristic` default — plays the Mountain
   * instead of the Swamp and leaves its own removal spell uncastable for a turn.
   * The land-drop candidates in `heuristic.ts` score each land on its own merits
   * and never ask what the land UNLOCKS, so two lands of different colours are
   * indistinguishable to it.
   *
   * NOT fixed on this branch, deliberately: `collectPriorityCandidates` feeds the
   * DEFAULT pilot, so changing how it picks a land changes every recorded baseline
   * in DESIGN §3.4 and every A/B verdict measured against them. That is its own
   * branch with its own measurement. This assertion exists so the day someone
   * fixes it, this test fails and tells them they succeeded.
   */
  it('DEFECT (unfixed): no pilot plays the land its own spell needs', () => {
    for (const { label } of pilots) {
      const solved = solvedIds(label);
      expect(solved.has('sequencing/play-the-land-that-casts-the-spell'), `${label} now solves it — remove this test`).toBe(
        false,
      );
    }
  });

  /**
   * The tactical pilot must not LOSE a puzzle the pilot it replaces solved.
   *
   * Deliberately not "must solve strictly more": it does not, and pretending
   * otherwise would be the suite lying about its own subject. On boards this small
   * a 160-simulation search simply plays the position out and reaches the terminal
   * whatever its leaf evaluator believes, so both search arms land on the same
   * score and the only pilot these separate is the heuristic. **That is the
   * finding, and it is why the evaluator half below exists** — a pilot-level
   * puzzle cannot isolate a leaf evaluator on a board the search can solve
   * outright.
   */
  it('the tactical pilot loses none of the puzzles the default one solved', () => {
    const before = solvedIds('hybrid (default)');
    const after = solvedIds('hybrid (tactical)');
    const lost = [...before].filter((id) => !after.has(id));
    expect(lost, `puzzles the tactical evaluator STOPPED solving: ${lost.join(', ')}`).toEqual([]);
    expect(after.size).toBeGreaterThanOrEqual(before.size);
  });

  it('both search pilots beat the shipped heuristic default on these positions', () => {
    expect(report('hybrid (tactical)').solved).toBeGreaterThan(report('heuristic').solved);
  });

  it('sees the evasion and trample lethals', () => {
    const after = solvedIds('hybrid (tactical)');
    expect(after.has('lethal/evasion-is-the-whole-answer')).toBe(true);
    expect(after.has('combat/trample-still-gets-there')).toBe(true);
  });

  it('prints the pilot scoreboard so a failure is diagnosable from the log alone', () => {
    const lines: string[] = ['', 'curated tactical suite — solved / total'];
    for (const { label } of pilots) {
      const r = report(label);
      const perCategory = [...r.byCategory.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, c]) => `${category} ${c.solved}/${c.total}`)
        .join('  ');
      lines.push(`  ${label.padEnd(22)} ${r.solved}/${r.total}   ${perCategory}`);
      for (const result of r.results) {
        if (!result.solved) lines.push(`      MISS ${result.puzzle.id} — played ${result.played}`);
      }
    }
    console.log(lines.join('\n'));
    expect(reports.size).toBe(pilots.length);
  });
});

/**
 * The evaluator half — position PAIRS with a required ordering, graded against
 * `evaluateState` directly.
 *
 * This is where the tactical terms are actually measurable. Each pair is two
 * reachable successors of one decision, so "scores the better one higher" is
 * exactly the judgement a search backs up, isolated from whether the search
 * happened to reach a terminal.
 */
describe('curated tactical suite — evaluator ordering', () => {
  const before = runEvaluationSuite('default', (state, player) =>
    evaluatePosition(state, player, DEFAULT_EVALUATION_WEIGHTS),
  );
  const after = runEvaluationSuite('tactical', (state, player) =>
    evaluatePosition(state, player, TACTICAL_EVALUATION_WEIGHTS),
  );

  it('the tactical evaluator orders every curated pair correctly', () => {
    const wrong = after.results.filter((r) => !r.correct).map((r) => r.puzzle.id);
    expect(wrong, `mis-ordered pairs: ${wrong.join(', ')}`).toEqual([]);
    expect(after.correct).toBe(EVALUATION_PUZZLES.length);
  });

  /**
   * ⚠️ The SHIPPED DEFAULT gets every one of them wrong, and it still ships —
   * because "more correct" and "stronger" turned out to be different claims and
   * only the second one decides a default (DESIGN §3.4d). This test exists so the
   * cost of that decision is written down and visible rather than implied.
   */
  it('the DEFAULT evaluator gets all of them wrong — the known, measured cost of shipping it off', () => {
    expect(before.correct).toBe(0);
    expect(after.correct).toBe(EVALUATION_PUZZLES.length);
  });

  it('the default cannot tell three of the pairs apart AT ALL — identical scores', () => {
    const ties = before.results.filter((r) => r.betterScore === r.worseScore);
    expect(ties.map((r) => r.puzzle.id).sort()).toEqual([
      'eval/being-dead-on-board-must-cost-something',
      'eval/board-that-can-attack-beats-board-that-cannot',
      'eval/the-faster-clock-wins-the-long-game',
    ]);
  });

  it('the default scores taking a proven kill BELOW declining it — a sign error, not a blind spot', () => {
    const id = 'eval/declaring-the-kill-must-not-be-scored-below-declining-it';
    const defaultAnswer = before.results.find((r) => r.puzzle.id === id);
    expect(defaultAnswer?.correct).toBe(false);
    expect(defaultAnswer!.betterScore).toBeLessThan(defaultAnswer!.worseScore);
    expect(after.results.find((r) => r.puzzle.id === id)?.correct).toBe(true);
  });

  it('prints the ordering scoreboard', () => {
    const lines: string[] = ['', 'curated tactical suite — evaluator ordering'];
    for (const report of [before, after]) {
      lines.push(`  ${report.label.padEnd(14)} ${report.correct}/${report.total}`);
      for (const r of report.results) {
        if (r.correct) continue;
        lines.push(
          `      WRONG ${r.puzzle.id} — better=${r.betterScore.toFixed(4)} worse=${r.worseScore.toFixed(4)}`,
        );
      }
    }
    console.log(lines.join('\n'));
    expect(after.total).toBe(EVALUATION_PUZZLES.length);
  });
});
