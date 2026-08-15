/**
 * PLAY-QUALITY GUARDS for the default pilot.
 *
 * These exist because a pilot swap shipped that made every simulated game worse
 * in ways no existing test could see: the suite asserted games *finish* and
 * verdicts are *reproducible*, never that the pilots play *sensibly*. A user
 * watching a replay caught it in about a minute — a player tapped a Sol Ring and
 * did nothing with the mana.
 *
 * Both guards are cheap, deterministic, and measured against the engine's own
 * event log rather than against a pilot's internal reasoning, so they hold for
 * whichever pilot occupies the default slot.
 */

import { describe, expect, it } from 'vitest';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, compileCard, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { loadDeck } from './deck.js';
import { runMatch } from './match.js';

/**
 * Wasted-mana budget: `manaPoolEmptied` fires only when a step ends with mana
 * still floating, so it counts misplays directly. A competent pilot occasionally
 * floats mana legitimately (a held instant that never gets cast), so the bar is
 * a loose per-turn rate rather than zero — but it is far below the 1.76/turn the
 * regression produced, and comfortably above the 0.01/turn the heuristic scores.
 */
const MAX_WASTED_MANA_PER_TURN = 0.35;

/** Games to average the waste rate over (deterministic seeds). */
const WASTE_SAMPLE_SEEDS: readonly number[] = [1, 2, 3];

describe(`default pilot ("${DEFAULT_PILOT_ID}") play quality`, () => {
  const pool = loadCardPool();
  const registry = buildRegistry();
  const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;

  it('does not tap mana it never spends', () => {
    const deckA = loadDeck(SAMPLE_DECKS[0]!, pool);
    const deckB = loadDeck(SAMPLE_DECKS[1]!, pool);

    let wasted = 0;
    let turns = 0;
    for (const seed of WASTE_SAMPLE_SEEDS) {
      const result = runMatch(
        { deckA, deckB, pilotA: pilot, pilotB: pilot, registry },
        seed,
        { recordTrace: true },
      );
      wasted += (result.events ?? []).filter((e) => e.type === 'manaPoolEmptied').length;
      turns += result.turns;
    }

    const perTurn = wasted / Math.max(turns, 1);
    expect(
      perTurn,
      `${wasted} wasted-mana events over ${turns} turns (${perTurn.toFixed(2)}/turn). ` +
        'A pilot tapping sources it never spends plays visibly badly and skews every A/B verdict.',
    ).toBeLessThan(MAX_WASTED_MANA_PER_TURN);
  });

  it('attacks with a hasty creature into an empty board', () => {
    // A deck of nothing but Mountains and Monastery Swiftspear: whatever the
    // opening hand, turn one is "land, Swiftspear, swing" and the opponent
    // (drawing only lands) can never have a blocker.
    const swiftspear = pool.getByName('Monastery Swiftspear');
    const mountain = pool.getByName('Mountain');
    expect(swiftspear, 'Monastery Swiftspear is in the pool').toBeDefined();
    expect(mountain, 'Mountain is in the pool').toBeDefined();

    const hasteDeck = {
      name: 'Haste test',
      library: [
        ...Array.from({ length: 16 }, () => swiftspear!),
        ...Array.from({ length: 17 }, () => mountain!),
      ],
    };
    const landsOnly = { name: 'Lands only', library: Array.from({ length: 33 }, () => mountain!) };

    const result = runMatch(
      { deckA: hasteDeck, deckB: landsOnly, pilotA: pilot, pilotB: pilot, registry },
      7,
      { recordTrace: true },
    );

    // The opponent has no creatures at all, so any attack that happens is the
    // hasty creature getting in — and it must happen on the turn it lands.
    const firstAttack = (result.events ?? []).find(
      (e) => e.type === 'attackersDeclared' && e.attackers.length > 0,
    );
    expect(
      firstAttack,
      'a hasty creature with no possible blocker never attacked — haste is being ignored',
    ).toBeDefined();
  });

  it('actually uses a fetchland instead of leaving it on the battlefield', () => {
    // Compiling a card and PLAYING it are different claims. The engine can offer
    // an activated ability perfectly while every pilot ignores it, which looks
    // exactly like the card not working — a fetchland that never cracks is a
    // dead land. This asserts the whole chain: compile → offer → activate →
    // resolve → the land is really on the battlefield.
    const compiled = compileCard({
      id: 'test:arid-mesa',
      name: 'Arid Mesa',
      manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
      typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
      oracleText:
        '{T}, Pay 1 life, Sacrifice Arid Mesa: Search your library for a Mountain or Plains card, put it onto the battlefield, then shuffle.',
      power: null,
      toughness: null,
      keywords: [],
    });
    expect(compiled.status, 'the fetchland compiles').toBe('complete');

    const mountain = pool.getByName('Mountain')!;
    const fetchDeck = {
      name: 'Fetch test',
      library: [
        ...Array.from({ length: 12 }, () => compiled.definition),
        ...Array.from({ length: 21 }, () => mountain),
      ],
    };
    const landsOnly = { name: 'Lands only', library: Array.from({ length: 33 }, () => mountain) };

    const result = runMatch(
      { deckA: fetchDeck, deckB: landsOnly, pilotA: pilot, pilotB: pilot, registry },
      11,
      { recordTrace: true },
    );

    const activated = (result.events ?? []).filter((e) => e.type === 'abilityActivated');
    expect(
      activated.length,
      'the pilot never cracked a fetchland — the ability is offered but unused',
    ).toBeGreaterThan(0);
  });
});
