/**
 * §3.148 — THE TARGETED-TRIGGER ROW, SPLIT THREE WAYS AND PINNED.
 *
 * The backlog row *"a targeted-trigger template the compiler does not recognize
 * yet"* named 888 cards. `scripts/targeted-blame.mjs` measured it as the §3.120
 * artifact (884 cards over 748 shapes) whose blame does NOT sit in one half:
 * 97 clauses are the TRIGGER CONDITION, 137 the TARGET SELECTOR, 396 the BODY.
 * Three shapes concentrate, and each one is pinned here by the thing it would
 * get WRONG if the rule were widened by a word:
 *
 *  1. the body's leading PRONOUN — "it deals N damage to …" — which means the
 *     source on a self-subject trigger and something else everywhere else;
 *  2. "creature an opponent controls" as a printed NOUN, which must never widen
 *     to "creature";
 *  3. the O-Ring's LINK, where the defect was a shipped card playing better than
 *     printed.
 */
import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';

/** A probe card carrying one printed line. Type is a parameter — an Aura is not a creature. */
function card(oracleText: string, over: Partial<CompilableCard> = {}): CompilableCard {
  return {
    id: 'test:targeted-trigger',
    name: 'Probe Card',
    manaCost: { generic: 2, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
    oracleText,
    power: '2',
    toughness: '2',
    keywords: [],
    ...over,
  } as CompilableCard;
}

const enchantment = (oracleText: string): CompilableCard =>
  card(oracleText, { typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] }, power: null, toughness: null });

/** The one trigger on a card that compiled, with a message naming what blocked it if it did not. */
function onlyTrigger(subject: CompilableCard) {
  const result = compileCard(subject);
  expect(result.status, JSON.stringify(result.missing)).toBe('complete');
  const triggers = result.definition.triggers ?? [];
  expect(triggers.length).toBeGreaterThan(0);
  return triggers[0]!;
}

describe('the body\'s leading pronoun — "it" is the source, but only where the subject is', () => {
  it('"When ~ enters, it deals N damage to any target" compiles to the source dealing the damage', () => {
    // Skeleton Archer / Meteorite / Sparkmage Apprentice — the largest
    // one-clause shape in the whole row (15 cards on the 32,414-card corpus).
    const trigger = onlyTrigger(card('When Probe Card enters, it deals 1 damage to any target.'));
    expect(trigger.condition.on).toBe('etb');
    expect(trigger.effects[0]?.primitive).toBe('dealDamage');
    expect(trigger.effects[0]?.params?.amount).toBe(1);
    // "any target" is the DEFAULT restriction, so the ability carries it rather
    // than the effect — the ability is what gets aimed.
    expect(trigger.targets).toBe('any');
  });

  it('reads the pronoun on the OTHER self-subject events too — dies, attacks', () => {
    // Mudbutton Torchrunner ("when ~ dies, it deals 3 damage to any target").
    const dies = onlyTrigger(card('When Probe Card dies, it deals 3 damage to any target.'));
    expect(dies.condition.on).toBe('dies');
    expect(dies.effects[0]?.params?.amount).toBe(3);

    const attacks = onlyTrigger(card('Whenever Probe Card attacks, it deals 1 damage to target player or planeswalker.'));
    expect(attacks.condition.on).toBe('attacks');
    expect(attacks.targets).toBe('playerOrPlaneswalker');
  });

  it('⚠️ REFUSES the pronoun when the trigger watches ANOTHER permanent — the damage would come from the wrong object', () => {
    // A BOARD-WATCHING trigger: "it" is the creature that died, never the
    // source. Widen `SOURCE_SUBJECT_EVENTS` to `permanentDies` and this card
    // compiles to the source burning someone, which is a different card.
    const boardWatch = compileCard(
      card('Whenever another creature you control dies, it deals 1 damage to any target.'),
    );
    expect(boardWatch.status).toBe('incomplete');

    // An EQUIPMENT'S host trigger is the same mistake wearing a flag: Extra Arms
    // prints "whenever enchanted creature attacks, it deals 2 damage to any
    // target", and the Aura is not the thing that deals it. Drop the `watches`
    // check in `resolveSourcePronoun` and this one compiles.
    const hostWatch = compileCard(
      card('Whenever equipped creature attacks, it deals 2 damage to any target.', {
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: ['Equipment'] },
        power: null,
        toughness: null,
      }),
    );
    expect(hostWatch.status).toBe('incomplete');
  });
});

describe('"creature an opponent controls" — one printed narrowing, four closed tables', () => {
  it('the SHRINK aims at the opponent only (Eyeblight Assassin)', () => {
    const trigger = onlyTrigger(
      card('When Probe Card enters, target creature an opponent controls gets -1/-1 until end of turn.'),
    );
    expect(trigger.effects[0]?.primitive).toBe('pumpUntilEndOfTurn');
    // The discriminator: 'creature' here would offer a pilot its OWN board as a
    // legal target for a penalty.
    expect(trigger.targets).toBe('creatureAnOpponentControls');
  });

  it('the TAP aims at the opponent only (Frost Trickster and the freeze family)', () => {
    const trigger = onlyTrigger(card('When Probe Card enters, tap target creature an opponent controls.'));
    expect(trigger.effects[0]?.primitive).toBe('tapTarget');
    expect(trigger.targets).toBe('creatureAnOpponentControls');
  });

  it('the BURN aims at the opponent only (Oath of Chandra)', () => {
    const trigger = onlyTrigger(
      card('When Probe Card enters, it deals 2 damage to target creature an opponent controls.'),
    );
    expect(trigger.effects[0]?.primitive).toBe('dealDamage');
    expect(trigger.targets).toBe('creatureAnOpponentControls');
  });

  it('the BOUNCE reads the SHARED noun table, not a private list (Stingscourger)', () => {
    const trigger = onlyTrigger(
      card("When Probe Card enters, return target creature an opponent controls to its owner's hand."),
    );
    expect(trigger.effects[0]?.primitive).toBe('returnToHand');
    expect(trigger.targets).toBe('creatureAnOpponentControls');

    // Sharing is the point: a noun added for destroy/exile has to reach bounce in
    // the SAME edit, or the three verbs drift into disagreeing about which nouns
    // are real. "nonland permanent" was in the table long before this change and
    // bounce could not say it.
    const nonland = onlyTrigger(
      card("When Probe Card enters, return target nonland permanent to its owner's hand."),
    );
    expect(nonland.targets).toBe('nonlandPermanent');
  });

  it('a noun OUTSIDE the table is still refused by bounce — never widened', () => {
    // The closed-table discipline the shared table exists to keep. "creature or
    // land" is not a restriction core carries; compiling it as 'permanent' would
    // let the card bounce an artifact it may not touch.
    expect(
      compileCard(card("When Probe Card enters, return target creature or land to its owner's hand.")).status,
    ).toBe('incomplete');
  });
});

describe('the O-Ring LINK — an exile that must remember who took the prisoner', () => {
  /** Oblivion Ring, printed. */
  const OBLIVION_RING = enchantment(
    'When Probe Card enters, exile another target nonland permanent.\n' +
      "When Probe Card leaves the battlefield, return the exiled card to the battlefield under its owner's control.",
  );
  /** Journey to Nowhere, printed — the same machine without the word "another". */
  const JOURNEY = enchantment(
    'When Probe Card enters, exile target creature.\n' +
      "When Probe Card leaves the battlefield, return the exiled card to the battlefield under its owner's control.",
  );

  it('⚠️ THE SHIPPED DEFECT: a paired exile must LINK, or the return half gives back nothing', () => {
    // Journey to Nowhere was in the pool compiling to `exileTarget` — which
    // records no link — beside a `returnExiledByThis` that returns only what the
    // link names. The creature was exiled for ever and destroying the
    // enchantment gave nothing back: removal with no drawback, a strictly better
    // card than the one printed. `exileTarget` here is the red.
    const result = compileCard(JOURNEY);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const [enters, leaves] = result.definition.triggers ?? [];
    expect(enters?.effects[0]?.primitive).toBe('exileUntilLeaves');
    expect(enters?.targets).toBe('creature');
    expect(leaves?.effects[0]?.primitive).toBe('returnExiledByThis');
  });

  it('Oblivion Ring compiles, aims at a nonland permanent, and cannot name ITSELF', () => {
    const result = compileCard(OBLIVION_RING);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const enters = (result.definition.triggers ?? [])[0]!;
    expect(enters.effects[0]?.primitive).toBe('exileUntilLeaves');
    expect(enters.targets).toBe('nonlandPermanent');
    // "ANOTHER" is load-bearing: a Ring that could exile itself would leave,
    // return itself and trigger again, for ever (DESIGN §3.33's mirror).
    expect(enters.targetsExcludeSelf).toBe(true);
  });

  it('⚠️ an ETB exile with NO printed return line stays a PLAIN exile', () => {
    // Galactus prints "When Galactus enters, exile target permanent." and never
    // gives it back. Drop the `printsLinkedReturn` guard and this compiles to
    // the linked funnel — a permanent exile that would hand the card back the
    // moment the exiler died. The same sentence is two different cards, and only
    // the card knows which.
    const plain = compileCard(enchantment('When Probe Card enters, exile target permanent.'));
    expect(plain.status, JSON.stringify(plain.missing)).toBe('complete');
    expect((plain.definition.triggers ?? [])[0]?.effects[0]?.primitive).toBe('exileTarget');
  });

  it('leaves the two shipped O-Ring printings exactly as they were', () => {
    // Banisher Priest (one sentence, both halves) and Fiend Hunter (the optional
    // "you may") have their own rules and their own tests; this pins that the new
    // rule did not steal either sentence.
    const priest = compileCard(
      card('When Probe Card enters, exile target creature an opponent controls until Probe Card leaves the battlefield.'),
    );
    expect(priest.status).toBe('complete');
    const priestTriggers = priest.definition.triggers ?? [];
    expect(priestTriggers.length, 'one printed sentence, TWO abilities (CR 603.6c)').toBe(2);
    expect(priestTriggers[0]?.effects[0]?.primitive).toBe('exileUntilLeaves');

    const hunter = compileCard(
      card(
        'When Probe Card enters, you may exile another target creature.\n' +
          "When Probe Card leaves the battlefield, return the exiled card to the battlefield under its owner's control.",
      ),
    );
    expect(hunter.status).toBe('complete');
    expect((hunter.definition.triggers ?? [])[0]?.effects[0]?.primitive, 'still wrapped in the printed "you may"').toBe(
      'mayEffects',
    );
  });
});
