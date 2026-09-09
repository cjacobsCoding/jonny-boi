/**
 * WHAT KIND OF DECK IS THIS, AND WHAT IS IT MISSING (pure, unit-tested) — §3.137.
 *
 * Asked for: "is there any consideration currently to 'what kind of deck does it
 * seem to be' and 'does a deck like this typically have such cards' … or 'are
 * there cards that decks like this typically have that this deck is missing?' …
 * For example 'this deck has no removal - that seems bad for this type of deck'."
 * There was none. This is it, built on §3.135's role classifier.
 *
 * ## The reference is REAL DECKS, not invented numbers
 * Every "decks like this usually run N of these" figure is computed from actual
 * decklists handed in by the caller — the bundled gauntlet, normally. Nothing
 * here carries a hand-written table of what a good deck looks like, because that
 * would be one person's opinion wearing the costume of a measurement. Add a deck
 * to the gauntlet and the reference updates itself.
 *
 * ⚠️ And the sample size travels WITH the answer. The repo's own field is
 * Aggro ×3, Midrange ×4, Control ×1, Tempo ×1, so a same-family comparison is
 * sometimes a comparison against ONE deck. {@link MIN_COHORT} is the honesty
 * gate: below it the profile falls back to the whole field and SAYS it did,
 * rather than quietly presenting n=1 as a norm.
 *
 * ## Why the field comparison is the strong one
 * Measured across the bundled decks: seven of nine run 12–16 ANSWER cards
 * (removal + damage + counterspells) and two run zero. That is a real, robust
 * signal at n=9 — much stronger than any four-way archetype label this data can
 * support — which is why the gap report leans on it.
 */
import type { CardPool } from '@jonny-boi/cards';
import { convertedManaCost } from '@jonny-boi/core';
import type { Deck } from './deck.js';
import { roleOf, type CardRole } from './card-role.js';

/** The deck families the repo's own archetype tags name. */
export type ArchetypeFamily = 'aggro' | 'midrange' | 'control' | 'tempo' | 'unknown';

/**
 * Fewest decks a same-family reference needs before it is worth quoting. Below
 * this the profile falls back to the whole field and reports that it did — a
 * norm derived from one deck is not a norm.
 */
export const MIN_COHORT = 3;

/** Curve at or under which an untagged deck reads as aggro (measured: 1.67–2.11). */
const AGGRO_MAX_AVG_MV = 2.15;
/** Counterspells at or above which a deck is playing a controlling game. */
const CONTROL_MIN_COUNTERS = 4;
/** Card-flow at or above which that controlling game is CONTROL, not tempo. */
const CONTROL_MIN_CARD_FLOW = 10;
/** Threats at or below which a deck is not trying to win with its board. */
const CONTROL_MAX_THREATS = 8;

/** A deck's measurable shape — the input to both classification and gaps. */
export interface DeckShape {
  readonly lands: number;
  readonly spells: number;
  /** Mean mana value of the NON-LAND cards (0 when there are none). */
  readonly avgSpellMv: number;
  /** How many CARDS (not distinct names) hold each job. */
  readonly roles: ReadonlyMap<CardRole, number>;
}

/** Roles that answer the opponent — the "does this deck do anything about them" group. */
export const ANSWER_ROLES: readonly CardRole[] = Object.freeze(['removal', 'damage', 'counterspell']);
/** Roles that refill your hand. */
export const CARD_FLOW_ROLES: readonly CardRole[] = Object.freeze(['draw', 'dig']);
/** Roles that put a body on the board. */
export const BOARD_ROLES: readonly CardRole[] = Object.freeze(['threat', 'token']);

/** Count the cards in `shape` holding any of `roles`. */
export function countRoles(shape: DeckShape, roles: readonly CardRole[]): number {
  let total = 0;
  for (const role of roles) total += shape.roles.get(role) ?? 0;
  return total;
}

/** Measure a decklist: lands, spells, curve, and how many cards hold each job. */
export function shapeOf(deck: Deck, pool: CardPool): DeckShape {
  const roles = new Map<CardRole, number>();
  let lands = 0;
  let spells = 0;
  let mvSum = 0;
  for (const entry of deck.cards) {
    const def = pool.get(entry.cardId) ?? pool.getByName(entry.cardId);
    if (!def) continue;
    const role = roleOf(def);
    roles.set(role, (roles.get(role) ?? 0) + entry.count);
    if (role === 'land') {
      lands += entry.count;
      continue;
    }
    spells += entry.count;
    mvSum += (def.cost ? convertedManaCost(def.cost) : 0) * entry.count;
  }
  return { lands, spells, avgSpellMv: spells > 0 ? mvSum / spells : 0, roles };
}

/**
 * The family a deck's OWN archetype tag names ("Aggro (burn)" → aggro).
 * Authoritative when present: a deck that says what it is is not guessed at.
 */
export function familyFromTag(archetype: string): ArchetypeFamily {
  const head = archetype.trim().toLowerCase().split(/[^a-z]+/)[0] ?? '';
  if (head === 'aggro' || head === 'midrange' || head === 'control' || head === 'tempo') return head;
  return 'unknown';
}

/**
 * Classify a deck by SHAPE, for a deck with no usable tag.
 *
 * The order is the argument: a deck holding up counterspells is playing a
 * reactive game, and what separates control from tempo there is whether it also
 * refills (control) or is racing behind its answers (tempo). Everything else is
 * decided by the curve.
 *
 * ⚠️ The thresholds are named above and were read off the bundled decks, not
 * chosen by taste — and `deck-shape.test.ts` pins that this reproduces all nine
 * decks' own tags. If a future deck breaks that test, the thresholds are wrong,
 * which is exactly what a test is for.
 */
export function detectFamily(shape: DeckShape): ArchetypeFamily {
  const counters = shape.roles.get('counterspell') ?? 0;
  const cardFlow = countRoles(shape, CARD_FLOW_ROLES);
  const board = countRoles(shape, BOARD_ROLES);
  if (counters >= CONTROL_MIN_COUNTERS) {
    return cardFlow >= CONTROL_MIN_CARD_FLOW && board <= CONTROL_MAX_THREATS ? 'control' : 'tempo';
  }
  if (shape.spells === 0) return 'unknown';
  return shape.avgSpellMv <= AGGRO_MAX_AVG_MV ? 'aggro' : 'midrange';
}

/** A deck's family: its own tag when it has one, otherwise read off its shape. */
export function familyOf(deck: Deck, shape: DeckShape): ArchetypeFamily {
  const tagged = familyFromTag(deck.archetype ?? '');
  return tagged === 'unknown' ? detectFamily(shape) : tagged;
}

/** What a set of reference decks typically runs, per role. */
export interface ReferenceProfile {
  /** The family this profile describes, or 'unknown' for a whole-field one. */
  readonly family: ArchetypeFamily;
  /** How many decks it was computed from — quote it, always. */
  readonly sampleSize: number;
  /** True when a same-family cohort was too small and the field was used instead. */
  readonly fellBackToField: boolean;
  /** Median cards per role across the reference decks. */
  readonly medianByRole: ReadonlyMap<CardRole, number>;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * What decks LIKE this one run, per role.
 *
 * Prefers the same family; falls back to the whole field when that cohort is
 * under {@link MIN_COHORT}, and marks the fallback rather than hiding it. The
 * deck itself is excluded from its own reference — comparing a deck against a
 * set containing itself pulls the norm toward it and hides exactly the gap this
 * is for.
 */
export function referenceProfile(
  family: ArchetypeFamily,
  references: readonly Deck[],
  pool: CardPool,
  excludeName?: string,
): ReferenceProfile {
  const usable = references.filter((d) => d.name !== excludeName);
  const shapes = usable.map((d) => ({ deck: d, shape: shapeOf(d, pool) }));
  const cohort = shapes.filter((s) => familyOf(s.deck, s.shape) === family);
  const fellBackToField = cohort.length < MIN_COHORT;
  const used = fellBackToField ? shapes : cohort;

  const roles = new Set<CardRole>();
  for (const s of used) for (const role of s.shape.roles.keys()) roles.add(role);
  const medianByRole = new Map<CardRole, number>();
  for (const role of roles) {
    medianByRole.set(role, median(used.map((s) => s.shape.roles.get(role) ?? 0)));
  }
  return {
    family: fellBackToField ? 'unknown' : family,
    sampleSize: used.length,
    fellBackToField,
    medianByRole,
  };
}

/** How a deck's count of one role compares to what its reference decks run. */
export type GapKind = 'missing' | 'thin' | 'heavy';

/** One role where this deck differs from decks like it. */
export interface RoleGap {
  readonly role: CardRole;
  /** Cards this deck runs in that role. */
  readonly have: number;
  /** Cards a reference deck typically runs (the median). */
  readonly typical: number;
  readonly kind: GapKind;
}

/** Below this multiple of the typical count, a role is THIN rather than merely fewer. */
const THIN_RATIO = 0.5;
/** Above this multiple, a role is HEAVY — the first place to look for a cut. */
const HEAVY_RATIO = 2;

/**
 * Roles where this deck departs from decks like it: the ones it is missing
 * outright, the ones it is thin on, and the ones it is heavy on.
 *
 * `'missing'` is reserved for running NONE of something the reference decks
 * genuinely run, which is the case worth saying out loud ("this deck has no
 * removal"). Lands are never reported — a mana base is its own question and a
 * median over decks of different colours says nothing useful about it.
 */
export function findRoleGaps(shape: DeckShape, reference: ReferenceProfile): readonly RoleGap[] {
  const gaps: RoleGap[] = [];
  for (const [role, typical] of reference.medianByRole) {
    if (role === 'land') continue;
    const have = shape.roles.get(role) ?? 0;
    if (typical > 0 && have === 0) gaps.push({ role, have, typical, kind: 'missing' });
    else if (typical > 0 && have < typical * THIN_RATIO) gaps.push({ role, have, typical, kind: 'thin' });
    else if (have > Math.max(typical, 1) * HEAVY_RATIO) gaps.push({ role, have, typical, kind: 'heavy' });
  }
  // Loudest first: what the deck lacks entirely, then what it is short of, then
  // what it has too much of — which is also the order they matter for a swap.
  const rank: Readonly<Record<GapKind, number>> = { missing: 0, thin: 1, heavy: 2 };
  return gaps.sort((a, b) => rank[a.kind] - rank[b.kind] || b.typical - a.typical || a.role.localeCompare(b.role));
}

/** A one-line, honest reading of a gap, for a report or the Lab. */
export function describeGap(gap: RoleGap): string {
  // "cards" rather than pluralising the role: the roles are a mix of mass nouns
  // ("removal", "ramp") and count nouns ("threat", "counterspell"), and "2
  // threat" or "8 removals" reads wrong for one half or the other.
  const what = `${gap.role} cards`;
  if (gap.kind === 'missing') return `no ${what} at all — decks like this run about ${gap.typical}`;
  if (gap.kind === 'thin') return `only ${gap.have} ${what} — decks like this run about ${gap.typical}`;
  return `${gap.have} ${what} — more than the ${gap.typical} decks like this run`;
}
