/**
 * Mana: colors, costs (data, never magic numbers), pools, and payment.
 *
 * A cost is plain data such as `{ generic: 2, U: 1 }`. A pool is the floating
 * mana a player has available. Payment is pure: it returns either a new pool or
 * a typed failure reason, never throwing.
 */

import type { ManaSpendPurpose, ManaSpendRestriction, RestrictedMana } from './spend-restriction.js';
import { restrictionAllows } from './spend-restriction.js';

/** The five MTG colors plus colorless mana. */
export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

/** All colored/colorless mana symbols, in canonical order. */
export const MANA_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

/**
 * A mana cost. `generic` is the {N} portion payable with any mana; the per-color
 * fields are specific symbol requirements. Omitted fields mean zero.
 */
export interface ManaCost {
  readonly generic?: number;
  readonly W?: number;
  readonly U?: number;
  readonly B?: number;
  readonly R?: number;
  readonly G?: number;
  /** Colorless-specific {C} requirement (distinct from generic). */
  readonly C?: number;
  /**
   * Hybrid symbols. Each entry is ONE printed symbol together with the colors
   * that may pay it: `{G/W}{G/W}` is `[['G','W'], ['G','W']]`. A hybrid symbol
   * counts 1 toward mana value, and the payer picks a different color per symbol
   * if that is what makes the cost payable.
   *
   * Only colour/colour hybrids are modelled. Monocolour hybrid (`{2/W}`) and
   * Phyrexian (`{W/P}`, payable with life) are deliberately absent — they need
   * an alternative-payment concept this cost shape does not have, so cards
   * printing them stay unimplemented instead of being silently mis-costed.
   */
  readonly hybrid?: readonly (readonly ManaColor[])[];
}

/**
 * A floating mana pool: counts of each color currently available, plus — only
 * when some source on the board printed one — the SPEND RESTRICTIONS attached to
 * part of that mana.
 *
 * ## The invariant, in one line
 * `pool[color]` is the TOTAL mana of that colour, restricted mana INCLUDED; the
 * `restricted` parcels record which slice of it is not freely spendable, and
 * their per-colour amounts never exceed `pool[color]`.
 *
 * Totals-inclusive rather than a second bucket on purpose. Everything in the
 * engine and the UI that asks "how much mana is floating?" — {@link poolTotal},
 * the seat panel, the end-of-step empty, the replay format — is asking a question
 * about QUANTITY, and quantity is not what a restriction changes. A player with
 * Ancient Ziggurat mana floating really does have that mana, publicly, and it
 * really does drain at end of step. Only LEGALITY differs, and every legality
 * question in the codebase already funnels through {@link canPay} /
 * {@link payCost}, which is exactly where the subtraction belongs.
 *
 * ## The hot path pays nothing
 * `restricted` is ABSENT on every pool in a game containing no restricted
 * source, which is very nearly all of them. Each payment path takes one
 * `=== undefined` property read and then runs code byte-identical to what it ran
 * before this system existed. Do not "normalise" the field to an empty array:
 * that would put a length check and a live array on the hottest path in the sim
 * to describe something that is not there.
 */
export type ManaPool = Record<ManaColor, number> & {
  /**
   * Parcels of restricted mana, in the order they were added — which is also the
   * order they are SPENT in, so payments stay deterministic and sims reproduce.
   * Absent when there is none (see above).
   */
  readonly restricted?: readonly RestrictedMana[];
};

/**
 * The exact mana a *single* activation of a mana ability adds to the pool — one
 * "mode" of that ability. `{ G: 1 }` is a Forest's only mode; `{ C: 2 }` is Sol
 * Ring's. A source with several modes (Birds of Paradise, a dual land) offers
 * one of these per activation and the controller picks (see
 * `CardDefinition.producesOptions`). Omitted colors mean zero.
 */
export type ManaProduction = Readonly<Partial<Record<ManaColor, number>>>;

/**
 * Total mana one production mode yields — how much a single tap is worth.
 *
 * A plain loop rather than `reduce`: this and {@link poolTotal} run on the
 * engine's hottest paths (every step change empties both pools; the AI's mana
 * math totals a pool per candidate play), and the callback handed to `reduce`
 * closes over nothing useful while costing an allocation per call.
 */
export function productionTotal(production: ManaProduction): number {
  let total = 0;
  for (let i = 0; i < MANA_COLORS.length; i++) total += production[MANA_COLORS[i] as ManaColor] ?? 0;
  return total;
}

/**
 * Add every color of a production mode to a pool, returning a new pool.
 *
 * `restriction` is the spend restriction the SOURCE printed on the mana it just
 * made ("Spend this mana only to cast a creature spell"). Omitted for every
 * ordinary source, in which case this is exactly the function it always was.
 */
export function addProduction(
  pool: ManaPool,
  production: ManaProduction,
  restriction?: ManaSpendRestriction,
): ManaPool {
  const next = { ...pool };
  for (const color of MANA_COLORS) next[color] += production[color] ?? 0;
  if (restriction === undefined) return next;
  // One parcel per COLOUR of the mode, because a restriction is carried by
  // individual mana and a mode may add several colours at once (Gwenna). Merging
  // by colour would be wrong the moment two sources print DIFFERENT restrictions.
  const parcels: RestrictedMana[] = pool.restricted ? [...pool.restricted] : [];
  for (const color of MANA_COLORS) {
    const amount = production[color] ?? 0;
    if (amount > 0) parcels.push(Object.freeze({ color, amount, restriction }));
  }
  return withRestricted(next, parcels);
}

/**
 * A pool carrying exactly these parcels — dropping the field entirely when there
 * are none, so a pool that spends its last restricted mana returns to the shape
 * the hot path short-circuits on.
 */
function withRestricted(pool: ManaPool, parcels: readonly RestrictedMana[]): ManaPool {
  if (parcels.length === 0) {
    // `delete` deoptimises the object into dictionary mode, and this object is
    // about to be read six times per payment. Rebuild the plain shape instead.
    return { W: pool.W, U: pool.U, B: pool.B, R: pool.R, G: pool.G, C: pool.C };
  }
  return { ...pool, restricted: parcels };
}

/**
 * How much of `pool`'s `color` may fund `purpose` — the whole of it when no
 * restricted mana exists, which is the answer on essentially every board.
 *
 * The subtraction, not a filter: restricted mana this purpose may not touch is
 * simply invisible to the payment, and the existing algorithm runs on what is
 * left (see spend-restriction.ts for why that is complete rather than greedy).
 */
export function usableMana(
  pool: ManaPool,
  color: ManaColor,
  purpose: ManaSpendPurpose | undefined,
): number {
  const parcels = pool.restricted;
  if (parcels === undefined) return pool[color];
  let usable = pool[color];
  for (let i = 0; i < parcels.length; i++) {
    const parcel = parcels[i] as RestrictedMana;
    if (parcel.color !== color) continue;
    if (!restrictionAllows(parcel.restriction, purpose)) usable -= parcel.amount;
  }
  return usable;
}

/**
 * Mana in `pool` that NO purpose could ever spend on anything — i.e. mana whose
 * restriction cannot be met by the object being paid for. Used by the UI and the
 * log to explain a pool that looks bigger than the spells it can cast.
 */
export function restrictedTotal(pool: ManaPool): number {
  const parcels = pool.restricted;
  if (parcels === undefined) return 0;
  let total = 0;
  for (let i = 0; i < parcels.length; i++) total += (parcels[i] as RestrictedMana).amount;
  return total;
}

/** An empty pool with every color at zero. */
export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

/** Total mana in a pool. */
export function poolTotal(pool: ManaPool): number {
  let total = 0;
  for (let i = 0; i < MANA_COLORS.length; i++) total += pool[MANA_COLORS[i] as ManaColor];
  return total;
}

/** Add `amount` of one color to a pool, returning a new pool. */
export function addMana(pool: ManaPool, color: ManaColor, amount: number): ManaPool {
  return { ...pool, [color]: pool[color] + amount };
}

/**
 * The converted mana cost (total pips) of a cost — used for sorting/curve.
 * Each hybrid symbol counts 1, matching the printed mana value.
 */
export function convertedManaCost(cost: ManaCost): number {
  return (
    (cost.generic ?? 0) +
    (cost.W ?? 0) +
    (cost.U ?? 0) +
    (cost.B ?? 0) +
    (cost.R ?? 0) +
    (cost.G ?? 0) +
    (cost.C ?? 0) +
    (cost.hybrid?.length ?? 0)
  );
}

/**
 * A cost written the way a card prints it — `{2}{U}`, `{G/W}{G/W}`, `{0}`.
 *
 * Lives here rather than in a UI helper because a cost is *asked about* in three
 * places that must all say the same thing: the prompt a payment choice raises
 * (`choices.ts`), the event log, and the client rendering that prompt. Generic
 * comes first and colours follow {@link MANA_COLORS} order, which is the printed
 * convention.
 */
export function formatManaCost(cost: ManaCost): string {
  const parts: string[] = [];
  const generic = cost.generic ?? 0;
  // A wholly free cost still has to render as something a player can read, and
  // "{0}" is how Magic prints one.
  if (generic > 0 || convertedManaCost(cost) === 0) parts.push(`{${generic}}`);
  for (const color of MANA_COLORS) {
    for (let i = 0; i < (cost[color] ?? 0); i++) parts.push(`{${color}}`);
  }
  for (const symbol of cost.hybrid ?? []) parts.push(`{${symbol.join('/')}}`);
  return parts.join('');
}

/** Outcome of attempting to pay a cost from a pool. */
export type PaymentResult =
  | { readonly ok: true; readonly pool: ManaPool }
  | { readonly ok: false; readonly reason: string };

/**
 * Attempt to pay `cost` from `pool`. Colored/colorless symbols are paid from
 * their own color first; the generic portion is then paid from whatever remains
 * (a deterministic order so sims reproduce). Returns the leftover pool on
 * success, or a reason on failure. Pure — never mutates `pool`.
 */
export function payCost(
  pool: ManaPool,
  cost: ManaCost,
  purpose?: ManaSpendPurpose,
): PaymentResult {
  // THE HOT PATH. No restricted mana anywhere in this pool ⇒ this is the exact
  // function it was before spend restrictions existed: one property read, then
  // the original algorithm on the original object.
  if (pool.restricted !== undefined) return payWithRestrictions(pool, cost, purpose);
  const hybrids = cost.hybrid ?? [];
  if (hybrids.length > 0) return payWithHybrids(pool, cost, hybrids, GENERIC_SPEND_ORDER);
  return payFixedCost(pool, cost, GENERIC_SPEND_ORDER);
}

/**
 * Pay from a pool that holds restricted mana.
 *
 * Three steps, none of which is a search:
 *  1. Hide what this purpose may not touch ({@link usableMana}) and pay from the
 *     rest with the ordinary algorithm — so hybrid symbols, generic pips and the
 *     failure reasons are decided by exactly one implementation.
 *  2. Prefer to spend the RESTRICTED mana. It is the least flexible resource on
 *     the board: an Ancient Ziggurat mana that is not spent on this creature
 *     spell is very likely never spent at all. The preference is expressed as a
 *     generic-spend ORDER (colours holding usable restricted mana first) plus a
 *     within-colour drain order, and it cannot change feasibility — generic mana
 *     is fungible, which is the same argument `canPayFixed` already relies on.
 *  3. Subtract what was spent from the real pool and from the parcels.
 */
function payWithRestrictions(
  pool: ManaPool,
  cost: ManaCost,
  purpose: ManaSpendPurpose | undefined,
): PaymentResult {
  const usable = usablePool(pool, purpose);
  const order = restrictedFirstSpendOrder(pool, purpose);
  const hybrids = cost.hybrid ?? [];
  const paid =
    hybrids.length > 0
      ? payWithHybrids(usable, cost, hybrids, order)
      : payFixedCost(usable, cost, order);
  if (!paid.ok) return paid;

  const next: ManaPool = { W: pool.W, U: pool.U, B: pool.B, R: pool.R, G: pool.G, C: pool.C };
  const parcels: RestrictedMana[] = [...(pool.restricted as readonly RestrictedMana[])];
  for (let i = 0; i < MANA_COLORS.length; i++) {
    const color = MANA_COLORS[i] as ManaColor;
    let spent = usable[color] - paid.pool[color];
    if (spent <= 0) continue;
    next[color] -= spent;
    // Drain the usable parcels of this colour, oldest first, so a pool holding
    // two differently-restricted mana of the same colour spends them in a fixed,
    // reproducible order.
    for (let p = 0; p < parcels.length && spent > 0; p++) {
      const parcel = parcels[p] as RestrictedMana;
      if (parcel.color !== color) continue;
      if (!restrictionAllows(parcel.restriction, purpose)) continue;
      const take = parcel.amount < spent ? parcel.amount : spent;
      parcels[p] = Object.freeze({ ...parcel, amount: parcel.amount - take });
      spent -= take;
    }
  }
  return { ok: true, pool: withRestricted(next, parcels.filter(hasMana)) };
}

/** A parcel that still holds mana — spent-out parcels are dropped, not kept at 0. */
function hasMana(parcel: RestrictedMana): boolean {
  return parcel.amount > 0;
}

/** The colour amounts of `pool` that `purpose` may actually spend, as a plain pool. */
function usablePool(pool: ManaPool, purpose: ManaSpendPurpose | undefined): ManaPool {
  return {
    W: usableMana(pool, 'W', purpose),
    U: usableMana(pool, 'U', purpose),
    B: usableMana(pool, 'B', purpose),
    R: usableMana(pool, 'R', purpose),
    G: usableMana(pool, 'G', purpose),
    C: usableMana(pool, 'C', purpose),
  };
}

/**
 * {@link GENERIC_SPEND_ORDER}, rotated so colours holding spendable RESTRICTED
 * mana come first — the "spend the least flexible resource" preference, applied
 * to the generic portion of a cost. Relative order inside each half is the
 * canonical one, so the result is still fully deterministic.
 */
function restrictedFirstSpendOrder(
  pool: ManaPool,
  purpose: ManaSpendPurpose | undefined,
): readonly ManaColor[] {
  const parcels = pool.restricted as readonly RestrictedMana[];
  const first: ManaColor[] = [];
  const rest: ManaColor[] = [];
  for (let i = 0; i < GENERIC_SPEND_ORDER.length; i++) {
    const color = GENERIC_SPEND_ORDER[i] as ManaColor;
    let restrictedHere = false;
    for (let p = 0; p < parcels.length; p++) {
      const parcel = parcels[p] as RestrictedMana;
      if (parcel.color === color && restrictionAllows(parcel.restriction, purpose)) {
        restrictedHere = true;
        break;
      }
    }
    (restrictedHere ? first : rest).push(color);
  }
  return first.length === 0 ? GENERIC_SPEND_ORDER : first.concat(rest);
}

/**
 * Pay a cost containing hybrid symbols by trying every assignment of colors to
 * those symbols and taking the first that works.
 *
 * Exhaustive search is the right tool here, not a heuristic: a greedy choice
 * ("always pay {G/W} with G") can fail a cost that is genuinely payable, which
 * would make the AI think it cannot cast a card it can. The space is tiny — a
 * printed card has at most a handful of hybrid symbols with 2 options each — and
 * the search short-circuits on the first success, so the common case is one pass.
 *
 * Assignments are enumerated in a fixed order, so payment stays deterministic
 * and sims remain reproducible (DESIGN §2.1).
 */
function payWithHybrids(
  pool: ManaPool,
  cost: ManaCost,
  hybrids: readonly (readonly ManaColor[])[],
  genericOrder: readonly ManaColor[],
): PaymentResult {
  const choice: ManaColor[] = [];

  const search = (index: number): PaymentResult | null => {
    if (index === hybrids.length) {
      // Fold the chosen colors into the fixed colored requirements and pay.
      const folded: Record<string, number> = {
        generic: cost.generic ?? 0,
        W: cost.W ?? 0,
        U: cost.U ?? 0,
        B: cost.B ?? 0,
        R: cost.R ?? 0,
        G: cost.G ?? 0,
        C: cost.C ?? 0,
      };
      for (const color of choice) folded[color] = (folded[color] ?? 0) + 1;
      const result = payFixedCost(pool, folded as ManaCost, genericOrder);
      return result.ok ? result : null;
    }
    for (const color of hybrids[index] ?? []) {
      choice.push(color);
      const found = search(index + 1);
      choice.pop();
      if (found) return found;
    }
    return null;
  };

  const paid = search(0);
  return (
    paid ?? {
      ok: false,
      reason: `insufficient mana for hybrid cost (${hybrids
        .map((options) => `{${options.join('/')}}`)
        .join('')})`,
    }
  );
}

/**
 * The order generic mana is spent in: colourless first, then WUBRG. Fixed (and
 * hoisted to module scope, not rebuilt per payment) so sims reproduce exactly.
 *
 * Generic mana is fungible, so the order cannot change WHETHER a cost is payable
 * — only which colours are left over. That is what makes it safe for
 * {@link restrictedFirstSpendOrder} to hand a different permutation in when
 * restricted mana is on the table.
 */
const GENERIC_SPEND_ORDER: readonly ManaColor[] = ['C', 'W', 'U', 'B', 'R', 'G'];

/** Pay a cost with no hybrid symbols — the original fixed-symbol algorithm. */
function payFixedCost(
  pool: ManaPool,
  cost: ManaCost,
  genericOrder: readonly ManaColor[],
): PaymentResult {
  const remaining: ManaPool = { W: pool.W, U: pool.U, B: pool.B, R: pool.R, G: pool.G, C: pool.C };

  // 1. Pay each specific color requirement from its own color. Iterating
  // `MANA_COLORS` (which is W,U,B,R,G,C — the same order this always used) rather
  // than building a fresh array of [color, need] pairs: that array plus its six
  // tuples were seven allocations on every payment attempt.
  for (let i = 0; i < MANA_COLORS.length; i++) {
    const color = MANA_COLORS[i] as ManaColor;
    const need = cost[color] ?? 0;
    if (need <= 0) continue;
    if (remaining[color] < need) {
      return { ok: false, reason: `insufficient ${color} mana (need ${need}, have ${remaining[color]})` };
    }
    remaining[color] -= need;
  }

  // 2. Pay generic from leftover mana, spending colorless first, then WUBRG.
  let generic = cost.generic ?? 0;
  for (let i = 0; i < genericOrder.length; i++) {
    if (generic <= 0) break;
    const color = genericOrder[i] as ManaColor;
    const take = Math.min(generic, remaining[color]);
    remaining[color] -= take;
    generic -= take;
  }
  if (generic > 0) {
    return { ok: false, reason: `insufficient mana for generic cost (short ${generic})` };
  }

  return { ok: true, pool: remaining };
}

/**
 * Whether `pool` can pay `cost` without committing the spend.
 *
 * Deliberately NOT `payCost(pool, cost).ok`. `generateLegalActions` asks this for
 * every card in hand and every activated ability on the board, on every single
 * decision — and the paying version answered by allocating a copy of the pool, an
 * array of six [colour, need] tuples, and (on the far more common *failure* path,
 * because most of a hand is unaffordable most of the time) a formatted "insufficient
 * mana" string that nobody ever reads. That was the single largest source of
 * garbage outside the per-action clone.
 *
 * The answer is exactly the same one `payFixedCost` computes, just without the
 * bookkeeping: every coloured requirement must be met by its own colour, and the
 * mana left over afterwards — which is fungible, so the ORDER generic is spent in
 * cannot change feasibility — must cover the generic portion.
 */
/**
 * The cost of paying `cost` exactly `times` times — the shape multikicker
 * needs ("you may pay {1}{G} any number of times as you cast this spell").
 *
 * Repeating a cost is NOT the same as scaling its mana value: each repetition
 * is its own set of symbols, so three copies of `{G/W}` are three hybrid
 * symbols the payer may satisfy with three DIFFERENT colours. Multiplying the
 * hybrid list rather than counting it keeps that true, which is why this lives
 * here beside `payCost` instead of being an ad-hoc `generic * n` at the call
 * site.
 *
 * `times <= 0` yields an empty cost — the free, pay-nothing repetition count.
 */
export function repeatCost(cost: ManaCost, times: number): ManaCost {
  const n = Math.max(0, Math.trunc(times));
  if (n === 0) return {};
  if (n === 1) return cost;
  const out: Record<string, unknown> = {};
  if (cost.generic) out.generic = cost.generic * n;
  for (const color of MANA_COLORS) {
    const count = cost[color];
    if (count) out[color] = count * n;
  }
  if (cost.hybrid && cost.hybrid.length > 0) {
    const hybrid: (readonly ManaColor[])[] = [];
    for (let i = 0; i < n; i++) hybrid.push(...cost.hybrid);
    out.hybrid = hybrid;
  }
  return out as ManaCost;
}

export function canPay(pool: ManaPool, cost: ManaCost, purpose?: ManaSpendPurpose): boolean {
  // THE HOT PATH — see `payCost`. One property read on a pool with no restricted
  // mana, and everything below is the code that was here before.
  if (pool.restricted !== undefined) return canPayRestricted(pool, cost, purpose);
  const hybrids = cost.hybrid;
  if (hybrids !== undefined && hybrids.length > 0) return canPayWithHybrids(pool, cost, hybrids);
  return canPayFixed(pool, cost, undefined);
}

/**
 * Feasibility against a pool holding restricted mana: the same question asked of
 * the mana this purpose may actually touch.
 *
 * Deliberately `payCost`'s step 1 and nothing more — one implementation of "what
 * is hidden from this payment", so the offer path and the apply path can never
 * disagree about whether a spell is castable.
 */
function canPayRestricted(
  pool: ManaPool,
  cost: ManaCost,
  purpose: ManaSpendPurpose | undefined,
): boolean {
  const usable = usablePool(pool, purpose);
  const hybrids = cost.hybrid;
  if (hybrids !== undefined && hybrids.length > 0) return canPayWithHybrids(usable, cost, hybrids);
  return canPayFixed(usable, cost, undefined);
}

/**
 * The feasibility half of {@link payFixedCost}, allocation-free.
 *
 * `extra` carries the additional per-colour demands a hybrid assignment has
 * chosen, so the hybrid search can reuse this without folding a new cost object
 * per candidate assignment.
 */
function canPayFixed(
  pool: ManaPool,
  cost: ManaCost,
  extra: Partial<Record<ManaColor, number>> | undefined,
): boolean {
  let spare = 0;
  // Indexed rather than `for...of`: V8 does not always elide the array-iterator
  // object here, and `generateLegalActions` asks this once per card in hand on
  // every decision — the iterators alone were a measurable slice of its garbage.
  for (let i = 0; i < MANA_COLORS.length; i++) {
    const color = MANA_COLORS[i] as ManaColor;
    const need = (cost[color] ?? 0) + (extra?.[color] ?? 0);
    const have = pool[color];
    if (have < need) return false;
    spare += have - need;
  }
  return spare >= (cost.generic ?? 0);
}

/**
 * Feasibility for a cost containing hybrid symbols: is there ANY assignment of
 * colours to those symbols that the pool can cover?
 *
 * Mirrors `payWithHybrids`' exhaustive, fixed-order search — a greedy choice can
 * fail a cost that is genuinely payable — but accumulates the chosen colours into
 * one reused counter object instead of folding a fresh cost per assignment.
 */
function canPayWithHybrids(
  pool: ManaPool,
  cost: ManaCost,
  hybrids: readonly (readonly ManaColor[])[],
): boolean {
  const chosen: Partial<Record<ManaColor, number>> = {};

  const search = (index: number): boolean => {
    if (index === hybrids.length) return canPayFixed(pool, cost, chosen);
    for (const color of hybrids[index] ?? []) {
      chosen[color] = (chosen[color] ?? 0) + 1;
      const found = search(index + 1);
      chosen[color] = (chosen[color] ?? 1) - 1;
      if (found) return true;
    }
    return false;
  };

  return search(0);
}
