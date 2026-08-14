/**
 * The compiler's RULE TABLE — printed Oracle templates mapped to real engine
 * behavior, as DATA (DESIGN §1.1: adding coverage is a table edit, not an engine
 * change). Each rule owns one printed template and builds the effect refs /
 * triggers / mana production that faithfully implement it using the primitives
 * registered in `../primitives.ts`.
 *
 * FAITHFULNESS IS THE WHOLE POINT. A rule exists only when the primitives can
 * reproduce the printed effect *as printed*. Where a template needs a system the
 * engine genuinely lacks — a player choosing which card to discard, an {X} cost,
 * a permanent entering tapped — there is deliberately NO rule, and the clause
 * falls through to `missing` with a plain-English explanation from
 * {@link UNSUPPORTED_HINTS}. A rule that "sort of" models a card would silently
 * bias every A/B verdict the deck lab produces, which is worse than saying no.
 */

import type {
  CardType,
  EffectRef,
  ManaColor,
  ManaProduction,
  TriggeredAbility,
} from '@jonny-boi/core';
import type { ClauseContribution, CompileRule, RuleContext } from './types.js';
import { COUNT_TOKEN, parseCount } from './text.js';

/** Mana symbols as they appear in normalized (lowercased) Oracle text. */
const MANA_SYMBOL_TO_COLOR: Readonly<Record<string, ManaColor>> = Object.freeze({
  '{w}': 'W',
  '{u}': 'U',
  '{b}': 'B',
  '{r}': 'R',
  '{g}': 'G',
  '{c}': 'C',
});

/** The `makeToken` primitive's default count — omitted from emitted params. */
const TOKEN_DEFAULT_COUNT = 1;

/**
 * The target phrases a single-target damage spell can print, all of which the
 * engine's one-target `dealDamage` implements exactly.
 *
 * Note the "or planeswalker" variants: the engine has no planeswalkers at all,
 * so "target player or planeswalker" can only ever resolve to the player — the
 * choice is vacuous, not approximated. If planeswalkers are ever implemented,
 * these variants must move to a targeting-aware rule.
 */
const DAMAGE_TARGET_PHRASE =
  '(?:any target|target creature|target player|target opponent|target creature or player|target player or planeswalker|target creature or planeswalker|target creature, player,? or planeswalker)';

/** Persist returns the creature with this many -1/-1 counters (the printed value). */
const PERSIST_MINUS_COUNTERS = 1;

/**
 * Scryfall keyword → the core `KeywordFlags` field implementing it. ONLY the
 * keywords core's combat/turn systems genuinely model appear here; anything else
 * (menace, flash, ward, cycling, …) is not a flag core reads, so a card printing
 * it is reported incomplete rather than quietly losing the ability.
 */
export const KEYWORD_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  flying: 'flying',
  vigilance: 'vigilance',
  haste: 'haste',
  'first strike': 'firstStrike',
  'double strike': 'doubleStrike',
  deathtouch: 'deathtouch',
  trample: 'trample',
  reach: 'reach',
  defender: 'defender',
  lifelink: 'lifelink',
});

/** The keyword alternation used inside "gains … until end of turn" patterns. */
const KEYWORD_TOKEN = `(${Object.keys(KEYWORD_FLAGS).join('|')})`;

/** Colour words Oracle uses in removal restrictions, mapped to color letters. */
const COLOR_WORDS: Readonly<Record<string, string>> = Object.freeze({
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
});

/** Build a `KeywordFlags` object from a printed keyword word. */
function keywordFlag(word: string): Record<string, boolean> | null {
  const field = KEYWORD_FLAGS[word.trim().toLowerCase()];
  return field ? { [field]: true } : null;
}

/**
 * Expand a printed spell-type restriction into the concrete card types the
 * trigger system filters on. Core's `spellType` takes ONE `CardType`, so a
 * restriction covering several types becomes several triggers — exactly how the
 * hand-authored pool models prowess and Young Pyromancer.
 */
function spellTypesFor(restriction: string): readonly CardType[] | null {
  const text = restriction.trim().toLowerCase();
  if (text === 'noncreature') return ['instant', 'sorcery'];
  if (text === 'instant or sorcery') return ['instant', 'sorcery'];
  if (text === 'instant') return ['instant'];
  if (text === 'sorcery') return ['sorcery'];
  if (text === 'creature') return ['creature'];
  if (text === 'artifact') return ['artifact'];
  if (text === 'enchantment') return ['enchantment'];
  return null;
}

/** Parse a run of mana symbols ("{b}{b}{b}") into a color list. */
function manaSymbols(text: string): readonly ManaColor[] | null {
  const matches = text.match(/\{[wubrgc]\}/g);
  if (!matches || matches.length === 0) return null;
  const colors: ManaColor[] = [];
  for (const symbol of matches) {
    const color = MANA_SYMBOL_TO_COLOR[symbol];
    if (!color) return null;
    colors.push(color);
  }
  return colors;
}

// --- effect rules ---------------------------------------------------------------
// Matched against a spell's resolution clause AND against a trigger's body (the
// same templates mean the same thing in both places — one mechanism, DESIGN §1.3).

/** Shorthand for a rule whose contribution is a fixed effect list. */
function effects(...refs: EffectRef[]): ClauseContribution {
  return { effects: refs };
}

export const EFFECT_RULES: readonly CompileRule[] = Object.freeze([
  {
    id: 'damage-any-target',
    description: '"~ deals N damage to any target / target creature / target player"',
    pattern: new RegExp(`^~ deals ${COUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}$`),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null ? null : effects({ primitive: 'dealDamage', params: { amount } });
    },
  },
  {
    id: 'damage-then-gain-life',
    description:
      '"~ deals N damage to any target and you gain N life" (Lightning Helix — printed as one sentence or two)',
    pattern: new RegExp(
      `^~ deals ${COUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}(?:\\.|,)? and you gain ${COUNT_TOKEN} life$|^~ deals ${COUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}\\. you gain ${COUNT_TOKEN} life$`,
    ),
    needsChosenTarget: true,
    build(match) {
      // The pattern has two alternations ("… and you gain" / "…. You gain"), so
      // read whichever pair of capture groups actually matched.
      const damage = parseCount(match[1] ?? match[3]);
      const life = parseCount(match[2] ?? match[4]);
      if (damage === null || life === null) return null;
      return effects(
        { primitive: 'dealDamage', params: { amount: damage } },
        { primitive: 'gainLife', params: { amount: life } },
      );
    },
  },
  {
    id: 'draw-cards',
    description: '"Draw N cards"',
    pattern: new RegExp(`^(?:you )?draw ${COUNT_TOKEN} cards?$`),
    build(match) {
      const count = parseCount(match[1]);
      return count === null ? null : effects({ primitive: 'drawCards', params: { count } });
    },
  },
  {
    id: 'gain-life',
    description: '"You gain N life"',
    pattern: new RegExp(`^you gain ${COUNT_TOKEN} life$`),
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null ? null : effects({ primitive: 'gainLife', params: { amount } });
    },
  },
  {
    id: 'you-lose-life',
    description: '"You lose N life"',
    pattern: new RegExp(`^you lose ${COUNT_TOKEN} life$`),
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null ? null : effects({ primitive: 'loseLife', params: { amount } });
    },
  },
  {
    id: 'target-player-loses-life',
    description: '"Target player/opponent loses N life"',
    pattern: new RegExp(`^target (?:player|opponent) loses ${COUNT_TOKEN} life$`),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null
        ? null
        : effects({ primitive: 'loseLife', params: { amount, targetPlayer: true } });
    },
  },
  {
    id: 'destroy-target-creature',
    description: '"Destroy target [non-COLOR] creature [with mana value N or less]"',
    pattern: new RegExp(
      `^destroy target (non(?:white|blue|black|red|green) )?creature(?: with mana value ${COUNT_TOKEN} or less)?$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const params: Record<string, unknown> = {};
      if (match[1]) {
        const color = COLOR_WORDS[match[1].trim().replace('non', '')];
        if (!color) return null;
        params.notColor = color;
      }
      if (match[2]) {
        const maxManaValue = parseCount(match[2]);
        if (maxManaValue === null) return null;
        params.maxManaValue = maxManaValue;
      }
      return effects({ primitive: 'destroyTarget', params });
    },
  },
  {
    id: 'destroy-all-creatures',
    description: '"Destroy all creatures"',
    pattern: /^destroy all creatures$/,
    build() {
      return effects({ primitive: 'destroyAll' });
    },
  },
  {
    id: 'exile-target-creature',
    description: '"Exile target creature"',
    pattern: /^exile target creature$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'exileTarget' });
    },
  },
  {
    id: 'exile-creature-controller-gains-life',
    description: '"Exile target creature. Its controller gains life equal to its power."',
    pattern: /^exile target creature\. its controller gains life equal to its power$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'exileTarget', params: { gainLifeEqualPower: true } });
    },
  },
  {
    id: 'counter-target-spell',
    description: '"Counter target spell"',
    pattern: /^counter target spell$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'counterSpell' });
    },
  },
  {
    id: 'pump-until-eot',
    description: '"Target creature gets +X/+Y until end of turn"',
    pattern: /^target creature gets ([+-]\d+)\/([+-]\d+) until end of turn$/,
    needsChosenTarget: true,
    build(match) {
      const power = Number.parseInt(match[1] ?? '', 10);
      const toughness = Number.parseInt(match[2] ?? '', 10);
      if (!Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      return effects({ primitive: 'pumpUntilEndOfTurn', params: { power, toughness } });
    },
  },
  {
    // The SELF form, printed on every "grows when you do X" creature (prowess's
    // reminder text, Kiln Fiend, …). It needs no chosen target — the primitive
    // falls back to its own source — which is exactly why it is the only pump a
    // triggered ability may use (see `needsChosenTarget` and `triggerFrom`).
    id: 'self-pump-until-eot',
    description: '"~ gets +X/+Y until end of turn" (the source pumps itself)',
    pattern: /^~ gets ([+-]\d+)\/([+-]\d+) until end of turn$/,
    build(match) {
      const power = Number.parseInt(match[1] ?? '', 10);
      const toughness = Number.parseInt(match[2] ?? '', 10);
      if (!Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      return effects({ primitive: 'pumpUntilEndOfTurn', params: { power, toughness } });
    },
  },
  {
    id: 'pump-and-grant-until-eot',
    description: '"Target creature gets +X/+Y and gains KEYWORD until end of turn"',
    pattern: new RegExp(
      `^target creature gets ([+-]\\d+)\\/([+-]\\d+) and gains ${KEYWORD_TOKEN} until end of turn$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const power = Number.parseInt(match[1] ?? '', 10);
      const toughness = Number.parseInt(match[2] ?? '', 10);
      const keywords = keywordFlag(match[3] ?? '');
      if (!Number.isFinite(power) || !Number.isFinite(toughness) || !keywords) return null;
      return effects(
        { primitive: 'pumpUntilEndOfTurn', params: { power, toughness } },
        { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords } },
      );
    },
  },
  {
    id: 'grant-keyword-until-eot',
    description: '"Target creature gains KEYWORD until end of turn"',
    pattern: new RegExp(`^target creature gains ${KEYWORD_TOKEN} until end of turn$`),
    needsChosenTarget: true,
    build(match) {
      const keywords = keywordFlag(match[1] ?? '');
      return keywords === null
        ? null
        : effects({ primitive: 'grantKeywordUntilEndOfTurn', params: { keywords } });
    },
  },
  {
    id: 'tap-target-creature',
    description: '"Tap target creature"',
    pattern: /^tap target creature$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'tapTarget' });
    },
  },
  {
    id: 'create-creature-token',
    description: '"Create N X/Y [color] [subtype] creature token(s) [with KEYWORD]"',
    pattern: new RegExp(
      `^create ${COUNT_TOKEN} (\\d+)\\/(\\d+) ([a-z ]*?)creature tokens?(?: with ${KEYWORD_TOKEN})?$`,
    ),
    build(match) {
      const count = parseCount(match[1]);
      const power = Number.parseInt(match[2] ?? '', 10);
      const toughness = Number.parseInt(match[3] ?? '', 10);
      if (count === null || !Number.isFinite(power) || !Number.isFinite(toughness)) return null;
      // The descriptor is "<colors> <subtypes> " — the last word is the creature
      // type that names the token (e.g. "red elemental" → "Elemental").
      const descriptor = (match[4] ?? '').trim();
      const words = descriptor.split(' ').filter((w) => w.length > 0);
      const typeWord = words[words.length - 1] ?? 'token';
      const name = typeWord.charAt(0).toUpperCase() + typeWord.slice(1);
      // `count` is omitted when it is the primitive's default of one, keeping the
      // emitted data minimal and identical to the hand-authored pool's style.
      const params: Record<string, unknown> = { power, toughness, name };
      if (count !== TOKEN_DEFAULT_COUNT) params.count = count;
      if (match[5]) {
        const keywords = keywordFlag(match[5]);
        if (!keywords) return null;
        params.keywords = keywords;
      }
      return effects({ primitive: 'makeToken', params });
    },
  },
  {
    id: 'add-mana-spell',
    description: '"Add {B}{B}{B}" (a ritual\'s resolution)',
    pattern: /^add ((?:\{[wubrgc]\})+)$/,
    build(match) {
      const colors = manaSymbols(match[1] ?? '');
      return colors === null ? null : effects({ primitive: 'addMana', params: { mana: [...colors] } });
    },
  },
]);

// --- trigger rules --------------------------------------------------------------
// Each recognizes a printed trigger prefix and compiles the BODY with the effect
// rules above. If the body has no faithful implementation the whole trigger is
// rejected (returns null) — never a trigger that fires and does nothing.

/**
 * Build a one-condition trigger whose body is compiled from `bodyText`.
 *
 * The body is compiled in TARGET-FREE mode, because core resolves a triggered
 * ability with an empty target list (`triggers-runtime.ts` puts `targets: []` on
 * the stack object): nothing chooses targets for a trigger yet. So a body like
 * "destroy target creature" would go on the stack, resolve, find no target and
 * do NOTHING — a card that reads as removal and is actually blank. Rejecting the
 * whole trigger reports the card instead, which is the compiler's contract.
 */
function triggerFrom(
  ctx: RuleContext,
  condition: TriggeredAbility['condition'],
  bodyText: string,
  label: string,
): ClauseContribution | null {
  const body = ctx.compileEffectClause(bodyText, { targetFree: true });
  if (body === null || body.length === 0) return null;
  return { triggers: [{ condition, effects: body, label }] };
}

export const TRIGGER_RULES: readonly CompileRule[] = Object.freeze([
  {
    id: 'trigger-etb',
    description: '"When ~ enters (the battlefield), BODY"',
    pattern: /^when ~ enters(?: the battlefield)?, (.+)$/,
    build(match, ctx) {
      return triggerFrom(ctx, { on: 'etb' }, match[1] ?? '', `Enters: ${match[1] ?? ''}`);
    },
  },
  {
    id: 'trigger-attacks',
    description: '"Whenever ~ attacks, BODY"',
    pattern: /^whenever ~ attacks, (.+)$/,
    build(match, ctx) {
      return triggerFrom(ctx, { on: 'attacks' }, match[1] ?? '', `Attacks: ${match[1] ?? ''}`);
    },
  },
  {
    id: 'trigger-dies',
    description: '"When ~ dies, BODY"',
    pattern: /^when ~ dies, (.+)$/,
    build(match, ctx) {
      return triggerFrom(ctx, { on: 'dies' }, match[1] ?? '', `Dies: ${match[1] ?? ''}`);
    },
  },
  {
    id: 'trigger-upkeep',
    description: '"At the beginning of your upkeep, BODY"',
    pattern: /^at the beginning of your upkeep, (.+)$/,
    build(match, ctx) {
      return triggerFrom(
        ctx,
        { on: 'upkeep', who: 'you' },
        match[1] ?? '',
        `Upkeep: ${match[1] ?? ''}`,
      );
    },
  },
  {
    id: 'trigger-cast-spell',
    description: '"Whenever you cast a(n) TYPE spell, BODY" (incl. prowess-style text)',
    pattern: /^whenever you cast an? ([a-z ]+?) spell, (.+)$/,
    build(match, ctx) {
      const types = spellTypesFor(match[1] ?? '');
      if (!types) return null;
      const body = ctx.compileEffectClause(match[2] ?? '', { targetFree: true });
      if (body === null || body.length === 0) return null;
      // One trigger per concrete card type — core filters on a single CardType.
      return {
        triggers: types.map((spellType) => ({
          condition: { on: 'castSpell' as const, who: 'you' as const, spellType },
          effects: body,
          label: `Cast ${spellType}: ${match[2] ?? ''}`,
        })),
      };
    },
  },
]);

// --- mana abilities -------------------------------------------------------------

/** Card-level static properties printed as their own ability line. */
export const STATIC_RULES: readonly CompileRule[] = Object.freeze([
  {
    id: 'enters-tapped',
    description: '"~ enters tapped" (the unconditional form only)',
    pattern: /^~ enters(?: the battlefield)? tapped$/,
    build() {
      return { entersTapped: true };
    },
  },
]);

/** The colors "one mana of any color" may be taken as, in canonical order. */
const ANY_COLOR: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** Turn a run of symbols ("{c}{c}") into the single mode one tap adds. */
function productionFromColors(colors: readonly ManaColor[]): ManaProduction {
  const mode: Partial<Record<ManaColor, number>> = {};
  for (const color of colors) mode[color] = (mode[color] ?? 0) + 1;
  return mode;
}

/** Split an "or"-list of mana runs ("{w}, {u}, or {b}") into its alternatives. */
const MANA_ALTERNATIVE_SEPARATOR = /,? or |, /;

export const MANA_RULES: readonly CompileRule[] = Object.freeze([
  {
    id: 'tap-for-mana',
    description: '"{T}: Add {G}" / "{T}: Add {C}{C}"',
    pattern: /^\{t\}: add ((?:\{[wubrgc]\})+)$/,
    build(match) {
      const colors = manaSymbols(match[1] ?? '');
      return colors === null ? null : { produces: colors };
    },
  },
  {
    // A CHOICE between fixed alternatives — the printed form of every common
    // dual land ("{T}: Add {W} or {U}"). Core models this exactly with
    // `producesOptions`: one tap adds one MODE, chosen at activation. (Writing
    // the alternatives as a `produces` bundle would instead add one of each,
    // turning a dual land into a two-mana land — which is why this rule may only
    // ever build modes, never a bundle.)
    id: 'tap-for-mana-choice',
    description: '"{T}: Add {W} or {U}" / "{T}: Add {W}, {U}, {B}, {R}, or {G}"',
    pattern:
      /^\{t\}: add ((?:\{[wubrgc]\})+(?:,? or (?:\{[wubrgc]\})+|, (?:\{[wubrgc]\})+)+)$/,
    build(match) {
      const alternatives = (match[1] ?? '').split(MANA_ALTERNATIVE_SEPARATOR);
      const producesOptions: ManaProduction[] = [];
      for (const alternative of alternatives) {
        const colors = manaSymbols(alternative);
        if (colors === null) return null;
        producesOptions.push(productionFromColors(colors));
      }
      return producesOptions.length > 1 ? { producesOptions } : null;
    },
  },
  {
    // "Add one mana of any color" is the same modal ability with the five colors
    // spelled out in words — Birds of Paradise, Manalith, Alloy Myr.
    id: 'tap-for-any-color',
    description: '"{T}: Add one mana of any color"',
    pattern: /^\{t\}: add one mana of any color$/,
    build() {
      return { producesOptions: ANY_COLOR.map((color) => productionFromColors([color])) };
    },
  },
  // NOTE: there is still deliberately NO rule for a mana ability whose colors are
  // not a fixed printed list — "add one mana of any color that a land you control
  // could produce", "add one mana of the chosen type". Those need the choice to be
  // constrained by board state at activation time, which the engine cannot do, so
  // they fall through to `missing` (see UNSUPPORTED_HINTS).
]);

/**
 * Riders that reference a mechanic the engine does not have AT ALL, and which
 * therefore change nothing. "They can't be regenerated" only matters in a game
 * with regeneration; since no card can ever regenerate here, honoring the rider
 * is automatic and ignoring the sentence is faithful — not an approximation.
 *
 * This list is strictly for clauses that are *vacuously satisfied*. A clause the
 * engine merely handles badly does NOT belong here; it belongs in `missing`.
 */
export const VACUOUS_CLAUSES: readonly RegExp[] = Object.freeze([
  /^(?:they|it) can'?t be regenerated$/,
]);

/** True when a clause is vacuously satisfied and can safely be skipped. */
export function isVacuousClause(clause: string): boolean {
  return VACUOUS_CLAUSES.some((pattern) => pattern.test(clause));
}

/**
 * Keyword abilities with a real implementation built from primitives, expressed
 * as a direct contribution. Persist is modelled exactly as the hand-authored
 * pool models it: a dies-trigger running `persistReturn`, which brings the
 * creature back with a -1/-1 counter and strips its own persist so it cannot
 * return twice.
 */
export const KEYWORD_ABILITY_BUILDERS: Readonly<Record<string, () => ClauseContribution>> =
  Object.freeze({
    persist: () => ({
      triggers: [
        {
          condition: { on: 'dies' as const },
          effects: [
            { primitive: 'persistReturn', params: { minusCounters: PERSIST_MINUS_COUNTERS } },
          ],
          label: 'Persist: return with a -1/-1 counter',
        },
      ],
    }),
  });

/**
 * Plain-English explanations for templates we deliberately do NOT implement.
 * These turn "this card didn't compile" into "this card needs X", which is what
 * makes the gap actionable — the import UI shows this text verbatim, and it is
 * the to-do list for the next engine milestone.
 *
 * Order matters: the first matching hint wins, so put specific patterns first.
 */
export const UNSUPPORTED_HINTS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly missingEngineSystem: string;
}> = Object.freeze([
  {
    pattern: /add one mana of any color|add \{[wubrgc]\} or \{[wubrgc]\}|add one mana of any/,
    missingEngineSystem: 'mana abilities that produce a chosen color',
  },
  { pattern: /\benters tapped\b/, missingEngineSystem: 'permanents entering the battlefield tapped' },
  { pattern: /\byou may\b|\bchoose\b|\bchooses\b|discards? a card|\bdiscards\b/, missingEngineSystem: 'player choice during resolution' },
  { pattern: /\bsearch your library\b/, missingEngineSystem: 'library search (tutoring) with a chooser' },
  { pattern: /\bscry\b|\bsurveil\b|look at the top/, missingEngineSystem: 'looking at and reordering library cards' },
  { pattern: /\bloyalty\b|^[+-]\d+:/, missingEngineSystem: 'planeswalker loyalty abilities' },
  { pattern: /\btransform\b|\bflip\b|double-faced/, missingEngineSystem: 'transform / double-faced cards' },
  { pattern: /\bflashback\b|\bflash\b/, missingEngineSystem: 'flash timing and graveyard recasting' },
  { pattern: /\bequip\b|\battach\b|\benchant\b/, missingEngineSystem: 'auras and equipment attachment' },
  { pattern: /\bsacrifice\b/, missingEngineSystem: 'sacrifice costs and activated abilities' },
  { pattern: /\bcounters? on\b|\b\+1\/\+1 counter/, missingEngineSystem: 'persistent counters beyond +1/+1 pumps' },
  { pattern: /\bexiles?\b.*\bgraveyard\b|\bgraveyard\b/, missingEngineSystem: 'graveyard-based abilities with a chooser' },
  { pattern: /\bmill\b|puts? the top .* into (?:their|his or her) graveyard/, missingEngineSystem: 'milling' },
  { pattern: /\bcan't be blocked\b|\bmenace\b|\bmust be blocked\b/, missingEngineSystem: 'blocking restrictions beyond evasion keywords' },
  { pattern: /\bward\b|\bhexproof\b|\bshroud\b|\bprotection from\b/, missingEngineSystem: 'targeting restrictions (hexproof / ward / protection)' },
  { pattern: /\bcycling\b|\bkicker\b|\bbuyback\b|\bmadness\b/, missingEngineSystem: 'alternative and additional casting costs' },
  { pattern: /\{x\}|\bx damage\b|\bequal to\b/, missingEngineSystem: 'variable ({X}) and derived values' },
  { pattern: /\bactivated abilit|\{t\}:|\{\d+\}[,:]/, missingEngineSystem: 'activated abilities with costs' },
]);

/** Find the best explanation for an unimplementable clause. */
export function explainUnsupported(clause: string): string {
  for (const hint of UNSUPPORTED_HINTS) {
    if (hint.pattern.test(clause)) return hint.missingEngineSystem;
  }
  return 'a rules template the compiler does not recognize yet';
}
