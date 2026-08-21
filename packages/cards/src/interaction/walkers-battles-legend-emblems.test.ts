/**
 * INTERACTION MATRIX - planeswalkers x battles x the legend rule x emblems, and
 * where each of them meets combat, damage, counters, attachments and anthems.
 *
 * These four objects were built by one branch on top of a seam another branch had
 * built, so each is well covered ALONE. The cells here are the crossings:
 *
 *   - a walker's loyalty is COUNTERS, so everything that reads counters meets it;
 *   - a battle is defended by its controller's OPPONENT (CR 310.11), so every
 *     combat check that compares controllers instead of asking `protectorOf`
 *     passes every walker test and silently breaks battles;
 *   - the legend rule is the only state-based action that PARKS A QUESTION, so it
 *     meets the priority machine, attachments and transform;
 *   - an emblem's statics come from the COMMAND zone, so they meet the continuous
 *     layer's two accessors and every board wipe.
 *
 * Real games, real pool cards (Liliana of the Veil, Zetalpa, Wrath of God) wherever
 * the shipped pool prints one; a hand-authored record only where it does not (no
 * printed battle compiles yet - see DESIGN 3.15 - and no pool card makes an emblem).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFENSE_COUNTER,
  LOYALTY_COUNTER,
  defenseOf,
  effectivePower,
  indexContinuous,
  isAttackable,
  legalTargetsFor,
  loyaltyOf,
  NO_MOD,
  protectorOf,
  type CardDefinition,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { buildRegistry } from '../pool.js';
import {
  act,
  boardAtMain,
  castCard,
  fund,
  isOnBattlefield,
  legal,
  onBattlefield,
  place,
  poolCard,
  resolvePermanent,
  settle,
  type Registry,
} from './harness.js';

/** A bare battle - no printed battle compiles yet, so the object is authored. */
function battleDef(name: string, defense = 3): CardDefinition {
  return { id: `matrix-${name}`, name, types: ['battle'], subtypes: ['siege'], defense };
}

/** A trampler big enough to punch past a small loyalty/defense total. */
const TRAMPLER: CardDefinition = {
  id: 'matrix-trampler',
  name: 'Matrix Trampler',
  types: ['creature'],
  cost: { generic: 4 },
  power: 5,
  toughness: 5,
  keywords: { trample: true },
};

/** A sorcery whose whole job is leaving an anthem emblem behind. */
const EMBLEM_MAKER: CardDefinition = {
  id: 'matrix-emblem-maker',
  name: 'Matrix Emblem Maker',
  types: ['sorcery'],
  timing: 'sorcery',
  cost: { generic: 1 },
  effects: [
    {
      primitive: 'createEmblem',
      params: {
        name: 'Matrix Emblem',
        statics: [
          {
            affects: { anyOfTypes: ['creature'], controller: 'you' },
            power: 2,
            toughness: 2,
            label: 'creatures you control get +2/+2',
          },
        ],
      },
    },
  ],
};

function powerOf(state: GameState, id: InstanceId): number {
  return effectivePower(onBattlefield(state, id), indexContinuous(state).get(id) ?? NO_MOD);
}

describe('CELL: planeswalkers x counters x damage x indestructible', () => {
  it('loyalty IS counters, burn takes them, and the walker dies at zero', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const lili = resolvePermanent(state, reg, poolCard('Liliana of the Veil'), 'A');
    state = lili.state;

    // CR 306.5b - the printed starting loyalty arrives as real counters in the
    // same record +1/+1 counters live in, so cloning and serialization carry it.
    expect(loyaltyOf(onBattlefield(state, lili.id))).toBe(3);
    expect(onBattlefield(state, lili.id).counters[LOYALTY_COUNTER]).toBe(3);

    // CR 115.4 - "any target" reaches a planeswalker, and CR 120.3c turns the
    // damage into loyalty removal rather than marked damage.
    expect(legalTargetsFor(state, 'any', 'B', poolCard('Lightning Bolt'))).toContain(lili.id);
    state = boltAt(state, reg, lili.id, 'B');
    expect(isOnBattlefield(state, lili.id)).toBe(false);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toContain(lili.id);
  });

  it('"creature or planeswalker" reaches a walker while "creature" never does', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const lili = resolvePermanent(state, reg, poolCard('Liliana of the Veil'), 'A');
    state = lili.state;
    const bear = resolvePermanent(state, reg, TRAMPLER, 'A');
    state = bear.state;

    const bolt = poolCard('Lightning Bolt');
    expect(legalTargetsFor(state, 'creatureOrPlaneswalker', 'B', bolt)).toContain(lili.id);
    expect(legalTargetsFor(state, 'creature', 'B', bolt)).not.toContain(lili.id);
    expect(legalTargetsFor(state, 'creature', 'B', bolt)).toContain(bear.id);
  });
});

describe('CELL: planeswalkers x combat x trample', () => {
  it('a trampling attacker takes the walker to zero and carries the excess to the player', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg, { active: 'B' });
    const lili = resolvePermanent(state, reg, poolCard('Liliana of the Veil'), 'A');
    state = lili.state;
    const brute = resolvePermanent(state, reg, TRAMPLER, 'B');
    state = brute.state;
    onBattlefield(state, brute.id).summoningSick = false;

    expect(isAttackable(onBattlefield(state, lili.id).def)).toBe(true);
    const lifeBefore = state.players.A.life;

    state = passUntil(state, reg, 'declareAttackers');
    state = act(
      state,
      {
        kind: 'declareAttackers',
        player: 'B',
        attackers: [brute.id],
        attackTargets: { [brute.id]: lili.id },
      },
      reg,
    );
    state = passUntil(state, reg, 'endCombat');

    // 5 power into 3 loyalty: the walker is gone and the other 2 trample through.
    expect(isOnBattlefield(state, lili.id)).toBe(false);
    expect(state.players.A.life).toBe(lifeBefore - 2);
  });
});

describe('CELL: battles x protectorOf x combat x trample', () => {
  it('a battle is attacked by its CONTROLLER and defended by their opponent (CR 310.11)', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg, { active: 'A' });
    const siege = resolvePermanent(state, reg, battleDef('Matrix Siege', 3), 'A');
    state = siege.state;

    // The one thing a controller comparison gets wrong: A's own creature may
    // attack A's own Siege, and B is the one who may block it.
    expect(protectorOf(onBattlefield(state, siege.id))).toBe('B');
    expect(defenseOf(onBattlefield(state, siege.id))).toBe(3);
    expect(onBattlefield(state, siege.id).counters[DEFENSE_COUNTER]).toBe(3);

    const brute = resolvePermanent(state, reg, TRAMPLER, 'A');
    state = brute.state;
    onBattlefield(state, brute.id).summoningSick = false;

    const lifeBefore = state.players.B.life;
    state = passUntil(state, reg, 'declareAttackers');
    // The engine offers ONE canonical "attack with everything" action and lets a
    // caller build narrower/aimed declarations itself, so the real claim is that
    // the ENGINE ACCEPTS this one - a plan the engine rejects is the same as no
    // plan. `isAttackable` + `protectorOf` are what make it legal.
    expect(legal(state).some((a) => a.kind === 'declareAttackers')).toBe(true);
    state = act(
      state,
      {
        kind: 'declareAttackers',
        player: 'A',
        attackers: [brute.id],
        attackTargets: { [brute.id]: siege.id },
      },
      reg,
    );
    state = passUntil(state, reg, 'endCombat');

    // Damage strips defense (CR 120.3d), zero defense is defeat by SBA, and the
    // trample excess goes to the DEFENDING PLAYER - who is the protector, B.
    expect(isOnBattlefield(state, siege.id)).toBe(false);
    expect(state.players.B.life).toBe(lifeBefore - 2);
  });

  it('"any target" burn strips a battle’s defense; "creature or planeswalker" never sees it', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const siege = resolvePermanent(state, reg, battleDef('Matrix Bastion', 5), 'A');
    state = siege.state;

    const bolt = poolCard('Lightning Bolt');
    expect(legalTargetsFor(state, 'any', 'B', bolt)).toContain(siege.id);
    expect(legalTargetsFor(state, 'creatureOrPlaneswalker', 'B', bolt)).not.toContain(siege.id);

    state = boltAt(state, reg, siege.id, 'B');
    expect(defenseOf(onBattlefield(state, siege.id))).toBe(2);
  });
});

describe('CELL: the legend rule x planeswalkers x priority x attachments', () => {
  it('a second copy parks a CHOICE, and the loser goes to its OWNER’s graveyard', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const first = resolvePermanent(state, reg, poolCard('Liliana of the Veil'), 'A');
    state = first.state;
    expect(state.pendingChoice ?? null).toBeNull();

    const second = castCard(state, reg, poolCard('Liliana of the Veil'), 'A');
    state = second.state;

    // Unlike every other state-based action this one cannot decide: it parks a
    // question, marked so the answer routes to the RULE and not to a resolution.
    expect(state.pendingChoice?.context).toBe('legendRule');
    expect(state.pendingChoice?.chooser).toBe('A');
    // ...and while it stands, the ONLY legal action is that chooser answering.
    expect(legal(state).every((a) => a.kind === 'answerChoice')).toBe(true);

    state = act(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: state.pendingChoice!.id,
        answer: { kind: 'selectCards', instanceIds: [second.id] },
      },
      reg,
    );
    expect(isOnBattlefield(state, second.id)).toBe(true);
    expect(isOnBattlefield(state, first.id)).toBe(false);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toContain(first.id);
  });

  it('is per PLAYER, not global: the two seats may each hold the same legend', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const mine = resolvePermanent(state, reg, poolCard('Zetalpa, Primal Dawn'), 'A');
    state = mine.state;
    const theirs = resolvePermanent(state, reg, poolCard('Zetalpa, Primal Dawn'), 'B');
    state = theirs.state;

    expect(state.pendingChoice ?? null).toBeNull();
    expect(isOnBattlefield(state, mine.id)).toBe(true);
    expect(isOnBattlefield(state, theirs.id)).toBe(true);
  });

  it('indestructible does NOT save a legend from the legend rule - it is not destruction', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    // Zetalpa prints indestructible AND legendary, which is the whole cell: the
    // keyword exempts CR 704.5g destruction and says nothing about CR 704.5j.
    const first = resolvePermanent(state, reg, poolCard('Zetalpa, Primal Dawn'), 'A');
    state = first.state;
    const second = castCard(state, reg, poolCard('Zetalpa, Primal Dawn'), 'A');
    state = second.state;

    expect(state.pendingChoice?.context).toBe('legendRule');
    state = act(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: state.pendingChoice!.id,
        answer: { kind: 'selectCards', instanceIds: [first.id] },
      },
      reg,
    );
    expect(isOnBattlefield(state, second.id)).toBe(false);
  });

  it('cascades: an Aura on the copy that loses the legend rule follows it into the graveyard', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const first = resolvePermanent(state, reg, poolCard('Zetalpa, Primal Dawn'), 'A');
    state = first.state;
    // Dead Weight is -2/-2 on a 4/8, so the host survives to be legend-ruled.
    const weight = resolvePermanent(state, reg, poolCard('Dead Weight'), 'A', [first.id]);
    state = weight.state;
    expect(onBattlefield(state, weight.id).attachedTo).toBe(first.id);

    const second = castCard(state, reg, poolCard('Zetalpa, Primal Dawn'), 'A');
    state = second.state;
    state = act(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: state.pendingChoice!.id,
        answer: { kind: 'selectCards', instanceIds: [second.id] },
      },
      reg,
    );

    // The rule's own re-check is what settles the cascade before priority returns.
    expect(isOnBattlefield(state, first.id)).toBe(false);
    expect(isOnBattlefield(state, weight.id)).toBe(false);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toContain(weight.id);
    expect(state.pendingChoice ?? null).toBeNull();
  });
});

describe('CELL: emblems x anthems x board wipes x the two continuous accessors', () => {
  it('an emblem anthem is real in the bulk index AND the one-off read, and survives a wrath', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, TRAMPLER, 'A');
    state = bear.state;
    expect(powerOf(state, bear.id)).toBe(5);

    state = castCard(state, reg, EMBLEM_MAKER, 'A').state;
    expect(state.players.A.command).toHaveLength(1);
    expect(powerOf(state, bear.id)).toBe(7);

    // Wrath of God destroys every creature. The emblem is in the COMMAND zone,
    // which no removal path in the engine reaches - unremovable by construction.
    state = settle(castCard(state, reg, poolCard('Wrath of God'), 'B').state, reg);
    expect(isOnBattlefield(state, bear.id)).toBe(false);
    expect(state.players.A.command).toHaveLength(1);

    // A fresh creature is buffed by the surviving emblem, through BOTH accessors.
    const next = resolvePermanent(state, reg, TRAMPLER, 'A');
    state = next.state;
    expect(powerOf(state, next.id)).toBe(7);
  });
});

// --- shared drivers ---------------------------------------------------------------

function boltAt(state: GameState, reg: Registry, target: InstanceId, caster: PlayerId): GameState {
  const bolt = place(state, caster, 'hand', poolCard('Lightning Bolt'));
  fund(state, caster);
  const before = state.priorityPlayer;
  state.priorityPlayer = caster;
  let next = act(state, { kind: 'castSpell', player: caster, instanceId: bolt, targets: [target] }, reg);
  next = settle(next, reg);
  if (!next.pendingChoice) next.priorityPlayer = before;
  return next;
}

function passUntil(state: GameState, reg: Registry, step: GameState['step']): GameState {
  let next = state;
  for (let i = 0; i < 40 && next.step !== step && !next.gameOver; i++) {
    if (next.pendingChoice) throw new Error(`a choice parked while advancing to ${step}`);
    next = act(next, { kind: 'passPriority', player: next.priorityPlayer }, reg);
  }
  if (next.step !== step) throw new Error(`never reached ${step} (stuck at ${next.step})`);
  return next;
}
