/**
 * The sample-deck registry (DESIGN §2 "Data registries"). Every deck is a data
 * file in this directory; this index just collects them into one frozen array so
 * the harness and CLI can list/select by name. Adding a deck = create a file and
 * add it here — no harness change. These double as the provisional gauntlet until
 * §3.8 ships polished meta decks.
 */

import type { Deck } from '../../src/deck.js';
import { MONO_RED_AGGRO } from './mono-red-aggro.js';
import { MONO_GREEN_STOMPY } from './mono-green-stompy.js';
import { UW_CONTROL } from './uw-control.js';
import { MONO_BLUE_TEMPO } from './mono-blue-tempo.js';
import { MONO_BLACK_MIDRANGE } from './mono-black-midrange.js';

/** Every bundled sample deck, in a stable order. */
export const SAMPLE_DECKS: readonly Deck[] = Object.freeze([
  MONO_RED_AGGRO,
  MONO_GREEN_STOMPY,
  UW_CONTROL,
  MONO_BLUE_TEMPO,
  MONO_BLACK_MIDRANGE,
]);

export {
  MONO_RED_AGGRO,
  MONO_GREEN_STOMPY,
  UW_CONTROL,
  MONO_BLUE_TEMPO,
  MONO_BLACK_MIDRANGE,
};
