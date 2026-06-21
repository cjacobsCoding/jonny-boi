import type { ReactElement } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import type { ReplayPermanent } from '../../lib/replay-types.js';

/**
 * A compact battlefield permanent for the replay board: the card's art crop (when
 * the instance maps to a pool card) with name, effective P/T, and tapped/sick/
 * damaged state. Reuses the bundled card index + Scryfall art (DRY — same image
 * source as `CardArt`), degrading to a labeled chip when art is unavailable.
 */
export function PermanentTile({ permanent }: { permanent: ReplayPermanent }): ReactElement {
  const card = permanent.cardId ? getCard(permanent.cardId) : undefined;
  const art = card ? cardImage(card, 'art_crop') : undefined;
  const wounded = permanent.isCreature && permanent.damageMarked > 0;

  return (
    <div
      className={`perm${permanent.tapped ? ' perm--tapped' : ''}`}
      title={`${permanent.name}${
        permanent.isCreature ? ` · ${permanent.power}/${permanent.toughness}` : ''
      }${permanent.summoningSick ? ' · summoning sick' : ''}`}
    >
      <div className="perm__art">
        {art ? (
          <img src={art} alt={permanent.name} loading="lazy" decoding="async" />
        ) : (
          <span className="perm__fallback">{permanent.name}</span>
        )}
        {permanent.tapped && (
          <span className="perm__tap-badge" aria-label="Tapped">
            ⤵
          </span>
        )}
      </div>
      <div className="perm__foot">
        <span className="perm__name" title={permanent.name}>
          {permanent.name}
        </span>
        {permanent.isCreature && (
          <span className={`perm__pt${wounded ? ' perm__pt--wounded' : ''}`}>
            {permanent.power}/{permanent.toughness}
            {wounded && <span className="perm__dmg"> (−{permanent.damageMarked})</span>}
          </span>
        )}
      </div>
    </div>
  );
}
