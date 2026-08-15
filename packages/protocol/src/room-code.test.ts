/**
 * Room-code contract tests.
 *
 * These exist because of a bug that made online play unjoinable for its whole
 * life: the server generated FIVE-character codes while the web client only
 * enabled its "Join room" button at exactly SIX. Both constants were called
 * `ROOM_CODE_LENGTH`, both were "obviously right" in their own file, and nothing
 * compared them — so the failure surfaced only as a button that never lit up.
 *
 * The lesson is the test: a value both ends must agree on gets ONE definition,
 * and the agreement is asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ROOM_CODE_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  isPlausibleRoomCode,
  normalizeRoomCode,
} from './index.js';

/** A code of the canonical shape, built from the canonical alphabet. */
const VALID_CODE = ROOM_CODE_ALPHABET.slice(0, ROOM_CODE_LENGTH);

describe('the room-code shape is internally consistent', () => {
  it('accepts a code of exactly the generated length', () => {
    expect(VALID_CODE).toHaveLength(ROOM_CODE_LENGTH);
    expect(isPlausibleRoomCode(VALID_CODE)).toBe(true);
  });

  it('rejects codes one character short or long', () => {
    expect(isPlausibleRoomCode(VALID_CODE.slice(0, -1))).toBe(false);
    expect(isPlausibleRoomCode(VALID_CODE + 'X')).toBe(false);
  });

  it('leaves room on the wire for codes issued under an older scheme', () => {
    // The wire bound is deliberately looser than today's length, so changing the
    // generated size never invalidates codes already in flight.
    expect(MAX_ROOM_CODE_LENGTH).toBeGreaterThan(ROOM_CODE_LENGTH);
  });

  it('omits the characters that get misread when a code is read aloud', () => {
    for (const ambiguous of ['I', 'O', '0', '1']) {
      expect(ROOM_CODE_ALPHABET, `${ambiguous} is easy to mishear or mistype`).not.toContain(
        ambiguous,
      );
    }
  });
});

describe('normalizing what a player actually types', () => {
  it('accepts a lowercase code — a phone keyboard may not capitalise', () => {
    expect(isPlausibleRoomCode(VALID_CODE.toLowerCase())).toBe(true);
    expect(normalizeRoomCode(VALID_CODE.toLowerCase())).toBe(VALID_CODE);
  });

  it('accepts a code pasted with surrounding whitespace', () => {
    expect(isPlausibleRoomCode(`  ${VALID_CODE} `)).toBe(true);
    expect(normalizeRoomCode(`  ${VALID_CODE} `)).toBe(VALID_CODE);
  });

  it('rejects an empty code', () => {
    expect(isPlausibleRoomCode('')).toBe(false);
    expect(isPlausibleRoomCode('   ')).toBe(false);
  });
});
