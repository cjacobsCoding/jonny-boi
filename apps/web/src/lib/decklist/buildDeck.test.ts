/**
 * Build tests — the guarantee that importing a deck gives you THE DECK.
 *
 * The rule these pin down: a card the engine cannot play yet is still a card.
 * It goes in the deck, it is named in the result, and it is named again by
 * `validateDeck` — but it never reaches `importedDefinitions()`, which is the
 * one place where letting it through would corrupt a simulation.
 *
 * Before this, an imported deck silently lost every unsupported card and told
 * the user only a count, which produced a crippled list and no way to find out
 * which cards went missing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { parseDeckText } from './parse.js';
import { resolveDecklist } from './resolve.js';
import { buildDeckFromPlan } from './buildDeck.js';
import {
  clearImportedCards,
  importedDefinitions,
  unsupportedReason,
} from './importedCards.js';
import { validateDeck } from '../deck.js';
import type { FetchLike } from '../scryfall/collection.js';

/** A raw Scryfall payload for the fake endpoint. */
function scryfallCard(
  overrides: Record<string, unknown> & { name: string },
): Record<string, unknown> {
  return {
    oracle_id: `oracle:${overrides.name}`,
    id: `print:${overrides.name}`,
    mana_cost: '',
    cmc: 0,
    type_line: 'Creature — Human',
    oracle_text: '',
    power: '1',
    toughness: '1',
    colors: [],
    color_identity: [],
    keywords: [],
    set: 'tst',
    collector_number: '1',
    rarity: 'common',
    image_uris: { normal: 'https://example.test/card.jpg' },
    ...overrides,
  };
}

/** A fake `/cards/collection`: knows some cards, reports the rest not found. */
function fakeScryfall(known: ReadonlyArray<Record<string, unknown>>): FetchLike {
  const byName = new Map(known.map((card) => [String(card.name).toLowerCase(), card]));
  return async (_url, init) => {
    const body = JSON.parse(init.body ?? '{"identifiers":[]}') as {
      identifiers: Array<{ name: string }>;
    };
    const data: unknown[] = [];
    const notFound: Array<{ name: string }> = [];
    for (const identifier of body.identifiers) {
      const hit = byName.get(identifier.name.toLowerCase());
      if (hit) data.push(hit);
      else notFound.push({ name: identifier.name });
    }
    return { ok: true, status: 200, json: async () => ({ data, not_found: notFound }) };
  };
}

/** A planeswalker — real, well-known, and genuinely beyond the engine. */
const JACE = scryfallCard({
  name: 'Jace, the Mind Sculptor',
  mana_cost: '{2}{U}{U}',
  cmc: 4,
  type_line: 'Legendary Planeswalker — Jace',
  oracle_text: "+2: Look at the top card of target player's library.",
  power: null,
  toughness: null,
});

/** A deck mixing all three outcomes: curated, unsupported, and a typo. */
const MIXED_LIST = [
  '4 Lightning Bolt',
  '2 Jace, the Mind Sculptor',
  '1 Lightnin Bolt',
  '20 Mountain',
].join('\n');

describe('buildDeckFromPlan', () => {
  beforeEach(() => {
    clearImportedCards();
  });

  it('puts unsupported cards in the deck instead of silently dropping them', async () => {
    const { entries } = parseDeckText(MIXED_LIST);
    const plan = await resolveDecklist(entries, fakeScryfall([JACE]));
    const result = buildDeckFromPlan(plan, 'Mixed');

    // 4 Bolt + 20 Mountain + 2 Jace = 26 copies. The typo has no card to add.
    expect(result.imported).toBe(26);
    const jace = result.deck.cards.find((entry) => entry.cardId === 'oracle:Jace, the Mind Sculptor');
    expect(jace, 'the unsupported card is in the deck').toBeDefined();
    expect(jace!.count).toBe(2);
  });

  it('names the unsupported cards and the system each one needs', async () => {
    const { entries } = parseDeckText(MIXED_LIST);
    const plan = await resolveDecklist(entries, fakeScryfall([JACE]));
    const result = buildDeckFromPlan(plan);

    expect(result.unsupported).toBe(2);
    expect(result.unsupportedCards).toHaveLength(1);
    const [entry] = result.unsupportedCards;
    expect(entry!.name).toBe('Jace, the Mind Sculptor');
    expect(entry!.qty).toBe(2);
    expect(entry!.systems.join(' ')).toContain('planeswalker');
  });

  it('names every card Scryfall could not find, so a typo is fixable', async () => {
    const { entries } = parseDeckText(MIXED_LIST);
    const plan = await resolveDecklist(entries, fakeScryfall([JACE]));
    const result = buildDeckFromPlan(plan);

    expect(result.skippedNotFound).toBe(1);
    expect(result.notFoundNames).toEqual(['Lightnin Bolt']);
  });

  it('keeps unsupported cards out of the engine pool (the honesty chokepoint)', async () => {
    const { entries } = parseDeckText(MIXED_LIST);
    const plan = await resolveDecklist(entries, fakeScryfall([JACE]));
    buildDeckFromPlan(plan);

    // The card is importable and visible, but it can never enter a simulation.
    const ids = importedDefinitions().map((definition) => definition.id);
    expect(ids).not.toContain('oracle:Jace, the Mind Sculptor');
    expect(unsupportedReason('oracle:Jace, the Mind Sculptor')).toBeDefined();
  });

  it('reports the unsupported card by name from validateDeck', async () => {
    const { entries } = parseDeckText(MIXED_LIST);
    const plan = await resolveDecklist(entries, fakeScryfall([JACE]));
    const { deck } = buildDeckFromPlan(plan);

    const issues = validateDeck(deck);
    const unsupported = issues.filter((issue) => issue.severity === 'unsupported');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.message).toContain('Jace, the Mind Sculptor');
    expect(unsupported[0]!.message).toContain('planeswalker');
  });

  it('still excludes the sideboard from a maindeck-only deck', async () => {
    const { entries } = parseDeckText('4 Lightning Bolt\n\nSideboard\n2 Lightning Bolt');
    const plan = await resolveDecklist(entries, fakeScryfall([]));
    const result = buildDeckFromPlan(plan);

    expect(result.imported).toBe(4);
    expect(result.skippedSideboard).toBe(2);
  });
});
