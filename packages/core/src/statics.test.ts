/**
 * Static ("anthem") ability tests — a permanent that continuously modifies OTHER
 * permanents for as long as it is on the battlefield.
 *
 * Everything here is proved through the PUBLIC engine surface on a real game
 * (`applyAction` / `generateLegalActions` / combat / SBAs), not by poking the
 * aggregation function, because the claim being tested is that statics reach every
 * place effective values are read — combat damage, state-based actions, attack and
 * block legality, and serialization — and not merely one of them.
 *
 * Card fixtures are declared INLINE here. Wiring real pool cards to `statics` is a
 * deliberate follow-up owned by `packages/cards`.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  aggregateFor,
  cloneState,
  effectiveKeywords,
  effectivePower,
  effectiveToughness,
  generateLegalActions,
  indexContinuous,
  serializeState,
  staticAppliesTo,
  NO_MOD,
  PLUS_ONE_COUNTER,
  type CardDefinition,
  type EffectContext,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

// --- inline card fixtures ---------------------------------------------------------
// These are exactly the shape a card author writes (see the §"exact API" note in
// statics.ts): `statics: [{ affects: {...}, power, toughness, keywords }]`.

/** "Creatures you control get +1/+1." Includes ITSELF if it is a creature. */
const GLORIOUS_ANTHEM: CardDefinition = {
  id: 'GloriousAnthem',
  name: 'Glorious Anthem',
  types: ['enchantment'],
  cost: { generic: 2 },
  statics: [
    {
      label: 'Creatures you control get +1/+1.',
      affects: { controller: 'you', anyOfTypes: ['creature'] },
      power: 1,
      toughness: 1,
    },
  ],
};

/** A creature lord: "Creatures you control get +1/+1" — the NON-"other" form. */
const SELF_PUMPING_LORD: CardDefinition = {
  id: 'SelfPumpingLord',
  name: 'Self-Pumping Lord',
  types: ['creature'],
  subtypes: ['Human', 'Soldier'],
  power: 2,
  toughness: 2,
  cost: { generic: 3 },
  statics: [
    {
      label: 'Creatures you control get +1/+1.',
      affects: { controller: 'you', anyOfTypes: ['creature'] },
      power: 1,
      toughness: 1,
    },
  ],
};

/** The same lord written with the printed word "other". */
const OTHER_ONLY_LORD: CardDefinition = {
  id: 'OtherOnlyLord',
  name: 'Other-Only Lord',
  types: ['creature'],
  subtypes: ['Human', 'Soldier'],
  power: 2,
  toughness: 2,
  cost: { generic: 3 },
  statics: [
    {
      label: 'OTHER creatures you control get +1/+1.',
      affects: { controller: 'you', anyOfTypes: ['creature'], excludeSource: true },
      power: 1,
      toughness: 1,
    },
  ],
};

/** "Goblins you control have haste." A tribal keyword grant, matched by subtype. */
const GOBLIN_WARCHIEF: CardDefinition = {
  id: 'GoblinWarchief',
  name: 'Goblin Warchief',
  types: ['creature'],
  subtypes: ['Goblin', 'Warrior'],
  power: 2,
  toughness: 2,
  cost: { generic: 3 },
  statics: [
    {
      label: 'Goblins you control have haste.',
      affects: { controller: 'you', anyOfSubtypes: ['Goblin'] },
      keywords: { haste: true },
    },
  ],
};

/** "Creatures you control have flying." */
const LEVITATION: CardDefinition = {
  id: 'Levitation',
  name: 'Levitation',
  types: ['enchantment'],
  cost: { generic: 3 },
  statics: [
    {
      label: 'Creatures you control have flying.',
      affects: { controller: 'you', anyOfTypes: ['creature'] },
      keywords: { flying: true },
    },
  ],
};

const GOBLIN = { ...creatureDef('Goblin Recruit', 1, 1), subtypes: ['Goblin'] } as CardDefinition;

// --- harness ----------------------------------------------------------------------

function testRegistry(): EffectRegistry {
  const reg = createEffectRegistry();
  reg.register('pumpUntilEOT', (ctx: EffectContext) => {
    const power = (ctx.params.power as number | undefined) ?? 0;
    const toughness = (ctx.params.toughness as number | undefined) ?? 0;
    const target = (ctx.targets[0] as InstanceId | undefined) ?? ctx.source.instanceId;
    ctx.addContinuousEffect({ target, power, toughness, duration: 'endOfTurn' });
  });
  return reg;
}

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function advanceToStep(state: GameState, target: string, reg: EffectRegistry, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== target && !s.gameOver && guard++ < max) s = pass(s, reg);
  return s;
}

function advanceUntilActive(state: GameState, player: PlayerId, reg: EffectRegistry, max = 800): GameState {
  let s = state;
  let guard = 0;
  while (s.activePlayer !== player && !s.gameOver && guard++ < max) s = pass(s, reg);
  return s;
}

function lib(): ReturnType<typeof deckOf> {
  return deckOf(ISLAND, 40);
}

/** Put a permanent on the battlefield, not summoning-sick, and return its id. */
function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id, def, controller, owner: controller, zone: 'battlefield',
    tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
    attachedTo: null,
  });
  return id;
}

/** Put a SUMMONING-SICK permanent on the battlefield and return its id. */
function placeSick(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id, def, controller, owner: controller, zone: 'battlefield',
    tapped: false, summoningSick: true, damageMarked: 0, markedByDeathtouch: false, counters: {},
    attachedTo: null,
  });
  return id;
}

/** Give a player a card in hand and return its instance id. */
function giveCard(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const id = state.nextInstanceId++;
  state.players[player].hand.push({
    instanceId: id, def, controller: player, owner: player, zone: 'hand',
    tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
    attachedTo: null,
  });
  return id;
}

/** Effective P/T through the ONE layering path — exactly what combat/SBAs read. */
function pt(state: GameState, id: InstanceId): { power: number; toughness: number } {
  const inst = state.battlefield.find((c) => c.instanceId === id)!;
  const mod = indexContinuous(state).get(id) ?? NO_MOD;
  return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
}

function alive(state: GameState, id: InstanceId): boolean {
  return state.battlefield.some((c) => c.instanceId === id);
}

// --- the anthem applies, everywhere -----------------------------------------------

describe('an anthem pumps the creatures it matches', () => {
  it('a 1/1 under a +1/+1 anthem attacks as a 2/2 — it kills a 1/1 blocker and lives', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 101, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    place(s, GLORIOUS_ANTHEM, 'A');
    // Without the anthem this is a mutual trade; with it the whelp wins outright.
    const blockerId = place(s, creatureDef('Guard', 1, 1), 'B');

    expect(pt(s, bearId)).toEqual({ power: 2, toughness: 2 });

    s = advanceToStep(s, 'declareAttackers', reg);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [bearId] }, reg);
    s = advanceToStep(s, 'declareBlockers', reg);
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: blockerId, attacker: bearId }] }, reg);
    s = advanceToStep(s, 'postcombatMain', reg);

    expect(alive(s, blockerId)).toBe(false);
    expect(alive(s, bearId)).toBe(true);
    // The 1 damage it took would have been lethal to the printed 1/1.
    expect(s.battlefield.find((c) => c.instanceId === bearId)!.damageMarked).toBe(1);
  });

  it('a 1/1 under TWO +1/+1 anthems is a 3/3 and survives 2 combat damage', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 105, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    place(s, GLORIOUS_ANTHEM, 'A');
    place(s, GLORIOUS_ANTHEM, 'A');
    const blockerId = place(s, creatureDef('Guard', 2, 2), 'B');
    expect(pt(s, bearId)).toEqual({ power: 3, toughness: 3 });

    s = advanceToStep(s, 'declareAttackers', reg);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [bearId] }, reg);
    s = advanceToStep(s, 'declareBlockers', reg);
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: blockerId, attacker: bearId }] }, reg);
    s = advanceToStep(s, 'postcombatMain', reg);

    expect(alive(s, blockerId)).toBe(false);
    expect(alive(s, bearId)).toBe(true);
    expect(s.battlefield.find((c) => c.instanceId === bearId)!.damageMarked).toBe(2);
  });

  it('an unblocked anthem’d creature deals its BOOSTED power to the player', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 102, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    place(s, GLORIOUS_ANTHEM, 'A');

    s = advanceToStep(s, 'declareAttackers', reg);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [bearId] }, reg);
    s = advanceToStep(s, 'declareBlockers', reg);
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [] }, reg);
    s = advanceToStep(s, 'postcombatMain', reg);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 2);
  });

  it('serialization reports the boosted P/T (the inspector and replay see it too)', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 103, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    place(s, GLORIOUS_ANTHEM, 'A');
    const snap = serializeState(s).battlefield.find((c) => c.instanceId === bearId)!;
    expect({ power: snap.power, toughness: snap.toughness }).toEqual({ power: 2, toughness: 2 });
  });

  it('a non-creature permanent is untouched by a creature-only anthem', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 104, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const landId = place(s, ISLAND, 'A');
    place(s, GLORIOUS_ANTHEM, 'A');
    expect(indexContinuous(s).get(landId)).toBeUndefined();
  });
});

// --- lifetime ---------------------------------------------------------------------

describe('a static lasts exactly as long as its source is on the battlefield', () => {
  it('the anthem leaves and the creature it was propping up dies to SBAs immediately', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 111, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    // A 0/0 body that only exists at all because the anthem makes it a 1/1.
    const spriteId = place(s, { id: 'Sprite', name: 'Sprite', types: ['creature'], power: 0, toughness: 0 }, 'A');
    const anthemId = place(s, GLORIOUS_ANTHEM, 'A');
    // Nothing has run SBAs yet on our hand-placed board; one priority pass does.
    s = pass(s, reg);
    expect(alive(s, spriteId)).toBe(true);
    expect(pt(s, spriteId)).toEqual({ power: 1, toughness: 1 });

    // Remove the anthem the way any removal spell would: off the battlefield.
    const draft = cloneState(s);
    draft.battlefield = draft.battlefield.filter((c) => c.instanceId !== anthemId);
    // The very next engine action runs SBAs, which rebuild the layering from the
    // battlefield — the sprite is a 0/0 again and dies in that pass.
    const after = pass(draft, reg);
    expect(alive(after, spriteId)).toBe(false);
  });

  it('the anthem DIES IN COMBAT DAMAGE and its team shrinks in the same combat', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 112, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    // B controls a creature-lord anthem and a 1/1 that is only a 2/2 because of it.
    // A attacks the lord with a 2/2; the lord (a 2/2 base, so 3/3 under its own
    // anthem) is blocked... no — A is the active player, so A attacks. Set it up the
    // other way: A owns the anthem and B kills it in combat.
    const lordId = place(s, SELF_PUMPING_LORD, 'A'); // base 2/2 → 3/3 under itself
    const whelpId = place(s, creatureDef('Whelp', 1, 1), 'A'); // → 2/2 under the lord
    // A 3/3 blocker kills the 3/3 lord in a trade.
    const slayerId = place(s, creatureDef('Slayer', 3, 3), 'B');
    // The whelp has already taken 2 damage this turn; at 2/2 it lives, at 1/1 it dies.
    s.battlefield.find((c) => c.instanceId === whelpId)!.damageMarked = 1;

    expect(pt(s, lordId)).toEqual({ power: 3, toughness: 3 });
    expect(pt(s, whelpId)).toEqual({ power: 2, toughness: 2 });

    s = advanceToStep(s, 'declareAttackers', reg);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [lordId] }, reg);
    s = advanceToStep(s, 'declareBlockers', reg);
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: slayerId, attacker: lordId }] }, reg);
    s = advanceToStep(s, 'postcombatMain', reg);

    // The lord traded with the 3/3 (it was a 3/3 *while damage was assigned*)...
    expect(alive(s, lordId)).toBe(false);
    expect(alive(s, slayerId)).toBe(false);
    // ...and the whelp, back to a 1/1 with 1 damage marked, died in the same SBA pass.
    expect(alive(s, whelpId)).toBe(false);
  });

  it('a creature that only the anthem kept alive survives while the anthem survives', () => {
    // Control for the case above: identical board, but the lord is NOT blocked, so
    // nothing about the whelp changes.
    const reg = testRegistry();
    const g = createGame({ seed: 113, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    const lordId = place(s, SELF_PUMPING_LORD, 'A');
    const whelpId = place(s, creatureDef('Whelp', 1, 1), 'A');
    s.battlefield.find((c) => c.instanceId === whelpId)!.damageMarked = 1;

    s = advanceToStep(s, 'declareAttackers', reg);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [lordId] }, reg);
    s = advanceToStep(s, 'declareBlockers', reg);
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [] }, reg);
    s = advanceToStep(s, 'postcombatMain', reg);

    expect(alive(s, lordId)).toBe(true);
    expect(alive(s, whelpId)).toBe(true);
  });

  it('a static in a card’s HAND or graveyard does nothing — only the battlefield counts', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 114, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    giveCard(s, 'A', GLORIOUS_ANTHEM);
    s.players.A.graveyard.push({
      instanceId: s.nextInstanceId++, def: GLORIOUS_ANTHEM, controller: 'A', owner: 'A', zone: 'graveyard',
      tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
    attachedTo: null,
    });
    expect(pt(s, bearId)).toEqual({ power: 1, toughness: 1 });
  });

  it('the anthem starts applying the moment it RESOLVES onto the battlefield', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 115, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    // A free anthem so no mana is needed.
    const freeAnthem: CardDefinition = { ...GLORIOUS_ANTHEM, cost: { generic: 0 } };
    const anthemCard = giveCard(s, 'A', freeAnthem);

    s = advanceToStep(s, 'precombatMain', reg);
    expect(pt(s, bearId)).toEqual({ power: 1, toughness: 1 });
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: anthemCard, targets: [] }, reg);
    s = pass(s, reg);
    s = pass(s, reg); // the enchantment resolves onto the battlefield
    expect(s.battlefield.some((c) => c.instanceId === anthemCard)).toBe(true);
    expect(pt(s, bearId)).toEqual({ power: 2, toughness: 2 });
  });
});

// --- self-reference ---------------------------------------------------------------

describe('self-reference: "other" versus the plain form', () => {
  it('"creatures you control" INCLUDES the lord itself', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 121, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const lordId = place(s, SELF_PUMPING_LORD, 'A');
    const otherId = place(s, creatureDef('Whelp', 1, 1), 'A');
    expect(pt(s, lordId)).toEqual({ power: 3, toughness: 3 }); // 2/2 base + its own anthem
    expect(pt(s, otherId)).toEqual({ power: 2, toughness: 2 });
  });

  it('"OTHER creatures you control" does NOT pump the lord itself', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 122, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const lordId = place(s, OTHER_ONLY_LORD, 'A');
    const otherId = place(s, creatureDef('Whelp', 1, 1), 'A');
    expect(pt(s, lordId)).toEqual({ power: 2, toughness: 2 }); // printed only
    expect(pt(s, otherId)).toEqual({ power: 2, toughness: 2 }); // pumped
  });

  it('two copies of an "other" lord DO pump each other', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 123, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const firstId = place(s, OTHER_ONLY_LORD, 'A');
    const secondId = place(s, OTHER_ONLY_LORD, 'A');
    // Each excludes only ITSELF, so each is pumped by the other: 2/2 → 3/3.
    expect(pt(s, firstId)).toEqual({ power: 3, toughness: 3 });
    expect(pt(s, secondId)).toEqual({ power: 3, toughness: 3 });
  });
});

// --- controller filtering ---------------------------------------------------------

describe('controller filtering', () => {
  it('an OPPONENT’s anthem does not pump your creatures', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 131, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const mineId = place(s, creatureDef('Whelp', 1, 1), 'A');
    const theirsId = place(s, creatureDef('Whelp', 1, 1), 'B');
    place(s, GLORIOUS_ANTHEM, 'B'); // B's anthem
    expect(pt(s, mineId)).toEqual({ power: 1, toughness: 1 });
    expect(pt(s, theirsId)).toEqual({ power: 2, toughness: 2 });
  });

  it('controller: "any" is symmetric — it pumps both sides', () => {
    const reg = testRegistry();
    const symmetric: CardDefinition = {
      id: 'Gigantiform', name: 'Gigantiform', types: ['enchantment'], cost: { generic: 2 },
      statics: [{ affects: { controller: 'any', anyOfTypes: ['creature'] }, power: 1, toughness: 1 }],
    };
    const g = createGame({ seed: 132, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const mineId = place(s, creatureDef('Whelp', 1, 1), 'A');
    const theirsId = place(s, creatureDef('Whelp', 1, 1), 'B');
    place(s, symmetric, 'A');
    expect(pt(s, mineId)).toEqual({ power: 2, toughness: 2 });
    expect(pt(s, theirsId)).toEqual({ power: 2, toughness: 2 });
  });

  it('controller: "opponent" is punitive — it shrinks THEIR creatures only', () => {
    const reg = testRegistry();
    const punitive: CardDefinition = {
      id: 'Ill Wind', name: 'Ill Wind', types: ['enchantment'], cost: { generic: 2 },
      statics: [{ affects: { controller: 'opponent', anyOfTypes: ['creature'] }, power: -1, toughness: 0 }],
    };
    const g = createGame({ seed: 133, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const mineId = place(s, creatureDef('Whelp', 2, 2), 'A');
    const theirsId = place(s, creatureDef('Whelp', 2, 2), 'B');
    place(s, punitive, 'A');
    expect(pt(s, mineId)).toEqual({ power: 2, toughness: 2 });
    expect(pt(s, theirsId)).toEqual({ power: 1, toughness: 2 });
  });

  it('the default scope, when omitted, is "you"', () => {
    const reg = testRegistry();
    const defaulted: CardDefinition = {
      id: 'Defaulted', name: 'Defaulted', types: ['enchantment'], cost: { generic: 2 },
      statics: [{ affects: { anyOfTypes: ['creature'] }, power: 1, toughness: 1 }],
    };
    const g = createGame({ seed: 134, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const mineId = place(s, creatureDef('Whelp', 1, 1), 'A');
    const theirsId = place(s, creatureDef('Whelp', 1, 1), 'B');
    place(s, defaulted, 'A');
    expect(pt(s, mineId)).toEqual({ power: 2, toughness: 2 });
    expect(pt(s, theirsId)).toEqual({ power: 1, toughness: 1 });
  });
});

// --- subtype (tribal) filtering ---------------------------------------------------

describe('subtype filtering', () => {
  it('a Goblin lord pumps only Goblins, case-insensitively', () => {
    const reg = testRegistry();
    const goblinLord: CardDefinition = {
      id: 'GoblinKing', name: 'Goblin King', types: ['creature'], subtypes: ['Goblin'],
      power: 2, toughness: 2, cost: { generic: 2 },
      statics: [{ affects: { controller: 'you', anyOfSubtypes: ['goblin'] }, power: 1, toughness: 1 }],
    };
    const g = createGame({ seed: 141, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const goblinId = place(s, GOBLIN, 'A');
    const elfId = place(s, { ...creatureDef('Elf Scout', 1, 1), subtypes: ['Elf'] } as CardDefinition, 'A');
    place(s, goblinLord, 'A');
    expect(pt(s, goblinId)).toEqual({ power: 2, toughness: 2 });
    expect(pt(s, elfId)).toEqual({ power: 1, toughness: 1 });
  });

  it('noneOfSubtypes writes the "non-Goblin" form', () => {
    const reg = testRegistry();
    const nonGoblin: CardDefinition = {
      id: 'NonGoblinAnthem', name: 'Non-Goblin Anthem', types: ['enchantment'], cost: { generic: 2 },
      statics: [{ affects: { controller: 'you', anyOfTypes: ['creature'], noneOfSubtypes: ['Goblin'] }, power: 1 }],
    };
    const g = createGame({ seed: 142, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const goblinId = place(s, GOBLIN, 'A');
    const elfId = place(s, { ...creatureDef('Elf Scout', 1, 1), subtypes: ['Elf'] } as CardDefinition, 'A');
    place(s, nonGoblin, 'A');
    expect(pt(s, goblinId)).toEqual({ power: 1, toughness: 1 });
    expect(pt(s, elfId)).toEqual({ power: 2, toughness: 1 });
  });
});

// --- granted keywords affect LEGALITY, not just damage ----------------------------

describe('a keyword granted by a static changes what is LEGAL', () => {
  it('a Goblin can attack the turn it lands under a haste-granting static', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 151, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    place(s, GOBLIN_WARCHIEF, 'A'); // "Goblins you control have haste"
    const recruitId = placeSick(s, GOBLIN, 'A'); // just landed, summoning-sick

    s = advanceToStep(s, 'declareAttackers', reg);
    expect(s.battlefield.find((c) => c.instanceId === recruitId)!.summoningSick).toBe(true);
    const inst = s.battlefield.find((c) => c.instanceId === recruitId)!;
    expect(effectiveKeywords(inst, indexContinuous(s).get(recruitId) ?? NO_MOD).haste).toBe(true);

    // Offered by the legal-action generator...
    const offered = generateLegalActions(s).find((a) => a.kind === 'declareAttackers');
    expect(offered).toBeDefined();
    expect((offered as Extract<GameAction, { kind: 'declareAttackers' }>).attackers).toContain(recruitId);
    // ...and accepted by applyAction.
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [recruitId] }, reg);
    expect(s.combat!.attackers).toContain(recruitId);
  });

  it('control: without the warchief, the same fresh Goblin cannot attack', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 152, decks: { A: lib(), B: lib() }, registry: reg });
    const recruitId = placeSick(g.state, GOBLIN, 'A');
    const s = advanceToStep(g.state, 'declareAttackers', reg);
    expect(s.battlefield.find((c) => c.instanceId === recruitId)!.summoningSick).toBe(true);
    expect(generateLegalActions(s).some((a) => a.kind === 'declareAttackers')).toBe(false);
  });

  it('the haste grant vanishes with the warchief — the Goblin can no longer attack', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 153, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    const warchiefId = place(s, GOBLIN_WARCHIEF, 'A');
    const recruitId = placeSick(s, GOBLIN, 'A');
    s = advanceToStep(s, 'declareAttackers', reg);
    // Kill the warchief before attackers are declared.
    s = cloneState(s);
    s.battlefield = s.battlefield.filter((c) => c.instanceId !== warchiefId);
    const offered = generateLegalActions(s).find((a) => a.kind === 'declareAttackers');
    expect(
      offered === undefined ||
        !(offered as Extract<GameAction, { kind: 'declareAttackers' }>).attackers.includes(recruitId),
    ).toBe(true);
    const rejected = applyAction(s, { kind: 'declareAttackers', player: 'A', attackers: [recruitId] }, DEFAULT_RULES, reg);
    expect(rejected.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });

  it('an attacker granted FLYING by a static cannot be blocked by a groundling', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 154, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    const beaterId = place(s, creatureDef('Beater', 2, 2), 'A'); // no printed flying
    place(s, LEVITATION, 'A'); // "Creatures you control have flying"
    s = advanceToStep(s, 'declareAttackers', reg);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [beaterId] }, reg);
    s = advanceToStep(s, 'declareBlockers', reg);

    const groundlingId = place(s, creatureDef('Groundling', 3, 3), 'B');
    const rejected = applyAction(
      s,
      { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: groundlingId, attacker: beaterId }] },
      DEFAULT_RULES,
      reg,
    );
    expect(rejected.events.some((e) => e.type === 'actionRejected')).toBe(true);

    // A reach creature still can.
    const reacherId = place(s, creatureDef('Reacher', 1, 1, { keywords: { reach: true } }), 'B');
    const ok = act(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: reacherId, attacker: beaterId }] }, reg);
    expect(ok.combat!.blocks[reacherId]).toBe(beaterId);
  });

  it('a static granting DEFENDER to the opponent’s creatures stops them attacking', () => {
    const reg = testRegistry();
    const pacifism: CardDefinition = {
      id: 'MassPacifism', name: 'Mass Pacifism', types: ['enchantment'], cost: { generic: 3 },
      statics: [{ affects: { controller: 'opponent', anyOfTypes: ['creature'] }, keywords: { defender: true } }],
    };
    const g = createGame({ seed: 155, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const bearId = place(s, creatureDef('Bear', 2, 2), 'A');
    place(s, pacifism, 'B'); // B's enchantment, aimed at A's creatures
    const atCombat = advanceToStep(s, 'declareAttackers', reg);
    const offered = generateLegalActions(atCombat).find((a) => a.kind === 'declareAttackers');
    expect(
      offered === undefined ||
        !(offered as Extract<GameAction, { kind: 'declareAttackers' }>).attackers.includes(bearId),
    ).toBe(true);
    const rejected = applyAction(atCombat, { kind: 'declareAttackers', player: 'A', attackers: [bearId] }, DEFAULT_RULES, reg);
    expect(rejected.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });
});

// --- stacking ---------------------------------------------------------------------

describe('stacking: anthems, until-EOT pumps and counters all combine', () => {
  it('two anthems stack additively', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 161, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    place(s, GLORIOUS_ANTHEM, 'A');
    place(s, GLORIOUS_ANTHEM, 'A');
    expect(pt(s, bearId)).toEqual({ power: 3, toughness: 3 });
  });

  it('anthem + until-EOT pump + a +1/+1 counter combine, and only the pump expires', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 162, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    s.battlefield.find((c) => c.instanceId === bearId)!.counters[PLUS_ONE_COUNTER] = 1;
    place(s, GLORIOUS_ANTHEM, 'A');
    const pumpCard = giveCard(s, 'A', {
      id: 'Growth', name: 'Growth', types: ['instant'], timing: 'instant', cost: { generic: 0 },
      effects: [{ primitive: 'pumpUntilEOT', params: { power: 2, toughness: 2 } }],
    });

    s = advanceToStep(s, 'precombatMain', reg);
    // base 1/1 + counter 1/1 + anthem 1/1 = 3/3
    expect(pt(s, bearId)).toEqual({ power: 3, toughness: 3 });
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: pumpCard, targets: [bearId] }, reg);
    s = pass(s, reg);
    s = pass(s, reg); // pump resolves
    // ...+ pump 2/2 = 5/5
    expect(pt(s, bearId)).toEqual({ power: 5, toughness: 5 });

    // The pump expires at cleanup; the anthem and the counter persist.
    s = advanceUntilActive(s, 'B', reg);
    expect(s.continuous.length).toBe(0);
    expect(pt(s, bearId)).toEqual({ power: 3, toughness: 3 });
  });

  it('two anthems, one granting a keyword, OR their grants together', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 163, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    place(s, GLORIOUS_ANTHEM, 'A');
    place(s, LEVITATION, 'A');
    const inst = s.battlefield.find((c) => c.instanceId === bearId)!;
    const mod = indexContinuous(s).get(bearId) ?? NO_MOD;
    expect(effectivePower(inst, mod)).toBe(2);
    expect(effectiveKeywords(inst, mod).flying).toBe(true);
  });
});

// --- the two aggregation entry points agree ---------------------------------------

describe('indexContinuous and aggregateFor give the same answer', () => {
  it('the single-instance read matches the bulk index, with and without statics', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 171, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    const plainId = place(s, creatureDef('Loner', 1, 1), 'B');
    place(s, GLORIOUS_ANTHEM, 'A');
    const index = indexContinuous(s);
    expect(aggregateFor(s, bearId)).toEqual(index.get(bearId));
    expect(aggregateFor(s, plainId)).toBe(NO_MOD);
    expect(index.get(plainId)).toBeUndefined();
  });

  it('an empty board returns the shared empty index (no per-call allocation)', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 172, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    place(s, creatureDef('Whelp', 1, 1), 'A');
    expect(indexContinuous(s)).toBe(indexContinuous(s));
    expect(indexContinuous(s).size).toBe(0);
  });
});

// --- the matcher itself -----------------------------------------------------------

describe('staticAppliesTo', () => {
  it('an inert static (no delta, no keywords) never reaches the index', () => {
    const reg = testRegistry();
    const inert: CardDefinition = {
      id: 'Inert', name: 'Inert', types: ['enchantment'], cost: { generic: 1 },
      statics: [{ affects: { controller: 'any', anyOfTypes: ['creature'] } }],
    };
    const g = createGame({ seed: 181, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    place(s, inert, 'A');
    expect(indexContinuous(s).get(bearId)).toBeUndefined();
  });

  it('matches directly on two instances (the unit the layering pass drives)', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 182, decks: { A: lib(), B: lib() }, registry: reg });
    const s = g.state;
    const lordId = place(s, OTHER_ONLY_LORD, 'A');
    const mateId = place(s, creatureDef('Whelp', 1, 1), 'A');
    const enemyId = place(s, creatureDef('Whelp', 1, 1), 'B');
    const lord = s.battlefield.find((c) => c.instanceId === lordId)!;
    const mate = s.battlefield.find((c) => c.instanceId === mateId)!;
    const enemy = s.battlefield.find((c) => c.instanceId === enemyId)!;
    const ability = OTHER_ONLY_LORD.statics![0]!;
    expect(staticAppliesTo(ability, lord, lord)).toBe(false); // "other"
    expect(staticAppliesTo(ability, lord, mate)).toBe(true);
    expect(staticAppliesTo(ability, lord, enemy)).toBe(false); // controller scope
  });
});

// --- determinism and purity -------------------------------------------------------

describe('determinism and applyAction purity with statics in play', () => {
  it('the same seed produces an identical game with statics on the board', () => {
    const runGame = (seed: number): string => {
      const reg = testRegistry();
      const g = createGame({ seed, decks: { A: lib(), B: lib() }, registry: reg });
      let s = g.state;
      const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
      place(s, GLORIOUS_ANTHEM, 'A');
      place(s, GOBLIN_WARCHIEF, 'A');
      placeSick(s, GOBLIN, 'A');
      s = advanceToStep(s, 'declareAttackers', reg);
      const attackers = (generateLegalActions(s).find((a) => a.kind === 'declareAttackers') as
        | Extract<GameAction, { kind: 'declareAttackers' }>
        | undefined)?.attackers ?? [bearId];
      s = act(s, { kind: 'declareAttackers', player: 'A', attackers }, reg);
      s = advanceToStep(s, 'declareBlockers', reg);
      s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [] }, reg);
      s = advanceToStep(s, 'postcombatMain', reg);
      return JSON.stringify(serializeState(s));
    };
    expect(runGame(191)).toBe(runGame(191));
  });

  it('applyAction does not mutate the input state, and leaks no shared reference', () => {
    const reg = testRegistry();
    const g = createGame({ seed: 192, decks: { A: lib(), B: lib() }, registry: reg });
    let s = g.state;
    const bearId = place(s, creatureDef('Whelp', 1, 1), 'A');
    place(s, GLORIOUS_ANTHEM, 'A');
    s = advanceToStep(s, 'declareAttackers', reg);
    const before = JSON.stringify(serializeState(s));

    const result = applyAction(s, { kind: 'declareAttackers', player: 'A', attackers: [bearId] }, DEFAULT_RULES, reg);
    // The input is untouched...
    expect(JSON.stringify(serializeState(s))).toBe(before);
    expect(s.combat?.attackers ?? []).not.toContain(bearId);
    // ...and the next state shares no mutable battlefield object with it.
    expect(result.state.battlefield).not.toBe(s.battlefield);
    for (const perm of result.state.battlefield) {
      expect(s.battlefield.includes(perm)).toBe(false);
    }
    // Card DEFINITIONS are deliberately shared (immutable), statics included.
    const nextBear = result.state.battlefield.find((c) => c.instanceId === bearId)!;
    const prevBear = s.battlefield.find((c) => c.instanceId === bearId)!;
    expect(nextBear.def).toBe(prevBear.def);
    // Mutating the clone's marked damage must not reach back to the original.
    nextBear.damageMarked += 5;
    expect(prevBear.damageMarked).toBe(0);
  });
});
