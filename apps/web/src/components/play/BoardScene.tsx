/**
 * THE BATTLEFIELD, DURING COMBAT — ONE SCENE, MOUNTED BY BOTH BOARDS.
 *
 * ## The fork this file removes (CLAUDE.md rule 12, `~/.claude/rules/50-engineering.md` rule 3)
 *
 * `PlayBoard` (hotseat) and `OnlineBoard` (multiplayer) each answered "how do I
 * draw a battlefield during combat?", and answered it differently. The LEAF
 * components were never the problem — the online board already imported eleven
 * of them from this directory (`SeatPanel`, `StackPanel`, `PlayCard`,
 * `ChoicePrompt`, `AbilityPrompts`, `CardFace`, `CardZoomOverlay`,
 * `CombatHoldBanner`, `CombatLines`, `ZonePanel`, `usePrefersReducedMotion`).
 * What was never extracted is the SCENE COMPOSITION, which lived inline in
 * `PlayBoard`'s JSX:
 *
 *   - the `.board-scene` / `.board-scene__table` wrapper carrying UX-9's tilt;
 *   - the `--board-*` custom properties fed from `BOARD_3D_CONFIG` /
 *     `BOARD_LAYOUT_CONFIG` / `TAP_ROTATION_CONFIG` / `COMBAT_ADVANCE_CONFIG`;
 *   - the `.board-midline` element UX-12's advance clamp MEASURES against;
 *   - `CombatStage` and the `StageEntry[]` it advances (UX-12 / UX-13);
 *   - the combat arcs (UX-14) and the damage layer (UX-15).
 *
 * So the online board was missing UX-9, UX-12, UX-13 and UX-14 not by design but
 * because there was no unit to mount. Porting features one at a time across two
 * boards forever IS the bug; this file is the one answer both boards read.
 *
 * ## What is a PROP, and what was UNIFIED
 *
 * A prop is something that GENUINELY differs: the view model's source (a local
 * engine vs. a server-masked frame), the interaction handlers (a local action
 * vs. a submitted `GameAction`), which seat is looking, what goes in the rail,
 * and the measure key. Everything else that used to differ, differed only
 * because nobody unified it, and is now decided here once:
 *
 *   - **the seat ORDER** — the opponent's fanned backs are drawn ABOVE their
 *     battlefield, at the far edge of the table, because that is where a player
 *     opposite you holds their hand. The online board drew them BELOW, between
 *     their creatures and the midline: the one place nothing belongs.
 *   - **the combat arcs** — one call to `combatArcPairs`, the funnel that draws
 *     attacker→player and attacker→planeswalker arcs as well as block arcs. The
 *     online board called `blockerLinePairs`, which is an adapter over the same
 *     funnel that simply never passed the attack half.
 *   - **the staged advance** — `stageEntries` is derived HERE from the shared
 *     `BoardView.combat`, so both boards walk their attackers and blockers out
 *     to the midline from the same rule.
 *   - **the inspect gesture** — right-click anywhere on a tile, plain click on a
 *     tile that is not a control. One implementation, one `permById` index.
 *   - **the drop zone** — the viewer's seat is the drag-to-play target on both
 *     boards, and the class list that lights it up is written once.
 *
 * ## WHAT THE SCENE MAY NOT NEED
 *
 * `maskStateForSeat` is the hidden-information chokepoint and stays one. Every
 * input below is either public by the rules (the battlefield, the combat state,
 * both graveyards) or the viewer's own. Nothing here would make a server reveal
 * a card it withholds — including {@link DamageSource}, whose events reach an
 * online seat through `maskEventsForSeat`, the chokepoint's sibling, which sends
 * only a CLOSED table of public kinds and only ones that name cards that seat
 * can already see.
 *
 * ## THE FIXED OVERLAYS ARE SIBLINGS OF THE SCENE, NEVER DESCENDANTS
 *
 * `.board-scene__table` is `transform`ed, and a transformed box is the
 * containing block for every `position: fixed` descendant — which silently
 * re-roots the overlay and moves every coordinate it measured. So `CombatLines`,
 * `CombatStage` and `DamageLayer` are rendered AFTER the scene closes, and the
 * boards' own overlays (prompts, toasts, the stack panel, the viewer's hand)
 * must stay outside too. `board-scene.test.ts` is the guard.
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { opponentOf, type GameEvent, type InstanceId, type PlayerId } from '@jonny-boi/core';
import {
  ANNOUNCEMENT_CONFIG,
  BOARD_3D_CONFIG,
  BOARD_LAYOUT_CONFIG,
  COMBAT_ADVANCE_CONFIG,
  TAP_ROTATION_CONFIG,
} from '../../lib/play/play-config.js';
import { STAGED_HOME_TILE_OPACITY } from '../../lib/play/combat-stage.js';
import { combatArcPairs } from '../../lib/play/combat-lines.js';
import type { BoardPermanent, BoardView } from '../../lib/play/view-model.js';
import type { JailedCardView } from '../../lib/play/jail-view.js';
import { DamageLayer, useDamageSequence, usePrefersReducedMotion } from './AnimationLayer.js';
import { CombatLines } from './CombatLines.js';
import { CombatStage, type StageEntry } from './CombatStage.js';
import { NO_STAGED_PERMANENTS, StagedPermanentsContext } from './combat-stage-context.js';
import { CardBack } from './PlayCard.js';
import { SeatPanel, type PermInteraction } from './SeatPanel.js';
import type { ZoomedCard } from './CardZoomOverlay.js';
import './board-scene.css';

/**
 * The combat selections the player is still CLICKING — not yet submitted.
 *
 * Both boards hold exactly these three, in exactly these shapes, because both
 * build the same three declarations out of them. A draft never advances a card
 * (see {@link stageEntriesFor}); it only draws a dashed arc.
 */
export interface CombatDraft {
  /** Attackers ticked in the declare-attackers step. */
  readonly attackers: Iterable<InstanceId>;
  /** Attacker → the planeswalker (or battle) it has been aimed at. */
  readonly attackTargets: ReadonlyMap<InstanceId, InstanceId | PlayerId>;
  /** Blocker → the attacker it has been assigned to. */
  readonly blocks: ReadonlyMap<InstanceId, InstanceId>;
}

/** A draft with nothing in it — shared, so a board with no selection allocates none. */
export const NO_COMBAT_DRAFT: CombatDraft = Object.freeze({
  attackers: Object.freeze([]) as readonly InstanceId[],
  attackTargets: new Map<InstanceId, InstanceId | PlayerId>(),
  blocks: new Map<InstanceId, InstanceId>(),
});

/**
 * UX-15's input: the events a damage sequence is derived from, plus where a tile
 * last stood (a creature killed by the very hit being drawn is already gone).
 */
export interface DamageSource {
  readonly events: readonly GameEvent[];
  readonly tileRectOf: (id: InstanceId) => DOMRect | undefined;
}

/**
 * The tabletop's own numbers, handed to the CSS as custom properties so
 * `board-scene.css` and `board-fit.css` contain no literal at all.
 *
 * ⚠️ RETURNED, NOT APPLIED. These have to sit on `.play-board` — the board's own
 * root — and not on `.board-scene`, because `board-fit.css` declares
 * `--play-board-right-overlay-inset` on `.play-board` out of `--play-log-rail-w`
 * and a custom property set on a DESCENDANT cannot feed an ancestor's
 * declaration. So both boards spread this on their root element, and
 * `online-board-parity.test.ts` fails if one of them stops.
 *
 * A player who asked for reduced motion gets `reducedMotionTiltDeg` — a NUMBER,
 * not a boolean, so a designer can pick a gentler tilt without a code change. A
 * static perspective is not literally motion, but `prefers-reduced-motion` is
 * the only signal browsers give for vestibular discomfort, and a tilted plane
 * with tiles sliding across it is exactly that trigger.
 */
export function useBoardSceneVars(): CSSProperties {
  const reducedMotion = usePrefersReducedMotion();
  return {
    '--board-perspective-px': `${BOARD_3D_CONFIG.perspectivePx}px`,
    '--board-tilt-deg': `${reducedMotion ? BOARD_3D_CONFIG.reducedMotionTiltDeg : BOARD_3D_CONFIG.tiltDeg}deg`,
    '--board-origin-x': `${BOARD_3D_CONFIG.perspectiveOriginXFraction * 100}%`,
    '--board-origin-y': `${BOARD_3D_CONFIG.perspectiveOriginYFraction * 100}%`,
    '--board-scene-ms': `${BOARD_3D_CONFIG.sceneTransitionMs}ms`,
    '--perm-turn-ms': `${TAP_ROTATION_CONFIG.turnMs}ms`,
    '--perm-tapped-opacity': String(TAP_ROTATION_CONFIG.tappedOpacity),
    '--perm-tapped-grayscale': String(TAP_ROTATION_CONFIG.tappedGrayscaleFraction),
    '--perm-staged-opacity': String(STAGED_HOME_TILE_OPACITY),
    '--combat-advance-ms': `${COMBAT_ADVANCE_CONFIG.advanceMs}ms`,
    // ONE fade for the ONE announcement surface. It replaced
    // `--spell-hold-fade-ms` and `--forced-choice-fade-ms`, which were two
    // published properties carrying the same number into two hand-written
    // keyframes — the parallel-vocabulary shape rule 12 exists to stop, and a
    // miniature of the four-announcer problem this whole change is about.
    // `ANNOUNCEMENT_CONFIG.fadeMs` still DERIVES from `SPELL_HOLD_CONFIG.fadeMs`,
    // so the hold's pacing is what tunes it.
    '--announce-fade-ms': `${ANNOUNCEMENT_CONFIG.fadeMs}ms`,
    // Where the ONE surface's top slot sits — measured against the board's own
    // status row, which a tall announcement was standing on top of.
    '--announce-top-clearance': `${ANNOUNCEMENT_CONFIG.topSlotClearanceRem}rem`,
    // §3.143 wave 3 — the ARRANGEMENT's own numbers (BOARD_LAYOUT_CONFIG). The
    // same rule as the tilt's: board-fit.css says how the board reads them and
    // contains none of them.
    '--play-log-rail-w': `${BOARD_LAYOUT_CONFIG.logRailWidthRem}rem`,
    '--board-midline-h': `${BOARD_LAYOUT_CONFIG.midlineThicknessPx}px`,
    '--play-tile-far-scale': String(BOARD_LAYOUT_CONFIG.farSeatTileScale),
    '--play-land-tile-scale': String(BOARD_LAYOUT_CONFIG.landTileScale),
    '--play-backs-scale': String(BOARD_LAYOUT_CONFIG.opponentBacksScale),
    // The tile's own SHAPE. Distinct from the per-tile `--perm-footprint`
    // (which is 1 or the ratio depending on whether THAT card is tapped): this
    // one is the card's aspect unconditionally, because an untapped tile is a
    // card standing up and a tapped one is the same card lying down.
    '--perm-aspect': String(TAP_ROTATION_CONFIG.footprintRatio),
  } as CSSProperties;
}

/**
 * §3.143 / UX-12 + UX-13 — WHICH CARDS WALK OUT, from the SHARED view model.
 *
 * Declared attackers and declared blockers only. A DRAFT selection does not
 * advance: while the player is still clicking, the cards must stay where they
 * are so the next click lands on the tile they aimed at — the arcs already show
 * the draft, dashed, which is the right channel for "not yet decided".
 *
 * Pure and exported so a Node test can pin it without a DOM: the advance is the
 * part that can be wrong, and `board-scene-parity` asks it the same question a
 * masked online frame does.
 */
export function stageEntriesFor(view: BoardView, viewer: PlayerId): readonly StageEntry[] {
  const combat = view.combat;
  if (!combat || !combat.attackersDeclared) return [];
  const permById = new Map<InstanceId, BoardPermanent>();
  for (const seat of [view.self, view.opponent]) {
    for (const perm of seat.permanents) permById.set(perm.instanceId, perm);
  }
  // The attacker's seat is the ACTIVE player's; everyone advances toward the
  // midline, so the sign is "am I the viewer's seat or the far one".
  const towardFor = (controller: PlayerId): 1 | -1 => (controller === viewer ? -1 : 1);
  const entries: StageEntry[] = [];
  for (const id of combat.attackers) {
    const perm = permById.get(id);
    if (perm) entries.push({ perm, role: 'attacker', toward: towardFor(perm.controller) });
  }
  if (combat.blockersDeclared) {
    for (const { blocker, attacker } of combat.blocks) {
      const perm = permById.get(blocker);
      if (perm) {
        entries.push({ perm, role: 'blocker', toward: towardFor(perm.controller), meets: attacker });
      }
    }
  }
  return entries;
}

export interface BoardSceneProps {
  /** The adapted, render-ready view of the table — the ONLY source of what is on it. */
  readonly view: BoardView;
  /** Which seat is looking. Decides which way every advance walks. */
  readonly viewer: PlayerId;
  /** The board's own root: the overlays below query their anchors inside it. */
  readonly boardRootRef: RefObject<HTMLDivElement | null>;
  /** Per-seat tile interaction (selection, markers, click). */
  readonly selfInteraction?: PermInteraction;
  readonly opponentInteraction?: PermInteraction;
  /** Jailed cards tucked under their jailer (both seats' PUBLIC exile zones). */
  readonly jails?: ReadonlyMap<InstanceId, readonly JailedCardView[]>;
  /** Open the card zoom — the one funnel every inspect gesture on this surface ends in. */
  readonly onInspectCard: (card: ZoomedCard) => void;
  /**
   * What to SAY when a permanent carries no provenance breakdown.
   *
   * The hotseat board runs the engine and always has one, so it passes nothing.
   * An online client holds a masked view and cannot know — and `CardFace` draws
   * an empty breakdown as "nothing is modifying this", which is a DIFFERENT and
   * false claim. So the absence is named rather than rendered as a zero.
   */
  readonly provenanceUnavailableReason?: string;
  /**
   * Open/close a seat's graveyard panel — EITHER seat's (bug report
   * 20260907_190210): a graveyard is public (CR 404.2), and the viewer's is
   * also the flashback affordance's door.
   */
  readonly onGraveyardClick: (seat: PlayerId) => void;
  /** Open/close a seat's exile panel — either seat's, since exile is public. */
  readonly onExileClick: (seat: PlayerId) => void;
  /** The live drag-to-play gesture, so the viewer's seat lights up as a drop target. */
  readonly drag: { readonly overDrop: boolean } | null;
  /** The drop target itself — the viewer's own seat. A CALLBACK ref: the pure
   *  drag module stores the element, not React (`useDragToPlay`). */
  readonly dropRef: (el: HTMLElement | null) => void;
  /** The panels opened FROM the viewer's seat (graveyard, exile). */
  readonly selfZonePanels?: ReactNode;
  /** What fills the rail beside the table: the game log, in each board's own words. */
  readonly rail: ReactNode;
  /** The selections the player is still clicking (dashed arcs, never advanced). */
  readonly combatDraft?: CombatDraft;
  /** Anything that changes when tiles may have moved (a commit, a server frame). */
  readonly measureKey: unknown;
  /**
   * UX-15's input. REQUIRED, and deliberately so: both boards have an event
   * stream now, so a board that mounted the scene without one would be a board
   * whose combat silently deals no visible damage — the exact defect this prop
   * replaced a named "no channel" constant to close.
   */
  readonly damage: DamageSource;
}

/**
 * The tabletop, its two seats, the seam between them, and the three unclipped
 * layers that draw combat on top of it.
 */
export function BoardScene({
  view,
  viewer,
  boardRootRef,
  selfInteraction,
  opponentInteraction,
  jails,
  onInspectCard,
  provenanceUnavailableReason,
  onGraveyardClick,
  onExileClick,
  drag,
  dropRef,
  selfZonePanels,
  rail,
  combatDraft = NO_COMBAT_DRAFT,
  measureKey,
  damage,
}: BoardSceneProps): ReactElement {
  /**
   * ONE index of every permanent on the table, read by the inspect gesture. The
   * seats already carry the render view each tile was drawn from; a second
   * lookup would be a second answer (rule 12).
   */
  const permById = useMemo(() => {
    const map = new Map<InstanceId, BoardPermanent>();
    for (const perm of [...view.self.permanents, ...view.opponent.permanents]) {
      map.set(perm.instanceId, perm);
    }
    return map;
  }, [view]);

  /**
   * §3.143 wave 3 / GAP-C — A WAY IN FROM THE BATTLEFIELD.
   *
   * The zoom had exactly two doors — a hand card and the jail peek — so the
   * cards a whole game is played with were the ones a player could never open
   * full-size with a pointer. (`CardHover`'s preview is deliberately
   * `pointer-events: none`, so its glossary pops are visible and not hoverable;
   * the zoom overlay is the only place UX-17.4 is genuinely reachable.)
   *
   * DELEGATED from the seat wrapper rather than added to the tile, because
   * `SeatPanel` and `BoardPermanentTile` are shared leaves — `data-perm-home` is
   * the anchor those files already publish and it is enough.
   *
   * TWO gestures, and the split is deliberate:
   *  - RIGHT-CLICK anywhere on a tile, matching the hand card's own context
   *    menu, so one gesture inspects a card wherever it sits;
   *  - a PLAIN CLICK only when the click did not land on a control. A tile is a
   *    `<button>` exactly when it is selectable (an attacker, a block, a land to
   *    tap), and hijacking that click would cost the player a real move — while
   *    a click on a NON-interactive permanent does nothing at all today, which
   *    is the affordance a touch device can reach.
   */
  const inspectPermanentFrom = useCallback(
    (event: ReactMouseEvent, requireInert: boolean): void => {
      const from = event.target instanceof Element ? event.target : null;
      if (from === null) return;
      if (requireInert && from.closest('button') !== null) return;
      const tile = from.closest('[data-perm-home]');
      const raw = tile?.getAttribute('data-perm-home');
      if (raw === null || raw === undefined) return;
      const perm = permById.get(Number(raw) as InstanceId);
      if (perm === undefined) return;
      event.preventDefault();
      onInspectCard({
        cardId: perm.cardId,
        name: perm.name,
        isCreature: perm.isCreature,
        ...(perm.explanation !== undefined ? { explanation: perm.explanation } : {}),
        ...(perm.explanation === undefined && provenanceUnavailableReason !== undefined
          ? { unavailableReason: provenanceUnavailableReason }
          : {}),
      });
    },
    [permById, onInspectCard, provenanceUnavailableReason],
  );

  /** The two handlers every seat gets, spread onto its wrapper. */
  const seatInspectProps = {
    onContextMenu: (event: ReactMouseEvent) => inspectPermanentFrom(event, false),
    onClick: (event: ReactMouseEvent) => inspectPermanentFrom(event, true),
  };

  /**
   * §3.143 / UX-14 — the fiery arcs, both directions. `combatArcPairs` is THE
   * funnel: blocker→attacker, PLUS attacker→(player | planeswalker), which the
   * online board could never draw because it called the block-only adapter.
   * `defendingSeat` is required for an attack on a PLAYER to draw anything — who
   * defends is a rules question (CR 506.2) core owns, and the arc module
   * deliberately refuses to re-answer it.
   */
  const combatLines = combatArcPairs({
    step: view.step,
    declaredBlocks: view.combat?.blocks,
    draftAssign: combatDraft.blocks,
    ...(view.combat !== null ? { declaredAttackers: view.combat.attackers } : {}),
    ...(view.combat?.attackTargets !== undefined
      ? { attackTargets: view.combat.attackTargets }
      : {}),
    defendingSeat: opponentOf(view.activePlayer),
    draftAttackers: combatDraft.attackers,
    draftAttackTargets: combatDraft.attackTargets,
  });

  /** §3.143 / UX-12 + UX-13 — which cards walk out to the midline. */
  const stageEntries = useMemo(() => stageEntriesFor(view, viewer), [view, viewer]);

  /**
   * Which cards are OUT, so their home tiles hand `data-perm-id` over to the
   * copy the player is actually looking at. Delivered through a CONTEXT rather
   * than a prop because `SeatPanel` renders every tile and has no field for it —
   * see `combat-stage-context.ts`.
   */
  const [stagedIds, setStagedIds] = useState<ReadonlySet<InstanceId>>(NO_STAGED_PERMANENTS);

  /** The element between the two seats: its vertical centre IS the midline. */
  const midlineRef = useRef<HTMLDivElement>(null);

  /** §3.143 / UX-15 — damage travels from source to recipient. */
  const { beats: damageBeats, retire: retireDamage } = useDamageSequence(damage.events);

  return (
    <>
      {/*
        THE TABLETOP (UX-9). Only the two seats and the seam between them are
        tilted — every modal, every overlay and the viewer's own hand are
        SIBLINGS of this box, so none of them is projected, re-rooted or
        mis-measured. The staged-permanent context wraps it because `SeatPanel`
        renders the tiles and cannot be given a prop.
      */}
      <StagedPermanentsContext.Provider value={stagedIds}>
        {/*
          THE STAGE: the table, and the rail beside it. A ROW, which is the whole
          of wave 3's layout fix — the game log used to sit in the COLUMN between
          the two battlefields, where it cost 171px of a 600px board (measured at
          1280×800, nine permanents), owned the height that made every tile tiny,
          and put a scrolling history on the one line a table reserves for
          combat. Moved sideways it costs the table no height at all, and the
          midline below is a seam again. Below `railFoldsBelowPx` the stage folds
          back to a column — a phone has no width to spend (board-fit.css rule 6).
        */}
        <div className="board-stage">
          <div className="board-scene">
            <div className="board-scene__table">
              {/*
                THE FAR EDGE OF THE TABLE. The opponent's fanned backs are drawn
                ABOVE their battlefield, not below it: on a real table the player
                opposite holds their hand at their own edge, and the other order
                puts their hand between their creatures and the midline — the one
                place nothing belongs. (That other order is what the online board
                drew until this scene became the single answer.)
              */}
              <div className="play-board__opponent" {...seatInspectProps}>
                <div
                  className="play-hand play-hand--hidden"
                  aria-label={`${view.opponent.name} hand (hidden)`}
                  data-anim-anchor={`hand:${view.opponent.id}`}
                >
                  {Array.from({ length: view.opponent.handCount }).map((_, i) => (
                    <CardBack key={i} index={i} />
                  ))}
                  {view.opponent.handCount === 0 && <span className="seat__empty">Empty hand</span>}
                </div>
                <SeatPanel
                  seat={view.opponent}
                  isActive={view.activePlayer === view.opponent.id}
                  hasPriority={view.priorityPlayer === view.opponent.id}
                  {...(opponentInteraction !== undefined ? { interaction: opponentInteraction } : {})}
                  onGraveyardClick={() => onGraveyardClick(view.opponent.id)}
                  onExileClick={() => onExileClick(view.opponent.id)}
                  {...(jails !== undefined ? { jails } : {})}
                  onInspectCard={onInspectCard}
                />
              </div>

              {/*
                THE MIDLINE — a seam on the table, and the element `CombatStage`
                measures UX-12's advance clamp from. It is measured rather than
                recomputed from seat heights, which is the one answer that stays
                true when board-fit.css squeezes a seat. Decorative, so it is
                hidden from assistive tech: a screen reader reads the two seats in
                order and a line between them says nothing.
              */}
              <div className="board-midline" ref={midlineRef} aria-hidden="true" />

              {/* Viewer (bottom) — their own seat, which doubles as the
                  drag-to-play drop zone: dashed while a card is in flight, solid
                  when the pointer is over it. */}
              <div className="play-board__self" {...seatInspectProps}>
                <div
                  ref={dropRef}
                  className={`drop-zone${drag ? ' drop-zone--active' : ''}${drag?.overDrop ? ' drop-zone--over' : ''}`}
                >
                  <SeatPanel
                    seat={view.self}
                    isActive={view.activePlayer === view.self.id}
                    hasPriority={view.priorityPlayer === view.self.id}
                    {...(selfInteraction !== undefined ? { interaction: selfInteraction } : {})}
                    onGraveyardClick={() => onGraveyardClick(view.self.id)}
                    onExileClick={() => onExileClick(view.self.id)}
                    {...(jails !== undefined ? { jails } : {})}
                    onInspectCard={onInspectCard}
                  />
                </div>
                {selfZonePanels}
              </div>
            </div>
            {/* .board-scene__table */}
          </div>
          {/* .board-scene */}
          {/*
            THE LOG'S RAIL. Outside `.board-scene`, so the history is never
            tilted: it is the one region on this surface made entirely of words,
            and words on a slant is exactly the legibility cost UX-9 must not
            pay. An `<aside>` because that is what it is — the table is the
            article.
          */}
          <aside className="board-rail" aria-label="Game log">
            {rail}
          </aside>
        </div>
        {/* .board-stage */}
      </StagedPermanentsContext.Provider>

      {/* Combat arcs (§3.57 / UX-14) — decorative overlay, tested pairing rule. */}
      <CombatLines lines={combatLines} containerRef={boardRootRef} measureKey={measureKey} />
      {/* §3.143 / UX-15 — damage TRAVELS from source to recipient, sequenced so
          first-strike reads as two rounds rather than one blur. */}
      <DamageLayer
        beats={damageBeats}
        boardRootRef={boardRootRef}
        tileRectOf={damage.tileRectOf}
        onDone={retireDamage}
      />
      {/* §3.143 / UX-12 + UX-13 — the advanced attackers and blockers. An
          UNCLIPPED sibling of the scene, because a transform on the tile is
          clipped by its own row (lib/play/combat-stage.ts names the four
          clipping boxes and why none of them can be relaxed). */}
      <CombatStage
        entries={stageEntries}
        boardRootRef={boardRootRef}
        midlineRef={midlineRef}
        measureKey={measureKey}
        onPlaced={setStagedIds}
      />
    </>
  );
}
