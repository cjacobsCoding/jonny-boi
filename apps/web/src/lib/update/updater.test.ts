/**
 * The update coordinator: WHEN a waiting build applies, WHAT happens first
 * (flush → flag → reload, in that order), and the resume-flag semantics —
 * an update-triggered reload writes the flag, user navigation never does.
 * Everything is injected (flag storage, scroll, the apply function), so the
 * whole reload path is observable without a service worker or a browser.
 */
import { describe, expect, it } from 'vitest';
import { UPDATE_RESUME_FLAG_KEY } from '../config.js';
import { UPDATE_PILL_TEXT } from './update-decision.js';
import {
  createUpdater,
  readUpdateResumeFlag,
  writeUpdateResumeFlag,
  type FlagStorage,
} from './updater.js';

/** An in-memory sessionStorage stand-in. */
function fakeFlagStorage(options: { readonly fail?: boolean } = {}): {
  storage: FlagStorage;
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  const storage: FlagStorage = {
    getItem: (key) => {
      if (options.fail) throw new Error('blocked');
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (options.fail) throw new Error('blocked');
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return { storage, map };
}

/** A harness capturing every side effect the updater performs, in order. */
function harness(scroll = 0) {
  const { storage, map } = fakeFlagStorage();
  const order: string[] = [];
  const updater = createUpdater({ flagStorage: storage, scrollY: () => scroll });
  const apply = (): void => {
    order.push('apply');
  };
  const flush = (): void => {
    order.push('flush');
  };
  return { updater, apply, flush, order, storage, map };
}

describe('the update coordinator', () => {
  it('applies immediately when no game is live — flush, then flag, then reload', () => {
    const h = harness(320);
    h.updater.reportAppView('lab');
    const unregister = h.updater.registerFlush(() => {
      h.flush();
      // The flag must not exist yet while state is being flushed.
      expect(h.map.has(UPDATE_RESUME_FLAG_KEY)).toBe(false);
    });
    h.updater.onUpdateReady(h.apply);
    expect(h.order).toEqual(['flush', 'apply']);
    // The flag carries the screen + scroll the user was on.
    expect(readUpdateResumeFlag(h.storage)).toEqual({ view: 'lab', scrollY: 320, gameLive: false });
    unregister();
  });

  it('defers while a game is live: pill up, no reload, no flag', () => {
    const h = harness();
    h.updater.reportGameLive('solo', 'game');
    h.updater.onUpdateReady(h.apply);
    expect(h.order).toEqual([]);
    expect(h.map.size).toBe(0);
    expect(h.updater.pillText()).toBe(UPDATE_PILL_TEXT.game);
  });

  it('applies the moment the last live game is released', () => {
    const h = harness();
    h.updater.reportAppView('play');
    h.updater.reportGameLive('solo', 'game');
    h.updater.onUpdateReady(h.apply);
    h.updater.registerFlush(h.flush);
    // A second surface (the end screen counts as live) keeps deferring.
    h.updater.reportGameLive('solo', 'game-over');
    expect(h.updater.pillText()).toBe(UPDATE_PILL_TEXT['game-over']);
    expect(h.order).toEqual([]);
    // Leaving the game releases it — the update applies right there.
    h.updater.reportGameLive('solo', null);
    expect(h.order).toEqual(['flush', 'apply']);
    // gameLive is false BY CONSTRUCTION here: the policy only reaches the apply
    // path once every live game is released, and the flag records that truth
    // rather than assuming it (see UpdateResumeFlag.gameLive).
    expect(readUpdateResumeFlag(h.storage)).toEqual({ view: 'play', scrollY: 0, gameLive: false });
  });

  it('applies at most once, whatever else keeps happening', () => {
    const h = harness();
    h.updater.reportGameLive('solo', 'game');
    h.updater.onUpdateReady(h.apply);
    h.updater.reportGameLive('solo', null);
    h.updater.reportGameLive('solo', 'game');
    h.updater.reportGameLive('solo', null);
    expect(h.order).toEqual(['apply']);
  });

  it('user navigation and game lifecycles NEVER write the flag on their own', () => {
    const h = harness();
    h.updater.reportAppView('cards');
    h.updater.reportAppView('play');
    h.updater.reportGameLive('solo', 'game');
    h.updater.reportGameLive('solo', 'game-over');
    h.updater.reportGameLive('solo', null);
    // No update was ever announced: nothing may have touched storage.
    expect(h.map.size).toBe(0);
  });

  it('an online game defers with its own copy, and out-ranks an end screen', () => {
    const h = harness();
    h.updater.reportGameLive('online-play', 'online-game');
    h.updater.onUpdateReady(h.apply);
    expect(h.updater.pillText()).toBe(UPDATE_PILL_TEXT['online-game']);
    // An ACTIVE local game is the most urgent copy of all.
    h.updater.reportGameLive('solo', 'game');
    expect(h.updater.pillText()).toBe(UPDATE_PILL_TEXT.game);
    expect(h.order).toEqual([]);
  });

  it('notifies subscribers when the pill changes, and clears it once applied', () => {
    const h = harness();
    let notified = 0;
    h.updater.subscribe(() => {
      notified += 1;
    });
    h.updater.reportGameLive('solo', 'game');
    h.updater.onUpdateReady(h.apply);
    expect(notified).toBeGreaterThan(0);
    expect(h.updater.pillText()).toBe(UPDATE_PILL_TEXT.game);
    h.updater.reportGameLive('solo', null);
    expect(h.updater.pillText()).toBeNull();
    expect(h.order).toEqual(['apply']);
  });

  it('a throwing flush cannot block the update', () => {
    const h = harness();
    h.updater.registerFlush(() => {
      throw new Error('storage died');
    });
    h.updater.registerFlush(h.flush);
    h.updater.onUpdateReady(h.apply);
    expect(h.order).toEqual(['flush', 'apply']);
  });
});

describe('the resume flag', () => {
  it('round-trips, and reading consumes it', () => {
    const { storage } = fakeFlagStorage();
    writeUpdateResumeFlag({ view: 'play', scrollY: 512, gameLive: true }, storage);
    expect(readUpdateResumeFlag(storage)).toEqual({ view: 'play', scrollY: 512, gameLive: true });
    expect(readUpdateResumeFlag(storage)).toBeNull(); // consumed
  });

  it('malformed or missing flags read as null', () => {
    const { storage, map } = fakeFlagStorage();
    expect(readUpdateResumeFlag(storage)).toBeNull();
    map.set(UPDATE_RESUME_FLAG_KEY, 'not json');
    expect(readUpdateResumeFlag(storage)).toBeNull();
    map.set(UPDATE_RESUME_FLAG_KEY, JSON.stringify({ view: 7 }));
    expect(readUpdateResumeFlag(storage)).toBeNull();
    // A flag missing its gameLive verdict is not trusted either.
    map.set(UPDATE_RESUME_FLAG_KEY, JSON.stringify({ view: 'play', scrollY: 3 }));
    expect(readUpdateResumeFlag(storage)).toBeNull();
  });

  it('absent or throwing storage degrades to null, never a crash', () => {
    expect(readUpdateResumeFlag(null)).toBeNull();
    writeUpdateResumeFlag({ view: 'play', scrollY: 0, gameLive: false }, null); // must not throw
    const blocked = fakeFlagStorage({ fail: true });
    writeUpdateResumeFlag({ view: 'play', scrollY: 0, gameLive: false }, blocked.storage);
    expect(readUpdateResumeFlag(blocked.storage)).toBeNull();
  });
});
