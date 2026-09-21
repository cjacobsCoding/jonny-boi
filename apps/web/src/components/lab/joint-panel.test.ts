/**
 * THE JOINT TAB PUTS THE CONFOUND, THE BUDGET AND THE PATH ON A SCREEN (§3.177)
 * — pinned with a static render, the `manabase-panel.test.ts` idiom, because
 * "built, tested, never reaches a screen" is this repo's dominant UI failure and
 * nine of them were caught by a frame rather than by a test.
 *
 *  - before a run: the confound stated, the two partner rules offered as a
 *    choice, the budget sliders, and a start button that names the family;
 *  - after a phase: the land-count rollup with a PARTNERS TRIED column (the
 *    whole fix, visible), the move table, the on-the-edge row labelled as not
 *    accepted, and what the accept rule does NOT look at;
 *  - the claim: the panel prints `JOINT_HONEST_CLAIM` and never says a ratio is
 *    perfect.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  JOINT_CONFOUND_NOTE,
  JOINT_NOT_GATED_ON,
  JOINT_PARTNER_RULES,
  SAMPLE_DECKS,
  type JointMove,
  type JointPhaseReport,
  DEFAULT_STATS_CONFIG,
} from '@jonny-boi/sim';
import { JointPanel } from './JointPanel.js';
import {
  JOINT_AUTO_CONTINUE_DEFAULT,
  JOINT_BUDGET_GAMES,
  JOINT_BUDGET_SECONDS,
  JOINT_GAMES,
  JOINT_PARTNERS,
  JOINT_RADIUS,
} from '../../lib/lab-config.js';
import type { PanelProps } from './panel-types.js';

const SELESNYA_BLINK = SAMPLE_DECKS.find((d) => d.name === 'Selesnya Blink')!;

const ci = (p: number) => ({ p, low: Math.max(0, p - 0.1), high: Math.min(1, p + 0.1), successes: Math.round(p * 100), n: 100 });

const move = (label: string, partner: string, landCount: number): JointMove => ({
  key: `count:${landCount}:${partner}`,
  family: 'count',
  phase: 'manabase',
  label,
  note: 'land count · partner 1 of 4 for this count',
  steps: [{ outId: 'forest', outName: 'Forest', inId: partner.toLowerCase(), inName: partner, copies: 1 }],
  landCount,
  slotsChanged: 1,
  partner: { cardId: partner.toLowerCase(), name: partner, direction: 'added', copies: 1, fitScore: 3, fitRank: 1 },
});

const WINNER = move('23 lands (−1 Forest, +1 Llanowar Elves)', 'Llanowar Elves', 23);
const RUNNER_UP = move('23 lands (−1 Forest, +1 Grizzly Bears)', 'Grizzly Bears', 23);

/** §3.179 — the reason a verdict of each kind arrives with. */
const REASON_FOR = { better: 'significantGain', worse: 'significantLoss', inconclusive: 'notSignificant' } as const;

const evaluation = (label: string, delta: number, verdict: 'better' | 'worse' | 'inconclusive') =>
  ({
    baseDeck: 'Selesnya Blink',
    variantDeck: `Selesnya Blink — ${label}`,
    swap: { out: 'joint', in: label },
    outName: '24 lands, as built',
    inName: label,
    baseWinRate: ci(0.5),
    variantWinRate: ci(0.5 + delta),
    delta,
    ci: ci(0.5 + delta),
    pValue: 0.01,
    paired: { bothWon: 40, baseOnly: 10, variantOnly: 16, neither: 34 },
    mcNemar: { statistic: 1, pValue: 0.01, variantOnly: 16, baseOnly: 10, discordant: 26 },
    verdict,
    verdictReason: REASON_FOR[verdict],
    nGames: 100,
    scope: 'one',
    copiesSwapped: 1,
  }) as JointPhaseReport['rows'][number]['evaluation'];

const ROWS = [
  { rank: 1, key: 'joint>a', move: WINNER, evaluation: evaluation(WINNER.label, 0.06, 'better'), gamesPlayed: 100, rawPValue: 0.01, adjustedPValue: 0.02 },
  { rank: 2, key: 'joint>b', move: RUNNER_UP, evaluation: evaluation(RUNNER_UP.label, 0.01, 'inconclusive'), gamesPlayed: 60, rawPValue: 0.3, adjustedPValue: 0.6 },
] as JointPhaseReport['rows'];

const REPORT: JointPhaseReport = {
  deckName: 'Selesnya Blink',
  deckFingerprint: 'fp',
  phase: 'manabase',
  round: 0,
  deckSize: 60,
  base: { deckSize: 60, landCount: 24, lands: [], basics: [], pips: {}, colors: ['W', 'G'], description: '24 lands — 8 Forest, 8 Plains' },
  partnerRule: 'measured',
  verdict: 'improved',
  rows: ROWS,
  winner: ROWS[0],
  landCounts: [
    { landCount: 23, isBase: false, partnersTested: 4, best: ROWS[0], partners: ROWS, verdict: 'better', verdictReason: 'significantGain', delta: 0.06, note: 'best of 4 partners (Llanowar Elves); the count is attributed to the deck you would actually build at it' },
    { landCount: 24, isBase: true, partnersTested: 0, partners: [], verdict: 'base', delta: 0, note: 'the deck as built — 50.0% against this gauntlet' },
    { landCount: 25, isBase: false, partnersTested: 1, best: ROWS[1], partners: [ROWS[1]!], verdict: 'inconclusive', verdictReason: 'notSignificant', delta: 0.01, note: 'judged on ONE partner (Grizzly Bears) — the count and that one spell moved together, so this row cannot separate them' },
  ],
  baseWinRate: ci(0.5),
  movesEvaluated: 2,
  skipped: [{ family: 'type', label: 'land type sweep', reason: 'a one-colour deck has no dual to try' }],
  capped: [],
  failures: [],
  waves: [],
  multipleComparisons: {
    method: 'holm',
    familySize: 2,
    demotedByCorrection: 0,
    alpha: 0.05,
    note: 'Holm over the family',
  } as unknown as JointPhaseReport['multipleComparisons'],
  notes: {
    totalGamesRun: 1200,
    candidatesGenerated: 3,
    cappedByBudget: false,
    baseGamesPlayed: 400,
    variantGamesPlayed: 800,
    variantGamesSkipped: 0,
    gamesAvoided: 0,
    identicalGameSkipEnabled: true,
    runIndex: 0,
    fidelityCaveat: 'caveat',
    stats: DEFAULT_STATS_CONFIG,
  } as JointPhaseReport['notes'],
  gamesPlayed: 1200,
  elapsedSeconds: 12.5,
  confoundNote: JOINT_CONFOUND_NOTE,
  notGatedOn: JOINT_NOT_GATED_ON,
};

function render(overrides: Partial<PanelProps> = {}, simOverrides: Record<string, unknown> = {}): string {
  const props = {
    hero: SELESNYA_BLINK as unknown as PanelProps['hero'],
    heroPayload: SELESNYA_BLINK as unknown as PanelProps['heroPayload'],
    heroLegal: true,
    chosenOpponents: ['Mono-Red Aggro'],
    seed: 1,
    pilotId: 'heuristic',
    sim: {
      status: 'idle',
      result: null,
      progress: null,
      error: null,
      workerCount: 4,
      run: () => {},
      cancel: () => {},
      reset: () => {},
      ...simOverrides,
    },
    ...overrides,
  } as unknown as PanelProps;
  return renderToStaticMarkup(
    createElement(JointPanel, {
      ...props,
      gamesConfig: JOINT_GAMES,
      radiusConfig: JOINT_RADIUS,
      partnersConfig: JOINT_PARTNERS,
      budgetGamesConfig: JOINT_BUDGET_GAMES,
      budgetSecondsConfig: JOINT_BUDGET_SECONDS,
      autoContinueDefault: JOINT_AUTO_CONTINUE_DEFAULT,
      onApplyJointMove: () => {},
    } as never),
  );
}

const withReport = () =>
  render({}, { status: 'done', result: { kind: 'joint-phase', result: REPORT, pilotId: 'heuristic' } });

describe('the Joint tab, before a run', () => {
  it('states the confound and offers BOTH partner rules as a choice', () => {
    const html = render();
    expect(html).toContain('A land count cannot be changed by itself');
    for (const rule of JOINT_PARTNER_RULES) expect(html).toContain(rule.label.replace(/§/gu, '§'));
    expect(html).toContain('joint-partner-rule');
  });

  it('shows the budget sliders and the deck as built, and names the first family', () => {
    const html = render();
    expect(html).toContain('Budget — games');
    expect(html).toContain('Budget — seconds');
    expect(html).toContain('As built:');
    expect(html).toContain('Start the search');
    expect(html).toContain('manabase move');
  });

  it('prints the honest claim, and the only word "perfect" on the page is the disclaimer', () => {
    const html = render();
    expect(html).toContain('best deck this search FOUND');
    expect(html).toContain('not the perfect ratio and not a proven optimum');
    // Every occurrence of the word must be the one that DENIES it. A panel that
    // grew a "perfect ratio: 23 lands" headline would pass a `toContain` check
    // on the claim and fail this one, which is the point.
    const all = html.match(/perfect/gu) ?? [];
    const denied = html.match(/not the perfect ratio/gu) ?? [];
    expect(all.length).toBe(denied.length);
    expect(denied.length).toBeGreaterThan(0);
  });
});

describe('the Joint tab, after a phase', () => {
  it('rolls the land counts up with a PARTNERS TRIED column — the fix, on screen', () => {
    const html = withReport();
    expect(html).toContain('Land counts, each judged by its best partner spell');
    expect(html).toContain('Partners tried');
    expect(html).toContain('Llanowar Elves');
    expect(html).toContain('best of 4 partners');
    expect(html).toContain('as built');
  });

  it('says plainly when a count was judged on ONE partner', () => {
    const html = withReport();
    expect(html).toContain('judged on ONE partner');
    expect(html).toContain('cannot separate them');
  });

  it('lists every move with its corrected verdict, and marks the winner', () => {
    const html = withReport();
    expect(html).toContain('23 lands (−1 Forest, +1 Llanowar Elves)');
    expect(html).toContain('23 lands (−1 Forest, +1 Grizzly Bears)');
    expect(html).toContain('BETTER');
    expect(html).toContain('INCONCLUSIVE');
    expect(html).toContain('joint-table__winner');
  });

  it('reports what the accept rule does NOT look at, and what the deck cannot reach', () => {
    const html = withReport();
    for (const row of JOINT_NOT_GATED_ON) expect(html).toContain(row.label);
    expect(html).toContain('a one-colour deck has no dual to try');
    expect(html).toContain('1,200 games');
  });
});
