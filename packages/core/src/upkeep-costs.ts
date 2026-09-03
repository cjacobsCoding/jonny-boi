/**
 * UPKEEP COSTS AND TIME COUNTERS (§3.106) — the two ENTRY-TIME facts core owes
 * the family, and the arithmetic behind one printed question.
 *
 * Echo (CR 702.30a), cumulative upkeep (702.24a), vanishing (702.63a), fading
 * (702.32a) and the printed "at the beginning of your upkeep, sacrifice ~ unless
 * you pay …" are all TRIGGERED abilities the cards package compiles from the
 * existing trigger vocabulary (`upkeep` + an intervening "if" + a pay-or-else
 * body). What none of them could get from a trigger alone is two things that
 * happen AS A PERMANENT ENTERS, which no resolving effect is around to record:
 *
 *  1. **"came under your control since the beginning of your last upkeep"** —
 *     echo's intervening "if". The permanent must remember WHEN it came under
 *     its controller's control: `CardInstance.controlledSinceTurn`, written by
 *     {@link markBattlefieldEntry} and {@link markControlChange}.
 *  2. **"enters with N time/fade counters"** — vanishing's and fading's first
 *     half, a CR 614.1c replacement on the entry: {@link applyEnteringCounters}.
 *
 * ## ONE helper, every entry path
 * Both are applied by {@link markBattlefieldEntry}, called from each of the
 * three places a permanent arrives on the battlefield — a resolving permanent
 * spell (engine.ts), a token being created (effects.ts) and `moveToZone`
 * (zones.ts: a land played, a card put onto the battlefield). That is the
 * `applyEnteringLoyalty` pattern and it is the whole reason these are helpers
 * rather than script entries: "~ enters with N +1/+1 counters" lives in the ETB
 * script, which only a CAST spell runs, so a reanimated Walking Ballista enters
 * with none. A reanimated Blastoderm entering with no fade counters would never
 * be sacrificed — a card playing STRONGER than printed, which biases an A/B
 * verdict exactly as badly as one playing weaker.
 *
 * ## The stamp is written only where it will be read
 * `controlledSinceTurn` goes on permanents whose definition ASKS the question
 * ({@link definitionTracksControlSince}: a trigger with the
 * `sourceControlledSinceLastUpkeep` intervening "if"). Every other permanent
 * keeps the object shape `cloneInstance` was measured on — an unconditional
 * extra property on every battlefield instance was the ~4% regression that
 * made `attachedTo` conditional (see clone.ts). The memo is per DEFINITION,
 * so a game full of echo-less creatures pays one WeakMap read per entry.
 */

import type { CardDefinition } from './card.js';
import type { GameEvent } from './events.js';
import type { CardInstance, GameState } from './state.js';
import { indexReplacements, replaceCounters } from './internal/replacement.js';

/** The counter kinds this family reads and writes, spelled once. */
export const TIME_COUNTER = 'time';
export const FADE_COUNTER = 'fade';
export const AGE_COUNTER = 'age';

/**
 * How many turns apart one player's upkeeps are. Turns alternate strictly in
 * this engine — CR 500.7 extra turns are classified not-applicable in the
 * rules manifest — so "the beginning of your LAST upkeep" is exactly this many
 * turns before the current one. If extra turns ever land, this constant is the
 * one place echo's clock is wound, and the manifest entry is the reminder.
 */
export const TURNS_BETWEEN_OWN_UPKEEPS = 2;

/** The intervening-"if" kind whose presence on a definition asks for the stamp. */
const CONTROL_SINCE_CONDITION = 'sourceControlledSinceLastUpkeep';

const TRACKS_CONTROL_MEMO = new WeakMap<CardDefinition, boolean>();

/**
 * Whether any trigger printed on this definition reads "came under your
 * control since the beginning of your last upkeep". Memoised per definition —
 * definitions are immutable and shared by every instance — so the per-entry
 * cost is a map read.
 */
export function definitionTracksControlSince(def: CardDefinition): boolean {
  const cached = TRACKS_CONTROL_MEMO.get(def);
  if (cached !== undefined) return cached;
  const triggers = def.triggers;
  let tracks = false;
  if (triggers !== undefined) {
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i]!.condition.intervening?.kind === CONTROL_SINCE_CONDITION) {
        tracks = true;
        break;
      }
    }
  }
  TRACKS_CONTROL_MEMO.set(def, tracks);
  return tracks;
}

/**
 * Record that `inst` has just come under its current controller's control by
 * ENTERING the battlefield, and put on the counters it enters with. The ONE
 * helper every battlefield-entry path calls — see the module header.
 */
export function markBattlefieldEntry(state: GameState, inst: CardInstance, emit: (e: GameEvent) => void): void {
  if (definitionTracksControlSince(inst.def)) inst.controlledSinceTurn = state.turnNumber;
  applyEnteringCounters(state, inst, emit);
}

/**
 * Record that `inst` has just come under a NEW controller's control while on
 * the battlefield (CR 702.30a counts a control change exactly as it counts an
 * entry). Called from the one control-change site in `internal/continuous.ts`,
 * in both directions — a stolen echo creature handed back at end of turn has
 * come under its owner's control again, and owes echo again.
 */
export function markControlChange(state: GameState, inst: CardInstance): void {
  if (definitionTracksControlSince(inst.def)) inst.controlledSinceTurn = state.turnNumber;
}

/**
 * Echo's question, asked at the beginning of the controller's upkeep: did this
 * permanent come under their control since the beginning of their LAST upkeep?
 *
 * The last upkeep was on the controller's previous turn ({@link
 * TURNS_BETWEEN_OWN_UPKEEPS} back), and "since its beginning" includes the rest
 * of that turn — the ordinary case, a creature cast in that turn's main phase.
 * Before a player's first upkeep there is no last upkeep at all, and a stamp
 * from any turn qualifies, which is the ruling for an echo permanent that
 * entered before its controller's first turn. A permanent with no stamp was
 * never asked and never owes — that is the honest inert default, not a card
 * silently getting a free turn, because the compiler stamps every definition
 * that prints the question.
 */
export function cameUnderControlSinceLastUpkeep(state: GameState, inst: CardInstance): boolean {
  const since = inst.controlledSinceTurn;
  if (since === undefined) return false;
  return since >= state.turnNumber - TURNS_BETWEEN_OWN_UPKEEPS;
}

/**
 * "This permanent enters with N [kind] counters on it" (CR 614.1c), through the
 * ONE counter-replacement site (`replaceCounters`), so Doubling Season doubles a
 * Blastoderm's fade counters exactly as it doubles a Ballista's +1/+1s.
 *
 * Emits the same `counterAdded` every other counter site emits. A replacement
 * that reduces the count to zero puts on nothing and says nothing, which is
 * what the printed replacement means.
 */
export function applyEnteringCounters(state: GameState, inst: CardInstance, emit: (e: GameEvent) => void): void {
  const entering = inst.def.entersWithCounters;
  if (entering === undefined || entering.length === 0) return;
  const replacements = indexReplacements(state);
  for (let i = 0; i < entering.length; i++) {
    const { kind, count } = entering[i]!;
    const magnitude = replaceCounters(state, replacements, inst, inst, kind, count, emit);
    if (magnitude <= 0) continue;
    // REPLACE the record, never write into it — see `CardInstance.counters`.
    inst.counters = { ...inst.counters, [kind]: (inst.counters[kind] ?? 0) + magnitude };
    emit({ type: 'counterAdded', instanceId: inst.instanceId, kind, amount: magnitude });
  }
}
