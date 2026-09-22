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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  DEFAULT_STATS_CONFIG,
  SWAP_VERDICT_REASON_BY_KEY,
  TRIM_STOP_REASONS,
  TRIM_STOP_REASON_WORDING,
  statsConfigFor,
  type SwapVerdictReason,
  type TrimRoundReport,
  type TrimRow,
  trimCoverage,
} from '@jonny-boi/sim';

/**
 * A plausible distinct-card count for a 63-card deck, so a fake round's
 * coverage line reads like a real one. It is a FIXTURE, not a claim about any
 * particular deck -- and the line itself is built by the sim's own
 * `trimCoverage`, so a test can never assert a sentence the panel does not
 * actually print.
 */
const DISTINCT_CARDS = 35;
import { RoundCard, TrimPanel } from './TrimPanel.js';
import {
  DEFAULT_VERDICT_BAR,
  SUGGEST_GAMES,
  TRIM_DEFAULT_SETTINGS,
  TRIM_TARGET_SIZE,
  VERDICT_MIN_GAMES,
} from '../../lib/lab-config.js';
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
    verdictBar: DEFAULT_VERDICT_BAR,
    verdictMinGames: VERDICT_MIN_GAMES.default,
    sim: { status: 'idle', result: null, run: () => {}, cancel: () => {}, workerCount: 4 },
    gamesConfig: SUGGEST_GAMES,
    targetConfig: TRIM_TARGET_SIZE,
    defaultSettings: TRIM_DEFAULT_SETTINGS,
    onApplyCut: () => ({ deck: HERO, copiesRemoved: 1, removed: ['Swamp'] }),
    ...extra,
  };
  return renderToStaticMarkup(createElement(TrimPanel, props as TrimPanelProps));
}

/**
 * §3.179 — a row now carries WHY, so the fixture has to as well. The reason is
 * the one the real funnel would have produced for that verdict, and an
 * inconclusive row also carries the games-to-settle estimate the panel offers.
 */
const REASON_FOR: Readonly<Record<'better' | 'inconclusive' | 'worse', SwapVerdictReason>> = {
  better: 'significantGain',
  worse: 'significantLoss',
  inconclusive: 'notSignificant',
};

function row(
  rank: number,
  label: string,
  verdict: 'better' | 'inconclusive' | 'worse',
  delta: number,
  isLand = false,
  reason: SwapVerdictReason = REASON_FOR[verdict],
): TrimRow {
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
      verdictReason: reason,
      ...(SWAP_VERDICT_REASON_BY_KEY[reason].moreGamesCouldSettle
        ? { gamesToSettle: { additionalPairedGames: 2101, totalPairedGames: 2141, alpha: 0.05 } }
        : {}),
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
    coverage: trimCoverage('singles', 1, DISTINCT_CARDS),
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
      stats: DEFAULT_STATS_CONFIG,
    },
    pairingNote: 'pairing note',
    ...overrides,
  };
}

function card(r: TrimRoundReport, status: 'asking' | 'finished' | 'running'): string {
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
    const html = card(report({ verdict: 'exhausted', edgeCandidate: edge, rows: [edge, row(2, 'Forest', 'worse', -0.03, true)] }), 'finished');
    expect(html).toContain('Nothing proved better');
    expect(html).toContain('Most likely improving removal: −1× Craw Wurm');
    expect(html).toContain('on the edge');
    expect(html).toMatch(/class="btn btn--ghost trim-edge-apply"[^>]*>Apply on-the-edge and keep trimming/);
    expect(html).not.toMatch(/btn--primary[^>]*>Apply on-the-edge/);
    expect(html).toContain('trim-row--edge');
    expect(html).toContain('trim-land-tag');
  });

  it('a round with every removal proven worse says so and offers nothing', () => {
    const html = card(report({ verdict: 'exhausted', rows: [row(1, 'Forest', 'worse', -0.03, true)] }), 'finished');
    // §3.179 re-worded this: "proven worse" was only ever true of SOME conclusive
    // rounds, and the honest claim is that every row was readable and none helped.
    expect(html).toContain('measured deeply enough to call');
    expect(html).toContain('more games would not change that');
    expect(html).not.toContain('Apply on-the-edge');
  });
});

describe('§3.179 — the round card says WHY, not just INCONCLUSIVE', () => {
  it('gives every row a reason beside its verdict', () => {
    const html = card(
      report({ verdict: 'unsure', rows: [row(1, 'Craw Wurm', 'inconclusive', 0.02), row(2, 'Forest', 'worse', -0.03, true)] }),
      'finished',
    );
    expect(html).toContain('<th>Why</th>');
    expect(html).toContain(SWAP_VERDICT_REASON_BY_KEY.notSignificant.label);
    expect(html).toContain(SWAP_VERDICT_REASON_BY_KEY.significantLoss.label);
  });

  it('tells the three inconclusive situations apart on screen — the whole complaint', () => {
    const rows = [
      row(1, 'Craw Wurm', 'inconclusive', 0.02, false, 'tooFewGames'),
      row(2, 'Giant Spider', 'inconclusive', 0.01, false, 'notSignificant'),
      row(3, 'Forest', 'inconclusive', 0, true, 'deadHeat'),
    ];
    const html = card(report({ verdict: 'unsure', rows }), 'finished');
    for (const reason of ['tooFewGames', 'notSignificant', 'deadHeat'] as const) {
      expect(html, `${reason} is not distinguishable on screen`).toContain(SWAP_VERDICT_REASON_BY_KEY[reason].label);
    }
    // Three rows, three DIFFERENT words. Before §3.179 all three printed
    // INCONCLUSIVE and nothing else.
    const labels = new Set((['tooFewGames', 'notSignificant', 'deadHeat'] as const).map((r) => SWAP_VERDICT_REASON_BY_KEY[r].label));
    expect(labels.size).toBe(3);
  });

  it('offers the games-to-settle estimate only where more games could settle it', () => {
    const unsureRow = row(1, 'Craw Wurm', 'inconclusive', 0.02, false, 'notSignificant');
    const deadRow = row(1, 'Forest', 'inconclusive', 0, true, 'deadHeat');
    expect(card(report({ verdict: 'unsure', rows: [unsureRow] }), 'finished')).toContain('2,101 more');
    // A dead heat has no N. A zero there would read as "already settled".
    expect(card(report({ verdict: 'unsure', rows: [deadRow] }), 'finished')).not.toContain('more)');
  });

  it('states the bar THE RUN was read at, taken from the report and not from a constant', () => {
    const at10 = report({ verdict: 'unsure', rows: [row(1, 'Craw Wurm', 'inconclusive', 0.02)] });
    const loose: TrimRoundReport = { ...at10, notes: { ...at10.notes, stats: statsConfigFor(0.1, 50) } };
    const html = card(loose, 'finished');
    expect(html).toContain('<strong>0.1</strong>');
    expect(html).toContain('<strong>50</strong>');
    // ...and the default run states its own bar, so the two cannot be confused.
    expect(card(at10, 'finished')).toContain(`<strong>${DEFAULT_STATS_CONFIG.alpha}</strong>`);
  });

  it('an UNSURE round does not claim nothing helps', () => {
    const unsure = card(report({ verdict: 'unsure', rows: [row(1, 'Craw Wurm', 'inconclusive', 0.02)] }), 'finished');
    expect(unsure).toContain('Not measured deeply enough to tell');
    expect(unsure).toContain('NOT &quot;nothing helps&quot;');
    expect(unsure).not.toContain('Nothing proved better');

    const conclusive = card(report({ verdict: 'exhausted', rows: [row(1, 'Forest', 'worse', -0.03, true)] }), 'finished');
    expect(conclusive).toContain('Nothing proved better');
    expect(conclusive).not.toContain('Not measured deeply enough to tell');
  });
});

describe('§3.179 acceptance 4, on screen — every stop reason has words in the panel', () => {
  it('enumerates TRIM_STOP_REASONS and fails if one would render mute', () => {
    expect(TRIM_STOP_REASONS.length).toBeGreaterThan(3);
    for (const reason of TRIM_STOP_REASONS) {
      const words = TRIM_STOP_REASON_WORDING[reason];
      expect(words, `the panel has no words for ${reason}`).toBeDefined();
      expect(words.label.length, `${reason} would render a blank headline`).toBeGreaterThan(3);
      expect(words.detail.length, `${reason} would render a blank explanation`).toBeGreaterThan(20);
    }
  });

  it('the panel reads those words from the sim rather than restating them', () => {
    // The guard for rule 12: a second wording table in the panel is how
    // "exhausted" came to be printed for two opposite situations.
    // No newline normalisation needed: every `detail` is a single line, so a
    // CRLF checkout cannot change whether it appears verbatim in the source.
    const source = readFileSync(fileURLToPath(new URL('./TrimPanel.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('TRIM_STOP_REASON_WORDING');
    for (const reason of TRIM_STOP_REASONS) {
      const words = TRIM_STOP_REASON_WORDING[reason];
      expect(
        source.includes(words.detail),
        `TrimPanel.tsx restates the wording for ${reason} instead of reading the sim's table`,
      ).toBe(false);
    }
  });
});
