/**
 * §3.124 — the battlefield is named ON SCREEN, in the same words a screen
 * reader hears.
 *
 * The report ("Battlefield zone naming/organization") was a mismatch: the rows
 * carried aria-labels and no visible caption, so sighted players saw two
 * unlabelled strips of tiles while assistive tech heard "creatures and other
 * permanents". Pinned with a static render (the `jail-tile.test.ts` idiom) —
 * this is about what the markup SAYS, which no engine test can see.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SeatPanel } from './SeatPanel.js';
import type { BoardPermanent, SeatView } from '../../lib/play/view-model.js';

/** A real permanent shape (the `jail-tile.test.ts` fixture), not a partial cast. */
const PERMANENT: BoardPermanent = {
  instanceId: 1,
  cardId: 'forest-id',
  name: 'Forest',
  controller: 'A',
  isCreature: false,
  isLand: true,
  isPlaneswalker: false,
  loyalty: 0,
  isBattle: false,
  defense: 0,
  protector: null,
  tapped: false,
  summoningSick: false,
  power: 0,
  toughness: 0,
  printedPower: 0,
  printedToughness: 0,
  ptDelta: null,
  damageMarked: 0,
  keywords: {},
  producesIfTapped: [],
  attacking: false,
  blocking: null,
};

const SEAT: SeatView = {
  id: 'A',
  name: 'Player 1',
  life: 20,
  poison: 0,
  handCount: 7,
  hand: null,
  libraryCount: 52,
  graveyardCount: 0,
  graveyard: [],
  exileCount: 0,
  manaPool: {},
  restrictedMana: [],
  hasLost: false,
  permanents: [],
};

function markup(seat: SeatView = SEAT): string {
  return renderToStaticMarkup(createElement(SeatPanel, { seat, isActive: true, hasPriority: true }));
}

const CREATURE: BoardPermanent = { ...PERMANENT, instanceId: 2, cardId: 'bear-id', name: 'Grizzly Bears', isLand: false, isCreature: true, power: 2, toughness: 2, printedPower: 2, printedToughness: 2 };

describe('the battlefield rows are captioned on screen', () => {
  it('captions populated rows — "Creatures" and "Lands" — visibly, not only in aria', () => {
    const html = markup({ ...SEAT, permanents: [PERMANENT, CREATURE] });
    expect(html).toMatch(/class="seat__row-label"[^>]*>Creatures</);
    expect(html).toMatch(/class="seat__row-label"[^>]*>Lands</);
  });

  it('names the zone itself — "Battlefield" — beside the rows once anything is on it', () => {
    expect(markup({ ...SEAT, permanents: [PERMANENT] })).toMatch(/class="seat__board-label"[^>]*>Battlefield</);
  });

  it('an EMPTY battlefield names itself in its text and adds no vertical caption (§3.62 budget)', () => {
    // A rotated word is taller than an empty row; captioning empty rows grew every
    // turn-one board by a caption's height. The empty text carries the name instead.
    const html = markup();
    expect(html).not.toContain('seat__row-label');
    expect(html).not.toContain('seat__board-label');
    expect(html).toContain('Battlefield — no creatures');
  });

  it('captions only the rows that hold tiles, so an empty row stays one line tall', () => {
    const html = markup({ ...SEAT, permanents: [PERMANENT] }); // lands only
    expect(html).toMatch(/class="seat__row-label"[^>]*>Lands</);
    expect(html).not.toMatch(/class="seat__row-label"[^>]*>Creatures</);
  });

  it('the accessible names use the SAME words as the captions — one table, no drift', () => {
    const html = markup();
    // The aria-label ends with the row's words; the caption shows the row's label.
    expect(html).toContain('aria-label="Player 1 creatures and other permanents"');
    expect(html).toContain('aria-label="Player 1 lands"');
    expect(html).toContain('aria-label="Player 1 battlefield"');
  });

  it('does not read the caption twice to assistive tech', () => {
    // The row already announces itself; the visible caption is decoration for eyes.
    const html = markup({ ...SEAT, permanents: [PERMANENT, CREATURE] });
    const captions = html.match(/class="seat__row-label"[^>]*>/g) ?? [];
    expect(captions.length).toBe(2);
    for (const c of captions) expect(c).toContain('aria-hidden="true"');
  });
});
