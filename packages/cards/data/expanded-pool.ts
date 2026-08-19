/**
 * GENERATED — do not edit by hand. Regenerate with:
 *   npx tsx packages/cards/scripts/build-expansion.ts
 *
 * The compiled half of the card pool (DESIGN §3.2, §3.11). Every definition here
 * was produced by the Oracle-text compiler from the card's real Scryfall text and
 * accepted ONLY because the compiler reported it `'complete'` — i.e. every
 * printed ability is genuinely implemented by a registered effect primitive. The
 * printed text sits above each entry so the data can be checked by eye against
 * what the engine will do.
 *
 * Candidates that could NOT be compiled faithfully are not here; they are listed
 * with the engine system they need in `./expansion-report.json`. Nothing is
 * approximated into the pool — an almost-right card would silently bias every
 * A/B verdict the lab produces.
 *
 * 299 cards.
 */

import type { CardDefinition } from '@jonny-boi/core';

export const EXPANDED_CARD_POOL: readonly CardDefinition[] = Object.freeze([
  // Choose one —
  // • Abrade deals 3 damage to target creature.
  // • Destroy target artifact.
  {
    id: 'f9db72dc-9a5b-48a4-a86e-7464d9a2166a',
    name: 'Abrade',
    types: ['instant'],
    cost: { generic: 1, R: 1 },
    modal: {
      min: 1,
      max: 1,
      modes: [
        {
          id: 'mode1',
          label: 'Abrade deals 3 damage to target creature',
          effects: [{ primitive: 'dealDamage', params: { amount: 3, targets: 'creature' } }],
          targets: 'creature',
        },
        {
          id: 'mode2',
          label: 'Destroy target artifact',
          effects: [{ primitive: 'destroyTarget', params: { targets: 'artifact' } }],
          targets: 'artifact',
        },
      ],
    },
  },
  // Counter target spell. You gain 3 life.
  {
    id: '132ca99a-a3c7-4ed6-b4d0-0edcd7140ca2',
    name: 'Absorb',
    types: ['instant'],
    cost: { W: 1, U: 2 },
    effects: [
      { primitive: 'counterSpell', params: { targets: 'spell' } },
      { primitive: 'gainLife', params: { amount: 3 } },
    ],
  },
  // Equipped creature gets +0/+3 and has vigilance. (Attacking doesn't cause it to tap.)
  // Equip {3} ({3}: Attach to target creature you control. Equip only as a sorcery.)
  {
    id: 'dd70d439-bd60-43d1-ac26-13b744cc4a37',
    name: 'Accorder\'s Shield',
    types: ['artifact'],
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 3 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {3}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {3}',
      modifies: { power: 0, toughness: 3, keywords: { vigilance: true } },
    },
  },
  // Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn. (It can attack and {T} this turn.)
  {
    id: '9d08af23-9f4a-4097-9abc-3b17475ab744',
    name: 'Act of Treason',
    types: ['sorcery'],
    cost: { generic: 2, R: 1 },
    effects: [{ primitive: 'gainControl', params: { targets: 'creature', untap: true, haste: true } }],
  },
  // Flying, vigilance, lifelink
  {
    id: '69b1b0ec-9db0-48d1-a7b5-71281aca16fe',
    name: 'Aerial Responder',
    types: ['creature'],
    cost: { generic: 1, W: 2 },
    power: 2,
    toughness: 3,
    keywords: { flying: true, vigilance: true, lifelink: true },
    subtypes: ['dwarf', 'soldier'],
  },
  // Choose one or both —
  // • Return target creature card from your graveyard to your hand.
  // • Return target planeswalker card from your graveyard to your hand.
  {
    id: 'acb0084d-3b09-4d2a-a4c1-848c92588845',
    name: 'Aid the Fallen',
    types: ['sorcery'],
    cost: { generic: 1, B: 1 },
    modal: {
      min: 1,
      max: 2,
      modes: [
        {
          id: 'mode1',
          label: 'Return target creature card from your graveyard to your hand',
          effects: [
            {
              primitive: 'returnFromGraveyard',
              params: { count: 1, filter: { anyOfTypes: ['creature'] } },
            },
          ],
        },
        {
          id: 'mode2',
          label: 'Return target planeswalker card from your graveyard to your hand',
          effects: [
            {
              primitive: 'returnFromGraveyard',
              params: { count: 1, filter: { anyOfTypes: ['planeswalker'] } },
            },
          ],
        },
      ],
    },
  },
  // Flying
  {
    id: '7744bae4-a8b7-44a5-9b4c-0048ad4cc448',
    name: 'Air Elemental',
    types: ['creature'],
    cost: { generic: 3, U: 2 },
    power: 4,
    toughness: 4,
    keywords: { flying: true },
    subtypes: ['elemental'],
  },
  // Lifelink (Damage dealt by this creature also causes you to gain that much life.)
  {
    id: '31009c45-afba-45f4-a6ca-9dfdb9990e72',
    name: 'Ajani\'s Sunstriker',
    types: ['creature'],
    cost: { W: 2 },
    power: 2,
    toughness: 2,
    keywords: { lifelink: true },
    subtypes: ['cat', 'cleric'],
  },
  // {T}: Add one mana of any color.
  {
    id: 'efb0394c-2a45-4dd8-bca3-08704056fa31',
    name: 'Alloy Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 3 },
    power: 2,
    toughness: 2,
    subtypes: ['myr'],
    producesOptions: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
  },
  {
    id: '4caa8e68-e599-416f-b839-3d009569ff29',
    name: 'Alpha Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 2,
    toughness: 1,
    subtypes: ['myr'],
  },
  // Destroy target artifact.
  // Flashback {G} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: '306593b0-6ea8-476f-a3f2-e17876c1bab4',
    name: 'Ancient Grudge',
    types: ['instant'],
    cost: { generic: 1, R: 1 },
    flashback: { G: 1 },
    effects: [{ primitive: 'destroyTarget', params: { targets: 'artifact' } }],
  },
  // Flying
  // When this creature enters, you gain 3 life.
  {
    id: 'a2daaf32-dbfe-4618-892e-0da24f63a44a',
    name: 'Angel of Mercy',
    types: ['creature'],
    cost: { generic: 4, W: 1 },
    power: 3,
    toughness: 3,
    keywords: { flying: true },
    subtypes: ['angel'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 3 } }],
        label: 'Enters: you gain 3 life',
      },
    ],
  },
  // You gain 7 life.
  {
    id: '6b232bb7-d372-4174-a049-5f8d620810e6',
    name: 'Angel\'s Mercy',
    types: ['instant'],
    cost: { generic: 2, W: 2 },
    effects: [{ primitive: 'gainLife', params: { amount: 7 } }],
  },
  // Enchant creature
  // When this Aura enters, draw a card.
  // Enchanted creature has flying.
  {
    id: 'e5e04968-d9b7-4bd5-b826-be9502360cd3',
    name: 'Angelic Gift',
    types: ['enchantment'],
    cost: { generic: 1, W: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: 'Enters: draw a card',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 0, toughness: 0, keywords: { flying: true } },
    },
  },
  // Choose one or both —
  // • Target creature gets +1/+1 until end of turn.
  // • Return target creature to its owner's hand.
  {
    id: '93ee2ea1-4f9b-47dd-b7d4-b0ed5a26d719',
    name: 'Applied Biomancy',
    types: ['instant'],
    cost: { U: 1, G: 1 },
    modal: {
      min: 1,
      max: 2,
      modes: [
        {
          id: 'mode1',
          label: 'Target creature gets +1/+1 until end of turn',
          effects: [
            {
              primitive: 'pumpUntilEndOfTurn',
              params: { power: 1, toughness: 1, targets: 'creature' },
            },
          ],
          targets: 'creature',
        },
        {
          id: 'mode2',
          label: 'Return target creature to its owner\'s hand',
          effects: [{ primitive: 'returnToHand', params: { targets: 'creature' } }],
          targets: 'creature',
        },
      ],
    },
  },
  // Flying
  // Ward {2} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {2}.)
  // When this creature enters, scry 2.
  {
    id: 'cddbd819-4895-4712-b44b-d6b51f3d8646',
    name: 'Archive Dragon',
    types: ['creature'],
    cost: { generic: 4, U: 2 },
    power: 4,
    toughness: 6,
    keywords: { flying: true, ward: 2 },
    subtypes: ['dragon', 'wizard'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'scry', params: { count: 2 } }],
        label: 'Enters: scry 2',
      },
    ],
  },
  // Target creature can't be blocked this turn.
  // Flashback {U} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'c174dcbb-03a0-439c-b3d8-ed61bd46dc67',
    name: 'Artful Dodge',
    types: ['sorcery'],
    cost: { U: 1 },
    flashback: { U: 1 },
    effects: [
      {
        primitive: 'grantKeywordUntilEndOfTurn',
        params: { keywords: { unblockable: true }, targets: 'creature' },
      },
    ],
  },
  // Choose one or both —
  // • Tap target creature.
  // • Target creature gets -2/-4 until end of turn.
  {
    id: 'edc193bf-2987-4c7b-9cf3-69089ff13764',
    name: 'Artful Takedown',
    types: ['instant'],
    cost: { generic: 2, U: 1, B: 1 },
    modal: {
      min: 1,
      max: 2,
      modes: [
        {
          id: 'mode1',
          label: 'Tap target creature',
          effects: [{ primitive: 'tapTarget', params: { targets: 'creature' } }],
          targets: 'creature',
        },
        {
          id: 'mode2',
          label: 'Target creature gets -2/-4 until end of turn',
          effects: [
            {
              primitive: 'pumpUntilEndOfTurn',
              params: { power: -2, toughness: -4, targets: 'creature' },
            },
          ],
          targets: 'creature',
        },
      ],
    },
  },
  // First strike
  // When this creature enters, create a 1/1 white Soldier creature token.
  {
    id: 'b3eb8f65-5eba-42a9-a1b4-4f37b14d03d9',
    name: 'Attended Knight',
    types: ['creature'],
    cost: { generic: 2, W: 1 },
    power: 2,
    toughness: 2,
    keywords: { firstStrike: true },
    subtypes: ['human', 'knight'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Soldier' } }],
        label: 'Enters: create a 1/1 white soldier creature token',
      },
    ],
  },
  // Flying
  // When this creature enters, scry 3. (Look at the top three cards of your library, then put any number of them on the bottom and the rest on top in any order.)
  {
    id: '44c5f8e1-d9b8-4067-a60a-1ecc8bd11145',
    name: 'Augury Owl',
    types: ['creature'],
    cost: { generic: 1, U: 1 },
    power: 1,
    toughness: 1,
    keywords: { flying: true },
    subtypes: ['bird'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'scry', params: { count: 3 } }],
        label: 'Enters: scry 3',
      },
    ],
  },
  // {T}: Add {W}.
  {
    id: '069f6530-e65c-4d52-85f3-e0a2acd148c5',
    name: 'Avacyn\'s Pilgrim',
    types: ['creature'],
    cost: { G: 1 },
    power: 1,
    toughness: 1,
    subtypes: ['human', 'monk'],
    produces: ['W'],
  },
  // This land enters tapped.
  // {T}: Add {W} or {U}.
  {
    id: 'ad1712d8-809f-410c-8b91-ffe6fb8a69a1',
    name: 'Azorius Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ W: 1 }, { U: 1 }],
  },
  // When this creature enters, create two 1/1 red Goblin creature tokens.
  {
    id: 'f5c5f64c-6911-430c-a825-b32b96d39c7d',
    name: 'Beetleback Chief',
    types: ['creature'],
    cost: { generic: 2, R: 2 },
    power: 2,
    toughness: 2,
    subtypes: ['goblin', 'warrior'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Goblin', count: 2 } }],
        label: 'Enters: create two 1/1 red goblin creature tokens',
      },
    ],
  },
  // Other creatures you control get +1/+1.
  {
    id: '2cc439e8-d112-44e6-bc5a-6e99333c519a',
    name: 'Benalish Marshal',
    types: ['creature'],
    cost: { W: 3 },
    power: 3,
    toughness: 3,
    subtypes: ['human', 'knight'],
    statics: [
      {
        affects: { anyOfTypes: ['creature'], controller: 'you', excludeSource: true },
        power: 1,
        toughness: 1,
        label: 'other creatures you control get +1/+1',
      },
    ],
  },
  // First strike (This creature deals combat damage before creatures without first strike.)
  // Protection from white (This creature can't be blocked, targeted, dealt damage, or enchanted by anything white.)
  {
    id: '9456c5b6-946d-403a-8ed0-dff9f921d98c',
    name: 'Black Knight',
    types: ['creature'],
    cost: { B: 2 },
    power: 2,
    toughness: 2,
    keywords: { firstStrike: true, protectionFrom: ['white'] },
    subtypes: ['human', 'knight'],
  },
  // Equipped creature has flying and first strike.
  // Equip {2}
  {
    id: 'c8cdc08a-975b-475f-8e30-85d61f6f3a9b',
    name: 'Bladed Pinions',
    types: ['artifact'],
    cost: { generic: 2 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 2 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {2}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {2}',
      modifies: { power: 0, toughness: 0, keywords: { flying: true, firstStrike: true } },
    },
  },
  // Blaze deals X damage to any target.
  {
    id: '0596920f-9946-42f4-a03b-24aab67f9f1b',
    name: 'Blaze',
    types: ['sorcery'],
    cost: { R: 1 },
    xCost: 1,
    effects: [{ primitive: 'dealDamage', params: { amount: { chosenX: true } } }],
  },
  // First strike, protection from white
  {
    id: '67fba605-9cfa-499c-83e0-4fbd023bcfa0',
    name: 'Blood Knight',
    types: ['creature'],
    cost: { R: 2 },
    power: 2,
    toughness: 2,
    keywords: { firstStrike: true, protectionFrom: ['white'] },
    subtypes: ['human', 'knight'],
  },
  // This land enters tapped.
  // When this land enters, you gain 1 life.
  // {T}: Add {B} or {R}.
  {
    id: '64e29bfc-9313-4e8c-808c-bc27f6b018a6',
    name: 'Bloodfell Caves',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ B: 1 }, { R: 1 }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
        label: 'Enters: you gain 1 life',
      },
    ],
  },
  // This land enters tapped.
  // When this land enters, you gain 1 life.
  // {T}: Add {G} or {W}.
  {
    id: '45429b2c-be3b-4b2e-9bab-a059ccbda8cd',
    name: 'Blossoming Sands',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ G: 1 }, { W: 1 }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
        label: 'Enters: you gain 1 life',
      },
    ],
  },
  // Equipped creature gets +1/+0.
  // Equip {1} ({1}: Attach to target creature you control. Equip only as a sorcery.)
  {
    id: '16e555f2-5aa8-4100-a036-eed48db0e84a',
    name: 'Bone Saw',
    types: ['artifact'],
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 1 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {1}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {1}',
      modifies: { power: 1, toughness: 0, keywords: {} },
    },
  },
  // Equipped creature gets +2/+0.
  // Equip {1}
  {
    id: '452e3f5f-ce17-4682-966b-5cc100210aee',
    name: 'Bonesplitter',
    types: ['artifact'],
    cost: { generic: 1 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 1 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {1}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {1}',
      modifies: { power: 2, toughness: 0, keywords: {} },
    },
  },
  // Choose one —
  // • Boros Charm deals 4 damage to target player or planeswalker.
  // • Permanents you control gain indestructible until end of turn.
  // • Target creature gains double strike until end of turn.
  {
    id: '2679d0dd-ba30-4a1c-b6a0-b3ac6c790496',
    name: 'Boros Charm',
    types: ['instant'],
    cost: { W: 1, R: 1 },
    modal: {
      min: 1,
      max: 1,
      modes: [
        {
          id: 'mode1',
          label: 'Boros Charm deals 4 damage to target player or planeswalker',
          effects: [{ primitive: 'dealDamage', params: { amount: 4, targets: 'playerOrPlaneswalker' } }],
          targets: 'playerOrPlaneswalker',
        },
        {
          id: 'mode2',
          label: 'Permanents you control gain indestructible until end of turn',
          effects: [
            {
              primitive: 'grantKeywordToYoursUntilEndOfTurn',
              params: { keywords: { indestructible: true } },
            },
          ],
        },
        {
          id: 'mode3',
          label: 'Target creature gains double strike until end of turn',
          effects: [
            {
              primitive: 'grantKeywordUntilEndOfTurn',
              params: { keywords: { doubleStrike: true }, targets: 'creature' },
            },
          ],
          targets: 'creature',
        },
      ],
    },
  },
  // This land enters tapped.
  // {T}: Add {R} or {W}.
  {
    id: '73c423b7-cab8-4e69-8070-9edbf96a6c2c',
    name: 'Boros Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ R: 1 }, { W: 1 }],
  },
  {
    id: 'f27e5e11-0ad0-448b-8760-75ed1b97e7d8',
    name: 'Bronze Sable',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 2,
    toughness: 1,
    subtypes: ['sable'],
  },
  // Target opponent loses 3 life.
  // Flashback {5}{R} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'd9f2c571-b357-4d4d-94c5-fd47551bb842',
    name: 'Bump in the Night',
    types: ['sorcery'],
    cost: { B: 1 },
    flashback: { generic: 5, R: 1 },
    effects: [{ primitive: 'loseLife', params: { amount: 3, targetPlayer: true, targets: 'opponent' } }],
  },
  // Create a 3/3 green Elephant creature token.
  // Flashback {3}{G} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'ee243f81-f51c-4d9a-a396-f7cef84b46c1',
    name: 'Call of the Herd',
    types: ['sorcery'],
    cost: { generic: 2, G: 1 },
    flashback: { generic: 3, G: 1 },
    effects: [{ primitive: 'makeToken', params: { power: 3, toughness: 3, name: 'Elephant' } }],
  },
  // Counter target spell.
  {
    id: '7d00fb28-ea6c-49a9-b4af-ffb38860a9a7',
    name: 'Cancel',
    types: ['instant'],
    cost: { generic: 1, U: 2 },
    effects: [{ primitive: 'counterSpell', params: { targets: 'spell' } }],
  },
  // Create three 1/1 white Soldier creature tokens.
  {
    id: '46418fe4-065c-4dfa-b796-eee02c14f351',
    name: 'Captain\'s Call',
    types: ['sorcery'],
    cost: { generic: 3, W: 1 },
    effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Soldier', count: 3 } }],
  },
  // This land enters tapped unless you control an Island.
  // {T}: Add {U}.
  // {2}{U}{U}, {T}: Scry 2.
  {
    id: 'cdf41cf4-4e77-453d-be5b-0abbbd358934',
    name: 'Castle Vantress',
    types: ['land'],
    entersTappedUnless: { controlsSubtype: ['island'] },
    produces: ['U'],
    activated: [
      {
        cost: { mana: { generic: 2, U: 2 }, tap: true },
        effects: [{ primitive: 'scry', params: { count: 2 } }],
        label: '{2}{u}{u}, {t}: scry 2',
      },
    ],
  },
  {
    id: '2f5bf099-2e01-4e1c-9ebf-0ce0ac66939e',
    name: 'Centaur Courser',
    types: ['creature'],
    cost: { generic: 2, G: 1 },
    power: 3,
    toughness: 3,
    subtypes: ['centaur', 'warrior'],
  },
  // This artifact enters tapped.
  // {T}: Add {B}.
  {
    id: '1386d111-a2a7-4df1-91d7-947664126989',
    name: 'Charcoal Diamond',
    types: ['artifact'],
    cost: { generic: 2 },
    entersTapped: true,
    produces: ['B'],
  },
  // Create a 1/1 green Squirrel creature token.
  // Flashback {1}{G} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'b0aaa4b1-5188-43a6-997d-7a9b2ad452bc',
    name: 'Chatter of the Squirrel',
    types: ['sorcery'],
    cost: { G: 1 },
    flashback: { generic: 1, G: 1 },
    effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Squirrel' } }],
  },
  // Lifelink
  {
    id: 'c650a7bc-e350-44a0-a698-d4a233d66156',
    name: 'Child of Night',
    types: ['creature'],
    cost: { generic: 1, B: 1 },
    power: 2,
    toughness: 1,
    keywords: { lifelink: true },
    subtypes: ['vampire'],
  },
  // Counter target spell unless its controller pays {X}.
  {
    id: '56aec5bd-a8e8-403f-b339-0fc817426428',
    name: 'Clash of Wills',
    types: ['instant'],
    cost: { U: 1 },
    xCost: 1,
    effects: [{ primitive: 'counterUnlessPaid', params: { targets: 'spell', unlessPaidX: true } }],
  },
  // Flying
  // When this creature enters, draw a card.
  {
    id: '09bd4e1c-9861-481f-80dc-4de955c8d3af',
    name: 'Cloudkin Seer',
    types: ['creature'],
    cost: { generic: 2, U: 1 },
    power: 2,
    toughness: 1,
    keywords: { flying: true },
    subtypes: ['elemental', 'wizard'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: 'Enters: draw a card',
      },
    ],
  },
  // Equipped creature has flying.
  // Equip {1} ({1}: Attach to target creature you control. Equip only as a sorcery.)
  {
    id: '8d8682f3-9ef3-4aa7-9ea6-8a2ce09bff6f',
    name: 'Cobbled Wings',
    types: ['artifact'],
    cost: { generic: 2 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 1 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {1}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {1}',
      modifies: { power: 0, toughness: 0, keywords: { flying: true } },
    },
  },
  // ({T}: Add {R} or {G}.)
  // This land enters tapped.
  // When this land enters, surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: 'b33656ae-3473-4223-845f-f9147f87678b',
    name: 'Commercial District',
    types: ['land'],
    subtypes: ['mountain', 'forest'],
    entersTapped: true,
    producesOptions: [{ R: 1 }, { G: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'surveil' }], label: 'Enters: surveil 1' }],
  },
  // Draw three cards.
  {
    id: 'a3d287ec-1a39-4f91-acf1-7c1d2c00ed89',
    name: 'Concentrate',
    types: ['sorcery'],
    cost: { generic: 2, U: 2 },
    effects: [{ primitive: 'drawCards', params: { count: 3 } }],
  },
  // Counter target spell unless its controller pays {X}. Scry 2. (Look at the top two cards of your library, then put any number of them on the bottom and the rest on top in any order.)
  {
    id: '96cf3c10-733d-4110-9dab-43d0cd4e6629',
    name: 'Condescend',
    types: ['instant'],
    cost: { U: 1 },
    xCost: 1,
    effects: [
      { primitive: 'counterUnlessPaid', params: { targets: 'spell', unlessPaidX: true } },
      { primitive: 'scry', params: { count: 2 } },
    ],
  },
  // Surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  // Draw a card.
  {
    id: '4c9bcba6-87b5-4fb3-97ee-6fe5b739337d',
    name: 'Consider',
    types: ['instant'],
    cost: { U: 1 },
    effects: [{ primitive: 'surveil' }, { primitive: 'drawCards', params: { count: 1 } }],
  },
  // {T}: Add {G}.
  {
    id: '8b52f30c-5e38-4333-88ab-901b37105b36',
    name: 'Copper Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 1,
    toughness: 1,
    subtypes: ['myr'],
    produces: ['G'],
  },
  {
    id: '4ed27607-21a8-4bc3-997e-6d2242313f6d',
    name: 'Coral Merfolk',
    types: ['creature'],
    cost: { generic: 1, U: 1 },
    power: 2,
    toughness: 1,
    subtypes: ['merfolk'],
  },
  {
    id: '6a462a69-3e42-41de-a3aa-a488d9f38d69',
    name: 'Craw Wurm',
    types: ['creature'],
    cost: { generic: 4, G: 2 },
    power: 6,
    toughness: 4,
    subtypes: ['wurm'],
  },
  // Target creature gets -2/-2 until end of turn.
  // Flashback—{1}{B}, Pay 3 life. (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'd87190d0-bda3-4ad9-84b2-019f751999ce',
    name: 'Crippling Fatigue',
    types: ['sorcery'],
    cost: { generic: 1, B: 2 },
    flashback: { generic: 1, B: 1 },
    flashbackLifeCost: 3,
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: -2, toughness: -2, targets: 'creature' } }],
  },
  // Choose one —
  // • Return target permanent to its owner's hand.
  // • Destroy target nonblack creature. It can't be regenerated.
  // • Destroy target artifact.
  {
    id: 'e59d70a2-40ac-45b0-995d-65b9caa290c8',
    name: 'Crosis\'s Charm',
    types: ['instant'],
    cost: { U: 1, B: 1, R: 1 },
    modal: {
      min: 1,
      max: 1,
      modes: [
        {
          id: 'mode1',
          label: 'Return target permanent to its owner\'s hand',
          effects: [{ primitive: 'returnToHand', params: { targets: 'permanent' } }],
          targets: 'permanent',
        },
        {
          id: 'mode2',
          label: 'Destroy target nonblack creature',
          effects: [{ primitive: 'destroyTarget', params: { targets: 'creature', notColor: 'B' } }],
          targets: 'creature',
        },
        {
          id: 'mode3',
          label: 'Destroy target artifact',
          effects: [{ primitive: 'destroyTarget', params: { targets: 'artifact' } }],
          targets: 'artifact',
        },
      ],
    },
  },
  // Choose one —
  // • Return target creature card from your graveyard to your hand.
  // • Darigaaz's Charm deals 3 damage to any target.
  // • Target creature gets +3/+3 until end of turn.
  {
    id: '7ee01801-5e42-4916-a359-64e9975090a7',
    name: 'Darigaaz\'s Charm',
    types: ['instant'],
    cost: { B: 1, R: 1, G: 1 },
    modal: {
      min: 1,
      max: 1,
      modes: [
        {
          id: 'mode1',
          label: 'Return target creature card from your graveyard to your hand',
          effects: [
            {
              primitive: 'returnFromGraveyard',
              params: { count: 1, filter: { anyOfTypes: ['creature'] } },
            },
          ],
        },
        {
          id: 'mode2',
          label: 'Darigaaz\'s Charm deals 3 damage to any target',
          effects: [{ primitive: 'dealDamage', params: { amount: 3 } }],
          targets: 'any',
        },
        {
          id: 'mode3',
          label: 'Target creature gets +3/+3 until end of turn',
          effects: [
            {
              primitive: 'pumpUntilEndOfTurn',
              params: { power: 3, toughness: 3, targets: 'creature' },
            },
          ],
          targets: 'creature',
        },
      ],
    },
  },
  // Enchant creature
  // When this Aura enters, you lose 1 life.
  // Enchanted creature gets +3/+1.
  {
    id: 'c1f4a440-638a-4e3e-8a3e-af4a4a73ec91',
    name: 'Dark Favor',
    types: ['enchantment'],
    cost: { generic: 1, B: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'loseLife', params: { amount: 1 } }],
        label: 'Enters: you lose 1 life',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 3, toughness: 1, keywords: {} },
    },
  },
  // This land enters tapped.
  // Indestructible
  // {T}: Add {B} or {G}.
  {
    id: '2065cada-4078-41c4-9e06-2460d2a2e8ee',
    name: 'Darkmoss Bridge',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    entersTapped: true,
    producesOptions: [{ B: 1 }, { G: 1 }],
  },
  // Indestructible (Effects that say "destroy" don't destroy this Equipment.)
  // Equipped creature gets +2/+0.
  // Equip {2}
  {
    id: '3b7ea3ac-ac0a-40aa-b743-d153e1c47d8c',
    name: 'Darksteel Axe',
    types: ['artifact'],
    cost: { generic: 1 },
    keywords: { indestructible: true },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 2 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {2}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {2}',
      modifies: { power: 2, toughness: 0, keywords: {} },
    },
  },
  // Indestructible
  // {T}: Add {C}.
  {
    id: '8dc067bf-f78f-4ac4-b6e7-b305c42cf0bc',
    name: 'Darksteel Citadel',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    produces: ['C'],
  },
  // Indestructible (Effects that say "destroy" don't destroy this artifact.)
  // {T}: Add one mana of any color.
  {
    id: 'a2529491-7389-4cfa-92d2-145eda779603',
    name: 'Darksteel Ingot',
    types: ['artifact'],
    cost: { generic: 3 },
    keywords: { indestructible: true },
    producesOptions: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
  },
  // Indestructible (Damage and effects that say "destroy" don't destroy this creature. If its toughness is 0 or less, it still dies.)
  {
    id: 'f90fe86c-5cca-483b-93c2-6e856fa01c88',
    name: 'Darksteel Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 3 },
    power: 0,
    toughness: 1,
    keywords: { indestructible: true },
    subtypes: ['myr'],
  },
  // Indestructible (Effects that say "destroy" don't destroy this artifact.)
  // {1}, {T}: Scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  {
    id: '431838a8-f020-4e4e-a6f4-2d4ca27c56df',
    name: 'Darksteel Pendant',
    types: ['artifact'],
    cost: { generic: 2 },
    keywords: { indestructible: true },
    activated: [
      {
        cost: { mana: { generic: 1 }, tap: true },
        effects: [{ primitive: 'scry' }],
        label: '{1}, {t}: scry 1',
      },
    ],
  },
  // Indestructible
  // Equipped creature has indestructible.
  // Equip {2}
  {
    id: 'b5b4cf54-ed5e-42d0-9d98-5fec76b0b0b8',
    name: 'Darksteel Plate',
    types: ['artifact'],
    cost: { generic: 3 },
    keywords: { indestructible: true },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 2 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {2}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {2}',
      modifies: { power: 0, toughness: 0, keywords: { indestructible: true } },
    },
  },
  // Flash (You may cast this spell any time you could cast an instant.)
  // Vigilance
  // Indestructible (Damage and effects that say "destroy" don't destroy this creature. If its toughness is 0 or less, it's still put into its owner's graveyard.)
  {
    id: 'b91c8946-591b-4c0d-a37e-36803df40db7',
    name: 'Darksteel Sentinel',
    types: ['artifact', 'creature'],
    cost: { generic: 6 },
    power: 3,
    toughness: 3,
    keywords: { flash: true, vigilance: true, indestructible: true },
    subtypes: ['golem'],
  },
  // Destroy all creatures.
  {
    id: 'd057289d-5e28-43d5-8ff3-4a1bc723477d',
    name: 'Day of Judgment',
    types: ['sorcery'],
    cost: { generic: 2, W: 2 },
    effects: [{ primitive: 'destroyAll' }],
  },
  // Enchant creature
  // Enchanted creature gets -2/-2.
  {
    id: 'b1804304-fac1-4b19-a48d-6ade9407972a',
    name: 'Dead Weight',
    types: ['enchantment'],
    cost: { B: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: -2, toughness: -2, keywords: {} },
    },
  },
  // Reach (This creature can block creatures with flying.)
  // Deathtouch (Any amount of damage this deals to a creature is enough to destroy it.)
  {
    id: '6b941291-1802-4ced-9869-39fa43825550',
    name: 'Deadly Recluse',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 1,
    toughness: 2,
    keywords: { reach: true, deathtouch: true },
    subtypes: ['spider'],
  },
  // Death Grasp deals X damage to any target. You gain X life.
  {
    id: 'a2335149-d2db-48c1-9699-0df8ce12d4dd',
    name: 'Death Grasp',
    types: ['sorcery'],
    cost: { W: 1, B: 1 },
    xCost: 1,
    effects: [
      { primitive: 'dealDamage', params: { amount: { chosenX: true } } },
      { primitive: 'gainLife', params: { amount: { chosenX: true } } },
    ],
  },
  // Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.
  // Flashback {4}{G} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'a823e880-3d5f-4186-a7da-e710a7db583c',
    name: 'Deep Reconnaissance',
    types: ['sorcery'],
    cost: { generic: 2, G: 1 },
    flashback: { generic: 4, G: 1 },
    effects: [
      {
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          filter: { anyOfTypes: ['land'] },
          nameAnyOf: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'],
          destination: 'battlefield',
          tapped: true,
        },
      },
    ],
  },
  // Devil's Play deals X damage to any target.
  // Flashback {X}{R}{R}{R} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'ee9f0b29-8a54-4cb8-8e2c-7bd67c2184ba',
    name: 'Devil\'s Play',
    types: ['sorcery'],
    cost: { R: 1 },
    xCost: 1,
    flashback: { R: 3 },
    flashbackXCost: 1,
    effects: [{ primitive: 'dealDamage', params: { amount: { chosenX: true } } }],
  },
  // This land enters tapped.
  // {T}: Add {U} or {B}.
  {
    id: '52d14717-0cbc-4d7e-b546-54ea91580338',
    name: 'Dimir Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ U: 1 }, { B: 1 }],
  },
  // This creature enters tapped.
  {
    id: '6048fc70-0dcc-4b54-977d-16e240225f82',
    name: 'Diregraf Ghoul',
    types: ['creature'],
    cost: { B: 1 },
    power: 2,
    toughness: 2,
    subtypes: ['zombie'],
    entersTapped: true,
  },
  // Target creature gets -2/-2 until end of turn.
  {
    id: '77eafe49-b9c5-461d-89c5-cec217dd2974',
    name: 'Disfigure',
    types: ['instant'],
    cost: { B: 1 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: -2, toughness: -2, targets: 'creature' } }],
  },
  // This land enters tapped.
  // When this land enters, you gain 1 life.
  // {T}: Add {U} or {B}.
  {
    id: '865a2194-fca0-446e-aae3-ca475cd66e00',
    name: 'Dismal Backwater',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ U: 1 }, { B: 1 }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
        label: 'Enters: you gain 1 life',
      },
    ],
  },
  // Counter target spell.
  // Draw a card.
  {
    id: '5c828a5e-10ae-4f63-86fd-2f160af43cc3',
    name: 'Dismiss',
    types: ['instant'],
    cost: { generic: 2, U: 2 },
    effects: [
      { primitive: 'counterSpell', params: { targets: 'spell' } },
      { primitive: 'drawCards', params: { count: 1 } },
    ],
  },
  // Draw two cards.
  {
    id: '273b339c-964b-4a18-8eb5-ceb8abcdfd9e',
    name: 'Divination',
    types: ['sorcery'],
    cost: { generic: 2, U: 1 },
    effects: [{ primitive: 'drawCards', params: { count: 2 } }],
  },
  // Create two 1/1 red Goblin creature tokens.
  {
    id: 'd0d2c45b-b6e3-4999-bdab-976e8f0d6617',
    name: 'Dragon Fodder',
    types: ['sorcery'],
    cost: { generic: 1, R: 1 },
    effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Goblin', count: 2 } }],
  },
  // Target player mills three cards.
  // Flashback {1}{U} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'd569d969-ce39-4314-b5f0-76b45f5c4c7f',
    name: 'Dream Twist',
    types: ['instant'],
    cost: { U: 1 },
    flashback: { generic: 1, U: 1 },
    effects: [{ primitive: 'mill', params: { amount: 3, targets: 'player' } }],
  },
  // Choose one —
  // • You gain 5 life.
  // • Counter target spell.
  // • Target creature gets -2/-2 until end of turn.
  {
    id: 'e9950393-8458-4132-9dc7-01246282a41a',
    name: 'Dromar\'s Charm',
    types: ['instant'],
    cost: { W: 1, U: 1, B: 1 },
    modal: {
      min: 1,
      max: 1,
      modes: [
        {
          id: 'mode1',
          label: 'You gain 5 life',
          effects: [{ primitive: 'gainLife', params: { amount: 5 } }],
        },
        {
          id: 'mode2',
          label: 'Counter target spell',
          effects: [{ primitive: 'counterSpell', params: { targets: 'spell' } }],
          targets: 'spell',
        },
        {
          id: 'mode3',
          label: 'Target creature gets -2/-2 until end of turn',
          effects: [
            {
              primitive: 'pumpUntilEndOfTurn',
              params: { power: -2, toughness: -2, targets: 'creature' },
            },
          ],
          targets: 'creature',
        },
      ],
    },
  },
  // This land enters tapped.
  // Indestructible
  // {T}: Add {B} or {R}.
  {
    id: '44b83535-fdbf-4307-bf53-ca20470a768d',
    name: 'Drossforge Bridge',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    entersTapped: true,
    producesOptions: [{ B: 1 }, { R: 1 }],
  },
  // Trample
  // Whenever you cast an instant or sorcery spell, put a +1/+1 counter on this creature.
  {
    id: 'ba8883fc-db24-4c3d-ae36-05085089c9cc',
    name: 'Electrostatic Infantry',
    types: ['creature'],
    cost: { generic: 1, R: 1 },
    power: 1,
    toughness: 2,
    keywords: { trample: true },
    subtypes: ['dwarf', 'wizard'],
    triggers: [
      {
        condition: { on: 'castSpell', who: 'you', spellType: 'instant' },
        effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
        label: 'Cast instant: put a +1/+1 counter on ~',
      },
      {
        condition: { on: 'castSpell', who: 'you', spellType: 'sorcery' },
        effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
        label: 'Cast sorcery: put a +1/+1 counter on ~',
      },
    ],
  },
  // ({T}: Add {R} or {W}.)
  // This land enters tapped.
  // When this land enters, surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: '9ea747cf-5d04-4aa7-bdc3-8145860cd1ba',
    name: 'Elegant Parlor',
    types: ['land'],
    subtypes: ['mountain', 'plains'],
    entersTapped: true,
    producesOptions: [{ R: 1 }, { W: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'surveil' }], label: 'Enters: surveil 1' }],
  },
  {
    id: 'b3b9a87d-cb95-435c-90b6-037406cab32e',
    name: 'Elite Vanguard',
    types: ['creature'],
    cost: { W: 1 },
    power: 2,
    toughness: 1,
    subtypes: ['human', 'soldier'],
  },
  // {T}: Add {G}.
  {
    id: '3f3b2c10-21f8-4e13-be83-4ef3fa36e123',
    name: 'Elvish Mystic',
    types: ['creature'],
    cost: { G: 1 },
    power: 1,
    toughness: 1,
    subtypes: ['elf', 'druid'],
    produces: ['G'],
  },
  // When this creature enters, draw a card.
  {
    id: 'c6a3a882-a127-4590-93d7-679ef4313efe',
    name: 'Elvish Visionary',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 1,
    toughness: 1,
    subtypes: ['elf', 'shaman'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: 'Enters: draw a card',
      },
    ],
  },
  // Enchant creature (Target a creature as you cast this. This card enters attached to that creature.)
  // Enchanted creature gets -2/-2.
  {
    id: '42b2db4c-4a1d-436f-9eeb-53a04db46c58',
    name: 'Enfeeblement',
    types: ['enchantment'],
    cost: { B: 2 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: -2, toughness: -2, keywords: {} },
    },
  },
  // {T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.
  {
    id: 'a75445d3-1303-4bb5-89ad-26ea93fecd48',
    name: 'Evolving Wilds',
    types: ['land'],
    activated: [
      {
        cost: { tap: true, sacrificeSelf: true },
        effects: [
          {
            primitive: 'searchLibrary',
            params: {
              who: 'controller',
              count: 1,
              filter: { anyOfTypes: ['land'] },
              nameAnyOf: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'],
              destination: 'battlefield',
              tapped: true,
            },
          },
        ],
        label: '{t}, sacrifice ~: search your library for a basic land card, put it onto the battlefield tapped, then shuffle',
      },
    ],
  },
  // Vigilance
  // This creature enters with three +1/+1 counters on it.
  {
    id: '139fb542-89fd-4b9e-87e6-ec925bcca93a',
    name: 'Faithful Watchdog',
    types: ['creature'],
    cost: { W: 1, G: 1 },
    power: 0,
    toughness: 0,
    keywords: { vigilance: true },
    subtypes: ['dog'],
    effects: [{ primitive: 'addCounters', params: { amount: 3, self: true } }],
  },
  // Double strike (This creature deals both first-strike and regular combat damage.)
  {
    id: '2f810936-2ba6-4c2b-84a0-ff4c1deb026b',
    name: 'Fencing Ace',
    types: ['creature'],
    cost: { generic: 1, W: 1 },
    power: 1,
    toughness: 1,
    keywords: { doubleStrike: true },
    subtypes: ['human', 'soldier'],
  },
  // This artifact enters tapped.
  // {T}: Add {R}.
  {
    id: '97b477d8-2e05-475e-8ed6-7d680cb21cd9',
    name: 'Fire Diamond',
    types: ['artifact'],
    cost: { generic: 2 },
    entersTapped: true,
    produces: ['R'],
  },
  {
    id: '3912d21e-1ebc-4a81-9dc9-f404248d564a',
    name: 'Fire Elemental',
    types: ['creature'],
    cost: { generic: 3, R: 2 },
    power: 5,
    toughness: 4,
    subtypes: ['elemental'],
  },
  // Kicker {4} (You may pay an additional {4} as you cast this spell.)
  // Firebending Lesson deals 2 damage to target creature. If this spell was kicked, it deals 5 damage to that creature instead.
  {
    id: 'a9282f91-638e-414b-8b3d-9a99e30aec96',
    name: 'Firebending Lesson',
    types: ['instant'],
    cost: { R: 1 },
    subtypes: ['lesson'],
    kicker: { generic: 4 },
    effects: [{ primitive: 'dealDamage', params: { amount: { base: 2, kicked: 5 }, targets: 'creature' } }],
  },
  // Firebolt deals 2 damage to any target.
  // Flashback {4}{R} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: '7aa31280-12c3-479d-a6dd-f1c669043083',
    name: 'Firebolt',
    types: ['sorcery'],
    cost: { R: 1 },
    flashback: { generic: 4, R: 1 },
    effects: [{ primitive: 'dealDamage', params: { amount: 2 } }],
  },
  // Equipped creature has double strike. (It deals both first-strike and regular combat damage.)
  // Equip {2} ({2}: Attach to target creature you control. Equip only as a sorcery.)
  {
    id: 'a02e1ca7-23c5-41e3-a744-72fc9e9dd8ba',
    name: 'Fireshrieker',
    types: ['artifact'],
    cost: { generic: 3 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 2 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {2}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {2}',
      modifies: { power: 0, toughness: 0, keywords: { doubleStrike: true } },
    },
  },
  // Flame Slash deals 4 damage to target creature.
  {
    id: '8d98d674-6811-4d45-b22a-63792e272a2b',
    name: 'Flame Slash',
    types: ['sorcery'],
    cost: { R: 1 },
    effects: [{ primitive: 'dealDamage', params: { amount: 4, targets: 'creature' } }],
  },
  // Enchant creature
  // Enchanted creature has flying.
  {
    id: '6a4068b0-fb4f-429c-a94e-47849f3eb7ef',
    name: 'Flight',
    types: ['enchantment'],
    cost: { U: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 0, toughness: 0, keywords: { flying: true } },
    },
  },
  // {T}: Add {G}.
  {
    id: 'df317532-7d36-40fd-938f-e972749c8792',
    name: 'Fyndhorn Elves',
    types: ['creature'],
    cost: { G: 1 },
    power: 1,
    toughness: 1,
    subtypes: ['elf', 'druid'],
    produces: ['G'],
  },
  // Trample (This creature can deal excess combat damage to the player or planeswalker it's attacking.)
  {
    id: '32fc8fa7-7e0a-4d4e-85cf-2f98b3fc6ecf',
    name: 'Garruk\'s Companion',
    types: ['creature'],
    cost: { G: 2 },
    power: 3,
    toughness: 2,
    keywords: { trample: true },
    subtypes: ['beast'],
  },
  // Geistflame deals 1 damage to any target.
  // Flashback {3}{R} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: '2f01c3d9-e0fc-4cdf-b4db-daeb8bb24bc3',
    name: 'Geistflame',
    types: ['instant'],
    cost: { R: 1 },
    flashback: { generic: 3, R: 1 },
    effects: [{ primitive: 'dealDamage', params: { amount: 1 } }],
  },
  // Reach (This creature can block creatures with flying.)
  {
    id: 'e740ce2f-2134-473c-afa1-1b6d2d1e38ef',
    name: 'Giant Spider',
    types: ['creature'],
    cost: { generic: 3, G: 1 },
    power: 2,
    toughness: 4,
    keywords: { reach: true },
    subtypes: ['spider'],
  },
  // Enchant creature
  // Enchanted creature gets +1/+1 and has flying and lifelink.
  {
    id: 'dcb6d317-5c55-4973-8e3d-2e98211dc30e',
    name: 'Gift of Orzhova',
    types: ['enchantment'],
    cost: { generic: 1, hybrid: [['W', 'B'], ['W', 'B']] },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 1, toughness: 1, keywords: { flying: true, lifelink: true } },
    },
  },
  // Target player mills ten cards.
  {
    id: '552f0163-a19d-4671-888f-044fc0354875',
    name: 'Glimpse the Unthinkable',
    types: ['sorcery'],
    cost: { U: 1, B: 1 },
    effects: [{ primitive: 'mill', params: { amount: 10, targets: 'player' } }],
  },
  // When this creature enters, create a 1/1 red Goblin creature token.
  {
    id: '8b022754-6d16-470e-b754-4df6e4f4709e',
    name: 'Goblin Instigator',
    types: ['creature'],
    cost: { generic: 1, R: 1 },
    power: 1,
    toughness: 1,
    subtypes: ['goblin', 'rogue'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Goblin' } }],
        label: 'Enters: create a 1/1 red goblin creature token',
      },
    ],
  },
  {
    id: '50608184-90d3-43d2-a221-deb186c78323',
    name: 'Goblin Piker',
    types: ['creature'],
    cost: { generic: 1, R: 1 },
    power: 2,
    toughness: 1,
    subtypes: ['goblin', 'warrior'],
  },
  // Enchant creature
  // Enchanted creature gets +2/+2 and has haste.
  {
    id: '67ca79d7-9064-4605-8625-b1cfe5cb1b45',
    name: 'Goblin War Paint',
    types: ['enchantment'],
    cost: { generic: 1, R: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 2, toughness: 2, keywords: { haste: true } },
    },
  },
  // {T}: Add {W}.
  {
    id: 'bd6af7b3-b30f-4a65-a18f-8655f778e76a',
    name: 'Gold Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 1,
    toughness: 1,
    subtypes: ['myr'],
    produces: ['W'],
  },
  // This land enters tapped.
  // Indestructible
  // {T}: Add {W} or {B}.
  {
    id: 'c9b7ea9c-3bcb-4538-aa25-cdb82a52037e',
    name: 'Goldmire Bridge',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    entersTapped: true,
    producesOptions: [{ W: 1 }, { B: 1 }],
  },
  // This land enters tapped.
  // {T}: Add {B} or {G}.
  {
    id: 'fa2da325-6859-45bb-b185-35526b01bcc1',
    name: 'Golgari Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ B: 1 }, { G: 1 }],
  },
  // Target creature gets -4/-4 until end of turn.
  {
    id: '494c819d-7d73-432b-8c96-4cb9dcd31094',
    name: 'Grasp of Darkness',
    types: ['instant'],
    cost: { B: 2 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: -4, toughness: -4, targets: 'creature' } }],
  },
  // When this creature enters, you may return target creature card from your graveyard to your hand.
  {
    id: '1a2030cc-d7ee-4059-b2d7-fb95ea8e267b',
    name: 'Gravedigger',
    types: ['creature'],
    cost: { generic: 3, B: 1 },
    power: 2,
    toughness: 2,
    subtypes: ['zombie'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [
          {
            primitive: 'returnFromGraveyard',
            params: { count: 1, filter: { anyOfTypes: ['creature'] }, optional: true },
          },
        ],
        label: 'Enters: you may return target creature card from your graveyard to your hand',
      },
    ],
  },
  // Choose one or both —
  // • Return target creature card from your graveyard to your hand.
  // • Return target land card from your graveyard to your hand.
  {
    id: 'be78d7ca-b904-452f-b9eb-34792e588986',
    name: 'Grim Discovery',
    types: ['sorcery'],
    cost: { generic: 1, B: 1 },
    modal: {
      min: 1,
      max: 2,
      modes: [
        {
          id: 'mode1',
          label: 'Return target creature card from your graveyard to your hand',
          effects: [
            {
              primitive: 'returnFromGraveyard',
              params: { count: 1, filter: { anyOfTypes: ['creature'] } },
            },
          ],
        },
        {
          id: 'mode2',
          label: 'Return target land card from your graveyard to your hand',
          effects: [
            {
              primitive: 'returnFromGraveyard',
              params: { count: 1, filter: { anyOfTypes: ['land'] } },
            },
          ],
        },
      ],
    },
  },
  {
    id: '14c8f55d-d177-4c25-a931-ebeb9e6062a0',
    name: 'Grizzly Bears',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 2,
    toughness: 2,
    subtypes: ['bear'],
  },
  // This land enters tapped.
  // {T}: Add {R} or {G}.
  {
    id: 'd38476e9-2e47-4c0c-8129-483c0bd09ec0',
    name: 'Gruul Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ R: 1 }, { G: 1 }],
  },
  // Whenever you cast an instant or sorcery spell, this creature deals 2 damage to each opponent.
  {
    id: 'c6bdaf76-6a03-4695-9c4b-f040e73435af',
    name: 'Guttersnipe',
    types: ['creature'],
    cost: { generic: 2, R: 1 },
    power: 2,
    toughness: 2,
    subtypes: ['goblin', 'shaman'],
    triggers: [
      {
        condition: { on: 'castSpell', who: 'you', spellType: 'instant' },
        effects: [{ primitive: 'dealDamageToEach', params: { amount: 2, opponents: true } }],
        label: 'Cast instant: ~ deals 2 damage to each opponent',
      },
      {
        condition: { on: 'castSpell', who: 'you', spellType: 'sorcery' },
        effects: [{ primitive: 'dealDamageToEach', params: { amount: 2, opponents: true } }],
        label: 'Cast sorcery: ~ deals 2 damage to each opponent',
      },
    ],
  },
  // Ward {2} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {2}.)
  // Harmonious Grovestrider's power and toughness are each equal to the number of lands you control.
  {
    id: '0ebec97e-3cb1-41e2-a693-0febb5623016',
    name: 'Harmonious Grovestrider',
    types: ['creature'],
    cost: { generic: 3, G: 2 },
    characteristicPT: { power: { countOf: 'landsYouControl' }, toughness: { countOf: 'landsYouControl' } },
    keywords: { ward: 2 },
    subtypes: ['beast'],
  },
  // Flying
  // Lifelink (Damage dealt by this creature also causes you to gain that much life.)
  {
    id: '28a52ba1-95da-44e1-8ac5-0dc23c902394',
    name: 'Healer\'s Hawk',
    types: ['creature'],
    cost: { W: 1 },
    power: 1,
    toughness: 1,
    keywords: { flying: true, lifelink: true },
    subtypes: ['bird'],
  },
  // Heat Ray deals X damage to target creature.
  {
    id: '76ec76b9-da0f-4b9d-ad0a-d734052a5f2b',
    name: 'Heat Ray',
    types: ['instant'],
    cost: { R: 1 },
    xCost: 1,
    effects: [{ primitive: 'dealDamage', params: { amount: { chosenX: true }, targets: 'creature' } }],
  },
  // ({T}: Add {G} or {U}.)
  // This land enters tapped.
  // When this land enters, surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: 'ca4b6689-04ee-4227-9bdc-cb5a9590c745',
    name: 'Hedge Maze',
    types: ['land'],
    subtypes: ['forest', 'island'],
    entersTapped: true,
    producesOptions: [{ G: 1 }, { U: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'surveil' }], label: 'Enters: surveil 1' }],
  },
  {
    id: '342199e0-15b6-4824-83da-25caef2592b3',
    name: 'Hill Giant',
    types: ['creature'],
    cost: { generic: 3, R: 1 },
    power: 3,
    toughness: 3,
    subtypes: ['giant'],
  },
  // Enchant creature
  // Enchanted creature gets +1/+2.
  {
    id: '9357de36-f8be-4f49-b2c8-9fe9eaf82b07',
    name: 'Holy Strength',
    types: ['enchantment'],
    cost: { W: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 1, toughness: 2, keywords: {} },
    },
  },
  // Kicker {W} (You may pay an additional {W} as you cast this spell.)
  // Hurloon Battle Hymn deals 4 damage to target creature or planeswalker. If this spell was kicked, you gain 4 life.
  {
    id: '2f541bf9-1e5b-4d16-8558-a5cfce7e93ad',
    name: 'Hurloon Battle Hymn',
    types: ['instant'],
    cost: { generic: 2, R: 1 },
    kicker: { W: 1 },
    effects: [
      { primitive: 'dealDamage', params: { amount: 4, targets: 'creatureOrPlaneswalker' } },
      {
        primitive: 'ifKicked',
        params: { effects: [{ primitive: 'gainLife', params: { amount: 4 } }] },
      },
    ],
  },
  // Choose one —
  // • Draw X cards.
  // • Invoke the Firemind deals X damage to any target.
  {
    id: '2037659f-2efe-4321-afaf-961bbec35e9e',
    name: 'Invoke the Firemind',
    types: ['sorcery'],
    cost: { U: 2, R: 1 },
    xCost: 1,
    modal: {
      min: 1,
      max: 1,
      modes: [
        {
          id: 'mode1',
          label: 'Draw x cards',
          effects: [{ primitive: 'drawCards', params: { count: { chosenX: true } } }],
        },
        {
          id: 'mode2',
          label: 'Invoke the Firemind deals x damage to any target',
          effects: [{ primitive: 'dealDamage', params: { amount: { chosenX: true } } }],
          targets: 'any',
        },
      ],
    },
  },
  // {T}: Add {R}.
  {
    id: '6c5cbab6-ee27-46f5-97a7-df85698d1e9f',
    name: 'Iron Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 1,
    toughness: 1,
    subtypes: ['myr'],
    produces: ['R'],
  },
  // This land enters tapped.
  // {T}: Add {U} or {R}.
  {
    id: 'bf75a3d1-f184-4b48-a913-21caee1db084',
    name: 'Izzet Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ U: 1 }, { R: 1 }],
  },
  // This land enters tapped.
  // When this land enters, you gain 1 life.
  // {T}: Add {B} or {G}.
  {
    id: '6de714e1-446d-4fb9-9e3d-bcd3ec6af9ca',
    name: 'Jungle Hollow',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ B: 1 }, { G: 1 }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
        label: 'Enters: you gain 1 life',
      },
    ],
  },
  {
    id: 'df7f697e-6886-4897-a024-61ae225c1b34',
    name: 'Kalonian Tusker',
    types: ['creature'],
    cost: { G: 2 },
    power: 3,
    toughness: 3,
    subtypes: ['beast'],
  },
  // Whenever you cast an instant or sorcery spell, this creature gets +3/+0 until end of turn.
  {
    id: 'eac8c196-8477-4b79-9875-21afa1e61708',
    name: 'Kiln Fiend',
    types: ['creature'],
    cost: { generic: 1, R: 1 },
    power: 1,
    toughness: 2,
    subtypes: ['elemental', 'beast'],
    triggers: [
      {
        condition: { on: 'castSpell', who: 'you', spellType: 'instant' },
        effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 3, toughness: 0 } }],
        label: 'Cast instant: ~ gets +3/+0 until end of turn',
      },
      {
        condition: { on: 'castSpell', who: 'you', spellType: 'sorcery' },
        effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 3, toughness: 0 } }],
        label: 'Cast sorcery: ~ gets +3/+0 until end of turn',
      },
    ],
  },
  // Equipped creature gets +1/+0 and has flying.
  // Equip {2} ({2}: Attach to target creature you control. Equip only as a sorcery.)
  {
    id: 'b079f9db-974d-4525-a894-57b754ba9dcc',
    name: 'Kitesail',
    types: ['artifact'],
    cost: { generic: 2 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 2 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {2}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {2}',
      modifies: { power: 1, toughness: 0, keywords: { flying: true } },
    },
  },
  // Create two 1/1 red Goblin creature tokens.
  {
    id: '9cfe86ae-eebe-44aa-a956-4b3e9e621105',
    name: 'Krenko\'s Command',
    types: ['sorcery'],
    cost: { generic: 1, R: 1 },
    effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Goblin', count: 2 } }],
  },
  // Target creature gets -3/-3 until end of turn.
  {
    id: 'a82c3860-4dd6-4ffd-aa8f-ab8df687db6c',
    name: 'Last Gasp',
    types: ['instant'],
    cost: { generic: 1, B: 1 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: -3, toughness: -3, targets: 'creature' } }],
  },
  // Lava Spike deals 3 damage to target player or planeswalker.
  {
    id: '2837888c-bfa8-4955-9334-0605ad409f7e',
    name: 'Lava Spike',
    types: ['sorcery'],
    cost: { R: 1 },
    subtypes: ['arcane'],
    effects: [{ primitive: 'dealDamage', params: { amount: 3, targets: 'playerOrPlaneswalker' } }],
  },
  // {T}: Add {B}.
  {
    id: 'f62cabf0-df0d-4c4f-a93a-9340967d1775',
    name: 'Leaden Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 1,
    toughness: 1,
    subtypes: ['myr'],
    produces: ['B'],
  },
  {
    id: '0ee14128-3bec-4b65-8ee4-619337d4ed45',
    name: 'Leatherback Baloth',
    types: ['creature'],
    cost: { G: 3 },
    power: 4,
    toughness: 5,
    subtypes: ['beast'],
  },
  // Equipped creature gets +1/+1.
  // Equip {1} ({1}: Attach to target creature you control. Equip only as a sorcery.)
  {
    id: 'cde26d69-f3e7-4dd0-a53b-cd0ec812d717',
    name: 'Leonin Scimitar',
    types: ['artifact'],
    cost: { generic: 1 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 1 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {1}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {1}',
      modifies: { power: 1, toughness: 1, keywords: {} },
    },
  },
  // Flying
  {
    id: '517c7295-8ba2-47a6-a1c6-aee722f8ca88',
    name: 'Leonin Skyhunter',
    types: ['creature'],
    cost: { W: 2 },
    power: 2,
    toughness: 2,
    keywords: { flying: true },
    subtypes: ['cat', 'knight'],
  },
  // Flying, vigilance, haste
  {
    id: '2be85439-4606-4e1e-8be7-56d9e31f77c4',
    name: 'Lightning Angel',
    types: ['creature'],
    cost: { generic: 1, W: 1, U: 1, R: 1 },
    power: 3,
    toughness: 4,
    keywords: { flying: true, vigilance: true, haste: true },
    subtypes: ['angel'],
  },
  // Haste (This creature can attack and {T} as soon as it comes under your control.)
  {
    id: '58aee5cb-7b88-446e-ab10-9f83c10d7227',
    name: 'Lightning Elemental',
    types: ['creature'],
    cost: { generic: 3, R: 1 },
    power: 4,
    toughness: 1,
    keywords: { haste: true },
    subtypes: ['elemental'],
  },
  // Lightning Helix deals 3 damage to any target and you gain 3 life.
  {
    id: '800c258a-cfc4-4a54-a667-065ea8dea69e',
    name: 'Lightning Helix',
    types: ['instant'],
    cost: { W: 1, R: 1 },
    effects: [
      { primitive: 'dealDamage', params: { amount: 3 } },
      { primitive: 'gainLife', params: { amount: 3 } },
    ],
  },
  // Lightning Strike deals 3 damage to any target.
  {
    id: 'f34b9bc4-7bfe-47fd-ba23-4eeeb46026eb',
    name: 'Lightning Strike',
    types: ['instant'],
    cost: { generic: 1, R: 1 },
    effects: [{ primitive: 'dealDamage', params: { amount: 3 } }],
  },
  // Create two 1/1 white Spirit creature tokens with flying.
  // Flashback {1}{B} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: '0b8c3337-04dd-4798-8203-6d8b8cfb936b',
    name: 'Lingering Souls',
    types: ['sorcery'],
    cost: { generic: 2, W: 1 },
    flashback: { generic: 1, B: 1 },
    effects: [
      {
        primitive: 'makeToken',
        params: { power: 1, toughness: 1, name: 'Spirit', count: 2, keywords: { flying: true } },
      },
    ],
  },
  // When this creature enters, you gain 4 life.
  {
    id: '626f1dc3-3b14-4873-902f-ffec5487a97d',
    name: 'Lone Missionary',
    types: ['creature'],
    cost: { generic: 1, W: 1 },
    power: 2,
    toughness: 1,
    subtypes: ['kor', 'monk'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 4 } }],
        label: 'Enters: you gain 4 life',
      },
    ],
  },
  // Equipped creature gets +3/+0 and has trample and lifelink.
  // Equip {3}
  {
    id: 'dba35ac5-7ad3-488a-a006-6b9a1d54eea5',
    name: 'Loxodon Warhammer',
    types: ['artifact'],
    cost: { generic: 3 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 3 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {3}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {3}',
      modifies: { power: 3, toughness: 0, keywords: { trample: true, lifelink: true } },
    },
  },
  // ({T}: Add {G} or {W}.)
  // This land enters tapped.
  // When this land enters, surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: 'd51831b1-7394-456e-a1de-6787a59f5932',
    name: 'Lush Portico',
    types: ['land'],
    subtypes: ['forest', 'plains'],
    entersTapped: true,
    producesOptions: [{ G: 1 }, { W: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'surveil' }], label: 'Enters: surveil 1' }],
  },
  // Magma Jet deals 2 damage to any target. Scry 2.
  {
    id: '2f292253-64d3-4cf2-881f-a3eea4fda388',
    name: 'Magma Jet',
    types: ['instant'],
    cost: { generic: 1, R: 1 },
    effects: [
      { primitive: 'dealDamage', params: { amount: 2 } },
      { primitive: 'scry', params: { count: 2 } },
    ],
  },
  // When this creature enters, return target creature to its owner's hand.
  {
    id: '67a3541c-8408-40c8-b44f-90035b860f57',
    name: 'Man-o\'-War',
    types: ['creature'],
    cost: { generic: 2, U: 1 },
    power: 2,
    toughness: 2,
    subtypes: ['jellyfish'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'returnToHand', params: { targets: 'creature' } }],
        label: 'Enters: return target creature to its owner\'s hand',
        targets: 'creature',
      },
    ],
  },
  // Counter target spell unless its controller pays {3}.
  {
    id: 'c61fe162-2202-4e56-9ba0-393547f9875f',
    name: 'Mana Leak',
    types: ['instant'],
    cost: { generic: 1, U: 1 },
    effects: [{ primitive: 'counterUnlessPaid', params: { targets: 'spell', unlessPaid: { generic: 3 } } }],
  },
  // {T}: Add one mana of any color.
  {
    id: 'bd9e416a-89b3-4912-be9b-49fce6a93dc9',
    name: 'Manalith',
    types: ['artifact'],
    cost: { generic: 3 },
    producesOptions: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
  },
  // This artifact enters tapped.
  // {T}: Add {W}.
  {
    id: '910488bf-66ab-415e-973b-1262b2ab7454',
    name: 'Marble Diamond',
    types: ['artifact'],
    cost: { generic: 2 },
    entersTapped: true,
    produces: ['W'],
  },
  // Enchant creature
  // Enchanted creature gets +2/+2 and has lifelink.
  {
    id: 'af942d30-a191-4306-846d-6c26755ca3e6',
    name: 'Mark of the Vampire',
    types: ['enchantment'],
    cost: { generic: 3, B: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 2, toughness: 2, keywords: { lifelink: true } },
    },
  },
  // Equipped creature gets +1/+2 and has hexproof. (It can't be the target of spells or abilities your opponents control.)
  // Equip {3}
  {
    id: 'ab66f8a8-eb3d-4c2d-95e9-26a53c66b237',
    name: 'Mask of Avacyn',
    types: ['artifact'],
    cost: { generic: 2 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 3 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {3}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {3}',
      modifies: { power: 1, toughness: 2, keywords: { hexproof: true } },
    },
  },
  {
    id: '7663ac7c-1de3-4250-b96a-fae9dbd66a27',
    name: 'Memnite',
    types: ['artifact', 'creature'],
    power: 1,
    toughness: 1,
    subtypes: ['construct'],
  },
  // ({T}: Add {W} or {U}.)
  // This land enters tapped.
  // When this land enters, surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: 'ccfb8b4d-651c-418a-aa19-cb23105b3f2f',
    name: 'Meticulous Archive',
    types: ['land'],
    subtypes: ['plains', 'island'],
    entersTapped: true,
    producesOptions: [{ W: 1 }, { U: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'surveil' }], label: 'Enters: surveil 1' }],
  },
  // Choose one —
  // • Midnight Charm deals 1 damage to target creature and you gain 1 life.
  // • Target creature gains first strike until end of turn.
  // • Tap target creature.
  {
    id: 'ed228f67-3adf-46d4-ac45-e0278592850d',
    name: 'Midnight Charm',
    types: ['instant'],
    cost: { B: 1 },
    modal: {
      min: 1,
      max: 1,
      modes: [
        {
          id: 'mode1',
          label: 'Midnight Charm deals 1 damage to target creature and you gain 1 life',
          effects: [
            { primitive: 'dealDamage', params: { amount: 1, targets: 'creature' } },
            { primitive: 'gainLife', params: { amount: 1 } },
          ],
          targets: 'creature',
        },
        {
          id: 'mode2',
          label: 'Target creature gains first strike until end of turn',
          effects: [
            {
              primitive: 'grantKeywordUntilEndOfTurn',
              params: { keywords: { firstStrike: true }, targets: 'creature' },
            },
          ],
          targets: 'creature',
        },
        {
          id: 'mode3',
          label: 'Tap target creature',
          effects: [{ primitive: 'tapTarget', params: { targets: 'creature' } }],
          targets: 'creature',
        },
      ],
    },
  },
  // Target creature gets +7/+7 until end of turn.
  {
    id: '8331f281-819b-4a0b-bad7-bd86dbedb877',
    name: 'Might of Oaks',
    types: ['instant'],
    cost: { generic: 3, G: 1 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 7, toughness: 7, targets: 'creature' } }],
  },
  // Target player discards two cards.
  {
    id: 'ad44cf74-b717-48fb-9fa2-77512024d76a',
    name: 'Mind Rot',
    types: ['sorcery'],
    cost: { generic: 2, B: 1 },
    effects: [{ primitive: 'discardCard', params: { count: 2, who: 'targetPlayer', targets: 'player' } }],
  },
  // Target opponent mills seven cards.
  {
    id: '4d8592d7-2e36-4a7a-be9e-7c8f512d5f62',
    name: 'Mind Sculpt',
    types: ['sorcery'],
    cost: { generic: 1, U: 1 },
    effects: [{ primitive: 'mill', params: { amount: 7, targets: 'player' } }],
  },
  // Draw X cards.
  {
    id: '3428287b-cfd5-45bc-b5f9-1e3f5a425a68',
    name: 'Mind Spring',
    types: ['sorcery'],
    cost: { U: 2 },
    xCost: 1,
    effects: [{ primitive: 'drawCards', params: { count: { chosenX: true } } }],
  },
  // {T}: Add {C}.
  // {1}, {T}, Sacrifice this artifact: Draw a card.
  {
    id: 'c97361b5-af16-4a7b-af85-a429dbaf4ad2',
    name: 'Mind Stone',
    types: ['artifact'],
    cost: { generic: 2 },
    produces: ['C'],
    activated: [
      {
        cost: { mana: { generic: 1 }, tap: true, sacrificeSelf: true },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: '{1}, {t}, sacrifice ~: draw a card',
      },
    ],
  },
  // Double strike, protection from black and from green
  {
    id: 'fe69d9bd-2a60-4b33-a0d8-1ca18c2b6705',
    name: 'Mirran Crusader',
    types: ['creature'],
    cost: { generic: 1, W: 2 },
    power: 2,
    toughness: 2,
    keywords: { doubleStrike: true, protectionFrom: ['black', 'green'] },
    subtypes: ['human', 'knight'],
  },
  // This land enters tapped.
  // Indestructible
  // {T}: Add {U} or {B}.
  {
    id: '33ee23bc-6327-4a54-a704-dfd83be36bb5',
    name: 'Mistvault Bridge',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    entersTapped: true,
    producesOptions: [{ U: 1 }, { B: 1 }],
  },
  // Create two 2/2 black Zombie creature tokens.
  // Flashback {5}{B}{B} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'ce87e5ed-2562-4563-9a5b-bd53c04ec4a5',
    name: 'Moan of the Unhallowed',
    types: ['sorcery'],
    cost: { generic: 2, B: 2 },
    flashback: { generic: 5, B: 2 },
    effects: [{ primitive: 'makeToken', params: { power: 2, toughness: 2, name: 'Zombie', count: 2 } }],
  },
  // Return target creature card from your graveyard to your hand.
  // Flashback {4}{B} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: '0b8a508b-20c0-4a87-a73a-08af72c39a0a',
    name: 'Morgue Theft',
    types: ['sorcery'],
    cost: { generic: 1, B: 1 },
    flashback: { generic: 4, B: 1 },
    effects: [
      {
        primitive: 'returnFromGraveyard',
        params: { count: 1, filter: { anyOfTypes: ['creature'] } },
      },
    ],
  },
  // This artifact enters tapped.
  // {T}: Add {G}.
  {
    id: '02500f21-6e15-423e-93ff-891e09fe9904',
    name: 'Moss Diamond',
    types: ['artifact'],
    cost: { generic: 2 },
    entersTapped: true,
    produces: ['G'],
  },
  // Destroy target creature.
  {
    id: '938b4e2c-88d9-4637-bc00-e228920c9a78',
    name: 'Murder',
    types: ['instant'],
    cost: { generic: 1, B: 2 },
    effects: [{ primitive: 'destroyTarget', params: { targets: 'creature' } }],
  },
  // Sacrifice this creature: Put a +1/+1 counter on target creature.
  {
    id: '1a4ffc1e-2f5e-446a-b1e8-32385b3c083b',
    name: 'Myr Scrapling',
    types: ['artifact', 'creature'],
    cost: { generic: 1 },
    power: 1,
    toughness: 1,
    subtypes: ['myr'],
    activated: [
      {
        cost: { sacrificeSelf: true },
        effects: [{ primitive: 'addCounters', params: { amount: 1, targets: 'creature' } }],
        label: 'Sacrifice ~: put a +1/+1 counter on target creature',
      },
    ],
  },
  {
    id: 'e876d1fc-3acd-41a3-a34b-2bfa83204393',
    name: 'Nessian Courser',
    types: ['creature'],
    cost: { generic: 2, G: 1 },
    power: 3,
    toughness: 3,
    subtypes: ['centaur', 'warrior'],
  },
  // You draw two cards and lose 2 life.
  {
    id: '7ffae8f8-3006-4969-a339-6d30678f87ea',
    name: 'Night\'s Whisper',
    types: ['sorcery'],
    cost: { generic: 1, B: 1 },
    effects: [
      { primitive: 'drawCards', params: { count: 2 } },
      { primitive: 'loseLife', params: { amount: 2 } },
    ],
  },
  // Flying, protection from black
  {
    id: '9a642db9-c337-481c-b260-11e01f64e68e',
    name: 'Nightwind Glider',
    types: ['creature'],
    cost: { generic: 2, W: 1 },
    power: 2,
    toughness: 1,
    keywords: { flying: true, protectionFrom: ['black'] },
    subtypes: ['human', 'rebel'],
  },
  // Enchant creature
  // Enchanted creature gets +1/+2 and has flying.
  {
    id: '0f35e73b-6a38-4185-a7d3-d237d67ba1cd',
    name: 'Nimbus Wings',
    types: ['enchantment'],
    cost: { generic: 1, W: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 1, toughness: 2, keywords: { flying: true } },
    },
  },
  // Flash (You may cast this spell any time you could cast an instant.)
  // When this enchantment enters, scry 2, then draw a card.
  // {2}{U}, Sacrifice this enchantment: Scry 2. (Look at the top two cards of your library, then put any number of them on the bottom and the rest on top in any order.)
  {
    id: '41960d32-ddb5-42be-94b2-3a2e77ca148d',
    name: 'Omen of the Sea',
    types: ['enchantment'],
    cost: { generic: 1, U: 1 },
    keywords: { flash: true },
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [
          { primitive: 'scry', params: { count: 2 } },
          { primitive: 'drawCards', params: { count: 1 } },
        ],
        label: 'Enters: scry 2, then draw a card',
      },
    ],
    activated: [
      {
        cost: { mana: { generic: 2, U: 1 }, sacrificeSelf: true },
        effects: [{ primitive: 'scry', params: { count: 2 } }],
        label: '{2}{u}, sacrifice ~: scry 2',
      },
    ],
  },
  // Scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // Draw a card.
  {
    id: '713332c1-5bd8-400f-bfff-c1ca0697a043',
    name: 'Opt',
    types: ['instant'],
    cost: { U: 1 },
    effects: [{ primitive: 'scry' }, { primitive: 'drawCards', params: { count: 1 } }],
  },
  // Flying
  {
    id: 'a3a98bc9-caa0-49b7-951c-fe4e4f54e4ba',
    name: 'Ornithopter',
    types: ['artifact', 'creature'],
    power: 0,
    toughness: 2,
    keywords: { flying: true },
    subtypes: ['thopter'],
  },
  // This land enters tapped.
  // {T}: Add {W} or {B}.
  {
    id: '57b37df5-fee4-4720-931f-f0cb0a8b338c',
    name: 'Orzhov Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ W: 1 }, { B: 1 }],
  },
  // Surveil 3. (Look at the top three cards of your library, then put any number of them into your graveyard and the rest on top of your library in any order.)
  // Flashback {1}{U} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'be668c2d-71ea-4346-8980-1fbf5e4cbed3',
    name: 'Otherworldly Gaze',
    types: ['instant'],
    cost: { U: 1 },
    flashback: { generic: 1, U: 1 },
    effects: [{ primitive: 'surveil', params: { count: 3 } }],
  },
  // Counter target spell unless its controller pays {X}. You gain X life.
  {
    id: 'fa43d688-99de-4774-ac2d-2d01866eef58',
    name: 'Overrule',
    types: ['instant'],
    cost: { W: 1, U: 1 },
    xCost: 1,
    effects: [
      { primitive: 'counterUnlessPaid', params: { targets: 'spell', unlessPaidX: true } },
      { primitive: 'gainLife', params: { amount: { chosenX: true } } },
    ],
  },
  // First strike, protection from black and from red (This creature deals combat damage before creatures without first strike. It can't be blocked, targeted, dealt damage, or enchanted by anything black or red.)
  {
    id: 'fd8722e1-9c41-4037-ab7e-47e2aa9858a0',
    name: 'Paladin en-Vec',
    types: ['creature'],
    cost: { generic: 1, W: 2 },
    power: 2,
    toughness: 2,
    keywords: { firstStrike: true, protectionFrom: ['black', 'red'] },
    subtypes: ['human', 'knight'],
  },
  // {T}: Add {C}{C}.
  {
    id: '7b0767b8-b504-456e-93bd-218502f73b3d',
    name: 'Palladium Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 3 },
    power: 2,
    toughness: 2,
    subtypes: ['myr'],
    produces: ['C', 'C'],
  },
  // Ward {2} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {2}.)
  // Whenever you cast an artifact spell, put a +1/+1 counter on this creature.
  {
    id: '0ba86a50-13df-4b26-8b3a-9e3917ff850f',
    name: 'Patchwork Automaton',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 1,
    toughness: 1,
    keywords: { ward: 2 },
    subtypes: ['construct'],
    triggers: [
      {
        condition: { on: 'castSpell', who: 'you', spellType: 'artifact' },
        effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
        label: 'Cast artifact: put a +1/+1 counter on ~',
      },
    ],
  },
  // Trample (This creature can deal excess combat damage to the player or planeswalker it's attacking.)
  // When this creature enters, you gain 7 life.
  // When this creature dies, draw a card.
  {
    id: 'd36075c2-de66-4202-9217-b1102a2bc14b',
    name: 'Pelakka Wurm',
    types: ['creature'],
    cost: { generic: 4, G: 3 },
    power: 7,
    toughness: 7,
    keywords: { trample: true },
    subtypes: ['wurm'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 7 } }],
        label: 'Enters: you gain 7 life',
      },
      {
        condition: { on: 'dies' },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: 'Dies: draw a card',
      },
    ],
  },
  // This creature can't be blocked.
  {
    id: '23745133-e5e2-4ce3-b94a-73d0d3d8a013',
    name: 'Phantom Warrior',
    types: ['creature'],
    cost: { generic: 1, U: 2 },
    power: 2,
    toughness: 2,
    keywords: { unblockable: true },
    subtypes: ['illusion', 'warrior'],
  },
  {
    id: '7af75024-6c9b-4844-aeb6-81de25464822',
    name: 'Phyrexian Walker',
    types: ['artifact', 'creature'],
    power: 0,
    toughness: 3,
    subtypes: ['phyrexian', 'construct'],
  },
  // Scry 2, then draw a card. (To scry 2, look at the top two cards of your library, then put any number of them on the bottom and the rest on top in any order.)
  {
    id: 'ac641490-ca14-48d7-8cc4-b69ce984befa',
    name: 'Preordain',
    types: ['sorcery'],
    cost: { U: 1 },
    effects: [{ primitive: 'scry', params: { count: 2 } }, { primitive: 'drawCards', params: { count: 1 } }],
  },
  // Ward {3} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {3}.)
  {
    id: 'dfb13eca-55fd-4ac6-aee3-2bdbfe9e1c4e',
    name: 'Punk Frogs',
    types: ['creature'],
    cost: { generic: 3, hybrid: [['G', 'U'], ['G', 'U']] },
    power: 4,
    toughness: 5,
    keywords: { ward: 3 },
    subtypes: ['frog', 'mutant', 'rebel'],
  },
  // Pyroclasm deals 2 damage to each creature.
  {
    id: 'e4bcd4ea-e7cd-4471-8f3b-18bb51d3d70c',
    name: 'Pyroclasm',
    types: ['sorcery'],
    cost: { generic: 1, R: 1 },
    effects: [{ primitive: 'dealDamageToEach', params: { amount: 2, creatures: true } }],
  },
  // When this land enters, you gain 2 life.
  // {T}: Add {C}.
  {
    id: '6db442e5-fbcc-4456-a4c5-bea1aee3fc8e',
    name: 'Radiant Fountain',
    types: ['land'],
    produces: ['C'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 2 } }],
        label: 'Enters: you gain 2 life',
      },
    ],
  },
  // Haste (This creature can attack and {T} as soon as it comes under your control.)
  {
    id: '30997b43-fc13-41d3-8064-1ccc2cb6fd2b',
    name: 'Raging Goblin',
    types: ['creature'],
    cost: { R: 1 },
    power: 1,
    toughness: 1,
    keywords: { haste: true },
    subtypes: ['goblin', 'berserker'],
  },
  // Create two 1/1 white Soldier creature tokens.
  {
    id: '5b2364d7-a811-4595-a1b4-224c70555ffa',
    name: 'Raise the Alarm',
    types: ['instant'],
    cost: { generic: 1, W: 1 },
    effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Soldier', count: 2 } }],
  },
  // This land enters tapped.
  // {T}: Add {B} or {R}.
  {
    id: '361f534b-39d1-4421-b5a8-d3813c62f86d',
    name: 'Rakdos Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ B: 1 }, { R: 1 }],
  },
  // Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.
  {
    id: '8539f295-5d58-4436-a73a-b9277c4c7795',
    name: 'Rampant Growth',
    types: ['sorcery'],
    cost: { generic: 1, G: 1 },
    effects: [
      {
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          filter: { anyOfTypes: ['land'] },
          nameAnyOf: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'],
          destination: 'battlefield',
          tapped: true,
        },
      },
    ],
  },
  // ({T}: Add {B} or {R}.)
  // This land enters tapped.
  // When this land enters, surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: '04e5e84f-8fd4-43ab-8f9d-5b24646f7ae5',
    name: 'Raucous Theater',
    types: ['land'],
    subtypes: ['swamp', 'mountain'],
    entersTapped: true,
    producesOptions: [{ B: 1 }, { R: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'surveil' }], label: 'Enters: surveil 1' }],
  },
  // This land enters tapped.
  // Indestructible
  // {T}: Add {W} or {U}.
  {
    id: '6cb37ac1-dd11-4a8c-bca5-ef44d828059f',
    name: 'Razortide Bridge',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    entersTapped: true,
    producesOptions: [{ W: 1 }, { U: 1 }],
  },
  // Scry 2, then draw two cards. You lose 2 life. (To scry 2, look at the top two cards of your library, then put any number of them on the bottom and the rest on top in any order.)
  {
    id: '5bf4d8d9-a2b2-4dba-ac05-9d4470a89db2',
    name: 'Read the Bones',
    types: ['sorcery'],
    cost: { generic: 2, B: 1 },
    effects: [
      { primitive: 'scry', params: { count: 2 } },
      { primitive: 'drawCards', params: { count: 2 } },
      { primitive: 'loseLife', params: { amount: 2 } },
    ],
  },
  // Target creature gets +3/+0 and gains haste until end of turn.
  // Flashback {2}{R} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: '45bee121-0beb-4901-9473-20e4704ba6dc',
    name: 'Reckless Charge',
    types: ['sorcery'],
    cost: { R: 1 },
    flashback: { generic: 2, R: 1 },
    effects: [
      { primitive: 'pumpUntilEndOfTurn', params: { power: 3, toughness: 0, targets: 'creature' } },
      {
        primitive: 'grantKeywordUntilEndOfTurn',
        params: { keywords: { haste: true }, targets: 'creature' },
      },
    ],
  },
  // Ward {3} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {3}.)
  {
    id: 'ec47cf67-2580-464f-8118-7eabea5be11c',
    name: 'Rimeshield Frost Giant',
    types: ['creature'],
    cost: { generic: 3, U: 2 },
    power: 4,
    toughness: 5,
    keywords: { ward: 3 },
    subtypes: ['giant', 'warrior'],
  },
  // Create a 6/6 green Wurm creature token.
  // Flashback {3}{G} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'b8b9e6fd-b3ed-4fbc-8753-74018fa33caa',
    name: 'Roar of the Wurm',
    types: ['sorcery'],
    cost: { generic: 6, G: 1 },
    flashback: { generic: 3, G: 1 },
    effects: [{ primitive: 'makeToken', params: { power: 6, toughness: 6, name: 'Wurm' } }],
  },
  // This land enters tapped.
  // When this land enters, you gain 1 life.
  // {T}: Add {R} or {G}.
  {
    id: '6c922206-6e68-4dcd-9559-88da1074f2c4',
    name: 'Rugged Highlands',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ R: 1 }, { G: 1 }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
        label: 'Enters: you gain 1 life',
      },
    ],
  },
  // Reach, deathtouch
  // {3}{G}: Put a +1/+1 counter on this creature.
  {
    id: 'd99efecd-1419-434b-9de6-5fbb04f57dda',
    name: 'Ruins Recluse',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 1,
    toughness: 1,
    keywords: { reach: true, deathtouch: true },
    subtypes: ['spider'],
    activated: [
      {
        cost: { mana: { generic: 3, G: 1 } },
        effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
        label: '{3}{g}: put a +1/+1 counter on ~',
      },
    ],
  },
  {
    id: 'ec49dfcf-d16d-4621-af4b-4a6f09043221',
    name: 'Runeclaw Bear',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 2,
    toughness: 2,
    subtypes: ['bear'],
  },
  // This land enters tapped.
  // Indestructible
  // {T}: Add {R} or {W}.
  {
    id: 'a3faf70d-c034-4692-9e92-1922029e3852',
    name: 'Rustvale Bridge',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    entersTapped: true,
    producesOptions: [{ R: 1 }, { W: 1 }],
  },
  // Sacred Fire deals 2 damage to any target and you gain 2 life.
  // Flashback {4}{R}{W} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: '812bf52c-37f5-41c9-8a69-009fddbafb3f',
    name: 'Sacred Fire',
    types: ['instant'],
    cost: { W: 1, R: 1 },
    flashback: { generic: 4, R: 1, W: 1 },
    effects: [
      { primitive: 'dealDamage', params: { amount: 2 } },
      { primitive: 'gainLife', params: { amount: 2 } },
    ],
  },
  // ({T}: Add {R} or {W}.)
  // As this land enters, you may pay 2 life. If you don't, it enters tapped.
  {
    id: '45181cb8-2090-4471-ba90-e5a8f04d525f',
    name: 'Sacred Foundry',
    types: ['land'],
    subtypes: ['mountain', 'plains'],
    entersTappedUnlessLifePaid: 2,
    producesOptions: [{ R: 1 }, { W: 1 }],
  },
  // Creatures you control have haste.
  // −1: Target creature gets +2/+1 and gains haste until end of turn. Scry 1.
  {
    id: '80405d7a-f533-44bd-ac85-890476cf2b78',
    name: 'Samut, Tyrant Smasher',
    types: ['planeswalker'],
    cost: { generic: 2, hybrid: [['R', 'G'], ['R', 'G']] },
    loyalty: 5,
    legendary: true,
    subtypes: ['samut'],
    activated: [
      {
        cost: { loyalty: -1 },
        effects: [
          {
            primitive: 'pumpUntilEndOfTurn',
            params: { power: 2, toughness: 1, targets: 'creature' },
          },
          {
            primitive: 'grantKeywordUntilEndOfTurn',
            params: { keywords: { haste: true }, targets: 'creature' },
          },
          { primitive: 'scry' },
        ],
        timing: 'sorcery',
        label: '−1: target creature gets +2/+1 and gains haste until end of turn. scry 1',
      },
    ],
    statics: [
      {
        affects: { anyOfTypes: ['creature'], controller: 'you' },
        keywords: { haste: true },
        label: 'creatures you control have haste',
      },
    ],
  },
  {
    id: '60ba93eb-39e6-4af2-9c66-cd38f72daff2',
    name: 'Savannah Lions',
    types: ['creature'],
    cost: { W: 1 },
    power: 2,
    toughness: 1,
    subtypes: ['cat'],
  },
  // Scry 2, then draw a card.
  // Flashback {4}{U} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: '3fb9f0d9-6514-4005-b65a-7929f7c4df06',
    name: 'Scour All Possibilities',
    types: ['sorcery'],
    cost: { generic: 1, U: 1 },
    flashback: { generic: 4, U: 1 },
    effects: [{ primitive: 'scry', params: { count: 2 } }, { primitive: 'drawCards', params: { count: 1 } }],
  },
  // This land enters tapped.
  // When this land enters, you gain 1 life.
  // {T}: Add {W} or {B}.
  {
    id: 'd37f858e-03c8-4594-9b92-cd03699a1591',
    name: 'Scoured Barrens',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ W: 1 }, { B: 1 }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
        label: 'Enters: you gain 1 life',
      },
    ],
  },
  // Kicker {1}{W} (You may pay an additional {1}{W} as you cast this spell.)
  // Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. If this spell was kicked, create two 1/1 white Soldier creature tokens.
  {
    id: '422aca0b-8e8f-4774-9a20-6f7a1cae967e',
    name: 'Scout the Wilderness',
    types: ['sorcery'],
    cost: { generic: 2, G: 1 },
    kicker: { generic: 1, W: 1 },
    effects: [
      {
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          filter: { anyOfTypes: ['land'] },
          nameAnyOf: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'],
          destination: 'battlefield',
          tapped: true,
        },
      },
      {
        primitive: 'ifKicked',
        params: {
          effects: [
            {
              primitive: 'makeToken',
              params: { power: 1, toughness: 1, name: 'Soldier', count: 2 },
            },
          ],
        },
      },
    ],
  },
  // Searing Spear deals 3 damage to any target.
  {
    id: 'aafd44c1-74a9-4aa7-a4a2-67eb39a07478',
    name: 'Searing Spear',
    types: ['instant'],
    cost: { generic: 1, R: 1 },
    effects: [{ primitive: 'dealDamage', params: { amount: 3 } }],
  },
  // Deathtouch (Any amount of damage this deals to a creature is enough to destroy it.)
  {
    id: 'fbadf7a3-0d54-40fe-a763-f641dd448e56',
    name: 'Sedge Scorpion',
    types: ['creature'],
    cost: { G: 1 },
    power: 1,
    toughness: 1,
    keywords: { deathtouch: true },
    subtypes: ['scorpion'],
  },
  // This land enters tapped.
  // {T}: Add {G} or {W}.
  {
    id: '75b235d3-595a-4859-be45-9559d8445db5',
    name: 'Selesnya Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ G: 1 }, { W: 1 }],
  },
  // Flying
  // Indestructible (Damage and effects that say "destroy" don't destroy this creature. If its toughness is 0 or less, it still dies.)
  {
    id: '8354b70e-43fc-4581-bb53-b913335bf460',
    name: 'Seraph of the Suns',
    types: ['creature'],
    cost: { generic: 5, W: 2 },
    power: 4,
    toughness: 4,
    keywords: { flying: true, indestructible: true },
    subtypes: ['angel'],
  },
  // Enchant creature
  // Enchanted creature gets +2/+2 and has flying and vigilance. (Attacking doesn't cause it to tap.)
  {
    id: '6d6ba936-4a15-4c40-aaa6-71605fb732d1',
    name: 'Serra\'s Embrace',
    types: ['enchantment'],
    cost: { generic: 2, W: 2 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 2, toughness: 2, keywords: { flying: true, vigilance: true } },
    },
  },
  // Draw a card. Scry 2.
  {
    id: '56956afd-db53-4542-816b-490c8b0bbcf7',
    name: 'Serum Visions',
    types: ['sorcery'],
    cost: { U: 1 },
    effects: [{ primitive: 'drawCards', params: { count: 1 } }, { primitive: 'scry', params: { count: 2 } }],
  },
  // ({T}: Add {W} or {B}.)
  // This land enters tapped.
  // When this land enters, surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: '216a2a92-9ca3-4ca3-8af7-686c13b04290',
    name: 'Shadowy Backstreet',
    types: ['land'],
    subtypes: ['plains', 'swamp'],
    entersTapped: true,
    producesOptions: [{ W: 1 }, { B: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'surveil' }], label: 'Enters: surveil 1' }],
  },
  // Flying
  // {R}: This creature gets +1/+0 until end of turn.
  {
    id: '711eea87-0fa3-46e0-a42b-fa5a86455f04',
    name: 'Shivan Dragon',
    types: ['creature'],
    cost: { generic: 4, R: 2 },
    power: 5,
    toughness: 5,
    keywords: { flying: true },
    subtypes: ['dragon'],
    activated: [
      {
        cost: { mana: { R: 1 } },
        effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 1, toughness: 0 } }],
        label: '{r}: ~ gets +1/+0 until end of turn',
      },
    ],
  },
  // Shock deals 2 damage to any target.
  {
    id: 'a9d288b8-cdc1-4e55-a0c9-d6edfc95e65d',
    name: 'Shock',
    types: ['instant'],
    cost: { R: 1 },
    effects: [{ primitive: 'dealDamage', params: { amount: 2 } }],
  },
  // Target player draws two cards and loses 2 life.
  {
    id: 'c6207f6a-a624-4754-88f5-dbe700c841ff',
    name: 'Sign in Blood',
    types: ['sorcery'],
    cost: { B: 2 },
    effects: [
      {
        primitive: 'drawCards',
        params: { count: 2, whichPlayer: 'targetPlayer', targets: 'player' },
      },
      { primitive: 'loseLife', params: { amount: 2, targetPlayer: true } },
    ],
  },
  // Return target creature to its owner's hand.
  // Flashback {4}{U} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'c41641f0-1abf-4776-9dec-1882f2d9badd',
    name: 'Silent Departure',
    types: ['sorcery'],
    cost: { U: 1 },
    flashback: { generic: 4, U: 1 },
    effects: [{ primitive: 'returnToHand', params: { targets: 'creature' } }],
  },
  // First strike, protection from red
  {
    id: 'aa7cd6e6-35a6-4c18-9d66-dc2a95206401',
    name: 'Silver Knight',
    types: ['creature'],
    cost: { W: 2 },
    power: 2,
    toughness: 2,
    keywords: { firstStrike: true, protectionFrom: ['red'] },
    subtypes: ['human', 'knight'],
  },
  // {T}: Add {U}.
  {
    id: '66e8f7f8-3a6d-46ba-837c-b9713ddf7f40',
    name: 'Silver Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 1,
    toughness: 1,
    subtypes: ['myr'],
    produces: ['U'],
  },
  // This land enters tapped.
  // Indestructible
  // {T}: Add {U} or {R}.
  {
    id: '081bfd50-a436-463b-9d2c-5bc8a32b387c',
    name: 'Silverbluff Bridge',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    entersTapped: true,
    producesOptions: [{ U: 1 }, { R: 1 }],
  },
  // This land enters tapped.
  // {T}: Add {G} or {U}.
  {
    id: 'e8705df9-6439-4930-91b6-229f818559af',
    name: 'Simic Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ G: 1 }, { U: 1 }],
  },
  // Counter target spell.
  // Surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: '973fd4d4-9255-4825-85b7-503606c4e932',
    name: 'Sinister Sabotage',
    types: ['instant'],
    cost: { generic: 1, U: 2 },
    effects: [{ primitive: 'counterSpell', params: { targets: 'spell' } }, { primitive: 'surveil' }],
  },
  // This artifact enters tapped.
  // {T}: Add {U}.
  {
    id: '2224b6e0-c5ff-45d0-84e3-83758c5fc99f',
    name: 'Sky Diamond',
    types: ['artifact'],
    cost: { generic: 2 },
    entersTapped: true,
    produces: ['U'],
  },
  // Flying, double strike
  {
    id: '0c07d09e-e127-4573-b827-6c50246f7a31',
    name: 'Skyhunter Skirmisher',
    types: ['creature'],
    cost: { generic: 1, W: 2 },
    power: 1,
    toughness: 1,
    keywords: { flying: true, doubleStrike: true },
    subtypes: ['cat', 'knight'],
  },
  // Flying, haste
  {
    id: '61178a6c-70b7-447d-87ee-a8d9369c3d15',
    name: 'Skyknight Legionnaire',
    types: ['creature'],
    cost: { generic: 1, W: 1, R: 1 },
    power: 2,
    toughness: 2,
    keywords: { flying: true, haste: true },
    subtypes: ['human', 'knight'],
  },
  // This land enters tapped.
  // Indestructible
  // {T}: Add {R} or {G}.
  {
    id: 'e040a8e6-b90c-42d1-a1b1-771d954c61ab',
    name: 'Slagwoods Bridge',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    entersTapped: true,
    producesOptions: [{ R: 1 }, { G: 1 }],
  },
  // Sorin's Vengeance deals 10 damage to target player or planeswalker and you gain 10 life.
  {
    id: '75d9c036-4f0d-4b55-b0a4-096ca84748ca',
    name: 'Sorin\'s Vengeance',
    types: ['sorcery'],
    cost: { generic: 4, B: 3 },
    effects: [
      { primitive: 'dealDamage', params: { amount: 10, targets: 'playerOrPlaneswalker' } },
      { primitive: 'gainLife', params: { amount: 10 } },
    ],
  },
  // Flying, haste
  // Whenever you cast a noncreature spell, put a +1/+1 counter on this creature.
  {
    id: 'a9d8ab76-70a4-475e-b87e-4737c090553a',
    name: 'Sprite Dragon',
    types: ['creature'],
    cost: { U: 1, R: 1 },
    power: 1,
    toughness: 1,
    keywords: { flying: true, haste: true },
    subtypes: ['faerie', 'dragon'],
    triggers: [
      {
        condition: { on: 'castSpell', who: 'you', spellTypeNoneOf: ['creature'] },
        effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
        label: 'Cast noncreature: put a +1/+1 counter on ~',
      },
    ],
  },
  // Defender (This creature can't attack.)
  {
    id: '5ccb57e1-ca94-4b5a-8e5f-b8b5e692cfb9',
    name: 'Steel Wall',
    types: ['artifact', 'creature'],
    cost: { generic: 1 },
    power: 0,
    toughness: 4,
    keywords: { defender: true },
    subtypes: ['wall'],
  },
  // Equipped creature gets +1/+1 and has haste.
  // Equip {1} ({1}: Attach to target creature you control. Equip only as a sorcery.)
  {
    id: 'bd4ad383-8c40-4dda-bc9c-ba8a001d6882',
    name: 'Strider Harness',
    types: ['artifact'],
    cost: { generic: 3 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 1 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {1}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {1}',
      modifies: { power: 1, toughness: 1, keywords: { haste: true } },
    },
  },
  // Choose one or both —
  // • Target creature gets -1/-1 until end of turn.
  // • Put a +1/+1 counter on target creature.
  {
    id: '08122109-6287-4d78-9242-2da8a25022b0',
    name: 'Subtle Strike',
    types: ['instant'],
    cost: { generic: 1, B: 1 },
    modal: {
      min: 1,
      max: 2,
      modes: [
        {
          id: 'mode1',
          label: 'Target creature gets -1/-1 until end of turn',
          effects: [
            {
              primitive: 'pumpUntilEndOfTurn',
              params: { power: -1, toughness: -1, targets: 'creature' },
            },
          ],
          targets: 'creature',
        },
        {
          id: 'mode2',
          label: 'Put a +1/+1 counter on target creature',
          effects: [{ primitive: 'addCounters', params: { amount: 1, targets: 'creature' } }],
          targets: 'creature',
        },
      ],
    },
  },
  // Flying
  {
    id: 'a8d31e2f-7b2e-4135-8074-9e6ef778bd80',
    name: 'Suntail Hawk',
    types: ['creature'],
    cost: { W: 1 },
    power: 1,
    toughness: 1,
    keywords: { flying: true },
    subtypes: ['bird'],
  },
  // This land enters tapped.
  // When this land enters, you gain 1 life.
  // {T}: Add {U} or {R}.
  {
    id: '2f4ad084-2062-44c0-9975-15f100204531',
    name: 'Swiftwater Cliffs',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ U: 1 }, { R: 1 }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
        label: 'Enters: you gain 1 life',
      },
    ],
  },
  // Equipped creature gets +2/+0 and has first strike, vigilance, trample, and haste.
  // Equip {3}
  {
    id: 'e366afb3-c447-4bde-b358-41c8568142d5',
    name: 'Sword of Vengeance',
    types: ['artifact'],
    cost: { generic: 3 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 3 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {3}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {3}',
      modifies: {
        power: 2,
        toughness: 0,
        keywords: { firstStrike: true, vigilance: true, trample: true, haste: true },
      },
    },
  },
  // This land enters tapped.
  // Indestructible
  // {T}: Add {G} or {U}.
  {
    id: '29cd8a7c-108a-43d1-af63-f603a27c24f2',
    name: 'Tanglepool Bridge',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    entersTapped: true,
    producesOptions: [{ G: 1 }, { U: 1 }],
  },
  // Whenever you cast a noncreature spell, put a +1/+1 counter on this creature.
  {
    id: '60ac490c-b489-4ad2-bcc2-3babaabf8ccb',
    name: 'Tempest Angler',
    types: ['creature'],
    cost: { generic: 1, hybrid: [['U', 'R'], ['U', 'R']] },
    power: 2,
    toughness: 2,
    subtypes: ['otter', 'wizard'],
    triggers: [
      {
        condition: { on: 'castSpell', who: 'you', spellTypeNoneOf: ['creature'] },
        effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
        label: 'Cast noncreature: put a +1/+1 counter on ~',
      },
    ],
  },
  // This land enters tapped.
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {R} or {G}.
  {
    id: '3baa8e38-ef93-435d-b63e-f781d5bfcc68',
    name: 'Temple of Abandon',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ R: 1 }, { G: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  // This land enters tapped.
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {U} or {B}.
  {
    id: '33b9b3bd-33ca-46f3-b8bb-a978bc3d1085',
    name: 'Temple of Deceit',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ U: 1 }, { B: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  // This land enters tapped.
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {W} or {U}.
  {
    id: '89f43e27-790b-4ca1-8ba7-0882b31e0783',
    name: 'Temple of Enlightenment',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ W: 1 }, { U: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  // This land enters tapped.
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {U} or {R}.
  {
    id: '79f94050-d850-41ca-b1db-5ae0cf743f0a',
    name: 'Temple of Epiphany',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ U: 1 }, { R: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  // This land enters tapped.
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {B} or {G}.
  {
    id: 'dc55421f-dee8-4263-9df0-2365df5f14bb',
    name: 'Temple of Malady',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ B: 1 }, { G: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  // This land enters tapped.
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {B} or {R}.
  {
    id: '7c439c18-31dc-41fe-b03d-3fca06e6fc0b',
    name: 'Temple of Malice',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ B: 1 }, { R: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  // This land enters tapped.
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {G} or {U}.
  {
    id: '7e26f0b7-20e6-46d5-8130-d98c14d6aa29',
    name: 'Temple of Mystery',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ G: 1 }, { U: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  // This land enters tapped.
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {G} or {W}.
  {
    id: 'e521322b-0e83-458c-8936-7021a80ee279',
    name: 'Temple of Plenty',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ G: 1 }, { W: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  // This land enters tapped.
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {W} or {B}.
  {
    id: 'e6e6fce8-0f6a-4b84-865e-d4e4a4182f9f',
    name: 'Temple of Silence',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ W: 1 }, { B: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  // This land enters tapped.
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {R} or {W}.
  {
    id: '6f0d94d9-64bb-4175-83bc-301e8f79f54f',
    name: 'Temple of Triumph',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ R: 1 }, { W: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  // Destroy target creature. It can't be regenerated.
  {
    id: '6257c2fd-005f-41e3-8a72-af76df1eb134',
    name: 'Terminate',
    types: ['instant'],
    cost: { B: 1, R: 1 },
    effects: [{ primitive: 'destroyTarget', params: { targets: 'creature' } }],
  },
  // {T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.
  {
    id: '1bd3e453-aa21-4ee6-95c2-d6d920ee8e7a',
    name: 'Terramorphic Expanse',
    types: ['land'],
    activated: [
      {
        cost: { tap: true, sacrificeSelf: true },
        effects: [
          {
            primitive: 'searchLibrary',
            params: {
              who: 'controller',
              count: 1,
              filter: { anyOfTypes: ['land'] },
              nameAnyOf: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'],
              destination: 'battlefield',
              tapped: true,
            },
          },
        ],
        label: '{t}, sacrifice ~: search your library for a basic land card, put it onto the battlefield tapped, then shuffle',
      },
    ],
  },
  // Draw a card.
  // Flashback {2}{U} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: 'fa85c5a2-8e83-4624-a35a-a0bbf17ecbb4',
    name: 'Think Twice',
    types: ['instant'],
    cost: { generic: 1, U: 1 },
    flashback: { generic: 2, U: 1 },
    effects: [{ primitive: 'drawCards', params: { count: 1 } }],
  },
  // This land enters tapped.
  // Indestructible
  // {T}: Add {G} or {W}.
  {
    id: '99720c65-be96-4220-8ed4-720660bf6928',
    name: 'Thornglint Bridge',
    types: ['artifact', 'land'],
    keywords: { indestructible: true },
    entersTapped: true,
    producesOptions: [{ G: 1 }, { W: 1 }],
  },
  // This land enters tapped.
  // When this land enters, you gain 1 life.
  // {T}: Add {G} or {U}.
  {
    id: 'ec96cde2-f1e6-495c-94e2-3e8ae79e556c',
    name: 'Thornwood Falls',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ G: 1 }, { U: 1 }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
        label: 'Enters: you gain 1 life',
      },
    ],
  },
  // Target player mills two cards.
  // Draw a card.
  {
    id: '83101ba8-a569-4827-8c53-9ca0dfcd59a7',
    name: 'Thought Scour',
    types: ['instant'],
    cost: { U: 1 },
    effects: [
      { primitive: 'mill', params: { amount: 2, targets: 'player' } },
      { primitive: 'drawCards', params: { count: 1 } },
    ],
  },
  // When this creature enters, you gain 5 life.
  // When this creature leaves the battlefield, create a 3/3 green Beast creature token.
  {
    id: '0dd0e91a-d16b-4718-8d11-1a3fcf8e0753',
    name: 'Thragtusk',
    types: ['creature'],
    cost: { generic: 4, G: 1 },
    power: 5,
    toughness: 3,
    subtypes: ['beast'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 5 } }],
        label: 'Enters: you gain 5 life',
      },
      {
        condition: { on: 'leaves' },
        effects: [{ primitive: 'makeToken', params: { power: 3, toughness: 3, name: 'Beast' } }],
        label: 'Leaves: create a 3/3 green beast creature token',
      },
    ],
  },
  // Target creature gets +1/+2 until end of turn.
  // Flashback {W} (You may cast this card from your graveyard for its flashback cost. Then exile it.)
  {
    id: '7b1f0b78-806f-4a7d-809b-d2bc60cf1b01',
    name: 'Thrill of the Hunt',
    types: ['instant'],
    cost: { G: 1 },
    flashback: { W: 1 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 1, toughness: 2, targets: 'creature' } }],
  },
  // ({T}: Add {U} or {R}.)
  // This land enters tapped.
  // When this land enters, surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: 'd2bcff58-7a8a-46ef-b6b3-39501d4c8e6e',
    name: 'Thundering Falls',
    types: ['land'],
    subtypes: ['island', 'mountain'],
    entersTapped: true,
    producesOptions: [{ U: 1 }, { R: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'surveil' }], label: 'Enters: surveil 1' }],
  },
  // Draw four cards.
  {
    id: '72897780-094d-4a21-8b1c-419a9defd2fb',
    name: 'Tidings',
    types: ['sorcery'],
    cost: { generic: 3, U: 2 },
    effects: [{ primitive: 'drawCards', params: { count: 4 } }],
  },
  // Target creature gets +4/+4 until end of turn.
  {
    id: '61e09dd9-7870-48c2-9177-d6abc3162692',
    name: 'Titanic Growth',
    types: ['instant'],
    cost: { generic: 1, G: 1 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 4, toughness: 4, targets: 'creature' } }],
  },
  // Ward {2} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {2}.)
  // {3}{G}: Put a +1/+1 counter on this creature.
  {
    id: '77b48b3c-c780-4c5b-90e6-33c5fd940c16',
    name: 'Toadstool Admirer',
    types: ['creature'],
    cost: { G: 1 },
    power: 1,
    toughness: 1,
    keywords: { ward: 2 },
    subtypes: ['ouphe'],
    activated: [
      {
        cost: { mana: { generic: 3, G: 1 } },
        effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
        label: '{3}{g}: put a +1/+1 counter on ~',
      },
    ],
  },
  // Kicker {W} (You may pay an additional {W} as you cast this spell.)
  // Return target creature to its owner's hand. Draw a card. If this spell was kicked, you gain 3 life.
  {
    id: 'd2240ce8-0bd6-4c4f-a73e-fb0a2af5bfac',
    name: 'Tolarian Geyser',
    types: ['sorcery'],
    cost: { generic: 2, U: 1 },
    kicker: { W: 1 },
    effects: [
      { primitive: 'returnToHand', params: { targets: 'creature' } },
      { primitive: 'drawCards', params: { count: 1 } },
      {
        primitive: 'ifKicked',
        params: { effects: [{ primitive: 'gainLife', params: { amount: 3 } }] },
      },
    ],
  },
  // Ward {2} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {2}.)
  {
    id: 'b68cf4e6-205e-40b6-b28b-f4b7d8af7017',
    name: 'Tomakul Honor Guard',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 3,
    toughness: 1,
    keywords: { ward: 2 },
    subtypes: ['human', 'soldier'],
  },
  // Target player mills five cards.
  {
    id: '446a9d7e-9c1a-4e83-8342-2ed5acae2eed',
    name: 'Tome Scour',
    types: ['sorcery'],
    cost: { U: 1 },
    effects: [{ primitive: 'mill', params: { amount: 5, targets: 'player' } }],
  },
  // This land enters tapped.
  // When this land enters, you gain 1 life.
  // {T}: Add {W} or {U}.
  {
    id: '5d641bf6-0f93-4189-8dc1-ec7ea446dade',
    name: 'Tranquil Cove',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ W: 1 }, { U: 1 }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
        label: 'Enters: you gain 1 life',
      },
    ],
  },
  // Equipped creature gets +2/+1.
  // Equip {2}
  {
    id: '394fae8f-3757-4e08-b97c-5d7c451f4e72',
    name: 'Trusty Machete',
    types: ['artifact'],
    cost: { generic: 1 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 2 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {2}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {2}',
      modifies: { power: 2, toughness: 1, keywords: {} },
    },
  },
  // Deathtouch (Any amount of damage this deals to a creature is enough to destroy it.)
  {
    id: 'd6ee6cc1-902d-4f56-afa5-6fa4813bfbbc',
    name: 'Typhoid Rats',
    types: ['creature'],
    cost: { B: 1 },
    power: 1,
    toughness: 1,
    keywords: { deathtouch: true },
    subtypes: ['rat'],
  },
  // Choose one —
  // • Destroy target creature with mana value 3 or less.
  // • Return target creature to its owner's hand.
  {
    id: 'afb278f1-0e21-4f6d-96bb-c34aa3ef96b0',
    name: 'Tyrant\'s Scorn',
    types: ['instant'],
    cost: { U: 1, B: 1 },
    modal: {
      min: 1,
      max: 1,
      modes: [
        {
          id: 'mode1',
          label: 'Destroy target creature with mana value 3 or less',
          effects: [{ primitive: 'destroyTarget', params: { targets: 'creature', maxManaValue: 3 } }],
          targets: 'creature',
        },
        {
          id: 'mode2',
          label: 'Return target creature to its owner\'s hand',
          effects: [{ primitive: 'returnToHand', params: { targets: 'creature' } }],
          targets: 'creature',
        },
      ],
    },
  },
  // Choose one —
  // • Target creature gets +2/+2 until end of turn.
  // • Target creature gets -1/-1 until end of turn.
  // • You gain 2 life.
  {
    id: '7cfd7606-1dab-4627-ba42-37d6e375f9f1',
    name: 'Umezawa\'s Charm',
    types: ['instant'],
    cost: { generic: 1, B: 1 },
    modal: {
      min: 1,
      max: 1,
      modes: [
        {
          id: 'mode1',
          label: 'Target creature gets +2/+2 until end of turn',
          effects: [
            {
              primitive: 'pumpUntilEndOfTurn',
              params: { power: 2, toughness: 2, targets: 'creature' },
            },
          ],
          targets: 'creature',
        },
        {
          id: 'mode2',
          label: 'Target creature gets -1/-1 until end of turn',
          effects: [
            {
              primitive: 'pumpUntilEndOfTurn',
              params: { power: -1, toughness: -1, targets: 'creature' },
            },
          ],
          targets: 'creature',
        },
        {
          id: 'mode3',
          label: 'You gain 2 life',
          effects: [{ primitive: 'gainLife', params: { amount: 2 } }],
        },
      ],
    },
  },
  // ({T}: Add {U} or {B}.)
  // This land enters tapped.
  // When this land enters, surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: '08d80efc-9542-4ba2-824c-c8615d8d07f2',
    name: 'Undercity Sewers',
    types: ['land'],
    subtypes: ['island', 'swamp'],
    entersTapped: true,
    producesOptions: [{ U: 1 }, { B: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'surveil' }], label: 'Enters: surveil 1' }],
  },
  // ({T}: Add {B} or {G}.)
  // This land enters tapped.
  // When this land enters, surveil 1. (Look at the top card of your library. You may put it into your graveyard.)
  {
    id: '840119bf-e60f-4ff7-9c9b-d420d09df545',
    name: 'Underground Mortuary',
    types: ['land'],
    subtypes: ['swamp', 'forest'],
    entersTapped: true,
    producesOptions: [{ B: 1 }, { G: 1 }],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'surveil' }], label: 'Enters: surveil 1' }],
  },
  // Enchant creature
  // Enchanted creature gets +2/+2 and has trample and lifelink. (Damage dealt by the creature also causes its controller to gain that much life.)
  {
    id: '0e969a27-1609-4ab4-b0db-46b1af8066a9',
    name: 'Unflinching Courage',
    types: ['enchantment'],
    cost: { generic: 1, W: 1, G: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 2, toughness: 2, keywords: { trample: true, lifelink: true } },
    },
  },
  // Enchant creature
  // Enchanted creature gets +2/+1.
  {
    id: '090d88a9-7f2d-4bd1-a30a-7c48d05068be',
    name: 'Unholy Strength',
    types: ['enchantment'],
    cost: { B: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 2, toughness: 1, keywords: {} },
    },
  },
  // Pay 3 life: Put a +1/+1 counter on target creature.
  {
    id: 'a5690d5f-633c-4a1e-afba-5fd79dcbf20e',
    name: 'Unspeakable Symbol',
    types: ['enchantment'],
    cost: { generic: 1, B: 2 },
    activated: [
      {
        cost: { life: 3 },
        effects: [{ primitive: 'addCounters', params: { amount: 1, targets: 'creature' } }],
        label: 'Pay 3 life: put a +1/+1 counter on target creature',
      },
    ],
  },
  // Return target creature to its owner's hand.
  {
    id: '837182db-1bf3-4a2c-bd01-1af9d9873561',
    name: 'Unsummon',
    types: ['instant'],
    cost: { U: 1 },
    effects: [{ primitive: 'returnToHand', params: { targets: 'creature' } }],
  },
  // {T}: Add {C}{C}.
  {
    id: 'fb34fc00-e60d-41fc-9393-ca4248ec0a1c',
    name: 'Ur-Golem\'s Eye',
    types: ['artifact'],
    cost: { generic: 4 },
    produces: ['C', 'C'],
  },
  // Flying
  // Deathtouch (Any amount of damage this deals to a creature is enough to destroy it.)
  // Lifelink (Damage dealt by this creature also causes you to gain that much life.)
  {
    id: 'feb244f8-bcb1-44cf-9940-2719221a7309',
    name: 'Vampire Nighthawk',
    types: ['creature'],
    cost: { generic: 1, B: 2 },
    power: 2,
    toughness: 3,
    keywords: { flying: true, deathtouch: true, lifelink: true },
    subtypes: ['vampire', 'shaman'],
  },
  // Defender (This creature can't attack.)
  // {T}: Add {G}.
  {
    id: '57de8fe7-3d1b-41cd-8354-38aff3d2d052',
    name: 'Vine Trellis',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 0,
    toughness: 4,
    keywords: { defender: true },
    subtypes: ['plant', 'wall'],
    produces: ['G'],
  },
  // Flying, protection from red
  {
    id: '535007c5-03a8-495f-a132-37960f179f96',
    name: 'Voice of Law',
    types: ['creature'],
    cost: { generic: 3, W: 1 },
    power: 2,
    toughness: 2,
    keywords: { flying: true, protectionFrom: ['red'] },
    subtypes: ['angel'],
  },
  // Volcanic Geyser deals X damage to any target.
  {
    id: '846a4f9c-d955-403f-8a08-5c7c3d32e180',
    name: 'Volcanic Geyser',
    types: ['instant'],
    cost: { R: 2 },
    xCost: 1,
    effects: [{ primitive: 'dealDamage', params: { amount: { chosenX: true } } }],
  },
  // Equipped creature gets +2/+2.
  // Equip {2} ({2}: Attach to target creature you control. Equip only as a sorcery.)
  {
    id: '12a8adc4-927f-4314-b2ef-9c647ace68d5',
    name: 'Vulshok Morningstar',
    types: ['artifact'],
    cost: { generic: 2 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 2 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {2}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {2}',
      modifies: { power: 2, toughness: 2, keywords: {} },
    },
  },
  {
    id: 'fea95888-e16a-4209-9cd4-623f7f4d2f67',
    name: 'Walking Corpse',
    types: ['creature'],
    cost: { generic: 1, B: 1 },
    power: 2,
    toughness: 2,
    subtypes: ['zombie'],
  },
  // Defender, flying (This creature can't attack, and it can block creatures with flying.)
  {
    id: 'b2d3da40-e2f7-4480-9da9-33019d6f4071',
    name: 'Wall of Air',
    types: ['creature'],
    cost: { generic: 1, U: 2 },
    power: 1,
    toughness: 5,
    keywords: { defender: true, flying: true },
    subtypes: ['wall'],
  },
  // Defender
  // When this creature enters, draw a card.
  {
    id: 'ef4d5fb3-70a3-433d-a9d3-18b2beb8d79f',
    name: 'Wall of Blossoms',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 0,
    toughness: 4,
    keywords: { defender: true },
    subtypes: ['plant', 'wall'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: 'Enters: draw a card',
      },
    ],
  },
  // Defender
  // When this creature enters, draw a card.
  {
    id: '5f601f48-d24b-4883-9fde-b3f620e7c9ea',
    name: 'Wall of Omens',
    types: ['creature'],
    cost: { generic: 1, W: 1 },
    power: 0,
    toughness: 4,
    keywords: { defender: true },
    subtypes: ['wall'],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: 'Enters: draw a card',
      },
    ],
  },
  // {T}: Add {C}.
  {
    id: '05d24b0c-904a-46b6-b42a-96a4d91a0dd4',
    name: 'Wastes',
    types: ['land'],
    basic: true,
    produces: ['C'],
  },
  {
    id: 'a35c2e20-eb90-4132-b65f-be1fcb569819',
    name: 'Watchwolf',
    types: ['creature'],
    cost: { W: 1, G: 1 },
    power: 3,
    toughness: 3,
    subtypes: ['wolf'],
  },
  // Flying
  // Ward {2} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {2}.)
  {
    id: '736026b2-84d4-4452-ae0d-5d1b0af0a400',
    name: 'Waterfall Aerialist',
    types: ['creature'],
    cost: { generic: 3, U: 1 },
    power: 3,
    toughness: 1,
    keywords: { flying: true, ward: 2 },
    subtypes: ['djinn', 'wizard'],
  },
  // Enchant creature
  // Enchanted creature gets -2/-1.
  {
    id: 'f07a24c0-bf3c-4733-9473-c6be3b16950e',
    name: 'Weakness',
    types: ['enchantment'],
    cost: { B: 1 },
    subtypes: ['aura'],
    effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: -2, toughness: -1, keywords: {} },
    },
  },
  // Equipped creature can't be blocked and has shroud. (It can't be the target of spells or abilities.)
  // Equip {2}
  {
    id: '9ad4f730-a18e-4a7c-a468-a926c718c741',
    name: 'Whispersilk Cloak',
    types: ['artifact'],
    cost: { generic: 3 },
    subtypes: ['equipment'],
    activated: [
      {
        cost: { mana: { generic: 2 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {2}',
      },
    ],
    attachment: {
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {2}',
      modifies: { power: 0, toughness: 0, keywords: { unblockable: true, shroud: true } },
    },
  },
  // First strike (This creature deals combat damage before creatures without first strike.)
  // Protection from black (This creature can't be blocked, targeted, dealt damage, or enchanted by anything black.)
  {
    id: 'ddb021df-ae4a-4ac1-8353-d0b375761714',
    name: 'White Knight',
    types: ['creature'],
    cost: { W: 2 },
    power: 2,
    toughness: 2,
    keywords: { firstStrike: true, protectionFrom: ['black'] },
    subtypes: ['human', 'knight'],
  },
  // Flying
  {
    id: 'd6ffdaf0-ac08-4de9-bbce-2eab2f86bcca',
    name: 'Wind Drake',
    types: ['creature'],
    cost: { generic: 2, U: 1 },
    power: 2,
    toughness: 2,
    keywords: { flying: true },
    subtypes: ['drake'],
  },
  // This land enters tapped.
  // When this land enters, you gain 1 life.
  // {T}: Add {R} or {W}.
  {
    id: 'b0af0c54-2a59-4075-8543-d41ff20c4c87',
    name: 'Wind-Scarred Crag',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ R: 1 }, { W: 1 }],
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 1 } }],
        label: 'Enters: you gain 1 life',
      },
    ],
  },
  // Choose one or both —
  // • Tap target creature.
  // • Winterflame deals 2 damage to target creature.
  {
    id: '8d3a0b81-1895-47a8-87a3-3e4093cbd951',
    name: 'Winterflame',
    types: ['instant'],
    cost: { generic: 1, U: 1, R: 1 },
    modal: {
      min: 1,
      max: 2,
      modes: [
        {
          id: 'mode1',
          label: 'Tap target creature',
          effects: [{ primitive: 'tapTarget', params: { targets: 'creature' } }],
          targets: 'creature',
        },
        {
          id: 'mode2',
          label: 'Winterflame deals 2 damage to target creature',
          effects: [{ primitive: 'dealDamage', params: { amount: 2, targets: 'creature' } }],
          targets: 'creature',
        },
      ],
    },
  },
  // This artifact enters tapped.
  // {T}: Add {C}{C}.
  {
    id: 'b166b670-febc-4821-855e-f8d465644c03',
    name: 'Worn Powerstone',
    types: ['artifact'],
    cost: { generic: 3 },
    entersTapped: true,
    produces: ['C', 'C'],
  },
  // Target creature gets -3/-1 until end of turn.
  {
    id: '45bb536c-c173-4b6e-a5a8-354c74fd93a1',
    name: 'Wring Flesh',
    types: ['instant'],
    cost: { B: 1 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: -3, toughness: -1, targets: 'creature' } }],
  },
  // First strike
  {
    id: 'ef2a24f5-ce5e-4054-843a-2cae0c66318a',
    name: 'Youthful Knight',
    types: ['creature'],
    cost: { generic: 1, W: 1 },
    power: 2,
    toughness: 1,
    keywords: { firstStrike: true },
    subtypes: ['human', 'knight'],
  },
  // Flying, double strike, vigilance, trample, indestructible
  {
    id: '7da0e5de-3e4c-420a-8685-991206100b9d',
    name: 'Zetalpa, Primal Dawn',
    types: ['creature'],
    cost: { generic: 6, W: 2 },
    power: 4,
    toughness: 8,
    legendary: true,
    keywords: { flying: true, doubleStrike: true, vigilance: true, trample: true, indestructible: true },
    subtypes: ['elder', 'dinosaur'],
  },
  // When this land enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)
  // {T}: Add {C}.
  {
    id: '13aab4fc-4c89-45e6-8275-b074b00d0ee9',
    name: 'Zhalfirin Void',
    types: ['land'],
    produces: ['C'],
    triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'scry' }], label: 'Enters: scry 1' }],
  },
  {
    id: 'eadd88b6-e75a-4482-8382-561718121772',
    name: 'Zombie Goliath',
    types: ['creature'],
    cost: { generic: 4, B: 1 },
    power: 4,
    toughness: 3,
    subtypes: ['zombie', 'giant'],
  },
]);
