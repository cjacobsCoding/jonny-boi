/**
 * The client half of the room-code agreement.
 *
 * The join bug lived here: `online-config.ts` declared its own
 * `ROOM_CODE_LENGTH = 6` next to a comment saying the server was authoritative,
 * while the server issued 5-character codes. The Join button gated on the local
 * copy, so no genuine code could ever enable it.
 *
 * The structural fix is that there is now ONE definition, in the shared protocol
 * package. This test is the tripwire for someone re-introducing a local literal:
 * the moment the client's exported value stops being the protocol's, it fails.
 */

import { describe, expect, it } from 'vitest';
import {
  ROOM_CODE_LENGTH as PROTOCOL_LENGTH,
  MAX_ROOM_CODE_LENGTH as PROTOCOL_MAX,
  ROOM_CODE_ALPHABET,
} from '@jonny-boi/protocol';
import {
  ROOM_CODE_LENGTH,
  MAX_ROOM_CODE_LENGTH,
  isPlausibleRoomCode,
} from './online-config.js';

describe('the client uses the shared room-code definition', () => {
  it('re-exports the protocol length rather than its own literal', () => {
    expect(ROOM_CODE_LENGTH).toBe(PROTOCOL_LENGTH);
    expect(MAX_ROOM_CODE_LENGTH).toBe(PROTOCOL_MAX);
  });

  it('would enable the Join button for a real server-issued code', () => {
    // Built the way the server builds one: canonical alphabet, canonical length.
    const serverIssued = ROOM_CODE_ALPHABET.slice(0, PROTOCOL_LENGTH);
    expect(
      isPlausibleRoomCode(serverIssued),
      'the client refuses a code of exactly the length the server generates — ' +
        'this is the bug that made online play unjoinable',
    ).toBe(true);
  });

  it('accepts what a phone keyboard produces (lowercase, stray spaces)', () => {
    const serverIssued = ROOM_CODE_ALPHABET.slice(0, PROTOCOL_LENGTH);
    expect(isPlausibleRoomCode(serverIssued.toLowerCase())).toBe(true);
    expect(isPlausibleRoomCode(` ${serverIssued} `)).toBe(true);
  });
});
