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
 * 124 cards.
 */

import type { CardDefinition } from '@jonny-boi/core';

export const EXPANDED_CARD_POOL: readonly CardDefinition[] = Object.freeze([
  // Counter target spell. You gain 3 life.
  {
    id: '132ca99a-a3c7-4ed6-b4d0-0edcd7140ca2',
    name: 'Absorb',
    types: ['instant'],
    cost: { W: 1, U: 2 },
    effects: [{ primitive: 'counterSpell' }, { primitive: 'gainLife', params: { amount: 3 } }],
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
  },
  // {T}: Add one mana of any color.
  {
    id: 'efb0394c-2a45-4dd8-bca3-08704056fa31',
    name: 'Alloy Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 3 },
    power: 2,
    toughness: 2,
    producesOptions: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
  },
  {
    id: '4caa8e68-e599-416f-b839-3d009569ff29',
    name: 'Alpha Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 2,
    toughness: 1,
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
    produces: ['W'],
  },
  // This land enters tapped.
  // {T}: Add {W} or {U}.
  {
    id: 'ad1712d8-809f-410c-8b91-ffe6fb8a69a1',
    name: 'Azorius Guildgate',
    types: ['land'],
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
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Goblin', count: 2 } }],
        label: 'Enters: create two 1/1 red goblin creature tokens',
      },
    ],
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
  // This land enters tapped.
  // {T}: Add {R} or {W}.
  {
    id: '73c423b7-cab8-4e69-8070-9edbf96a6c2c',
    name: 'Boros Guildgate',
    types: ['land'],
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
  },
  // Counter target spell.
  {
    id: '7d00fb28-ea6c-49a9-b4af-ffb38860a9a7',
    name: 'Cancel',
    types: ['instant'],
    cost: { generic: 1, U: 2 },
    effects: [{ primitive: 'counterSpell' }],
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
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: 'Enters: draw a card',
      },
    ],
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
    produces: ['G'],
  },
  {
    id: '4ed27607-21a8-4bc3-997e-6d2242313f6d',
    name: 'Coral Merfolk',
    types: ['creature'],
    cost: { generic: 1, U: 1 },
    power: 2,
    toughness: 1,
  },
  {
    id: '6a462a69-3e42-41de-a3aa-a488d9f38d69',
    name: 'Craw Wurm',
    types: ['creature'],
    cost: { generic: 4, G: 2 },
    power: 6,
    toughness: 4,
  },
  // Destroy all creatures.
  {
    id: 'd057289d-5e28-43d5-8ff3-4a1bc723477d',
    name: 'Day of Judgment',
    types: ['sorcery'],
    cost: { generic: 2, W: 2 },
    effects: [{ primitive: 'destroyAll' }],
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
  },
  // This land enters tapped.
  // {T}: Add {U} or {B}.
  {
    id: '52d14717-0cbc-4d7e-b546-54ea91580338',
    name: 'Dimir Guildgate',
    types: ['land'],
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
    entersTapped: true,
  },
  // Target creature gets -2/-2 until end of turn.
  {
    id: '77eafe49-b9c5-461d-89c5-cec217dd2974',
    name: 'Disfigure',
    types: ['instant'],
    cost: { B: 1 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: -2, toughness: -2 } }],
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
    effects: [{ primitive: 'counterSpell' }, { primitive: 'drawCards', params: { count: 1 } }],
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
  },
  // {T}: Add {G}.
  {
    id: '3f3b2c10-21f8-4e13-be83-4ef3fa36e123',
    name: 'Elvish Mystic',
    types: ['creature'],
    cost: { G: 1 },
    power: 1,
    toughness: 1,
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
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: 'Enters: draw a card',
      },
    ],
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
  },
  // Flame Slash deals 4 damage to target creature.
  {
    id: '8d98d674-6811-4d45-b22a-63792e272a2b',
    name: 'Flame Slash',
    types: ['sorcery'],
    cost: { R: 1 },
    effects: [{ primitive: 'dealDamage', params: { amount: 4 } }],
  },
  // {T}: Add {G}.
  {
    id: 'df317532-7d36-40fd-938f-e972749c8792',
    name: 'Fyndhorn Elves',
    types: ['creature'],
    cost: { G: 1 },
    power: 1,
    toughness: 1,
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
  },
  // When this creature enters, create a 1/1 red Goblin creature token.
  {
    id: '8b022754-6d16-470e-b754-4df6e4f4709e',
    name: 'Goblin Instigator',
    types: ['creature'],
    cost: { generic: 1, R: 1 },
    power: 1,
    toughness: 1,
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
  },
  // {T}: Add {W}.
  {
    id: 'bd6af7b3-b30f-4a65-a18f-8655f778e76a',
    name: 'Gold Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 1,
    toughness: 1,
    produces: ['W'],
  },
  // This land enters tapped.
  // {T}: Add {B} or {G}.
  {
    id: 'fa2da325-6859-45bb-b185-35526b01bcc1',
    name: 'Golgari Guildgate',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ B: 1 }, { G: 1 }],
  },
  // Target creature gets -4/-4 until end of turn.
  {
    id: '494c819d-7d73-432b-8c96-4cb9dcd31094',
    name: 'Grasp of Darkness',
    types: ['instant'],
    cost: { B: 2 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: -4, toughness: -4 } }],
  },
  {
    id: '14c8f55d-d177-4c25-a931-ebeb9e6062a0',
    name: 'Grizzly Bears',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 2,
    toughness: 2,
  },
  // This land enters tapped.
  // {T}: Add {R} or {G}.
  {
    id: 'd38476e9-2e47-4c0c-8129-483c0bd09ec0',
    name: 'Gruul Guildgate',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ R: 1 }, { G: 1 }],
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
  },
  {
    id: '342199e0-15b6-4824-83da-25caef2592b3',
    name: 'Hill Giant',
    types: ['creature'],
    cost: { generic: 3, R: 1 },
    power: 3,
    toughness: 3,
  },
  // {T}: Add {R}.
  {
    id: '6c5cbab6-ee27-46f5-97a7-df85698d1e9f',
    name: 'Iron Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 1,
    toughness: 1,
    produces: ['R'],
  },
  // This land enters tapped.
  // {T}: Add {U} or {R}.
  {
    id: 'bf75a3d1-f184-4b48-a913-21caee1db084',
    name: 'Izzet Guildgate',
    types: ['land'],
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
  },
  // Whenever you cast an instant or sorcery spell, this creature gets +3/+0 until end of turn.
  {
    id: 'eac8c196-8477-4b79-9875-21afa1e61708',
    name: 'Kiln Fiend',
    types: ['creature'],
    cost: { generic: 1, R: 1 },
    power: 1,
    toughness: 2,
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
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: -3, toughness: -3 } }],
  },
  // Lava Spike deals 3 damage to target player or planeswalker.
  {
    id: '2837888c-bfa8-4955-9334-0605ad409f7e',
    name: 'Lava Spike',
    types: ['sorcery'],
    cost: { R: 1 },
    effects: [{ primitive: 'dealDamage', params: { amount: 3 } }],
  },
  // {T}: Add {B}.
  {
    id: 'f62cabf0-df0d-4c4f-a93a-9340967d1775',
    name: 'Leaden Myr',
    types: ['artifact', 'creature'],
    cost: { generic: 2 },
    power: 1,
    toughness: 1,
    produces: ['B'],
  },
  {
    id: '0ee14128-3bec-4b65-8ee4-619337d4ed45',
    name: 'Leatherback Baloth',
    types: ['creature'],
    cost: { G: 3 },
    power: 4,
    toughness: 5,
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
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 4 } }],
        label: 'Enters: you gain 4 life',
      },
    ],
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
  {
    id: '7663ac7c-1de3-4250-b96a-fae9dbd66a27',
    name: 'Memnite',
    types: ['artifact', 'creature'],
    power: 1,
    toughness: 1,
  },
  // Target creature gets +7/+7 until end of turn.
  {
    id: '8331f281-819b-4a0b-bad7-bd86dbedb877',
    name: 'Might of Oaks',
    types: ['instant'],
    cost: { generic: 3, G: 1 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 7, toughness: 7 } }],
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
    effects: [{ primitive: 'destroyTarget', params: {  } }],
  },
  {
    id: 'e876d1fc-3acd-41a3-a34b-2bfa83204393',
    name: 'Nessian Courser',
    types: ['creature'],
    cost: { generic: 2, G: 1 },
    power: 3,
    toughness: 3,
  },
  // Flying
  {
    id: 'a3a98bc9-caa0-49b7-951c-fe4e4f54e4ba',
    name: 'Ornithopter',
    types: ['artifact', 'creature'],
    power: 0,
    toughness: 2,
    keywords: { flying: true },
  },
  // This land enters tapped.
  // {T}: Add {W} or {B}.
  {
    id: '57b37df5-fee4-4720-931f-f0cb0a8b338c',
    name: 'Orzhov Guildgate',
    types: ['land'],
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
  },
  {
    id: '60ba93eb-39e6-4af2-9c66-cd38f72daff2',
    name: 'Savannah Lions',
    types: ['creature'],
    cost: { W: 1 },
    power: 2,
    toughness: 1,
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
  },
  // This land enters tapped.
  // {T}: Add {G} or {W}.
  {
    id: '75b235d3-595a-4859-be45-9559d8445db5',
    name: 'Selesnya Guildgate',
    types: ['land'],
    entersTapped: true,
    producesOptions: [{ G: 1 }, { W: 1 }],
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
    produces: ['U'],
  },
  // This land enters tapped.
  // {T}: Add {G} or {U}.
  {
    id: 'e8705df9-6439-4930-91b6-229f818559af',
    name: 'Simic Guildgate',
    types: ['land'],
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
  },
  // Sorin's Vengeance deals 10 damage to target player or planeswalker and you gain 10 life.
  {
    id: '75d9c036-4f0d-4b55-b0a4-096ca84748ca',
    name: 'Sorin\'s Vengeance',
    types: ['sorcery'],
    cost: { generic: 4, B: 3 },
    effects: [
      { primitive: 'dealDamage', params: { amount: 10 } },
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
  // Destroy target creature. It can't be regenerated.
  {
    id: '6257c2fd-005f-41e3-8a72-af76df1eb134',
    name: 'Terminate',
    types: ['instant'],
    cost: { B: 1, R: 1 },
    effects: [{ primitive: 'destroyTarget', params: {  } }],
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
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 4, toughness: 4 } }],
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
  // Deathtouch (Any amount of damage this deals to a creature is enough to destroy it.)
  {
    id: 'd6ee6cc1-902d-4f56-afa5-6fa4813bfbbc',
    name: 'Typhoid Rats',
    types: ['creature'],
    cost: { B: 1 },
    power: 1,
    toughness: 1,
    keywords: { deathtouch: true },
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
    produces: ['G'],
  },
  {
    id: 'fea95888-e16a-4209-9cd4-623f7f4d2f67',
    name: 'Walking Corpse',
    types: ['creature'],
    cost: { generic: 1, B: 1 },
    power: 2,
    toughness: 2,
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
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: -3, toughness: -1 } }],
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
  },
  {
    id: 'eadd88b6-e75a-4482-8382-561718121772',
    name: 'Zombie Goliath',
    types: ['creature'],
    cost: { generic: 4, B: 1 },
    power: 4,
    toughness: 3,
  },
]);
