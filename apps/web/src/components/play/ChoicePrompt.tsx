import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { formatManaCost, type ChoiceAnswer, type PendingChoice, type PlayerId } from '@jonny-boi/core';
import {
  choicePromptView,
  clearDraft,
  draftStatus,
  emptyDraft,
  orderBadge,
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
import { PlayCard } from './PlayCard.js';

/**
 * The modal a human answers a {@link PendingChoice} in — the UI half of DESIGN
 * §3.11. One component covers every kind because the kinds differ only in what an
 * "option" looks like (a card, a seat, a mode, yes/no, pay/decline); the count
 * rules, the ordering and the submit gate are shared and live in the pure
 * `choice-view` model.
 *
 * ## Two guarantees this component keeps
 * 1. **An illegal answer cannot be submitted.** Confirm is disabled unless the
 *    ENGINE's `validateChoiceAnswer` (via `draftStatus`) accepts the draft, and the
 *    engine re-validates on `applyAction` regardless — the button is a courtesy,
 *    not the enforcement.
 * 2. **No hidden-information leak.** The caller renders this only for
 *    `choice.chooser` (see `isChoiceForViewer`); the candidate snapshots the engine
 *    put in the choice are exactly what the card reveals to that one seat.
 */
export function ChoicePrompt({
  choice,
  names,
  onAnswer,
  zoneOf,
}: {
  choice: PendingChoice;
  names: Readonly<Record<PlayerId, string>>;
  /** Submit the finished answer through the session's `answerChoice` action. */
  onAnswer: (answer: ChoiceAnswer) => void;
  /**
   * Resolve where a TARGET candidate publicly sits (battlefield / graveyard /
   * stack), built by the board from PUBLIC zones only — see `makeRefIndex`.
   * Optional: without it target rows still carry their owner, just no zone.
   */
  zoneOf?: ZoneOfRef;
}): ReactElement {
  const [draft, setDraft] = useState<ChoiceDraft>(() => emptyDraft(choice));
  const cardRef = useRef<HTMLDivElement>(null);
  // The live choice, read inside the effect below so the effect depends on the
  // choice ID ALONE — a re-render with an equivalent choice object must not wipe a
  // half-built selection, only a genuinely new question may.
  const currentChoice = useRef(choice);
  currentChoice.current = choice;

  // A follow-up question (a modal spell asking its second question) replaces the
  // choice in place, so the draft resets with it — keyed on the choice id, which
  // is what uniquely identifies a question.
  useEffect(() => {
    setDraft(emptyDraft(currentChoice.current));
    // The dialog is mandatory (there is no Escape out of a rules obligation), so
    // move focus INTO it: a keyboard player must not have to tab out of whatever
    // they last touched on the board to reach a question that is blocking the game.
    cardRef.current?.querySelector('button')?.focus();
  }, [choice.id]);

  const view = useMemo(() => choicePromptView(choice, names), [choice, names]);
  const status = draftStatus(choice, draft);

  const pick = (value: ChoiceOptionValue): void => setDraft((d) => toggleOption(choice, d, value));

  const submit = (): void => {
    if (status.answer && status.canSubmit) onAnswer(status.answer);
  };

  /** Submit "none" directly — the decline branch of a `may` selection. */
  const declineAll = (): void => {
    const cleared = clearDraft(choice, draft);
    const verdict = draftStatus(choice, cleared);
    if (verdict.answer && verdict.canSubmit) onAnswer(verdict.answer);
  };

  return (
    <div className="choice-prompt" role="dialog" aria-modal="true" aria-label={`${view.sourceName}: ${view.prompt}`}>
      <div className="choice-prompt__card" ref={cardRef}>
        <header className="choice-prompt__head">
          <span className="choice-prompt__who">{view.chooserName} must choose</span>
          <h3 className="choice-prompt__title">{view.prompt}</h3>
          <p className="choice-prompt__source">
            asked by <strong>{view.sourceName}</strong>
          </p>
          <p className="choice-prompt__requirement">{view.requirement}</p>
        </header>

        <div className="choice-prompt__options">
          {choice.kind === 'selectCards' && (
            <CardOptions choice={choice} draft={draft} names={names} onPick={pick} />
          )}
          {choice.kind === 'selectPlayers' && (
            <PlayerOptions choice={choice} draft={draft} names={names} onPick={pick} />
          )}
          {choice.kind === 'chooseModes' && <ModeOptions choice={choice} draft={draft} onPick={pick} />}
          {choice.kind === 'selectTargets' && (
            <TargetOptions choice={choice} draft={draft} names={names} onPick={pick} zoneOf={zoneOf} />
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
              // a lie, so it is disabled rather than left to fail on submit.
              yesDisabled={!choice.affordable}
              onSet={(pay) => setDraft((d) => setPayMana(d, pay))}
            />
          )}
          {choice.kind === 'payLife' && (
            <BinaryOptions
              chosen={draft.kind === 'payLife' ? draft.pay : null}
              labels={{ yes: `Pay ${choice.amount} life`, no: 'Enter tapped' }}
              yesDisabled={!choice.affordable}
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
        </div>

        <footer className="choice-prompt__foot">
          <span className="choice-prompt__hint" role="status">
            {status.hint}
          </span>
          <div className="choice-prompt__actions">
            {view.optional && (
              <button type="button" className="btn btn--ghost" onClick={declineAll}>
                Choose none
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary"
              onClick={submit}
              disabled={!status.canSubmit}
            >
              Confirm
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * The candidate cards. Reuses the shared `PlayCard` chip (same Scryfall art as the
 * hand and stack), badged with its 1-based position when the choice is ORDERED so
 * the human can see the sequence they are building — which is literally the answer.
 *
 * Every card carries an OWNER line ("yours" / "Computer’s"), and a ZONE when the
 * candidates span zones — Angel of Serenity offers battlefield creatures beside
 * graveyard cards, and rows that don't say which is which were §3.57's report 1.
 * The facts come from the choice's own candidate snapshots (`option-labels`),
 * never from a lookup that could reach hidden zones.
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
  const picked = new Set(draft.kind === 'selectCards' ? draft.instanceIds : []);
  if (choice.candidates.length === 0) {
    return <p className="choice-prompt__empty">No cards to choose from.</p>;
  }
  const notes = annotateCardOptions(choice.candidates, choice.chooser, names);
  return (
    <div className="choice-prompt__cards">
      {choice.candidates.map((c, index) => {
        const order = orderBadge(choice, draft, c.instanceId);
        const note = notes[index];
        return (
          <div key={c.instanceId} className="choice-card-opt">
            <PlayCard
              cardId={c.cardId}
              name={c.name}
              selected={picked.has(c.instanceId)}
              badge={order !== undefined ? `#${order}` : undefined}
              onClick={() => onPick(c.instanceId)}
            />
            {note && (
              <span
                className={`choice-card-opt__meta${note.owner === 'yours' ? ' choice-card-opt__meta--yours' : ''}`}
              >
                {formatOwnerZone(note)}
              </span>
            )}
          </div>
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
      {choice.candidates.map((p) => (
        <button
          key={p}
          type="button"
          className={`choice-option${picked.has(p) ? ' choice-option--selected' : ''}`}
          aria-pressed={picked.has(p)}
          onClick={() => onPick(p)}
        >
          {names[p] ?? p}
        </button>
      ))}
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
        return (
          <button
            key={m.id}
            type="button"
            className={`choice-option${times > 0 ? ' choice-option--selected' : ''}`}
            aria-pressed={times > 0}
            onClick={() => onPick(m.id)}
          >
            {m.label}
            {times > 1 ? ` ×${times}` : ''}
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
 * What a triggered ability is being pointed at. A target may be a PLAYER as well
 * as a permanent, which is why this renders the choice's own `TargetOption`
 * snapshots (name + controller) rather than reusing the card chips: there is no
 * card to draw for "Player B".
 *
 * §3.57 report 1: the note used to print the RAW seat id ("(A)"), which told the
 * player nothing. Every row now says whose the thing is in words ("yours" /
 * "Computer’s"), plus WHERE it sits when the candidates span zones or come from
 * somewhere other than the battlefield (Angel of Serenity's list mixes both).
 */
function TargetOptions({
  choice,
  draft,
  names,
  onPick,
  zoneOf,
}: {
  choice: Extract<PendingChoice, { kind: 'selectTargets' }>;
  draft: ChoiceDraft;
  names: Readonly<Record<PlayerId, string>>;
  onPick: (value: ChoiceOptionValue) => void;
  zoneOf?: ZoneOfRef;
}): ReactElement {
  const picked = new Set<ChoiceOptionValue>(draft.kind === 'selectTargets' ? draft.targets : []);
  if (choice.candidates.length === 0) {
    return <p className="choice-prompt__empty">Nothing legal to point at.</p>;
  }
  const notes = annotateTargetOptions(choice.candidates, choice.chooser, names, zoneOf);
  return (
    <div className="choice-prompt__list">
      {choice.candidates.map((candidate, index) => {
        const note = notes[index];
        const noteText =
          note === 'player' ? 'player' : note !== undefined ? formatOwnerZone(note) : undefined;
        // A seat candidate renders by its DISPLAY name — the engine's snapshot
        // says "Player B", which is the id, not the human.
        const label =
          note === 'player' ? (names[candidate.ref as PlayerId] ?? candidate.name) : candidate.name;
        return (
          <button
            key={String(candidate.ref)}
            type="button"
            className={`choice-option${picked.has(candidate.ref) ? ' choice-option--selected' : ''}`}
            aria-pressed={picked.has(candidate.ref)}
            onClick={() => onPick(candidate.ref)}
          >
            {label}
            {noteText && <span className="choice-option__note"> ({noteText})</span>}
          </button>
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
 */
function BinaryOptions({
  chosen,
  labels,
  yesDisabled = false,
  onSet,
}: {
  chosen: boolean | null;
  labels: { readonly yes: string; readonly no: string };
  yesDisabled?: boolean;
  onSet: (yes: boolean) => void;
}): ReactElement {
  return (
    <div className="choice-prompt__list choice-prompt__list--inline">
      <button
        type="button"
        className={`choice-option${chosen === true ? ' choice-option--selected' : ''}`}
        aria-pressed={chosen === true}
        disabled={yesDisabled}
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
