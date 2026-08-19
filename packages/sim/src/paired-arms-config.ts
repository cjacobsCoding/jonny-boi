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
import { HYBRID_PILOT_ID, MCTS_PILOT_ID } from '@jonny-boi/ai';

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
  /*
   * `ifKicked` is classified CONSERVATIVELY, and deliberately so: it is a
   * branch wrapper whose NESTED effect refs live inside its `effects` param,
   * where the decklist scan (which reads top-level `EffectRef.primitive` ids)
   * cannot see them. A kicked clause that wrapped a library reader would
   * therefore be invisible to the identical-game argument. Treating the wrapper
   * itself as library-reading withdraws the skip for any game that resolves a
   * kicked clause — sound whatever the clause contains, at the cost of playing
   * a few extra variant games in kicker decks.
   */
  'ifKicked',
  // Reads the top of a library and rearranges it.
  'reorderTopOfLibrary',
  // Reads the whole library to choose a card.
  'searchLibrary',
  // Reads the top card and BRANCHES on what it is — the filter miss is the
  // dangerous case: it looked, learned, and moved nothing.
  'revealTopCard',
  // Writes a card into the library, moving the slot we reason about.
  'putFromHandOnTop',
  // A shuffle permutes both arms identically, but the *question* ("may I shuffle?")
  // is answered by a pilot valuing a library it can see. Classified conservatively.
  'mayShuffleLibrary',
  // Delver's upkeep: reads the top card and BRANCHES on what it is (the reveal
  // choice's valence, and whether the source transforms). Same shape as
  // `revealTopCard`, with the same dangerous miss: it looked, learned, and
  // moved nothing — so a swapped top card can diverge the games invisibly.
  'transformRevealTop',
  /*
   * Scry READS the top N cards and then REORDERS them — both halves break the
   * identical-game argument. The read is the dangerous one: a scry that bottoms
   * everything it saw has moved cards the runner tracks (each bottoming emits a
   * `zoneChange`), but the DECISION was made by looking at cards the swap may
   * have changed, so the two arms can diverge from the same visible moves.
   */
  'scry',
  // Surveil is the same look with a graveyard for a bottom: it reads the top N
  // and branches on what it saw.
  'surveil',
]);

/**
 * The parameter every library primitive resolves its victim from, and the value
 * that means "the source's own controller".
 *
 * `playerParam(ctx, 'who', 'controller')` accepts `'controller'`, `'opponent'`,
 * `'targetPlayer'` and `'targetController'` — so a primitive id alone does NOT
 * tell you whose library was read, and neither does the source's controller. Only
 * the authored card data does, which is why `paired-arms.ts` scans the decklist
 * rather than guessing from the event.
 */
export const LIBRARY_TARGET_PARAM = 'who';
export const SELF_LIBRARY_TARGET = 'controller';
/** `who: 'opponent'` — the player who is NOT the source's controller. */
export const OPPONENT_LIBRARY_TARGET = 'opponent';

/**
 * Primitives that can move a permanent from one player's control to another's.
 *
 * The identical-game check reads a source card's OWNER off its instance id and
 * treats that as its controller, which is what lets it say "this Ponder belongs to
 * the opponent, so it read the opponent's library". A control-changing effect
 * breaks that equivalence: a stolen card's controller is no longer its owner, and
 * `who: 'controller'` would then resolve to the wrong player.
 *
 * The set is EMPTY because the pool has no such primitive today. It exists so the
 * assumption is written down and checked rather than implied — if one is ever
 * added, the runner falls back to the fully conservative rule instead of quietly
 * returning a wrong answer, and `paired-arms.test.ts` fails until it is classified.
 */
export const CONTROL_CHANGING_PRIMITIVES: ReadonlySet<string> = new Set<string>();

/**
 * Primitives that provably cannot read a library, and so leave the identical-game
 * argument intact. Listed explicitly (rather than "everything not above") so the
 * classification test can prove the two sets together cover the whole registry.
 */
export const LIBRARY_SAFE_PRIMITIVES: ReadonlySet<string> = new Set([
  'dealDamage',
  // Drawing is safe *because* every drawn card announces its instance id.
  'drawCards',
  /*
   * `mill` is SAFE for exactly the same reason `drawCards` is, which is worth
   * spelling out because "milling doesn't read a library" sounds wrong.
   *
   * Mill never branches on what it saw: it moves the top N cards to the graveyard
   * through `moveOwnedCard`, and every single one of those moves emits a
   * `zoneChange` carrying its instance id. So the runner already tracks mill
   * EXACTLY, per card:
   *   - the swapped card gets milled  → its id lands in `leftLibrary` → replay;
   *   - it doesn't                    → both arms milled the same cards from the
   *                                     same positions, so the games still agree.
   * Classifying it as library-reading would disqualify every game containing any
   * mill effect and buy no soundness whatsoever.
   */
  'mill',
  // Battlefield-only: reads and writes creatures, never a library.
  'fight',
  // Changing who controls a permanent touches the battlefield and the continuous
  // layer only — no library is read, so paired arms stay comparable.
  'gainControl',
  // Attaching an Aura/Equipment reads only the battlefield permanent it targets.
  'attachToTarget',
  'dealDamageToEach',
  'addCounters',
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
  // Countering with an optional payment reads the stack and a mana pool, and the
  // question it asks ("pay {3}?") is answered from the board, never from a library.
  'counterUnlessPaid',
  // Ward's resolution is the same shape: a stack read, a pay-or-decline answered
  // from the board, and a counter that moves only known cards.
  'wardCounterUnlessPaid',
  'createToken',
  'tapTarget',
  'discardCard',
  'returnFromGraveyard',
  'modal',
  'returnToHand',
  'tapPermanents',
  // Sacrifices read and write the BATTLEFIELD only: the victim's (or the pile
  // split's) choice is over permanents in play, and every card moved emits its
  // zoneChange. No library is ever consulted, so paired arms stay comparable.
  'sacrificeChosen',
  'pileSplitSacrifice',
  /*
   * Granting flashback reads the GRAVEYARD (a public zone, and one whose
   * contents the runner already tracks exactly: every card that got there
   * announced its instance id in a `zoneChange`), writes one grant record, and
   * branches on nothing a library holds. The recast it enables is an ordinary
   * cast of a card the log has already named. So the identical-game argument
   * survives it — unlike the top-of-library readers above, this one cannot see
   * the swapped card until that card has publicly arrived in the yard.
   */
  'grantFlashback',
]);

/**
 * Pilots that reason over information the *player* cannot see — specifically, the
 * real contents of the library, which a look-ahead pilot draws from when it
 * advances a hypothetical line past a draw step.
 *
 * For such a pilot the swapped card influences decisions from turn one whether or
 * not it is ever drawn, so "the game never saw the card" is false and the
 * identical-game skip is unsound. The runner detects a seated pilot by id and
 * disables the optimisation, recording the reason in the report.
 *
 * ⚠️ **The test is "does it search real engine states past a draw step", NOT
 * "does it roll out to a terminal".** `hybrid` was missing from this set for
 * exactly that reason: it deleted the rollout, so it *looked* like it had stopped
 * reading the library. It has not. Its tree spans **56–78 engine plies per
 * simulation** (measured on the tree-reuse branch) — many turns, and every draw
 * step inside that span deals the real, seeded library. Deleting the rollout
 * changed how DEEP it looks, not WHAT it may see.
 *
 * The consequence of the omission was not a slow test but a **wrong verdict**: a
 * paired A/B run under `--pilot hybrid` would skip variant games it believed
 * could not differ, when the swapped card had in fact been steering the search
 * from turn one. Any new searching pilot belongs here on the day it lands.
 */
export const PILOTS_THAT_READ_HIDDEN_LIBRARY: ReadonlySet<string> = new Set([
  MCTS_PILOT_ID,
  HYBRID_PILOT_ID,
]);
