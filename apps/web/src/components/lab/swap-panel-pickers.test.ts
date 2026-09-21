/**
 * THE A/B PANEL IS BUILT ON THE PICKERS, THE TRIMMED MENU AND THE APPLIED
 * BUTTON (§3.165) — pinned with a static render (the `gauntlet-row-owner.test.ts`
 * idiom), because every one of these was a "wire the consumer" defect waiting
 * to happen: the model can be perfect while the panel still renders two native
 * selects.
 *
 *  - two comboboxes (cut, add), no native card `<select>`s;
 *  - a 1-of cut leaves the copies menu with exactly one option;
 *  - with a finished verdict the apply button is offered live; the "applied"
 *    state is component state a static render cannot press, so its markup is
 *    pinned by the button's own class and label contract instead.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATS_CONFIG } from '@jonny-boi/sim';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SwapPanel } from './SwapPanel.js';
import { SWAP_GAMES } from '../../lib/lab-config.js';
import type { PanelProps, CardOption } from './panel-types.js';

const OUT: readonly CardOption[] = [
  { cardId: 'c:soul-warden', name: 'Soul Warden', count: 4 },
  { cardId: 'c:akromas-memorial', name: "Akroma's Memorial", count: 1 },
];
const IN: readonly CardOption[] = [
  { cardId: 'c:heliod', name: 'Heliod, Sun-Crowned' },
  { cardId: 'c:selvala', name: 'Selvala, Explorer Returned' },
];

const RESULT = {
  kind: 'swap' as const,
  // §3.179 — a bare SwapEvaluation has no `notes` to carry the bar it was read
  // at, so the result payload echoes it and the panel renders THAT, never its
  // own current control.
  stats: DEFAULT_STATS_CONFIG,
  pilotId: 'lookahead',
  gamesPerSecond: 100,
  result: {
    baseDeck: 'Thune',
    variantDeck: 'Thune (variant)',
    swap: { out: 'c:soul-warden', in: 'c:heliod' },
    outName: 'Soul Warden',
    inName: 'Heliod, Sun-Crowned',
    baseWinRate: { estimate: 0.5, low: 0.4, high: 0.6 },
    variantWinRate: { estimate: 0.6, low: 0.5, high: 0.7 },
    delta: 0.1,
    ci: { estimate: 0.1, low: 0.02, high: 0.18 },
    pValue: 0.01,
    paired: { bothWin: 30, baseOnly: 5, variantOnly: 15, bothLose: 50 },
    mcNemar: { statistic: 5, pValue: 0.01 },
    verdict: 'better',
    verdictReason: 'significantGain',
    nGames: 100,
    scope: 'playset',
    copiesSwapped: 4,
  },
};

function markup(extra: Partial<PanelProps> = {}, status: 'idle' | 'done' = 'idle'): string {
  const props = {
    hero: { id: 'd1', name: 'Thune', cards: [], updatedAt: '' },
    heroPayload: { name: 'Thune', archetype: 'lifegain', cards: [] },
    heroLegal: true,
    chosenOpponents: ['Mono-Green Ramp'],
    seed: 1,
    pilotId: 'lookahead',
    sim: { status, result: status === 'done' ? RESULT : null, run: () => {}, cancel: () => {} },
    gamesConfig: SWAP_GAMES,
    outOptions: OUT,
    inOptions: IN,
    ...extra,
  } as unknown as PanelProps & { gamesConfig: typeof SWAP_GAMES; outOptions: readonly CardOption[]; inOptions: readonly CardOption[] };
  return renderToStaticMarkup(createElement(SwapPanel, props));
}

describe('the A/B panel’s pickers', () => {
  it('renders two comboboxes and no native card select', () => {
    const html = markup();
    expect(html.match(/role="combobox"/g)?.length).toBe(2);
    expect(html).toContain('Cut (out)');
    expect(html).toContain('Add (in)');
    // The only <select> left is the copies menu.
    expect(html.match(/<select/g)?.length).toBe(1);
    expect(html).not.toContain('Pick a card…');
  });

  it('a 4-of cut offers the full menu; the first cut is the first option', () => {
    const html = markup();
    expect(html).toContain('All 4 copies');
    expect(html).toContain('Exactly 2 of the 4');
    expect(html).toContain('Exactly 3 of the 4');
    expect(html).not.toContain('Exactly 4');
  });

  it('a 1-of cut leaves exactly one copies option, and the menu is disabled', () => {
    const html = markup({ outOptions: [OUT[1]!] } as Partial<PanelProps>);
    expect(html).toContain('The only copy');
    expect(html).not.toContain('All ');
    expect(html).not.toContain('Exactly');
    expect(html).toMatch(/<select[^>]*disabled/);
  });

  it('a finished verdict offers a LIVE apply button, and the applied contract is the label', () => {
    const html = markup({ onApplySwap: () => {} } as Partial<PanelProps>, 'done');
    expect(html).toContain('Apply to my deck');
    expect(html).not.toContain('✓ Applied');
    // The live button carries no `disabled` attribute at all (a false
    // aria-disabled would still contain the word — match the attribute).
    expect(html).not.toMatch(/verdict-banner__apply[^>]*\sdisabled(?:=""|\s|>)/);
  });
});
