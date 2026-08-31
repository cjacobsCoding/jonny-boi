import { describe, expect, it } from 'vitest';
import { getCard, isBasicLand } from './cards.js';
import {
  addCard,
  removeCard,
  countOf,
  deckSize,
  createDeck,
  groupByType,
  manaCurve,
  validateDeck,
  toExport,
  fromExport,
  maxCopiesFor,
} from './deck.js';
import { MAX_COPIES_PER_CARD, MIN_DECK_SIZE, MANA_CURVE_BUCKETS } from './config.js';

// Real cards from the bundled curated pool (ids are stable Scryfall UUIDs).
const BIRDS_ID = 'd3a0b660-358c-41bd-9cd2-41fbf3491b1a'; // Creature, cmc 1, green
const COUNTERSPELL_ID = 'cc187110-1148-4090-bbb8-e205694a39f5'; // Instant, cmc 2, blue
const FOREST_ID = 'b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6'; // Basic Land

const birds = getCard(BIRDS_ID)!;
const counterspell = getCard(COUNTERSPELL_ID)!;
const forest = getCard(FOREST_ID)!;

describe('card pool', () => {
  it('resolves the seeded card ids', () => {
    expect(birds.name).toBe('Birds of Paradise');
    expect(counterspell.name).toBe('Counterspell');
    expect(isBasicLand(forest)).toBe(true);
    expect(isBasicLand(birds)).toBe(false);
  });
});

describe('addCard / removeCard with the 4-of rule', () => {
  it('adds copies up to the per-card limit and no further', () => {
    let deck = createDeck('Test');
    for (let i = 0; i < MAX_COPIES_PER_CARD + 2; i += 1) {
      deck = addCard(deck, birds);
    }
    expect(countOf(deck, BIRDS_ID)).toBe(MAX_COPIES_PER_CARD);
    expect(deckSize(deck)).toBe(MAX_COPIES_PER_CARD);
  });

  it('exempts basic lands from the 4-of rule', () => {
    expect(maxCopiesFor(forest)).toBe(Number.POSITIVE_INFINITY);
    let deck = createDeck('Lands');
    for (let i = 0; i < 20; i += 1) deck = addCard(deck, forest);
    expect(countOf(deck, FOREST_ID)).toBe(20);
  });

  it('removes copies and drops the entry at zero', () => {
    let deck = createDeck('Test');
    deck = addCard(deck, counterspell);
    deck = addCard(deck, counterspell);
    expect(countOf(deck, COUNTERSPELL_ID)).toBe(2);
    deck = removeCard(deck, COUNTERSPELL_ID);
    expect(countOf(deck, COUNTERSPELL_ID)).toBe(1);
    deck = removeCard(deck, COUNTERSPELL_ID);
    expect(countOf(deck, COUNTERSPELL_ID)).toBe(0);
    expect(deck.cards.find((e) => e.cardId === COUNTERSPELL_ID)).toBeUndefined();
  });

  it('treats add/remove as immutable updates', () => {
    const deck = createDeck('Test');
    const next = addCard(deck, birds);
    expect(deck.cards).toHaveLength(0);
    expect(next.cards).toHaveLength(1);
  });
});

describe('groupByType', () => {
  it('groups resolved entries by primary type with per-group counts', () => {
    let deck = createDeck('Mixed');
    deck = addCard(deck, birds); // Creature
    deck = addCard(deck, counterspell); // Instant
    deck = addCard(deck, counterspell);
    deck = addCard(deck, forest); // Land
    const groups = groupByType(deck);
    const byType = Object.fromEntries(groups.map((g) => [g.type, g.count]));
    expect(byType.Creature).toBe(1);
    expect(byType.Instant).toBe(2);
    expect(byType.Land).toBe(1);
    // Creature group sorts before Land in the canonical order.
    expect(groups[0]!.type).toBe('Creature');
  });
});

describe('manaCurve', () => {
  it('counts non-land cards per CMC bucket and excludes lands', () => {
    let deck = createDeck('Curve');
    deck = addCard(deck, birds); // cmc 1
    deck = addCard(deck, birds);
    deck = addCard(deck, counterspell); // cmc 2
    deck = addCard(deck, forest); // land — excluded
    const curve = manaCurve(deck);
    expect(curve).toHaveLength(MANA_CURVE_BUCKETS.length);
    const at = (b: number) => curve.find((bar) => bar.bucket === b)!.count;
    expect(at(1)).toBe(2);
    expect(at(2)).toBe(1);
    expect(at(0)).toBe(0);
    // Lands contribute nothing to the curve.
    const total = curve.reduce((s, bar) => s + bar.count, 0);
    expect(total).toBe(3);
  });

  it('folds high mana values into the top bucket', () => {
    const curve = manaCurve(createDeck('Empty'));
    expect(curve[curve.length - 1]!.label).toBe('7+');
  });
});

describe('validateDeck', () => {
  it('flags an under-sized deck as a warning', () => {
    const deck = createDeck('Small');
    const issues = validateDeck(deck);
    expect(issues.some((i) => i.message.includes(String(MIN_DECK_SIZE)))).toBe(true);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('flags over-limit copies as an error', () => {
    const deck = createDeck('Illegal');
    deck.cards.push({ cardId: BIRDS_ID, count: MAX_COPIES_PER_CARD + 1 });
    const issues = validateDeck(deck);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });
});

describe('export / import round-trip', () => {
  it('exports the sim-compatible {name, cards:[{cardId,count}]} shape', () => {
    let deck = createDeck('Export Me');
    deck = addCard(deck, birds);
    deck = addCard(deck, counterspell);
    const exported = toExport(deck);
    expect(exported.name).toBe('Export Me');
    const entry = exported.cards.find((card) => card.cardId === BIRDS_ID);
    expect(entry).toBeDefined();
    expect(entry!.count).toBe(1);
    // cardId must be the Scryfall UUID for sim compatibility.
    expect(exported.cards[0]!.cardId).toMatch(/^[0-9a-f-]{36}$/);
    // `cardId` + `count` are the contract; anything else is additive and the sim
    // ignores it. Asserted as a WHITELIST rather than exact equality so a future
    // additive field is a deliberate edit here, not a silent shape change —
    // `name` was added exactly this way (see deck-entry-names.test.ts).
    for (const card of exported.cards) {
      expect(Object.keys(card).sort()).toEqual(['cardId', 'count', 'name']);
    }
  });

  it('carries the card name so an unresolvable id can still be named', () => {
    let deck = createDeck('Export Me');
    deck = addCard(deck, birds);
    expect(toExport(deck).cards[0]!.name).toBe(birds.name);
  });

  it('imports a valid export back into a deck', () => {
    const imported = fromExport({ name: 'In', cards: [{ cardId: BIRDS_ID, count: 3 }] });
    expect(imported.name).toBe('In');
    expect(countOf(imported, BIRDS_ID)).toBe(3);
  });

  it('rejects malformed JSON with a descriptive error', () => {
    expect(() => fromExport(null)).toThrow();
    expect(() => fromExport({ name: 'x' })).toThrow();
  });

  it('skips junk entries on import rather than corrupting the deck', () => {
    const imported = fromExport({
      name: 'Dirty',
      cards: [{ cardId: BIRDS_ID, count: 2 }, { nope: true }, { cardId: 5, count: 1 }],
    });
    expect(imported.cards).toHaveLength(1);
  });
});
