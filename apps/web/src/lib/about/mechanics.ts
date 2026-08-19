/**
 * The About view's single source of truth for "which MTG mechanics can this app
 * actually play, and which are still to do?".
 *
 * Almost everything here is DERIVED from registries the app already ships — the
 * Oracle-compiler rule tables, its keyword map, its unsupported-hint list, the
 * effect-primitive libraries and the card pool — so the page updates itself the
 * moment a mechanic lands or a rule is added, with no prose copy to go stale.
 *
 * The one hand-written piece is {@link SUPPORTED_MECHANIC_GROUPS}: readable
 * system names need human words. It is kept honest the same way the card index
 * is: every entry names a WITNESS — a compiler rule id, an effect primitive, a
 * keyword, a pool card, or a snippet of real Oracle text that must compile
 * `'complete'` — and `mechanics.test.ts` resolves every witness on every
 * `npm test`. A claim whose witness disappears fails the suite, so this list
 * cannot describe an engine that no longer exists (CLAUDE.md: stale docs are
 * bugs; a capabilities page that lies is the worst kind).
 */

import {
  CARD_POOL,
  CHOICE_PRIMITIVES,
  CORE_PRIMITIVES,
  EFFECT_RULES,
  KEYWORD_FLAGS,
  MANA_RULES,
  STATIC_RULES,
  STUBBED_MECHANICS,
  TRIGGER_RULES,
  TYPES_WITHOUT_SYSTEM,
  UNSUPPORTED_HINTS,
  compileCard,
  type CompilableCard,
  type CompileRule,
} from '@jonny-boi/cards';

/**
 * Proof that a supported-mechanic claim is still true, resolvable against the
 * live registries (see {@link resolveWitness}):
 *  - `rule`      — a compiler rule with this id exists in one of the rule tables.
 *  - `primitive` — an effect primitive with this id is registered.
 *  - `keyword`   — this printed keyword is in the compiler's keyword map.
 *  - `card`      — a card with this name is in the engine pool (for mechanics
 *                  whose evidence is data, e.g. a hybrid mana cost).
 *  - `oracle`    — this real printed text must compile `'complete'`, i.e. the
 *                  engine genuinely plays it (the strongest form).
 */
export type MechanicWitness =
  | { readonly kind: 'rule'; readonly id: string }
  | { readonly kind: 'primitive'; readonly id: string }
  | { readonly kind: 'keyword'; readonly word: string }
  | { readonly kind: 'card'; readonly name: string }
  | { readonly kind: 'oracle'; readonly text: string; readonly as: 'creature' | 'instant' };

/** One supported mechanic, in user-facing words, with its proof. */
export interface SupportedMechanic {
  readonly title: string;
  readonly detail: string;
  readonly witness: MechanicWitness;
}

/** A themed group of supported mechanics, in display order. */
export interface SupportedMechanicGroup {
  readonly title: string;
  readonly mechanics: readonly SupportedMechanic[];
}

/**
 * What the engine plays today, grouped for reading. Every entry is pinned by
 * its witness — add the mechanic first, then the claim.
 */
export const SUPPORTED_MECHANIC_GROUPS: readonly SupportedMechanicGroup[] = [
  {
    title: 'The rules engine',
    mechanics: [
      {
        title: 'Turn structure, priority & the stack',
        detail:
          'Untap → upkeep → draw → mains → combat → end; both players pass priority; spells and abilities resolve last-in-first-out, so responses and counterspells work as printed.',
        witness: { kind: 'primitive', id: 'counterSpell' },
      },
      {
        title: 'Combat',
        detail:
          'Declared attackers and blockers, ordered damage with first/double strike, and the full combat-keyword set below.',
        witness: { kind: 'keyword', word: 'double strike' },
      },
      {
        title: 'State-based actions',
        detail:
          'Lethal damage, zero toughness, zero life, drawing from an empty library, and illegally-attached Auras/Equipment are all checked continuously, exactly as the rules order them.',
        witness: { kind: 'card', name: 'Dead Weight' },
      },
      {
        title: 'Mana: costs, pools & payment planning',
        detail:
          'Colored, generic and colorless costs, colour/colour hybrid ({G/W}), fixed and modal producers ("Add {W} or {U}", "any color"), and an exact payment planner shared by every pilot.',
        witness: { kind: 'card', name: 'Kitchen Finks' },
      },
      {
        title: 'Triggered abilities',
        detail:
          'Enters-the-battlefield, attacks, dies, leaves, upkeep and cast triggers go on the stack and resolve like spells.',
        witness: { kind: 'rule', id: 'trigger-etb' },
      },
      {
        title: 'Targets chosen by a triggered ability',
        detail:
          'A trigger that names a target ("When ~ enters, it deals 4 damage to target creature") chooses it when the trigger goes on the stack, as the rules require.',
        witness: {
          kind: 'oracle',
          text: 'When Flametongue Kavu enters, Flametongue Kavu deals 2 damage to target creature.',
          as: 'creature',
        },
      },
      {
        title: 'Continuous effects & counters',
        detail:
          'Until-end-of-turn pumps and keyword grants that genuinely wear off at cleanup, +1/+1 and -1/-1 counters, and an anthem-style static layer, all stacking in documented order.',
        witness: { kind: 'primitive', id: 'addCounters' },
      },
      {
        title: 'Player choices during resolution',
        detail:
          'Spells can ask questions mid-resolution — select cards or players, choose modes, confirm a "you may", search the library — and the same mechanism serves the AI, hotseat play and online play.',
        witness: { kind: 'primitive', id: 'searchLibrary' },
      },
      {
        title: 'Optional payment during resolution',
        detail:
          '"…unless its controller pays {1}" — Mana Leak and Force Spike play as printed, and a player who cannot pay is never asked.',
        witness: { kind: 'rule', id: 'counter-target-spell-unless-pays' },
      },
      {
        title: 'Activated abilities',
        detail: 'Abilities with {T} and mana costs, funded through the same payment planner as spells.',
        witness: { kind: 'rule', id: 'equip-cost' },
      },
      {
        title: '{X} costs',
        detail:
          'Casting an {X} spell asks the caster to choose X — the range bounded by what the board can actually pay — charges it, and the resolved effect reads the chosen value (Blaze, Mind Spring). X = 0 is a legal cast.',
        witness: { kind: 'rule', id: 'x-damage' },
      },
      {
        title: '{X} as an optional payment',
        detail:
          '"Counter target spell unless its controller pays {X}" (Condescend) — the X the caster chose and paid for becomes the price the victim is asked, and an X of zero is a cost everybody pays, so the spell simply resolves.',
        witness: { kind: 'rule', id: 'counter-target-spell-unless-pays-x' },
      },
      {
        title: 'Kicker',
        detail:
          'An affordable kicker is offered as a cast-time payment; a caster who cannot pay is never asked. The kicked half runs only when it was paid (Burst Lightning). Multikicker still reports.',
        witness: { kind: 'rule', id: 'kicker-cost' },
      },
    ],
  },
  {
    title: 'Card mechanics',
    mechanics: [
      {
        title: 'Auras & Equipment',
        detail:
          'One attachment relationship covers both: an Aura dies when its host is illegal (CR 704.5m), Equipment falls off and stays (CR 704.5n), and grants layer with anthems and pumps.',
        witness: { kind: 'primitive', id: 'attachToTarget' },
      },
      {
        title: 'Targeting restrictions',
        detail:
          'Hexproof and shroud, plus per-effect restrictions — creature / player / spell / opponent / "creature you control" — enforced at offer, at cast, and again at resolution.',
        witness: { kind: 'keyword', word: 'hexproof' },
      },
      {
        title: 'Protection from [quality]',
        detail:
          'All four halves, keyed on the source: can\'t be targeted, can\'t be dealt damage (combat and noncombat), can\'t be enchanted or equipped, and can\'t be blocked, by sources with the named color, colorless/multicolored, artifacts, creatures, or everything. Granted protection layers through continuous effects and wears off at cleanup.',
        witness: { kind: 'rule', id: 'grant-protection-until-eot' },
      },
      {
        title: 'Ward {N}',
        detail:
          'Targeting an opponent\'s warded permanent triggers "counter unless you pay {N}", asked through the same optional-payment machinery as Mana Leak — and a player who cannot pay is never asked. Fires on spells and on targeted abilities alike.',
        witness: { kind: 'primitive', id: 'wardCounterUnlessPaid' },
      },
      {
        title: 'Blocking restrictions',
        detail:
          'Menace judges the whole block declaration (not any single pair), and "can\'t be blocked" is enforced per pair.',
        witness: { kind: 'keyword', word: 'menace' },
      },
      {
        title: 'Flash timing',
        detail: 'A flash card casts whenever an instant could.',
        witness: { kind: 'keyword', word: 'flash' },
      },
      {
        title: 'Flashback',
        detail:
          'A "Flashback {cost}" instant or sorcery casts from your graveyard for that cost — honoring its normal timing — and is exiled as it leaves the stack, even when countered (CR 702.34a). Plain mana costs only; {X}/additional-cost flashback still reports.',
        witness: { kind: 'rule', id: 'flashback-cost' },
      },
      {
        title: 'Prowess',
        detail: 'Modelled exactly: a cast trigger per noncreature spell that pumps until end of turn.',
        witness: { kind: 'card', name: 'Monastery Swiftspear' },
      },
      {
        title: 'Characteristic-defining P/T (the star box)',
        detail:
          "A creature whose printed power/toughness is a formula plays at its real size: Tarmogoyf is the number of card types among cards in all graveyards, toughness that number plus one. It is applied in the rules' own layer 7a — BEFORE +1/+1 counters and pumps, so a counter adds on top — and re-derived on every read, so it grows the instant a fetchland fills a graveyard mid-combat.",
        witness: { kind: 'rule', id: 'characteristic-defining-pt' },
      },
      {
        title: 'Turn-scoped memory (revolt)',
        detail:
          'The engine remembers a short, named list of things that happened this turn — a permanent you controlled left the battlefield (revolt), a creature died, you gained life — and clears it as each turn begins. Fatal Push reads revolt when it RESOLVES, so a fetchland cracked in response turns its four-mana-value mode on.',
        witness: { kind: 'rule', id: 'destroy-creature-mana-value-revolt' },
      },
      {
        title: 'Coloured anthems & card filters',
        detail:
          '"White creatures you control get +1/+1" narrows by colour, read from the card’s mana pips exactly as protection reads it — and the same filter serves every other chooser (searches, discards, sacrifices), not just statics.',
        witness: { kind: 'rule', id: 'static-buff-your-creatures' },
      },
      {
        title: 'Derived values',
        detail:
          '"…equal to the number of creatures you control" works for damage, draw, life, mill and pumps alike — every numeric parameter reads the same derivation.',
        witness: { kind: 'rule', id: 'damage-equal-to-count' },
      },
      {
        title: 'Lands that enter tapped',
        detail:
          'Unconditional taplands, plus the conditional cycles: "unless you control two or fewer other lands" (fastlands) and "unless you control a <basic type>" (checklands).',
        witness: { kind: 'rule', id: 'enters-tapped-unless-few-lands' },
      },
      {
        title: 'Transforming double-faced cards',
        detail:
          'Innistrad-style DFCs play both faces: the front casts, a transform instruction flips the permanent to its back face (Delver of Secrets reveals for its 3/2 flyer), counters/damage/Auras persist across the flip (CR 712), and a bounced or killed DFC turns front-face-up again.',
        witness: { kind: 'primitive', id: 'transformRevealTop' },
      },
      {
        title: 'Gaining control of a permanent',
        detail: '"Gain control of target creature until end of turn" — Act of Treason effects.',
        witness: { kind: 'rule', id: 'gain-control-until-eot' },
      },
      {
        title: 'Anthems (static buffs)',
        detail:
          '"[Other] creatures you control get +1/+1" and keyword-granting statics ("…have haste") compile onto the continuous layer, so the buff exists exactly while its source is on the battlefield.',
        witness: { kind: 'rule', id: 'static-buff-your-creatures' },
      },
      {
        title: 'Planeswalkers & loyalty',
        detail:
          'Walkers enter at printed loyalty; +N/−N abilities are sorcery-speed, once per walker per turn; creatures attack them, "any target" burns them, and 0 loyalty is death by state-based action. Liliana of the Veil plays all three abilities as printed.',
        witness: { kind: 'card', name: 'Liliana of the Veil' },
      },
    ],
  },
  {
    title: 'Spells & effects',
    mechanics: [
      {
        title: 'Removal & exile',
        detail: 'Destroy, exile, board wipes, and minus-counter shrink effects.',
        witness: { kind: 'primitive', id: 'destroyAll' },
      },
      {
        title: 'Burn & group damage',
        detail:
          'Damage to any target, to each creature, to each opponent, or to everything — with deathtouch, trample and lifelink applied.',
        witness: { kind: 'primitive', id: 'dealDamageToEach' },
      },
      {
        title: 'Tokens',
        detail: 'Creature tokens with their own printed stats, subtypes and keywords.',
        witness: { kind: 'primitive', id: 'createToken' },
      },
      {
        title: 'Card flow',
        detail:
          'Draw, discard (targeted discard of the victim\'s choosing, Mind Rot-style, or where the caster chooses, Thoughtseize-style), bounce, and graveyard recursion — whole-graveyard or restricted by card type.',
        witness: { kind: 'rule', id: 'return-target-card-from-graveyard' },
      },
      {
        title: 'Library manipulation',
        detail:
          'Brainstorm-style ordered put-backs, Ponder-style look-and-reorder, optional shuffles, reveals, and fetch-style searches that respect land subtypes.',
        witness: { kind: 'rule', id: 'fetch-land-by-subtype' },
      },
      {
        title: 'Scry & surveil',
        detail:
          'Scry N looks at the top N cards and splits them any way you like between the top (in the order you choose to draw them) and the bottom; Surveil N does the same with your graveyard instead of the bottom. Both play as riders too ("…, then scry 2") and as enters-the-battlefield triggers, which is what makes the Temple and Undercity-Sewers land cycles real cards. The look is private — the log records only how many cards were seen.',
        witness: { kind: 'rule', id: 'scry-n' },
      },
      {
        title: 'Ramp & sacrifice-fetch',
        detail:
          '"Search your library for a basic land card, put it onto the battlefield tapped, then shuffle" — as a spell (Rampant Growth) or funded by a sacrifice-self activated ability (Sakura-Tribe Elder).',
        witness: { kind: 'rule', id: 'search-basic-land-to-battlefield' },
      },
      {
        title: 'Mill',
        detail: 'Target-player and self mill.',
        witness: { kind: 'primitive', id: 'mill' },
      },
      {
        title: 'Fighting',
        detail: '"~ fights target creature".',
        witness: { kind: 'primitive', id: 'fight' },
      },
    ],
  },
];

/**
 * The printed combat/timing/targeting keywords the engine enforces, straight
 * from the compiler's keyword map — the exact set a keyword line may use.
 */
export function supportedKeywords(): readonly string[] {
  return Object.keys(KEYWORD_FLAGS);
}

/** One compiler rule table, labelled for display. */
export interface CompilerRuleGroup {
  readonly title: string;
  readonly rules: readonly CompileRule[];
}

/**
 * Every printed template the Oracle compiler recognizes, by table — the live
 * answer to "which rules text can I import and actually play?".
 */
export function compilerRuleGroups(): readonly CompilerRuleGroup[] {
  return [
    { title: 'Spell & ability effects', rules: EFFECT_RULES },
    { title: 'Triggered abilities', rules: TRIGGER_RULES },
    { title: 'Whole-line statics (enters tapped, counters, evasion)', rules: STATIC_RULES },
    { title: 'Mana abilities', rules: MANA_RULES },
  ];
}

/** The compiler's TODO, split by what a gap means. */
export interface TodoMechanics {
  /**
   * Missing ENGINE SYSTEMS — real subsystems nobody has built (emblems,
   * battles, {X} costs…). Implementing one unblocks every card waiting on it.
   * Sourced from the compiler's own hint list plus the card types it cannot
   * represent.
   */
  readonly systems: readonly string[];
  /**
   * TEMPLATE gaps — the engine could play these, but no compiler rule reads
   * the printed wording yet. Cheaper work: usually one rule-table entry.
   */
  readonly templateGaps: readonly string[];
}

/** The wording every template-level (not system-level) hint shares. */
const TEMPLATE_GAP_WORDING = /template the compiler does not recognize yet/;

/**
 * The live TODO list, derived from the same hint table the import UI quotes —
 * when a mechanic lands and its hint is retired, this page updates with it.
 */
export function todoMechanics(): TodoMechanics {
  const systems: string[] = [];
  const templateGaps: string[] = [];
  const seen = new Set<string>();
  const gapNames = [
    ...UNSUPPORTED_HINTS.map((hint) => hint.missingEngineSystem),
    ...Object.values(TYPES_WITHOUT_SYSTEM),
  ];
  for (const name of gapNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    (TEMPLATE_GAP_WORDING.test(name) ? templateGaps : systems).push(name);
  }
  return { systems, templateGaps };
}

/** The curated-pool cards still waiting on a system, verbatim from `cards`. */
export function stubbedPoolCards(): typeof STUBBED_MECHANICS {
  return STUBBED_MECHANICS;
}

/** Headline numbers for the summary strip — all live. */
export interface MechanicsSummary {
  readonly poolCards: number;
  readonly compilerRules: number;
  readonly keywords: number;
  readonly primitives: number;
  readonly missingSystems: number;
  readonly templateGaps: number;
}

export function mechanicsSummary(): MechanicsSummary {
  const todo = todoMechanics();
  return {
    poolCards: CARD_POOL.length,
    compilerRules: compilerRuleGroups().reduce((total, group) => total + group.rules.length, 0),
    keywords: supportedKeywords().length,
    primitives: Object.keys(CORE_PRIMITIVES).length + Object.keys(CHOICE_PRIMITIVES).length,
    missingSystems: todo.systems.length,
    templateGaps: todo.templateGaps.length,
  };
}

/** A minimal real-shaped card wrapped around a witness's Oracle text. */
function witnessCard(text: string, as: 'creature' | 'instant'): CompilableCard {
  return {
    id: `witness-${as}`,
    // The name must appear in the text for self-reference normalization to
    // fold it to `~`, so oracle witnesses quote a real card and borrow its name.
    name: text.match(/^When (\w[\w' -]*?) enters/)?.[1] ?? 'Witness',
    manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
    typeLine:
      as === 'creature'
        ? { supertypes: [], types: ['Creature'], subtypes: [] }
        : { supertypes: [], types: ['Instant'], subtypes: [] },
    oracleText: text,
    power: as === 'creature' ? 2 : null,
    toughness: as === 'creature' ? 2 : null,
    keywords: [],
  };
}

/**
 * True when the witness still resolves against the live registries — the test
 * that keeps {@link SUPPORTED_MECHANIC_GROUPS} from outliving the engine.
 */
export function resolveWitness(witness: MechanicWitness): boolean {
  switch (witness.kind) {
    case 'rule':
      return compilerRuleGroups().some((group) => group.rules.some((rule) => rule.id === witness.id));
    case 'primitive':
      return witness.id in CORE_PRIMITIVES || witness.id in CHOICE_PRIMITIVES;
    case 'keyword':
      return witness.word in KEYWORD_FLAGS;
    case 'card':
      return CARD_POOL.some((card) => card.name === witness.name);
    case 'oracle':
      return compileCard(witnessCard(witness.text, witness.as)).status === 'complete';
  }
}
