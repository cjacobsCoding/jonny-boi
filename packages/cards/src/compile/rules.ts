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
  TargetRestriction,
  TriggerCondition,
  TriggeredAbility,
} from '@jonny-boi/core';
import { DEFAULT_TARGET_RESTRICTION } from '@jonny-boi/core';
import type { ClauseContribution, CompileRule, RuleContext } from './types.js';
import { COUNT_TOKEN, parseCount } from './text.js';
import { BASIC_LAND_NAMES } from '../../data/pool.js';

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
 * The target phrases a single-target damage spell can print, mapped to the
 * {@link TargetRestriction} that reproduces each one exactly.
 *
 * This table is the whole reason Lava Spike and Flame Slash are honest cards. The
 * compiler used to accept every phrase here and emit the SAME unrestricted
 * `dealDamage`, so "deals 4 damage to target **creature**" for one mana played as
 * a one-mana four-damage any-target spell, and "deals 3 damage to target
 * **player** or planeswalker" could kill creatures. Both played strictly better
 * than printed, which silently corrupts every A/B verdict that includes them.
 *
 * The "or planeswalker" variants collapse onto the non-planeswalker half because
 * the engine has no planeswalkers at all: the choice is vacuous, not approximated.
 * If planeswalkers are ever implemented, these entries need a third target kind.
 *
 * "target **opponent**" now maps to its own `'opponent'` restriction, which the
 * engine evaluates against the caster. It used to be absent here because
 * `TargetRestriction` could say "a player" but not "a player who isn't you", and
 * flattening it to `'player'` would have let the spell be aimed at its own
 * caster — strictly more permissive than printed.
 */
const DAMAGE_TARGET_RESTRICTIONS: Readonly<Record<string, TargetRestriction>> = Object.freeze({
  'any target': 'any',
  'target creature': 'creature',
  'target player': 'player',
  'target opponent': 'opponent',
  'target creature or player': 'any',
  'target player or planeswalker': 'player',
  'target creature or planeswalker': 'creature',
  'target creature, player, or planeswalker': 'any',
  'target creature, player or planeswalker': 'any',
});

/**
 * The capturing alternation of the phrases above, longest-first so a phrase is
 * never truncated to a shorter one that happens to prefix it ("target creature"
 * inside "target creature or player"). Built FROM the table so the patterns and
 * the restrictions they mean cannot drift apart.
 */
const DAMAGE_TARGET_PHRASE = `(${Object.keys(DAMAGE_TARGET_RESTRICTIONS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

/**
 * The restriction a printed target phrase means, or `null` if it is not one we
 * can reproduce. Never guesses: an unrecognised phrase rejects the whole rule.
 */
function damageRestriction(phrase: string): TargetRestriction | null {
  return DAMAGE_TARGET_RESTRICTIONS[phrase.trim().toLowerCase()] ?? null;
}

/**
 * The params for a targeted damage effect. `targets` is OMITTED when the phrase is
 * the unrestricted default, so an "any target" card compiles to exactly the data it
 * always did (and the hand-authored Lightning Bolt still matches byte for byte).
 */
function damageParams(amount: number, restriction: TargetRestriction): Record<string, unknown> {
  return restriction === DEFAULT_TARGET_RESTRICTION ? { amount } : { amount, targets: restriction };
}

/**
 * The two non-damage {@link TargetRestriction}s the rule table emits, named so the
 * printed phrase they stand for is obvious at every use site.
 *
 * They matter for a different reason than the damage ones. Removal and combat
 * tricks were never *aimed* wrongly — their primitives already refuse a
 * non-creature. What they lacked was MTG's rule that **a spell with no legal
 * target cannot be cast**: "Destroy target creature" was castable into an empty
 * board and simply evaporated, and — worse — "Counter target spell. You gain 3
 * life." was castable with an empty stack for a free three life, i.e. strictly
 * better than the printed card.
 */
const CREATURE_TARGET: TargetRestriction = 'creature';
const SPELL_TARGET: TargetRestriction = 'spell';
const PLAYER_TARGET: TargetRestriction = 'player';
const ARTIFACT_TARGET: TargetRestriction = 'artifact';

/** How many modes each printed header lets you choose. */
const MODAL_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  one: 1,
  two: 2,
  // "one or both" is a range the mode chooser cannot express as a fixed count,
  // so it is deliberately absent and those cards keep reporting.
});
const OPPONENT_TARGET: TargetRestriction = 'opponent';

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

/**
 * "A land card", as the `CardFilter` both a reveal and a search use. One object so
 * the compiler and the hand-authored pool cannot drift apart on what "land" means.
 */
const LAND_FILTER = Object.freeze({ anyOfTypes: Object.freeze(['land']) });

/**
 * The five basic land types. A fetchland selects by these, and restricting the
 * fetch template to them keeps it from matching a search for some other card
 * type whose retrieval this template does not actually implement.
 */
const LAND_SUBTYPES: ReadonlySet<string> = new Set([
  'plains',
  'island',
  'swamp',
  'mountain',
  'forest',
]);

/**
 * The printed restrictions a "you choose a ___ card from it" discard may carry,
 * mapped to the `CardFilter` implementing each. Anything outside this table is a
 * restriction the filter cannot express, so the rule declines rather than
 * discarding the wrong kind of card.
 */
const DISCARD_RESTRICTIONS: Readonly<Record<string, { readonly noneOfTypes?: readonly string[]; readonly anyOfTypes?: readonly string[] }>> =
  Object.freeze({
    nonland: { noneOfTypes: Object.freeze(['land']) },
    noncreature: { noneOfTypes: Object.freeze(['creature']) },
    creature: { anyOfTypes: Object.freeze(['creature']) },
    land: { anyOfTypes: Object.freeze(['land']) },
  });

/** The regex alternation of the discard restrictions above. */
const DISCARD_RESTRICTION_TOKEN = Object.keys(DISCARD_RESTRICTIONS).join('|');

/** The filter implementing a printed discard restriction, or null if unexpressible. */
function discardFilterFor(word: string): (typeof DISCARD_RESTRICTIONS)[string] | null {
  return DISCARD_RESTRICTIONS[word.trim().toLowerCase()] ?? null;
}

/** Build a `KeywordFlags` object from a printed keyword word. */
function keywordFlag(word: string): Record<string, boolean> | null {
  const field = KEYWORD_FLAGS[word.trim().toLowerCase()];
  return field ? { [field]: true } : null;
}

/**
 * The trigger CONDITIONS a printed spell-type restriction compiles to, or `null`
 * when the phrase is not one we model.
 *
 * Two shapes, because Oracle prints two:
 *   - a POSITIVE list ("instant or sorcery spell") — core's `spellType` takes one
 *     `CardType`, so a multi-type list becomes one trigger per type. This is how
 *     the hand-authored pool has always modelled Young Pyromancer and Kiln Fiend.
 *   - a NEGATIVE list ("**non**creature spell" — prowess) — one trigger carrying
 *     `spellTypeNoneOf`. Flattening this into the positive pair instant+sorcery is
 *     what made Monastery Swiftspear miss every artifact and planeswalker in the
 *     pool, so the negative form is compiled as a negative filter, not guessed at.
 */
function spellFiltersFor(restriction: string): readonly TriggerCondition[] | null {
  const text = restriction.trim().toLowerCase();
  const negated = /^non(.+)$/.exec(text);
  if (negated) {
    const excluded = SPELL_TYPE_WORDS[negated[1] ?? ''];
    return excluded ? [{ on: 'castSpell', who: 'you', spellTypeNoneOf: [excluded] }] : null;
  }
  const positive = text === 'instant or sorcery' ? (['instant', 'sorcery'] as const) : positiveSpellTypes(text);
  return positive === null
    ? null
    : positive.map((spellType) => ({ on: 'castSpell', who: 'you', spellType }));
}

/** A single printed type word → the `CardType` it names. */
const SPELL_TYPE_WORDS: Readonly<Record<string, CardType>> = Object.freeze({
  instant: 'instant',
  sorcery: 'sorcery',
  creature: 'creature',
  artifact: 'artifact',
  enchantment: 'enchantment',
  land: 'land',
  planeswalker: 'planeswalker',
});

/** The single-word positive form, as a one-element list. */
function positiveSpellTypes(text: string): readonly CardType[] | null {
  const type = SPELL_TYPE_WORDS[text];
  return type ? [type] : null;
}

/** How a compiled cast-trigger filter reads in its debug label. */
function describeSpellFilter(condition: TriggerCondition): string {
  if (condition.spellType) return condition.spellType;
  const excluded = condition.spellTypeNoneOf ?? [];
  return excluded.length > 0 ? `non${excluded.join('/')}` : 'spell';
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
    description:
      '"~ deals N damage to any target / target creature / target player [or planeswalker]" — the printed target phrase becomes the effect\'s `targets` restriction',
    pattern: new RegExp(`^~ deals ${COUNT_TOKEN} damage to ${DAMAGE_TARGET_PHRASE}$`),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[1]);
      const restriction = damageRestriction(match[2] ?? '');
      if (amount === null || restriction === null) return null;
      return effects({ primitive: 'dealDamage', params: damageParams(amount, restriction) });
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
      // The pattern has two alternations ("… and you gain" / "…. You gain"), each
      // carrying three groups (count, target phrase, life), so read whichever
      // triple actually matched.
      const damage = parseCount(match[1] ?? match[4]);
      const restriction = damageRestriction(match[2] ?? match[5] ?? '');
      const life = parseCount(match[3] ?? match[6]);
      if (damage === null || life === null || restriction === null) return null;
      return effects(
        { primitive: 'dealDamage', params: damageParams(damage, restriction) },
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
    // "target opponent" is deliberately NOT accepted here, for the same reason it
    // is absent from DAMAGE_TARGET_RESTRICTIONS: the engine can restrict a spell
    // to a player, but not to a player who isn't you.
    id: 'target-player-loses-life',
    description: '"Target player loses N life"',
    pattern: new RegExp(`^target player loses ${COUNT_TOKEN} life$`),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[1]);
      return amount === null
        ? null
        : effects({
            primitive: 'loseLife',
            // Without the restriction this spell could be "targeted" at a creature,
            // where `loseLife` finds no player target and falls back to the
            // controller — i.e. the caster would lose the life. The restriction is
            // what makes the printed target the only thing it can be pointed at.
            params: { amount, targetPlayer: true, targets: 'player' },
          });
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
      const params: Record<string, unknown> = { targets: CREATURE_TARGET };
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
    id: 'modal-choose',
    description: '"Choose one — • MODE • MODE" (charms and commands)',
    // `text.ts` folds the header and its bullets into one line, so this sees the
    // whole block. Each mode compiles through the ordinary effect rules, which
    // means a modal card can only ever offer modes the engine can really run.
    pattern: /^choose\s+(one|two|one or both)\s*[—-]\s*(•.+)$/,
    build(match, ctx) {
      const count = MODAL_COUNTS[match[1]!.toLowerCase()];
      if (count === undefined) return null;

      const bodies = match[2]!
        .split('•')
        .map((mode) => mode.trim())
        .filter((mode) => mode.length > 0);
      if (bodies.length < 2) return null; // not really a choice

      const modes: Array<{ id: string; label: string; effects: readonly EffectRef[] }> = [];
      for (const [index, body] of bodies.entries()) {
        // A mode the engine cannot run makes the WHOLE card unsupported. Half a
        // modal spell is not a modal spell — offering only the modes we happen
        // to implement would silently change what the card can do.
        const effects = ctx.compileEffectClause(body);
        if (!effects) return null;
        modes.push({ id: `mode${index + 1}`, label: body, effects });
      }

      return { effects: [{ primitive: 'modal', params: { count, modes } }] };
    },
  },
  {
    id: 'destroy-target-artifact',
    description: '"Destroy target artifact"',
    pattern: /^destroy target artifact$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'destroyTarget', params: { targets: ARTIFACT_TARGET } });
    },
  },
  {
    id: 'target-opponent-loses-life',
    description: '"Target opponent loses N life"',
    // Now expressible: `TargetRestriction` can say "a player who isn't you", so
    // the spell can no longer be offered pointing at its own caster.
    pattern: new RegExp(`^target opponent loses ${COUNT_TOKEN} life$`),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[1]!);
      if (amount === null) return null;
      return effects({
        primitive: 'loseLife',
        params: { amount, targetPlayer: true, targets: OPPONENT_TARGET },
      });
    },
  },
  {
    id: 'put-counters-on-target',
    description: '"Put N +1/+1 counters on target creature"',
    pattern: new RegExp(`^put (?:a|${COUNT_TOKEN}) \\+1/\\+1 counters? on target creature$`),
    needsChosenTarget: true,
    build(match) {
      // "a counter" has no count token to parse — it is exactly one.
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      return effects({
        primitive: 'addCounters',
        params: { amount, targets: CREATURE_TARGET },
      });
    },
  },
  {
    // The same template with -1/-1 counters. Now that the stat layer reads that
    // kind in its own right, this is a faithful compile rather than an
    // approximation stored as a negative +1/+1.
    id: 'put-minus-counters-on-target',
    description: '"Put N -1/-1 counters on target creature"',
    pattern: new RegExp(`^put (?:a|${COUNT_TOKEN}) -1/-1 counters? on target creature$`),
    needsChosenTarget: true,
    build(match) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      return effects({
        primitive: 'addCounters',
        params: { amount: -amount, targets: CREATURE_TARGET },
      });
    },
  },
  {
    // "Put a +1/+1 counter on it" / "on ~" — the SELF form. Extremely common as
    // the payload of an ETB or attack trigger, and it needs no target, which is
    // why the targeted rule above could never match it.
    id: 'put-counters-on-self',
    description: '"Put N +1/+1 counters on ~" (no target)',
    pattern: new RegExp(
      `^put (?:a|${COUNT_TOKEN}) \\+1/\\+1 counters? on (?:~|it|this creature)$`,
    ),
    build(match) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      return effects({ primitive: 'addCounters', params: { amount, self: true } });
    },
  },
  {
    id: 'draw-and-lose-life',
    description: '"You draw N cards and you lose M life" (one sentence, two effects)',
    // Printed as a single sentence, so the sentence splitter never separates it
    // into the two clauses that each already compile. Night's Whisper, Sign in
    // Blood, and the whole black card-draw family read this way.
    pattern: new RegExp(
      `^(?:you )?draws? ${COUNT_TOKEN} cards? and (?:you )?loses? ${COUNT_TOKEN} life$`,
    ),
    build(match) {
      const count = parseCount(match[1]!);
      const life = parseCount(match[2]!);
      if (count === null || life === null) return null;
      return effects(
        { primitive: 'drawCards', params: { count } },
        { primitive: 'loseLife', params: { amount: life } },
      );
    },
  },
  {
    id: 'return-target-permanent-to-hand',
    description: '"Return target creature to its owner\'s hand" (bounce)',
    pattern: /^return target (creature|permanent) to (?:its|their) owner'?s hand$/,
    needsChosenTarget: true,
    build() {
      // `returnToHand` has existed in the primitive library the whole time with
      // no rule able to reach it — bounce was reported unsupported purely for
      // want of this pattern.
      return effects({ primitive: 'returnToHand', params: { targets: CREATURE_TARGET } });
    },
  },
  {
    id: 'creature-fights',
    description: '"~ fights target creature"',
    pattern: /^~ fights target creature$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'fight', params: { targets: CREATURE_TARGET } });
    },
  },
  {
    id: 'target-player-mills',
    description: '"Target player mills N cards"',
    pattern: new RegExp(`^target (player|opponent) mills ${COUNT_TOKEN} cards?$`),
    needsChosenTarget: true,
    build(match) {
      const amount = parseCount(match[2]!);
      if (amount === null) return null;
      return effects({ primitive: 'mill', params: { amount, targets: PLAYER_TARGET } });
    },
  },
  {
    id: 'self-mill',
    description: '"You mill N cards" / "Mill N cards"',
    pattern: new RegExp(`^(?:you )?mills? ${COUNT_TOKEN} cards?$`),
    build(match) {
      const amount = parseCount(match[1]!);
      if (amount === null) return null;
      return effects({ primitive: 'mill', params: { amount, self: true } });
    },
  },
  {
    id: 'damage-to-each-creature',
    description: '"~ deals N damage to each creature"',
    pattern: new RegExp(`^~ deals ${COUNT_TOKEN} damage to each creature$`),
    build(match) {
      const amount = parseCount(match[1]!);
      if (amount === null) return null;
      return effects({ primitive: 'dealDamageToEach', params: { amount, creatures: true } });
    },
  },
  {
    id: 'damage-to-each-opponent',
    description: '"~ deals N damage to each opponent"',
    pattern: new RegExp(`^~ deals ${COUNT_TOKEN} damage to each opponent$`),
    build(match) {
      const amount = parseCount(match[1]!);
      if (amount === null) return null;
      return effects({ primitive: 'dealDamageToEach', params: { amount, opponents: true } });
    },
  },
  {
    id: 'damage-to-each-creature-and-player',
    description: '"~ deals N damage to each creature and each player"',
    pattern: new RegExp(`^~ deals ${COUNT_TOKEN} damage to each creature and each player$`),
    build(match) {
      const amount = parseCount(match[1]!);
      if (amount === null) return null;
      return effects({
        primitive: 'dealDamageToEach',
        params: { amount, creatures: true, players: true },
      });
    },
  },
  {
    id: 'exile-target-creature',
    description: '"Exile target creature"',
    pattern: /^exile target creature$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'exileTarget', params: { targets: CREATURE_TARGET } });
    },
  },
  {
    id: 'exile-creature-controller-gains-life',
    description: '"Exile target creature. Its controller gains life equal to its power."',
    pattern: /^exile target creature\. its controller gains life equal to its power$/,
    needsChosenTarget: true,
    build() {
      return effects({
        primitive: 'exileTarget',
        params: { gainLifeEqualPower: true, targets: CREATURE_TARGET },
      });
    },
  },
  {
    id: 'counter-target-spell',
    description: '"Counter target spell"',
    pattern: /^counter target spell$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'counterSpell', params: { targets: SPELL_TARGET } });
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
      return effects({
        primitive: 'pumpUntilEndOfTurn',
        params: { power, toughness, targets: CREATURE_TARGET },
      });
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
        { primitive: 'pumpUntilEndOfTurn', params: { power, toughness, targets: CREATURE_TARGET } },
        { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords, targets: CREATURE_TARGET } },
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
        : effects({
            primitive: 'grantKeywordUntilEndOfTurn',
            params: { keywords, targets: CREATURE_TARGET },
          });
    },
  },
  {
    id: 'tap-target-creature',
    description: '"Tap target creature"',
    pattern: /^tap target creature$/,
    needsChosenTarget: true,
    build() {
      return effects({ primitive: 'tapTarget', params: { targets: CREATURE_TARGET } });
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

  // --- templates that ASK the player something (DESIGN §3.11) -------------------
  // These compile to the choice-driven primitives in `../choice-primitives.ts`.
  // They are here for the same reason as every other rule: the engine can now play
  // the printed clause exactly, so refusing it would be the dishonest answer.
  {
    id: 'draw-then-put-back-on-top',
    description: '"Draw N cards, then put M cards from your hand on top of your library in any order" (Brainstorm)',
    pattern: new RegExp(
      `^draw ${COUNT_TOKEN} cards?, then put ${COUNT_TOKEN} cards? from your hand on top of your library in any order$`,
    ),
    build(match) {
      const drawn = parseCount(match[1]);
      const putBack = parseCount(match[2]);
      if (drawn === null || putBack === null) return null;
      return effects(
        { primitive: 'drawCards', params: { count: drawn } },
        { primitive: 'putFromHandOnTop', params: { count: putBack } },
      );
    },
  },
  {
    id: 'look-at-top-and-reorder',
    description: '"Look at the top N cards of your library, then put them back in any order" (Ponder)',
    pattern: new RegExp(`^look at the top ${COUNT_TOKEN} cards? of your library, then put them back in any order$`),
    build(match) {
      const count = parseCount(match[1]);
      return count === null ? null : effects({ primitive: 'reorderTopOfLibrary', params: { count } });
    },
  },
  {
    id: 'may-shuffle',
    description: '"You may shuffle"',
    pattern: /^you may shuffle(?: your library)?$/,
    build() {
      return effects({ primitive: 'mayShuffleLibrary' });
    },
  },
  {
    id: 'reveal-hand-caster-chooses-discard',
    description:
      '"Target player reveals their hand. You choose a RESTRICTION card from it. That player discards that card." (+ the "You lose N life" rider — Thoughtseize)',
    pattern: new RegExp(
      `^target player reveals their hand\\. you choose a (${DISCARD_RESTRICTION_TOKEN}) card from it\\. that player discards that card(?:\\. you lose ${COUNT_TOKEN} life)?$`,
    ),
    needsChosenTarget: true,
    build(match) {
      const filter = discardFilterFor(match[1] ?? '');
      if (!filter) return null;
      const discard: EffectRef = {
        primitive: 'discardCard',
        // The CASTER chooses — that is what "you choose a card from it" means, and
        // it is the whole difference between Thoughtseize and a random discard.
        params: { count: 1, who: 'targetPlayer', chosenBy: 'controller', filter },
      };
      const lifeLoss = parseCount(match[2]);
      if (match[2] === undefined) return effects(discard);
      return lifeLoss === null
        ? null
        : effects(discard, { primitive: 'loseLife', params: { amount: lifeLoss } });
    },
  },
  {
    id: 'return-target-card-from-graveyard',
    description: '"[You may] return target card from your graveyard to your hand" (Eternal Witness)',
    // No `needsChosenTarget`: the card to return is picked by a CHOICE at
    // resolution, not by a target chosen at cast — which is exactly why this may
    // also be the body of a triggered ability.
    pattern: /^(you may )?return target card from your graveyard to your hand$/,
    build(match) {
      const params: Record<string, unknown> = { count: 1 };
      if (match[1]) params.optional = true;
      return effects({ primitive: 'returnFromGraveyard', params });
    },
  },
  {
    id: 'defending-player-reveals-top-land',
    description:
      '"Defending player reveals the top card of their library. If it\'s a land card, that player puts it into their hand." (Goblin Guide)',
    pattern:
      /^defending player reveals the top card of their library\. if it'?s a land card, that player puts it into their hand$/,
    build() {
      return effects({ primitive: 'revealTopCard', params: { who: 'opponent', filter: LAND_FILTER } });
    },
  },
  {
    id: 'fetch-land-by-subtype',
    description:
      '"Search your library for a Mountain or Plains card, put it onto the battlefield, then shuffle." (the fetchland body)',
    // Matches one or two land subtypes joined by "or", with the optional
    // "tapped" and the optional trailing shuffle both printed forms carry.
    // Selection is by SUBTYPE, so this finds a dual land with those land types
    // exactly as the printed card does — not just a basic.
    pattern:
      /^search your library for an? ([a-z]+)(?: or ([a-z]+))? card, put it onto the battlefield( tapped)?(?:, then shuffle)?$/,
    build(match) {
      const subtypes = [match[1], match[2]].filter((s): s is string => Boolean(s));
      // Only LAND subtypes are safe here: a non-land search would need the card
      // to be castable, which this template does not express.
      if (!subtypes.every((subtype) => LAND_SUBTYPES.has(subtype))) return null;
      return effects({
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          filter: { anyOfTypes: ['land'], anyOfSubtypes: subtypes },
          destination: 'battlefield',
          ...(match[3] ? { tapped: true } : {}),
        },
      });
    },
  },
  {
    id: 'exile-creature-controller-may-fetch-basic',
    description:
      '"Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle." (Path to Exile)',
    // Compiled as ONE template rather than two clauses because the compensation
    // belongs to the exile: it is the exiled creature's controller who searches,
    // and only when the creature really was exiled.
    pattern:
      /^exile target creature\. its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle$/,
    needsChosenTarget: true,
    build() {
      return effects(
        { primitive: 'exileTarget', params: { targets: CREATURE_TARGET } },
        {
          primitive: 'searchLibrary',
          params: {
            who: 'targetController',
            requiresTargetInZone: 'exile',
            optional: true,
            count: 1,
            filter: LAND_FILTER,
            nameAnyOf: BASIC_LAND_NAMES,
            destination: 'battlefield',
            tapped: true,
          },
        },
      );
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
    id: 'trigger-leaves',
    description: '"When ~ leaves the battlefield, BODY"',
    // Core has had the `leaves` trigger event all along; only this pattern was
    // missing, so every leaves-the-battlefield card reported as unsupported.
    pattern: /^when ~ leaves the battlefield, (.+)$/,
    build(match, ctx) {
      return triggerFrom(ctx, { on: 'leaves' }, match[1] ?? '', `Leaves: ${match[1] ?? ''}`);
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
      const conditions = spellFiltersFor(match[1] ?? '');
      if (!conditions) return null;
      const body = ctx.compileEffectClause(match[2] ?? '', { targetFree: true });
      if (body === null || body.length === 0) return null;
      return {
        triggers: conditions.map((condition) => ({
          condition,
          effects: body,
          label: `Cast ${describeSpellFilter(condition)}: ${match[2] ?? ''}`,
        })),
      };
    },
  },
]);

// --- mana abilities -------------------------------------------------------------

/** Card-level static properties printed as their own ability line. */
export const STATIC_RULES: readonly CompileRule[] = Object.freeze([
  {
    id: 'enters-with-counters',
    description: '"~ enters with N +1/+1 counters on it"',
    // A whole ability line like "enters tapped", not a split sentence — hence its
    // place in this table and the optional trailing full stop.
    pattern: new RegExp(
      `^~ enters(?: the battlefield)? with (?:a|${COUNT_TOKEN}) \\+1/\\+1 counters? on it\\.?$`,
    ),
    build(match) {
      const amount = match[1] === undefined ? 1 : parseCount(match[1]);
      if (amount === null) return null;
      // The permanent's own ETB script counters itself.
      return { effects: [{ primitive: 'addCounters', params: { amount, self: true } }] };
    },
  },
  {
    id: 'enters-tapped',
    description: '"~ enters tapped" (the unconditional form only)',
    pattern: /^~ enters(?: the battlefield)? tapped$/,
    build() {
      return { entersTapped: true };
    },
  },
  {
    id: 'enters-tapped-unless-few-lands',
    description:
      '"~ enters tapped unless you control two or fewer other lands" (the fastland cycle)',
    pattern:
      /^~ enters(?: the battlefield)? tapped unless you control (\w+) or fewer other lands$/,
    build(match) {
      const max = SMALL_NUMBER_WORDS[match[1]!];
      if (max === undefined) return null; // an unexpected count — report it
      return { entersTappedUnless: { maxOtherLands: max } };
    },
  },
  {
    id: 'enters-tapped-unless-controls-subtype',
    description:
      '"~ enters tapped unless you control a Mountain or a Plains" (the checkland cycle)',
    pattern:
      /^~ enters(?: the battlefield)? tapped unless you control an? (\w+)(?: or an? (\w+))?$/,
    build(match) {
      const subtypes = [match[1], match[2]].filter((s): s is string => Boolean(s));
      // Only LAND subtypes are expressible: "unless you control a creature"
      // reads the same but means something this rule does not implement.
      if (!subtypes.every((subtype) => LAND_SUBTYPES.has(subtype))) return null;
      return { entersTappedUnless: { controlsSubtype: subtypes } };
    },
  },
]);

/** Number words a printed "N or fewer" uses. */
const SMALL_NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
});

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
  {
    // Modal cards are the one choice shape still genuinely missing a system: the
    // engine picks a spell's targets at cast with no modes declared, so a mode
    // that needs its own target can only be offered when the cast happens to have
    // one. (Everything else a "choose / you may" clause needs — the question, the
    // ordering, the search — the engine has; see `../choice-primitives.ts`.)
    pattern: /^choose (?:one|two|three|up to)\b|^choose one or both\b/,
    missingEngineSystem: 'modal spells (modes chosen at cast, with their own targets)',
  },
  {
    pattern: /\byou may\b|\bchoose\b|\bchooses\b|discards? a card|\bdiscards\b/,
    missingEngineSystem: 'a "you may / choose" template the compiler does not recognize yet',
  },
  {
    pattern: /\bsearch your library\b|\bsearch their library\b/,
    missingEngineSystem: 'a library-search template the compiler does not recognize yet',
  },
  { pattern: /\bscry\b|\bsurveil\b|look at the top/, missingEngineSystem: 'looking at and reordering library cards' },
  { pattern: /\bloyalty\b|^[+-]\d+:/, missingEngineSystem: 'planeswalker loyalty abilities' },
  { pattern: /\btransform\b|\bflip\b|double-faced/, missingEngineSystem: 'transform / double-faced cards' },
  { pattern: /\bflashback\b|\bflash\b/, missingEngineSystem: 'flash timing and graveyard recasting' },
  { pattern: /\bequip\b|\battach\b|\benchant\b/, missingEngineSystem: 'auras and equipment attachment' },
  { pattern: /\bsacrifice\b/, missingEngineSystem: 'sacrifice costs and activated abilities' },
  { pattern: /\bcounters? on\b|\b\+1\/\+1 counter/, missingEngineSystem: 'persistent counters beyond +1/+1 pumps' },
  { pattern: /\bexiles?\b.*\bgraveyard\b|\bgraveyard\b/, missingEngineSystem: 'graveyard-based abilities with a chooser' },
  {
    // Plain "target player mills N" and "you mill N" COMPILE now. What still
    // lands here is a mill whose count is derived or conditional, so the hint
    // names the template gap rather than claiming milling is missing entirely.
    pattern: /\bmill\b|puts? the top .* into (?:their|his or her) graveyard/,
    missingEngineSystem: 'a mill template the compiler does not recognize yet',
  },
  { pattern: /\bcan't be blocked\b|\bmenace\b|\bmust be blocked\b/, missingEngineSystem: 'blocking restrictions beyond evasion keywords' },
  { pattern: /\bward\b|\bhexproof\b|\bshroud\b|\bprotection from\b/, missingEngineSystem: 'targeting restrictions (hexproof / ward / protection)' },
  { pattern: /\bcycling\b|\bkicker\b|\bbuyback\b|\bmadness\b/, missingEngineSystem: 'alternative and additional casting costs' },
  { pattern: /\{x\}|\bx damage\b|\bequal to\b/, missingEngineSystem: 'variable ({X}) and derived values' },
  { pattern: /\bactivated abilit|\{t\}:|\{\d+\}[,:]/, missingEngineSystem: 'activated abilities with costs' },
  // --- below here: patterns that only refine the DEFAULT explanation. Nothing
  // above changes; these exist so "this card didn't compile" names a buildable
  // engine feature instead of shrugging. They are ordered specific → general,
  // and each one was written because a batch of real cards landed on it (see
  // `../../data/expansion-report.json`).
  {
    pattern: /\bcascade\b|\bevoke\b|\bsuspend\b|\bbattle cry\b|\binvestigate\b|fateful hour/,
    missingEngineSystem: 'named keyword mechanics with their own subsystem',
  },
  {
    pattern: /damage to each (?:creature|player|opponent)|to each of|damage to you\b/,
    missingEngineSystem: 'a group-damage template the compiler does not recognize yet',
  },
  // NOTE: there is deliberately no "bounce" hint any more. Plain bounce compiles
  // (see the `return-target-permanent-to-hand` rule), so a bounce clause that
  // still fails does so for some OTHER reason — most often that it sits inside a
  // trigger, and a triggered ability cannot choose targets. Letting it fall
  // through to that hint names the real blocker instead of a solved one.
  {
    pattern: /gain control of target/,
    missingEngineSystem: 'gaining control of another player’s permanent',
  },
  { pattern: /\bfights?\b/, missingEngineSystem: 'a fight template the compiler does not recognize yet' },
  {
    // `TargetRestriction` CAN now say "a player who isn't you" ('opponent'), so
    // what still lands here is an opponent-targeting template with no rule yet —
    // not a missing engine capability.
    pattern: /\btarget opponent\b/,
    missingEngineSystem: 'an opponent-targeting template the compiler does not recognize yet',
  },
  {
    pattern: /unless (?:its controller|that player|you) pays?/,
    missingEngineSystem: 'optional payment during resolution ("unless its controller pays")',
  },
  {
    pattern: /leaves the battlefield/,
    missingEngineSystem: 'leaves-the-battlefield triggers',
  },
  {
    pattern: /(?:other )?creatures you control (?:get|have)|as long as you control|creatures? you control gets?/,
    missingEngineSystem: 'static continuous effects (anthems and conditional buffs)',
  },
  {
    // "Destroy target artifact or creature", "Counter target creature spell",
    // "Destroy target nonlegendary creature" — the effect exists, the FILTER on
    // what may be chosen does not.
    pattern: /^(?:destroy|exile|counter) target \S/,
    missingEngineSystem: 'targeting filtered by card type or quality (artifact / noncreature / nonlegendary / with flying)',
  },
  {
    // A trigger body that names a target. Core resolves triggered abilities with
    // an empty target list, so these cannot be compiled without the same decision
    // seam "player choice during resolution" needs.
    pattern: /^(?:when|whenever)\b.*\btarget\b/,
    missingEngineSystem: 'targets chosen by a triggered ability',
  },
  {
    pattern: /\bdraws? (?:a|two|three|\d+) cards? and (?:you )?loses? \d+ life/,
    missingEngineSystem: 'compound "draw N and lose M" in one sentence',
  },
]);

/** Find the best explanation for an unimplementable clause. */
export function explainUnsupported(clause: string): string {
  for (const hint of UNSUPPORTED_HINTS) {
    if (hint.pattern.test(clause)) return hint.missingEngineSystem;
  }
  return 'a rules template the compiler does not recognize yet';
}
