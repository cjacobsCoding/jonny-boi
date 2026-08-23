/**
 * PLAYER-FACING STATICS — the small family of continuous abilities that modify a
 * PLAYER rather than a permanent: "You have no maximum hand size", "You may play
 * lands from your graveyard".
 *
 * ## Why this is not `statics.ts`
 * A {@link StaticAbility} is a filter over permanents plus a P/T-and-keyword
 * modification, and the continuous layer aggregates it per INSTANCE. Nothing in
 * that shape can express "its controller's hand has no limit": the subject is a
 * player, there is no instance to hang an aggregate on, and the modification is
 * not a stat. Bending the anthem machinery to carry it would give every one of
 * those reads a per-permanent aggregate to walk for an answer that is a single
 * boolean about a seat.
 *
 * ## Lifetime is DERIVED, exactly as it is for anthems
 * Nothing is pushed into the state when a Reliquary Tower resolves. Every reader
 * re-derives the answer from the objects that are on the battlefield (or in the
 * command zone) right now, so the ability ends the instant its source leaves and
 * there is nothing to expire, nothing to clean up, and no window in which a
 * destroyed Crucible of Worlds still lets a land be replayed.
 *
 * ## The command zone counts
 * An emblem (CR 114) radiates its abilities from the command zone exactly as a
 * permanent radiates them from the battlefield — the same rule
 * `internal/continuous.ts` already applies to anthems — so a "You have no maximum
 * hand size" emblem works without a second mechanism.
 *
 * ## It stays off the hot path
 * Both readers walk the battlefield, and both are asked rarely: the hand-size
 * question once per cleanup step, the land-play zones once per land-play decision.
 * Neither is inside the continuous-layering pass, combat, or the mana planner. The
 * zone reader returns a SHARED FROZEN EMPTY LIST when nothing grants anything, so
 * the overwhelmingly common board allocates nothing and its caller's `length === 0`
 * check is the whole cost.
 */

import type { LandPlayZone } from './actions.js';
import type { CardDefinition } from './card.js';
import type { GameState, PlayerId } from './state.js';

/**
 * Whether `player` has no maximum hand size — Reliquary Tower, Spellbook,
 * Venser's Journal, or an emblem saying so.
 *
 * Read by the cleanup step's discard (CR 514.1). A player controlling several
 * such permanents still simply has no limit; the ability does not stack, so this
 * is a boolean and stops at the first source it finds.
 */
export function hasNoMaximumHandSize(state: GameState, player: PlayerId): boolean {
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const permanent = battlefield[i]!;
    if (permanent.controller !== player) continue;
    if (permanent.def.noMaximumHandSize === true) return true;
  }
  const command = state.players[player].command;
  for (let i = 0; i < command.length; i++) {
    if (command[i]!.def.noMaximumHandSize === true) return true;
  }
  return false;
}

/**
 * Shared empty list, so the ordinary board — where no permanent widens a land
 * play — allocates nothing per decision. Frozen because the caller must not be
 * able to write into a value every other caller shares.
 */
const NO_EXTRA_LAND_ZONES: readonly LandPlayZone[] = Object.freeze([]);

/**
 * The zones — BEYOND the hand — `player` may currently play lands from.
 *
 * The hand is never listed: it needs no permission, and including it would make
 * every caller filter it back out. An empty result is the common case and is the
 * shared frozen list, so a caller can gate its whole graveyard/library walk on
 * `length === 0`.
 *
 * Duplicates are collapsed: two Crucibles of Worlds grant one `'graveyard'`, not
 * two, so the land-play menu cannot offer the same play twice.
 */
export function landPlayZonesFor(state: GameState, player: PlayerId): readonly LandPlayZone[] {
  let zones: LandPlayZone[] | undefined;
  const collect = (def: CardDefinition): void => {
    const granted = def.playLandsFrom;
    if (!granted || granted.length === 0) return;
    for (const zone of granted) {
      if (zones === undefined) zones = [zone];
      else if (!zones.includes(zone)) zones.push(zone);
    }
  };
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const permanent = battlefield[i]!;
    if (permanent.controller !== player) continue;
    collect(permanent.def);
  }
  const command = state.players[player].command;
  for (let i = 0; i < command.length; i++) collect(command[i]!.def);
  return zones ?? NO_EXTRA_LAND_ZONES;
}
