/**
 * Selesnya Blink — the deck that plays its enters-the-battlefield triggers twice
 * (GW). *(New with DESIGN §3.35.)*
 *
 * **Game plan.** Every creature does something the moment it lands, and the deck
 * pays one mana — or, once Conjurer's Closet is out, nothing at all — to make it
 * land again. Nothing here is a combo: it is a value engine that turns each
 * blink into a card, a life swing or a body, and simply out-resources anything
 * that trades one-for-one.
 *
 * **Why the gauntlet needed it.** This is the first deck in the meta whose
 * advantage comes from RE-USING permanents rather than from playing more of
 * them, so it is the only list that punishes spot removal by making the removal
 * arrive too late. It also gives the gauntlet its first real test of CR 400.7 in
 * competitive volume: every blink is a permanent leaving and re-entering, which
 * is the shape most likely to expose an engine that treats a returning object as
 * the same one.
 *
 * **The payoff card is Thragtusk.** It reads "enters: gain 5 life" AND "leaves:
 * create a 3/3" — so a blink is five life and a 3/3 beast, and the Closet does
 * it every single turn. Everything else is a smaller version of the same deal:
 * Wall of Omens and Wall of Blossoms are cantrips that also block, Attended
 * Knight is a token per blink, Eternal Witness buys back the Cloudshift that
 * blinked it, and Wood Elves is a land per blink.
 *
 * **Matchups it is built for.** Strong against removal-heavy midrange and against
 * burn (eight 0/4 walls and a great deal of lifegain). Weak to Wrath of God — it
 * commits creatures and the walls die too — and to fast, wide aggro before the
 * walls arrive, since almost nothing here attacks well.
 *
 * Every card plays exactly as printed. The blink itself is the `blinkTarget`
 * primitive (DESIGN §3.35): the returned permanent is a genuinely new object, so
 * the trigger really does fire again, and it comes back untapped and summoning
 * sick rather than as a pseudo-untapper.
 */

import type { Deck } from '../../src/deck.js';

export const SELESNYA_BLINK: Deck = {
  name: 'Selesnya Blink',
  archetype: 'Midrange (enters-the-battlefield value)',
  cards: [
    // The engine. Cloudshift is the one-mana instant version — it also saves a
    // creature from targeted removal, which is why it is a four-of.
    { cardId: 'Cloudshift', count: 4 },
    // The repeatable version: every end step, for free, forever.
    { cardId: "Conjurer's Closet", count: 3 },

    // Two-drops that replace themselves and hold the ground while the deck sets
    // up. Eight 0/4 bodies is what makes an aggro draw stall out.
    { cardId: 'Wall of Omens', count: 4 }, // ETB draw a card
    { cardId: 'Wall of Blossoms', count: 4 }, // ETB draw a card
    { cardId: 'Elvish Visionary', count: 2 }, // ETB draw a card
    { cardId: 'Lone Missionary', count: 2 }, // ETB gain 4
    { cardId: 'Skyclave Cleric', count: 2 }, // ETB gain 2

    // Three-drops whose ETB is worth repeating.
    { cardId: 'Wood Elves', count: 3 }, // ETB fetch a Forest — ramp AND fixing
    { cardId: 'Eternal Witness', count: 3 }, // ETB rebuy a spent Cloudshift
    { cardId: 'Attended Knight', count: 3 }, // ETB a 1/1 soldier, every blink

    // The top end the whole deck is pointed at.
    { cardId: 'Thragtusk', count: 4 }, // ETB gain 5; LEAVES a 3/3 — a blink is both
    // The marquee blink card, and the only one here that blinks at INSTANT speed:
    // flash means it ambushes an attacker AND re-triggers something in the same
    // motion. It cannot target itself or another Angel (CR-faithful "non-Angel"),
    // so Angel of Mercy came out to keep the effect live rather than blanked.
    { cardId: 'Restoration Angel', count: 2 },

    // Mana. Both duals are on-colour and the lifegain land is genuinely on-plan
    // against the decks this list wants to beat.
    { cardId: 'Selesnya Guildgate', count: 4 },
    { cardId: 'Blossoming Sands', count: 4 },
    { cardId: 'Forest', count: 8 },
    { cardId: 'Plains', count: 8 },
  ],
};
