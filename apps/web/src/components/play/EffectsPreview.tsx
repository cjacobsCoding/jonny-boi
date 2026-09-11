import { useCallback, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { ALL_SOUND_CUES, type SoundCue } from '../../lib/play/sound-cues.js';
import { SoundEngine } from '../../lib/play/sound-engine.js';
import { loadSoundPrefs, saveSoundPrefs, type SoundPrefs } from '../../lib/play/sound-prefs.js';
import { burstParticleOffsets, type VfxKind, type VfxTone } from '../../lib/play/vfx-cues.js';
import {
  BOARD_3D_CONFIG,
  TAP_ROTATION_CONFIG,
  VFX_CONFIG,
} from '../../lib/play/play-config.js';
import { DamageBench } from './AnimationLayer.js';
import { CombatLines } from './CombatLines.js';
import { COMBAT_ARC_BENCH_ARCS, COMBAT_ARC_BENCH_TILE_IDS } from '../../lib/play/combat-lines.js';
import './game-fx.css';
import './board-scene.css';
import './effects-preview.css';
import './effects-bench.css';

/**
 * THE EFFECTS PREVIEW BENCH (§3.132) — the observability the game-feel systems
 * (§3.130 audio, §3.131 VFX) owed under rule 3: a system is not done until you
 * can drive it at runtime. Here you can hear every sound and preview every
 * visual effect on demand, without playing a whole game — which is also the only
 * practical way to JUDGE and TUNE "rival MTGA", since the effects otherwise fire
 * only in the flow of a match.
 *
 * It reuses the real pieces, so what you audition is what you get: the same
 * `SoundEngine` and recipe table, the same `.vfx-*` CSS classes and the same
 * `burstParticleOffsets` the live layer draws. The master mute/volume here IS
 * the game's persisted audio preference; a sound preview `force`s a play so you
 * can still hear a cue with game audio muted.
 */

/** A friendly label per sound cue — the machine name is not a caption. */
const SOUND_LABELS: Readonly<Record<SoundCue, string>> = {
  land: 'Land drop',
  cast: 'Cast spell',
  draw: 'Draw',
  tap: 'Tap',
  attack: 'Attack',
  block: 'Block',
  damage: 'Damage',
  death: 'Creature dies',
  lifeGain: 'Life gain',
  lifeLoss: 'Life loss',
  resolve: 'Resolve',
  ability: 'Ability',
  counter: 'Counter',
  token: 'Token',
  turn: 'New turn',
  reveal: 'Reveal',
  cycle: 'Cycle',
  transform: 'Transform',
  victory: 'Victory',
  defeat: 'Defeat',
};

/** The visual effects to preview — one row per (kind, tone), with a caption. */
const VFX_PREVIEWS: readonly { readonly kind: VfxKind; readonly tone: VfxTone; readonly label: string }[] = [
  { kind: 'flash', tone: 'gain', label: 'Life gain (screen)' },
  { kind: 'flash', tone: 'loss', label: 'Life loss (screen)' },
  { kind: 'flare', tone: 'cast', label: 'Cast glow' },
  { kind: 'flare', tone: 'token', label: 'Token shimmer' },
  { kind: 'burst', tone: 'damage', label: 'Damage burst' },
  { kind: 'burst', tone: 'death', label: 'Death burst' },
];

/** One in-flight preview effect on the stage (or full-screen for a flash). */
interface PreviewEffect {
  readonly key: number;
  readonly kind: VfxKind;
  readonly tone: VfxTone;
  readonly style: CSSProperties;
}

export function EffectsPreview(): ReactElement {
  const [prefs, setPrefs] = useState<SoundPrefs>(loadSoundPrefs);
  const [engine] = useState(() => new SoundEngine(prefs.enabled, prefs.volume));
  const stageRef = useRef<HTMLDivElement>(null);
  const [effects, setEffects] = useState<readonly PreviewEffect[]>([]);
  const nextKey = useRef(0);

  const playSound = useCallback(
    (cue: SoundCue): void => {
      void engine.resume(); // the click is the gesture that unlocks audio
      engine.play(cue, true); // force: audition even if game audio is muted
    },
    [engine],
  );

  const setEnabled = useCallback(
    (enabled: boolean): void => {
      setPrefs((prev) => {
        const next = { ...prev, enabled };
        saveSoundPrefs(next);
        return next;
      });
      engine.setEnabled(enabled);
    },
    [engine],
  );

  const setVolume = useCallback(
    (volume: number): void => {
      setPrefs((prev) => {
        const next = { ...prev, volume };
        saveSoundPrefs(next);
        return next;
      });
      engine.setVolume(volume);
    },
    [engine],
  );

  const playVfx = useCallback((kind: VfxKind, tone: VfxTone): void => {
    const lifetime = kind === 'flash' ? VFX_CONFIG.flashMs : kind === 'flare' ? VFX_CONFIG.flareMs : VFX_CONFIG.burstMs;
    // A flash fills the screen; a flare/burst lands at the stage centre.
    let style: CSSProperties = { animationDuration: `${lifetime}ms` };
    if (kind !== 'flash') {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect) style = { ...style, left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 };
    }
    const key = nextKey.current++;
    setEffects((cur) => [...cur, { key, kind, tone, style }]);
    window.setTimeout(() => setEffects((cur) => cur.filter((e) => e.key !== key)), lifetime + 80);
  }, []);

  return (
    <article className="about__card effects-preview">
      <h3 className="about__heading">Game effects (§3.130–§3.131)</h3>
      <p>
        Hear every sound and preview every visual effect. This is also the audio settings: the master
        controls below are the same on/off and volume the game uses, and they are remembered.
      </p>

      <div className="effects-preview__master">
        <label className="effects-preview__check">
          <input type="checkbox" checked={prefs.enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          Game sound
        </label>
        <label className="effects-preview__vol">
          Volume
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={prefs.volume}
            onChange={(e) => setVolume(Number(e.currentTarget.value))}
            aria-label="Master volume"
          />
          <span className="effects-preview__vol-num">{Math.round(prefs.volume * 100)}%</span>
        </label>
      </div>

      <h4 className="effects-preview__sub">Sounds</h4>
      <div className="effects-preview__grid">
        {ALL_SOUND_CUES.map((cue) => (
          <button key={cue} type="button" className="btn effects-preview__btn" onClick={() => playSound(cue)}>
            🔈 {SOUND_LABELS[cue]}
          </button>
        ))}
      </div>

      <h4 className="effects-preview__sub">Visual effects</h4>
      <div className="effects-preview__grid">
        {VFX_PREVIEWS.map((v) => (
          <button
            key={`${v.kind}:${v.tone}`}
            type="button"
            className="btn effects-preview__btn"
            onClick={() => playVfx(v.kind, v.tone)}
          >
            ✨ {v.label}
          </button>
        ))}
      </div>
      <div className="effects-preview__stage" ref={stageRef} aria-hidden="true">
        <span className="effects-preview__stage-label">effect stage</span>
      </div>

      {/*
        §3.143 — THE NEW SYSTEMS REGISTER HERE (CLAUDE.md rule 3: a system is not
        done until you can observe and drive it at runtime). Three benches, each
        mounting the REAL component rather than a mock: a bench that draws its
        own arcs can look right while the board looks wrong.
      */}
      <h4 className="effects-preview__sub">Tabletop (§3.143 UX-9 / UX-11)</h4>
      <SceneBench />

      <h4 className="effects-preview__sub">Combat arcs (§3.143 UX-14)</h4>
      <CombatArcBench />

      <h4 className="effects-preview__sub">Damage distribution (§3.143 UX-15)</h4>
      <DamageBench />

      {/* The live preview effects — real .vfx-* classes, same as the board. */}
      <div className="vfx-layer" aria-hidden="true">
        {effects.map((e) =>
          e.kind === 'flash' ? (
            <div key={e.key} className={`vfx-flash vfx-flash--${e.tone}`} style={e.style} />
          ) : e.kind === 'flare' ? (
            <div key={e.key} className={`vfx-flare vfx-flare--${e.tone}`} style={e.style} />
          ) : (
            <div key={e.key} className={`vfx-burst vfx-burst--${e.tone}`} style={e.style}>
              {burstParticleOffsets(VFX_CONFIG.burstParticles).map((p, i) => (
                <span
                  key={i}
                  className="vfx-burst__p"
                  style={
                    {
                      animationDuration: e.style.animationDuration,
                      ['--vfx-dx' as string]: `${p.dx}px`,
                      ['--vfx-dy' as string]: `${p.dy}px`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
          ),
        )}
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* §3.143 benches                                                              */
/* -------------------------------------------------------------------------- */

/**
 * THE TABLETOP, DRIVABLE (UX-9 / UX-11).
 *
 * The sliders write the same custom properties `PlayBoard` writes, onto the same
 * `.board-scene` / `.board-scene__table` / `.perm-slot` / `.perm-turn` classes
 * the board uses — so what is tuned here is what ships. The config values are
 * the STARTING points, shown as numbers beside each control: a designer finds
 * an angle by feel and then commits it to `BOARD_3D_CONFIG` /
 * `TAP_ROTATION_CONFIG` rather than to a stylesheet.
 */
function SceneBench(): ReactElement {
  const [tiltDeg, setTilt] = useState(BOARD_3D_CONFIG.tiltDeg);
  const [perspectivePx, setPerspective] = useState(BOARD_3D_CONFIG.perspectivePx);
  const [originY, setOriginY] = useState(BOARD_3D_CONFIG.perspectiveOriginYFraction);
  const [tapped, setTapped] = useState(false);

  const vars = {
    '--board-perspective-px': `${perspectivePx}px`,
    '--board-tilt-deg': `${tiltDeg}deg`,
    '--board-origin-x': `${BOARD_3D_CONFIG.perspectiveOriginXFraction * 100}%`,
    '--board-origin-y': `${originY * 100}%`,
    '--board-scene-ms': `${BOARD_3D_CONFIG.sceneTransitionMs}ms`,
    '--perm-turn-ms': `${TAP_ROTATION_CONFIG.turnMs}ms`,
    '--perm-tapped-opacity': String(TAP_ROTATION_CONFIG.tappedOpacity),
    '--perm-tapped-grayscale': String(TAP_ROTATION_CONFIG.tappedGrayscaleFraction),
    '--perm-footprint': tapped ? String(TAP_ROTATION_CONFIG.footprintRatio) : '1',
    '--perm-turn-deg': `${tapped ? TAP_ROTATION_CONFIG.tappedDeg : 0}deg`,
  } as CSSProperties;

  return (
    <div className="play-board effects-preview__scene" style={vars}>
      <div className="effects-preview__knobs">
        <label className="effects-preview__vol">
          Tilt
          <input
            type="range"
            min={0}
            max={20}
            step={1}
            value={tiltDeg}
            onChange={(e) => setTilt(Number(e.currentTarget.value))}
            aria-label="Tabletop tilt in degrees"
          />
          <span className="effects-preview__vol-num">
            {tiltDeg}° (ships {BOARD_3D_CONFIG.tiltDeg}°)
          </span>
        </label>
        <label className="effects-preview__vol">
          Perspective
          <input
            type="range"
            min={600}
            max={3000}
            step={50}
            value={perspectivePx}
            onChange={(e) => setPerspective(Number(e.currentTarget.value))}
            aria-label="Perspective distance in px"
          />
          <span className="effects-preview__vol-num">
            {perspectivePx}px (ships {BOARD_3D_CONFIG.perspectivePx}px)
          </span>
        </label>
        <label className="effects-preview__vol">
          Vanishing point
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={originY}
            onChange={(e) => setOriginY(Number(e.currentTarget.value))}
            aria-label="Perspective origin, fraction down the scene"
          />
          <span className="effects-preview__vol-num">
            {originY.toFixed(2)} (ships {BOARD_3D_CONFIG.perspectiveOriginYFraction})
          </span>
        </label>
        <label className="effects-preview__check">
          <input type="checkbox" checked={tapped} onChange={(e) => setTapped(e.currentTarget.checked)} />
          Tap the cards (UX-11: {TAP_ROTATION_CONFIG.tappedDeg}°, footprint ×
          {TAP_ROTATION_CONFIG.footprintRatio.toFixed(2)})
        </label>
      </div>
      <div className="board-scene">
        <div className="board-scene__table">
          {['Opponent', 'You'].map((side) => (
            <div key={side} className="effects-preview__row">
              <span className="effects-preview__row-label">{side}</span>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={`perm-slot${tapped ? ' perm-slot--tapped' : ''}`}>
                  <div className="perm-turn">
                    <div className={`perm${tapped ? ' perm--tapped' : ''}`}>
                      <div className="perm__art" />
                      <div className="perm__foot">
                        <span className="perm__name">card {i + 1}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * THE COMBAT ARCS, on a stage of their own (UX-14).
 *
 * Lane G's own fixture (`COMBAT_ARC_BENCH_ARCS`) driven through the REAL
 * `CombatLines`, so the arcs, the arrowheads, the ember flow and the
 * draft-vs-declared distinction are the ones the board draws. The stage's tile
 * ids are negative on purpose — `InstanceId` is a positive engine counter, so a
 * bench mounted beside a live board cannot collide with a real permanent.
 */
function CombatArcBench(): ReactElement {
  const stageRef = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState(0);
  const ids = COMBAT_ARC_BENCH_TILE_IDS;
  return (
    <div className="effects-preview__arcs" ref={stageRef}>
      <div className="effects-preview__row" data-anim-anchor="board:A">
        <div className="perm" data-perm-id={ids.defender} />
        <div className="perm" data-perm-id={ids.blocker} />
        <div className="perm" data-perm-id={ids.secondBlocker} />
      </div>
      <div className="effects-preview__row">
        <div className="perm" data-perm-id={ids.attacker} />
        <div className="perm" data-perm-id={ids.secondAttacker} />
      </div>
      <button type="button" className="btn effects-preview__btn" onClick={() => setNudge((n) => n + 1)}>
        ↻ Re-measure the arcs
      </button>
      <CombatLines lines={COMBAT_ARC_BENCH_ARCS} containerRef={stageRef} measureKey={nudge} />
    </div>
  );
}
