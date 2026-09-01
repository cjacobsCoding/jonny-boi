/**
 * TOKEN-NESS IS NOT A COPIABLE VALUE (CR 707.2), AND GETTING IT WRONG DELETES A
 * REAL CARD FROM THE GAME.
 *
 * A copy takes the copied object's CHARACTERISTICS. Whether an object is a token
 * is a fact about how it was created (CR 111.1), not a characteristic — so a
 * card that enters as a copy of a token is still a card, and goes to its
 * owner's graveyard like any other.
 *
 * The bug this pins: `copiableDefOf` returned the source definition verbatim, so
 * a Glasspool Mimic entering as a copy of a Thopter token inherited
 * `isToken: true`. `ceaseToExistIfToken` then removed it from EVERY zone the
 * moment it left the battlefield (CR 704.5d, correct for a real token), and the
 * physical card was gone from the game — not in the graveyard, not in exile,
 * nowhere.
 *
 * Found by the soak over the whole printed pool (§3.71) as "original instance
 * #61 is in no zone on turn 37", after 36 turns of a game nobody wrote. The old
 * 573-card pool had never dealt a copy effect and a token maker into the same
 * game, which is exactly why a pool this size is worth having.
 */

import { describe, expect, it } from 'vitest';
import { copiableDefOf, tokenCopyDefOf } from './copy.js';
import type { CardDefinition, CardInstance } from './index.js';

const THOPTER_TOKEN: CardDefinition = {
  id: 'test:thopter',
  name: 'Thopter',
  types: ['artifact', 'creature'],
  subtypes: ['Thopter'],
  power: 1,
  toughness: 1,
  keywords: { flying: true },
  isToken: true,
};

const BEAR: CardDefinition = {
  id: 'test:bear',
  name: 'Grizzly Bears',
  types: ['creature'],
  power: 2,
  toughness: 2,
};

const asInstance = (def: CardDefinition): CardInstance => ({ def }) as CardInstance;

describe('copying a token does not make the copy a token', () => {
  it('drops isToken from the copiable definition', () => {
    const copiable = copiableDefOf(asInstance(THOPTER_TOKEN));
    expect(copiable.isToken).toBeUndefined();
  });

  it('keeps every actual characteristic', () => {
    // The point is that ONLY token-ness is dropped: a copy of a Thopter really
    // is a 1/1 flying artifact creature named Thopter.
    const copiable = copiableDefOf(asInstance(THOPTER_TOKEN));
    expect(copiable.name).toBe('Thopter');
    expect(copiable.power).toBe(1);
    expect(copiable.toughness).toBe(1);
    expect(copiable.types).toEqual(['artifact', 'creature']);
    expect(copiable.keywords?.flying).toBe(true);
  });

  it('leaves a NON-token definition untouched, allocating nothing new', () => {
    // The common path must not pay for the rare one.
    expect(copiableDefOf(asInstance(BEAR))).toBe(BEAR);
  });

  it('still produces a TOKEN definition when a token is what is being made', () => {
    // `tokenCopyDefOf` feeds the token-creation path, which stamps token-ness
    // back on — so stripping it here cannot stop a token copy from being a
    // token. What it produces is the characteristics; creation supplies the rest.
    const forToken = tokenCopyDefOf(asInstance(BEAR));
    expect(forToken.name).toBe('Grizzly Bears');
    expect(forToken.power).toBe(2);
  });
});
