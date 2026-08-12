import { useState, type ReactElement } from 'react';
import type { ProxyCard } from '../lib/proxy/paginate.js';
import {
  CARD_HEIGHT_MM,
  CARD_WIDTH_MM,
  CARD_GAP_MM,
  PAGE_MARGIN_MM,
  type GridDensity,
  type PageSize,
} from '../lib/proxy/config.js';

/**
 * A single printable proxy card: an exact-size (63×88mm) `<img>` with graceful
 * loading/error states so a failed image never renders a broken tile or blanks
 * the page. Cut guides are drawn by the sheet's border/outline, not per card.
 */
function ProxyCardCell({
  card,
  showCutGuides,
}: {
  card: ProxyCard;
  showCutGuides: boolean;
}): ReactElement {
  const [errored, setErrored] = useState(false);
  return (
    <div
      className={`proxy-card${showCutGuides ? ' proxy-card--guides' : ''}`}
      style={{ width: `${CARD_WIDTH_MM}mm`, height: `${CARD_HEIGHT_MM}mm` }}
    >
      {errored ? (
        <div className="proxy-card__fallback" role="img" aria-label={`${card.name} (image unavailable)`}>
          <span>{card.name}</span>
          {card.faceLabel && <span className="proxy-card__face">({card.faceLabel})</span>}
        </div>
      ) : (
        <img
          className="proxy-card__img"
          src={card.imageUrl}
          alt={card.name}
          decoding="async"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}

/**
 * One printable sheet: a fixed physical A4/Letter page holding a grid of
 * exact-size proxy cards. All dimensions are in real `mm` so the browser prints
 * true-to-size regardless of screen DPI. On screen the parent scales the sheet
 * down for preview; the print stylesheet renders it at 1:1 physical size.
 */
export function ProxySheet({
  cards,
  pageSize,
  density,
  showCutGuides,
  pageNumber,
  pageCount,
}: {
  cards: readonly ProxyCard[];
  pageSize: PageSize;
  density: GridDensity;
  showCutGuides: boolean;
  pageNumber: number;
  pageCount: number;
}): ReactElement {
  return (
    <div
      className="proxy-sheet"
      style={{
        width: `${pageSize.widthMm}mm`,
        height: `${pageSize.heightMm}mm`,
        padding: `${PAGE_MARGIN_MM}mm`,
      }}
    >
      <div
        className="proxy-grid"
        style={{
          gridTemplateColumns: `repeat(${density.columns}, ${CARD_WIDTH_MM}mm)`,
          gridTemplateRows: `repeat(${density.rows}, ${CARD_HEIGHT_MM}mm)`,
          gap: `${CARD_GAP_MM}mm`,
        }}
      >
        {cards.map((card, index) => (
          <ProxyCardCell key={index} card={card} showCutGuides={showCutGuides} />
        ))}
      </div>
      <div className="proxy-sheet__footer" aria-hidden="true">
        Page {pageNumber} / {pageCount}
      </div>
    </div>
  );
}
