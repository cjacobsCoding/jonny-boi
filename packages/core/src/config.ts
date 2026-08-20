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
   * The most cards a player may still be holding as their own turn ends
   * (CR 402.2 — "each player has a maximum hand size, which is normally seven
   * cards"), enforced by the CR 514.1 cleanup discard.
   *
   * A SEPARATE knob from {@link startingHandSize} even though both are seven in
   * the default rules, because they are different rules — CR 103.4 draws the
   * opening hand, CR 402.2 caps what you may keep — and a format may move one
   * without the other.
   *
   * ⚠️ Not a cosmetic knob in a deck-tuning lab. An unbounded hand changes what
   * card draw and held-back reactive spells are worth, which is exactly the
   * quantity every gauntlet and every A/B verdict measures. Moving this number
   * moves every recorded baseline in DESIGN §3.4a.
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
