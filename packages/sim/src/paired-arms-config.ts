/**
 * Named constants behind the paired-arm runner's **identical-game** argument
 * (`paired-arms.ts`). Everything the exactness proof depends on lives here, named
 * and auditable, rather than as literals buried in the runner.
 *
 * The claim being made is strong — "this variant game cannot possibly differ from
 * the base game, so we will not play it" — so each assumption is either verified at
 * runtime or pinned by a test that fails when the world changes underneath it.
 */

import type { CardDefinition, PlayerId } from '@jonny-boi/core';
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
 * ⚠️ THE CR 514.1 CLEANUP DISCARD IS NOT A PRIMITIVE AND DOES NOT BELONG HERE,
 * and it is worth saying so rather than leaving a reader to notice the absence.
 * It is a turn-based action the engine performs, and the question it asks reads
 * the HAND alone — the same hand in both arms while the identical-game claim
 * still holds, because that claim is precisely "the swapped card was never
 * drawn". The moment it IS drawn the runner has already withdrawn the claim, so
 * a discard decision cannot make the two arms diverge behind its back. (It does
 * change what the arms play, in both of them equally — see DESIGN §3.4a.)
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
  /*
   * `mayEffects` is the "you may" wrapper, and it is classified CONSERVATIVELY
   * for exactly the reason `ifKicked` is: its nested clause lives in an
   * `effects` param the decklist scan cannot see, so a "you may search your
   * library…" would otherwise hide a library reader from the identical-game
   * argument. Treating the wrapper as library-reading withdraws the skip for
   * any game that resolves an optional clause — sound whatever it contains.
   */
  'mayEffects',
  // The cost-gated "you may <cost>. If you do, <payoff>" wrapper — its payoff
  // param can hide a library search, same argument as `mayEffects`.
  'mayCostEffects',
  /*
   * `substituteIf` is the "…instead" branch wrapper (Scute Swarm), classified
   * conservatively for the same reason as `ifKicked` and `mayEffects`: both its
   * branches live in params (`effects` / `otherwise`) the decklist scan cannot
   * see, so either branch could hide a library reader.
   */
  'substituteIf',
  /*
   * `createPredefinedToken` mints a Clue, whose crack ability draws a card at
   * runtime — a library read the decklist scan cannot see (the draw lives on
   * the TOKEN's definition, not on any deck card). Same conservative call as
   * the wrappers: any game that makes one withdraws the identical-game skip.
   */
  'createPredefinedToken',
  // Reads the top of a library and rearranges it.
  'reorderTopOfLibrary',
  /*
   * `moveTargetFromGraveyard` can WRITE the library ('libraryTop'): the moved
   * card changes every draw after it, so a game that resolves one is no longer
   * comparable to its pair. Classified with the readers because the effect on
   * the identical-game argument is the same, whichever direction the deck
   * changes.
   */
  'moveTargetFromGraveyard',
  /*
   * Reads the whole library to choose a card — and now also ROUTES what it
   * finds to more than one destination (Cultivate's "one onto the battlefield
   * and the other into your hand"). The routing rides a `route` param on the
   * same primitive id, so this one classification still covers every printed
   * shape of the search; there is nothing new for the decklist scan to miss.
   *
   * ⚠️ A MANDATORY ADDITIONAL CAST COST (`CardDefinition.additionalCost`, the
   * "As an additional cost … sacrifice a creature" family) deliberately has NO
   * entry here and needs none: it is COST DATA, not an effect ref, it carries no
   * nested effects for `allEffectRefs` to walk, and the zones it reads — the
   * battlefield and its controller's own hand — are ones the runner already
   * tracks precisely (every card that reached either emitted a `drawCard` or a
   * `zoneChange` naming its instance id). If a future additional cost ever reads
   * a LIBRARY, it must withdraw the skip, and the place to do that is here.
   */
  'searchLibrary',
  // Reads the top card and BRANCHES on what it is — the filter miss is the
  // dangerous case: it looked, learned, and moved nothing.
  'revealTopCard',
  // Writes a card into the library, moving the slot we reason about.
  'putFromHandOnTop',
  /*
   * Teferi's Puzzle Box: writes the WHOLE HAND into the library (at the bottom)
   * and then draws that many cards. Classified with `putFromHandOnTop` and for
   * the same reason — it moves cards into the library, so the slot the runner
   * reasons about is no longer the slot it started from. The bottoming ORDER is
   * chosen by a pilot looking at a hand the swap may have changed, which is the
   * second, independent reason: the two arms can pick different orders from the
   * same visible moves.
   */
  'handToBottomThenDraw',
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
  /*
   * `chooseAsEnters` NAMES A VALUE as a permanent enters (a colour, a creature
   * type, a player). It moves no card and reveals no card — but the MENU it
   * offers for a creature type is built from every card its chooser owns,
   * LIBRARY INCLUDED, so the swapped card can change which types are on offer
   * and therefore which one gets named, in a game where that card is never
   * drawn. That is precisely the divergence the identical-game claim asserts
   * cannot happen, so the claim is withdrawn for any game that resolves one.
   *
   * Classified here rather than argued away, for the same reason `mayEffects`
   * is: a wrong verdict is far more expensive than a few extra variant games,
   * and this primitive appears on a handful of cards.
   */
  'chooseAsEnters',
  /*
   * §3.110 — EXPLORE (CR 701.44a) reads the TOP CARD of a library and branches
   * on it twice: a land goes to hand, a nonland puts a counter on and asks
   * whether to bin it. Both halves see a card the swap may have changed, so it
   * is classified with scry and surveil rather than argued away.
   */
  'explore',
  // --- the spell-count family (DESIGN §3.113) ----------------------------------
  /*
   * CASCADE reads cards off the top of the library one at a time and STOPS on
   * what it finds (CR 702.85a) — the deepest library read in the pool: a
   * swapped card can change how many cards come off, which one is offered, and
   * the random order the rest go to the bottom in. Every half of that breaks
   * the identical-game argument, so a game that resolves one withdraws the skip.
   */
  'cascade',
  // RIPPLE (CR 702.60a) is the same shape with a fixed depth: it reveals the top
  // N, branches on the NAMES it saw, and writes the rest to the bottom.
  'ripple',
  /*
   * STORM copies its own spell for each spell cast before it this turn (CR
   * 702.40a). It reads no library — but the count it copies by is a fact about
   * what the arms have CAST, and each copy re-aims through a question a pilot
   * answers. Classified conservatively for the reason `mayEffects` is: a spell
   * the swap changed, cast earlier in the turn, changes how many copies the two
   * arms make, and a wrong verdict costs far more than a few variant games.
   */
  'stormCopies',
  /*
   * `millThenReturn` reads the top N cards and offers a CHOICE among them (a
   * pilot looking at cards the swap may have changed), and `returnMilledCard`
   * is that choice — classified beside it because it is the half that looks.
   */
  'millThenReturn',
  'returnMilledCard',
  // Reads the top card and branches on what it is — the same shape as
  // `revealTopCard`, with the same dangerous miss (it looked and moved nothing).
  'revealTopDrawIf',
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
 * Definition fields that let a permanent run abilities **that are not on its own
 * decklist row** — and so break the runner's map from an instance id back to the
 * card it was minted from.
 *
 * `peekCouldReadHeroLibrary` answers "could this source have read the hero's
 * library?" by looking the source's instance id up in the pre-shuffle decklist
 * and scanning THAT card's effect refs. A COPY effect (CR 707) makes that scan
 * read the wrong card: a Clone whose `def` is now somebody's Temple has an ETB
 * scry that its own decklist row does not print, so the scan would answer "no
 * library read" for an ability that just read one. The verdict would be wrong,
 * and confidently so.
 *
 * The runner therefore withdraws the identical-game skip entirely for any game
 * whose decks contain such a card. Coarse on purpose: this is the same
 * conservative call `ifKicked` and `mayEffects` get, for the same reason — an
 * effect the scan cannot SEE must never default into the safe-looking bucket.
 * It costs a few extra variant games in decks that actually play a Clone.
 *
 * A list rather than a boolean so the next field of this shape (a "becomes a
 * copy" activated ability, a text-changing effect) is added here instead of
 * being discovered by a wrong number.
 */
export const ABILITY_ACQUIRING_DEFINITION_FIELDS: readonly (keyof CardDefinition)[] = Object.freeze([
  'copyAsEnters',
]);

/*
 * ✅ ASKED AND ANSWERED for §3.30's two new copy systems, because the obvious
 * reading is that they belong here and they do NOT.
 *
 * A copy of a SPELL and a TOKEN COPY both run abilities that are not on the
 * copying card's decklist row — so far, identical to a Clone. The difference is
 * WHICH OBJECT runs them. A Clone runs them as ITSELF: same instance id, still
 * indexable in the pre-shuffle library, so `sourceCardFor` places it, reads the
 * WRONG card's effect refs, and answers confidently wrong. That is the failure
 * this list exists for, and it can only be fixed by withdrawing the skip.
 *
 * A copy and a token are NEW OBJECTS with minted ids, outside both decklist
 * ranges, so `sourceCardFor` returns undefined and the runner already takes its
 * conservative branch. Adding the primitives here would disqualify every game
 * containing a Reverberate whether or not one was ever cast — strictly more
 * conservative, and buying no soundness at all.
 *
 * The rule to apply to the NEXT copy system: it belongs here when the copy is
 * applied to an object that KEEPS its instance id, and does not when the copy is
 * a newly created object. "Becomes a copy" applied by an activated ability
 * (Mirage Mirror, Thespian's Stage) is the first kind and will need a field here
 * the day it lands.
 */

/** Whether a card can end up running abilities its decklist row does not print. */
export function acquiresForeignAbilities(def: CardDefinition): boolean {
  return ABILITY_ACQUIRING_DEFINITION_FIELDS.some((field) => def[field] !== undefined);
}

/**
 * Primitives that provably cannot read a library, and so leave the identical-game
 * argument intact. Listed explicitly (rather than "everything not above") so the
 * classification test can prove the two sets together cover the whole registry.
 */
export const LIBRARY_SAFE_PRIMITIVES: ReadonlySet<string> = new Set([
  // Bounces a CHOSEN battlefield permanent to its owner's hand — reads the
  // battlefield and a hand, never a library.
  'returnChosenToHand',
  /*
   * THE DELAYED-ABILITY BODIES (CR 603.7) — both SAFE, and the argument is
   * simpler than the copy family's above: each moves permanents named by an
   * EXPLICIT list of instance ids that a primitive baked in at the moment it
   * created those objects. They read no library, ask no question and branch on
   * nothing hidden; a permanent that has already gone is skipped. The ids are
   * minted token ids, so the same "an id I cannot place" branch that already
   * covers a token copy covers anything downstream of these.
   */
  'sacrificeNamed',
  // Flip a seat's win/loss flag through core's one verb — no zone read at all.
  'winTheGame',
  'loseTheGame',
  'exileNamed',
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
  // --- the spell-count family (DESIGN §3.113) ----------------------------------
  /*
   * `learn` (CR 701.48a) is SAFE on the same argument the file header makes for
   * the cleanup discard: its question reads the HAND alone, the discard emits a
   * `zoneChange` naming the card, and the draw announces its id. The printed
   * sideboard half — the one thing that would read outside the game — does not
   * exist in this engine, so there is nothing here that could look at a library.
   */
  'learn',
  // Doubling power (CR 701.10b) reads the battlefield and writes a continuous
  // modification; no zone with hidden cards is involved.
  'doublePower',
  // Battlefield-only: reads and writes creatures, never a library.
  'fight',
  // Changing who controls a permanent touches the battlefield and the continuous
  // layer only — no library is read, so paired arms stay comparable.
  'gainControl',
  // Attaching an Aura/Equipment reads only the battlefield permanent it targets.
  'attachToTarget',
  'dealDamageToEach',
  /*
   * `preventDamage` registers a floating prevention effect (a fog) and touches
   * nothing else — no library is read, and the effect it creates is consulted
   * only by the damage layer, which reads the battlefield and a life total.
   * Paired arms stay comparable for exactly the reason `dealDamage` does.
   */
  'preventDamage',
  'addCounters',
  // Reads and writes battlefield counter records only — no library, no hand.
  'proliferate',
  'gainLife',
  'loseLife',
  'pumpUntilEndOfTurn',
  'grantKeywordUntilEndOfTurn',
  // The mass form reads the BATTLEFIELD (which permanents a player controls now)
  // and writes continuous effects onto them. No library is consulted, so paired
  // arms stay comparable for exactly the reason the single-target form does.
  'grantKeywordToYoursUntilEndOfTurn',
  'makeToken',
  // §3.121 — living weapon creates its Germ and attaches the source to it. Both
  // halves read the BATTLEFIELD only; no library is consulted, so paired arms
  // stay comparable for the same reason `makeToken` does.
  'livingWeaponGerm',
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
  // NOTE: there is no `modal` primitive to classify. Modal spells are announced
  // at CAST time (core's `ModalSpec`) and their chosen modes resolve as the
  // ordinary primitives listed here, each classified on its own terms — which is
  // strictly better for this table than one opaque wrapper would have been.
  'returnToHand',
  'tapPermanents',
  // Sacrifices read and write the BATTLEFIELD only: the victim's (or the pile
  // split's) choice is over permanents in play, and every card moved emits its
  // zoneChange. No library is ever consulted, so paired arms stay comparable.
  /*
   * The Pact bill and its scheduler read a MANA POOL and a life total and write
   * a delayed ability whose body is already classified — no library, no hand.
   * The consequence refs are classified on their own terms wherever they land.
   */
  'payManaOrElse',
  'scheduleDelayedPayment',
  /*
   * §3.106 — the upkeep-cost family. A sacrifice of the source, a life bill,
   * an age-scaled mana/life bill, a counter ticking down to a sacrifice, and
   * suspend's exile-side tick all read a pool, a life total and the counters on
   * one object, and move a card battlefield → graveyard or open a cast window;
   * none touches a library or a hand. `scheduleDelayedEffects` is the Pact
   * scheduler generalised: its body ("draw a card at the next upkeep") is
   * classified on its own terms when the delayed ability fires.
   */
  /*
   * §3.110 — the counter keyword family. Every body here reads and writes the
   * BATTLEFIELD and nothing else: counters placed through the one CR 614 site
   * (undying's return, modular's last-known move, renown's designation,
   * bloodthirst's turn-fact read, riot's and unleash's entry choice, devour's
   * sacrifice, amass's Army, bolster's toughness comparison, backup's aimed
   * counters and grant) and tokens built from their own params (fabricate's
   * Servos, chosen at resolution). `undyingReturn` moves ONE known card graveyard → battlefield and
   * announces its zoneChange, exactly as `persistReturn` does. Explore is the
   * one member that reads a library, and it is classified above.
   */
  'undyingReturn',
  'modularMove',
  'becomeRenowned',
  'bloodthirstCounters',
  'riotChoice',
  'unleashChoice',
  'devourChoice',
  'fabricateChoice',
  'amass',
  'bolster',
  'backup',
  'sacrificeSelf',
  'payLifeOrElse',
  'cumulativeUpkeep',
  'tickDownCounter',
  'suspendTick',
  'scheduleDelayedEffects',
  /*
   * §3.112 — the cast-alternative family's riders. Each reads ONE object's
   * `castWith` stamp and moves that permanent battlefield → graveyard / hand /
   * exile; `warpExile` also records a cast permission on the card it exiled.
   * No library and no hand is read, and every move emits its own zoneChange.
   */
  'sacrificeSelfIfCastWith',
  'returnSelfToHand',
  'warpExile',
  /*
   * §3.111 — THE GRAVEYARD-CASTING FAMILY's bodies. Every one of them reads and
   * writes the GRAVEYARD, exile and the battlefield and never a library:
   * `unearthReturn` moves its own card graveyard -> battlefield (and stamps CR
   * 702.84c's exile replacement on it), `scavengeCounters` puts counters on a
   * battlefield creature, `graveyardTokenCopy` creates token copies of the card
   * in exile, and `returnSourceFromGraveyard` moves its own card graveyard ->
   * hand. A card moved INTO a hand is a card the table already watched leave a
   * public zone, which is the same shape as a regrown creature and is why this
   * is library-SAFE rather than library-reading.
   */
  'unearthReturn',
  'scavengeCounters',
  'graveyardTokenCopy',
  'returnSourceFromGraveyard',
  /*
   * `exileGraveyard` moves every card out of one or both graveyards. It reads
   * and writes GRAVEYARDS only — never a library — and every card it moves
   * emits its own zoneChange, so the runner keeps tracking them precisely.
   */
  'exileGraveyard',
  // Raises a shield ON a battlefield permanent. No zone is read at all.
  'regenerate',
  'sacrificeChosen',
  'pileSplitSacrifice',
  /*
   * `createEmblem` puts a new object in the COMMAND zone built from data carried
   * in its own params — a name plus static/trigger ABILITY records. It never
   * reads a library, and unlike `ifKicked` it cannot come to hide one: its params
   * hold ability descriptions (a static's filter, a trigger's condition), not
   * nested effect refs the decklist scan would be blind to. The abilities those
   * records describe run through the ordinary primitive path when they fire, and
   * are classified there on their own account.
   */
  'createEmblem',
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
  /*
   * THE COPY FAMILY (CR 707) — all three SAFE, and the argument is the same one
   * `createToken` and `makeToken` already make, so it is worth stating rather
   * than assuming.
   *
   * The worry is real: `copySpell` can copy a PONDER, and `createTokenCopy` can
   * copy a permanent whose enters-the-battlefield trigger scries. Neither of
   * those reads is on the copying card's decklist row, so the scan
   * `peekCouldReadHeroLibrary` performs would answer "no library read" for an
   * effect that just read one — exactly the unsoundness
   * `ABILITY_ACQUIRING_DEFINITION_FIELDS` exists to prevent.
   *
   * What makes it sound is that the created object gets a MINTED instance id.
   * Ids are handed out hero-library-first, opponent-library-next, and a copy or
   * a token is numbered past both ranges — so `sourceCardFor` cannot place it,
   * and the runner's conservative "an id I cannot place" branch disqualifies the
   * game. The read is therefore SEEN, through the copy's own id, rather than
   * missed through the copier's. `paired-arms.test.ts` pins the id being new,
   * because that invariant is what this classification rests on.
   *
   * Note what this is NOT: it is not the same case as `copyAsEnters`, which IS
   * listed in `ABILITY_ACQUIRING_DEFINITION_FIELDS`. A Clone keeps its OWN
   * decklist instance id while running somebody else's abilities, so the scan
   * places it and reads the wrong card. A copy or a token has no decklist id at
   * all. Two different failures, and only the first needs the coarse withdrawal.
   */
  'copySpell',
  'createTokenCopy',
  /*
   * Returning a spell to its owner's hand moves ONE known card out of a public
   * zone; it reads no library and branches on nothing hidden. Same shape as
   * `returnToHand` above.
   */
  'returnSpellToHand',
  /*
   * BLINK (CR 400.7) — SAFE, and for a reason worth writing down because the
   * first instinct is the wrong one.
   *
   * The worry: blinking a permanent re-fires its enters-the-battlefield trigger,
   * and that trigger can absolutely read a library (blink a Wood Elves and it
   * searches for a Forest). So does the blink "acquire" an ability whose read is
   * invisible to the scan?
   *
   * No — and the difference from `copyAsEnters` is the whole argument. A blink
   * creates no new object identity: the permanent that returns is the SAME CARD,
   * carrying the SAME decklist instance id it has had since the opening shuffle.
   * `sourceCardFor` therefore places it exactly as it always did, and the ETB
   * read is attributed to the card that actually made it — Wood Elves' own row —
   * rather than to the Cloudshift that blinked it. The scan sees the read
   * through the right card, which is precisely what soundness requires here.
   *
   * The blinking CARD itself (Cloudshift, Conjurer's Closet) reads nothing: it
   * moves one known permanent out of a public zone and back into it.
   */
  'blinkTarget',
  'blinkSelf',
  /*
   * EXILE UNTIL THIS LEAVES (the O-Ring pair) — SAFE, same argument as blink and
   * for the same reason: neither half creates a new object identity. A card
   * exiled this way keeps the decklist instance id it has carried since the
   * opening shuffle, and so does the one that comes back, so `sourceCardFor`
   * places both exactly as it always did.
   *
   * Neither primitive reads a library. `exileUntilLeaves` moves a known permanent
   * from a public zone to a public zone and stamps a link on it;
   * `returnExiledByThis` walks the two exiles for that link and moves them back.
   * An exiled card's own enters-trigger may of course read a library when it
   * returns (a Wood Elves given back by a dying Fiend Hunter searches), and that
   * read is attributed to Wood Elves' own row — which is correct, and is exactly
   * the distinction from `copyAsEnters`.
   */
  'exileUntilLeaves',
  'returnExiledByThis',
  /*
   * COPYING A TRIGGERED ABILITY — SAFE. The copy is a stack object, never a
   * card: nothing is drawn, searched or revealed by the copy machinery itself,
   * and no decklist instance changes identity. The copied ability may of course
   * read a library when it RESOLVES (a copied "search your library" trigger
   * searches twice), and that read is attributed to the card that printed the
   * trigger — which is correct, and the same split `exileUntilLeaves` documents.
   */
  'copyTriggeredAbility',
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
