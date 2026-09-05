import type { ReactElement } from 'react';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import { POISON_LOSS_THRESHOLD } from '@jonny-boi/core';
import type { BoardPermanent, SeatView } from '../../lib/play/view-model.js';
import type { JailedCardView } from '../../lib/play/jail-view.js';
import { BoardPermanentTile } from './BoardPermanentTile.js';

/** Order mana colors consistently (WUBRG + C) for the pool readout. */
const MANA_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

/**
 * Poison counters within this many of CR 704.5c's threshold read as danger —
 * the poison clock's version of the life readout's low-life colour (§3.105).
 */
const POISON_DANGER_MARGIN = 2;
const POISON_DANGER_AT = POISON_LOSS_THRESHOLD - POISON_DANGER_MARGIN;

/**
 * THE BATTLEFIELD ROWS, NAMED ONCE (§3.124, report 20260901_205636 — "Battlefield
 * zone naming/organization"). The rows had aria-labels a screen reader spoke and
 * NO visible caption, so sighted players saw two unlabelled strips of tiles while
 * assistive tech heard "creatures and other permanents" — the same zone described
 * two different ways. One table now feeds BOTH the caption on screen and the
 * accessible name, so they cannot drift apart again. Adding a row is a ROW.
 */
const BATTLEFIELD_ROWS = Object.freeze({
  permanents: Object.freeze({
    label: 'Creatures',
    aria: 'creatures and other permanents',
    emptyText: 'Battlefield — no creatures',
  }),
  lands: Object.freeze({ label: 'Lands', aria: 'lands', emptyText: 'No lands' }),
});

/** How a board permanent may be interacted with this frame. */
export interface PermInteraction {
  /** Permanents that can be clicked (e.g. eligible attackers / targets / tap). */
  readonly selectableIds: ReadonlySet<InstanceId>;
  /** Currently selected permanents. */
  readonly selectedIds: ReadonlySet<InstanceId>;
  /** Per-permanent overlay marker (e.g. "ATK"). */
  readonly markers?: ReadonlyMap<InstanceId, string>;
  /**
   * Permanents that are LEGAL TARGETS of the spell/ability being aimed right
   * now (§3.119, report 20260901_211035). Drawn pulsing, so "where can this
   * Cloudshift go?" is answered by looking rather than by guessing. A subset of
   * `selectableIds` in practice — the aim is also the click.
   */
  readonly targetableIds?: ReadonlySet<InstanceId>;
  readonly onClick: (id: InstanceId) => void;
}

/**
 * One player's area: life, the zone counts + mana pool, and their battlefield split
 * into lands and other permanents. `isViewer` styles the active human's own side.
 * Permanent interactions (attack/block/target/tap selection) are injected so the
 * same panel serves both seats in every phase.
 */
export function SeatPanel({
  seat,
  isActive,
  hasPriority,
  interaction,
  onGraveyardClick,
  jails,
  onInspectCard,
}: {
  seat: SeatView;
  isActive: boolean;
  hasPriority: boolean;
  interaction?: PermInteraction;
  /**
   * When present, the graveyard count becomes a button that opens the graveyard
   * panel (the flashback affordance's entry point). Absent → plain count, as
   * before, so seats without a panel are unchanged.
   */
  onGraveyardClick?: () => void;
  /**
   * jailer instance id → the cards it exiled "until it leaves the battlefield"
   * (§3.57). Built by the board from the PUBLIC exile zones via the pure
   * `jail-view` grouping; a jailer with an entry renders its prisoners tucked
   * underneath its tile.
   */
  jails?: ReadonlyMap<InstanceId, readonly JailedCardView[]>;
  /** Zoom any card this panel peeks (today: a jailed prisoner). */
  onInspectCard?: (card: { cardId: string; name: string }) => void;
}): ReactElement {
  const lands = seat.permanents.filter((p) => p.isLand);
  const nonlands = seat.permanents.filter((p) => !p.isLand);
  const manaEntries = MANA_ORDER.map((c) => [c, seat.manaPool[c] ?? 0] as const).filter(([, n]) => n > 0);

  const renderPerm = (p: BoardPermanent): ReactElement => {
    const selectable = interaction?.selectableIds.has(p.instanceId) ?? false;
    return (
      <BoardPermanentTile
        key={p.instanceId}
        perm={p}
        selectable={selectable}
        selected={interaction?.selectedIds.has(p.instanceId) ?? false}
        marker={interaction?.markers?.get(p.instanceId)}
        targetable={interaction?.targetableIds?.has(p.instanceId) ?? false}
        onClick={selectable && interaction ? () => interaction.onClick(p.instanceId) : undefined}
        jailed={jails?.get(p.instanceId)}
        onInspectJailed={onInspectCard}
      />
    );
  };

  return (
    <section className={`seat${isActive ? ' seat--active' : ''}${seat.hasLost ? ' seat--lost' : ''}`}>
      <header className="seat__head">
        <div className="seat__id">
          <span className="seat__name">{seat.name}</span>
          {/*
           * Life sits BESIDE the name, not across the panel from it. It used to
           * be pushed to the far edge by a space-between header — an unlabeled
           * "20" a full panel-width from every other number — and a bug report
           * called it exactly that: "way off to the side, far from anything
           * else - hard to notice". The heart is what makes a bare number read
           * as a life total at a glance.
           */}
          <span
            className={`seat__life${seat.life <= 5 ? ' seat__life--low' : ''}`}
            title="Life total"
            aria-label={`${seat.name} life`}
          >
            <span aria-hidden="true">❤</span> {seat.life}
          </span>
          {/*
           * The POISON clock (CR 704.5c, §3.105), shown only once it has
           * started: a "0" beside every life total would be noise on the
           * boards where poison never happens, which is most of them.
           */}
          {seat.poison > 0 && (
            <span
              className={`seat__poison${seat.poison >= POISON_DANGER_AT ? ' seat__poison--danger' : ''}`}
              title={`Poison counters (${POISON_LOSS_THRESHOLD} loses)`}
              aria-label={`${seat.name} poison`}
            >
              <span aria-hidden="true">☠</span> {seat.poison}
            </span>
          )}
          {isActive && <span className="seat__tag">active turn</span>}
          {hasPriority && <span className="seat__tag seat__tag--priority">priority</span>}
        </div>
      </header>

      {/* The zone counters double as ANIMATION ANCHORS (§3.57): the flying
          card-back/face sprites measure these `data-anim-anchor` elements for
          their start/end points. Data attributes only — no behavior. */}
      {/*
        THE ZONE RAIL, IN WORDS (§3.119, report 20260901_210413 — "In fact I
        dont even see a library"). It was a row of bare glyphs — `📚 36` beside
        `✋ 4` beside `⚰ 1` — which reads as decoration next to a life total,
        and the library is the zone a Goblin Guide reveal is ABOUT. Every zone
        is now a labelled chip that names itself. The `data-anim-anchor`
        attributes are unchanged: they are what §3.57's sprites measure.
      */}
      <div className="seat__zones">
        <span className="seat__zone" title="Cards in hand" data-anim-anchor={`hand-count:${seat.id}`}>
          <span className="seat__zone-label">Hand</span>
          <span className="seat__zone-count">{seat.handCount}</span>
        </span>
        <span className="seat__zone" title="Cards left in library" data-anim-anchor={`library:${seat.id}`}>
          <span className="seat__zone-label">Library</span>
          <span className="seat__zone-count">{seat.libraryCount}</span>
        </span>
        {onGraveyardClick ? (
          <button
            type="button"
            className="seat__zone seat__zone-btn"
            title="Open graveyard"
            aria-label={`Open ${seat.name} graveyard (${seat.graveyardCount} cards)`}
            data-anim-anchor={`graveyard:${seat.id}`}
            onClick={onGraveyardClick}
          >
            <span className="seat__zone-label">Graveyard</span>
            <span className="seat__zone-count">{seat.graveyardCount}</span>
          </button>
        ) : (
          <span className="seat__zone" title="Graveyard" data-anim-anchor={`graveyard:${seat.id}`}>
            <span className="seat__zone-label">Graveyard</span>
            <span className="seat__zone-count">{seat.graveyardCount}</span>
          </span>
        )}
        {seat.exileCount > 0 && (
          <span className="seat__zone" title="Exile">
            <span className="seat__zone-label">Exile</span>
            <span className="seat__zone-count">{seat.exileCount}</span>
          </span>
        )}
        {manaEntries.length > 0 && (
          <span
            className="seat__mana"
            title={
              // Restricted mana is PUBLIC — it was printed on a permanent the
              // table can read. Naming it here is what stops "3 floating, spell
              // still greyed out" from reading as a bug.
              seat.restrictedMana.length > 0
                ? `Floating mana — restricted: ${seat.restrictedMana.join('; ')}`
                : 'Floating mana'
            }
          >
            {manaEntries.map(([c, n]) => (
              <span key={c} className={`pip pip--${c}`} aria-hidden="true">
                {n > 1 ? `${n}${c}` : c}
              </span>
            ))}
            {seat.restrictedMana.length > 0 && (
              <span className="seat__mana-restricted" aria-label="some floating mana is restricted">
                ⚠
              </span>
            )}
          </span>
        )}
      </div>

      <div className="seat__board" role="group" aria-label={`${seat.name} battlefield`}>
        {/* The battlefield is a zone like the others (CR 400.1) and was the ONE
            zone never named on screen. Its name runs vertically beside the rows
            rather than sitting in the rail as a chip: a chip wrapped the rail onto
            a second line and cost the height §3.62 fought for, whereas a rotated
            word beside rows that are a tile tall costs none.

            ⚠️ ONLY while something is on the battlefield. A rotated word is ~60px
            tall, and beside two EMPTY rows ("No creatures" / "No lands", ~20px
            each) it is the tallest thing there — it grew every turn-one board by
            a caption's height and broke §3.62's fit. An empty battlefield names
            itself in its empty text instead. Same rule per row, below. */}
        {seat.permanents.length > 0 && (
          <span className="seat__board-label" aria-hidden="true">
            Battlefield
          </span>
        )}
        <div className="seat__board-rows">
        <div
          className="seat__row"
          aria-label={`${seat.name} ${BATTLEFIELD_ROWS.permanents.aria}`}
          data-anim-anchor={`board:${seat.id}`}
        >
          {nonlands.length === 0 ? (
            <span className="seat__empty">{BATTLEFIELD_ROWS.permanents.emptyText}</span>
          ) : (
            <>
              <span className="seat__row-label" aria-hidden="true">
                {BATTLEFIELD_ROWS.permanents.label}
              </span>
              {nonlands.map(renderPerm)}
            </>
          )}
        </div>
        <div className="seat__row seat__row--lands" aria-label={`${seat.name} ${BATTLEFIELD_ROWS.lands.aria}`}>
          {lands.length === 0 ? (
            <span className="seat__empty">{BATTLEFIELD_ROWS.lands.emptyText}</span>
          ) : (
            <>
              <span className="seat__row-label" aria-hidden="true">
                {BATTLEFIELD_ROWS.lands.label}
              </span>
              {lands.map(renderPerm)}
            </>
          )}
        </div>
        </div>
      </div>
    </section>
  );
}

/** Pull the defending player's id from active player (the other seat). */
export function otherSeat(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}
