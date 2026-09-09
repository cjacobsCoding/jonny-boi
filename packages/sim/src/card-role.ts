/**
 * WHAT A CARD IS FOR (pure, data-driven, unit-tested) — §3.135.
 *
 * The suggestion engine used to know only two things about a candidate: can the
 * deck cast its colours, and does its mana value sit near the curve. That is
 * enough to rank plausibility and nothing else, so "swap a removal spell for a
 * removal spell" and "this cheaper card does the same job" were not questions it
 * could even ask. Asked for directly: look at the obvious swaps first, and prefer
 * swapping like for like.
 *
 * ## Read off the COMPILED card, never a guess
 * Every card in this pool compiles to real effect primitives (that is the whole
 * premise of the lab), so a card's job is derivable rather than inferred from its
 * text: `destroyTarget` is removal, `drawCards` is draw, `pumpUntilEndOfTurn` is
 * a pump. {@link PRIMITIVE_ROLE} is that TABLE — one row per primitive, built
 * from the vocabulary the pool actually uses. Adding a primitive is a ROW.
 *
 * ⚠️ The table is CLOSED, in this project's sense: a primitive with no row
 * contributes NO role rather than being bent to the nearest one. A card that
 * ends up with no rows at all falls back through mana production (a Llanowar
 * Elves has no effects, it has `produces`) to "it is a body", and finally to
 * `'other'` — which is an honest "we do not know", not a wrong label.
 *
 * ## Why a priority order
 * Cards do several things: a creature whose enters-trigger destroys something is
 * a removal spell wearing a body. {@link ROLE_PRIORITY} picks which job is THE
 * job, most-defining first, so like-for-like matching compares the thing a
 * player would actually name the card for.
 */
import type { CardDefinition, ManaColor } from '@jonny-boi/core';
import { convertedManaCost } from '@jonny-boi/core';

/** The functional jobs a card can hold in a deck. */
export type CardRole =
  | 'removal'
  | 'damage'
  | 'counterspell'
  | 'discard'
  | 'draw'
  | 'dig'
  | 'recursion'
  | 'bounce'
  | 'ramp'
  | 'token'
  | 'counters'
  | 'pump'
  | 'attachment'
  | 'lifegain'
  | 'protection'
  | 'blink'
  | 'threat'
  | 'land'
  | 'other';

/**
 * THE TABLE — effect primitive → the job it does. Built from the primitives the
 * pool actually uses (a scan of all 5,651 compiled cards), most-used first
 * within each group so the common cases are obvious to a reader.
 */
export const PRIMITIVE_ROLE: Readonly<Record<string, CardRole>> = Object.freeze({
  // Answering a permanent.
  destroyTarget: 'removal',
  destroyAll: 'removal',
  exileTarget: 'removal',
  exileUntilLeaves: 'removal',
  gainControl: 'removal',
  tapPermanents: 'removal',
  tapTarget: 'removal',
  // Damage — its own job, because it can go at a face as well as a creature.
  dealDamage: 'damage',
  dealDamageToEach: 'damage',
  loseLife: 'damage',
  // Answering a spell, or a hand.
  counterSpell: 'counterspell',
  counterUnlessPaid: 'counterspell',
  discardCard: 'discard',
  // Cards.
  drawCards: 'draw',
  scry: 'dig',
  surveil: 'dig',
  mill: 'dig',
  searchLibrary: 'dig',
  reorderTopOfLibrary: 'dig',
  revealTopCard: 'dig',
  putFromHandOnTop: 'dig',
  handToBottomThenDraw: 'dig',
  // Getting things back.
  returnFromGraveyard: 'recursion',
  moveTargetFromGraveyard: 'recursion',
  returnExiledByThis: 'recursion',
  persistReturn: 'recursion',
  grantFlashback: 'recursion',
  exileGraveyard: 'recursion',
  returnToHand: 'bounce',
  returnChosenToHand: 'bounce',
  returnSpellToHand: 'bounce',
  // Mana.
  addMana: 'ramp',
  payManaOrElse: 'ramp',
  // Making board.
  makeToken: 'token',
  createPredefinedToken: 'token',
  createTokenCopy: 'token',
  livingWeaponGerm: 'token',
  // Growing board.
  addCounters: 'counters',
  proliferate: 'counters',
  tickDownCounter: 'counters',
  pumpUntilEndOfTurn: 'pump',
  grantKeywordUntilEndOfTurn: 'pump',
  grantKeywordToYoursUntilEndOfTurn: 'pump',
  attachToTarget: 'attachment',
  // Staying alive.
  gainLife: 'lifegain',
  regenerate: 'protection',
  preventDamage: 'protection',
  // Flickering your OWN permanent to re-use its enters trigger. Its own job
  // rather than being folded into the nearest existing one: a blink is not
  // graveyard recursion, and in a deck built on it — Cloudshift, Conjurer's
  // Closet, Restoration Angel — it is the engine, not a footnote.
  blinkTarget: 'blink',
});

/**
 * Which job wins when a card does several. Most-defining first: a creature whose
 * enters-trigger destroys a permanent is a removal spell with a body attached,
 * and a player asked to name it would say "removal".
 */
export const ROLE_PRIORITY: readonly CardRole[] = Object.freeze([
  'removal',
  'counterspell',
  'damage',
  'recursion',
  'discard',
  'bounce',
  'draw',
  'ramp',
  'token',
  'attachment',
  'counters',
  'pump',
  'protection',
  'blink',
  'dig',
  'lifegain',
  'threat',
  'land',
  'other',
]);

/**
 * Is one effect's parameter set NO WORSE than another's?
 *
 * ⚠️ This is the guard that stops a plausible-looking swap from being called a
 * no-brainer when it is really a trade-off, and both failure modes are real
 * cards in this pool:
 *  - Shock deals 2 where Lightning Strike deals 3 for one more mana. Comparing
 *    primitive NAMES alone ("both dealDamage") would call the cheaper one a free
 *    upgrade. Numeric parameters must therefore be >= the cut card's.
 *  - Doom Blade is cheaper than Murder and also `destroyTarget`, but it carries
 *    `notColor: 'B'` — it cannot kill black creatures. A parameter the candidate
 *    adds is a RESTRICTION we cannot prove is harmless, so any difference in the
 *    non-numeric parameters (or in which keys exist at all) disqualifies it.
 *
 * Conservative on purpose: this only decides what gets simulated FIRST, so a
 * false negative costs a little search order and a false positive would put a
 * worse card at the front of the queue.
 */
function paramsNoWorse(outParams: unknown, inParams: unknown): boolean {
  const out = (outParams ?? {}) as Record<string, unknown>;
  const inn = (inParams ?? {}) as Record<string, unknown>;
  const outKeys = Object.keys(out).sort();
  const inKeys = Object.keys(inn).sort();
  if (outKeys.length !== inKeys.length) return false;
  for (let i = 0; i < outKeys.length; i++) if (outKeys[i] !== inKeys[i]) return false;
  for (const key of outKeys) {
    const o = out[key];
    const n = inn[key];
    if (typeof o === 'number' && typeof n === 'number') {
      if (n < o) return false; // fewer cards, less damage — a downgrade
      continue;
    }
    if (JSON.stringify(o) !== JSON.stringify(n)) return false; // a different restriction
  }
  return true;
}

/**
 * Does `inDef` do at least everything `outDef` does? Every one of the cut card's
 * effects must be matched by a distinct effect of the candidate with the same
 * primitive and {@link paramsNoWorse} parameters. Matching is one-to-one so a
 * card with two draws is not "covered" by a card with one.
 */
function doesAtLeastAsMuch(outDef: CardDefinition, inDef: CardDefinition): boolean {
  const outEffects = effectRefsOf(outDef);
  const inEffects = [...effectRefsOf(inDef)];
  const used = new Set<number>();
  for (const need of outEffects) {
    const at = inEffects.findIndex(
      (have, i) => !used.has(i) && have.primitive === need.primitive && paramsNoWorse(need.params, have.params),
    );
    if (at < 0) return false;
    used.add(at);
  }
  return true;
}

/** How deep to follow nested effects. A wrapper inside a wrapper is already rare. */
const MAX_EFFECT_DEPTH = 6;

/**
 * Collect effects, FOLLOWING WRAPPERS into their payload.
 *
 * ⚠️ This is the fix for a reported miss, and the shape of it matters. Several
 * primitives are wrappers that carry the real effect in a nested `effects` param
 * — `mayEffects` ("you may …"), `mayCostEffects`, `ifKicked`, `substituteIf`,
 * `scheduleDelayedEffects`. Reading only the top level, Fiend Hunter looked like
 * pure `returnExiledByThis` and classified as RECURSION, because its exile is
 * wrapped in a "you may": it is removal, and the classifier could not see it.
 * Conjurer's Closet and Cloudshift fell to 'other' the same way.
 *
 * The recursion is generic rather than a list of wrapper names on purpose: any
 * param holding a list of effect refs is followed, so a wrapper added tomorrow
 * is handled without a matching edit here. Depth-capped as a cheap guard.
 */
function collectEffectRefs(
  effects: readonly { primitive: string; params?: unknown }[] | undefined,
  out: { primitive: string; params?: unknown }[],
  depth: number,
): void {
  if (!effects || depth > MAX_EFFECT_DEPTH) return;
  for (const effect of effects) {
    out.push(effect);
    const params = effect.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== 'object') continue;
    for (const value of Object.values(params)) {
      if (!Array.isArray(value)) continue;
      const nested = value.filter(
        (v): v is { primitive: string; params?: unknown } =>
          typeof v === 'object' && v !== null && typeof (v as { primitive?: unknown }).primitive === 'string',
      );
      if (nested.length > 0) collectEffectRefs(nested, out, depth + 1);
    }
  }
}

/** Every effect a card can produce, from all three of its homes, wrappers followed. */
function effectRefsOf(def: CardDefinition): readonly { primitive: string; params?: unknown }[] {
  const out: { primitive: string; params?: unknown }[] = [];
  collectEffectRefs(def.effects, out, 0);
  for (const t of def.triggers ?? []) collectEffectRefs(t.effects, out, 0);
  for (const a of def.activated ?? []) collectEffectRefs(a.effects, out, 0);
  return out;
}

/** Every effect primitive a card can produce, from all three of its homes. */
export function primitivesOf(def: CardDefinition): readonly string[] {
  return effectRefsOf(def).map((e) => e.primitive);
}

/**
 * The job this card holds. See the module doc for why it reads the compiled
 * effects and how it falls back when the table has nothing to say.
 */
export function roleOf(def: CardDefinition): CardRole {
  if (def.types.includes('land')) return 'land';
  const roles = new Set<CardRole>();
  for (const primitive of primitivesOf(def)) {
    const role = PRIMITIVE_ROLE[primitive];
    if (role !== undefined) roles.add(role);
  }
  for (const role of ROLE_PRIORITY) if (roles.has(role)) return role;
  // No table row matched. A card that taps for mana is ramp even with no
  // effects at all (Llanowar Elves is `produces`, not `addMana`).
  if ((def.produces ?? []).length > 0) return 'ramp';
  if (def.types.includes('creature')) return 'threat';
  return 'other';
}

/** Mana value, 0 for a card with no printed cost. */
export function manaValueOf(def: CardDefinition): number {
  return def.cost ? convertedManaCost(def.cost) : 0;
}

/** The distinct coloured pips a cost demands (empty when colourless). */
export function coloredPipsOf(def: CardDefinition): readonly ManaColor[] {
  if (!def.cost) return [];
  const out: ManaColor[] = [];
  for (const [key, n] of Object.entries(def.cost)) {
    if (key === 'generic' || typeof n !== 'number' || n <= 0) continue;
    out.push(key as ManaColor);
  }
  return out;
}

/** Can a deck of these colours cast this card at all? */
export function castableIn(def: CardDefinition, colors: ReadonlySet<ManaColor>): boolean {
  const pips = coloredPipsOf(def);
  return pips.length === 0 || pips.every((c) => colors.has(c));
}

/** How a candidate compares to the card it would replace. */
export interface UpgradeVerdict {
  /** Both cards hold the same job — a like-for-like swap. */
  readonly sameRole: boolean;
  /**
   * The NO-BRAINER: same job, the deck can cast it, it does at least everything
   * the cut card does, and it is either cheaper or the same cost with a better
   * body. This is the "obvious swap" a player wants looked at first.
   */
  readonly strictUpgrade: boolean;
}

/**
 * Compare a candidate against the card it would replace.
 *
 * "Does effectively the same thing" is answered by the compiled primitives, not
 * by names: the candidate must produce a SUPERSET of the cut card's primitives,
 * so a card that draws AND gains life can upgrade a card that only draws, and
 * never the other way round. Cheaper for the same job, or the same cost with a
 * strictly better body, is then the whole no-brainer test.
 *
 * ⚠️ Deliberately conservative. It answers "is this obviously not worse?", which
 * is a question about the printed card, and it is only ever used to ORDER what
 * gets simulated. The sim still decides whether the swap actually wins — this
 * never promotes a card past the evidence, it only decides what is measured first.
 */
export function compareForUpgrade(
  outDef: CardDefinition,
  inDef: CardDefinition,
  colors: ReadonlySet<ManaColor>,
): UpgradeVerdict {
  const sameRole = roleOf(outDef) === roleOf(inDef);
  if (!sameRole || !castableIn(inDef, colors)) return { sameRole, strictUpgrade: false };
  if (!doesAtLeastAsMuch(outDef, inDef)) return { sameRole, strictUpgrade: false };

  const outMv = manaValueOf(outDef);
  const inMv = manaValueOf(inDef);
  const outBody = (outDef.power ?? 0) + (outDef.toughness ?? 0);
  const inBody = (inDef.power ?? 0) + (inDef.toughness ?? 0);
  // Cheaper for the same job, with a body that is not a downgrade …
  if (inMv < outMv && inBody >= outBody) return { sameRole, strictUpgrade: true };
  // … or the same cost and a strictly bigger body.
  if (inMv === outMv && inBody > outBody) return { sameRole, strictUpgrade: true };
  return { sameRole, strictUpgrade: false };
}
