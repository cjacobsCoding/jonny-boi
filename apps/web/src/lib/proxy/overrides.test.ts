import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyOverrides,
  clearOverride,
  getOverride,
  loadOverrides,
  saveOverrides,
  setOverride,
  type OverrideMap,
} from './overrides.js';
import type { ResolvedProxyCard } from './scryfall.js';

/** Minimal in-memory localStorage so persistence is testable in the node env. */
function installMemoryStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe('applyOverrides', () => {
  const resolved: ResolvedProxyCard[] = [
    { name: 'Lightning Bolt', imageUrl: 'default-bolt.png', set: 'lea' },
    { name: 'Sol Ring', imageUrl: 'default-sol.png' },
  ];

  it('uses the default image when no override is present', () => {
    const out = applyOverrides(resolved, new Map());
    expect(out).toEqual(resolved);
  });

  it('substitutes a printing override image (and its set/back)', () => {
    const overrides: OverrideMap = new Map([
      [
        'lightning bolt',
        {
          kind: 'printing',
          scryfallId: 'abc',
          imageUrl: 'alt-bolt.png',
          backImageUrl: 'alt-back.png',
          set: 'MH2',
        },
      ],
    ]);
    const out = applyOverrides(resolved, overrides);
    expect(out[0]).toEqual({
      name: 'Lightning Bolt',
      imageUrl: 'alt-bolt.png',
      set: 'MH2',
      backImageUrl: 'alt-back.png',
    });
    // Untouched card passes through unchanged.
    expect(out[1]).toEqual(resolved[1]);
  });

  it('substitutes an uploaded image and drops any DFC back', () => {
    const overrides: OverrideMap = new Map([
      ['sol ring', { kind: 'upload', imageUrl: 'data:image/png;base64,AAAA' }],
    ]);
    const out = applyOverrides(resolved, overrides);
    expect(out[1]).toEqual({ name: 'Sol Ring', imageUrl: 'data:image/png;base64,AAAA' });
  });
});

describe('setOverride / clearOverride', () => {
  it('sets and clears by normalized name, immutably', () => {
    const base: OverrideMap = new Map();
    const withOne = setOverride(base, 'Lightning Bolt', {
      kind: 'upload',
      imageUrl: 'data:image/png;base64,BBBB',
    });
    expect(base.size).toBe(0); // original untouched
    expect(getOverride(withOne, 'lightning BOLT')).toBeDefined();

    const cleared = clearOverride(withOne, 'LIGHTNING bolt');
    expect(withOne.size).toBe(1); // original untouched
    expect(getOverride(cleared, 'Lightning Bolt')).toBeUndefined();
  });
});

describe('persistence round-trip', () => {
  beforeEach(installMemoryStorage);
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('saves and reloads overrides through localStorage', () => {
    const map = setOverride(new Map(), 'Fatal Push', {
      kind: 'printing',
      scryfallId: 'xyz',
      imageUrl: 'push.png',
      set: 'MH2',
    });
    expect(saveOverrides(map)).toBe(true);

    const reloaded = loadOverrides();
    expect(reloaded.size).toBe(1);
    expect(getOverride(reloaded, 'fatal push')).toMatchObject({
      kind: 'printing',
      scryfallId: 'xyz',
      imageUrl: 'push.png',
    });
  });

  it('ignores malformed persisted entries', () => {
    globalThis.localStorage.setItem(
      'jonny-boi.proxyOverrides.v1',
      JSON.stringify({ good: { kind: 'upload', imageUrl: 'data:x' }, bad: { kind: 'upload' } }),
    );
    const reloaded = loadOverrides();
    expect(reloaded.has('good')).toBe(true);
    expect(reloaded.has('bad')).toBe(false);
  });
});
