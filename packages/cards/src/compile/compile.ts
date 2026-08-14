/**
 * The Oracle-text → `CardDefinition` compiler.
 *
 * Given a normalized Scryfall card, produce the engine definition that genuinely
 * plays it — cost, types, P/T, keyword flags, mana production, triggered
 * abilities and spell scripts — by matching each printed ability against the
 * rule table in `./rules.ts`.
 *
 * The compiler is deliberately STRICT. Every printed ability must be consumed by
 * a rule; anything left over is reported in `missing` and the result is
 * `'incomplete'`, which callers must treat as "not playable yet" (see
 * `./types.ts`). This is what lets the deck lab import arbitrary real cards
 * without quietly degrading the fidelity its statistical verdicts depend on.
 *
 * Pure and synchronous: no I/O, no network, no globals — the caller supplies the
 * card record (DESIGN §2.1).
 */

import type {
  CardDefinition,
  CardType,
  EffectRef,
  ManaColor,
  ManaCost,
  TriggeredAbility,
} from '@jonny-boi/core';
import type {
  ClauseContribution,
  CompilableCard,
  CompileResult,
  CompileRule,
  RuleContext,
  UnsupportedClause,
} from './types.js';
import {
  EFFECT_RULES,
  KEYWORD_ABILITY_BUILDERS,
  KEYWORD_FLAGS,
  MANA_RULES,
  STATIC_RULES,
  TRIGGER_RULES,
  explainUnsupported,
  isVacuousClause,
} from './rules.js';
import { frontFaceName, normalizeClause, prepareOracle, splitSentences } from './text.js';

/** Scryfall card types → the core `CardType`s the engine understands. */
const TYPE_MAP: Readonly<Record<string, CardType>> = Object.freeze({
  land: 'land',
  creature: 'creature',
  instant: 'instant',
  sorcery: 'sorcery',
  artifact: 'artifact',
  enchantment: 'enchantment',
  planeswalker: 'planeswalker',
});

/**
 * Card types the engine has no system for, with the reason. `planeswalker` maps
 * to a real `CardType` (so it is representable) but has no loyalty system, so a
 * planeswalker can never be complete.
 */
const TYPES_WITHOUT_SYSTEM: Readonly<Record<string, string>> = Object.freeze({
  planeswalker: 'planeswalker loyalty abilities',
  battle: 'battles (siege / defense counters)',
});

/** Basic land subtypes → the mana they tap for. */
const LAND_SUBTYPE_MANA: Readonly<Record<string, ManaColor>> = Object.freeze({
  plains: 'W',
  island: 'U',
  swamp: 'B',
  mountain: 'R',
  forest: 'G',
});

/**
 * Keyword abilities that are not a simple combat flag but DO have a faithful
 * implementation built from primitives. Prowess is the canonical case: it is
 * modelled exactly as the hand-authored pool models it — a cast trigger per
 * noncreature spell type that pumps the source until end of turn.
 */
const KEYWORD_ABILITY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  prowess: 'whenever you cast a noncreature spell, target creature gets +1/+1 until end of turn',
});

/**
 * A color/color hybrid symbol as the Scryfall parser leaves it in `other`
 * (e.g. `G/W`). Monocolour hybrid (`2/W`) and Phyrexian (`W/P`) deliberately do
 * not match — the engine cannot pay those, so they must stay reported.
 */
const HYBRID_SYMBOL = /^([WUBRGC])\/([WUBRGC])$/;

/** Split `other` cost symbols into payable hybrids and genuinely unpayable ones. */
function partitionOtherSymbols(symbols: readonly string[]): {
  hybrid: ManaColor[][];
  unpayable: string[];
} {
  const hybrid: ManaColor[][] = [];
  const unpayable: string[] = [];
  for (const symbol of symbols) {
    const match = HYBRID_SYMBOL.exec(symbol.toUpperCase());
    if (match) hybrid.push([match[1] as ManaColor, match[2] as ManaColor]);
    else unpayable.push(symbol);
  }
  return { hybrid, unpayable };
}

/** Convert a data-tools mana cost to the core cost shape (omitting zeroes). */
function toCoreCost(card: CompilableCard, hybrid: readonly (readonly ManaColor[])[]): ManaCost | undefined {
  const source = card.manaCost;
  const cost: Record<string, unknown> = {};
  if (source.generic > 0) cost.generic = source.generic;
  for (const color of ['W', 'U', 'B', 'R', 'G', 'C'] as const) {
    const count = source[color];
    if (count > 0) cost[color] = count;
  }
  if (hybrid.length > 0) cost.hybrid = hybrid;
  return Object.keys(cost).length > 0 ? (cost as ManaCost) : undefined;
}

/** Try every rule in a table against one clause; return the first contribution. */
function applyRules(
  rules: readonly CompileRule[],
  clause: string,
  ctx: RuleContext,
): { contribution: ClauseContribution; ruleId: string } | null {
  for (const rule of rules) {
    const match = clause.match(rule.pattern);
    if (!match) continue;
    const contribution = rule.build(match, ctx);
    // A rule that recognized the shape but cannot implement this instance
    // returns null — keep looking, then fall through to `missing`.
    if (contribution) return { contribution, ruleId: rule.id };
  }
  return null;
}

/** Accumulator for the pieces a card's clauses contribute. */
interface Assembly {
  readonly effects: EffectRef[];
  readonly triggers: TriggeredAbility[];
  readonly produces: ManaColor[];
  keywords: Record<string, boolean>;
  entersTapped: boolean;
  readonly matchedRules: string[];
  readonly missing: UnsupportedClause[];
}

/** Merge one clause contribution into the assembly. */
function absorb(assembly: Assembly, contribution: ClauseContribution, ruleId: string): void {
  if (contribution.effects) assembly.effects.push(...contribution.effects);
  if (contribution.triggers) assembly.triggers.push(...contribution.triggers);
  if (contribution.produces) assembly.produces.push(...contribution.produces);
  if (contribution.keywords) {
    assembly.keywords = { ...assembly.keywords, ...(contribution.keywords as Record<string, boolean>) };
  }
  if (contribution.entersTapped) assembly.entersTapped = true;
  assembly.matchedRules.push(ruleId);
}

/**
 * Compile a keyword-only ability line ("Flying", "Trample, haste", "Prowess").
 * Returns false when any listed keyword has no faithful implementation, so the
 * line is reported rather than silently dropping an ability.
 */
function compileKeywordLine(line: string, assembly: Assembly, ctx: RuleContext): boolean {
  const words = line
    .split(',')
    .map((word) => normalizeClause(word))
    .filter((word) => word.length > 0);
  if (words.length === 0) return false;

  const flags: Record<string, boolean> = {};
  for (const word of words) {
    const field = KEYWORD_FLAGS[word];
    if (field) {
      flags[field] = true;
      continue;
    }
    // A keyword with a real primitive-built implementation, either as a direct
    // contribution (persist) or by compiling its printed meaning through the
    // ordinary trigger rules (prowess).
    const builder = KEYWORD_ABILITY_BUILDERS[word];
    if (builder) {
      absorb(assembly, builder(), `keyword:${word}`);
      continue;
    }
    const expansion = KEYWORD_ABILITY_TEXT[word];
    if (expansion) {
      const result = applyRules(TRIGGER_RULES, expansion, ctx);
      if (!result) return false;
      absorb(assembly, result.contribution, `keyword:${word}`);
      continue;
    }
    return false; // not a keyword we model — report the line
  }
  if (Object.keys(flags).length > 0) {
    assembly.keywords = { ...assembly.keywords, ...flags };
    assembly.matchedRules.push('keyword-flags');
  }
  return true;
}

/**
 * Compile one printed ability line. Order matters: triggers and mana abilities
 * are whole-line shapes; a spell's script may be one clause or several
 * sentences. A permanent's bare sentence is NOT treated as an effect — that
 * would be a static ability the engine does not model — so it is reported.
 */
function compileAbilityLine(
  rawLine: string,
  assembly: Assembly,
  ctx: RuleContext,
  isSpell: boolean,
): void {
  // Drop vacuously-satisfied riders first ("They can't be regenerated"), so a
  // fully-implementable ability isn't reported over a sentence that cannot
  // change anything in this engine.
  const kept = splitSentences(rawLine).filter(
    (sentence) => !isVacuousClause(normalizeClause(sentence)),
  );
  const line = kept.length > 0 ? kept.join(' ') : '';
  if (line.trim().length === 0) return;

  const clause = normalizeClause(line);
  if (clause.length === 0) return;

  const trigger = applyRules(TRIGGER_RULES, clause, ctx);
  if (trigger) {
    absorb(assembly, trigger.contribution, trigger.ruleId);
    return;
  }

  const mana = applyRules(MANA_RULES, clause, ctx);
  if (mana) {
    absorb(assembly, mana.contribution, mana.ruleId);
    return;
  }

  // Card-level static properties ("~ enters tapped").
  const staticRule = applyRules(STATIC_RULES, clause, ctx);
  if (staticRule) {
    absorb(assembly, staticRule.contribution, staticRule.ruleId);
    return;
  }

  if (isSpell) {
    // Whole-line first (compound idioms like "…deals 3 damage… You gain 3 life"),
    // then sentence-by-sentence for plain sequences of effects.
    const whole = applyRules(EFFECT_RULES, clause, ctx);
    if (whole) {
      absorb(assembly, whole.contribution, whole.ruleId);
      return;
    }
    const sentences = splitSentences(line).map(normalizeClause);
    if (sentences.length > 1) {
      const results = sentences.map((sentence) => applyRules(EFFECT_RULES, sentence, ctx));
      if (results.every((result) => result !== null)) {
        for (const result of results) absorb(assembly, result!.contribution, result!.ruleId);
        return;
      }
    }
  }

  // Keyword-only lines ("Flying", "First strike, lifelink", "Prowess").
  if (compileKeywordLine(line, assembly, ctx)) return;

  assembly.missing.push({ text: line.trim(), missingEngineSystem: explainUnsupported(clause) });
}

/**
 * Compile a normalized Scryfall card into an engine definition.
 *
 * @param card A card record (a `NormalizedCard` from `@jonny-boi/data-tools`
 *   satisfies the required shape structurally).
 * @returns The definition plus an honest completeness verdict — see
 *   {@link CompileResult}. Never throws: a malformed record yields an
 *   `'incomplete'` result explaining what was wrong.
 */
export function compileCard(card: CompilableCard): CompileResult {
  const assembly: Assembly = {
    effects: [],
    triggers: [],
    produces: [],
    keywords: {},
    entersTapped: false,
    matchedRules: [],
    missing: [],
  };

  // --- type line -------------------------------------------------------------
  const types: CardType[] = [];
  for (const printed of card.typeLine.types) {
    const key = printed.toLowerCase();
    const mapped = TYPE_MAP[key];
    const noSystem = TYPES_WITHOUT_SYSTEM[key];
    if (noSystem) {
      assembly.missing.push({ text: printed, missingEngineSystem: noSystem });
    }
    if (mapped) {
      types.push(mapped);
    } else if (!noSystem) {
      // A card type core has no representation for at all (e.g. Battle, Kindred).
      assembly.missing.push({
        text: printed,
        missingEngineSystem: `the "${printed}" card type`,
      });
    }
  }
  if (types.length === 0) {
    assembly.missing.push({
      text: `${card.typeLine.types.join(' ') || '(no type line)'}`,
      missingEngineSystem: 'a card type the engine can represent',
    });
  }

  // A double-faced card can be played as its front face, but the engine cannot
  // transform it — so the back face's existence is itself a gap.
  if (card.name.includes(' // ')) {
    assembly.missing.push({
      text: card.name,
      missingEngineSystem: 'transform / double-faced cards',
    });
  }

  // --- mana cost -------------------------------------------------------------
  // Colour/colour hybrid symbols are payable now (the mana system tries each
  // assignment). What remains in `other` — {X}, Phyrexian, monocolour hybrid,
  // snow — genuinely cannot be paid, and a card we would mis-cost is never
  // complete.
  const { hybrid, unpayable } = partitionOtherSymbols(card.manaCost.other);
  if (unpayable.length > 0) {
    assembly.missing.push({
      text: unpayable.map((symbol) => `{${symbol}}`).join(''),
      missingEngineSystem: 'variable ({X}), Phyrexian, and monocolour hybrid mana costs',
    });
  }
  const cost = toCoreCost(card, hybrid);

  // --- power / toughness -----------------------------------------------------
  const isCreatureCard = types.includes('creature');
  if (isCreatureCard && (card.power === null || card.toughness === null)) {
    assembly.missing.push({
      text: 'power/toughness',
      missingEngineSystem: 'dynamic power/toughness (characteristic-defining */*)',
    });
  }

  // --- lands: basic land types produce their mana without any printed text ----
  for (const subtype of card.typeLine.subtypes) {
    const color = LAND_SUBTYPE_MANA[subtype.toLowerCase()];
    if (color && types.includes('land')) {
      assembly.produces.push(color);
      assembly.matchedRules.push('basic-land-type');
    }
  }

  // --- printed abilities -----------------------------------------------------
  const isSpell = types.includes('instant') || types.includes('sorcery');
  const ctx: RuleContext = {
    card,
    compileEffectClause(text: string): readonly EffectRef[] | null {
      const clause = normalizeClause(text);
      const whole = applyRules(EFFECT_RULES, clause, ctx);
      if (whole) return whole.contribution.effects ?? [];
      // A multi-sentence trigger body: every sentence must compile.
      const sentences = splitSentences(text).map(normalizeClause);
      if (sentences.length > 1) {
        const refs: EffectRef[] = [];
        for (const sentence of sentences) {
          const result = applyRules(EFFECT_RULES, sentence, ctx);
          if (!result) return null;
          refs.push(...(result.contribution.effects ?? []));
        }
        return refs;
      }
      return null;
    },
  };

  for (const line of prepareOracle(card.oracleText, card.name)) {
    compileAbilityLine(line, assembly, ctx, isSpell);
  }

  // --- keyword flags printed on the type line but not in the text ------------
  // Scryfall lists a card's keywords separately; anything it lists that we did
  // not already pick up from the text must still be modelled or reported.
  for (const keyword of card.keywords) {
    const word = keyword.toLowerCase();
    const field = KEYWORD_FLAGS[word];
    if (field) {
      assembly.keywords = { ...assembly.keywords, [field]: true };
      continue;
    }
    // Keywords with a real implementation are compiled from the printed line
    // (prowess via its template, persist via a direct builder) — Scryfall
    // listing them again is not a second, unmodelled ability.
    if (KEYWORD_ABILITY_TEXT[word] || KEYWORD_ABILITY_BUILDERS[word]) continue;
    if (!assembly.missing.some((m) => m.text.toLowerCase().includes(word))) {
      assembly.missing.push({
        text: keyword,
        missingEngineSystem: `the "${keyword}" keyword ability`,
      });
    }
  }

  // --- assemble --------------------------------------------------------------
  const definition: CardDefinition = {
    id: card.id,
    // A double-faced card is played as its front face; the back is a separate
    // face the engine cannot transform into (reported in `missing` above).
    name: frontFaceName(card.name),
    types,
    ...(cost ? { cost } : {}),
    ...(isCreatureCard && card.power !== null ? { power: card.power } : {}),
    ...(isCreatureCard && card.toughness !== null ? { toughness: card.toughness } : {}),
    ...(Object.keys(assembly.keywords).length > 0 ? { keywords: assembly.keywords } : {}),
    ...(assembly.entersTapped ? { entersTapped: true } : {}),
    ...(assembly.effects.length > 0 ? { effects: assembly.effects } : {}),
    ...(assembly.produces.length > 0 ? { produces: assembly.produces } : {}),
    ...(assembly.triggers.length > 0 ? { triggers: assembly.triggers } : {}),
  };

  return {
    status: assembly.missing.length === 0 ? 'complete' : 'incomplete',
    definition,
    matchedRules: assembly.matchedRules,
    missing: assembly.missing,
  };
}

/**
 * Compile many cards, partitioning them into the ones that are genuinely
 * playable and the ones that need engine work. This is the shape the importer
 * consumes: it imports `playable` and shows `blocked` to the user verbatim.
 */
export function compileCards(cards: readonly CompilableCard[]): {
  readonly playable: readonly CardDefinition[];
  readonly blocked: ReadonlyArray<{ readonly card: CompilableCard; readonly missing: readonly UnsupportedClause[] }>;
} {
  const playable: CardDefinition[] = [];
  const blocked: Array<{ card: CompilableCard; missing: readonly UnsupportedClause[] }> = [];
  for (const card of cards) {
    const result = compileCard(card);
    if (result.status === 'complete') playable.push(result.definition);
    else blocked.push({ card, missing: result.missing });
  }
  return { playable, blocked };
}
