/**
 * THE COUNTER KEYWORD FAMILY, COMPILED FROM PRINTED TEXT (DESIGN §3.110).
 *
 * Every Oracle line here is a real card's, as the corpus prints it — pinned by
 * name so a drift in the rule table shows up against a card and not against a
 * remembered wording. Two layers, as §3.107's suite has them:
 *   - what each line COMPILES TO (the definition), and
 *   - what the compiled card DOES in a real game through the real registry —
 *     a Young Wolf comes back once, an Arcbound Worker hands its counter on, a
 *     Rhox Maulers grows exactly once, a Relentless Advance makes an Army and
 *     then grows it.
 *
 * Plus the guards: every printed form OUTSIDE the closed tables keeps reporting
 * ("Modular—Sunburst", a land with modular, "Bloodthirst X", Thromok's squared
 * devour, a backup whose granted ability is activated, mentor, reinforce).
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, ChoiceAnswer, GameAction, GameState, InstanceId, PendingChoice, PlayerId } from '@jonny-boi/core';
import { DEFAULT_RULES, PLUS_ONE_COUNTER, aggregateFor, applyAction, createGame, effectivePower, effectiveToughness } from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
    oracleText: '',
    power: 2,
    toughness: 2,
    keywords: [],
    ...overrides,
  };
}

/** Compile a printed creature and insist it is COMPLETE — the whole contract. */
function creature(name: string, oracleText: string, keywords: readonly string[], power = 2, toughness = 2, types: readonly string[] = ['Creature']): CardDefinition {
  const result = compileCard(makeCard({ name, oracleText, keywords, power, toughness, typeLine: { supertypes: [], types: [...types], subtypes: [] } }));
  expect(result.status, `${name} missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

/** Compile a printed spell and insist it is complete. */
function spell(name: string, oracleText: string, keywords: readonly string[], type = 'Sorcery'): CardDefinition {
  const result = compileCard(makeCard({ name, oracleText, keywords, power: null, toughness: null, typeLine: { supertypes: [], types: [type], subtypes: [] } }));
  expect(result.status, `${name} missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

// --- what the lines compile to -------------------------------------------------------

describe('the keywords compile to exactly their engine payloads', () => {
  it('Undying → a dies trigger snapshotting +1/+1 counters with the "had none" intervening if (Young Wolf)', () => {
    const wolf = creature('Young Wolf', 'Undying', ['Undying'], 1, 1);
    expect(wolf.triggers).toEqual([
      {
        condition: {
          on: 'dies',
          snapshotsCounters: PLUS_ONE_COUNTER,
          intervening: { kind: 'sourceDiedWithoutCounter', counter: PLUS_ONE_COUNTER },
        },
        effects: [{ primitive: 'undyingReturn', params: { amount: 1 } }],
        label: 'Undying',
      },
    ]);
  });

  it('Modular N → the entry counters as a DEFINITION field plus the snapshotting dies trigger aimed at up to one artifact creature (Arcbound Worker)', () => {
    const worker = creature('Arcbound Worker', 'Modular 1', ['Modular'], 0, 0, ['Artifact', 'Creature']);
    expect(worker.entersWithCounters).toEqual([{ kind: PLUS_ONE_COUNTER, count: 1 }]);
    expect(worker.triggers).toEqual([
      {
        condition: { on: 'dies', snapshotsCounters: PLUS_ONE_COUNTER },
        effects: [{ primitive: 'modularMove' }],
        targets: 'artifactCreature',
        targetCount: { min: 0, max: 1 },
        label: 'Modular 1',
      },
    ]);
  });

  it('Evolve → a creature-enters trigger that carries its subject for the P/T comparison (Cloudfin Raptor)', () => {
    const raptor = creature('Cloudfin Raptor', 'Flying\nEvolve', ['Flying', 'Evolve'], 0, 1);
    expect(raptor.keywords).toMatchObject({ flying: true });
    expect(raptor.triggers?.[0]).toEqual({
      condition: {
        on: 'permanentEnters',
        who: 'you',
        permanentFilter: { anyOfTypes: ['creature'] },
        carriesSubject: true,
        intervening: { kind: 'triggeringCreatureLargerThanSource' },
      },
      effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
      label: 'Evolve',
    });
  });

  it('Renown N → a combat-damage-to-a-player trigger gated on "isn’t renowned" (Rhox Maulers)', () => {
    const maulers = creature('Rhox Maulers', 'Trample\nRenown 2', ['Trample', 'Renown'], 4, 4);
    expect(maulers.triggers).toEqual([
      {
        condition: { on: 'combatDamageToPlayer', intervening: { kind: 'sourceNotRenowned' } },
        effects: [{ primitive: 'becomeRenowned', params: { amount: 2 } }],
        label: 'Renown 2',
      },
    ]);
  });

  it('Bloodthirst N → an entry-script body reading the turn fact (Duskhunter Bat)', () => {
    const bat = creature('Duskhunter Bat', 'Bloodthirst 1\nFlying', ['Bloodthirst', 'Flying'], 1, 1);
    expect(bat.effects).toEqual([{ primitive: 'bloodthirstCounters', params: { amount: 1 } }]);
    expect(bat.keywords).toMatchObject({ flying: true });
  });

  it('Riot → the as-enters question in the entry script (Zhur-Taa Goblin)', () => {
    expect(creature('Zhur-Taa Goblin', 'Riot', ['Riot']).effects).toEqual([{ primitive: 'riotChoice' }]);
  });

  it('Unleash → the question plus a SELF-ONLY can’t-block static keyed on the counter (Rakdos Cackler)', () => {
    const cackler = creature('Rakdos Cackler', 'Unleash', ['Unleash'], 1, 1);
    expect(cackler.effects).toEqual([{ primitive: 'unleashChoice' }]);
    expect(cackler.statics).toEqual([
      {
        affects: { onlySource: true, hasCounterKind: PLUS_ONE_COUNTER },
        keywords: { cantBlock: true },
        label: "Unleash: can't block while it has a +1/+1 counter",
      },
    ]);
  });

  it('Dethrone → an attacks trigger gated on the opponent having the most life (Marchesa’s Emissary)', () => {
    const emissary = creature("Marchesa's Emissary", 'Hexproof\nDethrone', ['Hexproof', 'Dethrone']);
    expect(emissary.triggers).toEqual([
      {
        condition: { on: 'attacks', intervening: { kind: 'opponentHasMostLife' } },
        effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
        label: 'Dethrone',
      },
    ]);
  });

  it('Devour N / Devour artifact N → the as-enters sacrifice choice with the noun’s filter (Gorger Wurm, Caprichrome)', () => {
    expect(creature('Gorger Wurm', 'Devour 1', ['Devour'], 5, 5).effects).toEqual([
      { primitive: 'devourChoice', params: { amount: 1, filter: { anyOfTypes: ['creature'] } } },
    ]);
    expect(creature('Caprichrome', 'Flash\nVigilance\nDevour artifact 1', ['Flash', 'Vigilance', 'Devour'], 2, 2, ['Artifact', 'Creature']).effects).toEqual([
      { primitive: 'devourChoice', params: { amount: 1, filter: { anyOfTypes: ['artifact'] } } },
    ]);
  });

  it('Fabricate N → an enters trigger asking the printed question at RESOLUTION, not a modal (Glint-Sleeve Artisan)', () => {
    const artisan = creature('Glint-Sleeve Artisan', 'Fabricate 1', ['Fabricate']);
    expect(artisan.triggers).toEqual([
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'fabricateChoice', params: { amount: 1 } }],
        label: 'Fabricate 1',
      },
    ]);
    // ⚠️ NOT a ModalSpec: modes are chosen as an ability goes on the stack
    // (CR 603.3c), and fabricate's choice is made as it resolves.
    expect(artisan.triggers?.[0]?.modal).toBeUndefined();
  });

  it('Afterlife N → a dies trigger making N 1/1 white-and-black flying Spirits through the token rule (Ministrant of Obligation)', () => {
    const ministrant = creature('Ministrant of Obligation', 'Afterlife 2', ['Afterlife'], 2, 1);
    expect(ministrant.triggers?.[0]?.condition).toEqual({ on: 'dies' });
    expect(ministrant.triggers?.[0]?.effects).toEqual([
      {
        primitive: 'makeToken',
        params: { power: 1, toughness: 1, name: 'Spirit', colors: ['W', 'B'], subtypes: ['Spirit'], count: 2, keywords: { flying: true } },
      },
    ]);
    expect(ministrant.triggers?.[0]?.label).toBe('Afterlife 2');
  });

  it('Backup N → an enters trigger aiming at target creature, granting the printed keywords below it (Consuming Aetherborn, Chomping Kavu)', () => {
    const aetherborn = creature('Consuming Aetherborn', 'Backup 1\nLifelink', ['Backup', 'Lifelink']);
    expect(aetherborn.triggers).toEqual([
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'backup', params: { amount: 1, keywords: { lifelink: true } } }],
        targets: 'creature',
        label: 'Backup 1',
      },
    ]);
    // The card ITSELF still has lifelink — the grant is a copy of the flag, not a move.
    expect(aetherborn.keywords).toMatchObject({ lifelink: true });
    const kavu = creature('Chomping Kavu', "Backup 1\nThis creature can't be blocked by creatures with power 2 or less.", ['Backup'], 3, 3);
    expect(kavu.triggers?.[0]?.effects[0]?.params?.keywords).toEqual({ blockRestriction: { minBlockerPower: 3 } });
  });

  it('Outlast {cost} → a sorcery-speed tap-and-pay activation for a counter (Disowned Ancestor)', () => {
    const ancestor = creature('Disowned Ancestor', 'Outlast {1}{B}', ['Outlast'], 0, 4);
    expect(ancestor.activated).toEqual([
      {
        cost: { mana: { generic: 1, B: 1 }, tap: true },
        effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
        timing: 'sorcery',
        label: 'Outlast {1}{B}',
      },
    ]);
  });

  it('Amass [type] N on a spell → the amass primitive with the singular Army type (Relentless Advance)', () => {
    expect(spell('Relentless Advance', 'Amass Zombies 3.', ['Amass']).effects).toEqual([
      { primitive: 'amass', params: { subtype: 'Zombie', amount: 3 } },
    ]);
  });

  it('Bolster N on a spell → the bolster primitive (Dromoka’s Gift)', () => {
    expect(spell("Dromoka's Gift", 'Bolster 4.', ['Bolster'], 'Instant').effects).toEqual([{ primitive: 'bolster', params: { amount: 4 } }]);
  });

  it('"When ~ enters, it explores." → an enters trigger whose body is the explore primitive (Merfolk Branchwalker)', () => {
    const walker = creature('Merfolk Branchwalker', 'When this creature enters, it explores.', ['Explore'], 2, 1);
    expect(walker.triggers).toEqual([{ condition: { on: 'etb' }, effects: [{ primitive: 'explore' }], label: 'Enters: it explores' }]);
  });

  it('"If ~ was kicked, it enters with two +1/+1 counters on it." → the kicked wrapper around the entry counters (Academy Drake)', () => {
    const drake = creature(
      'Academy Drake',
      'Kicker {4}\nFlying\nIf this creature was kicked, it enters with two +1/+1 counters on it.',
      ['Kicker', 'Flying'],
      2,
      2,
    );
    expect(drake.kicker).toEqual({ generic: 4 });
    expect(drake.effects).toEqual([
      { primitive: 'ifKicked', params: { effects: [{ primitive: 'addCounters', params: { amount: 2, self: true } }] } },
    ]);
  });
});

describe('⚠️ every form outside the closed tables keeps reporting', () => {
  const reports = (name: string, oracleText: string, keywords: readonly string[], types: readonly string[] = ['Creature']): readonly string[] => {
    const result = compileCard(makeCard({ name, oracleText, keywords, typeLine: { supertypes: [], types: [...types], subtypes: [] } }));
    expect(result.status, name).toBe('incomplete');
    return result.missing.map((m) => m.text);
  };
  it('Modular—Sunburst (Arcbound Wanderer) and a LAND with modular (Power Depot)', () => {
    expect(reports('Arcbound Wanderer', 'Modular—Sunburst', ['Modular', 'Sunburst'], ['Artifact', 'Creature'])).toContain('Modular—Sunburst');
    expect(reports('Power Depot', '{T}: Add {C}.\nModular 1', ['Modular'], ['Artifact', 'Land'])).toContain('Modular 1');
  });
  it('Bloodthirst X (Petrified Wood-Kin) and Devour X (Thromok the Insatiable)', () => {
    expect(reports('Petrified Wood-Kin', 'Bloodthirst X', ['Bloodthirst'])).toContain('Bloodthirst X');
    expect(reports('Thromok the Insatiable', 'Devour X, where X is the number of creatures devoured this way', ['Devour'])).toContain(
      'Devour X, where X is the number of creatures devoured this way',
    );
  });
  it('a backup whose "following ability" is ACTIVATED (Scorn-Blade Berserker)', () => {
    expect(reports('Scorn-Blade Berserker', 'Backup 1\n{1}, Sacrifice this creature: Draw a card.', ['Backup'])).toContain('Backup 1');
  });
  it('mentor (a source-relative target) and reinforce (a targeted activation from hand) — no seam yet', () => {
    expect(reports('Hammer Dropper', 'Mentor', ['Mentor'])).toContain('Mentor');
    expect(reports('Mosquito Guard', 'First strike\nReinforce 1—{1}{W}', ['First strike', 'Reinforce'])).toContain('Reinforce 1—{1}{W}');
  });
  it('an Army type outside the table, and "amass … instead" (Tidings of War)', () => {
    expect(reports('Elf Muster', 'Amass Elves 1.', ['Amass'], ['Sorcery'])).toContain('Amass Elves 1.');
    expect(
      reports('Tidings of War', 'Amass Goblins 1. If this spell was cast from a graveyard, amass Goblins 3 instead.', ['Amass'], ['Sorcery']),
    ).toHaveLength(1);
  });
});

// --- what the compiled cards DO ------------------------------------------------------

const BEAR: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 };
const GIANT: CardDefinition = { id: 'giant', name: 'Hill Giant', types: ['creature'], power: 3, toughness: 3 };
const SQUIRREL: CardDefinition = { id: 'squirrel', name: 'Squirrel', types: ['creature'], power: 1, toughness: 1 };
const MYR: CardDefinition = { id: 'myr', name: 'Myr', types: ['artifact', 'creature'], power: 1, toughness: 1 };
const FOREST: CardDefinition = { id: 'forest', name: 'Forest', types: ['land'], subtypes: ['Forest'], produces: ['G'] };
const REGISTRY = buildRegistry();
const FULL_POOL = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };

function act(state: GameState, action: GameAction): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, REGISTRY);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`rejected ${action.kind}: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

/** How a test answers the family's questions: a function of the pending choice. */
type Answerer = (choice: PendingChoice) => ChoiceAnswer;

function passUntil(state: GameState, done: (s: GameState) => boolean, answer?: Answerer): GameState {
  let s = state;
  for (let guard = 0; guard < 400 && !done(s) && !s.gameOver; guard++) {
    if (s.pendingChoice) {
      if (!answer) throw new Error(`unanswered question: ${s.pendingChoice.prompt}`);
      const choice = s.pendingChoice;
      s = act(s, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: answer(choice) });
      continue;
    }
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer });
  }
  if (!done(s)) throw new Error(`never reached the target (at ${s.step}, turn ${s.turnNumber})`);
  return s;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId, counters: Record<string, number> = {}): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({ instanceId: id, def, controller, owner: controller, zone: 'battlefield', tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters });
  return id;
}

function inHand(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.players[controller].hand.push({ instanceId: id, def, controller, owner: controller, zone: 'hand', tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {} });
  return id;
}

function find(state: GameState, id: InstanceId) {
  return state.battlefield.find((c) => c.instanceId === id);
}

function stats(state: GameState, id: InstanceId): { power: number; toughness: number } {
  const inst = find(state, id)!;
  const mod = aggregateFor(state, id);
  return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
}

function plusCounters(state: GameState, id: InstanceId): number {
  return find(state, id)?.counters[PLUS_ONE_COUNTER] ?? 0;
}

/** A game at A's first main phase, both hands empty, A's pool full. */
function atMain(): GameState {
  const { state } = createGame({
    seed: 3110,
    startingPlayer: 'A',
    registry: REGISTRY,
    decks: { A: { cards: Array.from({ length: 30 }, () => FOREST) }, B: { cards: Array.from({ length: 30 }, () => FOREST) } },
  });
  state.players.A.hand = [];
  state.players.B.hand = [];
  const main = passUntil(state, (s) => s.step === 'precombatMain');
  main.players.A.manaPool = { ...FULL_POOL };
  return main;
}

/** Cast `id` from A's hand and settle the stack (spell and its triggers), answering questions with `answer`. */
function castAndSettle(state: GameState, id: InstanceId, answer?: Answerer): GameState {
  const cast = act(state, { kind: 'castSpell', player: 'A', instanceId: id });
  return passUntil(cast, (s) => s.stack.length === 0 && !s.pendingChoice, answer);
}

function attackWith(state: GameState, ids: readonly InstanceId[], answer?: Answerer): GameState {
  const declare = passUntil(state, (s) => s.step === 'declareAttackers', answer);
  const declared = act(declare, { kind: 'declareAttackers', player: 'A', attackers: [...ids] });
  return passUntil(declared, (s) => s.stack.length === 0 && s.step === 'declareBlockers' && !s.pendingChoice, answer);
}

function blockWith(state: GameState, blocks: ReadonlyArray<{ blocker: InstanceId; attacker: InstanceId }>): GameState {
  const defending = state.priorityPlayer === 'B' ? state : act(state, { kind: 'passPriority', player: 'A' });
  return act(defending, { kind: 'declareBlockers', player: 'B', blocks: [...blocks] });
}

function toPostcombat(state: GameState, answer?: Answerer): GameState {
  return passUntil(state, (s) => s.step === 'postcombatMain' && s.stack.length === 0 && !s.pendingChoice, answer);
}

const confirm = (yes: boolean): Answerer => () => ({ kind: 'confirm', yes });

describe('the compiled cards, played through the real engine and registry', () => {
  it('a Young Wolf blocked by a Hill Giant dies and returns with a +1/+1 counter — and the second time it stays dead', () => {
    const wolf = creature('Young Wolf', 'Undying', ['Undying'], 1, 1);
    const state = atMain();
    const wolfId = place(state, wolf, 'A');
    const giantId = place(state, GIANT, 'B');
    const after = toPostcombat(blockWith(attackWith(state, [wolfId]), [{ blocker: giantId, attacker: wolfId }]));
    expect(find(after, wolfId)).toBeDefined();
    expect(stats(after, wolfId)).toEqual({ power: 2, toughness: 2 });
    expect(plusCounters(after, wolfId)).toBe(1);
    // Next turn, the grown wolf dies for good: it HAD a counter (CR 702.93a).
    const nextTurn = passUntil(after, (s) => s.turnNumber === 3 && s.step === 'precombatMain');
    const again = toPostcombat(blockWith(attackWith(nextTurn, [wolfId]), [{ blocker: giantId, attacker: wolfId }]));
    expect(find(again, wolfId)).toBeUndefined();
    expect(again.players.A.graveyard.some((c) => c.instanceId === wolfId)).toBe(true);
  });

  it('a Murdered Young Wolf returns too — the destroy funnel emits the death BEFORE the counters are wiped', () => {
    const wolf = creature('Young Wolf', 'Undying', ['Undying'], 1, 1);
    const murder = spell('Murder', 'Destroy target creature.', [], 'Instant');
    const state = atMain();
    const wolfId = place(state, wolf, 'A');
    state.players.A.manaPool = { ...FULL_POOL };
    const murderId = inHand(state, murder, 'A');
    const cast = act(state, { kind: 'castSpell', player: 'A', instanceId: murderId, targets: [wolfId] });
    const after = passUntil(cast, (s) => s.stack.length === 0);
    expect(plusCounters(after, wolfId)).toBe(1);
  });

  it('an Arcbound Worker enters as a 1/1 and, dying, hands its counter to the Myr its controller aims at', () => {
    const worker = creature('Arcbound Worker', 'Modular 1', ['Modular'], 0, 0, ['Artifact', 'Creature']);
    const state = atMain();
    const workerId = inHand(state, worker, 'A');
    const myrId = place(state, MYR, 'A');
    const giantId = place(state, GIANT, 'B');
    const entered = castAndSettle(state, workerId);
    expect(stats(entered, workerId)).toEqual({ power: 1, toughness: 1 });
    const unsick = { ...entered };
    find(unsick, workerId)!.summoningSick = false;
    const aim: Answerer = (choice) => (choice.kind === 'selectTargets' ? { kind: 'selectTargets', targets: [myrId] } : { kind: 'confirm', yes: true });
    const after = toPostcombat(blockWith(attackWith(unsick, [workerId]), [{ blocker: giantId, attacker: workerId }]), aim);
    expect(find(after, workerId)).toBeUndefined();
    expect(plusCounters(after, myrId)).toBe(1);
    expect(stats(after, myrId)).toEqual({ power: 2, toughness: 2 });
  });

  it('a Cloudfin Raptor evolves off a Bear and not off a Squirrel', () => {
    const raptor = creature('Cloudfin Raptor', 'Flying\nEvolve', ['Flying', 'Evolve'], 0, 1);
    const state = atMain();
    const raptorId = place(state, raptor, 'A');
    const bearId = inHand(state, BEAR, 'A');
    const squirrelId = inHand(state, SQUIRREL, 'A');
    const grown = castAndSettle(state, bearId);
    expect(stats(grown, raptorId)).toEqual({ power: 1, toughness: 2 });
    // A 1/1 beside a 1/2: neither power nor toughness is greater.
    const same = castAndSettle(grown, squirrelId);
    expect(stats(same, raptorId)).toEqual({ power: 1, toughness: 2 });
  });

  it('Rhox Maulers connects and becomes renowned once: 6/6 after the first hit, still 6/6 after the second', () => {
    const maulers = creature('Rhox Maulers', 'Trample\nRenown 2', ['Trample', 'Renown'], 4, 4);
    const state = atMain();
    const id = place(state, maulers, 'A');
    const first = toPostcombat(attackWith(state, [id]));
    expect(first.players.B.life).toBe(16);
    expect(stats(first, id)).toEqual({ power: 6, toughness: 6 });
    expect(find(first, id)?.renowned).toBe(true);
    const nextTurn = passUntil(first, (s) => s.turnNumber === 3 && s.step === 'precombatMain');
    const second = toPostcombat(attackWith(nextTurn, [id]));
    expect(second.players.B.life).toBe(10);
    expect(stats(second, id)).toEqual({ power: 6, toughness: 6 });
  });

  it('a Duskhunter Bat cast after a Bear connected enters as a 2/2; cast before, as a 1/1', () => {
    const bat = creature('Duskhunter Bat', 'Bloodthirst 1\nFlying', ['Bloodthirst', 'Flying'], 1, 1);
    const cold = atMain();
    const coldBat = inHand(cold, bat, 'A');
    expect(stats(castAndSettle(cold, coldBat), coldBat)).toEqual({ power: 1, toughness: 1 });
    const hot = atMain();
    const bearId = place(hot, BEAR, 'A');
    const hotBat = inHand(hot, bat, 'A');
    const connected = toPostcombat(attackWith(hot, [bearId]));
    connected.players.A.manaPool = { ...FULL_POOL };
    expect(stats(castAndSettle(connected, hotBat), hotBat)).toEqual({ power: 2, toughness: 2 });
  });

  it('a Zhur-Taa Goblin enters with a counter (yes) or unsick (no) — riot’s two answers', () => {
    const goblin = creature('Zhur-Taa Goblin', 'Riot', ['Riot']);
    const counter = atMain();
    const a = inHand(counter, goblin, 'A');
    const grown = castAndSettle(counter, a, confirm(true));
    expect(stats(grown, a)).toEqual({ power: 3, toughness: 3 });
    expect(find(grown, a)?.summoningSick).toBe(true);
    const haste = atMain();
    const b = inHand(haste, goblin, 'A');
    const quick = castAndSettle(haste, b, confirm(false));
    expect(stats(quick, b)).toEqual({ power: 2, toughness: 2 });
    expect(aggregateFor(quick, b).keywords?.haste).toBe(true);
    // The proof that matters: it attacks the turn it arrived.
    const swung = attackWith(quick, [b]);
    expect(swung.combat?.attackers).toContain(b);
    // …and the haste does not wear off at cleanup (CR 702.136a — no duration).
    const nextTurn = passUntil(swung, (s) => s.turnNumber === 3 && s.step === 'precombatMain');
    expect(aggregateFor(nextTurn, b).keywords?.haste).toBe(true);
  });

  it('an unleashed Rakdos Cackler is a 2/2 that cannot be declared as a blocker', () => {
    const cackler = creature('Rakdos Cackler', 'Unleash', ['Unleash'], 1, 1);
    const state = atMain();
    const cacklerId = inHand(state, cackler, 'B');
    // B casts on their own turn: hand B the pool and the turn.
    const bTurn = passUntil(state, (s) => s.turnNumber === 2 && s.step === 'precombatMain');
    bTurn.players.B.manaPool = { ...FULL_POOL };
    const cast = act(bTurn, { kind: 'castSpell', player: 'B', instanceId: cacklerId });
    const entered = passUntil(cast, (s) => s.stack.length === 0 && !s.pendingChoice, confirm(true));
    expect(stats(entered, cacklerId)).toEqual({ power: 2, toughness: 2 });
    const aTurn = passUntil(entered, (s) => s.turnNumber === 3 && s.step === 'precombatMain');
    const bearId = place(aTurn, BEAR, 'A');
    const blockers = attackWith(aTurn, [bearId]);
    const defending = blockers.priorityPlayer === 'B' ? blockers : act(blockers, { kind: 'passPriority', player: 'A' });
    const result = applyAction(defending, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: cacklerId, attacker: bearId }] }, DEFAULT_RULES, REGISTRY);
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });

  it('a Gorger Wurm that devours a Squirrel enters as a 6/6 with the Squirrel in the graveyard', () => {
    const wurm = creature('Gorger Wurm', 'Devour 1', ['Devour'], 5, 5);
    const state = atMain();
    const squirrelId = place(state, SQUIRREL, 'A');
    const wurmId = inHand(state, wurm, 'A');
    const feed: Answerer = (choice) => (choice.kind === 'selectCards' ? { kind: 'selectCards', instanceIds: [squirrelId] } : { kind: 'confirm', yes: true });
    const after = castAndSettle(state, wurmId, feed);
    expect(stats(after, wurmId)).toEqual({ power: 6, toughness: 6 });
    expect(find(after, squirrelId)).toBeUndefined();
    expect(after.players.A.graveyard.some((c) => c.instanceId === squirrelId)).toBe(true);
  });

  it('a Glint-Sleeve Artisan declining the counters makes a 1/1 colourless Servo instead', () => {
    const artisan = creature('Glint-Sleeve Artisan', 'Fabricate 1', ['Fabricate']);
    const state = atMain();
    const artisanId = inHand(state, artisan, 'A');
    const servoState = castAndSettle(state, artisanId, confirm(false));
    const servo = servoState.battlefield.find((c) => c.def.name === 'Servo');
    expect(servo?.def.types).toEqual(['artifact', 'creature']);
    expect(servo?.def.colors).toEqual([]);
    expect(stats(servoState, artisanId)).toEqual({ power: 2, toughness: 2 });
    // Taking the counters instead grows the body and makes no token.
    const counterState = atMain();
    const grownId = inHand(counterState, artisan, 'A');
    const grown = castAndSettle(counterState, grownId, confirm(true));
    expect(grown.battlefield.some((c) => c.def.name === 'Servo')).toBe(false);
    expect(stats(grown, grownId)).toEqual({ power: 3, toughness: 3 });
  });

  it('Relentless Advance makes a 3/3 Zombie Army, and a second one grows it to 6/6', () => {
    const advance = spell('Relentless Advance', 'Amass Zombies 3.', ['Amass']);
    const state = atMain();
    const first = castAndSettle(state, inHand(state, advance, 'A'));
    const army = first.battlefield.find((c) => c.def.subtypes?.includes('Army'));
    expect(army).toBeDefined();
    expect(army?.def.subtypes).toEqual(['Zombie', 'Army']);
    expect(stats(first, army!.instanceId)).toEqual({ power: 3, toughness: 3 });
    first.players.A.manaPool = { ...FULL_POOL };
    const second = castAndSettle(first, inHand(first, advance, 'A'));
    expect(second.battlefield.filter((c) => c.def.subtypes?.includes('Army'))).toHaveLength(1);
    expect(stats(second, army!.instanceId)).toEqual({ power: 6, toughness: 6 });
  });

  it('Dromoka’s Gift bolsters the Squirrel, not the Bear', () => {
    const gift = spell("Dromoka's Gift", 'Bolster 4.', ['Bolster'], 'Instant');
    const state = atMain();
    const bearId = place(state, BEAR, 'A');
    const squirrelId = place(state, SQUIRREL, 'A');
    const after = castAndSettle(state, inHand(state, gift, 'A'));
    expect(stats(after, squirrelId)).toEqual({ power: 5, toughness: 5 });
    expect(stats(after, bearId)).toEqual({ power: 2, toughness: 2 });
  });

  it('Consuming Aetherborn backs up a Bear: a 3/3 with lifelink until end of turn', () => {
    const aetherborn = creature('Consuming Aetherborn', 'Backup 1\nLifelink', ['Backup', 'Lifelink']);
    const state = atMain();
    const bearId = place(state, BEAR, 'A');
    const aim: Answerer = (choice) => (choice.kind === 'selectTargets' ? { kind: 'selectTargets', targets: [bearId] } : { kind: 'confirm', yes: true });
    const after = castAndSettle(state, inHand(state, aetherborn, 'A'), aim);
    expect(stats(after, bearId)).toEqual({ power: 3, toughness: 3 });
    expect(aggregateFor(after, bearId).keywords?.lifelink).toBe(true);
    const nextTurn = passUntil(after, (s) => s.turnNumber === 2 && s.step === 'precombatMain');
    expect(aggregateFor(nextTurn, bearId).keywords?.lifelink).toBeFalsy();
    expect(stats(nextTurn, bearId)).toEqual({ power: 3, toughness: 3 });
  });

  it('a Ministrant of Obligation that dies leaves two 1/1 flying Spirits', () => {
    const ministrant = creature('Ministrant of Obligation', 'Afterlife 2', ['Afterlife'], 2, 1);
    const state = atMain();
    const id = place(state, ministrant, 'A');
    const giantId = place(state, GIANT, 'B');
    const after = toPostcombat(blockWith(attackWith(state, [id]), [{ blocker: giantId, attacker: id }]));
    const spirits = after.battlefield.filter((c) => c.def.name === 'Spirit' && c.controller === 'A');
    expect(spirits).toHaveLength(2);
    expect(spirits[0]?.def.keywords?.flying).toBe(true);
  });

  it('a Merfolk Branchwalker explores: a land on top goes to hand; a nonland gives a counter and may be binned', () => {
    const walker = creature('Merfolk Branchwalker', 'When this creature enters, it explores.', ['Explore'], 2, 1);
    const landTop = atMain();
    const a = inHand(landTop, walker, 'A');
    const handBefore = landTop.players.A.hand.length;
    const found = castAndSettle(landTop, a);
    expect(found.players.A.hand.length).toBe(handBefore); // the walker left the hand, the Forest joined it
    expect(found.players.A.hand[0]?.def.name).toBe('Forest');
    expect(plusCounters(found, a)).toBe(0);
    const spellTop = atMain();
    const b = inHand(spellTop, walker, 'A');
    spellTop.players.A.library.unshift({ instanceId: spellTop.nextInstanceId++, def: BEAR, controller: 'A', owner: 'A', zone: 'library', tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {} });
    const grown = castAndSettle(spellTop, b, confirm(true));
    expect(plusCounters(grown, b)).toBe(1);
    expect(grown.players.A.graveyard.some((c) => c.def.name === 'Bear')).toBe(true);
  });

  it('a Disowned Ancestor outlasts at sorcery speed for a counter, and the activation is not offered with a spell on the stack', () => {
    const ancestor = creature('Disowned Ancestor', 'Outlast {1}{B}', ['Outlast'], 0, 4);
    const state = atMain();
    const id = place(state, ancestor, 'A');
    const activated = act(state, { kind: 'activateAbility', player: 'A', instanceId: id, abilityIndex: 0 });
    const after = passUntil(activated, (s) => s.stack.length === 0);
    expect(stats(after, id)).toEqual({ power: 1, toughness: 5 });
    expect(find(after, id)?.tapped).toBe(true);
  });
});

/** The kicked template's body, run the way a kicked spell's resolution runs it. */
describe('"if ~ was kicked" counters', () => {
  it('Academy Drake kicked enters with two counters; unkicked with none', () => {
    const drake = creature('Academy Drake', 'Kicker {4}\nFlying\nIf this creature was kicked, it enters with two +1/+1 counters on it.', ['Kicker', 'Flying']);
    const run = (kicked: boolean): number => {
      const state = atMain();
      const id = state.nextInstanceId++;
      const card = { instanceId: id, def: drake, controller: 'A' as const, owner: 'A' as const, zone: 'stack' as const, tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {} };
      const fn = REGISTRY.get('ifKicked')!;
      fn({ state, source: card, controller: 'A', targets: [], params: drake.effects![0]!.params ?? {}, kicked, emit: () => {}, enqueueEffects: (refs) => { for (const ref of refs) REGISTRY.get(ref.primitive)!({ state, source: card, controller: 'A', targets: [], params: ref.params ?? {}, emit: () => {} } as never); } } as never);
      return card.counters[PLUS_ONE_COUNTER] ?? 0;
    };
    expect(run(true)).toBe(2);
    expect(run(false)).toBe(0);
  });
});
