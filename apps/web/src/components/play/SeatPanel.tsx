import type { ReactElement } from 'react';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import type { BoardPermanent, SeatView } from '../../lib/play/view-model.js';
import type { JailedCardView } from '../../lib/play/jail-view.js';
import { BoardPermanentTile } from './BoardPermanentTile.js';

/** Order mana colors consistently (WUBRG + C) for the pool readout. */
const MANA_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

/** How a board permanent may be interacted with this frame. */
export interface PermInteraction {
  /** Permanents that can be clicked (e.g. eligible attackers / targets / tap). */
  readonly selectableIds: ReadonlySet<InstanceId>;
  /** Currently selected permanents. */
  readonly selectedIds: ReadonlySet<InstanceId>;
  /** Per-permanent overlay marker (e.g. "ATK"). */
  readonly markers?: ReadonlyMap<InstanceId, string>;
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
          {isActive && <span className="seat__tag">active turn</span>}
          {hasPriority && <span className="seat__tag seat__tag--priority">priority</span>}
        </div>
      </header>

      {/* The zone counters double as ANIMATION ANCHORS (§3.57): the flying
          card-back/face sprites measure these `data-anim-anchor` elements for
          their start/end points. Data attributes only — no behavior. */}
      <div className="seat__zones">
        <span title="Cards in hand" data-anim-anchor={`hand-count:${seat.id}`}>
          ✋ {seat.handCount}
        </span>
        <span title="Library" data-anim-anchor={`library:${seat.id}`}>
          📚 {seat.libraryCount}
        </span>
        {onGraveyardClick ? (
          <button
            type="button"
            className="seat__zone-btn"
            title="Open graveyard"
            aria-label={`Open ${seat.name} graveyard (${seat.graveyardCount} cards)`}
            data-anim-anchor={`graveyard:${seat.id}`}
            onClick={onGraveyardClick}
          >
            ⚰ {seat.graveyardCount}
          </button>
        ) : (
          <span title="Graveyard" data-anim-anchor={`graveyard:${seat.id}`}>
            ⚰ {seat.graveyardCount}
          </span>
        )}
        {seat.exileCount > 0 && <span title="Exile">✦ {seat.exileCount}</span>}
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

      <div className="seat__board">
        <div
          className="seat__row"
          aria-label={`${seat.name} creatures and other permanents`}
          data-anim-anchor={`board:${seat.id}`}
        >
          {nonlands.length === 0 ? <span className="seat__empty">No creatures</span> : nonlands.map(renderPerm)}
        </div>
        <div className="seat__row seat__row--lands" aria-label={`${seat.name} lands`}>
          {lands.length === 0 ? <span className="seat__empty">No lands</span> : lands.map(renderPerm)}
        </div>
      </div>
    </section>
  );
}

/** Pull the defending player's id from active player (the other seat). */
export function otherSeat(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}
