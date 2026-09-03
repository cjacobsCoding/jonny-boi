/**
 * THE GRAVEYARD-CASTING FAMILY (DESIGN §3.111) — unearth, scavenge, embalm,
 * eternalize, encore, retrace, jump-start, escape, and flashback's non-mana
 * costs. Every one of them is a printed ability that FUNCTIONS WHILE THE CARD
 * IS IN A GRAVEYARD, and they come in exactly two shapes:
 *
 *  1. **An ACTIVATED ability of a card in a graveyard** (CR 702.84a unearth,
 *     702.96a scavenge, 702.128a embalm, 702.129a eternalize, 702.141a encore,
 *     and the printed "{2}{B}: Return ~ from your graveyard to your hand").
 *     Modelled as {@link GraveyardAbility} on the definition and the
 *     `activateGraveyardAbility` action — its own list and its own action for
 *     the reason cycling has both: `activated` is activated from the
 *     BATTLEFIELD by a permanent, and folding a graveyard card into that path
 *     would teach every battlefield-shaped check (summoning sickness, {T},
 *     `findOnBattlefield`) about a zone it has never had to consider. The body
 *     is compiled by the cards package exactly as a cycling body is; core names
 *     no primitive.
 *
 *  2. **A CAST from the graveyard for an altered cost** — flashback (702.34a,
 *     exiled on leaving the stack), retrace (702.81a: printed cost plus
 *     "discard a land card", and the spell goes back to the graveyard),
 *     jump-start (702.133a: printed cost plus "discard a card", then exiled),
 *     escape (702.138a: the escape cost plus "exile N other cards from your
 *     graveyard", and NOT exiled — an escaped instant can escape again).
 *     ONE casting funnel: every kind is a `castSpell` with `fromZone:
 *     'graveyard'`, read through {@link graveyardCastOptionsOf} by the offer
 *     loop, the cast path and the pilot alike, and the exit from the stack is
 *     the closed {@link GRAVEYARD_CAST_EXIT} table read by
 *     `spellLeaveDestination`. Flashback's printed non-mana costs ("Flashback—
 *     Sacrifice three creatures", "—Tap three untapped white creatures you
 *     control") are the SAME `AdditionalCastCost` shape the additional-cost
 *     machinery already pays, with two new closed kinds (`tap`,
 *     `exileFromGraveyard`) — see {@link additionalCostPool}.
 *
 * ## Unearth's exile clause (CR 702.84c)
 * "If it would leave the battlefield, exile it instead of putting it anywhere
 * else." A REPLACEMENT on the object's next zone change, recorded on the
 * instance (`CardInstance.exileIfLeaves`) and asked by BOTH leave-the-
 * battlefield funnels — core's `moveToZone` and the cards package's
 * `movePermanentTo` — through {@link leaveBattlefieldDestination}, exactly as
 * madness's `discardDestination` is asked by both discard funnels. A rule in
 * one funnel and not the other is a rule that depends on which primitive
 * killed the creature.
 */

import type { ActivationCost, AdditionalCastCost, CastTiming, EffectRef, CardDefinition } from './card.js';
import { matchesCardFilter } from './card.js';
import type { ManaCost } from './mana.js';
import type { CardInstance, GameState, InstanceId, PlayerId, SpellStackObject, ZoneName } from './state.js';
import { flashbackCostOf } from './card-grants.js';

// --- activated abilities of a card in a graveyard --------------------------------

/**
 * The closed vocabulary of graveyard-activated keywords, each keyed to the CR
 * rule that defines it. `returnToHand` is the printed template "{cost}: Return
 * ~ from your graveyard to your hand" (CR 602.2 — an ordinary activated
 * ability whose card happens to be in a graveyard). A kind rather than a free
 * label because the PILOT prices each one differently (an unearth is one
 * attack; a scavenge is counters on the best attacker), and the soak's
 * witness table is keyed on it.
 */
export type GraveyardAbilityKind = 'unearth' | 'scavenge' | 'embalm' | 'eternalize' | 'encore' | 'returnToHand';

/** Every kind → the rule that defines it, for the manifest and the inspector. */
export const GRAVEYARD_ABILITY_RULES: Readonly<Record<GraveyardAbilityKind, string>> = Object.freeze({
  unearth: '702.84a',
  scavenge: '702.96a',
  embalm: '702.128a',
  eternalize: '702.129a',
  encore: '702.141a',
  returnToHand: '602.2',
});

/**
 * One activated ability that functions while its card is in a graveyard.
 *
 * `cost` reuses {@link ActivationCost} (mana, life, "sacrifice a <noun>"), so a
 * printed rider is a field the engine already charges — never a second cost
 * vocabulary. `exileSelf` is the printed "Exile this card from your graveyard"
 * that scavenge, embalm, eternalize and encore all pay as PART OF THE COST
 * (CR 702.96a et al.: the card is exiled as the ability is activated, before it
 * reaches the stack). Unearth does not print it — the card is moved by the
 * ability's EFFECT — which is why it is a flag and not implied by the kind.
 *
 * `timing` is `'sorcery'` on every printed keyword here ("Unearth only as a
 * sorcery"); the `returnToHand` template prints no restriction and is instant.
 */
export interface GraveyardAbility {
  readonly kind: GraveyardAbilityKind;
  readonly cost: ActivationCost;
  /** "Exile this card from your graveyard:" — paid as the ability is activated. */
  readonly exileSelf?: boolean;
  /** The body, compiled by the cards package; core names no primitive. */
  readonly effects: readonly EffectRef[];
  readonly timing?: CastTiming;
  /** Human-readable text for the log, the inspector, and the replay viewer. */
  readonly label: string;
}

/**
 * CR 702.84c — where a permanent that "would leave the battlefield" actually
 * goes. An unearthed permanent is exiled INSTEAD of anywhere else; everything
 * else goes where the caller said. Asked by both leave funnels (see the module
 * header) BEFORE `resetInstanceForNewZone` clears the flag.
 *
 * A move to exile is left alone: "exile it instead" of exile is the same zone,
 * and rewriting it would emit a second, false destination.
 */
export function leaveBattlefieldDestination(inst: CardInstance, to: ZoneName): ZoneName {
  if (inst.zone !== 'battlefield' || inst.exileIfLeaves !== true) return to;
  return 'exile';
}

// --- casting from the graveyard ---------------------------------------------------

/**
 * The closed vocabulary of "cast this card from your graveyard" keywords.
 * `flashback` is the default — every `castSpell` with `fromZone: 'graveyard'`
 * written before this existed means a flashback cast, and keeps meaning it.
 */
export type GraveyardCastKind = 'flashback' | 'retrace' | 'jumpStart' | 'escape';

/**
 * Where the CARD goes when a spell cast from the graveyard leaves the stack —
 * resolved or countered — keyed on how it was cast. The one table
 * `spellLeaveDestination` and the cast path's `resolvesTo` both read.
 *
 *  - flashback (CR 702.34a) and jump-start (702.133a) print "then exile it";
 *  - retrace (702.81a) and escape (702.138a) print no such clause, so the
 *    spell goes to the graveyard like any other and may be cast again — which
 *    is the entire design of both keywords, and the reason a second table
 *    entry rather than a boolean was worth having.
 */
export const GRAVEYARD_CAST_EXIT: Readonly<Record<GraveyardCastKind, 'exile' | 'graveyard'>> = Object.freeze({
  flashback: 'exile',
  retrace: 'graveyard',
  jumpStart: 'exile',
  escape: 'graveyard',
});

/**
 * One printed "you may cast this card from your graveyard" keyword OTHER than
 * flashback (which has its own printed fields and its own grant seam).
 *
 * `cost` is the ALTERNATIVE mana cost when the keyword prints one (escape);
 * absent means the card's printed cost is paid ("in addition to paying its
 * other costs" — retrace, jump-start). `additional` is the non-mana half in the
 * shape the additional-cost machinery already pays.
 */
export interface GraveyardCastAbility {
  readonly kind: Exclude<GraveyardCastKind, 'flashback'>;
  readonly cost?: ManaCost;
  readonly additional: AdditionalCastCost;
}

/** One way `card` may be cast from the graveyard right now — what it costs and what it exits to. */
export interface GraveyardCastOption {
  readonly kind: GraveyardCastKind;
  /** The mana half. Empty for a flashback printed with no mana (Dread Return). */
  readonly cost: ManaCost;
  /** The non-mana half, if the keyword prints one. */
  readonly additional?: AdditionalCastCost;
  /** "Pay N life" — flashback's printed rider; zero for every other kind. */
  readonly lifeCost: number;
}

/** The answer when a card cannot be cast from the graveyard at all. Shared and frozen. */
const NO_GRAVEYARD_CASTS: readonly GraveyardCastOption[] = Object.freeze([]);

/**
 * Every way `card` may be cast out of its owner's graveyard, in printed order:
 * flashback (printed or GRANTED, through `flashbackCostOf` — the one accessor)
 * first, then the card's other graveyard-cast keywords. THE accessor: the
 * offer loop enumerates by it, `applyCastSpell` accepts by it, and the pilot
 * scores by it, so "can this card be cast from the graveyard, and for what?"
 * has exactly one answer.
 *
 * `castDef` is the face being cast (a split card's half); a grant names the
 * whole card, which is why the printed flashback is read off the face and the
 * grant off the card.
 */
export function graveyardCastOptionsOf(
  state: GameState,
  card: CardInstance,
  castDef: CardDefinition = card.def,
): readonly GraveyardCastOption[] {
  const flashback = flashbackCostOf(state, card) ?? castDef.flashback;
  const others = castDef.graveyardCasts;
  if (flashback === undefined && (others === undefined || others.length === 0)) return NO_GRAVEYARD_CASTS;
  const out: GraveyardCastOption[] = [];
  if (flashback !== undefined) {
    out.push({
      kind: 'flashback',
      cost: flashback,
      ...(castDef.flashbackAdditionalCost !== undefined ? { additional: castDef.flashbackAdditionalCost } : {}),
      lifeCost: castDef.flashbackLifeCost ?? 0,
    });
  }
  if (others !== undefined) {
    for (const ability of others) {
      out.push({
        kind: ability.kind,
        // "In addition to paying its other costs": the printed mana cost. The
        // compiler never gives a card with NO mana cost retrace or jump-start
        // (CR 202.1b — there is nothing to pay "in addition" to), so the empty
        // fallback is unreachable for one and exists only to type-check.
        cost: ability.cost ?? castDef.cost ?? {},
        additional: ability.additional,
        lifeCost: 0,
      });
    }
  }
  return out;
}

/** The one option of the named kind, or `undefined` when the card has no such keyword. */
export function graveyardCastOptionFor(
  state: GameState,
  card: CardInstance,
  castDef: CardDefinition,
  kind: GraveyardCastKind = 'flashback',
): GraveyardCastOption | undefined {
  const options = graveyardCastOptionsOf(state, card, castDef);
  for (let i = 0; i < options.length; i++) {
    const option = options[i] as GraveyardCastOption;
    if (option.kind === kind) return option;
  }
  return undefined;
}

/**
 * The MANDATORY additional cost this spell on the stack owes — read by the
 * cast-time question and its answer, so both agree on what is being paid.
 *
 * A graveyard cast owes the KEYWORD'S additional cost (retrace's land, escape's
 * exiled cards, flashback's printed sacrifice) rather than the card's own
 * `additionalCost`; a hand cast owes the printed one. No printed card carries
 * both shapes, and for one that did the keyword's cost is what its reminder
 * text names for that cast.
 */
export function spellAdditionalCostOf(spell: SpellStackObject): AdditionalCastCost | undefined {
  const def = spell.card.def;
  if (spell.castFrom !== 'graveyard') return def.additionalCost;
  const kind = spell.graveyardCast ?? 'flashback';
  if (kind === 'flashback') return def.flashbackAdditionalCost ?? def.additionalCost;
  const abilities = def.graveyardCasts;
  if (abilities !== undefined) {
    for (const ability of abilities) if (ability.kind === kind) return ability.additional;
  }
  return def.additionalCost;
}

/**
 * How many `{X}` symbols the cost this spell was cast for prints — flashback
 * reads the FLASHBACK cost's count, a retrace or jump-start cast pays the
 * printed cost and so reads the printed count, and an escape cost prints no X
 * on any card.
 */
export function castXCountOf(spell: SpellStackObject, def: CardDefinition): number {
  if (spell.castFrom !== 'graveyard') return def.xCost ?? 0;
  const kind = spell.graveyardCast ?? 'flashback';
  if (kind === 'flashback') return def.flashbackXCost ?? 0;
  if (kind === 'escape') return 0;
  return def.xCost ?? 0;
}

// --- the additional-cost kinds ---------------------------------------------------

/**
 * The zone a mandatory additional cost is paid FROM, per kind — the one table
 * the candidate list and the cast-time `selectCards` question both read.
 * A sacrifice and a tap both name permanents; a discard names hand cards; an
 * escape's fuel names graveyard cards.
 */
export const ADDITIONAL_COST_ZONE: Readonly<Record<AdditionalCastCost['kind'], ZoneName>> = Object.freeze({
  sacrifice: 'battlefield',
  tap: 'battlefield',
  discard: 'hand',
  exileFromGraveyard: 'graveyard',
});

/**
 * Every card `caster` could pay `cost` with right now, BEFORE the filter:
 * their permanents (a tap cost may only name UNTAPPED ones — CR 602.2b, a
 * tapped permanent cannot be tapped again), their hand, or their graveyard.
 * `matchesCardFilter` is applied by the caller so the two questions — "which
 * zone?" and "which of them qualify?" — stay one function each.
 */
export function additionalCostPool(state: GameState, cost: AdditionalCastCost, caster: PlayerId): readonly CardInstance[] {
  switch (cost.kind) {
    case 'sacrifice':
      return state.battlefield.filter((perm) => perm.controller === caster);
    case 'tap':
      return state.battlefield.filter((perm) => perm.controller === caster && !perm.tapped);
    case 'discard':
      return state.players[caster].hand;
    case 'exileFromGraveyard':
      return state.players[caster].graveyard;
  }
}

/**
 * Whether `count` legal payers of `cost` exist for `caster`, leaving out
 * `excludeInstanceId` (the spell itself, which cannot pay its own cost — it is
 * on the stack, or about to be). Shared by the offer loop and the pilot.
 */
export function canPayAdditionalCost(
  state: GameState,
  cost: AdditionalCastCost,
  caster: PlayerId,
  excludeInstanceId?: InstanceId,
): boolean {
  const need = cost.count ?? 1;
  let have = 0;
  for (const card of additionalCostPool(state, cost, caster)) {
    if (card.instanceId === excludeInstanceId) continue;
    if (!matchesCardFilter(card, cost.filter)) continue;
    have += 1;
    if (have >= need) return true;
  }
  return need <= 0;
}
