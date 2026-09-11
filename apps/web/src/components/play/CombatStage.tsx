/**
 * THE COMBAT STAGE (UX-12 / UX-13) — the unclipped layer the advanced cards are
 * painted in.
 *
 * All of the geometry lives in the pure `lib/play/combat-stage.ts`; this file
 * only measures, compares and renders. The split is deliberate: the midline
 * clamp is the part that can be wrong, and it is the part a Node test can see.
 *
 * ⚠️ `data-perm-id` MOVES WITH THE CARD. Lane G's arcs, lane H's damage blooms
 * and the death ghosts all find a permanent by `[data-perm-id]` and take the
 * FIRST match, and every one of them must aim at the card the player can SEE.
 * So a staged card's copy carries `data-perm-id` and its home tile carries only
 * `data-perm-home` — see `BoardPermanentTile`, where the swap is made, and the
 * `stagedIds` prop that tells it which cards are out.
 */
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from 'react';
import type { InstanceId } from '@jonny-boi/core';
import { COMBAT_ADVANCE_CONFIG } from '../../lib/play/play-config.js';
import {
  placementSignature,
  stagePlacements,
  type StagePlacement,
  type StageRect,
  type StageSubject,
} from '../../lib/play/combat-stage.js';
import type { BoardPermanent } from '../../lib/play/view-model.js';
import { BoardPermanentTile } from './BoardPermanentTile.js';

/** One card the board wants advanced, before anything has been measured. */
export interface StageEntry {
  readonly perm: BoardPermanent;
  readonly role: StageSubject['role'];
  readonly toward: StageSubject['toward'];
  /** For a blocker: the attacker it is blocking. */
  readonly meets?: InstanceId;
}

/** Read a home tile's box. `data-perm-home` is on the tile that stayed put. */
function homeRectOf(root: HTMLElement | null, id: InstanceId): StageRect | undefined {
  const el = root?.querySelector(`[data-perm-home="${id}"]`);
  if (!(el instanceof HTMLElement)) return undefined;
  const r = el.getBoundingClientRect();
  // A tile inside a collapsed/scrolled-away band measures as nothing; staging it
  // would drop a full-size copy at an arbitrary place on screen.
  if (r.width <= 0 || r.height <= 0) return undefined;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * Measure the home tiles and the midline, place every card, and only re-render
 * when the PICTURE changed.
 *
 * The midline is measured off the region between the two seats rather than
 * recomputed from seat heights — one answer to one question (rule 12), and the
 * only one that stays true when a seat is squeezed by board-fit.css's budget.
 */
function useStagePlacements(
  entries: readonly StageEntry[],
  boardRootRef: RefObject<HTMLElement | null>,
  midlineRef: RefObject<HTMLElement | null>,
  measureKey: unknown,
): readonly StagePlacement[] {
  const [placed, setPlaced] = useState<readonly StagePlacement[]>([]);

  // The identity of the REQUEST, so the effect re-runs when the board asks for a
  // different set of cards rather than on every render.
  const requestKey = entries.map((e) => `${e.perm.instanceId}:${e.role}:${e.meets ?? ''}`).join('|');

  const measure = useCallback((): void => {
    const root = boardRootRef.current;
    const mid = midlineRef.current;
    if (!root || entries.length === 0) {
      setPlaced((cur) => (cur.length === 0 ? cur : []));
      return;
    }
    const midRect = mid?.getBoundingClientRect();
    if (!midRect || midRect.height <= 0) {
      // No measurable midline means no clamp, and an unclamped advance is the
      // one thing UX-12 forbids. Refuse rather than approximate.
      setPlaced((cur) => (cur.length === 0 ? cur : []));
      return;
    }
    const subjects: StageSubject[] = [];
    for (const entry of entries) {
      const home = homeRectOf(root, entry.perm.instanceId);
      if (!home) continue;
      subjects.push({
        instanceId: entry.perm.instanceId,
        role: entry.role,
        home,
        toward: entry.toward,
        ...(entry.meets !== undefined ? { meets: entry.meets } : {}),
      });
    }
    const next = stagePlacements(
      { subjects, midlineY: midRect.top + midRect.height / 2 },
      COMBAT_ADVANCE_CONFIG,
    );
    setPlaced((cur) => (placementSignature(cur) === placementSignature(next) ? cur : next));
    // `entries` is rebuilt every render by the board; `requestKey` is its stable
    // identity, which is what this callback is really keyed on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRootRef, midlineRef, requestKey]);

  useEffect(() => {
    measure();
  }, [measure, measureKey]);

  useEffect(() => {
    // A viewport-fixed layer does NOT scroll with the board's own scrollers, and
    // those scrollers do not bubble `scroll` — hence the capturing listener, the
    // same one lane G's arcs needed for the same reason.
    const onMove = (): void => measure();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [measure]);

  return placed;
}

/** Which cards are currently OUT — the board hands this to the tiles. */
export function stagedIdsOf(placements: readonly StagePlacement[]): ReadonlySet<InstanceId> {
  return new Set(placements.map((p) => p.instanceId));
}

export function CombatStage({
  entries,
  boardRootRef,
  midlineRef,
  measureKey,
  onPlaced,
}: {
  readonly entries: readonly StageEntry[];
  /** The board container the home tiles are queried inside. */
  readonly boardRootRef: RefObject<HTMLElement | null>;
  /** The element BETWEEN the two seats — its vertical centre is the midline. */
  readonly midlineRef: RefObject<HTMLElement | null>;
  /** Anything that changes when tiles may have moved (the session works). */
  readonly measureKey: unknown;
  /** Reports which ids are staged, so the home tiles can hand over their anchor. */
  readonly onPlaced: (ids: ReadonlySet<InstanceId>) => void;
}): ReactElement | null {
  const placed = useStagePlacements(entries, boardRootRef, midlineRef, measureKey);
  const byId = new Map(entries.map((e) => [e.perm.instanceId, e.perm]));

  useEffect(() => {
    onPlaced(stagedIdsOf(placed));
  }, [placed, onPlaced]);

  if (placed.length === 0) return null;

  return (
    <div className="combat-stage" aria-hidden="true">
      {placed.map((p) => {
        const perm = byId.get(p.instanceId);
        if (!perm) return null;
        const style = {
          left: `${p.centre.x}px`,
          top: `${p.centre.y}px`,
          width: `${p.home.width}px`,
          '--combat-stagger-delay': `${p.staggerIndex * COMBAT_ADVANCE_CONFIG.staggerMs}ms`,
        } as CSSProperties;
        return (
          <div key={p.instanceId} className={`combat-stage__tile combat-stage__tile--${p.role}`} style={style}>
            {/*
              The SAME tile component, so an advanced attacker keeps its tap
              turn, its counters and its combat band. `staged` is what moves
              `data-perm-id` onto this copy; the home tile keeps only
              `data-perm-home`, so nothing measures the card twice.
            */}
            <BoardPermanentTile perm={perm} staged="copy" />
          </div>
        );
      })}
    </div>
  );
}
