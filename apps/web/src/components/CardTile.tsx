import type { ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { displayRarity } from '../lib/cards.js';
import { CardArt } from './CardArt.js';
import { CardHover } from './CardHover.js';
import { ManaCost } from './ManaCost.js';

interface CardTileProps {
  card: NormalizedCard;
  /** Open the detail view for this card. */
  onSelect: (card: NormalizedCard) => void;
  /**
   * §3.167 — false when the engine cannot play this card yet; the tile then
   * wears the "Not playable yet" badge. Omitted means playable (a caller whose
   * list is playable by construction says nothing).
   */
  playable?: boolean;
  /** When provided, the tile shows an in-deck count + add/remove stepper. */
  deck?: {
    count: number;
    canAdd: boolean;
    onAdd: (card: NormalizedCard) => void;
    onRemove: (card: NormalizedCard) => void;
  };
}

/**
 * The single reusable card tile (DRY: card markup lives only here). Shows art,
 * name, mana cost as pips, type line, rarity, and P/T. Clicking the art/name
 * opens the detail view; when in deck-builder context it also renders a copy
 * count badge and an add/remove stepper.
 *
 * ## Hovering a grid tile magnifies it (§3.143 / UX-10, wave 2 GAP-21)
 *
 * Caleb: *"hovering over any card ever should let you see a full clear view of
 * the card"* — **any** card, which includes the thousands in the browser and
 * the deck builder, not just the twenty on a play surface. Every play surface
 * has had {@link CardHover} since §3.53/§3.119 and this grid never did: the
 * tile is a 488×680 art thumbnail whose rules text is unreadable at grid size,
 * so "what does this card actually do?" meant a click, a detail view and a
 * click back.
 *
 * It ADOPTS the app's one hover funnel rather than growing a second one (spec
 * §2.4) — which is also why the glossary reaches here for free the moment
 * `CardHover` draws its preview with `CardFace` instead of a bare `<img>`: one
 * change upstream, every hover in the app. `card-hover-adoption.test.ts` fails
 * if this tile ever stops going through the funnel.
 *
 * The tile's art stays LAZY (`CardArt`) on purpose: this grid is thousands of
 * cards long, and rule 7's eager-image rule is scoped to play surfaces, where
 * nothing is ever off-screen. The hover preview loads one card, on demand.
 *
 * ## The art button’s reset is a CLASS, never an inline style (rule 7)
 *
 * The button carried `style={{ all: 'unset', ... }}`. The CSSOM expands an
 * inline `all` into every CSS longhand, so each tile serialised ~7.4 KB of
 * `style` attribute: 5,651 tiles = a 42 MB DOM on the app’s landing view, which
 * took ~40 s to render under an attached MutationObserver and put
 * `verify-game-resume.mjs` over its 30 s post-reload budget.
 * `.card-tile__art-btn` says exactly the same thing for free. The button does
 * NOT wear `.card-tile__art` any more — every declaration of that rule was
 * being unset here anyway, so it was dead weight that only looked meaningful;
 * the real `.card-tile__art` box is `CardArt`'s own wrapper div.
 */
export function CardTile({ card, onSelect, deck, playable = true }: CardTileProps): ReactElement {
  const pt =
    card.power !== null && card.toughness !== null ? `${card.power}/${card.toughness}` : null;

  return (
    <div className={`card-tile${playable ? '' : ' card-tile--unplayable'}`}>
      {!playable && (
        <span
          className="card-tile__unplayable"
          title="The engine cannot play this card yet — open it to see what it needs"
        >
          Not playable yet
        </span>
      )}
      {deck && deck.count > 0 && (
        <span className="count-badge" aria-label={`${deck.count} in deck`}>
          {deck.count}
        </span>
      )}
      {/* The wrapper is a flex ITEM of `.card-tile` (a column flex container),
          so it is blockified and the tile's layout is unchanged by it. */}
      <CardHover cardId={card.id}>
        <button
          type="button"
          className="card-tile__art-btn"
          onClick={() => onSelect(card)}
          aria-label={`View ${card.name}`}
        >
          <CardArt card={card} size="normal" />
        </button>
      </CardHover>
      <div className="card-tile__body">
        <div className="card-tile__name-row">
          <span className="card-tile__name" title={card.name}>
            {card.name}
          </span>
          <ManaCost cost={card.manaCost} />
        </div>
        <span className="card-tile__type" title={card.rawTypeLine}>
          {card.rawTypeLine}
        </span>
        <div className="card-tile__meta">
          <span className={`rarity rarity--${card.rarity}`}>{displayRarity(card.rarity)}</span>
          {pt && <span className="pt">{pt}</span>}
        </div>
        {deck && (
          <div className="card-tile__deck-controls">
            <div className="stepper">
              <button
                type="button"
                className="stepper__btn"
                onClick={() => deck.onRemove(card)}
                disabled={deck.count === 0}
                aria-label={`Remove one ${card.name}`}
              >
                −
              </button>
              <span className="stepper__count" aria-live="polite">
                {deck.count}
              </span>
              <button
                type="button"
                className="stepper__btn"
                onClick={() => deck.onAdd(card)}
                disabled={!deck.canAdd}
                aria-label={`Add one ${card.name}`}
              >
                +
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
