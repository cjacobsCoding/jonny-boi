import type { ReactElement } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import { CardHover } from '../CardHover.js';
import type { BoardPermanent } from '../../lib/play/view-model.js';
import './planeswalker.css';

/** Short keyword abbreviations shown as chips on a creature. */
const KEYWORD_ABBR: Readonly<Record<string, string>> = {
  flying: 'FL',
  vigilance: 'VG',
  haste: 'HA',
  firstStrike: 'FS',
  doubleStrike: 'DS',
  deathtouch: 'DT',
  trample: 'TR',
  reach: 'RE',
  defender: 'DEF',
  lifelink: 'LL',
};

/**
 * A battlefield permanent for the hotseat board. Renders effective P/T (continuous
 * effects already folded by the view-model), tapped + summoning-sick indicators,
 * marked damage, and keyword chips. Optionally selectable (for declaring attackers/
 * blockers or as a spell target). Reuses the bundled Scryfall art.
 */
export function BoardPermanentTile({
  perm,
  selected,
  selectable,
  marker,
  onClick,
}: {
  perm: BoardPermanent;
  selected?: boolean;
  selectable?: boolean;
  /** A small overlay label (e.g. "ATK", "→ blocks X"). */
  marker?: string;
  onClick?: () => void;
}): ReactElement {
  const card = getCard(perm.cardId);
  const art = card ? cardImage(card, 'art_crop') : undefined;
  const wounded = perm.isCreature && perm.damageMarked > 0;
  const keywords = Object.entries(perm.keywords)
    .filter(([, v]) => v)
    .map(([k]) => KEYWORD_ABBR[k] ?? k);

  const className =
    `perm${perm.tapped ? ' perm--tapped' : ''}` +
    `${selectable ? ' perm--selectable' : ''}` +
    `${selected ? ' perm--selected' : ''}` +
    `${perm.summoningSick && perm.isCreature ? ' perm--sick' : ''}`;

  const title =
    `${perm.name}` +
    (perm.isCreature ? ` · ${perm.power}/${perm.toughness}` : '') +
    (perm.isPlaneswalker ? ` · ${perm.loyalty} loyalty` : '') +
    (perm.isBattle ? ` · ${perm.defense} defense · protected by ${perm.protector}` : '') +
    (perm.tapped ? ' · tapped' : '') +
    (perm.summoningSick && perm.isCreature ? ' · summoning sick' : '');

  const body = (
    <>
      <div className="perm__art">
        {art ? (
          <img src={art} alt={perm.name} loading="lazy" decoding="async" />
        ) : (
          <span className="perm__fallback">{perm.name}</span>
        )}
        {perm.tapped && (
          <span className="perm__tap-badge" aria-label="Tapped">
            ⤵
          </span>
        )}
        {marker && <span className="perm__marker">{marker}</span>}
      </div>
      <div className="perm__foot">
        <span className="perm__name" title={perm.name}>
          {perm.name}
        </span>
        {perm.isCreature && (
          <span className={`perm__pt${wounded ? ' perm__pt--wounded' : ''}`}>
            {perm.power}/{perm.toughness}
            {wounded && <span className="perm__dmg"> (−{perm.damageMarked})</span>}
          </span>
        )}
        {perm.isPlaneswalker && (
          <span className="perm__loyalty" aria-label={`${perm.loyalty} loyalty`} title="Loyalty">
            ◆ {perm.loyalty}
          </span>
        )}
        {/*
          A battle's defense is its life total exactly as loyalty is a walker's,
          so it gets the same badge treatment with its own glyph — a shield for
          defense against the walker's loyalty diamond, so the two are
          distinguishable at a glance on a crowded board.
        */}
        {perm.isBattle && (
          <span className="perm__defense" aria-label={`${perm.defense} defense`} title="Defense">
            ⛨ {perm.defense}
          </span>
        )}
      </div>
      {keywords.length > 0 && (
        <div className="perm__keywords">
          {keywords.map((k) => (
            <span key={k} className="perm__kw">
              {k}
            </span>
          ))}
        </div>
      )}
    </>
  );

  // Wrapped so hovering a permanent raises the full, readable card — the tile
  // itself is only an art crop, and a player needs the rules text to decide.
  if (onClick && selectable) {
    return (
      <CardHover cardId={perm.cardId}>
        <button type="button" className={className} onClick={onClick} title={title} aria-pressed={selected}>
          {body}
        </button>
      </CardHover>
    );
  }
  return (
    <CardHover cardId={perm.cardId}>
      <div className={className} title={title}>
        {body}
      </div>
    </CardHover>
  );
}
