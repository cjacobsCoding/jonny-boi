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

/** A signed P/T delta as a badge string: "+1/+1", "-2/-2", "+0/+2". */
export function formatPtDelta(delta: { readonly power: number; readonly toughness: number }): string {
  const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
  return `${signed(delta.power)}/${signed(delta.toughness)}`;
}

/**
 * The combat badge copy — one table, so the tile, its tooltip and any test read
 * the same words. Bug report 20260901_204854: "It needs to be way more clear
 * who is attacking" — the only attack signal was a dashed outline shared with
 * every other selectable tile.
 */
export const COMBAT_BADGES = Object.freeze({
  attacking: '⚔ ATTACKING',
  blocking: '🛡 BLOCKING',
});

/**
 * A battlefield permanent for the hotseat board. Renders effective P/T (continuous
 * effects already folded by the view-model), tapped + summoning-sick indicators,
 * marked damage, and keyword chips. Optionally selectable (for declaring attackers/
 * blockers or as a spell target). Reuses the bundled Scryfall art.
 *
 * Two things it now SAYS that it used to only know (§3.119):
 *  - a creature whose effective P/T differs from the printed card carries a
 *    delta badge ("+1/+1") beside the number, and its tooltip spells out the
 *    printed stats — bug report 20260901_204957, a prowess-pumped 1/2 that
 *    killed a 0/2 while the player read the printed card;
 *  - a creature in combat wears its role — a red "⚔ ATTACKING" band, a blue
 *    "🛡 BLOCKING" one — for as long as the engine's combat state lists it.
 */
export function BoardPermanentTile({
  perm,
  selected,
  selectable,
  marker,
  onClick,
  jailed,
  onInspectJailed,
  targetable,
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
  /**
   * This tile is a LEGAL TARGET of the spell being cast (§3.119, bug report
   * 20260901_211035): it pulses so the player can see where a Cloudshift may
   * land, and a drop of the dragged card onto it is the cast.
   */
  targetable?: boolean;
}): ReactElement {
  const card = getCard(perm.cardId);
  const art = card ? cardImage(card, 'art_crop') : undefined;
  const wounded = perm.isCreature && perm.damageMarked > 0;
  const keywords = Object.entries(perm.keywords)
    .filter(([, v]) => v)
    .map(([k]) => KEYWORD_ABBR[k] ?? k);
  const delta = perm.ptDelta;

  const className =
    `perm${perm.tapped ? ' perm--tapped' : ''}` +
    `${selectable ? ' perm--selectable' : ''}` +
    `${selected ? ' perm--selected' : ''}` +
    `${targetable ? ' perm--targetable' : ''}` +
    `${perm.summoningSick && perm.isCreature ? ' perm--sick' : ''}` +
    `${perm.attacking ? ' perm--attacking' : ''}` +
    `${perm.blocking !== null ? ' perm--blocking' : ''}`;

  const title =
    `${perm.name}` +
    (perm.isCreature
      ? ` · ${perm.power}/${perm.toughness}` +
        (delta ? ` (printed ${perm.printedPower}/${perm.printedToughness}, ${formatPtDelta(delta)})` : '')
      : '') +
    (perm.isPlaneswalker ? ` · ${perm.loyalty} loyalty` : '') +
    (perm.isBattle ? ` · ${perm.defense} defense · protected by ${perm.protector}` : '') +
    (perm.tapped ? ' · tapped' : '') +
    (perm.attacking ? ' · attacking' : '') +
    (perm.blocking !== null ? ' · blocking' : '') +
    (perm.summoningSick && perm.isCreature ? ' · summoning sick' : '');

  const body = (
    <>
      <div className="perm__art">
        {art ? (
          // draggable={false} — §3.54's standing rule: battlefield tiles are
          // click targets (attack/block/target selection), and a native image
          // drag would eat the pointer stream exactly as it did in the hand.
          // loading="eager" — §3.119 (report 20260901_202314): a board tile is
          // never off-screen, so there is nothing for lazy loading to defer.
          <img src={art} alt={perm.name} loading="eager" decoding="async" draggable={false} />
        ) : (
          <span className="perm__fallback">{perm.name}</span>
        )}
        {perm.tapped && (
          <span className="perm__tap-badge" aria-label="Tapped">
            ⤵
          </span>
        )}
        {perm.attacking && (
          <span className="perm__combat perm__combat--attacking" aria-label="Attacking">
            {COMBAT_BADGES.attacking}
          </span>
        )}
        {perm.blocking !== null && !perm.attacking && (
          <span className="perm__combat perm__combat--blocking" aria-label="Blocking">
            {COMBAT_BADGES.blocking}
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
            {delta && (
              <span
                className={`perm__pt-delta${delta.power < 0 || delta.toughness < 0 ? ' perm__pt-delta--down' : ''}`}
                aria-label={`${formatPtDelta(delta)} from the printed ${perm.printedPower}/${perm.printedToughness}`}
              >
                {' '}
                {formatPtDelta(delta)}
              </span>
            )}
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
        <img src={art} alt="" loading="eager" decoding="async" draggable={false} />
      ) : (
        <span className="perm-stack__jailed-name">{prisoner.name}</span>
      )}
      <span className="perm-stack__jailed-tag" aria-hidden="true">
        ⛓ {prisoner.name}
      </span>
    </button>
  );
}
