/**
 * À-la-carte card adding: the fuzzy lookup, the fidelity screening, and the
 * unsupported-mechanic work queue.
 *
 * Every path is driven against stub Scryfall responses — no network — and the
 * screening half runs the REAL compiler, so a card that compiles here genuinely
 * plays and a card reported unplayable genuinely has no implementation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addCardByName, describeAddResult } from './addSingleCard.js';
import { lookupCardByName, suggestCardNames, MAX_NAME_SUGGESTIONS } from '../scryfall/named.js';
import {
  clearUnsupportedMechanics,
  formatUnsupportedReport,
  recordUnsupported,
  unsupportedMechanics,
  unsupportedMechanicCount,
} from './unsupportedRegistry.js';
import { clearImportedCards, importedCards, importedDefinitions, unsupportedReason } from '../decklist/importedCards.js';
import type { FetchLike } from '../scryfall/collection.js';

/**
 * A raw Scryfall card object, in the shape `normalizeCard` expects. The default
 * name is deliberately NOT a real card: adding checks the curated pool by name,
 * so a fixture named after a pool card (it was 'Grizzly Bears' until the pool
 * grew one) stops reading as "new" the day the pool absorbs it.
 */
function rawCard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'Grizzled Test Bears',
    mana_cost: '{1}{G}',
    cmc: 2,
    type_line: 'Creature — Bear',
    oracle_text: '',
    power: '2',
    toughness: '2',
    colors: ['G'],
    color_identity: ['G'],
    keywords: [],
    rarity: 'common',
    set: 'tst',
    set_name: 'Test',
    collector_number: '1',
    legalities: {},
    image_uris: { normal: 'https://example.test/n.jpg' },
    ...over,
  };
}

/** A stub fetch that answers each URL from a table. */
function stubFetch(
  routes: { match: RegExp; status?: number; body: unknown }[],
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => r.match.test(url));
    if (!route) return { ok: false, status: 500, json: async () => ({}) };
    const status = route.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => route.body };
  }) as unknown as FetchLike & { calls: string[] };
  impl.calls = calls;
  return impl;
}

/** No pacing delay in tests — the etiquette floor is exercised in production. */
const NO_WAIT = { minIntervalMs: 0 };

beforeEach(() => {
  clearImportedCards();
  clearUnsupportedMechanics();
});

describe('fuzzy name lookup', () => {
  it('finds a card from an approximate, wrongly-cased name', async () => {
    const fetchImpl = stubFetch([{ match: /cards\/named/, body: rawCard() }]);
    const result = await lookupCardByName('grizled test bears', fetchImpl, NO_WAIT);
    expect(result.kind).toBe('found');
    // It must use the FUZZY parameter — exact matching is what deck import does,
    // and it would reject this spelling outright.
    expect(fetchImpl.calls[0]).toContain('fuzzy=');
  });

  it('reports an ambiguous guess WITH real suggestions instead of failing', async () => {
    const fetchImpl = stubFetch([
      { match: /cards\/named/, status: 404, body: { details: 'Too many cards match ambiguous name "bolt".' } },
      { match: /autocomplete/, body: { data: ['Lightning Bolt', 'Bolt Bend', 'Chain Lightning'] } },
    ]);
    const result = await lookupCardByName('bolt', fetchImpl, NO_WAIT);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') expect(result.suggestions).toContain('Lightning Bolt');
  });

  it('distinguishes a genuine miss from an ambiguous one', async () => {
    const fetchImpl = stubFetch([
      { match: /cards\/named/, status: 404, body: { details: 'No cards found matching "zzzzz".' } },
    ]);
    const result = await lookupCardByName('zzzzz', fetchImpl, NO_WAIT);
    expect(result.kind).toBe('notFound');
  });

  it('surfaces a transport failure as retryable rather than "no such card"', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as FetchLike;
    const result = await lookupCardByName('Lightning Bolt', fetchImpl, NO_WAIT);
    expect(result.kind).toBe('error');
  });

  it('an empty query never reaches the network', async () => {
    const fetchImpl = stubFetch([{ match: /./, body: {} }]);
    const result = await lookupCardByName('   ', fetchImpl, NO_WAIT);
    expect(result.kind).toBe('notFound');
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('caps how many suggestions it offers', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `Card ${i}`);
    const fetchImpl = stubFetch([{ match: /autocomplete/, body: { data: many } }]);
    const names = await suggestCardNames('c', fetchImpl, NO_WAIT);
    expect(names.length).toBeLessThanOrEqual(MAX_NAME_SUGGESTIONS);
  });
});

describe('adding a card to the pool', () => {
  it('adds a fully-supported card and makes it available to the engine', async () => {
    const fetchImpl = stubFetch([{ match: /cards\/named/, body: rawCard() }]);
    const result = await addCardByName('grizled test bears', fetchImpl, NO_WAIT);

    expect(result.kind).toBe('added');
    // A vanilla creature compiles completely, so it reaches the engine pool.
    const ids = importedDefinitions().map((d) => d.id);
    expect(ids).toContain('11111111-2222-3333-4444-555555555555');
  });

  it('reports a card it cannot play, keeps it, and files the engine gap', async () => {
    // Real printed text with no implementation: a loyalty-ability planeswalker.
    const fetchImpl = stubFetch([
      {
        match: /cards\/named/,
        body: rawCard({
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          name: 'Test Walker',
          type_line: 'Legendary Planeswalker — Test',
          oracle_text: '+1: Draw a card.\n−7: You get an emblem with "You have no maximum hand size."',
          power: null,
          toughness: null,
        }),
      },
    ]);

    const result = await addCardByName('Test Walker', fetchImpl, NO_WAIT);
    expect(result.kind).toBe('addedUnplayable');

    // Kept as a real card, but NEVER reachable by a simulation.
    expect(importedDefinitions().map((d) => d.id)).not.toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(unsupportedReason('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeDefined();

    // And the gap is now on the work queue rather than lost in a toast.
    expect(unsupportedMechanicCount()).toBeGreaterThan(0);
    expect(unsupportedMechanics()[0]!.cards).toContain('Test Walker');
  });

  it('recognises a card already in the curated pool instead of re-adding it', async () => {
    // Lightning Bolt ships in the curated pool under this Scryfall id.
    const fetchImpl = stubFetch([
      {
        match: /cards\/named/,
        body: rawCard({
          id: '4457ed35-7c10-48c8-9776-456485fdf070',
          name: 'Lightning Bolt',
          type_line: 'Instant',
          oracle_text: 'Lightning Bolt deals 3 damage to any target.',
          power: null,
          toughness: null,
          mana_cost: '{R}',
        }),
      },
    ]);
    const result = await addCardByName('lightning bolt', fetchImpl, NO_WAIT);
    expect(result.kind).toBe('alreadyKnown');
  });

  it('recognises a DIFFERENT PRINTING of a curated card and refuses to duplicate it', async () => {
    // The fuzzy endpoint returns Scryfall's default printing, whose id rarely
    // matches the printing the pool ships. Same name = same card: adding it must
    // not create a second, identical row in the card browser (the "two Acidic
    // Slimes" bug).
    const fetchImpl = stubFetch([
      {
        match: /cards\/named/,
        body: rawCard({
          id: '99999999-8888-7777-6666-555555555555', // NOT the pool's printing
          name: 'Lightning Bolt',
          type_line: 'Instant',
          oracle_text: 'Lightning Bolt deals 3 damage to any target.',
          power: null,
          toughness: null,
          mana_cost: '{R}',
        }),
      },
    ]);
    const result = await addCardByName('lightning bolt', fetchImpl, NO_WAIT);
    expect(result.kind).toBe('alreadyKnown');
    // The answer names the record we already have — the curated printing.
    if (result.kind === 'alreadyKnown') {
      expect(result.card.id).toBe('4457ed35-7c10-48c8-9776-456485fdf070');
    }
    // And nothing entered the import store.
    expect(importedCards()).toHaveLength(0);
  });

  it('passes an ambiguous name straight through with its suggestions', async () => {
    const fetchImpl = stubFetch([
      { match: /cards\/named/, status: 404, body: { details: 'Too many cards match ambiguous name "bolt".' } },
      { match: /autocomplete/, body: { data: ['Lightning Bolt'] } },
    ]);
    const result = await addCardByName('bolt', fetchImpl, NO_WAIT);
    expect(result.kind).toBe('ambiguous');
    expect(describeAddResult(result)).toContain('Lightning Bolt');
  });

  it('every outcome has a human-readable message', async () => {
    const outcomes = [
      { kind: 'notFound', query: 'zzz' },
      { kind: 'error', message: 'boom' },
    ] as const;
    for (const outcome of outcomes) {
      expect(describeAddResult(outcome).length).toBeGreaterThan(0);
    }
  });
});

describe('the unsupported-mechanic work queue', () => {
  it('groups blocked cards by the SYSTEM they need, most-wanted first', () => {
    recordUnsupported('Card A', [{ text: 'choose one —', missingEngineSystem: 'modal spells' }]);
    recordUnsupported('Card B', [{ text: 'choose one —', missingEngineSystem: 'modal spells' }]);
    recordUnsupported('Card C', [{ text: '+1: draw', missingEngineSystem: 'planeswalker loyalty' }]);

    const queue = unsupportedMechanics();
    expect(queue[0]!.system).toBe('modal spells'); // blocks 2 cards, so it's first
    expect(queue[0]!.cards).toEqual(['Card A', 'Card B']);
    expect(queue.map((m) => m.system)).toContain('planeswalker loyalty');
  });

  it('does not double-count a card added twice', () => {
    const clause = [{ text: 'x', missingEngineSystem: 'modal spells' }];
    recordUnsupported('Card A', clause);
    recordUnsupported('Card A', clause);
    expect(unsupportedMechanics()[0]!.cards).toEqual(['Card A']);
  });

  it('exports a Markdown report with the work item, its cards, and an example', () => {
    recordUnsupported('Test Walker', [{ text: '+1: Draw a card.', missingEngineSystem: 'planeswalker loyalty' }]);
    const report = formatUnsupportedReport();
    expect(report).toContain('## planeswalker loyalty');
    expect(report).toContain('Test Walker');
    expect(report).toContain('+1: Draw a card.');
  });

  it('says so plainly when nothing is blocked', () => {
    expect(formatUnsupportedReport([])).toContain('None');
  });
});
