import { useMemo, useRef, useState, type ReactElement } from 'react';
import type { DecksApi } from '../lib/useDecks.js';
import { useDeckImport } from '../lib/decklist/useDeckImport.js';
import { blockedByEngineSystem, type ResolvedLine } from '../lib/decklist/resolve.js';
import type { BuildResult } from '../lib/decklist/buildDeck.js';
import { ScanDeckDialog } from './ScanDeckDialog.js';

/**
 * The deck importer.
 *
 * One box takes everything: a pasted decklist in any common export format, a
 * link to a deck on Moxfield/Archidekt/MTGGoldfish/TappedOut, a dropped `.txt`
 * or `.csv` file, or the app's own deck JSON.
 *
 * The review step is the point of the whole feature. Before anything is saved it
 * shows how many cards are genuinely playable, and — for the ones that are not —
 * exactly which engine systems their rules text needs. Nothing is imported as a
 * card that "sort of" works, because a card that sort of works would quietly
 * corrupt every A/B verdict the lab produces.
 */
export function ImportDeckDialog({
  decks,
  onClose,
}: {
  decks: DecksApi;
  onClose: () => void;
}): ReactElement {
  const importer = useDeckImport();
  const [text, setText] = useState('');
  const [deckName, setDeckName] = useState('');
  const [result, setResult] = useState<BuildResult | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const blockedGroups = useMemo(
    () => (importer.plan ? blockedByEngineSystem(importer.plan) : []),
    [importer.plan],
  );

  const handleFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const contents = await file.text();
    setText(contents);
    if (!deckName) setDeckName(file.name.replace(/\.[^.]+$/, ''));
    await importer.resolve(contents);
  };

  const handleCommit = (): void => {
    // The app's own export JSON needs no card lookups — import it directly.
    if (importer.jsonDeck) {
      const named = deckName.trim() ? { ...importer.jsonDeck, name: deckName.trim() } : importer.jsonDeck;
      decks.importDeck(named);
      onClose();
      return;
    }
    const built = importer.commit(deckName);
    if (!built) return;
    decks.importDeck(built.deck);
    setResult(built);
  };

  return (
    <div className="import-backdrop" role="dialog" aria-modal="true" aria-label="Import a deck">
      <div className="import-dialog">
        <div className="import-dialog__header">
          <h2 className="import-title">Import a deck</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {result ? (
          <ImportSummary result={result} onClose={onClose} />
        ) : (
          <>
            <p className="import-intro">
              Paste a decklist from anywhere — Arena, Moxfield, Archidekt, MTGGoldfish, TappedOut,
              a CSV export — or drop in a deck link or file.
            </p>

            <textarea
              className="io-textarea import-textarea"
              placeholder={'4 Lightning Bolt (M10) 146\n20 Mountain\n\n…or https://moxfield.com/decks/…'}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onDrop={(event) => {
                const file = event.dataTransfer.files[0];
                if (file) {
                  event.preventDefault();
                  void handleFile(file);
                }
              }}
              aria-label="Decklist, deck URL, or deck JSON"
            />

            <div className="import-row">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void importer.resolve(text)}
                disabled={text.trim().length === 0 || importer.phase === 'fetching'}
              >
                {importer.phase === 'fetching' ? 'Looking up cards…' : 'Look up cards'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose a file…
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setScanOpen(true)}>
                Scan from a photo…
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv,.dec,.dek,.json,text/plain"
                className="import-file-input"
                onChange={(event) => void handleFile(event.target.files?.[0])}
                aria-label="Deck file"
              />
            </div>

            {importer.phase === 'fetching' && importer.progress && (
              <div className="import-progress">
                Resolving {importer.progress.done} / {importer.progress.total} cards from Scryfall…
              </div>
            )}

            {importer.phase === 'error' && importer.error && (
              <div className="io-error">
                {importer.error}
                {importer.manualUrl && (
                  <>
                    {' '}
                    <a href={importer.manualUrl} target="_blank" rel="noreferrer noopener">
                      Open the deck’s export page
                    </a>{' '}
                    and paste its text here.
                  </>
                )}
              </div>
            )}

            {importer.parsed && importer.parsed.errors.length > 0 && (
              <ul className="import-errors">
                {importer.parsed.errors.slice(0, MAX_LISTED_LINE_ERRORS).map((issue) => (
                  <li key={issue.line}>
                    Line {issue.line}: {issue.reason} <code>{issue.text}</code>
                  </li>
                ))}
              </ul>
            )}

            {importer.jsonDeck && (
              <div className="import-summary-line">
                Recognized a jonny-boi deck export — {importer.jsonDeck.cards.length} entries, ready
                to import.
              </div>
            )}

            {importer.plan && (
              <ReviewPanel
                lines={importer.plan.lines}
                counts={importer.plan.counts}
                blockedGroups={blockedGroups}
                sourceLabel={importer.sourceLabel}
              />
            )}

            {(importer.plan || importer.jsonDeck) && (
              <div className="import-commit">
                <input
                  className="input"
                  placeholder={importer.plan?.deckName ?? 'Deck name'}
                  value={deckName}
                  onChange={(event) => setDeckName(event.target.value)}
                  aria-label="Name for the imported deck"
                />
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleCommit}
                  disabled={
                    !importer.jsonDeck &&
                    // Anything Scryfall identified can be imported — a deck made
                    // entirely of not-yet-supported cards is still your deck.
                    (importer.plan?.counts.playable ?? 0) +
                      (importer.plan?.counts.blocked ?? 0) ===
                      0
                  }
                >
                  Create deck
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {scanOpen && (
        <ScanDeckDialog
          onClose={() => setScanOpen(false)}
          onUseDecklist={(decklistText) => {
            // A scanned list is just a decklist — it goes through the exact same
            // parse → Scryfall → compile path as a pasted one, so scanned cards
            // are as real as typed ones.
            setScanOpen(false);
            setText(decklistText);
            void importer.resolve(decklistText);
          }}
        />
      )}
    </div>
  );
}

/** Cap the listed bad lines so one malformed paste can't fill the dialog. */
const MAX_LISTED_LINE_ERRORS = 8;

/**
 * Collapse repeated gaps on one card. A modal spell reports one gap per mode,
 * and three identical "needs player choice" lines say nothing the first didn't.
 */
function dedupeGaps(
  gaps: readonly { text: string; missingEngineSystem: string }[] | undefined,
): Array<{ text: string; missingEngineSystem: string }> {
  const seen = new Map<string, { text: string; missingEngineSystem: string }>();
  for (const gap of gaps ?? []) {
    const key = `${gap.text}|${gap.missingEngineSystem}`;
    if (!seen.has(key)) seen.set(key, gap);
  }
  return [...seen.values()];
}

/** Status → how it reads in the review list. */
const STATUS_LABELS: Readonly<Record<ResolvedLine['status'], string>> = {
  pool: 'Ready',
  compiled: 'Ready',
  blocked: 'Needs engine support',
  notFound: 'Not found',
};

/** The pre-import review: what will be imported, and what will not. */
function ReviewPanel({
  lines,
  counts,
  blockedGroups,
  sourceLabel,
}: {
  lines: readonly ResolvedLine[];
  counts: { total: number; playable: number; blocked: number; notFound: number };
  blockedGroups: ReadonlyArray<{ system: string; cards: string[] }>;
  sourceLabel: string | null;
}): ReactElement {
  const problems = lines.filter((line) => line.status === 'blocked' || line.status === 'notFound');

  return (
    <div className="import-review">
      <div className="section-label">
        Review{sourceLabel ? ` · from ${sourceLabel}` : ''}
      </div>

      <div className="import-counts">
        <span className="import-count import-count--ok">{counts.playable} playable</span>
        {counts.blocked > 0 && (
          <span className="import-count import-count--warn">{counts.blocked} need engine support</span>
        )}
        {counts.notFound > 0 && (
          <span className="import-count import-count--bad">{counts.notFound} not found</span>
        )}
        <span className="import-count">{counts.total} total</span>
      </div>

      {problems.length === 0 ? (
        <p className="import-all-good">
          Every card resolved and is fully implemented — this deck will play and simulate exactly as
          printed.
        </p>
      ) : (
        <>
          <p className="import-note">
            The whole deck is imported, including the cards below. Ones marked{' '}
            <em>needs engine support</em> go in the deck and are yours to edit and print — they just
            can’t be simulated yet, so the Lab will name them instead of running. Cards marked{' '}
            <em>not found</em> are the only ones left out, because there is no card to add:
          </p>
          <ul className="import-problem-list">
            {problems.map((line) => (
              <li key={`${line.name}-${line.section}`}>
                <span className="import-problem__name">
                  {line.qty}× {line.name}
                </span>
                <span className="import-problem__status">{STATUS_LABELS[line.status]}</span>
                {dedupeGaps(line.missing).map((gap) => (
                  <span className="import-problem__reason" key={`${gap.text}-${gap.missingEngineSystem}`}>
                    “{gap.text}” — needs {gap.missingEngineSystem}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}

      {blockedGroups.length > 0 && (
        <details className="import-gaps">
          <summary>What this deck would need ({blockedGroups.length} engine systems)</summary>
          <ul>
            {blockedGroups.map((group) => (
              <li key={group.system}>
                <strong>{group.system}</strong> — {group.cards.length} card
                {group.cards.length === 1 ? '' : 's'}: {group.cards.join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Post-import summary: exactly what landed and what did not. */
function ImportSummary({
  result,
  onClose,
}: {
  result: BuildResult;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="import-review">
      <p className="import-summary-line">
        Imported <strong>{result.imported}</strong> cards into “{result.deck.name}”.
        {result.newCards > 0 && ` ${result.newCards} new cards were added to your pool.`}
      </p>

      {result.unsupportedCards.length > 0 && (
        <>
          <p className="import-note">
            <strong>{result.unsupported}</strong> of those can’t be simulated yet — they are in the
            deck and you can edit and print them, but the Lab won’t run until they’re replaced or
            the engine catches up:
          </p>
          <ul className="import-problem-list">
            {result.unsupportedCards.map((card) => (
              <li key={card.name}>
                <span className="import-problem__name">
                  {card.qty}× {card.name}
                </span>
                {card.systems.length > 0 && (
                  <span className="import-problem__reason">needs {card.systems.join('; ')}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {result.notFoundNames.length > 0 && (
        <>
          <p className="import-note">
            <strong>{result.skippedNotFound}</strong>{' '}
            {result.skippedNotFound === 1 ? 'copy was' : 'copies were'} left out — Scryfall has no
            card by {result.notFoundNames.length === 1 ? 'this name' : 'these names'}. A typo or an
            odd export format is the usual cause, so it’s worth a second look:
          </p>
          <ul className="import-problem-list">
            {result.notFoundNames.map((name) => (
              <li key={name}>
                <span className="import-problem__name">{name}</span>
                <span className="import-problem__status">Not found</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {result.skippedSideboard > 0 && (
        <ul className="import-problem-list">
          <li>{result.skippedSideboard} copies skipped — sideboard (decks here are maindeck only).</li>
        </ul>
      )}
      <button type="button" className="btn btn--primary" onClick={onClose}>
        Done
      </button>
    </div>
  );
}
