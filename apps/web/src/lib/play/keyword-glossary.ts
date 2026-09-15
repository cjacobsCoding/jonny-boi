/**
 * THE KEYWORD GLOSSARY (§3.143, UX-17.4) — one closed table mapping an ability
 * word to a plain-English explanation of how it actually works.
 *
 * Caleb: *"hovering over any ability like 'vigilance' for example, on any card,
 * should show a tooltip explaining clearly what that ability does / how it
 * works."* The emphasis is **clearly**: several of these keywords print reminder
 * text that is precise and useless to someone who does not already know the
 * rule ("Menace (This creature can't be blocked except by two or more
 * creatures.)" is fine; "Bushido 1 (Whenever this creature blocks or becomes
 * blocked, it gets +1/+1 until end of turn.)" tells you nothing about *when*).
 * So the text here explains the MECHANISM, and reminder text is not copied.
 *
 * ## Where the row list came from (rule 11 — derive it, don't remember it)
 *
 * Two measured sources, unioned on 2026-09-11:
 *
 *  1. **The engine's vocabulary** — every key of `KeywordFlags`
 *     (`packages/core/src/card.ts`), 36 of them. {@link KEYWORD_FLAG_GLOSSARY}
 *     is a MAPPED TYPE over that interface, so adding a keyword to core stops
 *     `tsc` until this file names the row explaining it — the same default-deny
 *     shape as core's own `KEYWORD_LIST_IS_EXHAUSTIVE` and `KEYWORD_RULES`, and
 *     `keyword-glossary.test.ts` re-derives the key list from `card.ts` so the
 *     gap is also loud in a plain `vitest run`.
 *  2. **What the pool actually prints** — the `keywords` array Scryfall supplies
 *     for each of the 5,651 cards in `apps/web/src/data/card-index.json`: 85
 *     distinct terms. The test re-derives that count from the JSON rather than
 *     trusting this comment, and fails on any term that resolves to nothing and
 *     is not listed in {@link POOL_TERMS_WITHOUT_GLOSSARY}.
 *
 * ## Why most rows carry no CR number
 *
 * The 36 engine-flag rows cite the rule the repo's own ENFORCED table says they
 * answer to (`KEYWORD_RULES`, conformance/rules-manifest.ts), and the test pins
 * every one of those citations against that table so the two cannot fork.
 *
 * Nothing else cites a number, deliberately. `rules-manifest.ts:10-15` records
 * that **24 citations in this repo were found wrong and corrected**, and a grep
 * of the surviving prose cites turns up live contradictions right now —
 * `regenerate` appears as both CR 701.19 and CR 701.15, `scry` as 701.17 and
 * 701.22, `investigate` as 701.51 and 701.16a. A rules number is the one part of
 * a tooltip a player would repeat as fact, so an uncertain one is worse than
 * none (rule 2: report honestly rather than widen to the nearest plausible
 * thing). The explanations stand on their own.
 */
import type { KeywordFlags } from '@jonny-boi/core';

/**
 * What KIND of thing a glossary row explains. CLOSED — the kind drives how a
 * tooltip frames the row, and an untabulated kind would have to be framed by
 * guessing.
 */
export const GLOSSARY_TERM_KINDS = [
  /** A keyword ability (CR 702): the word itself carries rules meaning. */
  'keyword',
  /** A keyword action (CR 701): a verb — scry, mill, proliferate. */
  'action',
  /**
   * An ability word (CR 207.2c): italic flavour that has NO rules meaning of its
   * own. It only groups cards that share a condition; the ability after the dash
   * does all the work.
   */
  'abilityWord',
  /**
   * A combat restriction or requirement this engine models as a `KeywordFlags`
   * entry but which no card prints as a single word ("can't be blocked",
   * "attacks each combat if able"). It still needs a row, because a GRANTED one
   * appears in the aftermarket rules text (UX-17.3) and must be explainable.
   */
  'restriction',
  /** A predefined token a card creates — Treasure, Food. */
  'token',
] as const;
export type GlossaryTermKind = (typeof GLOSSARY_TERM_KINDS)[number];

/** One row of the glossary. */
export interface GlossaryEntry {
  /** The canonical display name, as a card prints it. */
  readonly term: string;
  readonly kind: GlossaryTermKind;
  /** How it works, in plain English. Mechanism first; never copied reminder text. */
  readonly text: string;
  /**
   * The Comprehensive Rules reference, present ONLY where the repo's enforced
   * `KEYWORD_RULES` table supplies it (see the module doc for why nothing else
   * cites one).
   */
  readonly rule?: string;
  /**
   * The `KeywordFlags` key this row explains, when the engine models it as a
   * flag. This is the link Lane P's aftermarket rules-text rendering follows: it
   * holds a flag key and needs the words, and it must not have to translate one
   * vocabulary into the other (rule 12).
   */
  readonly flag?: keyof KeywordFlags;
  /**
   * Other spellings that resolve to this row — DECLARED synonyms, not fuzzy
   * matches. Matched after {@link normalizeGlossaryTerm}, so case and spacing
   * need not be repeated here.
   */
  readonly aliases?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* The table. One row per term; adding the next term is a ROW.                 */
/* -------------------------------------------------------------------------- */

const ENTRIES = {
  // --- evasion and blocking ------------------------------------------------
  flying: {
    term: 'Flying',
    kind: 'keyword',
    rule: '702.9',
    flag: 'flying',
    text: 'Only creatures that themselves have flying, or that have reach, can block it. It can still block anything.',
  },
  reach: {
    term: 'Reach',
    kind: 'keyword',
    rule: '702.17',
    flag: 'reach',
    text: 'It can block creatures with flying. That is its whole effect — it does not let this creature fly.',
  },
  menace: {
    term: 'Menace',
    kind: 'keyword',
    rule: '702.111',
    flag: 'menace',
    text: 'It cannot be blocked unless two or more creatures block it together. One blocker on its own is an illegal block.',
  },
  shadow: {
    term: 'Shadow',
    kind: 'keyword',
    rule: '702.28',
    flag: 'shadow',
    text: 'It can block, and be blocked by, only creatures that also have shadow. That cuts both ways: a creature without shadow cannot block it, and it cannot block a creature without shadow.',
  },
  horsemanship: {
    term: 'Horsemanship',
    kind: 'keyword',
    rule: '702.31',
    flag: 'horsemanship',
    text: 'It can be blocked only by other creatures with horsemanship. Almost nothing has it, so in practice it is unblockable.',
  },
  landwalk: {
    term: 'Landwalk',
    kind: 'keyword',
    // The mirror worked exactly as designed, so this is the record of it: this
    // row used to read '702.18' because the conformance manifest did, and
    // '702.18' is SHROUD — one CR section cannot define two keywords. The row
    // mirrored the manifest rather than "correcting" it (a second independent
    // answer is the fork rule 12 forbids) and `keyword-glossary.test.ts` pinned
    // the mirror. Core fixed the manifest to '702.14' (§3.143 wave 2, GAP-15)
    // and this row went RED until it followed. Landwalk sits between intimidate
    // (702.13) and lifelink (702.15). Keep mirroring: never edit this number
    // except to match `KEYWORD_RULES`.
    rule: '702.14',
    flag: 'landwalk',
    text: 'Printed as "swampwalk", "islandwalk", "nonbasic landwalk" and so on. It cannot be blocked at all as long as the player it is attacking controls a land of that kind — one is enough, and it does not have to be tapped or doing anything.',
  },
  fear: {
    term: 'Fear',
    kind: 'keyword',
    flag: 'blockRestriction',
    text: 'It can be blocked only by artifact creatures and by black creatures. Anything else is an illegal blocker.',
  },
  intimidate: {
    term: 'Intimidate',
    kind: 'keyword',
    flag: 'blockRestriction',
    text: 'It can be blocked only by artifact creatures and by creatures that share a color with it. A colorless non-artifact creature cannot block it at all.',
  },
  skulk: {
    term: 'Skulk',
    kind: 'keyword',
    flag: 'blockRestriction',
    text: 'It cannot be blocked by creatures with greater power than its own. The comparison uses its power at the moment blockers are declared, so pumping it first makes it harder to block.',
  },
  flanking: {
    term: 'Flanking',
    kind: 'keyword',
    rule: '702.25',
    flag: 'flanking',
    text: 'Whenever a creature WITHOUT flanking blocks it, that blocker gets -1/-1 until end of turn. A blocker that also has flanking is unaffected.',
  },
  bushido: {
    term: 'Bushido',
    kind: 'keyword',
    text: 'Whenever it blocks or becomes blocked, it gets +N/+N until end of turn — so it is bigger in combat than its printed box suggests, but only once combat is actually joined.',
  },
  rampage: {
    term: 'Rampage',
    kind: 'keyword',
    text: 'It gets +N/+N for each blocker beyond the first. Gang-blocking it makes it larger, so two blockers is often worse than one.',
  },

  // --- combat damage -------------------------------------------------------
  firstStrike: {
    term: 'First strike',
    kind: 'keyword',
    rule: '702.7',
    flag: 'firstStrike',
    text: 'It deals its combat damage in a separate, earlier damage step. Anything it kills there is gone before the normal damage step, so that creature never deals damage back.',
  },
  doubleStrike: {
    term: 'Double strike',
    kind: 'keyword',
    rule: '702.4',
    flag: 'doubleStrike',
    text: 'It deals combat damage twice: once in the first-strike step and again in the normal one. Both hits are full damage, so it effectively hits for double.',
  },
  deathtouch: {
    term: 'Deathtouch',
    kind: 'keyword',
    rule: '702.2',
    flag: 'deathtouch',
    text: 'Any nonzero amount of damage it deals to a creature is lethal — even 1. It does nothing to players beyond normal damage.',
  },
  trample: {
    term: 'Trample',
    kind: 'keyword',
    rule: '702.19',
    flag: 'trample',
    text: 'When it is blocked, it assigns only enough damage to kill its blockers and the rest goes through to the defending player. With deathtouch, "enough" is 1 per blocker.',
  },
  lifelink: {
    term: 'Lifelink',
    kind: 'keyword',
    rule: '702.15',
    flag: 'lifelink',
    text: 'Any damage it deals — combat or otherwise, to anything — also gains its controller that much life, at the same moment the damage happens.',
  },
  vigilance: {
    term: 'Vigilance',
    kind: 'keyword',
    rule: '702.20',
    flag: 'vigilance',
    text: 'Attacking does not tap it. It stays untapped, so it can still block on the other player’s turn.',
  },
  haste: {
    term: 'Haste',
    kind: 'keyword',
    rule: '702.10',
    flag: 'haste',
    text: 'It can attack, and use abilities that need it to tap, the same turn it arrives — instead of having to wait until your next turn.',
  },
  defender: {
    term: 'Defender',
    kind: 'keyword',
    rule: '702.3',
    flag: 'defender',
    text: 'It cannot attack, ever. It blocks completely normally.',
  },
  indestructible: {
    term: 'Indestructible',
    kind: 'keyword',
    rule: '702.12',
    flag: 'indestructible',
    text: 'Damage never destroys it, and effects that say "destroy" do nothing to it. It is NOT invulnerable: toughness reduced to 0, sacrifice, exile and "put into the graveyard" all still work.',
  },
  myriad: {
    term: 'Myriad',
    kind: 'keyword',
    rule: '702.116',
    flag: 'myriad',
    text: 'When it attacks, you may make an attacking token copy for each opponent OTHER than the one being attacked. This game is two-player, so there is never such an opponent and myriad does nothing here — that is the printed rule, not a limitation of this app.',
  },

  // --- protection, targeting and counters ----------------------------------
  hexproof: {
    term: 'Hexproof',
    kind: 'keyword',
    rule: '702.11',
    flag: 'hexproof',
    text: 'Your opponents cannot target it with spells or abilities. You still can. It does not stop damage or effects that do not target, such as a board wipe.',
  },
  shroud: {
    term: 'Shroud',
    kind: 'keyword',
    rule: '702.18',
    flag: 'shroud',
    text: 'Nobody can target it — including you. Stronger than hexproof, and often a drawback, because your own auras and pump spells cannot reach it either.',
  },
  protectionFrom: {
    term: 'Protection from',
    kind: 'keyword',
    rule: '702.16',
    flag: 'protectionFrom',
    text: 'Against sources with the named quality, four things stop working: it cannot be Damaged, Enchanted or equipped, Blocked, or Targeted by them. Everything else from that source — a sacrifice effect, "destroy", -X/-X — still applies.',
    aliases: ['protection'],
  },
  hexproofFrom: {
    term: 'Hexproof from',
    kind: 'keyword',
    rule: '702.11',
    flag: 'hexproofFrom',
    text: 'Your opponents cannot target it with spells or abilities of the named quality. Only ONE of protection’s four rules, and only against opponents: their black removal cannot aim at a creature with hexproof from black, but their black board wipe still kills it, their black creature can still block it, and you can still target it yourself.',
    aliases: ['hexproof from'],
  },
  ward: {
    term: 'Ward',
    kind: 'keyword',
    rule: '702.21',
    flag: 'ward',
    text: 'Whenever an opponent targets it, their spell or ability is countered unless they pay the ward cost as well. It is a tax, not a wall: a player who pays it targets freely.',
  },
  infect: {
    term: 'Infect',
    kind: 'keyword',
    rule: '702.90',
    flag: 'infect',
    text: 'Its damage still counts as damage, but the result changes: creatures get that many -1/-1 counters instead of marked damage, and players get that many poison counters instead of losing life. Ten poison counters and that player loses.',
  },
  wither: {
    term: 'Wither',
    kind: 'keyword',
    rule: '702.80',
    flag: 'wither',
    text: 'Its damage to a CREATURE arrives as that many -1/-1 counters instead of ordinary damage, so it is permanent and does not wear off at end of turn. Damage to players is completely normal.',
  },
  toxic: {
    term: 'Toxic',
    kind: 'keyword',
    rule: '702.164',
    flag: 'toxic',
    text: 'On top of its normal combat damage, a player it hits in combat also gets N poison counters. Only combat damage, and only players.',
  },

  // --- timing --------------------------------------------------------------
  flash: {
    term: 'Flash',
    kind: 'keyword',
    rule: '702.8',
    flag: 'flash',
    text: 'You may cast it any time you could cast an instant — on the other player’s turn, or in response to something.',
  },
  splitSecond: {
    term: 'Split second',
    kind: 'keyword',
    rule: '702.61',
    flag: 'splitSecond',
    text: 'While it is on the stack, nobody may cast spells or activate abilities (mana abilities excepted). Abilities that TRIGGER still trigger and resolve normally — the lock is on taking actions, not on the game.',
  },

  // --- engine-modelled combat restrictions and requirements ----------------
  // Nothing prints these as a single word, but a granted one shows up in the
  // aftermarket rules text (UX-17.3), so each needs words of its own.
  unblockable: {
    term: "Can't be blocked",
    kind: 'restriction',
    rule: '509.1b',
    flag: 'unblockable',
    text: 'No blocker may be assigned to it at all. Not a keyword ability — a restriction the card states in words.',
    aliases: ['unblockable'],
  },
  cantBlock: {
    term: "Can't block",
    kind: 'restriction',
    rule: '509.1b',
    flag: 'cantBlock',
    text: 'It may never be declared as a blocker, whatever it would be blocking.',
  },
  doesNotUntap: {
    term: "Doesn't untap",
    kind: 'restriction',
    rule: '502.1',
    flag: 'doesNotUntap',
    text: 'It stays tapped through its next untap step for as long as this lasts. Not a keyword ability — a continuous effect on what the untap step does.',
  },
  minBlockers: {
    term: "Can't be blocked except by N or more creatures",
    kind: 'restriction',
    rule: '509.1b',
    flag: 'minBlockers',
    text: 'At least N creatures must block it together or the block is illegal. Menace is the N = 2 printing of this same restriction.',
  },
  maxBlockers: {
    term: "Can't be blocked by more than one creature",
    kind: 'restriction',
    rule: '509.1b',
    flag: 'maxBlockers',
    text: 'A single creature may block it, and a second one may not — the opposite restriction to menace. Gang-blocking it is illegal.',
  },
  blockRestriction: {
    term: "Can't be blocked by…",
    kind: 'restriction',
    rule: '509.1b',
    flag: 'blockRestriction',
    text: 'A restriction that describes the BLOCKER rather than naming a keyword: a power or toughness bound, a keyword the blocker must have, or "greater power than this creature". It is checked against the blocker’s current values, not its printed ones.',
  },
  blockOnly: {
    term: 'Can block only creatures with…',
    kind: 'restriction',
    rule: '509.1b',
    flag: 'blockOnly',
    text: 'A restriction on what THIS creature may block: the attacker must have at least one of the named keywords. It can still attack anything.',
  },
  mustBeBlocked: {
    term: 'Must be blocked if able',
    kind: 'restriction',
    rule: '509.1c',
    flag: 'mustBeBlocked',
    text: 'A block REQUIREMENT: if the defender can legally block it, they must block it with at least one creature. One blocker satisfies it.',
  },
  blockedByAllAble: {
    term: 'All creatures able to block it do so',
    kind: 'restriction',
    rule: '509.1c',
    flag: 'blockedByAllAble',
    text: 'The Lure requirement, and stronger than "must be blocked": EVERY creature that could legally block it has to. Leaving one home makes the whole declaration illegal.',
  },
  mustAttack: {
    term: 'Attacks each combat if able',
    kind: 'restriction',
    rule: '508.1d',
    flag: 'mustAttack',
    text: 'An attack REQUIREMENT: if it is untapped, not summoning sick and otherwise able, it has to be declared as an attacker.',
  },
  cantAttackUnlessDefenderControls: {
    term: "Can't attack unless defending player controls…",
    kind: 'restriction',
    rule: '508.1c',
    flag: 'cantAttackUnlessDefenderControls',
    text: 'An attack RESTRICTION: it may only be declared as an attacker while the defending player controls the named kind of land. Every line printed on it must hold at once.',
  },

  // --- casting from unusual places, and alternative costs ------------------
  cycling: {
    term: 'Cycling',
    kind: 'keyword',
    text: 'An ability of the card while it is in your HAND: pay the cycling cost, discard it, draw a card. You are not casting it, so it cannot be countered as a spell — but you also do not get the card’s own effect.',
  },
  typecycling: {
    term: 'Typecycling',
    kind: 'keyword',
    text: 'Printed as "plainscycling", "forestcycling", "basic landcycling" and so on. Same as cycling, except instead of drawing you search your library for a card of the named type, reveal it, put it in your hand and shuffle.',
    aliases: ['landcycling', 'basic landcycling'],
  },
  flashback: {
    term: 'Flashback',
    kind: 'keyword',
    text: 'You may cast it from your GRAVEYARD for its flashback cost instead of its normal one. It then gets exiled rather than going back to the graveyard, so it works exactly once.',
  },
  madness: {
    term: 'Madness',
    kind: 'keyword',
    text: 'If you DISCARD it, it is exiled instead of hitting the graveyard, and you may immediately cast it for its madness cost. Decline and it goes to the graveyard as normal.',
  },
  suspend: {
    term: 'Suspend',
    kind: 'keyword',
    text: 'From your hand, pay the suspend cost to exile it with N time counters. One comes off at each of your upkeeps; when the last is removed the card is cast for free, and if it is a creature it gains haste.',
  },
  buyback: {
    term: 'Buyback',
    kind: 'keyword',
    text: 'Pay the extra buyback cost as you cast it, and when it resolves it returns to your hand instead of the graveyard — so you can cast it again every turn you can afford it.',
  },
  kicker: {
    term: 'Kicker',
    kind: 'keyword',
    text: 'An OPTIONAL extra cost you may pay as you cast it. Paying it turns on an additional effect written on the card; the spell is perfectly castable without it.',
  },
  echo: {
    term: 'Echo',
    kind: 'keyword',
    text: 'At the beginning of your first upkeep after it arrives, you must pay its echo cost or sacrifice it. It is effectively a second payment one turn later, not an ongoing tax.',
  },
  cumulativeUpkeep: {
    term: 'Cumulative upkeep',
    kind: 'keyword',
    text: 'At the beginning of each of your upkeeps it gains an age counter, then you must pay the cost once for EVERY age counter on it or sacrifice it. The price climbs every turn.',
  },
  fading: {
    term: 'Fading',
    kind: 'keyword',
    text: 'It enters with N fade counters. At each of your upkeeps you remove one — and if there are none left to remove, you sacrifice it. So fading N lasts N turns.',
  },
  vanishing: {
    term: 'Vanishing',
    kind: 'keyword',
    text: 'It enters with N time counters and loses one at each of your upkeeps. When the last one is removed it is sacrificed. So vanishing N lasts one turn longer than fading N.',
  },
  aftermath: {
    term: 'Aftermath',
    kind: 'keyword',
    text: 'A split card whose second half can only be cast from your GRAVEYARD, never from your hand — and it is exiled afterwards. You cast the first half from hand, then the second half later.',
  },
  persist: {
    term: 'Persist',
    kind: 'keyword',
    text: 'When it dies, if it had no -1/-1 counter on it, it comes straight back to the battlefield with one. That counter is what stops it looping forever.',
  },
  soulshift: {
    term: 'Soulshift',
    kind: 'keyword',
    text: 'When it dies, you may return a Spirit card with mana value N or less from your graveyard to your hand.',
  },
  livingWeapon: {
    term: 'Living weapon',
    kind: 'keyword',
    text: 'When this Equipment enters, it makes a 0/0 black Phyrexian Germ token and attaches itself to it. The Germ is only alive because of what the Equipment gives it, so moving the Equipment off kills it.',
  },

  // --- cost reduction ------------------------------------------------------
  convoke: {
    term: 'Convoke',
    kind: 'keyword',
    text: 'You may tap untapped creatures you control while casting it. Each one you tap pays for {1}, or for one mana of that creature’s color. Summoning-sick creatures can still be tapped this way.',
  },
  improvise: {
    term: 'Improvise',
    kind: 'keyword',
    text: 'Convoke with artifacts: you may tap untapped artifacts you control while casting it, each paying for {1}. Only generic mana, never colored.',
  },
  delve: {
    term: 'Delve',
    kind: 'keyword',
    text: 'You may exile any number of cards from your graveyard while casting it, each paying for {1}. The cards are gone for good, so it trades graveyard for speed.',
  },
  affinity: {
    term: 'Affinity',
    kind: 'keyword',
    text: 'It costs {1} less to cast for each permanent you control of the named kind (usually artifacts). The reduction only touches generic mana — the colored pips still have to be paid.',
  },

  // --- static and triggered bodies -----------------------------------------
  enchant: {
    term: 'Enchant',
    kind: 'keyword',
    text: "An Aura's targeting rule: it can only be attached to the kind of thing its Enchant line names, and if that ever stops being true the Aura is put into the graveyard.",
  },
  equip: {
    term: 'Equip',
    kind: 'keyword',
    text: 'An activated ability of the Equipment, usable only at sorcery speed on your own turn: pay the equip cost to attach it to a creature you control. Attaching it is free of the creature — the Equipment stays behind if the creature dies.',
  },
  prowess: {
    term: 'Prowess',
    kind: 'keyword',
    text: 'Whenever you cast a NONCREATURE spell, it gets +1/+1 until end of turn. It triggers on casting, so it is already bigger while your spell is still on the stack.',
  },
  exalted: {
    term: 'Exalted',
    kind: 'keyword',
    text: 'Whenever a creature you control attacks ALONE, that creature gets +1/+1 until end of turn — once for each exalted ability you control. Attacking with a second creature turns it off entirely.',
  },
  changeling: {
    term: 'Changeling',
    kind: 'keyword',
    text: 'This card is every creature type at once, everywhere — in your hand, on the battlefield, in the graveyard. Every tribal lord and every "Goblins you control" effect sees it.',
  },
  devoid: {
    term: 'Devoid',
    kind: 'keyword',
    text: 'The card has NO color, whatever mana symbols are printed on its cost. It is still cast with that colored mana; it just is not that color for anything that cares.',
  },

  // --- ability words (CR 207.2c — no rules meaning of their own) ------------
  landfall: {
    term: 'Landfall',
    kind: 'abilityWord',
    text: 'Flavour text for "whenever a land enters the battlefield under your control". The word itself does nothing; the ability written after it is the real one, and it triggers on every land, not just your land drop.',
  },
  constellation: {
    term: 'Constellation',
    kind: 'abilityWord',
    text: 'Flavour text for "whenever an enchantment enters the battlefield under your control". The word itself does nothing; the ability after it does.',
  },
  metalcraft: {
    term: 'Metalcraft',
    kind: 'abilityWord',
    text: 'Flavour text for "as long as you control three or more artifacts". The word itself does nothing; the ability after it is live only while that condition holds.',
  },
  revolt: {
    term: 'Revolt',
    kind: 'abilityWord',
    text: 'Flavour text for "if a permanent you controlled left the battlefield this turn". Any permanent counts — a fetched land, a sacrificed token, a creature that died.',
  },
  alliance: {
    term: 'Alliance',
    kind: 'abilityWord',
    text: 'Flavour text for "whenever another creature you control enters the battlefield". The word itself does nothing; the ability after it does.',
  },

  // --- keyword actions (CR 701) --------------------------------------------
  scry: {
    term: 'Scry',
    kind: 'action',
    text: 'Look at the top N cards of your library, put any number of them on the BOTTOM in any order, and the rest back on top in any order. You do not draw them.',
  },
  surveil: {
    term: 'Surveil',
    kind: 'action',
    text: 'Look at the top N cards of your library and put any number of them into your GRAVEYARD, the rest back on top in any order. Like scry, but the rejects are milled rather than bottomed.',
  },
  mill: {
    term: 'Mill',
    kind: 'action',
    text: 'Put the top N cards of a library directly into that player’s graveyard. Nobody draws them and nothing is cast.',
  },
  proliferate: {
    term: 'Proliferate',
    kind: 'action',
    text: 'Choose any number of permanents and players that already have a counter on them, and give each one MORE of every kind of counter it already has. It never adds a kind that is not already there.',
  },
  investigate: {
    term: 'Investigate',
    kind: 'action',
    text: 'Create a Clue — a colorless artifact token with "{2}, Sacrifice this: Draw a card". It is a card you have to pay for later, not one you get now.',
  },
  regenerate: {
    term: 'Regenerate',
    kind: 'action',
    text: 'A shield that lasts until end of turn. The next time the creature would be destroyed, instead it is tapped, removed from combat, and all damage marked on it is cleared. It does NOT save the creature from exile, sacrifice, or 0 toughness.',
  },
  transform: {
    term: 'Transform',
    kind: 'action',
    text: 'Turn a double-faced permanent over so its other face is up. It is the SAME permanent throughout — auras, counters, damage and summoning sickness all stay exactly as they were.',
  },

  // --- predefined tokens (CR 111.10) ---------------------------------------
  treasure: {
    term: 'Treasure',
    kind: 'token',
    text: 'A colorless artifact token with "{T}, Sacrifice this: Add one mana of any color". One-shot ramp or fixing that you keep until you need it.',
  },
  food: {
    term: 'Food',
    kind: 'token',
    text: 'A colorless artifact token with "{2}, {T}, Sacrifice this: You gain 3 life".',
  },
} as const satisfies Readonly<Record<string, GlossaryEntry>>;

/** Every canonical key of {@link KEYWORD_GLOSSARY}. */
export type GlossaryKey = keyof typeof ENTRIES;

/** The glossary itself, keyed by canonical term key. */
export const KEYWORD_GLOSSARY: Readonly<Record<GlossaryKey, GlossaryEntry>> = Object.freeze(ENTRIES);

/**
 * Every `KeywordFlags` key → the glossary row that explains it.
 *
 * ⚠️ **A MAPPED TYPE over the interface, on purpose.** Adding a keyword to core
 * stops `tsc` here until this file names its explanation — the same default-deny
 * shape core uses for `KEYWORD_LIST_IS_EXHAUSTIVE` and `KEYWORD_RULES`, and for
 * the same reason: a granted keyword that silently renders with no tooltip is
 * indistinguishable from one the player simply did not hover.
 *
 * Several flags share a row (`fear`, `intimidate` and `skulk` are all
 * `blockRestriction` in the engine); that is a many-to-one link, not a fork.
 */
export const KEYWORD_FLAG_GLOSSARY: { readonly [K in keyof KeywordFlags]-?: GlossaryKey } =
  Object.freeze({
    flying: 'flying',
    vigilance: 'vigilance',
    haste: 'haste',
    firstStrike: 'firstStrike',
    doubleStrike: 'doubleStrike',
    deathtouch: 'deathtouch',
    trample: 'trample',
    reach: 'reach',
    defender: 'defender',
    lifelink: 'lifelink',
    flash: 'flash',
    hexproof: 'hexproof',
    shroud: 'shroud',
    menace: 'menace',
    unblockable: 'unblockable',
    cantBlock: 'cantBlock',
    doesNotUntap: 'doesNotUntap',
    minBlockers: 'minBlockers',
    mustBeBlocked: 'mustBeBlocked',
    blockedByAllAble: 'blockedByAllAble',
    blockRestriction: 'blockRestriction',
    indestructible: 'indestructible',
    horsemanship: 'horsemanship',
    protectionFrom: 'protectionFrom',
    hexproofFrom: 'hexproofFrom',
    ward: 'ward',
    infect: 'infect',
    wither: 'wither',
    toxic: 'toxic',
    shadow: 'shadow',
    flanking: 'flanking',
    splitSecond: 'splitSecond',
    myriad: 'myriad',
    mustAttack: 'mustAttack',
    landwalk: 'landwalk',
    cantAttackUnlessDefenderControls: 'cantAttackUnlessDefenderControls',
    maxBlockers: 'maxBlockers',
    blockOnly: 'blockOnly',
  });

/* -------------------------------------------------------------------------- */
/* Lookup                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The ONE normaliser — every lookup goes through it, so "First strike" (rules
 * text), `firstStrike` (the engine flag) and "FIRST STRIKE" are one key.
 *
 * The steps, in order, and why each exists:
 *  1. lower-case;
 *  2. cut at the first "(" or em dash — reminder text ("Changeling (This card is
 *     every creature type.)") and the ability-word dash ("Landfall — Whenever…")
 *     both trail the word the player is actually hovering;
 *  3. drop WHOLE `{…}` groups. ⚠️ This has to happen before step 4 and as a
 *     group, not symbol by symbol: "Cycling {1}{U}" reduced to bare characters
 *     leaves "cycling1u", and stripping trailing digits does not save it because
 *     the coloured pip is last. Dropping the braces and their contents together
 *     is the only rule that handles a coloured cost and a generic one alike;
 *  4. drop everything that is not a letter or digit, which removes spaces,
 *     hyphens and apostrophes;
 *  5. drop trailing digits, so "Toxic 1", "Bushido 1" and "Soulshift 3" — whose
 *     values are printed with no braces at all — reach their bare keywords.
 */
export function normalizeGlossaryTerm(raw: string): string {
  const cut = raw.toLowerCase().split(/[(—]/u)[0] ?? '';
  return cut
    .replace(/\{[^}]*\}/gu, '')
    .replace(/[^a-z0-9]+/gu, '')
    .replace(/[0-9]+$/u, '');
}

/**
 * A term whose keyword is its PREFIX or its SUFFIX, by the rule's own wording.
 *
 * ⚠️ This is not a fuzzy fallback, and the difference matters. "Swampwalk" is a
 * landwalk ability *because CR 702.14b defines landwalk as "[type]walk"* — the
 * affix IS the definition, so resolving it is exact. What is forbidden, and what
 * this table exists instead of, is nearest-match guessing: a term that matches
 * no row and no affix returns `undefined` and the caller shows no tooltip,
 * because a plausible wrong explanation of a rules keyword is worse than none.
 *
 * CLOSED — three rows. A new printed family is a ROW here, never a loosened
 * matcher.
 */
export interface GlossaryAffixRule {
  readonly position: 'prefix' | 'suffix';
  /** Already normalised (see {@link normalizeGlossaryTerm}). */
  readonly affix: string;
  readonly entry: GlossaryKey;
  /** Why the affix is definitional rather than a resemblance. */
  readonly why: string;
}

/** The affix table (see {@link GlossaryAffixRule}). */
export const GLOSSARY_AFFIX_RULES: readonly GlossaryAffixRule[] = Object.freeze([
  Object.freeze({
    position: 'suffix',
    affix: 'walk',
    entry: 'landwalk',
    why: 'Landwalk is printed as "[land type]walk" — swampwalk, islandwalk, legendary landwalk. The suffix is how the rule names the family.',
  } as const),
  Object.freeze({
    position: 'suffix',
    affix: 'cycling',
    entry: 'typecycling',
    why: 'Typecycling is printed as "[type]cycling" — plainscycling, basic landcycling. Bare "cycling" is an exact row and is matched before this rule is consulted.',
  } as const),
  Object.freeze({
    position: 'prefix',
    affix: 'protectionfrom',
    entry: 'protectionFrom',
    why: '"Protection from [quality]" names the quality AFTER the keyword, and the quality is open-ended ("from Dragons", "from multicolored"), so it cannot be enumerated as aliases.',
  } as const),
]);

/**
 * Normalised spelling → canonical key, built once from every row's key, its
 * printed `term` and its declared aliases. One index, so a row cannot be
 * reachable by its key and unreachable by its printed name.
 */
const INDEX: ReadonlyMap<string, GlossaryKey> = (() => {
  const index = new Map<string, GlossaryKey>();
  for (const key of Object.keys(ENTRIES) as GlossaryKey[]) {
    const entry = KEYWORD_GLOSSARY[key];
    for (const spelling of [key, entry.term, ...(entry.aliases ?? [])]) {
      index.set(normalizeGlossaryTerm(spelling), key);
    }
  }
  return index;
})();

/**
 * The explanation for a hovered word, or `undefined` when there is none.
 *
 * `undefined` is a real answer and the caller must honour it by showing NO
 * tooltip: this table is closed, and inventing a rules explanation for a word it
 * does not know is the failure mode it exists to prevent.
 *
 * The returned row's `term` is the CANONICAL family name — hovering
 * "Swampwalk" returns the Landwalk row. The caller already has the word the
 * player pointed at and may show either.
 *
 * ⚠️ Pass the WORD the player pointed at, not a whole printed LINE. "Enchant
 * creature" is a line whose keyword is its first word; this table matches words,
 * and it deliberately does not prefix-match "enchant", because "enchantment" is
 * a card type and would then resolve to a keyword explanation that is simply
 * wrong.
 */
export function glossaryEntry(term: string): GlossaryEntry | undefined {
  const key = normalizeGlossaryTerm(term);
  if (key.length === 0) return undefined;
  const exact = INDEX.get(key);
  if (exact !== undefined) return KEYWORD_GLOSSARY[exact];
  for (const rule of GLOSSARY_AFFIX_RULES) {
    const matches =
      rule.position === 'suffix' ? key.endsWith(rule.affix) : key.startsWith(rule.affix);
    // The remainder must be non-empty: a bare "walk" names no land type and is
    // not a landwalk ability, so it must miss rather than resolve.
    if (matches && key.length > rule.affix.length) return KEYWORD_GLOSSARY[rule.entry];
  }
  return undefined;
}

/**
 * The explanation for an engine keyword flag. TOTAL by construction — every
 * `KeywordFlags` key has a row, and {@link KEYWORD_FLAG_GLOSSARY}'s mapped type
 * is what makes that a compile-time fact rather than a hope.
 */
export function glossaryForFlag(flag: keyof KeywordFlags): GlossaryEntry {
  return KEYWORD_GLOSSARY[KEYWORD_FLAG_GLOSSARY[flag]];
}

/**
 * Terms the card pool prints that deliberately have NO glossary row, each with
 * the reason — the visible gap CLAUDE.md rule 2 asks for instead of a silent
 * one. `keyword-glossary.test.ts` fails if a pool term is missing from both the
 * glossary and this list, so the list cannot quietly grow.
 */
export const POOL_TERMS_WITHOUT_GLOSSARY: Readonly<Record<string, string>> = Object.freeze({
  Double:
    'Scryfall tags damage-DOUBLING replacement effects ("it deals double that damage instead") with this. It is not a keyword — there is no word on the card for a player to hover — and writing a glossary row for the bare verb "double" would explain something that does not exist.',
  Triple: 'The same, for damage-tripling effects. See "Double".',
});
