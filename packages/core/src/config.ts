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
  /**
   * The MAXIMUM HAND SIZE the active player is discarded down to in their cleanup
   * step (CR 514.1). A knob rather than a literal 7 for the same reason
   * {@link startingLife} is one: a format variant changes it, and the rule must
   * read it from one place.
   *
   * A player whose board says otherwise (`CardDefinition.noMaximumHandSize` —
   * Reliquary Tower) has no limit at all and skips the discard entirely; that is a
   * card ability, not a config value, so it is not expressed here.
   */
  readonly maximumHandSize: number;
}

/** The default MTG-faithful rules configuration. */
export const DEFAULT_RULES: RulesConfig = Object.freeze({
  startingLife: 20,
  startingHandSize: 7,
  maxLandsPerTurn: 1,
  playerOnPlaySkipsFirstDraw: true,
  cardsPerDrawStep: 1,
  maximumHandSize: 7,
});
