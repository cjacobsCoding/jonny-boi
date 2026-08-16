import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { formatManaCost, type ChoiceAnswer, type PendingChoice, type PlayerId } from '@jonny-boi/core';
import {
  choicePromptView,
  clearDraft,
  draftStatus,
  emptyDraft,
  orderBadge,
  setConfirm,
  setPayMana,
  toggleOption,
  type ChoiceDraft,
  type ChoiceOptionValue,
} from '../../lib/play/choice-view.js';
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
}: {
  choice: PendingChoice;
  names: Readonly<Record<PlayerId, string>>;
  /** Submit the finished answer through the session's `answerChoice` action. */
  onAnswer: (answer: ChoiceAnswer) => void;
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
            <CardOptions choice={choice} draft={draft} onPick={pick} />
          )}
          {choice.kind === 'selectPlayers' && (
            <PlayerOptions choice={choice} draft={draft} names={names} onPick={pick} />
          )}
          {choice.kind === 'chooseModes' && <ModeOptions choice={choice} draft={draft} onPick={pick} />}
          {choice.kind === 'selectTargets' && <TargetOptions choice={choice} draft={draft} onPick={pick} />}
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
 */
function CardOptions({
  choice,
  draft,
  onPick,
}: {
  choice: Extract<PendingChoice, { kind: 'selectCards' }>;
  draft: ChoiceDraft;
  onPick: (value: ChoiceOptionValue) => void;
}): ReactElement {
  const picked = new Set(draft.kind === 'selectCards' ? draft.instanceIds : []);
  if (choice.candidates.length === 0) {
    return <p className="choice-prompt__empty">No cards to choose from.</p>;
  }
  return (
    <div className="choice-prompt__cards">
      {choice.candidates.map((c) => {
        const order = orderBadge(choice, draft, c.instanceId);
        return (
          <PlayCard
            key={c.instanceId}
            cardId={c.cardId}
            name={c.name}
            selected={picked.has(c.instanceId)}
            badge={order !== undefined ? `#${order}` : undefined}
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

/** The modes of a modal spell — "choose two —" is `min = max = 2` over this list. */
function ModeOptions({
  choice,
  draft,
  onPick,
}: {
  choice: Extract<PendingChoice, { kind: 'chooseModes' }>;
  draft: ChoiceDraft;
  onPick: (value: ChoiceOptionValue) => void;
}): ReactElement {
  const picked = new Set(draft.kind === 'chooseModes' ? draft.modeIds : []);
  return (
    <div className="choice-prompt__list">
      {choice.modes.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`choice-option${picked.has(m.id) ? ' choice-option--selected' : ''}`}
          aria-pressed={picked.has(m.id)}
          onClick={() => onPick(m.id)}
        >
          {m.label}
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
 */
function TargetOptions({
  choice,
  draft,
  onPick,
}: {
  choice: Extract<PendingChoice, { kind: 'selectTargets' }>;
  draft: ChoiceDraft;
  onPick: (value: ChoiceOptionValue) => void;
}): ReactElement {
  const picked = new Set<ChoiceOptionValue>(draft.kind === 'selectTargets' ? draft.targets : []);
  if (choice.candidates.length === 0) {
    return <p className="choice-prompt__empty">Nothing legal to point at.</p>;
  }
  return (
    <div className="choice-prompt__list">
      {choice.candidates.map((candidate) => (
        <button
          key={String(candidate.ref)}
          type="button"
          className={`choice-option${picked.has(candidate.ref) ? ' choice-option--selected' : ''}`}
          aria-pressed={picked.has(candidate.ref)}
          onClick={() => onPick(candidate.ref)}
        >
          {candidate.name}
          <span className="choice-option__note"> ({candidate.controller})</span>
        </button>
      ))}
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

/** The plain yes/no copy, named so the component body reads as data + wiring. */
const CONFIRM_LABELS = Object.freeze({ yes: 'Yes', no: 'No' });
