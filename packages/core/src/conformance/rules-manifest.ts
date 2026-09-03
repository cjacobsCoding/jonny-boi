/**
 * THE RULES CONFORMANCE MANIFEST — which Comprehensive Rules this engine
 * actually implements, which it deliberately does not, and where it is wrong.
 *
 * Read `manifest-types.ts` first: it explains why this file exists and how it is
 * kept from going stale. In one line: **every CR section in scope is classified
 * here exactly once, and an unclassified section fails the build.**
 *
 * Rule numbers were verified against the official Comprehensive Rules text
 * effective **2026-08-07**. That verification was not a formality — it corrected
 * 24 citations that this repo (tests AND engine source comments) had wrong,
 * including priority living in 117 rather than 116, the mana pool emptying in
 * 500.5 rather than 500.4, copying being 707 rather than 706, and the layer-7
 * sublayers being 613.4 rather than 613.3. A rules index that cites the wrong
 * rule is worse than no index: it is confidently wrong.
 *
 * ## How to add a rule to the suite
 *  1. Write the test in the right `cr*.test.ts` file with `crTest('<rule>', …)`.
 *  2. Add `{ rule, title }` to that section's entry here, matching EXACTLY.
 *  3. If the section was `gap` or `not-applicable`, change its status.
 * Steps 1 and 2 are checked against each other at runtime — the suite fails if
 * either is missing. See TESTING.md.
 */

import type { GameAction } from '../actions.js';
import type { KeywordFlags } from '../card.js';
import type { PermanentModification } from '../statics.js';
import type { Step, ZoneName } from '../state.js';
import {
  CR_SECTIONS,
  type ActionRules,
  type ConformanceFile,
  type CrRule,
  type CrSection,
  type KeywordRules,
  type ManifestEntry,
  type RulesManifest,
  type StepRules,
  type ZoneRules,
} from './manifest-types.js';

export {
  CONFORMANCE_FILES,
  CR_SECTIONS,
  sectionOf,
  type ClaimedTest,
  type ConformanceFile,
  type CrRule,
  type CrSection,
  type ManifestEntry,
} from './manifest-types.js';

// --- shared reasons ------------------------------------------------------------
// Named so that "why is this out of scope?" has ONE answer per cause rather than
// forty slightly different sentences that can drift apart.

/** Two players, one game, no tables. */
const NOT_MULTIPLAYER =
  'This engine plays exactly two players (core `PLAYER_IDS` is a two-element tuple, and the ' +
  'sim pairs one deck against one gauntlet deck). Every multiplayer option, range of ' +
  'influence, and team rule is out of scope by construction, not by omission.';

/** No casual variants. */
const NOT_A_VARIANT =
  'A casual/multiplayer variant. The lab plays ordinary two-player games of constructed ' +
  'Magic; there is no commander, no planar deck, no scheme deck and no ante.';

/** Card anatomy that the data pipeline flattens away. */
const CARD_ANATOMY =
  'Describes the physical anatomy of a printed card. This engine consumes NORMALIZED card ' +
  'data from Scryfall (`packages/data-tools`) — a `CardDefinition` of types, costs, keywords ' +
  'and compiled effects — so the layout of the printed object is not a rule it can break.';

/** A card mechanic no card in the shipped pool has. */
function noCardHasIt(what: string): string {
  return (
    `No card in the shipped pool (357 cards, ${''}\`packages/cards/src/data\`) is a ${what}. ` +
    'The compiler REFUSES text it cannot build rather than approximating it ' +
    '(UNSUPPORTED-MECHANICS.md), so an unimplemented mechanic cannot leak into a game.'
  );
}

// --- the manifest --------------------------------------------------------------

/**
 * Every CR section in scope, classified.
 *
 * ⚠️ This is a mapped type over {@link CrSection}. Adding a section number to
 * `CR_SECTIONS` without an entry here stops `tsc`, and therefore stops
 * `npm run build` and `npm run verify`.
 */
export const RULES_MANIFEST: RulesManifest = {
  // ======================= 1 — GAME CONCEPTS =======================
  '100': {
    status: 'not-applicable',
    reason:
      'Deck construction, format legality, sideboards and match structure. The lab is handed a ' +
      'decklist and plays single games with it; there is no format legality model and no ' +
      'best-of-three. Deck HEALTH (a deck containing an unplayable card) is a product concern ' +
      'and is tested in apps/web/src/lib/decklist/deckHealth.test.ts.',
  },
  '101': {
    status: 'cited',
    suite: 'packages/core/src/triggers.test.ts',
    what:
      'CR 101.4 (APNAP order) is the rule that decides whose simultaneous triggers go on the ' +
      'stack first: "orders the active player\'s triggers to resolve after the non-active ' +
      'player\'s". CR 101.1 (card text beats the rules) is structural here — a card IS its ' +
      'compiled effects, so there is no general rule for a card to override.',
    shortfall:
      'CR 101.2 (if something is impossible, ignore it) is not modelled as a general principle; ' +
      'each effect handles its own no-op case.',
  },
  '102': {
    status: 'cited',
    suite: 'packages/core/src/engine.test.ts',
    what:
      'CR 102.1 — the active player is the player whose turn it is. `GameState.activePlayer` ' +
      'and the turn hand-off are exercised by the turn-structure suite and by every combat test ' +
      '(a defending player is defined as the non-active one).',
    shortfall: 'CR 102.2–102.4 (teams, opponents plural) — see the 800s.',
  },
  '103': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      { rule: '103.4', title: 'each player begins the game at the starting life total' },
      { rule: '103.5', title: 'each player draws an opening hand of the configured size' },
      { rule: '103.8a', title: 'the player who takes the first turn skips their first draw step' },
    ],
    shortfall:
      'CR 103.5 MULLIGANS are not implemented — no player may ever mulligan, so every game is ' +
      'played from the first seven. For a lab that measures decks over thousands of games this ' +
      'is a real distortion of opening-hand variance, and it is the single largest known ' +
      'fidelity gap in the turn model. (Written up in COORDINATION.md.)',
  },
  '104': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      { rule: '104.2a', title: 'a player whose only opponent has lost the game wins it' },
      { rule: '104.1', title: 'once the game is over no player is offered any action' },
    ],
    shortfall:
      'CR 104.4 DRAWS are modelled only as "no player is left alive" (`resolveWinner` sets ' +
      'winner = null); there is no draw by agreement and no CR 104.4b infinite-loop draw.',
  },
  '105': {
    status: 'cited',
    suite: 'packages/core/src/protection.test.ts',
    what:
      'CR 105.1–105.2 — the five colours, derived from mana-cost pips: "derives colors from cost ' +
      'pips, hybrid included". Colour is what protection and colour-restricted targeting read.',
    shortfall: 'CR 105.3 colour indicators and CR 105.4 colour identity are unmodelled (no commander).',
  },
  '106': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      { rule: '106.1', title: 'activating a mana ability puts that mana into its controller’s pool' },
      { rule: '106.4', title: 'unused mana empties from the pool as each step ends' },
    ],
    shortfall:
      'CR 106.6 ("mana of any colour") is modelled as an explicit mode list rather than a ' +
      'free choice; CR 106.12 restricted mana and snow mana do not exist.',
  },
  '107': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      { rule: '107.3', title: 'the value chosen for {X} is the value the spell resolves with' },
      { rule: '107.3', title: 'an {X} larger than the board can pay for is never offered and is refused' },
    ],
    shortfall:
      'CR 107.4 mana symbols: {W}{U}{B}{R}{G}{C}, generic and hybrid are modelled; Phyrexian ' +
      'mana, snow mana and {½} are not.',
  },
  '108': {
    status: 'cited',
    suite: 'packages/core/src/legend-rule.test.ts',
    what:
      'CR 108.3 — a card\'s OWNER is the player it started the game under, which is what decides ' +
      'the graveyard it goes to: "a loser goes to ITS OWNER graveyard, not the chooser". ' +
      '`CardInstance` carries `owner` and `controller` separately for exactly this reason.',
  },
  '109': {
    status: 'cited',
    suite: 'packages/core/src/gain-control.test.ts',
    what:
      'CR 109.4 — an object\'s controller. Control changing hands and handing back is affirmed by ' +
      '"moves the permanent to the stealing player" / "returns the creature at end of turn", and ' +
      'CR 109.5 ("you" means the ability\'s controller) is what every static\'s `affects` filter reads.',
  },
  '110': {
    status: 'cited',
    suite: 'packages/core/src/statics.test.ts',
    what:
      'CR 110.1–110.2 — a permanent exists only on the battlefield: "a static in a card\'s HAND ' +
      'or graveyard does nothing — only the battlefield counts".',
    shortfall:
      'CR 110.5 STATUS: this engine models tapped/untapped only. Flipped, face-down and ' +
      'phased-in/out do not exist (no card in the pool has any of them).',
  },
  '111': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [{ rule: '111.1', title: 'a token created by a resolving spell is a permanent on the battlefield' }],
    shortfall:
      'CR 111.7 — a token that leaves the battlefield ceases to exist (the CR 704.5d state-based ' +
      'action). This engine moves a dead token to the graveyard like a card, where it stays. ' +
      'Observable: card-conservation counts and any "cards in your graveyard" effect see it.',
  },
  '112': {
    status: 'cited',
    suite: 'packages/core/src/engine.test.ts',
    what:
      'CR 112.1–112.7 — a spell is a card on the stack, and it stops being one as it resolves. ' +
      'Affirmed by "casting a creature → stack → resolves to battlefield summoning-sick" and by ' +
      'this directory\'s CR 405 and CR 608 tests.',
  },
  '113': {
    status: 'cited',
    suite: 'packages/core/src/activated.test.ts',
    what:
      'CR 113.3 — the three ability kinds this engine has: activated (activated.test.ts), ' +
      'triggered (triggers.test.ts), static (statics.test.ts). CR 113.6: an ability on the stack ' +
      'exists independently of its source — "the cost of an activated ability is not refunded ' +
      'when its source leaves" (this directory, CR 602.2b).',
    shortfall: 'CR 113.4 spell abilities and CR 113.10 ability words are not modelled as distinct kinds.',
  },
  '114': {
    status: 'cited',
    suite: 'packages/core/src/emblem.test.ts',
    what:
      'CR 114.1–114.3 — an emblem lives in the COMMAND zone, is not a permanent, cannot be ' +
      'targeted, survives a board wipe, and its static and triggered abilities work from there. ' +
      'All five are separately affirmed.',
  },
  '115': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      { rule: '115.2', title: 'a spell that says "target creature" cannot be cast at a land' },
      { rule: '115.4', title: 'a spell with a target restriction is only offered against legal targets' },
    ],
    note:
      'packages/core/src/targeting.test.ts carries the wide per-restriction matrix; this pins the ' +
      'two rules themselves rather than duplicating it.',
    shortfall: 'CR 115.7 (changing targets) has no mechanism — no card in the pool redirects a spell.',
  },
  '116': {
    status: 'cited',
    suite: 'packages/core/src/conformance/cr1xx-2xx-objects.test.ts',
    what:
      'CR 116.2a — playing a land is a SPECIAL ACTION: it uses no stack and cannot be responded ' +
      'to. Affirmed by "a land is played, not cast — it never uses the stack".',
    shortfall:
      'The land drop is the only special action this engine has. Turning a face-down creature ' +
      'face up (116.2b), suspend (116.2c) and companion (116.2f) do not exist.',
  },
  '117': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      { rule: '117.3a', title: 'the active player receives priority as each step begins' },
      { rule: '117.1', title: 'only the player who holds priority may act' },
      { rule: '117.3d', title: 'passing priority hands it to the other player without ending the step' },
    ],
    note:
      'CR 117.3b (priority back to the active player after a resolution) is affirmed in ' +
      'cr4xx-zones, and CR 117.3c (priority back to whoever cast) in cr6xx — both live beside ' +
      'the stack behaviour they are about. CR 117.5 — "each time a player would get priority, ' +
      'the game first performs state-based actions" — is now how this engine is wired: see the ' +
      'CR 704.3 boundary test under section 704.',
  },
  '118': {
    status: 'cited',
    suite: 'packages/core/src/mana-ability-model.test.ts',
    what:
      'CR 118.3 (you cannot pay a cost you cannot pay) and CR 118.4 (life as a cost) are affirmed ' +
      'from four directions: "refuses to activate when the life cost would kill you", "paying ' +
      'down to exactly zero is legal, and it kills you", "rejects an answer that claims to pay ' +
      'life the total does not hold", and the pain-land distinction "is a RIDER, not a cost".',
  },
  '119': {
    status: 'cited',
    suite: 'packages/core/src/sba.test.ts',
    what:
      'CR 119.3 (life loss and gain) and CR 119.6 (0 or less life) — "a loseLife spell can reduce ' +
      'a player to 0 and end the game"; lifelink gain is affirmed in combat.test.ts.',
    shortfall: 'CR 119.8 life-total-setting effects and CR 119.9 life replacement do not exist.',
  },
  '120': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      { rule: '120.3', title: 'non-lethal damage dealt to a creature is MARKED on it, not applied to toughness' },
    ],
    note:
      'CR 120.3c (damage to a planeswalker removes loyalty) and 120.3d (damage to a battle removes ' +
      'defense) are affirmed by planeswalker.test.ts and battle.test.ts respectively.',
    shortfall:
      'CR 120.6 damage PREVENTION and CR 120.5 damage redirection do not exist — see section 615.',
  },
  '121': {
    status: 'cited',
    suite: 'packages/core/src/sba.test.ts',
    what:
      'CR 121.3 — drawing from an empty library does not lose the game immediately; it is ' +
      'remembered and the CR 704.5b state-based action ends the game: "a player who must draw ' +
      'from an empty library loses".',
  },
  '122': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      { rule: '122.1a', title: '+1/+1 counters raise both power and toughness through the effective accessors' },
    ],
    note:
      'CR 122.3 — a permanent may not carry both a +1/+1 and a -1/-1 counter — is affirmed as ' +
      'the state-based action it is, under section 704.',
  },
  '123': { status: 'not-applicable', reason: noCardHasIt('sticker card (an Unfinity mechanic)') },

  // ======================= 2 — PARTS OF A CARD =======================
  '200': { status: 'not-applicable', reason: CARD_ANATOMY },
  '201': {
    status: 'cited',
    suite: 'packages/core/src/legend-rule.test.ts',
    what:
      'CR 201.4 — the legend rule matches on NAME: "two DIFFERENTLY-named legends under one ' +
      'player are legal" and "two same-named NONlegendary permanents are legal".',
  },
  '202': {
    status: 'cited',
    suite: 'packages/core/src/hybrid-and-tapped.test.ts',
    what:
      'CR 202.1 mana cost and CR 202.3f hybrid mana value — "counts each hybrid symbol as one ' +
      'toward mana value", plus mana.test.ts\'s "convertedManaCost sums all pips".',
  },
  '203': {
    status: 'not-applicable',
    reason: 'Illustration. Art is fetched from Scryfall for the PWA; no rule reads it.',
  },
  '204': {
    status: 'not-applicable',
    reason:
      'Colour indicator. Colour is derived from mana-cost pips (see 105); no card in the pool ' +
      'needs an indicator to be the colour it is.',
  },
  '205': {
    status: 'cited',
    suite: 'packages/core/src/statics.test.ts',
    what:
      'CR 205.2 card types and CR 205.3 subtypes — the type line is what every filter reads: "a ' +
      'Goblin lord pumps only Goblins, case-insensitively" and "noneOfSubtypes writes the ' +
      '\\"non-Goblin\\" form". Supertypes: legendary, affirmed by legend-rule.test.ts.',
  },
  '206': {
    status: 'not-applicable',
    reason:
      'Expansion symbol, set code and rarity. None of them is a rule: no card in Magic behaves ' +
      'differently for being rare, and this engine never reads the fields even though the ' +
      'Scryfall pipeline carries them for the card browser.',
  },
  '207': {
    status: 'not-applicable',
    reason:
      'The text box as a printed region. Its CONTENT is compiled into effect primitives by ' +
      'packages/cards/src/compile, whose fidelity is the subject of compile.test.ts and ' +
      'fidelity.test.ts — a card either compiles as printed or is reported unsupported.',
  },
  '208': {
    status: 'cited',
    suite: 'packages/core/src/derived-state.test.ts',
    what:
      'CR 208.2 — a `*` power/toughness box is a characteristic-defining ability: "is 0/1 with ' +
      'both graveyards empty, and grows one type at a time" (Tarmogoyf), computed in CR 613.4a.',
  },
  '209': {
    status: 'cited',
    suite: 'packages/core/src/planeswalker.test.ts',
    what: 'CR 209.1 — the loyalty box becomes loyalty counters as the walker enters (CR 306.5b).',
  },
  '210': {
    status: 'cited',
    suite: 'packages/core/src/battle.test.ts',
    what: 'CR 210.1 — the defense box becomes defense counters: "a cast battle enters with its printed defense as counters".',
  },
  '211': { status: 'not-applicable', reason: 'Hand modifier — a Vanguard-only box. ' + NOT_A_VARIANT },
  '212': { status: 'not-applicable', reason: 'Life modifier — a Vanguard-only box. ' + NOT_A_VARIANT },
  '213': { status: 'not-applicable', reason: 'Collector number, artist credit, legal text. ' + CARD_ANATOMY },

  // ======================= 3 — CARD TYPES =======================
  '300': {
    status: 'cited',
    suite: 'packages/core/src/engine.test.ts',
    what:
      'CR 300.1 — the card types this engine has: artifact, creature, enchantment, instant, land, ' +
      'planeswalker, sorcery, battle. Permanent vs non-permanent timing is affirmed by ' +
      '"enforces sorcery-speed: a creature cannot be cast on the opponent\'s turn".',
  },
  '301': {
    status: 'cited',
    suite: 'packages/core/src/attachments.test.ts',
    what:
      'CR 301.5 — Equipment: "an Equip ability may not be pointed at a creature you do not ' +
      'control", and the CR 704.5n unattach behaviour.',
  },
  '302': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      {
        rule: '302.6',
        title: 'a creature’s activated ability with {T} needs it to have been controlled since your turn began',
      },
      { rule: '302.6', title: 'summoning sickness wears off as its controller’s next turn begins' },
    ],
    note:
      'CR 302.6\'s other half — a summoning-sick creature cannot ATTACK — is affirmed in cr6xx ' +
      '("a creature entering the battlefield is summoning sick unless it has haste") and by ' +
      'combat.test.ts, continuous.test.ts, statics.test.ts and gain-control.test.ts.',
  },
  '303': {
    status: 'cited',
    suite: 'packages/core/src/attachments.test.ts',
    what:
      'CR 303.4 — Auras: legal-host enforcement ("REFUSES an illegal host, leaving the board ' +
      'untouched"), falling off when the host stops qualifying, and the CR 704.5m death rule.',
  },
  '304': {
    status: 'covered',
    file: 'cr6xx-spells-and-abilities',
    tests: [{ rule: '304.1', title: 'an instant may be cast whenever its controller has priority' }],
  },
  '305': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      { rule: '305.1', title: 'a land is played, not cast — it never uses the stack' },
      { rule: '305.2', title: 'a player may play only the configured number of lands each turn' },
      { rule: '505.6b', title: 'a land can only be played during your own main phase on an empty stack' },
    ],
    note:
      'The third test is indexed to CR 505.6b — the rule that states the timing — because that is ' +
      'where a reader looking up "when may I play a land?" will start.',
  },
  '306': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [
      { rule: '306.5b', title: 'a planeswalker enters the battlefield with its printed loyalty in counters' },
    ],
    note:
      'planeswalker.test.ts carries the rest: attacking a walker, loyalty costs, the CR 704.5i ' +
      'zero-loyalty death, and damage redirection.',
  },
  '307': {
    status: 'cited',
    suite: 'packages/core/src/conformance/cr5xx-turn-and-combat.test.ts',
    what:
      'CR 307.1 — a sorcery is cast only at sorcery speed: "a sorcery may only be cast in the ' +
      'active player’s main phase with an empty stack" (CR 505.6a), and it goes to the graveyard ' +
      'as it finishes resolving (CR 608.2n, cr4xx-zones).',
  },
  '308': { status: 'not-applicable', reason: noCardHasIt('Kindred (formerly Tribal) card') },
  '309': { status: 'not-applicable', reason: noCardHasIt('Dungeon card') },
  '310': {
    status: 'cited',
    suite: 'packages/core/src/battle.test.ts',
    what:
      'CR 310.4 (enters with defense counters; a defeated Siege is exiled and its reward half may be ' +
      'cast without paying its mana cost — split-cards.test.ts drives that with an EMPTY mana ' +
      'pool, which is what makes "without paying" a real claim), CR 310.11 (a battle is ' +
      'protected by an opponent ' +
      'of its controller, and only an attack from the protector\'s opponent is legal) — five ' +
      'separate tests drive the real attack path.',
  },
  '311': { status: 'not-applicable', reason: 'Planes. ' + NOT_A_VARIANT },
  '312': { status: 'not-applicable', reason: 'Phenomena. ' + NOT_A_VARIANT },
  '313': { status: 'not-applicable', reason: 'Vanguards. ' + NOT_A_VARIANT },
  '314': { status: 'not-applicable', reason: 'Schemes. ' + NOT_A_VARIANT },
  '315': { status: 'not-applicable', reason: 'Conspiracies. ' + NOT_A_VARIANT },

  // ======================= 4 — ZONES =======================
  '400': {
    status: 'covered',
    file: 'cr4xx-zones',
    tests: [
      { rule: '400.7', title: 'a creature that dies loses its marked damage, counters and tapped status' },
      { rule: '400.7', title: 'a grant made to a card in a graveyard stops applying when the card leaves that zone' },
      { rule: '400.1', title: 'a card drawn from the library is in the hand zone and nowhere else' },
    ],
    note:
      'CR 400.7 is one of this engine\'s load-bearing invariants — it has its own chokepoint ' +
      '(`internal/zones.ts`\'s `resetInstanceForNewZone`) and four more affirmations in ' +
      'engine-regressions.test.ts, card-grants.test.ts and modal-casting.test.ts — and now ' +
      'as-enters.test.ts, whose "is CLEARED when the permanent leaves the battlefield" applies the ' +
      'rule to a value the permanent NAMED rather than to its damage or its counters.',
  },
  '401': {
    status: 'covered',
    file: 'cr4xx-zones',
    tests: [{ rule: '401.2', title: 'the library is an ordered zone and a draw takes the card from the TOP' }],
    shortfall: 'CR 401.4 — no card may look at or reorder a library beyond scry/surveil.',
  },
  '402': {
    status: 'covered',
    file: 'cr4xx-zones',
    tests: [
      {
        rule: '402.2',
        title: 'a hand over the maximum is cut back to it, and one at the maximum is not asked',
      },
      { rule: '402.2', title: 'a player at or under the maximum is never asked to discard at all' },
    ],
    note:
      'The maximum is `RulesConfig.maximumHandSize` (7 by default), never a literal, so a format ' +
      'that changes it is a config edit. It is ENFORCED by the CR 514.1 cleanup discard, whose own ' +
      'tests live under section 514 — the two entries are one rule seen from the zone side and one ' +
      'seen from the step side. WARNING: closing this MOVED every recorded gauntlet baseline in ' +
      'DESIGN section 3.4a. An unbounded hand changes what card draw and held-back reactive spells ' +
      'are worth, which is the quantity this product exists to measure.',
    shortfall:
      'CR 402.6 — a printed "you have no maximum hand size" (Reliquary Tower, Spellbook) is not ' +
      'modelled: the maximum is a rules-config value, not a per-player one a continuous effect can ' +
      'raise. No card in the pool prints it.',
  },
  '403': {
    status: 'cited',
    suite: 'packages/core/src/statics.test.ts',
    what:
      'CR 403.3 — permanents exist only on the battlefield, and a static ability applies only ' +
      'from there. Turn order of the battlefield is stable (`state.battlefield` is an array), ' +
      'which is what makes the sim deterministic.',
  },
  '404': {
    status: 'covered',
    file: 'cr4xx-zones',
    tests: [{ rule: '404.3', title: 'the graveyard is an ORDERED zone — the most recent card is on top' }],
  },
  '405': {
    status: 'covered',
    file: 'cr4xx-zones',
    tests: [
      { rule: '405.1', title: 'a cast spell goes on the stack and is no longer in its owner’s hand' },
      { rule: '405.5', title: 'the stack resolves LAST IN, FIRST OUT — one object at a time' },
      { rule: '117.3b', title: 'the active player receives priority again after an object resolves' },
    ],
  },
  '406': {
    status: 'covered',
    file: 'cr4xx-zones',
    tests: [
      { rule: '702.34a', title: 'a spell cast from a graveyard with flashback is EXILED as it leaves the stack' },
      { rule: '702.34a', title: 'exile is where a flashback spell goes even when it leaves the stack unresolved' },
    ],
    note:
      'Indexed to CR 702.34a because flashback is WHY a card is in exile here; the zone rule ' +
      '(CR 406.1, exile is public and outside the game) is what the tests observe.',
  },
  '407': { status: 'not-applicable', reason: 'Ante. Not played, and not legal in any supported format.' },
  '408': {
    status: 'cited',
    suite: 'packages/core/src/emblem.test.ts',
    what:
      'CR 408.1 — the command zone holds emblems: "createEmblem puts the object in the COMMAND ' +
      'zone, not the battlefield", and an emblem there is not targetable and survives a wipe.',
    shortfall: 'No commanders, no dungeons, no plane cards — an emblem is the only command-zone object.',
  },

  // ======================= 5 — TURN STRUCTURE =======================
  '500': {
    status: 'covered',
    file: 'cr5xx-turn-and-combat',
    tests: [
      { rule: '500.1', title: 'a turn proceeds through its steps in the printed order' },
      { rule: '500.5', title: 'each player’s mana pool empties as a step ends' },
      { rule: '500.1', title: 'the turn passes to the other player after cleanup' },
    ],
    shortfall:
      'CR 500.7–500.11 — extra turns, extra phases, extra steps and skipped steps are not ' +
      'modelled. `STEP_ORDER` is a constant array walked once per turn.',
  },
  '501': {
    status: 'cited',
    suite: 'packages/core/src/conformance/cr5xx-turn-and-combat.test.ts',
    what:
      'CR 501.1 — the beginning phase is untap, upkeep, draw in that order; affirmed by the ' +
      'CR 500.1 step-order test and by the untap/draw tests in the same file.',
  },
  '502': {
    status: 'covered',
    file: 'cr5xx-turn-and-combat',
    tests: [
      { rule: '502.4', title: 'no player receives priority during the untap step' },
      { rule: '502.3', title: 'the active player untaps their permanents as their turn begins' },
    ],
    shortfall: 'CR 502.1 phasing and CR 502.2 day/night do not exist.',
  },
  '503': {
    status: 'cited',
    suite: 'packages/core/src/counter-triggers.test.ts',
    what:
      'CR 503.1 — the upkeep step is a priority window in which "at the beginning of your upkeep" ' +
      'triggers fire; the trigger-timing matrix ("beginCombat fires on YOUR begin-combat step and ' +
      'not the opponent\'s", "endStep with who \\"any\\" fires on both players\' end steps") is the ' +
      'same machinery.',
  },
  '504': {
    status: 'covered',
    file: 'cr5xx-turn-and-combat',
    tests: [{ rule: '504.1', title: 'the active player draws a card during their draw step' }],
  },
  '505': {
    status: 'covered',
    file: 'cr5xx-turn-and-combat',
    tests: [
      { rule: '505.6a', title: 'a sorcery may only be cast in the active player’s main phase with an empty stack' },
      { rule: '505.6b', title: 'each player’s land drop resets as their turn begins' },
    ],
    shortfall: 'CR 505.5 (the Attractions step) does not exist — no Attraction card is in the pool.',
  },
  '506': {
    status: 'cited',
    suite: 'packages/core/src/planeswalker.test.ts',
    what:
      'CR 506.4 — removal from combat. "A walker that dies mid-combat absorbs nothing and ' +
      'redirects nothing" and battle.test.ts\'s equivalent both drive CR 506.4c: removing what ' +
      'was ATTACKED does not remove the attacker from combat.',
  },
  '507': {
    status: 'cited',
    suite: 'packages/core/src/counter-triggers.test.ts',
    what: 'CR 507.1 — the beginning of combat step is a priority window that fires "at the beginning of combat" triggers.',
  },
  '508': {
    status: 'covered',
    file: 'cr5xx-turn-and-combat',
    tests: [
      { rule: '508.1a', title: 'only the active player declares attackers' },
      { rule: '508.1a', title: 'a creature can only be declared as an attacker by the player who controls it' },
      { rule: '508.1a', title: 'a tapped creature cannot be declared as an attacker' },
      { rule: '508.1f', title: 'declaring an attacker taps it — unless it has vigilance' },
      { rule: '508.1', title: 'the same creature cannot be declared as an attacker twice' },
      {
        rule: '508.8',
        title: 'with no attackers declared, the declare-blockers and combat-damage steps are skipped',
      },
      { rule: '508.8', title: 'passing through declare-attackers without declaring skips the same two steps' },
    ],
    shortfall:
      'CR 508.1d attack REQUIREMENTS ("attacks each combat if able") are not modelled; CR 508.1c ' +
      'restrictions exist only as defender/summoning sickness. CR 508.1e banding is absent.',
  },
  '509': {
    status: 'covered',
    file: 'cr5xx-turn-and-combat',
    tests: [
      { rule: '509.1a', title: 'only the defending player declares blockers' },
      { rule: '509.1a', title: 'a tapped creature cannot be declared as a blocker' },
      { rule: '509.1a', title: 'a creature can only block a creature that is actually attacking' },
      { rule: '509.1h', title: 'a blocked creature stays blocked even after its blocker leaves combat' },
    ],
    note:
      'CR 509.1b block RESTRICTIONS (menace, "can\'t block", "except by N or more") have a ' +
      'fifteen-case matrix in packages/core/src/blocking-restrictions.test.ts. Cited, not copied.',
    shortfall:
      'CR 509.1c block REQUIREMENTS ("must block if able", "blocks each combat if able") are ' +
      'deliberately not implemented — `internal/combat.ts` says so at line 115. A declaration ' +
      'that ignores a requirement is accepted, because no requirement can be expressed.',
  },
  '510': {
    status: 'covered',
    file: 'cr5xx-turn-and-combat',
    tests: [
      { rule: '510.1c', title: 'a blocked creature deals no damage to the defending player, even so' },
      { rule: '510.1b', title: 'an unblocked attacker deals its power to the defending player' },
      { rule: '510.2', title: 'a blocked attacker and its blocker deal damage to each other simultaneously' },
      { rule: '510.4', title: 'first strike creates a separate, earlier combat damage step' },
    ],
    shortfall:
      'CR 510.1a lets an attacker DIVIDE its damage among multiple blockers in an order the ' +
      'attacker chooses; this engine assigns to blockers in declaration order with no choice ' +
      'offered. Trample overflow is computed from lethal-to-all rather than from an assignment.',
  },
  '511': {
    status: 'covered',
    file: 'cr5xx-turn-and-combat',
    tests: [{ rule: '511.3', title: 'creatures stop being attackers when combat ends' }],
  },
  '512': {
    status: 'cited',
    suite: 'packages/core/src/conformance/cr5xx-turn-and-combat.test.ts',
    what: 'CR 512.1 — the ending phase is the end step then cleanup; affirmed by the CR 500.1 step-order test.',
  },
  '513': {
    status: 'cited',
    suite: 'packages/core/src/counter-triggers.test.ts',
    what: 'CR 513.1 — the end step is a priority window that fires "at the beginning of the end step" triggers.',
  },
  '514': {
    status: 'covered',
    file: 'cr5xx-turn-and-combat',
    tests: [
      {
        rule: '514.1',
        title: 'the ACTIVE player discards down to their maximum hand size, and chooses which',
      },
      { rule: '514.1', title: 'the discard happens every turn, so a hand cannot grow without bound' },
      { rule: '514.2', title: 'damage marked on permanents is removed as the turn ends' },
      { rule: '514.2', title: '"until end of turn" effects end during the cleanup step' },
      { rule: '514.3', title: 'no player receives priority during the cleanup step' },
      {
        rule: '514.3a',
        title: 'a cleanup that DID open a priority window is followed by another cleanup step',
      },
      { rule: '514.3a', title: 'a discard alone does NOT open a priority window; the turn simply ends' },
    ],
    note:
      'The step runs in the printed order: the CR 514.1 discard first — a CHOICE the active player ' +
      'makes, so the step suspends on it — then the CR 514.2 simultaneous damage removal and ' +
      'end-of-turn expiry. CR 514.3a is implemented as a RE-ENTRANT cleanup step: reaching the turn ' +
      'machine step advance while the step is STILL cleanup can only mean a priority window was ' +
      'opened during it, which is exactly what "another cleanup step begins" describes, so it needs ' +
      'no state flag. Two of the three clauses in CR 514.3a are UNREACHABLE rather than ' +
      'unimplemented: no `TriggerEvent` in this engine watches a card leave a hand, and nothing a ' +
      'cleanup step does can make a state-based action applicable. What IS reachable is madness ' +
      '(CR 702.35a) on a discarded card, which this engine models as a window rather than as a ' +
      'trigger and which is therefore asked for by name.',
  },

  // ======================= 6 — SPELLS, ABILITIES, EFFECTS =======================
  '600': {
    status: 'not-applicable',
    reason: 'A one-line chapter header ("the rules in this section apply to spells and abilities"). Nothing to affirm.',
  },
  '601': {
    status: 'covered',
    file: 'cr6xx-spells-and-abilities',
    tests: [
      { rule: '601.2a', title: 'casting moves the card from its zone to the stack before anything else happens' },
      { rule: '601.2c', title: 'a spell’s targets are chosen as it is put on the stack, and stay on it' },
      { rule: '601.2h', title: 'a spell whose cost the player cannot pay is neither offered nor castable' },
      { rule: '601.2h', title: 'the cost is paid as the spell is cast, not when it resolves' },
      { rule: '117.3c', title: 'the player who casts a spell receives priority again afterwards' },
    ],
    note:
      'CR 601.2b (modes and {X} announced at cast time) has a 23-test matrix across ' +
      'cast-cost.test.ts and modal-casting.test.ts — the deepest per-feature coverage in the ' +
      'repo. Cited, not copied.',
    shortfall:
      'CR 601.2g — the mana-ability window DURING casting — exists only as the payment planner, ' +
      'not as a priority-free window a player can act in. (CR 601.2b ADDITIONAL COSTS are covered ' +
      'elsewhere: additional-cast-cost.test.ts drives the mandatory kind end-to-end — a spell whose ' +
      'extra cost nothing can pay is NOT OFFERED, and is REJECTED if a hand-built action tries it ' +
      'anyway, "and nothing is half-paid", which is the CR 601.2h guarantee that an unpayable cost ' +
      'makes the whole cast illegal rather than partially applied.)',
  },
  '602': {
    status: 'covered',
    file: 'cr6xx-spells-and-abilities',
    tests: [
      { rule: '602.2a', title: 'activating an ability puts it on the stack and pays its cost immediately' },
      { rule: '602.5d', title: 'an activated ability with no stated timing may be activated at instant speed' },
      { rule: '602.5d', title: 'an ability printed at sorcery speed is not offered outside a main phase' },
      { rule: '602.2b', title: 'the cost of an activated ability is not refunded when its source leaves' },
    ],
  },
  '603': {
    status: 'covered',
    file: 'cr6xx-spells-and-abilities',
    tests: [
      { rule: '603.3', title: 'a triggered ability goes on the stack the next time a player would get priority' },
      { rule: '603.3d', title: 'a triggered ability’s targets are chosen as it is put on the stack' },
      { rule: '603.3', title: 'a trigger whose condition never occurs never goes on the stack' },
    ],
    note:
      'The trigger-matching matrix (which events fire what, "another", combat-only) lives in ' +
      'counter-triggers.test.ts. CR 603.4 — the printed intervening "if", CHECKED TWICE — is ' +
      'affirmed by packages/core/src/step-triggers.test.ts: "a false condition stops the ability ' +
      'REACHING the stack, not merely resolving" AND "a condition that LAPSES between trigger and ' +
      'resolution fizzles the ability". Both halves matter — a condition written inside the effect ' +
      'body would implement only the second, and nobody could tell from a passing test. ' +
      'CR 603.3b (APNAP for simultaneous triggers) is in triggers.test.ts.',
    shortfall:
      'CR 603.8 STATE TRIGGERS ("whenever you have no cards in hand") are not modelled — every ' +
      'trigger here is an event trigger. CR 603.7 reflexive triggers and CR 603.10 delayed ' +
      'triggers exist only as ad-hoc effects.',
  },
  '604': {
    status: 'cited',
    suite: 'packages/core/src/statics.test.ts',
    what:
      'CR 604.1–604.3 — a static ability applies continuously with no stack and no trigger: "the ' +
      'anthem starts applying the moment it RESOLVES onto the battlefield", "the anthem leaves ' +
      'and the creature it was propping up dies to SBAs immediately".',
  },
  '605': {
    status: 'covered',
    file: 'cr1xx-2xx-objects',
    tests: [{ rule: '605.3b', title: 'a mana ability does not use the stack — the mana is there at once' }],
    note:
      'CR 605.1a (what qualifies as a mana ability) has a dedicated suite in ' +
      'mana-ability-model.test.ts: pain lands, filter lands, activation restrictions and ' +
      'board-derived colours, each with the "a rider is not a cost" distinction.',
  },
  '606': {
    status: 'covered',
    file: 'cr6xx-spells-and-abilities',
    tests: [
      { rule: '606.3', title: 'a loyalty ability may only be activated at sorcery speed' },
      { rule: '606.3', title: 'only one loyalty ability may be activated per planeswalker each turn' },
      { rule: '606.6', title: 'a minus ability cannot be activated for more loyalty than the walker has' },
    ],
  },
  '607': {
    status: 'not-applicable',
    reason:
      'Linked abilities ("the exiled card" referring to a specific earlier ability). No card in ' +
      'the pool has a linked pair; the compiler refuses text that needs one rather than guessing ' +
      'which exile pile is meant.',
  },
  '608': {
    status: 'covered',
    file: 'cr6xx-spells-and-abilities',
    tests: [
      { rule: '608.2c', title: 'a resolving spell follows its instructions in the printed order' },
      { rule: '608.3', title: 'a resolving permanent spell becomes a permanent on the battlefield' },
      { rule: '608.2n', title: 'an instant that finishes resolving is put into its owner’s graveyard', file: 'cr4xx-zones' },
    ],
    note:
      'CR 608.2b (a spell whose targets are all illegal does not resolve) has four affirmations ' +
      'across trigger-targets, card-grants, modal-casting and choice-cards. Cited, not copied.',
  },
  '609': {
    status: 'cited',
    suite: 'packages/core/src/continuous.test.ts',
    what:
      'CR 609.1–609.4 — the two effect kinds this engine has: one-shot (an effect primitive runs ' +
      'and is done) and continuous ("raises effective P/T this turn and wears off in the cleanup ' +
      'step"). CR 609.7 (a source that has left) is the subject of engine-regressions.test.ts\'s ' +
      '"a creature that dies takes its continuous effects with it".',
  },
  '610': {
    status: 'cited',
    suite: 'packages/core/src/engine.test.ts',
    what: 'CR 610.1 — one-shot effects do something once and do not last; every effect primitive is one.',
  },
  '611': {
    status: 'cited',
    suite: 'packages/core/src/continuous.test.ts',
    what:
      'CR 611.2 — a continuous effect from a resolving spell locks in what it affects on ' +
      'resolution and lasts for its stated duration: nine tests on grant/expire, including "a ' +
      'creature kept alive by an until-EOT toughness buff dies when it expires at cleanup".',
  },
  '612': {
    status: 'not-applicable',
    reason:
      'Text-changing effects ("target creature gains all creature types", "becomes your choice ' +
      'of colour"). ' + noCardHasIt('text-changing card'),
  },
  '613': {
    status: 'gap',
    rule:
      'CR 613.1 — continuous effects apply in seven LAYERS (copy, control, text, type, colour, ' +
      'ability, power/toughness), CR 613.4 sublayers 7a–7d within layer 7, CR 613.7 timestamp ' +
      'order within a layer, and CR 613.8 dependency.',
    engine:
      'There is no layer system. `internal/continuous.ts` collapses every continuous effect to ' +
      '"an additive P/T delta and a keyword OR" and says so, honestly, in its own header. That ' +
      'model is EXACT for every effect the engine can currently express — sums and ORs are ' +
      'commutative, so timestamp order provably cannot change an answer — but there is no ' +
      'timestamp, no dependency resolution, and nothing that could apply a SETTING effect ' +
      '("becomes a 1/1", "loses all abilities") in the right order relative to a modifying one. ' +
      'The day a card sets a value rather than adding to one, this stops being a modelling ' +
      'simplification and becomes a wrong answer.',
    owner:
      'Unowned. The boundary is held by TWO guards rather than by memory: the runtime pin below, ' +
      'and `MODIFICATION_IS_PURELY_ADDITIVE` in this file — a compile-time proof that ' +
      '`PermanentModification` still has only additive fields. Adding a setting field to it ' +
      'stops the build here.',
    pin: {
      file: 'cr7xx-sba-keywords-copy',
      tests: [
        { rule: '613.4c', title: 'counters and P/T-modifying effects combine additively over the printed base' },
        { rule: '613.7', title: 'timestamp order cannot change the result, because every modification is additive' },
      ],
    },
  },
  '614': {
    status: 'covered',
    file: 'cr6xx-spells-and-abilities',
    tests: [
      { rule: '614.1c', title: 'a permanent that "enters tapped" is never untapped on the battlefield first' },
      { rule: '302.6', title: 'a creature entering the battlefield is summoning sick unless it has haste' },
    ],
    note:
      'CR 614.1c ("[this] enters with…", "as [this] enters…") is the ONE replacement-effect shape ' +
      'this engine implements, and it is implemented well: taplands, conditional taplands, ' +
      'shocklands, reveal-lands, counters-on-entry and loyalty/defense all run through it, with ' +
      'sixteen affirmations across engine-regressions, hybrid-and-tapped, conditional-tapland and ' +
      'shockland. packages/core/src/as-enters.test.ts adds the ORDERING case only a SECOND ' +
      'as-enters clause can expose: "asks the NAMING and THEN the payment — one land, two ' +
      'questions, neither dropped", and "declining the second question still leaves the first ' +
      'answer standing".',
    shortfall:
      'It is the only shape. There is no general replacement layer: no "if damage would be dealt ' +
      '… instead", no CR 614.5 once-only rule (nothing can recurse, because nothing replaces), ' +
      'no CR 614.6, and no CR 614.12 self-replacement. A `feat/replacement-effects` branch is in ' +
      'flight; see section 615.',
  },
  '615': {
    status: 'gap',
    rule:
      'CR 615.1 — prevention effects: "prevent the next N damage that would be dealt to…", a ' +
      'shield the damage event passes through before it is dealt. CR 615.6 — prevented damage ' +
      'never happens.',
    engine:
      'Not implemented. Damage is applied directly by the effect that deals it; there is no ' +
      'shield the damage passes through. Protection (CR 702.16) prevents combat damage as a ' +
      'special case inside `internal/combat.ts`, but it is a hard-coded check rather than a ' +
      'prevention effect, so nothing else can prevent anything.',
    owner:
      'A sibling branch `feat/replacement-effects` is IN FLIGHT on this (COORDINATION.md ' +
      'in-flight table). Do not race it — reclassify 614/615/616 when it merges.',
  },
  '616': {
    status: 'gap',
    rule:
      'CR 616.1 — when two or more replacement/prevention effects could apply to the same event, ' +
      'the affected object\'s controller chooses the order.',
    engine:
      'Unreachable: with exactly one replacement shape (CR 614.1c, applied at one site as a ' +
      'permanent enters) two effects can never contend, so there is no choice to offer. This is a ' +
      'gap rather than not-applicable because the rule WOULD apply the moment section 615 lands.',
    owner: 'Same branch as 615 — `feat/replacement-effects`.',
  },

  // ======================= 7 — ADDITIONAL RULES =======================
  '700': {
    status: 'not-applicable',
    reason:
      'A chapter header ("the rules in this section are for situations not covered elsewhere"). ' +
      'It states no requirement, so there is nothing an engine could get right or wrong.',
  },
  '701': {
    status: 'cited',
    suite: 'packages/core/src/transform.test.ts',
    what:
      'The keyword ACTIONS this engine performs: transform (CR 701.27) with four tests including ' +
      'the no-op cases; destroy, discard (CR 701.8a, via madness and choice-cards), sacrifice, ' +
      'exile, mill (CR 701.17), scry (CR 701.22) and surveil (CR 701.25) — the last three ' +
      'affirmed in packages/cards/src/compile/scry-surveil.test.ts.',
    shortfall:
      'CR 701.19 REGENERATE does not exist anywhere in core; nor do fight, monstrosity, ' +
      'proliferate, populate, explore, venture or connive.',
  },
  '702': {
    status: 'covered',
    file: 'cr7xx-sba-keywords-copy',
    tests: [
      { rule: '702.21', title: 'targeting an opponent’s warded permanent puts its ward trigger above the spell' },
      { rule: '702.21', title: 'a permanent’s own controller never triggers its ward' },
    ],
    note:
      'Ward is here because it was the one shipped keyword whose TRIGGER nothing drove ' +
      'end-to-end. The other nineteen have strong per-feature coverage and are indexed by ' +
      '`KEYWORD_RULES` below, which is a compile-time exhaustiveness proof over `KeywordFlags`: ' +
      'deathtouch/trample/lifelink/first+double strike/vigilance/flying/reach (combat.test.ts), ' +
      'haste/defender (continuous + statics), hexproof/shroud (protection-and-flash.test.ts), ' +
      'protection (protection.test.ts, ten tests), indestructible (indestructible.test.ts), ' +
      'menace/cantBlock/minBlockers/unblockable (blocking-restrictions.test.ts, fifteen tests), ' +
      'flash (protection-and-flash.test.ts), flashback (flashback.test.ts, seven tests).',
    shortfall:
      'Of ~160 keyword abilities in the CR, this engine has 20 plus cycling (702.29), kicker ' +
      '(702.33), buyback (702.27), madness (702.35) and aftermath (702.127a — the half castable ' +
      'only from the graveyard, for its OWN printed cost rather than a flashback cost; affirmed in ' +
      'split-cards.test.ts). Everything else is refused by the compiler and listed in ' +
      'UNSUPPORTED-BACKLOG.md.',
  },
  '703': {
    status: 'cited',
    suite: 'packages/core/src/conformance/cr5xx-turn-and-combat.test.ts',
    what:
      'CR 703 lists the turn-based actions; the ones this engine performs — untap (CR 502.3), ' +
      'draw (CR 504.1), declare attackers/blockers (508/509), assign and deal combat damage ' +
      '(510), cleanup (514.2) — are each affirmed in the 5xx file, and CR 703.1 (they happen ' +
      'automatically, use no stack and nobody may respond) is what the no-priority tests on 502.4 ' +
      'and 514.3 prove.',
  },
  '704': {
    status: 'covered',
    file: 'cr7xx-sba-keywords-copy',
    tests: [
      { rule: '704.3', title: 'no state-based action is left outstanding while a player holds priority' },
      {
        rule: '704.3',
        title: 'a condition nobody announced is caught the moment a player would get priority',
      },
      { rule: '704.5a', title: 'a player reduced to 0 life loses as the spell that did it finishes resolving' },
      { rule: '704.5f', title: 'a creature at 0 or less toughness is put into the graveyard, not destroyed' },
      { rule: '704.5g', title: 'a creature with lethal damage marked is destroyed at the next check' },
      { rule: '704.5q', title: '+1/+1 and -1/-1 counters on one permanent are REMOVED in pairs' },
    ],
    note:
      'CR 704.3 is answered from BOTH sides, which is the point: the invariant test proves the ' +
      'engine settles every condition its own mutation sites create, and the boundary test proves ' +
      'the backstop by creating one with no mutation site behind it at all. The check now runs in ' +
      '`onPassPriority` behind `stateBasedActionsPossible`, a single allocation-free walk that is ' +
      'conservative in one direction only — it may say yes on a board with nothing to do, and ' +
      'never says no on one that has something. CR 704.5q lives in the state-based action pass ' +
      'rather than inside the counters primitive, so counters that arrive by any other route ' +
      '(persist, a token created with counters) annihilate too.',
    shortfall:
      'CR 704.5c (a token that has left the battlefield ceases to exist) and CR 704.5d (a counter ' +
      'on an object it cannot have) are not modelled; see section 111. CR 704.5b decking is ' +
      'flagged at the draw rather than as a state-based action; see section 121.',
  },
  '705': { status: 'not-applicable', reason: noCardHasIt('coin-flipping card') },
  '706': { status: 'not-applicable', reason: noCardHasIt('die-rolling card') },
  '707': {
    status: 'gap',
    rule:
      'CR 707.2 — a copy uses the COPIABLE VALUES of the original (printed characteristics as ' +
      'modified by other copy effects), and explicitly not its counters, status, or the effects ' +
      'currently modifying it. CR 707.10 — copying a spell on the stack.',
    engine:
      'Not implemented at all. There is no copy primitive, no `copiableValues`, and nothing in ' +
      '`CardInstance` that could record "this is a copy of that". A clone card cannot compile, so ' +
      'the rule is unreachable rather than wrong.',
    owner:
      'A sibling branch `feat/copy-effects` is IN FLIGHT (COORDINATION.md in-flight table). ' +
      'Reclassify when it merges — and note CR 707.2\'s "counters are not copied" clause, which ' +
      'is the half a copy implementation most often gets wrong.',
  },
  '708': { status: 'not-applicable', reason: 'Face-down spells and permanents (morph, manifest). ' + noCardHasIt('morph or manifest card') },
  '709': {
    status: 'cited',
    suite: 'packages/core/src/split-cards.test.ts',
    what:
      'CR 709.4 — a split card in a zone other than the stack is the COMBINED object: both names, ' +
      'the union of the type lines, the SUM of the two mana costs. "Is neither half while it sits ' +
      'in a zone: the combined name, types and mana value" pins exactly that, and it is the ' +
      'modelling call that would have been silent if wrong — a split card modelled as its left ' +
      'half would mis-answer every discard filter and "mana value 3 or less" clause in the game ' +
      'while looking perfectly fine in a cast test. CR 709.3 (cast one half, pay that half) and ' +
      'the revert to the combined object as it leaves the stack are separately affirmed.',
    shortfall: 'Fuse is absent — no split card may be cast as both halves.',
  },
  '710': { status: 'not-applicable', reason: noCardHasIt('flip card') },
  '711': { status: 'not-applicable', reason: noCardHasIt('leveler card') },
  '712': {
    status: 'cited',
    suite: 'packages/core/src/transform.test.ts',
    what:
      'CR 712 double-faced cards: each face has its own characteristics; a transforming permanent ' +
      'does NOT become a new object (CR 712.18) — "counters, damage, tapped state and attachments ' +
      'all persist across the swap"; a permanent that dies goes to the graveyard front-face up; ' +
      'the back face cannot be cast or played from hand; and modal DFCs offer both halves with ' +
      'the land half consuming the land drop.',
    shortfall: 'Meld cards, and the day/night cycle that drives werewolves automatically (CR 731), are absent.',
  },
  '713': { status: 'not-applicable', reason: 'Substitute cards — a physical-play convenience. Nothing to model.' },
  '714': { status: 'not-applicable', reason: noCardHasIt('Saga') },
  '715': {
    status: 'cited',
    suite: 'packages/core/src/split-cards.test.ts',
    what:
      'CR 715.2 — an adventurer card is defined by its CREATURE half, not by a combined object ' +
      '(unlike a split card under CR 709.4; the two are deliberately modelled differently, and the ' +
      'difference is asserted rather than assumed). CR 715.3d — the adventure exiles the card AS IT ' +
      'RESOLVES, so "a COUNTERED adventure goes to the graveyard — the exile is a RESOLUTION ' +
      'replacement" is the test that separates a resolution replacement from an on-cast one. ' +
      'Casting the creature half from exile, refusing the wrong face, and refusing a card with no ' +
      'permission at all, are each affirmed.',
  },
  '716': { status: 'not-applicable', reason: noCardHasIt('Class card') },
  '717': { status: 'not-applicable', reason: noCardHasIt('Attraction card') },
  '718': { status: 'not-applicable', reason: noCardHasIt('prototype card') },
  '719': { status: 'not-applicable', reason: noCardHasIt('Case card') },
  '720': { status: 'not-applicable', reason: noCardHasIt('Omen card') },
  '721': { status: 'not-applicable', reason: noCardHasIt('Station card') },
  '722': { status: 'not-applicable', reason: noCardHasIt('Preparation card') },
  '723': { status: 'not-applicable', reason: 'Controlling another player. ' + NOT_A_VARIANT },
  '724': {
    status: 'not-applicable',
    reason:
      'Ending turns and phases early ("end the turn"). No card in the pool does it, and the turn ' +
      'machine walks a fixed `STEP_ORDER` with no early exit.',
  },
  '725': { status: 'not-applicable', reason: 'The monarch. ' + NOT_A_VARIANT },
  '726': { status: 'not-applicable', reason: 'The initiative. ' + NOT_A_VARIANT },
  '727': { status: 'not-applicable', reason: 'Restarting the game (Karn Liberated). ' + noCardHasIt('game-restarting card') },
  '728': { status: 'not-applicable', reason: noCardHasIt('rad-counter card') },
  '729': { status: 'not-applicable', reason: 'Subgames (Shahrazad). ' + noCardHasIt('subgame card') },
  '730': { status: 'not-applicable', reason: 'Merging with permanents (mutate). ' + noCardHasIt('mutate card') },
  '731': {
    status: 'not-applicable',
    reason:
      'Day and night. The transform machinery exists (section 712) but nothing drives the ' +
      'day/night cycle, and ' + noCardHasIt('daybound or nightbound card'),
  },
  '732': {
    status: 'not-applicable',
    reason:
      'Taking shortcuts — a rule about human players agreeing to skip repetitive actions. The ' +
      'engine\'s equivalent (auto-passing empty priority windows) is a UI affordance, tested in ' +
      'apps/web/src/lib/play/auto-advance.test.ts, not a rule.',
  },
  '733': {
    status: 'cited',
    suite: 'packages/core/src/engine.test.ts',
    what:
      'CR 733 — handling illegal actions: back up to before the illegal action. This engine makes ' +
      'that structural — `applyAction` returns the PREVIOUS state plus an `actionRejected` event, ' +
      'so an illegal action cannot half-apply. "Rejects an action from a player without priority, ' +
      'without mutating state" and targeting.test.ts\'s "leaves the state untouched when it ' +
      'rejects (no mana spent, card still in hand)" are the two directions.',
  },

  // ======================= 8 — MULTIPLAYER =======================
  '800': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '801': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '802': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '803': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '804': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '805': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '806': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '807': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '808': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '809': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '810': { status: 'not-applicable', reason: NOT_MULTIPLAYER },
  '811': { status: 'not-applicable', reason: NOT_MULTIPLAYER },

  // ======================= 9 — CASUAL VARIANTS =======================
  '900': { status: 'not-applicable', reason: NOT_A_VARIANT },
  '901': { status: 'not-applicable', reason: 'Planechase. ' + NOT_A_VARIANT },
  '902': { status: 'not-applicable', reason: 'Vanguard. ' + NOT_A_VARIANT },
  '903': { status: 'not-applicable', reason: 'Commander. ' + NOT_A_VARIANT },
  '904': { status: 'not-applicable', reason: 'Archenemy. ' + NOT_A_VARIANT },
  '905': { status: 'not-applicable', reason: 'Conspiracy draft. ' + NOT_A_VARIANT },
};

// --- compile-time proofs over the engine's own vocabularies ---------------------

/**
 * Every keyword `KeywordFlags` can carry → the CR rule that defines it.
 *
 * ⚠️ **This is the KEYWORD_KEYS lesson, applied to the rules index.** Adding a
 * keyword to `KeywordFlags` and not to this map stops `tsc`. The failure it
 * prevents is a shipped keyword that no rule reference, and therefore no
 * conformance test, ever accounts for — the "invisibly absent" case this whole
 * directory exists to make impossible.
 */
export const KEYWORD_RULES: KeywordRules = {
  flying: '702.9',
  horsemanship: '702.31',
  vigilance: '702.20',
  haste: '702.10',
  firstStrike: '702.7',
  doubleStrike: '702.4',
  deathtouch: '702.2',
  trample: '702.19',
  reach: '702.17',
  defender: '702.3',
  lifelink: '702.15',
  flash: '702.8',
  hexproof: '702.11',
  shroud: '702.18',
  menace: '702.111',
  indestructible: '702.12',
  protectionFrom: '702.16',
  ward: '702.21',
  // "Can't be blocked" and "can't block" are not keyword abilities — they are
  // block RESTRICTIONS that a printed line states, checked where blockers are
  // declared. `minBlockers` is the general form of which menace is the N = 2
  // printing, so it indexes to the same declaration rule rather than to 702.111.
  unblockable: '509.1b',
  cantBlock: '509.1b',
  minBlockers: '509.1b',
  // Block REQUIREMENTS are the other half of the same rule, and they index to
  // 509.1c (the requirements themselves) rather than to 509.1b (the
  // restrictions) — the distinction is the whole reason they need a solver: CR
  // 509.1d resolves the two TOGETHER, maximising satisfied requirements without
  // violating any restriction.
  mustBeBlocked: '509.1c',
  blockedByAllAble: '509.1c',
  // A comparing restriction ("except by creatures with haste", a power bound,
  // skulk) is still a restriction, so it indexes with the others.
  blockRestriction: '509.1b',
};

/** Every step of a turn → the CR rule that defines it. Mapped over `Step`. */
export const STEP_RULES: StepRules = {
  untap: '502.1',
  upkeep: '503.1',
  draw: '504.1',
  precombatMain: '505.1',
  beginCombat: '507.1',
  declareAttackers: '508.1',
  declareBlockers: '509.1',
  combatDamage: '510.1',
  endCombat: '511.1',
  postcombatMain: '505.1',
  end: '513.1',
  cleanup: '514.1',
};

/** Every zone → the CR section that defines it. Mapped over `ZoneName`. */
export const ZONE_RULES: ZoneRules = {
  library: '401.1',
  hand: '402.1',
  battlefield: '403.1',
  graveyard: '404.1',
  stack: '405.1',
  exile: '406.1',
  command: '408.1',
};

/**
 * Every action a player may take → the rule that authorises it. Mapped over
 * `GameAction['kind']`, so a new action kind must name its rule.
 */
export const ACTION_RULES: ActionRules = {
  passPriority: '117.3d',
  playLand: '116.2a',
  tapForMana: '605.3b',
  castSpell: '601.2',
  cycleCard: '702.29',
  activateAbility: '602.2a',
  declareAttackers: '508.1a',
  declareBlockers: '509.1a',
  answerChoice: '601.2', // the engine's transport for every mid-announcement/resolution choice
};

/**
 * COMPILE-TIME PROOF that CR 613's absence is still SAFE — i.e. that every
 * continuous modification the engine can express is purely additive, which is
 * what makes "no layers, no timestamps" an exact model rather than a wrong one.
 *
 * `PermanentModification` is the one shape a static ability or a continuous
 * effect may take. While its only fields are a power delta, a toughness delta,
 * and a set of keywords to OR in, aggregation is commutative and CR 613.7's
 * timestamp ordering provably cannot change an answer.
 *
 * Add a SETTING field to it — `setPower`, `becomesType`, `losesAllAbilities` —
 * and this line stops type-checking. That is deliberate: at that moment the
 * layer system stops being optional, and section 613's manifest entry has to be
 * re-argued rather than silently inherited.
 *
 * This lives in shipped source, not in a test file: `packages/core/tsconfig.json`
 * excludes `*.test.ts`, and Vitest strips types without checking them, so a
 * proof written in a test would never be evaluated by anything.
 */
type ModificationFieldsAreAdditive =
  Exclude<
    keyof PermanentModification,
    // Each of these ADDS to what the permanent already has and can never
    // replace it: deltas sum, keyword flags union, and `activated` APPENDS to
    // the printed ability list (`effectiveActivated` keeps the printed ones
    // first, so a grant cannot renumber or remove an ability the card prints).
    'power' | 'toughness' | 'keywords' | 'activated'
  > extends never
    ? true
    : never;

/** The witness. If a setting-shaped field appears, this line fails to compile. */
export const MODIFICATION_IS_PURELY_ADDITIVE: ModificationFieldsAreAdditive = true;

// --- reading the manifest -------------------------------------------------------

/** Every title the named conformance file must collect — affirmations AND pins. */
export function coveredTitlesForFile(file: ConformanceFile): readonly string[] {
  const titles: string[] = [];
  for (const section of CR_SECTIONS) {
    const entry = RULES_MANIFEST[section];
    if (entry.status === 'covered') {
      for (const t of entry.tests) {
        if ((t.file ?? entry.file) === file) titles.push(`CR ${t.rule} — ${t.title}`);
      }
    } else if (entry.status === 'gap' && entry.pin) {
      for (const t of entry.pin.tests) {
        if ((t.file ?? entry.pin.file) === file) titles.push(`CR ${t.rule} — ${t.title}`);
      }
    }
  }
  return titles;
}

/** One line per status, for the report `manifest.test.ts` prints. */
export interface ManifestTotals {
  readonly covered: number;
  readonly cited: number;
  readonly notApplicable: number;
  readonly gap: number;
  /** Sections classified covered/cited that ALSO declare an unmet remainder. */
  readonly withShortfall: number;
  /** Conformance tests the manifest claims (affirmations only — pins excluded). */
  readonly affirmations: number;
  /** Gap-pin tests: assertions of what the engine does wrong TODAY. */
  readonly pins: number;
}

/** Count the manifest. Used by the suite's report and by its consistency checks. */
export function manifestTotals(): ManifestTotals {
  let covered = 0;
  let cited = 0;
  let notApplicable = 0;
  let gap = 0;
  let withShortfall = 0;
  let affirmations = 0;
  let pins = 0;
  for (const section of CR_SECTIONS) {
    const entry: ManifestEntry = RULES_MANIFEST[section];
    switch (entry.status) {
      case 'covered':
        covered++;
        affirmations += entry.tests.length;
        if (entry.shortfall) withShortfall++;
        break;
      case 'cited':
        cited++;
        if (entry.shortfall) withShortfall++;
        break;
      case 'not-applicable':
        notApplicable++;
        break;
      case 'gap':
        gap++;
        pins += entry.pin?.tests.length ?? 0;
        break;
    }
  }
  return { covered, cited, notApplicable, gap, withShortfall, affirmations, pins };
}

/** Every section classified as a gap, for the report and for COORDINATION.md. */
export function gapSections(): readonly CrSection[] {
  return CR_SECTIONS.filter((s) => RULES_MANIFEST[s].status === 'gap');
}

/**
 * Every rule reference the vocabulary maps point at. Used by `manifest.test.ts`
 * to prove no shipped keyword, step, zone or action indexes into a section the
 * manifest wrote off as not-applicable — which would be a contradiction: the
 * engine has the thing, so the rule cannot be out of scope.
 */
export function vocabularyRules(): readonly (readonly [string, CrRule])[] {
  return [
    ...Object.entries(KEYWORD_RULES).map(([k, r]) => [`keyword ${k}`, r] as const),
    ...Object.entries(STEP_RULES).map(([k, r]) => [`step ${k}`, r] as const),
    ...Object.entries(ZONE_RULES).map(([k, r]) => [`zone ${k}`, r] as const),
    ...Object.entries(ACTION_RULES).map(([k, r]) => [`action ${k}`, r] as const),
  ];
}

// Keep the imported engine types referenced so a future refactor that renames one
// breaks HERE, loudly, rather than silently detaching the proofs above from the
// vocabularies they are supposed to be proving things about.
export type ProvenVocabularies = readonly [KeywordFlags, Step, ZoneName, GameAction['kind']];
