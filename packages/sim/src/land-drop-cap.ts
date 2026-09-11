/**
 * THE LAND-DROP CAP, JUDGED AT THE RIGHT TIME.
 *
 * "A player never plays more lands than they are allowed" is one of the first
 * rules anybody would check, and checking it from a single settled state is
 * WRONG — which is how it spent a 2,000-game soak reporting a defect that was
 * not there (seed 3679986871).
 *
 * The two halves of the comparison are read at different moments:
 *
 *   - `landsPlayedThisTurn` is CLEARED only for the player whose turn is
 *     beginning (CR 505.4 has nothing to say about the other seat, which cannot
 *     play a land anyway). So the non-active player's count is a leftover from
 *     THEIR last turn, and comparing it to a cap read now compares two turns.
 *   - the cap itself MOVES. `additionalLandPlays` is granted by a permanent
 *     (Exploration, Icetill Explorer), and a permanent can die. Seed 3679986871
 *     is exactly that: B played two lands on turn 16 — one from hand, one from
 *     the graveyard, both legal, because Icetill Explorer prints "an additional
 *     land" and "you may play lands from your graveyard" — then blocked with the
 *     Explorer on turn 17 and lost it. At that instant `maxLandPlaysFor` answers
 *     1, B's stale count still says 2, and a flat comparison calls a legal turn
 *     a rules violation.
 *
 * So the count is judged against THE LARGEST CAP THIS SEAT HAS BEEN SEEN TO HAVE
 * SINCE ITS OWN TURN BEGAN, which is an upper bound on what was legal at the
 * moment of any of those plays. That keeps the check's whole point — a land drop
 * that ESCAPED the counter, or a cap the engine failed to enforce, still shows up
 * as a count above every cap the seat ever had — while making it impossible to
 * report a turn that was legal when it happened.
 *
 * ⚠️ It is STATEFUL on purpose, and that is the honest shape: "was this legal?"
 * is a question about a history, and a checker that pretends a snapshot can
 * answer it reports something other than "I didn't check". Both consumers (the
 * soak watcher and `rules-audit.test.ts`) fold every settled state they see
 * through one of these, so the two cannot answer the question differently.
 */

import {
  DEFAULT_RULES,
  maxLandPlaysFor,
  PLAYER_IDS,
  type GameState,
  type PlayerId,
  type RulesConfig,
} from '@jonny-boi/core';

/** A running judgement of the land-drop cap over one game. */
export interface LandDropCapWatch {
  /**
   * Fold one settled state in, and report an impossible count if there is one.
   *
   * Call it on every state the caller sees, in game order: the bound it keeps is
   * only as good as the states it was shown, and the state immediately before a
   * land play — the one that made the play legal — is always among them, because
   * a play is an ACTION and every action is chosen from a settled state.
   */
  check(state: GameState): string | undefined;
}

export function createLandDropCapWatch(rules: RulesConfig = DEFAULT_RULES): LandDropCapWatch {
  // The largest cap each seat has been observed to hold since its own turn began.
  const allowed: Record<PlayerId, number> = { A: rules.maxLandsPerTurn, B: rules.maxLandsPerTurn };
  let turn = -1;
  let turnPlayer: PlayerId | undefined;

  return {
    check(state: GameState): string | undefined {
      const active = state.activePlayer;
      // A new turn for this seat resets ITS bound (the count was just cleared);
      // the other seat's bound stays, because so does the count it belongs to.
      if (state.turnNumber !== turn || active !== turnPlayer) {
        turn = state.turnNumber;
        turnPlayer = active;
        allowed[active] = maxLandPlaysFor(state, active, rules);
      } else {
        const now = maxLandPlaysFor(state, active, rules);
        if (now > allowed[active]) allowed[active] = now;
      }
      for (const pid of PLAYER_IDS) {
        const played = state.players[pid as PlayerId].landsPlayedThisTurn;
        if (played > allowed[pid as PlayerId]) {
          return `${pid} played ${played} lands this turn (never entitled to more than ${allowed[pid as PlayerId]})`;
        }
      }
      return undefined;
    },
  };
}
