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
import { allAvailableCards, allCards, getCard } from './cards.js';

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

    // It is NOT in the curated Scryfall index — that is exactly why reading
    // `allCards` here was wrong.
    expect(allCards.some((c) => c.id === tusker!.id)).toBe(false);

    // But it must resolve and be selectable through the full pool.
    expect(getCard(tusker!.id), 'Kalonian Tusker must resolve for display').toBeDefined();
    expect(allAvailableCards().some((c) => c.id === tusker!.id)).toBe(true);
  });

  it('the full pool is meaningfully larger than the curated index', () => {
    // Guards against someone "simplifying" the union back to the curated list.
    expect(allAvailableCards().length).toBeGreaterThan(allCards.length);
    expect(allAvailableCards().length).toBeGreaterThanOrEqual(simPoolCards().length);
  });

  it('every selectable card has a usable display name', () => {
    for (const card of allAvailableCards()) {
      expect(card.name.trim().length, `card ${card.id} has no name`).toBeGreaterThan(0);
    }
  });
});
