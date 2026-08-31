/**
 * THE UPDATE-TIMING RULE, as one pure function.
 *
 * The old behavior reloaded the page the moment a new service worker took
 * control — mid-game, mid-anything. The user's requirement is the opposite:
 * an update must come in WITHOUT interrupting a live game. This module is the
 * whole policy, separated from the service-worker plumbing (updater.ts) so the
 * decision matrix is unit-testable without a browser:
 *
 *   - no update waiting            → do nothing, show nothing;
 *   - update waiting, no live game → apply NOW (flush state, flag the reload,
 *                                    skipWaiting + reload — the user is between
 *                                    things, this is the interruption-free
 *                                    moment);
 *   - update waiting, a live game  → DEFER: show a small non-blocking pill and
 *                                    apply at the next no-live-game evaluation
 *                                    (game dismissed, back to the menu).
 *
 * "Live game" includes the end screen on purpose: yanking the results away the
 * instant the winner is decided is still an interruption, so the game counts
 * as live until the player LEAVES it (rematch keeps it live; menu/new-game
 * releases it). Online games are never state-persisted (the server owns their
 * state) but they defer updates exactly the same way — a reload mid-online
 * game is the worst interruption of all.
 */

/**
 * What kind of game surface is live, for the pill's copy. `game` = an active
 * Solo/local game; `game-over` = its end screen (still the player's moment);
 * `online-game` = the online surface is mounted (lobby or game — the socket
 * dies with the surface, so mounted IS live).
 */
export type LiveGameScreen = 'game' | 'game-over' | 'online-game';

/** The inputs the rule reads. */
export interface UpdateInputs {
  /** A new service worker is installed and WAITING (not yet controlling). */
  readonly updateReady: boolean;
  /** Some game surface reports itself live (see {@link LiveGameScreen}). */
  readonly gameLive: boolean;
  /** The most game-ish live screen, or null when none is live. */
  readonly screen: LiveGameScreen | null;
}

/** What to do about it. */
export type UpdateActionKind = 'none' | 'applyNow' | 'defer';

export interface UpdateDecision {
  readonly action: UpdateActionKind;
  /** The pill's text while deferring; null = show no pill. */
  readonly pillText: string | null;
}

/** The pill copy per live screen — named data, not inline strings. */
export const UPDATE_PILL_TEXT: Readonly<Record<LiveGameScreen, string>> = Object.freeze({
  game: 'Update ready — applies when this game ends',
  'game-over': 'Update ready — applies when you leave this game',
  'online-game': 'Update ready — applies when you leave the online game',
});

/** The rule. Total over its inputs; see the module doc for the matrix. */
export function decideUpdate(inputs: UpdateInputs): UpdateDecision {
  if (!inputs.updateReady) return { action: 'none', pillText: null };
  if (!inputs.gameLive) return { action: 'applyNow', pillText: null };
  return { action: 'defer', pillText: UPDATE_PILL_TEXT[inputs.screen ?? 'game'] };
}
