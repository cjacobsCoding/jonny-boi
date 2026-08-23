import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import {
  Annotation,
  DEFAULT_BUG_REPORT_CONFIG,
  assembleReportMarkdown,
  reportBundleName,
  type ReportSummary,
  type ReportTimestamp,
} from '../lib/bugreport/report.js';
import { CAPTURE_IGNORE_ATTR, captureViewport, dataUrlToBytes } from '../lib/bugreport/capture.js';
import { consoleRing, installConsoleRing } from '../lib/bugreport/console-ring.js';
import { collectStateDump } from '../lib/bugreport/state-dump.js';
import { buildLine } from '../lib/bugreport/build-info.js';
import { VoiceRecorder, blobToBytes } from '../lib/bugreport/voice.js';
import { buildZip, compressEntries, type ZipEntry } from '../lib/bugreport/zip.js';
import { CLIP_DEFAULTS, ClipRing } from '../lib/bugreport/clip-ring.js';
import { buildReplayHtml } from '../lib/bugreport/replay-html.js';
import './bug-reporter.css';

/**
 * THE IN-GAME BUG REPORTER, for the web.
 *
 * One key (`b`) or one tap on the ⛬ button, from ANY view: the screen freezes on
 * the frame you were looking at, you scribble on it, type and/or SPEAK what went
 * wrong, and Submit hands you `bugreport_<stamp>.zip` carrying the screenshot,
 * the annotated screenshot, the recent console/error ring, the full app state
 * dump and your voice note.
 *
 * WHY IT IS A GLOBAL OVERLAY AND NOT A VIEW. A view would have to be navigated
 * to, which loses the screen you are reporting about — and the whole value of
 * this tool, proven in the two C++ games it is ported from, is that it captures
 * the thing while it is still on screen. So it mounts once in the app shell,
 * above the router-ish view switch, and no view contains a line of code about
 * bug reporting.
 *
 * ONE HONEST DIFFERENCE FROM THE GAMES. They stop simulating the instant you
 * press the key; here the sim workers keep running behind the overlay, because
 * killing a gauntlet mid-run to file a report would destroy the very run you are
 * reporting on. The FRAME is frozen (it is a raster), which is what the drawing
 * and the screenshot need; the workers are not.
 */

/** The launcher's label. A phone has no `b` key, so the button is not optional. */
const LAUNCHER_LABEL = 'Report a bug';

/** Line width in the note box before the panel scrolls, and other panel numbers. */
const NOTE_ROWS = 5;
const RECORDING_TICK_MS = 200;
/** How much the clip control moves per press. */
const CLIP_STEP_SECONDS = 5;

type Phase = 'closed' | 'capturing' | 'open' | 'submitting';

function nowTimestamp(): ReportTimestamp {
  const d = new Date();
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
  };
}

/** True when the keyboard belongs to a text field, so the hotkey must not fire. */
function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

const encoder = new TextEncoder();
const textEntry = (name: string, body: string): ZipEntry => ({
  name,
  bytes: encoder.encode(body),
});

export interface BugReporterProps {
  /** What was on screen, for the report's `screen` line. */
  readonly screenName: string;
}

export function BugReporter({ screenName }: BugReporterProps): ReactElement {
  const config = DEFAULT_BUG_REPORT_CONFIG;
  const [phase, setPhase] = useState<Phase>('closed');
  const [shot, setShot] = useState<{ dataUrl: string; width: number; height: number; note: string } | null>(
    null,
  );
  const [note, setNote] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  // The annotation lives in a ref (it is mutated on every pointer move and must
  // not re-render the panel per point), so what the panel DISPLAYS about it is
  // mirrored into state. `strokeTick` drives the canvas redraw; `strokeCount`
  // is what the Undo button reads — reading the ref during render would not
  // re-render when it changed.
  const [strokeTick, setStrokeTick] = useState(0);
  const [strokeCount, setStrokeCount] = useState(0);
  const [status, setStatus] = useState('');
  const [discardArmed, setDiscardArmed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  // Whether a finished recording is being held. STATE, not a read of
  // pendingVoiceRef during render: a ref does not re-render, so the button kept
  // saying "Record voice" after a recording had been captured.
  const [hasVoice, setHasVoice] = useState(false);
  const [lastBundle, setLastBundle] = useState<{ name: string; url: string } | null>(null);
  /**
   * Seconds of session the report should carry. The games default this to 0
   * because their clip is video and encoding it is expensive; here the clip is a
   * recorded event stream costing a few tens of kilobytes, and the whole point
   * of it is seeing what led up to the bug — so it defaults ON.
   */
  const [clipSeconds, setClipSeconds] = useState<number>(CLIP_DEFAULTS.windowSeconds);

  const annotationRef = useRef(new Annotation());
  const clipRef = useRef(new ClipRing());
  /** rrweb's `record`, kept so the ring can be restarted after a report. */
  const recordFnRef = useRef<Parameters<ClipRing['start']>[0] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const voiceRef = useRef(new VoiceRecorder());
  const pendingVoiceRef = useRef<{ bytes: Uint8Array; seconds: number; transcript: string; note: string } | null>(
    null,
  );
  /**
   * Why the voice note is missing, when it is. SEPARATE from pendingVoiceRef,
   * which now only ever holds real audio: a denied microphone used to be stored
   * as an empty pending recording, and every "does this report have work in it?"
   * test then said yes — so Cancel demanded a confirmation for a report the
   * reporter had not put anything into.
   */
  const voiceNoteRef = useRef('');
  /**
   * Which capture attempt is current. A capture takes a second or two, and the
   * reporter can hit Escape inside that window; without this the resolved
   * capture would then re-open an overlay they had already dismissed.
   */
  const captureSeqRef = useRef(0);

  // The console ring records from the moment the app loads, not from the moment
  // the reporter opens — by then it has already missed the thing you opened it
  // for. Installing it here (rather than in main.tsx) keeps the whole tool in
  // one place; the installer is idempotent.
  useEffect(() => {
    installConsoleRing();
  }, []);

  // The rolling clip starts with the APP, not with the reporter: by the time
  // someone presses `b`, the seconds worth having have already happened. The
  // recorder is imported lazily so it is not in the critical path of the first
  // paint, and a failure to load costs the clip and nothing else (rule 6).
  useEffect(() => {
    let cancelled = false;
    const ring = clipRef.current;
    void import('rrweb')
      .then(({ record }) => {
        if (cancelled) return;
        recordFnRef.current = record as unknown as Parameters<ClipRing['start']>[0];
        ring.start(recordFnRef.current);
      })
      .catch(() => {
        // Swallowed on purpose: the report will say the clip is missing.
      });
    return () => {
      cancelled = true;
      ring.stop();
    };
  }, []);

  /** Record again after a report, from a fresh snapshot. */
  const restartClip = useCallback(() => {
    const record = recordFnRef.current;
    if (record === null) return;
    clipRef.current.stop();
    clipRef.current.clear();
    clipRef.current.start(record);
  }, []);

  /** Redraw the ink and refresh what the panel says about it. */
  const inkChanged = useCallback(() => {
    setStrokeTick((tick) => tick + 1);
    setStrokeCount(annotationRef.current.strokeCount);
  }, []);

  const open = useCallback(async () => {
    const attempt = captureSeqRef.current + 1;
    captureSeqRef.current = attempt;
    // FIRST, before anything is drawn on top: the clip must end at the moment
    // the key was pressed, and must not contain the overlay's own frozen frame
    // (a multi-megabyte data URL) as a DOM mutation.
    clipRef.current.stop();
    setPhase('capturing');
    setStatus('freezing the frame… (Esc to cancel)');
    annotationRef.current.clear();
    inkChanged();
    setNote('');
    setDiscardArmed(false);
    pendingVoiceRef.current = null;
    voiceNoteRef.current = '';
    setHasVoice(false);
    setRecordedSeconds(0);
    const captured = await captureViewport();
    // Cancelled, or superseded by a second open, while the rasteriser worked.
    if (captureSeqRef.current !== attempt) return;
    setShot(captured);
    setPhase('open');
    setStatus(captured.note ? 'the screenshot failed — see the note in the report' : '');
  }, [inkChanged]);

  const close = useCallback(() => {
    // Bump the sequence so a capture still in flight cannot re-open the overlay.
    captureSeqRef.current += 1;
    void voiceRef.current.stop();
    setRecording(false);
    setPhase('closed');
    setShot(null);
    setDiscardArmed(false);
    restartClip();
  }, [restartClip]);

  /**
   * Take whatever the recorder is holding — whether the reporter pressed Stop or
   * the safety valve fired on its own. ONE place, because the valve firing used
   * to leave the audio uncollected: the button went back to "Record voice" and
   * five minutes of the reporter's own words were gone without a word about it.
   */
  const harvestRecording = useCallback(async (): Promise<void> => {
    const result = await voiceRef.current.stop();
    setRecording(false);
    if (result.blob !== null) {
      pendingVoiceRef.current = {
        bytes: await blobToBytes(result.blob),
        seconds: result.seconds,
        transcript: result.transcript,
        note: result.note,
      };
      voiceNoteRef.current = result.note;
      setHasVoice(true);
      setRecordedSeconds(result.seconds);
      setStatus(
        `${result.seconds.toFixed(1)} s of voice held${result.transcript ? ' + transcript' : ''}`,
      );
      return;
    }
    voiceNoteRef.current = result.note;
    if (result.note) setStatus(result.note);
  }, []);

  // The hotkey. Suppressed while a text field has the keyboard, so typing the
  // letter b in the note box cannot close the report — the same rule the two
  // games apply, and the one that makes a single-letter hotkey safe at all.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A modified key is never the single-letter hotkey (Ctrl+B is a browser
      // shortcut), but Ctrl+Z IS ours once the overlay is open — so the guard
      // covers only the hotkey branch below, not the whole handler.
      if (phase === 'closed') {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key.toLowerCase() === config.hotkey.toLowerCase() && !typingInField(event.target)) {
          event.preventDefault();
          void open();
        }
        return;
      }
      if (event.altKey) return;
      // Escape during the capture aborts it. The rasteriser can take a second or
      // two on a heavy view, and being unable to back out of a tool you opened by
      // mistake is the kind of thing that stops people opening it at all.
      if (event.key === 'Escape' && phase === 'capturing') {
        event.preventDefault();
        close();
        setStatus('');
        return;
      }
      // Ctrl/Cmd+Z undoes the last stroke, because a drawing surface that does
      // not is a drawing surface people are careful on instead of quick on.
      if (phase === 'open' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (annotationRef.current.undo()) inkChanged();
        return;
      }
      if (event.key === 'Escape' && phase === 'open') {
        event.preventDefault();
        // Losing a drawing and a spoken note to a stray keypress would be worse
        // than an extra keystroke, so a report with content arms first.
        const hasWork = note.length > 0 || !annotationRef.current.empty || hasVoice;
        if (!hasWork || discardArmed) {
          close();
        } else {
          setDiscardArmed(true);
          setStatus('press Escape again to DISCARD this report');
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, open, close, config.hotkey, note, discardArmed, inkChanged, hasVoice]);

  // Live seconds readout while recording.
  useEffect(() => {
    if (!recording) return undefined;
    const timer = window.setInterval(() => {
      if (!voiceRef.current.recording) {
        // The safety valve stopped it. Collect, rather than just flipping the
        // button back and leaving the audio behind.
        void harvestRecording();
        return;
      }
      setRecordedSeconds(voiceRef.current.elapsedSeconds());
    }, RECORDING_TICK_MS);
    return () => window.clearInterval(timer);
  }, [recording, harvestRecording]);

  // Redraw the annotation whenever it changes or the frame is (re)captured.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || shot === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of annotationRef.current.strokes) {
      const entry = config.palette[Math.min(stroke.paletteIndex, config.palette.length - 1)];
      ctx.strokeStyle = entry?.color ?? '#e83030';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = stroke.widthPx;
      if (stroke.points.length === 1) {
        // A dot IS a valid annotation — it is how you point at one card.
        const p = stroke.points[0]!;
        ctx.beginPath();
        ctx.arc(p.x, p.y, stroke.widthPx / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      stroke.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }
  }, [strokeTick, shot, config.palette]);

  // Pointer -> IMAGE coordinates. The canvas is laid out to fit the window, so a
  // resize (or a phone rotation) between capture and drawing changes the on-screen
  // size but not the image: mapping through the live bounding rect keeps a stroke
  // under the finger either way.
  const toImagePoint = (event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width === 0 ? 1 : canvas.width / rect.width;
    const scaleY = rect.height === 0 ? 1 : canvas.height / rect.height;
    return {
      x: Math.round((event.clientX - rect.left) * scaleX),
      y: Math.round((event.clientY - rect.top) * scaleY),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = toImagePoint(event);
    annotationRef.current.beginStroke(p.x, p.y, paletteIndex, config.strokeWidthPx);
    inkChanged();
    setDiscardArmed(false);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!annotationRef.current.drawing) return;
    const p = toImagePoint(event);
    annotationRef.current.extendStroke(p.x, p.y);
    inkChanged();
  };

  const onPointerUp = (): void => {
    annotationRef.current.endStroke();
    inkChanged();
  };

  const toggleRecording = async (): Promise<void> => {
    if (recording) {
      await harvestRecording();
      return;
    }
    const error = await voiceRef.current.start(config.audioMaxSeconds);
    if (error !== null) {
      // The REASON is kept (it belongs in the report), but it is not stored as a
      // pending recording — a denied microphone is not work the reporter would
      // be sad to lose, and treating it as such made Cancel ask twice for
      // nothing.
      setStatus(error);
      voiceNoteRef.current = error;
      return;
    }
    setRecording(true);
    setStatus('recording — say what went wrong');
  };

  /** Burn the annotation into a copy of the frame, exactly as drawn. */
  const renderAnnotated = (): string => {
    if (shot === null || shot.dataUrl === '' || annotationRef.current.empty) return '';
    const source = canvasRef.current;
    if (source === null) return '';
    const composite = document.createElement('canvas');
    composite.width = shot.width;
    composite.height = shot.height;
    const ctx = composite.getContext('2d');
    if (ctx === null) return '';
    const base = document.querySelector<HTMLImageElement>('.bugreport__frame');
    if (base !== null) ctx.drawImage(base, 0, 0, shot.width, shot.height);
    ctx.drawImage(source, 0, 0);
    return composite.toDataURL('image/png');
  };

  const submit = async (): Promise<void> => {
    if (shot === null) return;
    setPhase('submitting');
    setStatus('writing the report…');

    // Stop a live recording first: a report must never ship a half-written clip.
    if (recording || voiceRef.current.recording) await harvestRecording();

    const timestamp = nowTimestamp();
    const bundleName = reportBundleName(timestamp, config.bundlePrefix);
    const ring = consoleRing();
    const voice = pendingVoiceRef.current;
    const entries: ZipEntry[] = [];
    const attachments: string[] = [];

    if (shot.dataUrl !== '') {
      entries.push({ name: 'screenshot.png', bytes: dataUrlToBytes(shot.dataUrl) });
      attachments.push('screenshot.png');
    }
    const annotated = renderAnnotated();
    if (annotated !== '') {
      entries.push({ name: 'annotated.png', bytes: dataUrlToBytes(annotated) });
      attachments.push('annotated.png');
    }
    // THE CLIP. Assembled before the state dump so its outcome can be reported.
    const clipEvents = clipRef.current.eventsForWindow(clipSeconds, Date.now());
    let clipNote = clipRef.current.status;
    let clipSpanSeconds = 0;
    if (clipEvents.length >= 2) {
      const firstMs = clipEvents[0]?.timestamp ?? 0;
      const lastMs = clipEvents[clipEvents.length - 1]?.timestamp ?? 0;
      clipSpanSeconds = Math.max(0, (lastMs - firstMs) / 1000);
      const eventsJson = JSON.stringify(clipEvents);
      entries.push(textEntry('clip.json', eventsJson));
      attachments.push('clip.json');
      try {
        // The player is fetched only when a report is actually filed, so its
        // half-megabyte never lands in the app's own startup bundle.
        const [playerJs, playerCss] = await Promise.all([
          import('virtual:replay-player-js').then((m) => m.default),
          import('virtual:replay-player-css').then((m) => m.default),
        ]);
        entries.push(
          textEntry(
            'replay.html',
            buildReplayHtml({
              playerJs,
              playerCss,
              eventsJson,
              title: `${bundleName} — replay`,
              subtitle: `${screenName} — the ${clipSpanSeconds.toFixed(1)} s before the report was filed`,
            }),
          ),
        );
        attachments.push('replay.html');
      } catch (error) {
        // clip.json is already in the bundle, so the recording survives even
        // when the player does not — that is the whole reason both ship.
        clipNote = `the replay player could not be bundled (${String(error)}); clip.json holds the events`;
      }
    } else if (!clipNote) {
      clipNote = clipSeconds <= 0 ? 'the clip was dialled to 0 s' : 'nothing was recorded to replay';
    }

    entries.push(textEntry('state_dump.txt', collectStateDump()));
    attachments.push('state_dump.txt');
    entries.push(textEntry('console.txt', `${ring.format()}\n`));
    attachments.push('console.txt');
    // THE AUDIO IS WRITTEN AND NEVER DROPPED: a missing or wrong transcript must
    // cost the convenience, never the reporter's own words.
    if (voice && voice.bytes.length > 0) {
      entries.push({ name: 'voice.webm', bytes: voice.bytes });
      attachments.push('voice.webm');
      if (voice.transcript) {
        entries.push(textEntry('transcript.txt', `${voice.transcript}\n`));
        attachments.push('transcript.txt');
      }
    }

    const summary: ReportSummary = {
      timestamp,
      typedText: note,
      transcript: voice?.transcript ?? '',
      transcriptNote: voice?.note || voiceNoteRef.current,
      screenName,
      buildCommit: buildLine(),
      attachments: [...attachments, 'report.md'],
      clipSeconds: clipSpanSeconds,
      clipEvents: clipEvents.length,
      clipNote,
      audioRecorded: (voice?.bytes.length ?? 0) > 0,
      audioSeconds: voice?.seconds ?? 0,
      annotationStrokes: annotationRef.current.strokeCount,
      consoleLines: ring.size,
      errorLines: ring.countOf('error'),
      screenshotNote: shot.note,
    };
    // report.md last, so its file list is complete.
    entries.push(textEntry('report.md', assembleReportMarkdown(summary)));

    // Squeeze the text entries first. The clip's full DOM snapshot is megabytes
    // of JSON; stored raw it made a 15 MB report, which is one a phone will not
    // upload. Images are left alone — see shouldCompress.
    const zip = buildZip(await compressEntries(entries), timestamp);
    // `zip.buffer` is typed as ArrayBufferLike (it could in principle be a
    // SharedArrayBuffer), which BlobPart will not accept — so hand Blob the
    // exact byte range instead of the view.
    const url = URL.createObjectURL(
      new Blob([zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer], {
        type: 'application/zip',
      }),
    );
    const fileName = `${bundleName}.zip`;

    // Hand it over. The anchor click is what a phone turns into a normal
    // download; the link is kept on screen afterwards because a blocked or
    // missed download must not lose a report that has already been written.
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();

    if (lastBundle !== null) URL.revokeObjectURL(lastBundle.url);
    setLastBundle({ name: fileName, url });
    setPhase('closed');
    setShot(null);
    setStatus(`wrote ${fileName}`);
    restartClip();
    // The console ring IS the log, so a filed report belongs in it — the next
    // report then carries the record of the previous one.
    console.info(`[bugreport] wrote ${fileName} (${zip.length} bytes, ${entries.length} entries)`);
  };

  const paletteSwatches = useMemo(() => config.palette, [config.palette]);

  if (phase === 'closed') {
    return (
      <>
        <button
          type="button"
          className="bugreport-launcher"
          onClick={() => void open()}
          title={`${LAUNCHER_LABEL} (press ${config.hotkey.toUpperCase()})`}
          aria-label={LAUNCHER_LABEL}
          {...{ [CAPTURE_IGNORE_ATTR]: 'true' }}
        >
          ⛬
        </button>
        {lastBundle !== null && (
          <a
            className="bugreport-lastlink"
            href={lastBundle.url}
            download={lastBundle.name}
            {...{ [CAPTURE_IGNORE_ATTR]: 'true' }}
          >
            ⤓ {lastBundle.name}
          </a>
        )}
      </>
    );
  }

  return (
    <div className="bugreport" role="dialog" aria-label="Bug report" {...{ [CAPTURE_IGNORE_ATTR]: 'true' }}>
      <div className="bugreport__stage">
        {/*
          The frame and the ink canvas MUST share one box, and that box must have
          the captured frame's aspect ratio. Letting each fit itself inside the
          stage with `object-fit: contain` looked identical and was wrong: the
          canvas ELEMENT then filled the stage while its BITMAP was letterboxed
          inside it, so mapping a pointer through the element's rect scaled every
          stroke and offset it. An aspect-ratio wrapper makes the mapping a
          straight uniform scale.
        */}
        <div
          className="bugreport__framebox"
          style={shot !== null ? { aspectRatio: `${shot.width} / ${shot.height}` } : undefined}
        >
          {shot !== null && shot.dataUrl !== '' ? (
            <img className="bugreport__frame" src={shot.dataUrl} alt="The frozen screen" />
          ) : (
            <div className="bugreport__frame bugreport__frame--missing">
              {phase === 'capturing' ? 'freezing the frame…' : 'the screen could not be captured'}
            </div>
          )}
          {shot !== null && (
            <canvas
              ref={canvasRef}
              className="bugreport__ink"
              width={shot.width}
              height={shot.height}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          )}
        </div>
      </div>

      <div className="bugreport__panel">
        <div className="bugreport__title">BUG REPORT</div>
        <label className="bugreport__label" htmlFor="bugreport-note">
          What went wrong?
        </label>
        <textarea
          id="bugreport-note"
          className="bugreport__note"
          rows={NOTE_ROWS}
          value={note}
          placeholder="Type here — drag on the screen to draw"
          onChange={(event) => {
            setNote(event.target.value);
            setDiscardArmed(false);
          }}
          autoFocus
        />

        <div className="bugreport__palette">
          {paletteSwatches.map((entry, index) => (
            <button
              key={entry.name}
              type="button"
              className={`bugreport__swatch${index === paletteIndex ? ' bugreport__swatch--on' : ''}`}
              style={{ background: entry.color }}
              onClick={() => setPaletteIndex(index)}
              aria-label={entry.name}
              aria-pressed={index === paletteIndex}
            />
          ))}
        </div>

        <div className="bugreport__row">
          <button
            type="button"
            className="bugreport__btn"
            disabled={strokeCount === 0}
            onClick={() => {
              annotationRef.current.undo();
              inkChanged();
            }}
          >
            Undo ({strokeCount})
          </button>
          <button
            type="button"
            className="bugreport__btn"
            disabled={strokeCount === 0}
            onClick={() => {
              annotationRef.current.clear();
              inkChanged();
            }}
          >
            Clear drawing
          </button>
        </div>

        <button
          type="button"
          className={`bugreport__btn${recording ? ' bugreport__btn--recording' : ''}`}
          onClick={() => void toggleRecording()}
        >
          {recording
            ? `■ Stop recording (${recordedSeconds.toFixed(1)} s)`
            : hasVoice
              ? `● Re-record (${recordedSeconds.toFixed(1)} s held)`
              : '● Record voice'}
        </button>

        <div className="bugreport__row bugreport__row--clip">
          <button
            type="button"
            className="bugreport__btn bugreport__btn--step"
            onClick={() => setClipSeconds((v) => Math.max(0, v - CLIP_STEP_SECONDS))}
            disabled={clipSeconds <= 0}
            aria-label="Less clip"
          >
            −
          </button>
          <span className="bugreport__clip">
            {clipSeconds <= 0
              ? 'no clip'
              : `clip: last ${clipSeconds} s`}
          </span>
          <button
            type="button"
            className="bugreport__btn bugreport__btn--step"
            onClick={() =>
              setClipSeconds((v) => Math.min(CLIP_DEFAULTS.windowSeconds, v + CLIP_STEP_SECONDS))
            }
            disabled={clipSeconds >= CLIP_DEFAULTS.windowSeconds}
            aria-label="More clip"
          >
            +
          </button>
        </div>

        <div className="bugreport__row">
          <button
            type="button"
            className="bugreport__btn bugreport__btn--primary"
            disabled={phase !== 'open'}
            onClick={() => void submit()}
          >
            SUBMIT
          </button>
          <button
            type="button"
            className="bugreport__btn"
            onClick={() => {
              const hasWork = note.length > 0 || strokeCount > 0 || hasVoice;
              if (!hasWork || discardArmed) {
                close();
              } else {
                setDiscardArmed(true);
                setStatus('press Cancel again to DISCARD this report');
              }
            }}
          >
            {discardArmed ? 'DISCARD — sure?' : 'Cancel'}
          </button>
        </div>

        <div className={`bugreport__status${discardArmed ? ' bugreport__status--warn' : ''}`}>
          {status || `console ring: ${consoleRing().size} line(s)`}
        </div>
      </div>
    </div>
  );
}
