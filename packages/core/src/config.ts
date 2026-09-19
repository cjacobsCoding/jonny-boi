/**
 * Designer-tunable rules constants. No magic numbers live in the engine — every
 * value that affects play or feel is named here so it can be tuned from one place
 * (and, later, surfaced to the debug inspector). Keep this module pure data.
 */

import type { PlayerId } from './state.js';

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
   *
   * It is a SEPARATE knob from {@link startingHandSize} even though both are
   * seven in the default rules, because they are different rules — CR 103.4
   * draws the opening hand, CR 402.2 caps what you may keep — and a format may
   * move one without the other.
   *
   * ⚠️ Not a cosmetic knob in a deck-tuning lab. An unbounded hand changes what
   * card draw and held-back reactive spells are worth, which is exactly the
   * quantity every gauntlet and every A/B verdict measures. Moving this number
   * moves every recorded baseline in DESIGN §3.4a.
   */
  readonly maximumHandSize: number;
  /**
   * §3.177 — the seats the engine watches for an INFINITE COMBO and offers the
   * repeat prompt to (`GameState.comboWindow`). EMPTY — the default, and what
   * every simulation runs with — means the detector never runs, records
   * nothing, and the engine plays byte-identically to before it existed.
   *
   * A list of seats rather than a boolean because the engine cannot tell a
   * human from a pilot, and the board can: the Play session names its human
   * seats here (both in pass-and-play, one in Solo). The loop's OWNER is the
   * seat that took its non-pass actions, and a loop owned by an unlisted seat
   * — the computer's — is never offered, however it was completed; the pilot's
   * loops stay the CR 104.4b runaway the soak already guards. It is a rules
   * knob rather than a session flag so a replay of the recorded actions opens
   * the same window at the same action and the recorded `repeatCombo` is legal
   * again.
   */
  readonly comboDetectionSeats: readonly PlayerId[];
}

/** The default MTG-faithful rules configuration. */
export const DEFAULT_RULES: RulesConfig = Object.freeze({
  startingLife: 20,
  startingHandSize: 7,
  maxLandsPerTurn: 1,
  playerOnPlaySkipsFirstDraw: true,
  cardsPerDrawStep: 1,
  maximumHandSize: 7,
  comboDetectionSeats: Object.freeze([]) as readonly PlayerId[],
});
