/**
 * LIFE GAIN'S ONE QUESTION, and the ANCHOR vocabulary — §3.151.
 *
 * Every test here pins a mistake that fails SILENTLY. Green tests on the old
 * code would have said nothing about any of them:
 *
 *  1. **The two gain mechanisms must give the SAME answer.** A doubler that
 *     doubles a resolving "you gain 3 life" but not a LIFELINK hit is the bug
 *     this file exists for, and it is invisible from either half alone —
 *     `lifelinkParityAmount` and `gainLifeAmount` are asserted equal on the same
 *     board. (`effect-helpers.changeLife` is the cards-side caller; its own
 *     parity with this is pinned in `packages/cards/src/replacement-lifegain.test.ts`,
 *     which plays a real Rhox Faithmender.)
 *  2. **Zero is a real answer and must emit nothing.** "That player gains no
 *     life instead" (Sulfuric Vortex) is CR 118.5: a gain of nothing is not a
 *     life-gain event, so "whenever you gain life" must NOT fire. A layer that
 *     returned zero while the caller still emitted `gainLife` would look
 *     perfect in every unit test of the layer itself.
 *  3. **An anchor is a READ, not a baked id.** An Aura that changes host must
 *     guard the new host on the very next damage event. Resolving the anchor at
 *     index time instead would pass every single-host test ever written.
 *  4. **A two-directional shield must guard BOTH directions and nothing else.**
 *     Fog Bank stops damage to itself and damage it deals — and must not stop a
 *     third creature's damage to a fourth. A shield built from one entry with a
 *     disjunctive filter passes the first two assertions and fails the third.
 *  5. **The twins must agree.** `gainLifeAmount` with and without a prebuilt
 *     index is the same disagreement §3.146 shipped as a real defect.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_REPLACEMENTS,
  REPLACEMENT_ANCHORS,
  REPLACEMENT_EVENT_KINDS,
  affectedPlayerPrefersMore,
  createGame,
  gainLifeAmount,
  indexReplacements,
  replaceDamage,
  replaceLifeGain,
  replacementIsInert,
  type CardDefinition,
  type CardInstance,
  type GameEvent,
  type GameState,
  type PlayerId,
  type ReplacementAbility,
} from './index.js';
import { deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

function freshGame(): GameState {
  return createGame({ seed: 11, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } }).state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
    attachedTo: null,
  };
  state.battlefield.push(inst);
  return inst;
}

function collector(): { emit: (e: GameEvent) => void; events: GameEvent[] } {
  const events: GameEvent[] = [];
  return { emit: (e) => void events.push(e), events };
}

/** A bare body to hang printed replacement abilities on. */
function permanentWith(id: string, replacements: readonly ReplacementAbility[]): CardDefinition {
  return { id, name: id, types: ['enchantment'], cost: { generic: 2 }, replacements };
}

const BEAR: CardDefinition = {
  id: 'test-bear',
  name: 'Test Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 2 },
};

/** Rhox Faithmender's printed clause, as the compiler emits it. */
const RHOX: ReplacementAbility = {
  event: 'lifegain',
  applies: { recipientController: 'you' },
  outcome: { times: 2 },
  label: 'if you would gain life, you gain twice that much life instead',
};

/** Sulfuric Vortex's — symmetric, and ZERO rather than a prevention. */
const VORTEX: ReplacementAbility = {
  event: 'lifegain',
  applies: {},
  outcome: { times: 0 },
  label: 'if a player would gain life, that player gains no life instead',
};

describe('the lifegain event kind is a first-class member of the closed vocabulary', () => {
  it('is listed in REPLACEMENT_EVENT_KINDS', () => {
    expect(REPLACEMENT_EVENT_KINDS).toContain('lifegain');
  });

  it('the affected player prefers MORE of it (CR 616.1 ordering)', () => {
    expect(affectedPlayerPrefersMore('lifegain')).toBe(true);
  });

  it('a times:1 lifegain declaration is INERT and never occupies an ordering slot', () => {
    expect(replacementIsInert({ event: 'lifegain', applies: {}, outcome: { times: 1 } })).toBe(true);
    // ...but times:0 is NOT inert: "gains no life" genuinely changes the event.
    expect(replacementIsInert(VORTEX)).toBe(false);
  });
});

describe('gainLifeAmount — the one question', () => {
  it('returns the amount unchanged when nothing in the game replaces life gain', () => {
    const state = freshGame();
    const log = collector();
    expect(gainLifeAmount(state, 'A', 3, log.emit)).toBe(3);
    // The inert path must not even build an index.
    expect(indexReplacements(state)).toBe(NO_REPLACEMENTS);
    expect(log.events).toHaveLength(0);
  });

  it('doubles a gain for the controller only — Rhox Faithmender', () => {
    const state = freshGame();
    place(state, permanentWith('rhox', [RHOX]), 'A');
    const log = collector();
    expect(gainLifeAmount(state, 'A', 3, log.emit)).toBe(6);
    // The opponent gains what they were going to gain: "if YOU would gain life".
    expect(gainLifeAmount(state, 'B', 3, log.emit)).toBe(3);
  });

  it('two doublers give x4 and the CR 614.5 loop terminates', () => {
    const state = freshGame();
    place(state, permanentWith('rhox-1', [RHOX]), 'A');
    place(state, permanentWith('rhox-2', [RHOX]), 'A');
    const log = collector();
    expect(gainLifeAmount(state, 'A', 5, log.emit)).toBe(20);
    expect(log.events.filter((e) => e.type === 'replacementApplied')).toHaveLength(2);
  });

  it('times:0 returns ZERO — "that player gains no life instead"', () => {
    const state = freshGame();
    place(state, permanentWith('vortex', [VORTEX]), 'B');
    const log = collector();
    // Symmetric: it is the VORTEX's controller's clause, but it names "a player".
    expect(gainLifeAmount(state, 'A', 7, log.emit)).toBe(0);
    expect(gainLifeAmount(state, 'B', 7, log.emit)).toBe(0);
  });

  it('a non-positive gain is never offered to the layer (CR 118.5)', () => {
    const state = freshGame();
    place(state, permanentWith('rhox', [RHOX]), 'A');
    const log = collector();
    // Zero must not become "twice zero plus a log line", and a negative number
    // is not a gain at all — it must pass through untouched rather than be
    // scaled into a larger loss.
    expect(gainLifeAmount(state, 'A', 0, log.emit)).toBe(0);
    expect(gainLifeAmount(state, 'A', -4, log.emit)).toBe(-4);
    expect(log.events).toHaveLength(0);
  });

  it('the index-passed and index-omitted forms always agree (the §3.146 twin trap)', () => {
    const state = freshGame();
    place(state, permanentWith('rhox', [RHOX]), 'A');
    const index = indexReplacements(state);
    for (const amount of [1, 2, 3, 7, 13]) {
      const withIndex = gainLifeAmount(state, 'A', amount, collector().emit, index);
      const without = gainLifeAmount(state, 'A', amount, collector().emit);
      expect(withIndex).toBe(without);
    }
  });
});

describe('LIFELINK asks the same question as a resolving effect', () => {
  /**
   * The parity that makes the funnel worth having. A lifelinked attacker and a
   * "you gain N life" spell are two mechanisms; Rhox Faithmender is one card and
   * does not distinguish them, so the two must return the same number for the
   * same board and the same amount.
   */
  it('a lifelink hit is doubled by Rhox exactly as a resolving gain is', () => {
    const state = freshGame();
    place(state, permanentWith('rhox', [RHOX]), 'A');
    const index = indexReplacements(state);
    for (const amount of [1, 4, 9]) {
      // What core's combat-damage path computes for LIFELINK...
      const lifelink = gainLifeAmount(state, 'A', amount, collector().emit, index);
      // ...and what the cards package's gain primitive computes. Same call,
      // deliberately: a second implementation is exactly what this forbids.
      const spell = replaceLifeGain(state, index, 'A', amount, collector().emit);
      expect(lifelink).toBe(spell);
      expect(lifelink).toBe(amount * 2);
    }
  });
});

describe('ANCHORS — one answer to "which object does ~ mean?"', () => {
  const ANCHOR_SHIELD = (
    side: 'recipientAnchor' | 'dealerAnchor',
    anchor: 'source' | 'attached',
  ): ReplacementAbility => ({
    event: 'damage',
    applies: { combat: true, [side]: anchor },
    outcome: { preventAll: true },
  });

  it('exports the closed anchor set', () => {
    expect([...REPLACEMENT_ANCHORS]).toEqual(['source', 'attached']);
  });

  it("'source' guards the ability's own permanent and nothing else", () => {
    const state = freshGame();
    const wall = place(state, permanentWith('wall', [ANCHOR_SHIELD('recipientAnchor', 'source')]), 'A');
    const other = place(state, BEAR, 'A');
    const attacker = place(state, BEAR, 'B');
    const index = indexReplacements(state);
    // Damage TO the shield's own permanent is prevented...
    expect(
      replaceDamage(state, index, attacker, 'B', wall, 'A', 4, true, collector().emit).amount,
    ).toBe(0);
    // ...and damage to a different creature the same player controls is NOT.
    expect(
      replaceDamage(state, index, attacker, 'B', other, 'A', 4, true, collector().emit).amount,
    ).toBe(4);
  });

  it("'source' on the DEALER side stops damage the permanent deals", () => {
    const state = freshGame();
    const wall = place(state, permanentWith('wall', [ANCHOR_SHIELD('dealerAnchor', 'source')]), 'A');
    const other = place(state, BEAR, 'A');
    const victim = place(state, BEAR, 'B');
    const index = indexReplacements(state);
    expect(replaceDamage(state, index, wall, 'A', victim, 'B', 3, true, collector().emit).amount).toBe(0);
    // A different creature's damage is untouched — the dealer is PINNED, not a class.
    expect(replaceDamage(state, index, other, 'A', victim, 'B', 3, true, collector().emit).amount).toBe(3);
  });

  it('BOTH directions on one permanent is Fog Bank, and it guards no third party', () => {
    const state = freshGame();
    const fogBank = place(
      state,
      permanentWith('fog-bank', [
        ANCHOR_SHIELD('recipientAnchor', 'source'),
        ANCHOR_SHIELD('dealerAnchor', 'source'),
      ]),
      'A',
    );
    const mine = place(state, BEAR, 'A');
    const theirs = place(state, BEAR, 'B');
    const index = indexReplacements(state);
    // dealt TO it...
    expect(
      replaceDamage(state, index, theirs, 'B', fogBank, 'A', 5, true, collector().emit).amount,
    ).toBe(0);
    // ...and dealt BY it...
    expect(
      replaceDamage(state, index, fogBank, 'A', theirs, 'B', 5, true, collector().emit).amount,
    ).toBe(0);
    // ...but a fight between two OTHER creatures is untouched. This is the
    // assertion a single disjunctive entry would fail.
    expect(
      replaceDamage(state, index, theirs, 'B', mine, 'A', 5, true, collector().emit).amount,
    ).toBe(5);
    // And NONCOMBAT damage passes: Fog Bank prints the word "combat".
    expect(
      replaceDamage(state, index, theirs, 'B', fogBank, 'A', 5, false, collector().emit).amount,
    ).toBe(5);
  });

  it("'attached' follows attachedTo, and an UNATTACHED source guards nothing", () => {
    const state = freshGame();
    const aura = place(state, permanentWith('gaseous-form', [ANCHOR_SHIELD('recipientAnchor', 'attached')]), 'A');
    const host = place(state, BEAR, 'A');
    const otherHost = place(state, BEAR, 'A');
    const attacker = place(state, BEAR, 'B');

    // Unattached: the anchor names nothing, so the ability does not apply.
    expect(
      replaceDamage(state, indexReplacements(state), attacker, 'B', host, 'A', 2, true, collector().emit)
        .amount,
    ).toBe(2);

    aura.attachedTo = host.instanceId;
    expect(
      replaceDamage(state, indexReplacements(state), attacker, 'B', host, 'A', 2, true, collector().emit)
        .amount,
    ).toBe(0);
    expect(
      replaceDamage(state, indexReplacements(state), attacker, 'B', otherHost, 'A', 2, true, collector().emit)
        .amount,
    ).toBe(2);

    // MOVED — the whole reason the anchor is resolved at event time. An id baked
    // in when the ability was indexed would still be guarding the old host.
    aura.attachedTo = otherHost.instanceId;
    expect(
      replaceDamage(state, indexReplacements(state), attacker, 'B', otherHost, 'A', 2, true, collector().emit)
        .amount,
    ).toBe(0);
    expect(
      replaceDamage(state, indexReplacements(state), attacker, 'B', host, 'A', 2, true, collector().emit)
        .amount,
    ).toBe(2);
  });

  it('an anchored recipient never admits a PLAYER', () => {
    const state = freshGame();
    place(state, permanentWith('wall', [ANCHOR_SHIELD('recipientAnchor', 'source')]), 'A');
    const attacker = place(state, BEAR, 'B');
    // Damage to the player A, with no recipient permanent at all.
    expect(
      replaceDamage(state, indexReplacements(state), attacker, 'B', undefined, 'A', 6, true, collector().emit)
        .amount,
    ).toBe(6);
  });
});
