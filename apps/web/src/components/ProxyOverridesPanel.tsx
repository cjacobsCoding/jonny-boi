import { useRef, type ReactElement } from 'react';
import type { ResolvedProxyCard } from '../lib/proxy/scryfall.js';
import type { CardOverride, OverrideMap } from '../lib/proxy/overrides.js';
import { getOverride } from '../lib/proxy/overrides.js';
import { printLabel, type PrintOption } from '../lib/proxy/prints.js';
import { usePrints } from '../lib/proxy/usePrints.js';
import { PROXY_THUMBNAIL_WIDTH_PX, UPLOAD_ACCEPT_ATTR } from '../lib/proxy/config.js';

/** A failed upload, surfaced inline on the offending card's row. */
export interface UploadError {
  name: string;
  reason: string;
}

/** Short badge text describing an active override. */
function overrideBadge(override: CardOverride): string {
  if (override.kind === 'upload') return 'custom · upload';
  return override.set ? `custom · ${override.set}` : 'custom';
}

/** One card row: thumbnail (effective art) + change-printing / upload / reset. */
function OverrideRow({
  card,
  override,
  prints,
  onSetPrinting,
  onUpload,
  onReset,
  uploadError,
}: {
  card: ResolvedProxyCard;
  override: CardOverride | undefined;
  prints: ReturnType<typeof usePrints>;
  onSetPrinting: (name: string, option: PrintOption) => void;
  onUpload: (name: string, file: File) => void;
  onReset: (name: string) => void;
  uploadError: UploadError | null;
}): ReactElement {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const effectiveImage = override?.imageUrl ?? card.imageUrl;
  const pickerOpen = prints.activeName === card.name;

  const togglePicker = () => {
    if (pickerOpen) prints.clear();
    else void prints.load(card.name);
  };

  return (
    <li className="proxy-override">
      <div className="proxy-override__main">
        <img
          className="proxy-override__thumb"
          src={effectiveImage}
          alt={card.name}
          width={PROXY_THUMBNAIL_WIDTH_PX}
          loading="lazy"
          decoding="async"
        />
        <div className="proxy-override__body">
          <div className="proxy-override__name">
            {card.name}
            {override && (
              <span className="proxy-override__badge">{overrideBadge(override)}</span>
            )}
          </div>
          <div className="proxy-override__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={togglePicker}
              aria-expanded={pickerOpen}
            >
              {pickerOpen ? 'Hide printings' : 'Change printing'}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Upload
            </button>
            {override && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onReset(card.name)}
              >
                Reset
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={UPLOAD_ACCEPT_ATTR}
              className="proxy-override__file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUpload(card.name, file);
                event.target.value = ''; // Allow re-selecting the same file.
              }}
            />
          </div>
          {uploadError && uploadError.name === card.name && (
            <div className="proxy-override__error">{uploadError.reason}</div>
          )}
        </div>
      </div>

      {pickerOpen && (
        <div className="proxy-override__picker">
          {prints.status === 'loading' && (
            <p className="proxy-override__hint">Loading printings…</p>
          )}
          {prints.status === 'error' && (
            <p className="proxy-override__hint">Couldn’t load printings — try again.</p>
          )}
          {prints.status === 'done' && prints.prints.length === 0 && (
            <p className="proxy-override__hint">No alternate printings found.</p>
          )}
          {prints.prints.length > 0 && (
            <div className="proxy-override__prints">
              {prints.prints.map((option) => {
                const selected =
                  override?.kind === 'printing' && override.scryfallId === option.scryfallId;
                return (
                  <button
                    key={option.scryfallId}
                    type="button"
                    className={`proxy-print${selected ? ' proxy-print--selected' : ''}`}
                    title={printLabel(option)}
                    onClick={() => onSetPrinting(card.name, option)}
                  >
                    <img
                      className="proxy-print__img"
                      src={option.thumbnailUrl}
                      alt={printLabel(option)}
                      width={PROXY_THUMBNAIL_WIDTH_PX}
                      loading="lazy"
                      decoding="async"
                    />
                    <span className="proxy-print__label">{option.set ?? '—'}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The overrides panel: one row per resolved card with a thumbnail of its
 * effective art and controls to pick an alternate printing, upload custom art,
 * or reset to default. Collapsible printing picker keeps it uncluttered. All
 * mutations flow up to the view, which owns the persisted override model.
 */
export function ProxyOverridesPanel({
  cards,
  overrides,
  onSetPrinting,
  onUpload,
  onReset,
  onClearAll,
  uploadError,
}: {
  cards: readonly ResolvedProxyCard[];
  overrides: OverrideMap;
  onSetPrinting: (name: string, option: PrintOption) => void;
  onUpload: (name: string, file: File) => void;
  onReset: (name: string) => void;
  onClearAll: () => void;
  uploadError: UploadError | null;
}): ReactElement | null {
  const prints = usePrints();
  if (cards.length === 0) return null;

  const overrideCount = cards.filter((c) => getOverride(overrides, c.name)).length;

  return (
    <div className="proxy-overrides no-print">
      <div className="proxy-overrides__head">
        <span className="section-label">
          Card art{overrideCount > 0 ? ` · ${overrideCount} custom` : ''}
        </span>
        {overrideCount > 0 && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClearAll}>
            Clear all overrides
          </button>
        )}
      </div>
      <ul className="proxy-overrides__list">
        {cards.map((card) => (
          <OverrideRow
            key={card.name}
            card={card}
            override={getOverride(overrides, card.name)}
            prints={prints}
            onSetPrinting={onSetPrinting}
            onUpload={onUpload}
            onReset={onReset}
            uploadError={uploadError}
          />
        ))}
      </ul>
    </div>
  );
}
