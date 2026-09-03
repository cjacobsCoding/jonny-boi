import type { ReactElement } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import type { RevealView } from '../../lib/play/reveals.js';

/**
 * A card REVEALED to both players, shown on the board (§3.119; bug report
 * 20260901_210413 — "The goblin guide of the enemy is not revealing the top
 * card of my library so I can see it").
 *
 * A log line alone is not what "so I can see it" means: the reveal is a card
 * being turned face up in front of you, so the banner shows the FACE, says
 * whose library it came from and what became of it. It is `position: fixed`
 * above the board, dismissed by clicking it or by the next reveal, and it is
 * never the only record — the log keeps the line.
 */
export function RevealBanner({ reveal, onDismiss }: { reveal: RevealView; onDismiss: () => void }): ReactElement {
  const card = getCard(reveal.cardId);
  const image = card ? cardImage(card, 'normal') : undefined;
  return (
    <div className="reveal-banner" role="status" onClick={onDismiss}>
      {image && <img className="reveal-banner__img" src={image} alt={reveal.name} decoding="async" draggable={false} />}
      <span className="reveal-banner__text">{reveal.text}</span>
    </div>
  );
}
