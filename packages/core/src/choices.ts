/**
 * Player CHOICES — the seam that lets a resolving spell/ability ask a player a
 * question ("discard a nonland card", "choose two modes", "you may shuffle").
 *
 * ## Why it is DATA and not a callback
 * The obvious implementation — hand the effect a `ask(): Promise<Answer>` — would
 * break every contract the rest of the project is built on: `GameState` must stay
 * plain, cloneable, serializable data (DESIGN §2.1) so the sim can clone it per
 * action, MCTS can roll it forward, the replay can fold it, and the online server
 * can ship it over a socket. A closure cannot be cloned or sent.
 *
 * So a question is a **value**: the engine parks a {@link PendingChoice} in the
 * state, hands the *answering* seat the floor, and resumes the half-finished
 * resolution when an `answerChoice` action arrives. One mechanism serves all three
 * consumers unchanged:
 *   - headless AI sim — the pending choice appears in `generateLegalActions` as
 *     ordinary `answerChoice` actions, so a pilot answers it like any other move;
 *   - hotseat — the UI renders the choice and submits the chosen answer;
 *   - authoritative server — the choice is addressed to exactly one seat, which is
 *     the only seat whose answer the engine accepts.
 *
 * ## The kinds are composable, not per-card
 * Four small kinds cover every "you may / choose / search / modal" clause in the
 * card pool (DESIGN §1 composition over inheritance — no choice type per card):
 *   - {@link SelectCardsChoice}  — pick `min..max` cards from a candidate list,
 *     optionally ORDERED (that is what "put them back in any order" is).
 *   - {@link SelectPlayersChoice} — pick `min..max` players.
 *   - {@link ChooseModesChoice}  — pick `min..max` of the listed modes.
 *   - {@link ConfirmChoice}      — yes/no ("you may …").
 * Library search is `selectCards` over library candidates plus the shuffle that
 * follows (`EffectContext.shuffleLibrary`), not a fifth kind.
 *
 * ## The invariant that makes hanging impossible
 * Every normalised choice satisfies `0 <= min <= max <= optionCount`, so
 * {@link defaultAnswerFor} always produces a LEGAL answer and
 * {@link enumerateChoiceActions} always returns a non-empty action list. A game
 * can therefore never reach a state where nobody can move.
 */

import type { CardType, EffectRef } from './card.js';
import { hasSubtype } from './card.js';
import { convertedManaCost } from './mana.js';
import type { CardInstance, GameState, InstanceId, PlayerId, ZoneName } from './state.js';
import { PLAYER_IDS, playerZone } from './state.js';

// --- card filters ---------------------------------------------------------------

/**
 * A small, SERIALIZABLE predicate over a card definition — the "nonland card in
 * your hand" / "basic land in your library" half of a choice, expressed as data so
 * a card definition can carry it in an effect's `params` blob and the AI can read
 * the same filter the engine used.
 */
export interface CardFilter {
  /** Keep only cards with at least one of these types (omit ⇒ any type). */
  readonly anyOfTypes?: readonly CardType[];
  /** Drop cards with any of these types (this is how "nonland" is written). */
  readonly noneOfTypes?: readonly CardType[];
  /**
   * Keep only cards with at least one of these printed subtypes — how "Goblins"
   * / "Islands" is written. Compared case-insensitively (see `hasSubtype`).
   */
  readonly anyOfSubtypes?: readonly string[];
  /** Drop cards carrying any of these printed subtypes ("non-Goblin creature"). */
  readonly noneOfSubtypes?: readonly string[];
  /** Exact card name match (case-sensitive, as printed). */
  readonly nameEquals?: string;
  /** Inclusive mana-value bounds. */
  readonly minManaValue?: number;
  readonly maxManaValue?: number;
}

/** Whether a card instance passes a filter. An absent filter matches everything. */
export function matchesCardFilter(card: CardInstance, filter?: CardFilter): boolean {
  if (!filter) return true;
  const def = card.def;
  if (filter.anyOfTypes && !filter.anyOfTypes.some((t) => def.types.includes(t))) return false;
  if (filter.noneOfTypes && filter.noneOfTypes.some((t) => def.types.includes(t))) return false;
  if (filter.anyOfSubtypes && !filter.anyOfSubtypes.some((s) => hasSubtype(def, s))) return false;
  if (filter.noneOfSubtypes && filter.noneOfSubtypes.some((s) => hasSubtype(def, s))) return false;
  if (filter.nameEquals !== undefined && def.name !== filter.nameEquals) return false;
  if (filter.minManaValue !== undefined || filter.maxManaValue !== undefined) {
    const mv = def.cost ? convertedManaCost(def.cost) : 0;
    if (filter.minManaValue !== undefined && mv < filter.minManaValue) return false;
    if (filter.maxManaValue !== undefined && mv > filter.maxManaValue) return false;
  }
  return true;
}

// --- options --------------------------------------------------------------------

/**
 * One selectable card, as a flat SNAPSHOT rather than a live instance reference.
 *
 * The snapshot is the point: a choice travels to a UI (and, online, over a socket
 * to one seat) and must carry everything needed to render itself — including cards
 * that seat cannot otherwise see. Thoughtseize shows the caster's victim their own
 * hand; the masked game view still hides it from everyone else, because the choice
 * is addressed to exactly one `chooser`.
 */
export interface CardOption {
  readonly instanceId: InstanceId;
  /** The card definition's stable id (for art lookup in the UI). */
  readonly cardId: string;
  readonly name: string;
  /** The zone the card was in when the choice was raised. */
  readonly zone: ZoneName;
  /** Who controls/owns it right now. */
  readonly controller: PlayerId;
}

/** One selectable mode of a modal spell ("counter target spell", "draw a card"). */
export interface ChoiceMode {
  /** Stable id the answer refers to (the primitive maps it back to effects). */
  readonly id: string;
  /** Human-readable text for the UI / event log. */
  readonly label: string;
}

/** Snapshot a live instance as a selectable option. */
export function cardOption(card: CardInstance): CardOption {
  return {
    instanceId: card.instanceId,
    cardId: card.def.id,
    name: card.def.name,
    zone: card.zone,
    controller: card.controller,
  };
}

/** Where {@link collectCardOptions} looks and what it keeps. */
export interface CollectOptions {
  /**
   * Restrict to one player's cards: their hand/graveyard/library/exile, or the
   * permanents they control on the (shared) battlefield. Omit for both players.
   */
  readonly controller?: PlayerId;
  readonly filter?: CardFilter;
  /**
   * Keep at most this many. Combined with `fromTop` this is how "look at the top
   * three cards of your library" is expressed.
   */
  readonly limit?: number;
  /**
   * Take from the FRONT of the zone array rather than scanning all of it. A
   * library's front is its top (see `drawCard`), so `{ limit: 3, fromTop: true }`
   * is exactly the top three cards.
   */
  readonly fromTop?: boolean;
}

/**
 * Gather the selectable cards in a zone — the one helper every "choose a card in
 * <zone>" effect uses, so hand / graveyard / battlefield / top-N-of-library all
 * read the same way and stay in candidate order (which is also library order).
 */
export function collectCardOptions(state: GameState, zone: ZoneName, opts: CollectOptions = {}): CardOption[] {
  const out: CardOption[] = [];
  const push = (card: CardInstance): boolean => {
    if (!matchesCardFilter(card, opts.filter)) return true;
    out.push(cardOption(card));
    return opts.limit === undefined || out.length < opts.limit;
  };

  if (zone === 'battlefield') {
    for (const card of state.battlefield) {
      if (opts.controller && card.controller !== opts.controller) continue;
      if (!push(card)) break;
    }
    return out;
  }
  if (zone === 'stack') return out; // stack objects are chosen by their own machinery

  const owners: readonly PlayerId[] = opts.controller ? [opts.controller] : PLAYER_IDS;
  outer: for (const pid of owners) {
    const cards = playerZone(state.players[pid], zone);
    if (!cards) continue;
    // `fromTop` scans the front only — the natural reading of "the top N cards".
    const scan = opts.fromTop && opts.limit !== undefined ? cards.slice(0, opts.limit) : cards;
    for (const card of scan) {
      if (!push(card)) break outer;
    }
  }
  return out;
}

// --- requests (what a card author asks for) --------------------------------------

/**
 * Whether **being selected is good or bad**, from the answering player's point of
 * view. This one hint is what lets an AI answer a card it has never seen, without
 * core or the AI knowing anything about specific cards:
 *
 *   - `'gain'` — selection is favourable. Pick your BEST cards (Eternal Witness
 *     returning a card from your graveyard); pick YOURSELF among players.
 *   - `'loss'` — selection costs you. Pick your WORST cards (Thoughtseize's victim
 *     naming their own discard, Brainstorm choosing two cards to put back); pick
 *     the OPPONENT among players.
 *   - `'neutral'` — no steer; the AI takes the smallest legal selection.
 *
 * It is a hint for answering only — it never affects what answers are legal.
 */
export type ChoiceValence = 'gain' | 'loss' | 'neutral';

/** Fields every request carries. */
interface ChoiceRequestBase {
  /** Who ANSWERS. Not always the controller — Thoughtseize's victim chooses. */
  readonly chooser: PlayerId;
  /** Prompt text for the UI / event log. */
  readonly prompt: string;
  /** Hint for AI answering; see {@link ChoiceValence}. Defaults to `'neutral'`. */
  readonly valence?: ChoiceValence;
}

/**
 * Count bounds, shared by every multi-select request. Resolution (see
 * {@link normalizeCounts}): `max` defaults to `min ?? 1`, `min` defaults to `max`,
 * then both are clamped into `[0, optionCount]`. So `{ max: 2 }` means exactly two,
 * `{ min: 0, max: 2 }` means "up to two" — which is what "you may" looks like on a
 * selection — and omitting both means exactly one.
 */
interface ChoiceCountRequest {
  readonly min?: number;
  readonly max?: number;
}

export interface SelectCardsRequest extends ChoiceRequestBase, ChoiceCountRequest {
  readonly kind: 'selectCards';
  readonly candidates: readonly CardOption[];
  /**
   * When true the ANSWER ORDER is meaningful: the answer lists the chosen cards in
   * the order the effect will use them, FIRST being the position that comes up
   * soonest — the card that ends up on top of the library, is drawn first, is seen
   * first. (An AI therefore orders its picks best-first.) This is what "put them
   * back on top in any order" is; there is no separate "arrange" choice kind.
   */
  readonly ordered?: boolean;
  /** Where the candidates came from; UI copy + AI context only. */
  readonly fromZone?: ZoneName;
}

export interface SelectPlayersRequest extends ChoiceRequestBase, ChoiceCountRequest {
  readonly kind: 'selectPlayers';
  readonly candidates: readonly PlayerId[];
}

export interface ChooseModesRequest extends ChoiceRequestBase, ChoiceCountRequest {
  readonly kind: 'chooseModes';
  readonly modes: readonly ChoiceMode[];
}

export interface ConfirmRequest extends ChoiceRequestBase {
  readonly kind: 'confirm';
}

/** Everything a resolving effect may ask. */
export type ChoiceRequest = SelectCardsRequest | SelectPlayersRequest | ChooseModesRequest | ConfirmRequest;

/** The kinds, as a discriminator. */
export type ChoiceKind = ChoiceRequest['kind'];

// --- the pending choice (what lives in GameState) ---------------------------------

/** Identity + provenance every parked choice carries. */
interface PendingChoiceBase {
  /**
   * Unique per game. An answer must name it, which is what makes a stale answer
   * (a slow client answering last turn's question) rejectable rather than applied
   * to whatever question happens to be open now.
   */
  readonly id: number;
  readonly chooser: PlayerId;
  readonly prompt: string;
  readonly valence: ChoiceValence;
  /** The spell/permanent that asked. */
  readonly sourceInstanceId: InstanceId;
  readonly sourceName: string;
  readonly min: number;
  readonly max: number;
}

export interface SelectCardsChoice extends PendingChoiceBase {
  readonly kind: 'selectCards';
  readonly candidates: readonly CardOption[];
  readonly ordered: boolean;
  readonly fromZone?: ZoneName;
}

export interface SelectPlayersChoice extends PendingChoiceBase {
  readonly kind: 'selectPlayers';
  readonly candidates: readonly PlayerId[];
}

export interface ChooseModesChoice extends PendingChoiceBase {
  readonly kind: 'chooseModes';
  readonly modes: readonly ChoiceMode[];
}

export interface ConfirmChoice extends PendingChoiceBase {
  readonly kind: 'confirm';
}

/** A question parked in `GameState.pendingChoice`, awaiting an `answerChoice`. */
export type PendingChoice = SelectCardsChoice | SelectPlayersChoice | ChooseModesChoice | ConfirmChoice;

// --- answers ----------------------------------------------------------------------

export interface SelectCardsAnswer {
  readonly kind: 'selectCards';
  /** Chosen instance ids; ORDER IS THE ANSWER when the choice is `ordered`. */
  readonly instanceIds: readonly InstanceId[];
}
export interface SelectPlayersAnswer {
  readonly kind: 'selectPlayers';
  readonly players: readonly PlayerId[];
}
export interface ChooseModesAnswer {
  readonly kind: 'chooseModes';
  readonly modeIds: readonly string[];
}
export interface ConfirmAnswer {
  readonly kind: 'confirm';
  readonly yes: boolean;
}

/** What an `answerChoice` action carries. Plain data — clones and serializes. */
export type ChoiceAnswer = SelectCardsAnswer | SelectPlayersAnswer | ChooseModesAnswer | ConfirmAnswer;

// --- normalisation ----------------------------------------------------------------

/**
 * How many options a choice offers (two for a yes/no) — one answer to that
 * question, used by the event log, the inspector dump, and anything else that
 * wants to describe a choice without unpacking its payload.
 */
export function choiceOptionCount(choice: PendingChoice): number {
  switch (choice.kind) {
    case 'selectCards':
      return choice.candidates.length;
    case 'selectPlayers':
      return choice.candidates.length;
    case 'chooseModes':
      return choice.modes.length;
    case 'confirm':
      return CONFIRM_OPTION_COUNT;
    default:
      return 0;
  }
}

/** A yes/no offers exactly two answers. Named so no bare `2` appears in logic. */
const CONFIRM_OPTION_COUNT = 2;

/** Resolve + clamp `{min,max}` so `0 <= min <= max <= optionCount` always holds. */
function normalizeCounts(request: ChoiceCountRequest, optionCount: number): { min: number; max: number } {
  const requestedMax = request.max ?? request.min ?? DEFAULT_CHOICE_COUNT;
  const requestedMin = request.min ?? requestedMax;
  const max = Math.max(0, Math.min(requestedMax, optionCount));
  const min = Math.max(0, Math.min(requestedMin, max));
  return { min, max };
}

/** With neither bound given, a selection asks for exactly one option. */
const DEFAULT_CHOICE_COUNT = 1;

/** Provenance stamped onto a normalised choice. */
export interface ChoiceSource {
  readonly id: number;
  readonly sourceInstanceId: InstanceId;
  readonly sourceName: string;
}

/**
 * Turn a request into a parkable {@link PendingChoice}, clamping the counts to the
 * options actually available. Returns `null` for a request whose `kind` this build
 * does not know — the caller degrades safely rather than crashing (a state written
 * by a newer build, or a hand-rolled request, must never take the engine down).
 */
export function normalizeChoiceRequest(request: ChoiceRequest, source: ChoiceSource): PendingChoice | null {
  const valence = request.valence ?? 'neutral';
  const base = {
    id: source.id,
    chooser: request.chooser,
    prompt: request.prompt,
    valence,
    sourceInstanceId: source.sourceInstanceId,
    sourceName: source.sourceName,
  };
  switch (request.kind) {
    case 'selectCards': {
      const { min, max } = normalizeCounts(request, request.candidates.length);
      return {
        ...base,
        kind: 'selectCards',
        candidates: [...request.candidates],
        ordered: request.ordered ?? false,
        min,
        max,
        ...(request.fromZone ? { fromZone: request.fromZone } : {}),
      };
    }
    case 'selectPlayers': {
      const { min, max } = normalizeCounts(request, request.candidates.length);
      return { ...base, kind: 'selectPlayers', candidates: [...request.candidates], min, max };
    }
    case 'chooseModes': {
      const { min, max } = normalizeCounts(request, request.modes.length);
      return { ...base, kind: 'chooseModes', modes: request.modes.map((m) => ({ id: m.id, label: m.label })), min, max };
    }
    case 'confirm':
      return { ...base, kind: 'confirm', min: 1, max: 1 };
    default:
      return null;
  }
}

// --- validation --------------------------------------------------------------------

/** The verdict on a submitted answer. */
export type AnswerValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const VALID: AnswerValidation = { ok: true };

function invalid(reason: string): AnswerValidation {
  return { ok: false, reason };
}

/** Shared count + duplicate + membership check for the list-shaped kinds. */
function validateSelection<T>(
  chosen: readonly T[],
  allowed: readonly T[],
  min: number,
  max: number,
  noun: string,
): AnswerValidation {
  if (!Array.isArray(chosen)) return invalid(`the ${noun} selection must be a list`);
  if (chosen.length < min) return invalid(`choose at least ${min} ${noun}(s)`);
  if (chosen.length > max) return invalid(`choose at most ${max} ${noun}(s)`);
  const seen = new Set<T>();
  for (const item of chosen) {
    if (seen.has(item)) return invalid(`${noun} ${String(item)} was chosen more than once`);
    seen.add(item);
    if (!allowed.includes(item)) return invalid(`${String(item)} is not one of the offered ${noun}s`);
  }
  return VALID;
}

/**
 * Whether an answer legally answers a choice. Rejection is CLEAN: the caller
 * refuses the action and leaves the pending choice exactly as it was, so a
 * malformed or hostile answer (the online server's wire is untrusted) can never
 * corrupt state or advance the game.
 */
export function validateChoiceAnswer(choice: PendingChoice, answer: ChoiceAnswer): AnswerValidation {
  if (!answer || typeof answer !== 'object') return invalid('the answer is not a choice answer');
  if (answer.kind !== choice.kind) return invalid(`expected a ${choice.kind} answer, got ${String(answer.kind)}`);
  switch (choice.kind) {
    case 'selectCards':
      return validateSelection(
        (answer as SelectCardsAnswer).instanceIds,
        choice.candidates.map((c) => c.instanceId),
        choice.min,
        choice.max,
        'card',
      );
    case 'selectPlayers':
      return validateSelection(
        (answer as SelectPlayersAnswer).players,
        choice.candidates,
        choice.min,
        choice.max,
        'player',
      );
    case 'chooseModes':
      return validateSelection(
        (answer as ChooseModesAnswer).modeIds,
        choice.modes.map((m) => m.id),
        choice.min,
        choice.max,
        'mode',
      );
    case 'confirm':
      return typeof (answer as ConfirmAnswer).yes === 'boolean' ? VALID : invalid('a yes/no answer must be a boolean');
    default:
      return invalid('unknown choice kind');
  }
}

// --- default / degraded answers ------------------------------------------------------

/**
 * A guaranteed-legal answer to any choice — the first `min` options, or "no".
 *
 * This is the engine's floor: it is what a choice degrades to when the chooser
 * cannot answer (the game ended under them, a state arrived from a newer build,
 * a primitive asked more questions than {@link MAX_CHOICES_PER_RESOLUTION}). It is
 * always legal because normalisation guarantees `min <= optionCount`, which is
 * exactly why an unanswerable choice cannot exist.
 */
export function defaultAnswerFor(choice: PendingChoice): ChoiceAnswer {
  switch (choice.kind) {
    case 'selectCards':
      return { kind: 'selectCards', instanceIds: choice.candidates.slice(0, choice.min).map((c) => c.instanceId) };
    case 'selectPlayers':
      return { kind: 'selectPlayers', players: choice.candidates.slice(0, choice.min) };
    case 'chooseModes':
      return { kind: 'chooseModes', modeIds: choice.modes.slice(0, choice.min).map((m) => m.id) };
    case 'confirm':
      // Declining is the no-op branch of "you may", so it is the safe default.
      return { kind: 'confirm', yes: false };
    default:
      return { kind: 'confirm', yes: false };
  }
}

/**
 * Whether a choice has exactly ONE legal answer, in which case asking is theatre:
 * the engine answers it itself (emitting `choiceAutoAnswered`) instead of stopping
 * the game to collect the only possible reply. This is also what makes a choice
 * whose objects have all left the zone resolve safely — zero candidates is the
 * degenerate single answer "none".
 */
export function isTrivialChoice(choice: PendingChoice): boolean {
  switch (choice.kind) {
    case 'selectCards':
      // With an order to pick there are `n!` answers, so only 0 or 1 card is trivial.
      if (choice.ordered && choice.max > 1) return false;
      return choice.min === choice.max && (choice.min === 0 || choice.min === choice.candidates.length);
    case 'selectPlayers':
      return choice.min === choice.max && (choice.min === 0 || choice.min === choice.candidates.length);
    case 'chooseModes':
      return choice.min === choice.max && (choice.min === 0 || choice.min === choice.modes.length);
    case 'confirm':
      return false;
    default:
      return true;
  }
}

/**
 * A hard ceiling on how many questions ONE resolution may ask. A primitive with a
 * bug (asking inside a loop whose condition its own answer never changes) would
 * otherwise wedge the game forever; instead the engine abandons the rest of that
 * resolution with an event. Generous: no real card comes close.
 */
export const MAX_CHOICES_PER_RESOLUTION = 32;

// --- answer enumeration (the AI / legal-action seam) ------------------------------

/**
 * How many candidate answers `generateLegalActions` will enumerate for one choice.
 *
 * Enumeration must be BOUNDED — "choose up to three of my twelve cards" has 299
 * subsets and an ordered pick has factorially many — but it must also never be
 * empty. So the engine offers a bounded, representative menu and `applyAction`
 * accepts ANY valid answer besides. That is the same contract combat already uses:
 * `declareAttackers` offers "attack with everyone" while the engine accepts any
 * legal subset a pilot constructs itself.
 */
export const MAX_ENUMERATED_CHOICE_ANSWERS = 24;

/**
 * Subsets of `items` sized `min..max`, in a stable order and capped at `limit`.
 * Deterministic: the same inputs always yield the same list in the same order (no
 * RNG, no iteration over a hash), which is what keeps a seeded sim reproducible.
 */
function boundedSubsets<T>(items: readonly T[], min: number, max: number, limit: number): T[][] {
  const out: T[][] = [];
  const current: T[] = [];
  const walk = (start: number): void => {
    if (out.length >= limit) return;
    if (current.length >= min) out.push([...current]);
    if (current.length >= max) return;
    for (let i = start; i < items.length; i++) {
      if (out.length >= limit) return;
      current.push(items[i] as T);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return out;
}

/**
 * The answers a pilot may pick from for a pending choice — always at least one.
 *
 * For an ORDERED selection we enumerate each subset in candidate order only; a
 * pilot that cares about the order (the heuristic does) constructs the permutation
 * it wants and submits it directly, exactly as it constructs its own block
 * assignments.
 */
export function enumerateChoiceAnswers(choice: PendingChoice): ChoiceAnswer[] {
  const limit = MAX_ENUMERATED_CHOICE_ANSWERS;
  switch (choice.kind) {
    case 'selectCards': {
      const ids = choice.candidates.map((c) => c.instanceId);
      const answers = boundedSubsets(ids, choice.min, choice.max, limit).map(
        (instanceIds): ChoiceAnswer => ({ kind: 'selectCards', instanceIds }),
      );
      return answers.length > 0 ? answers : [defaultAnswerFor(choice)];
    }
    case 'selectPlayers': {
      const answers = boundedSubsets(choice.candidates, choice.min, choice.max, limit).map(
        (players): ChoiceAnswer => ({ kind: 'selectPlayers', players }),
      );
      return answers.length > 0 ? answers : [defaultAnswerFor(choice)];
    }
    case 'chooseModes': {
      const ids = choice.modes.map((m) => m.id);
      const answers = boundedSubsets(ids, choice.min, choice.max, limit).map(
        (modeIds): ChoiceAnswer => ({ kind: 'chooseModes', modeIds }),
      );
      return answers.length > 0 ? answers : [defaultAnswerFor(choice)];
    }
    case 'confirm':
      return [
        { kind: 'confirm', yes: true },
        { kind: 'confirm', yes: false },
      ];
    default:
      return [defaultAnswerFor(choice)];
  }
}

/**
 * Copy an answer so nothing downstream aliases the caller's action object. An
 * answer arrives from outside the engine — a pilot, a UI, a network peer — and is
 * stored in both the event log and the suspended frame; sharing the array would
 * let a caller mutate history after the fact.
 */
export function cloneChoiceAnswer(answer: ChoiceAnswer): ChoiceAnswer {
  switch (answer.kind) {
    case 'selectCards':
      return { kind: 'selectCards', instanceIds: [...answer.instanceIds] };
    case 'selectPlayers':
      return { kind: 'selectPlayers', players: [...answer.players] };
    case 'chooseModes':
      return { kind: 'chooseModes', modeIds: [...answer.modeIds] };
    default:
      return { ...answer };
  }
}

/** A compact, log-friendly rendering of an answer (used by the event log/inspector). */
export function describeChoiceAnswer(answer: ChoiceAnswer): string {
  switch (answer.kind) {
    case 'selectCards':
      return answer.instanceIds.length === 0 ? 'no cards' : `cards [${answer.instanceIds.join(', ')}]`;
    case 'selectPlayers':
      return answer.players.length === 0 ? 'no players' : `players [${answer.players.join(', ')}]`;
    case 'chooseModes':
      return answer.modeIds.length === 0 ? 'no modes' : `modes [${answer.modeIds.join(', ')}]`;
    case 'confirm':
      return answer.yes ? 'yes' : 'no';
    default:
      return 'answer';
  }
}

// --- the suspended-resolution frame ------------------------------------------------

/**
 * A resolution caught mid-flight, so it can be finished later from plain data.
 *
 * When an effect asks a question, the resolution cannot simply continue — but nor
 * may it be thrown away: the spell is half-resolved and MUST finish (and end up in
 * the right zone) once the answer arrives. The frame is that bookmark: the effect
 * refs still to run, the answers already collected for the one in progress, and
 * the card in limbo between the stack and its destination.
 *
 * It is plain data for the same reason the choice is: it clones, serializes, and
 * replays. There is no continuation, no closure, no promise.
 */
export interface ResolutionFrame {
  /** A spell resolving, or a triggered ability. */
  readonly origin: 'spell' | 'trigger';
  readonly controller: PlayerId;
  /** Targets chosen when the object went on the stack. */
  readonly targets: ReadonlyArray<InstanceId | PlayerId>;
  /** Effect refs for this resolution; `next` indexes the one in progress. */
  effects: EffectRef[];
  next: number;
  /**
   * Answers collected for the effect ref at `next`, in ask order. Re-running that
   * ref replays its questions from here, so it reaches the point it stopped at
   * without asking again — the reason a primitive must ask BEFORE it mutates.
   */
  answers: ChoiceAnswer[];
  /** Questions asked across the whole frame; guards {@link MAX_CHOICES_PER_RESOLUTION}. */
  askCount: number;
  /** The spell card mid-resolution (absent for a trigger). */
  card?: CardInstance;
  /** Where that card goes when the resolution finishes. */
  resolvesTo?: 'battlefield' | 'graveyard';
  /** The ability's source permanent + label (trigger frames only). */
  sourceInstanceId?: InstanceId;
  label?: string;
}
