import { useEffect, useRef, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { cardImage, displayRarity } from '../lib/cards.js';
import { whyUnplayable } from '../lib/decklist/deckHealth.js';
import { ManaCost } from './ManaCost.js';

interface CardDetailProps {
  card: NormalizedCard;
  onClose: () => void;
}

/**
 * §3.167 — "Not playable yet — needs …", from the same funnel the deck builder's
 * ⚠ and Play's refusal read (`whyUnplayable`), so the detail view can never say
 * something a deck holding the card would not. Nothing is rendered for a card
 * the engine plays.
 */
function UnplayableNote({ cardId }: { readonly cardId: string }): ReactElement | null {
  const systems = whyUnplayable(cardId);
  if (systems === undefined) return null;
  return (
    <p className="modal__unplayable" role="note">
      <strong>Not playable yet.</strong> You can add it to a deck, but that deck cannot be played or
      tested until the engine learns: {systems.join('; ')}.
    </p>
  );
}

/** Elements a Tab press may land on inside the dialog (the focus-trap ring). */
const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The single reusable card detail view (DRY). Renders a large card image plus
 * full data: mana cost, type line, oracle text, P/T, colors, keywords, set, and
 * rarity. Shown as a modal; closes on overlay click or the Escape key.
 */
export function CardDetail({ card, onClose }: CardDetailProps): ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  /**
   * Keyboard discipline for a real modal. The dialog declares `aria-modal`, so
   * focus has to live inside it: on open we move focus in (remembering where it
   * came from), Tab/Shift+Tab wrap within the dialog instead of walking the card
   * grid behind the overlay, Escape closes, and on close focus returns to the
   * tile the user opened.
   */
  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusableIn = (root: HTMLElement): HTMLElement[] =>
      [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => !element.hasAttribute('disabled'),
      );

    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = focusableIn(dialog);
      if (focusable.length === 0) {
        // Nothing to land on — keep focus on the dialog itself.
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const imageUrl = cardImage(card, 'large');
  const pt =
    card.power !== null && card.toughness !== null ? `${card.power}/${card.toughness}` : null;

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={card.name}
        // Programmatically focusable (so focus can enter the dialog) but not a
        // tab stop of its own.
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{ position: 'relative' }}
      >
        <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div className="modal__art">
          {imageUrl ? (
            <img src={imageUrl} alt={card.name} />
          ) : (
            <div className="card-fallback">
              <span className="card-fallback__name">{card.name}</span>
              <span>{card.rawTypeLine}</span>
            </div>
          )}
        </div>
        <div className="modal__body">
          <div className="card-tile__name-row">
            <h2 className="modal__title">{card.name}</h2>
            <ManaCost cost={card.manaCost} />
          </div>
          <div className="modal__type">{card.rawTypeLine}</div>

          <UnplayableNote cardId={card.id} />

          {card.oracleText && <p className="oracle-text">{card.oracleText}</p>}

          {card.keywords.length > 0 && (
            <div className="keyword-tags">
              {card.keywords.map((keyword) => (
                <span key={keyword} className="tag">
                  {keyword}
                </span>
              ))}
            </div>
          )}

          <dl className="data-grid">
            <dt>Mana value</dt>
            <dd>{card.cmc}</dd>
            {pt && (
              <>
                <dt>Power / Toughness</dt>
                <dd>{pt}</dd>
              </>
            )}
            <dt>Colors</dt>
            <dd>{card.colors.length > 0 ? card.colors.join(' / ') : 'Colorless'}</dd>
            <dt>Rarity</dt>
            <dd className={`rarity rarity--${card.rarity}`}>{displayRarity(card.rarity)}</dd>
            <dt>Set</dt>
            <dd>
              {card.set.toUpperCase()} · #{card.collectorNumber}
            </dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
