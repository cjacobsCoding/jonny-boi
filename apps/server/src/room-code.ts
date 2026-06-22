/**
 * Short, human-friendly room codes. The alphabet (ambiguity-free) and length live
 * in `config.ts`; this module only assembles characters from them. `crypto` gives
 * us uniform, unpredictable codes (so codes aren't guessable in sequence).
 */

import { randomInt } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './config.js';

/** Generate one candidate room code from the configured alphabet + length. */
export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Generate a code not already present in `taken`. Bounded by `maxAttempts` so a
 * pathologically full code space can never hang the server — returns `null` to let
 * the caller surface a clean error rather than spinning.
 */
export function generateUniqueRoomCode(
  taken: ReadonlySet<string>,
  maxAttempts: number,
): string | null {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateRoomCode();
    if (!taken.has(code)) return code;
  }
  return null;
}
