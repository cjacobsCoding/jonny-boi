import { describe, expect, it } from 'vitest';
import { MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@jonny-boi/protocol';
import { isLegacyVersion, negotiateOnError } from './negotiation.js';

describe('negotiateOnError', () => {
  it('steps down to the floor on a version mismatch and retries', () => {
    expect(negotiateOnError('protocolMismatch', PROTOCOL_VERSION, true)).toEqual({
      action: 'retry',
      version: MIN_COMPATIBLE_PROTOCOL_VERSION,
    });
  });

  it('surfaces any error that is NOT a version mismatch', () => {
    for (const code of ['roomNotFound', 'roomFull', 'invalidDeck', 'internal'] as const) {
      expect(negotiateOnError(code, PROTOCOL_VERSION, true)).toEqual({ action: 'surface' });
    }
  });

  it('surfaces when there is no handshake to replay', () => {
    // A mismatch arriving out of band must not silently re-send something stale.
    expect(negotiateOnError('protocolMismatch', PROTOCOL_VERSION, false)).toEqual({ action: 'surface' });
  });

  it('TERMINATES: at the floor it gives up instead of retrying forever', () => {
    expect(negotiateOnError('protocolMismatch', MIN_COMPATIBLE_PROTOCOL_VERSION, true)).toEqual({
      action: 'surface',
    });
    // and below the floor (a server older than we support) it still gives up
    expect(negotiateOnError('protocolMismatch', MIN_COMPATIBLE_PROTOCOL_VERSION - 1, true)).toEqual({
      action: 'surface',
    });
  });

  it('every retry strictly lowers the version, so the loop cannot cycle', () => {
    const first = negotiateOnError('protocolMismatch', PROTOCOL_VERSION, true);
    expect(first.action).toBe('retry');
    if (first.action !== 'retry') return;
    expect(first.version).toBeLessThan(PROTOCOL_VERSION);
    // the retried version is itself terminal
    expect(negotiateOnError('protocolMismatch', first.version, true)).toEqual({ action: 'surface' });
  });
});

describe('isLegacyVersion', () => {
  it('flags an older server and not the current one', () => {
    expect(isLegacyVersion(PROTOCOL_VERSION)).toBe(false);
    expect(isLegacyVersion(MIN_COMPATIBLE_PROTOCOL_VERSION)).toBe(PROTOCOL_VERSION > MIN_COMPATIBLE_PROTOCOL_VERSION);
  });
});

describe('the compatible floor is sane', () => {
  it('is at or below the current version', () => {
    expect(MIN_COMPATIBLE_PROTOCOL_VERSION).toBeLessThanOrEqual(PROTOCOL_VERSION);
    expect(MIN_COMPATIBLE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });
});
