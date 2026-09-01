/**
 * §3.65 — every number in the gauntlet table is the HERO's, per opponent, and
 * the table has to say so.
 *
 * The old header said "Win rate (95% CI)" beside a column of OPPONENT names, and
 * labelled the hero's bar with the opponent's name. A row reading
 * "Selesnya Blink · 13/100 · 13.0%" is the hero winning 13% AGAINST Selesnya
 * Blink — but it reads exactly like Selesnya Blink scoring 13%, which is how the
 * strongest deck in the gauntlet came to be reported as the worst.
 *
 * Pinned with a static render (the `jail-tile.test.ts` idiom): this is about
 * what the markup SAYS, which no engine test can see.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { GauntletPanel } from './GauntletPanel.js';
import { GAUNTLET_GAMES } from '../../lib/lab-config.js';
import type { PanelProps } from './panel-types.js';

const HERO_NAME = 'Selesnya Blink';
const OPPONENT = 'Mono-Green Ramp';

/** One finished gauntlet result, shaped as the panel consumes it. */
const RESULT = {
  kind: 'gauntlet' as const,
  pilotId: 'lookahead',
  gamesPerSecond: 120,
  result: {
    matchups: [
      {
        deckA: HERO_NAME,
        deckB: OPPONENT,
        games: 100,
        winsA: 13,
        winsB: 87,
        draws: 0,
        winRateA: { estimate: 0.13, low: 0.078, high: 0.21 },
        gameSeeds: [],
      },
    ],
    totalWins: 13,
    totalGames: 100,
    totalDraws: 0,
    overallWinRate: { estimate: 0.13, low: 0.078, high: 0.21 },
  },
};

function markup(): string {
  const props = {
    hero: null,
    heroPayload: { name: HERO_NAME, archetype: 'Midrange', cards: [] },
    heroLegal: true,
    chosenOpponents: [OPPONENT],
    seed: 99,
    pilotId: 'lookahead',
    sim: { status: 'done', result: RESULT, run: () => {}, cancel: () => {} },
    gamesConfig: GAUNTLET_GAMES,
  } as unknown as PanelProps & { gamesConfig: typeof GAUNTLET_GAMES };
  return renderToStaticMarkup(createElement(GauntletPanel, props));
}

describe('the gauntlet table names whose win rate it is showing', () => {
  it('attributes the record and win-rate columns to the hero deck', () => {
    const html = markup();
    expect(html).toContain(`${HERO_NAME} win rate`);
    expect(html).toContain(`${HERO_NAME} record`);
  });

  it('never shows a bare "Win rate" header beside the opponent column', () => {
    // The exact ambiguity: an unattributed column of numbers next to a column
    // of other decks' names.
    expect(markup()).not.toMatch(/>\s*Win rate \(95% CI\)\s*</);
  });

  it('does not label the hero bar with the opponent name alone', () => {
    const html = markup();
    // The bar is the hero's; naming it only for the opponent read as the
    // opponent's own score.
    expect(html).toContain(`${HERO_NAME} vs ${OPPONENT}`);
  });

  it('still names the opponent, because that is what the row identifies', () => {
    expect(markup()).toContain(OPPONENT);
  });
});
