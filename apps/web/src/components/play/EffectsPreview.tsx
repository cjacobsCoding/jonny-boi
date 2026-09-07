import { useCallback, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { ALL_SOUND_CUES, type SoundCue } from '../../lib/play/sound-cues.js';
import { SoundEngine } from '../../lib/play/sound-engine.js';
import { loadSoundPrefs, saveSoundPrefs, type SoundPrefs } from '../../lib/play/sound-prefs.js';
import { burstParticleOffsets, type VfxKind, type VfxTone } from '../../lib/play/vfx-cues.js';
import { VFX_CONFIG } from '../../lib/play/play-config.js';
import './game-fx.css';
import './effects-preview.css';

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
