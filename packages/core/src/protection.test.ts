/**
 * Protection from [quality] — the four printed halves, each asserted against the
 * seam that enforces it, plus the failure modes that make the checks honest:
 * a colorless source is NOT blocked by protection from a color, an unknown
 * source IS (the conservative direction), and a protection granted through the
 * continuous layer behaves exactly like a printed one while it lasts.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, ProtectionQuality } from './card.js';
import { unionProtection } from './card.js';
import type { CardInstance, GameState, PlayerId } from './state.js';
import { createGame, generateLegalActions } from './engine.js';
import { isLegalTarget, legalTargetsFor } from './targeting.js';
import {
  colorsOfDefinition,
  effectiveProtectionOf,
  effectiveWardOf,
  protectionBlocksSource,
  sourceHasQuality,
} from './protection.js';
import { canBlock, assignAndDealCombatDamage } from './internal/combat.js';
import { indexContinuous } from './internal/continuous.js';
import { mergeKeywordGrant } from './internal/stats.js';
import { isLegalHost, isLegallyAttached } from './attachments.js';
import { checkStateBasedActions } from './internal/sba.js';
import { deckOf, landDef } from './test-fixtures.js';

const SEED = 1717;

/** A creature definition with optional keywords and an optional cost. */
function creature(
  id: string,
  extra?: Partial<Pick<CardDefinition, 'keywords' | 'cost' | 'types' | 'attachment' | 'power'>>,
): CardDefinition {
  return {
    id,
    name: id,
    types: extra?.types ?? ['creature'],
    power: extra?.power ?? 2,
    toughness: 2,
    ...(extra?.keywords ? { keywords: extra.keywords } : {}),
    ...(extra?.cost ? { cost: extra.cost } : {}),
    ...(extra?.attachment ? { attachment: extra.attachment } : {}),
  };
}

const RED_SPELL: CardDefinition = {
  id: 'red-spell',
  name: 'Red Spell',
  types: ['instant'],
  cost: { R: 1 },
  timing: 'instant',
};
const WHITE_SPELL: CardDefinition = {
  id: 'white-spell',
  name: 'White Spell',
  types: ['instant'],
  cost: { generic: 1, W: 1 },
  timing: 'instant',
};
const COLORLESS_SPELL: CardDefinition = {
  id: 'colorless-spell',
  name: 'Colorless Spell',
  types: ['instant'],
  cost: { generic: 2 },
  timing: 'instant',
};

function board(): GameState {
  const { state } = createGame({
    seed: SEED,
    decks: { A: deckOf(landDef('Mountain', 'R'), 30), B: deckOf(landDef('Mountain', 'R'), 30) },
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
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
  return instance;
}

const PRO_RED = creature('Pro Red', { keywords: { protectionFrom: ['red'] } });
const PRO_EVERYTHING = creature('Pro Everything', { keywords: { protectionFrom: ['everything'] } });

describe('source qualities', () => {
  it('derives colors from cost pips, hybrid included', () => {
    expect(colorsOfDefinition(RED_SPELL)).toEqual(['R']);
    expect(colorsOfDefinition(COLORLESS_SPELL)).toEqual([]);
    const hybrid: CardDefinition = {
      id: 'gw',
      name: 'GW',
      types: ['creature'],
      cost: { generic: 1, hybrid: [['G', 'W'], ['G', 'W']] },
    };
    expect([...colorsOfDefinition(hybrid)].sort()).toEqual(['G', 'W']);
    expect(sourceHasQuality(hybrid, 'multicolored')).toBe(true);
    expect(sourceHasQuality(hybrid, 'colorless')).toBe(false);
  });

  it('answers the non-color qualities from the type line', () => {
    const equipment = creature('Blade', { types: ['artifact'], cost: { generic: 1 } });
    expect(sourceHasQuality(equipment, 'artifacts')).toBe(true);
    expect(sourceHasQuality(equipment, 'creatures')).toBe(false);
    expect(sourceHasQuality(equipment, 'colorless')).toBe(true);
    expect(sourceHasQuality(equipment, 'everything')).toBe(true);
  });
});

describe('protection half 1 — can\'t be targeted by sources with the quality', () => {
  it('blocks a red source and lets a colorless one through', () => {
    const state = board();
    const target = place(state, PRO_RED, 'B');
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', RED_SPELL)).toBe(false);
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', COLORLESS_SPELL)).toBe(true);
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', WHITE_SPELL)).toBe(true);
  });

  it('blocks the protected permanent\'s OWN controller too — protection has no hexproof escape', () => {
    const state = board();
    const target = place(state, PRO_RED, 'B');
    expect(isLegalTarget(state, 'creature', target.instanceId, 'B', RED_SPELL)).toBe(false);
  });

  it('treats an UNKNOWN source conservatively: a protected permanent is not targetable', () => {
    const state = board();
    const target = place(state, PRO_RED, 'B');
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A')).toBe(false);
    // …while an unprotected one is unaffected by the source being unknown.
    const plain = place(state, creature('Plain'), 'B');
    expect(isLegalTarget(state, 'creature', plain.instanceId, 'A')).toBe(true);
  });

  it('is enforced in the offered-targets menu, per source', () => {
    const state = board();
    const shielded = place(state, PRO_RED, 'B');
    const plain = place(state, creature('Plain'), 'B');
    const redMenu = legalTargetsFor(state, 'creature', 'A', RED_SPELL);
    expect(redMenu).not.toContain(shielded.instanceId);
    expect(redMenu).toContain(plain.instanceId);
    const whiteMenu = legalTargetsFor(state, 'creature', 'A', WHITE_SPELL);
    expect(whiteMenu).toContain(shielded.instanceId);
  });

  it('protection from everything blocks every source', () => {
    const state = board();
    const target = place(state, PRO_EVERYTHING, 'B');
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', COLORLESS_SPELL)).toBe(false);
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', WHITE_SPELL)).toBe(false);
  });
});

describe('protection half 2 — can\'t be dealt damage by sources with the quality', () => {
  /** Run one full-combat swing of `attacker` into `blocker` and return marked damage. */
  function combatDamage(attackerDef: CardDefinition, blockerDef: CardDefinition): {
    attackerMarked: number;
    blockerMarked: number;
    prevented: number;
  } {
    const state = board();
    const attacker = place(state, attackerDef, 'A');
    const blocker = place(state, blockerDef, 'B');
    state.combat = {
      attackers: [attacker.instanceId],
      blocks: { [blocker.instanceId]: attacker.instanceId },
      attackersDeclared: true,
      blockersDeclared: true,
    };
    let prevented = 0;
    assignAndDealCombatDamage(state, (e) => {
      if (e.type === 'damagePrevented') prevented += e.amount;
    }, 'normal');
    return { attackerMarked: attacker.damageMarked, blockerMarked: blocker.damageMarked, prevented };
  }

  it('prevents combat damage from a source with the quality, in either direction', () => {
    // The attacker is a red creature (red cost); the blocker has protection from red.
    const redAttacker = creature('Red Attacker', { cost: { R: 1 } });
    const shieldedBlocker = creature('Shielded Blocker', {
      keywords: { protectionFrom: ['red'] },
      cost: { W: 1 },
    });
    const swing = combatDamage(redAttacker, shieldedBlocker);
    expect(swing.blockerMarked).toBe(0); // prevented
    expect(swing.attackerMarked).toBe(2); // the white blocker still hits back
    expect(swing.prevented).toBe(2);
  });

  it('does not prevent damage from a source without the quality', () => {
    const colorlessAttacker = creature('Wall of Metal', { types: ['artifact', 'creature'], cost: { generic: 2 } });
    const shieldedBlocker = creature('Shielded Blocker', { keywords: { protectionFrom: ['red'] }, cost: { W: 1 } });
    const swing = combatDamage(colorlessAttacker, shieldedBlocker);
    expect(swing.blockerMarked).toBe(2);
    expect(swing.prevented).toBe(0);
  });
});

describe('protection half 3 — can\'t be enchanted/equipped by sources with the quality', () => {
  const RED_AURA: CardDefinition = {
    id: 'red-aura',
    name: 'Red Aura',
    types: ['enchantment'],
    cost: { R: 1 },
    attachment: {
      attachesTo: { anyOfTypes: ['creature'] },
      modifies: { power: 2, toughness: 0 },
      whenIllegal: 'toGraveyard',
    },
  };

  it('refuses a host protected from the attachment\'s quality', () => {
    const state = board();
    const host = place(state, PRO_RED, 'B');
    const aura = place(state, RED_AURA, 'A');
    expect(isLegalHost(RED_AURA.attachment!, 'A', host, RED_AURA, state)).toBe(false);
    aura.attachedTo = host.instanceId;
    expect(isLegallyAttached(state, aura)).toBe(false);
  });

  it('a protection GAINED later makes an existing attachment illegal (the SBA knocks it off)', () => {
    const state = board();
    const host = place(state, creature('Plain Host'), 'B');
    const aura = place(state, RED_AURA, 'A');
    aura.attachedTo = host.instanceId;
    expect(isLegallyAttached(state, aura)).toBe(true);
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: host.instanceId,
      sourceInstanceId: host.instanceId,
      duration: 'endOfTurn',
      keywords: { protectionFrom: ['red'] },
    });
    expect(isLegallyAttached(state, aura)).toBe(false);
    // The state-based actions put an illegally-attached Aura in the graveyard
    // (CR 704.5m) — run the same pass the engine runs at every SBA point.
    checkStateBasedActions(state, () => {});
    expect(state.battlefield.some((c) => c.instanceId === aura.instanceId)).toBe(false);
    expect(state.players.A.graveyard.some((c) => c.instanceId === aura.instanceId)).toBe(true);
  });
});

describe('protection half 4 — can\'t be blocked by creatures with the quality', () => {
  it('a pro-red attacker cannot be blocked by a red creature, and can by a white one', () => {
    const state = board();
    const attacker = place(state, creature('Pro Red Attacker', { keywords: { protectionFrom: ['red'] } }), 'A');
    const redBlocker = place(state, creature('Red Blocker', { cost: { R: 1 } }), 'B');
    const whiteBlocker = place(state, creature('White Blocker', { cost: { W: 1 } }), 'B');
    const index = indexContinuous(state);
    expect(canBlock(attacker, redBlocker, index)).toBe(false);
    expect(canBlock(attacker, whiteBlocker, index)).toBe(true);
  });

  it('protection from creatures is unblockable — every blocker is a creature', () => {
    const state = board();
    const attacker = place(state, creature('Pro Creatures', { keywords: { protectionFrom: ['creatures'] } }), 'A');
    const blocker = place(state, creature('Any Blocker'), 'B');
    expect(canBlock(attacker, blocker, indexContinuous(state))).toBe(false);
  });
});

describe('granted protection through the continuous layer', () => {
  it('behaves like printed protection while active and stops when the effect is gone', () => {
    const state = board();
    const target = place(state, creature('Plain'), 'B');
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', RED_SPELL)).toBe(true);
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: target.instanceId,
      sourceInstanceId: target.instanceId,
      duration: 'endOfTurn',
      keywords: { protectionFrom: ['red'] },
    });
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', RED_SPELL)).toBe(false);
    expect(effectiveProtectionOf(state, target)).toEqual(['red']);
    // A granted list UNIONS with a printed one rather than replacing it.
    const printed = place(state, PRO_RED, 'B');
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: printed.instanceId,
      sourceInstanceId: printed.instanceId,
      duration: 'endOfTurn',
      keywords: { protectionFrom: ['white', 'red'] },
    });
    expect([...(effectiveProtectionOf(state, printed) ?? [])].sort()).toEqual(['red', 'white']);
    state.continuous = [];
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', RED_SPELL)).toBe(true);
  });
});

describe('the keyword merge rules', () => {
  it('unions protection lists and adds ward costs', () => {
    expect(unionProtection(['red'], ['red', 'white'])).toEqual(['red', 'white']);
    expect(unionProtection(undefined, ['red'])).toEqual(['red']);
    const merged = mergeKeywordGrant(
      { protectionFrom: ['red'] as readonly ProtectionQuality[], ward: 2, flying: true },
      { protectionFrom: ['white'], ward: 1, trample: true },
    );
    expect(merged.protectionFrom).toEqual(['red', 'white']);
    expect(merged.ward).toBe(3);
    expect(merged.flying).toBe(true);
    expect(merged.trample).toBe(true);
  });

  it('a granted boolean flag missing from the old combat-only list aggregates now (hexproof)', () => {
    const state = board();
    const target = place(state, creature('Pumped'), 'B');
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: target.instanceId,
      sourceInstanceId: target.instanceId,
      duration: 'endOfTurn',
      keywords: { hexproof: true },
    });
    // Granted hexproof protects against the opponent…
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', COLORLESS_SPELL)).toBe(false);
    // …but not against its own controller, exactly like the printed keyword.
    expect(isLegalTarget(state, 'creature', target.instanceId, 'B', COLORLESS_SPELL)).toBe(true);
  });
});

describe('ward cost reads', () => {
  it('reads printed ward and adds a granted ward', () => {
    const state = board();
    const warded = place(state, creature('Warded', { keywords: { ward: 2 } }), 'B');
    expect(effectiveWardOf(state, warded)).toBe(2);
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: warded.instanceId,
      sourceInstanceId: warded.instanceId,
      duration: 'endOfTurn',
      keywords: { ward: 1 },
    });
    expect(effectiveWardOf(state, warded)).toBe(3);
  });
});

describe('protectionBlocksSource edge shapes', () => {
  it('an empty or absent protection list blocks nothing', () => {
    expect(protectionBlocksSource(undefined, RED_SPELL)).toBe(false);
    expect(protectionBlocksSource([], RED_SPELL)).toBe(false);
  });
  it('a non-empty list with no source blocks conservatively', () => {
    expect(protectionBlocksSource(['red'], undefined)).toBe(true);
  });
});

describe('the engine offers no cast onto a protected target', () => {
  it('a restricted red spell is not offered against the only (protected) creature', () => {
    const state = board();
    place(state, PRO_RED, 'B');
    const redRemoval: CardDefinition = {
      id: 'red-removal',
      name: 'Red Removal',
      types: ['instant'],
      cost: { R: 1 },
      timing: 'instant',
      effects: [{ primitive: 'dealDamage', params: { amount: 4, targets: 'creature' } }],
    };
    const card: CardInstance = {
      instanceId: state.nextInstanceId++,
      def: redRemoval,
      controller: 'A',
      owner: 'A',
      zone: 'hand',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    state.players.A.hand = [card];
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 2, G: 0, C: 0 };
    const offers = generateLegalActions(state).filter(
      (a) => a.kind === 'castSpell' && a.instanceId === card.instanceId,
    );
    expect(offers).toHaveLength(0);
  });
});
