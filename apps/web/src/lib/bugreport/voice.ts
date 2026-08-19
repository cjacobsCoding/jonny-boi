/**
 * Voice capture — say what went wrong instead of typing it.
 *
 * This is the half of the reporter that field use proved matters most: describing
 * a wrong verdict out loud takes five seconds and typing it takes a minute, so a
 * reporter who has to type says less. The audio is ALWAYS the record; the machine
 * transcript is a convenience laid on top of it and is labelled as a hint
 * everywhere it appears, because a clean-looking transcript that dropped one word
 * ("through" -> "to" is the case the games hit) sends a reader after the wrong bug.
 *
 * Two independent mechanisms, deliberately:
 *   - `MediaRecorder` writes the WebM/Opus the report carries. Nothing about the
 *     recording depends on speech recognition existing.
 *   - `SpeechRecognition` (Chrome/Android, `webkit`-prefixed) transcribes live.
 *     Absent — Firefox, Safari, an offline device — the report says why there is
 *     no transcript and points at the audio.
 */

/** The recognition surface, typed narrowly — TS ships no SpeechRecognition DOM types. */
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>; resultIndex: number }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface Recording {
  /** The audio, or null when nothing was captured. */
  readonly blob: Blob | null;
  readonly seconds: number;
  readonly transcript: string;
  /** Why the transcript is missing or partial. Empty when it is clean. */
  readonly note: string;
}

const MS_PER_SECOND = 1000;

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private recognition: SpeechRecognitionLike | null = null;
  private chunks: Blob[] = [];
  private transcriptParts: string[] = [];
  private note = '';
  private startedAtMs = 0;
  private stopTimer = 0;

  get recording(): boolean {
    return this.recorder !== null;
  }

  /** Seconds captured so far, for a live readout while recording. */
  elapsedSeconds(): number {
    return this.recorder === null ? 0 : (Date.now() - this.startedAtMs) / MS_PER_SECOND;
  }

  /**
   * Ask for the microphone and start. Returns an error string on failure (a
   * denied permission, no device, an insecure origin) — never throws, because a
   * missing microphone must cost the voice note and nothing else.
   */
  async start(maxSeconds: number): Promise<string | null> {
    if (this.recorder !== null) return null;
    this.chunks = [];
    this.transcriptParts = [];
    this.note = '';

    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return 'this browser cannot record audio';
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      return `no microphone (${String(error)})`;
    }

    try {
      this.recorder = new MediaRecorder(this.stream);
    } catch (error) {
      this.releaseStream();
      return `the recorder would not start (${String(error)})`;
    }
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start();
    this.startedAtMs = Date.now();

    // A safety valve, not a feature: a forgotten recording must not run forever.
    this.stopTimer = window.setTimeout(() => {
      this.note = 'recording stopped at the configured maximum length';
      void this.stop();
    }, maxSeconds * MS_PER_SECOND);

    this.startRecognition();
    return null;
  }

  private startRecognition(): void {
    const Ctor = speechRecognitionCtor();
    if (Ctor === null) {
      this.note =
        'this browser has no speech recognition — voice.webm is the record; play it';
      return;
    }
    try {
      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = navigator.language || 'en-US';
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (result && result.isFinal && result[0]) {
            this.transcriptParts.push(result[0].transcript.trim());
          }
        }
      };
      recognition.onerror = (event) => {
        // 'no-speech' and 'aborted' are ordinary; anything else is worth saying.
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          this.note = `speech recognition failed (${event.error}) — voice.webm is the record`;
        }
      };
      recognition.start();
      this.recognition = recognition;
    } catch (error) {
      this.note = `speech recognition would not start (${String(error)}) — voice.webm is the record`;
    }
  }

  /** Stop and collect. Safe to call when not recording. */
  async stop(): Promise<Recording> {
    if (this.recorder === null) {
      return { blob: null, seconds: 0, transcript: '', note: this.note };
    }
    window.clearTimeout(this.stopTimer);
    const seconds = this.elapsedSeconds();
    const recorder = this.recorder;
    this.recorder = null;

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;

    this.recognition?.stop();
    this.recognition = null;
    this.releaseStream();

    const blob = this.chunks.length > 0 ? new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }) : null;
    return {
      blob,
      seconds,
      transcript: this.transcriptParts.join(' ').trim(),
      note: this.note,
    };
  }

  private releaseStream(): void {
    // Not optional: leaving the track live keeps the browser's recording
    // indicator on after the report is filed, which reads as the app spying.
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}

/** Read a Blob as bytes for the bundle. */
export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
