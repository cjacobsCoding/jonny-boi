/**
 * The sample-deck registry (DESIGN §2 "Data registries"). Every deck is a data
 * file in this directory; this index just collects them into one frozen array so
 * the harness and CLI can list/select by name. Adding a deck = create a file and
 * add it here — no harness change. These ARE the §3.8 polished meta gauntlet: six
 * distinct, competitively-sensible archetypes built entirely from fully-supported
 * pool cards (no fully-stubbed card is a deck's core).
 *
 * The spread of identities, so the gauntlet measures a deck against a real meta:
 *   - Mono-Red Aggro     — fastest clock, burn reach.
 *   - Izzet Prowess      — spell-velocity go-wide (tokens + prowess).
 *   - Mono-Green Ramp    — resilient ramp/value midrange.
 *   - UW Control         — removal + counters + a flying finisher.
 *   - Golgari Midrange   — discard + removal attrition with green bodies.
 *   - Boros Aggro        — removal-backed beatdown with a flying top-end.
 */

import type { Deck } from '../../src/deck.js';
import { MONO_RED_AGGRO } from './mono-red-aggro.js';
import { MONO_GREEN_STOMPY } from './mono-green-stompy.js';
import { UW_CONTROL } from './uw-control.js';
import { MONO_BLUE_TEMPO } from './mono-blue-tempo.js';
import { MONO_BLACK_MIDRANGE } from './mono-black-midrange.js';
import { BOROS_AGGRO } from './boros-aggro.js';

/** Every bundled sample deck, in a stable order. */
export const SAMPLE_DECKS: readonly Deck[] = Object.freeze([
  MONO_RED_AGGRO,
  MONO_GREEN_STOMPY,
  UW_CONTROL,
  MONO_BLUE_TEMPO,
  MONO_BLACK_MIDRANGE,
  BOROS_AGGRO,
]);

export {
  MONO_RED_AGGRO,
  MONO_GREEN_STOMPY,
  UW_CONTROL,
  MONO_BLUE_TEMPO,
  MONO_BLACK_MIDRANGE,
  BOROS_AGGRO,
};
