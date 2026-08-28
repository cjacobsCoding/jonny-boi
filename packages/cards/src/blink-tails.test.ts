/**
 * THE END-STEP BLINK TAILS — "up to one", "other", and "under its owner's
 * control" (Teleportation Circle, Thassa, Deep-Dwelling).
 *
 * Three printed words, three fidelity edges:
 *  - "up to one" must lift onto the ABILITY as a 0..1 `targetCount`, or the aim
 *    forces a blink every end step — Thassa made to blink her only creature into
 *    an opposing removal window is a worse card; a Circle FORCED to pick is a
 *    different card.
 *  - "other" must exclude the source, or Thassa blinks herself (she is not even
 *    a creature half the time, but the menu must never offer it).
 *  - "under its owner's control" must return a permanent you control but do not
 *    own to its OWNER — the one board where it differs from "under your
 *    control", where blinking a stolen creature keeps it for good.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameState, PlayerId } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';

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

describe('compiling the end-step blink family', () => {
  it('compiles Teleportation Circle — up-to-one, artifact or creature, owner-control return', () => {
    const result = compileCard(
      makeCard({
        name: 'Teleportation Circle',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        manaCost: { generic: 3, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText:
          "At the beginning of your end step, exile up to one target artifact or creature you control, then return that card to the battlefield under its owner's control.",
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const trigger = result.definition.triggers?.[0];
    expect(trigger?.targets).toBe('artifactOrCreatureYouControl');
    expect(trigger?.targetCount).toEqual({ min: 0, max: 1 });
    const ref = trigger?.effects[0];
    expect(ref?.primitive).toBe('blinkTarget');
    expect(ref?.params?.ownerControl).toBe(true);
  });

  it("compiles Thassa's end-step line — up-to-one, OTHER, your-control return", () => {
    const result = compileCard(
      makeCard({
        name: 'Blink God',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText:
          'At the beginning of your end step, exile up to one other target creature you control, then return that card to the battlefield under your control.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const trigger = result.definition.triggers?.[0];
    expect(trigger?.targets).toBe('creatureYouControl');
    expect(trigger?.targetsExcludeSelf).toBe(true);
    expect(trigger?.targetCount).toEqual({ min: 0, max: 1 });
    expect(trigger?.effects[0]?.params?.ownerControl).toBeUndefined();
  });

  it('still compiles the bare Cloudshift wording exactly as before', () => {
    const result = compileCard(
      makeCard({
        name: 'Cloudshift',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 0, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText:
          'Exile target creature you control, then return that card to the battlefield under your control.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const ref = result.definition.effects?.[0];
    expect(ref?.primitive).toBe('blinkTarget');
    expect(ref?.params?.upToTargets).toBeUndefined();
    expect(ref?.params?.ownerControl).toBeUndefined();
  });
});

describe('the owner-control return, resolved through the real primitive', () => {
  it('returns a stolen permanent to its OWNER; the your-control form keeps it', () => {
    for (const ownerControl of [true, false]) {
      const registry = buildRegistry();
      const primitive = registry.get('blinkTarget');
      expect(primitive).toBeDefined();
      // Owned by B, controlled by A — the one board where the wordings differ.
      const stolen: Record<string, unknown> = {
        instanceId: 7,
        controller: 'A',
        owner: 'B',
        zone: 'battlefield',
        tapped: false,
        summoningSick: false,
        damageMarked: 0,
        markedByDeathtouch: false,
        attachedTo: null,
        counters: {},
        def: { id: 'stolen', name: 'Stolen Bear', types: ['creature'], power: 2, toughness: 2 } as CardDefinition,
      };
      const seat = () => ({ exile: [], hand: [], graveyard: [], library: [], command: [] });
      const state = {
        nextInstanceId: 100,
        battlefield: [stolen],
        stack: [],
        continuous: [],
        combat: null,
        players: { A: seat(), B: seat() },
      } as unknown as GameState;
      primitive!({
        state,
        source: { instanceId: 1, def: { id: 's', name: 'Circle', types: ['enchantment'] } },
        controller: 'A' as PlayerId,
        targets: [7],
        params: {
          targets: 'creatureYouControl',
          ...(ownerControl ? { ownerControl: true } : {}),
        },
        emit: () => {},
        ask: () => undefined,
      } as never);
      const back = state.battlefield.find((p) => p.instanceId === 7);
      expect(back, 'the permanent must come back').toBeDefined();
      expect(back?.controller).toBe(ownerControl ? 'B' : 'A');
      expect(back?.owner).toBe('B');
    }
  });
});
