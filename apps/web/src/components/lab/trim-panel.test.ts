/**
 * THE TRIM PANEL MOUNTS, AND SHOWS WHAT A ROUND FOUND (§3.174) — a static render
 * (the `swap-panel-pickers.test.ts` idiom), because a pure module that is
 * perfect and a panel that never renders its table is the defect this repo has
 * paid for most often.
 *
 *  - idle: the target input, both settings groups, the standing line, a live Start;
 *  - a target the deck cannot be trimmed to is refused in words, Start dead;
 *  - an improving round: the winner banner, the ask-mode buttons, every row;
 *  - an exhausted round: the on-the-edge candidate, named and labelled as such,
 *    with a DASHED (never primary) apply.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { TrimRoundReport, TrimRow } from '@jonny-boi/sim';
import { RoundCard, TrimPanel } from './TrimPanel.js';
import { SUGGEST_GAMES, TRIM_DEFAULT_SETTINGS, TRIM_TARGET_SIZE } from '../../lib/lab-config.js';
import { allCards } from '../../lib/cards.js';

/** A real card-index id by name — the standing line reads lands off the index. */
function idOf(name: string): string {
  const card = allCards.find((c) => c.name === name);
  if (!card) throw new Error(`card index has no "${name}"`);
  return card.id;
}

/** A 63-card hero: 24 Forest, 3 Swamp, nine 4-of nonlands. */
const HERO = {
  id: 'd1',
  name: 'Rigged Green',
  updatedAt: '',
  cards: [
    { cardId: idOf('Forest'), count: 24, name: 'Forest' },
    { cardId: idOf('Swamp'), count: 3, name: 'Swamp' },
    ...['Craw Wurm', 'Llanowar Elves', 'Elvish Mystic', 'Birds of Paradise', 'Wall of Blossoms', 'Deadly Recluse', 'Giant Spider', 'Eternal Witness', 'Pelakka Wurm'].map(
      (name) => ({ cardId: idOf(name), count: 4, name }),
    ),
  ],
};

type TrimPanelProps = Parameters<typeof TrimPanel>[0];

function markup(extra: Record<string, unknown> = {}): string {
  // The sim handle is a partial double (status/result/run/cancel/workerCount are
  // all the panel reads), hence the cast through `unknown`.
  const props: unknown = {
    hero: HERO,
    heroPayload: { name: HERO.name, archetype: HERO.name, cards: HERO.cards },
    heroLegal: true,
    chosenOpponents: ['UW Control'],
    seed: 1,
    pilotId: 'heuristic',
    sim: { status: 'idle', result: null, run: () => {}, cancel: () => {}, workerCount: 4 },
    gamesConfig: SUGGEST_GAMES,
    targetConfig: TRIM_TARGET_SIZE,
    defaultSettings: TRIM_DEFAULT_SETTINGS,
    onApplyCut: () => ({ deck: HERO, copiesRemoved: 1, removed: ['Swamp'] }),
    ...extra,
  };
  return renderToStaticMarkup(createElement(TrimPanel, props as TrimPanelProps));
}

function row(rank: number, label: string, verdict: 'better' | 'inconclusive' | 'worse', delta: number, isLand = false): TrimRow {
  return {
    rank,
    key: `${label}>(nothing)`,
    cuts: [{ cardId: label, name: label, isLand }],
    label,
    sizeAfter: 62,
    evaluation: {
      verdict,
      delta,
      baseWinRate: { p: 0.5, low: 0.4, high: 0.6, successes: 20, n: 40 },
      variantWinRate: { p: 0.5 + delta, low: 0.4, high: 0.6, successes: 20, n: 40 },
      nGames: 40,
      paired: { bothWon: 10, baseOnly: 5, variantOnly: 15, neither: 10 },
    } as unknown as TrimRow['evaluation'],
    gamesPlayed: 40,
    rawPValue: 0.004,
    adjustedPValue: 0.02,
    priorReasons: ['4 copies in the deck'],
  };
}

function report(overrides: Partial<TrimRoundReport>): TrimRoundReport {
  return {
    deckName: HERO.name,
    deckFingerprint: 'fp',
    deckSize: 63,
    targetSize: 60,
    round: 0,
    roundKind: 'singles',
    cardsPerCut: 1,
    reading: {
      base: { lands: 27, size: 63 },
      current: { lands: 27, size: 63 },
      ratioLands: 27,
      excessLands: 0,
      tolerance: 1,
      due: false,
      favoured: 'nonland',
      explanation: 'lands 27/63 at the start (42.9%) → unchanged so far → 27 lands would keep that ratio → 0 over (a land cut is due at 1 over) → no land cut due yet — a nonland goes first',
    },
    verdict: 'exhausted',
    rows: [],
    baseWinRate: { p: 0.5, low: 0.4, high: 0.6, successes: 20, n: 40 },
    candidatesEvaluated: 2,
    skipped: [],
    waves: [],
    multipleComparisons: { method: 'holm', familySize: 2, testedThisRun: 2, demotedByCorrection: 0 },
    notes: {
      totalGamesRun: 120,
      candidatesGenerated: 2,
      cappedByBudget: false,
      baseGamesPlayed: 40,
      variantGamesPlayed: 80,
      variantGamesSkipped: 0,
      gamesAvoided: 0,
      identicalGameSkipEnabled: false,
      runIndex: 0,
      fidelityCaveat: 'caveat',
    },
    pairingNote: 'pairing note',
    ...overrides,
  };
}

function card(r: TrimRoundReport, status: 'asking' | 'exhausted' | 'running'): string {
  return renderToStaticMarkup(
    createElement(RoundCard, {
      report: r,
      pilotId: 'heuristic',
      seed: 1,
      isLatest: true,
      status,
      applied: null,
      canApply: status !== 'running',
      onApply: () => {},
      onStop: () => {},
    }),
  );
}

describe('the Trim panel', () => {
  it('mounts with the target input, both settings, the standing line and a live Start', () => {
    const html = markup();
    expect(html).toContain('aria-label="Target deck size"');
    expect(html).toContain(`value="${TRIM_TARGET_SIZE.default}"`);
    expect(html).toContain('On an improving removal');
    expect(html).toContain('When nothing improves');
    expect(html).toContain('Keep looking — widen to nonland + land pairs');
    expect(html).toContain('lands 27/63');
    expect(html).toContain('<strong>3</strong> to cut');
    expect(html).toMatch(/<button[^>]*class="btn btn--primary"[^>]*>Start trimming<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Start trimming/);
  });

  it('refuses a target the deck cannot be trimmed to, in words, with Start dead', () => {
    const html = markup({ defaultSettings: { ...TRIM_DEFAULT_SETTINGS, targetSize: 63 } });
    expect(html).toContain('the target must be smaller');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start trimming<\/button>/);
  });

  it('without an editable hero the auto option is disabled and the reason is printed', () => {
    const html = markup({ onApplyCut: undefined });
    expect(html).toContain('bundled gauntlet deck');
    // React emits `disabled` before `value` on an input; match within the one tag.
    expect(html).toMatch(/<input[^>]*name="trim-on-improvement"[^>]*disabled=""[^>]*value="auto"/);
  });
});

describe('a round card', () => {
  it('an improving round shows the winner, the reading, every row, and the ask-mode buttons', () => {
    const winner = row(1, 'Swamp', 'better', 0.08, true);
    const html = card(report({ verdict: 'improved', winner, rows: [winner, row(2, 'Craw Wurm', 'inconclusive', 0.01)] }), 'asking');
    expect(html).toContain('BETTER without');
    expect(html).toContain('−1× Swamp');
    expect(html).toContain('no land cut due yet');
    expect(html).toContain('Apply and keep trimming');
    expect(html).toContain('Apply and stop');
    expect(html).toContain('Stop without applying');
    expect(html.match(/<tr/g)?.length).toBe(3); // header + two rows
    expect(html).toContain('−1× Craw Wurm');
    expect(html).toContain('pairing note');
  });

  it('an exhausted round names the on-the-edge candidate and offers it dashed, never primary', () => {
    const edge = row(1, 'Craw Wurm', 'inconclusive', 0.02);
    const html = card(report({ verdict: 'exhausted', edgeCandidate: edge, rows: [edge, row(2, 'Forest', 'worse', -0.03, true)] }), 'exhausted');
    expect(html).toContain('Nothing proved better');
    expect(html).toContain('Most likely improving removal: −1× Craw Wurm');
    expect(html).toContain('on the edge');
    expect(html).toMatch(/class="btn btn--ghost trim-edge-apply"[^>]*>Apply on-the-edge and keep trimming/);
    expect(html).not.toMatch(/btn--primary[^>]*>Apply on-the-edge/);
    expect(html).toContain('trim-row--edge');
    expect(html).toContain('trim-land-tag');
  });

  it('a round with every removal proven worse says so and offers nothing', () => {
    const html = card(report({ verdict: 'exhausted', rows: [row(1, 'Forest', 'worse', -0.03, true)] }), 'exhausted');
    expect(html).toContain('Every removal was proven worse');
    expect(html).not.toContain('Apply on-the-edge');
  });
});
