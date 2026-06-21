import { useState, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { cardImage } from '../lib/cards.js';

interface CardArtProps {
  card: NormalizedCard;
  /** Which Scryfall image size to request. */
  size?: 'normal' | 'large' | 'art_crop';
}

/**
 * Card art loader with graceful states (DESIGN.md §6: robust to misses).
 *
 * Art is loaded directly from the remote Scryfall URLs in the card index — the
 * simplest path that works in-browser with no local asset pipeline. (Offline
 * art via `npm run fetch` exists but is gitignored; remote URLs are fine here.
 * Browser image caching covers etiquette — we never re-fetch in a loop.)
 *
 * While loading we show a shimmering skeleton; on error (or a missing URL) we
 * show a labeled fallback tile so the grid never renders a broken image.
 */
export function CardArt({ card, size = 'normal' }: CardArtProps): ReactElement {
  const url = cardImage(card, size);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>(
    url ? 'loading' : 'error',
  );

  return (
    <div className="card-tile__art">
      {status === 'loading' && <div className="card-skeleton" aria-hidden="true" />}
      {status === 'error' ? (
        <div className="card-fallback" role="img" aria-label={`${card.name} (image unavailable)`}>
          <span className="card-fallback__name">{card.name}</span>
          <span>{card.rawTypeLine}</span>
        </div>
      ) : (
        <img
          className={`card-tile__img${status === 'loaded' ? ' card-tile__img--loaded' : ''}`}
          src={url}
          alt={card.name}
          loading="lazy"
          decoding="async"
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
        />
      )}
    </div>
  );
}
