import { describe, expect, it } from 'vitest';
import {
  TRANSPORT_BUTTONS,
  transportFaces,
  type TransportButtonId,
} from './replay-config.js';

/**
 * The Watch-a-Game transport bar, checked as a SET.
 *
 * A user reported that the screen "shows a two-play-buttons icon": Play and
 * Step-forward both rendered `▶` (U+25B6), so the bar put two identical play
 * triangles next to each other and there was no way to tell which one advanced
 * one frame. Nothing was wrong with either button on its own — the defect only
 * existed BETWEEN them, which is why it survived review and why these tests
 * assert over the whole list rather than button by button.
 */
describe('the replay transport bar', () => {
  const EXPECTED_ORDER: readonly TransportButtonId[] = [
    'restart',
    'stepBack',
    'playPause',
    'stepForward',
  ];

  it('offers exactly the four controls, left to right', () => {
    expect(TRANSPORT_BUTTONS.map((b) => b.id)).toEqual(EXPECTED_ORDER);
  });

  it('gives no two faces the same glyph', () => {
    const faces = transportFaces();
    const byGlyph = new Map<string, string[]>();
    for (const face of faces) {
      byGlyph.set(face.glyph, [...(byGlyph.get(face.glyph) ?? []), face.label]);
    }
    const collisions = [...byGlyph.entries()]
      .filter(([, labels]) => labels.length > 1)
      .map(([glyph, labels]) => `${glyph} is used by ${labels.join(' and ')}`);
    expect(collisions).toEqual([]);
  });

  it('gives no two faces the same accessible name', () => {
    const labels = transportFaces().map((f) => f.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('reserves the bare play triangle for play alone', () => {
    const PLAY_TRIANGLE = '▶';
    const usingIt = transportFaces().filter((f) => f.glyph === PLAY_TRIANGLE);
    expect(usingIt.map((f) => f.label)).toEqual(['Play']);
  });

  it('labels and glyphs are all non-empty single-mark strings', () => {
    for (const face of transportFaces()) {
      expect(face.label.trim(), 'a transport button has no accessible name').not.toBe('');
      // One glyph per button: a two-character "icon" is a layout accident, and
      // was how the duplicate play triangles nearly got "fixed" by padding.
      expect([...face.glyph], `${face.label} is not a single glyph`).toHaveLength(1);
    }
  });

  it('only play/pause changes face while the replay is running', () => {
    const changing = TRANSPORT_BUTTONS.filter((b) => b.whilePlaying !== undefined);
    expect(changing.map((b) => b.id)).toEqual(['playPause']);
    const playPause = changing[0]!;
    expect(playPause.label).toBe('Play');
    expect(playPause.whilePlaying?.label).toBe('Pause');
  });
});
