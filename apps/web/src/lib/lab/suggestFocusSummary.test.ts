/**
 * THE FOCUS SUMMARY LINE (§3.136, §3.181).
 *
 * The focus panel is collapsed by default, so this line is the only warning a
 * user gets that a run is about to search something other than what they meant.
 * Two things are pinned here: that the §3.136 wording is UNCHANGED for the cases
 * that existed before (a silent change to it reads as a regression on a screen
 * nobody diffed), and that the new bring-in side says what it is honestly.
 */
import { describe, expect, it } from 'vitest';
import { suggestFocusSummary } from './suggestFocusSummary.js';

describe('the §3.136 cases are byte-identical to what they always said', () => {
  it('nothing focused is the whole deck and whole playsets', () => {
    expect(suggestFocusSummary({ cutCount: 0, inCount: 0, copies: 'playset' })).toBe(
      '— whole deck, whole playsets',
    );
  });

  it('a cut focus counts cards, and pluralises', () => {
    expect(suggestFocusSummary({ cutCount: 3, inCount: 0, copies: 'playset' })).toBe(
      '— 3 cards, whole playsets',
    );
    expect(suggestFocusSummary({ cutCount: 1, inCount: 0, copies: 'playset' })).toBe(
      '— 1 card, whole playsets',
    );
  });

  it('the copies clause still says copy / copies', () => {
    expect(suggestFocusSummary({ cutCount: 0, inCount: 0, copies: 1 })).toBe(
      '— whole deck, 1 copy',
    );
    expect(suggestFocusSummary({ cutCount: 2, inCount: 0, copies: 3 })).toBe(
      '— 2 cards, 3 copies',
    );
  });
});

describe('§3.181 — the bring-in side', () => {
  it('ONE card to bring in is stated as the question the user actually asked', () => {
    expect(
      suggestFocusSummary({ cutCount: 0, inCount: 1, soleInName: 'Sol Ring', copies: 'playset' }),
    ).toBe('— what to cut to fit Sol Ring in, whole playsets');
  });

  it('one in-card AND a cut focus names both sides', () => {
    expect(
      suggestFocusSummary({ cutCount: 4, inCount: 1, soleInName: 'Sol Ring', copies: 'playset' }),
    ).toBe('— what to cut from 4 cards to fit Sol Ring in, whole playsets');
  });

  it('both sides restricted says the CROSS PRODUCT, and its real size', () => {
    expect(suggestFocusSummary({ cutCount: 3, inCount: 2, copies: 'playset' })).toBe(
      '— 3 cards → 2 cards (6 swaps), whole playsets',
    );
  });

  it('several in-cards with no cut focus still says the whole deck may be cut', () => {
    expect(suggestFocusSummary({ cutCount: 0, inCount: 5, copies: 'playset' })).toBe(
      '— whole deck → 5 cards to bring in, whole playsets',
    );
  });

  it('falls back to the count when the name could not be resolved', () => {
    // A pinned card whose name the pool cannot describe must not render
    // "fit undefined in" — the honest answer is the count it can defend.
    expect(suggestFocusSummary({ cutCount: 0, inCount: 1, copies: 'playset' })).toBe(
      '— whole deck → 1 card to bring in, whole playsets',
    );
    expect(
      suggestFocusSummary({ cutCount: 0, inCount: 1, soleInName: '', copies: 'playset' }),
    ).toBe('— whole deck → 1 card to bring in, whole playsets');
  });
});
