import { describe, expect, it } from 'vitest';
import type { Deck } from '../deck.js';
import { fromExport, toExport } from '../deck.js';
import type { PrintOption } from '../proxy/prints.js';
import {
  customPrintingCount,
  deckPrintingOverrides,
  entryPrintingOf,
  isChosenPrinting,
  isEntryPrinting,
  printingFromOption,
  withEntryPrinting,
  withoutEntryPrinting,
  type EntryPrinting,
} from './entryPrinting.js';

const LIGHTNING_BOLT = 'card-bolt';
const MOUNTAIN = 'card-mountain';

function deckOf(cards: Deck['cards']): Deck {
  return { id: 'd1', name: 'Test', cards, updatedAt: '2026-01-01T00:00:00.000Z' };
}

const RETRO: EntryPrinting = {
  scryfallId: 'print-retro',
  imageUrl: 'https://img.example/retro.png',
  set: 'STA',
  label: 'STA · #123 · An Artist',
};

describe('printingFromOption', () => {
  const option: PrintOption = {
    scryfallId: 'print-1',
    name: 'Lightning Bolt',
    imageUrl: 'https://img.example/front.png',
    thumbnailUrl: 'https://img.example/small.png',
    set: 'MH2',
    collectorNumber: '123',
    artist: 'An Artist',
  };

  it('carries the printing identity and its art', () => {
    const printing = printingFromOption(option, 'MH2 · #123');
    expect(printing.scryfallId).toBe('print-1');
    expect(printing.imageUrl).toBe('https://img.example/front.png');
    expect(printing.set).toBe('MH2');
    expect(printing.label).toBe('MH2 · #123');
  });

  it('carries a double-faced printing’s back image', () => {
    const printing = printingFromOption(
      { ...option, backImageUrl: 'https://img.example/back.png' },
      'MH2',
    );
    expect(printing.backImageUrl).toBe('https://img.example/back.png');
  });

  /**
   * `JSON.stringify` drops `undefined` keys, so setting them would make a deck's
   * export differ from the deck in memory — a diff nobody could explain.
   */
  it('omits absent fields entirely rather than setting them undefined', () => {
    const bare: PrintOption = {
      scryfallId: 'print-2',
      name: 'Mountain',
      imageUrl: 'https://img.example/m.png',
      thumbnailUrl: 'https://img.example/m-small.png',
    };
    const printing = printingFromOption(bare, '');
    expect(Object.keys(printing).sort()).toEqual(['imageUrl', 'scryfallId']);
    expect(JSON.parse(JSON.stringify(printing))).toEqual(printing);
  });
});

describe('choosing a printing for a deck slot', () => {
  const base = deckOf([
    { cardId: LIGHTNING_BOLT, count: 4 },
    { cardId: MOUNTAIN, count: 20 },
  ]);

  it('sets a printing on exactly one entry', () => {
    const next = withEntryPrinting(base, LIGHTNING_BOLT, RETRO);
    expect(entryPrintingOf(next, LIGHTNING_BOLT)).toEqual(RETRO);
    expect(entryPrintingOf(next, MOUNTAIN)).toBeUndefined();
  });

  it('never mutates the deck it was given', () => {
    const before = JSON.stringify(base);
    withEntryPrinting(base, LIGHTNING_BOLT, RETRO);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('leaves counts and card ids alone — a printing is art, not identity', () => {
    const next = withEntryPrinting(base, LIGHTNING_BOLT, RETRO);
    expect(next.cards.map((e) => [e.cardId, e.count])).toEqual(
      base.cards.map((e) => [e.cardId, e.count]),
    );
  });

  it('clears back to the default printing, removing the key outright', () => {
    const chosen = withEntryPrinting(base, LIGHTNING_BOLT, RETRO);
    const cleared = withoutEntryPrinting(chosen, LIGHTNING_BOLT);
    expect(entryPrintingOf(cleared, LIGHTNING_BOLT)).toBeUndefined();
    expect('printing' in cleared.cards[0]!).toBe(false);
  });

  it('is a no-op for a card that is not in the deck', () => {
    expect(withEntryPrinting(base, 'card-absent', RETRO)).toBe(base);
    expect(withoutEntryPrinting(base, 'card-absent')).toBe(base);
  });

  it('counts how many slots are on custom art', () => {
    expect(customPrintingCount(base)).toBe(0);
    const one = withEntryPrinting(base, LIGHTNING_BOLT, RETRO);
    expect(customPrintingCount(one)).toBe(1);
    expect(customPrintingCount(withEntryPrinting(one, MOUNTAIN, RETRO))).toBe(2);
  });

  it('recognises which option in the picker is the chosen one', () => {
    expect(isChosenPrinting(RETRO, 'print-retro')).toBe(true);
    expect(isChosenPrinting(RETRO, 'print-other')).toBe(false);
    expect(isChosenPrinting(undefined, 'print-retro')).toBe(false);
  });
});

describe('isEntryPrinting', () => {
  it('accepts a well-formed printing', () => {
    expect(isEntryPrinting(RETRO)).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'print-1'],
    ['no id', { imageUrl: 'https://img.example/x.png' }],
    ['no image', { scryfallId: 'print-1' }],
    ['an empty id', { scryfallId: '', imageUrl: 'https://img.example/x.png' }],
    ['an empty image', { scryfallId: 'print-1', imageUrl: '' }],
  ])('rejects %s', (_label, value) => {
    expect(isEntryPrinting(value)).toBe(false);
  });
});

/**
 * The round-trip is the whole reason `printing` rides along in the export: the
 * Deck Builder's Copy-JSON button is how a deck moves between machines, and a
 * copy that quietly dropped every art choice would be a silent data loss.
 */
describe('deck export/import carries chosen printings', () => {
  const deck = withEntryPrinting(
    deckOf([
      { cardId: LIGHTNING_BOLT, count: 4 },
      { cardId: MOUNTAIN, count: 20 },
    ]),
    LIGHTNING_BOLT,
    RETRO,
  );

  it('round-trips a chosen printing through JSON', () => {
    const reimported = fromExport(JSON.parse(JSON.stringify(toExport(deck))));
    expect(entryPrintingOf(reimported, LIGHTNING_BOLT)).toEqual(RETRO);
    expect(entryPrintingOf(reimported, MOUNTAIN)).toBeUndefined();
  });

  it('leaves an all-default deck’s export exactly as it always was', () => {
    const plain = deckOf([{ cardId: MOUNTAIN, count: 20 }]);
    expect(toExport(plain)).toEqual({
      name: 'Test',
      cards: [{ cardId: MOUNTAIN, count: 20 }],
    });
  });

  it('drops a malformed printing but keeps the card', () => {
    const reimported = fromExport({
      name: 'Broken',
      cards: [{ cardId: LIGHTNING_BOLT, count: 4, printing: { set: 'MH2' } }],
    });
    expect(reimported.cards).toEqual([{ cardId: LIGHTNING_BOLT, count: 4 }]);
  });
});

describe('deckPrintingOverrides (the Proxies bridge)', () => {
  const NAMES: Record<string, string> = {
    [LIGHTNING_BOLT]: 'Lightning Bolt',
    [MOUNTAIN]: 'Mountain',
  };
  const nameOf = (cardId: string): string | undefined => NAMES[cardId];

  const deck = withEntryPrinting(
    deckOf([
      { cardId: LIGHTNING_BOLT, count: 4 },
      { cardId: MOUNTAIN, count: 20 },
    ]),
    LIGHTNING_BOLT,
    RETRO,
  );

  it('emits one name-keyed printing override per chosen slot', () => {
    expect(deckPrintingOverrides(deck, nameOf)).toEqual([
      [
        'Lightning Bolt',
        {
          kind: 'printing',
          scryfallId: 'print-retro',
          imageUrl: 'https://img.example/retro.png',
          set: 'STA',
          label: 'STA · #123 · An Artist',
        },
      ],
    ]);
  });

  it('emits nothing for a deck that is all default art', () => {
    expect(deckPrintingOverrides(deckOf([{ cardId: MOUNTAIN, count: 20 }]), nameOf)).toEqual([]);
  });

  it('skips a slot whose card no longer resolves rather than guessing a name', () => {
    const orphan = withEntryPrinting(deckOf([{ cardId: 'card-gone', count: 1 }]), 'card-gone', RETRO);
    expect(deckPrintingOverrides(orphan, nameOf)).toEqual([]);
  });

  it('carries a double-faced printing’s back image to the sheet', () => {
    const dfc = withEntryPrinting(deck, MOUNTAIN, {
      scryfallId: 'print-dfc',
      imageUrl: 'https://img.example/front.png',
      backImageUrl: 'https://img.example/back.png',
    });
    const mountain = deckPrintingOverrides(dfc, nameOf).find(([name]) => name === 'Mountain');
    expect(mountain?.[1].backImageUrl).toBe('https://img.example/back.png');
  });
});
