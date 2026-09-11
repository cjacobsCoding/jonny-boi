import type { CSSProperties, ReactElement } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import { CardHover } from '../CardHover.js';
import { CardFace } from './CardFace.js';
import { useIsStaged } from './combat-stage-context.js';
import { TAP_ROTATION_CONFIG } from '../../lib/play/play-config.js';
import type { BoardPermanent } from '../../lib/play/view-model.js';
import type { JailedCardView } from '../../lib/play/jail-view.js';
import './planeswalker.css';
import './board-scene.css';

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
 * §3.133 — how a COUNTER kind is drawn. A row per kind that means something to
 * the eye; every other kind falls back to its own printed name, so a charge or
 * a stun counter shows up correctly the day a card makes one rather than being
 * silently dropped.
 */
const COUNTER_TONE: Readonly<Record<string, 'boost' | 'shrink'>> = {
  '+1/+1': 'boost',
  '-1/-1': 'shrink',
};

/** The label a counter chip prints: "+1/+1 ×3", "stun ×1". */
export function formatCounterChip(kind: string, count: number): string {
  return count === 1 ? kind : `${kind} ×${count}`;
}

/**
 * WHERE A TILE IS BEING DRAWN (UX-12/13). CLOSED — a fourth value is a ROW.
 *
 * `undefined`  the ordinary case: the tile is in the flow and IS the anchor.
 * `'home'`     this card is also painted advanced on the combat stage, so the
 *              tile stays for layout and clicks but gives up `data-perm-id`.
 * `'copy'`     the advanced copy on the stage: it carries `data-perm-id`, it is
 *              not interactive, and it renders no prisoners (the jail peek
 *              belongs with the jailer's real position).
 */
export type TileStaging = 'home' | 'copy';

/**
 * A battlefield permanent for the hotseat board.
 *
 * ## Three nested elements, one transform each (UX-11)
 *
 * `.perm-slot` reserves the LAYOUT footprint, `.perm-turn` carries the tap
 * rotation and `.perm` keeps game-fx.css's combat lunge. They are separate
 * elements because a CSS animation outranks a normal declaration: while the
 * lunge and the tap rotation lived on ONE element the lunge erased the turn, so
 * a tapped ATTACKER — the commonest tapped creature in the game — stood
 * upright. See board-scene.css for the cascade note and `tile-transform.test.ts`
 * for the guard.
 *
 * ## The face is lane P's `CardFace` (UX-17)
 *
 * The tile no longer renders a bare "+1/+1" badge. `CardFace` draws the card
 * wearing its CURRENT truth — a 4/5 under an anthem prints **5/6**, visibly
 * altered, with a hover breakdown naming every contributing card, and a granted
 * keyword appears in the rules text as if printed. That is one renderer reading
 * core's own `explainCharacteristics`, replacing a badge that could show the
 * NUMBER but never the SOURCE (scope §2.1, rule 12).
 *
 * The keyword chips below the face are therefore the PRINTED keywords only,
 * whenever core can tell us which those are: a granted `flying` already appears
 * in the face's rules text with its aftermarket treatment, and repeating it as
 * an unattributed "FL" chip would be the same fork one level down.
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
  staged: stagedProp,
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
  /**
   * See {@link TileStaging}. Passed explicitly only by the stage itself
   * (`'copy'`); an in-flow tile learns it is a `'home'` from the context the
   * board provides, because `SeatPanel` — which renders every tile and is owned
   * by no lane — has no prop to carry it. See `combat-stage-context.ts`.
   */
  staged?: TileStaging;
}): ReactElement {
  const contextStaged = useIsStaged(perm.instanceId);
  const staged: TileStaging | undefined = stagedProp ?? (contextStaged ? 'home' : undefined);
  const card = getCard(perm.cardId);
  const art = card ? cardImage(card, 'art_crop') : undefined;
  const wounded = perm.isCreature && perm.damageMarked > 0;
  // Printed keywords when core can say which are printed; effective otherwise —
  // an honest fallback for the online board, which carries no explanation.
  const chipSource = perm.explanation?.printedKeywords ?? perm.keywords;
  const keywords = Object.entries(chipSource)
    .filter(([, v]) => v)
    .map(([k]) => KEYWORD_ABBR[k] ?? k);
  const isCopy = staged === 'copy';

  const className =
    `perm${perm.tapped ? ' perm--tapped' : ''}` +
    `${selectable ? ' perm--selectable' : ''}` +
    `${selected ? ' perm--selected' : ''}` +
    `${targetable ? ' perm--targetable' : ''}` +
    `${perm.summoningSick && perm.isCreature ? ' perm--sick' : ''}` +
    `${perm.attacking ? ' perm--attacking' : ''}` +
    `${perm.blocking !== null ? ' perm--blocking' : ''}`;

  // The tooltip no longer restates the P/T: the face states it, with provenance,
  // and a `title` attribute that disagreed with the card under the cursor was
  // exactly the two-answers problem UX-17 exists to end.
  const title =
    `${perm.name}` +
    (perm.isPlaneswalker ? ` · ${perm.loyalty} loyalty` : '') +
    (perm.isBattle ? ` · ${perm.defense} defense · protected by ${perm.protector}` : '') +
    (perm.counters.length > 0
      ? ` · ${perm.counters.map((c) => `${c.count}× ${c.kind} counter`).join(', ')}`
      : '') +
    (perm.tapped ? ' · tapped' : '') +
    (perm.attacking ? ' · attacking' : '') +
    (perm.blocking !== null ? ' · blocking' : '') +
    (perm.summoningSick && perm.isCreature ? ' · summoning sick' : '');

  /** The board chrome drawn OVER the card face — counters, combat role, markers. */
  const chrome = (
    <>
      {perm.tapped && (
        <span className="perm__tap-badge" aria-label="Tapped">
          ⟳ TAPPED
        </span>
      )}
      {/*
        §3.133 — WHY this creature is the size it is. The counter chips stay:
        a "+1/+1 ×3" is a PERMANENT fact about the object, and the face's P/T
        says the total, not how much of it wears off at end of turn. The old
        "✦ +1/+1 from a spell or ability" chip is GONE — that was the
        subtraction-derived half, and the face's breakdown now names the actual
        spell instead of saying "a spell or ability".
      */}
      {perm.counters.length > 0 && (
        <div className="perm__marks">
          {perm.counters.map((c) => (
            <span
              key={c.kind}
              className={`perm__mark perm__mark--${COUNTER_TONE[c.kind] ?? 'other'}`}
              title={`${c.count} ${c.kind} counter${c.count === 1 ? '' : 's'} — permanent`}
            >
              {formatCounterChip(c.kind, c.count)}
            </span>
          ))}
        </div>
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
    </>
  );

  const body = (
    <>
      <div className="perm__art">
        {/*
          UX-17 on the battlefield. `explanation` is core's own breakdown
          (`explainCharacteristics`), built once per render pass in the
          view-model and carried on the permanent; absent means "this surface
          has no continuous index" (the online board), which `CardFace` reports
          rather than drawing an empty breakdown that would read as "nothing is
          modifying this".
          draggable/eager are inherited from CardFace, which keeps §3.54's
          no-native-drag rule and §3.119's eager-load rule in ONE place.
        */}
        <CardFace
          size="tile"
          explanation={perm.explanation}
          cardId={perm.cardId}
          name={perm.name}
          isCreature={perm.isCreature}
        >
          {chrome}
        </CardFace>
        {/* No pool entry and no art at all: the face already degrades to a named
            plate, so there is nothing to add here. */}
        {art === undefined && <span className="perm__fallback">{perm.name}</span>}
      </div>
      <div className="perm__foot">
        <span className="perm__name" title={perm.name}>
          {perm.name}
        </span>
        {/*
          EXACTLY ONE P/T ON SCREEN, and which element states it depends on which
          one can state it HONESTLY. With core's explanation the face prints the
          effective numbers with their provenance and the footer says nothing —
          two numbers for one question is rule 12's failure even when they agree.
          Without one (the online board renders a server-masked view and has no
          continuous index) the face cannot draw a P/T box at all, so the footer
          is the fallback rather than the creature silently losing its stats.
        */}
        {perm.isCreature && perm.explanation === undefined && (
          <span className={`perm__pt${wounded ? ' perm__pt--wounded' : ''}`}>
            {perm.power}/{perm.toughness}
          </span>
        )}
        {wounded && (
          <span className="perm__pt perm__pt--wounded">
            <span className="perm__dmg">−{perm.damageMarked} damage</span>
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

  /**
   * THE MEASURABLE ANCHOR. `data-perm-id` is what the combat arcs, the damage
   * blooms and the death ghosts find a permanent by, and every one of them must
   * aim at the card the player can SEE — so while a card is out on the combat
   * stage the anchor travels with the copy and the home tile keeps only
   * `data-perm-home`, which is what the stage itself measures. An ordinary tile
   * carries both, so nothing has to know whether combat is happening.
   */
  const anchors: Record<string, number> = {};
  if (staged !== 'home') anchors['data-perm-id'] = perm.instanceId;
  if (!isCopy) anchors['data-perm-home'] = perm.instanceId;

  const interactive = Boolean(onClick && selectable) && !isCopy;
  const tile = (
    /*
      §3.143 GAP-7/GAP-8: the hover preview carries the SAME explanation the tile
      does. Without it the tile printed 5/6 and the full card you raised to read
      it printed 4/5 — and the merged keyword line ("vigilance, first strike,
      flying") lives on the full-size face, because a ~96px tile can only carry
      the condensed aftermarket words. This one prop is what makes the line Caleb
      asked for reachable from the battlefield at all.
    */
    <CardHover
      cardId={perm.cardId}
      explanation={perm.explanation}
      name={perm.name}
      isCreature={perm.isCreature}
    >
      {interactive ? (
        <button type="button" className={className} {...anchors} onClick={onClick} title={title} aria-pressed={selected}>
          {body}
        </button>
      ) : (
        <div className={className} {...anchors} title={title}>
          {body}
        </div>
      )}
    </CardHover>
  );

  // Prisoners are tucked under the jailer's REAL position; a stage copy shows
  // the card alone rather than dragging its jail across the board with it.
  const withJail =
    !jailed || jailed.length === 0 || isCopy ? (
      tile
    ) : (
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

  // The stage places its own copy absolutely, so a copy needs no layout slot —
  // and must not carry the tapped footprint, which is a flex-basis.
  if (isCopy) return <div className="perm-turn" style={turnStyle(perm)}>{withJail}</div>;

  const slotClass =
    'perm-slot' +
    (perm.tapped ? ' perm-slot--tapped' : '') +
    (staged === 'home' ? ' perm-slot--staged' : '');

  return (
    <div className={slotClass} style={footprintStyle(perm)}>
      <div className="perm-turn" style={turnStyle(perm)}>
        {withJail}
      </div>
    </div>
  );
}

/** The tap rotation, as a custom property so board-scene.css holds no angle. */
function turnStyle(perm: BoardPermanent): CSSProperties {
  return {
    '--perm-turn-deg': `${perm.tapped ? TAP_ROTATION_CONFIG.tappedDeg : 0}deg`,
  } as CSSProperties;
}

/**
 * How much LAYOUT width a turned card reserves. `transform` does not reflow, so
 * without this a 90° card would lie across its neighbours — which is the exact
 * reason styles.css settled for 24° and said so in its comment.
 */
function footprintStyle(perm: BoardPermanent): CSSProperties {
  return {
    '--perm-footprint': perm.tapped ? String(TAP_ROTATION_CONFIG.footprintRatio) : '1',
  } as CSSProperties;
}

/**
 * One tucked prisoner, peeking out from behind its jailer's top edge. A button
 * (click or right-click zooms it) because a card you can barely see is exactly
 * the card you need to inspect.
 *
 * Wrapped in `CardHover` like every other card on this surface (UX-10: "hovering
 * over any card ever should let you see a full clear view of the card") — it was
 * the one card-bearing element on the battlefield with no preview.
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
    <CardHover cardId={prisoner.cardId}>
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
    </CardHover>
  );
}
