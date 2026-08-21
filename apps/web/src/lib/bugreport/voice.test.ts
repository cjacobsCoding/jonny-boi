/**
 * The voice recorder's tests, and specifically the one that matters: THE SAFETY
 * VALVE MUST NOT EAT THE RECORDING.
 *
 * `start()` arms a timer that stops the recorder at the configured maximum
 * length so a forgotten recording cannot run forever. That timer used to call
 * `void this.stop()` — firing and dropping the `Recording` on the floor. A
 * reporter who hit the cap watched the button go back to "Record voice" with no
 * error, and their audio was gone. Silent loss of the user's own words, in the
 * tool whose entire purpose is not losing what they were trying to tell you.
 *
 * There is no MediaRecorder in the test environment, so the browser surfaces are
 * faked here — narrowly, and only far enough to drive the state machine this
 * class actually owns: when it stops, what it hands back, and to whom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceRecorder } from './voice.js';

/** A MediaRecorder that emits one chunk and completes its stop on a microtask. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly mimeType = 'audio/webm';
  state = 'inactive';

  constructor() {
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])]) });
    // Real MediaRecorder fires onstop asynchronously; matching that is what
    // makes the concurrent-stop test meaningful rather than trivially serial.
    queueMicrotask(() => this.onstop?.());
  }
}

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

let streams: FakeStream[] = [];

/**
 * `navigator` is a getter-only global in Node, so it cannot be assigned — it has
 * to be stubbed. vi.stubGlobal handles that and unstubs cleanly afterwards.
 */
function stubBrowser(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('navigator', {
    language: 'en-GB',
    mediaDevices: {
      getUserMedia: async () => {
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      },
    },
  });
  // No SpeechRecognition: the transcript is a convenience and its absence is a
  // documented note, never a failure of the recording.
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
  });
  for (const [name, value] of Object.entries(overrides)) vi.stubGlobal(name, value);
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  streams = [];
  stubBrowser();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('VoiceRecorder', () => {
  it('records and hands back the audio', async () => {
    const recorder = new VoiceRecorder();
    expect(await recorder.start(300)).toBeNull();
    expect(recorder.recording).toBe(true);

    const result = await recorder.stop();
    expect(result.blob).not.toBeNull();
    expect(recorder.recording).toBe(false);
  });

  it('releases the microphone, so the browser stops showing a recording dot', async () => {
    const recorder = new VoiceRecorder();
    await recorder.start(300);
    await recorder.stop();
    expect(streams[0]?.getTracks().every((track) => track.stopped)).toBe(true);
  });

  it('KEEPS the audio when the safety valve stops the recording', async () => {
    // The regression. Nobody is awaiting the valve's stop, so the result has to
    // survive until someone asks for it.
    const recorder = new VoiceRecorder();
    await recorder.start(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(recorder.recording).toBe(false);

    const result = await recorder.stop();
    expect(result.blob).not.toBeNull();
    expect(result.note).toContain('maximum length');
  });

  it('delivers a valve-stopped recording exactly once', async () => {
    const recorder = new VoiceRecorder();
    await recorder.start(5);
    await vi.advanceTimersByTimeAsync(5_000);

    expect((await recorder.stop()).blob).not.toBeNull();
    // A second ask must not re-deliver stale audio into a later report.
    expect((await recorder.stop()).blob).toBeNull();
  });

  it('survives the valve firing while a Stop is already in flight', async () => {
    // Both the timer and the button can ask at once. The caller must still get
    // the audio, not a null from a second stop that found the recorder gone.
    const recorder = new VoiceRecorder();
    await recorder.start(5);
    const byTimer = vi.advanceTimersByTimeAsync(5_000);
    const byButton = recorder.stop();
    await byTimer;
    const result = await byButton;
    expect(result.blob).not.toBeNull();
  });

  it('is safe to stop twice, and to stop when never started', async () => {
    const recorder = new VoiceRecorder();
    expect((await recorder.stop()).blob).toBeNull();

    await recorder.start(300);
    const [first, second] = await Promise.all([recorder.stop(), recorder.stop()]);
    // One of the two carries the audio; neither throws, and the recorder ends
    // up stopped either way.
    expect([first.blob, second.blob].some((blob) => blob !== null)).toBe(true);
    expect(recorder.recording).toBe(false);
  });

  it('starting again clears the previous take rather than resurrecting it', async () => {
    const recorder = new VoiceRecorder();
    await recorder.start(5);
    await vi.advanceTimersByTimeAsync(5_000); // valve stops it, audio retained

    await recorder.start(300); // a re-record: the old take is not this report's
    expect(recorder.recording).toBe(true);
    await recorder.stop();
    expect(FakeMediaRecorder.instances).toHaveLength(2);
  });

  it('reports a missing microphone instead of throwing', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => Promise.reject(new Error('denied')) },
    });
    const recorder = new VoiceRecorder();
    const error = await recorder.start(300);
    expect(error).toContain('no microphone');
    expect(recorder.recording).toBe(false);
  });

  it('reports a browser that cannot record at all', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const recorder = new VoiceRecorder();
    expect(await recorder.start(300)).toBe('this browser cannot record audio');
  });
});
