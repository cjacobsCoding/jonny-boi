/**
 * The mulligan screens' COPY (pure, unit-tested) — §3.119, bug report
 * 20260901_212439: "I thought Mulligan was scry? Which means choose to leave on
 * top or put on bottom? This just says put on bottom."
 *
 * The rule the app plays is the LONDON mulligan (CR 103.5): you always draw a
 * full hand, and if you keep after N mulligans you put N cards of your choice
 * on the bottom of your library. That is not the Vancouver "scry 1" the player
 * remembered, and a screen that only said "put on the bottom" left them to
 * guess which rule they were playing. So the rule is NAMED, in every phase and
 * on both the human's screen and the computer's, from this one table.
 */

/** The rule line shown above every mulligan decision. */
export const LONDON_MULLIGAN_RULE =
  'London mulligan: draw a full hand of seven; if you keep after mulliganing, put one card per mulligan on the bottom of your library.';

export interface MulliganCopyContext {
  readonly handSize: number;
  readonly mulligansTaken: number;
  /** Deciding keep-or-mulligan, or choosing which cards go to the bottom. */
  readonly phase: 'choose' | 'bottom';
  readonly selectedCount: number;
}

export interface MulliganCopy {
  /** The rule, always the same line. */
  readonly rule: string;
  /** Where the player is in the decision. */
  readonly status: string;
  readonly keepButton: string;
  readonly mulliganButton: string;
  readonly confirmButton: string;
}

function cards(n: number): string {
  return `${n} card${n === 1 ? '' : 's'}`;
}

/** The human mulligan screen's copy for one moment of the decision. */
export function mulliganCopy(ctx: MulliganCopyContext): MulliganCopy {
  const mustBottom = ctx.mulligansTaken;
  const kept = ctx.handSize - mustBottom;
  const status =
    ctx.mulligansTaken === 0
      ? 'Your opening hand. Keep it, or mulligan for a fresh seven.'
      : ctx.phase === 'bottom'
        ? `Mulligan ${ctx.mulligansTaken} — choose ${cards(mustBottom)} to put on the bottom of your library (${ctx.selectedCount}/${mustBottom}). The rest stay in your hand.`
        : `Mulligan ${ctx.mulligansTaken} — a fresh seven. If you keep, you'll put ${cards(mustBottom)} of your choice on the bottom, keeping ${kept}.`;
  return {
    rule: LONDON_MULLIGAN_RULE,
    status,
    keepButton: `Keep (${cards(kept)})`,
    mulliganButton: 'Mulligan (redraw seven)',
    confirmButton: `Put ${cards(mustBottom)} on the bottom and keep`,
  };
}

/** The computer's mulligan screen: what it is doing, and under which rule. */
export function aiMulliganCopy(name: string): { readonly title: string; readonly rule: string } {
  return {
    title: `${name} is looking at their opening hand…`,
    rule: LONDON_MULLIGAN_RULE,
  };
}
