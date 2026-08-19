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

import type { ManaColor, ManaCost, ManaProduction } from './mana.js';
import { MANA_COLORS } from './mana.js';

/** Broad card types core needs to enforce timing and zone transitions. */
export type CardType =
  | 'land'
  | 'creature'
  | 'instant'
  | 'sorcery'
  | 'artifact'
  | 'enchantment'
  | 'planeswalker'
  | 'battle';

/**
 * Keyword ability flags the combat/turn systems read as data. Core implements the
 * pure-combat keywords; broader-system keywords are present as flags so `cards`
 * can author them now, with engine hooks landing later.
 */
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
}

/**
 * The qualities a printed "protection from …" can name, each with an exact
 * engine meaning (see `sourceHasQuality` in `protection.ts`). A closed list on
 * purpose: a quality outside it ("protection from Demons", "from instants") has
 * no faithful check, so the compiler reports those cards instead of guessing.
 */
export type ProtectionQuality =
  | 'white'
  | 'blue'
  | 'black'
  | 'red'
  | 'green'
  /** A source with NO colors (true colorless — lands, most artifacts). */
  | 'colorless'
  /** A source with two or more colors. */
  | 'multicolored'
  /** Any source whose card is an artifact. */
  | 'artifacts'
  /** Any source whose card is a creature. */
  | 'creatures'
  /** Every source, whatever its qualities. */
  | 'everything';

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
   * Only the single-kicker form is modelled; multikicker (pay any number of
   * times) needs a count, and cards printing it stay reported.
   */
  readonly kicker?: ManaCost;
  readonly power?: number;
  readonly toughness?: number;
  /**
   * CHARACTERISTIC-DEFINING power/toughness — the printed star/star box whose value
   * is a formula over the game state ("~'s power is equal to the number of card
   * types among cards in all graveyards…" — Tarmogoyf, Boneyard Wurm, Maro).
   *
   * Present ⇒ {@link power}/{@link toughness} are ABSENT: a card defines its P/T
   * by numbers or by formula, never both, and the compiler refuses a record that
   * would claim both. The formula is applied in CR 613.3's layer 7a — BEFORE
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
  readonly keywords?: KeywordFlags;
  /**
   * Ordered effects run when this spell resolves (instants/sorceries) or as the
   * permanent's enters-the-battlefield script. Opaque to core.
   */
  readonly effects?: readonly EffectRef[];
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
   * Only the PLAIN mana-cost form is modelled. A flashback cost with {X} or
   * additional non-mana costs ("Flashback—{1}{U}, Discard a card") needs the
   * cast-cost-modification system and stays reported by the compiler.
   */
  readonly flashback?: ManaCost;
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
  /** Distinct card types among cards in ALL graveyards (Tarmogoyf). */
  | 'cardTypesInAllGraveyards';

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
 * The colors of a definition: every color appearing among its cost's colored
 * pips, hybrid symbols included. A land, a free spell, or an artifact with a
 * purely generic cost has no colors ({C} pips are colorless, not a color).
 *
 * The engine has no color indicators and no color-changing effects, so this is
 * the color of every card it can represent — with one documented exception: a
 * transforming DFC's BACK face has no mana cost and reads as colorless, where
 * the printed card carries a color indicator. Every color consumer (protection,
 * colored card filters) inherits that limit together, from this one reader.
 */
export function colorsOfDefinition(def: CardDefinition): readonly ManaColor[] {
  const memoized = COLORS_MEMO.get(def);
  if (memoized) return memoized;
  const cost = def.cost;
  const colors: ManaColor[] = [];
  if (cost) {
    for (const pip of COLOR_PIPS) {
      if ((cost[pip] ?? 0) > 0) colors.push(pip);
    }
    if (cost.hybrid) {
      for (const symbol of cost.hybrid) {
        for (const option of symbol) {
          if (option !== 'C' && !colors.includes(option)) colors.push(option);
        }
      }
    }
  }
  const frozen = Object.freeze(colors);
  COLORS_MEMO.set(def, frozen);
  return frozen;
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
  /** The `{T}` symbol: tap this permanent (and obey summoning sickness). */
  readonly tap?: boolean;
  /** "Sacrifice ~": this permanent goes to its owner's graveyard. */
  readonly sacrificeSelf?: boolean;
  /** "Pay N life". Payable only while the controller's life exceeds it. */
  readonly life?: number;
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
}

/**
 * Memo of a definition's subtypes, lower-cased into a set for O(1) case-insensitive
 * lookup. Same argument as the mana memos below: definitions are immutable and
 * shared across every instance, and subtype matching runs inside the continuous
 * layering pass that combat and legality checks drive.
 */
const SUBTYPE_SET_MEMO = new WeakMap<CardDefinition, ReadonlySet<string>>();

/**
 * Whether a definition has a printed subtype, compared case-insensitively.
 *
 * A card with no subtypes answers `false` without touching the memo, so the common
 * board pays a single property check.
 */
export function hasSubtype(def: CardDefinition, subtype: string): boolean {
  const printed = def.subtypes;
  if (!printed || printed.length === 0) return false;
  let set = SUBTYPE_SET_MEMO.get(def);
  if (!set) {
    set = new Set(printed.map((s) => s.toLowerCase()));
    SUBTYPE_SET_MEMO.set(def, set);
  }
  return set.has(subtype.toLowerCase());
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
    const has = others.some((permanent) =>
      (permanent.def.subtypes ?? []).some((subtype) => wanted.includes(subtype)),
    );
    if (!has) return false;
  }

  return true;
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
