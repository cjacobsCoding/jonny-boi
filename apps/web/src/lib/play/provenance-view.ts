/**
 * THE AFTERMARKET CARD FACE, AS A PURE MODEL (§3.143 / UX-17).
 *
 * Caleb, verbatim: *"if a creature has an enchantment on it that gives it +1/+1
 * and flying, and its base power and toughness are 4/5, I want to see printed on
 * the card on the battlefield an actual 5/6 instead of 4/5, but it should have a
 * different visual treatment to show it has been altered from printed. And if I
 * hover over that 5/6, it should show a full breakdown … And the 'flying' ability
 * it is getting from the enchantment should also be there visibly, in the rules
 * text, just as if it was there natively — but with a different visual
 * treatment."*
 *
 * This module turns core's {@link CharacteristicExplanation} into exactly that,
 * and nothing here re-derives an answer core already gives:
 *   - the NUMBERS come from the explanation (`basePower`, `power`, the `'add'`
 *     rows). This file never subtracts counters out of a delta to guess what an
 *     aura supplied — that is the two-places-one-question failure rule 12
 *     forbids, and `view-model.ts:permanentMarks` is the copy of it this work
 *     exists to replace;
 *   - the WORDS for a keyword come from lane F's `keyword-glossary.ts`, keyed on
 *     the raw `keyof KeywordFlags` key core's rows carry, so there is one keyword
 *     vocabulary and not two;
 *   - what the engine CAN and CANNOT change comes from core's
 *     `CHARACTERISTIC_SUPPORT`, so the UI never claims a capability the rules
 *     engine does not have.
 *
 * ## Everything that varies by case is a TABLE
 * Four of them, each CLOSED and each a mapped type over a union core owns, so a
 * new characteristic / mode / keyword in the engine stops `tsc` here rather than
 * rendering as nothing:
 *   - {@link CHARACTERISTIC_PRESENTATION} — which region of the card face a
 *     characteristic is drawn in, and what to call it. Adding "the next
 *     attributable characteristic" is a ROW.
 *   - {@link MODE_TREATMENTS} — how a contribution mode looks.
 *   - {@link SOURCE_KIND_NOUNS} — how each source kind is worded.
 *   - {@link KEYWORD_VALUE_DISPLAY} — how a keyword's PAYLOAD is printed beside
 *     its name.
 *
 * ## The honest-refusal rules, which are requirements and not politeness
 *   - a keyword with no glossary row renders with **no tooltip**. Never a guessed
 *     one (lane F's `glossaryEntry` returns `undefined` and that is a real
 *     answer);
 *   - a contribution whose source core could not name renders as VISIBLY ALTERED
 *     carrying "(source unknown)" — never silently as if printed;
 *   - `fullyAttributed === false` reaches the model as {@link CardFaceModel.fullyAttributed}
 *     and the face must say so;
 *   - a surface with no provenance at all (the online board passes `NO_MOD` and
 *     has no continuous index) passes {@link CardFaceInput.unavailableReason} and
 *     gets a plain card plus a stated reason — not an empty breakdown, which
 *     reads as "nothing is modifying this".
 *
 * ## Not colour alone (item 5 of the brief)
 * Every treatment carries a GLYPH and a screen-reader label as well as a class,
 * because an added ability and a removed one must be distinguishable without
 * colour vision, and a struck-through word must survive a 96px tile where a hue
 * shift would not.
 */
import type {
  CharacteristicContribution,
  CharacteristicExplanation,
  CharacteristicKind,
  ContributionMode,
  ContributionSource,
  ContributionSourceKind,
  KeywordFlags,
  ZoneName,
} from '@jonny-boi/core';
import { CHARACTERISTIC_SUPPORT, UNEXPLAINED_SOURCE_NAME } from '@jonny-boi/core';
import {
  glossaryEntry,
  glossaryForFlag,
  KEYWORD_FLAG_GLOSSARY,
  type GlossaryEntry,
  type GlossaryTermKind,
} from './keyword-glossary.js';

/**
 * What a tooltip calls each KIND of glossary row.
 *
 * A mapped type over lane F's closed `GlossaryTermKind`, so a new kind of term
 * stops the build here. The `abilityWord` row is the one that earns this table:
 * CR 207.2c ability words have NO rules meaning of their own, and a tooltip that
 * presented "Landfall" the way it presents "Flying" would teach a player
 * something false about how the card works.
 */
export const GLOSSARY_KIND_LABELS: { readonly [K in GlossaryTermKind]: string } = Object.freeze({
  keyword: 'keyword ability',
  action: 'keyword action',
  abilityWord: 'ability word — no rules meaning of its own',
  restriction: 'combat restriction',
  token: 'predefined token',
});

/* -------------------------------------------------------------------------- */
/* 1. Treatments — WHAT happened, and whether we can name who did it           */
/* -------------------------------------------------------------------------- */

/**
 * The visual treatments a piece of a card face can wear. CLOSED.
 *
 * Two axes rather than one, because they answer two different questions and
 * collapsing them throws away half of each answer: a keyword removed by an
 * effect whose source vanished is BOTH struck through AND unattributed, and a
 * single enum would have to pick one.
 */
export const ALTERATION_TREATMENTS = [
  /** Exactly as the card was printed. No decoration at all. */
  'printed',
  /** Added after printing: a granted keyword, a granted activated ability. */
  'granted',
  /** A printed value that is now a different value: P/T, name, type line. */
  'altered',
  /** Taken away. Struck through — see {@link CHARACTERISTIC_SUPPORT} on why nothing emits one yet. */
  'removed',
] as const;
export type AlterationTreatment = (typeof ALTERATION_TREATMENTS)[number];

/** Whether a card can be NAMED as the reason for a change. CLOSED. */
export const ATTRIBUTION_STATES = [
  /** Core named a source card. */
  'attributed',
  /**
   * Core could not name a card — either the reconciliation found a remainder it
   * could not place (`source.kind === 'unexplained'`) or the source instance has
   * ceased to exist in every zone (CR 111.7), which arrives as an empty
   * `cardId`. Both mean the same thing to the player: *something* did this and
   * we cannot show you what.
   */
  'unknownSource',
] as const;
export type AttributionState = (typeof ATTRIBUTION_STATES)[number];

/** How one treatment is drawn and announced. */
export interface TreatmentPresentation {
  /**
   * The BEM modifier suffix `card-face.css` styles. A string rather than a full
   * class so the same table serves a token, a chip and a breakdown row.
   */
  readonly modifier: string;
  /**
   * A glyph shown beside the text. **This is the non-colour signal**, and it is
   * required: item 5 of the brief asks that an added ability and a removed one
   * be distinguishable without colour vision, and at a 96px tile a hue shift is
   * the first thing to disappear.
   */
  readonly glyph: string;
  /** What a screen reader says for the glyph. */
  readonly srLabel: string;
  readonly why: string;
}

/** How each treatment looks and reads. A mapped type, so a new treatment is a ROW. */
export const TREATMENT_PRESENTATION: {
  readonly [T in AlterationTreatment]: TreatmentPresentation;
} = Object.freeze({
  printed: Object.freeze({
    modifier: 'printed',
    glyph: '',
    srLabel: '',
    why: 'The printed card is the baseline; decorating it would make every card look modified.',
  }),
  granted: Object.freeze({
    modifier: 'granted',
    glyph: '✦',
    srLabel: 'granted',
    why: 'A four-pointed star reads as "added" at any size and is not a letterform, so it cannot be mistaken for part of the rules text.',
  }),
  altered: Object.freeze({
    modifier: 'altered',
    glyph: '▲',
    srLabel: 'altered from printed',
    why: 'A solid triangle says "this number is not the printed one" without implying a direction — the change may be downward, and a 1/1 that is now a 1/-1 is the case a player most needs to see.',
  }),
  removed: Object.freeze({
    modifier: 'removed',
    glyph: '✕',
    srLabel: 'removed',
    why: 'Struck-through text plus a cross: the strike survives greyscale and small sizes, and the cross survives a font that renders line-through weakly.',
  }),
});

/** How an attribution state is drawn and announced. */
export const ATTRIBUTION_PRESENTATION: {
  readonly [A in AttributionState]: TreatmentPresentation;
} = Object.freeze({
  attributed: Object.freeze({
    modifier: 'attributed',
    glyph: '',
    srLabel: '',
    why: 'The normal case carries no extra marking.',
  }),
  unknownSource: Object.freeze({
    modifier: 'unknown-source',
    glyph: '?',
    srLabel: 'source unknown',
    why: 'A visible question mark, because the alternative — showing the change with no marking — is indistinguishable from "we checked and this is printed", which is false.',
  }),
});

/**
 * A contribution's MODE → the treatment it wears. A mapped type over core's
 * `ContributionMode`, so a mode added to the engine stops the build here.
 *
 * `'add'` and `'replace'` share `'altered'` deliberately: from a player's seat
 * "+2 power from an aura" and "your power box is now the copied card's" are the
 * same fact — *the number on the card is not the number that was printed*. What
 * differs is the BREAKDOWN, and that is modelled by {@link BreakdownRow.kind},
 * where it belongs.
 */
export const MODE_TREATMENTS: { readonly [M in ContributionMode]: AlterationTreatment } =
  Object.freeze({
    add: 'altered',
    grant: 'granted',
    replace: 'altered',
    remove: 'removed',
  });

/* -------------------------------------------------------------------------- */
/* 2. Where each characteristic is drawn                                       */
/* -------------------------------------------------------------------------- */

/**
 * The regions of a card face this view can annotate. CLOSED.
 *
 * These are REGIONS OF A CARD, not CSS boxes: the renderer decides where each
 * sits, and a size preset may decline to draw one (a 96px tile has no room for a
 * text box). Adding a region is a ROW here plus a rule in `card-face.css`.
 */
export const CARD_FACE_REGIONS = [
  /** The power/toughness box, bottom-right of every modern creature frame. */
  'pt',
  /** The text box: printed rules text, granted abilities, struck-through removals. */
  'rulesText',
  /** The title bar — the card's name. */
  'title',
  /** The type line, which carries both card types and subtypes. */
  'typeLine',
  /** The mana cost, top-right. */
  'cost',
  /** Colour identity, which a card frame states by its FRAME rather than in words. */
  'colors',
  /** Who controls the permanent — printed nowhere on a card, so it is a chip. */
  'control',
] as const;
export type CardFaceRegion = (typeof CARD_FACE_REGIONS)[number];

/** How one characteristic is presented. */
export interface CharacteristicPresentation {
  readonly region: CardFaceRegion;
  /** The player-facing noun, used in breakdown rows and change chips. */
  readonly label: string;
  readonly why: string;
}

/**
 * WHERE each characteristic is drawn and WHAT it is called.
 *
 * **THIS IS THE TABLE THE BRIEF ASKS FOR** ("Drive this from a TABLE mapping
 * characteristic to how it renders, so the next attributable characteristic is a
 * ROW, not a code change"). It is a mapped type over core's `CharacteristicKind`,
 * so the day core learns to attribute a new characteristic, `tsc` stops in this
 * file until the row says where it goes — the alternative being a characteristic
 * that core reports and the card face silently drops.
 */
export const CHARACTERISTIC_PRESENTATION: {
  readonly [K in CharacteristicKind]: CharacteristicPresentation;
} = Object.freeze({
  power: Object.freeze({
    region: 'pt',
    label: 'Power',
    why: 'Folded into the P/T box with its own breakdown; never also shown as a change chip, or the same fact would be stated twice.',
  }),
  toughness: Object.freeze({
    region: 'pt',
    label: 'Toughness',
    why: 'Shares the P/T box with power and gets its own breakdown beside it, because an aura that gives +0/+3 and a counter that gives +1/+1 are two different stories about the same box.',
  }),
  keyword: Object.freeze({
    region: 'rulesText',
    label: 'Ability',
    why: 'Caleb asked for a granted keyword to appear "in the rules text, just as if it was there natively" — so it is a token in the text box, not a badge beside the card.',
  }),
  activatedAbility: Object.freeze({
    region: 'rulesText',
    label: 'Activated ability',
    why: 'A granted activated ability is a whole printed line ("{T}: Add {C}."), so it becomes its own line in the text box.',
  }),
  controller: Object.freeze({
    region: 'control',
    label: 'Controller',
    why: 'A real card prints nothing about who controls it, so there is no printed value to alter — it can only be a chip.',
  }),
  name: Object.freeze({
    region: 'title',
    label: 'Name',
    why: 'A copy or a transform swaps the whole definition, so the title bar already shows the NEW name; the chip is what says it was not always this.',
  }),
  types: Object.freeze({
    region: 'typeLine',
    label: 'Card types',
    why: 'The type line is one printed strip, but types and subtypes change by different routes, so they stay two rows that share a region.',
  }),
  subtypes: Object.freeze({
    region: 'typeLine',
    label: 'Subtypes',
    why: 'Shares the type line with card types; "as ~ enters, choose a creature type" adds one without touching the other half.',
  }),
  colors: Object.freeze({
    region: 'colors',
    label: 'Colours',
    why: 'A card states its colour with its FRAME, not with words, so a colour change has no printed text to strike — it can only be a chip.',
  }),
  manaCost: Object.freeze({
    region: 'cost',
    label: 'Mana cost',
    why: 'The PRINTED cost only. Cost reduction is a cast-time computation (CR 601.2f) and core never reports it here, so this chip can never mislead a player into thinking a permanent is cheaper.',
  }),
});

/** The two characteristics that share the P/T box, in printed order. */
export const PT_CHARACTERISTICS = ['power', 'toughness'] as const;
export type PtCharacteristic = (typeof PT_CHARACTERISTICS)[number];

/* -------------------------------------------------------------------------- */
/* 3. Wording a source                                                         */
/* -------------------------------------------------------------------------- */

/** How one source kind is described to a player. */
export interface SourceKindNoun {
  /** A short noun phrase placed after the card's name: "Griffin Guide (attached)". */
  readonly noun: string;
  readonly why: string;
}

/**
 * How each source kind is worded. A mapped type over core's
 * `ContributionSourceKind`, so a new kind of source stops the build rather than
 * rendering as a bare card name with no explanation of its relationship.
 */
export const SOURCE_KIND_NOUNS: {
  readonly [K in ContributionSourceKind]: SourceKindNoun;
} = Object.freeze({
  self: Object.freeze({
    noun: 'its own printed box',
    why: 'A `*` formula and a copied box both come from the card itself; naming the card again would read as a second card.',
  }),
  attachment: Object.freeze({
    noun: 'attached',
    why: 'An Aura or Equipment is physically on the permanent, and that is the relationship a player is looking for.',
  }),
  static: Object.freeze({
    noun: 'on the battlefield',
    why: 'An anthem radiates from somewhere else in play; saying so is how a player knows to go and remove it.',
  }),
  emblem: Object.freeze({
    noun: 'an emblem',
    why: 'An emblem is in the command zone and cannot be removed at all, which is a materially different answer from "an anthem on the battlefield".',
  }),
  temporary: Object.freeze({
    noun: 'until end of turn',
    why: 'A resolved pump or grant wears off; a player deciding whether to trade needs that fact more than it needs the zone the card sits in.',
  }),
  counter: Object.freeze({
    noun: 'counters on it',
    why: 'Counters are permanent and are not an effect anyone can remove by killing a card, which is the opposite advice from every other row here.',
  }),
  unexplained: Object.freeze({
    noun: 'source unknown',
    why: 'Core reconciles its breakdown against the effective values and emits this when something reached the number by a route it could not trace. Saying so is the whole point — a missing row reads as "nothing changed it".',
  }),
});

/**
 * Zones worth naming beside a source card. A source on the BATTLEFIELD is the
 * unremarkable case and is left unqualified; a pump whose card is in a graveyard
 * is the case a player cannot otherwise find.
 */
const ZONES_WORTH_NAMING: Readonly<Record<string, string>> = Object.freeze({
  graveyard: 'in a graveyard',
  exile: 'exiled',
  hand: 'in a hand',
  library: 'in a library',
  stack: 'on the stack',
  command: 'in the command zone',
  unknown: 'no longer in any zone',
});

/* -------------------------------------------------------------------------- */
/* 4. Printing a keyword's payload                                             */
/* -------------------------------------------------------------------------- */

/** How a keyword's value is printed beside its name. CLOSED. */
export const KEYWORD_VALUE_DISPLAYS = [
  /** A boolean keyword — the term IS the whole ability. */
  'none',
  /** The value follows the term: "Ward 2", "Toxic 1", "Protection from white". */
  'appendValue',
  /**
   * The glossary's term already states the value IN WORDS ("Can't be blocked
   * except by N or more creatures"), so appending the number produces nonsense.
   * The term stands alone and the value goes in the tooltip instead.
   */
  'inTerm',
  /**
   * The payload is a RECORD, not a string or a number — which land type, which
   * blocker quality — and core's contribution row carries no string form of it
   * (it sets `values` only for a list of plain strings, by design). The term
   * stands alone and the tooltip says to read the source card: an honest refusal
   * beats "Landwalk island" invented from a field shape.
   */
  'payloadNotRenderable',
] as const;
export type KeywordValueDisplay = (typeof KEYWORD_VALUE_DISPLAYS)[number];

/**
 * How each engine keyword's payload is printed.
 *
 * A mapped type over `keyof KeywordFlags` — the same default-deny shape lane F's
 * `KEYWORD_FLAG_GLOSSARY` uses, and for the same reason: a keyword added to core
 * must stop the build here rather than quietly rendering its value nowhere.
 *
 * ⚠️ NOT a fork of the glossary. The glossary answers "what does this word
 * mean"; this answers "where does its number go". Two questions, two tables.
 */
export const KEYWORD_VALUE_DISPLAY: {
  readonly [K in keyof KeywordFlags]-?: KeywordValueDisplay;
} = Object.freeze({
  flying: 'none',
  vigilance: 'none',
  haste: 'none',
  firstStrike: 'none',
  doubleStrike: 'none',
  deathtouch: 'none',
  trample: 'none',
  reach: 'none',
  defender: 'none',
  lifelink: 'none',
  flash: 'none',
  hexproof: 'none',
  shroud: 'none',
  menace: 'none',
  unblockable: 'none',
  cantBlock: 'none',
  // §3.150 — a plain flag, so there is no value to place beside the term.
  doesNotUntap: 'none',
  mustBeBlocked: 'none',
  blockedByAllAble: 'none',
  indestructible: 'none',
  horsemanship: 'none',
  infect: 'none',
  wither: 'none',
  shadow: 'none',
  flanking: 'none',
  splitSecond: 'none',
  myriad: 'none',
  mustAttack: 'none',
  // Values that read correctly straight after the term.
  ward: 'appendValue',
  toxic: 'appendValue',
  protectionFrom: 'appendValue',
  // Terms that already spell the value out in words.
  minBlockers: 'inTerm',
  maxBlockers: 'inTerm',
  // Record payloads core deliberately does not flatten to strings.
  blockRestriction: 'payloadNotRenderable',
  blockOnly: 'payloadNotRenderable',
  landwalk: 'payloadNotRenderable',
  cantAttackUnlessDefenderControls: 'payloadNotRenderable',
});

/* -------------------------------------------------------------------------- */
/* 5. The model the renderer consumes                                          */
/* -------------------------------------------------------------------------- */

/** One player-facing sentence naming where a change came from. */
export interface ProvenanceNote {
  readonly attribution: AttributionState;
  /** The source card's name, or core's `(source unknown)` / `(source no longer exists)`. */
  readonly sourceName: string;
  /** `CardDefinition.id` of the source, or `null` when there is no card to show. */
  readonly sourceCardId: string | null;
  readonly zone: ZoneName | 'unknown';
  /** The source's PRINTED wording for this modification, when the card declared one. */
  readonly label?: string;
  /** The whole thing as one sentence, ready to render. */
  readonly text: string;
}

/** What a breakdown row IS. CLOSED — the kinds sum differently. */
export const BREAKDOWN_ROW_KINDS = [
  /** A `'replace'` row that restates a printed value (a copy's box, a transformed face). Never summed. */
  'restated',
  /** The number the deltas are layered over. Summed as the starting value. */
  'base',
  /** One `'add'` row. Summed. */
  'delta',
  /** The effective value. Not summed — it is what the sum must equal. */
  'total',
] as const;
export type BreakdownRowKind = (typeof BREAKDOWN_ROW_KINDS)[number];

/** One line of the hover breakdown. */
export interface BreakdownRow {
  readonly kind: BreakdownRowKind;
  readonly label: string;
  /** Ready-to-render: `'4'`, `'+2'`, `'Grizzly Bears → Clone'`. */
  readonly value: string;
  /** The signed number, on the rows that carry one. Absent on `'restated'`. */
  readonly amount?: number;
  readonly treatment: AlterationTreatment;
  readonly attribution: AttributionState;
  readonly note?: ProvenanceNote;
}

/** The breakdown for ONE of power / toughness. */
export interface PtBreakdown {
  readonly characteristic: PtCharacteristic;
  readonly rows: readonly BreakdownRow[];
  readonly effective: number;
  /**
   * Whether `base + Σ delta === effective`.
   *
   * Core guarantees it (its reconciliation emits an `'unexplained'` row for any
   * remainder rather than dropping it), so a `false` here means THIS FILE lost a
   * row — and the face says so instead of showing a breakdown that does not add
   * up. A silent arithmetic lie in a tooltip is the one failure this whole
   * feature exists to prevent.
   */
  readonly reconciles: boolean;
}

/** The P/T box, and everything its hover says. */
export interface PtView {
  readonly power: number;
  readonly toughness: number;
  readonly basePower: number;
  readonly baseToughness: number;
  /** True when ANY contribution touches power or toughness — see {@link buildCardFaceModel}. */
  readonly altered: boolean;
  readonly treatment: AlterationTreatment;
  readonly attribution: AttributionState;
  /** `'5/6'`, or `'5/6 (base 4/5)'` when altered. */
  readonly summary: string;
  readonly breakdown: readonly PtBreakdown[];
}

/** One run of rules text: a glossary word, a granted ability, or plain prose. */
export interface RulesToken {
  readonly text: string;
  readonly treatment: AlterationTreatment;
  readonly attribution: AttributionState;
  /**
   * The glossary row for this word, when there is one.
   *
   * ⚠️ `undefined` means **show no tooltip**. Lane F's table is closed and
   * returning `undefined` is a real answer; substituting a generic string is the
   * failure that table exists to prevent.
   */
  readonly glossary?: GlossaryEntry;
  /** Where an aftermarket token came from. Empty for printed text. */
  readonly notes: readonly ProvenanceNote[];
  /** A keyword value the term could not carry inline — see {@link KEYWORD_VALUE_DISPLAY}. */
  readonly valueNote?: string;
}

/** One line of the text box. */
export interface RulesLine {
  readonly key: string;
  /** `'printed'` when the line came from the card's oracle text; `'aftermarket'` when this view created it. */
  readonly origin: 'printed' | 'aftermarket';
  readonly tokens: readonly RulesToken[];
}

/** One non-P/T, non-rules-text characteristic that is no longer what was printed. */
export interface CharacteristicChange {
  readonly characteristic: CharacteristicKind;
  readonly region: CardFaceRegion;
  readonly label: string;
  /** The value before, when core recorded one. */
  readonly from?: string;
  readonly to: string;
  readonly treatment: AlterationTreatment;
  readonly attribution: AttributionState;
  readonly note: ProvenanceNote;
}

/** Everything a card face needs, computed once. */
export interface CardFaceModel {
  readonly name: string;
  readonly cardId: string | null;
  /** `null` for anything with no P/T box to draw. */
  readonly pt: PtView | null;
  readonly lines: readonly RulesLine[];
  readonly changes: readonly CharacteristicChange[];
  /** Whether ANYTHING on this face is aftermarket — the cheap test for "decorate the frame". */
  readonly altered: boolean;
  /** False when core could not trace part of the effective value. The face MUST say so. */
  readonly fullyAttributed: boolean;
  /**
   * Whether this engine can remove a characteristic at all, read from core's
   * `CHARACTERISTIC_SUPPORT` rather than assumed. False today for every row: a
   * grant sets a flag and never clears one. The struck-through rendering exists
   * and is tested, and this is the honest statement that nothing reaches it yet.
   */
  readonly removalSupported: boolean;
  /**
   * Why there is no provenance here, when there is none. The online board has no
   * continuous index at all (`board-adapter.ts` passes `NO_MOD`), and an empty
   * breakdown there would read as "nothing is modifying this", which is a
   * different and false claim.
   */
  readonly unavailableReason?: string;
}

/** What {@link buildCardFaceModel} needs. Everything optional degrades to a plain card. */
export interface CardFaceInput {
  /** Core's breakdown. Absent for a card in hand, a stack object, or the online board. */
  readonly explanation?: CharacteristicExplanation | undefined;
  /** Identity when there is no explanation. */
  readonly cardId?: string | null;
  readonly name?: string;
  /** The card's printed rules text (`NormalizedCard.oracleText`). */
  readonly oracleText?: string;
  /**
   * Whether to draw a P/T box. Supplied by the caller because core's explanation
   * carries no type line; when omitted it is inferred (see
   * {@link buildCardFaceModel}).
   */
  readonly isCreature?: boolean;
  /** See {@link CardFaceModel.unavailableReason}. */
  readonly unavailableReason?: string;
}

/* -------------------------------------------------------------------------- */
/* 6. The glossary tokeniser                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The longest phrase the tokeniser will try to resolve, in words.
 *
 * THREE, measured against lane F's table rather than chosen: the longest term or
 * alias a card actually prints is `"protection from <quality>"` (three words,
 * and the glossary resolves it through its `protectionfrom` PREFIX rule, so a
 * longer quality like "artifact creatures" still lands on the right row from the
 * first three words). Everything else in the table that appears in printed text
 * is one or two words — "first strike", "double strike", "split second",
 * "living weapon", "cumulative upkeep", "basic landcycling".
 *
 * Raising it costs accuracy, not just time: a longer window can swallow the
 * start of the next sentence into a match.
 */
export const GLOSSARY_MAX_PHRASE_WORDS = 3;

/** A token with no glossary meaning — plain prose. */
function plainToken(text: string): RulesToken {
  return { text, treatment: 'printed', attribution: 'attributed', notes: [] };
}

/**
 * Characters that mean "the glossary term ENDED before this span did".
 *
 * `normalizeGlossaryTerm` cuts at `(` and at an em dash, because reminder text
 * and the ability-word dash both trail the word a player is pointing at. That is
 * right for a lookup and wrong for a longest-match scan: without this guard the
 * three-word span `"Vigilance (Attacking doesn't"` normalises to `vigilance`,
 * MATCHES, and highlights two words of reminder text as if they were part of the
 * keyword. Spans carrying either character are skipped so the scan falls through
 * to the one-word span that is the real term.
 */
const SPAN_ENDS_EARLY = /[(—]/u;

/** Punctuation that belongs to the sentence, not to the keyword it follows. */
const TRAILING_PUNCTUATION = /[),.;:!?]+$/u;

/**
 * Split one line of printed rules text into tokens, marking every word or phrase
 * lane F's glossary can explain.
 *
 * LONGEST MATCH FIRST, up to {@link GLOSSARY_MAX_PHRASE_WORDS}, because "first
 * strike" must not resolve as "first" + "strike" — neither of which is a
 * keyword, so the two-word ability would silently lose its tooltip.
 *
 * ⚠️ Words, never lines. Lane F's `glossaryEntry` deliberately refuses to
 * prefix-match "enchant", because "enchantment" is a card type; handing it the
 * whole line "Enchant creature" gets `undefined`, and handing it the first word
 * gets the right row. A phrase that resolves to nothing is left as prose with no
 * tooltip, which is the required behaviour and not a fallback.
 */
export function tokenizeRulesLine(line: string): readonly RulesToken[] {
  const tokens: RulesToken[] = [];
  // Keep the separators so the rendered line is byte-identical to the printed
  // one: a tooltip layer that silently re-spaces rules text is a text change.
  const parts = line.split(/(\s+)/u);
  let pending = '';
  let index = 0;

  const flush = (): void => {
    if (pending.length > 0) {
      tokens.push(plainToken(pending));
      pending = '';
    }
  };

  while (index < parts.length) {
    const part = parts[index] ?? '';
    if (part.length === 0 || /^\s+$/u.test(part)) {
      pending += part;
      index += 1;
      continue;
    }
    let matched = false;
    for (let words = GLOSSARY_MAX_PHRASE_WORDS; words >= 1 && !matched; words -= 1) {
      const span = wordSpan(parts, index, words);
      if (span === undefined) continue;
      if (SPAN_ENDS_EARLY.test(span.text)) continue;
      // The keyword is the span minus any sentence punctuation clinging to it:
      // "Flying." must highlight FLYING and leave the full stop as prose, or the
      // underline reads as part of the ability.
      const tail = TRAILING_PUNCTUATION.exec(span.text)?.[0] ?? '';
      const word = tail.length > 0 ? span.text.slice(0, -tail.length) : span.text;
      const entry = glossaryEntry(word);
      if (entry === undefined) continue;
      flush();
      tokens.push({ text: word, treatment: 'printed', attribution: 'attributed', glossary: entry, notes: [] });
      if (tail.length > 0) tokens.push(plainToken(tail));
      index = span.end;
      matched = true;
    }
    if (!matched) {
      pending += part;
      index += 1;
    }
  }
  flush();
  return tokens;
}

/**
 * The text of `words` whitespace-separated words starting at `parts[index]`, and
 * the index just past them — or `undefined` when the line runs out first.
 */
function wordSpan(
  parts: readonly string[],
  index: number,
  words: number,
): { readonly text: string; readonly end: number } | undefined {
  let text = '';
  let seen = 0;
  let cursor = index;
  while (cursor < parts.length && seen < words) {
    const part = parts[cursor] ?? '';
    if (!/^\s+$/u.test(part) && part.length > 0) seen += 1;
    text += part;
    cursor += 1;
  }
  if (seen < words) return undefined;
  // No trailing separator is possible: the loop stops the moment it has counted
  // its last WORD, so `text` always ends on one.
  return { text, end: cursor };
}

/* -------------------------------------------------------------------------- */
/* 7. Building the model                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Turn core's explanation (plus the printed card text) into everything the card
 * face draws.
 *
 * With no explanation this returns the plain printed card with every glossary
 * word still tooltipped — which is the right answer for a card in hand, a stack
 * object, or the online board, and is also UX-17 item 4 ("hovering over any
 * ability … on any card").
 */
export function buildCardFaceModel(input: CardFaceInput): CardFaceModel {
  const explanation = input.explanation;
  const name = explanation?.name ?? input.name ?? '';
  const cardId = explanation?.cardId ?? input.cardId ?? null;
  const contributions = explanation?.contributions ?? [];

  const pt = buildPtView(explanation, input.isCreature);
  const lines = buildRulesLines(input.oracleText ?? '', explanation);
  const changes = buildChanges(contributions);

  return {
    name,
    cardId,
    pt,
    lines,
    changes,
    altered:
      (pt?.altered ?? false) ||
      changes.length > 0 ||
      lines.some((line) => line.origin === 'aftermarket' || line.tokens.some((t) => t.treatment !== 'printed')),
    fullyAttributed: explanation?.fullyAttributed ?? true,
    removalSupported: Object.values(CHARACTERISTIC_SUPPORT).some((s) => s.removable),
    ...(input.unavailableReason !== undefined ? { unavailableReason: input.unavailableReason } : {}),
  };
}

/* ---- P/T ----------------------------------------------------------------- */

/**
 * Whether the P/T box is drawn.
 *
 * The caller knows the type line and should say; when it does not, the honest
 * fallback is "something is modifying a P/T, so there must be one" plus a
 * non-zero box. A 0/0 creature with nothing done to it is the one case this
 * misses, and it costs a hidden box rather than a wrong number.
 */
function showsPt(explanation: CharacteristicExplanation | undefined, isCreature: boolean | undefined): boolean {
  if (isCreature !== undefined) return isCreature;
  if (explanation === undefined) return false;
  if (explanation.power !== 0 || explanation.toughness !== 0) return true;
  return explanation.contributions.some((c) => c.characteristic === 'power' || c.characteristic === 'toughness');
}

function buildPtView(
  explanation: CharacteristicExplanation | undefined,
  isCreature: boolean | undefined,
): PtView | null {
  if (explanation === undefined || !showsPt(explanation, isCreature)) return null;
  const breakdown = PT_CHARACTERISTICS.map((c) => buildPtBreakdown(c, explanation));
  // ALTERED means "a contribution touches this box", not "the number differs
  // from `def.power`". A `*` box has a basePT row and no delta, so its 4/5 is
  // genuinely not what the card prints — and reading `def.power` is exactly the
  // defect that renders every characteristic-defining card as 0/0.
  const rows = explanation.contributions.filter(
    (c) => c.characteristic === 'power' || c.characteristic === 'toughness',
  );
  const altered = rows.length > 0;
  const unknown = rows.some((c) => attributionOf(c.source) === 'unknownSource');
  return {
    power: explanation.power,
    toughness: explanation.toughness,
    basePower: explanation.basePower,
    baseToughness: explanation.baseToughness,
    altered,
    treatment: altered ? 'altered' : 'printed',
    attribution: unknown ? 'unknownSource' : 'attributed',
    summary: altered
      ? `${explanation.power}/${explanation.toughness} (base ${explanation.basePower}/${explanation.baseToughness})`
      : `${explanation.power}/${explanation.toughness}`,
    breakdown,
  };
}

function buildPtBreakdown(
  characteristic: PtCharacteristic,
  explanation: CharacteristicExplanation,
): PtBreakdown {
  const label = CHARACTERISTIC_PRESENTATION[characteristic].label;
  const relevant = explanation.contributions.filter((c) => c.characteristic === characteristic);
  const base = characteristic === 'power' ? explanation.basePower : explanation.baseToughness;
  const effective = characteristic === 'power' ? explanation.power : explanation.toughness;
  const definingRow = relevant.find((c) => c.mode === 'replace' && c.layer === 'basePT');
  const rows: BreakdownRow[] = [];

  // A copy or a transformed face RESTATES the printed box. It is shown first and
  // never summed: `basePower` already reflects it, so counting it would double.
  for (const row of relevant) {
    if (row.mode !== 'replace' || row.layer === 'basePT') continue;
    rows.push({
      kind: 'restated',
      label,
      value: `${row.previous ?? '—'} → ${row.detail ?? '—'}`,
      treatment: MODE_TREATMENTS[row.mode],
      attribution: attributionOf(row.source),
      note: noteFor(row),
    });
  }

  rows.push({
    kind: 'base',
    label: definingRow
      ? `${label} from its own box (a ★ value, recounted from the board every time it is read)`
      : `Printed ${label.toLowerCase()}`,
    value: String(base),
    amount: base,
    treatment: definingRow ? 'altered' : 'printed',
    attribution: definingRow ? attributionOf(definingRow.source) : 'attributed',
    ...(definingRow ? { note: noteFor(definingRow) } : {}),
  });

  let sum = base;
  for (const row of relevant) {
    if (row.mode !== 'add' || row.amount === undefined) continue;
    sum += row.amount;
    rows.push({
      kind: 'delta',
      label,
      value: signed(row.amount),
      amount: row.amount,
      treatment: MODE_TREATMENTS[row.mode],
      attribution: attributionOf(row.source),
      note: noteFor(row),
    });
  }

  rows.push({
    kind: 'total',
    label: `${label} now`,
    value: String(effective),
    amount: effective,
    treatment: sum === base ? 'printed' : 'altered',
    attribution: 'attributed',
  });

  return { characteristic, rows, effective, reconciles: sum === effective };
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

/* ---- rules text ---------------------------------------------------------- */

/**
 * The text box: the printed lines with every glossary word tooltipped, plus the
 * aftermarket ones.
 *
 * The order is the order a real card prints things — keywords first, then the
 * rest of the text, then whole granted abilities — so the box still READS like a
 * card. Caleb's test of this feature is that "vigilance, first strike" becomes
 * "vigilance, first strike, flying"; a granted keyword parked in a separate
 * badge strip would fail it while looking like it passed.
 */
/** A line under construction — mutable, so a printed word can be struck IN PLACE. */
interface DraftLine {
  readonly key: string;
  readonly origin: 'printed' | 'aftermarket';
  readonly tokens: RulesToken[];
}

function buildRulesLines(
  oracleText: string,
  explanation: CharacteristicExplanation | undefined,
): readonly RulesLine[] {
  const lines: DraftLine[] = oracleText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => ({ key: `p${i}`, origin: 'printed' as const, tokens: [...tokenizeRulesLine(line)] }));

  if (explanation === undefined) return lines;

  const lineIndex = printedKeywordLineIndex(lines, explanation.printedKeywords);
  const appended: RulesToken[] = [];

  for (const row of explanation.contributions) {
    if (row.characteristic !== 'keyword') continue;
    const treatment = MODE_TREATMENTS[row.mode];
    const flag = keywordFlagOf(row.detail);
    // A grant of a keyword the card ALREADY prints adds no ability: it annotates
    // the printed word so the hover still names the redundant source, and never
    // appends a second copy, which would read as two flying abilities.
    const redundant =
      treatment !== 'removed' && flag !== undefined && keywordPresent(explanation.printedKeywords, flag);
    const annotated =
      flag !== undefined && lineIndex >= 0
        ? annotateToken(lines[lineIndex]!, flag, row, redundant ? 'printed' : treatment)
        : false;
    if (annotated) continue;
    // Printed, but on a line this view could not tokenise as a keyword line. The
    // word IS somewhere in the text box already, so appending it would state the
    // ability twice; the redundant grant simply goes unannotated.
    if (redundant) continue;
    appended.push(keywordToken(row, treatment));
  }

  if (appended.length > 0) {
    if (lineIndex >= 0) {
      lines[lineIndex]!.tokens.push(...joinTokens(appended, true));
    } else {
      // No printed keyword line to join, so the aftermarket keywords become one —
      // at the TOP, which is where a keyword line is printed on a real card.
      lines.unshift({ key: 'kw', origin: 'aftermarket', tokens: [...joinTokens(appended, false)] });
    }
  }

  // A whole granted ability is a whole printed line ("{T}: Add {C}."), so it gets
  // one, after the printed text exactly as a card prints its abilities in order.
  let ability = 0;
  for (const row of explanation.contributions) {
    if (row.characteristic !== 'activatedAbility') continue;
    lines.push({
      key: `a${ability}`,
      origin: 'aftermarket',
      tokens: [...abilityTokens(row, MODE_TREATMENTS[row.mode])],
    });
    ability += 1;
  }

  return lines;
}

/**
 * Comma-separate a run of appended keyword tokens the way a printed keyword line
 * does. `leading` is true when they are being joined ONTO existing text, where
 * the separator has to come first as well.
 */
function joinTokens(tokens: readonly RulesToken[], leading: boolean): readonly RulesToken[] {
  const out: RulesToken[] = [];
  for (const token of tokens) {
    if (out.length > 0 || leading) out.push(plainToken(', '));
    out.push(token);
  }
  return out;
}

/**
 * The index of the printed line that is a KEYWORD LINE, or -1.
 *
 * The rule is exact, not a resemblance: split on commas, and EVERY part must
 * resolve through the glossary to a row whose `flag` the engine records as
 * PRINTED on this card. A line that fails is left alone and the aftermarket
 * keywords get their own line — an honest refusal, never a merge into a line
 * this view guessed at. "Enchant creature", "Cycling {2}" and "Whenever this
 * creature attacks, draw a card" all fail it, each for the right reason.
 */
function printedKeywordLineIndex(lines: readonly DraftLine[], printedKeywords: KeywordFlags): number {
  for (const [i, line] of lines.entries()) {
    const text = line.tokens.map((t) => t.text).join('');
    const parts = text.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    const everyPartIsAPrintedKeyword = parts.every((part) => {
      const entry = glossaryEntry(part);
      return entry?.flag !== undefined && keywordPresent(printedKeywords, entry.flag);
    });
    if (everyPartIsAPrintedKeyword) return i;
  }
  return -1;
}

/**
 * Mark the token in `line` that names `flag`, in place. Returns whether one was
 * found.
 *
 * Matching is by FLAG, not by the printed word: lane F maps several printed
 * words onto one engine flag (fear, intimidate and skulk are all
 * `blockRestriction`), and the flag is the only thing both vocabularies agree
 * on. Matching on prose here would be the second vocabulary rule 12 forbids.
 */
function annotateToken(
  line: DraftLine,
  flag: keyof KeywordFlags,
  row: CharacteristicContribution,
  treatment: AlterationTreatment,
): boolean {
  for (const [i, token] of line.tokens.entries()) {
    if (token.glossary?.flag !== flag) continue;
    line.tokens[i] = {
      ...token,
      treatment,
      attribution: attributionOf(row.source),
      notes: [...token.notes, noteFor(row)],
    };
    return true;
  }
  return false;
}

/** One keyword token, named and valued from a contribution row. */
function keywordToken(row: CharacteristicContribution, treatment: AlterationTreatment): RulesToken {
  const flag = keywordFlagOf(row.detail);
  // No flag core recognises => no glossary row we can honestly show. The raw key
  // is still rendered so the change is visible; the tooltip is simply absent.
  const entry = flag === undefined ? undefined : glossaryForFlag(flag);
  const display = flag === undefined ? 'none' : KEYWORD_VALUE_DISPLAY[flag];
  const term = entry?.term ?? row.detail ?? 'an ability';
  const value = keywordValueText(row);
  const text = display === 'appendValue' && value !== undefined ? `${term} ${value}` : term;
  // An 'inTerm' keyword's term already says "N or more creatures" in words, so
  // the number goes in the tooltip; a 'payloadNotRenderable' one has a payload
  // core never flattens to a string, and saying so beats inventing "Landwalk
  // island" from the shape of a record (rule 2: report, do not widen).
  const valueNote =
    display !== 'appendValue' && value !== undefined
      ? `Value here: ${value}`
      : display === 'payloadNotRenderable'
        ? 'The exact values are printed on the source card.'
        : undefined;
  return {
    text,
    treatment,
    attribution: attributionOf(row.source),
    ...(entry !== undefined ? { glossary: entry } : {}),
    notes: [noteFor(row)],
    ...(valueNote !== undefined ? { valueNote } : {}),
  };
}

/** A granted/removed activated ability: its printed wording, glossary-tokenised. */
function abilityTokens(row: CharacteristicContribution, treatment: AlterationTreatment): readonly RulesToken[] {
  const note = noteFor(row);
  const attribution = attributionOf(row.source);
  return tokenizeRulesLine(row.detail ?? '').map((token) => ({
    ...token,
    treatment,
    attribution,
    notes: [note],
  }));
}

/** The printable form of a keyword row's payload, or `undefined` when it has none. */
function keywordValueText(row: CharacteristicContribution): string | undefined {
  if (row.values !== undefined && row.values.length > 0) return row.values.join(', ');
  if (row.amount !== undefined) return String(row.amount);
  return undefined;
}

/**
 * The `keyof KeywordFlags` a row names, or `undefined` when the string is not a
 * key the glossary covers.
 *
 * Core types a row's `detail` as `string`; lane F's `KEYWORD_FLAG_GLOSSARY` is
 * the closed, compile-checked list of what those strings may be. Checking
 * against it rather than casting is what turns "core added a keyword and this
 * file did not notice" into a visible, un-tooltipped word instead of a crash.
 */
function keywordFlagOf(detail: string | undefined): keyof KeywordFlags | undefined {
  if (detail === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(KEYWORD_FLAG_GLOSSARY, detail)
    ? (detail as keyof KeywordFlags)
    : undefined;
}

/**
 * Whether a keyword is actually SET in a flag bundle.
 *
 * `ward: 0`, `protectionFrom: []` and `flying: false` are all "absent" — the same
 * emptiness test core's own grant fold applies, so a printed `ward 0` cannot make
 * a line look like a keyword line.
 */
function keywordPresent(flags: KeywordFlags, key: keyof KeywordFlags): boolean {
  const value = (flags as Record<string, unknown>)[key];
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/* ---- everything that is not P/T or rules text ---------------------------- */

/**
 * One chip per contribution to a characteristic that has no printed home in the
 * text box: name, type line, colours, mana cost, controller.
 *
 * Rows are kept SEPARATE rather than collapsed per characteristic: a permanent
 * that transformed and was then copied has two honest answers about its name,
 * and merging them would invent a single history that did not happen.
 */
function buildChanges(contributions: readonly CharacteristicContribution[]): readonly CharacteristicChange[] {
  const changes: CharacteristicChange[] = [];
  for (const row of contributions) {
    const presentation = CHARACTERISTIC_PRESENTATION[row.characteristic];
    if (presentation.region === 'pt' || presentation.region === 'rulesText') continue;
    changes.push({
      characteristic: row.characteristic,
      region: presentation.region,
      label: presentation.label,
      ...(row.previous !== undefined ? { from: row.previous } : {}),
      to: row.detail ?? '—',
      treatment: MODE_TREATMENTS[row.mode],
      attribution: attributionOf(row.source),
      note: noteFor(row),
    });
  }
  return changes;
}

/* ---- sources ------------------------------------------------------------- */

/**
 * Whether a source can be pointed at.
 *
 * An empty `cardId` is core's signal for "this instance is in no zone at all" (a
 * token that pumped and then died, CR 111.7) — there is no card to show, which
 * is the same practical answer as `'unexplained'` even though core knows more
 * about one than the other.
 */
function attributionOf(source: ContributionSource): AttributionState {
  return source.kind === 'unexplained' || source.cardId === '' ? 'unknownSource' : 'attributed';
}

/** One row's source, as a sentence. */
function noteFor(row: CharacteristicContribution): ProvenanceNote {
  const source = row.source;
  const attribution = attributionOf(source);
  const noun = SOURCE_KIND_NOUNS[source.kind].noun;
  const zone = ZONES_WORTH_NAMING[source.zone];

  let text: string;
  if (source.kind === 'unexplained') {
    text = `${UNEXPLAINED_SOURCE_NAME} — something on the board reached this value by a route the rules engine could not trace.`;
  } else if (source.kind === 'counter') {
    text = `${row.detail ?? 'counters'} ${noun}`;
  } else if (source.kind === 'self') {
    text = `${source.name} — ${noun}`;
  } else {
    text = `${source.name} (${noun}${zone !== undefined ? `, ${zone}` : ''})`;
  }
  if (source.label !== undefined && source.label.length > 0) text += ` — “${source.label}”`;

  return {
    attribution,
    sourceName: source.name,
    sourceCardId: source.cardId === '' ? null : source.cardId,
    zone: source.zone,
    ...(source.label !== undefined ? { label: source.label } : {}),
    text,
  };
}

/* -------------------------------------------------------------------------- */
/* 8. Bench samples — rule 3's debug tooling, as DATA                          */
/* -------------------------------------------------------------------------- */

/**
 * Synthetic explanations covering every treatment this view can draw.
 *
 * DATA, not a component, on purpose. `EffectsPreview.tsx` (the shared effects
 * bench) is owned by no lane in this overhaul and four lanes need rows in it, so
 * shipping an array whose entries any bench can render with
 * `<CardFace explanation={sample.explanation} …/>` is the registry contribution
 * this lane can make WITHOUT editing a file it does not own. Whoever converts
 * the bench to a registry imports this and needs nothing from here but the data.
 *
 * ⚠️ It is also the test's fixture set — ONE source, so a sample that stops
 * rendering correctly fails the suite rather than rotting quietly in a debug
 * panel nobody opens (rule 12).
 */
export interface CardFaceBenchSample {
  readonly id: string;
  readonly label: string;
  /** What a viewer should be able to SEE in this sample. */
  readonly expect: string;
  readonly input: CardFaceInput;
}

/** A source descriptor for the synthetic samples below. */
function benchSource(
  kind: ContributionSourceKind,
  name: string,
  overrides: Partial<ContributionSource> = {},
): ContributionSource {
  return {
    kind,
    instanceId: 99,
    cardId: `bench-${name.toLowerCase().replace(/\s+/gu, '-')}`,
    name,
    zone: 'battlefield',
    ...overrides,
  };
}

/** A minimal explanation the samples layer contributions onto. */
function benchExplanation(
  overrides: Partial<CharacteristicExplanation> & {
    readonly contributions: readonly CharacteristicContribution[];
  },
): CharacteristicExplanation {
  return {
    instanceId: 1,
    cardId: 'bench-subject',
    name: 'Bench Subject',
    zone: 'battlefield',
    basePower: 4,
    baseToughness: 5,
    power: 4,
    toughness: 5,
    keywords: {},
    printedKeywords: {},
    activated: [],
    printedActivated: [],
    fullyAttributed: true,
    ...overrides,
  };
}

/** The bench rows (see {@link CardFaceBenchSample}). */
export const CARD_FACE_BENCH_SAMPLES: readonly CardFaceBenchSample[] = Object.freeze([
  Object.freeze({
    id: 'caleb-aura',
    label: 'The reported case: an aura giving +1/+1 and flying',
    expect: 'A 4/5 reads 5/6, marked altered; the keyword line reads “Vigilance, first strike, Flying” with Flying aftermarket.',
    input: {
      oracleText: 'Vigilance, first strike',
      isCreature: true,
      explanation: benchExplanation({
        name: 'Bench Knight',
        power: 5,
        toughness: 6,
        printedKeywords: { vigilance: true, firstStrike: true },
        keywords: { vigilance: true, firstStrike: true, flying: true },
        contributions: [
          {
            characteristic: 'keyword',
            layer: 'ability',
            mode: 'grant',
            detail: 'flying',
            source: benchSource('attachment', 'Bench Aura', { label: 'Enchanted creature gets +1/+1 and has flying.' }),
          },
          {
            characteristic: 'power',
            layer: 'modifyPT',
            mode: 'add',
            amount: 1,
            source: benchSource('attachment', 'Bench Aura', { label: 'Enchanted creature gets +1/+1 and has flying.' }),
          },
          {
            characteristic: 'toughness',
            layer: 'modifyPT',
            mode: 'add',
            amount: 1,
            source: benchSource('attachment', 'Bench Aura', { label: 'Enchanted creature gets +1/+1 and has flying.' }),
          },
        ],
      }),
    },
  } as const),
  Object.freeze({
    id: 'removed-ability',
    label: 'A REMOVED keyword (no engine effect produces one yet)',
    expect: 'The printed “Flying” is struck through and its hover names the source.',
    input: {
      oracleText: 'Flying',
      isCreature: true,
      explanation: benchExplanation({
        printedKeywords: { flying: true },
        keywords: { flying: true },
        contributions: [
          {
            characteristic: 'keyword',
            layer: 'ability',
            mode: 'remove',
            detail: 'flying',
            source: benchSource('static', 'Bench Grounder', { label: 'Creatures your opponents control lose flying.' }),
          },
        ],
      }),
    },
  } as const),
  Object.freeze({
    id: 'unknown-source',
    label: 'An UNATTRIBUTED remainder',
    expect: 'The P/T shows altered with a “?” marker and the breakdown row reads “(source unknown)”.',
    input: {
      isCreature: true,
      explanation: benchExplanation({
        power: 6,
        fullyAttributed: false,
        contributions: [
          {
            characteristic: 'power',
            layer: 'unknown',
            mode: 'add',
            amount: 2,
            source: {
              kind: 'unexplained',
              instanceId: 1,
              cardId: '',
              name: UNEXPLAINED_SOURCE_NAME,
              zone: 'unknown',
            },
          },
        ],
      }),
    },
  } as const),
  Object.freeze({
    id: 'copy',
    label: 'A COPY — name, subtypes and the printed box all replaced',
    expect: 'Change chips for the name and the type line, each naming the copied card as the reason.',
    input: {
      isCreature: true,
      explanation: benchExplanation({
        name: 'Grizzly Bears',
        basePower: 2,
        baseToughness: 2,
        power: 2,
        toughness: 2,
        contributions: [
          {
            characteristic: 'name',
            layer: 'copy',
            mode: 'replace',
            detail: 'Grizzly Bears',
            previous: 'Clone',
            source: benchSource('self', 'Grizzly Bears'),
          },
          // Subtypes, not card types: core diffs the two definitions and emits a
          // row only where they actually DIFFER, and a Clone copying a creature
          // keeps the card type it already had.
          {
            characteristic: 'subtypes',
            layer: 'copy',
            mode: 'replace',
            detail: 'Bear',
            previous: 'Shapeshifter',
            source: benchSource('self', 'Grizzly Bears'),
          },
        ],
      }),
    },
  } as const),
  Object.freeze({
    id: 'unavailable',
    label: 'A surface with NO provenance (the online board)',
    expect: 'The plain printed card plus a stated reason — never an empty breakdown.',
    input: {
      oracleText: 'Flying',
      isCreature: true,
      unavailableReason: 'Live provenance is not carried by the multiplayer protocol yet.',
    },
  } as const),
]);

/* -------------------------------------------------------------------------- */
/* 9. Where a tooltip is DRAWN — the pure half of the portal (§3.143 GAP-6)    */
/* -------------------------------------------------------------------------- */

/**
 * The pop's placement knobs.
 *
 * They live here, in this lane's own module, rather than in `play-config.ts`:
 * they describe a TOOLTIP's relationship to the word it hangs off, which no
 * other surface has an opinion about, and `components/card-hover-config.ts` is
 * the repo's existing precedent for a single component's placement constants.
 */
export const POP_PLACEMENT_CONFIG = Object.freeze({
  /** Clear air between the word and its tooltip, in CSS px. */
  gapPx: 8,
  /** How close to a viewport edge the tooltip may come, in CSS px. */
  viewportMarginPx: 8,
});

/** A measured rectangle, in viewport coordinates (a `DOMRect` satisfies it). */
export interface PopRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The viewport the tooltip must stay inside. */
export interface PopViewport {
  readonly width: number;
  readonly height: number;
}

/** Resolved placement, in viewport pixels — fed straight to `position: fixed`. */
export interface PopPlacement {
  readonly left: number;
  readonly top: number;
  /** True when the tooltip sits ABOVE its trigger; false when it was flipped under it. */
  readonly above: boolean;
}

/**
 * Place a tooltip against its trigger, clamped inside the viewport.
 *
 * Pure and DOM-free so the one part of the portal with real arithmetic can be
 * tested in Node — the portal itself cannot be, which is exactly how wave 1
 * shipped a tooltip that no player could ever see.
 *
 * ABOVE by default, because a tooltip under a word covers the next line of the
 * card it is explaining; it flips below only when there is genuinely no room
 * above. Horizontally it is centred on the trigger and then clamped.
 *
 * When the viewport is SMALLER than the tooltip, the top-left margin wins (the
 * same convention `previewPlacement` settled on): a tooltip whose first words
 * are on screen is readable, one whose last words are is not.
 */
export function popPlacement(anchor: PopRect, pop: PopRect, viewport: PopViewport): PopPlacement {
  const { gapPx, viewportMarginPx } = POP_PLACEMENT_CONFIG;

  const above = anchor.top - gapPx - pop.height >= viewportMarginPx;
  const lowestTop = viewport.height - viewportMarginPx - pop.height;
  const wantedTop = above ? anchor.top - gapPx - pop.height : anchor.top + anchor.height + gapPx;
  const top = Math.max(viewportMarginPx, Math.min(wantedTop, lowestTop));

  const centred = anchor.left + anchor.width / 2 - pop.width / 2;
  const rightmostLeft = viewport.width - viewportMarginPx - pop.width;
  const left = Math.max(viewportMarginPx, Math.min(centred, rightmostLeft));

  return { left, top, above };
}
