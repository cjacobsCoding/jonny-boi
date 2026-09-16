/**
 * §3.147 — EVERY MECHANIC THE SOAK DEMANDS MUST BE ONE SOMETHING CAN TICK.
 *
 * `SOAK_MECHANICS` is a requirement list: for each row whose `printedBy` matches
 * a card in the pool, the soak insists a real game FIRED it, and reports the row
 * as INERT otherwise. That is only a real requirement if some code path can
 * credit the row at all.
 *
 * `graveyard-cast` could not be. §3.111 added the row (retrace / jump-start /
 * escape) beside the existing `flashback-cast`, but `mechanicOfAction` reads the
 * cast's ZONE and nothing else — and all four keywords cast from the graveyard.
 * So every retrace in every game was credited to `flashback-cast`, the new row
 * was unreachable by construction, and the soak reported a family the engine
 * had fully implemented as never firing. The literal that says which keyword
 * paid is on the action (`castSpell.graveyardCast`); reading it is the fix.
 *
 * The two tests below are the instance and the CLASS: the attribution itself,
 * and a sweep that fails the day another id is declared with nowhere to come
 * from. The sweep is a source scan for the same reason `dead-rule-sweep.mjs` is
 * one — the witness sites are a `switch`, a state walk and a table, and the only
 * thing all three have in common is that they spell the id.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameAction, GameState } from '@jonny-boi/core';
import { mechanicOfAction } from './soak.js';
import { SOAK_EVENT_WITNESS, SOAK_MECHANICS, type SoakMechanicId } from './soak-config.js';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Enough of a state for the `castSpell` arm, which reads only the madness window. */
const NO_WINDOW = { madnessWindow: null } as unknown as GameState;

function cast(extra: Partial<Extract<GameAction, { kind: 'castSpell' }>>): GameAction {
  return { kind: 'castSpell', player: 'A', instanceId: 1 as never, ...extra } as GameAction;
}

describe('a graveyard cast is credited to the keyword that paid for it', () => {
  it('names `graveyard-cast` for retrace / jump-start / escape and `flashback-cast` for flashback', () => {
    const noDef = () => undefined;
    // The bug, pinned: without the discriminator these three were one mechanic.
    expect(mechanicOfAction(NO_WINDOW, cast({ fromZone: 'graveyard', graveyardCast: 'retrace' }), noDef)).toBe('graveyard-cast');
    expect(mechanicOfAction(NO_WINDOW, cast({ fromZone: 'graveyard', graveyardCast: 'jumpStart' }), noDef)).toBe('graveyard-cast');
    expect(mechanicOfAction(NO_WINDOW, cast({ fromZone: 'graveyard', graveyardCast: 'escape' }), noDef)).toBe('graveyard-cast');
    // A flashback carries no kind — including one with a non-mana rider, which
    // is still a flashback and rides the flashback row (soak-config says so).
    expect(mechanicOfAction(NO_WINDOW, cast({ fromZone: 'graveyard' }), noDef)).toBe('flashback-cast');
    // And the face still wins, because a second-face cast is a different claim.
    expect(mechanicOfAction(NO_WINDOW, cast({ fromZone: 'graveyard', face: 'back' }), noDef)).toBe('second-castable-face');
  });
});

describe('no soak mechanic is unreachable (the class)', () => {
  it('every SOAK_MECHANICS id can actually be ticked by some witness site', () => {
    // The three witness sites: the event table (values), and the action switch
    // and the state walk, both of which spell their ids in `soak.ts`.
    const source = readFileSync(join(SRC, 'soak.ts'), 'utf8');
    const reachable = new Set<string>();
    for (const witnessed of Object.values(SOAK_EVENT_WITNESS)) {
      if (witnessed !== null && witnessed !== undefined) reachable.add(witnessed);
    }
    for (const match of source.matchAll(/'([a-z][a-z0-9-]*)'/g)) reachable.add(match[1] as string);

    const orphans: SoakMechanicId[] = [];
    for (const entry of SOAK_MECHANICS) {
      if (!reachable.has(entry.id)) orphans.push(entry.id);
    }
    expect(
      orphans,
      `these mechanics are DEMANDED by the soak and can never be credited — either witness them or drop the row:\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });
});
