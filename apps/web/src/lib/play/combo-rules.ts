/**
 * THE PLAY SESSION'S RULES — the one place the board tells the engine which
 * seats are human (DESIGN §3.177).
 *
 * The engine watches for an infinite combo only on the seats named in
 * `RulesConfig.comboDetectionSeats`, and it cannot know who is human: in Solo
 * the computer's seat plays through the very same `GameSession.submit`. So the
 * seat list is derived HERE, from the one fact the Play view has — which seat,
 * if any, the pilot drives — and handed to the session at creation. Everything
 * else in the rules is the engine default.
 *
 * Pure, so the persisted-game rebuild (`persist.ts`) can derive the identical
 * rules from its record and replay a recorded `repeatCombo` legally.
 */
import { DEFAULT_RULES, PLAYER_IDS, type PlayerId, type RulesConfig } from '@jonny-boi/core';

/** The rules a Play session runs with: every seat the pilot does NOT drive is watched. */
export function playRulesFor(aiSeat: PlayerId | undefined): RulesConfig {
  return {
    ...DEFAULT_RULES,
    comboDetectionSeats: PLAYER_IDS.filter((seat) => seat !== aiSeat),
  };
}
