/**
 * Named constants behind the paired-arm runner's **identical-game** argument
 * (`paired-arms.ts`). Everything the exactness proof depends on lives here, named
 * and auditable, rather than as literals buried in the runner.
 *
 * The claim being made is strong — "this variant game cannot possibly differ from
 * the base game, so we will not play it" — so each assumption is either verified at
 * runtime or pinned by a test that fails when the world changes underneath it.
 */

import type { PlayerId } from '@jonny-boi/core';
import { MCTS_PILOT_ID } from '@jonny-boi/ai';

/**
 * The seat the deck under test always occupies. `evaluateSwap`, the gauntlet and
 * the suggestion engine all seat the hero as A and the opponent as B; a "win" in
 * every paired table means this seat won.
 */
export const HERO_SEAT: PlayerId = 'A';

/**
 * The instance id core assigns to the hero's FIRST library card. Ids are minted
 * sequentially from 1 as libraries are built, hero first, so the hero's pre-shuffle
 * library index `i` carries id `i + HERO_FIRST_INSTANCE_ID`. Verified at runtime by
 * `verifyHeroInstanceIdMapping` — if a future engine mints ids differently the
 * optimisation switches itself off rather than answering wrongly.
 */
export const HERO_FIRST_INSTANCE_ID = 1;

/**
 * Effect primitives whose behaviour can depend on **library contents**.
 *
 * When one of these resolves, the base and variant games may diverge even though
 * the swapped card was never drawn — a search sees a different card list, a
 * top-of-library peek sees a different card — so the identical-game claim is
 * withdrawn for that game and the variant is played for real.
 *
 * Primitives that only *move known cards* (draws, discards, removal, combat tricks)
 * are absent on purpose: a draw is reported by a `drawCard` event carrying the
 * exact instance id, which the runner already tracks precisely.
 *
 * `paired-arms.test.ts` asserts that EVERY primitive the card pool registers is
 * classified either here or in {@link LIBRARY_SAFE_PRIMITIVES}. A new primitive
 * therefore breaks the build until someone decides which side it belongs on — the
 * failure mode is a red test, never a silently wrong verdict.
 */
export const LIBRARY_READING_PRIMITIVES: ReadonlySet<string> = new Set([
  // Reads the top of a library and rearranges it.
  'reorderTopOfLibrary',
  // Reads the whole library to choose a card.
  'searchLibrary',
  // Reads the top card and acts on what it is.
  'revealTopCard',
  // Writes a card into the library, moving the slot we reason about.
  'putFromHandOnTop',
  // A shuffle permutes both arms identically, but the *question* ("may I shuffle?")
  // is answered by a pilot valuing a library it can see. Classified conservatively.
  'mayShuffleLibrary',
]);

/**
 * Primitives that provably cannot read a library, and so leave the identical-game
 * argument intact. Listed explicitly (rather than "everything not above") so the
 * classification test can prove the two sets together cover the whole registry.
 */
export const LIBRARY_SAFE_PRIMITIVES: ReadonlySet<string> = new Set([
  'dealDamage',
  // Drawing is safe *because* every drawn card announces its instance id.
  'drawCards',
  'gainLife',
  'loseLife',
  'pumpUntilEndOfTurn',
  'grantKeywordUntilEndOfTurn',
  'makeToken',
  'persistReturn',
  'destroyTarget',
  'exileTarget',
  'destroyAll',
  'addMana',
  'counterSpell',
  'createToken',
  'tapTarget',
  'discardCard',
  'returnFromGraveyard',
  'modal',
  'returnToHand',
  'tapPermanents',
]);

/**
 * Pilots that reason over information the *player* cannot see — specifically, the
 * real contents of the library, which a look-ahead pilot draws from when it rolls
 * out hypothetical lines.
 *
 * For such a pilot the swapped card influences decisions from turn one whether or
 * not it is ever drawn, so "the game never saw the card" is false and the
 * identical-game skip is unsound. The runner detects a seated pilot by id and
 * disables the optimisation, recording the reason in the report.
 */
export const PILOTS_THAT_READ_HIDDEN_LIBRARY: ReadonlySet<string> = new Set([MCTS_PILOT_ID]);
