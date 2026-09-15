/**
 * "Always let me choose which mana pays" — the persisted player preference
 * behind the §3.60 mana picker, and the pure rule that decides when the picker
 * should actually open.
 *
 * Two halves, deliberately split:
 *  - the STORED preference, which is a per-player setting that outlives a game
 *    (localStorage, like the deck list — not the resume record, which is one
 *    game's state);
 *  - {@link shouldAskForMana}, the pure predicate the board consults. It is a
 *    function rather than a boolean read because the setting alone is not the
 *    answer: a player who asked to choose still must not be interrupted for a
 *    payment with nothing to choose about.
 *
 * Storage is best-effort in both directions (a private window, a full quota, a
 * browser with site data blocked): a failed read is "off", a failed write is a
 * warning, and neither can white-screen a game in progress.
 */
import { MANA_CHOICE_STORAGE_KEY } from '../config.js';
import { writeStorage } from '../persistence/write.js';

/** The default: auto-tap, exactly as the board behaved before §3.60. */
export const MANA_CHOICE_DEFAULT = false;

/** Read the stored "always let me choose my mana" preference. */
export function loadManaChoicePref(): boolean {
  try {
    const raw = localStorage.getItem(MANA_CHOICE_STORAGE_KEY);
    if (raw === null) return MANA_CHOICE_DEFAULT;
    return raw === 'true';
  } catch {
    return MANA_CHOICE_DEFAULT;
  }
}

/** Persist the preference. `quiet`: losing a checkbox costs the user one click. */
export function saveManaChoicePref(always: boolean): void {
  writeStorage('pref-mana-choice', MANA_CHOICE_STORAGE_KEY, always ? 'true' : 'false', {
    quiet: true,
  });
}

/** What the board knows when it is deciding whether to open the picker. */
export interface ManaAskContext {
  /** The stored "always let me choose" preference. */
  readonly always: boolean;
  /** This cast asked for the picker explicitly (the per-cast way in). */
  readonly requested: boolean;
  /**
   * Whether more than one meaningfully different set of sources could fund this
   * payment — core's `manaPaymentChoiceExists`. FALSE also covers "the pool
   * already pays" and "this cannot be paid at all", both of which must never
   * open a picker.
   */
  readonly choiceExists: boolean;
}

/**
 * Should the mana picker open for this cast?
 *
 * `choiceExists` is a HARD gate on both routes, including the explicit per-cast
 * request: opening a picker that offers one button is worse than not opening it,
 * and it is exactly how a helpful prompt becomes the thing people switch off.
 * A player who wants to place mana by hand anyway can still tap sources on the
 * board before casting — that affordance predates this one and is untouched.
 */
export function shouldAskForMana(context: ManaAskContext): boolean {
  if (!context.choiceExists) return false;
  return context.always || context.requested;
}
