import { useMemo, useState, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { allAvailableCards } from '../lib/cards.js';
import { queryCards, EMPTY_QUERY, type CardQuery } from '../lib/filter.js';
import {
  deckSize,
  countOf,
  maxCopiesFor,
  groupByType,
  manaCurve,
  validateDeck,
  toExport,
  type DeckIssue,
} from '../lib/deck.js';
import { MIN_DECK_SIZE } from '../lib/config.js';
import { unsupportedReason } from '../lib/decklist/importedCards.js';
import type { DecksApi } from '../lib/useDecks.js';
import { CardToolbar } from '../components/CardToolbar.js';
import { CardGrid } from '../components/CardGrid.js';
import { CardDetail } from '../components/CardDetail.js';
import { ManaCurveChart } from '../components/ManaCurveChart.js';
import { ImportDeckDialog } from '../components/ImportDeckDialog.js';
import { deckToDecklist } from '../lib/proxy/deckToText.js';

/**
 * The Deck Builder: a card pool on the left (reusing the browser's toolbar +
 * grid, now with add/remove steppers) and a sticky deck panel on the right with
 * the saved-deck list, name, running totals, mana curve, grouped deck list, and
 * JSON import/export.
 */
export function DeckBuilderView({ decks }: { decks: DecksApi }): ReactElement {
  const [query, setQuery] = useState<CardQuery>(EMPTY_QUERY);
  const [selected, setSelected] = useState<NormalizedCard | null>(null);

  // Includes cards added by deck import, so an imported card is browsable and
  // re-addable exactly like a curated one.
  const pool = useMemo(() => allAvailableCards(), [decks.decks]);
  const results = useMemo(() => queryCards(pool, query), [pool, query]);
  const active = decks.activeDeck;

  const deckControls = (card: NormalizedCard) => {
    if (!active) {
      return { count: 0, canAdd: false, onAdd: () => {}, onRemove: () => {} };
    }
    const count = countOf(active, card.id);
    return {
      count,
      canAdd: count < maxCopiesFor(card),
      onAdd: decks.addCard,
      onRemove: (c: NormalizedCard) => decks.removeCard(c.id),
    };
  };

  return (
    <div className="deck-layout">
      <section aria-label="Card pool">
        <CardToolbar query={query} onChange={setQuery} resultCount={results.length} />
        <CardGrid cards={results} onSelect={setSelected} deckControls={deckControls} />
      </section>

      <DeckPanel decks={decks} onSelectCard={setSelected} />

      {selected && <CardDetail card={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** The right-hand sticky deck panel. */
function DeckPanel({
  decks,
  onSelectCard,
}: {
  decks: DecksApi;
  onSelectCard: (card: NormalizedCard) => void;
}): ReactElement {
  const active = decks.activeDeck;
  const [ioOpen, setIoOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  if (!active) {
    return (
      <aside className="deck-panel">
        <p>Loading decks…</p>
      </aside>
    );
  }

  const size = deckSize(active);
  const groups = groupByType(active);
  const curve = manaCurve(active);
  const issues = validateDeck(active);
  const atTarget = size >= MIN_DECK_SIZE;

  const exportJson = JSON.stringify(toExport(active), null, 2);

  return (
    <aside className="deck-panel" aria-label="Deck">
      <div className="deck-panel__header">
        <input
          className="input deck-name-input"
          value={active.name}
          onChange={(event) => decks.renameActive(event.target.value)}
          aria-label="Deck name"
        />
        <div className="deck-toolbar">
          <button type="button" className="btn btn--ghost" onClick={decks.newDeck}>
            New
          </button>
          <button type="button" className="btn btn--primary" onClick={() => setImportOpen(true)}>
            Import deck
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setIoOpen((open) => !open)}
            aria-expanded={ioOpen}
          >
            Export
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => decks.deleteDeck(active.id)}
          >
            Delete
          </button>
        </div>
      </div>

      <div className={`deck-stat-row${atTarget ? ' deck-stat-row--ok' : ''}`}>
        <span>Total cards</span>
        <strong>
          {size}
          <span style={{ color: 'var(--color-fg-faint)', fontSize: 'var(--text-sm)' }}>
            {' '}
            / {MIN_DECK_SIZE}
          </span>
        </strong>
      </div>

      <div>
        <div className="section-label">Mana curve</div>
        <ManaCurveChart bars={curve} />
      </div>

      {issues.length > 0 && (
        <ul className="deck-issues">
          {issues.map((issue, index) => (
            <li key={index} className={`deck-issue--${issue.severity}`}>
              {ISSUE_ICONS[issue.severity]}
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div>
        {groups.length === 0 ? (
          <p style={{ color: 'var(--color-fg-muted)', fontSize: 'var(--text-sm)' }}>
            Empty deck — add cards from the pool with the + buttons.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.type} className="deck-group">
              <div className="deck-group__title">
                {group.type} ({group.count})
              </div>
              {group.entries.map(({ card, count }) => (
                <div key={card.id} className="deck-entry">
                  <span className="deck-entry__count">{count}×</span>
                  <span
                    className="deck-entry__name"
                    onClick={() => onSelectCard(card)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') onSelectCard(card);
                    }}
                  >
                    {card.name}
                  </span>
                  {unsupportedReason(card.id) && (
                    <span
                      className="deck-entry__unsupported"
                      title={unsupportedSummary(card.id)}
                      aria-label={`${card.name} cannot be simulated yet`}
                    >
                      ⚠
                    </span>
                  )}
                  <button
                    type="button"
                    className="deck-entry__remove"
                    onClick={() => decks.removeCard(card.id)}
                    aria-label={`Remove one ${card.name}`}
                  >
                    −
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {ioOpen && (
        <div>
          <div className="section-label">Export (sim-compatible JSON)</div>
          <textarea className="io-textarea" readOnly value={exportJson} aria-label="Deck export JSON" />
          <div className="import-row">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => navigator.clipboard?.writeText(exportJson)}
            >
              Copy JSON
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => navigator.clipboard?.writeText(deckToDecklist(active))}
            >
              Copy decklist
            </button>
          </div>
        </div>
      )}

      <SavedDecks decks={decks} />

      {importOpen && (
        <ImportDeckDialog decks={decks} onClose={() => setImportOpen(false)} />
      )}
    </aside>
  );
}

/** Leading glyph per issue severity (kept out of JSX so the mapping is one place). */
const ISSUE_ICONS: Readonly<Record<DeckIssue['severity'], string>> = {
  error: '✕ ',
  warning: '! ',
  unsupported: '⚠ ',
};

/**
 * Hover text for an unsupported card's warning marker: the engine systems its
 * rules text needs, so the answer to "why is this flagged?" is one hover away.
 */
function unsupportedSummary(cardId: string): string {
  const missing = unsupportedReason(cardId) ?? [];
  const systems = [...new Set(missing.map((gap) => gap.missingEngineSystem))];
  return systems.length > 0
    ? `Can't be simulated yet — needs ${systems.join('; ')}.`
    : "Can't be simulated yet.";
}

/** The saved-deck switcher (load / active highlight / delete). */
function SavedDecks({ decks }: { decks: DecksApi }): ReactElement {
  if (decks.decks.length <= 1) return <></>;
  return (
    <div>
      <div className="section-label">Saved decks</div>
      <div className="saved-decks">
        {decks.decks.map((deck) => {
          const isActive = deck.id === decks.activeDeck?.id;
          const count = deck.cards.reduce((sum, entry) => sum + entry.count, 0);
          return (
            <div key={deck.id} className={`saved-deck${isActive ? ' saved-deck--active' : ''}`}>
              <button
                type="button"
                className="saved-deck__name"
                onClick={() => decks.selectDeck(deck.id)}
              >
                {deck.name} · {count}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
