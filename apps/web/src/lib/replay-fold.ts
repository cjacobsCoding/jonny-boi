/**
 * Pure event-folding for the replay viewer (DESIGN §2: the event log is the replay
 * source of truth). Given the ordered `GameEvent[]` and a step index, this folds
 * the log up to that step into derived state — life totals and the set of
 * permanents in play with their tapped state — plus key-moment flags the timeline
 * highlights (a creature died, a player hit lethal range, the game ended).
 *
 * This is intentionally INDEPENDENT of the worker's board snapshots: the snapshots
 * are authoritative for effective P/T (the engine computes layers), but folding the
 * log here is what the brief asks us to test ("state at step N is correct — life,
 * board") and it cross-checks the snapshots. The viewer renders the snapshot board
 * for fidelity and uses this fold for the timeline/highlights, so both agree.
 *
 * DOM-free and side-effect-free → unit-tested in Node.
 */
import type { GameEvent, InstanceId, PlayerId, ZoneName } from '@jonny-boi/core';

/** The starting life both players fold up from (engine default; overridable). */
export const DEFAULT_STARTING_LIFE = 20;

/** A permanent reconstructed purely from the event log. */
export interface FoldedPermanent {
  readonly instanceId: InstanceId;
  readonly controller: PlayerId;
  readonly tapped: boolean;
}

/** Derived per-player state at a fold step. */
export interface FoldedSide {
  readonly life: number;
  readonly board: readonly FoldedPermanent[];
}

/** The whole folded state at a given step (one entry per player). */
export interface FoldedState {
  readonly sides: Readonly<Record<PlayerId, FoldedSide>>;
  /** True once a `gameOver` event has been folded. */
  readonly gameOver: boolean;
  readonly winner: PlayerId | null;
}

/** Mutable scratch a permanent is tracked with while folding. */
interface MutablePermanent {
  instanceId: InstanceId;
  controller: PlayerId;
  tapped: boolean;
}

/** A lethal-range threshold: at or below this, a player is in danger. */
export const LETHAL_RANGE_LIFE = 5;

/** A key moment surfaced on the timeline at the event index where it happened. */
export interface KeyMoment {
  readonly eventIndex: number;
  readonly kind: 'death' | 'lethalRange' | 'gameOver';
  readonly label: string;
}

/** Does this zone change put a permanent onto / off of the battlefield? */
function isBattlefield(zone: ZoneName): boolean {
  return zone === 'battlefield';
}

/**
 * Fold the event log up to and including `upToIndex` (inclusive; pass -1 for the
 * opening state with no events applied) into derived life + board state.
 *
 * `controllerOf` resolves an instance's controller when a zoneChange (which carries
 * no player) moves it onto the battlefield; pass the worker-provided map. Unknown
 * instances default to player A so folding never throws (DESIGN §6) — the viewer's
 * authoritative board comes from snapshots, so a rare miss here is cosmetic.
 */
export function foldState(
  events: readonly GameEvent[],
  upToIndex: number,
  options: {
    readonly startingLife?: number;
    readonly controllerOf?: (instanceId: InstanceId) => PlayerId | undefined;
  } = {},
): FoldedState {
  const startingLife = options.startingLife ?? DEFAULT_STARTING_LIFE;
  const controllerOf = options.controllerOf ?? (() => undefined);

  const life: Record<PlayerId, number> = { A: startingLife, B: startingLife };
  const permanents = new Map<InstanceId, MutablePermanent>();
  let gameOver = false;
  let winner: PlayerId | null = null;

  const last = Math.min(upToIndex, events.length - 1);
  for (let i = 0; i <= last; i++) {
    const event = events[i]!;
    switch (event.type) {
      case 'lifeChanged':
        life[event.player] = event.to;
        break;
      case 'landPlayed':
        permanents.set(event.instanceId, {
          instanceId: event.instanceId,
          controller: event.player,
          tapped: false,
        });
        break;
      case 'tokenCreated':
        permanents.set(event.instanceId, {
          instanceId: event.instanceId,
          controller: event.controller,
          tapped: false,
        });
        break;
      case 'zoneChange':
        if (isBattlefield(event.to) && !isBattlefield(event.from)) {
          if (!permanents.has(event.instanceId)) {
            permanents.set(event.instanceId, {
              instanceId: event.instanceId,
              controller: controllerOf(event.instanceId) ?? 'A',
              tapped: false,
            });
          }
        } else if (isBattlefield(event.from) && !isBattlefield(event.to)) {
          permanents.delete(event.instanceId);
        }
        break;
      case 'creatureDied':
        permanents.delete(event.instanceId);
        break;
      case 'tapped': {
        const p = permanents.get(event.instanceId);
        if (p) p.tapped = true;
        break;
      }
      case 'untapped': {
        const p = permanents.get(event.instanceId);
        if (p) p.tapped = false;
        break;
      }
      case 'gameOver':
        gameOver = true;
        winner = event.winner;
        break;
      default:
        break;
    }
  }

  const board: Record<PlayerId, FoldedPermanent[]> = { A: [], B: [] };
  for (const p of permanents.values()) {
    board[p.controller].push({
      instanceId: p.instanceId,
      controller: p.controller,
      tapped: p.tapped,
    });
  }

  return {
    sides: {
      A: { life: life.A, board: board.A },
      B: { life: life.B, board: board.B },
    },
    gameOver,
    winner,
  };
}

/**
 * Scan the whole log once and collect the key moments the timeline highlights:
 * a creature dying, a player first crossing into lethal range, and the game end.
 * Each is tagged with the event index so the scrubber can mark it.
 */
export function findKeyMoments(events: readonly GameEvent[]): readonly KeyMoment[] {
  const moments: KeyMoment[] = [];
  const inLethalRange: Record<PlayerId, boolean> = { A: false, B: false };

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === 'creatureDied') {
      moments.push({ eventIndex: i, kind: 'death', label: `${event.name} dies` });
    } else if (event.type === 'lifeChanged') {
      const danger = event.to <= LETHAL_RANGE_LIFE;
      if (danger && !inLethalRange[event.player]) {
        inLethalRange[event.player] = true;
        moments.push({
          eventIndex: i,
          kind: 'lethalRange',
          label: `Player ${event.player} at ${event.to} life`,
        });
      } else if (!danger) {
        inLethalRange[event.player] = false;
      }
    } else if (event.type === 'gameOver') {
      moments.push({
        eventIndex: i,
        kind: 'gameOver',
        label: event.winner ? `Player ${event.winner} wins` : 'Draw',
      });
    }
  }
  return moments;
}
