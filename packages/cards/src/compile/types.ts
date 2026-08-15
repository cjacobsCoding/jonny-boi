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
  /** Scryfall's keyword list (e.g. `['Flying', 'Prowess']`). */
  readonly keywords: readonly string[];
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
  /** Keyword flags granted to the card itself. */
  readonly keywords?: CardDefinition['keywords'];
  /** Set when the printed text says this permanent enters the battlefield tapped. */
  readonly entersTapped?: boolean;
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
}
