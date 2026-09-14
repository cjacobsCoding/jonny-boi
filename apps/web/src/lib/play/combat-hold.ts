/**
 * HOLDING COMBAT ON SCREEN (§10 of docs/MTGA-UX-OVERHAUL.md) — pure, DOM-free.
 *
 * Caleb, verbatim: *"Animations when block phase is over and damage is being
 * distributed to players and creatures, just like MTGA does it, **so you can
 * clearly see what's happening**."*
 *
 * ## The measurement this module exists for
 *
 * UX-13 (the blocker walks out to meet its attacker) and UX-15 (damage travels
 * from source to recipient) were both built, both unit-tested, and neither had
 * ever been SEEN. A rig drove a real game to a real blocked combat and sampled
 * 260 ms after "Confirm 1 block", without passing priority:
 *
 * ```
 * BLOCKS CONFIRMED | blocking=0 staged=0 arcs=0 | Turn 7 · Main Phase 1
 * ```
 *
 * Blocks, combat damage and end-of-combat had all resolved and the turn had
 * advanced, with no input at all. The code that draws the advance is correct —
 * `PlayBoard`'s `stageEntries` gates it on `combat.blockersDeclared`, exactly as
 * the rules say — but `state.combat` is cleared again before a human eye, or a
 * 45 ms sampler, can catch it.
 *
 * ## A HOLD IS NOT A STOP — the same distinction UX-16 drew, for the same reason
 *
 * `spell-hold.ts` solved this identical problem for an opponent's spell and this
 * module is built in its image. A hold grants no priority, answers no question
 * and changes no state: it is a presentational pause LAYERED ON TOP of the
 * priority walk. `shouldStopForPriority` is a rules-shaped predicate and stays
 * one; widening it with "…unless combat just happened" would put a presentation
 * question inside it and re-open report 20260901_211359.
 *
 * ## ⚠️ WHAT MAKES IT A PAUSE RATHER THAN A DECORATION
 *
 * The state this board renders from is GONE a frame later, so a timer that only
 * delays a CSS class changes nothing. The hold therefore gates the two things
 * that move the game on their own — `autoAdvancePriority` and the AI seat (see
 * `PlayView.tsx`) — and the auto-passer is gated at its `shouldStop` predicate,
 * not only by an effect-level early return: `autoAdvancePriority` walks MANY
 * windows inside ONE effect, so a gate outside the loop cannot stop it partway
 * and the board would still be looking at Main Phase 1 of the next turn.
 *
 * ## Everything that can hold, or refuse to, is a ROW
 *
 * {@link COMBAT_HOLD_KINDS} is closed: a combat window not in the table refuses
 * honestly with a sentence attached rather than being widened to the nearest
 * beat that happens to exist, and a refusal is a first-class answer the debug
 * bench can render, because "why did it not pause?" is a question a player asks
 * out loud.
 *
 * ## The rules, the log and the replay are untouched
 *
 * Nothing here is imported by `packages/core`, `packages/sim` or the headless
 * harness, and nothing here can be: the decision is a function of the board's
 * already-rendered facts and its output is a number of milliseconds a *browser*
 * waits before calling `passPriority`. A sim running thousands of games never
 * constructs one, and a replay re-derives the identical state from the identical
 * log whether or not anybody watched it happen.
 */
import type { CombatState, Step } from '@jonny-boi/core';
import type { CombatHoldConfig } from './play-config.js';

/**
 * WHICH MOMENTS OF COMBAT ARE WORTH A PAUSE, what each one is called on screen,
 * and WHICH beat it spends.
 *
 * `beat` names the two config keys rather than carrying numbers, so the
 * blocks-declared beat and the damage beat can never be swapped by accident —
 * the same device `STAGE_ROLE_RULES.fractionOf` uses in `combat-stage.ts`. The
 * key type is `keyof CombatHoldConfig`, so deleting or renaming a beat in
 * `play-config.ts` stops the build here rather than resolving to `undefined` at
 * runtime.
 */
export const COMBAT_HOLD_KINDS: {
  readonly [K in CombatHoldKind]: {
    /** Which configured beat this kind spends, with and without reduced motion. */
    readonly beat: {
      readonly full: keyof CombatHoldConfig;
      readonly reducedMotion: keyof CombatHoldConfig;
    };
    /** What the board calls this pause while it is showing. */
    readonly label: string;
    /** What the player is being given time to look at. */
    readonly shows: string;
    readonly why: string;
    /**
     * Is this the window? Reads only facts the board already has on screen —
     * core's own step and its own combat state — so this module never re-derives
     * a rules question somebody else already answered (rule 12).
     */
    readonly applies: (window: CombatWindow) => boolean;
  };
} = Object.freeze({
  blocksDeclared: Object.freeze({
    beat: Object.freeze({
      full: 'blocksDeclaredMs' as const,
      reducedMotion: 'reducedMotionBlocksDeclaredMs' as const,
    }),
    label: 'Blockers declared',
    shows: 'who is blocking whom',
    why: 'UX-13: the blocker walks out to MEET its attacker (CR 509.1a) and the pair gets its arc. The advance is computed the moment `blockersDeclared` flips and is gone on the next pass — this is the beat that makes it a picture instead of a frame nobody rendered.',
    applies: (w: CombatWindow) =>
      w.step === 'declareBlockers' && w.combat !== null && w.combat.blockersDeclared && w.combat.blockCount > 0,
  }),
  damage: Object.freeze({
    beat: Object.freeze({
      full: 'damageMs' as const,
      reducedMotion: 'reducedMotionDamageMs' as const,
    }),
    label: 'Combat damage',
    shows: 'damage travelling to each creature and player',
    why: 'UX-15: combat damage is dealt on ENTERING this step (CR 510.1-2, engine.ts `performStepTurnBasedActions`), and priority is granted immediately afterward. Without a beat here the whole sequence is derived, mounted and walked past inside one effect.',
    applies: (w: CombatWindow) => w.step === 'combatDamage' && w.combat !== null && w.combat.attackerCount > 0,
  }),
});

/** The kinds of combat pause. CLOSED — a third moment is a ROW, not a branch. */
export type CombatHoldKind = 'blocksDeclared' | 'damage';

/**
 * The order the rows are tried in, which is simply the order combat happens in.
 * Explicit rather than `Object.keys`, because "the first row that applies wins"
 * is a rule and a rule may not depend on property-insertion order.
 */
export const COMBAT_HOLD_KIND_ORDER: readonly CombatHoldKind[] = Object.freeze([
  'blocksDeclared',
  'damage',
]);

/** Why a hold did not fire. CLOSED — each row carries the sentence the UI shows. */
export const COMBAT_HOLD_REFUSALS = Object.freeze({
  gameOver: 'The game is over — there is no combat left to watch.',
  notACombatBeat:
    'This is not a moment combat shows anything new (see COMBAT_HOLD_KINDS): no blocks were declared, or nothing is in combat.',
  alreadyHeld: 'This combat has already had this beat — the rest of it runs at full speed.',
  beatDisabled:
    'The beat for this moment is configured to zero, so the board does not pause here at all.',
});
export type CombatHoldRefusal = keyof typeof COMBAT_HOLD_REFUSALS;

/**
 * Core's combat state, reduced to the three facts the rows read.
 *
 * Counts rather than the arrays themselves: this module decides WHETHER to
 * pause, never what to paint, and a count cannot be mistaken for the
 * declaration. `blockCount` is the number of DECLARED blocks — a combat where
 * the defender took it on the chin has none, and there is no advance to show.
 *
 * There is no `attackersDeclared` flag here because `attackerCount > 0` already
 * implies it: core only fills `combat.attackers` in `commitAttackDeclaration`.
 * A second field saying the same thing is a second answer to one question.
 */
export interface CombatWindowFacts {
  readonly blockersDeclared: boolean;
  readonly attackerCount: number;
  readonly blockCount: number;
}

/** The step + combat pair a row is asked about. */
export interface CombatWindow {
  readonly step: Step;
  readonly combat: CombatWindowFacts | null;
}

/**
 * THE one adapter from core's combat state to {@link CombatWindowFacts}, so
 * "how many blocks are declared?" is answered in exactly one place.
 *
 * It lives HERE rather than in a `*-session.ts` sibling (the shape
 * `stopContextFor` uses) because it needs nothing but plain state: no legal
 * actions, no session derivations, no DOM. Keeping it pure is what lets the
 * decision and its adapter be tested together in Node.
 */
export function combatWindowFactsOf(combat: CombatState | null): CombatWindowFacts | null {
  if (combat === null) return null;
  return {
    blockersDeclared: combat.blockersDeclared,
    attackerCount: combat.attackers.length,
    blockCount: Object.keys(combat.blocks).length,
  };
}

/** Everything the rule needs. All of it is already in the board's hands. */
export interface CombatHoldContext extends CombatWindow {
  /**
   * Beats this COMBAT has already spent. A beat fires once per combat — the
   * game passes back through `declareBlockers` on every priority pass, and a
   * hold that re-armed each time would never let the step end.
   *
   * Scoped to the combat by the caller (one combat per turn: `STEP_ORDER` has a
   * single combat phase), the same way `spell-hold.ts` scopes its per-turn
   * budget.
   */
  readonly spent: ReadonlySet<CombatHoldKind>;
  /**
   * The viewer asked for reduced motion. Selects the row's OTHER beat rather
   * than switching the hold off — the same shape `BOARD_3D_CONFIG` uses for the
   * tilt, where reduced motion flattens an ANGLE instead of flipping a boolean,
   * so a designer can retune the quiet case without a code change.
   */
  readonly reducedMotion: boolean;
  readonly gameOver: boolean;
}

/** A pause that is actually happening. */
export interface CombatHold {
  readonly kind: CombatHoldKind;
  /** What the board calls it while it is showing (from the row, never re-worded). */
  readonly label: string;
  /** How long it lasts, ms. Always > 0 — a zero beat is refused, not armed. */
  readonly ms: number;
}

export type CombatHoldDecision =
  | { readonly kind: 'hold'; readonly hold: CombatHold }
  | { readonly kind: 'refused'; readonly reason: CombatHoldRefusal; readonly detail: string };

/**
 * How long a given beat lasts for this viewer. The one place the reduced-motion
 * swap happens, so no consumer has to know there are two numbers.
 */
export function combatHoldMs(
  kind: CombatHoldKind,
  cfg: CombatHoldConfig,
  reducedMotion: boolean,
): number {
  const { beat } = COMBAT_HOLD_KINDS[kind];
  return cfg[reducedMotion ? beat.reducedMotion : beat.full];
}

/**
 * Should the board pause on this moment of combat?
 *
 * Order matters only for which SENTENCE a refusal gives, never for the verdict:
 * the cheapest and most explanatory reason is reported first, because "the game
 * is over" is a better answer than "nothing is in combat".
 */
export function combatHoldDecision(
  ctx: CombatHoldContext,
  cfg: CombatHoldConfig,
): CombatHoldDecision {
  const refuse = (reason: CombatHoldRefusal): CombatHoldDecision => ({
    kind: 'refused',
    reason,
    detail: COMBAT_HOLD_REFUSALS[reason],
  });
  if (ctx.gameOver) return refuse('gameOver');
  const kind = COMBAT_HOLD_KIND_ORDER.find((candidate) =>
    COMBAT_HOLD_KINDS[candidate].applies(ctx),
  );
  if (kind === undefined) return refuse('notACombatBeat');
  if (ctx.spent.has(kind)) return refuse('alreadyHeld');
  const ms = combatHoldMs(kind, cfg, ctx.reducedMotion);
  // A beat a designer has turned off is a REFUSAL with a reason, not a hold of
  // zero milliseconds: a hold that is already over the moment it is armed would
  // still gate the walker for one render and would still have to be released.
  if (!(ms > 0)) return refuse('beatDisabled');
  return { kind: 'hold', hold: { kind, label: COMBAT_HOLD_KINDS[kind].label, ms } };
}
