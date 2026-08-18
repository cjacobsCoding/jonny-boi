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
  ActivatedAbility,
  ActivationCost,
  AttachmentSpec,
  CardDefinition,
  CardType,
  EffectRef,
  ManaColor,
  ManaCost,
  ManaProduction,
  PermanentModification,
  TargetRestriction,
  TriggeredAbility,
} from '@jonny-boi/core';
import { DEFAULT_TARGET_RESTRICTION, restrictionOfEffects } from '@jonny-boi/core';
import type {
  ClauseContribution,
  CompilableCard,
  CompileResult,
  CompileRule,
  RuleContext,
  TriggerBodyResult,
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
import { frontFaceName, normalizeClause, parseManaSymbols, prepareOracle, splitSentences } from './text.js';

/**
 * Scryfall's keyword names for the two printed attachment abilities. They are
 * modelled by the rule table (`enchant-permanent` / `equip-cost`) rather than by a
 * keyword flag, so the keyword sweep must not report them a second time.
 */
const ATTACHMENT_KEYWORDS: ReadonlySet<string> = new Set(['enchant', 'equip']);

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
 * planeswalker can never be complete. Exported so the About view's TODO list can
 * name these gaps from the same record the compiler judges by.
 */
export const TYPES_WITHOUT_SYSTEM: Readonly<Record<string, string>> = Object.freeze({
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
  // Prowess's own reminder text, in the compiler's canonical form: the SOURCE
  // gets the buff. (It must be the self template, not "target creature" — a
  // triggered ability resolves with no chosen targets, so only a self-referring
  // pump is faithful inside one. See `triggerFrom` in ./rules.ts.)
  prowess: 'whenever you cast a noncreature spell, ~ gets +1/+1 until end of turn',
});

/**
 * A color/color hybrid symbol as the Scryfall parser leaves it in `other`
 * (e.g. `G/W`). Monocolour hybrid (`2/W`) and Phyrexian (`W/P`) deliberately do
 * not match — the engine cannot pay those, so they must stay reported.
 */
const HYBRID_SYMBOL = /^([WUBRGC])\/([WUBRGC])$/;

/** Fold a fixed bundle of colors ({C}{C}) into the single mode one tap adds. */
function bundleAsMode(bundle: readonly ManaColor[]): ManaProduction {
  const mode: Partial<Record<ManaColor, number>> = {};
  for (const color of bundle) mode[color] = (mode[color] ?? 0) + 1;
  return mode;
}

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

/**
 * Whether the rule with this id declares that its effects need a target chosen by
 * somebody. Looked up by id (rather than threaded through every call site)
 * because it is asked once per trigger body, off any hot path — and looking it up
 * in the SAME table `applyRules` matched against is what stops the two from
 * disagreeing about which rules target.
 */
function ruleNeedsChosenTarget(ruleId: string): boolean {
  return EFFECT_RULES.some((rule) => rule.id === ruleId && rule.needsChosenTarget === true);
}

/**
 * Try every rule in a table against one clause; return the first contribution.
 *
 * `targetFree` restricts the table to rules whose effects work without a
 * caster-chosen target — the mode trigger bodies compile in, since core resolves
 * triggered abilities with no targets.
 */
function applyRules(
  rules: readonly CompileRule[],
  clause: string,
  ctx: RuleContext,
  targetFree = false,
): { contribution: ClauseContribution; ruleId: string } | null {
  for (const rule of rules) {
    if (targetFree && rule.needsChosenTarget) continue;
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
  readonly producesOptions: ManaProduction[];
  readonly activated: ActivatedAbility[];
  keywords: Record<string, boolean>;
  entersTapped: boolean;
  entersTappedUnless?: import('@jonny-boi/core').EntersUntappedCondition;
  /** The "Enchant …" / "Equip {N}" half of an attachment, once some line prints it. */
  attachesAs?: ClauseContribution['attachesAs'];
  /** The "Enchanted/Equipped creature gets …" half, accumulated across lines. */
  attachmentModifies?: PermanentModification;
  readonly matchedRules: string[];
  readonly missing: UnsupportedClause[];
}

/** Merge one clause contribution into the assembly. */
function absorb(assembly: Assembly, contribution: ClauseContribution, ruleId: string): void {
  if (contribution.effects) assembly.effects.push(...contribution.effects);
  if (contribution.triggers) assembly.triggers.push(...contribution.triggers);
  if (contribution.produces) assembly.produces.push(...contribution.produces);
  if (contribution.producesOptions) assembly.producesOptions.push(...contribution.producesOptions);
  if (contribution.keywords) {
    assembly.keywords = { ...assembly.keywords, ...(contribution.keywords as Record<string, boolean>) };
  }
  if (contribution.activated) assembly.activated.push(...contribution.activated);
  if (contribution.entersTapped) assembly.entersTapped = true;
  if (contribution.entersTappedUnless) assembly.entersTappedUnless = contribution.entersTappedUnless;
  if (contribution.attachesAs) assembly.attachesAs = contribution.attachesAs;
  if (contribution.attachmentModifies) {
    // Merged rather than replaced: a card may print the P/T line and the keyword
    // line separately ("Equipped creature gets +1/+1." / "Equipped creature has
    // vigilance."), and both are the same one modification.
    assembly.attachmentModifies = mergeModifications(assembly.attachmentModifies, contribution.attachmentModifies);
  }
  assembly.matchedRules.push(ruleId);
}

/** Sum two attachment modifications (P/T adds, keyword grants OR together). */
function mergeModifications(
  existing: PermanentModification | undefined,
  incoming: PermanentModification,
): PermanentModification {
  if (!existing) return incoming;
  return {
    power: (existing.power ?? 0) + (incoming.power ?? 0),
    toughness: (existing.toughness ?? 0) + (incoming.toughness ?? 0),
    keywords: { ...existing.keywords, ...incoming.keywords },
  };
}

/**
 * The `attachment` data a card's clauses added up to, or `undefined`.
 *
 * A modification with no "Enchant …"/"Equip {N}" line is deliberately REFUSED
 * (returns `undefined`, and the caller reports the clause): "Enchanted creature
 * gets +2/+0" alone tells us what the card does but nothing about how it ever
 * becomes attached, and compiling it would produce a permanent that sits on the
 * battlefield doing nothing — precisely the "looks implemented, isn't" failure the
 * compiler exists to prevent.
 */
function assembleAttachment(assembly: Assembly): AttachmentSpec | undefined {
  if (!assembly.attachesAs) return undefined;
  return {
    ...assembly.attachesAs,
    ...(assembly.attachmentModifies ? { modifies: assembly.attachmentModifies } : {}),
  };
}

/**
 * Compile an activated ability line — the printed `COST: EFFECT` shape.
 *
 * The cost half is parsed here (it is a small closed vocabulary of symbols and
 * stock phrases), while the effect half goes through the ordinary effect rules,
 * so an activated ability can only do things the engine already implements. If
 * either half is not fully understood the whole line is left unmatched and gets
 * reported in `missing` — the compiler never ships an ability with a cost it
 * silently dropped, which would make the card strictly better than printed.
 *
 * Returns true when the line was consumed.
 */
function compileActivatedAbility(clause: string, assembly: Assembly, ctx: RuleContext): boolean {
  const split = splitCostAndEffect(clause);
  if (!split) return false;

  const cost = parseActivationCost(split.cost, ctx);
  if (!cost) return false;

  const effects = ctx.compileEffectClause(split.effect);
  if (!effects || effects.length === 0) return false;

  assembly.activated.push({
    cost,
    effects,
    // Printed activated abilities are instant-speed unless they say otherwise;
    // "activate only as a sorcery" is caught by the cost parser refusing the
    // line, so anything reaching here is genuinely instant-speed.
    label: capitalizeFirst(split.raw),
  });
  assembly.matchedRules.push('activated-ability');
  return true;
}

/**
 * Split `COST: EFFECT` on the FIRST colon, rejecting lines whose colon is not an
 * activation cost separator (a loyalty ability's `+2:`, a reminder-text colon).
 */
function splitCostAndEffect(
  clause: string,
): { cost: string; effect: string; raw: string } | null {
  const colon = clause.indexOf(':');
  if (colon <= 0) return null;
  const cost = clause.slice(0, colon).trim();
  const effect = clause.slice(colon + 1).trim();
  if (cost.length === 0 || effect.length === 0) return null;
  // Planeswalker loyalty costs are their own system and must stay reported.
  if (/^[+−-]?\d+$/.test(cost)) return null;
  return { cost, effect, raw: clause };
}

/** A cost component the parser understands, as printed. */
const TAP_SYMBOL = '{t}';
/** "Pay N life" / "pay 1 life". */
const PAY_LIFE = /^pay (\d+) life$/;
/** "Sacrifice ~" — only sacrificing the ability's own source is supported. */
const SACRIFICE_SELF = /^sacrifice ~$/;
/** A mana symbol run, e.g. `{1}{g}` or `{u}`. */
const MANA_SYMBOLS = /^(?:\{[^}]+\})+$/;

/**
 * Parse an activation cost into the engine's `ActivationCost`, or `null` when
 * any component is one we cannot pay faithfully.
 */
function parseActivationCost(text: string, ctx: RuleContext): ActivationCost | null {
  const cost: {
    mana?: ManaCost;
    tap?: boolean;
    sacrificeSelf?: boolean;
    life?: number;
  } = {};

  for (const partRaw of text.split(',')) {
    const part = partRaw.trim();
    if (part.length === 0) continue;

    if (part === TAP_SYMBOL) {
      cost.tap = true;
      continue;
    }
    const life = PAY_LIFE.exec(part);
    if (life) {
      cost.life = Number.parseInt(life[1]!, 10);
      continue;
    }
    if (SACRIFICE_SELF.test(part) || part === `sacrifice ${ctx.card.name.toLowerCase()}`) {
      cost.sacrificeSelf = true;
      continue;
    }
    if (MANA_SYMBOLS.test(part)) {
      const mana = parseManaSymbols(part);
      if (!mana) return null; // a symbol we cannot pay (hybrid, {X}, Phyrexian)
      cost.mana = mana;
      continue;
    }
    return null; // an unrecognised cost component — report the whole line
  }

  return Object.keys(cost).length > 0 ? (cost as ActivationCost) : null;
}

/** Capitalize the first character, for a readable ability label. */
function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
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

  // An activated ability: "COST: EFFECT". Handled before the effect rules so the
  // cost is never mistaken for part of the effect text.
  if (compileActivatedAbility(clause, assembly, ctx)) return;

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
    producesOptions: [],
    activated: [],
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
    compileEffectClause(
      text: string,
      options?: { readonly targetFree?: boolean },
    ): readonly EffectRef[] | null {
      const targetFree = options?.targetFree === true;
      const clause = normalizeClause(text);
      const whole = applyRules(EFFECT_RULES, clause, ctx, targetFree);
      if (whole) return whole.contribution.effects ?? [];
      // A multi-sentence trigger body: every sentence must compile.
      const sentences = splitSentences(text).map(normalizeClause);
      if (sentences.length > 1) {
        const refs: EffectRef[] = [];
        for (const sentence of sentences) {
          const result = applyRules(EFFECT_RULES, sentence, ctx, targetFree);
          if (!result) return null;
          refs.push(...(result.contribution.effects ?? []));
        }
        return refs;
      }
      return null;
    },
    compileTriggerBody(text: string): TriggerBodyResult | null {
      // Compiled WITH targeting allowed (core aims a trigger as it goes on the
      // stack now), so what this has to work out is what may be aimed at.
      const clauses = [normalizeClause(text)];
      const whole = applyRules(EFFECT_RULES, clauses[0]!, ctx);
      const matched = whole ? [whole] : null;
      const parts =
        matched ??
        (() => {
          const sentences = splitSentences(text).map(normalizeClause);
          if (sentences.length <= 1) return null;
          const out: NonNullable<ReturnType<typeof applyRules>>[] = [];
          for (const sentence of sentences) {
            const result = applyRules(EFFECT_RULES, sentence, ctx);
            if (!result) return null;
            out.push(result);
          }
          return out;
        })();
      if (!parts) return null;

      const refs: EffectRef[] = [];
      let restriction: TargetRestriction | undefined;
      let targetingParts = 0;
      for (const part of parts) {
        const partEffects = part.contribution.effects ?? [];
        refs.push(...partEffects);
        if (!ruleNeedsChosenTarget(part.ruleId)) continue;
        targetingParts += 1;
        // `restrictionOfEffects` deliberately reports nothing for the default
        // "any target" (core does not police it), but a trigger still has to be
        // AIMED at something — so the default is what "any target" means.
        restriction = restrictionOfEffects(partEffects) ?? DEFAULT_TARGET_RESTRICTION;
      }
      // Two targets in one trigger is a template of its own; refusing keeps the
      // card reported rather than silently aiming both halves at one object.
      if (targetingParts > 1) return null;
      if (refs.length === 0) return null;
      return restriction === undefined ? { effects: refs } : { effects: refs, targets: restriction };
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
    // "Enchant" and "Equip" are Scryfall's names for the attachment ability the
    // card's own printed line already compiled (see `assembleAttachment`). Without
    // this, every Aura and Equipment would report its central ability as missing
    // one line after implementing it.
    if (ATTACHMENT_KEYWORDS.has(word) && assembly.attachesAs !== undefined) continue;
    if (!assembly.missing.some((m) => m.text.toLowerCase().includes(word))) {
      assembly.missing.push({
        text: keyword,
        missingEngineSystem: `the "${keyword}" keyword ability`,
      });
    }
  }

  // --- attachments -----------------------------------------------------------
  const attachment = assembleAttachment(assembly);
  if (attachment === undefined && assembly.attachmentModifies !== undefined) {
    assembly.missing.push({
      text: 'enchanted/equipped creature gets …',
      missingEngineSystem: 'auras and equipment attachment (no "Enchant …" or "Equip {N}" line to attach it)',
    });
  }

  // --- assemble --------------------------------------------------------------
  // Mana production has two authoring forms and a card uses exactly one of them:
  // a fixed bundle (`produces`, one tap adds all of it) or a list of modes
  // (`producesOptions`, one tap adds one). A card printing BOTH shapes has two
  // mana abilities, and since it can only be tapped once they are simply more
  // modes of the same choice — so the bundle folds in as one extra mode.
  const manaModes: readonly ManaProduction[] =
    assembly.producesOptions.length > 0
      ? [
          ...(assembly.produces.length > 0 ? [bundleAsMode(assembly.produces)] : []),
          ...assembly.producesOptions,
        ]
      : [];

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
    // Printed subtypes, lowercased, so subtype-selecting effects ("a Mountain
    // or Plains card") match a dual land the way the printed card does.
    ...(card.typeLine.subtypes.length > 0
      ? { subtypes: card.typeLine.subtypes.map((subtype) => subtype.toLowerCase()) }
      : {}),
    ...(assembly.entersTapped ? { entersTapped: true } : {}),
    ...(assembly.entersTappedUnless ? { entersTappedUnless: assembly.entersTappedUnless } : {}),
    ...(assembly.effects.length > 0 ? { effects: assembly.effects } : {}),
    ...(manaModes.length > 0
      ? { producesOptions: manaModes }
      : assembly.produces.length > 0
        ? { produces: assembly.produces }
        : {}),
    ...(assembly.triggers.length > 0 ? { triggers: assembly.triggers } : {}),
    ...(assembly.activated.length > 0 ? { activated: assembly.activated } : {}),
    ...(attachment ? { attachment } : {}),
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
