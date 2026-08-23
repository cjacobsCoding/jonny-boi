/**
 * The sample-deck registry (DESIGN §2 "Data registries"). Every deck is a data
 * file in this directory; this index just collects them into one frozen array so
 * the harness and CLI can list/select by name. Adding a deck = create a file and
 * add it here — no harness change. These ARE the §3.8 meta gauntlet: eight
 * distinct, competitively-sensible archetypes built entirely from cards that play
 * exactly as printed under engine-v2 (no stubbed mechanic is load-bearing).
 *
 * The spread of identities, so the gauntlet measures a deck against a real meta —
 * and, deliberately, so that each deck is somebody's bad matchup:
 *   - Mono-Red Aggro    — fastest clock, burn as reach.
 *   - Boros Aggro       — beatdown in the air, burn as the finisher.
 *   - Rakdos Goblins    — go wide; the deck that makes sweepers matter.
 *   - Izzet Prowess     — one threat that got enormous, backed by interaction.
 *   - Golgari Midrange  — discard + removal attrition; wins on cards.
 *   - Orzhov Lifegain   — lifelinking fliers; beats a race by winning it slower.
 *   - Mono-Green Ramp   — accelerate into creatures nothing beats on the ground.
 *   - Selesnya Blink    — re-uses its own creatures; wins on accumulated value.
 *   - UW Control        — answers, a sweeper, and a flier to close.
 *
 * The list was re-tuned after a wave of engine correctness fixes (the livelock fix
 * that removed ~60% bogus timeout draws, real modal/hybrid/enters-tapped mana, and
 * several cards becoming faithful). The old spread had two dominant midrange decks
 * and two decks under 30%; see each file for what changed and why.
 */

import type { Deck } from '../../src/deck.js';
import { MONO_RED_AGGRO } from './mono-red-aggro.js';
import { MONO_GREEN_STOMPY } from './mono-green-stompy.js';
import { UW_CONTROL } from './uw-control.js';
import { MONO_BLUE_TEMPO } from './mono-blue-tempo.js';
import { MONO_BLACK_MIDRANGE } from './mono-black-midrange.js';
import { BOROS_AGGRO } from './boros-aggro.js';
import { ORZHOV_LIFEGAIN } from './orzhov-lifegain.js';
import { RAKDOS_GOBLINS } from './rakdos-goblins.js';
import { SELESNYA_BLINK } from './selesnya-blink.js';

/** Every bundled sample deck, in a stable order (fastest to slowest). */
export const SAMPLE_DECKS: readonly Deck[] = Object.freeze([
  MONO_RED_AGGRO,
  BOROS_AGGRO,
  RAKDOS_GOBLINS,
  MONO_BLUE_TEMPO,
  MONO_BLACK_MIDRANGE,
  ORZHOV_LIFEGAIN,
  MONO_GREEN_STOMPY,
  UW_CONTROL,
  // APPENDED, not slotted into the curve order above, and deliberately so: a
  // gauntlet matchup is seeded by the opponent's INDEX (`gameSeedFor(baseSeed, i)`),
  // so inserting a deck mid-list reseeds every deck after it and silently moves
  // the recorded baseline. Slotting Selesnya Blink before UW Control moved UW's
  // row from 14 to 12 while changing nothing about how either deck plays.
  // Appending leaves all seven original rows byte-identical and adds an eighth.
  SELESNYA_BLINK,
]);

export {
  MONO_RED_AGGRO,
  MONO_GREEN_STOMPY,
  UW_CONTROL,
  MONO_BLUE_TEMPO,
  MONO_BLACK_MIDRANGE,
  BOROS_AGGRO,
  ORZHOV_LIFEGAIN,
  RAKDOS_GOBLINS,
  SELESNYA_BLINK,
};
