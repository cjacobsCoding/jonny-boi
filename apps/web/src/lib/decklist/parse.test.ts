/**
 * Parser tests — one per real-world exporter flavour. Each sample is the shape
 * that site actually produces, so a regression here means "pasting from <site>
 * broke", which is exactly the failure the import feature exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { entriesInSection, parseDeckText, totalCards } from './parse.js';

describe('parseDeckText — exporter flavours', () => {
  it('parses a plain list (MTGGoldfish / MTGO)', () => {
    const { entries, errors, format } = parseDeckText('4 Lightning Bolt\n20 Mountain');
    expect(errors).toHaveLength(0);
    expect(format).toBe('plain');
    expect(entries).toEqual([
      { name: 'Lightning Bolt', qty: 4, section: 'main' },
      { name: 'Mountain', qty: 20, section: 'main' },
    ]);
  });

  it('parses an MTG Arena export with set codes and collector numbers', () => {
    const text = [
      'Deck',
      '4 Lightning Bolt (M10) 146',
      '2 Fatal Push (MH2) 335',
      '',
      'Sideboard',
      '2 Abrade (VOW) 139',
    ].join('\n');

    const { entries, errors, format } = parseDeckText(text);

    expect(errors).toHaveLength(0);
    expect(format).toBe('arena');
    expect(entries[0]).toEqual({
      name: 'Lightning Bolt',
      qty: 4,
      set: 'm10',
      collectorNumber: '146',
      section: 'main',
    });
    expect(entriesInSection(entries, 'sideboard')).toHaveLength(1);
    expect(entriesInSection(entries, 'main')).toHaveLength(2);
  });

  it('reads the deck name from an Arena "Name" header', () => {
    const { deckName, entries } = parseDeckText('Name Mono Red Burn\nDeck\n4 Lightning Bolt');
    expect(deckName).toBe('Mono Red Burn');
    expect(entries).toHaveLength(1);
  });

  it('strips Moxfield foil markers', () => {
    const { entries, errors } = parseDeckText('1 Sol Ring (LTC) 379 *F*');
    expect(errors).toHaveLength(0);
    expect(entries[0]).toEqual({
      name: 'Sol Ring',
      qty: 1,
      set: 'ltc',
      collectorNumber: '379',
      section: 'main',
    });
  });

  it('strips an Archidekt category suffix but keeps a real set code', () => {
    const { entries } = parseDeckText('1 Birds of Paradise [Mana Ramp Package]\n1 Sol Ring (c21)');
    expect(entries[0]!.name).toBe('Birds of Paradise');
    expect(entries[0]!.set).toBeUndefined();
    expect(entries[1]).toEqual({ name: 'Sol Ring', qty: 1, set: 'c21', section: 'main' });
  });

  it('honors per-line SB: sideboard markers (Deckstats / TappedOut)', () => {
    const { entries } = parseDeckText('4 Lightning Bolt\nSB: 2 Fatal Push');
    expect(entries[1]).toEqual({ name: 'Fatal Push', qty: 2, section: 'sideboard' });
  });

  it('accepts an "x" suffix on the quantity', () => {
    const { entries } = parseDeckText('4x Lightning Bolt\n1x Sol Ring');
    expect(entries.map((entry) => entry.qty)).toEqual([4, 1]);
  });

  it('parses a CSV export with quoted names containing commas', () => {
    const text = [
      'Count,Name,Edition',
      '4,Lightning Bolt,M10',
      '1,"Jace, the Mind Sculptor",WWK',
    ].join('\n');

    const { entries, errors, format } = parseDeckText(text);

    expect(errors).toHaveLength(0);
    expect(format).toBe('csv');
    expect(entries[1]).toEqual({
      name: 'Jace, the Mind Sculptor',
      qty: 1,
      set: 'wwk',
      section: 'main',
    });
  });

  it('keeps a double-faced card name containing " // " intact', () => {
    const { entries, errors } = parseDeckText('4 Delver of Secrets // Insectile Aberration');
    expect(errors).toHaveLength(0);
    expect(entries[0]!.name).toBe('Delver of Secrets // Insectile Aberration');
  });

  it('treats a leading // line as a comment', () => {
    const { entries, errors } = parseDeckText('// exported from somewhere\n4 Lightning Bolt');
    expect(errors).toHaveLength(0);
    expect(entries).toHaveLength(1);
  });

  it('recognizes section headers with counts and colons', () => {
    const { entries } = parseDeckText('Deck:\n4 Lightning Bolt\nSideboard (1)\n1 Abrade');
    expect(entriesInSection(entries, 'main')).toHaveLength(1);
    expect(entriesInSection(entries, 'sideboard')).toHaveLength(1);
  });

  it('separates a commander section', () => {
    const { entries } = parseDeckText('Commander\n1 Atraxa, Praetors’ Voice\nDeck\n1 Sol Ring');
    expect(entriesInSection(entries, 'commander')).toHaveLength(1);
    expect(entriesInSection(entries, 'main')).toHaveLength(1);
  });

  it('reports an unparseable line without dropping the rest', () => {
    const { entries, errors } = parseDeckText('4 Lightning Bolt\n7\n2 Sol Ring');
    expect(entries).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(2);
  });

  it('counts total copies across entries', () => {
    const { entries } = parseDeckText('4 Lightning Bolt\n20 Mountain');
    expect(totalCards(entries)).toBe(24);
  });

  it('collapses internal whitespace in names', () => {
    const { entries } = parseDeckText('1   Serra    Angel');
    expect(entries[0]!.name).toBe('Serra Angel');
  });
});
