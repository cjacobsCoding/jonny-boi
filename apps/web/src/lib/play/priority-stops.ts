/**
 * PRIORITY STOPS — the Arena-style rule for WHEN the board pauses to offer the
 * player priority, and when it passes for them (pure, DOM-free, unit-tested).
 *
 * Bug reports 20260901_211359 ("How do we make playing with an Instant card in
 * hand less obnoxious? It's awful having to continually click on pass/advance"),
 * 20260901_212245 (a Thragtusk whose life-gain trigger sat on the stack, unseen,
 * waiting for a pass) and 20260901_213414 (an Angel of Serenity "swallowed" — on
 * the stack, likewise). All three are one rule: `hasMeaningfulChoice` treated an
 * instant in hand as a reason to stop in EVERY priority window of every step of
 * both turns, so a player holding Cloudshift was asked to pass a dozen times a
 * turn — including through their own triggers, which then looked stuck.
 *
 * The rule here is the one every digital client converges on:
 *  - a REAL DECISION always stops (a parked question, an attack or block
 *    declaration the engine is offering);
 *  - a window in which the player can do NOTHING never stops (as before);
 *  - otherwise the player has an instant-speed play, and whether that is worth
 *    a stop depends on WHERE we are: a table of per-step stops, split by whose
 *    turn it is; a stop for an OPPONENT's spell or ability on the stack (the
 *    classic "respond?" moment); a stop for the player's OWN stack objects
 *    (off by default — your own trigger resolves without asking); and a
 *    FULL CONTROL override that stops everywhere, for the turn you want it.
 *
 * Every default is a ROW in {@link STEP_STOPS}, not a branch, so the stops
 * menu, the rule and the persisted preference all read one table.
 */
import type { PlayerId, Step } from '@jonny-boi/core';

/** Whose turn a step-stop row applies to. */
export type TurnSide = 'mine' | 'theirs';

/** The key a step stop is stored under: `<side>:<step>`. */
export type StepStopKey = `${TurnSide}:${Step}`;

/** One row of the stops table. */
export interface StepStopRow {
  readonly key: StepStopKey;
  readonly side: TurnSide;
  readonly step: Step;
  /** The label the stops menu shows. */
  readonly label: string;
  /** Whether the stop is on when the player has never touched the menu. */
  readonly defaultOn: boolean;
}

/**
 * The steps a player may stop in, in turn order, for each side. The defaults
 * are the ones that make holding an instant PLEASANT rather than exhausting:
 * your own main phases and attack step (where you act at sorcery speed anyway),
 * their declare-blockers step (where you block) and their end step (the
 * instant-speed window every deck wants). Everything else passes unless the
 * stack holds something worth a response (see `stopOnOpponentStack`).
 *
 * Untap and cleanup are absent: the engine grants no priority in them.
 */
export const STEP_STOPS: readonly StepStopRow[] = Object.freeze([
  { key: 'mine:upkeep', side: 'mine', step: 'upkeep', label: 'Upkeep', defaultOn: false },
  { key: 'mine:draw', side: 'mine', step: 'draw', label: 'Draw', defaultOn: false },
  { key: 'mine:precombatMain', side: 'mine', step: 'precombatMain', label: 'Main 1', defaultOn: true },
  { key: 'mine:beginCombat', side: 'mine', step: 'beginCombat', label: 'Begin combat', defaultOn: false },
  { key: 'mine:declareAttackers', side: 'mine', step: 'declareAttackers', label: 'Attackers', defaultOn: true },
  { key: 'mine:declareBlockers', side: 'mine', step: 'declareBlockers', label: 'Blockers', defaultOn: false },
  { key: 'mine:combatDamage', side: 'mine', step: 'combatDamage', label: 'Damage', defaultOn: false },
  { key: 'mine:endCombat', side: 'mine', step: 'endCombat', label: 'End combat', defaultOn: false },
  { key: 'mine:postcombatMain', side: 'mine', step: 'postcombatMain', label: 'Main 2', defaultOn: true },
  { key: 'mine:end', side: 'mine', step: 'end', label: 'End step', defaultOn: false },
  { key: 'theirs:upkeep', side: 'theirs', step: 'upkeep', label: 'Upkeep', defaultOn: false },
  { key: 'theirs:draw', side: 'theirs', step: 'draw', label: 'Draw', defaultOn: false },
  { key: 'theirs:precombatMain', side: 'theirs', step: 'precombatMain', label: 'Main 1', defaultOn: false },
  { key: 'theirs:beginCombat', side: 'theirs', step: 'beginCombat', label: 'Begin combat', defaultOn: false },
  { key: 'theirs:declareAttackers', side: 'theirs', step: 'declareAttackers', label: 'Attackers', defaultOn: false },
  { key: 'theirs:declareBlockers', side: 'theirs', step: 'declareBlockers', label: 'Blockers', defaultOn: true },
  { key: 'theirs:combatDamage', side: 'theirs', step: 'combatDamage', label: 'Damage', defaultOn: false },
  { key: 'theirs:endCombat', side: 'theirs', step: 'endCombat', label: 'End combat', defaultOn: false },
  { key: 'theirs:postcombatMain', side: 'theirs', step: 'postcombatMain', label: 'Main 2', defaultOn: false },
  { key: 'theirs:end', side: 'theirs', step: 'end', label: 'End step', defaultOn: true },
]);

/** The player's stops, as persisted and as the rule reads them. */
export interface PriorityStops {
  /** Per-step stops (absent key ⇒ the row's default). */
  readonly steps: Readonly<Partial<Record<StepStopKey, boolean>>>;
  /** Stop when an OPPONENT's spell or ability is on the stack and you could respond. */
  readonly stopOnOpponentStack: boolean;
  /** Stop when your OWN spell or trigger is on the stack (to respond to yourself). */
  readonly stopOnOwnStack: boolean;
  /** Full control: stop in every window where you could do anything at all. */
  readonly fullControl: boolean;
}

/** The out-of-the-box stops: every row's default, respond to theirs, not to yours. */
export const DEFAULT_PRIORITY_STOPS: PriorityStops = Object.freeze({
  steps: Object.freeze({}),
  stopOnOpponentStack: true,
  stopOnOwnStack: false,
  fullControl: false,
});

/** Whether a step stop is on, honouring the row's default when unset. */
export function stepStopIsOn(stops: PriorityStops, key: StepStopKey): boolean {
  const explicit = stops.steps[key];
  if (explicit !== undefined) return explicit;
  return STEP_STOPS.find((row) => row.key === key)?.defaultOn ?? false;
}

/** The stops with one step toggled. */
export function withStepStop(stops: PriorityStops, key: StepStopKey, on: boolean): PriorityStops {
  return { ...stops, steps: { ...stops.steps, [key]: on } };
}

/** The stop key for a step from the priority-holder's point of view. */
export function stepStopKeyFor(step: Step, activePlayer: PlayerId, holder: PlayerId): StepStopKey {
  return `${activePlayer === holder ? 'mine' : 'theirs'}:${step}`;
}

/** What the rule needs to know about one priority window. */
export interface StopContext {
  readonly step: Step;
  readonly activePlayer: PlayerId;
  /** The seat holding priority — the one this window is for. */
  readonly holder: PlayerId;
  /** A parked question addressed to the holder. Always a stop. */
  readonly pendingChoice: boolean;
  /** The engine is offering an attack or block declaration. Always a stop. */
  readonly offersDeclaration: boolean;
  /** The holder could play a land or cast/activate SOMETHING (any speed). */
  readonly hasAnyPlay: boolean;
  /** The holder has an instant-speed play (see `GameSession.canRespond`). */
  readonly canRespond: boolean;
  /** Who controls the top of the stack, or null when it is empty. */
  readonly stackTopController: PlayerId | null;
  /**
   * §3.129 — the holder has an instant-speed response that legally AIMS AT one
   * of their OWN objects on the stack (an untapped Strionic Resonator with a
   * trigger to copy). This is what makes such a card usable out of the box: a
   * stop over your own stack is worth taking only when you can actually act on
   * it, so the default resolves your ordinary triggers silently yet pauses the
   * one turn you can copy one. `stopOnOwnStack` remains the manual override for
   * pausing over EVERY own object, response or not.
   */
  readonly canRespondToOwnStack: boolean;
}

/**
 * Should the board STOP and hand the holder priority in this window?
 *
 * Order matters and is the whole design: decisions first (never skipped),
 * then "nothing to do" (never stopped), then full control, then the stack
 * (a response window is about WHAT is on the stack, not which step it is),
 * and only then the per-step table.
 */
export function shouldStopForPriority(ctx: StopContext, stops: PriorityStops): boolean {
  if (ctx.pendingChoice) return true;
  if (ctx.offersDeclaration) return true;
  if (!ctx.hasAnyPlay) return false;
  if (stops.fullControl) return true;
  if (ctx.stackTopController !== null) {
    // Only a RESPONSE matters here: a sorcery in hand cannot be cast over a
    // stack, so stopping would offer nothing but the pass button.
    if (!ctx.canRespond) return false;
    if (ctx.stackTopController === ctx.holder) {
      // Your own stack: pause when you have a response that aims at it (§3.129 —
      // Strionic Resonator works by default), or when you asked to always pause.
      return stops.stopOnOwnStack || ctx.canRespondToOwnStack;
    }
    return stops.stopOnOpponentStack;
  }
  const key = stepStopKeyFor(ctx.step, ctx.activePlayer, ctx.holder);
  const stepOn = stepStopIsOn(stops, key);
  if (!stepOn) return false;
  // A main-phase stop is worth taking for ANY play (lands, creatures); every
  // other step is instant-speed only, so a stop there needs a response to offer.
  const isOwnMain =
    ctx.activePlayer === ctx.holder && (ctx.step === 'precombatMain' || ctx.step === 'postcombatMain');
  return isOwnMain ? ctx.hasAnyPlay : ctx.canRespond;
}
