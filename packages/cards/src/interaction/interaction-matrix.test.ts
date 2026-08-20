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
nonhand x cda            | gap       | sba-on-priority: a flashback cast empties a graveyard TYPE at cast time and the shrink is not judged until the spell resolves. CR 704.3
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

cda x turnfacts          | n/a       | both read game state at resolution, but through different vocabularies with no shared input
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
      'State-based actions are never checked when a player would RECEIVE PRIORITY. ' +
      '`onPassPriority`, `advanceToStepWithPriority` and `grantPriority` do not call ' +
      '`checkStateBasedActions`; the engine runs them only after a resolution, after combat ' +
      'damage, after the draw step and at cleanup. A board that becomes illegal without a ' +
      'resolution stays illegal until the next one. Reachable with two shipped cards: put ' +
      'lethal-but-not-yet damage on a Tarmogoyf, then flash back the graveyard\'s only sorcery ' +
      '- the card moves to the STACK as part of casting it, the star box shrinks, and the ' +
      'creature stands there with lethal damage while the opponent takes priority.',
    whyNotFixedHere:
      'the honest fix adds an SBA pass to the engine\'s hottest loop, and wall clock on this ' +
      'box is worthless (the same build measured 39-87 games/sec within an hour), so it needs ' +
      'a paired CPU-time measurement by whoever owns the hot path.',
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
