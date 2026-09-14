/**
 * HOLDING AN OPPONENT'S SPELL ON SCREEN (UX-16) — pure, DOM-free.
 *
 * Caleb, verbatim: *"when an opponent casts a sorcery or instant card, I need to
 * be able to see it and inspect the card before it goes off - even if I have no
 * instant-speed things I could do in response - just so I can see what they are
 * doing and understand! Right now, they just happen invisibly and I have no idea
 * why things are happening."*
 *
 * ## A HOLD IS NOT A STOP, and this module exists to keep them apart
 *
 * `shouldStopForPriority` returns false on `!ctx.hasAnyPlay`
 * (priority-stops.ts:156) and that is CORRECT: §3.119 removed the alternative on
 * purpose, because handing priority to a player who can do nothing is the bug
 * that made a hand with one instant in it cost a dozen confirmations a turn
 * (report 20260901_211359). Widening it to "…unless the opponent cast something"
 * would put a presentational question inside a rules-shaped predicate and would
 * reopen exactly that report.
 *
 * So a hold is a separate, purely presentational pause LAYERED ON TOP: the board
 * declines to auto-advance for a beat, shows the card, and then carries on. It
 * grants no priority, answers no question and changes no state — which is why it
 * is safe to skip entirely (see {@link HOLD_REFUSALS}) whenever it would get in
 * the way.
 *
 * ## Everything that can refuse a hold is a ROW
 *
 * A refusal is a first-class answer with a sentence attached, not a `return
 * null`: the debug bench renders the reason, and "why did it not pause?" is a
 * question a player will ask out loud. A shape not in {@link HOLD_KINDS} refuses
 * honestly rather than being widened to the nearest kind that exists.
 */
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import type { SpellHoldConfig } from './play-config.js';
import { STACK_ENTRY_KINDS, type StackEntryKind } from './stack-view.js';

/**
 * WHICH KINDS OF STACK OBJECT ARE WORTH A PAUSE. A mapped type over lane A's
 * own kind union (rule 12: one vocabulary, not two), so a fourth kind in
 * `stack-view.ts` stops the build here until somebody decides.
 */
export const HOLD_KINDS: {
  readonly [K in StackEntryKind]: {
    readonly holds: boolean;
    /** How the announce card words what the opponent is doing. */
    readonly announce: string;
    readonly why: string;
  };
} = Object.freeze({
  spell: Object.freeze({
    holds: true,
    announce: 'is casting',
    why: 'The reported case, verbatim: an opponent’s instant or sorcery resolves invisibly and the player cannot tell why the board changed.',
  }),
  activated: Object.freeze({
    holds: true,
    announce: 'is activating',
    why: 'An activated ability is a deliberate opponent ACTION with a source card to show, and it is exactly as invisible as a spell — the equipment that just moved, the walker that just ticked.',
  }),
  trigger: Object.freeze({
    holds: false,
    // Worded anyway rather than left empty: the row must stay renderable if the
    // `holds` flag is ever flipped, and a blank string is a trap for that day.
    announce: 'has a trigger',
    why: 'A trigger is not something the opponent chose to do this instant, and upkeep/attack/ETB triggers fire several times a turn — holding them would turn every turn into a slideshow, which is the click-through tax UX-16 must not become.',
  }),
});

/** Why a hold did not fire. CLOSED — each row carries the sentence the UI shows. */
export const HOLD_REFUSALS = Object.freeze({
  nothingOnStack: 'Nothing is waiting to resolve.',
  yourOwnObject: 'You put this on the stack yourself, so you already know what it is.',
  kindNotHeld: 'This kind of stack object is not held (see HOLD_KINDS).',
  alreadyAnnounced: 'This object has already been shown once.',
  alreadyStopping: 'You are being given priority here anyway, so the board is not going anywhere.',
  turnBudgetSpent: 'Too many holds already this turn — the rest resolve at full speed and the action feed reports them.',
  gameOver: 'The game is over — nothing left on the stack will resolve.',
});
export type HoldRefusal = keyof typeof HOLD_REFUSALS;

/** The top of the stack, reduced to the three facts the rule reads. */
export interface HoldCandidate {
  readonly instanceId: InstanceId;
  readonly controller: PlayerId;
  readonly kind: StackEntryKind;
}

/** Everything the rule needs. All of it is already in the board's hands. */
export interface SpellHoldContext {
  readonly viewer: PlayerId;
  /** The object that resolves NEXT, or null for an empty stack. */
  readonly stackTop: HoldCandidate | null;
  /**
   * True when `shouldStopForPriority` is already going to hand the viewer
   * priority in this window. A hold on top of a stop is a pause on top of a
   * pause: the player is looking at the board with a decision to make, and the
   * card is already on the stack panel in front of them.
   */
  readonly viewerWillStop: boolean;
  /** Objects already held once this game — a hold fires ONCE per object. */
  readonly announced: ReadonlySet<InstanceId>;
  /** How many holds this turn has already spent (see `maxHoldsPerTurn`). */
  readonly holdsThisTurn: number;
  readonly gameOver: boolean;
}

/** A hold that is actually happening. */
export interface SpellHold {
  readonly instanceId: InstanceId;
  readonly controller: PlayerId;
  readonly kind: StackEntryKind;
}

export type HoldDecision =
  | { readonly kind: 'hold'; readonly hold: SpellHold }
  | { readonly kind: 'refused'; readonly reason: HoldRefusal; readonly detail: string };

/**
 * Should the board pause on what is on top of the stack?
 *
 * Order matters only for which SENTENCE a refusal gives, never for the verdict:
 * the cheapest and most explanatory reason is reported first, because "nothing
 * is on the stack" is a better answer than "you have already seen it".
 */
export function spellHoldDecision(ctx: SpellHoldContext, cfg: SpellHoldConfig): HoldDecision {
  const refuse = (reason: HoldRefusal): HoldDecision => ({
    kind: 'refused',
    reason,
    detail: HOLD_REFUSALS[reason],
  });
  if (ctx.gameOver) return refuse('gameOver');
  const top = ctx.stackTop;
  if (top === null) return refuse('nothingOnStack');
  if (top.controller === ctx.viewer) return refuse('yourOwnObject');
  if (!HOLD_KINDS[top.kind].holds) return refuse('kindNotHeld');
  if (ctx.announced.has(top.instanceId)) return refuse('alreadyAnnounced');
  if (ctx.viewerWillStop) return refuse('alreadyStopping');
  if (ctx.holdsThisTurn >= cfg.maxHoldsPerTurn) return refuse('turnBudgetSpent');
  return {
    kind: 'hold',
    hold: { instanceId: top.instanceId, controller: top.controller, kind: top.kind },
  };
}

/** How long the hold currently on screen should last. */
export interface HoldPressure {
  /**
   * The pointer is over the held card — the player has SAID they are reading
   * it, so the beat becomes a pause. Bounded by `pointerHoldMs`, never
   * infinite: a pointer resting on the announce card must not freeze the game.
   */
  readonly pointerOver: boolean;
  /** How many times "Keep looking" has been pressed for THIS hold. */
  readonly extensions: number;
}

/** A fresh hold: nobody is reading it yet. Shared, so arming one allocates nothing. */
export const NO_HOLD_PRESSURE: HoldPressure = Object.freeze({ pointerOver: false, extensions: 0 });

/** The player pressed "keep looking" once more. */
export function extendPressure(pressure: HoldPressure): HoldPressure {
  return { ...pressure, extensions: pressure.extensions + 1 };
}

/** The pointer moved onto or off the held card. */
export function pointerPressure(pressure: HoldPressure, over: boolean): HoldPressure {
  return pressure.pointerOver === over ? pressure : { ...pressure, pointerOver: over };
}

/**
 * The hold's total lifetime, in ms.
 *
 * Two inputs, one number, no hidden ceiling: the pointer swaps the base
 * duration for the longer bounded one (`pointerHoldMs > holdMs` is pinned by
 * lane F's config test), and each explicit press adds `extendMs`. Presses are
 * deliberately NOT capped — a player who keeps pressing a button is not a
 * runaway timer, and the config's bounded-ness clause is about the POINTER,
 * which is a state a player can enter by accident.
 */
export function holdDurationMs(pressure: HoldPressure, cfg: SpellHoldConfig): number {
  const base = pressure.pointerOver ? cfg.pointerHoldMs : cfg.holdMs;
  return base + cfg.extendMs * Math.max(0, pressure.extensions);
}

/** Every kind, for a bench or a test that wants to enumerate them. */
export const HELD_STACK_KINDS: readonly StackEntryKind[] = Object.freeze(
  STACK_ENTRY_KINDS.filter((k) => HOLD_KINDS[k].holds),
);
