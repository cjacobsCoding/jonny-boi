/**
 * The curated card pool as DATA (DESIGN §3.2). Each entry is a plain
 * `CardDefinition` — cost / P-T / keywords / effect-refs are all data, never a
 * subclass and never an inline magic number in engine code. Adding a card is a
 * data edit here, ideally with no new primitive (DESIGN §1.1–1.2).
 *
 * JOIN KEY: every `id` is the Scryfall card id (UUID) from
 * `packages/data-tools/data/card-index.json`. The rules-side definition here and
 * the Scryfall display row (art, oracle text) join on this `id` — so the web UI
 * shows the correct art for the card the engine actually plays. `name` is carried
 * too and is a secondary join key (the data-tools index is unique by both).
 *
 * ACCURACY: a definition here is only as true as the index row it was written
 * from, and a wrong pip in either would bias every A/B verdict silently. Three
 * checks stand behind them, in increasing strength: `invariants.test.ts` proves
 * the index is self-consistent; the compiler's frame tests (`compile.test.ts`)
 * prove every definition below still matches its index row; and
 * `npm run verify -w @jonny-boi/data-tools` (opt-in, network) proves the index
 * still matches live Scryfall. Never hand-edit either side to make the other
 * agree — refresh the index, then let the frame tests point at what to redo.
 *
 * Effect-ref params carry every tunable value (damage amount, P/T delta, card
 * count, produced mana). The primitive ids referenced live in `../src/primitives`.
 *
 * Implementation honesty: the engine resolves `def.effects` as a spell's
 * resolution script, `def.triggers` as triggered abilities, and lets a resolving
 * effect ASK its controller (or its victim) a question mid-resolution — so
 * "choose", "you may", "in any order", "search your library" and modal "choose
 * two" are all played for real, not approximated. A spell that prints a target
 * restriction declares it as data (`params.targets`) and the engine enforces it
 * when the cast is offered, when it is applied, and again when it resolves — so
 * "target creature", "target player" and "target spell" mean what they say, and a
 * spell with no legal target cannot be cast. What it still has no system for is
 * transform, planeswalker loyalty, dynamic P/T, flash/flashback, activated
 * abilities, and target restrictions finer than those three (an opponent-only
 * target, "nonblack creature" as a legality rather than a resolution-time fizzle).
 * Cards whose identity needs one of those are authored as the closest faithful
 * subset (documented per-card); their
 * vanilla body (P/T, keywords, mana production) is always correct so they play on
 * the battlefield. See `STUBBED_MECHANICS`.
 */

import type { CardDefinition } from '@jonny-boi/core';
import { EXPANDED_CARD_POOL } from './expanded-pool.js';

/**
 * The five basic lands, by name — the DATA behind "search your library for a
 * **basic** land card" (Path to Exile). A `CardFilter` has no supertype field, so
 * a card that means "basic" carries the names it means (`params.nameAnyOf`) rather
 * than any primitive hard-coding a list of card names.
 */
export const BASIC_LAND_NAMES: readonly string[] = Object.freeze([
  'Plains',
  'Island',
  'Swamp',
  'Mountain',
  'Forest',
]);

/** "Nonland card", as a reusable `CardFilter` (Thoughtseize's discard filter). */
const NONLAND = Object.freeze({ noneOfTypes: Object.freeze(['land']) });

/** "A land card", as a reusable `CardFilter` (Goblin Guide's reveal, Path's fetch). */
const LAND = Object.freeze({ anyOfTypes: Object.freeze(['land']) });

/**
 * The hand-authored cards: written and reviewed against the engine directly,
 * before the Oracle compiler existed. They stay authored (rather than being
 * regenerated) because a few of them deliberately model the closest faithful
 * subset of a card whose full text the engine cannot do — see `STUBBED_MECHANICS`.
 */
export const CURATED_CARD_POOL: readonly CardDefinition[] = Object.freeze([
  // --- Basic lands (vanilla mana sources; zero custom effects) ----------------
  { id: 'bc71ebf6-2056-41f7-be35-b2e5c34afa99', name: 'Plains', types: ['land'], produces: ['W'] },
  { id: 'b2c6aa39-2d2a-459c-a555-fb48ba993373', name: 'Island', types: ['land'], produces: ['U'] },
  { id: '56719f6a-1a6c-4c0a-8d21-18f7d7350b68', name: 'Swamp', types: ['land'], produces: ['B'] },
  { id: 'a3fb7228-e76b-4e96-a40e-20b5fed75685', name: 'Mountain', types: ['land'], produces: ['R'] },
  { id: 'b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6', name: 'Forest', types: ['land'], produces: ['G'] },

  // --- Mana creatures / rocks (vanilla — mana production is data, no effects) --
  {
    // Birds of Paradise: 0/1 flyer, "{T}: Add one mana of any color" — a MODAL
    // source, so each color is its own mode and one tap yields exactly one mana.
    // (The old fixed-bundle `produces: ['W','U','B','R','G']` meant "add one of
    // each", which made it a five-mana rock.)
    id: 'd3a0b660-358c-41bd-9cd2-41fbf3491b1a',
    name: 'Birds of Paradise',
    types: ['creature'],
    cost: { G: 1 },
    power: 0,
    toughness: 1,
    keywords: { flying: true },
    producesOptions: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
  },
  {
    id: '68954295-54e3-4303-a6bc-fc4547a4e3a3',
    name: 'Llanowar Elves',
    types: ['creature'],
    cost: { G: 1 },
    power: 1,
    toughness: 1,
    produces: ['G'],
  },
  {
    id: '6ad8011d-3471-4369-9d68-b264cc027487',
    name: 'Sol Ring',
    types: ['artifact'],
    cost: { generic: 1 },
    // {T}: Add {C}{C} — a fixed bundle (no choice), so the legacy `produces`
    // form is exactly right: one tap adds one of each entry, i.e. two colorless.
    produces: ['C', 'C'],
  },

  // --- Burn / direct damage ----------------------------------------------------
  {
    id: '4457ed35-7c10-48c8-9776-456485fdf070',
    name: 'Lightning Bolt',
    types: ['instant'],
    cost: { R: 1 },
    effects: [{ primitive: 'dealDamage', params: { amount: 3 } }],
  },

  // --- Combat trick ------------------------------------------------------------
  {
    id: '5748ebf1-24e3-499d-ab7c-c2cebd462a24',
    name: 'Giant Growth',
    types: ['instant'],
    cost: { G: 1 },
    effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 3, toughness: 3, targets: 'creature' } }],
  },

  // --- Removal -----------------------------------------------------------------
  {
    id: '59e7f2ae-4535-4191-98be-3e65b6b2befa',
    name: 'Doom Blade',
    types: ['instant'],
    cost: { generic: 1, B: 1 },
    // Destroy target nonblack creature.
    effects: [{ primitive: 'destroyTarget', params: { targets: 'creature', notColor: 'B' } }],
  },
  {
    id: '16437a83-be52-44cd-a768-a767c9347eb2',
    name: 'Fatal Push',
    types: ['instant'],
    cost: { B: 1 },
    // Destroy target creature with mana value ≤ 2. (Revolt's ≤4 mode needs a
    // "permanent left the battlefield this turn" tracker the engine lacks; we
    // model the base mode faithfully.)
    effects: [{ primitive: 'destroyTarget', params: { targets: 'creature', maxManaValue: 2 } }],
  },
  {
    id: 'd683d985-9888-4d21-8b5f-69e69ce4a03b',
    name: 'Path to Exile',
    types: ['instant'],
    cost: { W: 1 },
    // "Exile target creature. Its controller MAY search their library for a basic
    // land card, put that card onto the battlefield tapped, then shuffle." Both
    // halves are real: the search is a yes/no + a selection put to the *creature's
    // controller* (usually the opponent), and it only happens when the creature
    // really was exiled (`requiresTargetInZone`).
    effects: [
      { primitive: 'exileTarget', params: { targets: 'creature' } },
      {
        primitive: 'searchLibrary',
        params: {
          who: 'targetController',
          requiresTargetInZone: 'exile',
          optional: true,
          count: 1,
          filter: LAND,
          nameAnyOf: BASIC_LAND_NAMES,
          destination: 'battlefield',
          tapped: true,
        },
      },
    ],
  },
  {
    id: 'b1544f21-7e98-461b-aed5-e748b0168c52',
    name: 'Swords to Plowshares',
    types: ['instant'],
    cost: { W: 1 },
    // Exile target creature; its controller gains life equal to its power.
    effects: [{ primitive: 'exileTarget', params: { gainLifeEqualPower: true, targets: 'creature' } }],
  },
  {
    id: '34515b16-c9a4-4f98-8c77-416a7a523407',
    name: 'Wrath of God',
    types: ['sorcery'],
    cost: { generic: 2, W: 2 },
    effects: [{ primitive: 'destroyAll' }],
  },

  // --- Card draw / selection ---------------------------------------------------
  {
    id: '36cd2364-d113-47d1-b2c4-b088d9eb88dd',
    name: 'Brainstorm',
    types: ['instant'],
    cost: { U: 1 },
    // "Draw three cards, then put two cards from your hand on top of your library
    // in any order." The order really is chosen: `putFromHandOnTop` asks an
    // ORDERED selection, and the first card named ends up on top.
    effects: [
      { primitive: 'drawCards', params: { count: 3 } },
      { primitive: 'putFromHandOnTop', params: { count: 2 } },
    ],
  },
  {
    id: '02090581-61aa-4348-ad57-451be8ee91c2',
    name: 'Ponder',
    types: ['sorcery'],
    cost: { U: 1 },
    // "Look at the top three cards of your library, then put them back in any
    // order. You may shuffle. Then draw a card." Three clauses, three effects —
    // the reorder is an ordered selection, the shuffle is a real yes/no.
    effects: [
      { primitive: 'reorderTopOfLibrary', params: { count: 3 } },
      { primitive: 'mayShuffleLibrary' },
      { primitive: 'drawCards', params: { count: 1 } },
    ],
  },

  // --- Counters ----------------------------------------------------------------
  {
    id: 'cc187110-1148-4090-bbb8-e205694a39f5',
    name: 'Counterspell',
    types: ['instant'],
    cost: { U: 2 },
    effects: [{ primitive: 'counterSpell', params: { targets: 'spell' } }],
  },
  {
    id: 'a3e51a35-09df-4189-b131-08a21e6a557d',
    name: 'Cryptic Command',
    types: ['instant'],
    cost: { generic: 1, U: 3 },
    // "Choose two —": all four printed modes, chosen for real. A mode whose target
    // is not legal for this cast is not offered (MTG's own rule), so a Cryptic cast
    // with nothing to counter still plays as the best legal version of itself.
    // Chosen modes run in PRINTED order, as MTG resolves a modal spell.
    effects: [
      {
        primitive: 'modal',
        params: {
          count: 2,
          modes: [
            {
              id: 'counter',
              label: 'Counter target spell',
              requires: 'targetSpell',
              effects: [{ primitive: 'counterSpell' }],
            },
            {
              id: 'bounce',
              label: "Return target permanent to its owner's hand",
              requires: 'targetPermanent',
              effects: [{ primitive: 'returnToHand' }],
            },
            {
              id: 'tapAll',
              label: 'Tap all creatures your opponents control',
              effects: [{ primitive: 'tapPermanents', params: { who: 'opponent', types: ['creature'] } }],
            },
            {
              id: 'draw',
              label: 'Draw a card',
              effects: [{ primitive: 'drawCards', params: { count: 1 } }],
            },
          ],
        },
      },
    ],
  },

  // --- Ritual / ramp -----------------------------------------------------------
  {
    id: '53f7c868-b03e-4fc2-8dcf-a75bbfa3272b',
    name: 'Dark Ritual',
    types: ['instant'],
    cost: { B: 1 },
    effects: [{ primitive: 'addMana', params: { mana: ['B', 'B', 'B'] } }],
  },

  // --- Discard -----------------------------------------------------------------
  {
    id: 'edd8d1e8-be43-4c38-bb3a-83081fbaf0b5',
    name: 'Thoughtseize',
    types: ['sorcery'],
    cost: { B: 1 },
    // "Target player reveals their hand. You choose a nonland card from it. That
    // player discards that card. You lose 2 life." The choice is put to the CASTER
    // (`chosenBy: 'controller'`) over the victim's nonland cards — which is both
    // the reveal and the pick — so the opponent loses the card you took, not the
    // one they would have given away.
    effects: [
      {
        primitive: 'discardCard',
        params: { count: 1, who: 'targetPlayer', chosenBy: 'controller', filter: NONLAND },
      },
      { primitive: 'loseLife', params: { amount: 2 } },
    ],
  },

  // --- ETB-script creatures ----------------------------------------------------
  {
    id: '5470dcfa-4eff-43da-abf7-19922841f719',
    name: 'Kitchen Finks',
    types: ['creature'],
    // {1}{G/W}{G/W} — a real hybrid cost now that the mana system can pay one
    // symbol with either color. (It was previously authored as a bare {1},
    // which made this a one-mana 3/2 and quietly warped every sim it appeared in.)
    cost: { generic: 1, hybrid: [['G', 'W'], ['G', 'W']] },
    power: 3,
    toughness: 2,
    // ETB: gain 2 life — authored as an `etb` trigger (not a resolution `effects`
    // script) so it ALSO fires when persist returns the creature to the battlefield.
    // Persist: when it dies, return it with a -1/-1 counter (engine-v2 dies-trigger +
    // the `persistReturn` primitive); the returned body can't persist again.
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'gainLife', params: { amount: 2 } }],
        label: 'ETB: gain 2 life',
      },
      {
        condition: { on: 'dies' },
        effects: [{ primitive: 'persistReturn', params: { minusCounters: 1 } }],
        label: 'Persist: return with a -1/-1 counter',
      },
    ],
  },
  {
    id: '30b24e8e-3b0e-4d8e-90f3-f66eb7c1858c',
    name: 'Eternal Witness',
    types: ['creature'],
    cost: { generic: 1, G: 2 },
    power: 2,
    toughness: 1,
    // "When this creature enters, you may return target card from your graveyard
    // to your hand." The quoted text is the CURRENT Oracle wording carried by
    // the card index — the comment used to quote the older, mandatory-sounding
    // printing, which made this entry's `optional: true` look like an invention.
    // It is not: the printed "you may" is why the return is declinable, and the
    // index is the source of truth (`npm run verify -w @jonny-boi/data-tools`
    // re-checks it against live Scryfall).
    //
    // Authored as an `etb` TRIGGER (not a resolution script) so it fires on every
    // entry — including a later blink/return — and the card that comes back is
    // CHOSEN by its controller, not whichever card happened to be on top of the
    // graveyard.
    triggers: [
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'returnFromGraveyard', params: { count: 1, optional: true } }],
        label: 'ETB: you may return a chosen card from your graveyard to your hand',
      },
    ],
  },

  // --- Vanilla / keyword creatures (zero custom effects; combat is data) -------
  {
    id: '51d9564b-44fc-4de1-9119-09d7b4089378',
    name: 'Goblin Guide',
    types: ['creature'],
    cost: { R: 1 },
    power: 2,
    toughness: 2,
    keywords: { haste: true },
    // "Whenever Goblin Guide attacks, the defending player reveals the top card of
    // their library. If it's a land card, that player puts it into their hand."
    // Exactly that: `revealTopCard` moves the top card only when it matches the
    // filter and otherwise leaves it where it is. (The reveal itself is not in the
    // event log — the engine has no `cardsRevealed` event — but every mechanical
    // consequence of it is.)
    triggers: [
      {
        condition: { on: 'attacks' },
        effects: [{ primitive: 'revealTopCard', params: { who: 'opponent', filter: LAND } }],
        label: 'Attacks: defending player reveals the top card; a land goes to their hand',
      },
    ],
  },
  {
    id: 'dafd2713-d1bc-474b-b390-d2ff20b5375e',
    name: 'Monastery Swiftspear',
    types: ['creature'],
    cost: { R: 1 },
    power: 1,
    toughness: 2,
    keywords: { haste: true },
    // Prowess: whenever you cast a NONCREATURE spell, +1/+1 until end of turn —
    // modelled as the negative filter it is printed as, pumping the source itself
    // through the until-EOT continuous layer.
    //
    // It used to be two positive triggers (instant + sorcery), on the assumption
    // that those are "the noncreature spells in the pool". They are not: Sol Ring,
    // Manalith, Worn Powerstone, Ur-Golem's Eye, the five Diamonds and Liliana of
    // the Veil are all noncreature spells that left Swiftspear flat — the card
    // played measurably WEAKER than printed, which biases a verdict exactly as
    // badly as playing stronger.
    triggers: [
      {
        condition: { on: 'castSpell', who: 'you', spellTypeNoneOf: ['creature'] },
        effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 1, toughness: 1 } }],
        label: 'Prowess: +1/+1 until end of turn',
      },
    ],
  },
  {
    id: '4b7ac066-e5c7-43e6-9e7e-2739b24a905d',
    name: 'Serra Angel',
    types: ['creature'],
    cost: { generic: 3, W: 2 },
    power: 4,
    toughness: 4,
    keywords: { flying: true, vigilance: true },
  },
  {
    id: '5fac139a-07d3-4e6c-98e3-d98b199f7a6f',
    name: 'Young Pyromancer',
    types: ['creature'],
    cost: { generic: 1, R: 1 },
    power: 2,
    toughness: 1,
    // "Whenever you cast an instant or sorcery spell, create a 1/1 red Elemental
    // creature token." Two cast-triggers (instant + sorcery), each making a 1/1 via
    // the `makeToken` primitive (token P/T/name are DATA — no magic numbers).
    triggers: [
      {
        condition: { on: 'castSpell', who: 'you', spellType: 'instant' },
        effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Elemental' } }],
        label: 'Cast instant: make a 1/1 red Elemental',
      },
      {
        condition: { on: 'castSpell', who: 'you', spellType: 'sorcery' },
        effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Elemental' } }],
        label: 'Cast sorcery: make a 1/1 red Elemental',
      },
    ],
  },
  {
    id: '2bb2eda7-3b38-4c56-870f-c3218a1056f5',
    name: 'Snapcaster Mage',
    types: ['creature'],
    cost: { generic: 1, U: 1 },
    power: 2,
    toughness: 1,
    keywords: {},
    // Flash + flashback-granting ETB needs flash timing + graveyard recast; the
    // vanilla 2/1 plays correctly.
  },
  {
    id: 'e3afc704-220f-498f-9eaa-0821b17dc24c',
    name: 'Sakura-Tribe Elder',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    power: 1,
    toughness: 1,
    // Sacrifice for a land needs an activated sac-ability + land search; vanilla
    // 1/1 plays correctly.
  },
  {
    id: 'edd531b9-f615-4399-8c8c-1c5e18c4acbf',
    name: 'Delver of Secrets',
    types: ['creature'],
    cost: { U: 1 },
    power: 1,
    toughness: 1,
    keywords: { flying: false },
    // Transform (upkeep trigger flipping to a 3/2 flyer) needs a transform system;
    // the front-face vanilla 1/1 plays correctly.
  },
  {
    id: '45900b2f-f6a9-4c42-9642-008f3c1cf6dd',
    name: 'Tarmogoyf',
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    // P/T is "* / *+1" derived from graveyard card types — a dynamic characteristic
    // the stat layer can't express yet. We pin a representative baseline (2/3) so
    // it plays as a creature; the dynamic P/T is the documented stub.
    power: 2,
    toughness: 3,
  },

  // --- Planeswalker ------------------------------------------------------------
  {
    id: '0ba134d8-ee7d-48ec-8dc6-57942b8e9261',
    name: 'Liliana of the Veil',
    types: ['planeswalker'],
    cost: { generic: 1, B: 2 },
    // Loyalty abilities need a planeswalker/loyalty system the engine lacks. She
    // enters as a permanent (correct zone/cost); her abilities are the stub.
  },
]);

/**
 * The whole playable pool: the hand-authored cards above plus every card the
 * Oracle-text compiler could build faithfully from its real Scryfall text
 * (`./expanded-pool.ts`, generated — see `../scripts/build-expansion.ts`).
 *
 * One list, one shape: a compiled card is a `CardDefinition` exactly like an
 * authored one, so everything downstream (the loader, deck validation, the sim,
 * the UI) treats them identically. Growing the pool is a DATA change — add names
 * to `./expansion-candidates.json` and re-run the generator.
 */
export const CARD_POOL: readonly CardDefinition[] = Object.freeze([
  ...CURATED_CARD_POOL,
  ...EXPANDED_CARD_POOL,
]);
