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
import type { GameEvent, InstanceId, PlayerId } from '@jonny-boi/core';
import { deriveVfxCues, type VfxCue } from '../../lib/play/vfx-cues.js';
import { VFX_CONFIG } from '../../lib/play/play-config.js';
import { anchorRect, usePrefersReducedMotion } from './AnimationLayer.js';

/**
 * THE VISUAL-EFFECTS LAYER (§3.131) — the DOM half of `vfx-cues.ts`, and the
 * sibling of `AnimationLayer`. The pure model decided WHAT plays (a life flash,
 * a cast flare, a damage/death burst) and WHERE (screen / a seat's board / a
 * tile); this layer measures the spot and blooms a transient element, then
 * retires it. Everything here is presentation — killing this layer changes
 * nothing about the game.
 *
 * Reduced motion is honored twice, like the flight layer: the hook derives
 * NOTHING when `prefers-reduced-motion` matches, and the CSS has no effect to
 * animate besides.
 */

/**
 * Fold the session's cumulative event log into live effects. Baselined at mount
 * so a board opening mid-game never replays history — only events appended while
 * the board is on screen bloom.
 */
export function useGameVfx(
  events: readonly GameEvent[],
  viewer: PlayerId,
): { readonly effects: readonly VfxCue[]; readonly retire: (key: string) => void } {
  const [effects, setEffects] = useState<readonly VfxCue[]>([]);
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
    const derived = deriveVfxCues(fresh, { reducedMotion, startIndex, viewer });
    if (derived.length > 0) setEffects((current) => [...current, ...derived]);
  }, [events, reducedMotion, viewer]);

  const retire = useCallback((key: string): void => {
    setEffects((current) => current.filter((e) => e.key !== key));
  }, []);

  return { effects, retire };
}

/** The overlay: one transient element per in-flight effect. */
export function VfxLayer({
  effects,
  boardRootRef,
  tileRectOf,
  onDone,
}: {
  effects: readonly VfxCue[];
  boardRootRef: RefObject<HTMLElement | null>;
  tileRectOf: (id: InstanceId) => DOMRect | undefined;
  onDone: (key: string) => void;
}): ReactElement | null {
  if (effects.length === 0) return null;
  return (
    <div className="vfx-layer" aria-hidden="true">
      {effects.map((effect) => (
        <VfxEffect key={effect.key} effect={effect} boardRootRef={boardRootRef} tileRectOf={tileRectOf} onDone={onDone} />
      ))}
    </div>
  );
}

/** Lifetime per kind (named knobs, not inline numbers). */
function lifetimeMs(kind: VfxCue['kind']): number {
  return kind === 'flash' ? VFX_CONFIG.flashMs : kind === 'flare' ? VFX_CONFIG.flareMs : VFX_CONFIG.burstMs;
}

/** Extra slack past the animation before the element retires (cheap safety). */
const RETIRE_SLACK_MS = 60;

/** One effect: positioned in a layout effect, retired by a timer. */
function VfxEffect({
  effect,
  boardRootRef,
  tileRectOf,
  onDone,
}: {
  effect: VfxCue;
  boardRootRef: RefObject<HTMLElement | null>;
  tileRectOf: (id: InstanceId) => DOMRect | undefined;
  onDone: (key: string) => void;
}): ReactElement | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const done = useRef(false);
  const lifetime = lifetimeMs(effect.kind);

  useLayoutEffect(() => {
    // A full-screen flash needs no measurement — it fills the layer.
    if (effect.kind !== 'flash') {
      const rect = rectFor(effect, boardRootRef.current, tileRectOf);
      if (!rect) {
        onDone(effect.key); // the spot is gone (re-flow, scrolled out) — skip cleanly
        return;
      }
      setStyle({
        left: rect.left + rect.width / 2,
        top: rect.top + rect.height / 2,
      });
    } else {
      setStyle({});
    }
    const timer = window.setTimeout(() => {
      if (!done.current) {
        done.current = true;
        onDone(effect.key);
      }
    }, lifetime + RETIRE_SLACK_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effect.key]);

  if (!style) return null;
  if (effect.kind === 'flash') {
    return <div className={`vfx-flash vfx-flash--${effect.tone}`} style={{ animationDuration: `${lifetime}ms` }} />;
  }
  if (effect.kind === 'flare') {
    return <div className={`vfx-flare vfx-flare--${effect.tone}`} style={{ ...style, animationDuration: `${lifetime}ms` }} />;
  }
  // A burst: a ring of particles flung outward, each with its own angle/reach.
  return (
    <div className={`vfx-burst vfx-burst--${effect.tone}`} style={style}>
      {Array.from({ length: VFX_CONFIG.burstParticles }, (_, i) => {
        const angle = (i / VFX_CONFIG.burstParticles) * Math.PI * 2;
        const reach = 18 + (i % 3) * 8; // three rings so the spray is not a clean circle
        return (
          <span
            key={i}
            className="vfx-burst__p"
            style={
              {
                animationDuration: `${lifetime}ms`,
                ['--vfx-dx' as string]: `${Math.cos(angle) * reach}px`,
                ['--vfx-dy' as string]: `${Math.sin(angle) * reach}px`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

/** Where a non-screen effect lands: a seat's board anchor, or a tile's rect. */
function rectFor(
  effect: VfxCue,
  boardRoot: HTMLElement | null,
  tileRectOf: (id: InstanceId) => DOMRect | undefined,
): DOMRect | undefined {
  const at = effect.at;
  if (at.where === 'board') return anchorRect(boardRoot, `board:${at.seat}`);
  if (at.where === 'tile') return tileRectOf(at.instanceId) ?? undefined;
  return undefined;
}
