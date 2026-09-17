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
  describeDeckProblems,
  unresolvedCopies,
  type DeckIssue,
} from '../lib/deck.js';
import { MIN_DECK_SIZE } from '../lib/config.js';
import { unsupportedReason } from '../lib/decklist/importedCards.js';
import { assessDeckHealth, deckHealthBadge, describeDeckHealth } from '../lib/decklist/deckHealth.js';
import {
  copiesOfGauntletDeck,
  copyGauntletDeck,
  describeExistingCopies,
  describeGauntletCopy,
  gauntletDecks,
} from '../lib/decklist/gauntletDecks.js';
import { DECK_ORIGIN_ATTR, originPresentation } from '../lib/decklist/deckOrigin.js';
import type { DecksApi } from '../lib/useDecks.js';
import { CardToolbar } from '../components/CardToolbar.js';
import { CardGrid } from '../components/CardGrid.js';
import { CardDetail } from '../components/CardDetail.js';
import { ManaCurveChart } from '../components/ManaCurveChart.js';
import { ImportDeckDialog } from '../components/ImportDeckDialog.js';
import { AddCardDialog } from '../components/AddCardDialog.js';
import { DeckEntryPrinting } from '../components/DeckEntryPrinting.js';
import { usePrints } from '../lib/proxy/usePrints.js';
import { customPrintingCount } from '../lib/printings/entryPrinting.js';
import { deckToDecklist } from '../lib/proxy/deckToText.js';
import { copyText } from '../lib/clipboard.js';
import './deck-health.css';
import '../components/deck-origin.css';
import './builtin-decks.css';
import './deck-steppers.css';

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
  // `decks.decks` is an INVISIBLE dependency (see CardsView): `allAvailableCards()`
  // reads a registry deck import mutates, so this list is the only signal the pool grew.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const [addCardOpen, setAddCardOpen] = useState(false);
  // ONE printings lookup for the whole deck list — see DeckEntryPrinting for why
  // a hook per row would cross-talk between cards.
  const prints = usePrints();

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
  // Can this deck actually be PLAYED, as opposed to merely being legal?
  const health = assessDeckHealth(active.cards.map((e) => ({ cardId: e.cardId, count: e.count })));

  const customPrinting = customPrintingCount(active);

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
          {/* The one-card path: needing a single card mid-build shouldn't send
              you to a decklist paste box. */}
          <button type="button" className="btn btn--ghost" onClick={() => setAddCardOpen(true)}>
            + Card
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

      {/* Chosen printings are invisible in a text deck list, so the count says
          they exist at all — otherwise the only way to find out a slot is on
          custom art is to open its picker. */}
      {customPrinting > 0 && (
        <div className="deck-stat-row deck-stat-row--printings">
          <span>Custom printings</span>
          <strong>{customPrinting}</strong>
        </div>
      )}

      <div>
        <div className="section-label">Mana curve</div>
        <ManaCurveChart bars={curve} />
      </div>

      {/* Fidelity warning. A deck holding a card the engine can't play still
          "works", which is exactly the danger: it would behave as if that card
          were a blank and quietly skew any simulation. So it is called out
          above the ordinary legality issues, by name. */}
      {!health.playable && (
        <div className="deck-health" role="alert">
          <strong className="deck-health__badge">⚠ {deckHealthBadge(health)}</strong>
          <p className="deck-health__detail">{describeDeckHealth(health)}</p>
        </div>
      )}

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
              {group.entries.map(({ card, count, printing }) => (
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
                  {/* A real stepper, right where the card already is. The old
                      control was a single faint "−" glyph with no background,
                      effectively invisible in a dense list — so changing a count
                      meant hunting the card back down in the pool grid. */}
                  <button
                    type="button"
                    className="deck-step deck-step--remove"
                    onClick={() => decks.removeCard(card.id)}
                    aria-label={`Remove one ${card.name}`}
                    title={`Remove one ${card.name}`}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="deck-step deck-step--add"
                    onClick={() => decks.addCard(card)}
                    disabled={count >= maxCopiesFor(card)}
                    aria-label={`Add one more ${card.name}`}
                    title={
                      count >= maxCopiesFor(card)
                        ? `Already at the maximum ${maxCopiesFor(card)} copies`
                        : `Add one more ${card.name}`
                    }
                  >
                    +
                  </button>
                  {/* Which PRINTING this slot uses. Art only — the card's
                      identity is its id, so this never touches legality,
                      the curve, or anything the sim reads. */}
                  <DeckEntryPrinting
                    card={card}
                    printing={printing}
                    prints={prints}
                    onChoose={decks.setEntryPrinting}
                    onReset={(cardId) => decks.setEntryPrinting(cardId, null)}
                  />
                </div>
              ))}
            </div>
          ))
        )}

        {/* CARDS THE POOL CANNOT SUPPLY YET — listed in the deck, not hidden.
            These have no `cardId`, so they cannot be a `deck-entry`: there is
            nothing to inspect, nothing to step up, and no art. What they DO
            need is to be visible and removable, because a deck that silently
            arrived thirteen cards light is the failure his own words name — and
            because "I must be able to edit all of them" has to reach the one
            part of a transcribed deck that has no card behind it. */}
        {(active.unresolved ?? []).length > 0 && (
          <div className="deck-group deck-group--unresolved">
            <div className="deck-group__title">
              Not in the card pool yet ({unresolvedCopies(active)})
            </div>
            {(active.unresolved ?? []).map((missing) => (
              <div key={missing.name} className="deck-entry deck-entry--unresolved">
                <span className="deck-entry__count">{missing.count}×</span>
                <span className="deck-entry__name" title={`${missing.name} is in this deck on paper, but the compiled card pool does not carry it yet. It will be added automatically when it does.`}>
                  {missing.name}
                </span>
                <button
                  type="button"
                  className="deck-step deck-step--remove"
                  onClick={() => decks.removeUnresolvedCard(missing.name)}
                  aria-label={`Drop ${missing.name} from this deck`}
                  title={`Drop ${missing.name} from this deck`}
                >
                  −
                </button>
              </div>
            ))}
          </div>
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
              onClick={() => void copyText(exportJson)}
            >
              Copy JSON
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void copyText(deckToDecklist(active))}
            >
              Copy decklist
            </button>
          </div>
        </div>
      )}

      {/* ONE collection. His transcribed paper decks are seeded INTO
          `SavedDecks` as decks of his own (see `lib/decklist/paperDecks.ts`),
          so there is nothing else to mount here — which is the entire fix. */}
      <SavedDecks decks={decks} />
      <GauntletDecks decks={decks} />

      {importOpen && (
        <ImportDeckDialog decks={decks} onClose={() => setImportOpen(false)} />
      )}

      {/* Adding from here puts the card straight into the deck being built —
          that is the whole reason to offer it inside the builder. */}
      {addCardOpen && (
        <AddCardDialog
          onClose={() => setAddCardOpen(false)}
          onAdded={(card) => decks.addCard(card)}
        />
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

/**
 * The six BUILT-IN gauntlet decks, browsable and copyable.
 *
 * These are bundled build data — reference decks the Lab tests against. They are
 * not editable in place; copying one gives you your own deck to tune, which is
 * the whole premise of the lab: take a real meta list, change a card, and let the
 * sim tell you if it got better. (To PLAY one directly, the Play setup lists them
 * too — grouped under their own heading there for the same reason as here.)
 *
 * ⚠️ This list used to render `.saved-decks` / `.saved-deck`, the user's own
 * classes, on purpose — so it "sat visually with the user's own decks". A user
 * copied Selesnya Blink, renamed the copy, saw the untouched built-in still
 * sitting in the column, and filed a bug saying the app had DUPLICATED his deck.
 * It had not. So the built-in region is now unmistakably its own: its own
 * container, a lock badge per row, and a marked origin attribute. Do not merge
 * the two treatments back together.
 *
 * Exported alongside {@link SavedDecks} so `builtin-deck-identity.test.ts` can
 * render the two lists side by side and assert they are TELLABLE APART in the
 * markup. The claim is about what the UI says, which no engine test can see.
 */
export function GauntletDecks({ decks }: { decks: DecksApi }): ReactElement {
  const [note, setNote] = useState<string | null>(null);
  const list = useMemo(() => gauntletDecks(), []);
  const builtin = originPresentation('builtin');

  const copy = (sample: (typeof list)[number]): void => {
    const result = copyGauntletDeck(sample.deck);
    decks.importDeck(result.deck);
    setNote(describeGauntletCopy(result));
  };

  return (
    <div className="builtin-decks">
      <div className="section-label">Built-in gauntlet decks</div>
      <p className="builtin-decks__intro">
        Reference decks that ship with the app — not yours, and not editable. Copy one
        to tune it as your own.
      </p>
      <div className="builtin-deck-list">
        {list.map((sample) => {
          const copies = copiesOfGauntletDeck(sample.name, decks.decks);
          const mine = copies[0];
          return (
            <div
              key={sample.name}
              className="builtin-deck"
              {...{ [DECK_ORIGIN_ATTR]: 'builtin' }}
            >
              <div className="builtin-deck__heading">
                <span
                  className="deck-origin-badge deck-origin-badge--builtin"
                  title={builtin.explanation}
                >
                  <span aria-hidden="true">{builtin.glyph}</span> {builtin.badge}
                </span>
                <span className="builtin-deck__name">{sample.name}</span>
              </div>
              <span className="builtin-deck__meta">
                {sample.archetype} · {sample.size} cards
              </span>
              {/* Already copied? Say so, and offer the copy — not the same
                  "Copy to my decks" button forever, which is the invitation
                  that produced the duplicate-looking deck in the first place.
                  Copying AGAIN stays possible (a second experimental branch of
                  a list is a normal thing to want) but it is now the quiet
                  option next to an explicit statement of what you already have. */}
              {mine ? (
                <div className="builtin-deck__copied">
                  <span className="builtin-deck__copied-note" role="status">
                    ✓ {describeExistingCopies(copies)}
                  </span>
                  <div className="builtin-deck__actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => decks.selectDeck(mine.id)}
                    >
                      Open my copy
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost builtin-deck__again"
                      onClick={() => copy(sample)}
                    >
                      Copy again
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn btn--ghost" onClick={() => copy(sample)}>
                  Copy to my decks
                </button>
              )}
            </div>
          );
        })}
      </div>
      {note && (
        <p className="builtin-decks__note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * YOUR DECKS — the one collection, and the only one he owns.
 *
 * ## There is exactly one of these, on purpose
 *
 * For one revision there were two: this, and a separate read-only region called
 * "Your paper decks" holding the physical decks he had transcribed. *"why is
 * there a 'your paper decks' and 'your decks' - this is dumb. I just want one
 * collection of decks and I must be able to edit all of them, regardless of
 * whether scanned in."* A transcribed deck is now SEEDED into this list as a
 * deck of his own (`lib/decklist/paperDecks.ts`) and is from then on
 * indistinguishable from one he built by hand — which is what he asked for, and
 * why there is nothing in this component that knows where a deck came from.
 *
 * The built-in gauntlet stays its own region. It is not his, the Lab measures
 * every verdict against it, and the last time the two were rendered alike he
 * filed a duplication bug (DESIGN §3.35). One collection of HIS decks, not one
 * list of all decks.
 *
 * ## A deck that is not right says so, in the row
 *
 * *"a deck that resolves to a handful of lands is not a deck."* A row whose deck
 * is short of sixty, or whose cards the compiled pool cannot supply yet, prints
 * the reason under its name rather than leaving him to open each one and count.
 * The sentence comes from `describeDeckProblems`, which reads the same two
 * fields `validateDeck` does — one answer to one question (CLAUDE.md rule 12).
 *
 * Always rendered, even at one deck: this heading is what tells you which region
 * of the panel is yours, and hiding it left a lone list of six built-in decks
 * under the builder with nothing to contrast against.
 */
export function SavedDecks({ decks }: { decks: DecksApi }): ReactElement {
  return (
    // Named so the region — heading INCLUDED — can be addressed as one thing.
    // `verify-deck-identity.mjs` scrolls to it to frame your decks against the
    // built-in ones; anchoring on `.saved-decks` alone left the heading one line
    // above the fold on a phone, which is the difference between a screenshot
    // that shows the comparison and one that shows half of it.
    <div className="saved-decks-region">
      <div className="section-label">Your decks</div>
      <div className="saved-decks">
        {decks.decks.map((deck) => {
          const isActive = deck.id === decks.activeDeck?.id;
          const count = deck.cards.reduce((sum, entry) => sum + entry.count, 0);
          const problems = describeDeckProblems(deck);
          return (
            <div
              key={deck.id}
              className={`saved-deck${isActive ? ' saved-deck--active' : ''}`}
              // Marked as yours for the same reason built-ins are marked: the
              // guard has to be able to assert that this row does NOT carry the
              // built-in treatment, and an absent attribute cannot say that.
              {...{ [DECK_ORIGIN_ATTR]: 'mine' }}
            >
              <button
                type="button"
                className="saved-deck__name"
                onClick={() => decks.selectDeck(deck.id)}
              >
                {deck.name} · {count}
              </button>
              {/* Rendered only when something IS wrong. A line under every deck
                  saying "60 cards, fine" trains the eye to skip the line, which
                  is how the deck that went short stops being noticed.

                  No `role="alert"`: these are static labels present on mount,
                  and a collection of them would announce themselves before he
                  had asked anything. The icon, the colour and the sentence
                  carry it in normal reading order. */}
              {problems !== '' && (
                <p className="saved-deck__problems">⚠ {problems}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
