import type { ReactElement } from 'react';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import type { BoardPermanent, SeatView } from '../../lib/play/view-model.js';
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
}: {
  seat: SeatView;
  isActive: boolean;
  hasPriority: boolean;
  interaction?: PermInteraction;
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
      />
    );
  };

  return (
    <section className={`seat${isActive ? ' seat--active' : ''}${seat.hasLost ? ' seat--lost' : ''}`}>
      <header className="seat__head">
        <div className="seat__id">
          <span className="seat__name">{seat.name}</span>
          {isActive && <span className="seat__tag">active turn</span>}
          {hasPriority && <span className="seat__tag seat__tag--priority">priority</span>}
        </div>
        <div className={`seat__life${seat.life <= 5 ? ' seat__life--low' : ''}`} aria-label={`${seat.name} life`}>
          {seat.life}
        </div>
      </header>

      <div className="seat__zones">
        <span title="Cards in hand">✋ {seat.handCount}</span>
        <span title="Library">📚 {seat.libraryCount}</span>
        <span title="Graveyard">⚰ {seat.graveyardCount}</span>
        {seat.exileCount > 0 && <span title="Exile">✦ {seat.exileCount}</span>}
        {manaEntries.length > 0 && (
          <span className="seat__mana" title="Floating mana">
            {manaEntries.map(([c, n]) => (
              <span key={c} className={`pip pip--${c}`} aria-hidden="true">
                {n > 1 ? `${n}${c}` : c}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="seat__board">
        <div className="seat__row" aria-label={`${seat.name} creatures and other permanents`}>
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
