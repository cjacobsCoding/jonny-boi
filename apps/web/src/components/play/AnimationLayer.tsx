import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from 'react';
import type { GameEvent, InstanceId } from '@jonny-boi/core';
import { getCard, cardImage } from '../../lib/cards.js';
import {
  deriveAnimations,
  type AnimationCardInfo,
  type AnimationDescriptor,
} from '../../lib/play/animations.js';
import {
  DAMAGE_BENCH_ROWS,
  DAMAGE_BENCH_SEAT,
  DAMAGE_BENCH_SOURCE_ID,
  DAMAGE_BENCH_TARGET_ID,
  DAMAGE_BENCH_THIRD_ID,
  damageHoldMsFor,
  deriveDamageSequence,
  type CombatDamageRound,
  type DamageBeat,
  type DamageEnd,
} from '../../lib/play/damage-sequence.js';
import { burstParticleOffsets } from '../../lib/play/vfx-cues.js';
import { ANIMATION_CONFIG, VFX_CONFIG } from '../../lib/play/play-config.js';

/**
 * The ZONE-CHANGE ANIMATION LAYER (§3.57) — the DOM half of `animations.ts`.
 *
 * The pure model decided WHAT animates (a draw's card back, a mill/discard's
 * face, a death's ghost); this layer decides WHERE, by measuring the board's
 * `data-anim-anchor` elements (zone counters, hand regions) and the last-known
 * tile rects, then plays each sprite as a CSS-transitioned flight and retires
 * it. Everything here is presentation: killing this layer changes nothing
 * about the game.
 *
 * Reduced motion is honored twice: `useZoneAnimations` derives NOTHING when
 * `prefers-reduced-motion` matches (no sprite is ever mounted), and the CSS
 * disables the transitions besides.
 */

/**
 * Resolve an anchor element's rect inside `root` ("library:A", "hand:B", "board:A"…).
 * Exported so the VFX layer (§3.131) measures seat anchors with the SAME reader —
 * one answer to "where is this zone on screen", not two that can drift.
 */
export function anchorRect(root: HTMLElement | null, anchor: string): DOMRect | undefined {
  if (!root) return undefined;
  const el = root.querySelector(`[data-anim-anchor="${anchor}"]`);
  return el instanceof HTMLElement ? el.getBoundingClientRect() : undefined;
}

/** Watch the OS-level reduced-motion preference (live, not just at mount). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (): void => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Fold the session's cumulative event log into live sprites. The baseline is
 * the log length AT MOUNT, so a board opening mid-game (or after a hotseat
 * handoff) never replays history — only events appended while the board is on
 * screen animate.
 */
export function useZoneAnimations(
  events: readonly GameEvent[],
  lookup: (id: InstanceId) => AnimationCardInfo | undefined,
): { readonly sprites: readonly AnimationDescriptor[]; readonly retire: (key: string) => void } {
  const [sprites, setSprites] = useState<readonly AnimationDescriptor[]>([]);
  const reducedMotion = usePrefersReducedMotion();
  // Baseline at mount: everything already in the log happened before we watched.
  const seen = useRef<number>(events.length);

  useEffect(() => {
    if (events.length <= seen.current) {
      // A rematch swaps in a shorter log; re-baseline instead of replaying it.
      seen.current = events.length;
      return;
    }
    const startIndex = seen.current;
    const fresh = events.slice(startIndex);
    seen.current = events.length;
    // THE SHARED CLOCK (UX-15). A creature killed by combat damage must not
    // vanish while the hit that killed it is still in flight, so the death ghost
    // waits for the damage plan derived from THIS SAME batch. Derived here as
    // well as in `useDamageSequence` on purpose: it is a pure function of one
    // input, so the two cannot disagree, and that is cheaper (and far less
    // brittle) than threading a second value through the board's props.
    const plan = deriveDamageSequence(fresh, { reducedMotion, startIndex });
    // `lookup` swaps identity together with `events` (both derive from the
    // session), so depending on it adds no extra derivations — a lookup-only
    // run sees nothing fresh and is a no-op.
    const derived = deriveAnimations(fresh, {
      reducedMotion,
      startIndex,
      lookup,
      deathHoldMsFor: (id) => damageHoldMsFor(plan, id),
    });
    if (derived.length > 0) setSprites((current) => [...current, ...derived]);
  }, [events, reducedMotion, lookup]);

  const retire = useCallback((key: string): void => {
    setSprites((current) => current.filter((sprite) => sprite.key !== key));
  }, []);

  return { sprites, retire };
}

/** The overlay itself: one transient element per in-flight descriptor. */
export function AnimationLayer({
  sprites,
  boardRootRef,
  tileRectOf,
  onDone,
}: {
  sprites: readonly AnimationDescriptor[];
  /** The board container the anchors are queried inside (read in effects only). */
  boardRootRef: RefObject<HTMLElement | null>;
  /** Last-known battlefield tile rect (captured before the tile left the DOM). */
  tileRectOf: (id: InstanceId) => DOMRect | undefined;
  onDone: (key: string) => void;
}): ReactElement | null {
  if (sprites.length === 0) return null;
  return (
    <div className="anim-layer" aria-hidden="true">
      {sprites.map((sprite) =>
        sprite.kind === 'death' ? (
          <DeathGhost key={sprite.key} sprite={sprite} tileRectOf={tileRectOf} boardRootRef={boardRootRef} onDone={onDone} />
        ) : (
          <FlightSprite key={sprite.key} sprite={sprite} boardRootRef={boardRootRef} onDone={onDone} />
        ),
      )}
    </div>
  );
}

/** Where one flight starts and ends, per kind (anchors by seat). */
function flightAnchors(sprite: AnimationDescriptor): { from: string; fromFallback?: string; to: string; toFallback?: string } {
  const seat = sprite.seat;
  if (sprite.kind === 'draw') {
    return { from: `library:${seat}`, to: `hand:${seat}`, toFallback: `hand-count:${seat}` };
  }
  if (sprite.kind === 'mill') {
    return { from: `library:${seat}`, to: `graveyard:${seat}` };
  }
  // discard
  return { from: `hand:${seat}`, fromFallback: `hand-count:${seat}`, to: `graveyard:${seat}` };
}

/** Flight duration per kind (named knobs, not inline numbers). */
function flightDurationMs(kind: AnimationDescriptor['kind']): number {
  return kind === 'draw' ? ANIMATION_CONFIG.drawFlightMs : ANIMATION_CONFIG.graveFlightMs;
}

/**
 * When a sprite starts: its stagger slot, plus any hold the descriptor carries
 * (a death waiting for the damage that caused it — see `deathHoldMsFor`). ONE
 * answer to "when does this sprite go", read by both sprite kinds.
 */
function spriteDelayMs(sprite: AnimationDescriptor): number {
  return sprite.order * ANIMATION_CONFIG.staggerMs + (sprite.delayMs ?? 0);
}

/** Extra time past the transition before the sprite retires (cheap safety). */
const RETIRE_SLACK_MS = 80;

/** The center of a rect, as fixed-position coordinates for the sprite box. */
function centerOf(rect: DOMRect, width: number, height: number): { left: number; top: number } {
  return {
    left: rect.left + rect.width / 2 - width / 2,
    top: rect.top + rect.height / 2 - height / 2,
  };
}

/** Card sprite proportions (a Magic card is 63×88mm — keep the ratio honest). */
const CARD_ASPECT = 88 / 63;

/**
 * A card flying between two zone anchors — a BACK for a draw (identity stays
 * hidden), the face art for a mill/discard (public by the time it flies).
 */
function FlightSprite({
  sprite,
  boardRootRef,
  onDone,
}: {
  sprite: AnimationDescriptor;
  boardRootRef: RefObject<HTMLElement | null>;
  onDone: (key: string) => void;
}): ReactElement | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const done = useRef(false);
  const width = ANIMATION_CONFIG.spriteWidthPx;
  const height = Math.round(width * CARD_ASPECT);
  const delayMs = spriteDelayMs(sprite);
  const durationMs = flightDurationMs(sprite.kind);

  useLayoutEffect(() => {
    const boardRoot = boardRootRef.current;
    const anchors = flightAnchors(sprite);
    const from =
      anchorRect(boardRoot, anchors.from) ??
      (anchors.fromFallback ? anchorRect(boardRoot, anchors.fromFallback) : undefined);
    const to =
      anchorRect(boardRoot, anchors.to) ??
      (anchors.toFallback ? anchorRect(boardRoot, anchors.toFallback) : undefined);
    if (!from || !to) {
      // An anchor missing (panel scrolled out of existence, hidden layout) —
      // skip the sprite rather than fly from nowhere. The log tells the story.
      onDone(sprite.key);
      return;
    }
    const start = centerOf(from, width, height);
    const end = centerOf(to, width, height);
    setStyle({
      left: start.left,
      top: start.top,
      width,
      height,
      transitionDuration: `${durationMs}ms`,
      transitionDelay: `${delayMs}ms`,
      // The flight is one transform, set on the NEXT frame (see below).
      transform: 'translate(0px, 0px)',
      ['--anim-dx' as string]: `${end.left - start.left}px`,
      ['--anim-dy' as string]: `${end.top - start.top}px`,
    });
    // Two rAFs: the first commits the start position, the second flips the
    // class so the transition actually runs (a same-frame flip transitions
    // nothing).
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setStyle((cur) => (cur ? { ...cur, transform: 'translate(var(--anim-dx), var(--anim-dy))' } : cur));
      });
    });
    const timer = window.setTimeout(() => {
      if (!done.current) {
        done.current = true;
        onDone(sprite.key);
      }
    }, delayMs + durationMs + RETIRE_SLACK_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(timer);
    };
    // Mounted once per sprite key; the descriptor is immutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprite.key]);

  if (!style) return null;
  const card = sprite.cardId ? getCard(sprite.cardId) : undefined;
  const art = card ? cardImage(card, 'art_crop') : undefined;
  return (
    <div className={`anim-sprite anim-sprite--${sprite.kind}`} style={style}>
      {sprite.kind === 'draw' || !art ? (
        <span className="anim-sprite__back">⚙</span>
      ) : (
        <img src={art} alt="" draggable={false} />
      )}
    </div>
  );
}

/**
 * A permanent's ghost fading and shrinking where its tile stood — the §3.57
 * "creatures dying" read. Positioned by the tile rect captured BEFORE the
 * tile left the DOM; when no rect survives (the board re-flowed), it fades at
 * the seat's board row instead of not existing at all.
 */
function DeathGhost({
  sprite,
  tileRectOf,
  boardRootRef,
  onDone,
}: {
  sprite: AnimationDescriptor;
  tileRectOf: (id: InstanceId) => DOMRect | undefined;
  boardRootRef: RefObject<HTMLElement | null>;
  onDone: (key: string) => void;
}): ReactElement | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);
  const durationMs = ANIMATION_CONFIG.deathFadeMs;
  const delayMs = spriteDelayMs(sprite);

  useLayoutEffect(() => {
    const rect = tileRectOf(sprite.instanceId) ?? anchorRect(boardRootRef.current, `board:${sprite.seat}`);
    if (!rect) {
      onDone(sprite.key);
      return;
    }
    setStyle({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      transitionDuration: `${durationMs}ms`,
      transitionDelay: `${delayMs}ms`,
    });
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setLeaving(true));
    });
    const timer = window.setTimeout(() => {
      if (!done.current) {
        done.current = true;
        onDone(sprite.key);
      }
    }, delayMs + durationMs + RETIRE_SLACK_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprite.key]);

  if (!style) return null;
  const card = sprite.cardId ? getCard(sprite.cardId) : undefined;
  const art = card ? cardImage(card, 'art_crop') : undefined;
  return (
    <div className={`anim-ghost${leaving ? ' anim-ghost--leaving' : ''}`} style={style}>
      {art ? <img src={art} alt="" draggable={false} /> : <span className="anim-ghost__name">{sprite.name}</span>}
    </div>
  );
}

/* ===========================================================================
 * THE DAMAGE LAYER (UX-15, §3.143) — the DOM half of `damage-sequence.ts`.
 *
 * Caleb: "Animations when block phase is over and damage is being distributed
 * to players and creatures, just like MTGA does it, so you can clearly see
 * what's happening." The pure fold decided WHAT hit WHAT, in which round, and at
 * what millisecond; this layer measures the two ends and schedules the paint.
 *
 * ## Why this is pure CSS delays and not the two-rAF transition trick above
 * The flight sprites flip a transition on the next frame because their endpoint
 * is only known after measurement. A damage beat already knows its whole
 * timeline from the plan, so each element is mounted once with an
 * `animation-delay` and `animation-fill-mode: both` — invisible before its beat,
 * self-cleaning after it. One mechanism, no frame-timing races, and a batch of
 * ten beats costs ten style objects rather than twenty rAF callbacks.
 *
 * ## ⚠️ WHAT LANE D MUST NOT DO (the 3D-scene trap)
 * `.dmg-layer` is `position: fixed` with raw VIEWPORT coordinates, exactly like
 * `.anim-layer` and `.vfx-layer`. That is correct only while no ancestor of it
 * is transformed: a `transform`/`perspective`/`filter` on an ancestor makes that
 * ancestor the containing block for fixed descendants and silently re-roots all
 * three layers. So the board's 3D scene wrapper (UX-9) must contain ONLY the
 * seat regions, and this layer must be mounted as its SIBLING, never inside it.
 * Measuring the tiles themselves is safe either way — `getBoundingClientRect`
 * returns the PROJECTED box, so a hit lands on the tile the player can see
 * (exact in x; in y, the midpoint of the projected top and bottom edges, a
 * few px off the true centre at the tilts this scene uses — fine for a bloom).
 * ======================================================================== */

/**
 * WHERE EACH TILE LAST STOOD, by instance id — the one place either board
 * answers that, and the rect source every fixed overlay measures against.
 *
 * Refreshed after every render and NEVER evicted, because "last stood" has to
 * survive the thing that needs it: a creature killed by the very hit being drawn
 * has already left the DOM, and a death ghost or a damage bloom aimed at it must
 * still land where the player last saw it. (A 2-deep window was measured losing
 * the rect to the burst of auto-advance commits between the death event and the
 * ghost's mount.) Memory is one `DOMRect` per instance that ever reached the
 * battlefield — trivial beside the game itself; the walk is one board's worth of
 * `getBoundingClientRect` calls per render, nothing beside the re-render.
 *
 * ⚠️ SHARED BY BOTH BOARDS ON PURPOSE (CLAUDE.md rule 12). It lived inline in
 * `PlayBoard` while the online board had no damage channel at all; the day the
 * online board got one, a second copy of this walk would have been a second
 * answer to "where is tile #7", drifting the two boards' overlays apart.
 */
export function useTileRects(boardRootRef: RefObject<HTMLElement | null>): (id: InstanceId) => DOMRect | undefined {
  const tileRectsRef = useRef(new Map<InstanceId, DOMRect>());
  useEffect(() => {
    const root = boardRootRef.current;
    if (!root) return;
    const rects = tileRectsRef.current;
    for (const el of root.querySelectorAll('[data-perm-id]')) {
      if (!(el instanceof HTMLElement)) continue;
      const id = Number(el.dataset['permId']);
      if (!Number.isNaN(id)) rects.set(id, el.getBoundingClientRect());
    }
  });
  return useCallback((id: InstanceId): DOMRect | undefined => tileRectsRef.current.get(id), []);
}

/**
 * Fold the session's cumulative event log into live damage beats. Baselined at
 * mount, like both sibling hooks, so a board opened mid-game never replays the
 * combat that already happened.
 */
export function useDamageSequence(events: readonly GameEvent[]): {
  readonly beats: readonly DamageBeat[];
  readonly retire: (key: string) => void;
} {
  const [beats, setBeats] = useState<readonly DamageBeat[]>([]);
  const reducedMotion = usePrefersReducedMotion();
  const seen = useRef<number>(events.length);

  useEffect(() => {
    if (events.length <= seen.current) {
      seen.current = events.length; // a rematch's shorter log: re-baseline, don't replay
      return;
    }
    const startIndex = seen.current;
    const fresh = events.slice(startIndex);
    seen.current = events.length;
    const derived = deriveDamageSequence(fresh, { reducedMotion, startIndex });
    if (derived.length > 0) setBeats((current) => [...current, ...derived]);
  }, [events, reducedMotion]);

  const retire = useCallback((key: string): void => {
    setBeats((current) => current.filter((b) => b.key !== key));
  }, []);

  return { beats, retire };
}

/**
 * Keep a banner alive for each round that turns up in `beats`.
 *
 * A banner is NOT re-derived from the live array on every render, and that is
 * the whole design: beats retire one at a time as they finish, so a round's
 * "lead" beat changes under you, and a naive re-derivation would re-announce a
 * round that is already half over. Instead each round is announced ONCE — every
 * beat it covers is remembered, so the survivors are recognised as already
 * spoken for — and the banner then retires on its own timer like every other
 * element in this file.
 *
 * It lives inside `DamageLayer` rather than in `useDamageSequence` so that the
 * board mounts the layer exactly as it does today: a banner is presentation the
 * layer derives for itself, not a second thing every caller has to thread
 * through.
 */
function useRoundBanners(beats: readonly DamageBeat[]): {
  readonly banners: readonly DamageRoundBanner[];
  readonly retire: (key: string) => void;
} {
  const [banners, setBanners] = useState<readonly DamageRoundBanner[]>([]);
  const announced = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (beats.length === 0) {
      // The board is idle: nothing can still be waiting to be announced, so the
      // memory resets rather than growing for the length of the game.
      announced.current.clear();
      return;
    }
    const fresh = damageRoundBanners(beats).filter((b) => !announced.current.has(b.key));
    if (fresh.length === 0) return;
    for (const banner of fresh) for (const key of banner.beatKeys) announced.current.add(key);
    setBanners((current) => [...current, ...fresh]);
  }, [beats]);

  const retire = useCallback((key: string): void => {
    setBanners((current) => current.filter((b) => b.key !== key));
  }, []);

  return { banners, retire };
}

/** The overlay: one element pair (travelling hit + impact) per live beat. */
export function DamageLayer({
  beats,
  boardRootRef,
  tileRectOf,
  onDone,
}: {
  beats: readonly DamageBeat[];
  /** The board container the seat anchors are queried inside (read in effects only). */
  boardRootRef: RefObject<HTMLElement | null>;
  /** Last-known battlefield tile rect (a creature killed by this very hit is already gone). */
  tileRectOf: (id: InstanceId) => DOMRect | undefined;
  onDone: (key: string) => void;
}): ReactElement | null {
  // Hooks BEFORE the empty-board bail-out: an early return above a hook is the
  // one thing React's rules genuinely forbid.
  const { banners, retire: retireBanner } = useRoundBanners(beats);
  if (beats.length === 0 && banners.length === 0) return null;
  return (
    <div className="dmg-layer" aria-hidden="true">
      {banners.map((banner) => (
        <DamageRoundLabel key={banner.key} banner={banner} onDone={retireBanner} />
      ))}
      {beats.map((beat) => (
        <DamageBeatView key={beat.key} beat={beat} boardRootRef={boardRootRef} tileRectOf={tileRectOf} onDone={onDone} />
      ))}
    </div>
  );
}

/**
 * The words over a damage round.
 *
 * Scheduled the same way every other element in this layer is — one
 * `animation-delay`, one `animation-duration`, `fill-mode: both` — so it is
 * invisible before its round and gone after it, with nothing to synchronise.
 * Exported so a test can render it without a DOM: the banner's whole job is to
 * put readable words on screen, and a test that only checks the derivation would
 * be exactly the "built, tested, unreachable" failure of the first two waves.
 */
export function DamageRoundLabel({
  banner,
  onDone,
}: {
  banner: DamageRoundBanner;
  onDone: (key: string) => void;
}): ReactElement {
  const done = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        if (done.current) return;
        done.current = true;
        onDone(banner.key);
      },
      banner.startMs + banner.durationMs + RETIRE_SLACK_MS,
    );
    return () => window.clearTimeout(timer);
    // Mounted once per banner key; the banner is immutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [banner.key]);

  // `--unnamed` rather than no modifier at all: the untabulated case gets its
  // own, deliberately plain treatment instead of inheriting a named round's.
  const modifier = banner.modifier === '' ? 'round-unnamed' : banner.modifier;
  return (
    <div
      className={`dmg-round dmg-round--${modifier}`}
      style={{
        animationDelay: `${banner.startMs}ms`,
        animationDuration: `${banner.durationMs}ms`,
      }}
    >
      {banner.label}
    </div>
  );
}

/**
 * Where one end of a hit is on screen.
 *
 * A seat aims at its LIFE readout if the board offers one and falls back to the
 * seat's board row, which every board already anchors. Graceful by construction:
 * the day `SeatPanel` grows a `life:<seat>` anchor the arcs re-aim themselves
 * with no code change here, and until then face damage still lands somewhere
 * honest instead of not animating at all.
 */
function endRect(
  end: DamageEnd,
  boardRoot: HTMLElement | null,
  tileRectOf: (id: InstanceId) => DOMRect | undefined,
): DOMRect | undefined {
  if (end.where === 'tile') return tileRectOf(end.instanceId);
  return anchorRect(boardRoot, `${SEAT_LIFE_ANCHOR}:${end.seat}`) ?? anchorRect(boardRoot, `board:${end.seat}`);
}

/** The anchor a face hit aims at when the board publishes one (see {@link endRect}). */
const SEAT_LIFE_ANCHOR = 'life';

/** The centre of a rect, in the viewport coordinates the layer paints in. */
function centrePoint(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/* ---------------------------------------------------------------------------
 * WHICH ROUND AM I LOOKING AT (UX-15, §3.143 wave 3 / GAP-F)
 *
 * Core stamps every combat-damage event with the step that dealt it and the fold
 * carries it through as `DamageBeat.round` — but until this wave nothing on
 * screen read it, so a first-strike combat drew two identical-looking volleys
 * separated by a 220ms pause. Two rounds that look the same ARE the confusion
 * Caleb is asking to be rid of ("so you can clearly see what's happening"); the
 * spacing alone does not say which volley is which, or that there were two.
 * ------------------------------------------------------------------------ */

/** How one damage round announces itself. */
export interface DamageRoundPresentation {
  /** CSS modifier suffix — `dmg-bolt--round-first-strike`, `dmg-round--first-strike`. */
  readonly modifier: string;
  /** The words on the banner. Plain English: this is read mid-combat, at a glance. */
  readonly label: string;
}

/**
 * The round table. CLOSED, and closed in the strong sense: it is a MAPPED TYPE
 * over core's own `CombatDamageRound`, so the day core gains a third step this
 * file fails to BUILD rather than quietly filing the new step under one of these
 * two. Adding a step is a ROW here (rule 2).
 */
export const DAMAGE_ROUND_PRESENTATION: { readonly [R in CombatDamageRound]: DamageRoundPresentation } =
  Object.freeze({
    firstStrike: Object.freeze({ modifier: 'round-first-strike', label: 'First-strike damage' }),
    normal: Object.freeze({ modifier: 'round-normal', label: 'Combat damage' }),
  });

/**
 * The table's row for a beat's round, or `undefined` when there isn't one.
 *
 * Read through a PARTIAL view on purpose. The mapped type above already makes a
 * missing row a build error; this handles the other direction — a value that is
 * not in the table at RUNTIME (a log replayed from a newer core, a hand-built
 * event in a bench row). Such a value REPORTS as an unnamed round rather than
 * being widened to the nearest thing that happens to exist, because "First-strike
 * damage" printed over a volley that was something else is worse than no label.
 */
function roundPresentationOf(
  round: CombatDamageRound | undefined,
): DamageRoundPresentation | undefined {
  if (round === undefined) return undefined;
  const table: Partial<Record<string, DamageRoundPresentation>> = DAMAGE_ROUND_PRESENTATION;
  return table[round];
}

/** The round modifier a beat's chips wear, or `''` when the round has no name. */
function roundModifierOf(beat: DamageBeat): string {
  return roundPresentationOf(beat.round)?.modifier ?? '';
}

/**
 * What a round's banner says, or `undefined` for no banner at all.
 *
 * An UNNAMED first round is a burn spell, a fight, a ping — damage that belongs
 * to no combat step and needs no announcement; labelling it would put a caption
 * over every Shock in the game. An unnamed round AFTER the first is the case
 * that genuinely needs words: two volleys are on screen and nothing else says
 * they are two. It is numbered rather than named, because the only honest thing
 * to say about a round with no marker is which one it is.
 */
function roundLabelFor(round: CombatDamageRound | undefined, roundIndex: number): string | undefined {
  const named = roundPresentationOf(round);
  if (named !== undefined) return named.label;
  return roundIndex > 0 ? `Damage — round ${roundIndex + 1}` : undefined;
}

/** One round's on-screen announcement. */
export interface DamageRoundBanner {
  /** Stable React key: the lead beat's key, itself an ABSOLUTE event index. */
  readonly key: string;
  readonly label: string;
  /** `'round-first-strike'` / `'round-normal'`, or `''` for an unnamed round. */
  readonly modifier: string;
  /** When the banner appears, ms from the start of the sequence (its round's start). */
  readonly startMs: number;
  /** How long it stays, ms — exactly as long as its round's damage is in flight. */
  readonly durationMs: number;
  /**
   * Every beat this banner speaks for. The layer remembers these so that a round
   * whose lead beat has already retired is not announced a second time by
   * whichever of its beats is now first.
   */
  readonly beatKeys: readonly string[];
}

/**
 * Group live beats into the banners they earn. PURE, so the grouping rule is
 * unit-testable in Node with no DOM — the half of this feature that can actually
 * be proved here.
 *
 * A new group starts when the round INDEX changes, when the round MARKER changes,
 * or when `startMs` goes backwards — the last of those is a fresh batch, whose
 * timings restart at zero while its indices restart at zero too. (Two
 * back-to-back batches that each contain exactly one round starting at 0ms merge
 * into one group; the second then finds its beats already announced and stays
 * silent. That is a missing banner, never a wrong one, and it needs two separate
 * damage events to arrive in two separate renders to happen at all.)
 */
export function damageRoundBanners(beats: readonly DamageBeat[]): readonly DamageRoundBanner[] {
  const out: DamageRoundBanner[] = [];
  let group: DamageBeat[] = [];

  const flush = (): void => {
    const lead = group[0];
    if (lead === undefined) return;
    const label = roundLabelFor(lead.round, lead.roundIndex);
    if (label !== undefined) {
      let end = 0;
      for (const b of group) end = Math.max(end, b.startMs + b.travelMs + b.impactMs);
      out.push({
        key: lead.key,
        label,
        modifier: roundModifierOf(lead),
        startMs: lead.startMs,
        durationMs: Math.max(0, end - lead.startMs),
        beatKeys: group.map((b) => b.key),
      });
    }
    group = [];
  };

  for (const beat of beats) {
    const prev = group[group.length - 1];
    if (
      prev !== undefined &&
      (prev.roundIndex !== beat.roundIndex || prev.round !== beat.round || beat.startMs < prev.startMs)
    ) {
      flush();
    }
    group.push(beat);
  }
  flush();
  return out;
}

/** The CSS modifier suffixes a beat earns, in a fixed order so classes are stable. */
export function beatModifiers(beat: DamageBeat): string {
  const parts: string[] = [];
  if (beat.outcome === 'prevented') parts.push('prevented');
  else if (beat.lethal) parts.push('lethal');
  if (beat.to.where === 'seat') parts.push('seat');
  if (beat.kind === 'condensed') parts.push('condensed');
  // Last, so the round tint is the outermost thing a reader of the class list
  // sees — and `''` when the round is untabulated, which paints nothing rather
  // than borrowing another round's look.
  const round = roundModifierOf(beat);
  if (round !== '') parts.push(round);
  return parts.join(' ');
}

/** Prefix the amount with a minus only for a player's life — a creature MARKS damage. */
function beatText(beat: DamageBeat): string {
  return beat.to.where === 'seat' ? `−${beat.amount}` : `${beat.amount}`;
}

/** One beat: measured once, scheduled entirely by CSS delays, retired by a timer. */
function DamageBeatView({
  beat,
  boardRootRef,
  tileRectOf,
  onDone,
}: {
  beat: DamageBeat;
  boardRootRef: RefObject<HTMLElement | null>;
  tileRectOf: (id: InstanceId) => DOMRect | undefined;
  onDone: (key: string) => void;
}): ReactElement | null {
  const [placed, setPlaced] = useState<{ bolt: CSSProperties | null; impact: CSSProperties } | null>(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    const boardRoot = boardRootRef.current;
    const toRect = endRect(beat.to, boardRoot, tileRectOf);
    if (!toRect) {
      // The recipient is nowhere measurable (board re-flowed, panel scrolled out
      // of existence) — skip the beat rather than bloom at the origin. The life
      // total and the log still tell the story, which is the same fallback both
      // sibling layers take.
      onDone(beat.key);
      return;
    }
    const to = centrePoint(toRect);
    const impact: CSSProperties = {
      left: to.x,
      top: to.y,
      animationDelay: `${beat.startMs + beat.travelMs}ms`,
      animationDuration: `${beat.impactMs}ms`,
    };
    // A condensed beat has many sources and deliberately does not travel; a hit
    // whose source has already left the board does not travel either.
    const fromRect = beat.from ? endRect(beat.from, boardRoot, tileRectOf) : undefined;
    let bolt: CSSProperties | null = null;
    if (fromRect && beat.travelMs > 0) {
      const from = centrePoint(fromRect);
      bolt = {
        left: from.x,
        top: from.y,
        animationDelay: `${beat.startMs}ms`,
        animationDuration: `${beat.travelMs}ms`,
        ['--dmg-dx' as string]: `${to.x - from.x}px`,
        ['--dmg-dy' as string]: `${to.y - from.y}px`,
      };
    }
    setPlaced({ bolt, impact });
    const timer = window.setTimeout(
      () => {
        if (!done.current) {
          done.current = true;
          onDone(beat.key);
        }
      },
      beat.startMs + beat.travelMs + beat.impactMs + RETIRE_SLACK_MS,
    );
    return () => window.clearTimeout(timer);
    // Mounted once per beat key; the beat is immutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat.key]);

  if (!placed) return null;
  const mods = beatModifiers(beat);
  const cls = (base: string): string =>
    mods === '' ? base : `${base} ${mods.split(' ').map((m) => `${base}--${m}`).join(' ')}`;
  // `data-dmg-step` is the round's NAME (`firstStrike`/`normal`/`unmarked`) next
  // to the existing ordinal: the ordinal cannot tell a harness or a debugging
  // human which combat-damage step it is looking at, which is the whole of GAP-F.
  const step = beat.round ?? 'unmarked';
  const roundMod = roundModifierOf(beat);
  return (
    <>
      {placed.bolt && (
        <div className={cls('dmg-bolt')} style={placed.bolt} data-dmg-round={beat.roundIndex} data-dmg-step={step}>
          <span className="dmg-bolt__n">{beatText(beat)}</span>
        </div>
      )}
      <div className={cls('dmg-impact')} style={placed.impact} data-dmg-round={beat.roundIndex} data-dmg-step={step}>
        <span className="dmg-impact__ring" />
        <span className="dmg-impact__n">{beatText(beat)}</span>
      </div>
      {/* The damage spray — the SAME particles `vfx-cues` used to fire at t=0,
          now fired when the hit actually lands (see the note in vfx-cues.ts).
          It carries the round modifier too: the spray sits OUTSIDE `.dmg-impact`
          (it is a sibling, not a child), so it inherits none of the impact's
          round tint and would otherwise be the one ember-coloured thing in a
          first-strike volley. */}
      {beat.outcome === 'dealt' && beat.to.where === 'tile' && (
        <div
          className={['vfx-burst', 'vfx-burst--damage', roundMod === '' ? '' : `vfx-burst--${roundMod}`]
            .filter((c) => c.length > 0)
            .join(' ')}
          style={{ left: placed.impact.left, top: placed.impact.top }}
        >
          {burstParticleOffsets(VFX_CONFIG.burstParticles).map((p, i) => (
            <span
              key={i}
              className="vfx-burst__p"
              style={
                {
                  animationDelay: placed.impact.animationDelay,
                  animationDuration: placed.impact.animationDuration,
                  ['--vfx-dx' as string]: `${p.dx}px`,
                  ['--vfx-dy' as string]: `${p.dy}px`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

/* ===========================================================================
 * THE DAMAGE BENCH (CLAUDE.md rule 3 — "a system isn't done until you can
 * observe and drive it at runtime").
 *
 * It lives HERE, in the layer's own module, because the effects bench
 * (`EffectsPreview.tsx`) belongs to no lane in this overhaul and four lanes need
 * rows in it. Packaging the whole thing as ONE self-contained component means
 * the registration is a single `<DamageBench />` line rather than a shared file
 * four agents edit at once.
 *
 * It drives the REAL fold and the REAL layer: the buttons come from
 * `DAMAGE_BENCH_ROWS`, a closed table of engine event batches, and each one is
 * run through `deriveDamageSequence`. What you audition is what a game draws —
 * the same discipline the sound/VFX bench already states about itself.
 * ======================================================================== */

/**
 * Key stride between bench runs. Beat keys are minted from absolute event
 * indices, so each replay needs its own index space or React reuses an element
 * that is mid-animation. Comfortably larger than any row's event count.
 */
const BENCH_RUN_STRIDE = 1000;

export function DamageBench(): ReactElement {
  const stageRef = useRef<HTMLDivElement>(null);
  const [beats, setBeats] = useState<readonly DamageBeat[]>([]);
  const runs = useRef(0);

  const tileRectOf = useCallback((id: InstanceId): DOMRect | undefined => {
    const el = stageRef.current?.querySelector(`[data-perm-id="${id}"]`);
    return el instanceof HTMLElement ? el.getBoundingClientRect() : undefined;
  }, []);

  const retire = useCallback((key: string): void => {
    setBeats((current) => current.filter((b) => b.key !== key));
  }, []);

  const play = useCallback((events: readonly GameEvent[]): void => {
    const startIndex = ++runs.current * BENCH_RUN_STRIDE;
    const derived = deriveDamageSequence(events, { reducedMotion: false, startIndex });
    setBeats((current) => [...current, ...derived]);
  }, []);

  return (
    <div className="dmg-bench">
      <h4 className="dmg-bench__sub">Damage distribution (UX-15)</h4>
      <p className="dmg-bench__note">
        Each button replays a real batch of engine events through the real fold —
        including the two-round read a first-striker produces and the condensed
        presentation a board-wide combat degrades to.
      </p>
      <div className="dmg-bench__grid">
        {DAMAGE_BENCH_ROWS.map((row) => (
          <button key={row.id} type="button" className="btn dmg-bench__btn" onClick={() => play(row.events)}>
            💥 {row.label}
          </button>
        ))}
      </div>
      <div className="dmg-bench__stage" ref={stageRef} aria-hidden="true">
        <span className="dmg-bench__tile" data-perm-id={DAMAGE_BENCH_SOURCE_ID}>
          source
        </span>
        <span className="dmg-bench__tile" data-perm-id={DAMAGE_BENCH_TARGET_ID}>
          target
        </span>
        <span className="dmg-bench__tile" data-perm-id={DAMAGE_BENCH_THIRD_ID}>
          other
        </span>
        <span className="dmg-bench__seat" data-anim-anchor={`${SEAT_LIFE_ANCHOR}:${DAMAGE_BENCH_SEAT}`}>
          face ({DAMAGE_BENCH_SEAT})
        </span>
      </div>
      <DamageLayer beats={beats} boardRootRef={stageRef} tileRectOf={tileRectOf} onDone={retire} />
    </div>
  );
}
