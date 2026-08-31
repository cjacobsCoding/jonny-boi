/**
 * §3.57 — the jailed-under-jailer grouping: exile lists + `exiledUntilLeavesBy`
 * links in, per-jailer stacks out. Rendering (the peeking tuck) is CSS; WHAT is
 * tucked under WHOM is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { groupJailedByJailer, jailSourcesOf, type JailSourceCard } from './jail-view.js';

const jailed = (id: number, name: string, jailer?: number): JailSourceCard => ({
  instanceId: id,
  cardId: `c${id}`,
  name,
  exiledUntilLeavesBy: jailer,
});

describe('groupJailedByJailer', () => {
  it('groups linked exiles under their battlefield jailer, in exile order', () => {
    const stacks = groupJailedByJailer(
      [jailed(11, 'Bear', 40), jailed(12, 'Wolf', 40), jailed(13, 'Elk', 41)],
      new Set([40, 41]),
    );
    expect([...stacks.keys()]).toEqual([40, 41]);
    expect(stacks.get(40)?.map((c) => c.name)).toEqual(['Bear', 'Wolf']);
    expect(stacks.get(41)?.map((c) => c.name)).toEqual(['Elk']);
    // The view rows carry exactly what the tile draws.
    expect(stacks.get(41)?.[0]).toEqual({ instanceId: 13, cardId: 'c13', name: 'Elk' });
  });

  it('ignores plain exiles (no link) and links whose jailer is not on the battlefield', () => {
    const stacks = groupJailedByJailer(
      [
        jailed(11, 'Plain exile'), // no link — ordinary exile
        jailed(12, 'Orphan', 99), // linked, but 99 is not a battlefield permanent
      ],
      new Set([40]),
    );
    expect(stacks.size).toBe(0);
  });

  it('is empty for empty inputs', () => {
    expect(groupJailedByJailer([], new Set()).size).toBe(0);
  });
});

describe('jailSourcesOf', () => {
  it('adapts CardInstance-shaped zone entries, keeping the link', () => {
    const sources = jailSourcesOf([
      { instanceId: 7, def: { id: 'banished-bear', name: 'Bear' }, exiledUntilLeavesBy: 3 },
      { instanceId: 8, def: { id: 'plain', name: 'Plain' } },
    ]);
    expect(sources).toEqual([
      { instanceId: 7, cardId: 'banished-bear', name: 'Bear', exiledUntilLeavesBy: 3 },
      { instanceId: 8, cardId: 'plain', name: 'Plain', exiledUntilLeavesBy: undefined },
    ]);
  });
});
