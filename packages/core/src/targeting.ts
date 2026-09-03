/**
 * TARGET LEGALITY — what a spell is *allowed* to point at (DESIGN §2 card seam).
 *
 * Why this exists: the engine used to accept any target for any spell, so a card
 * printed "deals 3 damage to target **player or planeswalker**" played as if it
 * read "any target", and a 1-mana "4 damage to target **creature**" played as a
 * 1-mana 4-damage any-target spell. Both are *strictly better than printed*, and
 * a card that plays better than printed silently corrupts every A/B verdict that
 * includes it. The project rule is **faithful or not at all**.
 *
 * The restriction is DATA, not code: an effect ref carries
 * `params.targets: 'any' | 'creature' | 'player'`, exactly like every other
 * tunable a primitive reads. Core stays primitive-agnostic — it never asks *which*
 * primitive an effect is, only whether the ref declares a target restriction under
 * the one reserved param name {@link TARGET_RESTRICTION_PARAM}. That keeps this a
 * convention on the card seam (any present or future targeting primitive inherits
 * it for free) rather than a hard-coded list of primitive ids in the engine.
 *
 * The restriction is enforced in THREE places, which is what makes it real:
 *   1. **Offer** — `generateLegalActions` enumerates a restricted spell's casts
 *      one per *legal* target, and offers none at all when the board has no legal
 *      target (a spell with no legal target cannot be cast).
 *   2. **Reject** — `applyCastSpell` refuses a submitted target that breaks the
 *      restriction, so a pilot or a UI that builds its own action cannot cheat.
 *   3. **Resolve** — the primitive itself re-checks (`cards/primitives.ts`), so a
 *      target that became illegal between cast and resolution does nothing.
 *
 * A definition that declares NO restriction is left completely alone (that is what
 * "defaults to unrestricted" means for legality): counterspells target a stack
 * object, pumps target their own source, and policing those here would break them.
 */

import type { CardDefinition, EffectRef, KeywordFlags } from './card.js';
import { hasSubtype, hasType, isCreature, isLand } from './card.js';
import { isBattle, isPlaneswalker } from './card.js';
import type { CardInstance, GameState, InstanceId, PlayerId, SpellStackObject, StackObject } from './state.js';
import { PLAYER_IDS } from './state.js';
import type { ContinuousIndex } from './internal/continuous.js';
import { anyContinuousModification, indexContinuous, NO_MOD } from './internal/continuous.js';
import { effectiveKeywords } from './internal/stats.js';
import { protectionBlocksSource } from './protection.js';

/**
 * The creature type Restoration Angel's printed line excludes. Named because a
 * bare `'angel'` in a legality check is a behaviour-defining literal, and it has
 * to read the same at both the enumeration and the legality site.
 */
const ANGEL_SUBTYPE = 'angel';

/**
 * What a targeted effect may point at.
 *
 * - `'any'` — MTG's "any target": a creature, a player, **a planeswalker, or a
 *   battle** (CR 115.4 — since planeswalkers and battles both exist in this
 *   engine, "any target" includes them, exactly as the reminder text says).
 * - `'creature'` — "target creature" only. Never a player's face, never a walker.
 * - `'player'` — "target player" only. Never a creature or a planeswalker.
 * - `'spell'` — "target spell": an object on the stack. Its point is the *timing*
 *   rule rather than the aim — a counterspell with an empty stack has no legal
 *   target and therefore **cannot be cast at all**. Without it, "Counter target
 *   spell. You gain 3 life." was castable into an empty stack for a free three
 *   life, which is strictly better than the printed card.
 */
export type TargetRestriction =
  | 'any'
  | 'creature'
  | 'player'
  | 'spell'
  /** "target artifact" — an artifact permanent, never a creature or a face. */
  | 'artifact'
  /**
   * "target opponent" — a player who ISN'T the caster.
   *
   * This one is unlike the others: legality depends on WHO is casting, not only
   * on the board. Every checker therefore takes an optional `controller`, and
   * when it is absent an opponent-target is treated as ILLEGAL rather than
   * guessed. Being unable to cast is a safe failure; letting a spell point at
   * its own caster would make it strictly more permissive than printed, which is
   * the exact infidelity this module exists to prevent.
   */
  | 'opponent'
  /**
   * "target creature you control" — the aim of every printed `Equip {N}`
   * ability ("Attach to target creature you control").
   *
   * Like `'opponent'`, legality depends on WHO is acting rather than only on the
   * board, so an absent `controller` makes it ILLEGAL rather than guessed. It
   * exists as its own restriction instead of being approximated by `'creature'`
   * for the usual reason: offering an Equipment every creature on the table lets
   * a pilot spend mana equipping the opponent's board, which is a card playing
   * differently from its printed text.
   */
  | 'creatureYouControl'
  /**
   * "target NONLEGENDARY creature you control" — Kiki-Jiki's aim, and Fable of
   * the Mirror-Breaker's.
   *
   * Its own restriction rather than an approximation of 'creatureYouControl',
   * and the direction is the whole reason: a card that may not copy a legend
   * compiled as one that may is a card playing WIDER than printed — in this
   * family the difference between a fair rare and an infinite combo with every
   * legendary creature ever printed. (Kiki-Jiki is itself legendary, so the
   * printed word is exactly what stops it copying itself.)
   */
  | 'nonlegendaryCreatureYouControl'
  /**
   * "target artifact or creature you control" — Molten Duplication's aim.
   * Neither 'creatureYouControl' widened nor 'permanent' narrowed: the first
   * cannot reach the Sol Ring the card is often pointed at, the second reaches
   * a land and the opponent's board. Controller-dependent like its neighbours.
   */
  | 'artifactOrCreatureYouControl'
  /**
   * "target NON-ANGEL creature you control" — Restoration Angel's printed line.
   *
   * Its own restriction rather than `'creatureYouControl'` for a reason the soak
   * would find within a thousand games: Restoration Angel blinks a creature you
   * control, and it is itself a creature you control. Widen this to any creature
   * and the pilot blinks the Angel with its own trigger, which re-triggers it,
   * for ever — the same shape as the copy mirror in DESIGN §3.33.
   *
   * ⚠️ Named for the printed line, in the style of `instantOrSorceryInYourGraveyard`.
   * The general form is a target that carries a {@link CardFilter} (which already
   * spells "non-Goblin creature" as `noneOfSubtypes`) — worth building the day a
   * SECOND non-<subtype> card lands, and not before: `TargetRestriction` is a flat
   * string union read at 67 sites, and giving it a shape is a change of a
   * different size from adding a member.
   */
  | 'nonAngelCreatureYouControl'
  /**
   * "target creature an OPPONENT controls" — Banisher Priest's printed line.
   *
   * The mirror of `creatureYouControl`, and like it (and `'opponent'`) legality
   * depends on WHO is acting, so an absent `controller` makes every candidate
   * illegal rather than guessed. Its own restriction rather than `'creature'`
   * because widening it would let a pilot exile its OWN board — a card playing
   * differently from its printed text, and in this case a strictly worse play
   * offered as if it were legal.
   */
  | 'creatureAnOpponentControls'
  /**
   * "target artifact, enchantment, or land" — Acidic Slime's printed line, and
   * the shape of most naturalize-family removal. One restriction rather than
   * three, because the printed line is one target with three acceptable types.
   */
  | 'artifactEnchantmentOrLand'
  /**
   * "target artifact or enchantment" — the naturalize pair without the land
   * (Reclamation Sage, Naturalize itself). Its own member because widening to
   * the three-type form would let the card hit a land the printed one cannot.
   */
  | 'artifactOrEnchantment'
  /**
   * The unscoped PERMANENT nouns the removal family prints, each its own
   * member for the reason the whole union is closed: a card that may destroy
   * "an artifact or creature" may not destroy a land, and widening it to
   * 'permanent' is a card playing wider than printed.
   */
  | 'artifactOrCreature'
  | 'creatureOrEnchantment'
  /** "destroy target NONARTIFACT creature" (Go for the Throat). */
  | 'nonartifactCreature'
  /** "destroy/exile target NONLAND permanent" (Void Rend, Utter End). */
  | 'nonlandPermanent'
  /** "counter target NONCREATURE spell" (Negate, Dovin's Veto). */
  | 'noncreatureSpell'
  /** "counter target INSTANT spell" (Dispel). */
  | 'instantSpell'
  /**
   * "target player or planeswalker" — a face or a walker, never a creature.
   * Lava Spike's printed line. Its own restriction (not `'player'`) because
   * flattening it would make the card NARROWER than printed now that
   * planeswalkers exist — the same infidelity this module polices, in the other
   * direction.
   */
  | 'playerOrPlaneswalker'
  /** "target creature or planeswalker" — a permanent of either kind, never a face. */
  | 'creatureOrPlaneswalker'
  /**
   * "target permanent" — ANY permanent on the battlefield: a creature, a land,
   * an artifact, an enchantment, a planeswalker. Never a player and never a
   * spell on the stack.
   *
   * Its own restriction rather than a flavour of `'any'` because the two are
   * genuinely different sets: "any target" reaches a player's face but not a
   * land, and this reaches a land but never a face. Cryptic Command's bounce
   * mode is the canonical printing, and flattening it either way would play the
   * card differently from its text.
   */
  | 'permanent'
  /**
   * "target instant or sorcery card in your graveyard" — Snapcaster Mage's ETB
   * aim, and the first restriction reaching a card in a NON-battlefield zone.
   *
   * Like `'opponent'` and `'creatureYouControl'`, legality depends on WHO is
   * acting: "your graveyard" is the acting player's own, so an absent
   * `controller` makes every candidate ILLEGAL rather than guessed — being
   * unable to aim is the safe failure, while reaching into the wrong graveyard
   * would be a card playing wider than printed.
   *
   * Hexproof/shroud/protection do not apply here by RULE, not by omission:
   * those abilities read "this permanent", and a card in a graveyard is not a
   * permanent (CR 110.1), so the battlefield targetability gate is correctly
   * skipped for this restriction.
   */
  | 'instantOrSorceryInYourGraveyard'
  /**
   * "target creature card in/from your graveyard" — the reanimate family's aim
   * (Mortuary Mire, Unearth). Same actor rule as its instant/sorcery sibling:
   * no actor, no "your graveyard", nothing offered.
   */
  | 'creatureCardInYourGraveyard'
  /**
   * "target instant or sorcery spell" — Fork, Reverberate, Narset's Reversal.
   *
   * Its own restriction rather than a flavour of `'spell'` because the two are
   * genuinely different sets: `'spell'` reaches a creature spell and an
   * artifact spell, and a card that says "instant or sorcery" may not copy one.
   * Flattening it would let Reverberate copy a Grizzly Bears, which is a card
   * playing WIDER than printed — the exact infidelity this module exists to
   * prevent, and the direction that is always the wrong one to guess in.
   *
   * The timing consequence is `'spell'`'s and is the reason it matters as much
   * as the aim: a copy spell with no instant or sorcery on the stack has no
   * legal target and therefore CANNOT BE CAST, so it can never be spent for
   * nothing.
   */
  | 'instantOrSorcerySpell'
  /**
   * "target TRIGGERED ABILITY you control" — Strionic Resonator.
   *
   * The stack holds two kinds of object, and every other stack-targeting
   * restriction here deliberately means the SPELL kind ("counter target spell"
   * cannot hit a trigger). This is the mirror: only the trigger kind, and only
   * the ones this player controls.
   */
  | 'triggeredAbilityYouControl'
  /**
   * "creatures from the battlefield AND/OR creature cards from graveyards" —
   * Angel of Serenity's printed line, and the pool's only two-zone target.
   *
   * One restriction rather than two, because the printed line is ONE target list
   * whose members may come from either zone: "up to three" means three in total,
   * not three of each. Both graveyards are in scope (it does not say "your").
   */
  | 'creatureOnBattlefieldOrInGraveyard'
  /**
   * "target instant or sorcery spell YOU CONTROL" — Lithoform Engine's middle
   * mode, Kitsa. The controller scope is the whole point: the printed card can
   * only fork its OWN spells, and widening it to `instantOrSorcerySpell` would
   * let a pilot copy the opponent's removal at them — a strictly better card.
   */
  | 'instantOrSorcerySpellYouControl'
  /**
   * "target PERMANENT spell you control" — Lithoform Engine's top mode. A
   * permanent spell is a spell on the stack that is NOT an instant or sorcery;
   * the copy resolves into a token (`spell-copy.ts` stamps token-ness), which is
   * already how every permanent-spell copy resolves here.
   */
  | 'permanentSpellYouControl'
  /**
   * "target activated or triggered ability you control" — Lithoform Engine's
   * bottom mode, Return the Favor's mode. Both kinds sit on the stack as
   * `kind: 'trigger'` objects; what separates this from
   * `triggeredAbilityYouControl` is that it ALSO accepts the ones stamped
   * `origin: 'activated'`, which the triggered-only wording must refuse.
   */
  | 'activatedOrTriggeredAbilityYouControl'
  /**
   * "target nonland permanent you control" — Extravagant Replication's printed
   * line (with "another", which rides separately as `targetsExcludeSelf`). Its
   * own member because `permanent` reaches lands and this must not: copying a
   * land for value is not what the printed card offers.
   */
  | 'nonlandPermanentYouControl'
  /**
   * "target token you control" — Caretaker's Talent's level-2 aim. Reads the
   * CR 111.1 token-ness stamp (`def.isToken`), which `createOneTokenInState`
   * writes on every token however it was made — so a token copy of a printed
   * card is offered and the printed card itself never is.
   */
  | 'tokenYouControl'
  /** "target enchantment" — an enchantment permanent (Casualties of War's mode). */
  | 'enchantment'
  /** "target land" — a land on the battlefield, never one in a hand or yard. */
  | 'land'
  /** "target planeswalker" — a walker only, never a face ('playerOrPlaneswalker' reaches both). */
  | 'planeswalker';

/**
 * Whether a spell on the stack is an INSTANT OR SORCERY spell — the one question
 * `'instantOrSorcerySpell'` adds over `'spell'`.
 *
 * Read off the card ON THE STACK, which is the object with the characteristics
 * that matter: a modal DFC cast as its instant face, a split card's chosen half
 * and an adventure being cast as its adventure half are all already carried in
 * `card.def` by the cast path, so this asks nothing about layouts and is right
 * for all three by construction. A COPY of a spell answers yes for the same
 * reason — its definition is the copiable values of what it copies — which is
 * what makes a copy of a copy legal, exactly as the rules do.
 */
function isInstantOrSorcerySpell(spell: SpellStackObject): boolean {
  return hasType(spell.card.def, 'instant') || hasType(spell.card.def, 'sorcery');
}

/**
 * The reserved effect-param name carrying a {@link TargetRestriction}. One name,
 * read identically by core's legality checks, the primitives, and both AI pilots —
 * so "what may this spell target" has exactly one answer in the codebase.
 */
export const TARGET_RESTRICTION_PARAM = 'targets';

/**
 * The restriction assumed when a targeting effect declares none: unrestricted
 * "any target". Keeping this the default is what leaves every already-authored
 * card (Lightning Bolt, Shock, Searing Spear) behaving exactly as before.
 */
export const DEFAULT_TARGET_RESTRICTION: TargetRestriction = 'any';

/** Whether an arbitrary value is a valid restriction word. */
export function isTargetRestriction(value: unknown): value is TargetRestriction {
  return (
    value === 'any' ||
    value === 'creature' ||
    value === 'player' ||
    value === 'spell' ||
    value === 'artifact' ||
    value === 'opponent' ||
    value === 'creatureYouControl' ||
    value === 'nonlegendaryCreatureYouControl' ||
    value === 'artifactOrCreatureYouControl' ||
    value === 'nonAngelCreatureYouControl' ||
    value === 'creatureAnOpponentControls' ||
    value === 'artifactEnchantmentOrLand' ||
    value === 'artifactOrEnchantment' ||
    value === 'artifactOrCreature' ||
    value === 'creatureOrEnchantment' ||
    value === 'nonartifactCreature' ||
    value === 'nonlandPermanent' ||
    value === 'noncreatureSpell' ||
    value === 'instantSpell' ||
    value === 'playerOrPlaneswalker' ||
    value === 'creatureOrPlaneswalker' ||
    value === 'permanent' ||
    value === 'instantOrSorceryInYourGraveyard' ||
    value === 'creatureCardInYourGraveyard' ||
    value === 'instantOrSorcerySpell' ||
    value === 'triggeredAbilityYouControl' ||
    value === 'instantOrSorcerySpellYouControl' ||
    value === 'permanentSpellYouControl' ||
    value === 'activatedOrTriggeredAbilityYouControl' ||
    value === 'nonlandPermanentYouControl' ||
    value === 'tokenYouControl' ||
    value === 'enchantment' ||
    value === 'land' ||
    value === 'planeswalker' ||
    value === 'creatureOnBattlefieldOrInGraveyard'
  );
}

/**
 * Every member of {@link TargetRestriction}, spelled once as a value so the
 * union has a RUNTIME form. `satisfies Record<TargetRestriction, true>` is what
 * keeps this list honest in BOTH directions at compile time: a union member
 * missing here is a type error, and a key that is not a union member is a type
 * error — so the list cannot drift from the type it mirrors, which is the
 * property a hand-kept array or a source-parsing test could not give.
 *
 * EXPORT-ONLY: nothing in the engine reads {@link ALL_TARGET_RESTRICTIONS}.
 * It exists for the §3.49 completeness invariant. A restriction word has FIVE
 * homes — this union, {@link isTargetRestriction}, {@link isLegalTarget}, the
 * enumerator behind {@link legalTargetsFor}, and {@link describeRestriction} —
 * and §3.40 was a word given four of the five: the validator miss made
 * `restrictionOfEffects` read the declared restriction back as `undefined`,
 * silently, wearing the costume of an AI limitation. The invariant sweeps this
 * list through all five homes so the NEXT word fails loudly until every home
 * knows it.
 */
const TARGET_RESTRICTION_MEMBERS = {
  any: true,
  creature: true,
  player: true,
  spell: true,
  artifact: true,
  opponent: true,
  creatureYouControl: true,
  nonAngelCreatureYouControl: true,
  nonlegendaryCreatureYouControl: true,
  artifactOrCreatureYouControl: true,
  creatureAnOpponentControls: true,
  artifactEnchantmentOrLand: true,
  artifactOrEnchantment: true,
  artifactOrCreature: true,
  creatureOrEnchantment: true,
  nonartifactCreature: true,
  nonlandPermanent: true,
  noncreatureSpell: true,
  instantSpell: true,
  playerOrPlaneswalker: true,
  creatureOrPlaneswalker: true,
  permanent: true,
  instantOrSorceryInYourGraveyard: true,
  creatureCardInYourGraveyard: true,
  instantOrSorcerySpell: true,
  triggeredAbilityYouControl: true,
  creatureOnBattlefieldOrInGraveyard: true,
  instantOrSorcerySpellYouControl: true,
  permanentSpellYouControl: true,
  activatedOrTriggeredAbilityYouControl: true,
  nonlandPermanentYouControl: true,
  tokenYouControl: true,
  enchantment: true,
  land: true,
  planeswalker: true,
} as const satisfies Record<TargetRestriction, true>;

/** See {@link TARGET_RESTRICTION_MEMBERS} — the union as a frozen runtime list. */
export const ALL_TARGET_RESTRICTIONS: readonly TargetRestriction[] = Object.freeze(
  Object.keys(TARGET_RESTRICTION_MEMBERS) as TargetRestriction[],
);

/**
 * Memo for {@link targetRestrictionOf}. Card definitions are immutable and shared
 * (the pool is frozen; every instance points at the same object), and this is read
 * for every card in hand on every `generateLegalActions` — the engine's hottest
 * read. Scanning the effect list each time put allocation on the sim's hot path.
 *
 * `null` is memoized too: "this definition declares no restriction" is the common
 * answer and must not be recomputed either.
 */
/**
 * The shared, frozen empty answer for a restriction that can offer nothing on
 * this board. Shared so the no-candidate case allocates nothing on the
 * legal-action loop, exactly like `internal/continuous.ts`’s EMPTY_INDEX.
 */
const NO_TARGETS: readonly (InstanceId | PlayerId)[] = Object.freeze([]);

const RESTRICTION_MEMO = new WeakMap<CardDefinition, TargetRestriction | null>();

/**
 * The target restriction core ENFORCES for a definition, or `undefined` when
 * there is none to enforce.
 *
 * When several effects declare one — "deals N damage to target creature and you
 * gain N life" is two refs but one target — the NARROWEST wins, because every
 * effect of a single spell points at the same chosen target and the printed card
 * can only be as permissive as its strictest clause.
 *
 * `'any'` (declared or defaulted) deliberately yields `undefined`, i.e. core does
 * not police it. Two reasons, and they point the same way:
 *   - *Nothing to enforce.* "Any target" excludes only things nobody targets
 *     anyway (a land, a card in a graveyard), and the primitive already refuses
 *     those at resolution. There is no way to play an "any target" spell as
 *     better than printed.
 *   - *Cost.* Enforcing it would make `generateLegalActions` enumerate one cast
 *     per creature-plus-player for every burn spell in hand, on the engine's
 *     hottest loop and straight into the search's branching factor — a real
 *     throughput regression (DESIGN §1.6) bought with no fidelity.
 * So an already-authored unrestricted card behaves exactly as it always has, and
 * only a card whose printed text is genuinely NARROWER than "any target" changes.
 */
export function targetRestrictionOf(def: CardDefinition): TargetRestriction | undefined {
  const memoized = RESTRICTION_MEMO.get(def);
  if (memoized !== undefined) return memoized ?? undefined;
  // Only a restriction NARROWER than the default is enforceable, so an explicit
  // `targets: 'any'` reads the same as declaring nothing at all (see above).
  const found = restrictionOfEffects(def.effects ?? []) ?? null;
  RESTRICTION_MEMO.set(def, found);
  return found ?? undefined;
}

/** Whether a target reference is a player (the two seats) rather than a permanent. */
export function isPlayerTarget(target: InstanceId | PlayerId): target is PlayerId {
  return target === 'A' || target === 'B';
}

/**
 * Whether `target` satisfies `restriction` on the current board. A permanent id
 * must name a **creature currently on the battlefield** — an id that has died, or
 * one naming a land, is not a legal creature target.
 */
export function isLegalTarget(
  state: GameState,
  restriction: TargetRestriction,
  target: InstanceId | PlayerId,
  controller?: PlayerId,
  source?: CardDefinition,
  /** See {@link legalTargetsFor} — the instance "another" excludes. */
  excludeInstanceId?: InstanceId,
): boolean {
  // Checked first and for every restriction: "another" is orthogonal to type,
  // and the enumeration site applies the same rule (DESIGN §3.36 — offer and
  // apply must agree).
  if (excludeInstanceId !== undefined && target === excludeInstanceId) return false;
  if (isPlayerTarget(target)) {
    if (restriction === 'opponent') {
      // Unknown caster ⇒ illegal, never "probably fine" (see the type's note).
      return controller !== undefined && target !== controller;
    }
    return restriction === 'any' || restriction === 'player' || restriction === 'playerOrPlaneswalker';
  }
  if (restriction === 'player' || restriction === 'opponent') return false;
  if (restriction === 'creatureOnBattlefieldOrInGraveyard') {
    for (const player of PLAYER_IDS) {
      const yard = state.players[player].graveyard;
      for (let i = 0; i < yard.length; i++) {
        const card = yard[i] as CardInstance;
        if (card.instanceId === target) return isCreature(card.def);
      }
    }
    // Not in a graveyard ⇒ it must be a creature on the battlefield — and the
    // battlefield half goes through the SAME hexproof/shroud/protection gate the
    // enumerator applies (CR 115.1c). §3.49's invariant layer caught this half
    // answering on type alone: the menu never offered an opponent's hexproof
    // creature, but a hand-built action aimed at one was accepted. A graveyard
    // card has no such qualities to consult, which is why only this half gates.
    for (const permanent of state.battlefield) {
      if (permanent.instanceId === target) {
        return isCreature(permanent.def) && isTargetableBy(state, permanent, controller, source);
      }
    }
    return false;
  }
  if (restriction === 'instantOrSorceryInYourGraveyard') {
    // "Your graveyard" needs an actor; unknown ⇒ illegal, never guessed (see
    // the type's note). The candidate must be sitting in THAT player's
    // graveyard right now — a card that left it mid-response is not a legal
    // target any more, which is exactly how the resolution re-check fizzles.
    if (controller === undefined) return false;
    const yard = state.players[controller].graveyard;
    for (let i = 0; i < yard.length; i++) {
      const card = yard[i] as CardInstance;
      if (card.instanceId !== target) continue;
      return hasType(card.def, 'instant') || hasType(card.def, 'sorcery');
    }
    return false;
  }
  if (restriction === 'creatureCardInYourGraveyard') {
    if (controller === undefined) return false;
    const yard = state.players[controller].graveyard;
    for (let i = 0; i < yard.length; i++) {
      const card = yard[i] as CardInstance;
      if (card.instanceId !== target) continue;
      return isCreature(card.def);
    }
    return false;
  }
  if (
    restriction === 'spell' ||
    restriction === 'instantOrSorcerySpell' ||
    restriction === 'instantOrSorcerySpellYouControl' ||
    restriction === 'permanentSpellYouControl' ||
    restriction === 'noncreatureSpell' ||
    restriction === 'instantSpell'
  ) {
    // A *spell* on the stack — never a triggered ability, which is also a stack
    // object but is not a spell and cannot be countered by "counter target spell".
    for (let i = 0; i < state.stack.length; i++) {
      const object = state.stack[i] as StackObject;
      if (object.kind !== 'spell' || object.instanceId !== target) continue;
      if (restriction === 'spell') return true;
      // The printed spell-TYPE narrowings, read off the card on the stack: a
      // creature spell is not a legal Negate target, and only an instant is a
      // legal Dispel target.
      if (restriction === 'noncreatureSpell') return !isCreature(object.card.def);
      if (restriction === 'instantSpell') return hasType(object.card.def, 'instant');
      // The "you control" scopes: unknown actor ⇒ illegal, never "probably
      // mine" — the same rule every other controller-scoped restriction follows.
      if (restriction === 'instantOrSorcerySpellYouControl') {
        return controller !== undefined && object.controller === controller && isInstantOrSorcerySpell(object);
      }
      if (restriction === 'permanentSpellYouControl') {
        return controller !== undefined && object.controller === controller && !isInstantOrSorcerySpell(object);
      }
      return isInstantOrSorcerySpell(object);
    }
    return false;
  }
  if (restriction === 'triggeredAbilityYouControl' || restriction === 'activatedOrTriggeredAbilityYouControl') {
    // Unknown actor ⇒ illegal, never "probably theirs" — the same rule
    // `'opponent'` and `creatureYouControl` follow.
    if (controller === undefined) return false;
    for (let i = 0; i < state.stack.length; i++) {
      const object = state.stack[i] as StackObject;
      if (object.kind !== 'trigger' || object.instanceId !== target) continue;
      // "Copy target TRIGGERED ability" must refuse an activated one on the
      // stack (CR 603 vs 602 — different words on the printed card); the
      // "activated or triggered" wording takes both. The marker is stamped by
      // `applyActivateAbility`; its absence means a genuine triggered ability.
      if (restriction === 'triggeredAbilityYouControl' && object.origin === 'activated') return false;
      return object.controller === controller;
    }
    return false;
  }
  const permanent = state.battlefield.find((c) => c.instanceId === target);
  if (!permanent) return false;
  if (!isTargetableBy(state, permanent, controller, source)) return false;
  // "Target permanent": being on the battlefield IS the whole requirement, so
  // the targetability check above is the only gate.
  if (restriction === 'permanent') return true;
  if (restriction === 'artifact') return permanent.def.types.includes('artifact');
  if (restriction === 'enchantment') return hasType(permanent.def, 'enchantment');
  if (restriction === 'land') return isLand(permanent.def);
  if (restriction === 'planeswalker') return isPlaneswalker(permanent.def);
  // "Target player or planeswalker": a permanent target must be a walker.
  if (restriction === 'playerOrPlaneswalker') return isPlaneswalker(permanent.def);
  // "Any target" reaches a creature, a player, a planeswalker OR A BATTLE
  // (CR 115.4 as amended when battles were printed), so burn answers a Siege
  // exactly as it answers a walker. "Creature or planeswalker" deliberately does
  // NOT widen with it: that printed wording names two kinds, not three.
  if (restriction === 'any') {
    return isCreature(permanent.def) || isPlaneswalker(permanent.def) || isBattle(permanent.def);
  }
  if (restriction === 'creatureOrPlaneswalker') {
    return isCreature(permanent.def) || isPlaneswalker(permanent.def);
  }
  if (restriction === 'artifactEnchantmentOrLand') {
    return hasType(permanent.def, 'artifact') || hasType(permanent.def, 'enchantment') || isLand(permanent.def);
  }
  if (restriction === 'artifactOrEnchantment') {
    return hasType(permanent.def, 'artifact') || hasType(permanent.def, 'enchantment');
  }
  if (restriction === 'artifactOrCreature') {
    return hasType(permanent.def, 'artifact') || isCreature(permanent.def);
  }
  if (restriction === 'creatureOrEnchantment') {
    return isCreature(permanent.def) || hasType(permanent.def, 'enchantment');
  }
  if (restriction === 'nonartifactCreature') {
    return isCreature(permanent.def) && !hasType(permanent.def, 'artifact');
  }
  if (restriction === 'nonlandPermanent') {
    return !isLand(permanent.def);
  }
  if (restriction === 'creatureAnOpponentControls') {
    // Unknown actor ⇒ illegal, never "probably theirs" (see the type's note).
    if (controller === undefined || permanent.controller === controller) return false;
    return isCreature(permanent.def);
  }
  if (restriction === 'nonlandPermanentYouControl') {
    // Unknown actor ⇒ illegal, never "probably mine" (see the type's note).
    if (controller === undefined || permanent.controller !== controller) return false;
    return !isLand(permanent.def);
  }
  if (restriction === 'tokenYouControl') {
    // Unknown actor ⇒ illegal, never "probably mine" (see the type's note).
    if (controller === undefined || permanent.controller !== controller) return false;
    // The CR 111.1 stamp, not a name heuristic: a token copy of a printed card
    // answers true, the printed card answers false.
    return permanent.def.isToken === true;
  }
  if (restriction === 'artifactOrCreatureYouControl') {
    // Unknown actor ⇒ illegal, never "probably mine" (see the type's note).
    if (controller === undefined || permanent.controller !== controller) return false;
    return isCreature(permanent.def) || permanent.def.types.includes('artifact');
  }
  if (
    restriction === 'creatureYouControl' ||
    restriction === 'nonAngelCreatureYouControl' ||
    restriction === 'nonlegendaryCreatureYouControl'
  ) {
    // Unknown actor ⇒ illegal, never "probably mine" (see the type's note).
    if (controller === undefined || permanent.controller !== controller) return false;
    if (restriction === 'nonAngelCreatureYouControl' && hasSubtype(permanent.def, ANGEL_SUBTYPE)) {
      return false;
    }
    // The printed word "nonlegendary", read off the CURRENT definition — which
    // is what a copy effect has to read: a token copy of a legend is legendary,
    // and a Clone that copied one is too.
    if (restriction === 'nonlegendaryCreatureYouControl' && permanent.def.legendary === true) return false;
  }
  return isCreature(permanent.def);
}

/**
 * Whether `permanent` may be targeted at all by `caster` — the hexproof/shroud
 * check, applied before any restriction so it holds for every targeting effect
 * rather than each one remembering it.
 *
 * Shroud blocks everyone. Hexproof blocks only opponents, so it needs the
 * caster; with an UNKNOWN caster a hexproof permanent is treated as untargetable
 * — the conservative direction, since guessing the other way would let an
 * opponent's spell through a protection the card really has.
 *
 * Granted keywords are read through the continuous layer, so a creature given
 * hexproof by an aura or a pump is protected too.
 *
 * PROTECTION's "can't be targeted" half is checked here too, keyed on the
 * SOURCE definition (`protection.ts`): a spell whose source has a protected
 * quality may not aim here, whoever casts it — its own controller included,
 * which is why protection does not share hexproof's own-controller escape.
 * With an UNKNOWN source a protected permanent is treated as untargetable, the
 * same conservative direction as an unknown caster under hexproof.
 */
function isTargetableBy(
  state: GameState,
  permanent: CardInstance,
  caster: PlayerId | undefined,
  source?: CardDefinition,
  /**
   * The index to judge granted keywords against, from {@link keywordIndexFor}:
   * `null` means "nothing on this board modifies a keyword, read the printed
   * set". Passed in so a menu builder pays for ONE index across every candidate
   * instead of one per candidate; omit it for a single ad-hoc check.
   */
  index?: ContinuousIndex | null,
): boolean {
  const mods = index === undefined ? keywordIndexFor(state) : index;
  // PERFORMANCE: this runs for every candidate target of every castable spell on
  // the engine's hottest loop. On the overwhelmingly common board — no anthem, no
  // attachment, no until-EOT effect — `mods` is null and the printed set is read
  // with no aggregation and no allocation at all.
  const keywords =
    mods === null
      ? (permanent.def.keywords ?? NO_KEYWORDS)
      : effectiveKeywords(permanent, mods.get(permanent.instanceId) ?? NO_MOD);
  if (keywords.shroud === true) return false;
  if (keywords.hexproof === true && (caster === undefined || caster !== permanent.controller)) {
    return false;
  }
  if (keywords.protectionFrom !== undefined && protectionBlocksSource(keywords.protectionFrom, source)) {
    return false;
  }
  return true;
}

/** The empty printed keyword set, shared so the fast path allocates nothing. */
const NO_KEYWORDS: KeywordFlags = Object.freeze({});

/**
 * The continuous index targeting must judge keywords against, or `null` when
 * nothing on the board can modify one.
 *
 * ⚠️ The gate is {@link anyContinuousModification} and NOT `state.continuous.length`.
 * Layer 3 — an Aura/Equipment's grant to its host, an anthem, an emblem — is
 * derived from the battlefield and never appears in that list, so keying the fast
 * path on it let an opponent's burn spell target a creature holding Mask of
 * Avacyn's granted hexproof. Costed at the module's own bar: on a board with no
 * modifier at all the check short-circuits over property reads and allocates
 * nothing, and when there IS one this builds the index ONCE for the whole menu
 * where the old code rebuilt it per candidate.
 */
function keywordIndexFor(state: GameState): ContinuousIndex | null {
  return anyContinuousModification(state) ? indexContinuous(state) : null;
}

/**
 * Every target that satisfies `restriction` right now: both players (a player may
 * legally be targeted by their own burn) and/or every creature on the battlefield,
 * whoever controls it. This is the menu `generateLegalActions` offers, so a
 * consumer that only ever picks from the offered actions physically cannot choose
 * an illegal target.
 */
export function legalTargetsFor(
  state: GameState,
  restriction: TargetRestriction,
  controller?: PlayerId,
  source?: CardDefinition,
  /**
   * "ANOTHER target …" — an instance this aim may not name, normally the
   * aiming ability's own source. Optional so every existing caller is unchanged;
   * a caller that does not pass it simply cannot express "another".
   */
  excludeInstanceId?: InstanceId,
): readonly (InstanceId | PlayerId)[] {
  const all = enumerateTargets(state, restriction, controller, source);
  // Applied to whatever the branches produced, so "another" works with EVERY
  // restriction rather than needing a case in each. Same rule `isLegalTarget`
  // applies, which is what keeps the offer and the apply in agreement.
  return excludeInstanceId === undefined ? all : all.filter((ref) => ref !== excludeInstanceId);
}

/** Every legal target for `restriction`, before any "another" exclusion. */
function enumerateTargets(
  state: GameState,
  restriction: TargetRestriction,
  controller?: PlayerId,
  source?: CardDefinition,
): readonly (InstanceId | PlayerId)[] {
  if (restriction === 'triggeredAbilityYouControl' || restriction === 'activatedOrTriggeredAbilityYouControl') {
    if (controller === undefined) return [];
    const out: (InstanceId | PlayerId)[] = [];
    for (let i = 0; i < state.stack.length; i++) {
      const object = state.stack[i] as StackObject;
      if (object.kind !== 'trigger') continue;
      if (object.controller !== controller) continue;
      // Same split as the legality arm: the triggered-only wording refuses the
      // activated-origin objects; the "activated or triggered" one takes both.
      if (restriction === 'triggeredAbilityYouControl' && object.origin === 'activated') continue;
      out.push(object.instanceId);
    }
    return out;
  }
  if (
    restriction === 'spell' ||
    restriction === 'instantOrSorcerySpell' ||
    restriction === 'instantOrSorcerySpellYouControl' ||
    restriction === 'permanentSpellYouControl' ||
    restriction === 'noncreatureSpell' ||
    restriction === 'instantSpell'
  ) {
    const yoursOnly =
      restriction === 'instantOrSorcerySpellYouControl' || restriction === 'permanentSpellYouControl';
    // Controller-scoped with no actor ⇒ nothing offered (the safe direction).
    if (yoursOnly && controller === undefined) return NO_TARGETS;
    const wantInstantOrSorcery =
      restriction === 'instantOrSorcerySpell' || restriction === 'instantOrSorcerySpellYouControl';
    const wantPermanentSpell = restriction === 'permanentSpellYouControl';
    const out: (InstanceId | PlayerId)[] = [];
    for (let i = 0; i < state.stack.length; i++) {
      const object = state.stack[i] as StackObject;
      if (object.kind !== 'spell') continue;
      if (yoursOnly && object.controller !== controller) continue;
      if (wantInstantOrSorcery && !isInstantOrSorcerySpell(object)) continue;
      if (wantPermanentSpell && isInstantOrSorcerySpell(object)) continue;
      // The printed spell-TYPE narrowings, asked exactly as `isLegalTarget`
      // asks them — the offer list and the apply path must name the same set
      // (DESIGN §3.36), which the zoo-board agreement test enforces.
      if (restriction === 'noncreatureSpell' && isCreature(object.card.def)) continue;
      if (restriction === 'instantSpell' && !hasType(object.card.def, 'instant')) continue;
      out.push(object.instanceId);
    }
    return out;
  }
  if (restriction === 'instantOrSorceryInYourGraveyard') {
    // With no actor there is no such thing as "your graveyard", so nothing is
    // offered — the same safe direction as 'opponent', and the one that makes an
    // unaimable trigger leave the stack rather than resolve pointing at nothing.
    if (controller === undefined) return NO_TARGETS;
    const out: (InstanceId | PlayerId)[] = [];
    const graveyard = state.players[controller].graveyard;
    for (let g = 0; g < graveyard.length; g++) {
      const card = graveyard[g] as CardInstance;
      if (hasType(card.def, 'instant') || hasType(card.def, 'sorcery')) out.push(card.instanceId);
    }
    return out;
  }
  if (restriction === 'creatureCardInYourGraveyard') {
    if (controller === undefined) return NO_TARGETS;
    const out: (InstanceId | PlayerId)[] = [];
    const graveyard = state.players[controller].graveyard;
    for (let g = 0; g < graveyard.length; g++) {
      const card = graveyard[g] as CardInstance;
      if (isCreature(card.def)) out.push(card.instanceId);
    }
    return out;
  }
  const targets: (InstanceId | PlayerId)[] = [];
  // ONE index for the whole menu. Every `isTargetableBy` below is handed it, so a
  // board carrying an anthem or an Equipment pays for the aggregation once rather
  // than once per candidate (which is what the previous shape did).
  const keywordIndex = keywordIndexFor(state);
  if (restriction === 'creatureOnBattlefieldOrInGraveyard') {
    const out: (InstanceId | PlayerId)[] = [];
    for (const permanent of state.battlefield) {
      if (isCreature(permanent.def) && isTargetableBy(state, permanent, controller, source, keywordIndex)) {
        out.push(permanent.instanceId);
      }
    }
    // BOTH graveyards — the printed line does not say "your". A card in a
    // graveyard has no protection/hexproof to consult (those are battlefield
    // qualities), so it is offered on type alone.
    for (const player of PLAYER_IDS) {
      for (const card of state.players[player].graveyard) {
        if (isCreature(card.def)) out.push(card.instanceId);
      }
    }
    return out;
  }
  if (restriction === 'any' || restriction === 'player' || restriction === 'playerOrPlaneswalker') {
    targets.push(...PLAYER_IDS);
  }
  if (restriction === 'opponent') {
    // With no caster there is no such thing as "an opponent", so nothing is
    // offered and the spell simply cannot be cast — the safe direction.
    if (controller !== undefined) {
      targets.push(...PLAYER_IDS.filter((player) => player !== controller));
    }
  }
  // A hexproof/shroud permanent is never OFFERED, so a consumer picking only
  // from this menu cannot try an illegal target in the first place.
  if (restriction === 'any' || restriction === 'creature' || restriction === 'creatureOrPlaneswalker') {
    // "Any target" (and "creature or planeswalker") includes planeswalkers —
    // CR 115.4 — so a walker on the battlefield is a real member of this menu.
    // "Any target" reaches BATTLES too; the narrower two-kind wording does not.
    const walkersToo = restriction !== 'creature';
    const battlesToo = restriction === 'any';
    for (const permanent of state.battlefield) {
      const kindOk =
        isCreature(permanent.def) ||
        (walkersToo && isPlaneswalker(permanent.def)) ||
        (battlesToo && isBattle(permanent.def));
      if (kindOk && isTargetableBy(state, permanent, controller, source, keywordIndex)) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'playerOrPlaneswalker') {
    for (const permanent of state.battlefield) {
      if (isPlaneswalker(permanent.def) && isTargetableBy(state, permanent, controller, source, keywordIndex)) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'artifactEnchantmentOrLand') {
    for (const permanent of state.battlefield) {
      if (
        (hasType(permanent.def, 'artifact') ||
          hasType(permanent.def, 'enchantment') ||
          isLand(permanent.def)) &&
        isTargetableBy(state, permanent, controller, source, keywordIndex)
      ) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'artifactOrEnchantment') {
    for (const permanent of state.battlefield) {
      if (
        (hasType(permanent.def, 'artifact') || hasType(permanent.def, 'enchantment')) &&
        isTargetableBy(state, permanent, controller, source, keywordIndex)
      ) {
        targets.push(permanent.instanceId);
      }
    }
  }
  // The unscoped permanent nouns, offered through the same targetability gate
  // every other menu uses — one predicate each, matching `isLegalTarget` above
  // so the offer list and the apply path can never disagree (DESIGN §3.36).
  if (
    restriction === 'artifactOrCreature' ||
    restriction === 'creatureOrEnchantment' ||
    restriction === 'nonartifactCreature' ||
    restriction === 'nonlandPermanent'
  ) {
    for (const permanent of state.battlefield) {
      const matches =
        restriction === 'artifactOrCreature'
          ? hasType(permanent.def, 'artifact') || isCreature(permanent.def)
          : restriction === 'creatureOrEnchantment'
            ? isCreature(permanent.def) || hasType(permanent.def, 'enchantment')
            : restriction === 'nonartifactCreature'
              ? isCreature(permanent.def) && !hasType(permanent.def, 'artifact')
              : !isLand(permanent.def);
      if (matches && isTargetableBy(state, permanent, controller, source, keywordIndex)) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'nonlandPermanentYouControl' && controller !== undefined) {
    for (const permanent of state.battlefield) {
      if (
        permanent.controller === controller &&
        !isLand(permanent.def) &&
        isTargetableBy(state, permanent, controller, source, keywordIndex)
      ) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'tokenYouControl' && controller !== undefined) {
    for (const permanent of state.battlefield) {
      if (
        permanent.controller === controller &&
        permanent.def.isToken === true &&
        isTargetableBy(state, permanent, controller, source, keywordIndex)
      ) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'creatureAnOpponentControls' && controller !== undefined) {
    for (const permanent of state.battlefield) {
      if (
        permanent.controller !== controller &&
        isCreature(permanent.def) &&
        isTargetableBy(state, permanent, controller, source, keywordIndex)
      ) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (
    (restriction === 'creatureYouControl' ||
      restriction === 'nonAngelCreatureYouControl' ||
      restriction === 'nonlegendaryCreatureYouControl') &&
    controller !== undefined
  ) {
    const excludeLegends = restriction === 'nonlegendaryCreatureYouControl';
    for (const permanent of state.battlefield) {
      if (
        permanent.controller === controller &&
        isCreature(permanent.def) &&
        !(excludeLegends && permanent.def.legendary === true) &&
        // The offer list and `isLegalTarget` must agree, or the menu offers a
        // cast the apply path refuses — see DESIGN §3.36 for what that costs.
        !(restriction === 'nonAngelCreatureYouControl' && hasSubtype(permanent.def, ANGEL_SUBTYPE)) &&
        isTargetableBy(state, permanent, controller, source, keywordIndex)
      ) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'artifact') {
    for (const permanent of state.battlefield) {
      if (permanent.def.types.includes('artifact') && isTargetableBy(state, permanent, controller, source, keywordIndex)) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'enchantment' || restriction === 'land' || restriction === 'planeswalker') {
    for (const permanent of state.battlefield) {
      const kindOk =
        restriction === 'enchantment'
          ? hasType(permanent.def, 'enchantment')
          : restriction === 'land'
            ? isLand(permanent.def)
            : isPlaneswalker(permanent.def);
      if (kindOk && isTargetableBy(state, permanent, controller, source, keywordIndex)) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'artifactOrCreatureYouControl' && controller !== undefined) {
    for (const permanent of state.battlefield) {
      if (
        permanent.controller === controller &&
        (isCreature(permanent.def) || permanent.def.types.includes('artifact')) &&
        isTargetableBy(state, permanent, controller, source, keywordIndex)
      ) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'permanent') {
    for (const permanent of state.battlefield) {
      if (isTargetableBy(state, permanent, controller, source, keywordIndex)) targets.push(permanent.instanceId);
    }
  }
  return targets;
}

/**
 * The reason a cast's targets are illegal, or `undefined` when they are fine.
 * Returned as a message so `applyAction`'s rejection says *why* — a silent
 * rejection is how a pilot ends up spinning on an action it cannot understand.
 *
 * A restricted spell must name **exactly one** target: every card the restriction
 * exists for is single-target, and accepting a target-less cast would let the
 * spell resolve as a free no-op instead of being an illegal play.
 */
export function illegalTargetReason(
  state: GameState,
  def: CardDefinition,
  targets: ReadonlyArray<InstanceId | PlayerId>,
  controller?: PlayerId,
): string | undefined {
  const restriction = targetRestrictionOf(def);
  if (restriction === undefined) return undefined; // unrestricted — not policed
  if (targets.length !== 1) {
    return `${def.name} targets exactly one ${describeRestriction(restriction)}`;
  }
  const target = targets[0]!;
  // The card being cast IS the source of its own targeting, so its protection
  // qualities (color, types) are checked without any caller having to say so.
  if (!isLegalTarget(state, restriction, target, controller, def)) {
    return `${def.name} can only target ${describeRestriction(restriction)}`;
  }
  return undefined;
}

/**
 * The same legality check as {@link illegalTargetReason}, but over a bare list
 * of effects rather than a whole card.
 *
 * An ACTIVATED ability has its own effects and therefore its own targeting
 * rules, independent of the spell script printed on the same card. `label` names
 * the thing being activated so a rejection reads as a sentence.
 */
export function illegalTargetReasonForEffects(
  state: GameState,
  label: string,
  effects: readonly EffectRef[],
  targets: ReadonlyArray<InstanceId | PlayerId>,
  controller?: PlayerId,
  source?: CardDefinition,
): string | undefined {
  const restriction = restrictionOfEffects(effects);
  if (restriction === undefined) return undefined; // unrestricted — not policed
  if (targets.length !== 1) {
    return `${label} targets exactly one ${describeRestriction(restriction)}`;
  }
  if (!isLegalTarget(state, restriction, targets[0]!, controller, source)) {
    return `${label} can only target ${describeRestriction(restriction)}`;
  }
  return undefined;
}

/** First narrower-than-default restriction declared by any of these effects. */
export function restrictionOfEffects(
  effects: readonly EffectRef[],
): TargetRestriction | undefined {
  for (const ref of effects) {
    const declared = ref.params?.[TARGET_RESTRICTION_PARAM];
    if (!isTargetRestriction(declared) || declared === DEFAULT_TARGET_RESTRICTION) continue;
    return declared;
  }
  return undefined;
}

/**
 * fix/reports-2026-09-01 — the prompt a TRIGGER's target question is raised with,
 * in one place so the engine (which asks it) and a UI (which may need to
 * recognise WHICH trigger a parked `selectTargets` belongs to) cannot drift apart
 * on the wording. Bug report 20260901_205339: Conjurer's Closet asked for a
 * target and then whether to use it; the board folds the two into one prompt,
 * and to do that it has to match this question to the trigger that asked it.
 */
export function triggerTargetPrompt(restriction: TargetRestriction, triggerLabel: string): string {
  return `Choose ${describeRestriction(restriction)} for ${triggerLabel}`;
}

/** Plain-English name of a restriction, for rejection messages and UI. */
export function describeRestriction(restriction: TargetRestriction): string {
  switch (restriction) {
    case 'creature':
      return 'a creature';
    case 'player':
      return 'a player';
    case 'spell':
      return 'a spell on the stack';
    case 'artifact':
      return 'an artifact';
    case 'opponent':
      return 'an opponent';
    case 'creatureYouControl':
      return 'a creature you control';
    case 'nonlegendaryCreatureYouControl':
      return 'a nonlegendary creature you control';
    case 'artifactOrCreatureYouControl':
      return 'an artifact or creature you control';
    case 'nonAngelCreatureYouControl':
      return 'a non-Angel creature you control';
    case 'creatureAnOpponentControls':
      return 'a creature an opponent controls';
    case 'artifactEnchantmentOrLand':
      return 'an artifact, enchantment, or land';
    case 'artifactOrCreature':
      return 'an artifact or creature';
    case 'creatureOrEnchantment':
      return 'a creature or enchantment';
    case 'nonartifactCreature':
      return 'a nonartifact creature';
    case 'nonlandPermanent':
      return 'a nonland permanent';
    case 'noncreatureSpell':
      return 'a noncreature spell';
    case 'instantSpell':
      return 'an instant spell';
    case 'artifactOrEnchantment':
      return 'an artifact or enchantment';
    case 'playerOrPlaneswalker':
      return 'a player or a planeswalker';
    case 'creatureOrPlaneswalker':
      return 'a creature or a planeswalker';
    case 'permanent':
      return 'a permanent';
    case 'creatureCardInYourGraveyard':
      return 'a creature card in your graveyard';
    case 'instantOrSorceryInYourGraveyard':
      return 'an instant or sorcery card in your graveyard';
    case 'creatureOnBattlefieldOrInGraveyard':
      return 'a creature on the battlefield or a creature card in a graveyard';
    case 'triggeredAbilityYouControl':
      return 'a triggered ability you control';
    case 'instantOrSorcerySpell':
      return 'an instant or sorcery spell on the stack';
    case 'instantOrSorcerySpellYouControl':
      return 'an instant or sorcery spell you control';
    case 'permanentSpellYouControl':
      return 'a permanent spell you control';
    case 'activatedOrTriggeredAbilityYouControl':
      return 'an activated or triggered ability you control';
    case 'nonlandPermanentYouControl':
      return 'a nonland permanent you control';
    case 'tokenYouControl':
      return 'a token you control';
    case 'enchantment':
      return 'an enchantment';
    case 'land':
      return 'a land';
    case 'planeswalker':
      return 'a planeswalker';
    case 'any':
      return 'any target (a creature, a player, a planeswalker, or a battle)';
  }
}
