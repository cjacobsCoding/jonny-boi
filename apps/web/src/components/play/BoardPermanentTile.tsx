import type { CSSProperties, ReactElement } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import { CardHover } from '../CardHover.js';
import type { BoardPermanent } from '../../lib/play/view-model.js';
import type { JailedCardView } from '../../lib/play/jail-view.js';
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
  jailed,
  onInspectJailed,
}: {
  perm: BoardPermanent;
  selected?: boolean;
  selectable?: boolean;
  /** A small overlay label (e.g. "ATK", "→ blocks X"). */
  marker?: string;
  onClick?: () => void;
  /**
   * Cards THIS permanent exiled "until it leaves the battlefield" (§3.57):
   * rendered tucked underneath the tile with their tops peeking out, so a
   * Banisher Priest visibly HOLDS its prisoner. Grouped by the pure
   * `jail-view` model; absent/empty renders the tile exactly as before.
   */
  jailed?: readonly JailedCardView[];
  /** Zoom a peeked prisoner (routes to the shared CardZoomOverlay). */
  onInspectJailed?: (card: JailedCardView) => void;
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
          // draggable={false} — §3.54's standing rule: battlefield tiles are
          // click targets (attack/block/target selection), and a native image
          // drag would eat the pointer stream exactly as it did in the hand.
          <img src={art} alt={perm.name} loading="lazy" decoding="async" draggable={false} />
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
  // `data-perm-id` marks the tile as a measurable anchor for the combat lines
  // and the death-ghost animation (§3.57) — data only, no behavior.
  const tile =
    onClick && selectable ? (
      <CardHover cardId={perm.cardId}>
        <button
          type="button"
          className={className}
          data-perm-id={perm.instanceId}
          onClick={onClick}
          title={title}
          aria-pressed={selected}
        >
          {body}
        </button>
      </CardHover>
    ) : (
      <CardHover cardId={perm.cardId}>
        <div className={className} data-perm-id={perm.instanceId} title={title}>
          {body}
        </div>
      </CardHover>
    );

  // No prisoners → exactly the DOM this tile always rendered.
  if (!jailed || jailed.length === 0) return tile;

  return (
    <div className="perm-stack">
      {jailed.map((prisoner, index) => (
        <JailedPeek
          key={prisoner.instanceId}
          prisoner={prisoner}
          index={index}
          jailerName={perm.name}
          onInspect={onInspectJailed}
        />
      ))}
      {tile}
    </div>
  );
}

/**
 * One tucked prisoner, peeking out from behind its jailer's top edge. A button
 * (click or right-click zooms it) because a card you can barely see is exactly
 * the card you need to inspect.
 */
function JailedPeek({
  prisoner,
  index,
  jailerName,
  onInspect,
}: {
  prisoner: JailedCardView;
  index: number;
  jailerName: string;
  onInspect?: (card: JailedCardView) => void;
}): ReactElement {
  const card = getCard(prisoner.cardId);
  const art = card ? cardImage(card, 'art_crop') : undefined;
  const label = `${prisoner.name} — exiled until ${jailerName} leaves the battlefield`;
  const inspect = onInspect ? () => onInspect(prisoner) : undefined;
  return (
    <button
      type="button"
      className="perm-stack__jailed"
      style={{ '--jail-slot': index } as CSSProperties}
      title={label}
      aria-label={label}
      onClick={inspect}
      onContextMenu={
        inspect
          ? (e) => {
              e.preventDefault();
              inspect();
            }
          : undefined
      }
    >
      {/* draggable={false} — §3.54's rule: no image near a gesture surface may
          start a native drag. */}
      {art ? (
        <img src={art} alt="" loading="lazy" decoding="async" draggable={false} />
      ) : (
        <span className="perm-stack__jailed-name">{prisoner.name}</span>
      )}
      <span className="perm-stack__jailed-tag" aria-hidden="true">
        ⛓ {prisoner.name}
      </span>
    </button>
  );
}
