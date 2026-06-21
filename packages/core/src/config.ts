/**
 * Designer-tunable rules constants. No magic numbers live in the engine — every
 * value that affects play or feel is named here so it can be tuned from one place
 * (and, later, surfaced to the debug inspector). Keep this module pure data.
 */

/** A frozen bundle of the rules knobs the engine reads. */
export interface RulesConfig {
  /** Life each player starts the game with. */
  readonly startingLife: number;
  /** Cards drawn into the opening hand. */
  readonly startingHandSize: number;
  /** Lands a player may play per turn. */
  readonly maxLandsPerTurn: number;
  /** Whether the player on the play skips their first draw step. */
  readonly playerOnPlaySkipsFirstDraw: boolean;
  /** Cards drawn during a normal draw step. */
  readonly cardsPerDrawStep: number;
}

/** The default MTG-faithful rules configuration. */
export const DEFAULT_RULES: RulesConfig = Object.freeze({
  startingLife: 20,
  startingHandSize: 7,
  maxLandsPerTurn: 1,
  playerOnPlaySkipsFirstDraw: true,
  cardsPerDrawStep: 1,
});
