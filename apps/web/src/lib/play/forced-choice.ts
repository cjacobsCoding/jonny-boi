/**
 * SAYING WHAT THE GAME DECIDED FOR YOU — pure, DOM-free.
 *
 * Caleb, verbatim, on a Banisher Priest that exiled a creature without asking:
 *
 * > *"whoah - I just played Banisher priest and it didnt let me choose a
 * > creature to banish - thats a REALLY BAD REGRESSION"* … *"Oh - its because
 * > there was only one option in this case... I see. Even so, **it should show
 * > that choice being made so the player understands what has happened.**"*
 *
 * ## The rules were right; the silence was the bug
 *
 * MEASURED, not assumed. A rig cast the real Banisher Priest at a board holding
 * exactly one opponent creature and printed every event:
 *
 * ```
 * triggerPutOnStack   … "Enters: exile target creature an opponent controls…"
 * choiceAutoAnswered  choiceKind=selectTargets answer={targets:[121]}
 *                     reason="only one legal target"
 * triggerTargetsChosen targets=[121]
 * ```
 *
 * …and with TWO opponent creatures on the board the same cast parks a
 * `choiceAsked` and waits, which is correct. So the settle is CORE's
 * (`aimPendingTriggers` → `isTrivialChoice`), it is right, and it must stay: the
 * sim and the pilots depend on a game that never stops to collect an inevitable
 * answer. What was missing is that NOTHING ON SCREEN said it had happened —
 * `play-format.ts` explicitly dropped the event as *"bookkeeping, not
 * narrative"*. This module is that sentence being wrong.
 *
 * ## The third instance of this branch's signature failure
 *
 * §7.3 and §10 of `docs/MTGA-UX-OVERHAUL.md` are the same shape twice over:
 * something CORRECT happening too fast or too quietly for a player to read it.
 * UX-16 (`spell-hold.ts`) and §10 (`combat-hold.ts`) are the two solutions that
 * work, and this is deliberately built in their image — a closed KIND table, a
 * closed REFUSAL set, a pure decision, and a banner in the same visual language.
 *
 * ## ⚠️ AN ANNOUNCEMENT IS NOT A PROMPT
 *
 * Caleb asked to SEE the decision, not to confirm it. A confirmation on every
 * single-target spell would be worse than the bug it fixed. Nothing here parks a
 * question, grants priority, or takes an input that the game waits on.
 *
 * ## Why every kind announces, and what actually stops a new kind going silent
 *
 * The brief asked for *"a kind with no phrasing must ASK rather than settle
 * silently"*. Measured against the engine, that rule has no unreachable half:
 * **every** {@link ChoiceKind} can be auto-answered, because the trivial-answer
 * path is not the only one — `state.gameOver`, a chooser who `hasLost`, and
 * `effects.ts`'s `detachedAnswer` settle a question of ANY kind. So there is no
 * honest row that can decline to phrase itself, and the union is not modelled as
 * if there were.
 *
 * What holds the line instead is the mapped type: {@link FORCED_CHOICE_KINDS} is
 * `{ readonly [K in ChoiceKind]: … }`, so a new choice kind in
 * `packages/core/src/choices.ts` STOPS THE BUILD here until somebody writes its
 * words. `forced-choice.test.ts` then asserts every row produces a non-empty
 * announcement from that kind's own default answer, so a row cannot satisfy the
 * compiler with empty strings.
 */
import {
  isPlayerTarget,
  NOTHING_CHOSEN,
  type CardDefinition,
  type ChoiceAnswer,
  type ChoiceKind,
  type GameEvent,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import type { ForcedChoiceConfig } from './play-config.js';

// -----------------------------------------------------------------------------
// The kinds
// -----------------------------------------------------------------------------

/**
 * How loudly one settled question is reported. CLOSED.
 *
 * `banner` is the board-level announcement Caleb asked for. `logOnly` is for the
 * settlements that are genuinely bookkeeping — a payment nobody could have made,
 * a yes/no settled because the game is already over — where a strip across the
 * board would be the click-through tax UX-16 was careful not to become. BOTH
 * reach the game log: a line there costs nothing and the log is where a player
 * looks to ask "what just happened?".
 */
export const FORCED_CHOICE_VOLUMES = ['banner', 'logOnly'] as const;
export type ForcedChoiceVolume = (typeof FORCED_CHOICE_VOLUMES)[number];

/** What one settled question of a given kind is called, and how it is worded. */
export interface ForcedChoiceKindRow {
  readonly volume: ForcedChoiceVolume;
  /**
   * The verb in "*Banisher Priest* **targets** *Grizzly Bears*". A VERB rather
   * than a whole sentence, because the subject is the asking card and the object
   * is the answer — both of which vary per event.
   */
  readonly verb: string;
  /**
   * The words for an answer that named nothing at all. "Up to one target" with
   * no legal target is a real, lawful answer, and `Banisher Priest targets` with
   * nothing after it reads as a rendering bug.
   */
  readonly nothing: string;
  /**
   * May the SHARED GAME LOG name what was chosen?
   *
   * ⚠️ NOT a styling flag — a hidden-information one, and the reason this is a
   * row rather than a blanket rule. In hotseat BOTH seats read one log, which is
   * why `play-format.ts` already refuses to name the cards in an ordinary
   * `choiceAnswered`. A settled `selectTargets` is safe (every legal target
   * lives in a public zone or is a seat) and a scalar answer names no card at
   * all; a settled `selectCards` is NOT, because its candidates can be a hand or
   * a library. The BANNER is unaffected: it is shown only to the chooser, who is
   * allowed to know their own answer.
   */
  readonly namesInSharedLog: boolean;
  /** Why this row is worded and pitched the way it is. */
  readonly why: string;
}

/**
 * EVERY QUESTION KIND THE ENGINE CAN SETTLE WITHOUT ASKING, and the words for
 * each. A mapped type over core's own `ChoiceKind`, so adding a kind there
 * breaks the build here (see the header) — a new kind cannot become invisible
 * by omission.
 */
export const FORCED_CHOICE_KINDS: { readonly [K in ChoiceKind]: ForcedChoiceKindRow } =
  Object.freeze({
    selectTargets: Object.freeze({
      volume: 'banner',
      verb: 'targets',
      nothing: 'nothing — there was no legal target',
      namesInSharedLog: true,  // Every legal target is in a public zone or is a seat.
      why: 'THE REPORTED CASE. A creature was exiled and the player was never told what or why.',
    }),
    selectCards: Object.freeze({
      volume: 'banner',
      verb: 'takes',
      nothing: 'nothing',
      namesInSharedLog: false, // Candidates can be a HAND or a LIBRARY — the one leaky kind.
      why: "An additional cost paid the only way it could — a creature leaves the battlefield and nothing says which one was picked or that the pick was forced.",
    }),
    selectPlayers: Object.freeze({
      volume: 'banner',
      verb: 'chooses',
      nothing: 'no player',
      namesInSharedLog: true,  // A seat is not hidden information.
      why: 'The same complaint aimed at a seat instead of a card: an effect landed on somebody and the player never saw it being aimed.',
    }),
    chooseModes: Object.freeze({
      volume: 'banner',
      verb: 'takes the only mode',
      nothing: 'no mode',
      namesInSharedLog: true,  // The menu is printed on the card both seats can read.
      why: 'A modal card that never showed its menu looks like a different card than the one printed; the mode taken is the whole of what it did.',
    }),
    confirm: Object.freeze({
      volume: 'logOnly',
      verb: 'answers',
      nothing: 'nothing',
      namesInSharedLog: true,  // A yes/no carries no card identity — `play-format` already says so.
      why: '`isTrivialChoice` returns FALSE for a yes/no, so this only ever fires when the chooser can no longer act — the game is over or they have lost. A strip across a board nobody is playing any more is noise on top of the end screen.',
    }),
    payMana: Object.freeze({
      volume: 'logOnly',
      verb: 'cannot pay',
      nothing: 'nothing',
      namesInSharedLog: true,  // "could not pay" names no card.
      why: 'Settled only when the cost is UNAFFORDABLE, which is common (every ward, every Mana Leak against an empty board) and whose consequence — the spell countered, the land entering tapped — is its own loud event.',
    }),
    payLife: Object.freeze({
      volume: 'logOnly',
      verb: 'cannot pay',
      nothing: 'nothing',
      namesInSharedLog: true,  // As payMana.
      why: 'As `payMana`: unaffordable is the only trivial case, and the painland entering tapped is the visible half.',
    }),
    chooseNumber: Object.freeze({
      volume: 'banner',
      verb: 'sets the value to',
      nothing: 'no value',
      namesInSharedLog: true,  // A number names no card.
      why: 'X on a board that can only fund X = 0 is exactly the reported complaint in another costume — the spell was cast for a number the player never named.',
    }),
    chooseValue: Object.freeze({
      volume: 'banner',
      verb: 'chooses',
      nothing: 'nothing to choose',
      namesInSharedLog: true,  // A creature type or colour, announced at the table (CR 614.1c).
      why: 'A named creature type or colour decides what a card DOES; taking the only option silently makes the card read as arbitrary.',
    }),
  });

// -----------------------------------------------------------------------------
// The refusals
// -----------------------------------------------------------------------------

/**
 * Why a settled question raised no BANNER. CLOSED — each row carries the
 * sentence the debug bench renders, exactly as `HOLD_REFUSALS` does, because
 * "why did nothing appear?" is a question somebody asks out loud.
 *
 * Note what is NOT a refusal: none of these suppress the LOG line. The log is
 * the complete record; the banner is the interruption, and only the banner is
 * rationed.
 */
export const FORCED_CHOICE_REFUSALS = Object.freeze({
  notYourChoice:
    'The computer answered its own forced question. The opponent feed and the game log report what it did; a banner would announce a decision you were never going to make.',
  logOnlyKind: 'This kind of settled question is logged rather than announced (see FORCED_CHOICE_KINDS).',
  gameOver: 'The game is over — the end screen is the announcement now.',
  alreadyAnnounced: 'This question has already been announced once.',
  turnBudgetSpent:
    'Too many forced choices already announced this turn — the rest are in the game log, which is the complete record.',
});
export type ForcedChoiceRefusal = keyof typeof FORCED_CHOICE_REFUSALS;

// -----------------------------------------------------------------------------
// The announcement
// -----------------------------------------------------------------------------

/**
 * What the board needs that the event does not carry: names for ids, and the
 * asking card's DEFINITION (the only place a mode's printed label lives).
 *
 * Deliberately three narrow lookups rather than a board handle: this module
 * stays pure and testable, and — the reason that matters — it can never reach
 * into a zone the masked view withholds. It is handed exactly what the caller
 * already renders.
 */
export interface ForcedChoiceNames {
  /** Total: an unknown id degrades to a readable placeholder, never throws. */
  readonly nameOf: (id: InstanceId) => string;
  readonly playerName: (player: PlayerId) => string;
  /**
   * The asking card's definition, for {@link modeLabelOf}. Partial by nature —
   * a token, or a source that has genuinely ceased to exist, has none.
   */
  readonly defOf?: (id: InstanceId) => CardDefinition | undefined;
}

/** One settled question, fully decided. Nothing is left for a renderer to infer. */
export interface ForcedChoice {
  readonly choiceId: number;
  readonly kind: ChoiceKind;
  readonly chooser: PlayerId;
  readonly sourceInstanceId: InstanceId;
  /** The asking card, named. Falls back to the id when nothing can name it. */
  readonly sourceName: string;
  /** From the kind row — "targets", "takes the only mode", … */
  readonly verb: string;
  /**
   * WHAT IT CHOSE, as raw refs, so the caller can draw real card faces through
   * the SAME renderer the stack panel's targets use. Empty when the answer
   * named no game object (a number, a yes/no, or a lawful "none").
   */
  readonly refs: readonly (InstanceId | PlayerId)[];
  /**
   * The same answer as words — every ref resolved to a name, or the scalar the
   * answer carried. NEVER empty: {@link ForcedChoiceKindRow.nothing} fills it.
   */
  readonly words: readonly string[];
  /** The ENGINE's own reason, verbatim ("only one legal target"). */
  readonly why: string;
  readonly volume: ForcedChoiceVolume;
}

/**
 * The one sentence, addressed to the CHOOSER — who is allowed to know their own
 * answer, so it names everything.
 */
export function forcedChoiceSentence(fc: ForcedChoice): string {
  return `${fc.sourceName} ${fc.verb} ${fc.words.join(', ')} — ${fc.why}.`;
}

/**
 * The same sentence for the SHARED game log.
 *
 * One body, two audiences (rule 12): the only difference is
 * {@link ForcedChoiceKindRow.namesInSharedLog}, and a kind that may not name its
 * answer still reports that the question was settled and WHY — which is the half
 * a player needs to stop thinking the app is broken. A redaction that printed
 * nothing at all would reproduce the very silence this module exists to end.
 */
export function forcedChoiceLogLine(fc: ForcedChoice): string {
  if (FORCED_CHOICE_KINDS[fc.kind].namesInSharedLog) return forcedChoiceSentence(fc);
  return `${fc.sourceName} ${fc.verb} the only legal answer — ${fc.why}.`;
}

/**
 * A mode's PRINTED LABEL, from the asking card's own definition.
 *
 * The event carries mode IDS (`mode1`, `mode2`) because that is what a replay
 * needs; printing one at a player would be an engine identifier on screen. Both
 * places a mode can be declared are searched — a spell's `modal` and every
 * trigger's — because a settled mode question can come from either
 * (`askCastModes` and `askTriggerModes` are two call sites of one idea).
 *
 * Returns `null` rather than guessing when the card cannot be found or holds no
 * such mode; the caller falls back to the raw id AND the fallback is visible in
 * the words, so a miss reads as a miss rather than as a card that is really
 * called "mode1".
 */
export function modeLabelOf(def: CardDefinition | undefined, modeId: string): string | null {
  if (!def) return null;
  for (const mode of def.modal?.modes ?? []) {
    if (mode.id === modeId) return mode.label;
  }
  for (const trigger of def.triggers ?? []) {
    for (const mode of trigger.modal?.modes ?? []) {
      if (mode.id === modeId) return mode.label;
    }
  }
  return null;
}

/**
 * The refs an answer names, and the words for the ones it does not.
 *
 * ONE switch over `ChoiceAnswer`, so "what did this answer pick?" has a single
 * home. `isPlayerTarget` is core's own funnel for seat-vs-instance and is called
 * rather than re-implemented (rule 12).
 */
function answerContents(
  answer: ChoiceAnswer,
  sourceInstanceId: InstanceId,
  names: ForcedChoiceNames,
): { refs: readonly (InstanceId | PlayerId)[]; words: readonly string[] } {
  const named = (refs: readonly (InstanceId | PlayerId)[]) => ({
    refs,
    words: refs.map((ref) => (isPlayerTarget(ref) ? names.playerName(ref) : names.nameOf(ref))),
  });
  switch (answer.kind) {
    case 'selectTargets':
      return named(answer.targets);
    case 'selectCards':
      return named(answer.instanceIds);
    case 'selectPlayers':
      return named(answer.players);
    case 'chooseModes':
      return {
        refs: [],
        words: answer.modeIds.map(
          (id) => modeLabelOf(names.defOf?.(sourceInstanceId), id) ?? `an unnamed mode (${id})`,
        ),
      };
    case 'confirm':
      return { refs: [], words: [answer.yes ? 'yes' : 'no'] };
    case 'payMana':
    case 'payLife':
      return { refs: [], words: [answer.pay ? 'yes' : 'no'] };
    case 'chooseNumber':
      return { refs: [], words: [String(answer.value)] };
    case 'chooseValue':
      // `NOTHING_CHOSEN` is core's own spelling of "named nothing" and is a
      // legal answer, not a missing one — it falls through to the row's
      // `nothing` words rather than printing an empty string.
      return { refs: [], words: answer.value === NOTHING_CHOSEN ? [] : [answer.value] };
  }
}

/**
 * The engine's `choiceAutoAnswered` → everything a banner and a log line need,
 * or `null` for any other event. Total and allocation-cheap: callers filter a
 * batch of events through it.
 */
export function forcedChoiceOf(event: GameEvent, names: ForcedChoiceNames): ForcedChoice | null {
  if (event.type !== 'choiceAutoAnswered') return null;
  const row = FORCED_CHOICE_KINDS[event.choiceKind];
  // A kind this build does not know cannot be phrased, and inventing words for
  // it would be the silent approximation rule 2 forbids. Unreachable while the
  // mapped type holds — it is the runtime half of that compile-time guarantee,
  // for a state written by a NEWER build (a saved game, an online peer).
  if (!row) return null;
  const { refs, words } = answerContents(event.answer, event.sourceInstanceId, names);
  return {
    choiceId: event.choiceId,
    kind: event.choiceKind,
    chooser: event.chooser,
    sourceInstanceId: event.sourceInstanceId,
    // The engine's own name first — it was captured while the source was still
    // findable, and an ability outlives its source (CR 603.4 / 608.2).
    sourceName: event.sourceName.length > 0 ? event.sourceName : names.nameOf(event.sourceInstanceId),
    verb: row.verb,
    refs,
    words: words.length > 0 ? words : [row.nothing],
    why: event.reason,
    volume: row.volume,
  };
}

// -----------------------------------------------------------------------------
// The banner decision
// -----------------------------------------------------------------------------

/** Everything the banner rule reads. All of it is already in the board's hands. */
export interface ForcedChoiceContext {
  /** Whose screen this is. Only the VIEWER's own settled questions interrupt. */
  readonly viewer: PlayerId;
  /** Questions already announced this game — a banner fires ONCE per question. */
  readonly announced: ReadonlySet<number>;
  /** How many banners this turn has already spent (see `maxPerTurn`). */
  readonly announcedThisTurn: number;
  readonly gameOver: boolean;
}

export type ForcedChoiceDecision =
  | { readonly kind: 'announce'; readonly forced: ForcedChoice }
  | { readonly kind: 'refused'; readonly reason: ForcedChoiceRefusal; readonly detail: string };

/**
 * Should this settled question interrupt the board?
 *
 * Order matters only for which SENTENCE a refusal gives, never for the verdict.
 */
export function forcedChoiceDecision(
  forced: ForcedChoice,
  ctx: ForcedChoiceContext,
  cfg: ForcedChoiceConfig,
): ForcedChoiceDecision {
  const refuse = (reason: ForcedChoiceRefusal): ForcedChoiceDecision => ({
    kind: 'refused',
    reason,
    detail: FORCED_CHOICE_REFUSALS[reason],
  });
  if (ctx.gameOver) return refuse('gameOver');
  // The complaint is "I was not asked and was not told". An opponent's forced
  // answer was never going to be the viewer's decision, and the opponent feed
  // already narrates what they did.
  if (forced.chooser !== ctx.viewer) return refuse('notYourChoice');
  if (forced.volume !== 'banner') return refuse('logOnlyKind');
  if (ctx.announced.has(forced.choiceId)) return refuse('alreadyAnnounced');
  if (ctx.announcedThisTurn >= cfg.maxPerTurn) return refuse('turnBudgetSpent');
  return { kind: 'announce', forced };
}

/** Every kind that raises a banner, for a bench or a test that enumerates them. */
export const ANNOUNCED_CHOICE_KINDS: readonly ChoiceKind[] = Object.freeze(
  (Object.keys(FORCED_CHOICE_KINDS) as ChoiceKind[]).filter(
    (k) => FORCED_CHOICE_KINDS[k].volume === 'banner',
  ),
);
