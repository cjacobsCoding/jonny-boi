import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { DecksApi } from '../lib/useDecks.js';
import { parseDecklist } from '../lib/proxy/parseDecklist.js';
import { deckToDecklist } from '../lib/proxy/deckToText.js';
import { toCountedProxies } from '../lib/proxy/scryfall.js';
import { buildPages } from '../lib/proxy/paginate.js';
import { useProxyResolver } from '../lib/proxy/useProxyResolver.js';
import {
  CUT_GUIDE_WIDTH_MM,
  DEFAULT_DENSITY_ID,
  DEFAULT_PAGE_SIZE_ID,
  GRID_DENSITIES,
  PAGE_SIZES,
  SCRYFALL_ATTRIBUTION,
  getDensity,
  getPageSize,
  perPageFor,
  type PageSizeId,
} from '../lib/proxy/config.js';
import { ProxySheet } from '../components/ProxySheet.js';

/** A small, self-contained sample so the empty view isn't a dead end. */
const SAMPLE_DECKLIST = ['4 Lightning Bolt', '4 Counterspell', '9 Mountain', '9 Island'].join('\n');

/**
 * The Proxies view: paste (or load) a decklist, resolve high-res card art from
 * Scryfall, and render print-ready A4/Letter sheets of exact-size (63×88mm)
 * proxy cards. "Print / Save as PDF" hands off to the browser; the print
 * stylesheet hides the app chrome and renders each sheet at true physical size.
 */
export function ProxiesView({ decks }: { decks: DecksApi }): ReactElement {
  const [text, setText] = useState('');
  const [pageSizeId, setPageSizeId] = useState<PageSizeId>(DEFAULT_PAGE_SIZE_ID);
  const [densityId, setDensityId] = useState<string>(DEFAULT_DENSITY_ID);
  const [showCutGuides, setShowCutGuides] = useState(true);
  const [includeBacks, setIncludeBacks] = useState(true);

  const resolver = useProxyResolver();

  const pageSize = getPageSize(pageSizeId);
  const density = getDensity(densityId);
  const perPage = perPageFor(density);

  // The @page CSS rule cannot read a runtime value, so we set the selected sheet
  // size (and the hairline cut-guide width) into a live <style> element. This is
  // what makes the printed page a true A4/Letter physical page.
  useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-proxy-print', '');
    styleEl.textContent =
      `@media print { @page { size: ${pageSize.cssSize}; margin: 0; } }\n` +
      `:root { --proxy-cut-guide-width: ${CUT_GUIDE_WIDTH_MM}mm; }`;
    document.head.appendChild(styleEl);
    return () => {
      styleEl.remove();
    };
  }, [pageSize.cssSize]);

  const parsed = useMemo(() => parseDecklist(text), [text]);

  const counted = useMemo(
    () => toCountedProxies(parsed.cards, resolver.resolved, includeBacks),
    [parsed.cards, resolver.resolved, includeBacks],
  );
  const pages = useMemo(() => buildPages(counted, perPage), [counted, perPage]);
  const totalCards = counted.reduce((sum, c) => sum + c.qty, 0);

  const handleGenerate = () => {
    if (parsed.cards.length > 0) void resolver.resolve(parsed.cards);
  };

  const loadDeck = (id: string) => {
    const deck = decks.decks.find((d) => d.id === id);
    if (deck) {
      setText(deckToDecklist(deck));
      resolver.reset();
    }
  };

  return (
    <div className="proxies-layout">
      {/* Controls column — hidden when printing via the print stylesheet. */}
      <aside className="proxies-controls no-print" aria-label="Proxy options">
        <h2 className="proxies-title">Proxies</h2>
        <p className="proxies-intro">
          Paste any decklist, fetch high-res art, and print cut-to-size proxies.
        </p>

        <label className="section-label" htmlFor="proxy-decklist">
          Decklist
        </label>
        <textarea
          id="proxy-decklist"
          className="io-textarea proxies-textarea"
          placeholder={'4 Lightning Bolt\n9 Mountain\n2 Fatal Push (mh2)'}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label="Decklist to print as proxies"
        />

        <div className="proxies-row">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setText(SAMPLE_DECKLIST)}
          >
            Load sample
          </button>
          {decks.decks.length > 0 && (
            <select
              className="input"
              aria-label="Load a saved deck"
              defaultValue=""
              onChange={(event) => {
                if (event.target.value) loadDeck(event.target.value);
                event.target.value = '';
              }}
            >
              <option value="" disabled>
                Load saved deck…
              </option>
              {decks.decks.map((deck) => (
                <option key={deck.id} value={deck.id}>
                  {deck.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {parsed.errors.length > 0 && (
          <ul className="proxies-errors">
            {parsed.errors.map((err) => (
              <li key={err.line}>
                Line {err.line}: {err.reason} <code>{err.text}</code>
              </li>
            ))}
          </ul>
        )}

        <div className="proxies-options">
          <label className="proxies-field">
            <span className="section-label">Page size</span>
            <select
              className="input"
              value={pageSizeId}
              onChange={(event) => setPageSizeId(event.target.value as PageSizeId)}
            >
              {PAGE_SIZES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="proxies-field">
            <span className="section-label">Layout</span>
            <select
              className="input"
              value={densityId}
              onChange={(event) => setDensityId(event.target.value)}
            >
              {GRID_DENSITIES.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label className="proxies-check">
            <input
              type="checkbox"
              checked={showCutGuides}
              onChange={(event) => setShowCutGuides(event.target.checked)}
            />
            Cut guides
          </label>

          <label className="proxies-check">
            <input
              type="checkbox"
              checked={includeBacks}
              onChange={(event) => setIncludeBacks(event.target.checked)}
            />
            Double-faced backs
          </label>
        </div>

        <div className="proxies-row">
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleGenerate}
            disabled={parsed.cards.length === 0 || resolver.status === 'resolving'}
          >
            {resolver.status === 'resolving' ? 'Fetching art…' : 'Fetch art'}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => window.print()}
            disabled={pages.length === 0}
          >
            Print / Save as PDF
          </button>
        </div>

        {resolver.status === 'error' && (
          <div className="io-error">
            {resolver.error ?? 'Could not reach Scryfall.'} Check your connection and try again.
          </div>
        )}

        {resolver.unresolved.length > 0 && (
          <div className="proxies-unresolved">
            <div className="section-label">Couldn’t find ({resolver.unresolved.length})</div>
            <ul>
              {resolver.unresolved.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        )}

        {pages.length > 0 && (
          <div className="proxies-summary">
            {totalCards} card{totalCards === 1 ? '' : 's'} · {pages.length} page
            {pages.length === 1 ? '' : 's'} · {pageSize.label} · exact 63 × 88 mm
          </div>
        )}

        <p className="proxies-attribution">{SCRYFALL_ATTRIBUTION}</p>
      </aside>

      {/* Preview / print column. In print, ONLY these sheets are visible. */}
      <div className="proxies-preview" aria-label="Print preview">
        {pages.length === 0 ? (
          <div className="proxies-empty no-print">
            <p>
              {resolver.status === 'done' && counted.length === 0
                ? 'No cards resolved — check the "couldn’t find" list.'
                : 'Paste a decklist and press “Fetch art” to build printable proxy sheets.'}
            </p>
          </div>
        ) : (
          <div className="proxies-pages">
            {pages.map((cards, index) => (
              <ProxySheet
                key={index}
                cards={cards}
                pageSize={pageSize}
                density={density}
                showCutGuides={showCutGuides}
                pageNumber={index + 1}
                pageCount={pages.length}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
