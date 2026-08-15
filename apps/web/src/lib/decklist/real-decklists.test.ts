/**
 * Regression guard on two REAL tournament decklists.
 *
 * The unit tests next door prove each import rule in isolation; this file
 * proves the rules still compose on the lists that actually broke. Both are
 * pasted verbatim, in the "Deck / Sideboard" shape MTGO and Moxfield export,
 * and between them they carry every name shape that has cost us a card:
 *
 *   - a split card written in full        "Wear // Tear"
 *   - a Universes Beyond printing         "Kavaero, Mind-Bitten"
 *   - double-faced cards named by front   "Ajani, Nacatl Pariah"
 *   - names containing commas, apostrophes, and hyphens
 *
 * Offline by construction: the fake Scryfall below mimics the one behaviour
 * that matters — `/cards/collection` matches a card *face* name and nothing
 * else, so combined and alternate names must be recovered by our own code.
 */
import { describe, expect, it } from 'vitest';
import { parseDeckText, totalCards, entriesInSection } from './parse.js';
import { fetchCardCollection, type FetchLike } from '../scryfall/collection.js';

const BOROS_ENERGY = `Deck
4 Ajani, Nacatl Pariah
4 Guide of Souls
4 Ocelot Pride
4 Phlage, Titan of Fire's Fury
4 Ragavan, Nimble Pilferer
3 Seasoned Pyromancer
2 Voice of Victory
2 Fable of the Mirror-Breaker
4 Galvanic Discharge
2 Thraben Charm
3 Goblin Bombardment
1 Blood Moon
4 Arid Mesa
4 Marsh Flats
4 Windswept Heath
3 Arena of Glory
3 Elegant Parlor
3 Sacred Foundry
2 Plains

Sideboard
2 Celestial Purge
2 Obsidian Charmaw
2 Wrath of the Skies
1 Clarion Conqueror
1 Containment Priest
1 Damping Sphere
1 High Noon
1 Meltdown
1 Soul-Guide Lantern
1 The Legend of Roku
1 Vexing Bauble
1 Wear // Tear`;

const GORYOS_VENGEANCE = `Deck
2 Griselbrand
4 Solitude
3 Fallaji Archaeologist
4 Atraxa, Grand Unifier
4 Psychic Frog
1 Quantum Riddler
1 Kavaero, Mind-Bitten
4 Goryo's Vengeance
4 Ephemerate
2 Force of Negation
2 Otherworldly Gaze
2 Faithful Mending
1 March of Otherworldly Light
3 Thoughtseize
2 Prismatic Ending
1 Island
1 Plains
1 Swamp
1 Overgrown Tomb
1 Godless Shrine
4 Marsh Flats
1 Hallowed Fountain
1 Watery Grave
4 Polluted Delta
1 Meticulous Archive
1 Shadowy Backstreet
1 Undercity Sewers
3 Flooded Strand

Sideboard
1 Surgical Extraction
1 Teferi, Time Raveler
2 Mystical Dispute
3 Consign to Memory
3 Wrath of the Skies
2 Clarion Conqueror
2 Quantum Riddler
1 Spell Snare`;

/**
 * Cards Scryfall files under a name the decklist does not use. The key is the
 * only name the collection endpoint answers to; the value is the card's real
 * name, exactly as Scryfall returns it.
 */
const MULTI_FACE_CARDS: Readonly<Record<string, string>> = {
  wear: 'Wear // Tear',
  'ajani, nacatl pariah': 'Ajani, Nacatl Pariah // Ajani, Nacatl Avenger',
  'fable of the mirror-breaker': 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki',
  'the legend of roku': 'The Legend of Roku // Avatar Roku',
};

/** Cards reachable only through the search endpoint, by their printed name. */
const ALTERNATE_NAME_CARDS: Readonly<Record<string, string>> = {
  'kavaero, mind-bitten': 'Superior Spider-Man',
};

/**
 * A Scryfall stand-in with the real endpoints' asymmetry: `/cards/collection`
 * matches face names only, while `/cards/search` also sees printed names.
 */
function fakeScryfall(): { fetchImpl: FetchLike; collectionRequests: string[][] } {
  const collectionRequests: string[][] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (init.method === 'GET') {
      // Recovery pass: q=!"<name>", URL-encoded.
      const query = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
      const wanted = query.replace(/^!?"|"$/g, '').toLowerCase();
      const realName = ALTERNATE_NAME_CARDS[wanted];
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: realName ? [{ name: realName, printed_name: wanted }] : [] }),
      };
    }

    const body = JSON.parse(init.body ?? '{"identifiers":[]}') as {
      identifiers: Array<{ name: string }>;
    };
    collectionRequests.push(body.identifiers.map((id) => id.name));
    const data: unknown[] = [];
    const notFound: Array<{ name: string }> = [];
    for (const identifier of body.identifiers) {
      const key = identifier.name.toLowerCase();
      // Anything not deliberately awkward resolves to itself.
      const known = MULTI_FACE_CARDS[key] ?? (ALTERNATE_NAME_CARDS[key] ? undefined : identifier.name);
      if (known) data.push({ name: known });
      else notFound.push({ name: identifier.name });
    }
    return { ok: true, status: 200, json: async () => ({ data, not_found: notFound }) };
  };
  return { fetchImpl, collectionRequests };
}

const DECKS = [
  { label: 'Boros Energy', text: BOROS_ENERGY, main: 60, sideboard: 15 },
  { label: "Goryo's Vengeance", text: GORYOS_VENGEANCE, main: 60, sideboard: 15 },
] as const;

describe.each(DECKS)('$label', ({ text, main, sideboard }) => {
  const parsed = parseDeckText(text);

  it('parses with no unrecognized lines', () => {
    expect(parsed.errors).toEqual([]);
  });

  it('splits maindeck and sideboard at the printed counts', () => {
    expect(totalCards(entriesInSection(parsed.entries, 'main'))).toBe(main);
    expect(totalCards(entriesInSection(parsed.entries, 'sideboard'))).toBe(sideboard);
  });

  it('files every line as maindeck or sideboard', () => {
    const strays = parsed.entries.filter(
      (entry) => entry.section !== 'main' && entry.section !== 'sideboard',
    );
    expect(strays).toEqual([]);
  });

  it('resolves every card name against Scryfall', async () => {
    const { fetchImpl } = fakeScryfall();

    const result = await fetchCardCollection(parsed.entries, fetchImpl, { minIntervalMs: 0 });

    expect(result.notFound).toEqual([]);
  });
});

describe('the name shapes that used to be dropped', () => {
  it('asks for a split card by its front face, not its combined name', async () => {
    const { fetchImpl, collectionRequests } = fakeScryfall();
    const parsed = parseDeckText(BOROS_ENERGY);

    const result = await fetchCardCollection(parsed.entries, fetchImpl, { minIntervalMs: 0 });

    expect(collectionRequests.flat()).toContain('Wear');
    expect(collectionRequests.flat()).not.toContain('Wear // Tear');
    expect(result.notFound).toEqual([]);
  });

  it('recovers a Universes Beyond printing the collection endpoint cannot see', async () => {
    const { fetchImpl } = fakeScryfall();
    const parsed = parseDeckText(GORYOS_VENGEANCE);

    const result = await fetchCardCollection(parsed.entries, fetchImpl, { minIntervalMs: 0 });

    expect(result.notFound).toEqual([]);
    expect(result.cards).toContainEqual(
      expect.objectContaining({ name: 'Superior Spider-Man' }),
    );
  });

  it('keeps a double-faced card that the list names by its front face', async () => {
    const { fetchImpl } = fakeScryfall();
    const parsed = parseDeckText(BOROS_ENERGY);

    const result = await fetchCardCollection(parsed.entries, fetchImpl, { minIntervalMs: 0 });

    expect(result.cards).toContainEqual(
      expect.objectContaining({ name: 'Ajani, Nacatl Pariah // Ajani, Nacatl Avenger' }),
    );
  });
});
