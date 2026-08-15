/**
 * THE A/B SWAP PICKER MUST NOT OFFER A CARD THE ENGINE CANNOT PLAY.
 *
 * Reported from the running app: an A/B swap of Elvish Visionary → Acidic Slime
 * errored and the run never started. Both cards were in the picker because both
 * had been imported; only one was playable. Acidic Slime's "When ~ enters,
 * destroy target artifact, enchantment, or land" needs targets chosen by a
 * triggered ability, which the compiler does not implement, so it has a display
 * record and NO engine definition — and a variant deck built around it dies
 * before the first game.
 *
 * The asymmetry that caused it is in `importedCards.ts` and is easy to
 * reintroduce: `importedDefinitions()` filters to playable cards ("the
 * chokepoint that keeps a card the engine cannot faithfully play from ever
 * entering a simulation") while `importedCards()` deliberately returns every
 * display record, unplayable included, so lists can show them. `swapInOptions()`
 * reads the second one — correctly, since the card should be VISIBLE — and so
 * must mark the unplayable ones rather than silently offering them.
 *
 * These tests call the SHIPPED builder (`swapInOptions`), not a restatement of
 * it, so removing the fix fails them. They assert the INVARIANT — unplayable ⇒
 * marked, playable ⇒ selectable — rather than that one card is broken, so they
 * stay honest as the compiler's coverage grows.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearImportedCards,
  registerImportedCards,
  unsupportedReason,
} from './decklist/importedCards.js';
import { swapInOptions } from './swapOptions.js';

/** A minimal display record — only the fields the option builder reads. */
function displayCard(id: string, name: string) {
  return { id, name, typeLine: 'Creature', manaCost: '{G}', oracleText: '', images: {} };
}

/** The shipped builder, so a revert of the fix fails these tests. */
const inOptions = swapInOptions;

const PLAYABLE = displayCard('playable-id', 'Elvish Visionary');
const BLOCKED = displayCard('blocked-id', 'Acidic Slime');

describe('the swap-in picker and unplayable imported cards', () => {
  beforeEach(() => {
    clearImportedCards();
    registerImportedCards([
      {
        card: PLAYABLE,
        definition: {
          id: PLAYABLE.id,
          name: PLAYABLE.name,
          types: ['creature'],
          cost: { generic: 0, colored: { G: 1 } },
          power: 1,
          toughness: 1,
        },
      },
      {
        card: BLOCKED,
        missing: [
          {
            text: 'When ~ enters, destroy target artifact, enchantment, or land.',
            missingEngineSystem: 'targets chosen by a triggered ability',
          },
        ],
      },
    ]);
  });

  it('still LISTS the unplayable card', () => {
    // Hiding it would be a different bug: the card is visible everywhere else in
    // the app, so its absence here reads as breakage rather than an explanation.
    const names = inOptions().map((o) => o.name);
    expect(names).toContain('Acidic Slime');
  });

  it('marks the unplayable card unavailable, naming what it needs', () => {
    const slime = inOptions().find((o) => o.name === 'Acidic Slime');
    expect(slime?.unavailable, 'Acidic Slime was offered as selectable').toBeTruthy();
    expect(slime?.unavailable).toContain('targets chosen by a triggered ability');
  });

  it('leaves the playable card selectable', () => {
    const visionary = inOptions().find((o) => o.name === 'Elvish Visionary');
    expect(visionary, 'Elvish Visionary went missing from the picker').toBeDefined();
    expect(visionary?.unavailable).toBeUndefined();
  });

  it('marks every card with no engine definition, whatever the pool holds', () => {
    // The invariant, stated once against the whole list: anything the engine
    // cannot play is marked. New compiler gaps are covered without editing this.
    for (const option of inOptions()) {
      const blocked = (unsupportedReason(option.cardId)?.length ?? 0) > 0;
      expect(
        Boolean(option.unavailable),
        `${option.name}: unplayable=${blocked} but marked=${Boolean(option.unavailable)}`,
      ).toBe(blocked);
    }
  });
});
