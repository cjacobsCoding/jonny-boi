import { describe, expect, it } from 'vitest';
import { collectionQueryName, fetchCardCollection, type FetchLike } from './collection.js';

/** Bodies the fake Scryfall saw, so tests can assert what we actually asked for. */
interface Sent {
  readonly identifiers: Array<{ name: string; set?: string }>;
}

/**
 * A fake Scryfall modelling the two endpoints' different matching rules:
 *
 * - `/cards/collection` (POST) matches a card *face* name only — never the
 *   combined "Front // Back" name, and never an alternate printed name.
 * - `/cards/search` (GET) with `include_multilingual` also matches the
 *   alternate names Universes Beyond printings carry.
 *
 * @param faces        face name (lowercased) → the card's canonical name
 * @param printedNames alternate printed name (lowercased) → canonical name
 */
function fakeScryfall(
  faces: Record<string, string>,
  printedNames: Record<string, string> = {},
): { fetchImpl: FetchLike; sent: Sent[]; searched: string[] } {
  const sent: Sent[] = [];
  const searched: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (init.method === 'GET') {
      const query = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
      searched.push(query);
      // Scryfall's exact-name operator: !"Some Card".
      const wanted = query.replace(/^!"/, '').replace(/"$/, '').toLowerCase();
      const canonical = printedNames[wanted];
      if (!canonical) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: [{ name: canonical }] }) };
    }

    const body = JSON.parse(init.body ?? '{}') as Sent;
    sent.push(body);
    const data: unknown[] = [];
    const notFound: Array<{ name?: string }> = [];
    for (const identifier of body.identifiers) {
      const fullName = faces[identifier.name.toLowerCase()];
      if (fullName) data.push({ name: fullName });
      else notFound.push({ name: identifier.name });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data, not_found: notFound }),
    };
  };
  return { fetchImpl, sent, searched };
}

const NO_THROTTLE = { minIntervalMs: 0 };

describe('collectionQueryName', () => {
  it('reduces a combined split-card name to its front face', () => {
    expect(collectionQueryName('Wear // Tear')).toBe('Wear');
    expect(collectionQueryName('Fable of the Mirror-Breaker // Reflection of Kiki-Jiki')).toBe(
      'Fable of the Mirror-Breaker',
    );
  });

  it('leaves an ordinary name alone', () => {
    expect(collectionQueryName('Lightning Bolt')).toBe('Lightning Bolt');
  });

  it('does not split on a bare slash inside a name', () => {
    // Only " // " (spaced) separates faces; a card name may contain other slashes.
    expect(collectionQueryName('Borrowing 100,000 Arrows')).toBe('Borrowing 100,000 Arrows');
    expect(collectionQueryName('Wear//Tear')).toBe('Wear//Tear');
  });
});

describe('fetchCardCollection', () => {
  it('finds a split card written with its full "A // B" name', async () => {
    const { fetchImpl, sent } = fakeScryfall({ wear: 'Wear // Tear' });

    const result = await fetchCardCollection([{ name: 'Wear // Tear' }], fetchImpl, NO_THROTTLE);

    // The endpoint only matches the face, so that is what we must have asked for.
    expect(sent[0]?.identifiers).toEqual([{ name: 'Wear' }]);
    expect(result.cards).toEqual([{ name: 'Wear // Tear' }]);
    expect(result.notFound).toEqual([]);
  });

  it('collapses the front-face and combined spellings into one request', async () => {
    const { fetchImpl, sent } = fakeScryfall({ wear: 'Wear // Tear' });

    const result = await fetchCardCollection(
      [{ name: 'Wear // Tear' }, { name: 'Wear' }],
      fetchImpl,
      NO_THROTTLE,
    );

    expect(sent[0]?.identifiers).toEqual([{ name: 'Wear' }]);
    expect(result.cards).toHaveLength(1);
  });

  it('reports a miss under the name the user typed, not our rewritten query', async () => {
    const { fetchImpl } = fakeScryfall({});

    const result = await fetchCardCollection(
      [{ name: 'Nonesuch // Nothing' }],
      fetchImpl,
      NO_THROTTLE,
    );

    expect(result.notFound).toEqual(['Nonesuch // Nothing']);
  });

  it('keeps a pinned set code while rewriting the name', async () => {
    const { fetchImpl, sent } = fakeScryfall({ wear: 'Wear // Tear' });

    await fetchCardCollection([{ name: 'Wear // Tear', set: 'dgm' }], fetchImpl, NO_THROTTLE);

    expect(sent[0]?.identifiers).toEqual([{ name: 'Wear', set: 'dgm' }]);
  });

  it('recovers a card Scryfall files under a different name', async () => {
    // The om1 printing reads "Kavaero, Mind-Bitten"; Scryfall files it as
    // "Superior Spider-Man", and only search can see the printed name.
    const { fetchImpl, searched } = fakeScryfall(
      {},
      { 'kavaero, mind-bitten': 'Superior Spider-Man' },
    );

    const result = await fetchCardCollection(
      [{ name: 'Kavaero, Mind-Bitten' }],
      fetchImpl,
      NO_THROTTLE,
    );

    expect(searched).toEqual(['!"Kavaero, Mind-Bitten"']);
    expect(result.cards).toEqual([{ name: 'Superior Spider-Man' }]);
    expect(result.notFound).toEqual([]);
    // The caller indexes by card name, so it needs the tie back to the line.
    expect(result.aliases.get('kavaero, mind-bitten')).toBe('Superior Spider-Man');
  });

  it('leaves a genuine typo not-found instead of guessing a near match', async () => {
    const { fetchImpl } = fakeScryfall({}, { 'lightning bolt': 'Lightning Bolt' });

    const result = await fetchCardCollection([{ name: 'Lightnig Bolt' }], fetchImpl, NO_THROTTLE);

    expect(result.cards).toEqual([]);
    expect(result.notFound).toEqual(['Lightnig Bolt']);
  });

  it('never runs the recovery pass when everything resolved', async () => {
    const { fetchImpl, searched } = fakeScryfall({ 'lightning bolt': 'Lightning Bolt' });

    const result = await fetchCardCollection([{ name: 'Lightning Bolt' }], fetchImpl, NO_THROTTLE);

    expect(searched).toEqual([]);
    expect(result.aliases.size).toBe(0);
    expect(result.cards).toHaveLength(1);
  });

  it('reports every name in a failed batch as requested', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const result = await fetchCardCollection(
      [{ name: 'Wear // Tear' }, { name: 'Lightning Bolt' }],
      fetchImpl,
      NO_THROTTLE,
    );

    expect(result.notFound).toEqual(['Wear // Tear', 'Lightning Bolt']);
  });
});
