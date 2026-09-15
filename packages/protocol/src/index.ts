/**
 * `@jonny-boi/protocol` — the frozen client↔server contract for online play, plus
 * the per-seat view-masking function. PURE + isomorphic: it runs identically in the
 * Node authoritative server and the browser client, and depends only on
 * `@jonny-boi/core` *types* (no Node, no DOM, no runtime deps beyond core's PLAYER_IDS).
 *
 * Anti-cheat principle: the server is authoritative and sends each client ONLY its
 * own `MaskedGameView`. A client therefore never receives the opponent's hidden
 * information (hand contents, library order) over the wire — masking happens here,
 * server-side, before sending. `maskStateForSeat` is the single chokepoint.
 */

import { INSTANCE_ID_FIELD_NAMES, instanceIdsNamedBy, PLAYER_IDS, poisonOf } from '@jonny-boi/core';
import type {
  GameState,
  GameEvent,
  PlayerState,
  PlayerId,
  CardInstance,
  ChoiceKind,
  PendingChoice,
  StackObject,
  CombatState,
  Step,
  GameAction,
} from '@jonny-boi/core';

/**
 * Bumped on any breaking change to the message shapes below; checked at handshake.
 *
 * 2 — `MaskedGameView.pendingChoice`: the server now tells a seat what question a
 * resolving card asked it. Before this, an online client saw its legal menu
 * collapse to opaque `answerChoice` actions with no prompt, which is a dead end.
 *
 * 3 — the `state` message's `events`: the PUBLIC half of the engine's event
 * stream, beside the prose `log` it has always carried. Before this an online
 * client could not animate combat damage at all, because the only account of it
 * on the wire was five kinds of English sentence.
 */
export const PROTOCOL_VERSION = 3;

/**
 * The oldest version a current client can still hold a useful game on.
 *
 * The two halves of this app deploy at different speeds: the web app ships
 * automatically on every merge, while the game server is a bundle someone copies
 * onto a NAS by hand. So the server is routinely the stale side, and a strict
 * equality check turns that skew into a total outage — the lobby refuses to open
 * at all, for a difference that only affects some cards.
 *
 * v1 → v2 added `MaskedGameView.pendingChoice`. A v1 server simply omits the
 * field, which a v2 client already reads as "no question parked". Everything else
 * — rooms, lobby, mulligans, casting, combat, reconnect — is unchanged, so a v2
 * client can play a v1 server for any game that never asks a player to choose.
 * The client negotiates down to this floor and says so, rather than failing shut.
 *
 * v2 → v3 added the `state` message's `events`, and it is additive in exactly the
 * same way: a v2 server omits the field, a v3 client reads the absence as "this
 * server carries no event stream" and simply animates no damage — which is what
 * every client did before v3. Nothing else on the wire moved.
 */
export const MIN_COMPATIBLE_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Room codes.
//
// These live HERE, in the shared contract, because a room code is something the
// server issues and the client types back — the definition of a value both ends
// must agree on. They used to be defined twice, and the two copies drifted: the
// server generated FIVE characters while the web client only enabled its "Join
// room" button at exactly SIX. Every real code left the button greyed out, so
// joining an online game was impossible, and nothing failed loudly enough to
// notice — the button just sat there.
// ---------------------------------------------------------------------------

/**
 * Number of characters in a generated room code. The client validates against
 * this and the server generates to it; importing the same constant is what stops
 * them drifting apart again.
 */
export const ROOM_CODE_LENGTH = 5;

/**
 * Characters a generated code may contain — uppercase, with the shapes that get
 * misread out loud or on a phone screen (I, O, 0, 1) deliberately absent, since
 * these get read aloud and re-typed.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Longest code the wire accepts. Deliberately looser than
 * {@link ROOM_CODE_LENGTH} so the server can keep honouring codes it issued
 * under an older, differently-sized scheme; validation bounds the string, it
 * does not pin it to today's length.
 */
export const MAX_ROOM_CODE_LENGTH = 16;

/**
 * Normalize a typed room code for comparison: trim surrounding space and fold to
 * uppercase, matching how the server looks a room up. A phone keyboard that
 * autocapitalises differently, or a code pasted with a trailing space, then
 * still finds the room.
 */
export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Whether a typed code is worth sending to the server. Length only — the server
 * remains the authority on whether the room exists.
 */
export function isPlausibleRoomCode(code: string): boolean {
  return normalizeRoomCode(code).length === ROOM_CODE_LENGTH;
}

// ---------------------------------------------------------------------------
// Decklists carried over the wire (so the server can build ANY deck — including
// the user's custom decks — from the shared card pool, then validate it).
// ---------------------------------------------------------------------------

export interface DeckList {
  readonly name: string;
  readonly cards: ReadonlyArray<{ readonly cardId: string; readonly count: number }>;
}

// ---------------------------------------------------------------------------
// Masked game view: GameState from one seat's perspective.
// ---------------------------------------------------------------------------

/**
 * One player's state as another seat is entitled to see it. Public zones
 * (graveyard, exile) and public scalars (life, mana, etc.) are always present;
 * hidden zones are reduced to counts. `hand` carries the actual cards ONLY for the
 * viewer's own seat (null for the opponent — the opponent's cards never travel here).
 */
export interface PublicPlayerView {
  readonly id: PlayerId;
  readonly life: number;
  /**
   * Poison counters (CR 122.1f, §3.105) — a public scalar exactly as life is,
   * always present so a client never has to guess whether zero means "none" or
   * "not sent".
   */
  readonly poison: number;
  /**
   * The floating pool, INCLUDING any spend restrictions on it ("only to cast a
   * creature spell").
   *
   * Travels whole and unredacted, deliberately. Mana in a pool is open
   * information in paper Magic, and a restriction on it is printed on a permanent
   * everyone can read — there is no seat entitlement to compute. It also has to
   * travel for the client to work at all: the online seat plans its own payments
   * with core's shared planner (`auto-tap.ts`), and a planner handed a pool whose
   * restrictions were stripped would offer casts the server then rejects.
   */
  readonly manaPool: PlayerState['manaPool'];
  readonly landsPlayedThisTurn: number;
  readonly hasLost: boolean;
  /** Public zones — visible to everyone. */
  readonly graveyard: readonly CardInstance[];
  /**
   * Exile, minus the opponent's FACE-DOWN cards (§3.112 — a foretold card, CR
   * 702.143a: only its owner may look at it). The viewer's own face-down cards
   * are present; everyone else's are counted in {@link faceDownExileCount}.
   */
  readonly exile: readonly CardInstance[];
  /** How many of this player's exiled cards are face down and withheld from the viewer. */
  readonly faceDownExileCount: number;
  /** Hidden zones reduced to counts. */
  readonly handCount: number;
  readonly libraryCount: number;
  /** The viewer's own hand cards (revealed); `null` for the opponent. */
  readonly hand: readonly CardInstance[] | null;
}

// ---------------------------------------------------------------------------
// The parked question (`GameState.pendingChoice`), masked per seat.
// ---------------------------------------------------------------------------

/**
 * A pending choice as a seat that is NOT answering it is entitled to see it: who
 * was asked, by which card, and what SHAPE the question has — never its payload.
 *
 * The payload is the whole point of the redaction. A `PendingChoice`'s
 * `candidates` are a snapshot the engine deliberately hands to exactly one seat,
 * and for a card like Thoughtseize those candidates ARE the opponent's hand: the
 * card entitles the caster to see them, and nobody else. `prompt` is dropped for
 * the same reason — an effect is free to write the cards it is asking about into
 * its prompt text, so it is payload too, not chrome.
 *
 * What survives is what the board is already showing anyway: the spell that asked
 * is on the (public) stack, and whose turn it is to act is public by construction.
 */
export interface RedactedPendingChoice {
  /**
   * Discriminant. A client narrows on this rather than sniffing for a missing
   * field, so a summary can never be mistaken for a full question (or vice versa)
   * by a client that guessed the shape wrong.
   */
  readonly redacted: true;
  readonly id: number;
  readonly chooser: PlayerId;
  readonly sourceName: string;
  readonly kind: ChoiceKind;
}

/**
 * What `MaskedGameView.pendingChoice` carries: the FULL question for the seat that
 * must answer it, a {@link RedactedPendingChoice} summary for anyone else.
 */
export type MaskedPendingChoice = PendingChoice | RedactedPendingChoice;

/** Reduce a choice to the summary a non-chooser may see. */
export function redactPendingChoice(choice: PendingChoice): RedactedPendingChoice {
  return {
    redacted: true,
    id: choice.id,
    chooser: choice.chooser,
    sourceName: choice.sourceName,
    kind: choice.kind,
  };
}

/**
 * Narrow a masked choice to the summary form. The negative branch is the full
 * `PendingChoice`, which is what the choice UI needs — so a client that renders a
 * prompt has to pass this guard first, and cannot render one from a summary.
 */
export function isRedactedChoice(choice: MaskedPendingChoice): choice is RedactedPendingChoice {
  return (choice as RedactedPendingChoice).redacted === true;
}

/**
 * The pending choice as `seat` may see it (`null` for a spectator, who is never
 * anyone's chooser). This is the masking rule in one line: you get the question
 * only if you are the one being asked.
 */
function maskPendingChoiceForSeat(state: GameState, seat: PlayerId | null): MaskedPendingChoice | null {
  const choice = state.pendingChoice;
  if (!choice) return null;
  return seat !== null && choice.chooser === seat ? choice : redactPendingChoice(choice);
}

/** A serializable snapshot of `GameState` redacted for one seat. */
export interface MaskedGameView {
  readonly viewer: PlayerId;
  readonly turnNumber: number;
  readonly activePlayer: PlayerId;
  readonly priorityPlayer: PlayerId;
  readonly step: Step;
  readonly players: Record<PlayerId, PublicPlayerView>;
  /** Battlefield + stack are public (both players see them). */
  readonly battlefield: readonly CardInstance[];
  readonly stack: readonly StackObject[];
  readonly combat: CombatState | null;
  readonly winner: PlayerId | null;
  readonly gameOver: boolean;
  /**
   * The question a resolving card parked, or `null`. Full for the seat that must
   * answer; a {@link RedactedPendingChoice} summary for the other seat and for
   * spectators. Without this an online client sees its legal menu collapse to
   * opaque `answerChoice` actions and the game dead-ends.
   */
  readonly pendingChoice: MaskedPendingChoice | null;
}

/**
 * Produce the view `seat` is entitled to. The opponent's `hand` is `null` (only a
 * `handCount`) and their `library` is a `libraryCount` only — their hidden cards are
 * never copied into the result, so a serialized `MaskedGameView` cannot leak them.
 */
export function maskStateForSeat(state: GameState, seat: PlayerId): MaskedGameView {
  const players = {} as Record<PlayerId, PublicPlayerView>;
  for (const id of PLAYER_IDS) {
    const p = state.players[id];
    const isViewer = id === seat;
    players[id] = {
      id,
      life: p.life,
      poison: poisonOf(p),
      manaPool: p.manaPool,
      landsPlayedThisTurn: p.landsPlayedThisTurn,
      hasLost: p.hasLost,
      graveyard: p.graveyard,
      // §3.112 — a face-down (foretold) card is hidden from everyone but its
      // owner; it is never copied into another seat's view, only counted.
      exile: isViewer ? p.exile : p.exile.filter((card) => card.faceDown !== true),
      faceDownExileCount: isViewer ? 0 : p.exile.filter((card) => card.faceDown === true).length,
      handCount: p.hand.length,
      libraryCount: p.library.length,
      hand: isViewer ? p.hand : null,
    };
  }
  return {
    viewer: seat,
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    step: state.step,
    players,
    battlefield: state.battlefield,
    stack: state.stack,
    combat: state.combat,
    winner: state.winner,
    gameOver: state.gameOver,
    pendingChoice: maskPendingChoiceForSeat(state, seat),
  };
}

/**
 * The view a SPECTATOR is entitled to: no seat's hand, and only the summary of any
 * parked question. It lives here, beside `maskStateForSeat`, so masking stays a
 * single chokepoint — a spectator view assembled by the server out of a seat's view
 * would silently inherit whatever that seat was entitled to see next time a field
 * is added, which is exactly how `pendingChoice` would have leaked.
 *
 * `viewer` is seat A only because the shape demands a value; nothing seat-specific
 * survives the blanking below.
 */
export function maskStateForSpectator(state: GameState): MaskedGameView {
  const view = maskStateForSeat(state, PLAYER_IDS[0] as PlayerId);
  const players = {} as Record<PlayerId, PublicPlayerView>;
  for (const id of PLAYER_IDS) players[id] = { ...view.players[id], hand: null };
  return {
    ...view,
    players,
    pendingChoice: maskPendingChoiceForSeat(state, null),
  };
}

// ---------------------------------------------------------------------------
// The PUBLIC EVENT STREAM — `maskStateForSeat`'s sibling.
//
// The `state` message has always carried the board plus `Room.summarizeEvents`'s
// five kinds of pre-formatted English sentence. A sentence cannot be animated, so
// the online board could not draw combat damage while the hotseat board could —
// the same fork, one layer down. This carries the EVENTS the sentences were made
// from, beside them, so `log` keeps working unchanged.
// ---------------------------------------------------------------------------

/**
 * THE CLOSED TABLE — the only `GameEvent` kinds that may travel to a client, each
 * row stating WHY that kind is public. **A kind absent from this table is not
 * sent**, whatever it is and however harmless it looks: silently widening the
 * wire to "things that seem fine" is how a hidden-information channel opens, and
 * an event nobody classified is an event nobody checked. Adding a kind is a ROW.
 *
 * Two independent things had to be true of every row here, and the second is the
 * one that keeps the table honest as core grows:
 *
 *  1. it is public BY THE RULES — a fact every player at a paper table watches
 *     happen — and in most rows the server was already broadcasting a prose
 *     account of it to both seats, so the structured form discloses nothing the
 *     shipped `log` did not;
 *  2. `packages/sim`'s `OBSERVATION_POLICY` — the OTHER hidden-information table
 *     in this repo, which decides what an AI pilot may observe — also classifies
 *     it `'public'`, i.e. passes it through unredacted. The two tables answer
 *     genuinely different questions (a pilot is one spectator holding no cards; a
 *     seat sees its own hand as well), so neither can be derived from the other —
 *     but a kind the pilot feed must redact can never be one a seat may receive
 *     verbatim, and `apps/server/src/event-stream.test.ts` pins that containment
 *     so the two cannot drift apart unnoticed.
 *
 * ⚠️ THE TABLE IS ONLY HALF THE GATE. A kind can be public and an individual
 * event of that kind can still name a card this seat may not see — a counter put
 * on a face-down foretold card in the opponent's exile is a `counterAdded`. So
 * {@link maskEventsForSeat} also checks, per event and per seat, that every card
 * the event names is one that seat's own masked view already carries. Both gates
 * must pass.
 */
export const PUBLIC_EVENT_KINDS = Object.freeze({
  // --- combat damage and the events dealt inside one assignment --------------
  damageDealt: 'CR 510.2 — combat damage is dealt in the open, and this is UX-15’s whole input.',
  damagePrevented: 'A shield or a fog firing is watched by the table exactly as the damage would have been.',
  lifeChanged: 'Life totals are public (CR 118.1) and already travel on every `PublicPlayerView`.',
  gainLife: 'The lifelink half of the same public life change.',
  poisonChanged: 'CR 122.1f — poison counters are public, and `PublicPlayerView.poison` already carries the total.',
  loyaltyChanged: 'Loyalty is a public counter on a battlefield permanent.',
  defenseChanged: 'Defense is a public counter on a battlefield permanent.',
  counterAdded: 'Counters on a permanent are public; the id gate refuses the ones placed on a card this seat cannot see.',
  replacementApplied: 'A damage doubler or prevention shield firing mid-hit — the permanent that did it is on the battlefield.',
  // --- what ends a damage round: death is a state-based action ---------------
  creatureDied: 'CR 704.5g — the creature and its name were on the battlefield, and it is now in a public graveyard.',
  planeswalkerDied: 'CR 704.5i — as `creatureDied`.',
  battleDefeated: 'CR 704.5x — as `creatureDied`.',
  playerLost: 'Losing the game is not something a player can keep to themselves.',
  gameOver: 'The result, which the `gameOver` message already announces to every connection.',
  // --- the five kinds `Room.summarizeEvents` ALREADY narrates to both seats ---
  landPlayed: 'Already broadcast as “A land was played.” — the structured form discloses nothing new.',
  spellCast: 'Already broadcast as “A spell was cast: <name>.”; casting is a public announcement (CR 601.2a).',
  attackersDeclared: 'Already broadcast, and the attackers are in the public `CombatState` the view carries.',
  blockersDeclared: 'Already broadcast, and the blocks are in the public `CombatState` the view carries.',
  stepBegin: 'Already broadcast, and `MaskedGameView.step` carries the same fact.',
  // --- the remaining public boundaries a damage fold reads -------------------
  // Damage rounds are separated by the events BETWEEN them (`damage-sequence.ts`),
  // so the boundaries have to travel too or two rounds arrive as one blur.
  turnBegin: 'Whose turn it is and which turn number — `MaskedGameView` carries both.',
  stackResolved: 'The object resolved from the public stack, which the view sends unredacted.',
} as const) satisfies Readonly<Partial<Record<GameEvent['type'], string>>>;

/** One row of {@link PUBLIC_EVENT_KINDS} — derived, never a second list. */
export type PublicEventKind = keyof typeof PUBLIC_EVENT_KINDS;

/**
 * A `GameEvent` narrowed to the kinds the wire carries. DERIVED from the table,
 * so a new row widens the type (and every consumer's switch) for free, and a
 * consumer cannot name a kind the table refuses to send.
 */
export type PublicGameEvent = Extract<GameEvent, { readonly type: PublicEventKind }>;

/** Whether a kind is in the closed table. The negative branch is "do not send". */
export function isPublicEventKind(type: GameEvent['type']): type is PublicEventKind {
  return Object.prototype.hasOwnProperty.call(PUBLIC_EVENT_KINDS, type);
}

/** Shared empty result, so the overwhelmingly common quiet frame allocates nothing. */
const NO_PUBLIC_EVENTS: readonly PublicGameEvent[] = Object.freeze([]);

/**
 * The two views that bound what one seat may be told about an action: the view it
 * held before the action and the view it is about to be sent.
 *
 * ⚠️ **MASKED VIEWS, NOT `GameState`s — that is the whole design.** This is a
 * hidden-information boundary, and the way to make one provable is to hand the
 * filter nothing it must be trusted not to publish. `maskEventsForSeat` therefore
 * cannot see a hand it is meant to withhold, because it is never given one.
 *
 * `before` is `null` only when there is no previous frame for this seat (the
 * first send of a game). Both frames are needed, not just `after`: a TOKEN that
 * blocked and died is gone from every zone by the time `after` is built, and a
 * filter that only knew `after` would drop its `damageDealt` and lose that half
 * of the combat. A card visible in either frame is a card this seat was already
 * entitled to see, so the union widens the filter's knowledge by exactly nothing.
 */
export interface SeatEventWindow {
  readonly before: MaskedGameView | null;
  readonly after: MaskedGameView;
}

/**
 * The events from one action that `window`'s seat may be told about.
 *
 * BOTH gates, in order: the kind must be in {@link PUBLIC_EVENT_KINDS}, and every
 * card the event names — via core's exact, type-derived `instanceIdsNamedBy`,
 * never a key-name guess — must appear in one of the seat's own two views. An
 * event that fails either gate is DROPPED WHOLE rather than trimmed: a
 * half-redacted event is a shape no consumer asked for, and "report, don't
 * widen" is the closed-table rule (CLAUDE.md rule 2).
 *
 * What that costs, said out loud: a token creature that dies in the same combat
 * it fought in has left every zone by `after` and was never in `before` if it was
 * also created by that action, so its hits do not animate on the online board.
 * That is an honest omission — the life totals, the log and the board still carry
 * the outcome — and it is the only direction this filter is allowed to be wrong in.
 */
export function maskEventsForSeat(
  events: readonly GameEvent[],
  window: SeatEventWindow,
): readonly PublicGameEvent[] {
  if (events.length === 0) return NO_PUBLIC_EVENTS;
  // The cheap gate first: most batches contain no public event at all, and the
  // id walk over two whole views is the expensive half.
  let anyPublic = false;
  for (const event of events) {
    if (isPublicEventKind(event.type)) {
      anyPublic = true;
      break;
    }
  }
  if (!anyPublic) return NO_PUBLIC_EVENTS;

  const visible = collectInstanceIds(window.after);
  if (window.before !== null) for (const id of collectInstanceIds(window.before)) visible.add(id);

  const out: PublicGameEvent[] = [];
  for (const event of events) {
    if (!isPublicEventKind(event.type)) continue;
    let mayTell = true;
    for (const id of instanceIdsNamedBy(event)) {
      if (!visible.has(id)) {
        mayTell = false;
        break;
      }
    }
    if (mayTell) out.push(event as PublicGameEvent);
  }
  return out.length > 0 ? out : NO_PUBLIC_EVENTS;
}

// ---------------------------------------------------------------------------
// Anti-cheat assertion tooling.
// ---------------------------------------------------------------------------

/**
 * Every instance id reachable anywhere in a value, at any depth — the STRUCTURAL
 * way to ask "does this message mention that card?".
 *
 * Text scanning is the tempting version and it is wrong in both directions: a
 * substring/regex over the serialized JSON hits the digits of unrelated numbers
 * (life totals, counts, a longer id that starts with a shorter one), and it misses
 * an id that a future field carries under another name. Walking the structure is
 * exact.
 *
 * ## ⚠️ IT USED TO RECOGNISE ONE KEY NAME, AND THAT WAS THE BUG
 * This function collected the values of keys named exactly `instanceId`. The
 * engine names cards under a dozen other keys — `sourceInstanceId`,
 * `targetInstanceId`, `keptInstanceId`, `hostInstanceId`, `copiedInstanceId`,
 * `source`, `target`, `targets`, `attackers`, `attackTargets`, `blocks`,
 * `instanceIds`, `ref`, `attachedTo` — and every one of them walked straight past
 * this scan. Two real hidden-information leaks were found through that blind
 * spot, and neither could ever have been caught here.
 *
 * So the key vocabulary is no longer written down in this file. It comes from
 * `@jonny-boi/core`'s {@link INSTANCE_ID_FIELD_NAMES}, which is DERIVED from a
 * mapped type over every field of every `GameEvent` (plus the id fields that live
 * on state types) — adding a field that can name a card fails core's build until
 * somebody classifies it, and the classification extends this scan for free. See
 * `packages/core/src/instance-ids.ts`.
 *
 * A pattern match on the NAME (say, "ends in `InstanceId`") was the other
 * candidate and is strictly weaker: it would still miss `source`, `target`,
 * `targets`, `attackers`, `blocks` and `ref`, which is most of combat and all of
 * targeting. It is kept as a BACKSTOP below, for id fields declared outside core
 * where nothing forces a classification — never as the mechanism.
 *
 * Exported because it is the assertion the masking chokepoint has to be provable
 * with, and every consumer that ships a new view field needs the same check.
 */
/**
 * The BACKSTOP: any key whose name ends in `instanceId` / `instanceIds`,
 * whatever the prefix and whatever the case.
 *
 * Core's table is the primary mechanism and it is the strong one — it is checked
 * by the compiler and by a scan of core's own source. But it can only speak for
 * `@jonny-boi/core`, and ids are declared outside it too (`swappedInstanceIds` in
 * the sim, `knownInstanceIds` in a pilot's belief state), where nothing forces a
 * classification. This catches the conventionally-named ones for free.
 *
 * It is a backstop and not the mechanism, because on its own it would still miss
 * `source`, `target`, `targets`, `attackers`, `blocks` and `ref` — most of combat
 * and all of targeting. Anything that matters belongs in core's table.
 */
const INSTANCE_ID_KEY_SUFFIX = /instanceids?$/i;

/** Whether a value found under `key` is an instance id. */
function keyNamesACard(key: string): boolean {
  return INSTANCE_ID_FIELD_NAMES.has(key) || INSTANCE_ID_KEY_SUFFIX.test(key);
}

export function collectInstanceIds(value: unknown): Set<number> {
  const found = new Set<number>();
  const seen = new Set<object>();
  const add = (n: unknown): void => {
    if (typeof n === 'number' && Number.isFinite(n)) found.add(n);
  };
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return; // a cycle must not wedge the walk
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (keyNamesACard(key)) {
        add(child);
        // An id field can hold one id, a LIST of them, or a MAP KEYED BY them
        // (`attackTargets` is attacker-id → attacked object; `blocks` is
        // blocker-id → attacker-id). A scan that read only the values of the
        // last shape would publish exactly half of a leak.
        if (Array.isArray(child)) for (const item of child) add(item);
        else if (child !== null && typeof child === 'object') {
          for (const [nestedKey, nestedChild] of Object.entries(child as Record<string, unknown>)) {
            add(Number(nestedKey));
            add(nestedChild);
          }
        }
      }
      walk(child);
    }
  };
  walk(value);
  return found;
}

/**
 * Which of `forbidden` a value mentions — empty means "nothing leaked". Returning
 * the offenders rather than a boolean is what makes a failing anti-cheat test say
 * WHICH card escaped.
 */
export function leakedInstanceIds(value: unknown, forbidden: Iterable<number>): number[] {
  const present = collectInstanceIds(value);
  return [...forbidden].filter((id) => present.has(id));
}

// ---------------------------------------------------------------------------
// Room + error vocabularies (no magic strings — consumers switch on these).
// ---------------------------------------------------------------------------

export type RoomPhase = 'waiting' | 'deckSelect' | 'mulligan' | 'playing' | 'finished';

export type ErrorCode =
  | 'roomNotFound'
  | 'roomFull'
  | 'notInRoom'
  | 'notYourTurn'
  | 'illegalAction'
  | 'invalidDeck'
  | 'protocolMismatch'
  | 'internal';

export interface LobbyPlayer {
  readonly seat: PlayerId;
  readonly name: string;
  readonly ready: boolean;
  readonly hasDeck: boolean;
}

// ---------------------------------------------------------------------------
// Client → Server messages.
// ---------------------------------------------------------------------------

/**
 * Who takes the first turn of an online game, as the room's CREATOR chooses it
 * (§3.125). 'host' is the creating seat (A), 'guest' the joining seat (B), and
 * 'random' a coin the SERVER flips when the game starts — never the client, so
 * neither player can pick a flip they like. Optional and additive on `createRoom`:
 * an older server's validator rebuilds the message from the fields it knows and
 * simply drops this one, so an old server still starts the host, exactly as it
 * always did.
 */
export type StartingPlayerChoice = 'host' | 'guest' | 'random';

/** The closed set, for validators — a value outside it is refused, not widened. */
export const STARTING_PLAYER_CHOICES: readonly StartingPlayerChoice[] = Object.freeze(['host', 'guest', 'random']);

/** The choice the room falls back to when the creator did not make one. */
export const DEFAULT_STARTING_PLAYER_CHOICE: StartingPlayerChoice = 'host';

export type ClientMessage =
  | {
      readonly t: 'createRoom';
      readonly protocolVersion: number;
      readonly name: string;
      readonly deck?: DeckList;
      readonly startingPlayer?: StartingPlayerChoice;
    }
  | { readonly t: 'joinRoom'; readonly protocolVersion: number; readonly code: string; readonly name: string; readonly deck?: DeckList }
  /**
   * Reclaim a seat after a dropped socket, using the `reconnectToken` the server
   * issued in `roomJoined`. Added in PROTOCOL_VERSION 1 as a new tag: a client that
   * never sends it behaves exactly as before, so this is backward-compatible.
   */
  | {
      readonly t: 'reconnect';
      readonly protocolVersion: number;
      readonly code: string;
      readonly seat: PlayerId;
      readonly token: string;
    }
  | { readonly t: 'chooseDeck'; readonly deck: DeckList }
  | { readonly t: 'setReady'; readonly ready: boolean }
  | { readonly t: 'mulligan'; readonly keep: boolean }
  | { readonly t: 'submitAction'; readonly action: GameAction }
  | { readonly t: 'concede' }
  | { readonly t: 'rematch' }
  | { readonly t: 'ping' };

export type ClientMessageTag = ClientMessage['t'];

// ---------------------------------------------------------------------------
// Server → Client messages.
// ---------------------------------------------------------------------------

export type ServerMessage =
  | {
      readonly t: 'roomJoined';
      readonly code: string;
      readonly yourSeat: PlayerId | null;
      readonly spectator: boolean;
      /**
       * Secret that lets THIS client reclaim THIS seat after a drop (see the
       * `reconnect` client message). Present only for a seated player — never for a
       * spectator, and never for the opposing seat. Optional so older clients, which
       * simply ignore it, keep working unchanged.
       */
      readonly reconnectToken?: string;
    }
  | {
      readonly t: 'lobby';
      readonly code: string;
      readonly phase: RoomPhase;
      readonly players: readonly LobbyPlayer[];
      /**
       * What the creator chose for the first turn (§3.125), so the joining player
       * sees it in the lobby rather than discovering it when the board appears.
       * Optional: older servers do not send it and older clients ignore it.
       */
      readonly startingPlayer?: StartingPlayerChoice;
    }
  | { readonly t: 'gameStarted'; readonly yourSeat: PlayerId }
  | { readonly t: 'mulliganPrompt'; readonly hand: readonly CardInstance[]; readonly mulligansTaken: number }
  | {
      readonly t: 'state';
      readonly view: MaskedGameView;
      readonly legalActions: readonly GameAction[];
      readonly yourTurn: boolean;
      readonly log: readonly string[];
      /**
       * The PUBLIC events this frame was produced by, filtered for THIS seat by
       * {@link maskEventsForSeat} — the structure `log`'s sentences were folded
       * out of, carried BESIDE them rather than instead of them (the prose log
       * is a separate consumer and does not regress).
       *
       * Optional and additive: a v2 server omits it, and a client reads the
       * absence as "this server carries no event stream" — which is exactly the
       * behaviour every client had before v3. Omitted, rather than sent empty,
       * whenever an action produced nothing public: a field that is always
       * present makes "no damage happened" and "no channel" the same message.
       */
      readonly events?: readonly PublicGameEvent[];
    }
  | { readonly t: 'gameOver'; readonly winner: PlayerId | null; readonly reason: string }
  | { readonly t: 'opponentDisconnected' }
  | { readonly t: 'opponentReconnected' }
  | { readonly t: 'error'; readonly code: ErrorCode; readonly message: string }
  | { readonly t: 'pong' };

export type ServerMessageTag = ServerMessage['t'];

/** Exhaustiveness helper: callers can `default: return assertNever(msg)` in a switch. */
export function assertNever(x: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(x)}`);
}
