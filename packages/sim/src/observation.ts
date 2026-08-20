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
 * Neither of those is the whole guarantee: `observation.test.ts` plays real games
 * and scans every delivered observation with `@jonny-boi/protocol`'s
 * `collectInstanceIds` against the cards actually sitting in hands and libraries.
 * The types stop the classes of mistake a type can stop; the scan is what proves
 * it on the game the engine really played.
 */

import type { GameEvent, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { PLAYER_IDS } from '@jonny-boi/core';
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
  stackResolved: 'public',
  // Mana in a pool is open information in paper Magic, and it is the raw material
  // for the brief's §35–37 "represented mana" reasoning.
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
  effectApplied: 'public',
  effectUnsupported: 'public',
  attackersDeclared: 'public',
  blockersDeclared: 'public',
  damageDealt: 'public',
  // Prevented damage is as face-up as dealt damage: the swing, the shield and
  // the amount all happen on the table.
  damagePrevented: 'public',
  lifeChanged: 'public',
  gainLife: 'public',
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
  triggerPutOnStack: 'public',
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
  permanentAttached: 'public',
  permanentUnattached: 'public',
  attachmentFailed: 'public',
  attachmentPutIntoGraveyard: 'public',
  tokenCreated: 'public',
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
