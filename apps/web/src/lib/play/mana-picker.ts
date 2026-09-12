/**
 * THE MANA PICKER — the pure half (DOM-free, unit-tested) of "let me choose
 * which mana pays" (§3.60).
 *
 * The report: *"There should also be an easy way to make the game have you
 * specify which mana to use when you actually have unique options."* Auto-tap
 * answers "fund this spell"; the picker answers "fund it with THESE". This
 * module owns the two things the prompt has to get right — what is still owed,
 * and how each source's row reads — and owns neither the React state nor the
 * session threading, which live in the board.
 *
 * The rows follow the §3.57 label conventions (`option-labels.ts`): every row
 * carries its OWNER from the chooser's point of view, so the picker reads like
 * every other picker in the game rather than like a second dialect.
 */
import {
  formatManaCost,
  isColorComponent,
  isGenericComponent,
  isLifeComponent,
  MANA_COLORS,
  type HybridComponent,
  type ManaColor,
  type ManaCost,
  type ManaPool,
} from '@jonny-boi/core';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import { ownerLabel } from './option-labels.js';
import type { ManaTapOption } from './mana-tap.js';

/**
 * What `cost` still owes after `pool` pays what it can — the picker's live
 * "still needed" readout.
 *
 * ⚠️ DISPLAY ONLY, and the distinction matters. This mirrors `payCost`'s order
 * (each colour pays its own pips, then whatever is spare pays the generic), but
 * the engine's `canPay` is the authority on whether the cost is actually
 * payable, and the Confirm button is gated on THAT. A second opinion driving a
 * real decision is exactly the drift `mana-plan.ts`'s header warns about; a
 * second opinion driving a label is a label.
 *
 * `lifeSpend` is the life the CAST has already committed to this cost's
 * Phyrexian symbols (§3.143) — the reading the player picked. Without it the
 * readout for "Dismember, {1} and 4 life" would go on demanding {B}{B} the cast
 * is never going to charge, and the row would still say "Still needed" after the
 * last land was tapped.
 */
export function manaStillNeeded(pool: ManaPool, cost: ManaCost, lifeSpend = 0): ManaCost {
  const spare: Partial<Record<ManaColor, number>> = {};
  // Built mutable and handed back as the readonly `ManaCost` it is — the record
  // never escapes this function under a writable type.
  const owed: { -readonly [K in keyof ManaCost]: ManaCost[K] } = {};
  for (const color of MANA_COLORS) {
    const need = cost[color] ?? 0;
    const have = pool[color] ?? 0;
    if (have < need) owed[color] = need - have;
    else spare[color] = have - need;
  }
  // Each hybrid symbol is settled by ONE of its printed alternatives, tried in
  // the order this payment would actually use them: the life price first while
  // the chosen reading still has life to give (that is what the player bought
  // with it), then a colour that has spare mana, then the `{2}` half of a
  // `{2/W}` — which is not "paid" here so much as FOLDED into the generic pile
  // below, exactly as core's own payment search folds it. A symbol no
  // alternative can settle stays owed and prints as itself.
  let lifeLeft = lifeSpend;
  let foldedGeneric = 0;
  const hybridOwed: (readonly HybridComponent[])[] = [];
  for (const symbol of cost.hybrid ?? []) {
    const life = symbol.find(isLifeComponent);
    if (life !== undefined && life.life <= lifeLeft) {
      lifeLeft -= life.life;
      continue;
    }
    const payer = symbol.find(
      (component): component is ManaColor => isColorComponent(component) && (spare[component] ?? 0) > 0,
    );
    if (payer !== undefined) {
      spare[payer] = (spare[payer] ?? 0) - 1;
      continue;
    }
    const generic = symbol.find(isGenericComponent);
    if (generic !== undefined) {
      foldedGeneric += generic.generic;
      continue;
    }
    hybridOwed.push(symbol);
  }
  if (hybridOwed.length > 0) owed.hybrid = hybridOwed;
  let generic = (cost.generic ?? 0) + foldedGeneric;
  for (const color of MANA_COLORS) {
    if (generic === 0) break;
    const available = spare[color] ?? 0;
    const used = available < generic ? available : generic;
    generic -= used;
  }
  if (generic > 0) owed.generic = generic;
  return owed;
}

/** True when nothing is owed — i.e. `manaStillNeeded` came back empty. */
export function isFullyFunded(owed: ManaCost): boolean {
  if ((owed.generic ?? 0) > 0) return false;
  if ((owed.hybrid?.length ?? 0) > 0) return false;
  for (const color of MANA_COLORS) if ((owed[color] ?? 0) > 0) return false;
  return true;
}

/**
 * The "still needed: {1}{G}" line, or the done message. One place so the prompt
 * and any test agree on the wording.
 */
export function stillNeededText(owed: ManaCost): string {
  return isFullyFunded(owed) ? FUNDED_TEXT : `Still needed: ${formatManaCost(owed)}`;
}

/** What the readout says once the pool covers the cost. */
export const FUNDED_TEXT = 'Fully paid — confirm to cast.';

/** One selectable source in the picker, already labeled for a button. */
export interface ManaPickerRow {
  readonly instanceId: InstanceId;
  /** The engine's mode index; `undefined` for a single-mode source. */
  readonly mode: number | undefined;
  /** "Forest (yours) — G" — name, §3.57 owner note, and what this mode makes. */
  readonly label: string;
  /** True when this source has already been tapped for this payment. */
  readonly spent: boolean;
  /** True when this permanent offers more than one colour and will ask which. */
  readonly modal: boolean;
}

/** What the picker needs to know about one permanent to label its row. */
export interface ManaPickerSource {
  readonly instanceId: InstanceId;
  readonly name: string;
  readonly controller: PlayerId;
  /** Every way the engine will let this permanent be tapped right now. */
  readonly options: readonly ManaTapOption[];
}

/**
 * Build the picker's rows from the sources that were tappable when the picker
 * OPENED, marking the ones spent since.
 *
 * A snapshot rather than a live re-read on purpose: a tapped permanent leaves
 * the engine's offer list, so a live list would delete the row the player just
 * clicked and shuffle the rest under their finger mid-decision. Spent rows stay
 * in place, disabled, and the board shows them tapped.
 *
 * A MODAL source collapses to a single row that says "any colour" — picking it
 * hands off to the existing which-colour prompt (`isModalTap`), which is where
 * that question already lives and must keep living.
 */
export function manaPickerRows(
  sources: readonly ManaPickerSource[],
  spent: ReadonlySet<InstanceId>,
  viewer: PlayerId,
  names: Readonly<Record<PlayerId, string>>,
): readonly ManaPickerRow[] {
  const rows: ManaPickerRow[] = [];
  for (const source of sources) {
    if (source.options.length === 0) continue;
    const owner = ownerLabel(source.controller, viewer, names);
    const modal = source.options.length > 1;
    const makes = modal ? ANY_COLOR_LABEL : (source.options[0]?.label ?? '');
    rows.push({
      instanceId: source.instanceId,
      mode: modal ? undefined : source.options[0]?.mode,
      label: `${source.name} (${owner}) — ${makes}`,
      spent: spent.has(source.instanceId),
      modal,
    });
  }
  return rows;
}

/** What a modal source's row says instead of naming one colour. */
const ANY_COLOR_LABEL = 'any colour';
