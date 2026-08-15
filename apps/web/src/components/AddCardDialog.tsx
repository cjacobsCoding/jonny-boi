import { useCallback, useState, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools/pure';
import { addCardByName, describeAddResult, type AddCardResult } from '../lib/cards/addSingleCard.js';
import { unsupportedMechanics } from '../lib/cards/unsupportedRegistry.js';
import './add-card-dialog.css';

/**
 * Add ONE card to the pool by name, with the guessing done for us.
 *
 * Mounted from both the card browser and the deck builder, because "I need this
 * one card" happens in both places and neither should send you to a decklist
 * paste box to get it. Typing is fuzzy on purpose (Scryfall's own fuzzy match),
 * so "lightnig bolt" resolves; when a name is genuinely ambiguous we show the
 * real alternatives as buttons rather than refusing.
 *
 * The result is deliberately honest about fidelity: a card whose printed text
 * needs an engine system we don't have is still ADDED (it is a real card and
 * belongs in your pool and decklists), but it is reported as not simulatable and
 * its missing systems are filed on the shared work queue.
 */
export function AddCardDialog({
  onClose,
  onAdded,
}: {
  readonly onClose: () => void;
  /** Called with the added card, so a deck builder can slot it straight in. */
  readonly onAdded?: (card: NormalizedCard) => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddCardResult | null>(null);

  const run = useCallback(
    async (name: string): Promise<void> => {
      const trimmed = name.trim();
      if (trimmed.length === 0 || busy) return;
      setBusy(true);
      setResult(null);
      try {
        const outcome = await addCardByName(trimmed, fetch as never);
        setResult(outcome);
        if (outcome.kind === 'added' || outcome.kind === 'addedUnplayable' || outcome.kind === 'alreadyKnown') {
          onAdded?.(outcome.card);
        }
      } catch (err) {
        setResult({ kind: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      } finally {
        setBusy(false);
      }
    },
    [busy, onAdded],
  );

  const blocked = result?.kind === 'addedUnplayable' ? result.missing : [];
  const queueSize = unsupportedMechanics().length;

  return (
    <div className="add-card__backdrop" role="dialog" aria-modal="true" aria-label="Add a card">
      <div className="add-card">
        <h3 className="add-card__title">Add a card</h3>
        <p className="add-card__intro">
          Type a card name — spelling doesn’t have to be exact. It’s fetched from Scryfall and added to
          your pool.
        </p>

        <form
          className="add-card__form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(query);
          }}
        >
          <input
            className="add-card__input"
            type="text"
            value={query}
            autoFocus
            placeholder="e.g. lightnig bolt"
            aria-label="Card name"
            onChange={(e) => setQuery(e.target.value)}
            disabled={busy}
          />
          <button type="submit" className="btn btn--primary" disabled={busy || query.trim().length === 0}>
            {busy ? 'Looking up…' : 'Add'}
          </button>
        </form>

        {result && (
          <div
            className={`add-card__result add-card__result--${resultTone(result)}`}
            role={resultTone(result) === 'bad' ? 'alert' : 'status'}
          >
            {describeAddResult(result)}
          </div>
        )}

        {/* An ambiguous name is a choice, not a failure — offer the real names. */}
        {result?.kind === 'ambiguous' && result.suggestions.length > 0 && (
          <ul className="add-card__suggestions">
            {result.suggestions.map((name) => (
              <li key={name}>
                <button type="button" className="btn btn--ghost" onClick={() => void run(name)} disabled={busy}>
                  {name}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Say exactly which printed text we can't play, not just "unsupported". */}
        {blocked.length > 0 && (
          <div className="add-card__blocked">
            <strong>Not simulatable yet — the engine is missing:</strong>
            <ul>
              {blocked.map((clause, i) => (
                <li key={`${clause.missingEngineSystem}-${i}`}>
                  <span className="add-card__system">{clause.missingEngineSystem}</span>
                  <span className="add-card__clause">“{clause.text}”</span>
                </li>
              ))}
            </ul>
            <p className="add-card__queued">
              Logged for the developers ({queueSize} outstanding mechanic{queueSize === 1 ? '' : 's'}).
            </p>
          </div>
        )}

        <div className="add-card__actions">
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** Which visual tone a result gets: good, mixed, or bad. */
function resultTone(result: AddCardResult): 'good' | 'warn' | 'bad' {
  switch (result.kind) {
    case 'added':
      return 'good';
    case 'alreadyKnown':
    case 'addedUnplayable':
    case 'ambiguous':
      return 'warn';
    case 'notFound':
    case 'error':
      return 'bad';
  }
}
