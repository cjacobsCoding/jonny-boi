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
  readonly targets?: import('./targeting.js').TargetRestriction;
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
  | 'timesThisWasKicked';

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
  /** Human-readable text for logs and the inspector. */
  readonly label?: string;
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

/**
 * The colours this source could contribute to ANOTHER source's derived-colour
 * ability ("any color that a land you control could produce").
 *
 * Deliberately excludes derived modes. Two Reflecting Pools do not see each
 * other: the rules answer is that a derived ability reads what the other
 * permanents *could* produce, and a permanent whose own production is defined by
 * that same question contributes nothing rather than looping. Excluding it here
 * is both the faithful answer and what makes the derivation terminate.
 */
export function fixedManaColorsOf(def: CardDefinition): readonly ManaColor[] {
  const extras = manaExtrasOf(def);
  const modes = manaModesOf(def);
  const out: ManaColor[] = [];
  for (let i = 0; i < modes.length; i++) {
    if (extras?.[i]?.derivedColor !== undefined) continue;
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
  if (face !== 'back') return def;
  if (def.backFaceCastable !== true) return undefined;
  return def.backFace;
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
