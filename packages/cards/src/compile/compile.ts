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
  ABILITY_WORDS,
  explainUnsupported,
  isVacuousClause,
  parseProtectionOrWard,
} from './rules.js';
import { mergeKeywordGrant } from '@jonny-boi/core';
import type { KeywordFlags } from '@jonny-boi/core';
import { frontFaceName, normalizeClause, parseManaSymbols, prepareOracle, splitSentences } from './text.js';

/**
 * Scryfall's keyword names for the two printed attachment abilities. They are
 * modelled by the rule table (`enchant-permanent` / `equip-cost`) rather than by a
 * keyword flag, so the keyword sweep must not report them a second time.
 */
const ATTACHMENT_KEYWORDS: ReadonlySet<string> = new Set(['enchant', 'equip']);

/**
 * Scryfall keywords that this compiler models as effect PRIMITIVES matched by the
 * rule table rather than as keyword flags or dedicated assembly fields.
 *
 * Scry, Surveil and Mill each compile from their printed line (`scry-n`,
 * `surveil-n`, `scry-then-effect`, `self-mill`, `target-player-mills`) into an
 * `EffectRef` whose `primitive` is the name below. The keyword sweep therefore has
 * to look at the compiled OUTPUT to decide whether the line was implemented — the
 * same question `flashback`/`kicker` answer with a single assembly field.
 *
 * The guard is deliberately evidence-based, not a blanket skip: a wording the rule
 * table does NOT match (a derived or conditional count, "look at the top N …")
 * produces no such primitive, so that card still reports honestly.
 */
const PRIMITIVE_BACKED_KEYWORDS: Readonly<Record<string, string>> = Object.freeze({
  scry: 'scry',
  surveil: 'surveil',
  mill: 'mill',
});

/**
 * Every effect-primitive name reachable in a compiled assembly.
 *
 * Primitives nest: a scry can sit inside a triggered ability's effect list (the
 * Theros temples), inside an activated ability (Castle Vantress), or inside another
 * primitive's params (`scry-then-effect`, the "you may" wrappers). A shallow look at
 * `assembly.effects` would miss all three and report the keyword anyway, so the walk
 * is a deep one over the assembled data.
 */
function compiledPrimitives(assembly: Assembly): ReadonlySet<string> {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.primitive === 'string') found.add(record.primitive);
    for (const value of Object.values(record)) visit(value);
  };
  visit(assembly.effects);
  visit(assembly.triggers);
  visit(assembly.activated);
  visit(assembly.statics);
  return found;
}

/** Scryfall card types → the core `CardType`s the engine understands. */
const TYPE_MAP: Readonly<Record<string, CardType>> = Object.freeze({
  land: 'land',
  creature: 'creature',
  instant: 'instant',
  sorcery: 'sorcery',
  artifact: 'artifact',
  enchantment: 'enchantment',
  planeswalker: 'planeswalker',
  battle: 'battle',
});

/**
 * Card types the engine has no system for, with the reason. Exported so the
 * About view's TODO list can name these gaps from the same record the compiler
 * judges by.
 *
 * The record is EMPTY, and that is the honest state of the world: every printed
 * card type the engine can meet now has a system behind it. `planeswalker` left
 * when loyalty landed; `battle` left when battles did — a battle enters with its
 * printed defense counters, is attacked through the same attackable-object seam
 * as a walker, loses defense to combat and to burn, and is put into its owner's
 * graveyard by a state-based action at zero.
 *
 * ⚠️ A battle CARD is still usually reported, and by design: every printed battle
 * is a Siege, whose reward is casting its BACK FACE, and that needs the
 * castable-second-face system (`SECOND_CASTABLE_FACE_GAP`). The subsystem being
 * complete is not the same claim as the cards being playable, and the compiler
 * says so per card rather than letting a type-level "supported" imply it.
 */
export const TYPES_WITHOUT_SYSTEM: Readonly<Record<string, string>> = Object.freeze({});

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

/** Split `other` cost symbols into payable hybrids, `{X}` symbols, and genuinely unpayable ones. */
function partitionOtherSymbols(symbols: readonly string[]): {
  hybrid: ManaColor[][];
  /** How many `{X}` symbols the cost prints — payable now (chosen at cast time). */
  xCount: number;
  unpayable: string[];
} {
  const hybrid: ManaColor[][] = [];
  const unpayable: string[] = [];
  let xCount = 0;
  for (const symbol of symbols) {
    // Canonical `other` entries are brace-free ('X', 'G/W'), but a hand-built
    // record may carry the printed form ('{X}') — fold both to one shape.
    const upper = symbol.replace(/[{}]/g, '').toUpperCase();
    if (upper === 'X') {
      xCount += 1;
      continue;
    }
    const match = HYBRID_SYMBOL.exec(upper);
    if (match) hybrid.push([match[1] as ManaColor, match[2] as ManaColor]);
    else unpayable.push(symbol);
  }
  return { hybrid, xCount, unpayable };
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
  /** Mana abilities that print a cost, a rider, a restriction or derived colours. */
  readonly manaAbilities: import('@jonny-boi/core').ManaAbility[];
  readonly activated: ActivatedAbility[];
  readonly statics: import('@jonny-boi/core').StaticAbility[];
  keywords: KeywordFlags;
  entersTapped: boolean;
  entersTappedUnless?: import('@jonny-boi/core').EntersUntappedCondition;
  entersTappedUnlessLifePaid?: number;
  entersTappedUnlessRevealed?: import('@jonny-boi/core').RevealFromHandCondition;
  /** The printed "Kicker {COST}", once some line prints it. */
  kicker?: ManaCost;
  /** The printed "Multikicker {COST}" — an additional cost paid any number of times. */
  multikicker?: ManaCost;
  /** The printed modal header + modes ("Choose one — • … • …"). */
  modal?: import('@jonny-boi/core').ModalSpec;
  /** The printed flashback cost, once a "Flashback {…}" line compiles. */
  flashback?: ManaCost;
  /** How many {X} symbols the flashback cost prints. */
  flashbackXCost?: number;
  /** The "Pay N life" rider on a flashback cost. */
  flashbackLifeCost?: number;
  /** Cycling abilities, accumulated — a card may print cycling AND landcycling. */
  readonly cycling: import('@jonny-boi/core').CyclingAbility[];
  /** The printed buyback cost, once a "Buyback {…}" line compiles. */
  buyback?: ManaCost;
  /** The printed madness cost, once a "Madness {…}" line compiles. */
  madness?: ManaCost;
  /** The formula behind a `*` P/T box, once a line compiles one. */
  characteristicPT?: import('@jonny-boi/core').CharacteristicPT;
  /** The "Enchant …" / "Equip {N}" half of an attachment, once some line prints it. */
  attachesAs?: ClauseContribution['attachesAs'];
  /** The "Enchanted/Equipped creature gets …" half, accumulated across lines. */
  attachmentModifies?: PermanentModification;
  /** Set once a line prints the keyword **Changeling**. */
  changeling?: boolean;
  /** Set once a line prints "This spell can't be countered". */
  cantBeCountered?: boolean;
  /** Set once a line prints "Spells [you control] can't be countered". */
  spellsCantBeCountered?: import('@jonny-boi/core').UncounterableSpellsAbility;
  /** Set once a line prints "You have no maximum hand size". */
  noMaximumHandSize?: boolean;
  /** Land-play zones this card unlocks, accumulated across lines. */
  playLandsFrom?: import('@jonny-boi/core').LandPlayZone[];
  readonly matchedRules: string[];
  readonly missing: UnsupportedClause[];
}

/**
 * Whether a Scryfall keyword name is a CYCLING one. Matched by suffix rather
 * than against a list, because Scryfall names the typed variants BOTH generically
 * ("Typecycling") and by the printed word ("Plainscycling", "Islandcycling",
 * "Landcycling") — and a list would have to enumerate every land, creature and
 * artifact type that has ever been printed with the word attached. All of them
 * compile to the same `CardDefinition.cycling` list, so all of them are answered
 * by the same guard.
 */
function isCyclingKeyword(word: string): boolean {
  return word === 'cycling' || word.endsWith('cycling');
}

/** Merge one clause contribution into the assembly. */
function absorb(assembly: Assembly, contribution: ClauseContribution, ruleId: string): void {
  if (contribution.effects) assembly.effects.push(...contribution.effects);
  if (contribution.triggers) assembly.triggers.push(...contribution.triggers);
  if (contribution.produces) assembly.produces.push(...contribution.produces);
  if (contribution.producesOptions) assembly.producesOptions.push(...contribution.producesOptions);
  if (contribution.manaAbilities) assembly.manaAbilities.push(...contribution.manaAbilities);
  if (contribution.keywords) {
    // Folded by the same merge rule the engine layers with: boolean flags OR,
    // protection lists UNION, ward costs ADD (`mergeKeywordGrant`).
    assembly.keywords = mergeKeywordGrant(assembly.keywords, contribution.keywords);
  }
  if (contribution.activated) assembly.activated.push(...contribution.activated);
  if (contribution.statics) assembly.statics.push(...contribution.statics);
  if (contribution.entersTapped) assembly.entersTapped = true;
  if (contribution.entersTappedUnless) assembly.entersTappedUnless = contribution.entersTappedUnless;
  if (contribution.entersTappedUnlessLifePaid !== undefined) {
    assembly.entersTappedUnlessLifePaid = contribution.entersTappedUnlessLifePaid;
  }
  if (contribution.entersTappedUnlessRevealed !== undefined) {
    assembly.entersTappedUnlessRevealed = contribution.entersTappedUnlessRevealed;
  }
  if (contribution.kicker) assembly.kicker = contribution.kicker;
  if (contribution.multikicker) assembly.multikicker = contribution.multikicker;
  if (contribution.modal) assembly.modal = contribution.modal;
  if (contribution.cycling) assembly.cycling.push(...contribution.cycling);
  if (contribution.buyback) assembly.buyback = contribution.buyback;
  if (contribution.madness) assembly.madness = contribution.madness;
  if (contribution.characteristicPT) assembly.characteristicPT = contribution.characteristicPT;
  if (contribution.flashback !== undefined) assembly.flashback = contribution.flashback;
  if (contribution.flashbackXCost !== undefined) assembly.flashbackXCost = contribution.flashbackXCost;
  if (contribution.flashbackLifeCost !== undefined) {
    assembly.flashbackLifeCost = contribution.flashbackLifeCost;
  }
  if (contribution.changeling) assembly.changeling = true;
  if (contribution.cantBeCountered) assembly.cantBeCountered = true;
  if (contribution.spellsCantBeCountered) assembly.spellsCantBeCountered = contribution.spellsCantBeCountered;
  if (contribution.noMaximumHandSize) assembly.noMaximumHandSize = true;
  if (contribution.playLandsFrom) {
    // Accumulated, not replaced: Bolas's Citadel prints one zone and a second
    // line could print another, and both permissions are real at once.
    const zones = assembly.playLandsFrom ?? (assembly.playLandsFrom = []);
    for (const zone of contribution.playLandsFrom) if (!zones.includes(zone)) zones.push(zone);
  }
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

/**
 * A planeswalker loyalty-ability line: `+1: BODY`, `−2: BODY`, `0: BODY`. The
 * printed minus is U+2212 (`−`); a plain hyphen is accepted for hand-typed text.
 */
const LOYALTY_LINE = /^([+−-]?\d+): (.+)$/;

/**
 * Compile a loyalty ability into an activated ability with a SIGNED loyalty
 * cost, sorcery-speed — which, with the engine's once-per-turn rule keyed on the
 * cost kind, is exactly what CR 606 makes a loyalty ability. The body goes
 * through the ordinary effect rules (targets and questions included), so a
 * walker can only print abilities the engine genuinely runs; any body without a
 * faithful implementation leaves the line unmatched and reported.
 *
 * Only planeswalkers get this reading: on anything else a leading `+2:` is not
 * a loyalty cost, and the line falls through to the normal tables. Returns true
 * when the line was consumed.
 */
function compileLoyaltyAbility(clause: string, assembly: Assembly, ctx: RuleContext): boolean {
  if (!ctx.card.typeLine.types.some((printed) => printed.toLowerCase() === 'planeswalker')) return false;
  const match = LOYALTY_LINE.exec(clause);
  if (!match) return false;
  const value = Number.parseInt(match[1]!.replace('−', '-'), 10);
  if (!Number.isFinite(value)) return false;
  const effects = ctx.compileEffectClause(match[2]!);
  if (!effects || effects.length === 0) return false;
  assembly.activated.push({
    cost: { loyalty: value },
    effects,
    timing: 'sorcery',
    label: capitalizeFirst(clause),
  });
  assembly.matchedRules.push('loyalty-ability');
  return true;
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

  let flags: KeywordFlags = {};
  for (const word of words) {
    const field = KEYWORD_FLAGS[word];
    if (field) {
      flags = mergeKeywordGrant(flags, { [field]: true });
      continue;
    }
    // The two payload keywords - `Ward {N}` and `Protection from ...` - are not
    // boolean flags, so they parse through their own closed tables. A form
    // outside them ("Ward-Pay 3 life") falls through and reports the line.
    const special = parseProtectionOrWard(word);
    if (special) {
      flags = mergeKeywordGrant(flags, special);
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
    assembly.keywords = mergeKeywordGrant(assembly.keywords, flags);
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

  // A planeswalker's loyalty ability: "+1: EFFECT" / "−2: EFFECT". Tried before
  // the generic activated-ability parser, whose cost vocabulary deliberately
  // refuses a bare number.
  if (compileLoyaltyAbility(clause, assembly, ctx)) return;

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
  // A TRANSFORMING double-faced card is compiled as two linked faces — see
  // `compileTransformDfc`. Detected by Scryfall's `layout` when the record
  // carries it, else by the `Transform` keyword Scryfall stamps on every
  // transforming DFC (the committed index predates the layout field). Other
  // multi-faced layouts (modal DFC, split, adventure) fall through: their
  // second face is CASTABLE, which needs the cast-time face choice the engine
  // does not have, and they are reported as exactly that below.
  if (isTransformDfc(card)) return compileTransformDfc(card);
  // A MODAL double-faced card is compiled as two linked faces too, but with the
  // opposite castability rule: BOTH halves are cast (or played) from hand, each
  // for its own cost. That is `backFaceCastable`, and it is the whole
  // difference between the two DFC layouts.
  if (isModalDfc(card)) return compileModalDfc(card);

  const assembly: Assembly = {
    effects: [],
    triggers: [],
    produces: [],
    producesOptions: [],
    manaAbilities: [],
    activated: [],
    statics: [],
    keywords: {},
    cycling: [],
    entersTapped: false,
    matchedRules: [],
    missing: [],
  };

  // --- type line -------------------------------------------------------------
  // SUPERTYPES were parsed but never read until the legend rule needed one.
  // Two of them now carry engine meaning: **Legendary** (CR 704.5j) and
  // **Basic**, which the battlelands' "unless you control two or more basic
  // lands" counts and which no other characteristic can answer (a nonbasic dual
  // prints the same land subtypes as two basics). "Snow" still has none — no
  // card in reach cares — so it is ignored rather than reported, which changes
  // nothing a game could observe.
  const supertypes = card.typeLine.supertypes.map((printed) => printed.toLowerCase());
  const isLegendary = supertypes.includes('legendary');
  const isBasic = supertypes.includes('basic');
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

  // A multi-faced card that is neither a transforming DFC nor a modal DFC still
  // reports. Modal DFCs are cast outright as either face (`backFaceCastable`),
  // and that is exactly what these are NOT: a SPLIT card is one object with two
  // costs, an ADVENTURE exiles itself and is cast again later from exile, and a
  // SIEGE's back face becomes castable only once the battle is defeated. Each
  // needs a cast path of its own, so none is expressible as the front/back pair
  // the face system models. They stay reported rather than being played as their
  // first half only, which would be a strictly weaker card than printed.
  if (card.name.includes(' // ')) {
    assembly.missing.push({
      text: card.name,
      missingEngineSystem: SECOND_CASTABLE_FACE_GAP,
    });
  }

  // --- mana cost -------------------------------------------------------------
  // Colour/colour hybrid symbols are payable (the mana system tries each
  // assignment) and `{X}` is payable now too — its value is a cast-time choice
  // the engine charges (`CardDefinition.xCost`). What remains in `other` —
  // Phyrexian, monocolour hybrid, snow — genuinely cannot be paid, and a card
  // we would mis-cost is never complete.
  const { hybrid, xCount, unpayable } = partitionOtherSymbols(card.manaCost.other);
  if (unpayable.length > 0) {
    assembly.missing.push({
      text: unpayable.map((symbol) => `{${symbol}}`).join(''),
      missingEngineSystem: 'Phyrexian and monocolour hybrid mana costs',
    });
  }
  const cost = toCoreCost(card, hybrid);

  const isCreatureCard = types.includes('creature');

  // --- planeswalkers: printed starting loyalty --------------------------------
  // A walker without a usable loyalty number cannot enter at the right value, so
  // it is never complete — whether the printed box is variable (`X`, parsed to
  // null) or the record simply predates loyalty capture in the data pipeline.
  const isWalkerCard = types.includes('planeswalker');
  const printedLoyalty =
    typeof card.loyalty === 'number' && Number.isFinite(card.loyalty) && card.loyalty > 0
      ? card.loyalty
      : undefined;
  if (isWalkerCard && printedLoyalty === undefined) {
    assembly.missing.push({
      text: 'loyalty',
      missingEngineSystem:
        'a printed starting-loyalty number in the card record (variable/X loyalty, or a cached record from before loyalty was captured)',
    });
  }

  // --- battles: printed starting defense --------------------------------------
  // The same contract, for the same reason: a battle that entered with the wrong
  // number of defense counters would take the wrong number of attacks to defeat,
  // which is a different card. No number in the record ⇒ reported, never guessed.
  const isBattleCard = types.includes('battle');
  const printedDefense =
    typeof card.defense === 'number' && Number.isFinite(card.defense) && card.defense > 0
      ? card.defense
      : undefined;
  if (isBattleCard && printedDefense === undefined) {
    assembly.missing.push({
      text: 'defense',
      missingEngineSystem:
        'a printed starting-defense number in the card record (variable defense, or a cached record from before defense was captured)',
    });
  }

  // --- lands: basic land types produce their mana without any printed text ----
  //
  // Rule 305.6: EACH basic land type is its own "{T}: Add {X}" ability, so a
  // land with two of them (a shockland's Swamp Mountain, a true dual) offers a
  // CHOICE of one mana per tap — `producesOptions` — not a bundle. Pushing both
  // into `produces` would make one tap add both colours, the exact "Birds taps
  // for five" bug the compiler was built to refuse. A single basic type stays
  // the plain fixed bundle it always was.
  {
    const landColors: ManaColor[] = [];
    for (const subtype of card.typeLine.subtypes) {
      const color = LAND_SUBTYPE_MANA[subtype.toLowerCase()];
      if (color && types.includes('land')) {
        landColors.push(color);
        assembly.matchedRules.push('basic-land-type');
      }
    }
    if (landColors.length === 1) assembly.produces.push(landColors[0]!);
    else if (landColors.length > 1) {
      assembly.producesOptions.push(...landColors.map((color) => ({ [color]: 1 }) as ManaProduction));
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

  // --- power / toughness -----------------------------------------------------
  // Checked AFTER the ability lines, because the answer depends on them: a `*`
  // box (Scryfall parses it to null) is faithful exactly when some line
  // compiled the FORMULA that defines it. The blanket refusal this replaces
  // reported every such card; the refusal itself is kept for every card whose
  // defining sentence the rule table cannot express, which is the honest half —
  // a formula we cannot reproduce must be named, never approximated.
  if (isCreatureCard && (card.power === null || card.toughness === null)) {
    if (assembly.characteristicPT === undefined) {
      assembly.missing.push({
        text: 'power/toughness',
        missingEngineSystem:
          'a characteristic-defining P/T formula the compiler does not recognize yet (the star box is supported; this card defines it by a rule outside the closed count vocabulary)',
      });
    }
  } else if (assembly.characteristicPT !== undefined) {
    // A card printing NUMBERS and a defining sentence would be two answers to
    // one question. No real card does it; refusing keeps the invariant that
    // `characteristicPT` and printed P/T never coexist.
    assembly.missing.push({
      text: 'power/toughness',
      missingEngineSystem: 'a card printing both a fixed P/T and a characteristic-defining formula',
    });
  }

  // --- keyword flags printed on the type line but not in the text ------------
  // Scryfall lists a card's keywords separately; anything it lists that we did
  // not already pick up from the text must still be modelled or reported.
  const primitivesCompiled = compiledPrimitives(assembly);
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
    // Scryfall lists ward and protection by their bare names; the printed line
    // carries the payload ("Ward {2}", "Protection from red") and has already
    // compiled it into the keyword fields - or already reported the line, in
    // which case the missing-scan below still refuses a duplicate entry.
    if (word === 'ward' && assembly.keywords.ward !== undefined) continue;
    if (word === 'protection' && assembly.keywords.protectionFrom !== undefined) continue;
    // "Enchant" and "Equip" are Scryfall's names for the attachment ability the
    // card's own printed line already compiled (see `assembleAttachment`). Without
    // this, every Aura and Equipment would report its central ability as missing
    // one line after implementing it.
    if (ATTACHMENT_KEYWORDS.has(word) && assembly.attachesAs !== undefined) continue;
    // Same story for "Kicker": Scryfall lists it as a keyword, and the printed
    // "Kicker {COST}" line has already compiled into `CardDefinition.kicker`.
    if (word === 'kicker' && assembly.kicker !== undefined) continue;
    // Scryfall lists BOTH "Kicker" and "Multikicker" on a multikicker card (the
    // mechanic is a kicker), so a compiled multikicker answers for either name.
    if ((word === 'multikicker' || word === 'kicker') && assembly.multikicker !== undefined) continue;
    // "Modal" is not printed as an ability — it is the shape of the card, and
    // the "Choose one —" line has already compiled into `assembly.modal`.
    if (word === 'modal' && assembly.modal !== undefined) continue;
    // Same shape for "Flashback": the printed "Flashback {…}" line compiled into
    // `assembly.flashback`, and Scryfall listing the keyword again is not a
    // second, unmodelled ability. A flashback line that did NOT compile (an {X}
    // or additional-cost form) leaves `flashback` unset, so the keyword still
    // reports through the line's own `missing` entry.
    if (word === 'flashback' && assembly.flashback !== undefined) continue;
    // Scry / Surveil / Mill: modelled as effect primitives, so the evidence that
    // the printed line compiled is the primitive's presence in the assembled card
    // rather than a dedicated field. Same contract as the guards above — skip the
    // sweep entry ONLY when the line really was implemented; a wording the rules do
    // not match compiles no primitive and still reports through its own `missing`
    // entry (the scry/mill template hints).
    const backingPrimitive = PRIMITIVE_BACKED_KEYWORDS[word];
    if (backingPrimitive !== undefined && primitivesCompiled.has(backingPrimitive)) continue;
    // Cycling and its typed variants: Scryfall lists "Cycling", "Typecycling"
    // and "Landcycling" as keywords, and the printed line has already compiled
    // into `assembly.cycling`. A cycling line that did NOT compile (an {X}
    // cycling cost, a cycling word this engine cannot search for) leaves the
    // list empty for that line, so the keyword still reports through the line's
    // own `missing` entry — which is why this is keyed on the list, not on the
    // keyword's presence.
    if (isCyclingKeyword(word) && assembly.cycling.length > 0) continue;
    if (word === 'buyback' && assembly.buyback !== undefined) continue;
    if (word === 'madness' && assembly.madness !== undefined) continue;
    // An ABILITY WORD (Revolt, Morbid, …) is a label, not an ability — CR
    // 207.2c. It is skipped only when the line it labels actually compiled;
    // a line that failed put its own text (word included) into `missing`, so
    // the card still reports through that entry.
    if (
      ABILITY_WORDS.has(word) &&
      !assembly.missing.some((entry) => entry.text.toLowerCase().includes(word))
    ) {
      continue;
    }
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

  // A card that prints a RICH mana ability (a cost, a rider, an "Activate only
  // if …", derived colours) emits `manaAbilities` and NOTHING ELSE — core treats
  // that field as superseding both shorthands, so a plain line on the same card
  // ("{T}: Add {C}" on a pain land, the basic land types on a filter land) has to
  // come along as one more entry or it would vanish. It leads the list because it
  // is printed first on every real card of this shape.
  const richManaAbilities: readonly import('@jonny-boi/core').ManaAbility[] =
    assembly.manaAbilities.length > 0
      ? [
          ...(manaModes.length > 0
            ? [{ produces: manaModes }]
            : assembly.produces.length > 0
              ? [{ produces: [bundleAsMode(assembly.produces)] }]
              : []),
          ...assembly.manaAbilities,
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
    // A `*` box: the FORMULA replaces the numbers (never both — refused above).
    ...(assembly.characteristicPT ? { characteristicPT: assembly.characteristicPT } : {}),
    ...(isWalkerCard && printedLoyalty !== undefined ? { loyalty: printedLoyalty } : {}),
    ...(isBattleCard && printedDefense !== undefined ? { defense: printedDefense } : {}),
    // The printed **Legendary** supertype, carried because the legend rule
    // (CR 704.5j) is keyed on exactly this — it is not decoration. Read from the
    // supertype list rather than from the raw type line so a card whose name
    // happens to contain the word is not mistaken for one.
    ...(isLegendary ? { legendary: true } : {}),
    // The printed **Basic** supertype — read by the battlelands' enters-untapped
    // condition (see `EntersUntappedCondition.minBasicLands`).
    ...(isBasic ? { basic: true } : {}),
    // Changeling is a characteristic-defining ability that applies in EVERY zone,
    // so it rides the definition rather than the keyword-flag bag.
    ...(assembly.changeling ? { changeling: true } : {}),
    ...(assembly.cantBeCountered ? { cantBeCountered: true } : {}),
    ...(assembly.spellsCantBeCountered ? { spellsCantBeCountered: assembly.spellsCantBeCountered } : {}),
    ...(assembly.noMaximumHandSize ? { noMaximumHandSize: true } : {}),
    ...(assembly.playLandsFrom && assembly.playLandsFrom.length > 0
      ? { playLandsFrom: assembly.playLandsFrom }
      : {}),
    ...(Object.keys(assembly.keywords).length > 0 ? { keywords: assembly.keywords } : {}),
    // Printed subtypes, lowercased, so subtype-selecting effects ("a Mountain
    // or Plains card") match a dual land the way the printed card does.
    ...(card.typeLine.subtypes.length > 0
      ? { subtypes: card.typeLine.subtypes.map((subtype) => subtype.toLowerCase()) }
      : {}),
    ...(assembly.entersTapped ? { entersTapped: true } : {}),
    ...(assembly.entersTappedUnless ? { entersTappedUnless: assembly.entersTappedUnless } : {}),
    ...(assembly.entersTappedUnlessRevealed !== undefined
      ? { entersTappedUnlessRevealed: assembly.entersTappedUnlessRevealed }
      : {}),
    ...(assembly.entersTappedUnlessLifePaid !== undefined
      ? { entersTappedUnlessLifePaid: assembly.entersTappedUnlessLifePaid }
      : {}),
    ...(xCount > 0 ? { xCost: xCount } : {}),
    ...(assembly.kicker ? { kicker: assembly.kicker } : {}),
    ...(assembly.multikicker ? { multikicker: assembly.multikicker } : {}),
    ...(assembly.modal ? { modal: assembly.modal } : {}),
    ...(assembly.cycling.length > 0 ? { cycling: assembly.cycling } : {}),
    ...(assembly.buyback ? { buyback: assembly.buyback } : {}),
    ...(assembly.madness ? { madness: assembly.madness } : {}),
    ...(assembly.flashback !== undefined ? { flashback: assembly.flashback } : {}),
    ...(assembly.flashbackXCost !== undefined ? { flashbackXCost: assembly.flashbackXCost } : {}),
    ...(assembly.flashbackLifeCost !== undefined
      ? { flashbackLifeCost: assembly.flashbackLifeCost }
      : {}),
    ...(assembly.effects.length > 0 ? { effects: assembly.effects } : {}),
    ...(richManaAbilities.length > 0
      ? { manaAbilities: richManaAbilities }
      : manaModes.length > 0
        ? { producesOptions: manaModes }
        : assembly.produces.length > 0
          ? { produces: assembly.produces }
          : {}),
    ...(assembly.triggers.length > 0 ? { triggers: assembly.triggers } : {}),
    ...(assembly.activated.length > 0 ? { activated: assembly.activated } : {}),
    ...(assembly.statics.length > 0 ? { statics: assembly.statics } : {}),
    ...(attachment ? { attachment } : {}),
  };

  return {
    status: assembly.missing.length === 0 ? 'complete' : 'incomplete',
    definition,
    matchedRules: assembly.matchedRules,
    missing: assembly.missing,
  };
}

// --- transforming double-faced cards ---------------------------------------------

/**
 * The gap a modal DFC / split / adventure card reports: its second face is
 * CASTABLE, and choosing which face to cast is a cast-time decision the engine
 * cannot ask yet (it belongs to the cast-cost/choice system, in progress on its
 * own branch). Named once so the report and the tests cannot drift.
 */
export const SECOND_CASTABLE_FACE_GAP =
  'casting the second half of a split, adventure or Siege card (a castable half reached by a cast path the engine does not have — unlike a modal DFC, whose two faces are both cast outright)';

/** The id suffix a compiled back-face definition carries (`<frontId>#back`). */
export const BACK_FACE_ID_SUFFIX = '#back';

/** Scryfall's layout value / keyword for Innistrad-style transforming DFCs. */
const TRANSFORM_LAYOUT = 'transform';
const TRANSFORM_KEYWORD = 'transform';

/** Scryfall's layout value for a Zendikar-Rising-style MODAL double-faced card. */
const MODAL_DFC_LAYOUT = 'modal_dfc';

/** The number of faces a transforming DFC prints — a front and a back. */
const DFC_FACE_COUNT = 2;

/**
 * Whether this record is a TRANSFORMING double-faced card (front castable, back
 * never castable, a transform instruction flips between them) — as opposed to a
 * modal DFC / split / adventure, whose second half is castable.
 */
function isTransformDfc(card: CompilableCard): boolean {
  if (!card.faces || card.faces.length !== DFC_FACE_COUNT) return false;
  if (card.layout !== undefined) return card.layout === TRANSFORM_LAYOUT;
  return card.keywords.some((keyword) => keyword.toLowerCase() === TRANSFORM_KEYWORD);
}

/**
 * Compile one face of a transforming DFC by wrapping it as an ordinary
 * single-faced record and running it through {@link compileCard} — the whole
 * rule table, the keyword sweep, the P/T checks, everything, applies to each
 * face with no second compiler.
 *
 * `keywords` is the subset of the card's Scryfall keywords attributable to this
 * face (see {@link compileTransformDfc} for how attribution works).
 */
function compileFace(
  face: NonNullable<CompilableCard['faces']>[number],
  id: string,
  keywords: readonly string[],
): CompileResult {
  return compileCard({
    id,
    name: face.name,
    manaCost: face.manaCost,
    typeLine: face.typeLine,
    oracleText: face.oracleText,
    power: face.power,
    toughness: face.toughness,
    keywords,
    // No `faces` on the wrapped record — each face is single-faced, which is
    // also what terminates the recursion.
  });
}

/**
 * Compile a transforming DFC: BOTH faces in full, linked as one definition.
 *
 * THE CONTRACT DOES NOT BEND HERE: the card is `'complete'` only when every
 * printed ability of BOTH faces compiled — a DFC whose back face is
 * half-modelled would sit on the battlefield playing wrong after the first
 * transform, which is worse than reporting it. The front face's definition
 * carries the back nested as `CardDefinition.backFace` (back marked
 * `isBackFace`, id `<frontId>#back` so the UI can look up per-face art); which
 * face is UP is per-permanent state owned by core (`transformPermanent`).
 *
 * Scryfall's card-level `keywords` list is the UNION of both faces' keywords
 * (Delver's says `Flying`, printed only on the back). Each keyword (minus
 * `Transform` itself, which is the machinery, not an ability) is attributed to
 * every face whose own oracle text prints it; one attributable to NEITHER face
 * is reported, never guessed onto a face.
 */
function compileTransformDfc(card: CompilableCard): CompileResult {
  const faces = card.faces as NonNullable<CompilableCard['faces']>;
  const [frontFace, backFace] = faces as [typeof faces[number], typeof faces[number]];

  const missing: UnsupportedClause[] = [];
  const keywordsFor = (face: typeof frontFace): string[] => {
    const text = face.oracleText.toLowerCase();
    return card.keywords.filter((keyword) => {
      const word = keyword.toLowerCase();
      return word !== TRANSFORM_KEYWORD && text.includes(word);
    });
  };
  for (const keyword of card.keywords) {
    const word = keyword.toLowerCase();
    if (word === TRANSFORM_KEYWORD) continue;
    const printedSomewhere = faces.some((face) => face.oracleText.toLowerCase().includes(word));
    if (!printedSomewhere) {
      missing.push({
        text: keyword,
        missingEngineSystem: `the "${keyword}" keyword ability (not attributable to either face's text)`,
      });
    }
  }

  const front = compileFace(frontFace, card.id, keywordsFor(frontFace));
  const back = compileFace(backFace, `${card.id}${BACK_FACE_ID_SUFFIX}`, keywordsFor(backFace));
  missing.push(...front.missing, ...back.missing);

  const definition: CardDefinition = {
    ...front.definition,
    backFace: { ...back.definition, isBackFace: true },
  };
  return {
    status: missing.length === 0 ? 'complete' : 'incomplete',
    definition,
    matchedRules: [...front.matchedRules, ...back.matchedRules, 'transforming-dfc'],
    missing,
  };
}

/**
 * Whether this record is a MODAL double-faced card — a card whose SECOND FACE
 * is castable (or playable, when it is a land), as opposed to a transforming
 * DFC whose back face is only ever reached by a transform instruction.
 *
 * Detected by Scryfall's `layout` alone, with no keyword fallback: modal DFCs
 * print no keyword that names the layout, and guessing one from a "//" name
 * would sweep in split and adventure cards, which are NOT two faces and must
 * keep reporting.
 */
function isModalDfc(card: CompilableCard): boolean {
  return card.layout === MODAL_DFC_LAYOUT && (card.faces?.length ?? 0) === DFC_FACE_COUNT;
}

/**
 * Compile a modal DFC: BOTH faces in full, linked as one definition whose back
 * face is marked CASTABLE.
 *
 * The contract does not bend here either — the card is `'complete'` only when
 * every printed ability of BOTH faces compiled. A modal DFC whose back half is
 * half-modelled would be a card whose value is precisely the choice between two
 * halves, one of which lies.
 *
 * Two things differ from `compileTransformDfc`, and both follow from the
 * layout: the back face is stamped `isBackFace` AND the front stamps
 * `backFaceCastable`, so core offers both halves at cast/play time; and each
 * face keeps its OWN mana cost (a transforming back face has none, because it
 * is never cast). Keyword attribution is shared with the transform path — a
 * keyword is attributed to every face whose own text prints it, never guessed.
 */
function compileModalDfc(card: CompilableCard): CompileResult {
  const faces = card.faces as NonNullable<CompilableCard['faces']>;
  const [frontFace, backFace] = faces as [typeof faces[number], typeof faces[number]];

  const missing: UnsupportedClause[] = [];
  for (const keyword of card.keywords) {
    const word = keyword.toLowerCase();
    if (!faces.some((face) => face.oracleText.toLowerCase().includes(word))) {
      missing.push({
        text: keyword,
        missingEngineSystem: `the "${keyword}" keyword ability (not attributable to either face's text)`,
      });
    }
  }
  const keywordsFor = (face: typeof frontFace): string[] =>
    card.keywords.filter((keyword) => face.oracleText.toLowerCase().includes(keyword.toLowerCase()));

  const front = compileFace(frontFace, card.id, keywordsFor(frontFace));
  const back = compileFace(backFace, `${card.id}${BACK_FACE_ID_SUFFIX}`, keywordsFor(backFace));
  missing.push(...front.missing, ...back.missing);

  const definition: CardDefinition = {
    ...front.definition,
    backFace: { ...back.definition, isBackFace: true },
    backFaceCastable: true,
  };
  return {
    status: missing.length === 0 ? 'complete' : 'incomplete',
    definition,
    matchedRules: [...front.matchedRules, ...back.matchedRules, 'modal-dfc'],
    missing,
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
