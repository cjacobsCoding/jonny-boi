/**
 * RANDOMISED-BUT-LEGAL decks drawn from the WHOLE card pool — the soak's input.
 *
 * The gauntlet decks in `../data/decks` are eight curated archetypes. They are
 * the right thing to measure a card swap against and the wrong thing to soak an
 * engine with: they touch a fraction of the pool, and the systems that
 * shipped in the last three days barely appear in them at all. Worse, they never
 * COLLIDE — no gauntlet deck puts a planeswalker, an Equipment, a protection
 * creature, a modal spell and a flashback spell in the same game, which is
 * exactly where a system that was only ever tested in isolation breaks.
 *
 * So the soak generates its own. Every deck here is:
 *
 *  - **legal** — it passes the same `loadDeck` every other deck in the repo
 *    passes (60+ cards, four-of rule, basics exempt). A deck the loader would
 *    reject proves nothing about the engine;
 *  - **castable** — its colours are derived from the spells it contains and its
 *    mana base from its own pip census, so the games actually PLAY. A random
 *    five-colour pile that never casts a spell is a slow way to test the untap
 *    step;
 *  - **a pure function of its seed** — the same seed rebuilds the same 60 cards,
 *    which is what makes "here is the seed that reproduces it" a real offer;
 *  - **deliberately mixed** — {@link buildMixedDeck} takes cards from several
 *    mechanic families at once, and {@link buildAnchoredDeck} guarantees one
 *    named mechanic is present in quantity so the soak can require it to fire.
 */

import type { CardDefinition, HybridComponent, ManaColor, ManaCost, Rng } from '@jonny-boi/core';
import { convertedManaCost, createRng, isColorComponent, MANA_COLORS } from '@jonny-boi/core';
import type { Deck, DeckEntry } from './deck.js';
import { BASIC_LAND_NAMES, DEFAULT_DECK_RULES } from './config.js';
import { SOAK_MECHANICS, serializeDefinition, type SoakMechanicId } from './soak-config.js';

// ---------------------------------------------------------------------------
// Deck shape. Named constants — a deck's silhouette is a tuning decision, not a
// literal buried in a loop (DESIGN §1.1).
// ---------------------------------------------------------------------------

/** Cards in a generated deck. The loader's minimum, which is also the format's. */
export const SOAK_DECK_SIZE = DEFAULT_DECK_RULES.minDeckSize;

/**
 * Lands in a generated deck.
 *
 * Deliberately above a tuned constructed deck's 24: these lists are random, so
 * their curves are worse than a designed deck's, and a soak that spends its
 * games mulliganing to nothing tests the mulligan rule rather than the engine.
 */
export const SOAK_LANDS_PER_DECK = 26;

/** The most copies of one nonbasic card a generated deck may run (format rule). */
export const SOAK_MAX_COPIES = DEFAULT_DECK_RULES.maxCopiesNonBasic;

/**
 * Copies of the ANCHOR card an anchored deck runs. The maximum, on purpose: the
 * anchored deck exists to make one mechanic happen, and a single copy in sixty
 * cards is drawn in well under half of games.
 */
export const SOAK_ANCHOR_COPIES = SOAK_MAX_COPIES;

/**
 * Distinct anchor CARDS an anchored deck packs for its mechanic (when the pool
 * offers that many). Several different cards rather than one, so a mechanic
 * whose only firing card happens to be uncastable in the generated colours still
 * has a second chance inside the same deck.
 */
export const SOAK_ANCHOR_CARDS = 3;

/**
 * Distinct ENABLER cards an anchored deck packs, and how many copies of each.
 *
 * Fewer and thinner than the anchors: an enabler is a means, not the thing under
 * test, and a deck that is half Mind Rot stops being a mixed-systems game.
 */
export const SOAK_ENABLER_CARDS = 2;
export const SOAK_ENABLER_COPIES = 3;

/**
 * The most colours an anchored deck will stretch to.
 *
 * Higher than a mixed deck's three because an anchor plus its enablers can
 * genuinely need four (a red madness card wants a black discard outlet), and the
 * generated mana base is 26 lands with the pool's duals available. Five is
 * refused: at that point the deck casts nothing and the anchor never resolves.
 */
export const SOAK_ANCHOR_MAX_COLORS = 4;

/**
 * The most expensive spell a generated deck will run.
 *
 * A random pile has no ramp package, so a seven-drop is a blank. Cutting the top
 * of the curve is what turns "the deck contains a modal spell" into "the modal
 * spell was cast", which is the only version worth soaking.
 */
export const SOAK_MAX_SPELL_MANA_VALUE = 6;

/** How many colours a generated deck plays, and how often. Sums to 1. */
export const SOAK_COLOR_COUNT_WEIGHTS: readonly (readonly [count: number, weight: number])[] = [
  [1, 0.2],
  [2, 0.55],
  [3, 0.25],
];

/**
 * Curve weighting: the relative chance of picking a spell of each mana value.
 *
 * Index = mana value. A real deck is a triangle peaking at two, and an unweighted
 * uniform draw over the pool produces a top-heavy pile that casts nothing before
 * turn six. Index past the end falls back to the last entry.
 */
export const SOAK_CURVE_WEIGHTS: readonly number[] = [3, 8, 10, 8, 5, 3, 2];

/** The five colours a deck may be built in (colourless is never a "colour" here). */
const COLORED: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

// ---------------------------------------------------------------------------
// Card facts the generator needs. Pure functions of a definition.
// ---------------------------------------------------------------------------

/**
 * Total mana value of a printed cost ({X} counts 0 — CR 107.3, as core does).
 *
 * Delegates rather than counting: this used to add ONE per hybrid symbol, which
 * is right for `{G/W}` and wrong for `{2/R}` (CR 202.3b — a hybrid symbol is
 * worth its GREATEST component, so Flame Javelin is 6, not 3). Mana value has
 * one owner, and a curve built from a second opinion would quietly deal the
 * wrong deck.
 */
export function costManaValue(cost: ManaCost | undefined): number {
  return cost ? convertedManaCost(cost) : 0;
}

/**
 * The colours a card's cost REQUIRES. A hybrid symbol requires none of them on
 * its own (any of its components pays it), so it is reported separately by
 * {@link hybridOptions}.
 */
export function requiredColors(cost: ManaCost | undefined): ReadonlySet<ManaColor> {
  const out = new Set<ManaColor>();
  if (!cost) return out;
  for (const color of COLORED) if ((cost[color] ?? 0) > 0) out.add(color);
  return out;
}

/** The per-symbol hybrid options of a cost (one entry per printed hybrid symbol). */
export function hybridOptions(cost: ManaCost | undefined): readonly (readonly HybridComponent[])[] {
  return cost?.hybrid ?? [];
}

/** Is this definition a land? */
function isLand(card: CardDefinition): boolean {
  return card.types.includes('land');
}

/**
 * Can a deck restricted to `colors` cast this spell?
 *
 * Every required colour must be available, and every hybrid symbol must have at
 * least one COMPONENT this deck can pay. Generic and `{C}` are ignored: generic
 * is paid by anything, and every mana base in the pool can make colourless.
 *
 * §3.143 — a component that is not a colour is one every deck can pay: `{2/R}`
 * is castable off Plains and `{B/P}` off nothing but a life total. Judging those
 * by their colour half alone would have hidden them from every deck but one.
 */
export function castableWith(card: CardDefinition, colors: ReadonlySet<ManaColor>): boolean {
  for (const color of requiredColors(card.cost)) if (!colors.has(color)) return false;
  for (const symbol of hybridOptions(card.cost)) {
    const payable = symbol.some(
      (component) => !isColorComponent(component) || colors.has(component),
    );
    if (!payable) return false;
  }
  return true;
}

/**
 * The colours a LAND can put into a pool, across every mode of every one of its
 * mana abilities.
 *
 * Reads the definition's own shorthands rather than `manaModesOf`, because a
 * land whose colours are DERIVED from the board (Reflecting Pool) has no fixed
 * answer — and a deck builder must not pretend it does. Such a land reports the
 * empty set and is treated as colourless-safe, which is the honest reading: it
 * is never the reason a colour is castable.
 */
export function landColors(card: CardDefinition): ReadonlySet<ManaColor> {
  const out = new Set<ManaColor>();
  const def = card as {
    produces?: readonly ManaColor[];
    producesOptions?: readonly Readonly<Partial<Record<ManaColor, number>>>[];
    manaAbilities?: readonly { readonly produces?: readonly Readonly<Partial<Record<ManaColor, number>>>[] }[];
  };
  for (const color of def.produces ?? []) out.add(color);
  for (const mode of def.producesOptions ?? []) {
    for (const color of MANA_COLORS) if ((mode[color] ?? 0) > 0) out.add(color);
  }
  for (const ability of def.manaAbilities ?? []) {
    for (const mode of ability.produces ?? []) {
      for (const color of MANA_COLORS) if ((mode[color] ?? 0) > 0) out.add(color);
    }
  }
  return out;
}

/**
 * Would this land's mana be USABLE in a deck of `colors`?
 *
 * A land qualifies when it makes nothing off-colour — a Guildgate in the wrong
 * two colours is a tapland that produces mana the deck cannot spend, which is
 * strictly worse than a basic and would quietly starve the games.
 */
function landFits(card: CardDefinition, colors: ReadonlySet<ManaColor>): boolean {
  for (const color of landColors(card)) {
    if (color !== 'C' && !colors.has(color)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Seeded sampling helpers.
// ---------------------------------------------------------------------------

/** Pick one element, weighted. `weights` must be index-aligned and non-negative. */
function weightedPick<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T | undefined {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0 || items.length === 0) return undefined;
  let roll = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** Curve weight for a spell — see {@link SOAK_CURVE_WEIGHTS}. */
function curveWeight(card: CardDefinition): number {
  const mv = costManaValue(card.cost);
  return SOAK_CURVE_WEIGHTS[Math.min(mv, SOAK_CURVE_WEIGHTS.length - 1)] ?? 1;
}

/** Pick `n` distinct elements uniformly (a partial Fisher–Yates on a copy). */
function sampleDistinct<T>(rng: Rng, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + rng.nextInt(pool.length - i);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, take);
}

// ---------------------------------------------------------------------------
// The generator.
// ---------------------------------------------------------------------------

/** A generated deck plus the facts a failure message needs to reproduce it. */
export interface SoakDeck extends Deck {
  /** The seed this deck is a pure function of. */
  readonly seed: number;
  /** The colours it was built in. */
  readonly colors: readonly ManaColor[];
  /** The mechanic it was anchored on, when it was anchored on one. */
  readonly anchor?: SoakMechanicId;
}

/** Everything the generator needs to know about the pool, computed once. */
export interface SoakCardIndex {
  readonly spells: readonly CardDefinition[];
  readonly lands: readonly CardDefinition[];
  readonly basics: Readonly<Partial<Record<ManaColor, CardDefinition>>>;
  /** Cards printing each mechanic, by mechanic id. Empty ⇒ the pool has none. */
  readonly byMechanic: ReadonlyMap<SoakMechanicId, readonly CardDefinition[]>;
  /**
   * Cards that ENABLE each mechanic — see `SoakMechanic.enabledBy`. Empty for
   * every mechanic that enables itself, which is nearly all of them.
   */
  readonly enablersByMechanic: ReadonlyMap<SoakMechanicId, readonly CardDefinition[]>;
}

/**
 * Index a pool once for the whole soak. It walks EVERY card in the pool and
 * serializes each of them, so it is done once per run and threaded — never
 * rebuilt per deck. That mattered at 357 cards; the pool is now an order of
 * magnitude larger, so rebuilding this per deck would dominate a soak run.
 */
export function indexPoolForSoak(cards: readonly CardDefinition[]): SoakCardIndex {
  const spells: CardDefinition[] = [];
  const lands: CardDefinition[] = [];
  const basics: Partial<Record<ManaColor, CardDefinition>> = {};
  const byMechanic = new Map<SoakMechanicId, CardDefinition[]>();
  const enablersByMechanic = new Map<SoakMechanicId, CardDefinition[]>();
  for (const mechanic of SOAK_MECHANICS) {
    byMechanic.set(mechanic.id, []);
    enablersByMechanic.set(mechanic.id, []);
  }

  for (const card of cards) {
    const serialized = serializeDefinition(card);
    for (const mechanic of SOAK_MECHANICS) {
      if (mechanic.printedBy(card, serialized)) byMechanic.get(mechanic.id)!.push(card);
      if (mechanic.enabledBy?.(card, serialized)) enablersByMechanic.get(mechanic.id)!.push(card);
    }
    if (isLand(card)) {
      lands.push(card);
      if (BASIC_LAND_NAMES.has(card.name)) {
        for (const color of landColors(card)) if (color !== 'C') basics[color] = card;
      }
      continue;
    }
    if (costManaValue(card.cost) <= SOAK_MAX_SPELL_MANA_VALUE) spells.push(card);
  }
  return { spells, lands, basics, byMechanic, enablersByMechanic };
}

/** Choose a colour set of `count` colours, biased toward colours the pool is deep in. */
function pickColors(rng: Rng, count: number): Set<ManaColor> {
  return new Set(sampleDistinct(rng, COLORED, count));
}

/** Roll the number of colours from {@link SOAK_COLOR_COUNT_WEIGHTS}. */
function rollColorCount(rng: Rng): number {
  const counts = SOAK_COLOR_COUNT_WEIGHTS.map(([c]) => c);
  const weights = SOAK_COLOR_COUNT_WEIGHTS.map(([, w]) => w);
  return weightedPick(rng, counts, weights) ?? 2;
}

/**
 * Assemble the nonland half: draw distinct cards, weighted by curve, and give
 * each a random legal copy count. Stops when the slot budget is filled or the
 * castable candidates run out.
 */
function pickSpells(
  rng: Rng,
  candidates: readonly CardDefinition[],
  slots: number,
  already: Map<string, { readonly def: CardDefinition; count: number }>,
): void {
  if (candidates.length === 0) return;
  const weights = candidates.map(curveWeight);
  let filled = 0;
  for (const entry of already.values()) filled += entry.count;
  // A generous attempt budget: the draw is with replacement, so a small candidate
  // list needs several rolls to fill sixty slots, and an exhausted list must not
  // spin. 8 attempts per remaining slot has always been ample and always ends.
  const maxAttempts = (slots - filled + 1) * 8;
  for (let attempt = 0; filled < slots && attempt < maxAttempts; attempt++) {
    const card = weightedPick(rng, candidates, weights);
    if (!card) break;
    const existing = already.get(card.id);
    const room = Math.min(SOAK_MAX_COPIES - (existing?.count ?? 0), slots - filled);
    if (room <= 0) continue;
    const copies = 1 + rng.nextInt(room);
    if (existing) existing.count += copies;
    else already.set(card.id, { def: card, count: copies });
    filled += copies;
  }
}

/**
 * Build the mana base from the deck's own pip census.
 *
 * Colours are weighted by how many pips of them the chosen spells actually
 * demand, so a deck that is 80% red and 20% white gets a mana base shaped like
 * that rather than an even split — which is the difference between a deck that
 * casts its spells and one that holds them.
 */
function buildManaBase(
  rng: Rng,
  index: SoakCardIndex,
  colors: ReadonlySet<ManaColor>,
  spells: ReadonlyMap<string, { readonly def: CardDefinition; count: number }>,
  landSlots: number,
): DeckEntry[] {
  const pips = new Map<ManaColor, number>();
  for (const color of colors) pips.set(color, 1); // every colour gets a floor
  for (const { def, count } of spells.values()) {
    for (const color of requiredColors(def.cost)) {
      pips.set(color, (pips.get(color) ?? 0) + (def.cost?.[color] ?? 0) * count);
    }
    for (const symbol of hybridOptions(def.cost)) {
      for (const color of symbol) {
        if (colors.has(color as ManaColor)) pips.set(color as ManaColor, (pips.get(color as ManaColor) ?? 0) + count);
      }
    }
  }

  const entries: DeckEntry[] = [];
  // A slice of the base is nonbasic — duals, taplands, cycling lands, the
  // fetch-a-basic lands and the {C} utility lands. This is where the mana-ability
  // model gets exercised at all, so it is never zero when the pool offers one.
  const nonbasicCandidates = index.lands.filter(
    (land) => !BASIC_LAND_NAMES.has(land.name) && landFits(land, colors),
  );
  const nonbasicSlots = nonbasicCandidates.length === 0 ? 0 : Math.min(landSlots >> 1, 1 + rng.nextInt(landSlots >> 1));
  let placed = 0;
  const chosen = sampleDistinct(rng, nonbasicCandidates, Math.ceil(nonbasicSlots / 2) + 1);
  for (const land of chosen) {
    if (placed >= nonbasicSlots) break;
    const copies = Math.min(SOAK_MAX_COPIES, nonbasicSlots - placed, 1 + rng.nextInt(SOAK_MAX_COPIES));
    entries.push({ cardId: land.id, count: copies });
    placed += copies;
  }

  // The rest is basics, apportioned by the pip census. Largest-remainder, so the
  // counts sum to exactly the remaining slots rather than drifting by rounding.
  const remaining = landSlots - placed;
  const colorList = [...colors].filter((color) => index.basics[color] !== undefined);
  if (colorList.length === 0) {
    // No basic exists for any chosen colour (a colourless deck). Fill with any
    // basic the pool has so the deck still reaches legal size.
    const anyBasic = Object.values(index.basics)[0];
    if (anyBasic) entries.push({ cardId: anyBasic.id, count: remaining });
    return entries;
  }
  const totalPips = colorList.reduce((sum, color) => sum + (pips.get(color) ?? 0), 0) || colorList.length;
  const exact = colorList.map((color) => (remaining * (pips.get(color) ?? 0)) / totalPips);
  const floors = exact.map((v) => Math.floor(v));
  let shortfall = remaining - floors.reduce((a, b) => a + b, 0);
  const order = colorList
    .map((_color, i) => ({ i, frac: exact[i]! - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (shortfall <= 0) break;
    floors[i] = floors[i]! + 1;
    shortfall--;
  }
  for (let i = 0; i < colorList.length; i++) {
    const count = floors[i]!;
    if (count > 0) entries.push({ cardId: index.basics[colorList[i]!]!.id, count });
  }
  return entries;
}

/**
 * The LAST thing every generated list passes through: merge duplicate lines,
 * enforce the four-of rule, and top the deck back up to sixty.
 *
 * It exists because the generator writes the same card from two places — an
 * anchor LAND is packed by `buildAnchoredDeck` and the mana base may
 * independently pick it, and the anchor pass and the filler pass can both reach
 * for a card. The loader counts copies per CARD, not per line (see `deck.ts`,
 * which learned this the same way), so two legal-looking `4x Darksteel Citadel`
 * lines are an illegal eight-of. The soak found that on its own first run —
 * which is the harness working, but there is no reason to hand it decks it will
 * only reject.
 */
function normalizeEntries(
  entries: readonly DeckEntry[],
  index: SoakCardIndex,
  colors: ReadonlySet<ManaColor>,
): DeckEntry[] {
  const basicIds = new Map(Object.entries(index.basics).map(([color, def]) => [def!.id, color as ManaColor]));
  const merged = new Map<string, number>();
  for (const entry of entries) merged.set(entry.cardId, (merged.get(entry.cardId) ?? 0) + entry.count);
  let total = 0;
  const capped = new Map<string, number>();
  for (const [cardId, count] of merged) {
    const kept = basicIds.has(cardId) ? count : Math.min(count, SOAK_MAX_COPIES);
    if (kept <= 0) continue;
    capped.set(cardId, kept);
    total += kept;
  }
  if (total < SOAK_DECK_SIZE) {
    // The cap took slots away; give them back as basics of the deck's own
    // colours, which can never make the deck illegal or unplayable.
    const fill =
      [...colors].map((color) => index.basics[color]).find((def) => def !== undefined)
      ?? Object.values(index.basics)[0];
    if (fill) capped.set(fill.id, (capped.get(fill.id) ?? 0) + (SOAK_DECK_SIZE - total));
  }
  return [...capped].map(([cardId, count]) => ({ cardId, count }));
}

/** Assemble a `SoakDeck` from a spell map, a colour set and a land budget. */
function assemble(
  rng: Rng,
  index: SoakCardIndex,
  colors: ReadonlySet<ManaColor>,
  spells: Map<string, { readonly def: CardDefinition; count: number }>,
  seed: number,
  name: string,
  anchor?: SoakMechanicId,
): SoakDeck {
  const spellEntries: DeckEntry[] = [...spells.values()].map((e) => ({ cardId: e.def.id, count: e.count }));
  const spellCount = spellEntries.reduce((sum, e) => sum + e.count, 0);
  const landSlots = SOAK_DECK_SIZE - spellCount;
  const landEntries = buildManaBase(rng, index, colors, spells, landSlots);
  const colorList = [...colors];
  return {
    name,
    archetype: anchor ? `soak/${anchor}` : `soak/${colorList.join('') || 'C'}`,
    cards: normalizeEntries([...spellEntries, ...landEntries], index, colors),
    seed,
    colors: colorList,
    ...(anchor ? { anchor } : {}),
  };
}

/**
 * A random legal deck that MIXES mechanics.
 *
 * No anchor: colours first, then any castable spell, curve-weighted. Across a
 * few thousand of these the pool's systems land in the same game in combinations
 * nobody wrote a test for, which is the whole point.
 */
export function buildMixedDeck(index: SoakCardIndex, seed: number): SoakDeck {
  const rng = createRng(seed);
  const colors = pickColors(rng, rollColorCount(rng));
  const candidates = index.spells.filter((card) => castableWith(card, colors));
  const spells = new Map<string, { readonly def: CardDefinition; count: number }>();
  pickSpells(rng, candidates, SOAK_DECK_SIZE - SOAK_LANDS_PER_DECK, spells);
  return assemble(rng, index, colors, spells, seed, `soak-mixed-${seed}`);
}

/**
 * A random legal deck GUARANTEED to contain the named mechanic in quantity.
 *
 * The anchor cards come first and the colour set is derived from THEM — a deck
 * built colours-first would have to get lucky to be able to cast the one card
 * the run is trying to make fire. The rest is filled the mixed way, so an
 * anchored deck is still a collision test and not a single-card fixture.
 *
 * Returns `undefined` when the pool prints no card with the mechanic, or when
 * the mechanic's cards need more colours than a deck plays. That is a fact about
 * the POOL, not a failure: `pool-mechanics.test.ts` owns "this mechanic has no
 * card", and the soak simply does not require an occurrence it cannot set up.
 */
export function buildAnchoredDeck(
  index: SoakCardIndex,
  mechanic: SoakMechanicId,
  seed: number,
  /**
   * Also pack the ENABLERS of another mechanic — the opponent's side of an
   * interaction witness (see `SoakMechanic.enablerBelongsToOpponent`). The deck
   * is still anchored on `mechanic`; this only adds the other half.
   */
  enablersFor?: SoakMechanicId,
): SoakDeck | undefined {
  const printed = index.byMechanic.get(mechanic) ?? [];
  const castable = printed.filter((card) => costManaValue(card.cost) <= SOAK_MAX_SPELL_MANA_VALUE || card.types.includes('land'));
  if (castable.length === 0) return undefined;

  const rng = createRng(seed);
  const colors = new Set<ManaColor>();
  const spells = new Map<string, { readonly def: CardDefinition; count: number }>();
  const landAnchors: DeckEntry[] = [];

  /**
   * Add one card at anchor strength, widening the colour set to fit it. Refuses
   * a card that would push the deck past every colour there is — a five-colour
   * random pile casts nothing, which would make the anchoring pointless.
   */
  const packAtAnchorStrength = (card: CardDefinition, copies: number): boolean => {
    const needed = new Set<ManaColor>([...colors, ...requiredColors(card.cost)]);
    // A hybrid symbol is satisfiable if the deck already plays one of its halves;
    // otherwise it needs the first half, which is what this adds.
    for (const symbol of hybridOptions(card.cost)) {
      if (!symbol.some((c) => needed.has(c as ManaColor))) needed.add(symbol[0] as ManaColor);
    }
    if (needed.size > SOAK_ANCHOR_MAX_COLORS) return false;
    for (const color of needed) colors.add(color);
    if (isLand(card)) landAnchors.push({ cardId: card.id, count: copies });
    else spells.set(card.id, { def: card, count: copies });
    return true;
  };

  for (const card of sampleDistinct(rng, castable, SOAK_ANCHOR_CARDS)) packAtAnchorStrength(card, SOAK_ANCHOR_COPIES);
  if (spells.size === 0 && landAnchors.length === 0) return undefined;
  // The ENABLERS (see `SoakMechanic.enabledBy`) — the cards without which the
  // anchor cannot do anything. They come second so the anchor's colours win any
  // contest for the colour budget: an enabled deck that cannot cast its anchor
  // is worse than an unenabled one.
  // An anchor whose enablers belong to the OPPONENT does not pack them here —
  // counterspells beside the uncounterable spells prove nothing, because a pilot
  // does not counter its own spell.
  const ownEnablers = SOAK_MECHANICS.find((entry) => entry.id === mechanic)?.enablerBelongsToOpponent
    ? []
    : (index.enablersByMechanic.get(mechanic) ?? []);
  const packed = [...ownEnablers, ...(enablersFor === undefined ? [] : (index.enablersByMechanic.get(enablersFor) ?? []))];
  for (const card of sampleDistinct(rng, packed, SOAK_ENABLER_CARDS)) {
    packAtAnchorStrength(card, SOAK_ENABLER_COPIES);
  }
  // A mono-colourless anchor (an artifact) still needs a colour to build around,
  // or the filler is colourless too and the deck plays four cards.
  if (colors.size === 0) for (const color of pickColors(rng, rollColorCount(rng))) colors.add(color);

  const candidates = index.spells.filter((card) => castableWith(card, colors));
  pickSpells(rng, candidates, SOAK_DECK_SIZE - SOAK_LANDS_PER_DECK, spells);
  const deck = assemble(rng, index, colors, spells, seed, `soak-${mechanic}-${seed}`, mechanic);
  if (landAnchors.length === 0) return deck;
  // Anchor lands displace basics rather than adding to the deck, so it stays
  // exactly `SOAK_DECK_SIZE`; `normalizeEntries` then merges any line the mana
  // base happened to pick as well, which is what keeps it LEGAL.
  return { ...deck, cards: normalizeEntries(displaceBasics(deck.cards, landAnchors, index), index, new Set(deck.colors)) };
}

/**
 * Splice anchor LANDS into a finished list by taking their slots from the
 * basics, largest first, so the deck neither grows past sixty nor loses its
 * coloured sources wholesale.
 */
function displaceBasics(
  cards: readonly DeckEntry[],
  anchors: readonly DeckEntry[],
  index: SoakCardIndex,
): DeckEntry[] {
  const basicIds = new Set(Object.values(index.basics).map((b) => b.id));
  const out = cards.map((e) => ({ ...e }));
  let owed = anchors.reduce((sum, e) => sum + e.count, 0);
  while (owed > 0) {
    const biggest = out
      .filter((e) => basicIds.has(e.cardId) && e.count > 0)
      .sort((a, b) => b.count - a.count || a.cardId.localeCompare(b.cardId))[0];
    if (!biggest) break;
    const take = Math.min(owed, biggest.count);
    biggest.count -= take;
    owed -= take;
  }
  return [...out.filter((e) => e.count > 0), ...anchors];
}

/** A one-line decklist, for a failure message that reproduces the game. */
export function describeDeck(deck: SoakDeck, cardName: (id: string) => string): string {
  const entries = [...deck.cards]
    .sort((a, b) => b.count - a.count || cardName(a.cardId).localeCompare(cardName(b.cardId)))
    .map((e) => `${e.count}x ${cardName(e.cardId)}`);
  return `${deck.name} [${deck.colors.join('') || 'C'}] seed=${deck.seed}\n      ${entries.join(', ')}`;
}
