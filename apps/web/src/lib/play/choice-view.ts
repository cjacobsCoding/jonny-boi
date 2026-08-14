/**
 * The PURE view-model for answering a `PendingChoice` (DESIGN §3.11 "player choice
 * during resolution"). DOM-free and unit-tested, so the rules of "what may I pick
 * next / may I submit yet" live in one tested place and the React component is a
 * thin renderer over it.
 *
 * ## Why a draft, and why the draft is ordered
 * A `ChoiceAnswer` is the FINISHED answer; while the human is still clicking, the
 * partial selection is a {@link ChoiceDraft}. Keeping them separate is what makes
 * an illegal submit impossible: the component only ever offers Submit when
 * {@link draftStatus} reports the engine's own `validateChoiceAnswer` accepted the
 * draft's answer, so the button is dead until the answer is genuinely legal.
 *
 * The draft stores selections **in click order**, because for an `ordered` choice
 * the order IS the answer ("put them back on top in any order" — first picked =
 * first the effect uses = ends up on top). An unordered choice ignores the order,
 * so one representation serves both and there is no second "arrange" mode.
 *
 * ## Hidden information
 * A choice's `candidates` are a snapshot the engine deliberately hands to ONE seat
 * (`choice.chooser`) — Thoughtseize shows its victim's hand to the caster because
 * the card says so. This module never decides who may look; it exposes
 * {@link isChoiceForViewer} and the caller (PlayBoard) renders the prompt only for
 * the chooser, exactly as the masked board view already gates the hand.
 */
import {
  choiceOptionCount,
  validateChoiceAnswer,
  type AnswerValidation,
  type ChoiceAnswer,
  type ChoiceKind,
  type InstanceId,
  type PendingChoice,
  type PlayerId,
} from '@jonny-boi/core';

// --- labels (data, not inline strings scattered through the component) -------------

/** Human labels for the zone a card selection was drawn from (UI copy only). */
const ZONE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  hand: 'hand',
  library: 'library',
  graveyard: 'graveyard',
  exile: 'exile',
  battlefield: 'battlefield',
  command: 'command zone',
  stack: 'stack',
});

/** The noun each kind selects, used for counting hints ("choose 2 more cards"). */
const KIND_NOUNS: Readonly<Record<ChoiceKind, { one: string; many: string }>> = Object.freeze({
  selectCards: { one: 'card', many: 'cards' },
  selectPlayers: { one: 'player', many: 'players' },
  chooseModes: { one: 'mode', many: 'modes' },
  confirm: { one: 'answer', many: 'answers' },
});

/** A readable zone name, degrading to the raw id for a zone we have no copy for. */
export function zoneLabel(zone: string | undefined): string | undefined {
  return zone ? (ZONE_LABELS[zone] ?? zone) : undefined;
}

/** `n card` / `n cards`, from the kind's noun. */
function countNoun(kind: ChoiceKind, n: number): string {
  const noun = KIND_NOUNS[kind];
  return `${n} ${n === 1 ? noun.one : noun.many}`;
}

// --- the draft --------------------------------------------------------------------

/**
 * A partially-built answer. Mirrors {@link ChoiceAnswer} one-for-one except that a
 * `confirm` may still be undecided (`yes: null`), which is the state a yes/no is in
 * before the human has clicked either button.
 */
export type ChoiceDraft =
  | { readonly kind: 'selectCards'; readonly instanceIds: readonly InstanceId[] }
  | { readonly kind: 'selectPlayers'; readonly players: readonly PlayerId[] }
  | { readonly kind: 'chooseModes'; readonly modeIds: readonly string[] }
  | { readonly kind: 'confirm'; readonly yes: boolean | null };

/** The value one selectable option contributes to the draft. */
export type ChoiceOptionValue = InstanceId | PlayerId | string;

/** The empty draft for a choice — nothing picked yet. */
export function emptyDraft(choice: PendingChoice): ChoiceDraft {
  switch (choice.kind) {
    case 'selectCards':
      return { kind: 'selectCards', instanceIds: [] };
    case 'selectPlayers':
      return { kind: 'selectPlayers', players: [] };
    case 'chooseModes':
      return { kind: 'chooseModes', modeIds: [] };
    default:
      return { kind: 'confirm', yes: null };
  }
}

/** The picked values, in pick order (empty for an undecided confirm). */
export function draftValues(draft: ChoiceDraft): readonly ChoiceOptionValue[] {
  switch (draft.kind) {
    case 'selectCards':
      return draft.instanceIds;
    case 'selectPlayers':
      return draft.players;
    case 'chooseModes':
      return draft.modeIds;
    default:
      return [];
  }
}

/** Rebuild a draft of the same kind from a new ordered value list. */
function withValues(draft: ChoiceDraft, values: readonly ChoiceOptionValue[]): ChoiceDraft {
  switch (draft.kind) {
    case 'selectCards':
      return { kind: 'selectCards', instanceIds: values as readonly InstanceId[] };
    case 'selectPlayers':
      return { kind: 'selectPlayers', players: values as readonly PlayerId[] };
    case 'chooseModes':
      return { kind: 'chooseModes', modeIds: values as readonly string[] };
    default:
      return draft;
  }
}

/**
 * Click one option. Selected → deselect (and everything after it shuffles up one
 * position, which is what an ordered list must do). Not selected → append, so the
 * click order becomes the answer order.
 *
 * At the maximum, a **single**-pick choice REPLACES its selection (radio-button
 * feel — the overwhelmingly common case, "choose a card"), while a multi-pick
 * choice ignores the click and leaves the human to deselect something first. Either
 * way the draft can never exceed `max`, so it can never become unsubmittable by
 * over-picking.
 */
export function toggleOption(choice: PendingChoice, draft: ChoiceDraft, value: ChoiceOptionValue): ChoiceDraft {
  if (draft.kind === 'confirm') return draft;
  const values = draftValues(draft);
  const at = values.indexOf(value);
  if (at >= 0) return withValues(draft, values.filter((v) => v !== value));
  if (values.length >= choice.max) {
    if (choice.max === SINGLE_PICK) return withValues(draft, [value]);
    return draft;
  }
  return withValues(draft, [...values, value]);
}

/** A choice that takes exactly one option behaves like a radio group. */
const SINGLE_PICK = 1;

/** Set a yes/no draft's answer (a no-op on any other kind). */
export function setConfirm(draft: ChoiceDraft, yes: boolean): ChoiceDraft {
  return draft.kind === 'confirm' ? { kind: 'confirm', yes } : draft;
}

/** Clear every pick — the "choose none" path of a `may` selection. */
export function clearDraft(choice: PendingChoice, draft: ChoiceDraft): ChoiceDraft {
  return draft.kind === 'confirm' ? draft : emptyDraft(choice);
}

/**
 * The 1-based position of a value in an ORDERED draft, or `undefined` when the
 * value isn't picked (or the choice doesn't care about order). This is the badge
 * the UI stamps on a picked card so the human can see the order they built.
 */
export function orderBadge(choice: PendingChoice, draft: ChoiceDraft, value: ChoiceOptionValue): number | undefined {
  if (choice.kind !== 'selectCards' || !choice.ordered) return undefined;
  const at = draftValues(draft).indexOf(value);
  return at < 0 ? undefined : at + 1;
}

// --- submission -------------------------------------------------------------------

/** The finished answer a draft represents, or `null` while it is still undecided. */
export function draftToAnswer(draft: ChoiceDraft): ChoiceAnswer | null {
  switch (draft.kind) {
    case 'selectCards':
      return { kind: 'selectCards', instanceIds: [...draft.instanceIds] };
    case 'selectPlayers':
      return { kind: 'selectPlayers', players: [...draft.players] };
    case 'chooseModes':
      return { kind: 'chooseModes', modeIds: [...draft.modeIds] };
    default:
      return draft.yes === null ? null : { kind: 'confirm', yes: draft.yes };
  }
}

/** Whether a draft is legal, and (when it isn't) the engine's own reason. */
export interface DraftStatus {
  /** The answer to submit, or null when the draft is not yet a complete answer. */
  readonly answer: ChoiceAnswer | null;
  /** True only when the ENGINE's validator accepts the answer. */
  readonly canSubmit: boolean;
  /** What still has to happen ("choose 1 more card"), for the UI hint line. */
  readonly hint: string;
}

/**
 * Grade a draft with the engine's own {@link validateChoiceAnswer} — deliberately
 * NOT a re-implementation of the count rules, so the button can never disagree with
 * what `applyAction` will accept.
 */
export function draftStatus(choice: PendingChoice, draft: ChoiceDraft): DraftStatus {
  const answer = draftToAnswer(draft);
  if (!answer) return { answer: null, canSubmit: false, hint: 'Choose Yes or No.' };
  const verdict: AnswerValidation = validateChoiceAnswer(choice, answer);
  if (!verdict.ok) return { answer, canSubmit: false, hint: capitalize(verdict.reason) };
  return { answer, canSubmit: true, hint: readyHint(choice, draft) };
}

/** The hint shown once the draft is already legal (it may still take more picks). */
function readyHint(choice: PendingChoice, draft: ChoiceDraft): string {
  if (choice.kind === 'confirm') return 'Confirm your answer.';
  const picked = draftValues(draft).length;
  if (picked < choice.max) {
    const room = choice.max - picked;
    return `You may choose up to ${countNoun(choice.kind, room)} more.`;
  }
  return picked === 0 ? 'Choosing nothing is allowed here.' : 'Ready to confirm.';
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

// --- prompt copy ------------------------------------------------------------------

/** Everything the prompt header needs, resolved from ids to human text. */
export interface ChoicePromptView {
  readonly choiceId: number;
  readonly kind: ChoiceKind;
  /** The seat that must answer, as the human's chosen name. */
  readonly chooserName: string;
  /** The card/ability that asked. */
  readonly sourceName: string;
  readonly prompt: string;
  /** "Choose 2 cards from your graveyard" — the count + zone rule, spelled out. */
  readonly requirement: string;
  /** True when the answer order matters (the UI then numbers the picks). */
  readonly ordered: boolean;
  /** True when picking nothing is legal, so a decline control is offered. */
  readonly optional: boolean;
  readonly optionCount: number;
}

/**
 * Spell out the count rule in words. Every branch is derived from `min`/`max`, so
 * "exactly one", "up to two", "any number" and "two or three" all read correctly
 * without the card author writing UI copy.
 */
function requirementText(choice: PendingChoice): string {
  if (choice.kind === 'confirm') return 'Answer yes or no.';
  const { min, max, kind } = choice;
  const zone = choice.kind === 'selectCards' ? zoneLabel(choice.fromZone) : undefined;
  const suffix = zone ? ` from the ${zone}` : '';
  const orderNote = choice.kind === 'selectCards' && choice.ordered ? ' The order you pick is the order used.' : '';
  if (max === 0) return `Nothing can be chosen${suffix}.`;
  if (min === max) return `Choose exactly ${countNoun(kind, max)}${suffix}.${orderNote}`;
  if (min === 0) return `Choose up to ${countNoun(kind, max)}${suffix} — or none.${orderNote}`;
  return `Choose ${min}–${countNoun(kind, max)}${suffix}.${orderNote}`;
}

/** Build the prompt header for a pending choice. */
export function choicePromptView(
  choice: PendingChoice,
  names: Readonly<Record<PlayerId, string>>,
): ChoicePromptView {
  return {
    choiceId: choice.id,
    kind: choice.kind,
    chooserName: names[choice.chooser] ?? choice.chooser,
    sourceName: choice.sourceName,
    prompt: choice.prompt,
    requirement: requirementText(choice),
    ordered: choice.kind === 'selectCards' && choice.ordered,
    optional: choice.kind !== 'confirm' && choice.min === 0,
    optionCount: choiceOptionCount(choice),
  };
}

/**
 * Whether THIS viewer is the seat the choice was addressed to. The single guard the
 * UI uses before rendering any candidate — a choice's candidates may include cards
 * the other seat is not entitled to see, so a prompt shown to the wrong viewer is a
 * hidden-information leak, not merely a wrong button.
 */
export function isChoiceForViewer(choice: PendingChoice, viewer: PlayerId): boolean {
  return choice.chooser === viewer;
}

/**
 * The only two fields the waiting line needs. Typed as its own minimal shape rather
 * than as a whole `PendingChoice` because the seat that is NOT answering must never
 * be handed the full question: online it is sent a redacted summary carrying exactly
 * these two fields, and this signature is what lets the same copy render from it.
 */
export interface ChoiceWaitInfo {
  readonly chooser: PlayerId;
  readonly sourceName: string;
}

/** The waiting line shown to the seat that is NOT answering (leaks nothing). */
export function waitingForChoiceText(
  choice: ChoiceWaitInfo,
  names: Readonly<Record<PlayerId, string>>,
): string {
  return `Waiting for ${names[choice.chooser] ?? choice.chooser} to answer ${choice.sourceName}…`;
}
