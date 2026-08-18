import { useState, type ReactElement } from 'react';
import { useCardScan } from '../lib/scan/useCardScan.js';
import { matchCardName } from '../lib/scan/match.js';
import type { ScannedCard } from '../lib/scan/pipeline.js';

/**
 * Scan a photo of physical cards into a decklist.
 *
 * The flow is photo → find the piles → OCR each pile's title → correct against
 * every real card name → REVIEW → hand the resulting decklist to the importer,
 * which turns it into real, playable cards.
 *
 * The review grid is not a formality. Every pile shows its own crop next to the
 * name we think it is and the number of copies we counted, anything we are
 * unsure about is flagged, and both the name and the count can be corrected. A
 * scanner that quietly swapped one card for a look-alike, or imported three
 * copies as four, would poison a deck in a way that is very hard to notice
 * later, so nothing is accepted on the scanner's word alone.
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
          Put the copies of each card in a pile, fanned so every name shows, and lay the piles out in
          rows on a plain surface. One photo then gives both the cards and how many of each. Single
          cards laid out in a grid work too. Everything runs on your device — the photo is never
          uploaded.
        </p>

        <div className="import-row">
          <label className="btn btn--primary scan-file-label">
            Choose a photo…
            {/*
              No `capture` attribute on purpose. It forces the camera and hides
              the gallery on mobile, which blocks the most common case by far —
              someone who already laid the deck out and took the photo. Without
              it the browser offers both.
            */}
            <input
              type="file"
              accept="image/*"
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
              <span className="import-count import-count--ok">{scanner.copies} cards</span>
              {scanner.unrecognized > 0 && (
                <span className="import-count import-count--warn">
                  {scanner.unrecognized} need a name
                </span>
              )}
              <span className="import-count">{scanner.scanned.length} piles found</span>
            </div>

            <p className="import-note">
              Check anything highlighted, and check the counts — the number on each pile is how many
              copies we think it holds. Every name is corrected against the full list of real Magic
              cards.
            </p>

            <div className="scan-grid">
              {scanner.scanned.map((card) => (
                <ScannedCardTile
                  key={card.index}
                  card={card}
                  onChoose={(name) => scanner.chooseName(card.index, name)}
                  onQuantity={(qty) => scanner.chooseQuantity(card.index, qty)}
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
                Use these {scanner.copies} cards
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One detected pile in the review grid: its crop, its name, its count, and ways to fix both. */
function ScannedCardTile({
  card,
  onChoose,
  onQuantity,
  searchNames,
}: {
  card: ScannedCard;
  onChoose: (name: string | null) => void;
  onQuantity: (qty: number) => void;
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

      <div className="scan-tile__qty">
        <button
          type="button"
          className="scan-tile__qty-step"
          onClick={() => onQuantity(card.qty - 1)}
          disabled={card.qty <= 1}
          aria-label={`One fewer copy of card ${card.index + 1}`}
        >
          −
        </button>
        <span className="scan-tile__qty-value">{card.qty}×</span>
        <button
          type="button"
          className="scan-tile__qty-step"
          onClick={() => onQuantity(card.qty + 1)}
          aria-label={`One more copy of card ${card.index + 1}`}
        >
          +
        </button>
      </div>

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
