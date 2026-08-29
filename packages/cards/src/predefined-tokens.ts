/**
 * PREDEFINED ARTIFACT TOKENS (CR 111.10) — Treasure, Clue, Food.
 *
 * The rules define these token faces once, globally, and every card that says
 * "create a Treasure token" means exactly this object. So they are DATA here —
 * one definition each, assembled from abilities the engine already runs —
 * and "create a Treasure token" is a rule-table entry, not an engine change:
 *
 *  - **Treasure** — "{T}, Sacrifice this artifact: Add one mana of any color."
 *    A rich mana ability with the `sacrificeSelf` cost the engine charges
 *    through the same graveyard path every sacrifice uses.
 *  - **Clue** — "{2}, Sacrifice this artifact: Draw a card." An ordinary
 *    activated ability (no tap — a Clue is crackable the turn it arrives).
 *  - **Food** — "{2}, {T}, Sacrifice this artifact: You gain 3 life."
 *
 * ⚠️ `isToken` is deliberately NOT stamped here — token-ness is a property of
 * HOW an object was made, and core's one token funnel (`createOneTokenInState`)
 * stamps it, exactly as it does for every other token definition.
 */

import type { CardDefinition } from '@jonny-boi/core';

/** "You gain 3 life" — Food's printed number. */
const FOOD_LIFE_GAIN = 3;
/** The generic cost printed on Clue and Food ("{2}, …"). */
const CRACK_GENERIC_COST = 2;

/** The five single-colour modes "add one mana of any color" offers. */
const ONE_OF_EACH_COLOR = [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }] as const;

export const PREDEFINED_TOKEN_DEFS: Readonly<Record<string, CardDefinition>> = Object.freeze({
  treasure: {
    id: 'token:treasure',
    name: 'Treasure',
    types: ['artifact'],
    subtypes: ['Treasure'],
    manaAbilities: [
      {
        produces: [...ONE_OF_EACH_COLOR],
        cost: { sacrificeSelf: true },
      },
    ],
  },
  clue: {
    id: 'token:clue',
    name: 'Clue',
    types: ['artifact'],
    subtypes: ['Clue'],
    activated: [
      {
        cost: { mana: { generic: CRACK_GENERIC_COST }, sacrificeSelf: true },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: '{2}, Sacrifice this artifact: Draw a card.',
      },
    ],
  },
  food: {
    id: 'token:food',
    name: 'Food',
    types: ['artifact'],
    subtypes: ['Food'],
    activated: [
      {
        cost: { mana: { generic: CRACK_GENERIC_COST }, tap: true, sacrificeSelf: true },
        effects: [{ primitive: 'gainLife', params: { amount: FOOD_LIFE_GAIN } }],
        label: '{2}, {T}, Sacrifice this artifact: You gain 3 life.',
      },
    ],
  },
});
