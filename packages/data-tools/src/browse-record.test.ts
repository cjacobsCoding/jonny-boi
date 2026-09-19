/**
 * THE BROWSE RECORD IS LOSSLESS, and it is SMALL — both measured on the real index.
 *
 * Every card in the committed canonical index goes through `pack` then `unpack`
 * and must come back deep-equal on every field the app reads. That is the whole
 * contract: a packed index that dropped a fact for one layout out of fourteen
 * would look fine in the browser and lie in the deck builder.
 *
 * The size half is a BUDGET, not a boast: the reason this shape exists is that
 * 32,341 cards at the full record's ~1,564 B each is 48 MB, so a change that
 * quietly fattened the record past its budget would defeat the point in a way
 * no round-trip could notice.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CardIndex, NormalizedCard } from './types.js';
import {
  browseImageUris,
  imageIdOf,
  packBrowseRecord,
  packManaCost,
  unpackBrowseRecord,
} from './browse-record.js';
import { parseManaCost } from './parse.js';

const INDEX_PATH = fileURLToPath(new URL('../data/card-index.json', import.meta.url));
const INDEX = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as CardIndex;

/**
 * The fields the round trip must preserve. `localImages` is deliberately NOT
 * here: it is a per-machine cache path and the browse index never carries one.
 * Everything else a `NormalizedCard` has is listed, so a field added to the type
 * and forgotten here still fails — the whole-object comparison below sees it.
 */
function comparable(card: NormalizedCard): Omit<NormalizedCard, 'localImages'> & { imageUris: Record<string, string> } {
  const { localImages: _drop, ...rest } = card;
  // Cache-buster queries are not facts about the card; strip before comparing.
  const imageUris: Record<string, string> = {};
  for (const [size, url] of Object.entries(card.imageUris)) {
    if (typeof url === 'string') imageUris[size] = url.split('?')[0] as string;
  }
  return { ...rest, imageUris, faces: rest.faces.map((f) => ({ ...f, imageUris: stripQueries(f.imageUris) })) };
}

function stripQueries(uris: NormalizedCard['imageUris']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [size, url] of Object.entries(uris)) if (typeof url === 'string') out[size] = url.split('?')[0] as string;
  return out;
}

/** Per-card byte cost of the packed form, as JSON — what the wire and the disk see. */
function packedBytes(card: NormalizedCard): number {
  return Buffer.byteLength(JSON.stringify(packBrowseRecord(card)), 'utf8');
}

/** The budget: measured 2026-09-18 at ~420 B/card on this index; the ceiling leaves room, not slack. */
const PACKED_BYTES_PER_CARD_BUDGET = 520;

describe('the browse record round-trips the whole canonical index', () => {
  it('is a real index, not an empty file passing vacuously', () => {
    expect(INDEX.cards.length).toBeGreaterThan(6000);
  });

  it('every card comes back deep-equal on every field the app reads', () => {
    const failures: string[] = [];
    for (const card of INDEX.cards) {
      const back = unpackBrowseRecord(packBrowseRecord(card));
      const want = comparable(card);
      const got = comparable(back);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        // Name the first differing field, so a failure is actionable from the log.
        const key = (Object.keys(want) as (keyof typeof want)[]).find(
          (k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]),
        );
        failures.push(`${card.name} (${card.layout ?? 'normal'}): ${String(key)} — want ${JSON.stringify(want[key!])?.slice(0, 80)} got ${JSON.stringify(got[key!])?.slice(0, 80)}`);
      }
    }
    expect(failures, `${failures.length} of ${INDEX.cards.length} cards did not survive:\n${failures.slice(0, 12).join('\n')}`).toEqual([]);
  });

  it('covers every layout the index prints, not only "normal"', () => {
    // A codec proven on 31,000 normal cards and zero sagas is not proven.
    const layouts = new Set(INDEX.cards.map((c) => c.layout ?? 'normal'));
    expect(layouts.size, 'the fixture index should print several layouts').toBeGreaterThan(3);
    for (const layout of layouts) {
      const sample = INDEX.cards.find((c) => (c.layout ?? 'normal') === layout)!;
      expect(comparable(unpackBrowseRecord(packBrowseRecord(sample))), layout).toEqual(comparable(sample));
    }
  });
});

describe('the browse record is small', () => {
  it(`averages under ${PACKED_BYTES_PER_CARD_BUDGET} B/card packed, against ~1,564 B/card for the full record`, () => {
    let packed = 0;
    let full = 0;
    for (const card of INDEX.cards) {
      packed += packedBytes(card);
      full += Buffer.byteLength(JSON.stringify(card), 'utf8');
    }
    const perCard = packed / INDEX.cards.length;
    expect(perCard, `packed ${perCard.toFixed(0)} B/card vs full ${(full / INDEX.cards.length).toFixed(0)} B/card`).toBeLessThan(PACKED_BYTES_PER_CARD_BUDGET);
    expect(packed, 'the point of the shape: several times smaller').toBeLessThan(full / 3);
  });

  it('stores no image id for a card whose image id IS its card id — the 91% case', () => {
    const own = INDEX.cards.find((c) => imageIdOf(c.imageUris) === c.id)!;
    expect(own).toBeDefined();
    expect(packBrowseRecord(own).img).toBeUndefined();
    const other = INDEX.cards.find((c) => imageIdOf(c.imageUris) !== undefined && imageIdOf(c.imageUris) !== c.id);
    if (other) expect(packBrowseRecord(other).img).toBe(imageIdOf(other.imageUris));
  });
});

describe('the pieces', () => {
  it('synthesizes the four image URIs in the exact shape Scryfall serves', () => {
    const id = '7673784e-db4b-43a1-8d55-1bb9fc1e284f';
    expect(browseImageUris(id)).toEqual({
      small: `https://cards.scryfall.io/small/front/7/6/${id}.jpg`,
      normal: `https://cards.scryfall.io/normal/front/7/6/${id}.jpg`,
      large: `https://cards.scryfall.io/large/front/7/6/${id}.jpg`,
      art_crop: `https://cards.scryfall.io/art_crop/front/7/6/${id}.jpg`,
    });
  });

  it('reads the image id out of a real URL, query or not', () => {
    expect(imageIdOf({ small: 'https://cards.scryfall.io/small/front/1/a/1add1757-c1f8-448a-b279-c6940fb7ad5f.jpg?1783903778' })).toBe('1add1757-c1f8-448a-b279-c6940fb7ad5f');
    expect(imageIdOf({ small: 'https://cards.scryfall.io/small/front/1/a/1add1757-c1f8-448a-b279-c6940fb7ad5f.jpg' })).toBe('1add1757-c1f8-448a-b279-c6940fb7ad5f');
    expect(imageIdOf({})).toBeUndefined();
    expect(imageIdOf(undefined)).toBeUndefined();
  });

  it('mana cost: the string it writes is the object it read — one parser, both ways', () => {
    for (const printed of ['{2}{U}{U}', '{W/U}{W/U}', '{X}{R}', '{C}{C}', '{1}{G/P}', '{S}']) {
      const cost = parseManaCost(printed);
      expect(parseManaCost(packManaCost(cost))).toEqual(cost);
    }
    expect(packManaCost(parseManaCost(undefined)), 'no printed cost stays absent').toBeUndefined();
    expect(parseManaCost(packManaCost(parseManaCost('{0}'))), 'a printed {0} is a cost, not an absence').toEqual(parseManaCost('{0}'));
  });
});
