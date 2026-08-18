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
 * 159 cards.
 */

import type { CardDefinition } from '@jonny-boi/core';

export const EXPANDED_CARD_POOL: readonly CardDefinition[] = Object.freeze([
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
  // Draw three cards.
  {
    id: 'a3d287ec-1a39-4f91-acf1-7c1d2c00ed89',
    name: 'Concentrate',
    types: ['sorcery'],
    cost: { generic: 2, U: 2 },
    effects: [{ primitive: 'drawCards', params: { count: 3 } }],
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
  // Target creature gets +7/+7 until end of turn.
  {
    id: '8331f281-819b-4a0b-bad7-bd86dbedb877',
    name: 'Might of Oaks',
    types: ['instant'],
    cost: { generic: 3, G: 1 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 7, toughness: 7, targets: 'creature' } }],
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
  {
    id: '7af75024-6c9b-4844-aeb6-81de25464822',
    name: 'Phyrexian Walker',
    types: ['artifact', 'creature'],
    power: 0,
    toughness: 3,
    subtypes: ['phyrexian', 'construct'],
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
  {
    id: 'ec49dfcf-d16d-4621-af4b-4a6f09043221',
    name: 'Runeclaw Bear',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 2,
    toughness: 2,
    subtypes: ['bear'],
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
  // {T}: Add {G} or {U}.
  {
    id: 'e8705df9-6439-4930-91b6-229f818559af',
    name: 'Simic Guildgate',
    types: ['land'],
    subtypes: ['gate'],
    entersTapped: true,
    producesOptions: [{ G: 1 }, { U: 1 }],
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
  // Destroy target creature. It can't be regenerated.
  {
    id: '6257c2fd-005f-41e3-8a72-af76df1eb134',
    name: 'Terminate',
    types: ['instant'],
    cost: { B: 1, R: 1 },
    effects: [{ primitive: 'destroyTarget', params: { targets: 'creature' } }],
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
  { id: '05d24b0c-904a-46b6-b42a-96a4d91a0dd4', name: 'Wastes', types: ['land'], produces: ['C'] },
  {
    id: 'a35c2e20-eb90-4132-b65f-be1fcb569819',
    name: 'Watchwolf',
    types: ['creature'],
    cost: { W: 1, G: 1 },
    power: 3,
    toughness: 3,
    subtypes: ['wolf'],
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
