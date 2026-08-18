/**
 * FLASHBACK — casting from a NON-HAND zone (CR 702.34): a card with a flashback
 * cost may be cast from its owner's graveyard for that cost, and is then EXILED
 * any time it would leave the stack — resolved or countered — never returned to
 * the graveyard.
 *
 * The properties pinned here, ordered by how silently each would break:
 *  1. **The source zone is explicit, cast → stack → resolution.** The stack
 *     object carries `castFrom`, `applyAction`'s per-boundary clone preserves it
 *     (the field-by-field `cloneStackObject` trap), and the destination on
 *     leaving the stack is derived from it in ONE place
 *     (`spellLeaveDestination`) — so "exile instead of graveyard" cannot be a
 *     special case that one exit path forgets.
 *  2. **The flashback cost is paid, not the printed one.**
 *  3. **Timing is the card's own** — a sorcery flashes back only at sorcery
 *     speed; an instant flashes back whenever its owner holds priority.
 *  4. **A card that left the graveyard cannot be flashed back** — the cast is
 *     validated against the live zone, so a response that removes the card
 *     cleanly rejects the cast instead of teleporting it out of exile.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  createGame,
  DEFAULT_RULES,
  dumpState,
  generateLegalActions,
  spellLeaveDestination,
  type CardDefinition,
  type GameAction,
  type GameState,
  type SpellStackObject,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, giveGraveyard, giveHand, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** The printed vs flashback costs, deliberately DIFFERENT so a test that sees
 * the wrong pool remainder knows exactly which cost was charged. */
const PRINTED_COST = { generic: 1, U: 1 } as const;
const FLASHBACK_COST = { generic: 2, U: 1 } as const;

/** A Think-Twice-shaped sorcery: printed {1}{U}, flashback {2}{U}. */
const FLASHBACK_SORCERY: CardDefinition = {
  id: 'fb-sorcery',
  name: 'Deep Thought',
  types: ['sorcery'],
  cost: PRINTED_COST,
  flashback: FLASHBACK_COST,
  effects: [{ primitive: 'noteResolved' }],
};

/** The same card at instant speed, for the timing half. */
const FLASHBACK_INSTANT: CardDefinition = {
  ...FLASHBACK_SORCERY,
  id: 'fb-instant',
  name: 'Quick Thought',
  types: ['instant'],
  timing: 'instant',
};

/** An ordinary sorcery with NO flashback — the "has no flashback" rejection. */
const PLAIN_SORCERY: CardDefinition = {
  id: 'plain-sorcery',
  name: 'Plain Thought',
  types: ['sorcery'],
  cost: PRINTED_COST,
  effects: [{ primitive: 'noteResolved' }],
};

const SEED = 0xf1a5;

/** A registry whose one primitive counts its resolutions, so a test can prove
 * a flashback cast RESOLVES its script rather than merely changing zones. */
function makeRegistry(): { reg: EffectRegistry; resolved: () => number } {
  const reg = createEffectRegistry();
  let count = 0;
  reg.register('noteResolved', () => {
    count += 1;
  });
  return { reg, resolved: () => count };
}

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

/** Apply an action EXPECTING rejection; returns the reason. */
function rejection(state: GameState, action: GameAction, reg: EffectRegistry): string {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  expect(rejected, 'expected the action to be rejected').toBeDefined();
  return (rejected as { reason: string }).reason;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** Both players pass; the top of the stack resolves. */
function resolveTop(state: GameState, reg: EffectRegistry): GameState {
  return pass(pass(state, reg), reg);
}

/** A's precombat main, empty hands, pool set by the caller. */
function gameAtMain(reg: EffectRegistry): GameState {
  const created = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

/** Give `player` a floating pool that covers the flashback cost exactly. */
function fundFlashback(state: GameState, player: 'A' | 'B'): void {
  state.players[player].manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 2 };
}

const flashbackCastOf = (state: GameState, player: 'A' | 'B', instanceId: number): GameAction => ({
  kind: 'castSpell',
  player,
  instanceId,
  fromZone: 'graveyard',
});

describe('flashback — legal-action generation', () => {
  it('offers a flashback cast from the graveyard once the pool covers the FLASHBACK cost', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveGraveyard(state, 'A', [FLASHBACK_SORCERY]);

    // Pool empty: not offered.
    const before = generateLegalActions(state, DEFAULT_RULES);
    expect(before.some((a) => a.kind === 'castSpell' && a.fromZone === 'graveyard')).toBe(false);

    // Pool covers the PRINTED cost but not the flashback cost: still not offered.
    state.players.A.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 1 };
    const printedOnly = generateLegalActions(state, DEFAULT_RULES);
    expect(printedOnly.some((a) => a.kind === 'castSpell' && a.fromZone === 'graveyard')).toBe(false);

    fundFlashback(state, 'A');
    const offers = generateLegalActions(state, DEFAULT_RULES).filter(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell',
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]!.fromZone).toBe('graveyard');
    expect(offers[0]!.instanceId).toBe(card!.instanceId);
  });

  it('does not offer a card with no flashback, and honors sorcery timing', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    giveGraveyard(state, 'A', [PLAIN_SORCERY]);
    fundFlashback(state, 'A');
    expect(
      generateLegalActions(state, DEFAULT_RULES).some((a) => a.kind === 'castSpell'),
    ).toBe(false);

    // B (non-active) holds a flashback SORCERY and a flashback INSTANT: with
    // priority in A's main, only the instant may flash back.
    const [, instant] = giveGraveyard(state, 'B', [FLASHBACK_SORCERY, FLASHBACK_INSTANT]);
    fundFlashback(state, 'B');
    const afterPass = pass(state, reg); // A passes; B holds priority mid-main
    expect(afterPass.priorityPlayer).toBe('B');
    const offers = afterPass && generateLegalActions(afterPass, DEFAULT_RULES).filter(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell',
    );
    expect(offers.map((a) => a.instanceId)).toEqual([instant!.instanceId]);
    expect(offers[0]!.fromZone).toBe('graveyard');
  });
});

describe('flashback — the cast', () => {
  it('pays the flashback cost, runs the script, and EXILES the card on resolution', () => {
    const { reg, resolved } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveGraveyard(state, 'A', [FLASHBACK_SORCERY]);
    fundFlashback(state, 'A');

    state = act(state, flashbackCastOf(state, 'A', card!.instanceId), reg);
    // The whole flashback pool was spent — the PRINTED cost would have left {C} floating.
    expect(Object.values(state.players.A.manaPool).every((n) => n === 0)).toBe(true);
    expect(state.players.A.graveyard).toHaveLength(0);
    const spell = state.stack[0] as SpellStackObject;
    expect(spell.castFrom).toBe('graveyard');
    expect(spell.resolvesTo).toBe('exile');
    expect(spellLeaveDestination(spell)).toBe('exile');

    state = resolveTop(state, reg);
    expect(resolved()).toBe(1); // the script genuinely ran
    expect(state.players.A.exile.map((c) => c.instanceId)).toEqual([card!.instanceId]);
    expect(state.players.A.graveyard).toHaveLength(0); // exiled, NOT back to the yard
  });

  it('an ordinary from-hand cast of the SAME card still goes to the graveyard', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [FLASHBACK_SORCERY]);
    state.players.A.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 1 };

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    const spell = state.stack[0] as SpellStackObject;
    expect(spell.castFrom).toBeUndefined();
    expect(spellLeaveDestination(spell)).toBe('graveyard');

    state = resolveTop(state, reg);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toEqual([card!.instanceId]);
    expect(state.players.A.exile).toHaveLength(0);
  });

  it('the castFrom marker survives the per-action state clone', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveGraveyard(state, 'A', [FLASHBACK_SORCERY]);
    fundFlashback(state, 'A');
    state = act(state, flashbackCastOf(state, 'A', card!.instanceId), reg);

    // The explicit clone (what every action boundary does) must not drop the
    // field — dropping it would resolve the spell into the graveyard.
    const cloned = cloneState(state);
    const spell = cloned.stack[0] as SpellStackObject;
    expect(spell.castFrom).toBe('graveyard');
    expect(spellLeaveDestination(spell)).toBe('exile');
  });
});

describe('flashback — rejections (each leaves the state unchanged)', () => {
  it('rejects a flashback cast of a card that is no longer in the graveyard', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveGraveyard(state, 'A', [FLASHBACK_SORCERY]);
    fundFlashback(state, 'A');

    // The card leaves the graveyard "in response" (here: moved by hand, as a
    // graveyard-hate effect would) — the cast must fail against the live zone.
    const removed = state.players.A.graveyard.pop()!;
    removed.zone = 'exile';
    state.players.A.exile.push(removed);
    expect(rejection(state, flashbackCastOf(state, 'A', card!.instanceId), reg)).toMatch(
      /not in your graveyard/,
    );
    // And it cannot be cast twice: a resolved flashback cast leaves nothing to recast.
    expect(state.players.A.exile).toHaveLength(1);
  });

  it('rejects flashing back a card with no flashback cost', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveGraveyard(state, 'A', [PLAIN_SORCERY]);
    fundFlashback(state, 'A');
    expect(rejection(state, flashbackCastOf(state, 'A', card!.instanceId), reg)).toMatch(
      /no flashback/,
    );
  });

  it('rejects a sorcery flashback at instant speed and an unfunded one at any speed', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [sorcery] = giveGraveyard(state, 'B', [FLASHBACK_SORCERY]);
    fundFlashback(state, 'B');
    const afterPass = pass(state, reg); // B holds priority in A's main
    expect(rejection(afterPass, flashbackCastOf(afterPass, 'B', sorcery!.instanceId), reg)).toMatch(
      /sorcery speed/,
    );

    const [mine] = giveGraveyard(state, 'A', [FLASHBACK_SORCERY]);
    state.players.A.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 1 }; // printed, not flashback
    expect(rejection(state, flashbackCastOf(state, 'A', mine!.instanceId), reg)).toMatch(
      /insufficient mana/,
    );
  });
});
