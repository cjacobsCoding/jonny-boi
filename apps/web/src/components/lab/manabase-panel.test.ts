/**
 * THE MANABASE TAB RENDERS BOTH AXES, THE RULE, AND THE HONEST GAPS (§3.175) —
 * pinned with a static render, the `swap-panel-pickers.test.ts` idiom, because
 * "built, tested, never reaches a screen" is this repo's dominant UI failure.
 *
 *  - before a run: the base manabase as built, the enumerated family (from the
 *    same generator the worker runs) and its skips, and a run button that names
 *    the count;
 *  - after a run: a table with a win-rate axis AND a reliability axis, the
 *    recommendation rule printed, mulligans declared NOT MEASURED with the
 *    reason, and an Apply button per row only when the hero can be edited.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SAMPLE_DECKS, MANABASE_RECOMMENDATION_RULE, RELIABILITY_NOT_MEASURED, type ManabaseReport } from '@jonny-boi/sim';

const SELESNYA_BLINK = SAMPLE_DECKS.find((d) => d.name === 'Selesnya Blink')!;
import { ManabasePanel } from './ManabasePanel.js';
import { MANABASE_GAMES, MANABASE_SWEEP_RADIUS } from '../../lib/lab-config.js';
import type { PanelProps } from './panel-types.js';

const ci = (p: number) => ({ p, low: Math.max(0, p - 0.1), high: Math.min(1, p + 0.1), successes: Math.round(p * 100), n: 100 });
const mean = (m: number) => ({ mean: m, low: m - 0.2, high: m + 0.2, n: 100 });

const VARIANT = {
  key: 'type:temple-garden',
  kind: 'type' as const,
  label: '4 Temple Garden for 2 Forest + 2 Plains',
  note: 'shockland — pay 2 life or enters tapped',
  steps: [
    { outId: 'forest', outName: 'Forest', inId: 'temple-garden', inName: 'Temple Garden', copies: 2 },
    { outId: 'plains', outName: 'Plains', inId: 'temple-garden', inName: 'Temple Garden', copies: 2 },
  ],
  landCount: 24,
  slotsChanged: 4,
  family: 'shock' as const,
};

const REPORT = {
  baseDeck: 'Selesnya Blink',
  base: { deckSize: 60, landCount: 24, lands: [], basics: [], pips: {}, colors: ['W', 'G'], description: '24 lands — …' },
  baseGauntletWinRate: ci(0.5),
  baseReliability: { games: 100, missedLandDrop: ci(0.2), heldLandGames: 1, colourScrew: ci(0.1), landsOnTurn4: mean(3.1) },
  results: [
    {
      rank: 1,
      variant: VARIANT,
      evaluation: {
        baseDeck: 'Selesnya Blink',
        variantDeck: 'Selesnya Blink — 4 Temple Garden for 2 Forest + 2 Plains',
        swap: { out: 'manabase', in: 'type:temple-garden' },
        outName: '24 lands (as built)',
        inName: VARIANT.label,
        baseWinRate: ci(0.5),
        variantWinRate: ci(0.56),
        delta: 0.06,
        ci: ci(0.56),
        pValue: 0.01,
        paired: { bothWon: 40, baseOnly: 10, variantOnly: 16, neither: 34 },
        mcNemar: { statistic: 1, pValue: 0.01, variantOnly: 16, baseOnly: 10, discordant: 26 },
        verdict: 'better',
        nGames: 100,
        scope: 'playset',
        copiesSwapped: 4,
      },
      gamesPlayed: 100,
      rawPValue: 0.01,
      adjustedPValue: 0.02,
      reliability: {
        base: { games: 100, missedLandDrop: ci(0.2), heldLandGames: 1, colourScrew: ci(0.1), landsOnTurn4: mean(3.1) },
        variant: { games: 100, missedLandDrop: ci(0.18), heldLandGames: 0, colourScrew: ci(0.04), landsOnTurn4: mean(3.2) },
        metrics: [
          { id: 'missedLandDrop', label: 'Missed a land drop (turns 2–4)', verdict: 'inconclusive', pValue: 0.5, nPaired: 100 },
          { id: 'colourScrew', label: 'Colour-screwed (turn 3+)', verdict: 'better', pValue: 0.01, nPaired: 100 },
          { id: 'landsOnTurn4', label: 'Lands at the start of turn 4', verdict: 'inconclusive', pValue: 0.4, nPaired: 100, meanDifference: mean(0.1) },
        ],
        notMeasured: RELIABILITY_NOT_MEASURED,
        notWorse: true,
      },
      qualifies: true,
      betterSomewhere: true,
    },
  ],
  recommended: null as unknown,
  recommendationRule: MANABASE_RECOMMENDATION_RULE,
  skipped: [{ kind: 'type', label: '4 Arctic Flats for 2 Forest + 2 Plains', reason: 'the deck already runs an equivalent land (Selesnya Guildgate)' }],
  capped: [],
  failures: [],
  waves: [{ wave: 1, cumulativeGames: 100, candidatesPlayed: 1, survivors: 1, eliminated: [], offspring: [] }],
  multipleComparisons: { method: 'holm', familySize: 1, testedThisRun: 1, demotedByCorrection: 0 },
  notes: {
    totalGamesRun: 200,
    candidatesGenerated: 1,
    cappedByBudget: false,
    baseGamesPlayed: 100,
    variantGamesPlayed: 100,
    variantGamesSkipped: 0,
    gamesAvoided: 0,
    identicalGameSkipEnabled: true,
    runIndex: 0,
    fidelityCaveat: 'caveat',
  },
  notMeasured: RELIABILITY_NOT_MEASURED,
} as unknown as ManabaseReport;
(REPORT as { recommended: unknown }).recommended = REPORT.results[0];

function markup(extra: Record<string, unknown> = {}, status: 'idle' | 'done' = 'idle'): string {
  const props = {
    hero: { id: 'd1', name: 'Selesnya Blink', cards: [], updatedAt: '' },
    heroPayload: SELESNYA_BLINK,
    heroLegal: true,
    chosenOpponents: ['Mono-Red Aggro'],
    seed: 1,
    pilotId: 'heuristic',
    sim: {
      status,
      result: status === 'done' ? { kind: 'manabase', result: REPORT, pilotId: 'heuristic' } : null,
      run: () => {},
      cancel: () => {},
      workerCount: 4,
    },
    gamesConfig: MANABASE_GAMES,
    radiusConfig: MANABASE_SWEEP_RADIUS,
    ...extra,
  } as unknown as PanelProps & { gamesConfig: typeof MANABASE_GAMES; radiusConfig: typeof MANABASE_SWEEP_RADIUS };
  return renderToStaticMarkup(createElement(ManabasePanel, props));
}

describe('the Manabase tab before a run', () => {
  const html = markup();

  it('shows the base manabase as built, from the same generator the worker runs', () => {
    expect(html).toContain('As built:');
    expect(html).toContain('24 lands — 4 Selesnya Guildgate, 4 Blossoming Sands, 8 Forest, 8 Plains · spells need W ×17, G ×19');
  });

  it('previews the enumerated family with labels, and the skips with reasons', () => {
    expect(html).toContain('23 lands (−1 Forest, +1 Elvish Visionary)');
    expect(html).toContain('Forest/Plains 8/8 → 7/9');
    expect(html).toContain('4 Temple Garden for 2 Forest + 2 Plains');
    expect(html).toContain('the deck already runs an equivalent land (Selesnya Guildgate)');
  });

  it('the run button names how many manabases will be tested, and the sweeps are toggles', () => {
    expect(html).toMatch(/Try \d+ manabases/);
    expect(html.match(/type="checkbox"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('Games per finalist');
    expect(html).toContain('Sweep radius');
  });
});

describe('the Manabase tab after a run', () => {
  it('shows both axes side by side, the rule, and the honest gaps', () => {
    const html = markup({ onApplyManabase: () => {} }, 'done');
    expect(html).toContain('Win rate (paired, corrected)');
    expect(html).toContain('Reliability (measured, base → variant)');
    expect(html).toContain(VARIANT.label);
    expect(html).toContain('BETTER');
    expect(html).toContain('more reliable');
    expect(html).toContain('no difference shown');
    expect(html).toContain('Recommended:');
    expect(html).toContain('never blended into one score');
    expect(html).toContain('Mulligans taken: NOT MEASURED');
    expect(html).toContain('the simulator never mulligans');
    expect(html).toContain('Not tested (1)');
    expect(html).toContain('>Apply<');
  });

  it('offers no Apply when the hero cannot be edited', () => {
    const html = markup({}, 'done');
    expect(html).not.toContain('>Apply<');
    expect(html).toContain('read-only');
  });
});
