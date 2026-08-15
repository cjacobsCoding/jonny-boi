/**
 * The end-to-end room-code guard: a code this server GENERATES must be one the
 * client would accept typing back.
 *
 * This is the test that would have caught the join bug. The server made
 * 5-character codes, the web client's Join button required 6, and every unit
 * test on both sides passed — because each side only ever checked itself. The
 * assertion that mattered was the one across the seam.
 */

import { describe, expect, it } from 'vitest';
import { isPlausibleRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@jonny-boi/protocol';
import { generateRoomCode, generateUniqueRoomCode } from './room-code.js';
import { ROOM_CODE_ALPHABET as SERVER_ALPHABET, ROOM_CODE_LENGTH as SERVER_LENGTH } from './config.js';

describe('a generated room code is one the client will accept', () => {
  it('passes the client-side check, every time', () => {
    // Many draws: the generator is random, and a length bug that only bit some
    // codes would be worse than one that bit all of them.
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(
        isPlausibleRoomCode(code),
        `the server generated "${code}" (${code.length} chars) but the client would refuse to send it`,
      ).toBe(true);
    }
  });

  it('draws only from the shared alphabet', () => {
    for (let i = 0; i < 200; i++) {
      for (const character of generateRoomCode()) {
        expect(ROOM_CODE_ALPHABET).toContain(character);
      }
    }
  });

  it('produces a unique code that is still client-acceptable', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const code = generateUniqueRoomCode(taken, 16);
      expect(isPlausibleRoomCode(code)).toBe(true);
      expect(taken.has(code)).toBe(false);
      taken.add(code);
    }
  });
});

describe('the server reads the shared definition rather than its own copy', () => {
  it('re-exports the protocol length and alphabet unchanged', () => {
    // If someone re-declares these locally "just for the server", this fails —
    // which is the whole point. Two constants for one concept is the bug.
    expect(SERVER_LENGTH).toBe(ROOM_CODE_LENGTH);
    expect(SERVER_ALPHABET).toBe(ROOM_CODE_ALPHABET);
  });
});
