/**
 * §3.149 — THE NAMED-COUNTER AND GRAVEYARD-EXILE TEMPLATES.
 *
 * ## Every card text in this file is the card's REAL printed Oracle text
 * §3.57's dead rule was written from a remembered wording, and the test that
 * "covered" it was written from the same remembered wording: the two agreed
 * perfectly and covered nothing. So every string below was copied out of the
 * 32,414-card Scryfall corpus (2026-09-15), reminder text and all, and the two
 * acceptance cards for this lane — Scavenging Ooze and Luminarch Ascension, both
 * from `docs/decks/thunes-life.txt` — are asserted COMPLETE by name.
 *
 * ## The refusals are the other half of the claim
 * A template that swallows text it does not implement is worse than no template:
 * it puts a card into the pool playing differently from its print, and every A/B
 * verdict involving that card is then wrong. So each closed table is pinned from
 * both sides, and the refusal cases name WHY the engine may not widen:
 *   - shield / stun counters carry CR 122.1 behaviour this engine does not honour;
 *   - "Activate only if AN OPPONENT has …" is a different condition from
 *     "Activate only if THIS PERMANENT has …" and has no field to hold it.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

/** Build a compilable card; the defaults are the uninteresting half. */
function card(
  name: string,
  oracleText: string,
  overrides: Partial<CompilableCard> = {},
): CompilableCard {
  return {
    id: `test:${name}`,
    name,
    oracleText,
    manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

/** The clauses a card could not implement, for a failure message that explains itself. */
const why = (c: CompilableCard): string =>
  compileCard(c)
    .missing.map((m) => `${m.text} -> ${m.missingEngineSystem}`)
    .join(' ; ');

/* -------------------------------------------------------------------------- */
/* The two acceptance cards                                                    */
/* -------------------------------------------------------------------------- */

describe('§3.149 — Caleb’s deck cards (docs/decks/thunes-life.txt)', () => {
  const SCAVENGING_OOZE = card(
    'Scavenging Ooze',
    '{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on this creature and you gain 1 life.',
    {
      manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
      typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Ooze'] },
      power: 2,
      toughness: 2,
    },
  );

  const LUMINARCH_ASCENSION = card(
    'Luminarch Ascension',
    "At the beginning of each opponent's end step, if you didn't lose life this turn, you may put a quest counter on this enchantment. (Damage causes loss of life.)\n{1}{W}: Create a 4/4 white Angel creature token with flying. Activate only if this enchantment has four or more quest counters on it.",
    {
      manaCost: { generic: 1, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
      typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
    },
  );

  it('Scavenging Ooze compiles completely', () => {
    expect(compileCard(SCAVENGING_OOZE).status, why(SCAVENGING_OOZE)).toBe('complete');
  });

  it('Scavenging Ooze’s ability is what the card prints, not an approximation', () => {
    const ability = compileCard(SCAVENGING_OOZE).definition.activated?.[0];
    expect(ability?.cost.mana).toEqual({ G: 1 });
    const exile = ability?.effects[0];
    expect(exile?.primitive).toBe('exileTargetCardFromGraveyard');
    // "a graveyard" is EITHER player's — the whole reason a new restriction
    // existed to be added. A 'creatureCardInYourGraveyard' here would be a card
    // that cannot eat the opponent's graveyard, which is most of its job.
    expect(exile?.params?.targets).toBe('cardInAnyGraveyard');
    // The rider is gated on the type, and it is gated on CREATURE.
    expect(exile?.params?.ifWasType).toBe('creature');
    const rider = exile?.params?.effects as readonly { primitive: string }[];
    expect(rider.map((r) => r.primitive)).toEqual(['addCounters', 'gainLife']);
  });

  it('Luminarch Ascension compiles completely', () => {
    expect(compileCard(LUMINARCH_ASCENSION).status, why(LUMINARCH_ASCENSION)).toBe('complete');
  });

  it('Luminarch Ascension’s trigger is scoped, gated and optional exactly as printed', () => {
    const def = compileCard(LUMINARCH_ASCENSION).definition;
    const trigger = def.triggers?.[0];
    // "each OPPONENT'S end step" — `who: 'you'` would be a card that never
    // ticks on the turns it is meant to, and `'any'` one that ticks twice.
    expect(trigger?.condition.on).toBe('endStep');
    expect(trigger?.condition.who).toBe('opponent');
    expect(trigger?.condition.intervening).toEqual({ kind: 'didNotLoseLifeThisTurn' });
    // The gate on the SECOND line, with the printed floor.
    expect(def.activated?.[0]?.activateOnly).toEqual({
      kind: 'sourceHasCounters',
      counter: 'quest',
      min: 4,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The named-counter table, from both sides                                    */
/* -------------------------------------------------------------------------- */

describe('§3.149 — inert named counters compile; counters with RULES do not', () => {
  // Real printed text, corpus 2026-09-15.
  const COMPILES: readonly (readonly [string, string, Partial<CompilableCard>?])[] = [
    [
      'Grindclock',
      '{T}: Put a charge counter on this artifact.\n{T}: Target player mills X cards, where X is the number of charge counters on this artifact.',
      {},
    ],
    [
      'Surge Node',
      'This artifact enters with six charge counters on it.\n{1}, {T}, Remove a charge counter from this artifact: Put a charge counter on target artifact.',
      {},
    ],
  ];

  it('a "{T}: Put a charge counter on ~" line is understood', () => {
    // Grindclock's FIRST line compiles; its second (a variable mill) does not,
    // so the card still reports — which is the honest outcome and is asserted
    // below. What is claimed here is only that the counter line matched.
    const c = card(COMPILES[0]![0], COMPILES[0]![1]);
    expect(compileCard(c).matchedRules).toContain('put-named-counter-on-self');
  });

  it('"~ enters with six charge counters on it" is understood', () => {
    const c = card(COMPILES[1]![0], COMPILES[1]![1]);
    expect(compileCard(c).matchedRules).toContain('enters-with-named-counters');
  });

  it('a card whose counter is placed but never READ still reports — it does not enter the pool', () => {
    // THE SAFETY PROPERTY OF THIS WHOLE FAMILY. Placing an inert counter is
    // faithful; the line that SPENDS it is a separate template, and until that
    // template exists the card must stay out of the pool rather than enter it
    // half-implemented.
    const grindclock = card(COMPILES[0]![0], COMPILES[0]![1]);
    expect(compileCard(grindclock).status).toBe('incomplete');
    const surgeNode = card(COMPILES[1]![0], COMPILES[1]![1]);
    expect(compileCard(surgeNode).status).toBe('incomplete');
  });

  it('a bare "it" on a SPELL is not a self-reference — Free from Flesh', () => {
    // THE DEFECT THIS GUARD EXISTS FOR, found by diffing the accepted-card lists
    // rather than by a test: "Target creature gets +2/+2 until end of turn. Put
    // two oil counters on it." The sentence splitter hands the second half over
    // alone, "it" was read as the source, and this INSTANT compiled 'complete'
    // while its oil counters went nowhere — a card in the pool playing weaker
    // than printed. Real printed text, corpus 2026-09-15.
    const freeFromFlesh = card(
      'Free from Flesh',
      'Target creature gets +2/+2 until end of turn. Put two oil counters on it.',
      { typeLine: { supertypes: [], types: ['Instant'], subtypes: [] } },
    );
    const result = compileCard(freeFromFlesh);
    expect(result.status, 'a spell cannot hold counters, so the clause reports').toBe(
      'incomplete',
    );
    expect(result.matchedRules).not.toContain('put-named-counter-on-self');
  });

  it('the +1/+1 sibling now REFUSES a bare "it" on a spell — Big Play, Miraculous Recovery', () => {
    /*
     * §3.151 — the guard that replaced a pinned defect. This test used to assert
     * the WRONG behaviour on purpose, because the fix could not land alone: the
     * `sourceCanHoldCounters` gate drops both these cards from the pool, and
     * `pool-mechanics.test.ts`'s round-trip guard is absolute by design. The
     * pool refresh landed the gate and the regeneration as one change, so the
     * pin is now a guard pointing the other way.
     *
     * THE DEFECT IT GUARDS. `put-counters-on-self` read a bare "it" as the
     * source. On an INSTANT that is impossible — counters live on permanents
     * (CR 122.1) — and "it" is the creature the PREVIOUS sentence named, because
     * the sentence splitter hands the second half over alone. Both cards were in
     * the shipped pool putting their counter nowhere, playing weaker than
     * printed. A corpus sweep for every instant/sorcery compiling 'complete'
     * with a `self: true` addCounters found exactly these two.
     *
     * Deleting this test instead of inverting it would unpin the class: the gate
     * is one line, and the day somebody removes it these two cards would quietly
     * re-enter the pool mis-compiled, exactly as before. Real printed text,
     * corpus 2026-09-15.
     */
    const cases: readonly (readonly [string, string])[] = [
      [
        'Big Play',
        'Target creature gets +2/+2 and gains reach until end of turn. Put a +1/+1 counter on it.',
      ],
      [
        'Miraculous Recovery',
        'Return target creature card from your graveyard to the battlefield. Put a +1/+1 counter on it.',
      ],
    ];
    for (const [name, text] of cases) {
      const spell = card(name, text, {
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
      });
      const result = compileCard(spell);
      expect(
        result.status,
        `${name}: a spell cannot hold counters, so the clause must report`,
      ).toBe('incomplete');
      expect(result.matchedRules, `${name}: the bare-"it" rule must not match`).not.toContain(
        'put-counters-on-self',
      );
    }
  });

  it('but a bare "it" on a PERMANENT does mean the source', () => {
    // The other side of the same gate: on a creature, "put an oil counter on it"
    // inside its own trigger body is the source, and must still compile — a fix
    // that refused both readings would trade one wrong card for many.
    const drake = card(
      'Trawler Drake',
      'Whenever you cast a noncreature spell, put an oil counter on it.',
      {
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Drake'] },
        power: 0,
        toughness: 0,
      },
    );
    expect(compileCard(drake).matchedRules).toContain('put-named-counter-on-self');
  });

  const REFUSED: readonly (readonly [string, string])[] = [
    // CR 122.1c — a shield counter is removed INSTEAD of a destruction/damage.
    ['a shield counter', 'Put a shield counter on this artifact.'],
    // CR 122.1d — a stun counter is removed INSTEAD of an untap.
    ['a stun counter', 'Put a stun counter on this artifact.'],
    // §3.106 owns time/fade/age through suspend, vanishing and cumulative upkeep.
    ['a time counter', 'Put a time counter on this artifact.'],
    ['a fade counter', 'Put a fade counter on this artifact.'],
    // Whole card types read these.
    ['a loyalty counter', 'Put a loyalty counter on this artifact.'],
    ['a lore counter', 'Put a lore counter on this artifact.'],
    // A kind in no table at all reports rather than being widened.
    ['an unlisted kind', 'Put a bogus counter on this artifact.'],
  ];

  it.each(REFUSED)('refuses to place %s', (_label, text) => {
    const c = card('Probe', `{T}: ${text}`);
    const result = compileCard(c);
    expect(result.status).toBe('incomplete');
    expect(result.matchedRules).not.toContain('put-named-counter-on-self');
  });

  it('refuses the same kinds in the "enters with" position too', () => {
    for (const kind of ['shield', 'stun', 'time', 'loyalty']) {
      const c = card('Probe', `This artifact enters with two ${kind} counters on it.`);
      const result = compileCard(c);
      expect(result.matchedRules, `${kind} must not compile`).not.toContain(
        'enters-with-named-counters',
      );
      expect(result.status).toBe('incomplete');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The activation restriction, from both sides                                 */
/* -------------------------------------------------------------------------- */

describe('§3.149 — "Activate only if …"', () => {
  it('reads the SOURCE form and keeps the counters unspent (it is not a cost)', () => {
    // Tablet of Compleation, REAL printed text (corpus 2026-09-15). An earlier
    // draft of this test wrote the card from memory and gave it a
    // "Remove three oil counters" cost it does not print — §3.57's trap, caught
    // here only because the assertion was specific. The card prints TWO gated
    // abilities at different floors, which is a better test than the invented one.
    const tablet = card(
      'Tablet of Compleation',
      '{T}: Put an oil counter on this artifact.\n{T}: Add {C}. Activate only if this artifact has two or more oil counters on it.\n{1}, {T}: Draw a card. Activate only if this artifact has five or more oil counters on it.',
    );
    const result = compileCard(tablet);
    expect(result.status, why(tablet)).toBe('complete');
    const gated = (result.definition.activated ?? []).filter((a) => a.activateOnly !== undefined);
    expect(gated).toHaveLength(2);
    // Two floors on one card: each ability carries its OWN, so a shared or
    // last-wins reading would show up here immediately.
    expect(gated.map((a) => a.activateOnly)).toEqual([
      { kind: 'sourceHasCounters', counter: 'oil', min: 2 },
      { kind: 'sourceHasCounters', counter: 'oil', min: 5 },
    ]);
    // The restriction is NOT folded into the cost — that would spend the
    // counters the printed card only ever checks.
    expect(gated[0]?.cost).toEqual({ tap: true });
    expect(gated[1]?.cost).toEqual({ mana: { generic: 1 }, tap: true });
  });

  it('REFUSES the "an opponent has …" form, which is a different condition', () => {
    // Glistening Sphere, The Seedcore, Chittering Skitterling, Fleshless
    // Gladiator and Sinew Dancer print this; 5 cards that must keep reporting
    // rather than be quietly compiled as though they read their OWN counters.
    const sphere = card(
      'Glistening Sphere',
      'This artifact enters tapped.\n{T}: Add one mana of any color.\nCorrupted — {T}: Add three mana of any one color. Activate only if an opponent has three or more poison counters.',
    );
    const result = compileCard(sphere);
    expect(result.status).toBe('incomplete');
    for (const ability of result.definition.activated ?? []) {
      expect(ability.activateOnly, 'no restriction may be invented here').toBeUndefined();
    }
  });

  it('REFUSES an ability whose restriction it cannot transcribe, rather than dropping it', () => {
    // An unreadable COUNT must refuse the whole line. Compiling the ability
    // without its restriction would make it activatable in states the printed
    // card is not — strictly better, which is the direction that biases a verdict.
    const weird = card(
      'Probe',
      '{T}: Draw a card. Activate only if this artifact has umpteen or more oil counters on it.',
    );
    const result = compileCard(weird);
    expect(result.status).toBe('incomplete');
    expect(result.definition.activated ?? [], 'the whole ability is refused').toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The graveyard exile, from both sides                                        */
/* -------------------------------------------------------------------------- */

describe('§3.149 — "Exile target card from a graveyard"', () => {
  it('compiles the bare form — Crypt Creeper, real printed text', () => {
    const creeper = card(
      'Crypt Creeper',
      'Sacrifice this creature: Exile target card from a graveyard.',
      {
        manaCost: { generic: 1, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Zombie'] },
        power: 2,
        toughness: 1,
      },
    );
    expect(compileCard(creeper).status, why(creeper)).toBe('complete');
    const effect = compileCard(creeper).definition.activated?.[0]?.effects[0];
    expect(effect?.primitive).toBe('exileTargetCardFromGraveyard');
    // No rider on this card — and none invented.
    expect(effect?.params?.ifWasType).toBeUndefined();
  });

  it('refuses a rider whose CONDITION is a type it does not read', () => {
    // "If it was a LAND card" is a different sentence. Widening the rule to any
    // type word would be the silent approximation the compiler exists to refuse.
    //
    // The exile half still matches — the sentence splitter hands it over on its
    // own — and that is correct: what must NOT happen is the card entering the
    // pool. So the claim is that the rider is REPORTED BY NAME, which is the
    // thing that keeps the card out.
    const probe = card(
      'Probe',
      '{T}: Exile target card from a graveyard. If it was a land card, you gain 1 life.',
    );
    const result = compileCard(probe);
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((m) => m.text).join(' ')).toMatch(/land card/);
    // And no rider was invented on the effect that did compile.
    const exile = (result.definition.activated ?? [])
      .flatMap((a) => a.effects)
      .find((e) => e.primitive === 'exileTargetCardFromGraveyard');
    expect(exile?.params?.ifWasType, 'no rider invented').toBeUndefined();
  });

  it('refuses a rider whose BODY has no implementation', () => {
    const probe = card(
      'Probe',
      '{T}: Exile target card from a graveyard. If it was a creature card, you ascend to a higher plane.',
    );
    expect(compileCard(probe).status).toBe('incomplete');
  });
});
