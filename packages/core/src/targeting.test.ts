/**
 * TARGET LEGALITY — the engine must neither OFFER nor ACCEPT a target the printed
 * card cannot point at (targeting.ts).
 *
 * The bug these tests exist to keep dead: `dealDamage` took only `amount`, so a
 * printed target restriction had nowhere to live. Lava Spike ("deals 3 damage to
 * target *player or planeswalker*") could kill creatures, and Flame Slash ("deals
 * 4 damage to target *creature*", one mana, four damage) was an any-target burn
 * spell — both strictly better than printed, and a card that plays better than
 * printed silently corrupts every A/B verdict that includes it.
 *
 * Both directions are asserted, because they fail differently: a creature-only
 * spell aimed at a face and a player-only spell aimed at a creature.
 */

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, generateLegalActions } from './engine.js';
import type { GameAction } from './actions.js';
import type { CardDefinition } from './card.js';
import type { CardInstance, GameState, InstanceId, PlayerId } from './state.js';
import { creatureDef, deckOf, giveHand, landDef, spellDef } from './test-fixtures.js';
import {
  DEFAULT_TARGET_RESTRICTION,
  illegalTargetReason,
  isLegalTarget,
  isTargetRestriction,
  legalTargetsFor,
  targetRestrictionOf,
} from './targeting.js';

const SEED = 4242;

/** The two real cards this whole feature exists for, as engine data. */
const FLAME_SLASH = spellDef(
  'flame-slash',
  'sorcery',
  [{ primitive: 'dealDamage', params: { amount: 4, targets: 'creature' } }],
  { R: 1 },
);
const LAVA_SPIKE = spellDef(
  'lava-spike',
  'sorcery',
  [{ primitive: 'dealDamage', params: { amount: 3, targets: 'player' } }],
  { R: 1 },
);
/** The control: "any target", which is deliberately NOT policed. */
const LIGHTNING_BOLT = spellDef(
  'lightning-bolt',
  'instant',
  [{ primitive: 'dealDamage', params: { amount: 3 } }],
  { R: 1 },
);
const COUNTERSPELL = spellDef(
  'counterspell',
  'instant',
  [{ primitive: 'counterSpell', params: { targets: 'spell' } }],
  { U: 2 },
);

const BEAR = creatureDef('bear', 2, 2, { name: 'Bear' });

/** A game parked in A's precombat main with mana floating and a clean board. */
function mainPhase(): GameState {
  const { state } = createGame({
    seed: SEED,
    decks: { A: deckOf(landDef('Mountain', 'R'), 30), B: deckOf(landDef('Mountain', 'R'), 30) },
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const instance: CardInstance = {
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
  };
  state.battlefield.push(instance);
  return instance.instanceId;
}

/** The `castSpell` actions the engine offers for one card in hand. */
function castsOffered(state: GameState, instanceId: InstanceId): Array<Extract<GameAction, { kind: 'castSpell' }>> {
  return generateLegalActions(state).filter(
    (a): a is Extract<GameAction, { kind: 'castSpell' }> =>
      a.kind === 'castSpell' && a.instanceId === instanceId,
  );
}

function rejectionFor(state: GameState, action: GameAction): string | undefined {
  const result = applyAction(state, action);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  return rejected && 'reason' in rejected ? rejected.reason : undefined;
}

describe('targetRestrictionOf — the restriction is read off the card DATA', () => {
  it('reads the narrower-than-default restriction a printed card declares', () => {
    expect(targetRestrictionOf(FLAME_SLASH)).toBe('creature');
    expect(targetRestrictionOf(LAVA_SPIKE)).toBe('player');
    expect(targetRestrictionOf(COUNTERSPELL)).toBe('spell');
  });

  it('leaves an unrestricted card completely alone', () => {
    expect(targetRestrictionOf(LIGHTNING_BOLT)).toBeUndefined();
    expect(targetRestrictionOf(BEAR)).toBeUndefined();
  });

  it('treats an explicit "any" exactly like declaring nothing', () => {
    const explicitAny = spellDef('explicit-any', 'instant', [
      { primitive: 'dealDamage', params: { amount: 3, targets: DEFAULT_TARGET_RESTRICTION } },
    ]);
    expect(targetRestrictionOf(explicitAny)).toBeUndefined();
  });

  it('takes the NARROWEST restriction across a multi-effect spell', () => {
    // "deals 3 damage to target creature and you gain 3 life" is two effect refs
    // but ONE chosen target, so the strictest clause wins.
    const helix = spellDef('helix', 'instant', [
      { primitive: 'dealDamage', params: { amount: 3, targets: 'creature' } },
      { primitive: 'gainLife', params: { amount: 3, targets: 'any' } },
    ]);
    expect(targetRestrictionOf(helix)).toBe('creature');
  });

  it('ignores a junk restriction value rather than trusting it', () => {
    // 'planeswalker' was this test's junk example until it became a REAL
    // restriction (Casualties of War's mode) — the junk word has to be one no
    // future card could plausibly promote.
    const junk = spellDef('junk', 'instant', [
      { primitive: 'dealDamage', params: { amount: 3, targets: 'telepathicOctopus' } },
    ]);
    expect(isTargetRestriction('telepathicOctopus')).toBe(false);
    expect(targetRestrictionOf(junk)).toBeUndefined();
  });
});

describe('the engine does not OFFER an illegal target', () => {
  it('offers Flame Slash at every creature and at NO player', () => {
    const state = mainPhase();
    const [card] = giveHand(state, 'A', [FLAME_SLASH]);
    const mine = place(state, BEAR, 'A');
    const theirs = place(state, BEAR, 'B');

    const offered = castsOffered(state, card!.instanceId);
    const targets = offered.flatMap((a) => [...(a.targets ?? [])]);
    // Both creatures — a creature-only spell may legally hit your OWN board.
    expect(new Set(targets)).toEqual(new Set([mine, theirs]));
    expect(targets).not.toContain('A');
    expect(targets).not.toContain('B');
  });

  it('offers Lava Spike at both players and at NO creature', () => {
    const state = mainPhase();
    const [card] = giveHand(state, 'A', [LAVA_SPIKE]);
    const theirs = place(state, BEAR, 'B');

    const targets = castsOffered(state, card!.instanceId).flatMap((a) => [...(a.targets ?? [])]);
    expect(new Set(targets)).toEqual(new Set<InstanceId | PlayerId>(['A', 'B']));
    expect(targets).not.toContain(theirs);
  });

  it('does not offer a restricted spell at all when the board has no legal target', () => {
    const state = mainPhase();
    const [card] = giveHand(state, 'A', [FLAME_SLASH]);
    // No creatures anywhere: a spell with no legal target cannot be cast.
    expect(castsOffered(state, card!.instanceId)).toHaveLength(0);
  });

  it('still offers an unrestricted spell as one bare cast (nothing changed for it)', () => {
    const state = mainPhase();
    const [card] = giveHand(state, 'A', [LIGHTNING_BOLT]);
    place(state, BEAR, 'B');

    const offered = castsOffered(state, card!.instanceId);
    expect(offered).toHaveLength(1);
    expect(offered[0]!.targets).toBeUndefined();
  });

  it('only offers a counterspell while there is a spell on the stack', () => {
    const state = mainPhase();
    const [counter] = giveHand(state, 'A', [COUNTERSPELL]);
    expect(castsOffered(state, counter!.instanceId)).toHaveLength(0);

    // Put an opposing spell on the stack; now it has exactly one legal target.
    const [victim] = giveHand(state, 'B', [LIGHTNING_BOLT]);
    state.stack.push({
      kind: 'spell',
      instanceId: victim!.instanceId,
      card: victim!,
      controller: 'B',
      resolvesTo: 'graveyard',
      targets: [],
    });
    const offered = castsOffered(state, counter!.instanceId);
    expect(offered).toHaveLength(1);
    expect(offered[0]!.targets).toEqual([victim!.instanceId]);
  });
});

describe('the engine REJECTS an illegal target submitted directly', () => {
  it('rejects a creature-only spell aimed at a player', () => {
    const state = mainPhase();
    const [card] = giveHand(state, 'A', [FLAME_SLASH]);
    place(state, BEAR, 'B');

    const reason = rejectionFor(state, {
      kind: 'castSpell',
      player: 'A',
      instanceId: card!.instanceId,
      targets: ['B'],
    });
    expect(reason).toContain('can only target a creature');
  });

  it('rejects a player-only spell aimed at a creature', () => {
    const state = mainPhase();
    const [card] = giveHand(state, 'A', [LAVA_SPIKE]);
    const bear = place(state, BEAR, 'B');

    const reason = rejectionFor(state, {
      kind: 'castSpell',
      player: 'A',
      instanceId: card!.instanceId,
      targets: [bear],
    });
    expect(reason).toContain('can only target a player');
  });

  it('rejects a restricted spell cast with NO target', () => {
    const state = mainPhase();
    const [card] = giveHand(state, 'A', [FLAME_SLASH]);
    place(state, BEAR, 'B');

    const reason = rejectionFor(state, {
      kind: 'castSpell',
      player: 'A',
      instanceId: card!.instanceId,
      targets: [],
    });
    expect(reason).toContain('targets exactly one');
  });

  it('rejects a creature target that is not on the battlefield', () => {
    const state = mainPhase();
    const [card] = giveHand(state, 'A', [FLAME_SLASH]);
    place(state, BEAR, 'B');
    const ghost = 9_999;

    expect(
      rejectionFor(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, targets: [ghost] }),
    ).toContain('can only target a creature');
  });

  it('rejects a "creature" target that is really a land', () => {
    const state = mainPhase();
    const [card] = giveHand(state, 'A', [FLAME_SLASH]);
    place(state, BEAR, 'B');
    const land = place(state, landDef('Mountain', 'R'), 'B');

    expect(
      rejectionFor(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, targets: [land] }),
    ).toContain('can only target a creature');
  });

  it('leaves the state untouched when it rejects (no mana spent, card still in hand)', () => {
    const state = mainPhase();
    const [card] = giveHand(state, 'A', [FLAME_SLASH]);
    place(state, BEAR, 'B');
    const manaBefore = state.players.A.manaPool.R;

    const result = applyAction(state, {
      kind: 'castSpell',
      player: 'A',
      instanceId: card!.instanceId,
      targets: ['B'],
    });

    expect(result.state.players.A.manaPool.R).toBe(manaBefore);
    expect(result.state.players.A.hand.map((c) => c.instanceId)).toContain(card!.instanceId);
    expect(result.state.stack).toHaveLength(0);
  });

  it('accepts the legal target for each of them', () => {
    const state = mainPhase();
    const [slash, spike] = giveHand(state, 'A', [FLAME_SLASH, LAVA_SPIKE]);
    const bear = place(state, BEAR, 'B');

    expect(
      rejectionFor(state, { kind: 'castSpell', player: 'A', instanceId: slash!.instanceId, targets: [bear] }),
    ).toBeUndefined();
    expect(
      rejectionFor(state, { kind: 'castSpell', player: 'A', instanceId: spike!.instanceId, targets: ['B'] }),
    ).toBeUndefined();
  });
});

describe('the legality helpers themselves', () => {
  it('classifies each restriction against a real board', () => {
    const state = mainPhase();
    const bear = place(state, BEAR, 'B');
    const land = place(state, landDef('Mountain', 'R'), 'B');

    expect(isLegalTarget(state, 'creature', bear)).toBe(true);
    expect(isLegalTarget(state, 'creature', land)).toBe(false);
    expect(isLegalTarget(state, 'creature', 'B')).toBe(false);
    expect(isLegalTarget(state, 'player', 'B')).toBe(true);
    expect(isLegalTarget(state, 'player', bear)).toBe(false);
    expect(isLegalTarget(state, 'any', bear)).toBe(true);
    expect(isLegalTarget(state, 'any', 'A')).toBe(true);
    expect(isLegalTarget(state, 'any', land)).toBe(false);
  });

  it('enumerates exactly the targets it would accept', () => {
    const state = mainPhase();
    place(state, BEAR, 'A');
    place(state, BEAR, 'B');
    place(state, landDef('Mountain', 'R'), 'B');

    for (const restriction of ['any', 'creature', 'player'] as const) {
      const offered = legalTargetsFor(state, restriction);
      expect(offered.length).toBeGreaterThan(0);
      for (const target of offered) expect(isLegalTarget(state, restriction, target)).toBe(true);
    }
    expect(legalTargetsFor(state, 'creature')).toHaveLength(2);
    expect(legalTargetsFor(state, 'player')).toEqual(['A', 'B']);
  });

  it('says nothing about an unrestricted card', () => {
    const state = mainPhase();
    expect(illegalTargetReason(state, LIGHTNING_BOLT, [])).toBeUndefined();
    expect(illegalTargetReason(state, LIGHTNING_BOLT, ['A', 'B'])).toBeUndefined();
  });
});

describe('artifact and opponent restrictions', () => {
  const SOL_RING: CardDefinition = { id: 'sol', name: 'Sol Ring', types: ['artifact'] };

  it('an artifact target is legal for "artifact" and a creature is not', () => {
    const state = mainPhase();
    const artifact = place(state, SOL_RING, 'A');
    const creature = place(state, BEAR, 'A');

    expect(isLegalTarget(state, 'artifact', artifact)).toBe(true);
    expect(isLegalTarget(state, 'artifact', creature)).toBe(false);
    // An artifact is not a legal "creature" target either — the filters are real.
    expect(isLegalTarget(state, 'creature', artifact)).toBe(false);
  });

  it('"opponent" excludes the caster and accepts the other seat', () => {
    const state = mainPhase();
    expect(isLegalTarget(state, 'opponent', 'B', 'A')).toBe(true);
    expect(isLegalTarget(state, 'opponent', 'A', 'A')).toBe(false);
  });

  it('treats an opponent-target as ILLEGAL when the caster is unknown', () => {
    // Being unable to cast is a safe failure; letting the spell point at its own
    // caster would make it strictly more permissive than printed.
    const state = mainPhase();
    expect(isLegalTarget(state, 'opponent', 'A')).toBe(false);
    expect(isLegalTarget(state, 'opponent', 'B')).toBe(false);
  });

  it('offers only the opponent in the legal-target menu', () => {
    const state = mainPhase();
    expect(legalTargetsFor(state, 'opponent', 'A')).toEqual(['B']);
    expect(legalTargetsFor(state, 'opponent')).toEqual([]);
  });

  it('offers only artifacts for an artifact-restricted effect', () => {
    const state = mainPhase();
    const artifact = place(state, SOL_RING, 'B');
    place(state, BEAR, 'B');
    expect(legalTargetsFor(state, 'artifact')).toEqual([artifact]);
  });
});
