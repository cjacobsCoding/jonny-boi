import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createHeuristicPilot } from '@jonny-boi/ai';
import { loadDeck, validateDeck, DeckLoadError, type Deck } from './deck.js';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { DEFAULT_DECK_RULES } from './config.js';
import { runMatch } from './match.js';

const pool = loadCardPool({ onWarn: () => {} });

describe('loadDeck', () => {
  it('expands a deck by name into a flat library of the right size', () => {
    const deck: Deck = {
      name: 'tiny',
      archetype: 'test',
      cards: [
        { cardId: 'Lightning Bolt', count: 4 },
        { cardId: 'Mountain', count: 56 },
      ],
    };
    const loaded = loadDeck(deck, pool);
    expect(loaded.size).toBe(60);
    expect(loaded.library).toHaveLength(60);
    // The four Bolts are present.
    expect(loaded.library.filter((c) => c.name === 'Lightning Bolt')).toHaveLength(4);
  });

  it('accepts cards by Scryfall id as well as name', () => {
    const boltId = '4457ed35-7c10-48c8-9776-456485fdf070';
    const deck: Deck = {
      name: 'by-id',
      archetype: 'test',
      cards: [
        { cardId: boltId, count: 4 },
        { cardId: 'Mountain', count: 56 },
      ],
    };
    const loaded = loadDeck(deck, pool);
    expect(loaded.library.filter((c) => c.id === boltId)).toHaveLength(4);
  });

  it('rejects an unknown card id with a clear reason (no throw of a raw stack)', () => {
    const deck: Deck = {
      name: 'bad-card',
      archetype: 'test',
      cards: [
        { cardId: 'Black Lotus', count: 1 },
        { cardId: 'Mountain', count: 59 },
      ],
    };
    expect(() => loadDeck(deck, pool)).toThrow(DeckLoadError);
    const problems = validateDeck(deck, pool);
    expect(problems.some((p) => p.includes('Black Lotus'))).toBe(true);
  });

  // §3.123 — a web deck stores a PRINTING id. An imported printing the pool does
  // not carry used to make the whole deck unplayable with `unknown card
  // "f413a83d-…"`. The entry's recorded name now resolves it to the pool's
  // printing of the same card, and names the card when even that fails.
  describe('an entry whose id is not in the pool (§3.123)', () => {
    const forest = pool.getByName('Forest');
    if (!forest) throw new Error('the pool has no Forest');
    const UNKNOWN_PRINTING = 'f413a83d-a40d-434c-b20a-4c707c0527fa';

    it('resolves through its recorded name, so the deck PLAYS', () => {
      const deck: Deck = {
        name: 'other-printing',
        archetype: 'test',
        cards: [
          { cardId: UNKNOWN_PRINTING, count: 4, name: 'Forest' },
          { cardId: 'Forest', count: 56 },
        ],
      };
      const loaded = loadDeck(deck, pool);
      expect(loaded.size).toBe(60);
      // Every copy is the pool's Forest — the same card, the pool's printing.
      expect(loaded.library.filter((c) => c.id === forest.id)).toHaveLength(60);
    });

    it('names the CARD, not the uuid, when the name is unknown too', () => {
      const deck: Deck = {
        name: 'truly-missing',
        archetype: 'test',
        cards: [
          // A name no pool will ever carry — a real card's name might resolve
          // (the pool grows), which is the feature, not a failure of it.
          { cardId: UNKNOWN_PRINTING, count: 4, name: 'Definitely Not A Card' },
          { cardId: 'Forest', count: 56 },
        ],
      };
      const problems = validateDeck(deck, pool);
      expect(problems.some((p) => p.includes('Definitely Not A Card'))).toBe(true);
      // The id is still there for anyone debugging, but it is not the headline.
      expect(problems.some((p) => p.includes(UNKNOWN_PRINTING))).toBe(true);
    });

    it('a legacy entry with no name still reports the id it has', () => {
      const deck: Deck = {
        name: 'legacy',
        archetype: 'test',
        cards: [
          { cardId: UNKNOWN_PRINTING, count: 4 },
          { cardId: 'Forest', count: 56 },
        ],
      };
      const problems = validateDeck(deck, pool);
      expect(problems.some((p) => p.includes(UNKNOWN_PRINTING))).toBe(true);
    });

    it('the id still wins when it resolves — the name is a fallback, not an override', () => {
      const mountain = pool.getByName('Mountain');
      if (!mountain) throw new Error('the pool has no Mountain');
      const deck: Deck = {
        name: 'id-wins',
        archetype: 'test',
        cards: [
          // A stale or wrong name must not redirect a perfectly good id.
          { cardId: mountain.id, count: 4, name: 'Forest' },
          { cardId: 'Forest', count: 56 },
        ],
      };
      const loaded = loadDeck(deck, pool);
      expect(loaded.library.filter((c) => c.id === mountain.id)).toHaveLength(4);
    });
  });

  it('rejects an undersized deck', () => {
    const deck: Deck = {
      name: 'too-small',
      archetype: 'test',
      cards: [{ cardId: 'Mountain', count: 40 }],
    };
    const problems = validateDeck(deck, pool);
    expect(problems.some((p) => p.includes('below the minimum'))).toBe(true);
  });

  it('enforces the 4-of limit for non-basics but allows unlimited basics', () => {
    const tooMany: Deck = {
      name: 'five-bolts',
      archetype: 'test',
      cards: [
        { cardId: 'Lightning Bolt', count: 5 },
        { cardId: 'Mountain', count: 55 },
      ],
    };
    expect(validateDeck(tooMany, pool).some((p) => p.includes('4-of'))).toBe(true);

    // 60 Mountains is legal (basics are exempt).
    const allBasics: Deck = {
      name: 'all-mountains',
      archetype: 'test',
      cards: [{ cardId: 'Mountain', count: 60 }],
    };
    expect(validateDeck(allBasics, pool)).toHaveLength(0);
  });
});

describe('SAMPLE_DECKS', () => {
  it('are all legal under the default rules', () => {
    expect(SAMPLE_DECKS.length).toBeGreaterThanOrEqual(4);
    for (const deck of SAMPLE_DECKS) {
      const problems = validateDeck(deck, pool, DEFAULT_DECK_RULES);
      expect(problems, `${deck.name}: ${problems.join('; ')}`).toHaveLength(0);
    }
  });

  it('all expand to exactly the minimum deck size', () => {
    for (const deck of SAMPLE_DECKS) {
      const loaded = loadDeck(deck, pool);
      expect(loaded.size, deck.name).toBe(DEFAULT_DECK_RULES.minDeckSize);
    }
  });

  it('provides at least five gauntlet decks with distinct names and archetypes', () => {
    // DESIGN §3.8: the polished gauntlet is a spread of distinct identities, so a
    // hero deck is measured against a real meta, not five copies of one plan.
    expect(SAMPLE_DECKS.length).toBeGreaterThanOrEqual(5);
    const names = new Set(SAMPLE_DECKS.map((d) => d.name));
    expect(names.size, 'deck names must be unique').toBe(SAMPLE_DECKS.length);
    const archetypes = new Set(SAMPLE_DECKS.map((d) => d.archetype));
    expect(archetypes.size, 'every gauntlet deck must have a distinct archetype').toBe(
      SAMPLE_DECKS.length,
    );
  });

  it('every gauntlet deck can complete a game against another without erroring', () => {
    // A cheap, deterministic smoke test: pair each deck with the next one (wrapping)
    // and play a single seeded game. We don't assert WHO wins — only that every list
    // resolves to a finished (or cleanly timed-out) game with no thrown error, so a
    // broken/unplayable list is caught here rather than in the gauntlet.
    const registry = buildRegistry();
    const pilot = createHeuristicPilot();
    const loaded = SAMPLE_DECKS.map((d) => loadDeck(d, pool));
    for (let i = 0; i < loaded.length; i++) {
      const a = loaded[i]!;
      const b = loaded[(i + 1) % loaded.length]!;
      const result = runMatch(
        { deckA: a, deckB: b, pilotA: pilot, pilotB: pilot, registry },
        // A fixed per-pair seed keeps the test deterministic and fast.
        1000 + i,
      );
      expect(['win', 'timeout'], `${a.name} vs ${b.name}`).toContain(result.outcome.kind);
      expect(result.turns, `${a.name} vs ${b.name} made progress`).toBeGreaterThan(0);
    }
  });
});
