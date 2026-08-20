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
  backFaceCastZonesOf,
  castPermissionFor,
  hasCastableBackFace,
  isSplitCard,
  modalSpecOf,
  playableFaceOf,
} from '@jonny-boi/core';
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
  | { readonly kind: 'oracle'; readonly text: string; readonly as: 'creature' | 'instant' }
  /**
   * `engine` — a named capability the CORE engine exports, for a mechanic whose
   * evidence is a rules SEAM rather than a compiler rule or a primitive. Modal
   * double-faced cards are the case that needed it: nothing about "the back face
   * is castable" lives in a rule table or a primitive id, so a rule/primitive
   * witness would have been a claim about the wrong thing.
   */
  | { readonly kind: 'engine'; readonly api: keyof typeof CORE_ENGINE_API };

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
        title: 'Counters matter',
        detail:
          'The counters-matter family plays as printed: "put a +1/+1 counter on each creature you control" counts exactly the printed set (and refuses a phrase the filter cannot express, like "each ATTACKING creature"), creatures grow off life gain, spells cast, deaths, combat damage and other creatures entering, an {X} creature really enters with X counters on it, and a static can read "creatures you control with +1/+1 counters on them cannot be blocked".',
        witness: { kind: 'rule', id: 'put-counters-on-each' },
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
        title: 'Modal mana sources',
        detail:
          'A source that taps for a CHOICE adds one mode per tap, picked when you tap it — a dual land’s two colours, "one mana of any color", or Gilded Lotus’s three-of-one-colour.',
        witness: { kind: 'rule', id: 'tap-for-n-of-any-one-color' },
      },
      {
        title: 'Mana abilities with a price',
        detail:
          'A mana ability may charge more than the tap and may do more than add mana. "{T}, Pay 1 life: Add one mana of any color" (Mana Confluence, the horizon lands) charges the life and is not offered when you cannot pay it; a filter land’s "{W/U}, {T}:" consumes its input before producing; a pain land’s "…deals 1 damage to you" is a RIDER, not a cost, so the land still works at 1 life and can kill you. None of it uses the stack (CR 605.3a), and the shared payment planner prefers the painless source when both close the same shortfall.',
        witness: { kind: 'rule', id: 'mana-ability-with-rider' },
      },
      {
        title: 'Conditional and board-derived mana',
        detail:
          '"Activate only if you control an Island / a red permanent / three or more artifacts" (Nimbus Maze, the Verge cycle, Mox Opal) is checked when the ability is OFFERED, so an unmet condition makes the source invisible to the payment planner rather than refusing after it has been counted on. Reflecting Pool and Exotic Orchard read their colours off the live board every time — never frozen when the card compiles — and two of them see each other as producing nothing rather than looping.',
        witness: { kind: 'rule', id: 'mana-ability-activation-restriction' },
      },
      {
        title: 'Mana you may spend on only one thing',
        detail:
          'Ancient Ziggurat, Somberwald Sage, Eldrazi Temple, Giada and Power Depot print a restriction on the MANA rather than on the source: "Spend this mana only to cast a creature spell", "…only to cast artifact spells or activate abilities of artifacts". The floating pool carries it, so casting, activating an ability, cycling and a filter land’s own cost each ask what the mana is being spent on — and a spell it may not pay for is not offered at all. Mana you cannot spend still counts as floating and still empties at end of step, exactly like any other. The shared payment planner spends the restricted mana FIRST when it legally can, because it is the least flexible resource on the board.',
        witness: {
          kind: 'oracle',
          text: '{T}: Add one mana of any color. Spend this mana only to cast a creature spell.',
          as: 'creature',
        },
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
          'An affordable kicker is offered as a cast-time payment; a caster who cannot pay is never asked. The kicked half runs only when it was paid (Burst Lightning).',
        witness: { kind: 'rule', id: 'kicker-cost' },
      },
      {
        title: 'Multikicker',
        detail:
          'An additional cost payable any number of times: the caster is asked HOW MANY, bounded by what the board can actually fund, and charged once. "For each time it was kicked" reads the count — during the spell\'s own resolution and afterwards, from the permanent it became.',
        witness: { kind: 'rule', id: 'multikicker-cost' },
      },
      {
        title: 'Modal spells ("Choose one —")',
        detail:
          'Modes are announced as the spell is CAST, and each chosen mode is aimed at cast too — so the opponent decides whether to respond already knowing which halves are coming, exactly as in paper. A mode with no legal target is not on the menu; chosen modes resolve in printed order, each against its own target. "Choose one or both", "choose up to N" and "you may choose the same mode more than once" all play as printed (Cryptic Command).',
        witness: { kind: 'card', name: 'Cryptic Command' },
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
          'Each restriction is enforced where it is expressible: "can\'t be blocked" and "~ can\'t block" per pair, while menace — and its general form "can\'t be blocked except by three or more creatures" — judges the whole block declaration, because every blocker is individually legal and only the count is not. Block REQUIREMENTS ("must be blocked if able") are not implemented, and a card printing one says so rather than playing without it.',
        witness: { kind: 'keyword', word: 'menace' },
      },
      {
        title: 'Granted evasion',
        detail:
          '"Target creature can\'t be blocked this turn" is the ordinary until-end-of-turn keyword grant, so it expires at cleanup through the same path a pump does (Rogue\'s Passage, Whirler Rogue, Enter the Enigma).',
        witness: { kind: 'rule', id: 'grant-unblockable-until-eot' },
      },
      {
        title: 'Indestructible',
        detail:
          'Effects that say "destroy" and lethal damage — deathtouch included — leave it alone. Nothing else does: 0 toughness still puts it into the graveyard (a different state-based action, which the keyword does not mention), a sacrifice still takes it, and exile still removes it.',
        witness: { kind: 'keyword', word: 'indestructible' },
      },
      {
        title: 'Granted indestructible, one creature or the whole team',
        detail:
          'Heroic Intervention\'s "permanents you control gain hexproof and indestructible until end of turn" and Darksteel Forge\'s "artifacts you control have indestructible" both reach the destroy rules — a granted keyword is not a second-class one.',
        witness: { kind: 'primitive', id: 'grantKeywordToYoursUntilEndOfTurn' },
      },
      {
        title: 'Flash timing',
        detail: 'A flash card casts whenever an instant could.',
        witness: { kind: 'keyword', word: 'flash' },
      },
      {
        title: 'Flashback',
        detail:
          'A "Flashback {cost}" instant or sorcery casts from your graveyard for that cost — honoring its normal timing — and is exiled as it leaves the stack, even when countered (CR 702.34a). All three printed cost shapes work: plain mana, "Flashback {X}{R}{R}" (the X is asked and charged at cast), and "Flashback—{1}{U}, Pay 3 life". A non-life rider (a discard, a sacrifice) still reports.',
        witness: { kind: 'rule', id: 'flashback-cost' },
      },
      {
        title: 'Cycling',
        detail:
          'A "Cycling {cost}" card is an activated ability of a card in your HAND: pay the cost, discard the card as part of it, draw a card. Instant speed, so a cycling land turns into a card on an opponent turn. The discard is a COST, which is what lets it feed madness and a "whenever you cycle or discard" trigger. An {X} cycling cost still reports.',
        witness: { kind: 'rule', id: 'cycling-cost' },
      },
      {
        title: 'Typecycling and landcycling',
        detail:
          'The same mechanism with a different reward: "Plainscycling {2}" / "Landcycling {2}" search your library for a card of that type instead of drawing. Only words the card filter can genuinely select compile — the five basic land types and the generic "land"; anything else reports rather than fetching approximately the right card.',
        witness: { kind: 'rule', id: 'typecycling-cost' },
      },
      {
        title: 'Buyback',
        detail:
          'An optional additional cost asked at cast time, exactly like a kicker. Pay it and the card returns to your HAND as it resolves instead of going to the graveyard (CR 702.27a) — and only as it resolves: a bought-back spell that is countered goes to the graveyard like any other. Both answers come from the one helper that also decides where a flashback card goes, so the two can never disagree.',
        witness: { kind: 'rule', id: 'buyback-cost' },
      },
      {
        title: 'Madness',
        detail:
          'Discarding a madness card exiles it instead, and you may then cast it for its madness cost — from either discard funnel (a cost, or an effect), ignoring the timing printed on the card, with mana abilities still legal so you can pay. Passing declines and puts it in the graveyard the discard would have used. A madness cost printed in words ("Madness—Pay six {C}") still reports.',
        witness: { kind: 'rule', id: 'madness-cost' },
      },
      {
        title: 'Granted flashback (Snapcaster Mage)',
        detail:
          'An effect can give a card in your GRAVEYARD flashback until end of turn, for the mana cost printed on that card. The ability targets the graveyard card as it goes on the stack (so it fizzles if the card leaves in response), the grant is scoped to that one card, it expires at end of turn, and it stops applying the moment the card changes zones (CR 400.7). Casting on the grant exiles the card exactly as a printed flashback does.',
        witness: { kind: 'rule', id: 'grant-flashback-to-graveyard-spell' },
      },
      {
        title: 'Targeting a card in a graveyard',
        detail:
          'An ability can point at an instant or sorcery card in the graveyard of the player who controls it — the first targeting that reaches outside the battlefield, offered and re-checked exactly like every other target kind.',
        witness: { kind: 'primitive', id: 'grantFlashback' },
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
          'Unconditional taplands, plus every conditional cycle: "unless you control two or fewer other lands" (fastlands), "unless you control a <basic type>" (checklands), "unless you control two or more other lands" (slowlands) and "unless you control two or more basic lands" (battlelands, which count the printed Basic supertype, so a nonbasic dual does not qualify).',
        witness: { kind: 'rule', id: 'enters-tapped-unless-few-lands' },
      },
      {
        title: 'Lands that ask a question as they enter',
        detail:
          'A shockland asks "pay 2 life?" and a reveal-land asks "show a Plains or Island card from your hand?" — both at land-play time, both real questions with two legal answers, and both defaulting to the printed "if you don\'t" (tapped) on any path that cannot ask. A controller with nothing to reveal is not asked at all.',
        witness: { kind: 'rule', id: 'enters-tapped-unless-revealed' },
      },
      {
        title: '"As ~ enters, choose a creature type / a color"',
        detail:
          'The naming a permanent makes on the way in (CR 614.1c), asked at the printed moment — while a land is being played, or while a permanent spell is resolving and the card is not yet on the battlefield. The answer is REMEMBERED on that permanent for as long as it is there, which is the whole point: Adaptive Automaton becomes the type it named and pumps the others of it, Coldsteel Heart taps for the colour it named, and Chronicle of Victory draws off the type it named. A permanent that enters where nobody can be asked — reanimated, put onto the battlefield by another card, copied as a token — names NOTHING, and nothing named matches nothing.',
        witness: { kind: 'primitive', id: 'chooseAsEnters' },
      },
      {
        title: '"Of the chosen type / color" — reading a named value back',
        detail:
          'The three readers that make a naming worth making: an anthem narrowed to the named type or colour ("creatures you control of the chosen type get +1/+1"), a mana ability that adds the named colour, and a cast trigger that fires only on the named type. Each is refused at compile time on a card that never names anything, because an anthem over a value nothing writes is a card that reports as playable and then does nothing.',
        witness: { kind: 'rule', id: 'as-enters-choose-value' },
      },
      {
        title: 'Optional triggers ("you may")',
        detail:
          'The printed "you may" is a genuine yes/no asked as the ability resolves, and declining is a complete outcome — never auto-answered to make a card compile, because a forced yes is a different card. Reclamation-Sage-style entries, the Mage cycle\'s tutors and Farhaven Elf all play both ways.',
        witness: { kind: 'primitive', id: 'mayEffects' },
      },
      {
        title: 'Step-beginning triggers, in every printed scope',
        detail:
          'Upkeep, draw step, first main phase, end step and combat all carry triggers, and so do the shared forms — "each player\'s", "each opponent\'s" and the bare "each". The player whose step it is rides the ability into its resolution, so a body can say "that player": Howling Mine, Kami of the Crescent Moon, Dictate of Kruphix, Font of Mythos and Teferi\'s Puzzle Box all draw for the RIGHT seat instead of for their controller.',
        witness: { kind: 'rule', id: 'trigger-step-begins' },
      },
      {
        title: 'The intervening "if"',
        detail:
          'A trigger\'s printed condition ("…, if this artifact is untapped, …", "…, if you control six or more lands, …") is checked at BOTH moments the rules require: a false condition stops the ability going on the stack at all, and one that lapses before it resolves removes it doing nothing. A power bound reads EFFECTIVE power, so counters and anthems count. A condition the compiler cannot read makes its card report — never a body compiled as though the condition were not printed.',
        witness: { kind: 'oracle', text: 'At the beginning of your upkeep, if you control six or more lands, create a 5/5 red Dragon creature token with flying.', as: 'creature' },
      },
      {
        title: '"That player" / "each player" bodies',
        detail:
          'A trigger body can happen to somebody other than its controller through one shared vocabulary — "each player draws a card and loses 1 life" (Stormfist Crusader), "each opponent loses 1 life", and the "that player" forms a scoped trigger points at. "Whenever a player draws a card" watches every draw in the game, which is what makes Spiteful Visions and Scrawling Crawler real cards.',
        witness: { kind: 'rule', id: 'trigger-draws-card' },
      },
      {
        title: 'Board-watching triggers',
        detail:
          '"Whenever a creature you control [with power 3 or greater] enters/dies" watches the battlefield through the same card filter every other chooser reads, so the printed restriction is honoured rather than dropped. Ajani\'s Welcome, Elemental Bond, Grave Pact and Dictate of Erebos all play.',
        witness: { kind: 'rule', id: 'trigger-permanent-enters-or-dies' },
      },
      {
        title: 'Filtered library tutors',
        detail:
          'A search to hand may be narrowed by card type, printed subtype, mana value or printed power/toughness ("an artifact card with mana value 1 or less", "a creature card with toughness 2 or less"). A restriction the filter cannot express reports instead — a tutor that ignored its bound would fetch the best card in the deck.',
        witness: { kind: 'rule', id: 'search-to-hand-by-filter' },
      },
      {
        title: 'Transforming double-faced cards',
        detail:
          'Innistrad-style DFCs play both faces: the front casts, a transform instruction flips the permanent to its back face (Delver of Secrets reveals for its 3/2 flyer), counters/damage/Auras persist across the flip (CR 712), and a bounced or killed DFC turns front-face-up again.',
        witness: { kind: 'primitive', id: 'transformRevealTop' },
      },
      {
        title: 'Modal double-faced cards',
        detail:
          'A modal DFC is one card with two CASTABLE halves — unlike a transforming DFC, whose back face is only ever reached by a transform instruction. Either face may be cast (or played, when the back is a land, counting as your land drop) with that face\'s own cost, timing, targets and script; the card reverts to its front face whenever it leaves the battlefield.',
        witness: { kind: 'engine', api: 'hasCastableBackFace' },
      },
      {
        title: 'Split cards (Fire // Ice)',
        detail:
          'One card, two halves, either castable for its own cost. While it sits in a hand, graveyard or library it is NEITHER half: CR 709.4 gives it the combined name, the union of the type lines and a mana value equal to the sum of both — which is what a discard filter or a "mana value 3 or less" clause reads. Casting one puts THAT half on the stack, and the card reverts to the combined object on the way out.',
        witness: { kind: 'engine', api: 'isSplitCard' },
      },
      {
        title: 'Aftermath (Dusk // Dawn)',
        detail:
          'The second half of an aftermath card is castable ONLY from your graveyard (CR 702.127a), never from your hand, and it pays its own printed cost rather than a flashback cost it does not print. It is exiled after it resolves — the same one answer that exiles a flashback spell, so the two can never disagree.',
        witness: { kind: 'engine', api: 'backFaceCastZonesOf' },
      },
      {
        title: 'Adventures (Bonecrusher Giant // Stomp)',
        detail:
          'Cast the adventure half as an instant or sorcery and, when it RESOLVES, the card is exiled instead of being buried — with permission for its owner to cast the creature half from exile later (CR 715.3d). Countered, it goes to the graveyard like anything else and the creature is gone. The permission names one face, dies with the object if the card ever leaves exile (CR 400.7), and a Town // Adventure card whose primary half is a land is PLAYED from exile as your land drop.',
        witness: { kind: 'engine', api: 'castPermissionFor' },
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
      {
        title: 'Battles (Sieges)',
        detail:
          "Battles enter with their printed defense counters and are attacked through the very same seam planeswalkers use. A battle is defended by its PROTECTOR — its controller's opponent — so you attack your own Siege, and their creatures block. Combat damage and \"any target\" burn alike strip defense counters, trample carries the excess to the defender, and removing the last counter defeats it. A defeated SIEGE is exiled rather than buried, and its controller may then cast its reward half from exile without paying its mana cost (CR 310.4).",
        witness: { kind: 'primitive', id: 'createEmblem' },
      },
      {
        title: 'The legend rule',
        detail:
          "Controlling two or more legendary permanents with the same name makes YOU choose which to keep — not the game, and not your opponent — with the rest going to their owners' graveyards as a state-based action. One shared rule covering legendary creatures, planeswalkers and battles alike, applied per player: you and your opponent may each hold your own copy quite legally.",
        witness: { kind: 'card', name: 'Liliana of the Veil' },
      },
      {
        title: 'Emblems',
        detail:
          "A planeswalker ultimate's emblem lives in the command zone with its statics and triggers fully live from there — and nothing in the game can remove it, because no removal path reaches outside the battlefield. It survives a board wipe and keeps buffing whatever arrives afterwards.",
        witness: { kind: 'rule', id: 'emblem-with-ability' },
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

/**
 * The core rules seams an `engine` witness may name. A named map rather than a
 * free string, so a claim can only cite a capability that is really imported —
 * a deleted seam becomes a compile error here, not a silently-passing witness.
 */
const CORE_ENGINE_API = {
  /** A card declares a second, CASTABLE face (a modal DFC, a split half). */
  hasCastableBackFace,
  /** Which face a cast/play action names. */
  playableFaceOf,
  /** A card's printed modal header + modes. */
  modalSpecOf,
  /** The definition is a SPLIT card's combined object, not a castable spell. */
  isSplitCard,
  /** Which zones a castable back half may be cast FROM (aftermath, a Siege). */
  backFaceCastZonesOf,
  /** Permission to cast a card out of exile (an adventure, a defeated Siege). */
  castPermissionFor,
} as const;

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
    case 'engine':
      return typeof CORE_ENGINE_API[witness.api] === 'function';
  }
}
