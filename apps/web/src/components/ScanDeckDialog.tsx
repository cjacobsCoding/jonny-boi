import { useState, type ReactElement } from 'react';
import { useCardScan } from '../lib/scan/useCardScan.js';
import { matchCardName } from '../lib/scan/match.js';
import type { ScannedCard } from '../lib/scan/pipeline.js';

/**
 * Scan a photo of physical cards into a decklist.
 *
 * The flow is photo → detect → OCR the title of each card → correct against
 * every real card name → REVIEW → hand the resulting decklist to the importer,
 * which turns it into real, playable cards.
 *
 * The review grid is not a formality. Every card shows its own crop next to the
 * name we think it is, cards we are unsure about are flagged, and any guess can
 * be re-picked from the runners-up or typed in. A scanner that quietly swapped
 * one card for a look-alike would poison a deck in a way that is very hard to
 * notice later, so nothing is accepted on the scanner's word alone.
 */
export function ScanDeckDialog({
  onClose,
  onUseDecklist,
}: {
  onClose: () => void;
  /** Hand the reviewed decklist text to the deck importer. */
  onUseDecklist: (decklistText: string) => void;
}): ReactElement {
  const scanner = useCardScan();
  const [manualRows, setManualRows] = useState('');
  const [manualColumns, setManualColumns] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const runScan = (chosen: File | null): void => {
    if (!chosen) return;
    const rows = Number.parseInt(manualRows, 10);
    const columns = Number.parseInt(manualColumns, 10);
    const useManual = Number.isFinite(rows) && Number.isFinite(columns) && rows > 0 && columns > 0;
    void scanner.scan(chosen, useManual ? { rows, columns } : undefined);
  };

  const recognized = scanner.scanned.length - scanner.unrecognized;

  return (
    <div className="import-backdrop" role="dialog" aria-modal="true" aria-label="Scan cards from a photo">
      <div className="import-dialog">
        <div className="import-dialog__header">
          <h2 className="import-title">Scan a deck from a photo</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="import-intro">
          Lay the cards out in a grid on a plain surface, with each card’s name visible, and take one
          photo. Everything runs on your device — the photo is never uploaded.
        </p>

        <div className="import-row">
          <label className="btn btn--primary scan-file-label">
            Choose a photo…
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="import-file-input"
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                runScan(chosen);
              }}
              aria-label="Photo of your cards"
            />
          </label>
          {file && scanner.phase !== 'scanning' && (
            <button type="button" className="btn btn--ghost" onClick={() => runScan(file)}>
              Scan again
            </button>
          )}
        </div>

        {(scanner.phase === 'error' || scanner.scanned.length > 0) && (
          <div className="scan-manual">
            <span className="section-label">If the cards weren’t found, tell us the layout</span>
            <div className="import-row">
              <input
                className="input scan-manual__input"
                inputMode="numeric"
                placeholder="rows"
                value={manualRows}
                onChange={(event) => setManualRows(event.target.value)}
                aria-label="Rows of cards in the photo"
              />
              <span className="scan-manual__times">×</span>
              <input
                className="input scan-manual__input"
                inputMode="numeric"
                placeholder="columns"
                value={manualColumns}
                onChange={(event) => setManualColumns(event.target.value)}
                aria-label="Columns of cards in the photo"
              />
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => runScan(file)}
                disabled={!file}
              >
                Use this layout
              </button>
            </div>
          </div>
        )}

        {scanner.phase === 'preparing' && (
          <div className="import-progress">Loading the card vocabulary and the text reader…</div>
        )}
        {scanner.phase === 'scanning' && scanner.progress && (
          <div className="import-progress">
            Reading card {scanner.progress.done} of {scanner.progress.total}…
          </div>
        )}
        {scanner.phase === 'error' && scanner.error && <div className="io-error">{scanner.error}</div>}

        {scanner.scanned.length > 0 && (
          <div className="import-review">
            <div className="section-label">Review</div>
            <div className="import-counts">
              <span className="import-count import-count--ok">{recognized} recognized</span>
              {scanner.unrecognized > 0 && (
                <span className="import-count import-count--warn">
                  {scanner.unrecognized} need a name
                </span>
              )}
              <span className="import-count">{scanner.scanned.length} cards found</span>
            </div>

            <p className="import-note">
              Check anything highlighted, then create the deck. Every name here is corrected against
              the full list of real Magic cards.
            </p>

            <div className="scan-grid">
              {scanner.scanned.map((card) => (
                <ScannedCardTile
                  key={card.index}
                  card={card}
                  onChoose={(name) => scanner.chooseName(card.index, name)}
                  searchNames={(text) =>
                    scanner.nameIndex ? matchCardName(text, scanner.nameIndex, 6) : []
                  }
                />
              ))}
            </div>

            <div className="import-commit">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => onUseDecklist(scanner.decklistText())}
                disabled={recognized === 0}
              >
                Use these {recognized} cards
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One detected card in the review grid: its crop, its name, and a way to fix it. */
function ScannedCardTile({
  card,
  onChoose,
  searchNames,
}: {
  card: ScannedCard;
  onChoose: (name: string | null) => void;
  searchNames: (text: string) => ReadonlyArray<{ name: string }>;
}): ReactElement {
  const [typed, setTyped] = useState('');
  const needsAttention = !card.chosenName || !card.confident;
  const suggestions = typed.trim().length > 0 ? searchNames(typed) : card.matches;

  return (
    <div className={`scan-tile${needsAttention ? ' scan-tile--attention' : ''}`}>
      {card.thumbnailUrl ? (
        <img className="scan-tile__image" src={card.thumbnailUrl} alt="" />
      ) : (
        <div className="scan-tile__image scan-tile__image--empty" />
      )}

      <div className="scan-tile__name">{card.chosenName ?? 'Not recognized'}</div>
      {card.ocrText && card.ocrText !== card.chosenName && (
        <div className="scan-tile__ocr">read: “{card.ocrText}”</div>
      )}

      <input
        className="input scan-tile__search"
        placeholder="Type to find a card…"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        aria-label={`Correct card ${card.index + 1}`}
      />

      <div className="scan-tile__options">
        {suggestions.map((option) => (
          <button
            key={option.name}
            type="button"
            className={`scan-tile__option${
              option.name === card.chosenName ? ' scan-tile__option--chosen' : ''
            }`}
            onClick={() => {
              onChoose(option.name);
              setTyped('');
            }}
          >
            {option.name}
          </button>
        ))}
        {card.chosenName && (
          <button
            type="button"
            className="scan-tile__option scan-tile__option--clear"
            onClick={() => onChoose(null)}
          >
            Not a card
          </button>
        )}
      </div>
    </div>
  );
}
