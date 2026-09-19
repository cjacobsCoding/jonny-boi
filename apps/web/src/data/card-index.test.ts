/**
 * THE GUARD THAT KEEPS THE BUNDLED CARD INDEX HONEST.
 *
 * `card-index.json` used to be a hand-made duplicate of the canonical
 * `packages/data-tools/data/card-index.json`. Nothing generated it and nothing
 * checked it, so the only thing standing between the app and a stale card list
 * was somebody remembering to copy a file. When it does go stale the failure is
 * invisible in code review and loud for the user: every card added to the pool
 * since renders as a bare id with no name and no art, in the browser, the deck
 * builder and the replay board alike.
 *
 * So the file is now DERIVED, and this suite re-derives it and fails on any
 * disagreement. It also checks the two joins that make the derived file useful:
 * every card the ENGINE can play must have a display row, and every display row
 * must resolve to art through the same `cardImage()` the UI calls.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadCardPool } from '@jonny-boi/cards';
import type { CardIndex, NormalizedCard } from '@jonny-boi/data-tools/pure';
import { describe, expect, it } from 'vitest';

import {
  DISPLAYED_IMAGE_VARIANTS,
  SOURCE_INDEX_URL,
  expectedWebIndexText,
  projectCardIndex,
  serializeCardIndex,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain-JS build script; typed by use, not by a .d.ts.
} from '../../scripts/build-card-index.mjs';
import { cardImage } from '../lib/cards.js';
import rawIndex from './card-index.json';

/** How to fix a failure here — repeated in every message so it is unmissable. */
const REGENERATE_HINT =
  'Run `npm run cards:index -w @jonny-boi/web` to regenerate apps/web/src/data/card-index.json. ' +
  'Never hand-edit it: it is derived from packages/data-tools/data/card-index.json.';

const webIndex = rawIndex as unknown as CardIndex;

const canonicalIndex = JSON.parse(
  readFileSync(fileURLToPath(SOURCE_INDEX_URL as URL), 'utf8'),
) as CardIndex;

describe('bundled card index — derived, never hand-copied', () => {
  it('matches a fresh regeneration from the canonical data-tools index', async () => {
    const expected = (await expectedWebIndexText()) as string;
    const committed = serializeCardIndex(webIndex) as string;
    // Compare the parsed values first: on a mismatch the diff names the card,
    // where a raw string compare would just print two 150 KB blobs.
    expect(JSON.parse(committed), REGENERATE_HINT).toEqual(JSON.parse(expected));
    expect(committed, REGENERATE_HINT).toBe(expected);
  });

  it('covers every card in the canonical index — no silently dropped rows', () => {
    expect(webIndex.cards.length, REGENERATE_HINT).toBe(canonicalIndex.cards.length);
    const canonicalIds = canonicalIndex.cards.map((card) => card.id);
    expect(
      webIndex.cards.map((card) => card.id),
      REGENERATE_HINT,
    ).toEqual(canonicalIds);
  });
});

describe('bundled card index — joins to the engine pool', () => {
  const pool = loadCardPool({ onWarn: () => {} });
  const displayIds = new Set(webIndex.cards.map((card) => card.id));

  it('has a display row for every card the engine can play', () => {
    const missing = pool.cards.filter((card) => !displayIds.has(card.id));
    // Named, not counted: a bare number here would not tell the next reader
    // which card lost its art.
    expect(
      missing.map((card) => `${card.name} (${card.id})`),
      REGENERATE_HINT,
    ).toEqual([]);
  });

  it('resolves art for every display row through the UI’s own cardImage()', () => {
    const artless = webIndex.cards.filter(
      (card) => cardImage(card as NormalizedCard, 'normal') === undefined,
    );
    expect(
      artless.map((card) => card.name),
      REGENERATE_HINT,
    ).toEqual([]);
  });

  it('carries no rows the engine pool does not know about', () => {
    const poolIds = new Set(pool.cards.map((card) => card.id));
    const orphans = webIndex.cards.filter((card) => !poolIds.has(card.id));
    expect(
      orphans.map((card) => card.name),
      REGENERATE_HINT,
    ).toEqual([]);
  });
});

describe('bundled card index — the projection stays in step with the UI', () => {
  /** Every size `cardImage()` accepts; widening it must widen the projection. */
  const CARD_IMAGE_SIZES = ['normal', 'large', 'art_crop'] as const;

  it('keeps every image variant cardImage() can return', () => {
    const kept = new Set(DISPLAYED_IMAGE_VARIANTS as readonly string[]);
    // `cardImage` degrades through `small` for each requested size, so it is
    // required too even though no caller asks for it by name.
    for (const size of [...CARD_IMAGE_SIZES, 'small']) {
      expect(
        kept.has(size),
        `cardImage() can return the "${size}" image, but build-card-index.mjs drops it ` +
          'from the bundled index, so that card would fall back to a text tile. ' +
          'Add it to DISPLAYED_IMAGE_VARIANTS and regenerate.',
      ).toBe(true);
    }
  });

  it('drops the variants nothing renders, and keeps the bundle smaller for it', () => {
    const projected = projectCardIndex(canonicalIndex) as CardIndex;
    const canonicalBytes = Buffer.byteLength(serializeCardIndex(canonicalIndex) as string, 'utf8');
    const projectedBytes = Buffer.byteLength(serializeCardIndex(projected) as string, 'utf8');
    // The projection exists to earn its keep; if it ever stops saving anything,
    // it is pure complexity and should be deleted rather than left in place.
    expect(projectedBytes).toBeLessThan(canonicalBytes);

    const canonicalVariants = new Set(
      canonicalIndex.cards.flatMap((card) => Object.keys(card.imageUris ?? {})),
    );
    const projectedVariants = new Set(
      projected.cards.flatMap((card) => Object.keys(card.imageUris ?? {})),
    );
    expect(projectedVariants.size).toBeLessThan(canonicalVariants.size);
    for (const variant of projectedVariants) {
      expect(DISPLAYED_IMAGE_VARIANTS as readonly string[]).toContain(variant);
    }
  });

  it('derives art from a PRINTING id when a record carries no URLs (§3.167)', () => {
    // The projection drops every URL that is exactly what the id derives, so
    // most bundled rows now carry none — and must still resolve art.
    const derivable = webIndex.cards.find(
      (card) => Object.keys(card.imageUris ?? {}).length === 0,
    ) as NormalizedCard | undefined;
    expect(
      derivable,
      'the projection should have dropped derivable URLs from at least one row',
    ).toBeDefined();
    expect(cardImage(derivable!, 'normal')).toBe(
      `https://cards.scryfall.io/normal/front/${derivable!.id[0]}/${derivable!.id[1]}/${derivable!.id}.jpg`,
    );
    expect(cardImage(derivable!, 'art_crop')).toContain('/art_crop/front/');
  });

  it('degrades a card with no art AND no printing id to a readable text card rather than crashing', () => {
    // Rule 6 (graceful fallback). `cardImage` returning `undefined` is the
    // signal `CardArt` uses to render its labelled tile; the card still has the
    // name and cost needed to read it. An id that is not a Scryfall uuid (a
    // synthesized engine record) cannot derive a URL, so there is nothing to show.
    const artless = {
      ...webIndex.cards[0]!,
      id: 'engine:synthesized',
      imageUris: {},
    } as NormalizedCard;
    expect(cardImage(artless, 'normal')).toBeUndefined();
    expect(cardImage(artless, 'large')).toBeUndefined();
    expect(cardImage(artless, 'art_crop')).toBeUndefined();
    expect(artless.name.length).toBeGreaterThan(0);
  });
});
