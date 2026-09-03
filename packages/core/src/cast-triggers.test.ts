/**
 * CAST TRIGGERS AND THE LIBRARY-PILE WINDOWS (DESIGN §3.113) — the core seams
 * behind storm, cascade and ripple, driven through the real engine:
 *
 *  - a cast trigger is pushed above its spell the moment the spell is cast,
 *    carrying storm's count (CR 702.40a "each other spell cast before it") as
 *    `triggeringAmount` — read at the push, so a response is not counted;
 *  - the count is a turn fact: it clears as the next turn begins;
 *  - cascade exiles to the first cheaper nonland card, opens a FREE window on
 *    it, and bottoms the rest whether the window is cast or declined;
 *  - a cascade that finds nothing bottoms its pile and opens no window;
 *  - ripple re-opens on every same-name card of the pile, then bottoms the rest
 *    in revealed order;
 *  - every one of those states survives the per-action clone, because each
 *    step here is a separate `applyAction`.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameState } from './state.js';
import { makeSpellCopy } from './spell-copy.js';
import { performCascade, performRipple, spellOnStackById, stackManaValueOf } from './cascade.js';
import { spellsCastThisTurn } from './turn-facts.js';
import { creatureDef, giveHand, giveLibrary, landDef, spellDef } from './test-fixtures.js';
import { act, advanceTo, advanceToTurn, newGame, pass, registryWith } from './conformance/harness.js';

const MOUNTAIN = landDef('Mountain', 'R');

/** A blank one-mana sorcery — the "other spells cast before it" a storm counts. */
const BLANK = spellDef('Blank', 'sorcery', [], { generic: 1 });
/** A three-mana sorcery with storm, whose body records the count it saw. */
const STORM_SPELL: CardDefinition = {
  ...spellDef('Storm Spell', 'sorcery', [{ primitive: 'noteResolved' }], { generic: 3 }),
  castTriggers: [{ keyword: 'storm', label: 'Storm', effects: [{ primitive: 'stormCopies' }] }],
};
/** A four-mana creature with cascade. */
const CASCADER: CardDefinition = {
  ...creatureDef('Cascader', 3, 2, { cost: { generic: 4 } }),
  castTriggers: [{ keyword: 'cascade', label: 'Cascade', effects: [{ primitive: 'cascade' }] }],
};
const BIG = creatureDef('Big', 5, 5, { cost: { generic: 5 } });
const CHEAP = creatureDef('Cheap', 2, 2, { cost: { generic: 2 } });
/** A two-mana ripple-4 sorcery. */
const RIPPLER: CardDefinition = {
  ...spellDef('Rippler', 'sorcery', [{ primitive: 'noteResolved' }], { generic: 2 }),
  castTriggers: [{ keyword: 'ripple', label: 'Ripple 4', effects: [{ primitive: 'ripple', params: { count: 4 } }] }],
};

const seenCounts: number[] = [];
const resolved: string[] = [];
const registry = registryWith({
  noteResolved: (ctx) => {
    resolved.push(ctx.source.def.name);
  },
  stormCopies: (ctx) => {
    seenCounts.push(ctx.triggeringAmount ?? -1);
    const original = spellOnStackById(ctx.state, ctx.source.instanceId);
    if (!original) return;
    for (let i = 0; i < (ctx.triggeringAmount ?? 0); i++) ctx.state.stack.push(makeSpellCopy(ctx.state, original, ctx.controller));
  },
  cascade: (ctx) => {
    const spell = spellOnStackById(ctx.state, ctx.source.instanceId)!;
    performCascade(ctx.state, ctx.controller, stackManaValueOf(spell), ctx.emit);
  },
  ripple: (ctx) => {
    performRipple(ctx.state, ctx.controller, ctx.source.def.name, 4, ctx.emit);
  },
});

function atMain(): GameState {
  const state = advanceTo(newGame({ registry }), 'precombatMain', registry);
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 20 };
  return state;
}

/** Pass until the stack is empty (both players passing resolves the top object). */
function resolveStack(state: GameState): GameState {
  let s = state;
  for (let guard = 0; guard < 40 && s.stack.length > 0 && !s.madnessWindow; guard++) s = pass(s, registry);
  return s;
}

describe('cast triggers — storm’s count (CR 702.40a)', () => {
  it('is pushed above the spell as it is cast, carrying the number of spells cast BEFORE it this turn', () => {
    seenCounts.length = 0;
    resolved.length = 0;
    const state = atMain();
    const [blank1, blank2, storm] = giveHand(state, 'A', [BLANK, BLANK, STORM_SPELL]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: blank1!.instanceId }, registry);
    s = resolveStack(s);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: blank2!.instanceId }, registry);
    s = resolveStack(s);
    expect(spellsCastThisTurn(s)).toBe(2);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: storm!.instanceId }, registry);
    // The trigger sits ABOVE the spell, labelled, with the count already fixed.
    const top = s.stack[s.stack.length - 1]!;
    expect(top.kind).toBe('trigger');
    expect(top.kind === 'trigger' && top.label).toBe('Storm');
    expect(top.kind === 'trigger' && top.triggeringAmount).toBe(2);
    s = resolveStack(s);
    expect(seenCounts).toEqual([2]);
    // Two copies plus the original resolved: three bodies ran.
    expect(resolved).toEqual(['Storm Spell', 'Storm Spell', 'Storm Spell']);
    // Copies are not cast: the count grew by the one real cast only.
    expect(spellsCastThisTurn(s)).toBe(3);
  });

  it('clears as the next turn begins, like every other turn fact', () => {
    const state = atMain();
    const [blank] = giveHand(state, 'A', [BLANK]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: blank!.instanceId }, registry);
    s = resolveStack(s);
    expect(spellsCastThisTurn(s)).toBe(1);
    s = advanceToTurn(s, 2, 'upkeep', registry);
    expect(spellsCastThisTurn(s)).toBe(0);
  });
});

describe('cascade — the library-pile window (CR 702.85a)', () => {
  it('exiles down to the first cheaper nonland card, opens a free window on it, and bottoms the rest at random after the cast', () => {
    const state = atMain();
    const [cascader] = giveHand(state, 'A', [CASCADER]);
    const [mountain, big, cheap, ...rest] = giveLibrary(state, 'A', [MOUNTAIN, BIG, CHEAP, MOUNTAIN, MOUNTAIN, MOUNTAIN]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: cascader!.instanceId }, registry);
    s = resolveStack(s);
    const window = s.madnessWindow;
    expect(window?.kind).toBe('cascade');
    expect(window?.instanceId).toBe(cheap!.instanceId);
    expect(window?.pile).toEqual([mountain!.instanceId, big!.instanceId, cheap!.instanceId]);
    expect(s.players.A.exile.map((c) => c.instanceId)).toEqual([mountain!.instanceId, big!.instanceId, cheap!.instanceId]);
    // The cascading spell is still on the stack beneath.
    expect(s.stack.map((o) => o.instanceId)).toEqual([cascader!.instanceId]);
    // Free: an empty pool casts it.
    s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: cheap!.instanceId, fromZone: 'exile' }, registry);
    expect(s.madnessWindow).toBeNull();
    expect(s.players.A.exile).toEqual([]);
    // The two uncast cards are the library's bottom two — in some order.
    const library = s.players.A.library;
    expect(library.length).toBe(rest.length + 2);
    expect(new Set(library.slice(-2).map((c) => c.instanceId))).toEqual(new Set([mountain!.instanceId, big!.instanceId]));
    expect(library.slice(0, rest.length).map((c) => c.instanceId)).toEqual(rest.map((c) => c.instanceId));
    // Both spells resolve, cheapest first.
    s = resolveStack(s);
    expect(s.battlefield.map((c) => c.def.name)).toEqual(['Cheap', 'Cascader']);
  });

  it('declining bottoms the whole pile, the offered card included', () => {
    const state = atMain();
    const [cascader] = giveHand(state, 'A', [CASCADER]);
    const [mountain, cheap, ...rest] = giveLibrary(state, 'A', [MOUNTAIN, CHEAP, MOUNTAIN, MOUNTAIN]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: cascader!.instanceId }, registry);
    s = resolveStack(s);
    expect(s.madnessWindow?.kind).toBe('cascade');
    s = act(s, { kind: 'passPriority', player: 'A' }, registry);
    expect(s.madnessWindow).toBeNull();
    expect(s.players.A.exile).toEqual([]);
    expect(s.players.A.library.length).toBe(rest.length + 2);
    expect(new Set(s.players.A.library.slice(-2).map((c) => c.instanceId))).toEqual(
      new Set([mountain!.instanceId, cheap!.instanceId]),
    );
    s = resolveStack(s);
    expect(s.battlefield.map((c) => c.def.name)).toEqual(['Cascader']);
  });

  it('a library with nothing cheaper opens no window: every card is bottomed', () => {
    const state = atMain();
    const [cascader] = giveHand(state, 'A', [CASCADER]);
    giveLibrary(state, 'A', [MOUNTAIN, BIG, MOUNTAIN]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: cascader!.instanceId }, registry);
    s = resolveStack(s);
    expect(s.madnessWindow ?? null).toBeNull();
    expect(s.players.A.exile).toEqual([]);
    expect(s.players.A.library.length).toBe(3);
    expect(s.battlefield.map((c) => c.def.name)).toEqual(['Cascader']);
  });
});

describe('ripple — a chain of same-name windows (CR 702.60a)', () => {
  it('re-opens on each same-name card, casts each for nothing, then bottoms the rest in revealed order', () => {
    resolved.length = 0;
    const state = atMain();
    const [first] = giveHand(state, 'A', [RIPPLER]);
    const [second, m1, third, m2, ...rest] = giveLibrary(state, 'A', [
      RIPPLER,
      MOUNTAIN,
      RIPPLER,
      MOUNTAIN,
      MOUNTAIN,
      MOUNTAIN,
      MOUNTAIN,
      MOUNTAIN,
    ]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: first!.instanceId }, registry);
    s = resolveStack(s);
    expect(s.madnessWindow?.kind).toBe('ripple');
    expect(s.madnessWindow?.instanceId).toBe(second!.instanceId);
    s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: second!.instanceId, fromZone: 'exile' }, registry);
    // Re-opened on the third; the second's own ripple trigger waits on the stack.
    expect(s.madnessWindow?.kind).toBe('ripple');
    expect(s.madnessWindow?.instanceId).toBe(third!.instanceId);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: third!.instanceId, fromZone: 'exile' }, registry);
    expect(s.madnessWindow).toBeNull();
    // The two Mountains went to the bottom in revealed order.
    const library = s.players.A.library;
    expect(library.slice(-2).map((c) => c.instanceId)).toEqual([m1!.instanceId, m2!.instanceId]);
    expect(library.slice(0, rest.length).map((c) => c.instanceId)).toEqual(rest.map((c) => c.instanceId));
    // Three spells on the stack, two ripple triggers above them; the later
    // reveals find no fourth copy, so no window re-opens and all resolve.
    s = resolveStack(s);
    expect(s.madnessWindow ?? null).toBeNull();
    expect(resolved).toEqual(['Rippler', 'Rippler', 'Rippler']);
  });
});
