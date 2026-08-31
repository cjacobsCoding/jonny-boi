/**
 * THE UPDATE COORDINATOR — the stateful counterpart to update-decision.ts.
 *
 * One instance ({@link appUpdater}) is shared by three parties:
 *   - `main.tsx` announces "a new service worker is waiting" and hands over
 *     the function that applies it (skipWaiting + reload);
 *   - game surfaces report themselves live/not-live (`reportGameLive`), and
 *     persistence registers force-flush callbacks (`registerFlush`) so no
 *     committed action can be lost to an update reload;
 *   - the `UpdatePill` component subscribes and renders `pillText`.
 *
 * Every input change re-evaluates the pure {@link decideUpdate}; the moment it
 * says `applyNow` the coordinator (1) runs every registered flush, (2) writes
 * the UPDATE-RESUME FLAG — screen + scroll, so the reloaded app comes back to
 * exactly where the user was — and (3) calls the apply function. That order is
 * the contract: the flag and the flushed state must be on disk BEFORE the
 * reload can happen.
 *
 * ## The resume flag
 *
 * Written ONLY here, on the update-triggered reload path — user navigation
 * never writes it, which is how the app tells "I was reloaded by an update,
 * restore everything" from "the user opened me, start normally". It lives in
 * sessionStorage: per-tab and reload-surviving, so another tab or tomorrow's
 * launch cannot replay a stale restore. Consumed (removed) on first read.
 */
import { UPDATE_RESUME_FLAG_KEY } from '../config.js';
import { decideUpdate, type LiveGameScreen } from './update-decision.js';

/** The slice of Web Storage the flag uses — injectable for tests. */
export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What the flag carries: enough to put the user back where they were. */
export interface UpdateResumeFlag {
  /** The App view id that was active (e.g. 'play', 'cards'). */
  readonly view: string;
  /** `window.scrollY` at apply time, restored after the reloaded app mounts. */
  readonly scrollY: number;
  /**
   * Whether a LOCAL game surface was live at apply time — the Play view
   * auto-resumes the saved game (no menu stop) exactly when this is true, so
   * an update can never teleport a user who had already LEFT their game back
   * into it. Under the shipped policy updates defer while a game is live, so
   * this is false today on every written flag; it is recorded (rather than
   * assumed) so any future mid-game apply path restores correctly by
   * construction.
   */
  readonly gameLive: boolean;
}

/** The real sessionStorage, or null where unavailable. */
function defaultFlagStorage(): FlagStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Write the flag. Best-effort: a failed write only costs the auto-restore. */
export function writeUpdateResumeFlag(
  flag: UpdateResumeFlag,
  storage: FlagStorage | null = defaultFlagStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UPDATE_RESUME_FLAG_KEY, JSON.stringify(flag));
  } catch {
    // Degrade to the manual "Resume game" offer — never block the update.
  }
}

/** Read AND REMOVE the flag. Null when absent or malformed. Never throws. */
export function readUpdateResumeFlag(
  storage: FlagStorage | null = defaultFlagStorage(),
): UpdateResumeFlag | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(UPDATE_RESUME_FLAG_KEY);
    if (raw === null) return null;
    storage.removeItem(UPDATE_RESUME_FLAG_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { view?: unknown }).view === 'string' &&
      typeof (parsed as { scrollY?: unknown }).scrollY === 'number' &&
      typeof (parsed as { gameLive?: unknown }).gameLive === 'boolean'
    ) {
      return parsed as UpdateResumeFlag;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The flag as consumed ONCE per page load, memoized for every later caller.
 *
 * Both `App` (initial view + scroll) and `PlayView` (auto-resume the game)
 * need the same answer, and React StrictMode double-invokes initializers — so
 * a naive read-and-remove would hand the value to one caller and null to the
 * rest. First call reads + removes from storage; the value is then served
 * from memory for the rest of the page's life.
 */
let consumedFlag: UpdateResumeFlag | null | undefined;
export function updateResumeFlag(): UpdateResumeFlag | null {
  if (consumedFlag === undefined) consumedFlag = readUpdateResumeFlag();
  return consumedFlag;
}

/**
 * Mark the flag's game-resume half handled, so a LATER visit to the Play view
 * (after the user deliberately left the restored game) does not force them
 * back into it. Idempotent; the App-level view/scroll restore has already
 * happened by the time anyone calls this.
 */
export function markUpdateResumeHandled(): void {
  consumedFlag = null;
}

// --- the coordinator -----------------------------------------------------------------

/** Effects the updater performs, injectable so tests observe order + payloads. */
export interface UpdaterDeps {
  readonly flagStorage?: FlagStorage | null;
  /** Where the user's viewport is, captured into the flag at apply time. */
  readonly scrollY?: () => number;
}

export interface Updater {
  /**
   * A new service worker is waiting; `apply` performs skipWaiting + reload.
   * May be called again for a newer worker — the latest apply wins.
   */
  onUpdateReady(apply: () => void): void;
  /** The App's current view id (rides into the resume flag at apply time). */
  reportAppView(view: string): void;
  /**
   * A game surface declares itself live (`screen`) or gone (null). `id` keys
   * the surface so remounts and multiple surfaces cannot double-release.
   * Re-evaluates the policy — releasing the last live game applies a waiting
   * update immediately.
   */
  reportGameLive(id: string, screen: LiveGameScreen | null): void;
  /** Register a force-flush run before any update reload. Returns unregister. */
  registerFlush(flush: () => void): () => void;
  /** The pill's current text, or null (subscribe to be told when it changes). */
  pillText(): string | null;
  /** Subscribe to pill/state changes (useSyncExternalStore-compatible). */
  subscribe(listener: () => void): () => void;
}

/** Build an updater. The app uses {@link appUpdater}; tests build their own. */
export function createUpdater(deps: UpdaterDeps = {}): Updater {
  const scrollY = deps.scrollY ?? (() => (typeof window === 'undefined' ? 0 : window.scrollY));

  let apply: (() => void) | null = null;
  let applying = false;
  let view = 'cards';
  const liveGames = new Map<string, LiveGameScreen>();
  const flushers = new Set<() => void>();
  const listeners = new Set<() => void>();
  // Cached so `pillText()` is referentially stable for useSyncExternalStore.
  let currentPillText: string | null = null;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  /**
   * The dominant live screen for the pill copy: an active game outranks its
   * end screen, and a (rare) mix with online reports the active game.
   */
  const dominantScreen = (): LiveGameScreen | null => {
    const screens = new Set(liveGames.values());
    if (screens.has('game')) return 'game';
    if (screens.has('online-game')) return 'online-game';
    if (screens.has('game-over')) return 'game-over';
    return null;
  };

  const applyNow = (): void => {
    // At-most-once: apply() reloads the page; a second run could double-write
    // or race the reload.
    if (applying || apply === null) return;
    applying = true;
    // Order is the contract (see module doc): flush state, then the flag,
    // then the reload. A throwing flusher must not block the update.
    for (const flush of [...flushers]) {
      try {
        flush();
      } catch {
        // Best-effort — the debounced writer already wrote recently.
      }
    }
    const screen = dominantScreen();
    writeUpdateResumeFlag(
      // `gameLive` records the LOCAL surfaces only: an online game's state is
      // the server's, so there is nothing for the flag to promise a resume of.
      { view, scrollY: scrollY(), gameLive: screen === 'game' || screen === 'game-over' },
      deps.flagStorage !== undefined ? deps.flagStorage : defaultFlagStorage(),
    );
    apply();
  };

  const evaluate = (): void => {
    const decision = decideUpdate({
      updateReady: apply !== null,
      gameLive: liveGames.size > 0,
      screen: dominantScreen(),
    });
    const nextPill = applying ? null : decision.pillText;
    if (nextPill !== currentPillText) {
      currentPillText = nextPill;
      notify();
    }
    if (decision.action === 'applyNow') applyNow();
  };

  return {
    onUpdateReady(applyFn) {
      apply = applyFn;
      evaluate();
    },
    reportAppView(nextView) {
      // Deliberately no evaluate(): where the user is browsing never changes
      // WHETHER to apply, only what the flag will say when we do.
      view = nextView;
    },
    reportGameLive(id, screen) {
      if (screen === null) liveGames.delete(id);
      else liveGames.set(id, screen);
      evaluate();
    },
    registerFlush(flush) {
      flushers.add(flush);
      return () => flushers.delete(flush);
    },
    pillText: () => currentPillText,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The one updater the app shares. */
export const appUpdater: Updater = createUpdater();
