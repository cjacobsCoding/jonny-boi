/**
 * THE COPY-TEMPLATE EXTENSIONS — the corpus's top remaining gap, closed as a
 * family: controller-scoped spell/ability copies (Lithoform Engine), the
 * "another … you control" token-copy selector (Extravagant Replication), tapped
 * token copies, and the kicked ETB intervening "if" (Skyclave Relic).
 *
 * The fidelity edge each half pins:
 *  - "you control" scopes must REFUSE the opponent's objects — a Lithoform that
 *    forks the opponent's removal is a strictly better card than printed.
 *  - "copy target TRIGGERED ability" must refuse an ACTIVATED one now that the
 *    stack can tell them apart (`origin: 'activated'`) — before the marker the
 *    triggered-only wording was quietly wider than printed.
 *  - "another" must exclude the ability's own source from the aiming menu, or
 *    Extravagant Replication copies itself every upkeep, forever wider.
 *  - "tapped" must reach the created tokens, or they are attackers a turn early.
 *  - "if it was kicked" must hold the trigger back on an unkicked entry, or the
 *    unkicked card is strictly better than printed.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameState,
  InstanceId,
  PlayerId,
  TriggeredStackObject,
} from '@jonny-boi/core';
import {
  DEFAULT_RULES,
  applyAction,
  createGame,
  defaultAnswerFor,
  generateLegalActions,
  isLegalTarget,
  legalTargetsFor,
  tokenCopyDefOf,
} from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

// --- the compiler half --------------------------------------------------------------

describe('compiling the copy-template family', () => {
  it('compiles Lithoform Engine completely — all three modes', () => {
    const result = compileCard(
      makeCard({
        name: 'Lithoform Engine',
        typeLine: { supertypes: ['Legendary'], types: ['Artifact'], subtypes: [] },
        manaCost: { generic: 4, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText:
          '{2}, {T}: Copy target activated or triggered ability you control. You may choose new targets for the copy.\n' +
          '{3}, {T}: Copy target instant or sorcery spell you control. You may choose new targets for the copy.\n' +
          '{4}, {T}: Copy target permanent spell you control. (The copy becomes a token.)',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const restrictions = (result.definition.activated ?? []).map(
      (ability) => ability.effects[0]?.params?.targets,
    );
    expect(restrictions).toEqual([
      'activatedOrTriggeredAbilityYouControl',
      'instantOrSorcerySpellYouControl',
      'permanentSpellYouControl',
    ]);
  });

  it('compiles Extravagant Replication with the exclusion ON THE ABILITY', () => {
    const result = compileCard(
      makeCard({
        name: 'Extravagant Replication',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        manaCost: { generic: 4, W: 0, U: 2, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText:
          "At the beginning of your upkeep, create a token that's a copy of another target nonland permanent you control.",
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const trigger = result.definition.triggers?.[0];
    expect(trigger?.targets).toBe('nonlandPermanentYouControl');
    // The flag lives on the ABILITY, because the ability is what gets aimed —
    // a flag left on the effect ref alone would exclude nothing.
    expect(trigger?.targetsExcludeSelf).toBe(true);
  });

  it('compiles Skyclave Relic — kicked intervening "if" plus tapped plural copies', () => {
    const result = compileCard(
      makeCard({
        name: 'Skyclave Relic',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        manaCost: { generic: 3, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        keywords: ['Kicker', 'Indestructible'],
        oracleText:
          'Kicker {3}\nIndestructible\nWhen this artifact enters, if it was kicked, create two tapped tokens that are copies of this artifact.\n{T}: Add one mana of any color.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const trigger = result.definition.triggers?.[0];
    expect(trigger?.condition.intervening).toEqual({ kind: 'sourceKicked' });
    const ref = trigger?.effects[0];
    expect(ref?.primitive).toBe('createTokenCopy');
    expect(ref?.params?.count).toBe(2);
    expect((ref?.params?.except as { entersTapped?: boolean })?.entersTapped).toBe(true);
  });

  it('still REFUSES an unreadable ETB intervening "if" rather than dropping it', () => {
    // Compiling the body as though the condition were absent would fire the
    // trigger unconditionally — a strictly better card than printed.
    const result = compileCard(
      makeCard({
        name: 'Odd Gate',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        oracleText: 'When this artifact enters, if you have exactly 13 life, draw a card.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.triggers ?? []).toHaveLength(0);
  });
});

// --- the engine half: the origin marker and the new scopes ---------------------------

function byName(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

/** A bare state whose stack holds one trigger-kind object (± the activated stamp). */
function stateWithAbility(owner: PlayerId, activated: boolean): GameState {
  const object: TriggeredStackObject = {
    kind: 'trigger',
    instanceId: 50,
    sourceInstanceId: 7,
    controller: owner,
    effects: [{ primitive: 'drawCards', params: { count: 1 } }],
    targets: [],
    label: activated ? '{T}: Draw a card' : 'Enters: draw a card',
    ...(activated ? { origin: 'activated' as const } : {}),
  };
  return {
    nextInstanceId: 100,
    battlefield: [],
    stack: [object],
    players: {
      A: { exile: [], hand: [], graveyard: [], library: [] },
      B: { exile: [], hand: [], graveyard: [], library: [] },
    },
  } as unknown as GameState;
}

describe('the activated-origin marker (CR 602 vs 603 on the stack)', () => {
  it('"target TRIGGERED ability you control" refuses an activated one', () => {
    const s = stateWithAbility('A', true);
    expect(isLegalTarget(s, 'triggeredAbilityYouControl', 50, 'A')).toBe(false);
    expect(legalTargetsFor(s, 'triggeredAbilityYouControl', 'A')).toEqual([]);
  });

  it('"target activated or triggered ability you control" takes both', () => {
    for (const activated of [true, false]) {
      const s = stateWithAbility('A', activated);
      expect(isLegalTarget(s, 'activatedOrTriggeredAbilityYouControl', 50, 'A')).toBe(true);
      expect(legalTargetsFor(s, 'activatedOrTriggeredAbilityYouControl', 'A')).toEqual([50]);
    }
  });

  it('…but never the opponent’s, and never with an unknown actor', () => {
    const s = stateWithAbility('B', true);
    expect(isLegalTarget(s, 'activatedOrTriggeredAbilityYouControl', 50, 'A')).toBe(false);
    expect(isLegalTarget(s, 'activatedOrTriggeredAbilityYouControl', 50, undefined)).toBe(false);
  });
});

/** A bare state with two spells on the stack: A's sorcery under B's creature spell. */
function stateWithSpells(): GameState {
  const spell = (
    instanceId: InstanceId,
    controller: PlayerId,
    types: readonly string[],
  ): Record<string, unknown> => ({
    kind: 'spell',
    instanceId,
    controller,
    resolvesTo: types.includes('creature') ? 'battlefield' : 'graveyard',
    targets: [],
    card: {
      instanceId,
      controller,
      owner: controller,
      zone: 'stack',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
      def: { id: `s${instanceId}`, name: `Spell ${instanceId}`, types },
    },
  });
  return {
    nextInstanceId: 100,
    battlefield: [],
    stack: [spell(60, 'A', ['sorcery']), spell(61, 'B', ['creature'])],
    players: {
      A: { exile: [], hand: [], graveyard: [], library: [] },
      B: { exile: [], hand: [], graveyard: [], library: [] },
    },
  } as unknown as GameState;
}

describe('the controller-scoped spell targets', () => {
  it('"instant or sorcery spell you control" sees only your own instants/sorceries', () => {
    const s = stateWithSpells();
    expect(legalTargetsFor(s, 'instantOrSorcerySpellYouControl', 'A')).toEqual([60]);
    expect(legalTargetsFor(s, 'instantOrSorcerySpellYouControl', 'B')).toEqual([]);
    expect(isLegalTarget(s, 'instantOrSorcerySpellYouControl', 60, 'B')).toBe(false);
  });

  it('"permanent spell you control" is the complement — and still yours only', () => {
    const s = stateWithSpells();
    expect(legalTargetsFor(s, 'permanentSpellYouControl', 'B')).toEqual([61]);
    expect(legalTargetsFor(s, 'permanentSpellYouControl', 'A')).toEqual([]);
  });

  it('offers nothing with an unknown actor — the safe direction', () => {
    const s = stateWithSpells();
    expect(legalTargetsFor(s, 'instantOrSorcerySpellYouControl', undefined)).toEqual([]);
    expect(legalTargetsFor(s, 'permanentSpellYouControl', undefined)).toEqual([]);
  });
});

describe('a tapped token copy, resolved through the real primitive', () => {
  it('creates the tokens TAPPED', () => {
    const registry = buildRegistry();
    const primitive = registry.get('createTokenCopy');
    expect(primitive).toBeDefined();

    const bear: Record<string, unknown> = {
      instanceId: 70,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
      def: byName('Grizzly Bears'),
    };
    const created: Array<{ tapped: boolean }> = [];
    const state = {
      nextInstanceId: 100,
      battlefield: [bear],
      stack: [],
      players: {
        A: { exile: [], hand: [], graveyard: [], library: [] },
        B: { exile: [], hand: [], graveyard: [], library: [] },
      },
    } as unknown as GameState;

    primitive!({
      state,
      source: bear,
      controller: 'A' as PlayerId,
      targets: [],
      params: { self: true, count: 2, except: { entersTapped: true } },
      emit: () => {},
      ask: () => undefined,
      createTokens(def: CardDefinition, count: number, _controller?: unknown, options?: { tapped?: boolean }) {
        // Mirror core's own funnel question: `entersTapped(def)` OR the creation
        // options — the exception rides the def, the printed word rides the
        // options, and either is enough.
        const ids: number[] = [];
        for (let i = 0; i < count; i++) {
          const tapped = def.entersTapped === true || options?.tapped === true;
          created.push({ tapped });
          const id = (state as { nextInstanceId: number }).nextInstanceId++;
          (state.battlefield as unknown[]).push({ ...bear, instanceId: id, tapped, def });
          ids.push(id);
        }
        return ids;
      },
    } as never);

    expect(created).toHaveLength(2);
    expect(created.every((token) => token.tapped)).toBe(true);
  });
});

// --- the §3.53 tails: for-each, the token target, and the "instead" substitution ----

describe('compiling the remaining copy tails', () => {
  it('compiles Second Harvest — the for-each iteration', () => {
    const result = compileCard(
      makeCard({
        name: 'Second Harvest',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 2, C: 0, other: [] },
        oracleText: "For each token you control, create a token that's a copy of that permanent.",
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const ref = result.definition.effects?.[0];
    expect(ref?.primitive).toBe('createTokenCopy');
    expect(ref?.params?.forEachTokenYouControl).toBe(true);
  });

  it('compiles the "target token you control" selector (Caretaker\'s Talent\'s level-2 body)', () => {
    const result = compileCard(
      makeCard({
        name: 'Token Copier',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: "Create a token that's a copy of target token you control.",
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects?.[0]?.params?.targets).toBe('tokenYouControl');
  });

  it('compiles Scute Swarm — the board-conditional "instead" substitution, both halves intact', () => {
    const result = compileCard(
      makeCard({
        name: 'Scute Swarm',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Insect'] },
        manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        power: '1',
        toughness: '1',
        oracleText:
          'Landfall — Whenever a land you control enters, create a 1/1 green Insect creature token. If you control six or more lands, create a token that\'s a copy of this creature instead.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const ref = result.definition.triggers?.[0]?.effects[0];
    expect(ref?.primitive).toBe('substituteIf');
    const params = ref?.params as {
      condition?: { kind?: string; min?: number; filter?: { anyOfTypes?: string[] } };
      effects?: Array<{ primitive: string }>;
      otherwise?: Array<{ primitive: string }>;
    };
    expect(params.condition?.kind).toBe('controlCount');
    expect(params.condition?.min).toBe(6);
    expect(params.condition?.filter?.anyOfTypes).toEqual(['land']);
    // The "instead" half copies the source; the base half makes the Insect.
    expect(params.effects?.[0]?.primitive).toBe('createTokenCopy');
    expect(params.otherwise?.[0]?.primitive).toBe('makeToken');
  });

  it('still REFUSES an "instead" whose condition it cannot read', () => {
    const result = compileCard(
      makeCard({
        name: 'Odd Swarm',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText:
          "Create a 1/1 green Insect creature token. If you have exactly 13 life, create a token that's a copy of target creature instead.",
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

describe('the tokenYouControl target (CR 111.1 stamp, not a name heuristic)', () => {
  function boardWith(defs: Array<{ id: number; isToken?: boolean; controller: PlayerId }>): GameState {
    return {
      nextInstanceId: 100,
      battlefield: defs.map((d) => ({
        instanceId: d.id,
        controller: d.controller,
        owner: d.controller,
        zone: 'battlefield',
        tapped: false,
        summoningSick: false,
        damageMarked: 0,
        markedByDeathtouch: false,
        counters: {},
        def: {
          id: `t${d.id}`,
          name: `Perm ${d.id}`,
          types: ['creature'],
          ...(d.isToken ? { isToken: true } : {}),
        },
      })),
      stack: [],
      continuous: [],
      players: {
        A: { exile: [], hand: [], graveyard: [], library: [], command: [] },
        B: { exile: [], hand: [], graveyard: [], library: [], command: [] },
      },
    } as unknown as GameState;
  }

  it('offers only your own tokens — never a printed card, never theirs, never with an unknown actor', () => {
    const s = boardWith([
      { id: 1, isToken: true, controller: 'A' },
      { id: 2, controller: 'A' },
      { id: 3, isToken: true, controller: 'B' },
    ]);
    expect(legalTargetsFor(s, 'tokenYouControl', 'A')).toEqual([1]);
    expect(isLegalTarget(s, 'tokenYouControl', 2, 'A')).toBe(false);
    expect(isLegalTarget(s, 'tokenYouControl', 3, 'A')).toBe(false);
    expect(legalTargetsFor(s, 'tokenYouControl', undefined)).toEqual([]);
  });
});

describe('the for-each token copy, resolved through the real primitive', () => {
  it('copies each of YOUR tokens once, snapshot before anything is created', () => {
    const registry = buildRegistry();
    const primitive = registry.get('createTokenCopy');
    const instance = (id: number, isToken: boolean, controller: PlayerId): Record<string, unknown> => ({
      instanceId: id,
      controller,
      owner: controller,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
      def: { id: `d${id}`, name: `Perm ${id}`, types: ['creature'], ...(isToken ? { isToken: true } : {}) },
    });
    const state = {
      nextInstanceId: 100,
      battlefield: [instance(1, true, 'A'), instance(2, false, 'A'), instance(3, true, 'B')],
      stack: [],
      players: {
        A: { exile: [], hand: [], graveyard: [], library: [] },
        B: { exile: [], hand: [], graveyard: [], library: [] },
      },
    } as unknown as GameState;
    const copiedOf: number[] = [];
    const events: Array<Record<string, unknown>> = [];
    primitive!({
      state,
      source: state.battlefield[1],
      controller: 'A' as PlayerId,
      targets: [],
      params: { forEachTokenYouControl: true },
      emit: (e: Record<string, unknown>) => events.push(e),
      ask: () => undefined,
      createTokens(def: CardDefinition) {
        const id = (state as { nextInstanceId: number }).nextInstanceId++;
        // Stamped a token, exactly as core's funnel does — so the snapshot
        // discipline is what keeps this new arrival out of the iteration.
        (state.battlefield as unknown[]).push({ ...instance(id, true, 'A'), def: { ...def, isToken: true } });
        return [id];
      },
    } as never);
    for (const e of events) {
      if (e.type === 'tokenCopyCreated') copiedOf.push(e.copiedInstanceId as number);
    }
    // Exactly A's one token was copied — not A's nontoken, not B's token, and
    // not the copy this very resolution created.
    expect(copiedOf).toEqual([1]);
  });
});

describe('substituteIf picks its branch from the board at resolution', () => {
  function run(landCount: number): string[] {
    const registry = buildRegistry();
    const primitive = registry.get('substituteIf');
    expect(primitive).toBeDefined();
    const land = (id: number): Record<string, unknown> => ({
      instanceId: id,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
      def: { id: `l${id}`, name: `Land ${id}`, types: ['land'] },
    });
    const state = {
      nextInstanceId: 100,
      battlefield: Array.from({ length: landCount }, (_, i) => land(10 + i)),
      stack: [],
      players: {
        A: { exile: [], hand: [], graveyard: [], library: [] },
        B: { exile: [], hand: [], graveyard: [], library: [] },
      },
    } as unknown as GameState;
    const enqueued: string[] = [];
    primitive!({
      state,
      source: { instanceId: 1, def: { id: 's', name: 'Source', types: ['creature'] } },
      controller: 'A' as PlayerId,
      targets: [],
      params: {
        condition: { kind: 'controlCount', filter: { anyOfTypes: ['land'] }, min: 6 },
        effects: [{ primitive: 'createTokenCopy', params: { self: true } }],
        otherwise: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Insect' } }],
      },
      emit: () => {},
      ask: () => undefined,
      enqueueEffects: (refs: Array<{ primitive: string }>) => {
        for (const ref of refs) enqueued.push(ref.primitive);
      },
    } as never);
    return enqueued;
  }

  it('five lands make the Insect; six make the copy — the printed upgrade, decided live', () => {
    expect(run(5)).toEqual(['makeToken']);
    expect(run(6)).toEqual(['createTokenCopy']);
  });
});

// --- "ANOTHER target creature you control" — the printed word, enforced twice ------
//
// Orthion, Jaxis and The Jolly Balloon Man all print it, and it is the ONLY
// thing that stops each of them from copying itself every turn for free. The
// word had a home already (`excludeSelf` on the ref, lifted by the trigger-body
// compiler onto a TRIGGERED ability) and no home at all on an ACTIVATED one:
// the engine's activation menu and its rejection path both read the restriction
// and neither read the flag. Three tests, because the class has three faces —
// the compiler must EMIT it, the offer path must OMIT the source, and the
// validate path must REFUSE it if an action naming the source arrives anyway.
// The third is not redundant with the second: a generator-only fix leaves the
// engine accepting an action it never offered, which is the exact pairing the
// full-pool soak asserts.

describe('the printed word "another" on an activated token-copy ability', () => {
  const ORTHION_TEXT =
    "{1}{R}, {T}: Create a token that's a copy of another target creature you control. " +
    'It gains haste. Sacrifice it at the beginning of the next end step. Activate only as a sorcery.';

  function orthion(): CardDefinition {
    const result = compileCard(
      makeCard({
        name: 'Orthion, Hero of Lavabrink',
        typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Human', 'Soldier'] },
        manaCost: { generic: 3, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        power: '2',
        toughness: '3',
        oracleText: ORTHION_TEXT,
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    return result.definition;
  }

  it('compiles Orthion whole — the selector, the haste GRANT and the delayed sacrifice', () => {
    const params = orthion().activated?.[0]?.effects[0]?.params as Record<string, unknown>;
    expect(params?.targets).toBe('creatureYouControl');
    // The printed "another", carried as data rather than dropped.
    expect(params?.excludeSelf).toBe(true);
    // Layer 6, NOT folded into the copy's own keywords — a second copy of this
    // token must not inherit the haste, and "except it has haste" would.
    expect(params?.grantKeywords).toEqual({ haste: true });
    expect(params?.except).toBeUndefined();
    expect(params?.delayedRemoval).toBe('sacrifice');
    expect(orthion().activated?.[0]?.timing).toBe('sorcery');
  });

  it('refuses to widen: the same line WITHOUT "another" is a different, self-copying card', () => {
    const withoutAnother = compileCard(
      makeCard({
        name: 'Not Orthion',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
        power: '2',
        toughness: '3',
        oracleText: ORTHION_TEXT.replace('another target creature', 'target creature'),
      }),
    );
    expect(withoutAnother.status).toBe('complete');
    expect(withoutAnother.definition.activated?.[0]?.effects[0]?.params?.excludeSelf).toBeUndefined();
  });

  it('the engine never OFFERS the source as its own target, but does offer the other creature', () => {
    const { state, reg, orthionId, bearId } = boardWithOrthion();
    const offers = generateLegalActions(state)
      .filter((a) => a.kind === 'activateAbility' && a.instanceId === orthionId)
      .map((a) => (a as { targets?: readonly (InstanceId | PlayerId)[] }).targets?.[0]);
    expect(offers).toContain(bearId);
    expect(offers).not.toContain(orthionId);
    expect(reg.get('createTokenCopy')).toBeDefined();
  });

  it('the engine REJECTS an activation aimed at the source — the offer and the check agree', () => {
    const { state, reg, orthionId } = boardWithOrthion();
    const result = applyAction(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: orthionId, abilityIndex: 0, targets: [orthionId] },
      DEFAULT_RULES,
      reg,
    );
    const rejected = result.events.find((e) => e.type === 'actionRejected') as { reason: string } | undefined;
    expect(rejected?.reason).toMatch(/another/);
  });

  it('PLAYED: activating it on the other creature makes a hasty token copy of THAT creature', () => {
    const { state, reg, orthionId, bearId } = boardWithOrthion();
    const before = state.battlefield.length;
    const result = applyAction(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: orthionId, abilityIndex: 0, targets: [bearId] },
      DEFAULT_RULES,
      reg,
    );
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
    // The ability goes on the stack; resolve it the way the engine does.
    let s = result.state;
    let guard = 0;
    while (s.stack.length > 0 && guard++ < 20) {
      const next = generateLegalActions(s)[0];
      if (!next) break;
      s = applyAction(s, next, DEFAULT_RULES, reg).state;
    }
    const bear = state.battlefield.find((c) => c.instanceId === bearId)!;
    const token = s.battlefield.find((c) => c.def.isToken === true);
    expect(s.battlefield.length).toBe(before + 1);
    // A COPY of the bear, not of Orthion — the whole point of the word.
    expect(token?.def.name).toBe(bear.def.name);
    expect(token?.def.power).toBe(bear.def.power);
  });

  /**
   * A two-creature board with Orthion and one other creature, mana flooded and
   * in a sorcery-speed window — the only window this ability is legal in.
   */
  function boardWithOrthion(): {
    state: GameState;
    reg: ReturnType<typeof buildRegistry>;
    orthionId: InstanceId;
    bearId: InstanceId;
  } {
    const reg = buildRegistry();
    const forest = CARD_POOL.find((c) => c.name === 'Forest')!;
    const { state } = createGame({
      seed: 4401,
      decks: { A: { cards: Array.from({ length: 60 }, () => forest) }, B: { cards: Array.from({ length: 60 }, () => forest) } },
      registry: reg,
    });
    let s = state;
    let guard = 0;
    while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 400) {
      const question = s.pendingChoice;
      s = applyAction(
        s,
        question
          ? { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: defaultAnswerFor(question) }
          : { kind: 'passPriority', player: s.priorityPlayer },
        DEFAULT_RULES,
        reg,
      ).state;
    }
    s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
    const put = (def: CardDefinition): InstanceId => {
      const id = s.nextInstanceId++;
      s.battlefield.push({
        instanceId: id,
        def,
        controller: 'A',
        owner: 'A',
        zone: 'battlefield',
        tapped: false,
        summoningSick: false,
        damageMarked: 0,
        markedByDeathtouch: false,
        counters: {},
      });
      return id;
    };
    const orthionId = put(orthion());
    const bearId = put(CARD_POOL.find((c) => c.name === 'Grizzly Bears')!);
    return { state: s, reg, orthionId, bearId };
  }
});

// --- "copy THAT spell" — the printed noun the compiler could not read ---------------

describe('copying the spell that TRIGGERED the ability', () => {
  it("compiles Reflections of Littjara whole — the chosen type AND the copy", () => {
    const result = compileCard(
      makeCard({
        name: 'Reflections of Littjara',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        manaCost: { generic: 4, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText:
          ['As this enchantment enters, choose a creature type.', 'Whenever you cast a spell of the chosen type, copy that spell.'].join('\n'),
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const trigger = result.definition.triggers?.[0];
    expect(trigger?.condition.on).toBe('castSpell');
    expect(trigger?.condition.spellSubtypeIsChosen).toBe(true);
    // The lift: a BODY that reads the subject flags its CONDITION to carry one.
    expect(trigger?.condition.carriesSubject).toBe(true);
    expect(trigger?.effects[0]?.primitive).toBe('copySpell');
    expect(trigger?.effects[0]?.params?.subject).toBe('triggering');
    // NO target: the object is already determined, which is exactly what makes
    // this body legal inside a trigger.
    expect(trigger?.effects[0]?.params?.targets).toBeUndefined();
  });

  it("keeps the original's aim when the card does NOT print the re-aim permission", () => {
    // Reflections of Littjara prints no "you may choose new targets", and
    // saying so explicitly is what stops the default from granting a permission
    // the card does not have — a copy that may be re-aimed is a better card.
    const withoutPermission = compileCard(
      makeCard({
        name: 'Silent Mirror',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'Whenever you cast an instant spell, copy that spell.',
      }),
    );
    expect(withoutPermission.definition.triggers?.[0]?.effects[0]?.params?.mayRetarget).toBe(false);
    const withPermission = compileCard(
      makeCard({
        name: 'Loud Mirror',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText:
          'Whenever you cast an instant spell, copy that spell. You may choose new targets for the copy.',
      }),
    );
    expect(withPermission.definition.triggers?.[0]?.effects[0]?.params?.mayRetarget).toBeUndefined();
  });

  it('the subject lift NEVER turns the flag off, and leaves a body that reads no subject alone', () => {
    // A trigger whose body names nothing gets no field it will not read — the
    // opt-in property `carriesSubject` was given in the first place.
    const plain = compileCard(
      makeCard({
        name: 'Plain Mirror',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'Whenever you cast an instant spell, draw a card.',
      }),
    );
    expect(plain.status, JSON.stringify(plain.missing)).toBe('complete');
    expect(plain.definition.triggers?.[0]?.condition.carriesSubject).toBeUndefined();
  });

  /**
   * ⚠️ WRITTEN BECAUSE A SABOTAGE ESCAPED. The play test above counters the
   * original and asserts no copy is made — but by the time that trigger
   * resolves the stack is EMPTY, so a `spellToCopy` that fell back to "whatever
   * is on the stack" passed it happily. The hole is only visible when the stack
   * holds a DIFFERENT spell, which no end-to-end sequence reaches cleanly: the
   * copy trigger fires on every cast, so any spell you add to the stack brings
   * its own trigger with it.
   *
   * So this drives the primitive directly with an id that is not on the stack
   * and a stack that is not empty. A copy of the wrong spell is the failure this
   * pins, and it is strictly worse than no copy: the card would copy an opponent's
   * counterspell, or its own controller's unrelated sorcery, at random.
   */
  it('copies NOTHING when the triggering id is gone, even with another spell on the stack', () => {
    const registry = buildRegistry();
    const primitive = registry.get('copySpell');
    expect(primitive).toBeDefined();
    const bystander = {
      kind: 'spell' as const,
      instanceId: 80,
      controller: 'B' as PlayerId,
      targets: [],
      card: {
        instanceId: 80,
        controller: 'B',
        owner: 'B',
        zone: 'stack',
        tapped: false,
        summoningSick: false,
        damageMarked: 0,
        markedByDeathtouch: false,
        counters: {},
        def: { id: 'bystander', name: 'Unrelated Sorcery', types: ['sorcery'] },
      },
    };
    const state = {
      nextInstanceId: 200,
      battlefield: [],
      stack: [bystander],
      players: {
        A: { exile: [], hand: [], graveyard: [], library: [] },
        B: { exile: [], hand: [], graveyard: [], library: [] },
      },
    } as unknown as GameState;
    const emitted: string[] = [];
    primitive!({
      state,
      source: { instanceId: 1, def: { id: 'src', name: 'Mirror', types: ['enchantment'] } },
      controller: 'A' as PlayerId,
      targets: [],
      // The spell that set the trigger off has LEFT the stack (countered,
      // or it resolved). Its id answers nothing now.
      triggeringInstances: [999],
      params: { subject: 'triggering' },
      emit: (e: { type: string }) => emitted.push(e.type),
      ask: () => undefined,
    } as never);
    expect(state.stack).toHaveLength(1);
    expect(emitted).not.toContain('spellCopied');
  });
});

// --- the "except" tail that says FOUR things, and the splitter that broke on it ------

describe('an "except" tail carrying a base P/T, an added colour and a keyword list', () => {
  const JOLLY_TEXT =
    "{1}, {T}: Create a token that's a copy of another target creature you control, except it's a " +
    "1/1 red Balloon creature in addition to its other colors and types and it has flying and haste. " +
    'Sacrifice it at the beginning of the next end step. Activate only as a sorcery.';

  function jollyExcept(): Record<string, unknown> {
    const result = compileCard(
      makeCard({
        name: 'The Jolly Balloon Man',
        typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Human', 'Clown'] },
        manaCost: { generic: 1, W: 1, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        power: '2',
        toughness: '3',
        oracleText: `Haste
${JOLLY_TEXT}`,
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    return result.definition.activated?.[0]?.effects[0]?.params?.except as Record<string, unknown>;
  }

  it('reads every printed word of the tail — and keeps ADDED colour apart from REPLACED', () => {
    const except = jollyExcept();
    // The P/T REPLACES (layer 7a, like eternalize's "it's a 4/4").
    expect(except.power).toBe(1);
    expect(except.toughness).toBe(1);
    // The colour is ADDED — "in addition to its other colors". Writing it into
    // `colors` would make a copy of a green creature mono-red, which is a
    // different card the moment anything asks about green.
    expect(except.addColors).toEqual(['R']);
    expect(except.colors).toBeUndefined();
    expect(except.addTypes).toEqual(['creature']);
    expect(except.addSubtypes).toEqual(['Balloon']);
    // BOTH keywords: "flying and haste" is one clause granting two.
    expect(except.addKeywords).toEqual({ flying: true, haste: true });
  });

  it('core ADDS the colour to the copied ones rather than replacing them', () => {
    // A green bear copied as "red in addition" is BOTH — and red is not listed
    // twice when the original was already red.
    const green: CardDefinition = { id: 'g', name: 'Green Bear', types: ['creature'], colors: ['G'], power: 2, toughness: 2 };
    const red: CardDefinition = { id: 'r', name: 'Red Bear', types: ['creature'], colors: ['R'], power: 2, toughness: 2 };
    const asInstance = (def: CardDefinition): CardInstance =>
      ({
        instanceId: 1,
        def,
        controller: 'A',
        owner: 'A',
        zone: 'battlefield',
        tapped: false,
        summoningSick: false,
        damageMarked: 0,
        markedByDeathtouch: false,
        counters: {},
      }) as unknown as CardInstance;
    const tail = { addColors: ['R' as const], power: 1, toughness: 1 };
    expect(tokenCopyDefOf(asInstance(green), tail).colors).toEqual(['G', 'R']);
    expect(tokenCopyDefOf(asInstance(red), tail).colors).toEqual(['R']);
    expect(tokenCopyDefOf(asInstance(green), tail).power).toBe(1);
  });

  it('the splitter cuts only where a CLAUSE begins — "colors and types" survives intact', () => {
    // The class this fixes: " and " inside a clause used to be a separator, so
    // the tail tore into fragments that matched nothing and the card reported a
    // missing template when what was missing was the split. Proven by the
    // three-clause tail Spark Double prints still parsing as three.
    const spark = compileCard(
      makeCard({
        name: 'Spark Double',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Shapeshifter'] },
        power: '0',
        toughness: '0',
        oracleText:
          "You may have ~ enter as a copy of a creature you control, except it isn't legendary and it enters with an additional +1/+1 counter on it if it's a creature.",
      }),
    );
    expect(spark.status, JSON.stringify(spark.missing)).toBe('complete');
    const except = spark.definition.copyAsEnters?.except as Record<string, unknown>;
    expect(except.legendary).toBe(false);
    expect(except.extraCounters).toBeDefined();
  });

  /**
   * ⚠️ WRITTEN TWICE. The first version used "flying and bushido 2", which never
   * reached the keyword-list branch at all — the digit fails the `[a-z' ]+`
   * match, so the clause was refused one level up and a sabotage that made the
   * list SKIP unreadable words sailed through. The word has to be alphabetic and
   * simply not a flag this engine has.
   */
  it('still REFUSES a keyword list containing a word the engine has no flag for', () => {
    // Half a grant is a copy missing a printed ability — the widening this
    // compiler must never do. "Banding" is a real printed keyword with no flag
    // here, so the clause parses as a list and the list must refuse it.
    const partial = compileCard(
      makeCard({
        name: 'Half Reader',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: "Create a token that's a copy of target creature you control, except it has flying and banding.",
      }),
    );
    expect(partial.status).toBe('incomplete');
    // …and the FLYING half was not quietly kept: the card contributes nothing.
    expect(partial.definition.effects ?? []).toHaveLength(0);
    // The control: the same shape with two readable keywords compiles, so the
    // refusal above is about the unreadable word and not about the list form.
    const both = compileCard(
      makeCard({
        name: 'Whole Reader',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: "Create a token that's a copy of target creature you control, except it has flying and haste.",
      }),
    );
    expect(both.status, JSON.stringify(both.missing)).toBe('complete');
    expect((both.definition.effects?.[0]?.params?.except as { addKeywords?: unknown })?.addKeywords).toEqual({
      flying: true,
      haste: true,
    });
  });
});
