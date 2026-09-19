/**
 * THREE TARGET ROWS FOR THUNE'S LIFE (DESIGN §3.162) — the printed words behind
 * Skyclave Apparition and Heliod, Sun-Crowned, each pinned in BOTH directions:
 *
 *  - `nonlandPermanentAnOpponentControls` — "target nonland permanent you
 *    don't control" (Skyclave) and "… an opponent controls" (Deputy of
 *    Detention): never a land, never the actor's own board, never anything
 *    when the actor is unknown;
 *  - `creatureOrEnchantmentYouControl` — Heliod's lifegain aim: your creature
 *    or your enchantment, never the opponent's, never your land;
 *  - the `nontoken` BOUND — read off the CR 111.1 stamp, composable with the
 *    numeric bounds the way the printed card composes them ("nonland, nontoken
 *    permanent you don't control with mana value 4 or less").
 *
 * The §3.49 completeness invariant already proves offer and legality agree for
 * every member on a zoo board; this file is the SEMANTIC pin — that each word
 * selects what it prints and refuses what it does not.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameState, InstanceId, PlayerId } from './index.js';
import { createGame } from './index.js';
import { describeBound, describeRestriction, isLegalTarget, legalTargetsFor, type TargetSpec } from './targeting.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const FOREST = landDef('Forest', 'G');
const BEAR = creatureDef('bear', 2, 2, { cost: { generic: 1, G: 1 } });
const ANGEL = creatureDef('angel', 4, 4, { cost: { generic: 3, W: 2 } });
const TOKEN_BEAR: CardDefinition = { ...creatureDef('token-bear', 2, 2), isToken: true } as CardDefinition;
const SHRINE: CardDefinition = { id: 'shrine', name: 'Shrine', types: ['enchantment'], cost: { generic: 1, W: 1 } };
const ROCK: CardDefinition = { id: 'rock', name: 'Rock', types: ['artifact'], cost: { generic: 2 } };

function board(): GameState {
  const { state } = createGame({ seed: 5, decks: { A: deckOf(FOREST, 40), B: deckOf(FOREST, 40) } });
  state.battlefield = [];
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

/** The offered set and the accepted set, which must agree — returned once for both assertions. */
function selected(state: GameState, spec: TargetSpec, actor: PlayerId | undefined): Set<InstanceId | PlayerId> {
  const offered = new Set(legalTargetsFor(state, spec, actor));
  for (const permanent of state.battlefield) {
    const legal = isLegalTarget(state, spec, permanent.instanceId, actor);
    expect(legal, `offer and legality agree on ${permanent.def.name}`).toBe(offered.has(permanent.instanceId));
  }
  return offered;
}

describe("'nonlandPermanentAnOpponentControls' — \"target nonland permanent you don't control\"", () => {
  it('selects the other seat’s nonland permanents and nothing else', () => {
    const s = board();
    const theirBear = place(s, BEAR, 'B');
    const theirShrine = place(s, SHRINE, 'B');
    const theirRock = place(s, ROCK, 'B');
    const theirLand = place(s, FOREST, 'B');
    const myBear = place(s, BEAR, 'A');
    const got = selected(s, 'nonlandPermanentAnOpponentControls', 'A');
    expect(got).toEqual(new Set([theirBear, theirShrine, theirRock]));
    expect(got.has(theirLand), 'nonland').toBe(false);
    expect(got.has(myBear), "you don't control").toBe(false);
    // The mirror: asked as B, it is A's board.
    expect(selected(s, 'nonlandPermanentAnOpponentControls', 'B')).toEqual(new Set([myBear]));
  });

  it('with no actor it selects nothing — never "probably theirs"', () => {
    const s = board();
    place(s, BEAR, 'B');
    expect(selected(s, 'nonlandPermanentAnOpponentControls', undefined).size).toBe(0);
  });

  it('has a distinct English name', () => {
    expect(describeRestriction('nonlandPermanentAnOpponentControls')).toBe('a nonland permanent an opponent controls');
  });
});

describe("'creatureOrEnchantmentYouControl' — Heliod's lifegain aim", () => {
  it('selects your creatures and your enchantments, never theirs and never your lands', () => {
    const s = board();
    const myBear = place(s, BEAR, 'A');
    const myShrine = place(s, SHRINE, 'A');
    const myRock = place(s, ROCK, 'A');
    const myLand = place(s, FOREST, 'A');
    const theirBear = place(s, BEAR, 'B');
    const theirShrine = place(s, SHRINE, 'B');
    const got = selected(s, 'creatureOrEnchantmentYouControl', 'A');
    expect(got).toEqual(new Set([myBear, myShrine]));
    for (const [id, why] of [
      [myRock, 'an artifact is neither'],
      [myLand, 'a land is neither'],
      [theirBear, "the opponent's creature"],
      [theirShrine, "the opponent's enchantment"],
    ] as const) {
      expect(got.has(id), why).toBe(false);
    }
    expect(selected(s, 'creatureOrEnchantmentYouControl', undefined).size, 'no actor, nothing').toBe(0);
  });
});

describe('the nontoken bound', () => {
  it('refuses a token and accepts the printed card, composed with a mana-value bound', () => {
    const s = board();
    const bear = place(s, BEAR, 'B');
    const token = place(s, TOKEN_BEAR, 'B');
    const angel = place(s, ANGEL, 'B');
    const skyclaveAim: TargetSpec = {
      base: 'nonlandPermanentAnOpponentControls',
      bound: { nontoken: true, atMost: { property: 'manaValue', value: 4 } },
    };
    const got = selected(s, skyclaveAim, 'A');
    expect(got).toEqual(new Set([bear]));
    expect(got.has(token), 'a token is not a nontoken permanent').toBe(false);
    expect(got.has(angel), 'mana value 5 is over the bound').toBe(false);
    // The bound alone, on the plain creature noun (Kaya's "target nontoken creature").
    expect(selected(s, { base: 'creature', bound: { nontoken: true } }, 'A')).toEqual(new Set([bear, angel]));
  });

  it('describes itself', () => {
    expect(describeBound({ nontoken: true })).toBe('that is not a token');
    expect(describeBound({ nontoken: true, atMost: { property: 'manaValue', value: 4 } })).toBe(
      'with manaValue 4 or less and that is not a token',
    );
  });
});
