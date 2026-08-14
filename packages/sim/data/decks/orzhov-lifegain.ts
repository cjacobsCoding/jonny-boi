/**
 * Orzhov Lifegain — every creature also gains life (WB). *(New in the retune.)*
 *
 * **Game plan.** Play a curve of cheap lifelinking bodies, most of them in the air,
 * and back them with the two best one-mana removal spells in the pool. It does not
 * race and it does not durdle: it attacks profitably every turn while its life
 * total goes *up*, so an aggro deck's clock never actually arrives and a midrange
 * deck's ground creatures never get to block the fliers.
 *
 * **Why the gauntlet needed it.** Before this deck the meta had no list whose
 * defence was its offence — the aggro decks all raced, and the only thing that
 * punished racing was a control deck that answered cards one at a time. Orzhov is
 * the archetype that *beats a race by winning it slower*: Vampire Nighthawk alone
 * blanks most attackers (2/3 flying deathtouch lifelink) while representing four
 * life a turn in either direction.
 *
 * **Matchups it is built for.** Very strong against the burn and weenie decks
 * (every trade gains life, and deathtouch/first-strike-proof fliers stop the
 * ground). Weak to Wrath of God — it commits real creatures to the board and has
 * no way to rebuild — and to hard countermagic, since it has no card advantage of
 * its own beyond a slow stream of two-for-ones.
 *
 * Every card plays exactly as printed: lifelink, flying, deathtouch and vigilance
 * are all engine-v2 combat keywords, and Angel of Mercy's ETB lifegain is a real
 * trigger.
 */

import type { Deck } from '../../src/deck.js';

export const ORZHOV_LIFEGAIN: Deck = {
  name: 'Orzhov Lifegain',
  archetype: 'Midrange (lifelink + removal)',
  cards: [
    // One- and two-drops that attack and gain at the same time.
    { cardId: "Healer's Hawk", count: 4 }, // 1/1 flying, lifelink
    { cardId: 'Child of Night', count: 4 }, // 2/1 lifelink
    { cardId: "Ajani's Sunstriker", count: 4 }, // 2/2 lifelink
    // The three-drops the deck is actually built around.
    { cardId: 'Vampire Nighthawk', count: 4 }, // 2/3 flying, deathtouch, lifelink
    { cardId: 'Aerial Responder', count: 4 }, // 2/3 flying, vigilance, lifelink
    // The pool's most efficient removal, in the colours that want it.
    { cardId: 'Swords to Plowshares', count: 4 },
    { cardId: 'Fatal Push', count: 4 },
    { cardId: 'Doom Blade', count: 4 },
    // A top end that is another four life the turn it lands.
    { cardId: 'Angel of Mercy', count: 4 }, // 3/3 flying, ETB gain 3
    // Two-colour mana; the lifegain dual is genuinely on-plan here.
    { cardId: 'Orzhov Guildgate', count: 4 },
    { cardId: 'Scoured Barrens', count: 4 },
    { cardId: 'Plains', count: 8 },
    { cardId: 'Swamp', count: 8 },
  ],
};
