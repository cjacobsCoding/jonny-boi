import { useCallback, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import { ALL_SOUND_CUES, type SoundCue } from '../../lib/play/sound-cues.js';
import { SoundEngine } from '../../lib/play/sound-engine.js';
import { loadSoundPrefs, saveSoundPrefs, type SoundPrefs } from '../../lib/play/sound-prefs.js';
import { burstParticleOffsets, type VfxKind, type VfxTone } from '../../lib/play/vfx-cues.js';
import {
  BOARD_3D_CONFIG,
  SPELL_HOLD_CONFIG,
  STACK_PANEL_CONFIG,
  TAP_ROTATION_CONFIG,
  VFX_CONFIG,
} from '../../lib/play/play-config.js';
import { DamageBench } from './AnimationLayer.js';
import { CombatLines } from './CombatLines.js';
import { COMBAT_ARC_BENCH_ARCS, COMBAT_ARC_BENCH_TILE_IDS } from '../../lib/play/combat-lines.js';
import { CardHover } from '../CardHover.js';
import { CardFace } from './CardFace.js';
import { StackPanel } from './StackPanel.js';
import { getCardByName } from '../../lib/cards.js';
import { CARD_FACE_BENCH_SAMPLES } from '../../lib/play/provenance-view.js';
import {
  DEFAULT_STACK_PLACEMENT,
  STACK_ENTRY_KINDS,
  STACK_PLACEMENTS,
  STACK_PLACEMENT_TABLE,
  type StackEntry,
  type StackEntryKind,
  type StackPlacement,
} from '../../lib/play/stack-view.js';
import {
  extendPressure,
  holdDurationMs,
  HOLD_KINDS,
  HOLD_REFUSALS,
  NO_HOLD_PRESSURE,
  pointerPressure,
  spellHoldDecision,
  type HoldPressure,
  type SpellHoldContext,
} from '../../lib/play/spell-hold.js';
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
        done until you can observe and drive it at runtime). Each bench mounts the
        REAL component rather than a mock: a bench that draws its own arcs can look
        right while the board looks wrong.

        ⚠️ Wave 1 shipped only the first three and the audit found the reason it
        mattered — lane P's `CARD_FACE_BENCH_SAMPLES` was exported, tested and
        imported by NOTHING, so the aftermarket treatments existed and reached no
        screen. `effects-bench-adoption.test.ts` now fails if a `*_BENCH_*` fixture
        in `lib/play` is mounted nowhere, which is the class, not the instance.
      */}
      <h4 className="effects-preview__sub">Tabletop (§3.143 UX-9 / UX-11)</h4>
      <SceneBench />

      <h4 className="effects-preview__sub">Combat arcs (§3.143 UX-14)</h4>
      <CombatArcBench />

      <h4 className="effects-preview__sub">Damage distribution (§3.143 UX-15)</h4>
      <DamageBench />

      <h4 className="effects-preview__sub">The stack (§3.143 UX-1 / UX-2)</h4>
      <StackBench />

      <h4 className="effects-preview__sub">Opponent spell hold (§3.143 UX-16)</h4>
      <SpellHoldBench />

      <h4 className="effects-preview__sub">Aftermarket card faces (§3.143 UX-17)</h4>
      <CardFaceBench />

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

/**
 * THE STACK, DRIVABLE (UX-1 / UX-2).
 *
 * The REAL {@link StackPanel}, fed the REAL `StackEntry` shape both board
 * adapters produce — so the fan geometry, the top-of-stack lift, the condense
 * threshold and the target arrows auditioned here are the ones a game draws. The
 * two knobs are the two decisions the panel cannot make for itself:
 *
 *  - **Depth**, because `STACK_PANEL_CONFIG.maxVisibleEntries` is a threshold you
 *    can only judge by crossing it, and a five-deep stack is rare enough in play
 *    that nobody would otherwise see the condensed form until a player did.
 *  - **Placement**, because `STACK_PLACEMENT_TABLE` is a CLOSED table whose
 *    `column` row states, in its own `why`, that it does NOT satisfy UX-2. Being
 *    able to flip to `floating` here is how that claim gets checked by eye
 *    before it is made the default on the real board.
 */
function StackBench(): ReactElement {
  const [depth, setDepth] = useState(STACK_BENCH_ROWS.length);
  const [placement, setPlacement] = useState<StackPlacement>(DEFAULT_STACK_PLACEMENT);
  const shown = STACK_BENCH_ROWS.slice(0, depth);

  return (
    <div className="effects-preview__arcs">
      <div className="effects-preview__knobs">
        <label className="effects-preview__vol">
          Depth
          <input
            type="range"
            min={1}
            max={STACK_BENCH_ROWS.length}
            step={1}
            value={depth}
            onChange={(e) => setDepth(Number(e.currentTarget.value))}
            aria-label="How many objects are on the stack"
          />
          <span className="effects-preview__vol-num">
            {depth} (condenses past {STACK_PANEL_CONFIG.maxVisibleEntries})
          </span>
        </label>
        {STACK_PLACEMENTS.map((option) => (
          <label
            key={option}
            className="effects-preview__check"
            title={STACK_PLACEMENT_TABLE[option].why}
          >
            <input
              type="radio"
              name="stack-bench-placement"
              checked={placement === option}
              onChange={() => setPlacement(option)}
            />
            {option}
          </label>
        ))}
      </div>
      <StackPanel
        stack={shown.map(stackEntryOf)}
        names={STACK_BENCH_SEAT_NAMES}
        nameOf={stackBenchNameOf}
        faceOf={stackBenchFaceOf}
        viewer={STACK_BENCH_VIEWER}
        placement={placement}
      />
    </div>
  );
}

/**
 * THE OPPONENT-SPELL HOLD, DRIVABLE (UX-16).
 *
 * `spell-hold.ts` says in its own header that "the debug bench renders the
 * reason" — this is that bench. Every control below writes one field of the REAL
 * {@link SpellHoldContext} and the verdict is the REAL `spellHoldDecision`, so
 * the six refusals are auditioned as sentences a player would read rather than
 * inferred from a table nobody has seen fire. The duration underneath is the
 * REAL `holdDurationMs` over the REAL pressure reducers, which is the only way
 * to see that a pointer SWAPS the base duration for the bounded one rather than
 * adding to it.
 *
 * ⚠️ IT DOES NOT REDRAW THE ANNOUNCE CARD'S CHROME. `SpellHoldCard` is a private
 * function inside `PlayBoard.tsx`, which this lane does not own — and importing
 * it would pull the whole play board into the About page's chunk to show one
 * card. Re-typing its markup here would be the second renderer §2.4 of the spec
 * forbids, so the bench mounts the parts that ARE shared — `CardHover` +
 * `CardFace`, the one hover funnel and the one card renderer the announce card
 * is itself built from — and extracting `SpellHoldCard` into its own module is
 * reported as a contract instead.
 */
function SpellHoldBench(): ReactElement {
  const [kind, setKind] = useState<StackEntryKind>('spell');
  const [yours, setYours] = useState(false);
  const [viewerWillStop, setViewerWillStop] = useState(false);
  const [alreadySeen, setAlreadySeen] = useState(false);
  const [holdsThisTurn, setHoldsThisTurn] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [pressure, setPressure] = useState<HoldPressure>(NO_HOLD_PRESSURE);

  const context: SpellHoldContext = {
    viewer: STACK_BENCH_VIEWER,
    stackTop: { instanceId: HOLD_BENCH_OBJECT_ID, controller: yours ? 'A' : 'B', kind },
    viewerWillStop,
    announced: alreadySeen ? new Set([HOLD_BENCH_OBJECT_ID]) : EMPTY_ANNOUNCED,
    holdsThisTurn,
    gameOver,
  };
  const decision = spellHoldDecision(context, SPELL_HOLD_CONFIG);
  const heldCard = getCardByName(HOLD_BENCH_CARD_NAME);

  return (
    <div className="effects-preview__arcs">
      <div className="effects-preview__knobs">
        {STACK_ENTRY_KINDS.map((option) => (
          <label key={option} className="effects-preview__check" title={HOLD_KINDS[option].why}>
            <input
              type="radio"
              name="hold-bench-kind"
              checked={kind === option}
              onChange={() => setKind(option)}
            />
            {option} ({HOLD_KINDS[option].holds ? HOLD_KINDS[option].announce : 'never held'})
          </label>
        ))}
        <label className="effects-preview__check" title={HOLD_REFUSALS.yourOwnObject}>
          <input
            type="checkbox"
            checked={yours}
            onChange={(e) => setYours(e.currentTarget.checked)}
          />
          it is yours
        </label>
        <label className="effects-preview__check" title={HOLD_REFUSALS.alreadyStopping}>
          <input
            type="checkbox"
            checked={viewerWillStop}
            onChange={(e) => setViewerWillStop(e.currentTarget.checked)}
          />
          you get priority anyway
        </label>
        <label className="effects-preview__check" title={HOLD_REFUSALS.alreadyAnnounced}>
          <input
            type="checkbox"
            checked={alreadySeen}
            onChange={(e) => setAlreadySeen(e.currentTarget.checked)}
          />
          already shown once
        </label>
        <label className="effects-preview__check" title={HOLD_REFUSALS.gameOver}>
          <input
            type="checkbox"
            checked={gameOver}
            onChange={(e) => setGameOver(e.currentTarget.checked)}
          />
          game over
        </label>
        <label className="effects-preview__vol" title={HOLD_REFUSALS.turnBudgetSpent}>
          Holds spent
          <input
            type="range"
            min={0}
            max={SPELL_HOLD_CONFIG.maxHoldsPerTurn}
            step={1}
            value={holdsThisTurn}
            onChange={(e) => setHoldsThisTurn(Number(e.currentTarget.value))}
            aria-label="Holds already spent this turn"
          />
          <span className="effects-preview__vol-num">
            {holdsThisTurn} / {SPELL_HOLD_CONFIG.maxHoldsPerTurn}
          </span>
        </label>
      </div>

      <p>
        {decision.kind === 'hold'
          ? `HOLD — ${STACK_BENCH_SEAT_NAMES[decision.hold.controller]} ${HOLD_KINDS[decision.hold.kind].announce}.`
          : `NO HOLD (${decision.reason}) — ${decision.detail}`}
      </p>

      <div className="effects-preview__knobs">
        <button
          type="button"
          className="btn effects-preview__btn"
          onClick={() => setPressure((p) => pointerPressure(p, !p.pointerOver))}
        >
          {pressure.pointerOver ? 'Pointer is ON the card' : 'Pointer is elsewhere'}
        </button>
        <button
          type="button"
          className="btn effects-preview__btn"
          onClick={() => setPressure(extendPressure)}
        >
          Keep looking (+{SPELL_HOLD_CONFIG.extendMs}ms) x{pressure.extensions}
        </button>
        <button
          type="button"
          className="btn effects-preview__btn"
          onClick={() => setPressure(NO_HOLD_PRESSURE)}
        >
          Fresh hold
        </button>
        <span className="effects-preview__vol-num">
          {holdDurationMs(pressure, SPELL_HOLD_CONFIG)}ms
        </span>
      </div>

      {/* The inspectable card, through the app's ONE hover funnel and ONE card
          renderer — the same two the announce card is built from. */}
      <div className="effects-preview__grid">
        <CardHover cardId={heldCard?.id ?? null} name={HOLD_BENCH_CARD_NAME}>
          <CardFace size="full" cardId={heldCard?.id ?? null} name={HOLD_BENCH_CARD_NAME} />
        </CardHover>
      </div>
    </div>
  );
}

/**
 * AFTERMARKET CARD FACES, DRIVABLE (UX-17).
 *
 * Lane P built {@link CARD_FACE_BENCH_SAMPLES} — one row per treatment the face
 * can wear, each carrying a sentence saying what a viewer should SEE — and
 * nothing imported it, so the whole provenance presentation reached no screen.
 * This mounts the REAL `CardFace` on the REAL samples, inside the REAL
 * `CardHover`, which is the funnel a player actually opens a card with.
 *
 * ⚠️ A sample's `oracleText` is NOT shown, and that is a gap rather than a
 * choice: `CardFaceProps` has no `oracleText` — the component reads it from
 * `getCard(cardId)`, and a synthetic sample has no pool card. The granted and
 * struck-through lines still render (they come from the contributions), but the
 * PRINTED lines they are meant to sit beside do not. One added prop closes it;
 * it is reported as a contract rather than reached across a lane boundary.
 */
function CardFaceBench(): ReactElement {
  return (
    <div className="effects-preview__grid">
      {CARD_FACE_BENCH_SAMPLES.map((sample) => (
        <div key={sample.id}>
          <CardHover explanation={sample.input.explanation}>
            <CardFace
              size="full"
              explanation={sample.input.explanation}
              {...(sample.input.isCreature !== undefined
                ? { isCreature: sample.input.isCreature }
                : {})}
              {...(sample.input.name !== undefined ? { name: sample.input.name } : {})}
              {...(sample.input.cardId !== undefined ? { cardId: sample.input.cardId } : {})}
              {...(sample.input.unavailableReason !== undefined
                ? { unavailableReason: sample.input.unavailableReason }
                : {})}
            />
          </CardHover>
          <span className="effects-preview__stage-label">{sample.label}</span>
          <p>{sample.expect}</p>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* §3.143 bench fixtures                                                       */
/* -------------------------------------------------------------------------- */

/** Whose screen the three §3.143 benches above are drawn for. */
const STACK_BENCH_VIEWER: PlayerId = 'A';

/** The seat names the benches caption objects with. */
const STACK_BENCH_SEAT_NAMES: Readonly<Record<PlayerId, string>> = Object.freeze({
  A: 'You',
  B: 'Opponent',
});

/**
 * One stack object for the bench, as a ROW.
 *
 * Faces are named by their PRINTED NAME and resolved through `lib/cards.ts` —
 * the app's one card-data funnel — rather than by a pasted Scryfall id, because
 * an id in a fixture is a magic number nobody can check and that rots silently
 * when the pool is rebuilt. A name that no longer resolves degrades to `null`,
 * which is the panel's documented "no face" path (a named plate), not a broken
 * image.
 */
interface StackBenchRow {
  readonly instanceId: InstanceId;
  readonly kind: StackEntryKind;
  /** A spell's card name; an ability's printed text. */
  readonly name: string;
  readonly controller: PlayerId;
  /** The printed card whose art this object shows, or `null` for none. */
  readonly faceName: string | null;
  /** For an ability: the permanent that produced it. */
  readonly sourceName: string | null;
  readonly targets: readonly (InstanceId | PlayerId)[];
}

/**
 * Bench instance ids are NEGATIVE on purpose — `InstanceId` is a positive engine
 * counter, so a bench mounted beside a live board cannot collide with a real
 * object. Same convention, and same reason, as `COMBAT_ARC_BENCH_TILE_IDS`.
 */
const STACK_BENCH_TARGET_ID: InstanceId = -201;
const HOLD_BENCH_OBJECT_ID: InstanceId = -210;

/** The card the hold bench shows. A one-line instant is the reported case. */
const HOLD_BENCH_CARD_NAME = 'Lightning Bolt';

/** Shared empty set, so re-rendering the hold bench allocates nothing extra. */
const EMPTY_ANNOUNCED: ReadonlySet<InstanceId> = new Set<InstanceId>();

/**
 * The bench stack, TOP-FIRST (index 0 resolves next) — the order `stackEntries`
 * produces and the order `StackPanel` requires.
 *
 * Deliberately longer than `STACK_PANEL_CONFIG.maxVisibleEntries` so the depth
 * slider can cross the condense threshold, and deliberately mixed: an
 * opponent's spell aimed at the viewer, the viewer's own answer aimed at it, an
 * activated ability with a source permanent, and a trigger with NO face — the
 * four shapes whose captions and fallbacks differ.
 */
const STACK_BENCH_ROWS: readonly StackBenchRow[] = Object.freeze([
  {
    instanceId: -101,
    kind: 'spell',
    name: 'Counterspell',
    controller: 'A',
    faceName: 'Counterspell',
    sourceName: null,
    targets: [STACK_BENCH_TARGET_ID],
  },
  {
    instanceId: STACK_BENCH_TARGET_ID,
    kind: 'spell',
    name: 'Lightning Bolt',
    controller: 'B',
    faceName: 'Lightning Bolt',
    sourceName: null,
    targets: ['A'],
  },
  {
    instanceId: -102,
    kind: 'activated',
    name: '{T}: Add {G}.',
    controller: 'A',
    faceName: 'Llanowar Elves',
    sourceName: 'Llanowar Elves',
    targets: [],
  },
  {
    instanceId: -103,
    kind: 'trigger',
    name: 'When this creature enters, draw a card.',
    controller: 'B',
    faceName: null,
    sourceName: null,
    targets: [],
  },
  {
    instanceId: -104,
    kind: 'spell',
    name: 'Giant Growth',
    controller: 'B',
    faceName: 'Giant Growth',
    sourceName: null,
    targets: [],
  },
  {
    instanceId: -105,
    kind: 'spell',
    name: 'Divination',
    controller: 'A',
    faceName: 'Divination',
    sourceName: null,
    targets: [],
  },
]);

/** A bench row as the `StackEntry` both board adapters hand the panel. */
function stackEntryOf(row: StackBenchRow): StackEntry {
  return {
    instanceId: row.instanceId,
    kind: row.kind,
    name: row.name,
    controller: row.controller,
    targets: row.targets,
    faceCardId: stackBenchFaceOf(row.instanceId),
    sourceName: row.sourceName,
  };
}

/** TOTAL, exactly as the session's own `nameOf` is: an unknown id reads as `#id`. */
function stackBenchNameOf(id: InstanceId): string {
  return STACK_BENCH_ROWS.find((row) => row.instanceId === id)?.name ?? `#${id}`;
}

/** PARTIAL by nature: `null` means "no face", never "guess one". */
function stackBenchFaceOf(id: InstanceId): string | null {
  const name = STACK_BENCH_ROWS.find((row) => row.instanceId === id)?.faceName;
  if (name === undefined || name === null) return null;
  return getCardByName(name)?.id ?? null;
}
