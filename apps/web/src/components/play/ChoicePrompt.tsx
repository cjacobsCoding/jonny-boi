import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  defaultAnswerFor,
  formatManaCost,
  type CardDefinition,
  type ChoiceAnswer,
  type InstanceId,
  type PendingChoice,
  type PlayerId,
} from '@jonny-boi/core';
import {
  candidateBlock,
  choicePromptView,
  clearDraft,
  draftStatus,
  emptyDraft,
  optionBlockReason,
  orderBadge,
  payYesBlock,
  pickCount,
  setChooseNumber,
  setChosenValue,
  setConfirm,
  setPayLife,
  setPayMana,
  toggleOption,
  type ChoiceDraft,
  type ChoiceOptionValue,
} from '../../lib/play/choice-view.js';
import {
  annotateCardOptions,
  annotateTargetOptions,
  formatOwnerZone,
  type ZoneOfRef,
} from '../../lib/play/option-labels.js';
import { foldedMayPrompt } from '../../lib/play/optional-trigger.js';
import { CardHover } from '../CardHover.js';
import { PlayCard } from './PlayCard.js';
import './choice-prompt.css';

/**
 * The modal a human answers a {@link PendingChoice} in — the UI half of DESIGN
 * §3.11, rebuilt for §3.143 (UX-6, UX-7, UX-8). One component covers every kind
 * because the kinds differ only in what an "option" looks like (a card, a seat,
 * a mode, yes/no, pay/decline); the count rules, the ordering and the submit
 * gate are shared and live in the pure `choice-view` model.
 *
 * ## Four guarantees this component keeps
 *
 * 1. **An illegal answer cannot be submitted.** Confirm is disabled unless the
 *    ENGINE's `validateChoiceAnswer` (via `draftStatus`) accepts the draft, and
 *    the engine re-validates on `applyAction` regardless — the button is a
 *    courtesy, not the enforcement.
 * 2. **No hidden-information leak.** The caller renders this only for
 *    `choice.chooser` (see `isChoiceForViewer`); the candidate snapshots the
 *    engine put in the choice are exactly what the card reveals to that seat.
 * 3. **UX-6/UX-7 — the "may" is asked FIRST, and saying yes is reversible.**
 *    When `foldedMayPrompt` recognises a "you may &lt;do X to&gt; target Y" source,
 *    the prompt opens on the QUESTION and reveals the target picker only after
 *    the player accepts. Nothing is sent to the engine until the final Confirm,
 *    so "Change my mind" is free and idempotent, however many times it is used.
 *    See the rules note on the stage machine below for why this is a
 *    presentation change and not a rules change.
 * 4. **UX-8 — every card in the question is a CARD.** The source that provoked
 *    the choice renders its real face, and so does every candidate, each
 *    hoverable to full size through the shared `CardHover` funnel. A candidate
 *    that cannot be taken says WHY (`candidateBlock`) instead of being a greyed
 *    rectangle. Anything with no art — a token, an emblem, a Scryfall miss, a
 *    seat — degrades to a NAMED placeholder, never a blank box.
 */
export function ChoicePrompt({
  choice,
  names,
  onAnswer,
  zoneOf,
  sourceDef,
  cardIdOf,
  onFoldedMay,
}: {
  choice: PendingChoice;
  names: Readonly<Record<PlayerId, string>>;
  /** Submit the finished answer through the session's `answerChoice` action. */
  onAnswer: (answer: ChoiceAnswer) => void;
  /**
   * The definition of the object that asked, resolved by the board from
   * `choice.sourceInstanceId` (only the board can resolve an instance id). Two
   * jobs, one prop: it is the face shown at the top of the prompt (UX-8) and it
   * is what {@link foldedMayPrompt} reads to decide whether this question is
   * really a "you may" in disguise (UX-6). Absent for a source the board cannot
   * find — a token, an emblem, the online board's masked view — and the prompt
   * then shows a named placeholder and offers no fold.
   */
  sourceDef?: CardDefinition | null;
  /**
   * Resolve a TARGET candidate's card id, so target rows can render real faces.
   * `selectTargets` candidates carry only `{ref, name, controller}` — core's
   * `TargetOption` has no `cardId` — so the board supplies this from the same
   * PUBLIC-zone index it builds for {@link zoneOf}. Without it, target rows
   * degrade to named placeholders rather than guessing at art.
   */
  cardIdOf?: (ref: InstanceId | PlayerId) => string | null | undefined;
  /**
   * Answer a FOLDED "may" (UX-6). `yes` is what the player said to the question;
   * `answer` is the target answer to submit for it. The board submits `answer`
   * and REMEMBERS `yes` in its deferred-may ledger, because the engine parks the
   * "may" a full priority round later (see `optional-trigger.ts`).
   *
   * The fold is offered ONLY when this is wired: without a ledger, declining
   * would answer the targets and then let the "may" modal pop up anyway, which
   * is the exact bug being fixed. An unwired board gets the engine's own
   * ordering — an honest refusal, not a half-fold.
   */
  onFoldedMay?: (yes: boolean, answer: ChoiceAnswer) => void;
  /**
   * Resolve where a TARGET candidate publicly sits (battlefield / graveyard /
   * stack), built by the board from PUBLIC zones only — see `makeRefIndex`.
   * Optional: without it target rows still carry their owner, just no zone.
   */
  zoneOf?: ZoneOfRef;
}): ReactElement {
  const [draft, setDraft] = useState<ChoiceDraft>(() => emptyDraft(choice));
  /**
   * The fold's stage. `false` = the player has not yet said yes to the "may", so
   * the target picker is not shown. Local state, never sent anywhere: that is
   * precisely what makes "Change my mind" cost nothing (UX-7).
   */
  const [mayAccepted, setMayAccepted] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  /**
   * A follow-up question (a modal spell asking its second question) replaces the
   * choice IN PLACE, so the draft and the fold's stage reset with it — keyed on
   * the choice id, which is what uniquely identifies a question. A re-render
   * with an equivalent choice OBJECT must not wipe a half-built selection.
   *
   * This is React's own "adjust state when a prop changes" pattern rather than
   * an effect: the reset happens before anything is painted, so no frame is ever
   * rendered with the previous question's half-built answer under the new
   * question's prompt. The effect version needed a ref written during render to
   * dodge its own dependency list, which the lint rule correctly objects to.
   */
  const [askedChoiceId, setAskedChoiceId] = useState(choice.id);
  if (askedChoiceId !== choice.id) {
    setAskedChoiceId(choice.id);
    setDraft(emptyDraft(choice));
    setMayAccepted(false);
  }

  // The dialog is mandatory (there is no Escape out of a rules obligation), so
  // move focus INTO it: a keyboard player must not have to tab out of whatever
  // they last touched on the board to reach a question that is blocking the game.
  useEffect(() => {
    cardRef.current?.querySelector('button')?.focus();
  }, [choice.id]);

  const view = useMemo(() => choicePromptView(choice, names), [choice, names]);
  /**
   * ⚠️ THE FOLD IS GATED ON `onFoldedMay` BEING WIRED, on purpose. See the prop's
   * doc: a decline with nowhere to record the answer is worse than no fold.
   *
   * Computed on every render rather than memoised: the only argument that could
   * key a memo is `onFoldedMay`, which a caller will normally pass as an inline
   * arrow, so the cache would miss every time AND the dependency list would be
   * claiming a stability the prop does not have. `abilitySourcesOf` memoises the
   * expensive half per definition, and this is a modal a player opens a handful
   * of times a turn.
   */
  const fold = onFoldedMay ? foldedMayPrompt(choice, sourceDef) : null;
  const askingTheMay = fold !== null && !mayAccepted;
  const status = draftStatus(choice, draft);
  const sourceCardId = sourceDef?.id;

  const pick = (value: ChoiceOptionValue): void => setDraft((d) => toggleOption(choice, d, value));

  const submit = (): void => {
    if (!status.answer || !status.canSubmit) return;
    // A folded question routes its answer through `onFoldedMay` so the board can
    // pair the remembered "yes" with the targets that were actually submitted —
    // the ledger's discriminator when one permanent has two triggers waiting.
    if (fold && onFoldedMay) onFoldedMay(true, status.answer);
    else onAnswer(status.answer);
  };

  /** Submit "none" directly — the decline branch of a `may` selection. */
  const declineAll = (): void => {
    const cleared = clearDraft(choice, draft);
    const verdict = draftStatus(choice, cleared);
    if (verdict.answer && verdict.canSubmit) onAnswer(verdict.answer);
  };

  /**
   * "No, don't use it."
   *
   * The engine still demands a target — CR 603.3d chose one as the ability went
   * on the stack, and no answer at all is not a legal reply — so the ENGINE's
   * own `defaultAnswerFor` supplies it. Which legal target it picks cannot
   * matter: the "may" is about to be answered no, so nothing happens to it.
   * Using the engine's default rather than inventing one keeps a single answer
   * to "what does 'no choice made' mean here".
   */
  const declineMay = (): void => {
    onFoldedMay?.(false, defaultAnswerFor(choice));
  };

  return (
    <div className="choice-prompt" role="dialog" aria-modal="true" aria-label={`${view.sourceName}: ${view.prompt}`}>
      <div className="choice-prompt__card" ref={cardRef}>
        <header className="choice-prompt__head choice-prompt__head--faced">
          <SourceFace cardId={sourceCardId} name={view.sourceName} />
          <div className="choice-prompt__headtext">
            <span className="choice-prompt__who">{view.chooserName} must choose</span>
            <h3 className="choice-prompt__title">{askingTheMay && fold ? fold.mayPrompt : view.prompt}</h3>
            <p className="choice-prompt__source">
              asked by <strong>{view.sourceName}</strong>
            </p>
            <p className="choice-prompt__requirement">
              {askingTheMay ? MAY_FIRST_REQUIREMENT : view.requirement}
            </p>
          </div>
        </header>

        <div className="choice-prompt__options">
          {askingTheMay ? null : (
            <>
              {choice.kind === 'selectCards' && (
                <CardOptions choice={choice} draft={draft} names={names} onPick={pick} />
              )}
              {choice.kind === 'selectPlayers' && (
                <PlayerOptions choice={choice} draft={draft} names={names} onPick={pick} />
              )}
              {choice.kind === 'chooseModes' && <ModeOptions choice={choice} draft={draft} onPick={pick} />}
              {choice.kind === 'selectTargets' && (
                <TargetOptions
                  choice={choice}
                  draft={draft}
                  names={names}
                  onPick={pick}
                  zoneOf={zoneOf}
                  cardIdOf={cardIdOf}
                />
              )}
              {choice.kind === 'confirm' && (
                <BinaryOptions
                  chosen={draft.kind === 'confirm' ? draft.yes : null}
                  labels={CONFIRM_LABELS}
                  onSet={(yes) => setDraft((d) => setConfirm(d, yes))}
                />
              )}
              {choice.kind === 'payMana' && (
                <BinaryOptions
                  chosen={draft.kind === 'payMana' ? draft.pay : null}
                  labels={{ yes: `Pay ${formatManaCost(choice.cost)}`, no: 'Don’t pay' }}
                  // The engine only ever parks an UNAFFORDABLE payment when a state was
                  // hand-built, but a Pay button that cannot be honoured would still be
                  // a lie — so it says WHY instead of merely going grey.
                  yesBlockedBecause={blockText(choice)}
                  onSet={(pay) => setDraft((d) => setPayMana(d, pay))}
                />
              )}
              {choice.kind === 'payLife' && (
                <BinaryOptions
                  chosen={draft.kind === 'payLife' ? draft.pay : null}
                  labels={{ yes: `Pay ${choice.amount} life`, no: 'Enter tapped' }}
                  yesBlockedBecause={blockText(choice)}
                  onSet={(pay) => setDraft((d) => setPayLife(d, pay))}
                />
              )}
              {choice.kind === 'chooseValue' && (
                <NameableValueOptions
                  choice={choice}
                  chosen={draft.kind === 'chooseValue' ? draft.value : null}
                  onSet={(value) => setDraft((d) => setChosenValue(d, value))}
                />
              )}
              {choice.kind === 'chooseNumber' && (
                <NumberOptions
                  min={choice.min}
                  max={choice.max}
                  chosen={draft.kind === 'chooseNumber' ? draft.value : null}
                  onSet={(value) => setDraft((d) => setChooseNumber(d, value))}
                />
              )}
            </>
          )}
        </div>

        <footer className="choice-prompt__foot">
          <span className="choice-prompt__hint" role="status">
            {askingTheMay ? MAY_FIRST_HINT : status.hint}
          </span>
          <div className="choice-prompt__actions">
            {askingTheMay && fold ? (
              <>
                <button type="button" className="btn btn--ghost" onClick={declineMay}>
                  {fold.declineLabel}
                </button>
                <button type="button" className="btn btn--primary" onClick={() => setMayAccepted(true)}>
                  {fold.acceptLabel}
                </button>
              </>
            ) : (
              <>
                {view.optional && (
                  <button type="button" className="btn btn--ghost" onClick={declineAll}>
                    Choose none
                  </button>
                )}
                {/* UX-7 — the yes stays reversible right up to Confirm, because
                    nothing has been sent to the engine yet. */}
                {fold && (
                  <button type="button" className="btn btn--ghost" onClick={() => setMayAccepted(false)}>
                    {fold.backLabel}
                  </button>
                )}
                <button type="button" className="btn btn--primary" onClick={submit} disabled={!status.canSubmit}>
                  Confirm
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

/** The copy for the stage-one "may" question, named rather than inlined. */
const MAY_FIRST_REQUIREMENT =
  'Decide whether to use it first — you are asked for targets only if you say yes, and you can change your mind after seeing them.';
const MAY_FIRST_HINT = 'Nothing has been chosen yet.';

/** The reason a payment's Pay button is unavailable, or undefined when it is fine. */
function blockText(choice: PendingChoice): string | undefined {
  const blocked = payYesBlock(choice);
  return blocked === null ? undefined : optionBlockReason(blocked, choice);
}

/**
 * The card that provoked the question, shown as a real face (UX-8: *"it should
 * be showing the actual card that is provoking the choice - not just the card
 * name"*). Hoverable to full size through the shared funnel, like every other
 * card on the board.
 *
 * With no resolvable card — a token, an emblem, a Scryfall miss, the online
 * board's masked view — it degrades to a NAMED placeholder. A blank rectangle
 * where the card should be is the one outcome worse than the name alone.
 */
function SourceFace({ cardId, name }: { cardId?: string; name: string }): ReactElement {
  if (!cardId) {
    return (
      <div className="choice-source choice-source--nameonly" aria-label={name}>
        <span className="choice-source__placeholder">{name}</span>
      </div>
    );
  }
  return (
    <CardHover cardId={cardId} className="choice-source">
      <PlayCard cardId={cardId} name={name} face="full" />
    </CardHover>
  );
}

/**
 * One candidate, as a card. The wrapper carries the owner/zone note, the
 * selection state and — when the option cannot be taken right now — the reason,
 * which is both visible and the card's tooltip.
 *
 * ⚠️ A blocked option is NOT rendered `disabled`. A disabled button emits no
 * pointer events in any browser, which would take the hover preview away from
 * exactly the card whose situation the player most needs to inspect. The click
 * is already a no-op (`toggleOption` refuses it), so the button stays live and
 * the prompt explains itself instead.
 */
function CandidateCard({
  cardId,
  name,
  note,
  selected,
  badge,
  blockedBecause,
  onClick,
}: {
  cardId?: string | null;
  name: string;
  note?: string;
  selected: boolean;
  badge?: string;
  blockedBecause?: string;
  onClick: () => void;
}): ReactElement {
  const className = `choice-card-opt${selected ? ' choice-card-opt--selected' : ''}${
    blockedBecause ? ' choice-card-opt--blocked' : ''
  }`;
  const face: ReactNode = cardId ? (
    <CardHover cardId={cardId}>
      <PlayCard
        cardId={cardId}
        name={name}
        face="full"
        selected={selected}
        badge={badge}
        reason={blockedBecause}
        onClick={onClick}
      />
    </CardHover>
  ) : (
    <button
      type="button"
      className={`choice-card-opt__placeholder${selected ? ' choice-card-opt__placeholder--selected' : ''}`}
      aria-pressed={selected}
      title={blockedBecause ? `${name} — ${blockedBecause}` : name}
      onClick={onClick}
    >
      <span className="choice-card-opt__placeholder-name">{name}</span>
      {badge && <span className="choice-card-opt__placeholder-badge">{badge}</span>}
    </button>
  );
  return (
    <div className={className}>
      {face}
      {note && <span className="choice-card-opt__meta">{note}</span>}
      {blockedBecause && <span className="choice-card-opt__why">{blockedBecause}</span>}
    </div>
  );
}

/**
 * The candidate cards. Every card carries an OWNER line ("yours" /
 * "Computer’s"), and a ZONE when the candidates span zones — Angel of Serenity
 * offers battlefield creatures beside graveyard cards, and rows that don't say
 * which is which were §3.57's report 1. The facts come from the choice's own
 * candidate snapshots (`option-labels`), never from a lookup that could reach
 * hidden zones.
 *
 * Badged with its 1-based position when the choice is ORDERED, because the
 * sequence the human is building is literally the answer.
 */
function CardOptions({
  choice,
  draft,
  names,
  onPick,
}: {
  choice: Extract<PendingChoice, { kind: 'selectCards' }>;
  draft: ChoiceDraft;
  names: Readonly<Record<PlayerId, string>>;
  onPick: (value: ChoiceOptionValue) => void;
}): ReactElement {
  if (choice.candidates.length === 0) {
    return <p className="choice-prompt__empty">No cards to choose from.</p>;
  }
  const notes = annotateCardOptions(choice.candidates, choice.chooser, names);
  return (
    <div className="choice-prompt__cards">
      {choice.candidates.map((c, index) => {
        const order = orderBadge(choice, draft, c.instanceId);
        const note = notes[index];
        const blocked = candidateBlock(choice, draft, c.instanceId);
        return (
          <CandidateCard
            key={c.instanceId}
            cardId={c.cardId}
            name={c.name}
            note={note ? formatOwnerZone(note) : undefined}
            selected={pickCount(draft, c.instanceId) > 0}
            badge={order !== undefined ? `#${order}` : undefined}
            blockedBecause={blocked ? optionBlockReason(blocked, choice) : undefined}
            onClick={() => onPick(c.instanceId)}
          />
        );
      })}
    </div>
  );
}

/** The candidate seats, by the humans' chosen names. */
function PlayerOptions({
  choice,
  draft,
  names,
  onPick,
}: {
  choice: Extract<PendingChoice, { kind: 'selectPlayers' }>;
  draft: ChoiceDraft;
  names: Readonly<Record<PlayerId, string>>;
  onPick: (value: ChoiceOptionValue) => void;
}): ReactElement {
  const picked = new Set(draft.kind === 'selectPlayers' ? draft.players : []);
  return (
    <div className="choice-prompt__list">
      {choice.candidates.map((p) => {
        const blocked = candidateBlock(choice, draft, p);
        const why = blocked ? optionBlockReason(blocked, choice) : undefined;
        return (
          <button
            key={p}
            type="button"
            className={`choice-option${picked.has(p) ? ' choice-option--selected' : ''}${
              why ? ' choice-option--blocked' : ''
            }`}
            aria-pressed={picked.has(p)}
            title={why}
            onClick={() => onPick(p)}
          >
            {names[p] ?? p}
            {why && <span className="choice-option__note"> — {why}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The modes of a modal spell — "choose two —" is `min = max = 2` over this list.
 * The question is asked while the spell is being CAST, so what the human sees
 * here is the menu of modes this board actually lets them announce.
 */
function ModeOptions({
  choice,
  draft,
  onPick,
}: {
  choice: Extract<PendingChoice, { kind: 'chooseModes' }>;
  draft: ChoiceDraft;
  onPick: (value: ChoiceOptionValue) => void;
}): ReactElement {
  return (
    <div className="choice-prompt__list">
      {choice.modes.map((m) => {
        // A repeated-modes choice can hold the SAME mode several times, and how
        // many is part of the answer — so the count is shown, not just whether
        // the mode is selected at all.
        const times = pickCount(draft, m.id);
        const blocked = candidateBlock(choice, draft, m.id);
        const why = blocked ? optionBlockReason(blocked, choice) : undefined;
        return (
          <button
            key={m.id}
            type="button"
            className={`choice-option${times > 0 ? ' choice-option--selected' : ''}${
              why ? ' choice-option--blocked' : ''
            }`}
            aria-pressed={times > 0}
            title={why}
            onClick={() => onPick(m.id)}
          >
            {m.label}
            {times > 1 ? ` ×${times}` : ''}
            {why && <span className="choice-option__note"> — {why}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The values a permanent may NAME as it enters — "As Cavern of Souls enters,
 * choose a creature type."
 *
 * A radio group, not a multi-select: exactly one value is named, and naming it
 * is not optional (there is no "choose none" button on this prompt, because
 * declining is the engine's floor for a seat that cannot answer, never a move a
 * human should be offered).
 *
 * The list can be long — a creature-type menu is as long as the deck is varied —
 * so it scrolls inside the prompt rather than pushing the Confirm button off the
 * card. The engine never raises this question with an empty menu (it settles
 * that case itself), but the empty branch is rendered anyway: a hand-built or
 * replayed state must show a readable dialog, not an empty box with a dead
 * button.
 */
function NameableValueOptions({
  choice,
  chosen,
  onSet,
}: {
  choice: Extract<PendingChoice, { kind: 'chooseValue' }>;
  chosen: string | null;
  onSet: (value: string) => void;
}): ReactElement {
  if (choice.options.length === 0) {
    return <p className="choice-prompt__empty">There is nothing to name.</p>;
  }
  return (
    <div className="choice-prompt__list choice-prompt__list--scroll">
      {choice.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`choice-option${chosen === option.value ? ' choice-option--selected' : ''}`}
          aria-pressed={chosen === option.value}
          onClick={() => onSet(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * What a spell or ability is being pointed at — as CARDS (UX-8), not a list of
 * names.
 *
 * A target may be a PLAYER as well as a permanent, and core's `TargetOption`
 * carries no `cardId` at all, so the face comes from the board's public-zone
 * index via {@link ChoicePrompt}'s `cardIdOf`. Both absences degrade the same
 * way — a named placeholder tile — because a seat has no card to draw and a
 * token has no art, and neither is a reason to show an empty rectangle.
 *
 * §3.57 report 1: the note used to print the RAW seat id ("(A)"), which told the
 * player nothing. Every row now says whose the thing is in words ("yours" /
 * "Computer’s"), plus WHERE it sits when the candidates span zones or come from
 * somewhere other than the battlefield.
 */
function TargetOptions({
  choice,
  draft,
  names,
  onPick,
  zoneOf,
  cardIdOf,
}: {
  choice: Extract<PendingChoice, { kind: 'selectTargets' }>;
  draft: ChoiceDraft;
  names: Readonly<Record<PlayerId, string>>;
  onPick: (value: ChoiceOptionValue) => void;
  zoneOf?: ZoneOfRef;
  cardIdOf?: (ref: InstanceId | PlayerId) => string | null | undefined;
}): ReactElement {
  if (choice.candidates.length === 0) {
    return <p className="choice-prompt__empty">Nothing legal to point at.</p>;
  }
  const notes = annotateTargetOptions(choice.candidates, choice.chooser, names, zoneOf);
  return (
    <div className="choice-prompt__cards">
      {choice.candidates.map((candidate, index) => {
        const note = notes[index];
        const noteText =
          note === 'player' ? 'player' : note !== undefined ? formatOwnerZone(note) : undefined;
        // A seat candidate renders by its DISPLAY name — the engine's snapshot
        // says "Player B", which is the id, not the human.
        const label =
          note === 'player' ? (names[candidate.ref as PlayerId] ?? candidate.name) : candidate.name;
        const blocked = candidateBlock(choice, draft, candidate.ref);
        return (
          <CandidateCard
            key={String(candidate.ref)}
            cardId={note === 'player' ? undefined : cardIdOf?.(candidate.ref)}
            name={label}
            note={noteText}
            selected={pickCount(draft, candidate.ref) > 0}
            blockedBecause={blocked ? optionBlockReason(blocked, choice) : undefined}
            onClick={() => onPick(candidate.ref)}
          />
        );
      })}
    </div>
  );
}

/**
 * The two BINARY kinds — a yes/no and a pay/decline — share one control. Only the
 * button copy differs, so the labels are a prop rather than a second component
 * whose selection and submit wiring could drift from this one. Still routed
 * through Confirm so every kind commits the same way.
 *
 * A blocked "yes" stays clickable-looking but says why, for the same reason a
 * blocked candidate does: a dead control with no explanation reads as a bug.
 */
function BinaryOptions({
  chosen,
  labels,
  yesBlockedBecause,
  onSet,
}: {
  chosen: boolean | null;
  labels: { readonly yes: string; readonly no: string };
  yesBlockedBecause?: string;
  onSet: (yes: boolean) => void;
}): ReactElement {
  return (
    <div className="choice-prompt__list choice-prompt__list--inline">
      <button
        type="button"
        className={`choice-option${chosen === true ? ' choice-option--selected' : ''}${
          yesBlockedBecause ? ' choice-option--blocked' : ''
        }`}
        aria-pressed={chosen === true}
        disabled={Boolean(yesBlockedBecause)}
        title={yesBlockedBecause}
        onClick={() => onSet(true)}
      >
        {labels.yes}
      </button>
      <button
        type="button"
        className={`choice-option${chosen === false ? ' choice-option--selected' : ''}`}
        aria-pressed={chosen === false}
        onClick={() => onSet(false)}
      >
        {labels.no}
      </button>
      {yesBlockedBecause && <span className="choice-option__note">{yesBlockedBecause}</span>}
    </div>
  );
}

/**
 * The values a choose-a-number question offers ("choose a value for X"), one
 * button per value. The range comes from the engine, which bounded it by what
 * the board can actually pay, so every button here is a legal, fundable answer
 * — no button ever needs disabling.
 */
function NumberOptions({
  min,
  max,
  chosen,
  onSet,
}: {
  min: number;
  max: number;
  chosen: number | null;
  onSet: (value: number) => void;
}): ReactElement {
  const values: number[] = [];
  for (let value = min; value <= max; value++) values.push(value);
  return (
    <div className="choice-prompt__list choice-prompt__list--inline">
      {values.map((value) => (
        <button
          key={value}
          type="button"
          className={`choice-option${chosen === value ? ' choice-option--selected' : ''}`}
          aria-pressed={chosen === value}
          onClick={() => onSet(value)}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

/** The plain yes/no copy, named so the component body reads as data + wiring. */
const CONFIRM_LABELS = Object.freeze({ yes: 'Yes', no: 'No' });
