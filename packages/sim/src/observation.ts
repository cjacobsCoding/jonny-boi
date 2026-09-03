/**
 * **The observation chokepoint** — the one place a `GameEvent` becomes something
 * a pilot is allowed to see (`docs/plans/superhuman-ai-program.md` §13–17).
 *
 * It lives in the harness, not in `@jonny-boi/ai`, for the same reason
 * `maskStateForSeat` lives in `@jonny-boi/protocol` and not in the client: the
 * side that HOLDS the secret is the side that must redact it. A pilot is the
 * untrusted consumer here, exactly as an online client is.
 *
 * ## The rule, in one sentence
 * An observation carries only what a spectator holding no cards would know, so
 * there is no seat whose entitlement could be computed wrongly — and the feed is
 * therefore computed once per event rather than once per seat.
 *
 * ## Default-deny, enforced by the compiler in two independent ways
 *  1. {@link OBSERVATION_POLICY} is a **mapped type over `GameEvent['type']`**, so
 *     a new core event type makes this file fail to compile until somebody
 *     classifies it. (The same shape as `paired-arms-config.ts`'s primitive
 *     classification, and for the same reason: a new thing must not default into
 *     the safe-looking bucket.)
 *  2. The literal `'public'` is only *permitted* for an event type whose core
 *     shape is assignable to `Observation`. Every redacted shape in
 *     `@jonny-boi/ai`'s `observation.ts` declares its dropped fields as
 *     `?: never`, so `drawCard`, `gameStart`, `zoneChange` and the three choice
 *     events cannot be waved through as printed even by a determined typo — the
 *     `'public'` branch of their policy type evaluates to `never`.
 *
 * Neither of those is the whole guarantee: {@link createObservationLeakScanner}
 * plays real games and checks every delivered observation against the cards
 * actually sitting in hands and libraries. The types stop the classes of mistake
 * a type can stop; the scan is what proves it on the game the engine really
 * played.
 *
 * ## ⚠️ WHAT THE GUARANTEE ACTUALLY PROMISES — read this before changing a policy
 *
 * The tempting one-liner is "no observation ever names a card that is in a hidden
 * zone". **That is not true, it has never been true, and stating it would be a
 * worse failure than the leak it is trying to describe** — because it is
 * unfalsifiable-looking and quietly wrong, so the next reader trusts it.
 *
 * The promise is:
 *
 * > **An observation names a card only if that card is on PUBLIC DISPLAY at the
 * > instant the observation is produced.**
 *
 * Equivalently, and this is the form the scan checks: *the feed never reveals the
 * identity of a card the table has not seen.* It may say that a card everybody
 * watched is now somewhere hidden; it may never say what an unseen card is.
 *
 * Three consequences that look like leaks and are not:
 *
 *  - **A buyback spell resolves back into its owner's hand** (Capsize, Elvish
 *    Fury). `stackResolved` fires while the object is still ON THE STACK — a
 *    public zone (CR 405.1), which the whole table watched it reach when it was
 *    cast (CR 601.2a) — and the move to hand is a *separate* `zoneChange`, which
 *    the policy above anonymises because its destination is hidden. So the id in
 *    `stackResolved` was public when it was published, and a spectator at a paper
 *    table knows exactly which card went back to that hand. Dropping it would
 *    leave a pilot knowing LESS than a spectator, which is the opposite failure:
 *    it corrupts the "what did they just cast, what mana is represented" reasoning
 *    the whole feed exists to support (`superhuman-ai-program.md` §35–37).
 *  - **A card the table watched leave a public zone.** A creature dies (public,
 *    named), then Gravedigger returns it to a hand. It is in a hidden zone now,
 *    but its identity was public before, and the move that hid it was itself
 *    anonymised.
 *  - **A bought-back spell named by a LATER public event.** Elvish Fury resolves
 *    back into its owner's hand, and at cleanup the pump it left behind expires
 *    as `continuousEffectExpired{ sourceInstanceId: <the Elvish Fury> }`. That
 *    fires many actions later, with the card genuinely sitting in a hand — and it
 *    still tells a pilot nothing, because the whole table watched that card be
 *    cast. (This one is live: it is what the widened scan found first.)
 *
 * So the scan does not ask "is this card hidden right now", nor even "was it
 * hidden before the window as well as after" — that second rule is a one-window
 * approximation, and the Elvish Fury above walks straight through it. It tracks
 * the ids that have **never once been on public display** and reports only those.
 * An id leaves that set the first time it is seen anywhere but a hand or a
 * library.
 *
 * There is deliberately **no exemption list** — no "…except `stackResolved`,
 * which is allowed to name a bought-back spell". One was written, and measuring
 * it showed it never fired: a spell is on the STACK, which is not a hidden zone,
 * for at least one whole decision between being cast and resolving, so the rule
 * above has already recorded it as seen by the time anything names it in a hand.
 * An exemption that never fires is worse than none — it reads like the thing
 * keeping the scan honest while asserting nothing.
 *
 * That is more permissive than "hidden before and after", and the difference is
 * exactly the cards the table has already seen. It is not more permissive about
 * the thing that matters: an id that has only ever sat in a hand or a library —
 * every card whose identity would read the opponent's decklist — is still
 * reported the instant anything names it. The CR 514.1 cleanup-discard leak that
 * started all this is caught by this rule unchanged, and there is a test that
 * reintroduces it and watches this scan fail.
 *
 * ## And "which cards does this name?" is not a key-name guess
 * The scan asks core's {@link instanceIdsNamedBy}, which is driven by a mapped
 * type over every field of every `GameEvent` (`packages/core/src/instance-ids.ts`).
 * It used to collect keys named exactly `instanceId`, which is how a
 * `choiceAsked.sourceInstanceId` aimed at a card in a player's HAND travelled to
 * every pilot with this file's tests green.
 */

import type { GameEvent, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { instanceIdsNamedBy, PLAYER_IDS } from '@jonny-boi/core';
import type { GameObserver, Observation } from '@jonny-boi/ai';
import { isPublicZone } from '@jonny-boi/ai';

/**
 * What to do with one event type.
 *
 * `'public'` — deliver the event object ITSELF, by reference. No allocation: the
 * common case (a spell cast, damage dealt, a step beginning) is already exactly
 * what a spectator sees.
 * A function — deliver a freshly built, narrower value. Allocates, and is
 * therefore reserved for the six event types that genuinely carry a secret.
 * `'private'` — deliver nothing at all.
 */
export type ObservationPolicy<K extends GameEvent['type']> =
  | (Extract<GameEvent, { readonly type: K }> extends Observation ? 'public' : never)
  | 'private'
  | ((event: Extract<GameEvent, { readonly type: K }>) => Observation);

/**
 * COMPILE-TIME PROOF that the six redacted event types cannot be declared
 * `'public'`, checked by `tsc` on every build.
 *
 * This lives in the shipped source rather than in `observation.test.ts` on
 * purpose: `packages/sim/tsconfig.json` EXCLUDES `*.test.ts`, and Vitest strips
 * types without checking them, so a `@ts-expect-error` written in a test file is
 * never evaluated by anything. An assertion nothing runs is worse than no
 * assertion, because it reads like one.
 *
 * Each entry is `true` only while `'public'` is unspellable for that event type —
 * i.e. only while its redacted shape in `@jonny-boi/ai` still declares its secret
 * field as `?: never`. Delete one of those `?: never`s and this array stops
 * type-checking.
 */
type UnspellablePublic<K extends GameEvent['type']> = 'public' extends ObservationPolicy<K> ? never : true;

export type RedactionIsUnspellable = readonly [
  UnspellablePublic<'gameStart'>,
  UnspellablePublic<'drawCard'>,
  UnspellablePublic<'zoneChange'>,
  UnspellablePublic<'choiceAsked'>,
  UnspellablePublic<'choiceAnswered'>,
  UnspellablePublic<'choiceAutoAnswered'>,
];

/** The witness. If any redaction weakens, this initialiser fails to compile. */
export const REDACTION_IS_UNSPELLABLE: RedactionIsUnspellable = [true, true, true, true, true, true];

/**
 * Every event type the engine can emit, classified. Adding an event to
 * `packages/core/src/events.ts` breaks this table until it is classified — which
 * is the point.
 */
export const OBSERVATION_POLICY: { readonly [K in GameEvent['type']]: ObservationPolicy<K> } = {
  // --- Redacted: these carry something no spectator may know. ----------------
  /*
   * THE SEED IS THE WHOLE GAME. `gameStart.seed` is what both libraries were
   * shuffled from, so handing it to a pilot is handing it perfect information
   * through a field that reads like bookkeeping. It is the least obvious leak in
   * the union and the worst one.
   */
  gameStart: (e) => ({ type: 'gameStart', startingPlayer: e.startingPlayer }),
  // A drawn card is in a hand. Public: that a draw happened. Not public: which card.
  drawCard: (e) => ({ type: 'drawCard', player: e.player }),
  /*
   * The only payload-conditional event. A card that came to rest somewhere public
   * was watched by the table and keeps its id (by reference — no allocation); a
   * card that vanished into a hand or a library moves anonymously.
   */
  zoneChange: (e) => (isPublicZone(e.to) ? (e as Observation) : { type: 'zoneChange', from: e.from, to: e.to }),
  /*
   * An effect writes its own prompt text and is free to name the cards it is
   * asking about in it, so the prompt is payload rather than chrome —
   * `@jonny-boi/protocol`'s `RedactedPendingChoice` drops it for the same reason,
   * and the two redactions agreeing is deliberate.
   */
  choiceAsked: (e) => ({
    type: 'choiceAsked',
    choiceId: e.choiceId,
    chooser: e.chooser,
    choiceKind: e.choiceKind,
    sourceInstanceId: e.sourceInstanceId,
    optionCount: e.optionCount,
  }),
  // The answer names cards ("put THIS one in your hand"); `summary` is that answer
  // written out. The board consequences of an answer arrive as public events.
  choiceAnswered: (e) => ({
    type: 'choiceAnswered',
    choiceId: e.choiceId,
    chooser: e.chooser,
    choiceKind: e.choiceKind,
  }),
  choiceAutoAnswered: (e) => ({
    type: 'choiceAutoAnswered',
    choiceId: e.choiceId,
    chooser: e.chooser,
    choiceKind: e.choiceKind,
    // Engine-authored ("only one legal answer"), never card-authored — see
    // `createChoiceChannel` in core. Safe to carry; the ANSWER is not.
    reason: e.reason,
  }),

  // --- Public as printed: a spectator sees all of this happen. ---------------
  turnBegin: 'public',
  stepBegin: 'public',
  priorityPassed: 'public',
  untapped: 'public',
  tapped: 'public',
  landPlayed: 'public',
  spellCast: 'public',
  // Transforming happens on the battlefield in front of everyone (CR 712.8);
  // both face names are public the moment the permanent flips.
  transformed: 'public',
  // A copy is chosen and applied ON THE TABLE (CR 707): which permanent became
  // a copy, the card it printed as, the card it now is, and the visible object
  // it was copied from are all things a spectator sees. Copying from a
  // GRAVEYARD (Echoing Deeps) is public for the same reason — a graveyard is a
  // public zone, so no variant of this event carries a secret.
  becameCopy: 'public',
  /*
   * THE THREE COPY-CREATION EVENTS ARE PUBLIC, and none of them is a judgement
   * call: every object each one names is on the stack or on the battlefield.
   *
   * `spellCopied` names a copy created ON THE STACK from a spell that is also on
   * the stack — both were announced out loud when they got there, and both names
   * have been public since. `spellCopyCeasedToExist` says the copy left, which
   * the whole table watches; withholding it would leave a pilot believing a
   * spell is still waiting to resolve. `tokenCopyCreated` names two battlefield
   * objects.
   *
   * The question to ask when classifying an event of this family is whether the
   * OBJECT it names could be a hidden card. A copy is created from a spell on
   * the stack, never from a card in a hand or a library, so it cannot be. A
   * future "copy target card in a graveyard" would still be public (a graveyard
   * is a public zone); a hypothetical "copy a card in your hand" would NOT be,
   * and would need a redacting function here rather than this literal.
   */
  spellCopied: 'public',
  // A copy on the stack is as public as the ability it copied — both players
  // watch it go on, and both must be able to respond to it.
  triggerCopied: 'public',
  spellCopyCeasedToExist: 'public',
  tokenCopyCreated: 'public',
  /*
   * THE TWO DELAYED-ABILITY EVENTS (CR 603.7) ARE PUBLIC, by the same test the
   * copy family above sets out: ask what OBJECT the event names. Both name the
   * `sourceInstanceId` of whatever created the ability, which is always a
   * permanent on the battlefield or a spell resolving off the stack — never a
   * card in a hand or a library. (`id` is the ability's own and names no card at
   * all, which is why `instance-ids.ts` classifies it `'none'`.)
   *
   * Withholding them would be a REAL loss of public information rather than a
   * conservative default: the delayed sacrifice IS the drawback of the hasty
   * token now standing on the battlefield, and an opponent who could not see it
   * would be looking at what appears to be a permanent creature and blocking
   * accordingly.
   */
  delayedTriggerCreated: 'public',
  delayedTriggerFired: 'public',
  stackResolved: 'public',
  // Mana in a pool is open information in paper Magic, and it is the raw material
  // for the brief's §35–37 "represented mana" reasoning.
  //
  // ⚠️ DELIBERATE: this now also carries `spendRestriction` — the printed wording
  // on restricted mana ("only to cast a creature spell"). It travels PUBLIC, and
  // that is the correct classification rather than a convenient one: the
  // restriction is printed on a permanent every seat can read, and the whole table
  // watched that permanent be tapped. There is no seat entitlement to compute, so
  // it satisfies this file's one rule — "only what a spectator holding no cards
  // would know". Redacting it would ALSO be a mistake in the other direction: an
  // opponent who sees three mana float off Ancient Ziggurat and cannot see the
  // restriction would read the board as three mana of represented interaction,
  // which is the exact inference §35–37 asks the pilot to make correctly.
  manaAdded: 'public',
  manaPoolEmptied: 'public',
  // Paying "unless its controller pays {3}" happens on the table, in front of
  // everyone: the cost is printed on the card that asked and the mana leaving the
  // pool is visible. Nothing here is anybody's hidden information.
  manaCostPaid: 'public',
  controlChanged: 'public',
  // How MANY cards were milled. The cards themselves arrive as `zoneChange`s into
  // a graveyard, which is public, so nothing is lost by this being a count.
  cardsMilled: 'public',
  /*
   * A scry/surveil LOOK. Public as printed — and it is worth being precise about
   * why that is not a leak. The event carries a player and a COUNT, which is
   * exactly what a spectator sees when somebody picks up the top two cards of
   * their library; the identities are never in it. They live only in the
   * `selectCards` choice, which travels to its chooser alone and whose own
   * `choiceAsked` observation is already redacted to an option count above. The
   * consequences that ARE public arrive on their own: a surveilled card lands in
   * a graveyard and emits a `zoneChange` into a public zone, while a bottomed or
   * kept card moves library → library and is anonymised by the same rule.
   */
  cardsLookedAt: 'public',
  abilityActivated: 'public',
  /*
   * CYCLING is public as printed, and the name it carries is not a leak: the
   * card is discarded face-up as part of the cost, so it is in a public zone —
   * and already named by the `zoneChange` into the graveyard — before anyone
   * sees the ability resolve. What was DRAWN off it stays hidden, because that
   * arrives as an ordinary `drawCard`, redacted by the rule above.
   */
  cardCycled: 'public',
  /*
   * Both halves of madness are equally face-up. A discarded madness card is
   * exiled in front of the table (exile is a public zone, and the move emits its
   * own public `zoneChange`), and declining is a decision made out loud — the
   * card visibly goes to the graveyard. Neither event carries anything the
   * discarding player still knows privately.
   */
  madnessWindowOpened: 'public',
  madnessDeclined: 'public',
  // §3.106 — suspend is played face-up: the card is exiled in front of the
  // table (its own public `zoneChange`), the counters are on it for everyone to
  // count, and the free cast or the decline is a decision made out loud.
  cardSuspended: 'public',
  suspendWindowOpened: 'public',
  suspendDeclined: 'public',
  // §3.112 — foretell/plot: the special action is taken in front of the table
  // and names no card (a foretold card is face down); the `zoneChange` that
  // carries the id is judged by its own row above.
  cardExiledToCastLater: 'public',
  // §3.113 — cascade exiles face-up and ripple reveals: every card in a pile is
  // shown to the table before the window opens (its `zoneChange` into exile is
  // public), and the bottoming names only cards the table has just seen.
  cascadeWindowOpened: 'public',
  rippleWindowOpened: 'public',
  pileBottomed: 'public',
  effectApplied: 'public',
  effectUnsupported: 'public',
  attackersDeclared: 'public',
  blockersDeclared: 'public',
  damageDealt: 'public',
  // Prevented damage is as face-up as dealt damage: the swing, the shield and
  // the amount all happen on the table.
  damagePrevented: 'public',
  // A counter that hit an uncounterable spell is as face-up as one that worked:
  // the spell, its name and its controller are already on the stack in the open.
  counterPrevented: 'public',
  lifeChanged: 'public',
  gainLife: 'public',
  // poison family (§3.105): a poison total is as face-up as a life total.
  poisonChanged: 'public',
  creatureDied: 'public',
  // A walker's loyalty and its death are face-up battlefield facts, exactly
  // like a creature dying or a counter landing.
  loyaltyChanged: 'public',
  planeswalkerDied: 'public',
  // A battle's defense and its defeat are face-up battlefield facts, exactly as
  // a walker's loyalty and death are — the counters sit on the card where the
  // whole table can count them.
  defenseChanged: 'public',
  battleDefeated: 'public',
  // The legend rule happens in the open: everyone sees which copy stayed and
  // which went to a graveyard. The CHOICE that produced it is redacted by the
  // choice events above, exactly as every other choice is.
  legendRuleApplied: 'public',
  // An emblem is created face-up in the command zone with its ability read out,
  // and nothing can ever remove it — there is no part of it anyone could hide.
  emblemCreated: 'public',
  playerLost: 'public',
  gameOver: 'public',
  // Reveals that a pilot proposed something illegal — a pilot-quality signal, not
  // game information. Kept so a belief model cannot silently mis-count plies.
  actionRejected: 'public',
  counterAdded: 'public',
  // §3.110 — a renown designation is board state; a REVEAL is, by definition,
  // the card shown to the table (explore's top card, CR 701.44a).
  becameRenowned: 'public',
  cardRevealed: 'public',
  /*
   * THE NAMED VALUE IS PUBLIC, and this one is worth being deliberate about
   * because it sits next to three redacted choice events.
   *
   * The ANSWER to a question is private to its chooser — that is why
   * `choiceAnswered` is redacted above. But "As ~ enters, choose a creature
   * type" is not a private answer: CR 614.1c makes it a value announced at the
   * table as the permanent enters, and it stays visible on the card for as long
   * as the permanent is on the battlefield (every opponent needs it to know what
   * the lord pumps and what the land taps for). A spectator sees it, so a pilot
   * may.
   *
   * What is NOT public, and is not in this event, is the option LIST the chooser
   * was offered: for a creature type that menu is derived from the chooser's own
   * cards, so its length would be a weak read on their decklist. It travels only
   * inside the choice, whose `choiceAsked` observation is already redacted to an
   * option count above.
   */
  chosenAsEnters: 'public',
  // Everyone watched the creature not die.
  regenerated: 'public',
  triggerPutOnStack: 'public',
  // Chosen modes are announced on the stack — everyone responds knowing them.
  triggerModesChosen: 'public',
  /*
   * A trigger removed from the stack because its intervening "if" lapsed. Public
   * for the same reason the push is: everyone watched the ability go on the
   * stack and everyone watched it do nothing, and its payload names only the
   * source, its controller and the printed label — all of it already on the table.
   */
  triggerFizzled: 'public',
  // Both halves of aiming a trigger happen face-up on the table: everyone sees
  // what the ability was pointed at, and everyone sees one leave the stack for
  // want of a target.
  triggerTargetsChosen: 'public',
  /*
   * A modal spell's announced modes and their aims are PUBLIC by the rules: in
   * paper the caster declares them out loud as the spell is cast, before anyone
   * decides whether to respond. Knowing which half of a Cryptic Command is
   * coming is precisely what the opponent is entitled to, so these are the
   * event objects themselves — no allocation, nothing redacted.
   */
  modesChosen: 'public',
  modeTargetChosen: 'public',
  triggerRemovedFromStack: 'public',
  triggeredAbilityResolved: 'public',
  continuousEffectAdded: 'public',
  continuousEffectExpired: 'public',
  // A grant to a card in a graveyard is as face-up as a pump on the battlefield:
  // the graveyard is a public zone, the card was already named by the zoneChange
  // that put it there, and the granting ability resolved in front of the table.
  cardGrantAdded: 'public',
  cardGrantExpired: 'public',
  /*
   * A replacement effect firing is as public as the event it replaced. Both
   * halves are already public — the counters land face up, the damage moves a
   * life total — and the card that did it is on the battlefield in front of
   * everybody. `from`/`to` say only how much of each; nothing here names a card
   * in a hand or a library, and the `label` is the printed line, which every
   * player can read off the permanent.
   */
  replacementApplied: 'public',
  replacementExpired: 'public',
  permanentAttached: 'public',
  permanentUnattached: 'public',
  attachmentFailed: 'public',
  attachmentPutIntoGraveyard: 'public',
  tokenCreated: 'public',
  // A token ceasing to exist (CR 704.5d) is as public as its creation was: both
  // seats watched it hit the graveyard, and both watch it stop existing. It
  // carries no hidden information — the name is one already announced by
  // `tokenCreated`.
  tokenCeasedToExist: 'public',
  // `reason` here is engine-authored from the choice KIND, never from card text.
  choiceAbandoned: 'public',
};

/**
 * Project one engine event onto what the table may see, or `null` if it may see
 * nothing. The single function every observation in this repo passes through.
 */
export function observationOf(event: GameEvent): Observation | null {
  /*
   * ONE cast, and it is worth being precise about what it does and does not
   * assume. `ObservationPolicy<K>` is only ever *checked* per concrete event type
   * — that is where the `'public'` literal is admitted or refused. Reading the
   * table with a union key collapses that conditional to `never`, so the lookup is
   * widened to the runtime shape here. Nothing is being asserted about safety: the
   * safety was decided at the table's declaration, one entry at a time.
   */
  const policy = OBSERVATION_POLICY[event.type] as
    | 'public'
    | 'private'
    | ((e: GameEvent) => Observation);
  if (policy === 'private') return null;
  // Sound because `'public'` is unspellable for an event type that is not itself
  // a member of `Observation` — see `ObservationPolicy`.
  if (policy === 'public') return event as Observation;
  return policy(event);
}

/**
 * Every instance id currently sitting where nobody at the table can read it —
 * both hands and both libraries.
 *
 * This is the forbidden set the anti-cheat scan tests against, and it is
 * seat-agnostic on purpose: the feed is spectator-level, so a card hidden from
 * *anyone* must not appear in it. Exported because a leak scan nobody can run is
 * not a guarantee, and because any future consumer that adds a field to the feed
 * needs the same check (`@jonny-boi/protocol`'s `collectInstanceIds` is the other
 * half — reused rather than re-implemented, so "does this mention that card?" has
 * exactly one answer in this repo).
 */
export function hiddenInstanceIds(state: GameState): Set<InstanceId> {
  const hidden = new Set<InstanceId>();
  for (const id of PLAYER_IDS) {
    const player = state.players[id as PlayerId];
    for (const card of player.hand) hidden.add(card.instanceId);
    for (const card of player.library) hidden.add(card.instanceId);
  }
  return hidden;
}

// ---------------------------------------------------------------------------
// THE LEAK SCAN. One implementation, used by `observation.test.ts` and by the
// full-pool soak — because two copies of an anti-cheat check is two checks that
// can disagree, and the weaker one is the one that will be believed.
// ---------------------------------------------------------------------------

/** Field names an observation must never carry, whatever the event, at any depth. */
export const FORBIDDEN_OBSERVATION_KEYS: readonly string[] = ['seed', 'prompt', 'answer', 'summary'];

/** Every key present anywhere in a value — the deep half of the forbidden-field check. */
function collectKeys(value: unknown, into: Set<string>, seen: Set<object>): Set<string> {
  if (value === null || typeof value !== 'object') return into;
  if (seen.has(value)) return into;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into, seen);
    return into;
  }
  for (const [key, child] of Object.entries(value)) {
    into.add(key);
    collectKeys(child, into, seen);
  }
  return into;
}

/**
 * Buffers observations and reports the ones that named a card nobody had seen.
 *
 * ⚠️ **THE TIMING IS THE WHOLE TEST, and it is easy to get backwards.**
 * "Is this card hidden?" must be asked of the state the action LANDED IN, not the
 * one it started from. A land played from hand is named by `landPlayed` and by a
 * `zoneChange` into the battlefield — both entirely public — and it was in a hand
 * a microsecond earlier, so scanning against the PRE-action state reports every
 * land drop in the game as a leak. (It did, the first time this was written.) The
 * equal and opposite mistake is scanning at the END of the game: a creature
 * bounced to hand later would retro-actively turn an honest `spellCast` into one.
 *
 * So observations are buffered as they arrive and flushed at the next decision,
 * whose view is exactly the post-action state — and an id counts as a leak only
 * if it was ALSO hidden before that window (see the guarantee at the top of this
 * file). The tail (the final action of a game, after which nobody is asked to
 * decide) is flushed against the last state seen, which is the closest truth
 * available and cannot mask a leak a later state would have revealed.
 */
export interface ObservationLeakScanner {
  /** Buffer one delivered observation. */
  observe(observation: Observation): void;
  /**
   * Check everything buffered against `state` — the state the last action landed
   * in — and start a new window. `null` means "no state available" (the tail of a
   * game), which scans against nothing hidden rather than against stale truth.
   */
  flush(state: GameState | null): void;
  /** How many observations have been scanned. A green run must have looked at something. */
  readonly scanned: number;
}

export function createObservationLeakScanner(report: (detail: string) => void): ObservationLeakScanner {
  const pending: Observation[] = [];
  /*
   * THE IDS THE TABLE HAS NEVER SEEN — the forbidden set, and the whole of the
   * guarantee's memory.
   *
   * `null` until the first flush, when it is seeded with everything sitting in a
   * hand or a library. From then on it only ever SHRINKS: an id that is not in a
   * hidden zone at some flush has been on display, and an id an emission-public
   * observation names as its subject was on the stack when it was named. Once a
   * card has been seen, naming it again reveals nothing — see the guarantee at
   * the top of this file for why that is the honest rule and "is it hidden now"
   * is not.
   */
  let neverSeen: Set<InstanceId> | null = null;
  let scanned = 0;
  return {
    get scanned() {
      return scanned;
    },
    observe(observation) {
      pending.push(observation);
    },
    flush(state) {
      const hidden = state ? hiddenInstanceIds(state) : new Set<InstanceId>();
      if (neverSeen === null) neverSeen = new Set(hidden);
      // Anything no longer hidden has been on display since the last flush —
      // including the card just cast out of the hand, which is what stops every
      // land drop and every spell in the game reading as a leak.
      else for (const id of neverSeen) if (!hidden.has(id)) neverSeen.delete(id);

      for (const observation of pending) {
        scanned++;
        const keys = collectKeys(observation, new Set<string>(), new Set<object>());
        for (const key of FORBIDDEN_OBSERVATION_KEYS) {
          if (keys.has(key)) report(`observation ${observation.type} carries a forbidden field "${key}"`);
        }
        // Driven by core's field table, so `sourceInstanceId`, `attackTargets`'
        // KEYS and an answer's `instanceIds` are as visible as `instanceId`.
        for (const id of instanceIdsNamedBy(observation)) {
          if (neverSeen.has(id)) {
            report(`observation ${observation.type} names #${id}, a card the table has never seen`);
          }
        }
      }
      pending.length = 0;
    },
  };
}

/**
 * The observers watching one game, or `null` when neither pilot asked to watch.
 *
 * `null` is not an optimisation detail — it is the guarantee that a pilot which
 * does not implement the seam runs down exactly the code path it ran down before
 * this file existed. See `match.ts`.
 */
export interface MatchObservers {
  readonly A: GameObserver | undefined;
  readonly B: GameObserver | undefined;
}

/**
 * Push one event to whichever observers exist.
 *
 * A public observation is the engine's own event object, handed to both observers
 * by reference — no copy, which is where the seam's affordability comes from. The
 * `Observation` type is read-only in every field core declares, so an observer that
 * tried to scribble on it would not compile; this is the same borrow-not-give
 * contract `PilotView` and `MatchEventObserver` already run on.
 */
export function deliverObservation(observers: MatchObservers, event: GameEvent): void {
  const observation = observationOf(event);
  if (observation === null) return;
  observers.A?.observe(observation);
  observers.B?.observe(observation);
}
