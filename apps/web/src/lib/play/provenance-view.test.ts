/**
 * THE AFTERMARKET CARD FACE, PINNED (§3.143 / UX-17).
 *
 * Caleb has complained, by name, that bugs he finds by playing should have been
 * caught by a test. Every behavioural claim this lane makes has a case here, and
 * the four that would be quietly wrong rather than loudly broken are the reason
 * the file is this long:
 *
 *  1. **The reported example, literally.** A 4/5 with an aura giving +1/+1 and
 *     flying must read 5/6, and its keyword line must read
 *     "Vigilance, first strike, Flying". Not "a badge saying +1/+1", not "a
 *     separate list of granted keywords" — the words in the line, in order.
 *  2. **The reminder-text trap.** `normalizeGlossaryTerm` cuts at "(", so a
 *     greedy three-word scan of "Vigilance (Attacking doesn't" MATCHES and would
 *     underline two words of reminder text as part of the keyword.
 *  3. **The sum.** base + every delta must equal the effective value. Core
 *     guarantees it; a row dropped HERE breaks it silently, and a tooltip whose
 *     arithmetic does not add up is the one failure this feature exists to
 *     prevent.
 *  4. **Not colour alone.** An added ability and a removed one must be
 *     distinguishable with no colour vision, so the rendered markup is asserted
 *     to differ in glyph AND in class, not merely in hue.
 *
 * It also covers the RENDERER, even though the file is named for the model: this
 * lane owns exactly one test file, and the claims about what reaches the DOM
 * (the tooltip is really there, a word with no glossary row really shows
 * nothing) cannot be made anywhere else.
 *
 * The last block is the anti-drift guard: a REAL board, through core's real
 * `explainCharacteristics`, into this model. Hand-written fixtures are how a
 * view model ends up testing its own assumptions instead of the engine's.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import {
  CHARACTERISTIC_KINDS,
  CONTRIBUTION_MODES,
  CONTRIBUTION_SOURCE_KINDS,
  UNEXPLAINED_SOURCE_NAME,
  createGame,
  explainCharacteristics,
  indexContinuous,
  type CardDefinition,
  type CardInstance,
  type CharacteristicContribution,
  type CharacteristicExplanation,
  type ContributionSource,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { CardFace } from '../../components/play/CardFace.js';
import { GLOSSARY_TERM_KINDS, KEYWORD_FLAG_GLOSSARY } from './keyword-glossary.js';
import {
  ALTERATION_TREATMENTS,
  ATTRIBUTION_PRESENTATION,
  CARD_FACE_BENCH_SAMPLES,
  CARD_FACE_REGIONS,
  CHARACTERISTIC_PRESENTATION,
  GLOSSARY_KIND_LABELS,
  KEYWORD_VALUE_DISPLAY,
  KEYWORD_VALUE_DISPLAYS,
  MODE_TREATMENTS,
  SOURCE_KIND_NOUNS,
  TREATMENT_PRESENTATION,
  buildCardFaceModel,
  tokenizeRulesLine,
  type CardFaceInput,
} from './provenance-view.js';

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function source(overrides: Partial<ContributionSource> = {}): ContributionSource {
  return {
    kind: 'attachment',
    instanceId: 42,
    cardId: 'aura-id',
    name: 'Griffin Guide',
    zone: 'battlefield',
    ...overrides,
  };
}

function explanation(
  overrides: Partial<CharacteristicExplanation> & {
    readonly contributions: readonly CharacteristicContribution[];
  },
): CharacteristicExplanation {
  return {
    instanceId: 1,
    cardId: 'subject',
    name: 'Subject',
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

/** The reported case: 4/5, "Vigilance, first strike", an aura giving +1/+1 and flying. */
function calebsCase(): CardFaceInput {
  const aura = source({ label: 'Enchanted creature gets +1/+1 and has flying.' });
  return {
    oracleText: 'Vigilance, first strike',
    isCreature: true,
    explanation: explanation({
      power: 5,
      toughness: 6,
      printedKeywords: { vigilance: true, firstStrike: true },
      keywords: { vigilance: true, firstStrike: true, flying: true },
      contributions: [
        { characteristic: 'keyword', layer: 'ability', mode: 'grant', detail: 'flying', source: aura },
        { characteristic: 'power', layer: 'modifyPT', mode: 'add', amount: 1, source: aura },
        { characteristic: 'toughness', layer: 'modifyPT', mode: 'add', amount: 1, source: aura },
      ],
    }),
  };
}

/** Every token's text, joined — what the line actually READS as. */
function lineText(tokens: readonly { readonly text: string }[]): string {
  return tokens.map((t) => t.text).join('');
}

/* -------------------------------------------------------------------------- */
/* 1. The tables are closed, total, and not colour alone                       */
/* -------------------------------------------------------------------------- */

describe('the tables are closed and total', () => {
  it('every characteristic core can attribute has a place on the card face', () => {
    for (const kind of CHARACTERISTIC_KINDS) {
      const row = CHARACTERISTIC_PRESENTATION[kind];
      expect(row, `no presentation row for "${kind}"`).toBeDefined();
      expect(CARD_FACE_REGIONS).toContain(row.region);
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.why.length, `"${kind}" must say WHY it renders where it does`).toBeGreaterThan(20);
    }
    expect(Object.keys(CHARACTERISTIC_PRESENTATION).sort()).toEqual([...CHARACTERISTIC_KINDS].sort());
  });

  it('every contribution mode has a treatment', () => {
    for (const mode of CONTRIBUTION_MODES) {
      expect(ALTERATION_TREATMENTS).toContain(MODE_TREATMENTS[mode]);
    }
    expect(Object.keys(MODE_TREATMENTS).sort()).toEqual([...CONTRIBUTION_MODES].sort());
  });

  it('every source kind has words', () => {
    for (const kind of CONTRIBUTION_SOURCE_KINDS) {
      expect(SOURCE_KIND_NOUNS[kind].noun.length).toBeGreaterThan(0);
    }
    expect(Object.keys(SOURCE_KIND_NOUNS).sort()).toEqual([...CONTRIBUTION_SOURCE_KINDS].sort());
  });

  it('every glossary term kind has a tooltip label, and an ability word SAYS it has no rules meaning', () => {
    for (const kind of GLOSSARY_TERM_KINDS) expect(GLOSSARY_KIND_LABELS[kind].length).toBeGreaterThan(0);
    expect(GLOSSARY_KIND_LABELS.abilityWord).toContain('no rules meaning');
  });

  /**
   * THE GUARD FOR "core added a keyword and the card face did not notice". The
   * mapped type already stops `tsc`; this makes the gap loud in a plain
   * `vitest run`, which is what a sibling agent actually runs.
   */
  it('every engine keyword says where its VALUE is printed', () => {
    const flags = Object.keys(KEYWORD_FLAG_GLOSSARY);
    expect(flags.length).toBeGreaterThan(30);
    for (const flag of flags) {
      const display = (KEYWORD_VALUE_DISPLAY as Record<string, string>)[flag];
      expect(display, `keyword "${flag}" has no value-display rule`).toBeDefined();
      expect(KEYWORD_VALUE_DISPLAYS).toContain(display);
    }
    expect(Object.keys(KEYWORD_VALUE_DISPLAY).sort()).toEqual(flags.sort());
  });

  it('every treatment except "printed" carries a distinct non-colour glyph', () => {
    const glyphs: string[] = [];
    for (const treatment of ALTERATION_TREATMENTS) {
      const row = TREATMENT_PRESENTATION[treatment];
      if (treatment === 'printed') {
        expect(row.glyph, 'the printed baseline must not be decorated').toBe('');
        continue;
      }
      expect(row.glyph.length, `"${treatment}" needs a glyph, not just a colour`).toBeGreaterThan(0);
      expect(row.srLabel.length).toBeGreaterThan(0);
      glyphs.push(row.glyph);
    }
    expect(new Set(glyphs).size, 'two treatments sharing a glyph is one treatment').toBe(glyphs.length);
    expect(ATTRIBUTION_PRESENTATION.unknownSource.glyph.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The glossary tokeniser (UX-17.4)                                         */
/* -------------------------------------------------------------------------- */

describe('every ability word gets its explanation, and no word gets a guessed one', () => {
  it('finds both a one-word and a two-word keyword in one line', () => {
    const tokens = tokenizeRulesLine('Vigilance, first strike');
    const named = tokens.filter((t) => t.glossary !== undefined).map((t) => t.text);
    expect(named).toEqual(['Vigilance', 'first strike']);
    expect(tokens.find((t) => t.text === 'first strike')?.glossary?.term).toBe('First strike');
  });

  /**
   * THE REMINDER-TEXT TRAP. Without the span guard the three-word window
   * "Vigilance (Attacking doesn't" normalises to "vigilance", matches, and
   * highlights reminder text as part of the keyword.
   */
  it('stops the keyword at the reminder text, not three words into it', () => {
    const tokens = tokenizeRulesLine("Vigilance (Attacking doesn't cause this creature to tap.)");
    const named = tokens.filter((t) => t.glossary !== undefined);
    expect(named).toHaveLength(1);
    expect(named[0]?.text).toBe('Vigilance');
  });

  it('takes the first word of an "Enchant creature" line and not the line', () => {
    const tokens = tokenizeRulesLine('Enchant creature');
    const named = tokens.filter((t) => t.glossary !== undefined).map((t) => t.text);
    expect(named).toEqual(['Enchant']);
  });

  it('leaves sentence punctuation out of the highlighted word', () => {
    const tokens = tokenizeRulesLine('Enchanted creature has flying.');
    const flying = tokens.find((t) => t.glossary?.term === 'Flying');
    expect(flying?.text).toBe('flying');
    expect(tokens.at(-1)?.text).toBe('.');
  });

  it('resolves a printed cost and a brace-less value', () => {
    expect(tokenizeRulesLine('Cycling {1}{U}').find((t) => t.glossary)?.glossary?.term).toBe('Cycling');
    expect(tokenizeRulesLine('Ward {2}').find((t) => t.glossary)?.glossary?.term).toBe('Ward');
    expect(tokenizeRulesLine('Scry 2').find((t) => t.glossary)?.glossary?.term).toBe('Scry');
  });

  it('shows NOTHING for a word the glossary does not know', () => {
    const tokens = tokenizeRulesLine('Sacrifice a creature: Draw a card.');
    expect(tokens.every((t) => t.glossary === undefined)).toBe(true);
  });

  it('never re-spaces the printed line', () => {
    for (const line of [
      'Vigilance, first strike',
      "Vigilance (Attacking doesn't cause this creature to tap.)",
      'Enchanted creature gets +2/+2 and has flying.',
      '{T}: Add {C}.',
      'Landfall — Whenever a land enters the battlefield under your control, draw a card.',
    ]) {
      expect(lineText(tokenizeRulesLine(line))).toBe(line);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The P/T box and its breakdown (UX-17.1, UX-17.2)                         */
/* -------------------------------------------------------------------------- */

describe('the P/T box shows the effective numbers with a full breakdown', () => {
  it('4/5 with a +1/+1 aura reads 5/6, marked altered, naming the aura', () => {
    const model = buildCardFaceModel(calebsCase());
    expect(model.pt?.power).toBe(5);
    expect(model.pt?.toughness).toBe(6);
    expect(model.pt?.altered).toBe(true);
    expect(model.pt?.treatment).toBe('altered');
    expect(model.pt?.summary).toBe('5/6 (base 4/5)');

    const power = model.pt?.breakdown.find((b) => b.characteristic === 'power');
    expect(power?.rows.map((r) => r.kind)).toEqual(['base', 'delta', 'total']);
    expect(power?.rows[0]?.value).toBe('4');
    expect(power?.rows[1]?.value).toBe('+1');
    expect(power?.rows[1]?.note?.text).toContain('Griffin Guide');
    expect(power?.rows[1]?.note?.text).toContain('Enchanted creature gets +1/+1 and has flying.');
    expect(power?.rows[2]?.value).toBe('5');
  });

  /** THE SUM. A row dropped here is a tooltip whose arithmetic does not add up. */
  it('base plus every delta equals the effective value, on every fixture', () => {
    const inputs: CardFaceInput[] = [calebsCase(), ...CARD_FACE_BENCH_SAMPLES.map((s) => s.input)];
    for (const input of inputs) {
      const model = buildCardFaceModel(input);
      for (const part of model.pt?.breakdown ?? []) {
        const base = part.rows.find((r) => r.kind === 'base')?.amount ?? 0;
        const deltas = part.rows.filter((r) => r.kind === 'delta').reduce((n, r) => n + (r.amount ?? 0), 0);
        expect(base + deltas, `${part.characteristic} does not add up`).toBe(part.effective);
        expect(part.reconciles).toBe(true);
      }
    }
  });

  it('a characteristic-defining box states the base rather than adding to it', () => {
    const self = source({ kind: 'self', cardId: 'goyf', name: 'Tarmogoyf' });
    const model = buildCardFaceModel({
      isCreature: true,
      explanation: explanation({
        basePower: 4,
        baseToughness: 5,
        power: 4,
        toughness: 5,
        contributions: [
          { characteristic: 'power', layer: 'basePT', mode: 'replace', amount: 4, detail: '4', source: self },
          { characteristic: 'toughness', layer: 'basePT', mode: 'replace', amount: 5, detail: '5', source: self },
        ],
      }),
    });
    const power = model.pt?.breakdown.find((b) => b.characteristic === 'power');
    // Exactly two rows: a base and a total. A `replace` row must NOT become a
    // delta, or a 4/5 Tarmogoyf renders as "0/0, +4/+5".
    expect(power?.rows.map((r) => r.kind)).toEqual(['base', 'total']);
    expect(power?.rows[0]?.amount).toBe(4);
    expect(power?.rows[0]?.treatment).toBe('altered');
    expect(model.pt?.altered).toBe(true);
  });

  it('a copy RESTATES the printed box without entering the sum', () => {
    const self = source({ kind: 'self', cardId: 'bears', name: 'Grizzly Bears' });
    const model = buildCardFaceModel({
      isCreature: true,
      explanation: explanation({
        basePower: 2,
        baseToughness: 2,
        power: 2,
        toughness: 2,
        contributions: [
          { characteristic: 'power', layer: 'copy', mode: 'replace', detail: '2', previous: '0', source: self },
        ],
      }),
    });
    const power = model.pt?.breakdown.find((b) => b.characteristic === 'power');
    expect(power?.rows.map((r) => r.kind)).toEqual(['restated', 'base', 'total']);
    expect(power?.rows[0]?.value).toBe('0 → 2');
    expect(power?.reconciles).toBe(true);
  });

  it('an untraceable remainder is shown as altered with an honest "source unknown"', () => {
    const model = buildCardFaceModel({
      isCreature: true,
      explanation: explanation({
        power: 6,
        fullyAttributed: false,
        contributions: [
          {
            characteristic: 'power',
            layer: 'unknown',
            mode: 'add',
            amount: 2,
            source: { kind: 'unexplained', instanceId: 1, cardId: '', name: UNEXPLAINED_SOURCE_NAME, zone: 'unknown' },
          },
        ],
      }),
    });
    expect(model.pt?.attribution).toBe('unknownSource');
    expect(model.fullyAttributed).toBe(false);
    const delta = model.pt?.breakdown[0]?.rows.find((r) => r.kind === 'delta');
    expect(delta?.attribution).toBe('unknownSource');
    expect(delta?.note?.text).toContain(UNEXPLAINED_SOURCE_NAME);
  });

  it('no explanation means no P/T box invented', () => {
    expect(buildCardFaceModel({ cardId: 'x', name: 'X', oracleText: 'Flying' }).pt).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The ability list (UX-17.3)                                               */
/* -------------------------------------------------------------------------- */

describe('granted abilities appear in the rules text as if printed', () => {
  /** CALEB'S EXAMPLE, LITERALLY. */
  it('"Vigilance, first strike" becomes "Vigilance, first strike, Flying"', () => {
    const model = buildCardFaceModel(calebsCase());
    expect(model.lines).toHaveLength(1);
    expect(lineText(model.lines[0]!.tokens)).toBe('Vigilance, first strike, Flying');

    const flying = model.lines[0]!.tokens.find((t) => t.text === 'Flying');
    expect(flying?.treatment).toBe('granted');
    expect(flying?.glossary?.term).toBe('Flying');
    expect(flying?.notes[0]?.text).toContain('Griffin Guide');
    // The printed words are left exactly as printed.
    expect(model.lines[0]!.tokens.find((t) => t.text === 'Vigilance')?.treatment).toBe('printed');
  });

  it('with no printed keyword line the granted keywords get their own, at the top, with no stray comma', () => {
    const model = buildCardFaceModel({
      oracleText: 'When this creature enters, draw a card.',
      isCreature: true,
      explanation: explanation({
        keywords: { trample: true },
        contributions: [
          {
            characteristic: 'keyword',
            layer: 'ability',
            mode: 'grant',
            detail: 'trample',
            source: source({ kind: 'static', name: 'Glorious Anthem' }),
          },
        ],
      }),
    });
    expect(model.lines[0]?.origin).toBe('aftermarket');
    expect(lineText(model.lines[0]!.tokens)).toBe('Trample');
    expect(model.lines[1]?.origin).toBe('printed');
  });

  it('a REDUNDANT grant annotates the printed word instead of printing it twice', () => {
    const model = buildCardFaceModel({
      oracleText: 'Flying',
      isCreature: true,
      explanation: explanation({
        printedKeywords: { flying: true },
        keywords: { flying: true },
        contributions: [
          {
            characteristic: 'keyword',
            layer: 'ability',
            mode: 'grant',
            detail: 'flying',
            source: source({ name: 'Angelic Gift' }),
          },
        ],
      }),
    });
    expect(lineText(model.lines[0]!.tokens)).toBe('Flying');
    const flying = model.lines[0]!.tokens[0]!;
    expect(flying.treatment).toBe('printed');
    expect(flying.notes[0]?.text).toContain('Angelic Gift');
  });

  /**
   * REMOVAL. Nothing in this engine emits a `remove` row today — `grantInto`
   * only ORs — so this is the only place the struck-through rendering Caleb
   * asked for can be exercised at all. Written now so it is written ONCE, and so
   * the day removal lands it is already correct.
   */
  it('a removed keyword is struck through IN PLACE and explains itself', () => {
    const model = buildCardFaceModel({
      oracleText: 'Flying',
      isCreature: true,
      explanation: explanation({
        printedKeywords: { flying: true },
        keywords: { flying: true },
        contributions: [
          {
            characteristic: 'keyword',
            layer: 'ability',
            mode: 'remove',
            detail: 'flying',
            source: source({ kind: 'static', name: 'Grounding Field', label: 'Creatures lose flying.' }),
          },
        ],
      }),
    });
    const flying = model.lines[0]!.tokens[0]!;
    expect(flying.treatment).toBe('removed');
    expect(flying.notes[0]?.text).toContain('Grounding Field');
    expect(model.removalSupported, 'core still reports that nothing can remove a characteristic').toBe(false);
  });

  it('a removed keyword the printed text never named is appended, never dropped', () => {
    const model = buildCardFaceModel({
      oracleText: 'When this creature enters, draw a card.',
      isCreature: true,
      explanation: explanation({
        contributions: [
          {
            characteristic: 'keyword',
            layer: 'ability',
            mode: 'remove',
            detail: 'flying',
            source: source({ kind: 'static', name: 'Grounding Field' }),
          },
        ],
      }),
    });
    const removed = model.lines.flatMap((l) => l.tokens).filter((t) => t.treatment === 'removed');
    expect(removed.map((t) => t.text)).toEqual(['Flying']);
  });

  it('a granted ACTIVATED ability becomes its own line, glossary-tokenised', () => {
    const model = buildCardFaceModel({
      oracleText: 'Flying',
      isCreature: true,
      explanation: explanation({
        printedKeywords: { flying: true },
        contributions: [
          {
            characteristic: 'activatedAbility',
            layer: 'ability',
            mode: 'grant',
            detail: '{T}: Scry 1.',
            source: source({ name: 'Paradise Mantle' }),
          },
        ],
      }),
    });
    const line = model.lines.at(-1)!;
    expect(line.origin).toBe('aftermarket');
    expect(lineText(line.tokens)).toBe('{T}: Scry 1.');
    expect(line.tokens.every((t) => t.treatment === 'granted')).toBe(true);
    expect(line.tokens.find((t) => t.glossary !== undefined)?.glossary?.term).toBe('Scry');
  });

  it('prints a keyword value where it reads, and refuses where it does not', () => {
    const kw = (detail: string, extra: Partial<CharacteristicContribution>): CharacteristicContribution => ({
      characteristic: 'keyword',
      layer: 'ability',
      mode: 'grant',
      detail,
      source: source({ kind: 'static', name: 'Some Anthem' }),
      ...extra,
    });
    const model = buildCardFaceModel({
      isCreature: true,
      explanation: explanation({
        contributions: [
          kw('ward', { amount: 2 }),
          kw('protectionFrom', { values: ['white', 'green'] }),
          kw('minBlockers', { amount: 3 }),
          kw('landwalk', {}),
        ],
      }),
    });
    const tokens = model.lines.flatMap((l) => l.tokens);
    const byTerm = (term: string) => tokens.find((t) => t.glossary?.term === term);

    expect(byTerm('Ward')?.text).toBe('Ward 2');
    expect(byTerm('Protection from')?.text).toBe('Protection from white, green');
    // The term already spells the value out in words, so appending "3" would
    // produce nonsense — it goes in the tooltip instead.
    expect(byTerm("Can't be blocked except by N or more creatures")?.text).toBe(
      "Can't be blocked except by N or more creatures",
    );
    expect(byTerm("Can't be blocked except by N or more creatures")?.valueNote).toContain('3');
    // A record payload core never flattens to a string: name the family, and say
    // where the details are. Never "Landwalk island" invented from a field shape.
    expect(byTerm('Landwalk')?.text).toBe('Landwalk');
    expect(byTerm('Landwalk')?.valueNote).toContain('source card');
  });

  it('a keyword key the glossary does not cover is still SHOWN, with no tooltip', () => {
    const model = buildCardFaceModel({
      isCreature: true,
      explanation: explanation({
        contributions: [
          {
            characteristic: 'keyword',
            layer: 'ability',
            mode: 'grant',
            detail: 'someKeywordCoreAddedLater',
            source: source({ kind: 'static', name: 'A Card' }),
          },
        ],
      }),
    });
    const token = model.lines.flatMap((l) => l.tokens).find((t) => t.treatment === 'granted')!;
    expect(token.text).toBe('someKeywordCoreAddedLater');
    expect(token.glossary).toBeUndefined();
    expect(token.notes[0]?.text).toContain('A Card');
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Everything else that can be attributed (UX-17, item 4 of the brief)      */
/* -------------------------------------------------------------------------- */

describe('any other mutated characteristic is shown too', () => {
  /**
   * Caleb listed "the card's type, subtype, name, anything that something could
   * effect". Every one of them rides the SAME table-driven routing, so this
   * covers the whole family at once — and the day core attributes another
   * characteristic, the mapped type stops the build until it has a row.
   */
  it('a copy shows its name, type line, colours and printed cost as chips, routed by the table', () => {
    const self = source({ kind: 'self', cardId: 'bears', name: 'Grizzly Bears' });
    const model = buildCardFaceModel({
      isCreature: true,
      explanation: explanation({
        name: 'Grizzly Bears',
        contributions: [
          { characteristic: 'name', layer: 'copy', mode: 'replace', detail: 'Grizzly Bears', previous: 'Clone', source: self },
          { characteristic: 'subtypes', layer: 'copy', mode: 'replace', detail: 'Bear', previous: 'Shapeshifter', source: self },
          { characteristic: 'colors', layer: 'copy', mode: 'replace', detail: 'G', previous: 'U', source: self },
          { characteristic: 'manaCost', layer: 'copy', mode: 'replace', detail: '{1}{G}', previous: '{2}{U}', source: self },
          { characteristic: 'power', layer: 'copy', mode: 'replace', detail: '2', previous: '0', source: self },
        ],
      }),
    });
    expect(model.changes.map((c) => [c.characteristic, c.region, c.from, c.to])).toEqual([
      ['name', 'title', 'Clone', 'Grizzly Bears'],
      ['subtypes', 'typeLine', 'Shapeshifter', 'Bear'],
      ['colors', 'colors', 'U', 'G'],
      ['manaCost', 'cost', '{2}{U}', '{1}{G}'],
    ]);
    for (const change of model.changes) {
      expect(change.treatment).toBe('altered');
      expect(change.note.text).toContain('Grizzly Bears');
    }
    // P/T is drawn in the P/T box and must NOT also be a chip, or the same fact
    // is stated twice in two places (rule 12).
    expect(model.changes.some((c) => c.characteristic === 'power')).toBe(false);
  });

  it('a control change is a chip, because a card prints nothing about who controls it', () => {
    const model = buildCardFaceModel({
      isCreature: true,
      explanation: explanation({
        contributions: [
          {
            characteristic: 'controller',
            layer: 'control',
            mode: 'replace',
            detail: 'B',
            previous: 'A',
            source: source({ kind: 'temporary', name: 'Act of Treason', zone: 'graveyard' }),
          },
        ],
      }),
    });
    expect(model.changes[0]?.region).toBe('control');
    expect(model.changes[0]?.note.text).toContain('Act of Treason');
    // A resolved spell's card is in a graveyard — the one place a player cannot
    // otherwise find it.
    expect(model.changes[0]?.note.text).toContain('graveyard');
  });

  it('a source that has ceased to exist degrades to "cannot be shown", never a crash', () => {
    const model = buildCardFaceModel({
      isCreature: true,
      explanation: explanation({
        power: 7,
        contributions: [
          {
            characteristic: 'power',
            layer: 'modifyPT',
            mode: 'add',
            amount: 3,
            source: { kind: 'temporary', instanceId: 9, cardId: '', name: '(source no longer exists)', zone: 'unknown' },
          },
        ],
      }),
    });
    const delta = model.pt?.breakdown[0]?.rows.find((r) => r.kind === 'delta');
    expect(delta?.attribution).toBe('unknownSource');
    expect(delta?.note?.sourceCardId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The renderer                                                             */
/* -------------------------------------------------------------------------- */

function render(props: Parameters<typeof CardFace>[0]): string {
  return renderToStaticMarkup(createElement(CardFace, props));
}

/**
 * The reported case on a REAL pool card.
 *
 * ⚠️ The renderer resolves the printed rules text from the card index itself —
 * there is deliberately no `oracleText` prop, because a caller-supplied one
 * would be a second answer to "what does this card say" (rule 12). So a render
 * test that passes `cardId: null` exercises a card with NO printed text and
 * proves much less than it appears to. Every render assertion below rides a real
 * id for that reason.
 */
function realCardCase(): Parameters<typeof CardFace>[0] {
  const knight = loadCardPool({ onWarn: () => {} }).getByName('Youthful Knight')!;
  const aura = source({ label: 'Enchanted creature gets +2/+2 and has flying.' });
  return {
    cardId: knight.id,
    isCreature: true,
    explanation: explanation({
      cardId: knight.id,
      name: knight.name,
      basePower: 2,
      baseToughness: 1,
      power: 4,
      toughness: 3,
      printedKeywords: { firstStrike: true },
      keywords: { firstStrike: true, flying: true },
      contributions: [
        { characteristic: 'keyword', layer: 'ability', mode: 'grant', detail: 'flying', source: aura },
        { characteristic: 'power', layer: 'modifyPT', mode: 'add', amount: 2, source: aura },
        { characteristic: 'toughness', layer: 'modifyPT', mode: 'add', amount: 2, source: aura },
      ],
    }),
  };
}

describe('what actually reaches the DOM', () => {
  it('the reported case renders 4/3, a granted Flying beside the printed keyword, and the aura', () => {
    const html = render(realCardCase());
    expect(html).toContain('4/3');
    expect(html).toContain('card-face__pt--altered');
    expect(html).toContain('card-face__tok--granted');
    // The PRINTED keyword is really rendered as text (which is what makes it
    // hoverable at all) and the granted one joins it on the same line.
    expect(html).toContain('First strike');
    expect(html).toContain('Flying');
    expect(html).toContain('Griffin Guide');
    expect(html).toContain('Enchanted creature gets +2/+2 and has flying.');
    // The breakdown is really in the DOM, not conjured on hover by script.
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('Printed power');
  });

  /** NOT COLOUR ALONE: the two states differ in glyph and in class, not in hue. */
  it('an added ability and a removed one differ without any colour', () => {
    const granted = render(realCardCase());
    const removed = render({
      cardId: null,
      isCreature: true,
      explanation: explanation({
        printedKeywords: { flying: true },
        keywords: { flying: true },
        contributions: [
          {
            characteristic: 'keyword',
            layer: 'ability',
            mode: 'remove',
            detail: 'flying',
            source: source({ kind: 'static', name: 'Grounding Field' }),
          },
        ],
      }),
      name: 'Subject',
    });
    expect(granted).toContain(TREATMENT_PRESENTATION.granted.glyph);
    expect(removed).toContain(TREATMENT_PRESENTATION.removed.glyph);
    expect(granted).not.toContain(TREATMENT_PRESENTATION.removed.glyph);
    expect(granted).toContain('card-face__tok--granted');
    expect(removed).toContain('card-face__tok--removed');
    expect(granted).toContain(`aria-label="${TREATMENT_PRESENTATION.granted.srLabel}"`);
  });

  /**
   * UX-17.4 applies to EVERY card, not only modified ones — "hovering over any
   * ability like vigilance for example, ON ANY CARD". So a plain card with no
   * explanation at all must still carry the glossary.
   */
  it('a plain unmodified card still explains its printed ability words', () => {
    const knight = loadCardPool({ onWarn: () => {} }).getByName('Youthful Knight')!;
    const html = render({ cardId: knight.id, name: knight.name });
    expect(html).toContain('card-face__tok--printed');
    expect(html).toContain('role="tooltip"');
    // The actual explanation, not a placeholder.
    expect(html).toContain('separate, earlier damage step');
    // …and nothing claims the card has been altered.
    expect(html).not.toContain('card-face--altered');
    expect(html).not.toContain('card-face__tok--granted');
  });

  it('a word with no glossary row renders no tooltip at all', () => {
    const tokens = tokenizeRulesLine('Sacrifice a creature: Draw a card.');
    expect(tokens.every((t) => t.glossary === undefined && t.notes.length === 0)).toBe(true);
  });

  it('an unknown card id degrades to a name plate, never a crash', () => {
    const html = render({ cardId: 'not-a-real-card', name: 'Mystery Card' });
    expect(html).toContain('card-face__fallback');
    expect(html).toContain('Mystery Card');
    expect(html).not.toContain('<img');
  });

  it('a surface with NO provenance says so rather than showing an empty breakdown', () => {
    const html = render({
      cardId: null,
      name: 'Remote Creature',
      isCreature: true,
      unavailableReason: 'Live provenance is not carried by the multiplayer protocol yet.',
    });
    expect(html).toContain('multiplayer protocol');
    expect(html).not.toContain('card-face__pt--altered');
  });

  it('a partial attribution is stated on the face, not swallowed', () => {
    const html = render({
      cardId: null,
      name: 'Subject',
      isCreature: true,
      explanation: explanation({
        power: 6,
        fullyAttributed: false,
        contributions: [
          {
            characteristic: 'power',
            layer: 'unknown',
            mode: 'add',
            amount: 2,
            source: { kind: 'unexplained', instanceId: 1, cardId: '', name: UNEXPLAINED_SOURCE_NAME, zone: 'unknown' },
          },
        ],
      }),
    });
    expect(html).toContain('card-face--partial');
    expect(html).toContain('could not be traced');
    expect(html).toContain(ATTRIBUTION_PRESENTATION.unknownSource.glyph);
  });

  it('a tile shows only what the card does not already print', () => {
    const html = render({ ...realCardCase(), size: 'tile' });
    expect(html).toContain('card-face--tile');
    expect(html).toContain('Flying');
    expect(html).toContain('4/3');
    // "First strike" IS printed on the card and is one hover away; a 96px tile
    // spends its space on the words that are visible nowhere else.
    expect(html).not.toContain('First strike');
  });

  it('every card image is eager and never natively draggable (§3.54 / §3.119)', () => {
    const pool = loadCardPool({ onWarn: () => {} });
    const forest = pool.getByName('Forest')!;
    for (const size of ['tile', 'full'] as const) {
      const html = render({ cardId: forest.id, name: forest.name, size });
      const imgs = html.match(/<img\b[^>]*>/g) ?? [];
      expect(imgs.length, `${size} must render the real card`).toBeGreaterThan(0);
      for (const img of imgs) {
        expect(img).toContain('loading="eager"');
        expect(img).toContain('draggable="false"');
      }
    }
  });

  it('every bench sample renders — the debug bench cannot rot unnoticed', () => {
    expect(CARD_FACE_BENCH_SAMPLES.length).toBeGreaterThan(3);
    const ids = new Set<string>();
    for (const sample of CARD_FACE_BENCH_SAMPLES) {
      expect(ids.has(sample.id), `duplicate bench id "${sample.id}"`).toBe(false);
      ids.add(sample.id);
      expect(sample.expect.length).toBeGreaterThan(20);
      const html = render({ ...sample.input, cardId: sample.input.cardId ?? null });
      expect(html).toContain('card-face');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 7. The anti-drift guard: a REAL board through core's real walk              */
/* -------------------------------------------------------------------------- */

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function def(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

function fresh(): GameState {
  const forest = def('Forest');
  return createGame({
    seed: 5,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
    },
    registry,
  }).state;
}

function place(state: GameState, card: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def: card,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

describe('a real board, through core, into this model', () => {
  it('an aura, an anthem and a counter all reach the face with their own cards named', () => {
    const state = fresh();
    const knight = place(state, def('Youthful Knight'), 'A');
    const guide = place(state, def('Griffin Guide'), 'A');
    (guide as { attachedTo?: number }).attachedTo = knight.instanceId;
    place(state, def('Glorious Anthem'), 'A');
    knight.counters['+1/+1'] = 1;

    const found = explainCharacteristics(state, knight.instanceId, indexContinuous(state));
    expect(found, 'core must be able to explain a permanent on the battlefield').toBeDefined();
    const model = buildCardFaceModel({
      explanation: found!,
      oracleText: 'First strike',
      isCreature: true,
    });

    // The headline numbers are core's, not re-derived here.
    expect(model.pt?.power).toBe(found!.power);
    expect(model.pt?.toughness).toBe(found!.toughness);
    expect(model.pt?.basePower).toBe(2);
    expect(model.pt?.altered).toBe(true);
    expect(model.fullyAttributed).toBe(true);

    // Every breakdown still adds up on real data, not just on fixtures.
    for (const part of model.pt?.breakdown ?? []) {
      const base = part.rows.find((r) => r.kind === 'base')?.amount ?? 0;
      const deltas = part.rows.filter((r) => r.kind === 'delta').reduce((n, r) => n + (r.amount ?? 0), 0);
      expect(base + deltas).toBe(part.effective);
    }

    const sources = (model.pt?.breakdown ?? [])
      .flatMap((p) => p.rows)
      .map((r) => r.note?.sourceName)
      .filter((n): n is string => n !== undefined);
    expect(sources).toContain('Griffin Guide');
    expect(sources).toContain('Glorious Anthem');
    expect(sources).toContain('Youthful Knight');

    // …and the aura's granted keyword lands in the printed keyword line.
    expect(lineText(model.lines[0]!.tokens)).toBe('First strike, Flying');
    expect(model.lines[0]!.tokens.find((t) => t.text === 'Flying')?.treatment).toBe('granted');
  });

  it('a card with nothing done to it is a plain printed card', () => {
    const state = fresh();
    const knight = place(state, def('Youthful Knight'), 'A');
    const found = explainCharacteristics(state, knight.instanceId, indexContinuous(state))!;
    const model = buildCardFaceModel({ explanation: found, oracleText: 'First strike', isCreature: true });
    expect(model.altered).toBe(false);
    expect(model.pt?.treatment).toBe('printed');
    expect(model.changes).toHaveLength(0);
    // The glossary tooltip is still live on the printed word — UX-17.4 applies
    // to EVERY card, not only modified ones.
    expect(model.lines[0]?.tokens.find((t) => t.glossary !== undefined)?.glossary?.term).toBe('First strike');
  });
});
