import { describe, expect, it } from 'vitest';
import { normalizeCard } from './normalize.js';
import type { RawScryfallCard } from './types.js';

import lightningBolt from './__fixtures__/lightning-bolt.json' with { type: 'json' };
import adeliz from './__fixtures__/goblin-wizard-creature.json' with { type: 'json' };
import delver from './__fixtures__/delver-dfc.json' with { type: 'json' };

describe('normalizeCard — normal card', () => {
  const card = normalizeCard(lightningBolt as RawScryfallCard);

  it('maps core identity fields', () => {
    expect(card.name).toBe('Lightning Bolt');
    expect(card.id).toBe('4457ed35-7c10-48c8-9776-456485fdf070'); // prefers oracle_id
    expect(card.cmc).toBe(1);
    expect(card.rarity).toBe('uncommon');
    expect(card.set).toBe('2x2');
    expect(card.collectorNumber).toBe('117');
  });

  it('parses the mana cost', () => {
    expect(card.manaCost.R).toBe(1);
    expect(card.manaCost.generic).toBe(0);
  });

  it('parses the type line', () => {
    expect(card.typeLine.types).toEqual(['Instant']);
    expect(card.typeLine.subtypes).toEqual([]);
  });

  it('leaves power/toughness null for a non-creature', () => {
    expect(card.power).toBeNull();
    expect(card.toughness).toBeNull();
  });

  it('carries colors, color identity, keywords, oracle text', () => {
    expect(card.colors).toEqual(['R']);
    expect(card.colorIdentity).toEqual(['R']);
    expect(card.keywords).toEqual([]);
    expect(card.oracleText).toContain('3 damage');
  });

  it('surfaces image URIs and is not double-faced', () => {
    expect(card.imageUris.normal).toContain('normal');
    expect(card.imageUris.art_crop).toContain('art_crop');
    expect(card.isDoubleFaced).toBe(false);
    expect(card.faces).toEqual([]);
    expect(card.localImages).toEqual({});
  });
});

describe('normalizeCard — legendary creature', () => {
  const card = normalizeCard(adeliz as RawScryfallCard);

  it('parses supertype/type/subtype and numeric P/T', () => {
    expect(card.typeLine.supertypes).toEqual(['Legendary']);
    expect(card.typeLine.types).toEqual(['Creature']);
    expect(card.typeLine.subtypes).toEqual(['Faerie', 'Wizard']);
    expect(card.power).toBe(2);
    expect(card.toughness).toBe(2);
  });

  it('parses a two-color mana cost', () => {
    expect(card.manaCost.generic).toBe(1);
    expect(card.manaCost.U).toBe(1);
    expect(card.manaCost.R).toBe(1);
  });
});

describe('normalizeCard — double-faced card', () => {
  const card = normalizeCard(delver as RawScryfallCard);

  it('flags it double-faced and captures both faces', () => {
    expect(card.isDoubleFaced).toBe(true);
    expect(card.faces).toHaveLength(2);
    expect(card.faces[0]?.name).toBe('Delver of Secrets');
    expect(card.faces[1]?.name).toBe('Insectile Aberration');
  });

  it('falls back to the front face for top-level fields when absent', () => {
    // The DFC fixture has no top-level mana_cost/type_line/image_uris.
    expect(card.manaCost.U).toBe(1);
    expect(card.typeLine.types).toEqual(['Creature']);
    expect(card.power).toBe(1); // front face
    expect(card.imageUris.normal).toContain('front');
  });

  it('normalizes each face independently', () => {
    expect(card.faces[1]?.power).toBe(3);
    expect(card.faces[1]?.toughness).toBe(2);
    expect(card.faces[1]?.oracleText).toBe('Flying');
    expect(card.faces[1]?.imageUris.normal).toContain('back');
  });
});

describe('normalizeCard — robustness', () => {
  it('produces a usable sparse record from a near-empty card', () => {
    const card = normalizeCard({ name: 'Mystery Card' } as RawScryfallCard);
    expect(card.name).toBe('Mystery Card');
    expect(card.id).toBe('Mystery Card'); // falls back to name
    expect(card.cmc).toBe(0);
    expect(card.colors).toEqual([]);
    expect(card.imageUris).toEqual({});
    expect(card.power).toBeNull();
  });
});
