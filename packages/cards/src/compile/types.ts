/**
 * Types for the Oracle-text → `CardDefinition` compiler (the "import a real card"
 * seam). See `./compile.ts` for the orchestration and `./rules.ts` for the rule
 * table.
 *
 * THE CONTRACT THAT MAKES THIS TRUSTWORTHY: the compiler never approximates. A
 * card either compiles to a definition whose every printed ability is genuinely
 * implemented by registered primitives ({@link CompileStatus} `'complete'`), or it
 * reports the exact clauses it could not implement (`'incomplete'`) so the
 * importer can refuse to treat it as playable and tell the user precisely which
 * rules text is missing an engine system. We do NOT ship a half-modelled card and
 * call it real — that would silently corrupt the A/B sim verdicts the whole
 * project rests on (DESIGN §1.6, §4).
 */

import type { CardDefinition } from '@jonny-boi/core';

/**
 * The structural subset of a card record the compiler reads. `NormalizedCard`
 * from `@jonny-boi/data-tools` satisfies this shape, so callers pass one directly
 * — declared structurally here so `cards` needs no dependency on `data-tools`
 * (DESIGN §6: packages stay decoupled; they meet at shapes, not imports).
 */
export interface CompilableCard {
  /** Scryfall id — becomes the definition's id (the pool join key). */
  readonly id: string;
  readonly name: string;
  /** Parsed mana cost. `other` holds symbols we can't yet pay (X, hybrid, …). */
  readonly manaCost: {
    readonly generic: number;
    readonly W: number;
    readonly U: number;
    readonly B: number;
    readonly R: number;
    readonly G: number;
    readonly C: number;
    readonly other: readonly string[];
  };
  readonly typeLine: {
    readonly supertypes: readonly string[];
    readonly types: readonly string[];
    readonly subtypes: readonly string[];
  };
  readonly oracleText: string;
  /** Printed power/toughness; `null` for non-creatures and for `*` values. */
  readonly power: number | null;
  readonly toughness: number | null;
  /**
   * Printed starting loyalty — planeswalkers only. `null`/absent for everything
   * else, and for a walker whose record predates loyalty being captured (an old
   * cached index): the compiler then reports the missing datum rather than
   * inventing a number, because a walker entering at the wrong loyalty is a
   * different card.
   */
  readonly loyalty?: number | null;
  /**
   * Printed starting DEFENSE — battles only. `null`/absent for everything else,
   * and for a battle whose record predates defense being captured. The compiler
   * then reports the missing datum rather than inventing a number, because a
   * battle entering at the wrong defense is a different card — the exact
   * contract {@link CompilableCard.loyalty} already has.
   */
  readonly defense?: number | null;
  /** Scryfall's keyword list (e.g. `['Flying', 'Prowess']`). */
  readonly keywords: readonly string[];
  /**
   * Per-face data for a double-faced card, when the record carries it
   * (`NormalizedCard.faces`). The compiler uses it to compile a TRANSFORMING
   * DFC as two linked faces; a single-faced card omits it or leaves it empty.
   */
  readonly faces?: readonly CompilableCardFace[];
  /**
   * Scryfall's `layout` when the record carries it (`'transform'`,
   * `'modal_dfc'`, `'split'`, …). Optional because the committed index predates
   * the field — the transform detection therefore also accepts the `Transform`
   * keyword, which Scryfall stamps on every transforming DFC.
   */
  readonly layout?: string;
}

/**
 * One face of a double-faced card, structurally matching
 * `NormalizedCardFace` from `@jonny-boi/data-tools` (minus display-only
 * fields) for the same no-import reason as {@link CompilableCard}.
 */
export interface CompilableCardFace {
  readonly name: string;
  readonly manaCost: CompilableCard['manaCost'];
  readonly typeLine: CompilableCard['typeLine'];
  readonly oracleText: string;
  readonly power: number | null;
  readonly toughness: number | null;
}

/** Whether every printed ability compiled to a real implementation. */
export type CompileStatus = 'complete' | 'incomplete';

/** Why a specific piece of a card could not be faithfully implemented. */
export interface UnsupportedClause {
  /** The exact printed text (or symbol/keyword) we could not implement. */
  readonly text: string;
  /**
   * The engine system that would be needed, in user-facing words — e.g.
   * "player choice during resolution" or "planeswalker loyalty abilities".
   * This is what the import UI shows, so it must read as an explanation.
   */
  readonly missingEngineSystem: string;
}

/**
 * The compiler's output. `definition` is always present and always correct for
 * everything it *does* model (cost, types, P/T, mana production, the abilities
 * that matched rules) — but it is only safe to PLAY when `status` is `'complete'`.
 * On `'incomplete'`, `missing` names every clause that has no implementation.
 */
export interface CompileResult {
  readonly status: CompileStatus;
  readonly definition: CardDefinition;
  /** Ids of the rules that fired, in clause order (for debug/inspector display). */
  readonly matchedRules: readonly string[];
  /** Empty when `status` is `'complete'`. */
  readonly missing: readonly UnsupportedClause[];
}

/**
 * What a single matched clause contributes to the definition under construction.
 * A rule returns one of these; the compiler merges them in clause order. Every
 * field is optional so a rule contributes only what its clause actually says.
 */
export interface ClauseContribution {
  /** Effects appended to the spell-resolution / ETB script. */
  readonly effects?: readonly import('@jonny-boi/core').EffectRef[];
  /** Triggered abilities appended to the card. */
  readonly triggers?: readonly import('@jonny-boi/core').TriggeredAbility[];
  /** Mana this permanent taps for as a FIXED bundle (merged into `produces`). */
  readonly produces?: readonly import('@jonny-boi/core').ManaColor[];
  /**
   * Mana modes this permanent taps for when the printed ability offers a CHOICE
   * ("{T}: Add {W} or {U}") — merged into `producesOptions`, where one activation
   * adds exactly one mode.
   */
  readonly producesOptions?: readonly import('@jonny-boi/core').ManaProduction[];
  /**
   * A RICH mana ability — one that prints something beyond the colour bundle: an
   * additional cost, a rider, an "Activate only if …", or colours derived from
   * the board. Merged into `CardDefinition.manaAbilities`, which supersedes the
   * two shorthands above (the assembly folds any plain bundle in as one more
   * entry, so a pain land's "{T}: Add {C}" line and its painful line end up as
   * two entries of one list).
   */
  readonly manaAbilities?: readonly import('@jonny-boi/core').ManaAbility[];
  /** Keyword flags granted to the card itself. */
  readonly keywords?: CardDefinition['keywords'];
  /** Set when the printed text says this permanent enters the battlefield tapped. */
  readonly entersTapped?: boolean;

  /** Set when the text gives a BOARD condition for entering untapped. */
  readonly entersTappedUnless?: import('@jonny-boi/core').EntersUntappedCondition;
  /** Set when the text charges a LIFE price to enter untapped (a shockland). */
  readonly entersTappedUnlessLifePaid?: number;
  /** Set when the text asks for a REVEAL to enter untapped (a reveal-land). */
  readonly entersTappedUnlessRevealed?: import('@jonny-boi/core').RevealFromHandCondition;
  /**
   * "As ~ enters, choose a…" — the CR 614.1c naming this card makes as it
   * enters. Only the DECLARATION: who raises the question is decided once, by
   * the assembly, from whether the card is a land.
   */
  readonly asEntersChoice?: import('@jonny-boi/core').AsEntersChoice;
  /** "~ is the chosen type in addition to its other types". */
  readonly isChosenSubtype?: boolean;
  /**
   * The card's printed flashback cost (`CardDefinition.flashback`) — the mana
   * half. `{X}` symbols in it come back as {@link flashbackXCost} and a "Pay N
   * life" rider as {@link flashbackLifeCost}, so all three printed forms of
   * flashback compile through one rule.
   */
  readonly flashback?: import('@jonny-boi/core').ManaCost;
  /** How many `{X}` symbols the flashback cost prints ("Flashback {X}{R}{R}"). */
  readonly flashbackXCost?: number;
  /** A "Pay N life" rider on the flashback cost ("Flashback—{1}{U}, Pay 3 life"). */
  readonly flashbackLifeCost?: number;
  /** Activated abilities this clause prints ("Equip {2}"). */
  readonly activated?: readonly import('@jonny-boi/core').ActivatedAbility[];
  /**
   * The printed "Kicker {COST}" line — an optional additional cost the engine
   * asks about at cast time (`CardDefinition.kicker`).
   */
  readonly kicker?: import('@jonny-boi/core').ManaCost;
  /**
   * The printed "As an additional cost to cast this spell, …" line — a MANDATORY
   * additional cost (`CardDefinition.additionalCost`). Unlike {@link kicker} it
   * cannot be declined, so a caster who cannot pay it cannot cast the spell at
   * all; see the core type for why that difference earns its own field.
   */
  readonly additionalCost?: import('@jonny-boi/core').AdditionalCastCost;
  /**
   * The printed "Multikicker {COST}" line — an additional cost the caster may
   * pay ANY NUMBER of times, so the cast-time question is a count rather than a
   * yes/no (`CardDefinition.multikicker`).
   */
  readonly multikicker?: import('@jonny-boi/core').ManaCost;
  /**
   * The printed modal header and its modes ("Choose one — • … • …"), chosen at
   * cast time (`CardDefinition.modal`). A modal card's whole script lives here
   * rather than in {@link effects}: each mode carries its own effects AND its
   * own target restriction, because two chosen modes point at two objects.
   */
  readonly modal?: import('@jonny-boi/core').ModalSpec;
  /**
   * The printed "Cycling {2}" / "Plainscycling {2}" line — an activated ability
   * of the card while it is in HAND (`CardDefinition.cycling`). A list because
   * a card may print more than one, and the contributions accumulate.
   */
  readonly cycling?: readonly import('@jonny-boi/core').CyclingAbility[];
  /**
   * The printed "Buyback {3}" line — an optional additional cost that returns
   * the spell to its caster's hand as it resolves (`CardDefinition.buyback`).
   */
  readonly buyback?: import('@jonny-boi/core').ManaCost;
  /**
   * The printed "Madness {1}{U}" line — discarding the card exiles it instead,
   * with a window to cast it for this cost (`CardDefinition.madness`).
   */
  readonly madness?: import('@jonny-boi/core').ManaCost;
  /**
   * A CHARACTERISTIC-DEFINING P/T this clause prints — the formula behind a `*`
   * box (Tarmogoyf). Present ⇒ the card's printed P/T is variable and the
   * assembly emits `CardDefinition.characteristicPT` INSTEAD of numbers.
   */
  readonly characteristicPT?: import('@jonny-boi/core').CharacteristicPT;
  /**
   * Static ("anthem") abilities this clause prints ("Creatures you control get
   * +1/+1") — continuous modifications applied by core's statics layer for as
   * long as this permanent is on the battlefield.
   */
  readonly statics?: readonly import('@jonny-boi/core').StaticAbility[];
  /**
   * The half of an attachment that says WHAT it attaches to and what happens when
   * it isn't legally attached — the printed "Enchant creature" / "Equip {N}" line.
   */
  readonly attachesAs?: Pick<
    import('@jonny-boi/core').AttachmentSpec,
    'attachesTo' | 'whenIllegal' | 'label'
  >;
  /**
   * The other half: what the host gets while attached ("Enchanted creature gets
   * +2/+0 and has trample"). Kept separate from {@link attachesAs} because a real
   * card prints them as two ability lines, and either may be absent.
   */
  readonly attachmentModifies?: import('@jonny-boi/core').PermanentModification;
}

/** A compiler rule: a pattern over one normalized clause + what it builds. */
export interface CompileRule {
  /** Stable id used in `matchedRules` and in tests. */
  readonly id: string;
  /** What printed template this recognizes, for humans reading the table. */
  readonly description: string;
  /** Matched against the normalized clause text (lowercased, `~` for the name). */
  readonly pattern: RegExp;
  /**
   * True when the effect this rule builds only works if a TARGET was chosen when
   * the spell was cast. Such a rule is unusable inside a triggered ability, since
   * core resolves triggers with an empty target list — the effect would silently
   * no-op. The compiler refuses those bodies instead (see `RuleContext`).
   */
  readonly needsChosenTarget?: boolean;
  /**
   * Build the contribution from the regex match. Returning `null` means "this
   * rule recognized the shape but cannot faithfully implement this instance"
   * (e.g. a mode the primitives don't cover) — the clause then falls through to
   * `missing` rather than compiling into something subtly wrong.
   */
  build(match: RegExpMatchArray, ctx: RuleContext): ClauseContribution | null;
}

/** Context a rule may consult while building (the card being compiled). */
export interface RuleContext {
  readonly card: CompilableCard;
  /**
   * Compile a nested clause (a trigger's body) with the same effect rules.
   * Returns the effects, or `null` when the body itself is unsupported — which
   * makes the whole trigger unsupported rather than silently empty.
   *
   * Pass `targetFree` when the clause will run somewhere no target can be chosen
   * (a triggered ability); rules flagged {@link CompileRule.needsChosenTarget}
   * are then rejected rather than compiled into a no-op.
   */
  compileEffectClause(
    text: string,
    options?: { readonly targetFree?: boolean },
  ): readonly import('@jonny-boi/core').EffectRef[] | null;
  /**
   * Compile a TRIGGER's body, reporting what it targets.
   *
   * A trigger chooses its targets as it goes on the stack (core's
   * `TriggeredAbility.targets`), so unlike a spell — where the caster names the
   * target in the cast action — the ABILITY has to declare what may be chosen.
   * This returns both halves, and `null` when the body has no faithful
   * implementation at all.
   *
   * A body that would need TWO chosen targets is rejected: every printed template
   * reproduced here names one, and quietly aiming both at the same object would
   * be a card playing differently from its text.
   */
  compileTriggerBody(text: string): TriggerBodyResult | null;
}

/** What {@link RuleContext.compileTriggerBody} recovered from a trigger's body. */
export interface TriggerBodyResult {
  readonly effects: readonly import('@jonny-boi/core').EffectRef[];
  /** What the ability targets, or `undefined` when it targets nothing. */
  readonly targets?: import('@jonny-boi/core').TargetRestriction;
}
