import { useCallback, useMemo, useReducer, type ReactElement } from 'react';
import type { Deck } from '../lib/deck.js';
import { clearStorageNotices } from '../lib/persistence/failures.js';
import { asDeck, recoverableDecks } from '../lib/persistence/recovery.js';
import { clearStorageArea, formatChars, measureStorage } from '../lib/persistence/usage.js';
import type { StorageAreaId } from '../lib/persistence/budget.js';
import './storage-panel.css';

/**
 * THE STORAGE READOUT — what is stored, how big each part is, what can be
 * cleared, and whether anything is genuinely recoverable.
 *
 * An invisible quota is why two lost decks were a mystery rather than a
 * message. This is the page the alert banner links to, and it is the page a
 * user lands on when they want to know why an app they have used for a week has
 * started refusing to save.
 *
 * It never implies that a deck lost to a failed write can be got back — it
 * cannot, it was never on disk. The recovery section offers ONLY decklists that
 * are demonstrably still stored somewhere else (see `persistence/recovery.ts`),
 * and says plainly when there are none.
 */
export function StoragePanel({
  decks,
  onRecoverDeck,
}: {
  /** The saved decks, so recovery can tell a missing deck from one you have. */
  readonly decks: readonly Deck[];
  /** Add a recovered deck to the collection (the `useDecks` import path). */
  readonly onRecoverDeck: (deck: Deck) => void;
}): ReactElement {
  // Measuring reads localStorage, so it must re-run after a clear or a restore
  // rather than memoize on props that did not change.
  const [revision, bump] = useReducer((n: number) => n + 1, 0);
  const usage = useMemo(() => {
    void revision;
    return measureStorage();
  }, [revision]);
  const recoverable = useMemo(() => {
    void revision;
    return recoverableDecks(decks);
  }, [revision, decks]);

  const clear = useCallback((id: StorageAreaId) => {
    clearStorageArea(id);
    // Room has been made: the standing failure notices are no longer known to
    // be true, so retire them rather than leaving a stale alarm on screen.
    clearStorageNotices();
    bump();
  }, []);

  const usedShare = Math.min(1, usage.totalChars / usage.originBudget);

  return (
    <section className="storage-panel" aria-labelledby="storage-panel-title">
      <header className="storage-panel__intro">
        <h3 id="storage-panel-title">Browser storage</h3>
        <p>
          Everything jonny-boi keeps between visits lives in this browser, and browsers cap that
          per site — commonly around {formatChars(usage.originBudget)} of text, shared by every
          feature below. When it fills, the <em>newest</em> thing you save is the one that fails,
          which is why a deck can look saved for a session and be gone on the next load.
        </p>
      </header>

      <div className="storage-panel__total">
        <div className="storage-panel__bar" aria-hidden="true">
          <div
            className={`storage-panel__bar-fill${usedShare > 0.85 ? ' storage-panel__bar-fill--hot' : ''}`}
            style={{ width: `${(usedShare * 100).toFixed(1)}%` }}
          />
        </div>
        <p className="storage-panel__total-text">
          <strong>{formatChars(usage.totalChars)}</strong> stored of roughly{' '}
          {formatChars(usage.originBudget)} available ({Math.round(usedShare * 100)}%).
        </p>
      </div>

      <table className="storage-panel__table">
        <caption className="storage-panel__caption">
          Every area, largest first. &ldquo;Budget&rdquo; is the share jonny-boi allows itself, so
          no one feature can take the whole site allowance and starve your decks.
        </caption>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col">Size</th>
            <th scope="col">Budget</th>
            <th scope="col">
              <span className="storage-panel__sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {usage.areas.map(({ area, chars, budget, keys }) => (
            <tr key={area.id}>
              <th scope="row">
                <span className="storage-panel__label">{area.label}</span>
                <span className="storage-panel__why">{area.why}</span>
              </th>
              <td className="storage-panel__num">
                {chars === 0 ? <span className="storage-panel__empty">empty</span> : formatChars(chars)}
                {keys > 1 && <span className="storage-panel__keys"> · {keys} entries</span>}
              </td>
              <td className="storage-panel__num">{formatChars(budget)}</td>
              <td>
                {area.clearable && chars > 0 ? (
                  <button
                    type="button"
                    className="storage-panel__clear"
                    onClick={() => clear(area.id as StorageAreaId)}
                  >
                    Clear
                  </button>
                ) : (
                  <span className="storage-panel__why">
                    {area.clearable ? '—' : 'kept'}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {usage.unattributed.keys.length > 0 && (
        <p className="storage-panel__unattributed">
          {formatChars(usage.unattributed.chars)} is stored under{' '}
          {usage.unattributed.keys.length}{' '}
          {usage.unattributed.keys.length === 1 ? 'key' : 'keys'} jonny-boi does not recognise (
          {usage.unattributed.keys.slice(0, 4).join(', ')}
          {usage.unattributed.keys.length > 4 ? ', …' : ''}). It still counts against the same
          allowance, so it is listed rather than hidden.
        </p>
      )}

      <div className="storage-panel__recovery">
        <h4>Decks still on disk</h4>
        {recoverable.length === 0 ? (
          <p className="storage-panel__why">
            Nothing to recover. A deck that failed to save was never written to this browser, so
            there is nothing to restore — if a deck is missing, the decklist has to come from
            wherever you imported it. This section only ever shows decks that <em>are</em> still
            stored, inside a saved game.
          </p>
        ) : (
          <>
            <p className="storage-panel__why">
              These decklists are stored inside a saved game but are not in your deck list. They
              can be restored exactly as they were played.
            </p>
            <ul className="storage-panel__recover-list">
              {recoverable.map((candidate) => (
                <li key={candidate.key}>
                  <span className="storage-panel__label">{candidate.name}</span>
                  <span className="storage-panel__why">
                    {candidate.cards.reduce((n, c) => n + c.count, 0)} cards, found in{' '}
                    {candidate.source}
                  </span>
                  <button
                    type="button"
                    className="storage-panel__clear"
                    onClick={() => {
                      onRecoverDeck(asDeck(candidate));
                      bump();
                    }}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
