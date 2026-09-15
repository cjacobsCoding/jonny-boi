/**
 * Card model SEAM. Core defines the minimal interfaces it needs to resolve cards;
 * package `cards` (§3.2) owns the actual card pool and the effect-primitive
 * *implementations*. The split:
 *
 *   - A **CardDefinition** is immutable data: cost, types, P/T, keyword flags, and
 *     an opaque ordered list of effect references. Core never hard-codes a card.
 *   - An **effect reference** (`EffectRef`) names a primitive by id plus a params
 *     blob. Core looks the id up in the **EffectRegistry** (which `cards` populates)
 *     and runs it against an **EffectContext**. Unknown id → safe no-op + event.
 *   - A **PermanentInstance** is the runtime object on the battlefield: a reference
 *     to its definition plus mutable per-object state (tapped, sick, damage, …).
 *
 * Composition over inheritance: there is no class-per-card-type. A "creature" is
 * just a definition whose `types` includes `'creature'`.
 */

import type { CastZone } from './actions.js';
import type { HybridComponent, ManaColor, ManaCost, ManaPool, ManaProduction } from './mana.js';
import { MANA_COLORS, convertedManaCost, isColorComponent } from './mana.js';
import type { LandPlayZone } from './actions.js';
// Type-only, so it is erased at build time and no runtime import cycle exists
// (`copy.ts` imports this module's `unionProtection` for real).
import type { CopyAsEntersSpec } from './copy.js';
import type { ManaSpendKind, ManaSpendPurpose, ManaSpendRestriction } from './spend-restriction.js';
// TYPE-ONLY, and deliberately so: `choices.ts` imports this module for its colour
// and subtype readers, so a VALUE import here would close a runtime cycle. A
// `CardFilter` is plain serializable data, so the type is all a printed cost
// needs in order to say what qualifies (see `AdditionalCastCost`) — and the
// MATCHER itself lives in this file (see {@link matchesCardFilter}), precisely so
// that the enters-tapped conditions below can ask the question without one.
import type { CardFilter } from './choices.js';

/** Broad card types core needs to enforce timing and zone transitions. */
export type CardType =
  | 'land'
  | 'creature'
  | 'instant'
  | 'sorcery'
  | 'artifact'
  | 'enchantment'
  | 'planeswalker'
  | 'battle'
  /**
   * **Kindred** (CR 308, the type formerly printed as "Tribal") — a card type
   * that ALWAYS appears alongside another one ("Kindred Sorcery", "Kindred
   * Enchantment - Faerie"), and whose entire rules content is that the card's
   * subtypes are CREATURE types even though the card is not a creature.
   *
   * That is why it is a real member of this union rather than a word the
   * compiler quietly drops. Two things in this engine read it, and both would
   * be wrong without it:
   *   - `subtypes` on a Kindred card are creature types, so a tribal static
   *     ("Faeries you control get +1/+1") and a subtype filter select it
   *     exactly as the printed card does — which they already do, because
   *     subtypes are one list here;
   *   - a card type in a GRAVEYARD is a card type: Tarmogoyf counts Kindred,
   *     so it needs a bit in `CARD_TYPE_BIT` (`derived.ts`) like every other.
   *
   * What it deliberately does NOT do is make the card a permanent: a Kindred
   * Instant is an instant and nothing else, so `isPermanentType` ignores it and
   * the card's OTHER type decides everything about how it is played.
   */
  | 'kindred';

/**
 * Keyword ability flags the combat/turn systems read as data. Core implements the
 * pure-combat keywords; broader-system keywords are present as flags so `cards`
 * can author them now, with engine hooks landing later.
 */
/**
 * The boolean-valued keys of {@link KeywordFlags} — every keyword whose whole
 * meaning is "on or off", as a name.
 *
 * Derived from the interface rather than listed, so it cannot fall behind it.
 * `internal/continuous.ts` builds its grant list against this same type (that is
 * what makes its exhaustiveness proof a proof), and {@link BlockRestriction} uses
 * it to name the keyword a blocker must have.
 */
export type BooleanKeywordName = {
  [K in keyof KeywordFlags]-?: boolean extends NonNullable<KeywordFlags[K]> ? K : never;
}[keyof KeywordFlags];

/**
 * A block restriction that COMPARES the attacker and the blocker, or reads the
 * blocker's characteristics — the half of "can't be blocked by …" that no single
 * flag can express.
 *
 * Every bound is judged against EFFECTIVE power/toughness (through the continuous
 * index `canBlock` already threads), never printed: a 1/1 pumped to 3/3 by an
 * anthem really has stopped being a legal blocker for "except by creatures with
 * power 2 or less", and reading the printed box would let it through.
 *
 * An absent field is no restriction. Two restrictions merge by taking the
 * STRICTEST of each field (see {@link KeywordFlags.blockRestriction}).
 */
/**
 * A QUALITY a blocker may be required to have, for the evasion keywords whose
 * exception names a colour or a card type rather than a keyword.
 *
 * A CLOSED union on purpose: `fear` and `intimidate` are the printed lines this
 * serves, and a quality outside it ("except by Walls", "except by creatures with
 * a +1/+1 counter") is a selector core cannot read, so its card keeps REPORTING
 * rather than compiling into a restriction that silently lets everything block.
 */
export type BlockerQuality =
  /** "artifact creatures" — the half `fear` and `intimidate` share. */
  | { readonly kind: 'artifact' }
  /** "black creatures" (fear). */
  | { readonly kind: 'color'; readonly color: ManaColor }
  /** "creatures that share a color with it" (intimidate) — read off the ATTACKER. */
  | { readonly kind: 'sharesColorWithAttacker' };

export interface BlockRestriction {
  /**
   * "…except by creatures with haste" (Gingerbrute). The blocker must have at
   * least ONE of these keywords. Named by {@link BooleanKeywordName}, so a
   * keyword that does not exist cannot be written here.
   */
  readonly blockerMustHaveAnyOf?: readonly BooleanKeywordName[];
  /** "can't be blocked by creatures with power N or greater" ⇒ `maxBlockerPower = N - 1`. */
  readonly maxBlockerPower?: number;
  /** "can't be blocked by creatures with power N or less" ⇒ `minBlockerPower = N + 1`. */
  readonly minBlockerPower?: number;
  /** "…with toughness N or greater" ⇒ `maxBlockerToughness = N - 1`. */
  readonly maxBlockerToughness?: number;
  /** "…with toughness N or less" ⇒ `minBlockerToughness = N + 1`. */
  readonly minBlockerToughness?: number;
  /**
   * **Skulk** (CR 702.118a) — "can't be blocked by creatures with greater power".
   * A flag rather than a number because the bound is the ATTACKER'S OWN effective
   * power, read at declare-blockers time: a skulking creature pumped this turn is
   * harder to block, exactly as printed.
   */
  readonly blockerPowerAtMostMine?: boolean;
  /**
   * **Fear** (CR 702.36a) and **intimidate** (CR 702.13a) — "can't be blocked
   * except by artifact creatures and/or [black creatures | creatures that share a
   * color with it]". The blocker qualifies by matching ANY entry, which is what
   * the printed "and/or" means.
   *
   * Separate from {@link blockerMustHaveAnyOf} because that names KEYWORDS: these
   * exceptions name a colour or a card type, and folding them into one list would
   * mean inventing keyword flags for "artifact" and "black".
   */
  readonly blockerMustMatchAnyOf?: readonly BlockerQuality[];
}

export interface KeywordFlags {
  readonly flying?: boolean;
  readonly vigilance?: boolean;
  readonly haste?: boolean;
  readonly firstStrike?: boolean;
  readonly doubleStrike?: boolean;
  readonly deathtouch?: boolean;
  readonly trample?: boolean;
  readonly reach?: boolean;
  readonly defender?: boolean;
  readonly lifelink?: boolean;
  /**
   * Flash — this card may be cast whenever its controller could cast an instant.
   * A timing rule rather than a combat one, read by {@link castTiming}.
   */
  readonly flash?: boolean;
  /**
   * Hexproof — this permanent can't be the target of spells or abilities your
   * OPPONENTS control. Its controller may still target it, which is why the
   * legality check needs to know who is casting.
   */
  readonly hexproof?: boolean;
  /**
   * Shroud — this permanent can't be the target of ANY spell or ability,
   * including its own controller's. Strictly stronger than hexproof.
   */
  readonly shroud?: boolean;
  /**
   * Menace — can't be blocked except by two or more creatures. A restriction on
   * the whole block DECLARATION rather than on any single pair, so it is checked
   * where blockers are declared, not in `canBlock`.
   */
  readonly menace?: boolean;
  /** Can't be blocked at all. Checked per pair in `canBlock`. */
  readonly unblockable?: boolean;
  /**
   * The blocking RESTRICTION that mirrors {@link unblockable}: this creature
   * can't block at all ("~ can't block" — Carrion Feeder, Gravecrawler,
   * Bloodghast). Checked per pair in `canBlock`, which is where it is
   * expressible: it disqualifies the blocker whatever it would be blocking.
   */
  readonly cantBlock?: boolean;
  /**
   * "Can't be blocked except by N or more creatures" — the GENERAL form of which
   * {@link menace} is the N = 2 printing (Pathrazer of Ulamog prints N = 3).
   *
   * Like menace it constrains the whole block DECLARATION rather than any single
   * pair, so `illegalBlockDeclaration` reads it and `canBlock` deliberately does
   * not. The two are folded there by taking the LARGER requirement, so a
   * creature carrying both is judged by the stricter one.
   */
  readonly minBlockers?: number;
  /**
   * **"~ must be blocked if able"** — a block REQUIREMENT (CR 509.1c), the other
   * half of the declare-blockers rules from every flag above it.
   *
   * A restriction says what the defender MAY NOT do and can be judged pair by
   * pair; a requirement says what they MUST do and can only be judged against the
   * whole declaration, because "if able" depends on what every other creature is
   * doing. `illegalBlockDeclaration` therefore resolves requirements and
   * restrictions TOGETHER (CR 509.1d — satisfy the maximum possible number of
   * requirements without violating any restriction), which is why this is not a
   * `canBlock` check.
   *
   * "Must be blocked" is satisfied by ONE blocker; {@link blockedByAllAble} is
   * the stronger printing that demands every creature that could.
   */
  readonly mustBeBlocked?: boolean;
  /**
   * **"All creatures able to block ~ do so"** — the Lure requirement. Strictly
   * stronger than {@link mustBeBlocked}: it generates one requirement PER creature
   * that could block, so a defender who blocks with only some of them has
   * satisfied fewer requirements than they could and the declaration is illegal.
   *
   * Both flags are read by the same declaration-level solver, and a creature
   * carrying both is judged by this one (satisfying every per-creature
   * requirement necessarily satisfies "at least one").
   */
  readonly blockedByAllAble?: boolean;
  /**
   * A block RESTRICTION whose selector describes the BLOCKER — "except by
   * creatures with haste" (Gingerbrute), "can't be blocked by creatures with
   * power 2 or less", skulk's "can't be blocked by creatures with greater power".
   *
   * NOT a boolean flag: the payload IS the restriction, so the keyword-merge paths
   * fold two of them by taking the STRICTEST of each bound rather than OR-ing —
   * the only reading under which both printed restrictions hold at once, and the
   * same argument `protectionFrom` (union) and `ward` (sum) each make.
   *
   * Judged per pair in `canBlock`, because it compares exactly two creatures, and
   * against EFFECTIVE power/toughness — a creature pumped past the bound really
   * can no longer block.
   */
  readonly blockRestriction?: BlockRestriction;
  /**
   * Indestructible — "damage and effects that say 'destroy' don't destroy this"
   * (CR 702.12b).
   *
   * ⚠️ **It is not a general shield, and treating it as one is the classic wrong
   * implementation.** Exactly two things stop happening:
   *   - lethal MARKED DAMAGE no longer destroys it (CR 704.5g), deathtouch's
   *     "any nonzero damage is lethal" (CR 702.2b) included;
   *   - an effect that says **destroy** — targeted removal, a board wipe — does
   *     nothing to it.
   *
   * Everything else still kills it, and each is a *different* rule that must keep
   * working: **0 or less toughness** puts it into its owner's graveyard as a
   * state-based action (CR 704.5f, which indestructible does not mention),
   * sacrifice is a cost and not destruction, exile removes it, and −N/−N effects
   * reach it through toughness. A permanent whose toughness is reduced to 0 dies
   * with indestructible on the battlefield; an implementation that skips the
   * whole death check when the flag is set gets that backwards.
   */
  readonly indestructible?: boolean;
  /**
   * **Horsemanship** (CR 702.31a) — "can't be blocked except by creatures with
   * horsemanship". A flag with no effect of its own: it exists so a horseman's
   * `blockRestriction` can NAME the quality its blockers need, exactly as
   * `flying`/`reach` pair up.
   */
  readonly horsemanship?: boolean;
  /**
   * Protection from [quality] — the printed bundle of four rules, all enforced
   * against SOURCES having any listed quality (see `protection.ts`):
   * can't be targeted, can't be dealt damage, can't be enchanted/equipped, and
   * can't be blocked, by sources with that quality. A list because a card may
   * print several ("protection from black and from green").
   *
   * NOT a boolean flag: the payload is what the protection is FROM, so the
   * keyword-merge paths (`effectiveKeywords`, the continuous layer's grant fold)
   * UNION lists instead of OR-ing booleans.
   */
  readonly protectionFrom?: readonly ProtectionQuality[];
  /**
   * Ward {N} — whenever this permanent becomes the target of a spell or ability
   * an OPPONENT controls, counter it unless that player pays {N}. The value is
   * the printed generic cost; only the plain `Ward {N}` form is modelled (a
   * ward whose cost is life, colored mana or {X} stays unimplemented rather
   * than being flattened to a generic charge). Merged additively — a creature
   * with two ward abilities charges the sum, which is what paying both costs.
   */
  readonly ward?: number;
  // --- poison family (§3.105) ---------------------------------------------------
  /**
   * **Infect** (CR 702.90) — damage this source deals is still DAMAGE, but its
   * RESULTS change (CR 120.3): to a creature it lands as that many -1/-1
   * counters instead of marked damage (120.3d); to a player it lands as that
   * many poison counters instead of life loss (120.3b). Deathtouch, lifelink,
   * "deals damage" triggers and prevention all still apply, which is why this is
   * a flag read at the ONE damage-result funnel (`damage-result.ts`) and not a
   * replacement effect. Multiple instances are redundant (702.90f).
   */
  readonly infect?: boolean;
  /**
   * **Wither** (CR 702.80) — infect's creature half only: damage to a creature
   * lands as -1/-1 counters (120.3d); damage to a player is ordinary life loss.
   * Printed on spells as well as creatures (Puncture Blast), so the funnel reads
   * the SOURCE's keywords wherever the source is (702.80c).
   */
  readonly wither?: boolean;
  /**
   * **Toxic N** (CR 702.164) — a player dealt COMBAT damage by this creature
   * also gets N poison counters, in ADDITION to the damage's other results
   * (120.3g). Only combat damage, and only players: a toxic creature that
   * fights, or that hits a planeswalker, gives no poison.
   *
   * A PAYLOAD keyword, not a boolean: "total toxic value" is the SUM of every
   * instance (702.164b), so it merges additively exactly as `ward` does.
   */
  readonly toxic?: number;

  // --- the combat keyword family (DESIGN §3.107) ------------------------------
  /**
   * **Shadow** (CR 702.28b) — "can block or be blocked by only creatures with
   * shadow". A SYMMETRIC pair rule: a shadow creature can't be blocked by a
   * non-shadow creature, and a non-shadow creature can't be blocked by a shadow
   * one. Judged per pair in `canBlock`, on both sides of the pair at once.
   */
  readonly shadow?: boolean;
  /**
   * **Flanking** (CR 702.25a) — a flag with no effect of its own, exactly like
   * {@link horsemanship}: it exists so flanking's trigger ("whenever a creature
   * WITHOUT flanking blocks this creature, the blocking creature gets −1/−1")
   * can read the quality off the blocker. The trigger itself is compiled beside
   * the flag (`becomesBlockedByCreature` + `counterpartLacksKeyword`).
   */
  readonly flanking?: boolean;
  /**
   * **Split second** (CR 702.61a) — "as long as this spell is on the stack,
   * players can't cast spells or activate abilities that aren't mana
   * abilities". A timing flag like {@link flash}, read by the engine's offer
   * pass (`splitSecondOnStack`) and by the cast/activate/cycle apply paths, so
   * the lock is enforced from both sides. Triggered abilities still trigger
   * and resolve (CR 702.61b) — nothing here touches them.
   */
  readonly splitSecond?: boolean;
  /**
   * **Myriad** (CR 702.116a) — "whenever this creature attacks, for each
   * opponent OTHER THAN defending player, you may create a token copy … attacking
   * that player".
   *
   * ⚠️ VACUOUS IN THIS ENGINE, AND RECORDED RATHER THAN DROPPED. The game is
   * strictly two-player (`PLAYER_IDS` has length 2, enforced by the conformance
   * manifest), so the set "opponents other than defending player" is EMPTY and
   * the ability does exactly nothing — that is the printed rule, not an
   * approximation. The flag stays on the definition so a future multiplayer
   * engine finds every myriad card by grepping for the field instead of
   * rediscovering the keyword one card at a time; the compiler reports the
   * vacuity in `CompileResult.vacuous` for the same reason.
   */
  readonly myriad?: boolean;
  /**
   * **"~ attacks each combat if able"** — an attack REQUIREMENT (CR 508.1d),
   * the attacker-side mirror of {@link mustBeBlocked}. A declaration that
   * leaves such a creature home while it was ABLE to attack (untapped, not
   * summoning-sick, no defender, no unmet {@link cantAttackUnlessDefenderControls})
   * is illegal; passing the declare-attackers step with one on the board
   * declares exactly the required creatures (`attack-requirements.ts`).
   */
  readonly mustAttack?: boolean;
  /**
   * **Landwalk** (CR 702.14b) — "can't be blocked as long as defending player
   * controls a [land of this kind]". A LIST because a creature may print
   * several ("islandwalk, swampwalk"), any one of which makes it unblockable;
   * grants UNION, like {@link protectionFrom}. The kinds are the closed
   * {@link LandCondition} table — a walk outside it keeps reporting.
   *
   * Judged per pair in `canBlock`, which reads the DEFENDER's lands off the
   * battlefield it is handed — the one evasion rule that depends on something
   * other than the two creatures.
   */
  readonly landwalk?: readonly LandCondition[];
  /**
   * **"~ can't attack unless defending player controls an Island"** — an
   * attack RESTRICTION (CR 508.1c) reading the same closed {@link LandCondition}
   * table as {@link landwalk}, from the same helper, so "an Island" cannot mean
   * two things. Every entry must hold (each printed line is its own
   * restriction); grants CONCATENATE.
   */
  readonly cantAttackUnlessDefenderControls?: readonly LandCondition[];
  /**
   * **"~ can't be blocked by more than one creature"** — the DUAL of
   * {@link minBlockers} (CR 509.1b), and like it a restriction on the whole
   * DECLARATION rather than any single pair: each blocker may block it, and
   * what the rule forbids is a second one doing so. Merges by MINIMUM — the
   * stricter cap is the one in force.
   */
  readonly maxBlockers?: number;
  /**
   * **"~ can block only creatures with flying"** — a restriction on what THIS
   * creature may block (CR 509.1b), the blocker-side mirror of
   * {@link blockRestriction}. The attacker must have at least one of the named
   * keywords; the table of nameable keywords is the compiler's closed
   * `BLOCKER_QUALITY_KEYWORDS`. Two printed lines merge by INTERSECTION of the
   * lists (both must be satisfied by the one attacker).
   */
  readonly blockOnly?: BlockOnlyRestriction;
}

/**
 * A condition on the DEFENDING player's lands, read by landwalk (CR 702.14b)
 * and by "can't attack unless defending player controls …" (CR 508.1c).
 *
 * A CLOSED union, and closed on purpose: each kind is something `land-conditions.ts`
 * can answer exactly from the board. "Legendary landwalk" and "nonbasic
 * landwalk" are real printed lines (Ayumi, the Last Visitor; Dryad
 * Sophisticate), so they are rows; a walk naming anything else ("snow
 * landwalk", "Desertwalk") is outside the table and its card keeps reporting
 * rather than compiling into a creature that is never unblockable.
 */
export type LandCondition =
  /** "an Island" / "a Forest" … — a land with the named basic land type. */
  | { readonly kind: 'subtype'; readonly subtype: BasicLandSubtype }
  /** "a legendary land". */
  | { readonly kind: 'legendary' }
  /** "a nonbasic land". */
  | { readonly kind: 'nonbasic' };

/** The five basic land types a `LandCondition` may name. */
export type BasicLandSubtype = 'plains' | 'island' | 'swamp' | 'mountain' | 'forest';

/**
 * A restriction on what a BLOCKER may block — "~ can block only creatures with
 * flying" (Welkin Tern, Cloud Sprite). The attacker must carry at least one of
 * the listed keywords. Named by {@link BooleanKeywordName}, so a keyword that
 * does not exist cannot be written here.
 */
export interface BlockOnlyRestriction {
  readonly attackerMustHaveAnyOf: readonly BooleanKeywordName[];
}

/**
 * The qualities a printed "protection from …" can name, each with an exact
 * engine meaning (see `sourceHasQuality` in `protection.ts`). A closed list on
 * purpose: a quality outside it ("protection from mana value 3 or less", "from
 * the chosen color") has no faithful check, so the compiler reports those cards
 * instead of guessing.
 *
 * A quality is a STRING, never a record, so the lists can be unioned, compared
 * and serialised with `includes`/`===` everywhere they already are. The one
 * open-ended family — a printed SUBTYPE ("protection from Dragons", "from
 * Arcane") — is therefore the prefixed form `subtype:<Name>`, read through
 * `hasSubtype` so a changeling counts as every creature type here as it does
 * for every other subtype question in the engine.
 */
export type ProtectionQuality =
  | 'white'
  | 'blue'
  | 'black'
  | 'red'
  | 'green'
  /** A source with NO colors (true colorless — lands, most artifacts). */
  | 'colorless'
  /** A source with exactly one color (Guardian of the Guildpact). */
  | 'monocolored'
  /** A source with two or more colors. */
  | 'multicolored'
  /** Any source whose card is an artifact. */
  | 'artifacts'
  /** Any source whose card is a creature. */
  | 'creatures'
  /** Any source whose card is an enchantment (Azorius First-Wing). */
  | 'enchantments'
  /** Any source whose card is a land (Horizon Drake). */
  | 'lands'
  /** Any source whose card is a planeswalker (Greensleeves, Maro-Sorcerer). */
  | 'planeswalkers'
  /** Any source whose card is an instant (Sword of Wealth and Power). */
  | 'instants'
  /** Any source whose card is a sorcery. */
  | 'sorceries'
  /** Any source with the named printed subtype — `subtype:Dragon`, `subtype:Arcane`. */
  | `subtype:${string}`
  /** Every source, whatever its qualities. */
  | 'everything';

/** The prefix of the subtype-shaped {@link ProtectionQuality}. */
export const PROTECTION_SUBTYPE_PREFIX = 'subtype:';

/**
 * Union two protection lists without duplicates — the one merge rule everywhere
 * a protection grant meets a printed list (`effectiveKeywords`, the continuous
 * layer's grant fold, the compiler's keyword assembly). Returns the first list
 * unchanged when the second adds nothing, so the no-grant path allocates nothing.
 */
export function unionProtection(
  base: readonly ProtectionQuality[] | undefined,
  granted: readonly ProtectionQuality[] | undefined,
): readonly ProtectionQuality[] | undefined {
  if (granted === undefined || granted.length === 0) return base;
  if (base === undefined || base.length === 0) return granted;
  const extra = granted.filter((quality) => !base.includes(quality));
  return extra.length === 0 ? base : [...base, ...extra];
}

/**
 * A reference to an effect primitive: an id resolved against the EffectRegistry,
 * plus an opaque params bag the primitive interprets. Core treats params as
 * unknown data — only the primitive (owned by `cards`) knows its shape.
 */
export interface EffectRef {
  readonly primitive: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** When a spell/ability may legally be cast/activated. */
export type CastTiming = 'sorcery' | 'instant';

/**
 * Immutable card data. Authored by `cards` as plain records; core only reads it.
 * `power`/`toughness` are present only for creatures. `produces` lets a land/mana
 * source declare what tapping it yields without a bespoke primitive.
 */
export interface CardDefinition {
  /** Stable id, unique within the pool (e.g. a Scryfall-derived slug). */
  readonly id: string;
  readonly name: string;
  readonly types: readonly CardType[];
  /**
   * Printed subtypes — creature types (`['Goblin', 'Warrior']`), land types
   * (`['Mountain']`), and so on.
   *
   * Two features need them, which is why the field is load-bearing rather than
   * decorative: tribal statics ("Goblins you control get +1/+1") select against
   * them as DATA instead of a per-card rule, and a fetchland searches for "a
   * Mountain or Plains card", which must find a DUAL land with those land types
   * and not just a basic — matching by name there would play worse than printed.
   *
   * Case is not significant: every comparison goes through {@link hasSubtype},
   * which folds both sides, so either as-printed (`'Mountain'`) or lower-cased
   * (`'mountain'`) authoring works and a casing slip cannot silently break a lord.
   */
  readonly subtypes?: readonly string[];
  /**
   * The object's colors, stated EXPLICITLY rather than derived from cost pips.
   *
   * Almost every card in Magic prints its colour as mana symbols, and
   * {@link colorsOfDefinition} reads those — so this field is absent on
   * essentially every card definition and nothing about them changes. It exists
   * for objects that print a colour in WORDS and carry no mana cost at all:
   *
   *  - **TOKENS.** "Create a 1/1 **black** Faerie Rogue creature token" and
   *    "create a 1/1 **blue and black** Faerie creature token" are printed
   *    colours with no pip anywhere to read them off. Without this field every
   *    token in the game entered COLOURLESS and was therefore invisible to
   *    "black creatures you control get +1/+1", to protection from red, to
   *    "destroy target nonblack creature", and to every {@link CardFilter}
   *    `anyOfColors` query — the card compiled `'complete'` and then played as
   *    something different from what is printed.
   *  - **The explicitly colourless token** ("a 1/1 **colorless** Thopter
   *    artifact creature token"), which is why an EMPTY array is meaningful and
   *    distinct from the field being absent: `[]` says "printed colourless",
   *    absent says "read my pips".
   *
   * A colour INDICATOR (a transforming DFC's back face) is the same shape and
   * would fit here, but the data pipeline does not capture one yet, so that
   * limit is still the one {@link colorsOfDefinition} documents.
   *
   * Order and duplicates do not matter — the reader normalises to canonical
   * WUBRG and de-duplicates, so `['B','U']` and `['U','B']` are one answer.
   */
  readonly colors?: readonly ManaColor[];
  /**
   * The printed **Basic** supertype. Carried for the same reason
   * {@link legendary} is: a rule keys on it — "unless you control two or more
   * basic lands" (the battlelands) — and no other characteristic answers it.
   * A basic land and a nonbasic dual print the same land SUBTYPES, so subtypes
   * cannot stand in for this without counting duals as basics, which would let
   * a battleland enter untapped when the printed card would not.
   */
  readonly basic?: boolean;
  /** Mana cost. Absent for lands and other free-to-play cards. */
  readonly cost?: ManaCost;
  /**
   * §3.106 — this nonland card prints NO mana cost (CR 202.1b): Ancestral
   * Vision, Living End, the suspend cycle. It cannot be cast by paying its
   * mana cost — from the hand there is nothing else to pay, so the engine never
   * offers or accepts the cast — and reaches the stack only through a
   * permission that says "without paying its mana cost" (a suspend window, a
   * Siege reward) or an alternative cost. Distinct from an absent {@link cost},
   * which a printed `{0}` also produces and which IS payable.
   */
  readonly noManaCost?: boolean;
  /**
   * How many `{X}` symbols the printed cost carries (1 for `{X}{R}`, 2 for
   * `{X}{X}{U}`). The X portion is deliberately NOT part of {@link cost}: X is 0
   * everywhere except on the stack (CR 107.3), so every existing consumer of
   * `cost` — affordability gates, curve sorting, payment — is already correct
   * reading the base cost, and none of the mana functions had to learn a new
   * symbol.
   *
   * The VALUE of X is a cast-time decision, not card data: `applyCastSpell`
   * parks a `chooseNumber` question after the base cost is paid, the engine
   * charges `chosen × xCost` generic mana as it accepts the answer, and the
   * chosen value rides the stack object into the resolution
   * (`ResolutionFrame.xValue` → `EffectContext.xValue`) so "deals X damage"
   * reads the number that was actually paid for.
   */
  readonly xCost?: number;
  /**
   * Kicker — "you may pay an additional [this] as you cast this spell". The
   * decision is asked at cast time exactly like X (a `payMana` question the
   * engine settles, charging the cost once as the answer is accepted), and the
   * kicked flag rides the stack object into the resolution so "if this spell
   * was kicked" branches read what actually happened. A caster who cannot
   * produce the kicker cost is never asked — the spell simply casts unkicked,
   * which is the printed default.
   *
   * Only the single yes/no kicker form lives here; a "pay any number of times"
   * cost is {@link multikicker}.
   */
  readonly kicker?: ManaCost;
  /**
   * Multikicker — "you may pay an additional [this] any number of times as you
   * cast this spell". The COUNT is the cast-time decision: the engine asks a
   * `chooseNumber` question ranged 0..max-affordable (computed by the same
   * payment planner that will charge it, exactly like {@link xCost}), charges
   * `count × multikicker` as it accepts the answer, and the count rides the
   * stack object into the resolution (`ResolutionFrame.kickCount` →
   * `EffectContext.kickCount`) so "for each time it was kicked" reads the
   * number of payments that actually happened. A count of zero is the printed
   * default and `kicked` stays false for it; any positive count also sets
   * `kicked`, so "if this spell was kicked" riders read multikicker correctly.
   *
   * A PERMANENT spell that resolves records the count on the entering instance
   * (`CardInstance.timesKicked`), which is how an enters-the-battlefield
   * trigger ("create a token for each time it was kicked") still sees it after
   * the resolution frame is gone.
   */
  readonly multikicker?: ManaCost;
  readonly power?: number;
  readonly toughness?: number;
  /**
   * CHARACTERISTIC-DEFINING power/toughness — the printed star/star box whose value
   * is a formula over the game state ("~'s power is equal to the number of card
   * types among cards in all graveyards…" — Tarmogoyf, Boneyard Wurm, Maro).
   *
   * Present ⇒ {@link power}/{@link toughness} are ABSENT: a card defines its P/T
   * by numbers or by formula, never both, and the compiler refuses a record that
   * would claim both. The formula is applied in CR 613.4's layer 7a — BEFORE
   * +1/+1 counters and continuous pumps — which the stat pipeline honours by
   * treating the formula's value as the creature's base: base (7a) + counters +
   * modifications, exactly the order `internal/stats.ts` documents. The value is
   * re-derived from the live state on every read (never stored), so a Tarmogoyf
   * grows the moment a fetchland hits a graveyard MID-combat, before the
   * state-based actions run.
   *
   * The formula vocabulary is the same closed {@link DerivedCountName} list the
   * "equal to the number of …" effect params use — one derivation, evaluated by
   * `derived.ts`, so a CDA and a derived damage amount cannot disagree about
   * what a count means.
   */
  readonly characteristicPT?: CharacteristicPT;
  /**
   * Printed starting loyalty — planeswalkers only. The permanent ENTERS with this
   * many loyalty counters (CR 306.5b), stored in `CardInstance.counters` under
   * {@link LOYALTY_COUNTER}, and a walker whose loyalty reaches 0 is put into its
   * owner's graveyard by a state-based action (CR 704.5i). A planeswalker
   * definition without this cannot be played faithfully, so the compiler refuses
   * it rather than inventing a number.
   */
  readonly loyalty?: number;
  /**
   * Printed starting DEFENSE — battles only. The permanent ENTERS with this many
   * defense counters (CR 310.4), stored in `CardInstance.counters` under
   * {@link DEFENSE_COUNTER}'s key ('defense'); damage dealt to a battle removes
   * that many defense counters (CR 120.3d), and a battle with none is put into
   * its owner's graveyard by a state-based action. A battle definition without
   * this cannot be played faithfully, so the compiler refuses it rather than
   * inventing a number — the exact contract printed loyalty already has.
   */
  readonly defense?: number;
  /**
   * The printed **Legendary** supertype. Load-bearing, not decorative: the
   * legend rule (CR 704.5j) is a state-based action keyed on exactly this flag —
   * a player who controls two or more legendary permanents with the same name
   * chooses one and the rest go to their owners' graveyards. One shared flag for
   * every permanent type (creatures, planeswalkers, battles, artifacts…), so the
   * rule has one implementation rather than a walker-only special case.
   */
  readonly legendary?: boolean;
  /**
   * **Changeling** (CR 702.73a) — "this card is every creature type." A
   * characteristic-defining ability that applies in every zone, which is exactly
   * why it is a flag on the DEFINITION and not a static ability or a continuous
   * effect: a Universal Automaton in a graveyard, in a library or on the stack is
   * a Goblin there too, and a battlefield-only mechanism would answer wrongly for
   * every typal search, every "sacrifice a Zombie" cost and every graveyard
   * count.
   *
   * It is honoured by {@link hasSubtype}, the one funnel every subtype question
   * in the engine goes through, so no consumer has to know the keyword exists.
   */
  readonly changeling?: boolean;
  /**
   * **"This spell can't be countered."** A property of the CARD (Supreme Verdict,
   * Abrupt Decay, Dovin's Veto), so it lives on the definition rather than on the
   * stack object.
   *
   * It is not a targeting restriction and must not be implemented as one: an
   * uncounterable spell is a perfectly legal target for Counterspell, which then
   * resolves and does nothing (CR 701.5a — "counter" is the effect that fails, not
   * the targeting). The rule is enforced at the single point where a spell is
   * actually removed from the stack, so every counter path — the plain
   * counterspell, "unless its controller pays", a modal counter mode and the ward
   * trigger — inherits it without a second implementation to keep in step.
   */
  readonly cantBeCountered?: boolean;
  /**
   * **"Spells you control can't be countered"** (Chimil, the Inner Sun),
   * **"Creature spells you control can't be countered"** (Rhythm of the Wild),
   * **"Spells can't be countered"** (Lier, Disciple of the Drowned) — the same
   * rule as {@link cantBeCountered}, printed on a PERMANENT that protects other
   * cards' spells instead of its own.
   *
   * Not a {@link StaticAbility}: those filter permanents and contribute a
   * P/T-and-keyword modification, and the subject here is an object on the stack.
   * Read by `countering.ts`, whose lifetime is derived from the board on every
   * query — so destroying the source in response really does let the counterspell
   * through.
   */
  readonly spellsCantBeCountered?: import('./countering.js').UncounterableSpellsAbility;
  /**
   * **"You have no maximum hand size."** Reliquary Tower, Spellbook, Venser's
   * Journal — a static ability of a permanent its controller controls, read by
   * the cleanup step's discard (CR 514.1).
   *
   * A boolean rather than a number because every printing of the effect on this
   * side removes the limit entirely; a card that RAISES the limit by N would be a
   * different field, and one that lowers an opponent's (Jin-Gitaxias) is a
   * different effect again — neither is approximated by this flag.
   */
  readonly noMaximumHandSize?: boolean;
  /**
   * **"You may play lands from your graveyard."** Crucible of Worlds, Ramunap
   * Excavator, Conduit of Worlds — a static ability of a permanent that widens
   * where its controller's land plays may come from.
   *
   * A list of zones rather than a boolean so "from the top of your library"
   * (Courser of Kruphix, Oracle of Mul Daya) is the same field with a different
   * value, instead of a second flag that the land-play path would have to ask
   * about separately.
   */
  readonly playLandsFrom?: readonly LandPlayZone[];
  /**
   * Marks this definition as an EMBLEM (CR 114) — the object a planeswalker
   * ultimate leaves behind. An emblem is not a card and not a permanent: it has
   * no card types, no characteristics beyond its abilities, it lives in the
   * COMMAND zone, and **nothing in the game can remove it**.
   *
   * That last property needs no enforcement code, deliberately: every removal
   * path in this engine (targeting, destroy, exile, board wipes, state-based
   * actions) reaches only `state.battlefield`, so an object that never enters
   * the battlefield is unremovable BY CONSTRUCTION rather than by a list of
   * exceptions somebody has to remember to keep complete.
   *
   * What an emblem does have is abilities, and they work from the command zone
   * exactly as a permanent's work from the battlefield: {@link statics} reach
   * the continuous layer and {@link triggers} reach the trigger collector,
   * because both of those systems discover emblems alongside permanents.
   */
  readonly isEmblem?: boolean;
  /**
   * Marks this definition as a TOKEN (CR 111) — an object created on the
   * battlefield by an effect rather than a card that was ever in a deck.
   *
   * It lives on the DEFINITION, beside {@link isEmblem}, rather than on
   * `CardInstance`, for three reasons that all point the same way:
   *  - a token definition is MINTED by the effect that creates it and is never
   *    shared with a card, so "this definition describes a token" and "this
   *    object is a token" are the same statement here;
   *  - `cloneInstance` shares `def` by reference, so the flag cannot be dropped
   *    by the field-by-field clone the way an instance field can — the trap
   *    `internal/clone.ts` warns about;
   *  - it costs the engine's hottest allocation nothing at all.
   *
   * Two things read it, and both are rules the game gets wrong without it:
   * {@link CardFilter.isToken} (the printed words "nontoken" and "token", e.g.
   * "Destroy all nontoken creatures") and CR 704.5d — a token that has left the
   * battlefield ceases to exist, which is what stops a dead token from sitting
   * in a graveyard forever inflating every graveyard count in the game.
   */
  readonly isToken?: boolean;
  readonly keywords?: KeywordFlags;
  /**
   * Ordered effects run when this spell resolves (instants/sorceries) or as the
   * permanent's enters-the-battlefield script. Opaque to core.
   */
  readonly effects?: readonly EffectRef[];
  /**
   * MODAL SPELLS — "Choose one —", "Choose two —", "Choose one or both —",
   * "Choose up to N —" (charms, commands, confluences), as data.
   *
   * Modes are chosen at CAST time (CR 601.2b) and each chosen mode's target is
   * chosen at cast time too (CR 601.2c) — the engine asks both questions while
   * the spell is being announced, records the picks on the stack object
   * (`SpellStackObject.modePicks`, public information exactly as in paper),
   * and the resolution runs the chosen modes' effects IN PRINTED ORDER, each
   * against its own chosen target. A mode with no legal target is not
   * choosable (CR 601.2c: you can only choose modes you can legally announce),
   * and a modal spell that cannot seat `min` legal modes cannot be cast at
   * all.
   *
   * Mutually exclusive with {@link effects} in practice: a modal spell's whole
   * script IS its modes. When both are present the modal machinery wins and
   * `effects` is ignored by the cast path (`resolveTopOfStack` builds the
   * frame from the picks).
   */
  readonly modal?: ModalSpec;
  /**
   * For *fixed-bundle* mana sources: tapping adds one mana of **each** listed
   * color at once. `['G']` is a Forest; `['C', 'C']` is Sol Ring's {C}{C}.
   *
   * This form cannot express a *choice*, so a source that adds "one mana of any
   * color" must NOT be written as `['W','U','B','R','G']` — that would produce
   * all five at once. Use {@link producesOptions} for modal sources instead.
   */
  readonly produces?: readonly import('./mana.js').ManaColor[];
  /**
   * For *modal* mana sources: tapping adds the mana of exactly **one** of these
   * modes, chosen by the controller (`TapForManaAction.mode` indexes this list).
   * Birds of Paradise is the five single-color modes; a dual land is two.
   *
   * Supersedes {@link produces}, which is the single-mode shorthand: when both
   * are present this wins. Core normalises the two into one mode list, so a
   * fixed bundle is simply a source with exactly one mode.
   */
  readonly producesOptions?: readonly import('./mana.js').ManaProduction[];
  /**
   * The FULL mana-ability form: a list of separately-printed mana abilities,
   * each with its own additional cost, rider, activation restriction and
   * (optionally) board-derived colours. See {@link ManaAbility}.
   *
   * Supersedes {@link produces}/{@link producesOptions} completely: those two are
   * the shorthand for "one ability, whose whole cost is the tap, with nothing
   * else printed", and a definition that declares `manaAbilities` has its mode
   * list built solely from this (the compiler folds a plain bundle in as one more
   * entry). Keeping the forms mutually exclusive is what lets {@link manaModesOf}
   * stay a single memoized answer instead of two lists a consumer could read
   * only half of.
   */
  readonly manaAbilities?: readonly ManaAbility[];
  /**
   * When true this permanent arrives on the battlefield already tapped, exactly
   * as printed ("~ enters tapped"). It is the defining drawback of the common
   * dual lands, so without it those lands would play a full turn faster than
   * they really do and every deck containing them would simulate too fast.
   *
   * Only the UNCONDITIONAL form is modelled here. A conditional entry ("enters
   * tapped unless you control two or fewer other lands") or a paid choice
   * (shocklands' "you may pay 2 life") needs the choice system, so those cards
   * stay unimplemented rather than being flattened into always-tapped.
   */
  readonly entersTapped?: boolean;
  /**
   * A board condition that lets this permanent enter UNTAPPED — the "unless"
   * half of the common dual lands: "enters tapped unless you control two or
   * fewer other lands" (a fastland), "unless you control a Mountain or a
   * Plains" (a checkland).
   *
   * Present ⇒ the permanent enters tapped whenever the condition is NOT met.
   * Only conditions that read the board are expressible here; a land that
   * charges a PRICE instead declares it in {@link entersTappedUnlessLifePaid},
   * because a price is a question for the controller, not a fact of the board.
   */
  readonly entersTappedUnless?: EntersUntappedCondition;
  /**
   * A shockland: "As ~ enters, you may **pay N life**. If you don't, it enters
   * tapped." The value is the printed life cost.
   *
   * This is a DECISION, not a condition, so `entersTapped` cannot answer it —
   * the entry paths that can ask (playing the land; a fetch effect putting it
   * onto the battlefield mid-resolution) raise a `payLife` choice and override
   * the tapped state with the answer. **Every path that does not ask enters the
   * permanent TAPPED**: an unasked entry is an unpaid one, which is the printed
   * default and the direction that can never play better than the real card.
   */
  readonly entersTappedUnlessLifePaid?: number;
  /**
   * "You may play an additional land on each of your turns." (Exploration,
   * Dryad of the Ilysian Grove; Azusa prints two.) While a permanent with this
   * is on the battlefield, its CONTROLLER's land plays per turn go up by this
   * many — read by {@link maxLandPlaysFor} at the two places the engine asks
   * (offering the play, and applying it), so the offer and the apply cannot
   * disagree. Copies stack, exactly as the printed cards do.
   */
  readonly additionalLandPlays?: number;
  /**
   * "Instant and sorcery spells you cast cost {1} less to cast." (Goblin
   * Electromancer; the Medallion cycle prints the one-colour form.) While this
   * permanent is on the battlefield, its CONTROLLER'S matching spells cost
   * `amount` less GENERIC mana — CR 601.2f's arithmetic: a reduction never
   * touches coloured pips, so `{U}{U}` under a Sapphire Medallion still costs
   * `{U}{U}`. `filter` names which spells qualify through the same `CardFilter`
   * everything else reads (types, colours); absent means every spell you cast.
   *
   * Read by the engine's `castManaCostFor` at BOTH the offer and the pay, and
   * it applies to whichever cost is actually being paid (printed, flashback,
   * madness) — CR 601.2f applies reductions to alternative costs too. Copies
   * stack.
   */
  readonly castCostReduction?: {
    readonly amount: number;
    readonly filter?: import('./choices.js').CardFilter;
  };
  /**
   * **AFFINITY** (CR 702.40) and every card that prints its wording longhand:
   * "This spell costs {1} less to cast for each artifact you control."
   *
   * The counterpart to {@link castCostReduction} and deliberately a SEPARATE
   * field, because the two answer different questions. That one is a grant a
   * PERMANENT makes to its controller's matching spells, and the engine finds it
   * by walking the battlefield; this one is printed on the SPELL itself and
   * scales with a board count. Folding affinity into the other field would mean
   * either walking the battlefield for a reducer that is never there, or reading
   * a spell in hand as though it were on the battlefield — and the second is how
   * a card ends up reducing its own cost while it sits in the graveyard.
   *
   * `amount` is the reduction PER matching permanent (always 1 on a printed
   * affinity card, named rather than assumed so the longhand "costs {2} less for
   * each…" wording has somewhere honest to go). `filter` is the same
   * `CardFilter` every other selector reads, and the count is of permanents the
   * CASTER controls — "you control", as printed.
   *
   * Reduces GENERIC mana only, floored at zero, exactly like every other
   * reduction (CR 601.2f): Myr Enforcer with four artifacts costs {3}, and with
   * eight it costs nothing rather than owing the board four mana.
   */
  /**
   * COST ASSISTANCE — CONVOKE (CR 702.51), IMPROVISE (CR 702.126) or DELVE
   * (CR 702.66): the caster may tap creatures, tap artifacts, or exile cards
   * from their graveyard, each paying one mana toward this spell.
   *
   * A KIND rather than a description, because the three differ only in which
   * resource they spend and whether one can pay a coloured pip — see the closed
   * `COST_ASSISTS` table in `cost-assist.ts`, which is where a fourth mechanic
   * of this shape becomes a row instead of a branch.
   *
   * Unlike a cost REDUCTION this does not change what the spell costs: the cost
   * stays as printed and part of it is paid by something other than mana
   * (CR 601.2g), which is why a convoked spell still has its printed mana value
   * for anything that reads one.
   */
  readonly costAssist?: import('./cost-assist.js').CostAssistKind;
  readonly castCostReductionPerPermanent?: {
    readonly amount: number;
    readonly filter: import('./choices.js').CardFilter;
  };
  /**
   * A "reveal-land" (the Shadows over Innistrad / Strixhaven cycles): "As ~
   * enters, you may **reveal** an Island or Swamp card from your hand. If you
   * don't, this land enters tapped." The value is the printed land types the
   * revealed card may have.
   *
   * A DECISION like {@link entersTappedUnlessLifePaid}, not a board condition:
   * having the card in hand does not by itself untap the land, the controller
   * has to choose to show it. So the same rule applies — the entry paths that
   * can ask raise a `confirm` and override the tapped state with the answer, and
   * **every path that does not ask enters the permanent TAPPED**, which is the
   * printed "if you don't" and the direction that can never play better than the
   * real card.
   *
   * The reveal itself moves nothing and is pure information; the engine has no
   * `cardsRevealed` event (see `revealTopCard`), so the mechanical consequence —
   * tapped or untapped — is the whole of it, and it is exact.
   */
  readonly entersTappedUnlessRevealed?: RevealFromHandCondition;
  /**
   * "**You may have ~ enter as a copy of** any creature on the battlefield"
   * (Clone, Phantasmal Image, Spark Double, Sakashima, Vesuva) — the as-enters
   * COPY replacement (CR 614.1c + CR 707.9), declared as data.
   *
   * It sits here beside `entersTapped*` and {@link asEntersChoice} because it is
   * the same family of thing: a replacement applied AS the permanent enters,
   * which every entry path must ask about rather than only the ones that happen
   * to run a resolution script. The engine asks it in `resolveTopOfStack` (a
   * permanent spell — before a single effect runs, so the COPIED card decides
   * summoning sickness, starting loyalty and starting defense) and in
   * `applyPlayLand` (a land — once, ahead of the entry ladder, because it
   * decides WHICH LAND that ladder is then asking its naming/reveal/life
   * questions about).
   *
   * The copy itself is applied in LAYER 1 by swapping the instance's `def`; see
   * `copy.ts` for the layering argument and the copiable-values rule.
   */
  readonly copyAsEnters?: CopyAsEntersSpec;
  /**
   * "**As ~ enters, choose a** creature type / a color / a player / a card type"
   * — the replacement-effect naming made as the permanent enters (CR 614.1c).
   *
   * The DECLARATION lives here so one record answers every consumer: the engine
   * (which raises the question on the entry paths that can ask), the AI (whose
   * per-subject answering policy is chosen from `subject`), the UI (which
   * renders the option list), and the About page. The ANSWER lives on the
   * instance, in `CardInstance.chosenAsEntered`, which is what the card's own
   * later abilities and other cards' filters read.
   *
   * Same rule as {@link entersTappedUnlessLifePaid}: a naming is a DECISION, and
   * **every entry path that cannot ask records nothing** — which matches
   * nothing, the direction that can never play better than the real card. See
   * `NOTHING_CHOSEN` in `choices.ts`.
   */
  readonly asEntersChoice?: AsEntersChoice;
  /**
   * "**This creature is the chosen type in addition to its other types**"
   * (Adaptive Automaton, Metallic Mimic, Roaming Throne) — set when the printed
   * line makes the permanent ITSELF a member of the type it named.
   *
   * It reads {@link asEntersChoice}'s answer off the instance, so it is only
   * meaningful on a definition that also declares one. Absent, or with nothing
   * chosen, the permanent has exactly its printed subtypes — see
   * {@link subtypesOfInstance}, which is the one accessor that folds the two
   * together.
   */
  readonly isChosenSubtype?: boolean;
  /** Casting timing; defaults to `'sorcery'` when omitted. */
  readonly timing?: CastTiming;
  /**
   * Flashback — "You may cast this card from your graveyard for its flashback
   * cost. Then exile it." (CR 702.34). The value is that cost.
   *
   * Two halves, both engine-enforced from this one field:
   *  - **The cast**: a `castSpell` action with `fromZone: 'graveyard'` pays THIS
   *    cost instead of `cost`, honoring the card's normal timing (a sorcery
   *    flashes back only at sorcery speed).
   *  - **The exile**: a spell cast from the graveyard is exiled whenever it
   *    would leave the stack — resolved OR countered (CR 702.34a) — never put
   *    back into the graveyard. See `spellLeaveDestination` in state.ts.
   *
   * The MANA half is here; two printed extensions ride beside it:
   * {@link flashbackXCost} for "Flashback {X}{R}{R}" and
   * {@link flashbackLifeCost} for "Flashback—{1}{U}, Pay 3 life". A flashback
   * rider outside those cost kinds (a discard, a sacrifice) still has no cast-
   * time cost machinery and stays reported by the compiler.
   */
  readonly flashback?: ManaCost;
  /**
   * How many `{X}` symbols the FLASHBACK cost prints ("Flashback {X}{R}{R}{R}"
   * — Devil's Play). Exactly {@link xCost}'s shape, for the graveyard cast:
   * when a spell is cast with `fromZone: 'graveyard'` the engine asks the X
   * question off THIS count instead of the printed cost's, charges the chosen
   * X, and the value rides into the resolution the same way. Meaningful only
   * alongside {@link flashback}.
   */
  readonly flashbackXCost?: number;
  /**
   * A "Pay N life" rider on the flashback cost ("Flashback—{1}{U}, Pay 3
   * life"). Charged IN FULL at cast time with the mana — a mandatory part of
   * the cost, not a choice — and a caster who cannot pay it (CR 118.4: life
   * pays down to zero, never past) is never offered the cast. Meaningful only
   * alongside {@link flashback}.
   */
  readonly flashbackLifeCost?: number;
  // --- the graveyard-casting family (§3.111) -----------------------------------
  /**
   * A NON-MANA rider on the flashback cost — "Flashback—Sacrifice three
   * creatures" (Dread Return), "Flashback—Tap three untapped white creatures
   * you control" (Battle Screech), "Flashback—Sacrifice a Mountain" (Lava
   * Dart). The SAME closed shape a printed "as an additional cost" uses
   * ({@link additionalCost}), paid through the same cast-time question, and
   * charged only on the graveyard cast. Sits beside {@link flashback}, whose
   * mana half is then EMPTY for every card that prints one of these.
   */
  readonly flashbackAdditionalCost?: AdditionalCastCost;
  /**
   * The OTHER "cast this card from your graveyard" keywords — retrace (CR
   * 702.81a), jump-start (702.133a), escape (702.138a). Each is a kind, an
   * optional alternative mana cost and a mandatory non-mana rider; how the
   * spell LEAVES the stack is the closed `GRAVEYARD_CAST_EXIT` table. Read
   * beside {@link flashback} by ONE accessor, `graveyardCastOptionsOf`, so the
   * offer loop, the cast path and the pilot agree on every way a card in the
   * graveyard may be cast. See `graveyard-casting.ts`.
   */
  readonly graveyardCasts?: readonly import('./graveyard-casting.js').GraveyardCastAbility[];
  /**
   * ACTIVATED abilities that function while this card is in a GRAVEYARD —
   * unearth (CR 702.84a), scavenge (702.96a), embalm (702.128a), eternalize
   * (702.129a), encore (702.141a) and the printed "{cost}: Return ~ from your
   * graveyard to your hand". Indexed by the `activateGraveyardAbility` action
   * exactly as {@link activated} is by `activateAbility`, and kept apart from
   * it for the reason {@link cycling} is: a battlefield activation starts by
   * finding a permanent. See `graveyard-casting.ts`.
   */
  readonly graveyardAbilities?: readonly import('./graveyard-casting.js').GraveyardAbility[];
  /**
   * CYCLING — "{cost}, Discard this card: Draw a card" (CR 702.29), plus the
   * TYPECYCLING/LANDCYCLING variants whose effect is a library search instead of
   * a draw. A list because a card may print more than one cycling ability, and
   * because the `cycleCard` action indexes it exactly as `activateAbility`
   * indexes {@link activated} — so *which* cycling ability is part of the
   * action and a pilot can enumerate and score each one.
   *
   * It is NOT in {@link activated}, and that is the whole point: an activated
   * ability there is activated from the BATTLEFIELD by a permanent, while
   * cycling is activated from HAND by a card that is not a permanent at all
   * (every cycling land in the corpus cycles while it is still a card in hand).
   * Folding the two would mean teaching every battlefield-shaped check —
   * summoning sickness, tap costs, `findOnBattlefield` — about a zone it has
   * never had to consider.
   *
   * The DISCARD is a cost, not an effect, which is why madness (below) and any
   * "whenever you cycle or discard" trigger see it: it goes through the same
   * discard funnel every other discard does.
   */
  readonly cycling?: readonly CyclingAbility[];
  /**
   * BUYBACK — "You may pay an additional {cost} as you cast this spell. If you
   * do, put this card into your hand as it resolves." (CR 702.27). The value is
   * that additional cost.
   *
   * The decision is a cast-time question exactly like {@link kicker} (the same
   * `payMana` the engine charges as it accepts the answer), and the answer rides
   * the stack object as `boughtBack`. Where the card GOES is then one shared
   * answer — `spellLeaveDestination` in state.ts — which is what makes buyback
   * agree with flashback rather than being a second opinion about the exit from
   * the stack. Note the asymmetry the rules require and that helper encodes: a
   * bought-back spell returns to hand only when it RESOLVES; countered, it is
   * put into the graveyard like any other countered spell.
   */
  readonly buyback?: ManaCost;
  /**
   * A MANDATORY ADDITIONAL COST paid as this spell is cast — "As an additional
   * cost to cast this spell, sacrifice a creature" (Village Rites), "…discard a
   * card" (Thrill of Possibility).
   *
   * It is NOT the optional-cost shape {@link kicker} and {@link buyback} have,
   * and the difference is the whole point of a separate field: an optional cost
   * may be declined, so a caster who cannot pay simply casts the spell without
   * it. This one may not. CR 601.2h makes an unpayable cost an ILLEGAL CAST —
   * so a Village Rites with no creature is not offered and is rejected if a
   * hand-built action tries it, exactly as a spell with no legal target is.
   * Treating it as declinable would print a strictly better card: a free
   * two-card draw.
   *
   * Paying it is a real sacrifice/discard performed by the engine as the answer
   * is accepted, through the same zone-change funnel every other one uses —
   * which is what makes a dies/leaves-the-battlefield trigger and the madness
   * discard replacement see it, because in the rules they genuinely do.
   */
  readonly additionalCost?: AdditionalCastCost;
  /**
   * MADNESS — "If you discard this card, exile it instead of putting it into
   * your graveyard. When you do, you may cast it for its madness cost" (CR
   * 702.35). The value is that cost.
   *
   * Two halves, both engine-enforced from this one field:
   *  - **The exile**: the discard funnel (`discardDestination` in state.ts)
   *    diverts the card to exile and opens a MADNESS WINDOW on the game state.
   *  - **The cast**: while that window stands, its owner may cast the card with
   *    `fromZone: 'exile'`, paying THIS cost instead of `cost`; passing priority
   *    declines, and the card falls into the graveyard where an ordinary discard
   *    would have put it.
   *
   * Only the plain mana-cost form is modelled; a madness cost printed in words
   * ("Madness—Pay six {C}") or with a non-mana component stays reported.
   */
  readonly madness?: ManaCost;
  // --- upkeep costs and time counters (§3.106) ------------------------------------
  /**
   * Counters this permanent ENTERS WITH — "This permanent enters with N time
   * counters on it" (vanishing, CR 702.63a) / "N fade counters" (fading, CR
   * 702.32a). A CR 614.1c replacement on the entry itself, applied by the ONE
   * helper every battlefield-entry path calls (`applyEnteringCounters`, the
   * sibling of `applyEnteringLoyalty`), so a land played, a creature cast, a
   * token made and a permanent put onto the battlefield all arrive counted —
   * the reason this is a definition field and not an entry in the ETB script,
   * which only a resolving spell runs.
   */
  readonly entersWithCounters?: readonly EnteringCounters[];
  /**
   * **Suspend N—[cost]** (CR 702.62a). The static half — "if you could begin to
   * cast this card, you may pay [cost] and exile it with N time counters" — is a
   * SPECIAL ACTION (`suspendCard`) the engine offers from hand; the exile-side
   * halves (the upkeep tick and the free cast when the last counter leaves)
   * live in the delayed-ability record the action creates, because a card in
   * exile is on no trigger source. See `suspend.ts`.
   */
  readonly suspend?: SuspendAbility;
  // --- the cast-alternative family (§3.112) -----------------------------------------
  /**
   * The ALTERNATIVE COSTS this card prints — evoke (CR 702.74a), dash
   * (702.109a), blitz (702.152a), surge (702.117a), prototype (702.160a), warp
   * (702.185a): "you may cast this card by paying [cost] rather than its mana
   * cost". Keyed by the closed `AlternativeCostKind` so a `castSpell` action
   * names WHICH one it pays (`CastSpellAction.alternative`) and the one cast
   * funnel charges it where the printed cost would go; the keyword's own rules
   * (haste, a required turn fact, the prototype face) live in core's
   * `ALTERNATIVE_COSTS` table and the card carries only its cost and the
   * delayed riders the cards package compiled. See `cast-alternatives.ts`.
   */
  readonly alternativeCosts?: Readonly<
    Partial<Record<import('./cast-alternatives.js').AlternativeCostKind, import('./cast-alternatives.js').AlternativeCastCost>>
  >;
  /**
   * ENTWINE (CR 702.42a) — "You may choose all modes of this spell instead of
   * just the number specified. If you do, you pay an additional [cost]." Asked
   * as the FIRST cast-time question of a modal spell, before the mode menu
   * (CR 601.2b: the mode choice is where entwine is announced), and only when
   * every printed mode can legally be chosen — an entwined spell that could
   * not seat a mode would be a spell choosing a mode it may not.
   */
  readonly entwine?: ManaCost;
  /**
   * FORETELL (CR 702.143a) — the cost this card is cast for from exile after
   * the turn it was foretold on. Foretelling itself is the `foretellCard`
   * SPECIAL ACTION (CR 116.2h): pay {2} on your own turn, exile the card face
   * down. The later cast is a card GRANT (`CardGrant.castCost`), so the
   * permission dies with the object exactly as an adventurer's does.
   */
  readonly foretell?: ManaCost;
  /**
   * PLOT (CR 702.170a) — the cost paid to exile this card as a sorcery
   * (`plotCard`, CR 116.2k); the plotted card is then cast free, as a sorcery,
   * on a later turn — a card grant with `castFree` and `castAsSorcery`.
   */
  readonly plot?: ManaCost;
  // --- the spell-count family (§3.113): storm, cascade, ripple ------------------
  /**
   * "When you cast this spell, …" abilities that function on the STACK — storm
   * (CR 702.40a), cascade (CR 702.85a), ripple (CR 702.60a). Not `triggers`,
   * because the trigger collector reads the battlefield and the command zone
   * only; the cast path pushes these itself the moment the spell is cast (see
   * `cast-triggers.ts`). One record per printed instance: "Cascade, cascade"
   * is two.
   */
  readonly castTriggers?: readonly import('./cast-triggers.js').CastTriggeredAbility[];
  /**
   * Triggered abilities (DESIGN §3.9), as data: each is a condition (what event
   * sets it off) + an effect-ref list run when it resolves. Opaque to most of core
   * — the trigger machinery (triggers.ts) matches conditions against the event log
   * and the engine resolves the effects via the same registry as spells. Omit for
   * cards with no triggers.
   */
  readonly triggers?: readonly import('./triggers.js').TriggeredAbility[];
  /**
   * Abilities the controller may ACTIVATE by paying a cost — the `Cost: Effect`
   * line printed on fetchlands ("{T}, Pay 1 life, Sacrifice ~: Search…"),
   * sacrifice outlets, and mana rocks with a second ability.
   *
   * Mana abilities are NOT here: a permanent that only taps for mana declares
   * {@link produces}/{@link producesOptions} and resolves without using the
   * stack, exactly as the rules require. Everything in this list uses the stack.
   */
  readonly activated?: readonly ActivatedAbility[];
  /**
   * Static ("anthem") abilities: continuous modifications this permanent applies to
   * a *set* of other permanents for as long as it is on the battlefield — "creatures
   * you control get +1/+1", "other Goblins you control have haste". Data, like
   * triggers; see `statics.ts` for the shape and for why the lifetime needs no
   * bookkeeping. Omit for cards with none (the overwhelming majority).
   */
  readonly statics?: readonly import('./statics.js').StaticAbility[];
  /**
   * REPLACEMENT and PREVENTION abilities (CR 614/615): "If one or more +1/+1
   * counters would be put on a creature you control, that many **plus one** are
   * put on it instead", "If a source you control would deal damage …, it deals
   * **double** that damage instead", "Prevent all combat damage that would be
   * dealt to attacking creatures you control".
   *
   * Data, like {@link statics}, and with the same DERIVED lifetime: live for
   * exactly as long as this permanent is on the battlefield, because the layer
   * re-reads `state.battlefield` rather than storing anything. See
   * `replacement.ts` for the vocabulary and `internal/replacement.ts` for the one
   * seam damage, counters and draws all consult. Omit for cards with none, which
   * is nearly every card — the absent field is what keeps the damage and counter
   * hot paths free.
   */
  readonly replacements?: readonly import('./replacement.js').ReplacementAbility[];
  /**
   * The SECOND FACE of a transforming double-faced card (Innistrad-style), as a
   * complete nested definition — everything a face can print: name, types, P/T,
   * keywords, triggers, statics, the lot.
   *
   * Present only on the FRONT face. The back face never carries a `backFace` of
   * its own; it is marked {@link isBackFace} instead, and the way back to the
   * front is the instance's `printedDef` (state.ts) — deliberately NOT a back-
   * reference here, so definitions stay acyclic and serializable as plain data
   * (the generated pool module writes them as literals).
   *
   * Which face is UP is per-permanent state, not definition data: a transformed
   * permanent's `CardInstance.def` points at this nested definition, so every
   * characteristic read in the engine (combat, targeting, triggers, statics,
   * the AI, the renderer) routes through the active face with no second code
   * path. See `transform.ts` for the swap and CR 712 for why it is not a zone
   * change.
   */
  readonly backFace?: CardDefinition;
  /**
   * Marks this definition as the BACK face of a transforming double-faced card.
   * A back face is never castable and never starts in any zone face-up (CR
   * 712.8a: a DFC is always front-face-up everywhere except the battlefield) —
   * the cast/play paths refuse it defensively, though in practice a back-face
   * definition only ever appears as a battlefield permanent's active face.
   */
  readonly isBackFace?: boolean;
  /**
   * Marks a {@link backFace} as CASTABLE/PLAYABLE — a MODAL double-faced card
   * (Zendikar Rising style), where the player casts either face from any zone
   * the card may be cast from, as opposed to a transforming DFC whose back
   * face is only ever reached by a transform instruction (CR 712.8b).
   *
   * Present on the FRONT face, beside `backFace`. The cast/play actions carry
   * `face: 'back'` to choose the second face; the instance's `def` then IS
   * that face for as long as it is on the stack/battlefield (`printedDef`
   * holds the front, exactly as a transform does), and leaving for a hidden
   * or graveyard zone reverts it to the front (CR 712.8a). Playing a land
   * back face counts as the turn's land play like any other land.
   */
  readonly backFaceCastable?: boolean;
  /**
   * The FIRST castable half of a SPLIT card (CR 709) — "Fire" of "Fire // Ice".
   *
   * A split card is ONE card with TWO halves, and the object that sits in a
   * hand, graveyard or library is neither half: CR 709.4 gives it the COMBINED
   * characteristics (both names, the union of the type lines and colours, and a
   * mana value equal to the sum). So for a split card THIS definition carries
   * those combined characteristics and is not itself castable, while the two
   * halves hang off it as {@link frontFace} and {@link backFace}.
   *
   * That is the whole difference from a modal DFC, whose front face IS one of
   * the castable halves (CR 712.8a gives an MDFC in a non-battlefield zone only
   * its front face's characteristics). `playableFaceOf` reads this field, so
   * every cast path asks one function which object it is actually casting and
   * no caller has to know which layout it is holding.
   *
   * Absent on every other card, including modal DFCs — reading it is how the
   * engine tells the two layouts apart.
   */
  readonly frontFace?: CardDefinition;
  /**
   * The zones the CASTABLE BACK half may be cast from. Absent means `['hand']`,
   * which is a modal DFC and the left-to-right half of an ordinary split card.
   *
   * `['graveyard']` is AFTERMATH (CR 702.127a: "cast this spell only from your
   * graveyard") — the second half of Dusk // Dawn is not castable from hand at
   * all, and offering it there would be a strictly better card than printed.
   * `['exile']` is a SIEGE's reward half, which becomes castable only once the
   * battle is defeated and exiled (see {@link backFaceFreeCast}); the exile
   * offer additionally requires the per-instance permission a defeated Siege
   * grants, so an exiled Siege that was never defeated is not castable.
   */
  readonly backFaceCastZones?: readonly CastZone[];
  /**
   * The back half is cast WITHOUT PAYING ITS MANA COST — a Siege's reward (CR
   * 310.4: "exile it, then you may cast it transformed without paying its mana
   * cost"). Data rather than a special case at the cast seam, so the one cast
   * path charges what the card says and nothing else.
   */
  readonly backFaceFreeCast?: boolean;
  /**
   * Marks THIS definition as an ADVENTURE — the instant/sorcery half of an
   * adventurer card (CR 715), printed on the back face beside the creature.
   *
   * It is the whole of what makes an adventure different from any other spell:
   * when it RESOLVES the card is exiled instead of being put into its owner's
   * graveyard, and its owner may then cast the creature half from exile (CR
   * 715.3d). Countered, it goes to the graveyard like anything else — which is
   * why the exile lives in `spellLeaveDestination`'s `reason` and not in a flag
   * each exit reads for itself.
   */
  readonly adventure?: boolean;
  /**
   * Declares this permanent to be an ATTACHMENT — an Aura or an Equipment — as
   * data: what it may be attached to, what it does to its host while attached, and
   * what the state-based actions do when it is not legally attached. See
   * `attachments.ts`; the two printed forms differ only in that data, so core has
   * one attachment system rather than an aura one and an equipment one.
   *
   * How it BECOMES attached is not declared here, because it is already
   * expressible: an Aura carries `effects: [{ primitive: 'attachToTarget' }]` (its
   * spell targets a creature and attaches on resolution), and an Equipment carries
   * the same ref inside an `activated` ability — which is exactly what "Equip {N}"
   * abbreviates.
   */
  readonly attachment?: import('./attachments.js').AttachmentSpec;
}

/**
 * One printed mode of a modal spell ("• Counter target spell.") — effects plus
 * an optional target requirement, as data.
 */
export interface SpellMode {
  /** Stable id the chosen-modes answer refers to (`mode1`, `counter`, …). */
  readonly id: string;
  /** The printed mode text, for the UI and the event log. */
  readonly label: string;
  /** What this mode does when it resolves — ordinary effect refs. */
  readonly effects: readonly EffectRef[];
  /**
   * What this mode TARGETS, when it targets at all. Unlike a whole-card
   * restriction (where `'any'` is left unpoliced for cost reasons —
   * `targetRestrictionOf`), a mode's requirement is explicit data: present
   * means "this mode names exactly one target of this shape, chosen at cast",
   * absent means the mode is target-free. `'any'` is meaningful here, because
   * whether a mode is CHOOSABLE at all depends on a legal target existing.
   */
  readonly targets?: import('./targeting.js').TargetSpec;
}

/**
 * The modal header, as data: how many modes are chosen and whether one mode may
 * be chosen more than once ("Choose two. You may choose the same mode more
 * than once.").
 */
export interface ModalSpec {
  /** Fewest modes the caster must choose (0 for "choose up to N"). */
  readonly min: number;
  /** Most modes the caster may choose. */
  readonly max: number;
  /** "You may choose the same mode more than once." */
  readonly allowRepeats?: boolean;
  /**
   * "Choose one that hasn't been chosen THIS TURN —" (Gala Greeters, Monument
   * to Endurance): a mode this object already took this turn is off the menu.
   * Only meaningful on a TRIGGER's spec — the memory lives on the permanent
   * (`CardInstance.modesChosenThisTurn`), and a spell has no permanent to
   * remember with. The turnless wording is deliberately NOT this flag; see the
   * instance field.
   */
  readonly notChosenThisTurn?: boolean;
  readonly modes: readonly SpellMode[];
}

/**
 * The countable sets a DERIVED value may name — the closed vocabulary behind
 * both "equal to the number of …" effect params and characteristic-defining
 * P/T ({@link CardDefinition.characteristicPT}). Closed on purpose: each entry
 * is a set the engine can count exactly, so a card either names one of these or
 * is reported unsupported. An open expression language would let the compiler
 * accept text it only approximately understands — the one thing the compiler
 * contract forbids. Evaluated by `evaluateDerivedCount` in `derived.ts`.
 */
export type DerivedCountName =
  | 'creaturesYouControl'
  | 'creaturesOpponentControls'
  | 'creaturesOnBattlefield'
  | 'landsYouControl'
  | 'cardsInYourHand'
  | 'cardsInYourGraveyard'
  /** Creature CARDS in your graveyard (Boneyard Wurm). */
  | 'creaturesInYourGraveyard'
  /**
   * "the number of creatures you control **with defender**" — the wall-tribal
   * count both halves of that archetype print (Axebane Guardian, Doorkeeper,
   * Assault Formation's pump).
   *
   * Its own row rather than a `creaturesYouControl` narrowed by an arbitrary
   * filter, for the reason the whole vocabulary is a closed table: one row, one
   * definition, read identically by every consumer.
   *
   * ⚠️ Counted off each permanent's CURRENT DEFINITION, exactly as every other
   * row here counts (`creaturesYouControl` asks `isCreature(perm.def)`), so a
   * copy effect is seen and a continuous keyword GRANT is not. That is this
   * evaluator's existing contract and not a new gap — it sits below the
   * continuous layer, which folds this function in, so it cannot ask it without
   * a cycle. A card whose count must see granted defender would need the
   * layer-aware reader and is not compiled today.
   */
  | 'creaturesYouControlWithDefender'
  /** Distinct card types among cards in ALL graveyards (Tarmogoyf). */
  | 'cardTypesInAllGraveyards'
  /**
   * How many times the SPELL that produced this effect was kicked — "for each
   * time it was kicked" on a multikicker card.
   *
   * The one name in this vocabulary that is NOT a fact about the board, and so
   * the one `evaluateDerivedCount` cannot answer: it is a fact about the
   * resolution in progress (or, for an enters-the-battlefield trigger, about
   * the permanent's own `timesKicked`). It lives in the shared vocabulary
   * anyway because it is read at exactly the same seam every other count is —
   * `intParam` — so damage, draw, life, counters and token counts all learn it
   * at once, and no primitive changes. See `effect-helpers.ts` for the reader.
   */
  | 'timesThisWasKicked'
  /**
   * "**That much**" — how big the event that set this TRIGGER off was (life
   * gained, life lost). Like `timesThisWasKicked` it is a fact about the
   * resolution rather than about the board, so `evaluateDerivedCount` cannot
   * answer it; `intParam` reads it off the context instead.
   */
  | 'triggeringAmount'
  /**
   * RAMPAGE's count (CR 702.23a) — "for each creature blocking it BEYOND THE
   * FIRST": the number of creatures currently blocking the effect's SOURCE,
   * minus one, floored at zero. Read as the ability RESOLVES (CR 702.23b — the
   * bonus is calculated once, when the trigger resolves), off the live combat
   * state. A fact about the source rather than about a player, so like
   * `timesThisWasKicked` it is answered by `intParam` (which holds the source)
   * and not by the board-only evaluator.
   */
  | 'creaturesBlockingThisBeyondFirst';

/**
 * One half of a characteristic-defining P/T: a derived count plus an optional
 * printed offset — Tarmogoyf's toughness is "that number plus 1".
 */
export interface CharacteristicFormula {
  readonly countOf: DerivedCountName;
  /** Added to the count ("…plus 1"). Omit for none. */
  readonly plus?: number;
}

/** A characteristic-defining star/star box: both halves, each a formula. */
export interface CharacteristicPT {
  readonly power: CharacteristicFormula;
  readonly toughness: CharacteristicFormula;
}

/**
 * Memo of a definition's colors. Definitions are immutable and shared (the pool
 * is frozen), and color is asked per candidate on the targeting-legality and
 * card-filter paths, so the pip walk happens once per definition ever, not once
 * per check. Lives here (not `protection.ts`) because BOTH protection and the
 * shared `CardFilter` read it, and `choices.ts` importing protection would form
 * an import cycle through the continuous layer.
 */
const COLORS_MEMO = new WeakMap<CardDefinition, readonly ManaColor[]>();

/** The five COLORS (not {C}) in canonical order — colorless is not a color. */
const COLOR_PIPS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/**
 * The colors of a definition.
 *
 * Two sources, in this order, and the order is the whole point:
 *  1. **{@link CardDefinition.colors} when present** — a colour printed in WORDS
 *     on an object that has no mana cost to read it off. Every TOKEN is that
 *     object ("a 1/1 **black** Faerie Rogue creature token"), and an empty array
 *     is a meaningful answer: the printed word "colorless".
 *  2. Otherwise the cost's colored **pips**, hybrid symbols included. A land, a
 *     free spell, or an artifact with a purely generic cost has no colors ({C}
 *     pips are colorless, not a color).
 *
 * Preferring the explicit field rather than merging the two keeps every card
 * that works today working unchanged — no printed card in the pool declares
 * `colors`, so every one of them still walks its pips — while making the field
 * authoritative for the objects that need it. (Nothing in Magic both prints a
 * colour in words and has pips that disagree; devoid and colour indicators are
 * exactly the "the words win" case.)
 *
 * The engine has no color-changing effects, so this is the color of every object
 * it can represent — with one documented exception: a transforming DFC's BACK
 * face carries a colour INDICATOR the data pipeline does not capture, so it
 * declares no `colors` and reads off its (absent) cost as colorless. Every color
 * consumer (protection, colored card filters, coloured anthems) inherits that
 * limit together, from this one reader.
 */
/** Whether any hybrid symbol in a cost offers `color` as one of its components. */
function costHybridOffers(hybrid: NonNullable<ManaCost['hybrid']>, color: ManaColor): boolean {
  for (let i = 0; i < hybrid.length; i++) {
    const symbol = hybrid[i] as readonly HybridComponent[];
    for (let c = 0; c < symbol.length; c++) {
      const component = symbol[c] as HybridComponent;
      if (isColorComponent(component) && component === color) return true;
    }
  }
  return false;
}

export function colorsOfDefinition(def: CardDefinition): readonly ManaColor[] {
  const memoized = COLORS_MEMO.get(def);
  if (memoized) return memoized;
  const colors: ManaColor[] = [];
  const printed = def.colors;
  if (printed !== undefined) {
    // Normalised to canonical WUBRG and de-duplicated, so `['B','U']` and
    // `['U','B']` are one answer and a repeated word cannot double-count. The
    // walk is over the five pips (not over `printed`) precisely to fix the
    // order; anything that is not one of the five — a stray 'C' — is not a
    // colour and is dropped, which is what makes `[]` mean colorless.
    for (const pip of COLOR_PIPS) {
      if (printed.includes(pip)) colors.push(pip);
    }
  } else {
    const cost = def.cost;
    if (cost) {
      // ONE walk over the five pips, asking each colour whether the cost demands
      // it — as a fixed pip or as one alternative of a hybrid symbol (CR 202.2b:
      // a hybrid symbol is every colour it COULD be paid with). Walking the
      // colours rather than the cost is what fixes the ORDER: before this, a
      // {G/W} card answered ['G','W'] while a {W}{G} card answered ['W','G'],
      // which is two answers to one question.
      //
      // A hybrid symbol's colours are a fact about the PRINTED cost, never about
      // the payment: a card with {W/P} is white even when every copy of it is
      // paid with life, and {2/W} is white even when it is paid with two
      // Mountains. So only the COLOUR components count — generic and life are
      // not colours, and {C} is not one either.
      for (const pip of COLOR_PIPS) {
        if ((cost[pip] ?? 0) > 0) {
          colors.push(pip);
          continue;
        }
        if (cost.hybrid === undefined) continue;
        if (costHybridOffers(cost.hybrid, pip)) colors.push(pip);
      }
    }
  }
  const frozen = Object.freeze(colors);
  COLORS_MEMO.set(def, frozen);
  return frozen;
}

/**
 * A mandatory additional cost printed on a spell — see
 * {@link CardDefinition.additionalCost}.
 *
 * `kind` says which zone the payment comes out of and what the move MEANS:
 * `'sacrifice'` takes permanents its controller controls off the battlefield,
 * `'discard'` takes cards out of its controller's hand. Both are expressed with
 * the shared {@link CardFilter} vocabulary rather than a private one, so
 * "sacrifice an artifact **or creature**" is the same data an edict, a search
 * and an anthem are narrowed by.
 *
 * `count` is how many (default 1). There is deliberately NO "you may" variant
 * here: an optional additional cost is a different decision (it may be declined,
 * so it can never make a cast illegal) and belongs in its own field when a card
 * that prints one is implemented.
 */
export interface AdditionalCastCost {
  /**
   * Which zone the payment leaves, and what the move means. §3.111 added the
   * two kinds the graveyard-casting family prints — `tap` ("Flashback—Tap
   * three untapped white creatures you control": tap N untapped permanents
   * matching the filter) and `exileFromGraveyard` (escape's "Exile five other
   * cards from your graveyard"). Where each is paid from is the closed
   * `ADDITIONAL_COST_ZONE` table in `graveyard-casting.ts`.
   */
  readonly kind: 'sacrifice' | 'discard' | 'tap' | 'exileFromGraveyard';
  /** How many cards/permanents (default 1). */
  readonly count?: number;
  /** What qualifies. Absent means "any card in that zone". */
  readonly filter?: CardFilter;
  /** Printed text, for the prompt and the log. */
  readonly label: string;
}

/**
 * What activating an ability costs. Every field is optional and they combine —
 * a fetchland pays all three of tap, life, and sacrifice.
 *
 * Costs are PAID ON ACTIVATION, before the ability goes on the stack, and are
 * not refunded if the ability is later countered or fizzles (rule 602.2).
 */
export interface ActivationCost {
  /** Mana component, paid from the controller's floating pool. */
  readonly mana?: ManaCost;
  /**
   * How many `{X}` symbols the printed ACTIVATION cost carries — "**{X}{R}{G}**,
   * {T}: Target creature gets +X/+0…" (Kessig Wolf Run), "{X}, {T}: Target
   * player mills X cards" (Sands of Delirium). DESIGN §3.149.
   *
   * Exactly {@link CardDefinition.xCost}'s shape and meaning, one level down: the
   * X portion is NOT part of {@link mana}, so every existing reader of an
   * activation cost (the payability gate, the offer path's affordability check,
   * `payCost`) is already correct reading the base cost and none of them had to
   * learn a new symbol.
   *
   * The VALUE is chosen as the ability is ACTIVATED, not as it resolves (CR
   * 601.2b via 602.2b — costs are paid before the ability goes on the stack), so
   * it rides `ActivateAbilityAction.xValue` rather than being asked for later:
   * the offer path enumerates one action per affordable value, the apply path
   * charges `xValue × xCost` generic on top of the base cost, and the chosen
   * number rides the stack object into the resolution
   * (`AbilityStackObject.xValue` → `ResolutionFrame.xValue` →
   * `EffectContext.xValue`) so the body's "gets +X/+0" reads what was paid for.
   *
   * Enumerating the value is affordable here in a way it is not for a cast:
   * an activation cost is paid from the FLOATING pool, so the range is bounded
   * by mana already produced rather than by everything that could be tapped.
   */
  readonly xCost?: number;
  /** The `{T}` symbol: tap this permanent (and obey summoning sickness). */
  readonly tap?: boolean;
  /** "Sacrifice ~": this permanent goes to its owner's graveyard. */
  readonly sacrificeSelf?: boolean;
  /** "Pay N life". Payable only while the controller's life exceeds it. */
  readonly life?: number;
  /**
   * "**Sacrifice a creature**" (Viscera Seer, Goblin Bombardment), "**Sacrifice
   * a Treasure**" (Professional Face-Breaker), "**Sacrifice another creature**"
   * (Yahenni) — an additional cost paid by sacrificing some OTHER permanent
   * matching a printed filter.
   *
   * The SAME shape as {@link ManaAbilityCost.sacrificeAnother}, and read from
   * the same compiler noun table, so "a Treasure" cannot mean one thing on a
   * mana ability and another on an activated one. The permanent is named by the
   * ACTION (`ActivateAbilityAction.costInstanceId`) rather than chosen
   * mid-resolution: the cost is paid as the ability is activated (CR 602.2b),
   * before it is on the stack, so there is no resolution in which to ask.
   */
  readonly sacrificeAnother?: CardFilter;
  /** The printed word "another": the source itself may not pay (Yahenni). */
  readonly sacrificeExcludesSelf?: boolean;
  /** How many to sacrifice ("Sacrifice TWO artifacts" — Sai). Default 1. */
  readonly sacrificeCount?: number;
  /**
   * A LOYALTY cost — the `[+N]` / `[−N]` / `[0]` printed on a planeswalker's
   * abilities, SIGNED: `+1` adds a loyalty counter as the cost is paid, `-2`
   * removes two, `0` changes nothing (CR 606.5, 602.5b). Paying a negative cost
   * is only possible while the walker has at least that many loyalty counters —
   * you can never pay more loyalty than is there (CR 118.5).
   *
   * The engine also enforces the two rules that make these loyalty abilities
   * rather than ordinary activations: at most ONE loyalty ability per permanent
   * per turn (CR 606.3 as modified by the modern once-per-turn rule), and only at
   * sorcery speed — the compiler stamps `timing: 'sorcery'` on every loyalty
   * ability it builds, which is what CR 606.3 means.
   */
  readonly loyalty?: number;
}

/**
 * One activated ability: a cost, the effects it puts on the stack, and when it
 * may be activated.
 *
 * `timing` defaults to `'instant'` because that is the rules default — an
 * activated ability may be activated whenever its controller has priority
 * unless its text says otherwise (rule 602.2). A `'sorcery'` ability is the
 * exception ("Activate only as a sorcery").
 */
export interface ActivatedAbility {
  readonly cost: ActivationCost;
  readonly effects: readonly EffectRef[];
  readonly timing?: CastTiming;
  /** Human-readable text for the log, the inspector, and the replay viewer. */
  readonly label: string;
  /**
   * §3.149 — a printed **"Activate only if …"** restriction (CR 602.5a): a
   * condition that must hold for the ability to be activated at all.
   *
   * SEPARATE FROM {@link cost} on purpose, because the two are different rules
   * and the difference is visible. A cost is PAID — it taps the permanent,
   * spends the mana, removes the counters — and paying it changes the board. A
   * restriction is merely CHECKED: Luminarch Ascension's four quest counters
   * stay on it every time an Angel is made. Modelling the restriction as a cost
   * would consume them, which is a strictly worse card; modelling it as a
   * `timing` would lose it entirely.
   *
   * Enforced in `unpayableActivationReason`, the ONE funnel both the legality
   * check and the action-offer menu read — so an ability the pilot may not
   * activate is never offered AND never accepted, and the two answers cannot
   * drift apart.
   *
   * Absent ⇒ no restriction, which is every ability written before this existed.
   */
  readonly activateOnly?: ActivationRestriction;
}

/**
 * A printed "Activate only if …" condition — a CLOSED union, for the reason
 * every table in this engine is closed: a restriction the engine cannot decide
 * must make its card REPORT, never compile to one that is silently always true
 * (a strictly better card) or always false (a dead one).
 *
 * One member so far. 226 cards in the corpus print an "Activate only if" of
 * some shape and 8 of them print THIS shape, so the rest keep reporting until
 * their own conditions are built — deliberately, rather than being widened into
 * this one.
 */
export type ActivationRestriction = {
  /**
   * "Activate only if ~ has four or more **quest** counters on it" (Luminarch
   * Ascension, Glistening Sphere, Cryptex). Counts counters of one KIND on the
   * ability's own source; a source no longer on the battlefield has none, so
   * the condition fails rather than defaulting to true.
   */
  readonly kind: 'sourceHasCounters';
  /** The counter kind, exactly as `CardInstance.counters` keys it. */
  readonly counter: string;
  /** The printed floor — "four **or more**" is `min: 4`. */
  readonly min: number;
};

/**
 * One printed CYCLING ability: what it costs and what cycling it does.
 *
 * The cost is mana only — the other half of every printed cycling cost is
 * "Discard this card", which is not data because it is the same for every
 * cycling ability in the game and the engine performs it (see
 * `CardDefinition.cycling`).
 *
 * `effects` is what the ability puts on the stack, as ordinary effect refs, so
 * plain cycling ("Draw a card") and typecycling/landcycling ("Search your
 * library for a Plains card…") are the SAME mechanism with different data —
 * exactly one code path, and no primitive that exists only for cycling.
 */
export interface CyclingAbility {
  /** The mana cost paid to cycle (the discard is performed by the engine). */
  readonly cost: ManaCost;
  /** What the cycling ability does on resolution — a draw, or a search. */
  readonly effects: readonly EffectRef[];
  /** Human-readable text for the log, the inspector, and the replay viewer. */
  readonly label: string;
  // --- the cast-alternative family (§3.112) -----------------------------------------
  /**
   * WHICH printed "[cost], Discard this card: …" ability this is. Absent means
   * cycling (CR 702.29a). CHANNEL and BLOODRUSH are ability words (CR 207.2c)
   * whose whole rule is the printed line — the same from-hand discard
   * activation with a spell-shaped body — and TRANSMUTE (CR 702.53a) is the
   * same shape with a mana-value search. One funnel (`cycleCard`) plays all
   * four; the kind is here so the pilot can price a channel body as the spell
   * it is rather than as a draw, and so the keyword sweep has its evidence.
   */
  readonly kind?: 'channel' | 'bloodrush' | 'transmute';
  /**
   * "Activate only as a sorcery" — transmute's printed timing, and Ghost-Lit
   * Stalker's. Defaults to `'instant'`, the rules default for an activated
   * ability (CR 602.5d), exactly as `ActivatedAbility.timing` does.
   */
  readonly timing?: CastTiming;
}

// --- upkeep costs and time counters (§3.106) --------------------------------------

/** Counters a permanent enters with (CR 614.1c) — see `CardDefinition.entersWithCounters`. */
export interface EnteringCounters {
  /** The counter kind, exactly as `CardInstance.counters` keys it (`'time'`, `'fade'`). */
  readonly kind: string;
  readonly count: number;
}

/**
 * The printed **Suspend N—[cost]** (CR 702.62a).
 *
 * Only the plain form is modelled: a fixed count and a mana cost. "Suspend
 * X—{X}{W}{W}" and the cards that add abilities to the exiled card ("whenever a
 * time counter is removed from this card while it's exiled…") stay reported —
 * the count and the exile-side triggers are things this record cannot say.
 */
export interface SuspendAbility {
  /** How many time counters the card is exiled with. */
  readonly count: number;
  /** The suspend cost, paid as the special action is taken. */
  readonly cost: ManaCost;
  /**
   * The body of the exile-side upkeep ability, compiled by the cards package
   * exactly as `CyclingAbility.effects` is — core creates the delayed ability
   * and never names a primitive itself. It removes a time counter and, when the
   * last one leaves, opens the free-cast window.
   */
  readonly upkeep: readonly EffectRef[];
}

/**
 * Memo of a definition's subtypes, lower-cased into a set for O(1) case-insensitive
 * lookup. Same argument as the mana memos below: definitions are immutable and
 * shared across every instance, and subtype matching runs inside the continuous
 * layering pass that combat and legality checks drive.
 */
const SUBTYPE_SET_MEMO = new WeakMap<CardDefinition, ReadonlySet<string>>();

/**
 * The subtypes that are **not** creature types, so {@link CardDefinition.changeling}
 * ("this card is every creature type", CR 702.73a) cannot claim them.
 *
 * Changeling is expressed as an EXCLUSION list rather than as the ~280-entry
 * creature-type list, and only this direction stays correct as Magic prints new
 * words: every set adds creature types, and a new one would be silently missing
 * from an inclusion list — a changeling that stops being a Cephalid the day
 * Cephalids matter. The non-creature subtype vocabulary (land / artifact /
 * enchantment / spell types) is the half that is genuinely closed.
 *
 * Planeswalker types are deliberately absent: they are only ever asked about
 * alongside the planeswalker CARD TYPE, and {@link hasSubtype} already gates the
 * changeling answer on the card being a creature.
 *
 * Lower-cased, because {@link hasSubtype} folds both sides.
 */
const NON_CREATURE_SUBTYPES: ReadonlySet<string> = new Set([
  // Land types (basic and nonbasic).
  'plains', 'island', 'swamp', 'mountain', 'forest', 'wastes',
  'desert', 'gate', 'lair', 'locus', 'mine', 'power-plant', 'sphere', 'tower',
  "urza's", 'cave',
  // Artifact types.
  'equipment', 'fortification', 'vehicle', 'contraption', 'clue', 'food',
  'treasure', 'gold', 'blood', 'powerstone', 'map', 'junk', 'incubator',
  'bobblehead', 'attraction',
  // Enchantment types.
  'aura', 'cartouche', 'case', 'class', 'curse', 'rune', 'saga', 'shard',
  'shrine', 'background', 'role',
  // Spell types.
  'adventure', 'arcane', 'chorus', 'lesson', 'omen', 'trap',
]);

/**
 * Whether a definition has a printed subtype, compared case-insensitively.
 *
 * A card with no subtypes answers `false` without touching the memo, so the common
 * board pays a single property check.
 *
 * CHANGELING (CR 702.73a) is answered here and nowhere else, because this is the
 * single funnel every subtype question in the engine already goes through — the
 * shared `CardFilter` (`choices.ts`), every static's `anyOfSubtypes` /
 * `noneOfSubtypes`, fetchland searches, and the enters-tapped `controlsSubtype`
 * condition. A card that "is every creature type" therefore becomes one for lords,
 * for typal searches and for "non-Goblin" exclusions alike, with no consumer
 * having to learn the keyword exists.
 */
export function hasSubtype(def: CardDefinition, subtype: string): boolean {
  const folded = subtype.toLowerCase();
  // Changeling is asked BEFORE the printed list, because the whole point of the
  // keyword is that the printed list is not the answer. It is gated on the card
  // actually being a creature: the keyword grants creature types, and an artifact
  // creature with changeling is still not an Equipment.
  if (def.changeling === true && def.types.includes('creature') && !NON_CREATURE_SUBTYPES.has(folded)) {
    return true;
  }
  const printed = def.subtypes;
  if (!printed || printed.length === 0) return false;
  let set = SUBTYPE_SET_MEMO.get(def);
  if (!set) {
    set = new Set(printed.map((s) => s.toLowerCase()));
    SUBTYPE_SET_MEMO.set(def, set);
  }
  return set.has(folded);
}

/**
 * The minimum of a permanent that a chosen-value read needs: its active face and
 * what it named as it entered.
 *
 * Declared structurally rather than as `CardInstance` because `state.ts` imports
 * THIS file, so the dependency cannot run the other way — and because it makes
 * the contract explicit: nothing else about the instance participates.
 */
export interface ChoiceBearingPermanent {
  readonly def: CardDefinition;
  readonly chosenAsEntered?: string;
}

/**
 * Whether a PERMANENT has `subtype` — its printed subtypes, plus the one it
 * named as it entered when the card says it is that type too ("this creature is
 * the chosen type in addition to its other types",
 * {@link CardDefinition.isChosenSubtype}).
 *
 * This is the instance-aware form of {@link hasSubtype}, and it is what every
 * battlefield subtype question must use — a lord that named Goblin and is
 * therefore a Goblin has to see itself in the next lord's filter, or two
 * Adaptive Automatons stop pumping each other.
 *
 * It creates no layer-dependency loop (CR 613.8), for the same reason
 * `StaticAffects.hasCounterKind` does not: the named value is instance STATE
 * written once as the permanent entered, and no continuous effect in this engine
 * can change it. The single-pass layering stays exact.
 *
 * Reads in the printed order and returns early, so the common permanent — one
 * with no `isChosenSubtype` — pays exactly what {@link hasSubtype} costs today.
 */
export function permanentHasSubtype(permanent: ChoiceBearingPermanent, subtype: string): boolean {
  if (hasSubtype(permanent.def, subtype)) return true;
  if (permanent.def.isChosenSubtype !== true) return false;
  const chosen = permanent.chosenAsEntered;
  // Nothing named ⇒ no extra type. See `NOTHING_CHOSEN`: an unchosen value
  // matches nothing, never everything.
  return chosen !== undefined && chosen !== '' && chosen.toLowerCase() === subtype.toLowerCase();
}

/** Convenience predicates over a definition's type line. */
export function hasType(def: CardDefinition, type: CardType): boolean {
  return def.types.includes(type);
}

export function isLand(def: CardDefinition): boolean {
  return hasType(def, 'land');
}

export function isPermanentType(def: CardDefinition): boolean {
  return (
    hasType(def, 'land') ||
    hasType(def, 'creature') ||
    hasType(def, 'artifact') ||
    hasType(def, 'enchantment') ||
    hasType(def, 'planeswalker') ||
    hasType(def, 'battle')
  );
}

export function isCreature(def: CardDefinition): boolean {
  return hasType(def, 'creature');
}

export function isPlaneswalker(def: CardDefinition): boolean {
  return hasType(def, 'planeswalker');
}

export function isBattle(def: CardDefinition): boolean {
  return hasType(def, 'battle');
}

/**
 * Whether this permanent is a non-player object that ATTACKERS may be declared
 * against — planeswalkers and battles (CR 508.1). Combat asks this ONE question
 * (declaration legality, damage routing, the AI's target menu) so a future
 * attackable kind plugs in here without touching the combat code again.
 *
 * WHO may attack it differs by kind and is a separate question — see
 * `protectorOf` in state.ts: a walker is defended by its controller, a battle by
 * its PROTECTOR (its controller's opponent), which is why "attack my own battle"
 * is legal and "attack my own walker" is not.
 */
export function isAttackable(def: CardDefinition): boolean {
  return isPlaneswalker(def) || isBattle(def);
}

// ---------------------------------------------------------------------------
// THE MANA-ABILITY MODEL
//
// A mana ability is NOT an activated ability (CR 605.1a): it does not use the
// stack, nobody may respond to it, and it is offered during payment planning
// rather than with priority. That is why it cannot simply be folded into
// `ActivatedAbility` — an "activated ability that adds mana" would be
// respondable, which is a rules bug, and would arrive at the payment planner one
// stack resolution too late to fund anything.
//
// What a printed mana ability can carry beyond the colour bundle, and which this
// model therefore has to represent:
//   - an ADDITIONAL COST beyond the tap  ("{T}, Pay 1 life:", the filter lands'
//     "{R/W}, {T}:")
//   - a RIDER effect                     (every pain land, the Talisman cycle)
//   - an ACTIVATION RESTRICTION          (the Verge cycle, Nimbus Maze, Mox Opal)
//   - COLOURS DERIVED FROM THE BOARD     (Reflecting Pool, Exotic Orchard)
// ---------------------------------------------------------------------------

/**
 * What activating a mana ability costs BEYOND tapping the permanent.
 *
 * The `{T}` symbol is not represented here because every mana ability this
 * engine models prints it; a hypothetical mana ability without a tap would be a
 * repeatable free source, which no modelled card is.
 */
export interface ManaAbilityCost {
  /**
   * "Pay N life" — Mana Confluence, the horizon lands, Ancient Tomb's rider is
   * NOT this (that is a {@link ManaAbilityRider}: it happens on resolution and
   * is not a cost you may decline).
   *
   * Payable only while the controller's life is at least N (CR 118.4 — life pays
   * down to zero, never past), which is exactly the rule
   * `ActivationCost.life` already obeys.
   */
  readonly life?: number;
  /**
   * A mana component — the filter lands' "{R/W}, {T}: Add {R}{R}, {R}{W}, or
   * {W}{W}". Paid from the controller's FLOATING pool, exactly as
   * `ActivationCost.mana` is: the engine offers the activation only once the
   * input mana is actually floating, so a filter land is reached by tapping its
   * funding source first. See `pushManaTapActions` for why that is the same
   * gate every other mana-costed activation in this engine uses.
   */
  readonly mana?: ManaCost;
  /**
   * "{T}, **Sacrifice this artifact**: Add one mana of any color" — the
   * Treasure token, Lotus Petal. The source leaves for the graveyard through
   * the same death path a sacrifice cost on an activated ability uses, AFTER
   * the mana is added (the observable order is identical to paying first —
   * both are one atomic action — and the production still needs the source).
   */
  readonly sacrificeSelf?: boolean;
  /**
   * "**Tap an untapped creature you control**" (Springleaf Drum, Survivors'
   * Encampment) — an ADDITIONAL cost paid by tapping some OTHER permanent.
   *
   * The permanent is named by the ACTION (`TapForManaAction.costInstanceId`),
   * not chosen mid-resolution: a mana ability may not park a question (CR
   * 605.3a — it resolves immediately and nothing can respond), so the choice
   * has to be part of the action the pilot submits, exactly as the mana MODE
   * already is. The filter says which permanents qualify.
   */
  readonly tapAnother?: CardFilter;
  /**
   * "**Sacrifice a creature**" (Phyrexian Tower), "**Sacrifice a Food**"
   * (Gilded Goose), "**Sacrifice a Goblin**" (Skirk Prospector) — the same
   * shape as {@link tapAnother} and named by the action for the same reason.
   */
  readonly sacrificeAnother?: CardFilter;
  /**
   * The printed cost does NOT include {T} — "**Sacrifice a Goblin**: Add {R}"
   * (Skirk Prospector), "**Tap an untapped legendary creature you control**:
   * Add one mana of any color" (Relic of Legends).
   *
   * An explicit OPT-OUT rather than an inferred one: every mana source taps by
   * default (that is what a land does), and rich abilities that DO print {T}
   * carry no `tap` flag today — so reading an absent flag as "no tap" would
   * untap the whole pool. The difference is real: a source that does not tap
   * can be activated more than once a turn, which is what Skirk Prospector is.
   */
  readonly noTap?: boolean;
}

/**
 * An effect that happens as part of the mana ability's own resolution — the
 * second printed sentence of a pain land ("~ deals 1 damage to you") or a
 * Talisman ("~ deals 1 damage to you").
 *
 * A rider is NOT optional and NOT a cost: it happens after the mana is added,
 * and a controller who cannot "afford" it still takes it. That is why it is a
 * separate field from {@link ManaAbilityCost} rather than a negative life cost —
 * modelling a pain land's damage as a cost would wrongly make the land
 * unusable at 1 life, when in paper it is usable and lethal.
 */
export interface ManaAbilityRider {
  /**
   * "~ deals N damage to you" — damage to the ability's controller, from the
   * source permanent. Damage, not life loss: the distinction is real (prevention
   * and damage-triggered abilities see one and not the other), and the engine
   * routes it through the same player-damage path combat and burn use.
   */
  readonly damageToController?: number;
}

/**
 * "Activate only if …" — a board condition that must hold for a mana ability to
 * be activatable at all (CR 602.5a).
 *
 * Every field present must hold (they AND together); a field listing several
 * options is satisfied by ANY of them ("a Mountain **or** a Plains").
 *
 * Deliberately its own shape rather than reusing {@link EntersUntappedCondition}:
 * that one answers a question asked once, as a permanent enters, and its
 * vocabulary (`maxOtherLands`) is about the land drop. This one is asked on every
 * legal-action pass and needs colour and type-count vocabulary the entry
 * condition has no use for. Two questions, two shapes — merging them would make
 * one of the two carry fields that can never fire.
 */
export interface ManaActivationCondition {
  /** "if you control an Island" / "a Mountain or a Plains" — any listed subtype. */
  readonly controlsSubtype?: readonly string[];
  /** "if you control a red permanent" — any permanent of any listed colour. */
  readonly controlsColor?: readonly ManaColor[];
  /** Metalcraft: "if you control three or more artifacts". */
  readonly controlsTypeAtLeast?: { readonly type: CardType; readonly count: number };
}

/**
 * Where a mana ability's COLOURS come from when they are not printed.
 *
 * "Add one mana of any color that a land you control could produce" (Reflecting
 * Pool) / "…that a land an opponent controls could produce" (Exotic Orchard,
 * Fellwar Stone). The answer is a function of the board and is therefore
 * computed per query — never cached on the definition, which would freeze one
 * board's answer into a shared immutable object.
 */
export type DerivedManaColors = 'landsYouControl' | 'landsOpponentsControl';

/** One printed mana ability. */
export interface ManaAbility {
  /**
   * The modes this ability offers — one activation adds exactly ONE of them,
   * chosen by the controller. A fixed bundle is the single-entry case.
   *
   * Omitted exactly when {@link derivedColors} is set; the two are alternatives.
   */
  readonly produces?: readonly ManaProduction[];
  /** Present ⇒ the modes are one mana of each colour the board makes available. */
  readonly derivedColors?: DerivedManaColors;
  /**
   * "Add one mana of **the chosen color**" (Coldsteel Heart, Heraldic Banner,
   * Temple of the Dragon Queen) — the colour this ability makes is the one its
   * own permanent named as it entered
   * ({@link CardDefinition.asEntersChoice}).
   *
   * Modelled exactly like {@link derivedColors} and for the same reason: the
   * mode LIST is fixed at five entries (one per colour) because
   * `TapForManaAction.mode` is an index into it and a list whose length moved
   * with the game would make the same action number mean different colours to
   * the action generator, the payment planner and the apply path. WHICH of the
   * five is available is the per-permanent question, asked against the live
   * instance by `manaModeBlockedReason`.
   *
   * A permanent that named NOTHING has no available mode and therefore produces
   * no mana at all — the inert default, and the direction that can never play
   * better than the real card.
   */
  readonly chosenColor?: boolean;
  /**
   * Whether the derivation includes COLOURLESS. Oracle draws the line with one
   * word: Reflecting Pool adds "one mana of any **type** that a land you control
   * could produce" and can therefore make {C}; Exotic Orchard and Fellwar Stone
   * say "any **color**" and cannot. Ignoring the distinction would hand every
   * Orchard a colourless mode off a Wastes.
   */
  readonly derivedIncludesColorless?: boolean;
  /** Cost beyond the tap, if the card prints one. */
  readonly cost?: ManaAbilityCost;
  /** An effect that is part of this ability's resolution ("deals 1 damage to you"). */
  readonly rider?: ManaAbilityRider;
  /** "Activate only if …". */
  readonly restriction?: ManaActivationCondition;
  /**
   * "Spend this mana only to cast a creature spell" — a restriction carried by
   * the MANA this ability produces, not by the source (see spend-restriction.ts).
   *
   * It is the one entry in this interface that outlives the activation: the other
   * four are answered while the permanent is being tapped, and this one is
   * answered later, by the pool, when the mana is spent.
   */
  readonly spendRestriction?: ManaSpendRestriction;
  /** Human-readable text for logs and the inspector. */
  readonly label?: string;
}

/**
 * The spend-restriction descriptor of a definition — what a restricted mana asks
 * about the spell it is being offered to pay for.
 *
 * Memoized per definition and per kind. Definitions are immutable and shared, so
 * this is computed once per printed card for the whole process; a payment on a
 * board that holds restricted mana therefore costs a WeakMap lookup rather than
 * an allocation, and a payment on any other board never calls this at all.
 */
const SPEND_PURPOSE_MEMO = new WeakMap<
  CardDefinition,
  { cast?: ManaSpendPurpose; activate?: ManaSpendPurpose }
>();

export function spendPurposeFor(def: CardDefinition, kind: ManaSpendKind): ManaSpendPurpose {
  let entry = SPEND_PURPOSE_MEMO.get(def);
  if (!entry) {
    entry = {};
    SPEND_PURPOSE_MEMO.set(def, entry);
  }
  const memoized = entry[kind];
  if (memoized) return memoized;
  const built: ManaSpendPurpose = Object.freeze({
    kind,
    // Lowercased once, here, rather than on every clause comparison. `CardType`
    // is already lowercase; `subtypes` is printed in title case.
    types: def.types as readonly string[],
    subtypes: Object.freeze((def.subtypes ?? []).map((subtype) => subtype.toLowerCase())),
    legendary: def.legendary === true,
    colors: colorsOfDefinition(def),
  });
  entry[kind] = built;
  return built;
}

/**
 * The purpose to hand {@link canPay}/{@link payCost}, **or `undefined` when the
 * pool holds no restricted mana at all**.
 *
 * ⚠️ THE `undefined` RETURN IS THE POINT, exactly as it is for `manaExtrasOf`.
 * Payment feasibility is asked for every card in hand on every decision, and on
 * essentially every board there is nothing to restrict; the whole system must
 * therefore cost that board one property read on the pool. Call sites read
 * better for it too: the purpose is named at the place that knows what is being
 * paid for, and costs nothing where there is nothing to pay for it with.
 *
 * ⛔ **DO NOT USE THIS FOR `planManaPayment`.** It asks the pool as it is NOW, and
 * a planner is called before the mana exists — the restricted mana it is about to
 * create is exactly what the plan is for. Gating on the live pool made the
 * planner refuse to tap Ancient Ziggurat at all, because there was no purpose to
 * check the restriction it was creating against, and the pilot then read a
 * castable creature as uncastable. The planner takes the DEFINITION and resolves
 * the purpose itself, lazily; see `mana-plan.ts`.
 */
export function spendPurposeIfRestricted(
  pool: ManaPool,
  def: CardDefinition,
  kind: ManaSpendKind,
): ManaSpendPurpose | undefined {
  return pool.restricted === undefined ? undefined : spendPurposeFor(def, kind);
}

/**
 * The per-MODE facts a rich mana ability adds, parallel to {@link manaModesOf}.
 *
 * Flat and index-aligned with the mode list because `TapForManaAction.mode`
 * indexes that list, and a second indexing scheme would be one more thing for an
 * offer path and an apply path to disagree about.
 */
export interface ManaModeExtra {
  readonly ability: ManaAbility;
  /** For a derived-colour mode: which colour this mode would add. */
  readonly derivedColor?: ManaColor;
  /**
   * For a CHOSEN-colour mode ({@link ManaAbility.chosenColor}): which colour this
   * mode would add. Kept distinct from {@link derivedColor} rather than folded
   * into it because the availability questions are different — a derived mode
   * asks the BOARD what other lands make, a chosen mode asks THIS PERMANENT what
   * it named — and one field answering two questions is how a mode ends up
   * available for the wrong reason.
   */
  readonly chosenColor?: ManaColor;
}

/**
 * The colours a derived mana ability enumerates modes for, in canonical order.
 *
 * ALWAYS all six, including colourless, even for a "any color" ability that can
 * never make {C}: the mode list is the index space of `TapForManaAction.mode` and
 * must not change shape with the wording any more than it changes with the board.
 * The colourless mode of a colour-only ability is simply never available.
 */
const DERIVED_COLOR_ORDER: readonly ManaColor[] = MANA_COLORS;

/**
 * The colours a CHOSEN-colour mana ability enumerates modes for — the five a card
 * may name, in canonical order. Colourless is absent because "choose a color"
 * cannot name it; see {@link ManaAbility.chosenColor}.
 */
const CHOSEN_COLOR_ORDER: readonly ManaColor[] = Object.freeze(
  MANA_COLORS.filter((color) => color !== 'C'),
);

/** No mana modes — shared frozen empty list so the hot path allocates nothing. */
const NO_MANA_MODES: readonly ManaProduction[] = Object.freeze([]);

/**
 * Memo for the legacy-form normalisation below. Card definitions are immutable and
 * shared (the pool is frozen and every instance points at the same object), so the
 * folded mode list can be computed once per definition and reused forever.
 *
 * This matters: `manaModesOf` is called for every permanent on every
 * `generateLegalActions`, which is the engine's hottest read and runs millions of
 * times across a sim. Folding `['C','C']` into `{C:2}` on each call allocated a
 * fresh object every time and measurably cut sim throughput. A WeakMap keyed on
 * the definition keeps it allocation-free without pinning definitions in memory.
 */
const MANA_MODE_MEMO = new WeakMap<CardDefinition, readonly ManaProduction[]>();

/**
 * The mana-ability modes of a definition, as ONE normalised list regardless of
 * which authoring form was used: `producesOptions` verbatim when present, else
 * the legacy `produces` bundle folded into a single mode (`['C','C']` → one mode
 * of `{ C: 2 }`). A non-source yields an empty list.
 *
 * Every consumer (legal-action generation, payment, the AI's mana math) reads
 * modes through here, so "how many mana is one tap worth" has exactly one
 * answer in the codebase.
 */
export function manaModesOf(def: CardDefinition): readonly ManaProduction[] {
  // The rich form supersedes both shorthands (see `CardDefinition.manaAbilities`).
  if (def.manaAbilities && def.manaAbilities.length > 0) return flattenManaAbilities(def).modes;
  if (def.producesOptions && def.producesOptions.length > 0) return def.producesOptions;
  const bundle = def.produces;
  if (!bundle || bundle.length === 0) return NO_MANA_MODES;
  const memoized = MANA_MODE_MEMO.get(def);
  if (memoized) return memoized;
  const single: Partial<Record<string, number>> = {};
  for (const color of bundle) single[color] = (single[color] ?? 0) + 1;
  const modes: readonly ManaProduction[] = Object.freeze([single as ManaProduction]);
  MANA_MODE_MEMO.set(def, modes);
  return modes;
}

/**
 * The per-mode extras of a definition, index-aligned with {@link manaModesOf} —
 * or **`undefined` when this source prints nothing beyond the tap**.
 *
 * ⚠️ THE `undefined` RETURN IS THE POINT, not a convenience. `planManaPayment`
 * is the hottest function in the engine profile and the overwhelming majority of
 * real boards contain no source with a cost, a rider or a restriction. Every
 * caller therefore checks this once per source and takes a branch that does no
 * further work at all, so the model growing costs the common board exactly one
 * property read on an immutable definition — no allocation, no per-mode loop, no
 * per-query object. Do not "simplify" this into an array of `undefined`s.
 */
export function manaExtrasOf(def: CardDefinition): readonly ManaModeExtra[] | undefined {
  if (!def.manaAbilities || def.manaAbilities.length === 0) return undefined;
  return flattenManaAbilities(def).extras;
}

/** Memo for the flattened rich form — same immutability argument as the mode memo. */
const MANA_ABILITY_MEMO = new WeakMap<
  CardDefinition,
  { readonly modes: readonly ManaProduction[]; readonly extras: readonly ManaModeExtra[] }
>();

/**
 * Flatten `manaAbilities` into one mode list plus its parallel extras.
 *
 * A DERIVED ability always contributes exactly five modes (one per colour), on
 * the board or off it. Enumerating the superset rather than only the colours the
 * current board offers is deliberate: `TapForManaAction.mode` is an index into
 * this list, and a list whose LENGTH moved with the board would make the same
 * action number mean different colours to the action generator, the payment
 * planner and the apply path. Availability is a separate question, asked per
 * offer against the live board (`manaOfferBlockedReason` in engine.ts).
 */
function flattenManaAbilities(def: CardDefinition): {
  readonly modes: readonly ManaProduction[];
  readonly extras: readonly ManaModeExtra[];
} {
  const memoized = MANA_ABILITY_MEMO.get(def);
  if (memoized) return memoized;
  const modes: ManaProduction[] = [];
  const extras: ManaModeExtra[] = [];
  for (const ability of def.manaAbilities ?? []) {
    if (ability.derivedColors) {
      for (const color of DERIVED_COLOR_ORDER) {
        modes.push(Object.freeze({ [color]: 1 }) as ManaProduction);
        extras.push(Object.freeze({ ability, derivedColor: color }));
      }
      continue;
    }
    if (ability.chosenColor === true) {
      // The five NAMEABLE colours, never colourless: "choose a color" is one of
      // five (CR 105.1), so a sixth mode here would be a mode no printed card
      // offers. Same fixed-length argument as the derived branch above.
      for (const color of CHOSEN_COLOR_ORDER) {
        modes.push(Object.freeze({ [color]: 1 }) as ManaProduction);
        extras.push(Object.freeze({ ability, chosenColor: color }));
      }
      continue;
    }
    for (const production of ability.produces ?? []) {
      modes.push(production);
      extras.push(Object.freeze({ ability }));
    }
  }
  const flattened = Object.freeze({
    modes: Object.freeze(modes) as readonly ManaProduction[],
    extras: Object.freeze(extras) as readonly ManaModeExtra[],
  });
  MANA_ABILITY_MEMO.set(def, flattened);
  return flattened;
}

/* -------------------------------------------------------------------------- */
/* GRANTED mana abilities (DESIGN §3.143, GAP-G)                               */
/* -------------------------------------------------------------------------- */

/**
 * The effect primitives that do nothing but ADD MANA — the CLOSED table that
 * decides whether an activated ability is a MANA ability (CR 605.1a: an
 * activated ability is a mana ability if it could add mana, does not target and
 * is not a loyalty ability).
 *
 * ⚠️ CLOSED ON PURPOSE. An ability carrying any primitive that is not a row here
 * is NOT converted; it keeps the ordinary activated-ability path. That is a
 * REFUSAL rather than an approximation — a "mana ability" the engine invented out
 * of an effect it does not model would resolve without ever using the stack and
 * would silently drop whatever the other effect did. Adding a mana-only primitive
 * is a ROW here, not a code change anywhere else.
 */
const MANA_EFFECT_PRIMITIVES: ReadonlySet<string> = new Set(['addMana']);

/** The param a mana-adding primitive lists its colour symbols in (`['G','G']`). */
const MANA_EFFECT_SYMBOLS_PARAM = 'mana';

/**
 * Memo for {@link manaAbilityFromActivated}. `ActivatedAbility` objects live on
 * frozen card definitions and are shared by every instance, so one conversion per
 * printed ability serves the whole process. `null` records "looked at it, it is
 * not a mana ability", so a negative answer costs a WeakMap hit too.
 */
const GRANTED_MANA_ABILITY_MEMO = new WeakMap<ActivatedAbility, ManaAbility | null>();

/**
 * The {@link ManaAbility} an activated ability IS, or `undefined` when it is not
 * one — the single place in the codebase that answers "is this a mana ability".
 *
 * ## Why this exists
 * A continuous effect can GRANT an activated ability (Citanul Hierophants:
 * "Creatures you control have '{T}: Add {G}'"). The grant arrives as an
 * `ActivatedAbility`, because that is the only shape a modification can carry —
 * `PermanentModification` has no `manaAbilities` field and adding one would give
 * the grant a second vocabulary. But the MANA system reads {@link manaModesOf},
 * so a granted mana ability was invisible to `tapForMana`, to the payment planner
 * and to auto-tap: a pilot could make the mana only by putting the ability on the
 * stack and passing priority, which is not what a mana ability does (CR 605.3a)
 * and which `planManaPayment` can never do at all.
 *
 * ## What it refuses
 * Everything it cannot represent EXACTLY. A `ManaAbility` has no timing field, no
 * loyalty cost and no "sacrifice two"; and its `sacrificeAnother` always excludes
 * the source, while an `ActivationCost`'s only does when the card printed the word
 * "another". Each of those is a refusal, so the ability stays where it was rather
 * than becoming a mana ability with subtly different rules.
 */
export function manaAbilityFromActivated(ability: ActivatedAbility): ManaAbility | undefined {
  const memo = GRANTED_MANA_ABILITY_MEMO.get(ability);
  if (memo !== undefined) return memo ?? undefined;
  const built = buildManaAbilityFromActivated(ability) ?? null;
  GRANTED_MANA_ABILITY_MEMO.set(ability, built);
  return built ?? undefined;
}

function buildManaAbilityFromActivated(ability: ActivatedAbility): ManaAbility | undefined {
  if (ability.effects.length === 0) return undefined;
  // "Activate only as a sorcery" has no `ManaAbility` spelling, and a mana ability
  // that quietly lost its timing restriction would be a strictly better card.
  if (ability.timing !== undefined && ability.timing !== 'instant') return undefined;
  const cost = ability.cost;
  if (cost.loyalty !== undefined) return undefined; // CR 605.1a excludes loyalty abilities
  // `ManaAbilityCost.sacrificeAnother` names ONE payer and always excludes the
  // source; an `ActivationCost` says both of those separately.
  if (cost.sacrificeCount !== undefined && cost.sacrificeCount !== 1) return undefined;
  if (cost.sacrificeAnother !== undefined && cost.sacrificeExcludesSelf !== true) return undefined;

  const production: Record<string, number> = {};
  let pips = 0;
  for (const effect of ability.effects) {
    if (!MANA_EFFECT_PRIMITIVES.has(effect.primitive)) return undefined;
    const symbols = effect.params?.[MANA_EFFECT_SYMBOLS_PARAM];
    if (!Array.isArray(symbols)) return undefined;
    for (const symbol of symbols) {
      // A symbol outside the palette REPORTS rather than being dropped: an
      // ability whose production this engine cannot state in full is not a mana
      // ability it may offer.
      if (typeof symbol !== 'string' || !(MANA_COLORS as readonly string[]).includes(symbol)) {
        return undefined;
      }
      production[symbol] = (production[symbol] ?? 0) + 1;
      pips++;
    }
  }
  if (pips === 0) return undefined;

  const manaCost: ManaAbilityCost = {
    ...(cost.mana === undefined ? {} : { mana: cost.mana }),
    ...(cost.life === undefined ? {} : { life: cost.life }),
    ...(cost.sacrificeSelf === true ? { sacrificeSelf: true } : {}),
    ...(cost.sacrificeAnother === undefined ? {} : { sacrificeAnother: cost.sacrificeAnother }),
    // Every mana source taps by default (that is what a land does), so `noTap` is
    // the OPT-OUT — see {@link ManaAbilityCost.noTap}.
    ...(cost.tap === true ? {} : { noTap: true }),
  };
  return Object.freeze({
    produces: Object.freeze([Object.freeze(production) as ManaProduction]),
    cost: Object.freeze(manaCost),
    label: ability.label,
  });
}

/**
 * The mana abilities among a set of GRANTED activated abilities, in order — or
 * `undefined` when none of them is one, which is every board that has no grant at
 * all and nearly every board that has one.
 *
 * The order is the grant order, and {@link effectiveManaModesOf},
 * {@link effectiveManaExtrasOf} and {@link manaSourceNeverTaps} all build from
 * this ONE list, which is what keeps the first two index-aligned:
 * `TapForManaAction.mode` indexes both, and two builders with different ideas of
 * what mode 3 is would tap for the wrong colour.
 */
function grantedManaAbilitiesOf(
  granted: readonly ActivatedAbility[] | undefined,
): readonly ManaAbility[] | undefined {
  if (granted === undefined || granted.length === 0) return undefined;
  let out: ManaAbility[] | undefined;
  for (let i = 0; i < granted.length; i++) {
    const converted = manaAbilityFromActivated(granted[i] as ActivatedAbility);
    if (converted !== undefined) (out ??= []).push(converted);
  }
  return out;
}

/**
 * The mana modes a PERMANENT has right now: its definition's printed modes
 * followed by one mode per granted mana ability.
 *
 * PRINTED FIRST, then granted — the same ordering rule `effectiveActivated` uses,
 * so a mode index a player is looking at does not shift when an unrelated grant
 * appears.
 *
 * ⚠️ `granted === undefined` returns {@link manaModesOf}'s own memoized list by
 * identity and allocates nothing. That is essentially every board: this runs for
 * every permanent on every `generateLegalActions`, the engine's hottest read.
 */
export function effectiveManaModesOf(
  def: CardDefinition,
  granted: readonly ActivatedAbility[] | undefined,
): readonly ManaProduction[] {
  const printed = manaModesOf(def);
  const grants = grantedManaAbilitiesOf(granted);
  if (grants === undefined) return printed;
  const out: ManaProduction[] = printed.slice();
  for (const ability of grants) {
    out.push((ability.produces as readonly ManaProduction[])[0] as ManaProduction);
  }
  return out;
}

/**
 * The per-mode extras of a PERMANENT right now, index-aligned with
 * {@link effectiveManaModesOf}.
 *
 * A PRINTED mode with no extras leaves a HOLE rather than shifting the granted
 * entries down — the alignment is the contract, and `manaExtrasOf`'s "`undefined`
 * means nothing rich here" answer is preserved per MODE instead of per source.
 * That is the one case in which the array-of-`undefined`s `manaExtrasOf` forbids
 * is correct, and it only ever happens on a board that actually carries a grant.
 */
export function effectiveManaExtrasOf(
  def: CardDefinition,
  granted: readonly ActivatedAbility[] | undefined,
): readonly (ManaModeExtra | undefined)[] | undefined {
  // Same one-property-read fast path `manaExtrasOf`'s doc insists on.
  const printed = def.manaAbilities === undefined ? undefined : manaExtrasOf(def);
  const grants = grantedManaAbilitiesOf(granted);
  if (grants === undefined) return printed;
  const out: (ManaModeExtra | undefined)[] = [];
  const printedModes = manaModesOf(def).length;
  for (let i = 0; i < printedModes; i++) out.push(printed?.[i]);
  for (const ability of grants) out.push(Object.freeze({ ability }));
  return out;
}

/**
 * Whether EVERY mana ability this permanent has right now pays without tapping —
 * the question the offer path asks before skipping a TAPPED source.
 *
 * Effective, not printed: a granted "Sacrifice this creature: Add {B}{B}" (Basal
 * Sliver) is activatable while its host is tapped, exactly as a printed one is.
 */
export function manaSourceNeverTaps(
  def: CardDefinition,
  granted: readonly ActivatedAbility[] | undefined,
): boolean {
  const printed = def.manaAbilities;
  const printedNeverTaps =
    printed !== undefined && printed.length > 0 && printed.every((a) => a.cost?.noTap === true);
  const grants = grantedManaAbilitiesOf(granted);
  // Unchanged from the printed-only rule: a source with no rich mana ability at
  // all (a plain land) taps, and so does one whose abilities do not all opt out.
  if (grants === undefined) return printedNeverTaps;
  // One TAPPING mode is enough to make a tapped source unusable, so a printed
  // mode that is not itself a `noTap` ability settles it.
  if (manaModesOf(def).length > 0 && !printedNeverTaps) return false;
  return grants.every((ability) => ability.cost?.noTap === true);
}

/**
 * The colours this source could contribute to ANOTHER source's derived-colour
 * ability ("any color that a land you control could produce").
 *
 * `chosenColor` is what the permanent NAMED as it entered (`chosenColorOf` in
 * `as-enters.ts`), passed in by the caller rather than read here so this file
 * stays free of a dependency cycle. Omitting it — which is what every caller that
 * has only a definition does — makes a chosen-colour source contribute NOTHING,
 * the conservative direction that never invents mana the board cannot make.
 *
 * Deliberately excludes derived modes. Two Reflecting Pools do not see each
 * other: the rules answer is that a derived ability reads what the other
 * permanents *could* produce, and a permanent whose own production is defined by
 * that same question contributes nothing rather than looping. Excluding it here
 * is both the faithful answer and what makes the derivation terminate.
 */
export function fixedManaColorsOf(def: CardDefinition, chosenColor?: ManaColor): readonly ManaColor[] {
  const extras = manaExtrasOf(def);
  const modes = manaModesOf(def);
  const out: ManaColor[] = [];
  for (let i = 0; i < modes.length; i++) {
    if (extras?.[i]?.derivedColor !== undefined) continue;
    // A CHOSEN-colour mode contributes only the colour this permanent actually
    // named. Without the instance we cannot know it, so the mode contributes
    // nothing — a Reflecting Pool reads an unknown Coldsteel Heart as producing
    // nothing rather than as producing all five, which is the conservative
    // direction and the one that never invents mana that is not there.
    const modeChosenColor = extras?.[i]?.chosenColor;
    if (modeChosenColor !== undefined && modeChosenColor !== chosenColor) continue;
    const mode = modes[i] as ManaProduction;
    for (const color of MANA_COLORS) {
      if ((mode[color] ?? 0) > 0 && !out.includes(color)) out.push(color);
    }
  }
  return out;
}

/** Whether an "Activate only if …" condition holds for `controller` on this board. */
export function manaActivationConditionMet(
  condition: ManaActivationCondition,
  context: EntersTappedContext,
): boolean {
  const { controlsSubtype, controlsColor, controlsTypeAtLeast } = condition;
  let colorFound = controlsColor === undefined;
  let subtypeFound = controlsSubtype === undefined;
  let typeCount = 0;
  for (const permanent of context.battlefield) {
    if (permanent.controller !== context.controller) continue;
    if (!subtypeFound && controlsSubtype !== undefined) {
      for (const subtype of controlsSubtype) {
        if (hasSubtype(permanent.def, subtype)) {
          subtypeFound = true;
          break;
        }
      }
    }
    if (!colorFound && controlsColor !== undefined) {
      const colors = colorsOfDefinition(permanent.def);
      for (const color of controlsColor) {
        if (colors.includes(color)) {
          colorFound = true;
          break;
        }
      }
    }
    if (controlsTypeAtLeast !== undefined && hasType(permanent.def, controlsTypeAtLeast.type)) {
      typeCount += 1;
    }
  }
  if (!subtypeFound || !colorFound) return false;
  if (controlsTypeAtLeast !== undefined && typeCount < controlsTypeAtLeast.count) return false;
  return true;
}

/** Whether tapping this permanent for mana is a thing it can do at all. */
export function isManaSource(def: CardDefinition): boolean {
  return manaModesOf(def).length > 0;
}

/**
 * The distinct mana colours this source could produce, across all of its modes —
 * what a UI shows as "this can make {G}" / "this can make any colour".
 *
 * Derived from normalised modes, so it is correct for both authoring forms. A UI
 * reading `produces` directly renders a modal source as producing nothing at all.
 */
export function manaColorsOffered(def: CardDefinition): ManaColor[] {
  const seen = new Set<ManaColor>();
  for (const mode of manaModesOf(def)) {
    for (const color of MANA_COLORS) {
      if ((mode[color] ?? 0) > 0) seen.add(color);
    }
  }
  return [...seen];
}

/** Memo for {@link bestManaYield} — same immutability argument as the mode memo. */
const MANA_YIELD_MEMO = new WeakMap<CardDefinition, number>();

/**
 * The most mana ONE activation of this source can add — i.e. what tapping it is
 * worth. A modal source is worth its BEST mode, never the sum of its modes: an
 * any-colour source yields one mana, not five.
 *
 * Memoized because AI mana math reads this for every permanent on every decision,
 * which put it squarely on the sim's hot path.
 */
export function bestManaYield(def: CardDefinition): number {
  const memoized = MANA_YIELD_MEMO.get(def);
  if (memoized !== undefined) return memoized;
  let best = 0;
  for (const mode of manaModesOf(def)) {
    let total = 0;
    for (const color of MANA_COLORS) total += mode[color] ?? 0;
    if (total > best) best = total;
  }
  MANA_YIELD_MEMO.set(def, best);
  return best;
}

/**
 * A board condition under which a permanent enters UNTAPPED. Both forms are
 * evaluated the instant the permanent enters, counting only OTHER permanents —
 * the entering one is not yet on the battlefield when the check happens.
 */
/**
 * The printed land types a reveal-land will accept — "an Island or Swamp card
 * from your hand". Matched against a card's printed SUBTYPES, so a dual land
 * with those types is a legal reveal exactly as it is on the real card.
 */
export interface RevealFromHandCondition {
  readonly anyOfSubtypes: readonly string[];
}

/**
 * What a permanent NAMES as it enters — see {@link CardDefinition.asEntersChoice}.
 *
 * `subject` is the printed noun ("a creature type", "a color", "a player"), and
 * it is the whole record for every subject whose option list is a fixed, known
 * set. `options` exists for the one printed form that names its own menu —
 * Cloud Key's "choose artifact, creature, enchantment, instant, or sorcery" —
 * where the card, not the rules, decides what is on offer.
 */
export interface AsEntersChoice {
  readonly subject: import('./choices.js').ChosenValueSubject;
  /**
   * The explicit menu, when the card prints one. Absent ⇒ the canonical list for
   * the subject (`asEntersOptions` in `as-enters.ts`), which for a creature type
   * is derived from the game rather than hard-coded.
   */
  readonly options?: readonly string[];
  /** Prompt override for the UI / log. Absent ⇒ built from `subject`. */
  readonly prompt?: string;
}

export interface EntersUntappedCondition {
  /**
   * "unless you control two or fewer other lands" — a fastland. Satisfied when
   * the controller's other lands number at most this.
   */
  readonly maxOtherLands?: number;
  /**
   * "unless you control a Mountain or a Plains" — a checkland. Satisfied when
   * the controller has another permanent with any of these subtypes.
   */
  readonly controlsSubtype?: readonly string[];
  /**
   * "unless you control two or more **other** lands" — the slowland cycle
   * (Deserted Beach and friends). The mirror image of {@link maxOtherLands}:
   * satisfied when the controller's OTHER lands number at least this, so the
   * land is tapped early in the game and untapped late.
   */
  readonly minOtherLands?: number;
  /**
   * "unless you control two or more **basic** lands" — the Battle for Zendikar
   * battlelands (Sunken Hollow and friends). Counts only lands whose printed
   * type line carries the **Basic** supertype ({@link CardDefinition.basic}),
   * which is why that flag exists: a nonbasic dual land prints the same land
   * SUBTYPES as two basics and would otherwise be counted as one.
   */
  readonly minBasicLands?: number;
  /**
   * "unless you control **a legendary creature**" (Minas Tirith, Rivendell,
   * Barad-dûr), "unless you control **a basic land**" (Ba Sing Se), "unless you
   * control **three or more other Swamps**" (Witch's Cottage) — the GENERAL form
   * of which the three fields above are fixed printings.
   *
   * Satisfied when the controller's OTHER permanents matching `filter` number at
   * least `minimum` (default 1). It reuses the shared {@link CardFilter} rather
   * than growing a fourth bespoke count, so a new wording of the same rule is a
   * data edit; the older fields stay because live card data already uses them and
   * a silent re-encoding is exactly the kind of change that flips a land's
   * behaviour without a test noticing.
   *
   * Like every other condition here it counts only permanents the controller
   * controls, and never the entering land itself (the `self` exclusion in
   * {@link EntersTappedContext}) — which is what makes "three or more OTHER
   * Swamps" the plain reading rather than an off-by-one.
   */
  readonly controlsMatching?: {
    readonly filter: CardFilter;
    readonly minimum?: number;
  };
}

/**
 * The slice of the board an enters-tapped condition reads.
 *
 * Declared structurally rather than as `GameState` so `card.ts` stays free of a
 * cycle back through `state.ts`, which imports this module.
 */
export interface EntersTappedContext {
  readonly controller: string;
  readonly battlefield: readonly {
    readonly controller: string;
    readonly def: CardDefinition;
  }[];
  /** The entering permanent, excluded from its own condition when present. */
  readonly self?: unknown;
}

/**
 * Whether a permanent of this definition arrives tapped. One accessor so every
 * battlefield-entry path (resolving a permanent spell, playing a land, creating
 * a token) asks the same question the same way.
 *
 * `context` is required to answer a CONDITIONAL entry. Omitting it answers only
 * the unconditional flag — which is correct for a token or a test fixture with
 * no board, and deliberately conservative everywhere else.
 */
export function entersTapped(def: CardDefinition, context?: EntersTappedContext): boolean {
  if (def.entersTapped === true) return true;
  // A pay-life entry is a QUESTION, and this accessor cannot ask one. Tapped is
  // the printed "if you don't" default, so any entry path that does not raise
  // the choice gets the unpaid outcome — never a free untapped shockland. The
  // two paths that do ask override the answer explicitly.
  if (def.entersTappedUnlessLifePaid !== undefined) return true;
  // A reveal-land is the same shape of question, and gets the same unasked
  // default: showing a card is a CHOICE, and this accessor cannot ask one.
  if (def.entersTappedUnlessRevealed !== undefined) return true;
  const condition = def.entersTappedUnless;
  if (!condition) return false;
  // With no board to read we cannot evaluate the condition. Entering tapped is
  // the printed default (the "unless" is the exception), so that is the safe answer.
  if (!context) return true;
  return !conditionMet(condition, context);
}

/**
 * Whether `hand` holds a card this reveal-land would accept.
 *
 * Asked before the question is raised: a controller with nothing to show is not
 * asked at all, because the printed default is then the only outcome and
 * stopping the game for an answer that cannot matter would be a wedge.
 */
export function canRevealForUntapped(
  condition: RevealFromHandCondition,
  hand: readonly { readonly def: CardDefinition }[],
): boolean {
  for (const card of hand) {
    for (const subtype of condition.anyOfSubtypes) {
      if (hasSubtype(card.def, subtype)) return true;
    }
  }
  return false;
}

/**
 * Whether a card instance passes a filter. An absent filter matches everything.
 *
 * Written with explicit loops rather than `.some(...)`: static abilities
 * (`statics.ts`) run this for every permanent on the battlefield inside the
 * continuous-layering pass, which combat and every legality check drive, and a
 * closure allocated per predicate per candidate showed up in the hot path.
 *
 * The parameter is a {@link ChoiceBearingPermanent} — a `def` plus the subtype the
 * permanent NAMED as it entered — rather than a full `CardInstance`, which keeps
 * two callers honest at once. Subtype matching goes through `permanentHasSubtype`,
 * so a card that "is the chosen type in addition to its other types" is that type
 * here; and a caller holding only a definition — the enters-tapped conditions in
 * `card.ts`, which see the battlefield as `{ controller, def }` — is not forced to
 * fabricate an instance to ask the same question a second way. Every other
 * characteristic a filter reads is PRINTED (see {@link CardFilter.minPower}).
 */
export function matchesCardFilter(card: ChoiceBearingPermanent, filter?: CardFilter): boolean {
  if (!filter) return true;
  // The disjunction (see CardFilter.anyOf): one more conjunct clause — the
  // card must match at least one branch, AND whatever the siblings say.
  if (filter.anyOf !== undefined) {
    let any = false;
    for (let i = 0; i < filter.anyOf.length; i++) {
      if (matchesCardFilter(card, filter.anyOf[i])) { any = true; break; }
    }
    if (!any) return false;
  }
  const def = card.def;
  // The helper forms are the allocation-free, case-insensitive ones — required by
  // the statics pass that runs this for every permanent, and by subtype matching
  // that must treat "Mountain" and "mountain" alike.
  if (filter.anyOfTypes !== undefined && !hasAnyType(def.types, filter.anyOfTypes)) return false;
  if (filter.noneOfTypes !== undefined && hasAnyType(def.types, filter.noneOfTypes)) return false;
  if (filter.anyOfSubtypes !== undefined && !hasAnySubtype(card, filter.anyOfSubtypes)) return false;
  if (filter.noneOfSubtypes !== undefined && hasAnySubtype(card, filter.noneOfSubtypes)) return false;
  if (filter.nameEquals !== undefined && def.name !== filter.nameEquals) return false;
  // Supertypes: absent on most definitions, so `=== true` rather than truthiness —
  // `legendary: false` must match a plain creature, not be treated as "unset".
  if (filter.legendary !== undefined && (def.legendary === true) !== filter.legendary) return false;
  if (filter.basic !== undefined && (def.basic === true) !== filter.basic) return false;
  // The printed words "token" / "nontoken". Same `=== true` argument as the two
  // supertypes above: an ordinary card omits the flag entirely, so a `false`
  // filter must match it rather than reading `undefined` as "unset".
  if (filter.isToken !== undefined && (def.isToken === true) !== filter.isToken) return false;
  if (filter.minManaValue !== undefined || filter.maxManaValue !== undefined) {
    const mv = def.cost ? convertedManaCost(def.cost) : 0;
    if (filter.minManaValue !== undefined && mv < filter.minManaValue) return false;
    if (filter.maxManaValue !== undefined && mv > filter.maxManaValue) return false;
  }
  if (filter.minPower !== undefined || filter.maxPower !== undefined) {
    if (!withinPrintedBox(def.power, filter.minPower, filter.maxPower)) return false;
  }
  if (filter.minToughness !== undefined || filter.maxToughness !== undefined) {
    if (!withinPrintedBox(def.toughness, filter.minToughness, filter.maxToughness)) return false;
  }
  // Colors last: it is the only test that can touch the (memoized) pip walk, so
  // a candidate rejected by type/subtype/name never pays for it at all.
  if (filter.anyOfColors !== undefined && !hasAnyColor(def, filter.anyOfColors)) return false;
  return true;
}

/**
 * Whether a printed power/toughness box falls inside an inclusive bound.
 *
 * An ABSENT box (a non-creature, or a `*` P/T that is a formula rather than a
 * number) is outside every bound — see {@link CardFilter.minPower} for why that
 * is the printed reading and not a conservative guess.
 */
function withinPrintedBox(box: number | undefined, min?: number, max?: number): boolean {
  if (box === undefined) return false;
  if (min !== undefined && box < min) return false;
  if (max !== undefined && box > max) return false;
  return true;
}

/** Whether a definition is any of `wanted` colors. Allocation-free (see above). */
function hasAnyColor(def: CardDefinition, wanted: readonly ManaColor[]): boolean {
  const colors = colorsOfDefinition(def);
  for (const want of wanted) {
    for (const color of colors) {
      if (color === want) return true;
    }
  }
  return false;
}

/** Whether a type line carries any of `wanted`. Allocation-free (see above). */
function hasAnyType(types: readonly CardType[], wanted: readonly CardType[]): boolean {
  for (const want of wanted) {
    for (const type of types) {
      if (type === want) return true;
    }
  }
  return false;
}

/**
 * Whether a card carries any of `wanted` as a subtype.
 *
 * Instance-aware ({@link permanentHasSubtype}), not definition-only: a permanent
 * that named a creature type and prints "this creature is the chosen type in
 * addition to its other types" genuinely HAS that type, so a filter that read
 * only the printed line would fail to see one Adaptive Automaton from another.
 * For every card in a hand, library or graveyard the two readings are identical,
 * because nothing there has named anything.
 */
function hasAnySubtype(card: ChoiceBearingPermanent, wanted: readonly string[]): boolean {
  for (const want of wanted) {
    if (permanentHasSubtype(card, want)) return true;
  }
  return false;
}

/** Whether the "enters untapped" condition holds on the current board. */
function conditionMet(
  condition: EntersUntappedCondition,
  context: EntersTappedContext,
): boolean {
  const others = context.battlefield.filter(
    (permanent) => permanent.controller === context.controller && permanent !== context.self,
  );

  if (condition.maxOtherLands !== undefined) {
    const lands = others.filter((permanent) => permanent.def.types.includes('land')).length;
    if (lands > condition.maxOtherLands) return false;
  }

  if (condition.minOtherLands !== undefined) {
    const lands = others.filter((permanent) => permanent.def.types.includes('land')).length;
    if (lands < condition.minOtherLands) return false;
  }

  if (condition.minBasicLands !== undefined) {
    // "Other" is not part of the printed condition here — a battleland counts
    // every basic land you control — but the entering land is never basic
    // itself, so filtering it out changes no answer and reuses one list.
    const basics = others.filter(
      (permanent) => permanent.def.basic === true && permanent.def.types.includes('land'),
    ).length;
    if (basics < condition.minBasicLands) return false;
  }

  if (condition.controlsSubtype !== undefined) {
    const wanted = condition.controlsSubtype;
    // Through `hasSubtype`, so a changeling counts as the wanted type here for the
    // same reason it counts everywhere else — and so casing cannot break a
    // checkland.
    const has = others.some((permanent) => wanted.some((subtype) => hasSubtype(permanent.def, subtype)));
    if (!has) return false;
  }

  if (condition.controlsMatching !== undefined) {
    const { filter, minimum } = condition.controlsMatching;
    const needed = minimum ?? 1;
    let found = 0;
    for (const permanent of others) {
      if (!matchesCardFilter(permanent, filter)) continue;
      // Counting stops the moment the printed threshold is met: the condition is
      // "three or MORE", so the exact total past that point changes no answer.
      if (++found >= needed) break;
    }
    if (found < needed) return false;
  }

  return true;
}

/**
 * The face of `def` a `'front'`/`'back'` choice names, or `undefined` when the
 * card has no such playable face.
 *
 * `'back'` resolves only for a MODAL double-faced card
 * ({@link CardDefinition.backFaceCastable}). A transforming DFC's back face is
 * reached by a transform instruction and never by a cast or a land play (CR
 * 712.8b), so asking for it here yields `undefined` and the caller rejects —
 * which is what keeps a hostile online client (or a hand-built test) from
 * casting the 3/2 Aberration half of a Delver directly.
 */
export function playableFaceOf(def: CardDefinition, face: 'front' | 'back' | undefined): CardDefinition | undefined {
  // A SPLIT card's own definition is the CR 709.4 combined object, which is
  // never cast: `'front'` on one means its LEFT half. Every other layout is its
  // own front face, so this is one property read for all of them.
  if (face !== 'back') return def.frontFace ?? def;
  if (def.backFaceCastable !== true) return undefined;
  return def.backFace;
}

/**
 * The zones a card's castable BACK half may be cast from — `['hand']` unless
 * the definition says otherwise. THE accessor: the offer loop and the accept
 * path both ask it, so aftermath's graveyard-only restriction and a Siege
 * reward's exile-only one cannot be enforced in one place and forgotten in the
 * other.
 */
export function backFaceCastZonesOf(def: CardDefinition): readonly CastZone[] {
  return def.backFaceCastZones ?? DEFAULT_BACK_FACE_CAST_ZONES;
}

/** The zones a back half is castable from when its definition does not say. */
const DEFAULT_BACK_FACE_CAST_ZONES: readonly CastZone[] = ['hand'];

/**
 * Whether this definition is a SPLIT card's combined object rather than a
 * castable spell — the question "is what I am holding itself a thing I can
 * cast?", asked by name so no caller re-derives it from `frontFace != null`.
 */
export function isSplitCard(def: CardDefinition): boolean {
  return def.frontFace !== undefined;
}

/**
 * Whether this definition offers a second, CASTABLE face — the one question
 * every "offer both halves of this card" loop asks. Written as its own
 * predicate so the offer (`generateLegalActions`) and the accept
 * (`applyCastSpell`/`applyPlayLand`) cannot drift apart.
 */
export function hasCastableBackFace(def: CardDefinition): boolean {
  return def.backFaceCastable === true && def.backFace !== undefined;
}

/** Resolve a definition's casting timing, defaulting to sorcery-speed. */
export function castTiming(def: CardDefinition): CastTiming {
  if (def.timing) return def.timing;
  // Flash IS a timing rule — "you may cast this any time you could cast an
  // instant" — so a creature with flash is instant-speed exactly like one whose
  // data declares `timing: 'instant'`. Reading it here means every consumer of
  // `castTiming` (legality, the AI, the hotseat UI) inherits it for free.
  if (def.keywords?.flash === true) return 'instant';
  // Instants are instant-speed by type; everything else is sorcery-speed.
  return hasType(def, 'instant') ? 'instant' : 'sorcery';
}
