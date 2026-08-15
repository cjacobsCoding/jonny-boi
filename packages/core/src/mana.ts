/**
 * Mana: colors, costs (data, never magic numbers), pools, and payment.
 *
 * A cost is plain data such as `{ generic: 2, U: 1 }`. A pool is the floating
 * mana a player has available. Payment is pure: it returns either a new pool or
 * a typed failure reason, never throwing.
 */

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

/** A floating mana pool: counts of each color currently available. */
export type ManaPool = Record<ManaColor, number>;

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
  for (const color of MANA_COLORS) total += production[color] ?? 0;
  return total;
}

/** Add every color of a production mode to a pool, returning a new pool. */
export function addProduction(pool: ManaPool, production: ManaProduction): ManaPool {
  const next = { ...pool };
  for (const color of MANA_COLORS) next[color] += production[color] ?? 0;
  return next;
}

/** An empty pool with every color at zero. */
export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

/** Total mana in a pool. */
export function poolTotal(pool: ManaPool): number {
  let total = 0;
  for (const color of MANA_COLORS) total += pool[color];
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
export function payCost(pool: ManaPool, cost: ManaCost): PaymentResult {
  const hybrids = cost.hybrid ?? [];
  if (hybrids.length > 0) return payWithHybrids(pool, cost, hybrids);
  return payFixedCost(pool, cost);
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
      const result = payFixedCost(pool, folded as ManaCost);
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

/** Pay a cost with no hybrid symbols — the original fixed-symbol algorithm. */
function payFixedCost(pool: ManaPool, cost: ManaCost): PaymentResult {
  const remaining = { ...pool };

  // 1. Pay each specific color requirement from its own color. Iterating
  // `MANA_COLORS` (which is W,U,B,R,G,C — the same order this always used) rather
  // than building a fresh array of [color, need] pairs: that array plus its six
  // tuples were seven allocations on every payment attempt.
  for (const color of MANA_COLORS) {
    const need = cost[color] ?? 0;
    if (need <= 0) continue;
    if (remaining[color] < need) {
      return { ok: false, reason: `insufficient ${color} mana (need ${need}, have ${remaining[color]})` };
    }
    remaining[color] -= need;
  }

  // 2. Pay generic from leftover mana, spending colorless first, then WUBRG.
  let generic = cost.generic ?? 0;
  const genericOrder: readonly ManaColor[] = ['C', 'W', 'U', 'B', 'R', 'G'];
  for (const color of genericOrder) {
    if (generic <= 0) break;
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
export function canPay(pool: ManaPool, cost: ManaCost): boolean {
  const hybrids = cost.hybrid;
  if (hybrids !== undefined && hybrids.length > 0) return canPayWithHybrids(pool, cost, hybrids);
  return canPayFixed(pool, cost, undefined);
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
  for (const color of MANA_COLORS) {
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
