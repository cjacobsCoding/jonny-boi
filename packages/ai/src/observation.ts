/**
 * The **observation vocabulary** — what a pilot is allowed to learn about the
 * half of the game it did not play (`docs/plans/superhuman-ai-program.md`
 * §13–17, §32–33, §37).
 *
 * ## Why this file exists
 * `Pilot.chooseAction` is called ONLY when that pilot holds priority, so until
 * now a pilot never saw the opponent act at all. Every imperfect-information
 * item in the program brief — `P(card in opponent hand)`, "what could they
 * have?", archetype inference, reading represented mana — is an update rule
 * applied to *evidence*, and there was no evidence channel. This is that
 * channel's vocabulary. The channel itself (the masking chokepoint that
 * produces these values) lives in `@jonny-boi/sim`, deliberately: masking is the
 * harness's job, because the harness is the trusted side and the pilot is the
 * side that must not be trusted with hidden state.
 *
 * ## The one rule: this feed is SPECTATOR-LEVEL
 * An `Observation` carries only what a person standing beside the table, holding
 * no cards, would know. It is **not** per-seat. Two consequences, both
 * deliberate:
 *
 *  1. **It cannot leak, to anybody.** There is no seat whose entitlement could be
 *     computed wrongly, because nothing in the feed is anybody's secret. An
 *     observation feed that leaked the opponent's hand would be strictly worse
 *     than no feed at all — it would silently make every measured AI result
 *     meaningless, since the pilot would be "inferring" what it was simply told.
 *  2. **It is computed once per event, not once per seat**, which is what keeps
 *     it affordable in a harness that plays thousands of games.
 *
 * A pilot combines this public feed with the view it is already lent, which
 * contains its own hand. Nothing a seat is entitled to is lost.
 *
 * ## How the type enforces it
 * `Observation` is derived FROM core's `GameEvent` union: every event type is
 * public *as printed* except the ones listed in {@link REDACTED_OBSERVATION_TYPES},
 * which are replaced here by narrower shapes. The redacted shapes declare the
 * dropped fields as `?: never`, so the original event is **not assignable** to its
 * replacement — which is what lets the harness's policy table refuse, at compile
 * time, to wave an event through unredacted. See `packages/sim/src/observation.ts`.
 *
 * Because the union is built with `Exclude` over core's own event union, a NEW
 * core event type automatically appears here, and the harness's policy table
 * (a mapped type over `GameEvent['type']`) fails to compile until somebody
 * classifies it. New evidence is never silently admitted OR silently dropped.
 */

import type { ChoiceKind, GameEvent, InstanceId, PlayerId, ZoneName } from '@jonny-boi/core';

/**
 * Zones whose contents no player may read. A card sitting in one of these is
 * *not* public knowledge, so no observation may name it.
 *
 * A library is hidden even from its owner (you do not know your own draw order),
 * which is why the seat-agnostic rule is also the correct rule: "in a hand or a
 * library" is exactly "not on public display".
 */
export type HiddenZoneName = 'hand' | 'library';

/** Every other zone: everyone at the table can read its contents. */
export type PublicZoneName = Exclude<ZoneName, HiddenZoneName>;

export const HIDDEN_ZONES: ReadonlySet<ZoneName> = new Set<HiddenZoneName>(['hand', 'library']);

/** Whether a card sitting in `zone` is hidden from the table. */
export function isHiddenZone(zone: ZoneName): zone is HiddenZoneName {
  return HIDDEN_ZONES.has(zone);
}

/** Whether a card sitting in `zone` is on public display. */
export function isPublicZone(zone: ZoneName): zone is PublicZoneName {
  return !HIDDEN_ZONES.has(zone);
}

/**
 * The event types that may NOT travel as printed. Named here, beside the shapes
 * that replace them, so the reason for each redaction is readable in one place.
 */
export const REDACTED_OBSERVATION_TYPES = [
  'gameStart',
  'drawCard',
  'zoneChange',
  'choiceAsked',
  'choiceAnswered',
  'choiceAutoAnswered',
] as const;

export type RedactedObservationType = (typeof REDACTED_OBSERVATION_TYPES)[number];

/**
 * The game started. **The seed is dropped**, and this is the least obvious and
 * most dangerous redaction in the file: `gameStart.seed` is the number the entire
 * shuffle is derived from, so a pilot holding it could reconstruct both libraries
 * exactly. That is not "a bit of extra information", it is perfect information
 * about the whole game, arriving through a field that reads like bookkeeping.
 */
export interface ObservedGameStart {
  readonly type: 'gameStart';
  readonly startingPlayer: PlayerId;
  /** Never carried — see above. Typed as `never` so the raw event can't slip by. */
  readonly seed?: never;
}

/**
 * Somebody drew a card. **Which** card is not public — the drawn card goes to a
 * hand — so the instance id is dropped, including for the drawing seat's own
 * draws: the feed is spectator-level, and a pilot reads its own hand off its
 * view anyway.
 */
export interface ObservedDraw {
  readonly type: 'drawCard';
  readonly player: PlayerId;
  readonly instanceId?: never;
}

/**
 * A card changed zones. The id is carried **only when the card came to rest
 * somewhere public** — a creature dying, a land entering, a spell being milled to
 * a graveyard are all things everyone at the table watched happen. A card moving
 * INTO a hand or a library is not, so it moves anonymously.
 *
 * The test that matters is the DESTINATION, not the origin: a card leaving a hand
 * for the battlefield is revealed by the act of arriving, while a card leaving the
 * battlefield for a hand disappears from view even though everyone saw it go.
 *
 * Split into two members on `to` so that core's `zoneChange` — whose `to` is the
 * WHOLE `ZoneName` union — is assignable to neither. That is what stops the
 * harness's policy table declaring this event "public as printed": the one event
 * whose safety depends on its payload is also the one the compiler refuses to let
 * through unexamined.
 */
export type ObservedZoneChange =
  | {
      readonly type: 'zoneChange';
      readonly from: ZoneName;
      /** Narrowed: this member exists only for a card coming to rest in public. */
      readonly to: PublicZoneName;
      readonly instanceId: InstanceId;
    }
  | {
      readonly type: 'zoneChange';
      readonly from: ZoneName;
      readonly to: HiddenZoneName;
      readonly instanceId?: never;
    };

/**
 * A resolving card asked somebody a question. The **prompt is dropped**: an effect
 * is free to write the cards it is asking about into its own prompt text, so the
 * prompt is payload, not chrome. (`@jonny-boi/protocol`'s `RedactedPendingChoice`
 * redacts it for exactly this reason — the two redactions agree on purpose.)
 *
 * What survives is what the board already shows: a spell on the public stack asked
 * a public player a question of a known shape with a known number of options.
 */
export interface ObservedChoiceAsked {
  readonly type: 'choiceAsked';
  readonly choiceId: number;
  readonly chooser: PlayerId;
  readonly choiceKind: ChoiceKind;
  readonly sourceInstanceId: InstanceId;
  readonly optionCount: number;
  readonly prompt?: never;
}

/**
 * A question was answered. The **answer and its rendered summary are dropped** —
 * an answer names cards ("put THIS one into your hand"), and the summary is that
 * answer written out. The consequences of the answer arrive on their own as public
 * events, which is the honest channel for them.
 */
export interface ObservedChoiceAnswered {
  readonly type: 'choiceAnswered';
  readonly choiceId: number;
  readonly chooser: PlayerId;
  readonly choiceKind: ChoiceKind;
  readonly answer?: never;
  readonly summary?: never;
}

/** As {@link ObservedChoiceAnswered}, for the engine answering on a player's behalf. */
export interface ObservedChoiceAutoAnswered {
  readonly type: 'choiceAutoAnswered';
  readonly choiceId: number;
  readonly chooser: PlayerId;
  readonly choiceKind: ChoiceKind;
  /** Engine-authored, never card-authored ("only one legal answer") — safe to carry. */
  readonly reason: string;
  readonly answer?: never;
}

/**
 * One thing a pilot may learn about the game while it was not acting.
 *
 * Every core event that is public **as printed** passes through unchanged (and,
 * in the harness, by reference — no allocation); the handful that carry a secret
 * are replaced by the narrower shapes above.
 */
export type Observation =
  | Exclude<GameEvent, { readonly type: RedactedObservationType }>
  | ObservedGameStart
  | ObservedDraw
  | ObservedZoneChange
  | ObservedChoiceAsked
  | ObservedChoiceAnswered
  | ObservedChoiceAutoAnswered;

/**
 * Public facts about a game, handed to a pilot when its per-game observer is
 * created. Deliberately tiny and deliberately seed-free: an observer is created
 * before a single card is drawn, so anything here is something it could not have
 * inferred, and the seed above is the reason to be careful about what goes in.
 */
export interface GameStartInfo {
  /** The seat the observing pilot occupies for this game. */
  readonly seat: PlayerId;
  /** The opposing seat — the one this pilot is trying to read. */
  readonly opponent: PlayerId;
  /** Who takes the first turn. Public at the table. */
  readonly startingPlayer: PlayerId;
}

/**
 * A pilot's memory of **one game**, and the whole of the isolation argument.
 *
 * The obvious alternative design — an `observe()` method on `Pilot` itself — was
 * rejected, and the reason is structural rather than stylistic. Every real
 * consumer builds ONE pilot and runs MANY games through it (`sim/cli.ts`,
 * `apps/web`'s Lab, `packages/ai/bench`), and the Lab additionally shards the
 * game grid across workers by range. A pilot that accumulated beliefs on itself
 * would carry game 1's evidence into game 2 — and since a shard boundary is just
 * a place where a fresh pilot happens to start, a paired A/B verdict would then
 * **depend on the worker count**. That is not a subtle bias; it is the
 * measurement changing when the machine changes.
 *
 * So the seam gives a pilot *nowhere to put cross-game state*: the harness calls
 * {@link Pilot.createGameObserver} once per game, hands the result back on every
 * `DecisionContext`, and drops it when the game ends. The natural implementation
 * keeps its state in that object's closure, whose lifetime the harness owns. A
 * pilot can still deliberately stash state on itself, but it has to bypass the
 * seam to do it — and `packages/sim/src/observation.test.ts` plays the same game
 * standalone and after other games and demands a byte-identical transcript.
 */
export interface GameObserver {
  /** Called once per public observation, in the order the engine produced them. */
  observe(observation: Observation): void;
}
