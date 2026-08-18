/**
 * Resolver tests — the guarantee that import produces REAL cards.
 *
 * The fetch is faked with Scryfall-shaped payloads, so these assert the whole
 * chain (fetch → normalize → compile → classify) without a network call: a
 * curated card keeps its hand-authored definition, a compilable card becomes
 * playable, and a card the engine cannot honestly run is BLOCKED rather than
 * imported as a hollow body.
 */

import { describe, expect, it } from 'vitest';
import { blockedByEngineSystem, isPlayable, resolveDecklist } from './resolve.js';
import { parseDeckText } from './parse.js';
import type { FetchLike } from '../scryfall/collection.js';

/** Build a raw Scryfall card payload for the fake endpoint. */
function scryfallCard(overrides: Record<string, unknown> & { name: string }): Record<string, unknown> {
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

/**
 * A fake `/cards/collection` endpoint: returns the cards it knows and reports
 * the rest as not found, exactly like Scryfall does.
 */
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
    return {
      ok: true,
      status: 200,
      json: async () => ({ data, not_found: notFound }),
    };
  };
}

describe('resolveDecklist', () => {
  it('uses the curated pool for cards the app already ships', async () => {
    const { entries } = parseDeckText('4 Lightning Bolt\n20 Mountain');
    const plan = await resolveDecklist(entries, fakeScryfall([]));

    expect(plan.lines.map((line) => line.status)).toEqual(['pool', 'pool']);
    // The hand-authored definition is what gets used, not a compiled guess.
    expect(plan.lines[0]!.definition?.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 3 } },
    ]);
    expect(plan.counts).toEqual({ total: 24, playable: 24, blocked: 0, notFound: 0 });
  });

  it('compiles an outside card into a genuinely playable definition', async () => {
    const { entries } = parseDeckText('2 Baneslayer Angel');
    const plan = await resolveDecklist(
      entries,
      fakeScryfall([
        scryfallCard({
          name: 'Baneslayer Angel',
          mana_cost: '{3}{W}{W}',
          cmc: 5,
          type_line: 'Creature — Angel',
          oracle_text: 'Flying, vigilance',
          power: '4',
          toughness: '4',
          keywords: ['Flying', 'Vigilance'],
        }),
      ]),
    );

    const [line] = plan.lines;
    expect(line!.status).toBe('compiled');
    expect(isPlayable(line!)).toBe(true);
    expect(line!.definition).toMatchObject({
      name: 'Baneslayer Angel',
      types: ['creature'],
      cost: { generic: 3, W: 2 },
      power: 4,
      toughness: 4,
      keywords: { flying: true, vigilance: true },
    });
    expect(plan.counts.playable).toBe(2);
  });

  it('blocks a card whose text the engine cannot honestly run', async () => {
    const { entries } = parseDeckText('1 Jace, the Mind Sculptor');
    const plan = await resolveDecklist(
      entries,
      fakeScryfall([
        scryfallCard({
          name: 'Jace, the Mind Sculptor',
          mana_cost: '{2}{U}{U}',
          cmc: 4,
          type_line: 'Legendary Planeswalker — Jace',
          oracle_text: '+2: Look at the top card of target player\'s library.',
          power: null,
          toughness: null,
        }),
      ]),
    );

    const [line] = plan.lines;
    expect(line!.status).toBe('blocked');
    expect(isPlayable(line!)).toBe(false);
    expect(line!.missing?.length).toBeGreaterThan(0);
    // The display record is still available, so the UI can show the real card.
    expect(line!.card?.name).toBe('Jace, the Mind Sculptor');
    expect(plan.counts).toMatchObject({ playable: 0, blocked: 1 });
  });

  it('reports a name Scryfall does not know', async () => {
    const { entries } = parseDeckText('1 Definitely Not A Card');
    const plan = await resolveDecklist(entries, fakeScryfall([]));

    expect(plan.lines[0]!.status).toBe('notFound');
    expect(plan.counts.notFound).toBe(1);
  });

  it('groups blocked cards by the engine system they need', async () => {
    const { entries } = parseDeckText('1 Jace, the Mind Sculptor\n1 Gideon Jura');
    const plan = await resolveDecklist(
      entries,
      fakeScryfall([
        scryfallCard({
          name: 'Jace, the Mind Sculptor',
          type_line: 'Legendary Planeswalker — Jace',
          oracle_text: '+2: Look at the top card of target player\'s library.',
          power: null,
          toughness: null,
        }),
        scryfallCard({
          name: 'Gideon Jura',
          type_line: 'Legendary Planeswalker — Gideon',
          oracle_text:
            "+2: During target opponent's next turn, creatures that player controls attack Gideon Jura if able.",
          power: null,
          toughness: null,
        }),
      ]),
    );

    const grouped = blockedByEngineSystem(plan);
    expect(grouped.length).toBeGreaterThan(0);
    // Both fixture walkers lack a printed-loyalty number in their record, so
    // they group under that shared gap (their ability BODIES differ, so the
    // loyalty-template gap would not group them together).
    const loyalty = grouped.find((group) => group.system.includes('starting-loyalty'));
    expect(loyalty?.cards).toEqual(['Gideon Jura', 'Jace, the Mind Sculptor']);
  });

  it('keeps sideboard lines separate from the maindeck', async () => {
    const { entries } = parseDeckText('4 Lightning Bolt\nSideboard\n2 Counterspell');
    const plan = await resolveDecklist(entries, fakeScryfall([]));

    expect(plan.lines.map((line) => line.section)).toEqual(['main', 'sideboard']);
  });

  it('asks Scryfall for each distinct name only once', async () => {
    let requests = 0;
    const counting: FetchLike = async (url, init) => {
      requests += 1;
      return fakeScryfall([scryfallCard({ name: 'Baneslayer Angel' })])(url, init);
    };
    const { entries } = parseDeckText('2 Baneslayer Angel\n2 Baneslayer Angel\n1 Baneslayer Angel');
    await resolveDecklist(entries, counting);

    expect(requests).toBe(1);
  });
});
