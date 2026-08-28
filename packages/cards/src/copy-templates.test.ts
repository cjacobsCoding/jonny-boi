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
  GameState,
  InstanceId,
  PlayerId,
  TriggeredStackObject,
} from '@jonny-boi/core';
import { isLegalTarget, legalTargetsFor } from '@jonny-boi/core';
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
