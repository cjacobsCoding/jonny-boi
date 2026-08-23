/**
 * The rolling clip's arithmetic, and the replay page's assembly.
 *
 * Both are pinned here because both have a failure mode that LOOKS fine: a
 * window rule that returns an empty selection produces a report that silently
 * carries no clip, and a replay page that starts mid-chunk produces a player
 * showing a blank rectangle. Neither throws; neither is visible without opening
 * the artifact. So the rules are tested rather than eyeballed once.
 */
import { describe, expect, it } from 'vitest';
import {
  CLIP_DEFAULTS,
  ClipRing,
  firstChunkForWindow,
  trimToEventCap,
  type ClipEvent,
} from './clip-ring.js';
import { buildReplayHtml, escapeForScript } from './replay-html.js';

const SECOND = 1000;

function spans(...bounds: readonly (readonly [number, number])[]) {
  return bounds.map(([startMs, endMs]) => ({ startMs, endMs }));
}

describe('firstChunkForWindow', () => {
  const now = 100 * SECOND;

  it('takes every chunk that overlaps the window', () => {
    // Three 15 s chunks ending now; a 30 s window starts at 70 s. The first
    // chunk ENDS at exactly 70 s, so it still overlaps and is taken: the window
    // is a FLOOR, not a ceiling. A clip is allowed to carry more context than
    // was asked for — it is never allowed to carry less, and it can only start
    // where a snapshot is.
    const chunks = spans([55 * SECOND, 70 * SECOND], [70 * SECOND, 85 * SECOND], [85 * SECOND, 100 * SECOND]);
    expect(firstChunkForWindow(chunks, now, 30)).toBe(0);
  });

  it('stops at the first chunk that ends BEFORE the window', () => {
    const chunks = spans([40 * SECOND, 69 * SECOND], [70 * SECOND, 85 * SECOND], [85 * SECOND, 100 * SECOND]);
    expect(firstChunkForWindow(chunks, now, 30)).toBe(1);
  });

  it('takes them all when the window covers everything', () => {
    const chunks = spans([55 * SECOND, 70 * SECOND], [70 * SECOND, 85 * SECOND], [85 * SECOND, 100 * SECOND]);
    expect(firstChunkForWindow(chunks, now, 300)).toBe(0);
  });

  it('takes only the newest when the window is short', () => {
    const chunks = spans([55 * SECOND, 70 * SECOND], [85 * SECOND, 100 * SECOND]);
    expect(firstChunkForWindow(chunks, now, 5)).toBe(1);
  });

  it('still returns the newest chunk when ALL of it predates the window', () => {
    // An idle page: nothing has happened for a minute. The last thing that
    // happened is still the clip worth having — returning nothing here would
    // file a report that quietly carries no replay.
    const chunks = spans([10 * SECOND, 20 * SECOND]);
    expect(firstChunkForWindow(chunks, now, 30)).toBe(0);
  });

  it('a zero or negative window means no clip at all — the games dial-to-zero rule', () => {
    const chunks = spans([85 * SECOND, 100 * SECOND]);
    expect(firstChunkForWindow(chunks, now, 0)).toBe(-1);
    expect(firstChunkForWindow(chunks, now, -5)).toBe(-1);
  });

  it('handles having recorded nothing', () => {
    expect(firstChunkForWindow([], now, 30)).toBe(-1);
  });

  it('does not reach past a GAP in the recording', () => {
    // A chunk that ended long before the window starts cannot be joined to one
    // inside it — the replay would jump.
    const chunks = spans([1 * SECOND, 5 * SECOND], [90 * SECOND, 100 * SECOND]);
    expect(firstChunkForWindow(chunks, now, 30)).toBe(1);
  });
});

describe('trimToEventCap', () => {
  it('keeps everything under the cap', () => {
    expect(trimToEventCap([10, 20, 30], 1000)).toBe(0);
  });

  it('drops the OLDEST chunks first', () => {
    expect(trimToEventCap([500, 500, 500], 1000)).toBe(1);
    // Dropped until what remains FITS, so three go and the newest survives.
    expect(trimToEventCap([500, 500, 500, 500], 900)).toBe(3);
  });

  it('never drops the newest chunk, however far over the cap it is', () => {
    // What the reporter just saw is the one thing the clip must contain.
    expect(trimToEventCap([100_000], 10)).toBe(0);
    expect(trimToEventCap([5, 100_000], 10)).toBe(1);
  });

  it('handles an empty ring', () => {
    expect(trimToEventCap([], 100)).toBe(0);
  });
});

/** A fake rrweb: emits what the test asks for, and reports being stopped. */
function fakeRecord(script: readonly (readonly [number, boolean])[]) {
  let stopped = false;
  const fn = (options: {
    emit: (event: ClipEvent, isCheckout?: boolean) => void;
  }): (() => void) => {
    for (const [timestamp, isCheckout] of script) {
      options.emit({ type: 3, timestamp }, isCheckout);
    }
    return () => {
      stopped = true;
    };
  };
  return { fn, wasStopped: () => stopped };
}

describe('ClipRing', () => {
  it('collects events and reports what it is holding', () => {
    const ring = new ClipRing();
    const rec = fakeRecord([
      [1 * SECOND, true],
      [2 * SECOND, false],
      [3 * SECOND, false],
    ]);
    ring.start(rec.fn);
    expect(ring.recording).toBe(true);
    expect(ring.eventCount).toBe(3);
  });

  it('hands over the events for the requested window', () => {
    const ring = new ClipRing();
    ring.start(
      fakeRecord([
        [1 * SECOND, true],
        [2 * SECOND, false],
        [3 * SECOND, false],
      ]).fn,
    );
    expect(ring.eventsForWindow(30, 3 * SECOND)).toHaveLength(3);
  });

  it('hands over nothing when the dial is at zero', () => {
    const ring = new ClipRing();
    ring.start(fakeRecord([[1 * SECOND, true], [2 * SECOND, false]]).fn);
    expect(ring.eventsForWindow(0, 2 * SECOND)).toHaveLength(0);
  });

  it('refuses to hand over a single event, which cannot replay', () => {
    const ring = new ClipRing();
    ring.start(fakeRecord([[1 * SECOND, true]]).fn);
    expect(ring.eventsForWindow(30, 1 * SECOND)).toHaveLength(0);
  });

  it('drops the oldest chunk once the retained chunks exceed the limit', () => {
    const ring = new ClipRing();
    // One checkout per chunk; maxChunks + 2 chunks emitted.
    const script: [number, boolean][] = [];
    for (let chunk = 0; chunk < CLIP_DEFAULTS.maxChunks + 2; chunk += 1) {
      script.push([chunk * 10 * SECOND, true]);
      script.push([chunk * 10 * SECOND + 1, false]);
    }
    ring.start(fakeRecord(script).fn);
    expect(ring.chunkCount).toBeLessThanOrEqual(CLIP_DEFAULTS.maxChunks + 1);
  });

  it('stops cleanly and keeps what it had', () => {
    const ring = new ClipRing();
    const rec = fakeRecord([[1 * SECOND, true], [2 * SECOND, false]]);
    ring.start(rec.fn);
    ring.stop();
    expect(rec.wasStopped()).toBe(true);
    expect(ring.recording).toBe(false);
    expect(ring.eventsForWindow(30, 2 * SECOND)).toHaveLength(2);
  });

  it('a recorder that throws costs the clip and nothing else', () => {
    const ring = new ClipRing();
    ring.start(() => {
      throw new Error('no MutationObserver');
    });
    expect(ring.recording).toBe(false);
    expect(ring.status).toContain('would not start');
    expect(ring.eventsForWindow(30, Date.now())).toHaveLength(0);
  });

  it('clear() empties it, so a handed-over clip is not filed twice', () => {
    const ring = new ClipRing();
    ring.start(fakeRecord([[1 * SECOND, true], [2 * SECOND, false]]).fn);
    ring.clear();
    expect(ring.eventCount).toBe(0);
  });
});

describe('buildReplayHtml', () => {
  const input = {
    playerJs: 'window.rrwebPlayer = function () {};',
    playerCss: '.rr-player { color: red; }',
    eventsJson: '[{"type":2,"timestamp":1},{"type":3,"timestamp":2}]',
    title: 'bugreport_20260815_142530',
    subtitle: 'Cards — 30 s before the report',
  };

  it('inlines the player, the stylesheet and the events', () => {
    const html = buildReplayHtml(input);
    expect(html).toContain(input.playerJs);
    expect(html).toContain(input.playerCss);
    expect(html).toContain('"timestamp":2');
  });

  it('fetches NOTHING — a report is read offline', () => {
    const html = buildReplayHtml(input);
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<link[^>]+href\s*=\s*["']https?:/i);
  });

  it('escapes a closing script tag hidden in the events', () => {
    // A recorded page containing "</script>" in its own markup would otherwise
    // end the inlined block early and produce a broken, silent page.
    const html = buildReplayHtml({ ...input, eventsJson: '[{"html":"</script><b>x"}]' });
    expect(html).not.toContain('</script><b>x');
    expect(html).toContain('<\\/script>');
  });

  it('escapes the header text rather than injecting it', () => {
    const html = buildReplayHtml({ ...input, subtitle: '<img onerror=alert(1)>' });
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;img onerror');
  });

  it('says so in the page when the clip cannot play', () => {
    // The failure has to be visible in the artifact itself; a blank player is
    // indistinguishable from a clip that recorded nothing.
    const html = buildReplayHtml(input);
    expect(html).toContain('could not be played');
    expect(html).toContain('clip.json');
  });
});

describe('escapeForScript', () => {
  it('neutralises the sequences that end an inline script', () => {
    expect(escapeForScript('</script>')).toBe('<\\/script>');
    expect(escapeForScript('</SCRIPT>')).toBe('<\\/SCRIPT>');
    expect(escapeForScript('<!--')).toBe('<\\!--');
  });

  it('leaves ordinary JSON untouched', () => {
    const json = '[{"a":1,"b":"x < y"}]';
    expect(escapeForScript(json)).toBe(json);
  });
});
