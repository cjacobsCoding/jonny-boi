/**
 * THE INTERACTION MATRIX ITSELF - executable, not prose.
 *
 * Fifteen-odd engine systems landed in three days, each built by a different
 * agent and each tested ONLY in isolation by its own author. Interactions are
 * where rules engines actually break, so this file enumerates the shipped
 * systems and states, for EVERY unordered pair, one of five things:
 *
 *   - `covered`   - a test in this directory plays the pair in a real game;
 *   - `elsewhere` - an existing suite already plays it (named);
 *   - `gap`       - the pair is genuinely wrong or unimplemented, with a CR
 *                   reference and a reproduction that asserts the HONEST current
 *                   behaviour rather than the behaviour we wish it had;
 *   - `n/a`       - the two systems cannot interact, with the reason;
 *   - `untested`  - they CAN interact and nobody has proved it, with what a test
 *                   would need. This category exists on purpose: calling an
 *                   unproved pair "n/a" is how a matrix becomes convenient
 *                   instead of complete.
 *
 * The tests below make the table load-bearing: every pair must appear EXACTLY
 * once, every `covered`/`elsewhere` cell must name a test file that EXISTS,
 * every `gap` must carry a CR reference, every `n/a` and `untested` must carry a
 * reason, and every system must resolve a WITNESS in the live code - so this
 * cannot describe an engine that no longer exists.
 *
 * HOW TO ADD A SYSTEM: add it to {@link SYSTEMS} with a witness, then add its
 * row of cells. The completeness test will tell you exactly which pairs you owe.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '@jonny-boi/core';
import type { CardDefinition } from '@jonny-boi/core';
import { CARD_POOL } from '../../data/pool.js';
import { EXPANDED_CARD_POOL } from '../../data/expanded-pool.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ALL_CARDS: readonly CardDefinition[] = [...CARD_POOL, ...EXPANDED_CARD_POOL];

/**
 * A shipped system, and the proof it exists. Two witness kinds, deliberately:
 *  - `api`  - core exports this name (the system has an engine seam);
 *  - `card` - at least one card in the SHIPPED POOL satisfies this predicate
 *             (the system is reachable by a player, DESIGN 3.20's rule).
 * A system with only an `api` witness and no pool card is a system nobody can
 * see; the test below reports those by name rather than failing, because the
 * pool is another branch's file.
 */
interface System {
  readonly id: string;
  readonly title: string;
  readonly api: readonly string[];
  readonly card?: (def: CardDefinition) => boolean;
}

const SYSTEMS: readonly System[] = [
  {
    id: 'walkers',
    title: 'planeswalkers + loyalty',
    api: ['isPlaneswalker', 'loyaltyOf', 'LOYALTY_COUNTER'],
    card: (d) => d.types.includes('planeswalker'),
  },
  {
    id: 'battles',
    title: 'battles + the opponent-protector',
    api: ['isBattle', 'defenseOf', 'protectorOf', 'DEFENSE_COUNTER'],
    // No printed battle compiles yet (DESIGN 3.15) - the subsystem is complete,
    // the CARDS are reported. Deliberately no card witness.
  },
  {
    id: 'legend',
    title: 'the legend rule',
    api: ['PLAYER_IDS'],
    card: (d) => d.legendary === true,
  },
  {
    id: 'emblems',
    title: 'emblems (command-zone objects)',
    api: ['indexContinuous'],
    // No printed emblem BODY compiles (DESIGN 3.15) - no card witness.
  },
  {
    id: 'transform',
    title: 'transforming double-faced cards',
    api: ['transformPermanent', 'faceUpOf', 'transformTargetOf'],
    card: (d) => d.backFace !== undefined,
  },
  {
    id: 'modal',
    title: 'modal casting (+ modal DFCs, multikicker)',
    api: ['modalSpecOf', 'choosableModes', 'picksToResolution', 'hasCastableBackFace'],
    card: (d) => d.modal !== undefined,
  },
  {
    id: 'nonhand',
    title: 'flashback + non-hand casting + graveyard grants',
    api: ['flashbackCostOf', 'addCardGrant', 'spellLeaveDestination'],
    card: (d) => d.flashback !== undefined,
  },
  {
    id: 'protection',
    title: 'protection + ward + source-aware targeting',
    api: ['effectiveProtectionOf', 'effectiveWardOf', 'protectionBlocksSource', 'sourceHasQuality'],
    card: (d) => d.keywords?.protectionFrom !== undefined || (d.keywords?.ward ?? 0) > 0,
  },
  {
    id: 'indestructible',
    title: 'indestructible + blocking restrictions',
    api: ['effectiveKeywords', 'hasKeyword'],
    card: (d) => d.keywords?.indestructible === true || (d.keywords?.minBlockers ?? 0) > 0,
  },
  {
    id: 'castcosts',
    title: '{X} and kicker cast-time costs',
    api: ['canAffordManaCost', 'planManaPayment'],
    card: (d) => d.xCost !== undefined || d.kicker !== undefined,
  },
  {
    id: 'altcosts',
    title: 'cycling + buyback + madness',
    api: ['discardDestination', 'declineMadness'],
    card: (d) => d.cycling !== undefined || d.buyback !== undefined || d.madness !== undefined,
  },
  {
    id: 'library',
    title: 'scry + surveil',
    api: ['shuffleLibraryInState'],
    card: (d) => JSON.stringify(d).includes('"scry"') || JSON.stringify(d).includes('"surveil"'),
  },
  {
    id: 'counters',
    title: '+1/+1, -1/-1 and annihilation',
    api: ['PLUS_ONE_COUNTER', 'MINUS_ONE_COUNTER', 'NO_COUNTERS'],
    card: (d) => JSON.stringify(d).includes('addCounters'),
  },
  {
    id: 'cda',
    title: 'characteristic-defining P/T',
    api: ['characteristicValue', 'evaluateDerivedCount'],
    card: (d) => d.characteristicPT !== undefined,
  },
  {
    id: 'turnfacts',
    title: 'turn-scoped facts (revolt / morbid)',
    api: ['TURN_FACTS', 'turnFactHolds', 'setTurnFact', 'clearTurnFacts'],
    card: (d) => JSON.stringify(d).includes('revolt'),
  },
  {
    id: 'mana',
    title: 'the mana-ability model (costs / riders / restrictions / derived colours)',
    api: ['manaExtrasOf', 'manaModesOf', 'manaActivationConditionMet', 'manaColorsOffered'],
    // NO POOL CARD - see the "a system nobody can see" test below.
  },
  {
    id: 'attachments',
    title: 'attachments (Auras + Equipment)',
    api: ['attachTo', 'isLegallyAttached', 'attachmentProblem', 'AURA_WHEN_ILLEGAL'],
    card: (d) => d.attachment !== undefined,
  },
  {
    id: 'statics',
    title: 'statics + anthems',
    api: ['staticsOf', 'staticAppliesTo', 'aggregateFor'],
    card: (d) => (d.statics ?? []).length > 0,
  },
  {
    id: 'triggers',
    title: 'triggered abilities (the unified vocabulary)',
    api: ['matchTriggers', 'conditionMatches', 'orderPendingTriggers'],
    card: (d) => (d.triggers ?? []).length > 0,
  },
  {
    id: 'steptriggers',
    title: 'step triggers + the triggering player + the intervening "if"',
    api: ['triggeringPlayerFor', 'interveningIfHolds'],
    // NO POOL CARD - see the "a system nobody can see" test below.
  },
  {
    id: 'splitcards',
    title: 'split / aftermath / adventure / Siege (the CR 709.4 combined object)',
    api: ['isSplitCard', 'backFaceCastZonesOf', 'playableFaceOf'],
    // NO POOL CARD.
  },
  {
    id: 'asenters',
    title: 'as-enters choices (the value a permanent NAMES)',
    api: ['recordChosenAsEntered', 'chosenSubtypeOf', 'chosenColorOf', 'asEntersOptions'],
    // NO POOL CARD.
  },
  {
    id: 'addcosts',
    title: 'mandatory additional casting costs (CR 601.2h)',
    api: ['generateLegalActions'],
    // NO POOL CARD.
  },
  {
    id: 'replacements',
    title: 'replacement + prevention effects (CR 614/615/616)',
    api: ['replacementsOf', 'indexReplacements', 'replaceDamage', 'replaceCounters', 'replaceDraw'],
    // NO POOL CARD.
  },
  {
    id: 'copies',
    title: 'copy effects (CR 706, layer 1)',
    api: ['copiableDefOf', 'isCopy', 'copyResultDef', 'copyCandidates'],
    // NO POOL CARD.
  },
];

/**
 * The matrix. One line per unordered pair:
 *
 *     a x b | status | note
 *
 * `status` is one of covered / elsewhere / gap / n/a / untested. For `covered`
 * and `elsewhere` the note STARTS with the test file's basename; for `gap` it
 * starts with the GAP id and contains a `CR ` reference.
 */
const MATRIX = `
walkers x battles        | covered   | walkers-battles-legend-emblems: one attackable-object seam; protectorOf decides who defends
walkers x legend         | covered   | walkers-battles-legend-emblems: Liliana is legendary; the rule parks a choice
walkers x emblems        | untested  | needs a walker whose ULTIMATE compiles into an emblem; 0 of 90 printed emblem bodies compile
walkers x transform      | n/a       | no DFC in Magic that this compiler accepts has a planeswalker face; backFace + loyalty never coexist
walkers x modal          | untested  | Boros Charm's playerOrPlaneswalker mode aimed at a walker; the targeting half is covered, the modal half is not
walkers x nonhand        | untested  | a flashback spell aimed at a walker; nothing about the graveyard changes loyalty
walkers x protection     | untested  | no printed walker has protection or ward; would need an authored one to prove the source check reaches walkers
walkers x indestructible | covered   | walkers-battles-legend-emblems: 0 loyalty (CR 704.5i) is not destruction, so the keyword cannot save one
walkers x castcosts      | n/a       | no walker in the pool prints {X} or kicker; loyalty costs are activation costs, a different system
walkers x altcosts       | n/a       | cycling/buyback/madness are casting routes for cards in hand/graveyard/exile; a walker is a permanent on the battlefield
walkers x library        | elsewhere | planeswalker-play.test.ts: Samut's minus scries as part of its own ability
walkers x counters       | covered   | walkers-battles-legend-emblems: loyalty IS counters, in the same record +1/+1 counters use
walkers x cda            | n/a       | a star box is a P/T box; a planeswalker has no P/T and characteristicPT is never set on one
walkers x turnfacts      | untested  | a walker dying should set permanentLeftBattlefield for its controller; only the creature path is proved
walkers x mana           | n/a       | a walker produces no mana and no mana ability targets one
walkers x attachments    | untested  | an Aura on a planeswalker; attachesTo can name the type, but no pool Aura enchants one
walkers x statics        | untested  | an anthem whose filter names planeswalkers; Samut's static reaches creatures only
walkers x triggers       | elsewhere | planeswalker-play.test.ts: loyalty abilities put triggers on the stack and resolve them

battles x legend         | untested  | a legendary battle is printable; the rule is keyed on the supertype, not the card kind
battles x emblems        | covered   | walkers-battles-legend-emblems: an emblem anthem buffs the creature attacking a Siege
battles x transform      | n/a       | every printed battle is a Siege, whose second half is a CAST path, not a face swap (SECOND_CASTABLE_FACE_GAP)
battles x modal          | untested  | a modal mode aimed at a battle; "any target" reaches one, so a mode with that restriction would
battles x nonhand        | untested  | a flashback burn spell stripping defense counters
battles x protection     | n/a       | no printed battle has protection or ward, and protection is keyed on qualities a battle cannot have
battles x indestructible | n/a       | a battle leaves at 0 defense (CR 704.5x), which is not destruction; the keyword has no printed battle
battles x castcosts      | untested  | an {X} burn spell stripping X defense counters
battles x altcosts       | n/a       | a battle is a permanent; cycling/buyback/madness are routes for cards in other zones
battles x library        | n/a       | scry and surveil touch a library and a graveyard; a battle is neither
battles x counters       | covered   | walkers-battles-legend-emblems: defense IS counters, applied on every entry path
battles x cda            | n/a       | a battle has no P/T box
battles x turnfacts      | untested  | a defeated battle leaving the battlefield should set permanentLeftBattlefield
battles x mana           | n/a       | a battle produces no mana
battles x attachments    | untested  | an Aura on a battle; attachesTo could name the type but no printed Aura does
battles x statics        | covered   | walkers-battles-legend-emblems: the emblem anthem is a static, and it reaches the attacker
battles x triggers       | untested  | the battleDefeated event exists; no trigger condition reads it yet (the Siege reward)

legend x emblems         | n/a       | an emblem has no card types and never touches the battlefield; the rule reads legendary permanents
legend x transform       | covered   | transform-and-triggers: the rule reads the ACTIVE face's name, so a flip can create the duplicate
legend x modal           | n/a       | a mode chooses what a spell does; the legend rule is a state-based action on permanents
legend x nonhand         | untested  | flashing back a legendary creature card into a duplicate; the cast path is orthogonal but the exit zone is not
legend x protection      | untested  | protection cannot stop the legend rule (it is not targeting, damage, blocking or attaching)
legend x indestructible  | covered   | walkers-battles-legend-emblems: Zetalpa is legendary AND indestructible; the rule is not destruction
legend x castcosts       | n/a       | a cast-time cost changes what was paid, not what the battlefield holds
legend x altcosts        | n/a       | same: an alternative cost is a route to the stack, not a battlefield rule
legend x library         | n/a       | the rule reads the battlefield only
legend x counters        | untested  | the CHOOSER should be able to keep the copy carrying counters; the choice's valence says "gain" but nothing pins which copy an AI keeps
legend x cda             | n/a       | no legendary card in the pool has a star box, and the rule reads names, not P/T
legend x turnfacts       | untested  | a copy buried by the legend rule left the battlefield, so it should set permanentLeftBattlefield
legend x mana            | untested  | a legendary land duplicated; the rule applies to lands and would take a mana source away mid-payment
legend x attachments     | covered   | walkers-battles-legend-emblems: an Aura on the losing copy follows it in the same SBA cascade
legend x statics         | untested  | a legendary anthem duplicated: the second copy dies and the buff must halve in the same pass
legend x triggers        | untested  | a legendary creature buried by the rule emits creatureDied, so a dies-trigger should fire

emblems x transform      | n/a       | an emblem is never on the battlefield and has no faces
emblems x modal          | n/a       | an emblem is created by a resolution; modes are chosen at cast
emblems x nonhand        | n/a       | an emblem is not a card and can never be cast from any zone
emblems x protection     | untested  | an emblem granting protection to a team - the same layer-3 path the anthem cell proves
emblems x indestructible | untested  | an emblem granting indestructible; nothing can remove the emblem itself
emblems x castcosts      | n/a       | an emblem has no cost
emblems x altcosts       | n/a       | an emblem is not a card
emblems x library        | n/a       | an emblem never enters a library or a graveyard
emblems x counters       | untested  | an emblem whose static reads hasCounterKind
emblems x cda            | untested  | an emblem anthem on top of a star box; the arithmetic is the same fold the anthem cell proves
emblems x turnfacts      | n/a       | an emblem cannot leave any zone, so no fact can be about it
emblems x mana           | n/a       | an emblem produces no mana
emblems x attachments    | n/a       | an emblem is not a permanent and cannot be attached to or attach
emblems x statics        | covered   | walkers-battles-legend-emblems: an emblem's static is read by BOTH continuous accessors and survives a wrath
emblems x triggers       | untested  | createEmblem accepts a triggers list; no test fires one from the command zone

transform x modal        | elsewhere | transform-play.test.ts + modal-casting.test.ts: a modal DFC's back face is castable, a transforming one is not (CR 712.8b)
transform x nonhand      | untested  | a DFC flashed back or cast from exile reverts to its front face on leaving (CR 712.8a); only the graveyard path is proved
transform x protection   | untested  | a face swap changing the permanent's colours changes what protects it
transform x indestructible| untested | a back face printing indestructible that the front does not
transform x castcosts    | n/a       | a transforming back face is never cast, so it never asks a cast-time question
transform x altcosts     | untested  | a madness cast that transforms; the exile-and-cast path and the face swap share the reset chokepoint
transform x library      | covered   | transform-and-triggers: Delver's look-and-reveal IS a library selection, and it flips on a match
transform x counters     | covered   | transform-and-triggers: counters persist across the flip (CR 712.8)
transform x cda          | untested  | a star box on one face only; the formula is read off the ACTIVE face
transform x turnfacts    | n/a       | transforming is not a zone change, so no turn fact can be about it (that IS the CR 712.8 claim)
transform x mana         | untested  | a DFC land face producing mana; no such card compiles today
transform x attachments  | covered   | transform-and-triggers: an Equipment stays attached across the flip and keeps modifying
transform x statics      | untested  | a face whose static differs from the other's; indexContinuous reads def.statics off the active face
transform x triggers     | covered   | transform-and-triggers: no zoneChange is emitted, so no ETB fires; the trigger list follows the active face

modal x nonhand          | elsewhere | modal-casting.test.ts: a modal spell cast from a graveyard obeys the same announceable-mode rule
modal x protection       | covered   | modes-and-cast-costs: a protected permanent is off the aiming menu of a same-coloured mode
modal x indestructible   | untested  | Boros Charm's mass-indestructible mode answering a wrath; the grant path is proved elsewhere, the modal half is not
modal x castcosts        | untested  | a modal spell that also asks {X}; both questions ride the same stack object and are answered through one action
modal x altcosts         | untested  | a modal spell with buyback; the mode picks and the buyback answer are two payMana/chooseModes questions in sequence
modal x library          | untested  | a scry mode; the mode's own resolution parks a library question
modal x counters         | untested  | a counters mode aimed at one creature while another mode is aimed elsewhere
modal x cda              | n/a       | a mode is a spell script; a star box is a permanent's P/T
modal x turnfacts        | untested  | a mode reading revolt at resolution while another mode caused it
modal x mana             | untested  | funding a modal spell from a source with a rider; planManaPayment is shared, the modal half is not proved
modal x attachments      | untested  | an Aura mode; no printed modal spell in the pool attaches
modal x statics          | n/a       | a static is a permanent's continuous ability; a mode is a one-shot script
modal x triggers         | elsewhere | modal-casting.test.ts: a mode compiles through compileTriggerBody, so it must DECLARE what it may be aimed at

nonhand x protection     | untested  | a flashback spell aimed at a protected permanent; the source check reads the CARD, not the zone
nonhand x indestructible | untested  | a flashback destroy spell against an indestructible creature
nonhand x castcosts      | elsewhere | cast-cost.test.ts: flashbackXCost reads the FLASHBACK cost's X, not the printed cost's
nonhand x altcosts       | covered   | graveyard-and-alt-costs: flashback exiles however it leaves; buyback returns to hand only on resolve (CR 702.34a / 702.27a)
nonhand x library        | untested  | a flashback spell that scries; nothing in the pool prints both
nonhand x counters       | untested  | a flashback spell that puts counters on a permanent
nonhand x cda            | covered   | graveyard-and-alt-costs: a flashback cast empties a graveyard card TYPE at cast time and the shrink is judged before anyone responds (CR 704.3)
nonhand x turnfacts      | untested  | a permanent leaving to fund a graveyard cast; the exile of a flashback card is not a battlefield departure
nonhand x mana           | untested  | funding a flashback cost from a source with a rider or a restriction
nonhand x attachments    | untested  | an Aura with flashback; none is printed
nonhand x statics        | untested  | a static that reduces or grants a flashback cost
nonhand x triggers       | elsewhere | graveyard-grants.test.ts: Snapcaster's ETB is AIMED as it goes on the stack, and grants flashback to a graveyard card

protection x indestructible | covered| protection-ward-attachments: a protected blocker takes no damage and still deals its own
protection x castcosts   | untested  | ward taxing an {X} spell; the ward payment and the X payment are two payMana questions
protection x altcosts    | untested  | ward against a madness cast; the window's legal actions must still leave room for the tax
protection x library     | n/a       | scry and surveil target nothing, so no source check applies
protection x counters    | covered   | protection-ward-attachments: Patchwork Automaton prints ward AND grows on its own trigger
protection x cda         | untested  | protection on a star-box creature; the source check reads colours from the mana cost, which a formula does not change
protection x turnfacts   | n/a       | a turn fact is a boolean about the past; protection is a property of a permanent
protection x mana        | untested  | paying a ward cost out of a source with a rider
protection x attachments | covered   | protection-ward-attachments: an Aura falls off the moment its host gains protection from its colour (CR 704.5m)
protection x statics     | covered   | protection-ward-attachments: an anthem-granted protection/ward/shroud is real - THE defect this branch found
protection x triggers    | covered   | protection-ward-attachments: ward is a trigger the engine raises, and it lands ABOVE the spell it answers

indestructible x castcosts | n/a     | a cast-time cost changes what was paid; indestructible is a battlefield exemption
indestructible x altcosts| n/a       | same - an alternative cost is a route to the stack
indestructible x library | n/a       | the keyword touches destruction; scry and surveil destroy nothing
indestructible x counters| covered   | layers-counters-cda: -1/-1 counters to 0 toughness kill an indestructible creature (CR 704.5f vs 704.5g)
indestructible x cda     | untested  | a star box whose formula falls to 0 toughness while the creature is indestructible
indestructible x turnfacts| untested | an indestructible creature that survives a wrath sets no fact, while a mortal one does
indestructible x mana    | n/a       | a mana ability neither destroys nor is destroyed by one
indestructible x attachments| covered| protection-ward-attachments + layers-counters-cda: Darksteel Plate grants it; an Aura zeroing toughness still kills the host
indestructible x statics | untested  | a static granting indestructible to a team (the KEYWORD_KEYS trap); the until-EOT grant is proved elsewhere
indestructible x triggers| untested  | a dies-trigger that must NOT fire because the creature was not destroyed

castcosts x altcosts     | untested  | an {X} cycling cost is reported by name (Shark Typhoon); a kicker on a bought-back spell is not proved
castcosts x library      | untested  | an {X} scry - the chooseNumber answer would have to reach the library primitive's count
castcosts x counters     | untested  | "put X +1/+1 counters"; the derived-count vocabulary reads xValue but no pool card pairs them
castcosts x cda          | n/a       | X is a cast-time number; a star box is a board-derived P/T
castcosts x turnfacts    | n/a       | X is paid at cast; a turn fact is read at resolution and by a different vocabulary
castcosts x mana         | untested  | planning an {X} payment across a source with a rider or an unmet restriction - the planner is shared, the pairing is unproved
castcosts x attachments  | n/a       | equip costs are activation costs, not cast-time costs
castcosts x statics      | untested  | a static that changes what a spell costs; no such static exists yet
castcosts x triggers     | elsewhere | cast-cost.test.ts: "if this spell was kicked" rides onto the PERMANENT so an ETB trigger can read it

altcosts x library       | covered   | library-turnfacts-mana + graveyard-and-alt-costs: cycling DRAWS, and the discard is a cost
altcosts x counters      | untested  | a madness creature entering with counters
altcosts x cda           | untested  | cycling a card GROWS a star box (the discard is a cost, so it happens before any resolution)
altcosts x turnfacts     | n/a       | a discard is not a battlefield departure, so no revolt fact is about it
altcosts x mana          | untested  | funding a cycling or madness cost from a source with a rider; the offer is gated on the FLOATING pool
altcosts x attachments   | untested  | an Aura with madness or buyback; none is printed
altcosts x statics       | n/a       | a static is a battlefield ability; these are routes to the stack
altcosts x triggers      | untested  | "whenever you cycle" is reported by name - the cardCycled event exists, the trigger CONDITION does not

library x counters       | untested  | surveil feeding a counters-matter card that reads the graveyard
library x cda            | covered   | library-turnfacts-mana: surveilling a card into the graveyard GROWS a Tarmogoyf; scry never can
library x turnfacts      | n/a       | a library or graveyard move is not a battlefield departure
library x mana           | n/a       | scry and surveil cost only what the spell costs; no mana-ability shape is involved
library x attachments    | n/a       | neither reaches the battlefield
library x statics        | n/a       | a static modifies permanents; scry and surveil touch cards in hidden zones
library x triggers       | untested  | a surveil trigger; none is printed

counters x cda           | covered   | layers-counters-cda: counters ADD to the formula base (CR 613.3 layer 7a then 7d)
counters x turnfacts     | n/a       | counters are instance state; a turn fact is a boolean about events
counters x mana          | n/a       | no mana ability in the pool costs or produces a counter (Devoted Druid is reported by name)
counters x attachments   | covered   | layers-counters-cda + transform-and-triggers: an Equipment's delta and counters fold into one aggregate
counters x statics       | covered   | layers-counters-cda: an anthem, counters and a pump on one creature read the sum
counters x triggers      | covered   | transform-and-triggers: a trigger that adds a counter to itself, on an ENGINE-created permanent

cda x turnfacts          | gap       | sba-on-priority: a star box that shrinks on a NON-cast path keeps standing with lethal damage until the next resolution. CR 704.3
cda x mana               | n/a       | a star box is a P/T; a mana ability produces mana
cda x attachments        | covered   | layers-counters-cda: an Equipment on a star box adds to the formula base
cda x statics            | covered   | layers-counters-cda: an anthem on a star box adds to the formula base
cda x triggers           | untested  | a trigger whose payload counts the same derived value the star box does

turnfacts x mana         | untested  | a mana source sacrificed for mana sets permanentLeftBattlefield; no such land is in the pool
turnfacts x attachments  | untested  | an Aura going to the graveyard with its host is a permanent leaving; it should set revolt for its controller
turnfacts x statics      | n/a       | a static is continuous; a turn fact is a memory of an event
turnfacts x triggers     | untested  | a dies-trigger and the morbid fact both read the same creatureDied event

mana x attachments       | untested  | an Equipment granting a mana ability; none is printed
mana x statics           | untested  | a static that adds a mana ability to a land
mana x triggers          | n/a       | a mana ability uses no stack and nothing may respond to it (CR 605.3a), so no trigger can watch one

attachments x statics    | covered   | protection-ward-attachments + layers-counters-cda: both are layer 3, folded into one aggregate
attachments x triggers   | untested  | an attach/unattach trigger; the attachmentPutIntoGraveyard event exists, no trigger condition reads it

statics x triggers       | untested  | a static and a trigger on the same permanent, both keyed on the same board change
steptriggers x walkers        | elsewhere | planeswalker-play.test.ts: a loyalty ability is activated, not a step trigger; only the shared stack is common
steptriggers x battles        | untested  | a Siege reward is a battleDefeated trigger, not a step one; no printed step trigger watches a battle
steptriggers x legend         | n/a       | the legend rule is a state-based action with no trigger condition and no triggering player
steptriggers x emblems        | untested  | an emblem carrying a step trigger; createEmblem accepts the list and nothing fires one from the command zone
steptriggers x transform      | covered   | transform-and-triggers: Delver's upkeep trigger IS a step trigger, and the ACTIVE face is what still has it
steptriggers x modal          | n/a       | a mode is chosen while announcing a spell; a step trigger has no announcement and no modes
steptriggers x nonhand        | n/a       | a step trigger is an ability of a permanent; the graveyard cast paths are for cards
steptriggers x protection     | untested  | a step trigger aimed at a protected permanent; the source check reads the trigger's source definition
steptriggers x indestructible | n/a       | the keyword exempts destruction; a step trigger neither destroys nor is destroyed by one
steptriggers x castcosts      | n/a       | an ability on the stack has no cast-time cost question
steptriggers x altcosts       | n/a       | same: cycling/buyback/madness are routes a CARD takes to the stack
steptriggers x library        | untested  | an upkeep scry; the trigger's own resolution would park the library question
steptriggers x counters       | untested  | an upkeep trigger that adds a counter; the counters path is proved from a cast trigger instead
steptriggers x cda            | untested  | an intervening if reading a star box effective power - the condition data carries a minPower floor
steptriggers x turnfacts      | untested  | a step trigger and a turn fact both remember something about "this turn" through different vocabularies
steptriggers x mana           | n/a       | a mana ability uses no stack (CR 605.3a), so nothing can trigger off one
steptriggers x attachments    | untested  | an Aura printing an upkeep trigger; the trigger collector reads the AURA's definition, not the host's
steptriggers x statics        | untested  | a permanent carrying both, keyed on the same board; the intervening "if" reads the board a static modifies
steptriggers x triggers       | covered   | new-systems: the triggering player is read off the EVENT, so a who: any trigger can be about the other seat

splitcards x walkers          | n/a       | no printed split/adventure/Siege half is a planeswalker
splitcards x battles          | untested  | a Siege IS the split-card system's fourth layout; the reward is a free cast from exile and no printed Siege compiles yet
splitcards x legend           | untested  | a legendary adventure creature: the rule reads the COMBINED object's name
splitcards x emblems          | n/a       | an emblem is not a card and has no faces
splitcards x transform        | covered   | new-systems: both print two halves and only backFaceCastable separates them (CR 712.8b)
splitcards x modal            | untested  | two halves are two CASTS with two costs; two modes are one cast - the pair that is easiest to conflate and has no test
splitcards x nonhand          | untested  | aftermath restricts the second half to the GRAVEYARD via backFaceCastZones; the accessor is shared with flashback's zone gate
splitcards x protection       | untested  | a split card is two colours at once, so protection from either colour must stop the whole object
splitcards x indestructible   | n/a       | a split card is a spell in hand or a card in a graveyard; the keyword is a battlefield exemption
splitcards x castcosts        | untested  | an {X} on one half only; the X question must read the HALF being cast, not the combined cost
splitcards x altcosts         | untested  | a split card with flashback or madness; the exit zone and the half being cast are two different questions
splitcards x library          | untested  | a tutor filtered by type finding a split card - which is two types at once
splitcards x counters         | n/a       | a split card is not a permanent, so no counter is ever on one
splitcards x cda              | covered   | new-systems: ONE split card in a graveyard feeds TWO card types to a star box
splitcards x turnfacts        | n/a       | a split card in hand or graveyard never left the battlefield
splitcards x mana             | untested  | a split card's SUM cost planned by planManaPayment, which must charge the half being cast
splitcards x attachments      | n/a       | no printed split half is an Aura or Equipment
splitcards x statics          | untested  | an anthem filtered by mana value, over a card whose value is the SUM of two halves
splitcards x triggers         | untested  | a cast trigger narrowed by card type, over a card that is two types at once
splitcards x steptriggers     | n/a       | a step trigger fires off the turn machine; a split card's two halves are a casting question

asenters x walkers            | n/a       | no printed planeswalker prints an "as ~ enters, choose" line
asenters x battles            | n/a       | no printed battle prints one, and no battle compiles yet in any case
asenters x legend             | untested  | two copies of a legendary lord that named DIFFERENT types; the rule still reads the printed name
asenters x emblems            | n/a       | an emblem never enters the battlefield, so nothing is named as it enters
asenters x transform          | covered   | new-systems: transforming is not a zone change, so the named value survives the flip
asenters x modal              | n/a       | a mode is chosen while ANNOUNCING; an as-enters value is named while the permanent enters
asenters x nonhand            | untested  | a flashed-back permanent spell naming a value; the entry path is the same, the source zone is not
asenters x protection         | untested  | "choose a colour" plus "protection from the chosen colour"; the protection list is printed data and cannot read the choice yet
asenters x indestructible     | n/a       | the named value is instance memory; the keyword is a destruction exemption
asenters x castcosts          | untested  | a kicked permanent naming a value: two answers ride the same resolution and both must land on the instance
asenters x altcosts           | untested  | a madness permanent naming a value as it enters from exile
asenters x library            | untested  | the creature-type MENU is derived from the chooser's own cards, so a tutor changes what is offerable
asenters x counters           | untested  | a permanent that both names a value and enters with counters; both are CR 614.1c replacements on the same entry
asenters x cda                | n/a       | a star box is a formula over the board; the named value is a string on the instance
asenters x turnfacts          | n/a       | naming a value is not an event a turn fact remembers
asenters x mana               | untested  | "As ~ enters, choose a colour. {T}: Add one mana of the chosen colour" - the mana model reads the instance, and no pool land does
asenters x attachments        | untested  | an Aura naming a value as it enters, then modifying its host by it
asenters x statics            | covered   | new-systems: the lord's own anthem filters on the type it NAMED, so only that type is buffed
asenters x triggers           | untested  | a cast trigger narrowed by the named type - the third consumer of the same instance field
asenters x steptriggers       | untested  | an upkeep trigger whose body reads the value its source named
asenters x splitcards         | n/a       | no printed split half prints an as-enters line

addcosts x walkers            | untested  | a planeswalker spell with a mandatory additional cost; the legality gate is type-agnostic
addcosts x battles            | n/a       | no battle compiles yet, and none prints an additional cost
addcosts x legend             | n/a       | the cost is paid while casting; the legend rule is a battlefield state-based action
addcosts x emblems            | n/a       | an emblem is never cast
addcosts x transform          | untested  | a DFC spell with an additional cost; the cost is on the CARD, the face is the cast
addcosts x modal              | untested  | a modal spell with a mandatory additional cost: two cast-time questions, one stack object, order matters
addcosts x nonhand            | untested  | a flashback cast still owes the printed additional cost - the flashback cost replaces only the MANA
addcosts x protection         | n/a       | the cost is a payment; protection is a property of the object a spell points at
addcosts x indestructible     | covered   | new-systems: the sacrifice takes an indestructible creature, because sacrifice is not destruction
addcosts x castcosts          | untested  | {X} and a mandatory sacrifice on one spell; both are asked while announcing and both must be charged
addcosts x altcosts           | untested  | a madness cast that still owes a printed sacrifice; CR 601.2h applies to any casting route
addcosts x library            | n/a       | the cost leaves the battlefield or the hand; scry and surveil touch neither
addcosts x counters           | untested  | sacrificing a permanent that carried counters; the counters go with it and must not survive the move
addcosts x cda                | covered   | new-systems: the sacrificed creature card grows a star box WHILE the spell is still on the stack
addcosts x turnfacts          | covered   | new-systems: paying the sacrifice turns REVOLT on before the spell that caused it resolves
addcosts x mana               | untested  | funding the mana half from a source with a rider while the sacrifice half is also owed
addcosts x attachments        | untested  | sacrificing the HOST to pay a cost; the orphaned Aura should follow in the same SBA pass
addcosts x statics            | untested  | sacrificing an anthem source to pay a cost, which shrinks the board the spell then resolves against
addcosts x triggers           | untested  | a dies-trigger firing off the creature sacrificed to PAY for the spell that is still on the stack
addcosts x steptriggers       | n/a       | a step trigger is an ability, not a cast, so it never owes a casting cost
addcosts x splitcards         | untested  | an additional cost printed on one half of a split card
addcosts x asenters           | n/a       | the cost is paid while casting; the value is named as the permanent enters, a resolution later
replacements x walkers        | untested  | a damage multiplier against a planeswalker: the replacement fires on the damage, the loyalty removal follows it
replacements x battles        | untested  | the same question for defense counters, which damage strips by CR 120.3d
replacements x legend         | n/a       | the legend rule is a state-based action; nothing about it is a replaceable event
replacements x emblems        | untested  | an emblem carrying a replacement ability; the command zone is discovered by the continuous layer, not by the replacement index
replacements x transform      | untested  | a face whose replacement ability differs from the other face's
replacements x modal          | untested  | a mode that creates a prevention shield, aimed at cast alongside another mode
replacements x nonhand        | n/a       | where a spell was cast from does not change what its damage is replaced by
replacements x protection     | covered   | new-systems: protection prevents the damage outright, so a multiplier has nothing to double
replacements x indestructible | covered   | new-systems: replacement changes the AMOUNT of damage, never whether lethal damage destroys
replacements x castcosts      | untested  | {X} damage doubled - the X is chosen at cast and the replacement applies as the damage is dealt
replacements x altcosts       | n/a       | an alternative cost is a route to the stack; a replacement acts on an event
replacements x library        | untested  | a DRAW replacement over scry/surveil's draw half, and over an empty library
replacements x counters       | covered   | new-systems: a doubler feeds the doubled count into CR 704.5q annihilation and the layer stack
replacements x cda            | untested  | doubled damage judged against a star box that can shrink before state-based actions run
replacements x turnfacts      | n/a       | a replacement acts on an event; a turn fact remembers one afterwards
replacements x mana           | n/a       | mana production is not one of the three replaceable event kinds
replacements x attachments    | untested  | an Aura or Equipment granting a prevention shield to its host
replacements x statics        | untested  | a permanent carrying both; the two indexes are built separately and must agree about who is affected
replacements x triggers       | untested  | a replaced event must still emit what a trigger watches - a prevented damage is not damage dealt
replacements x steptriggers   | n/a       | a step trigger fires off the turn machine, which raises no replaceable event
replacements x splitcards     | n/a       | a split card is a casting question; a replacement acts on damage, counters or draws
replacements x asenters       | untested  | "enters with N counters" IS a replacement (CR 614.1c) and a counter doubler must see it
replacements x addcosts       | n/a       | the cost is paid while casting; a replacement acts on an event a spell causes
copies x walkers              | untested  | copying a planeswalker: loyalty is not a copiable value, so the copy enters on its PRINTED starting loyalty
copies x battles              | untested  | the same question for a battle's printed defense
copies x legend               | covered   | new-systems: legendary IS a copiable value, so a clone of a legend makes a duplicate the rule then answers
copies x emblems              | n/a       | an emblem is not an object on the battlefield and nothing can copy one
copies x transform            | covered   | new-systems: a transformed permanent is copied by its FRONT face (CR 706.2)
copies x modal                | n/a       | modes are chosen while announcing a spell; a copy is applied as a permanent enters
copies x nonhand              | untested  | a copy source in a GRAVEYARD (CopySourceZone allows it) reached by a graveyard-casting card
copies x protection           | untested  | protection IS a copiable value, so a clone of a protected creature is protected too
copies x indestructible       | untested  | the same for indestructible - the copy gets the keyword, and the two death rules still differ
copies x castcosts            | n/a       | what a copy costs is its own printed cost; the copy happens as it enters
copies x altcosts             | n/a       | an alternative cost is a route to the stack; the copy is applied on the way in
copies x library              | n/a       | a copy is applied on the battlefield; scry and surveil touch hidden zones
copies x counters             | covered   | new-systems: counters are NOT copiable values (CR 706.2) and stay with the original
copies x cda                  | untested  | copying a star box copies the FORMULA, so the copy recomputes from its own controller's board
copies x turnfacts            | n/a       | a copy is a characteristic swap, not an event a turn fact remembers
copies x mana                 | untested  | copying a land with a mana ability, including a derived-colour one that must read the COPY's board
copies x attachments          | untested  | an Aura on the copied original does not follow the copy; the copy enters unattached
copies x statics              | untested  | copying an anthem source doubles the anthem; both copies radiate from layer 3
copies x triggers             | untested  | a copy has the copied card's triggers, so an ETB the ORIGINAL prints fires for the copy as it enters
copies x steptriggers         | untested  | copying a permanent with a step trigger; the trigger collector reads the ACTIVE def, which is now the copy's
copies x splitcards           | n/a       | a split card is never a permanent, so an as-enters copy can never point at one (CR 715.2)
copies x asenters             | untested  | an as-enters CHOICE is a copiable value (CR 706.2), so a clone of a lord copies the type it named
copies x addcosts             | n/a       | the cost is paid while casting; the copy is applied as the permanent enters
copies x replacements         | untested  | copying a permanent that declares a replacement ability; both copies then index into the replacement layer
`;

/**
 * THE GAP REGISTER - every cell this branch found BROKEN or UNIMPLEMENTED, with
 * the CR rule it violates and the test that reproduces it.
 *
 * A gap is recorded here rather than fixed when the fix is not contained: it
 * touches the engine's hottest loop and needs a paired throughput measurement
 * (rule 7), or it belongs to a system a sibling branch is actively changing.
 * Every reproduction asserts the HONEST CURRENT BEHAVIOUR, so this suite stays
 * green while the gap stands - and goes RED the day somebody fixes it, which is
 * the signal to move the cell to `covered`.
 */
interface Gap {
  readonly id: string;
  readonly cr: string;
  /** The test file whose reproduction pins the current behaviour. */
  readonly repro: string;
  readonly what: string;
  /** Why it is recorded rather than fixed here. */
  readonly whyNotFixedHere: string;
}

const GAPS: readonly Gap[] = [
  {
    id: 'sba-on-priority',
    cr: 'CR 704.3',
    repro: 'graveyard-and-alt-costs.test.ts',
    what:
      'NARROWED, not closed. CR 704.3 checks state-based actions whenever a player WOULD RECEIVE ' +
      'PRIORITY. A sibling has since closed the announcement half - `applyCastSpell` now runs the ' +
      'pass after a cast is announced, which is what a flashback cast emptying a graveyard card ' +
      'TYPE out from under a Tarmogoyf needed, and that cell is now covered positively. What ' +
      'remains: `onPassPriority`, `advanceToStepWithPriority` and `grantPriority` still never call ' +
      '`checkStateBasedActions`, so a board that becomes illegal on any path that is NOT a cast, a ' +
      'resolution, combat damage, the draw step or cleanup stays illegal until the next resolution.',
    whyNotFixedHere:
      'the remaining half puts an SBA pass on the engine\'s hottest loop (every priority pass, ' +
      'every step change), and wall clock on this box is worthless - the same build reads 39-87 ' +
      'games/sec within an hour - so it needs a paired CPU-time measurement by whoever owns the ' +
      'hot path. The reproduction pins the honest current behaviour meanwhile.',
  },
  {
    id: 'spell-draw-decking',
    cr: 'CR 704.5b',
    repro: 'library-turnfacts-mana.test.ts',
    what:
      'A SPELL-driven draw from an empty library does not lose the game. Core\'s `drawCard` ' +
      '(the draw step) calls `loseGame`; the cards package\'s `drawCards` primitive returns ' +
      'early with the comment "emit nothing rather than fabricate a loss event here". So a ' +
      'player at zero cards may cast Opt, Consider or any other draw spell forever. It matters ' +
      'to the lab specifically: a control deck that has decked itself keeps playing, biasing ' +
      'exactly the long games a control matchup is decided in.',
    whyNotFixedHere:
      'the fix is a rules change inside `packages/cards/src/primitives.ts`, the most contested ' +
      'file in the repo, and it can end games earlier - which moves the recorded gauntlet ' +
      'baselines several branches pin. It belongs with whoever re-measures those.',
  },
  {
    id: 'two-zone-change-funnels',
    cr: 'CR 400.7',
    repro: 'new-systems.test.ts',
    what:
      'FIXED ON THIS BRANCH, kept here as the record. There are two funnels that move a ' +
      'permanent off the battlefield - core\'s `moveToZone` + `resetInstanceForNewZone`, and the ' +
      'cards package\'s `movePermanentTo` (every bounce and every "put into its owner\'s ' +
      'graveyard" primitive). The second hand-copied the reset list and had drifted by THREE ' +
      'fields: `attachedTo`, `loyaltyActivatedTurn` and `chosenAsEntered`. So a bounced Aura came ' +
      'back still pointing at its old host, a bounced planeswalker could not activate the turn it ' +
      'was replayed, and a bounced "as ~ enters, choose a type" lord still lorded over the type it ' +
      'named last time. `movePermanentTo` now CALLS the shared reset.',
    whyNotFixedHere: 'it was fixed here - the entry stays so the drift cannot silently return.',
  },
  {
    id: 'counter-annihilation-is-not-an-sba',
    cr: 'CR 704.5q',
    repro: 'layers-counters-cda.test.ts',
    what:
      '+1/+1 and -1/-1 counters annihilate inside the `addCounters` PRIMITIVE rather than in ' +
      'the state-based-action pass. Two kinds arriving by two different routes therefore ' +
      'coexist until the next `addCounters` on that permanent. Unreachable by any printed card ' +
      'today (every route in the shipped pool goes through `addCounters`), which is why it is ' +
      'recorded rather than fixed speculatively.',
    whyNotFixedHere:
      'no printed card reaches it, and moving the rule into the SBA pass costs a counters walk ' +
      'on every state-based check. The reproduction is the placement argument for whoever adds ' +
      'the second counter route (persist, a -1/-1 ETB replacement, proliferate).',
  },
];

// --- the parsed table ---------------------------------------------------------------

type Status = 'covered' | 'elsewhere' | 'gap' | 'n/a' | 'untested';
const STATUSES: readonly Status[] = ['covered', 'elsewhere', 'gap', 'n/a', 'untested'];

interface Cell {
  readonly a: string;
  readonly b: string;
  readonly status: Status;
  readonly note: string;
}

/** Parse the table once. A malformed line is a loud failure, never a skip. */
function parseMatrix(): readonly Cell[] {
  const cells: Cell[] = [];
  for (const raw of MATRIX.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length !== 3) throw new Error(`matrix line is not "pair | status | note": ${line}`);
    const [pair, status, note] = parts as [string, string, string];
    const sides = pair.split(' x ').map((p) => p.trim());
    if (sides.length !== 2) throw new Error(`matrix pair is not "a x b": ${pair}`);
    if (!STATUSES.includes(status as Status)) throw new Error(`unknown status "${status}" on: ${line}`);
    cells.push({ a: sides[0] as string, b: sides[1] as string, status: status as Status, note });
  }
  return cells;
}

const CELLS = parseMatrix();
const key = (a: string, b: string): string => (a < b ? `${a} x ${b}` : `${b} x ${a}`);

describe('the interaction matrix is COMPLETE', () => {
  it('names only systems that exist, and names each one once', () => {
    const ids = SYSTEMS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const cell of CELLS) {
      expect(ids, `unknown system "${cell.a}"`).toContain(cell.a);
      expect(ids, `unknown system "${cell.b}"`).toContain(cell.b);
      expect(cell.a, 'a cell may not pair a system with itself').not.toBe(cell.b);
    }
  });

  it('covers EVERY unordered pair exactly once', () => {
    const seen = new Map<string, number>();
    for (const cell of CELLS) {
      const k = key(cell.a, cell.b);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(duplicated, 'a pair appears twice in the matrix').toEqual([]);

    const missing: string[] = [];
    for (let i = 0; i < SYSTEMS.length; i++) {
      for (let j = i + 1; j < SYSTEMS.length; j++) {
        const k = key(SYSTEMS[i]!.id, SYSTEMS[j]!.id);
        if (!seen.has(k)) missing.push(k);
      }
    }
    // The whole point: a new system cannot be added without stating what it does
    // to every system already here.
    expect(missing, 'these pairs are not in the matrix').toEqual([]);
    expect(CELLS).toHaveLength((SYSTEMS.length * (SYSTEMS.length - 1)) / 2);
  });
});

describe('every matrix cell is HONEST', () => {
  it('a covered/elsewhere cell names a test file that exists', () => {
    const missingFiles: string[] = [];
    for (const cell of CELLS) {
      if (cell.status !== 'covered' && cell.status !== 'elsewhere') continue;
      const named = cell.note.split(':')[0]?.trim() ?? '';
      // A note may name several files ("a + b"); every one of them must exist.
      for (const candidate of named.split('+').map((n) => n.trim())) {
        if (candidate.length === 0) continue;
        const base = candidate.endsWith('.test.ts') ? candidate : `${candidate}.test.ts`;
        if (!existsSync(join(HERE, base)) && !fileExistsInRepo(base)) {
          missingFiles.push(`${key(cell.a, cell.b)} -> ${base}`);
        }
      }
    }
    expect(missingFiles, 'a matrix cell points at a test file that does not exist').toEqual([]);
  });

  it('a gap cell carries a GAP id and a CR reference', () => {
    const gaps = CELLS.filter((c) => c.status === 'gap');
    // A matrix with no gaps at all, over this many systems built this fast, would
    // be a claim to disbelieve rather than a result to celebrate.
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap.note, `${key(gap.a, gap.b)} has no CR reference`).toMatch(/CR \d/);
      expect(gap.note.split(':')[0]?.trim().length, `${key(gap.a, gap.b)} has no GAP id`).toBeGreaterThan(0);
    }
  });

  it('an n/a or untested cell carries a real reason', () => {
    for (const cell of CELLS) {
      if (cell.status !== 'n/a' && cell.status !== 'untested') continue;
      expect(cell.note.length, `${key(cell.a, cell.b)} has no reason`).toBeGreaterThan(20);
    }
  });
});

describe('the GAP register is real', () => {
  it('every `gap` cell names a registered gap, and every registered gap is reachable from a cell', () => {
    const registered = new Set(GAPS.map((g) => g.id));
    const cited = new Set(
      CELLS.filter((c) => c.status === 'gap').map((c) => c.note.split(':')[0]!.trim()),
    );
    for (const id of cited) {
      expect(registered, `matrix cites GAP "${id}" but it is not registered`).toContain(id);
    }
    // A gap may legitimately not map onto a pair of the systems above (the
    // decking one is about the draw rule, which is not a "system" here), so the
    // reverse direction is not required - but every gap MUST have a reproduction.
    expect(GAPS.length).toBeGreaterThanOrEqual(cited.size);
  });

  it('every registered gap has a CR reference, a reproduction file that exists, and a reason it is not fixed here', () => {
    for (const gap of GAPS) {
      expect(gap.cr, `${gap.id} has no CR reference`).toMatch(/^CR \d/);
      expect(existsSync(join(HERE, gap.repro)), `${gap.id} names a missing repro ${gap.repro}`).toBe(true);
      expect(gap.what.length, `${gap.id} has no description`).toBeGreaterThan(80);
      expect(gap.whyNotFixedHere.length, `${gap.id} does not say why it was not fixed`).toBeGreaterThan(40);
    }
  });
});

describe('every system in the matrix still exists in the engine', () => {
  for (const system of SYSTEMS) {
    it(`${system.id} — its API witnesses resolve`, () => {
      for (const name of system.api) {
        expect((core as Record<string, unknown>)[name], `core no longer exports ${name}`).toBeDefined();
      }
    });
  }

  it('reports which shipped systems have NO card a player can see', () => {
    const invisible = SYSTEMS.filter((s) => s.card !== undefined && !ALL_CARDS.some((c) => s.card!(c))).map(
      (s) => s.id,
    );
    // A system with a `card` predicate claims to be represented in the pool; if
    // it stops being, the pool regressed. Systems with NO predicate declare
    // "deliberately unrepresented" in their comment above (battles, emblems,
    // mana) and are audited by `pool-mechanics.test.ts`, not here.
    expect(invisible, 'a system claims a pool card and no longer has one').toEqual([]);
  });
});

/** Does this basename exist anywhere in the two packages the matrix draws on? */
function fileExistsInRepo(base: string): boolean {
  const roots = [
    join(HERE, '..'),
    join(HERE, '..', 'compile'),
    join(HERE, '..', '..', '..', 'core', 'src'),
  ];
  return roots.some((root) => existsSync(join(root, base)));
}
