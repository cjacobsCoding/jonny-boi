/**
 * THE LAB'S TWO CARD LISTS MUST COME FROM THE SAME POOL.
 *
 * Suggestions generates its candidates from the SIM's pool — everything the
 * engine can play. The A/B Swap tab's "bring in" dropdown was built from the
 * CURATED Scryfall index instead, which is a fraction of that. So the Lab could
 * recommend swapping in Kalonian Tusker and then refuse to let you select it in
 * the very tab that exists to verify the recommendation.
 *
 * That is the third time this repo's two card pools have silently disagreed (the
 * card browser, the gauntlet-deck copy, and now this), so this asserts the
 * containment directly rather than trusting one call site to stay correct.
 */
import { describe, expect, it } from 'vitest';
import { loadCardPool } from '@jonny-boi/cards';
import { allAvailableCards, allCards, getCard, cardImage } from './cards.js';

/** Every card the SIM could ever propose as a swap-in candidate. */
function simPoolCards() {
  return loadCardPool({ onWarn: () => {} }).cards;
}

describe('the swap-in pool covers everything Suggestions can propose', () => {
  it('every simulatable card is selectable in the Lab', () => {
    const selectable = new Set(allAvailableCards().map((c) => c.id));
    const missing = simPoolCards()
      .filter((def) => !selectable.has(def.id))
      .map((def) => def.name);

    expect(
      missing,
      `Suggestions could propose these, but the A/B tab cannot offer them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('regression: Kalonian Tusker is selectable (the card that exposed this)', () => {
    const tusker = simPoolCards().find((c) => c.name === 'Kalonian Tusker');
    expect(tusker, 'Kalonian Tusker should be in the sim pool').toBeDefined();
    expect(getCard(tusker!.id), 'Kalonian Tusker must resolve for display').toBeDefined();
    expect(allAvailableCards().some((c) => c.id === tusker!.id)).toBe(true);
  });

  it('the selectable pool is never smaller than what the sim can play', () => {
    // The real invariant, independent of how many cards Scryfall data covers:
    // whatever the engine can play must be offerable. (It used to be ~32 vs ~150.)
    expect(allAvailableCards().length).toBeGreaterThanOrEqual(simPoolCards().length);
    expect(allAvailableCards().length).toBeGreaterThanOrEqual(allCards.length);
  });

  it('every simulatable card has real art, not a synthesized placeholder', () => {
    // The synthesized records exist as a safety net for an engine card Scryfall
    // data misses; if this fails the index needs re-fetching for the new cards.
    // Asked through the UI's one art funnel (`cardImage`), not by peeking at
    // `imageUris`: since §3.167 most records carry no URLs and derive them from
    // the printing id, so a URL-less record is not an art-less one.
    const artless = simPoolCards()
      .map((def) => getCard(def.id))
      .filter((card) => card && cardImage(card, 'normal') === undefined)
      .map((card) => card!.name);

    expect(
      artless,
      `these render with no art — re-run the data-tools fetch for them: ${artless.join(', ')}`,
    ).toEqual([]);
  });

  it('every selectable card has a usable display name', () => {
    for (const card of allAvailableCards()) {
      expect(card.name.trim().length, `card ${card.id} has no name`).toBeGreaterThan(0);
    }
  });
});
