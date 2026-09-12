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
 * A `{2}`-style option inside a MONOCOLOUR hybrid symbol: `{2/W}` is "two
 * generic mana, or one white" (CR 107.4e). An object rather than a bare number
 * so a component is always discriminable from a `ManaColor` string.
 */
export interface GenericHybridComponent {
  readonly generic: number;
}

/**
 * The PHYREXIAN option inside a symbol: `{W/P}` is "one white, or 2 life"
 * (CR 107.4f). The amount is data rather than a hard-coded 2 because it is the
 * price this symbol prints, and the payment path charges what it says.
 */
export interface LifeHybridComponent {
  readonly life: number;
}

/**
 * ONE alternative inside a printed hybrid symbol — a colour, a generic amount,
 * or a life price. Every hybrid family in Magic is a list of these:
 *
 * | printed  | components                  | CR      |
 * |----------|-----------------------------|---------|
 * | `{G/W}`  | `['G', 'W']`                | 107.4d  |
 * | `{2/W}`  | `[{generic:2}, 'W']`        | 107.4e  |
 * | `{W/P}`  | `['W', {life:2}]`           | 107.4f  |
 * | `{G/U/P}`| `['G', 'U', {life:2}]`      | 107.4f  |
 *
 * Widening the ELEMENT of the existing list — rather than adding a second and a
 * third parallel field — is what keeps ONE answer to each of the questions a
 * symbol is asked: its mana value, its colours, how it prints, and how it is
 * paid. A second structure would mean four readers each learning two shapes.
 */
export type HybridComponent = ManaColor | GenericHybridComponent | LifeHybridComponent;

/** Whether a hybrid component is the plain colour option. */
export function isColorComponent(component: HybridComponent): component is ManaColor {
  return typeof component === 'string';
}

/** Whether a hybrid component is the `{2}`-style generic option of `{2/W}`. */
export function isGenericComponent(component: HybridComponent): component is GenericHybridComponent {
  return typeof component === 'object' && 'generic' in component;
}

/** Whether a hybrid component is the pay-life option of a Phyrexian symbol. */
export function isLifeComponent(component: HybridComponent): component is LifeHybridComponent {
  return typeof component === 'object' && 'life' in component;
}

/**
 * What one component contributes to its symbol's MANA VALUE.
 *
 * CR 202.3b: a hybrid symbol's mana value is the GREATEST of its components'.
 * CR 202.3c: a Phyrexian symbol counts as the coloured symbol — i.e. the life
 * option contributes nothing, so `{W/P}` is 1 and `{2/W}` is 2. Reading the
 * table is how every consumer of mana value (curve sorting, cost reduction,
 * "mana value 3 or less", the card index's pip reconciliation) gets the same
 * answer, and it is the answer regardless of how the symbol was actually PAID.
 */
function componentManaValue(component: HybridComponent): number {
  if (isColorComponent(component)) return 1;
  if (isGenericComponent(component)) return component.generic;
  return 0; // life is not mana (CR 202.3c)
}

/** The mana value of one printed hybrid symbol — CR 202.3b, the greatest component. */
export function hybridSymbolManaValue(symbol: readonly HybridComponent[]): number {
  let greatest = 0;
  for (let i = 0; i < symbol.length; i++) {
    const value = componentManaValue(symbol[i] as HybridComponent);
    if (value > greatest) greatest = value;
  }
  return greatest;
}

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
   * Hybrid symbols. Each entry is ONE printed symbol together with the
   * alternatives that may pay it: `{G/W}{G/W}` is `[['G','W'], ['G','W']]`,
   * `{2/W}` is `[[{generic:2},'W']]`, `{B/P}` is `[['B',{life:2}]]`.
   *
   * The payer picks a different alternative per symbol if that is what makes
   * the cost payable — {@link payCost} searches them exhaustively. The LIFE
   * alternative is the one exception: life is not in the pool, so how much of
   * it this payment spends is decided by the caster BEFORE the payment (the
   * `lifeSpend` argument), never by the search helping itself to a life total.
   */
  readonly hybrid?: readonly (readonly HybridComponent[])[];
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
 *
 * Each hybrid symbol contributes the GREATEST of its components (CR 202.3b), so
 * `{G/W}` is 1, `{2/W}` is 2 and `{W/P}` is 1 — and, crucially, that is true
 * however the symbol was actually paid (CR 202.3c). A Dismember paid entirely
 * with life is still mana value 3.
 */
export function convertedManaCost(cost: ManaCost): number {
  let total =
    (cost.generic ?? 0) +
    (cost.W ?? 0) +
    (cost.U ?? 0) +
    (cost.B ?? 0) +
    (cost.R ?? 0) +
    (cost.G ?? 0) +
    (cost.C ?? 0);
  const hybrids = cost.hybrid;
  if (hybrids === undefined) return total;
  for (let i = 0; i < hybrids.length; i++) total += hybridSymbolManaValue(hybrids[i] as readonly HybridComponent[]);
  return total;
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
  for (const symbol of cost.hybrid ?? []) parts.push(`{${symbol.map(componentSymbolText).join('/')}}`);
  return parts.join('');
}

/**
 * The life a PHYREXIAN symbol prints as its alternative (CR 107.4f). Named
 * because two different things read it: the `P` in `{W/P}`, and the compiler
 * that builds the component from that same printed letter.
 */
export const PHYREXIAN_LIFE_PRICE = 2;

/**
 * How one hybrid component prints inside its symbol's braces. The Phyrexian
 * option prints as `P` at its canonical price and as the bare number otherwise,
 * so a hand-built cost with an unprinted life price renders honestly instead of
 * masquerading as a real Phyrexian symbol.
 */
function componentSymbolText(component: HybridComponent): string {
  if (isColorComponent(component)) return component;
  if (isGenericComponent(component)) return String(component.generic);
  return component.life === PHYREXIAN_LIFE_PRICE ? 'P' : `${component.life}life`;
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
  lifeSpend = 0,
): PaymentResult {
  // THE HOT PATH. No restricted mana anywhere in this pool ⇒ this is the exact
  // function it was before spend restrictions existed: one property read, then
  // the original algorithm on the original object.
  if (pool.restricted !== undefined) return payWithRestrictions(pool, cost, purpose, lifeSpend);
  const hybrids = cost.hybrid ?? [];
  if (hybrids.length > 0) return payWithHybrids(pool, cost, hybrids, GENERIC_SPEND_ORDER, lifeSpend);
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
  lifeSpend: number,
): PaymentResult {
  const usable = usablePool(pool, purpose);
  const order = restrictedFirstSpendOrder(pool, purpose);
  const hybrids = cost.hybrid ?? [];
  const paid =
    hybrids.length > 0
      ? payWithHybrids(usable, cost, hybrids, order, lifeSpend)
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
 * Pay a cost containing hybrid symbols by trying every assignment of components
 * to those symbols and taking the first that works.
 *
 * Exhaustive search is the right tool here, not a heuristic: a greedy choice
 * ("always pay {G/W} with G") can fail a cost that is genuinely payable, which
 * would make the AI think it cannot cast a card it can. The space is tiny — a
 * printed card has at most a handful of hybrid symbols with 2–3 options each —
 * and the search short-circuits on the first success, so the common case is one
 * pass.
 *
 * `lifeSpend` is how much life this payment has been TOLD to spend on Phyrexian
 * components, and the search must land on exactly that much. Exactly, not "at
 * most": a caster who chose to pay 4 life for Dismember did so to keep two mana
 * up, and a search free to under-spend would quietly overrule them. It is also
 * why life is an argument rather than something the search reads off the player
 * — the engine asks before it pays (see `phyrexianLifeOptions`).
 *
 * Assignments are enumerated in a fixed order, so payment stays deterministic
 * and sims remain reproducible (DESIGN §2.1). WHICH of two same-priced symbols
 * the life is spent on is therefore the engine's call, exactly as which land
 * gets tapped and which colour pays a `{G/W}` already are.
 */
function payWithHybrids(
  pool: ManaPool,
  cost: ManaCost,
  hybrids: readonly (readonly HybridComponent[])[],
  genericOrder: readonly ManaColor[],
  lifeSpend: number,
): PaymentResult {
  const folded: Record<string, number> = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

  const search = (index: number, lifeLeft: number): PaymentResult | null => {
    if (index === hybrids.length) {
      // Every life this payment promised to spend must have been spent, or the
      // assignment is not the one the caster asked for.
      if (lifeLeft !== 0) return null;
      const total: Record<string, number> = {
        generic: (cost.generic ?? 0) + (folded.generic as number),
        W: (cost.W ?? 0) + (folded.W as number),
        U: (cost.U ?? 0) + (folded.U as number),
        B: (cost.B ?? 0) + (folded.B as number),
        R: (cost.R ?? 0) + (folded.R as number),
        G: (cost.G ?? 0) + (folded.G as number),
        C: (cost.C ?? 0) + (folded.C as number),
      };
      const result = payFixedCost(pool, total as ManaCost, genericOrder);
      return result.ok ? result : null;
    }
    for (const component of hybrids[index] ?? []) {
      const key = foldKeyOf(component);
      const amount = foldAmountOf(component);
      const life = isLifeComponent(component) ? component.life : 0;
      if (life > lifeLeft) continue; // more life than this payment was given
      if (key !== undefined) folded[key] = (folded[key] as number) + amount;
      const found = search(index + 1, lifeLeft - life);
      if (key !== undefined) folded[key] = (folded[key] as number) - amount;
      if (found) return found;
    }
    return null;
  };

  const paid = search(0, lifeSpend);
  return (
    paid ?? {
      ok: false,
      reason: `insufficient mana for hybrid cost (${formatManaCost({ hybrid: hybrids })})`,
    }
  );
}

/**
 * Which slot of a folded cost a hybrid component adds to — its colour, the
 * generic pile, or nothing at all (life is paid out of a life total, not a
 * pool). ONE table, read by both the paying and the feasibility search, so the
 * two cannot disagree about what choosing a component demands.
 */
function foldKeyOf(component: HybridComponent): string | undefined {
  if (isColorComponent(component)) return component;
  if (isGenericComponent(component)) return 'generic';
  return undefined;
}

/** How much {@link foldKeyOf}'s slot grows by when this component is chosen. */
function foldAmountOf(component: HybridComponent): number {
  return isGenericComponent(component) ? component.generic : 1;
}

/**
 * Every DISTINCT amount of life a caster could choose to spend on `cost`'s
 * Phyrexian components, cheapest first, bounded by the life they have.
 *
 * `[0]` for every cost with no Phyrexian component — which is every cost in the
 * game but a handful — so a caller loops once and the offer path it feeds is
 * byte-identical to the one that existed before this system.
 *
 * CR 118.4 bounds it: life is a resource payable down to exactly zero, which is
 * legal, the player's call, and promptly lethal via the state-based actions. So
 * `life` itself is the cap, not `life - 1`.
 */
export function phyrexianLifeOptions(cost: ManaCost, life: number): readonly number[] {
  const hybrids = cost.hybrid;
  if (hybrids === undefined) return NO_LIFE_SPEND;
  // Distinct TOTALS, not subsets: two {B/P} symbols priced at 2 life each offer
  // 0, 2 and 4 — three decisions, not four assignments. Which symbol the life
  // actually pays for is the payment search's, and unobservable while a printed
  // card's Phyrexian symbols all print the same price.
  let totals: number[] | undefined;
  for (let i = 0; i < hybrids.length; i++) {
    const symbol = hybrids[i] as readonly HybridComponent[];
    for (let c = 0; c < symbol.length; c++) {
      const component = symbol[c] as HybridComponent;
      if (!isLifeComponent(component)) continue;
      const price = component.life;
      if (totals === undefined) totals = [0];
      for (let t = totals.length - 1; t >= 0; t--) {
        const sum = (totals[t] as number) + price;
        if (sum <= life && !totals.includes(sum)) totals.push(sum);
      }
      break; // one symbol offers at most one life price
    }
  }
  if (totals === undefined) return NO_LIFE_SPEND;
  totals.sort((a, b) => a - b);
  return totals;
}

/** The single "spend no life" answer, shared so the common path allocates nothing. */
const NO_LIFE_SPEND: readonly number[] = Object.freeze([0]);

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
    const hybrid: (readonly HybridComponent[])[] = [];
    for (let i = 0; i < n; i++) hybrid.push(...cost.hybrid);
    out.hybrid = hybrid;
  }
  return out as ManaCost;
}

export function canPay(
  pool: ManaPool,
  cost: ManaCost,
  purpose?: ManaSpendPurpose,
  lifeSpend = 0,
): boolean {
  // THE HOT PATH — see `payCost`. One property read on a pool with no restricted
  // mana, and everything below is the code that was here before.
  if (pool.restricted !== undefined) return canPayRestricted(pool, cost, purpose, lifeSpend);
  const hybrids = cost.hybrid;
  if (hybrids !== undefined && hybrids.length > 0) return canPayWithHybrids(pool, cost, hybrids, lifeSpend);
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
  lifeSpend: number,
): boolean {
  const usable = usablePool(pool, purpose);
  const hybrids = cost.hybrid;
  if (hybrids !== undefined && hybrids.length > 0) return canPayWithHybrids(usable, cost, hybrids, lifeSpend);
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
  extraGeneric = 0,
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
  return spare >= (cost.generic ?? 0) + extraGeneric;
}

/**
 * Feasibility for a cost containing hybrid symbols: is there ANY assignment of
 * components to those symbols that the pool can cover, spending exactly
 * `lifeSpend` life on the Phyrexian ones?
 *
 * Mirrors `payWithHybrids`' exhaustive, fixed-order search — a greedy choice can
 * fail a cost that is genuinely payable — but accumulates the chosen components
 * into one reused counter object instead of folding a fresh cost per assignment.
 * The two must agree exactly: an offer this says yes to and the payment then
 * refuses is a spell the menu shows and the engine rejects.
 */
function canPayWithHybrids(
  pool: ManaPool,
  cost: ManaCost,
  hybrids: readonly (readonly HybridComponent[])[],
  lifeSpend: number,
): boolean {
  const chosen: Partial<Record<ManaColor, number>> = {};
  let chosenGeneric = 0;

  const search = (index: number, lifeLeft: number): boolean => {
    if (index === hybrids.length) {
      return lifeLeft === 0 && canPayFixed(pool, cost, chosen, chosenGeneric);
    }
    for (const component of hybrids[index] ?? []) {
      if (isLifeComponent(component)) {
        if (component.life > lifeLeft) continue;
        if (search(index + 1, lifeLeft - component.life)) return true;
        continue;
      }
      if (isGenericComponent(component)) {
        chosenGeneric += component.generic;
        const found = search(index + 1, lifeLeft);
        chosenGeneric -= component.generic;
        if (found) return true;
        continue;
      }
      chosen[component] = (chosen[component] ?? 0) + 1;
      const found = search(index + 1, lifeLeft);
      chosen[component] = (chosen[component] ?? 1) - 1;
      if (found) return true;
    }
    return false;
  };

  return search(0, lifeSpend);
}
