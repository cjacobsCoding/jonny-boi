/**
 * THE SCAN THAT PROVES THE SCAN.
 *
 * `instance-ids.ts` claims to know every way this engine spells "that card". A
 * claim like that is worth nothing on its own — the previous version of this
 * guarantee was a single key name (`instanceId`), and it read exactly as
 * confident as this one while walking past eighteen other id-bearing fields.
 *
 * So the claim is checked against core's own SOURCE. Every property declaration
 * in `packages/core/src` whose declared type mentions `InstanceId` must be
 * recognised:
 *
 *  - if it is a field of a `GameEvent`, {@link EVENT_ID_FIELDS} must classify it
 *    as something other than `'none'` (the compiler already forces an entry to
 *    EXIST; only a human can get its VALUE wrong, and this is what catches that);
 *  - either way, its key name must be in {@link INSTANCE_ID_FIELD_NAMES}, which
 *    is what the structural walker in `@jonny-boi/protocol` scans by.
 *
 * The reverse direction is checked too, so a name that stops being an id does not
 * sit here for ever making the walker look thorough.
 *
 * ⚠️ This test reads `.ts` files off disk. That is deliberate and it is the only
 * mechanism available: `InstanceId` is a bare `number`, so no runtime value and
 * no conditional type can tell an instance id from a life total. The declaration
 * is the only place the distinction exists, so the declaration is what is read.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GameEvent } from './events.js';
import {
  CHOICE_ANSWER_ID_FIELDS,
  EVENT_ID_FIELDS,
  INSTANCE_ID_FIELD_NAMES,
  instanceIdsNamedBy,
  type InstanceIdShape,
} from './instance-ids.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, into);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) into.push(full);
  }
  return into;
}

/**
 * A PROPERTY declaration — `readonly foo?: Bar;` or `foo: Bar;` inside an
 * interface or a type literal.
 *
 * Deliberately not a general TypeScript parse. What it must do is find every
 * `name: <type mentioning InstanceId>;` and NOT match a `const x: InstanceId =`
 * binding or a `f(id: InstanceId)` parameter — parameters end in `,` or `)`,
 * which is why those characters terminate the type, and bindings are filtered by
 * the keyword check below.
 */
const PROPERTY = /(?:^|[;{}]|\breadonly\b)\s*([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^;{}()=\n]+);/gm;

/** Every property name in core whose declared type mentions `InstanceId`. */
function declaredIdFieldNames(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of sourceFiles(SRC)) {
    // Comments are stripped first: several of them TALK about `InstanceId`
    // fields, and a doc comment is not a declaration.
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    PROPERTY.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PROPERTY.exec(text)) !== null) {
      const [whole, name, declaredType] = match;
      if (!/\bInstanceId\b/.test(declaredType!)) continue;
      if (/\b(?:const|let|var|function)\b/.test(whole)) continue;
      if (!found.has(name!)) found.set(name!, new Set());
      found.get(name!)!.add(path.basename(file));
    }
  }
  return found;
}

/** Every field the two tables classify as carrying an id. */
function classifiedIdFieldNames(): Set<string> {
  const names = new Set<string>();
  const collect = (fields: Record<string, InstanceIdShape>) => {
    for (const [name, shape] of Object.entries(fields)) if (shape !== 'none') names.add(name);
  };
  for (const fields of Object.values(EVENT_ID_FIELDS)) collect(fields as Record<string, InstanceIdShape>);
  for (const fields of Object.values(CHOICE_ANSWER_ID_FIELDS)) collect(fields as Record<string, InstanceIdShape>);
  return names;
}

describe('the instance-id vocabulary is complete, checked against core’s own source', () => {
  const declared = declaredIdFieldNames();

  it('finds enough declarations to mean anything', () => {
    // Guards the guard. If the regex ever stops matching (a formatting change, a
    // move to a different declaration style), every assertion below would pass
    // vacuously and this file would become a green test of nothing.
    expect(declared.size).toBeGreaterThanOrEqual(15);
    for (const known of ['instanceId', 'sourceInstanceId', 'targetInstanceId', 'attackTargets', 'targets']) {
      expect([...declared.keys()], `the source scan lost '${known}'`).toContain(known);
    }
  });

  it('knows every key name in core that holds an instance id', () => {
    const unknown = [...declared.entries()]
      .filter(([name]) => !INSTANCE_ID_FIELD_NAMES.has(name))
      .map(([name, files]) => `${name} (declared in ${[...files].join(', ')})`);
    expect(
      unknown,
      'a field naming a card that the leak scanner would walk straight past — ' +
        'classify it in EVENT_ID_FIELDS, or add it to NON_EVENT_INSTANCE_ID_FIELDS',
    ).toEqual([]);
  });

  it('carries no stale name that stopped being an id', () => {
    const stale = [...INSTANCE_ID_FIELD_NAMES].filter((name) => !declared.has(name));
    expect(stale, 'these names are in the vocabulary but no longer declared as ids anywhere in core').toEqual([]);
  });

  it('classifies every id-bearing EVENT field as an id — `none` is a claim, and this checks it', () => {
    const classified = classifiedIdFieldNames();
    // Every name the source says is an id, and that an event actually carries,
    // must be classified non-`'none'` by at least one table entry.
    const eventFieldNames = new Set(
      Object.values(EVENT_ID_FIELDS).flatMap((fields) => Object.keys(fields as Record<string, unknown>)),
    );
    const misclassified = [...declared.keys()].filter((name) => eventFieldNames.has(name) && !classified.has(name));
    expect(misclassified, "an event field the source says is an InstanceId but the table calls 'none'").toEqual([]);
  });
});

describe('instanceIdsNamedBy — every id, whatever it is called', () => {
  it('sees the id-bearing fields a key-name scan walks past', () => {
    // The exact shape of HOLE 1: `sourceInstanceId` on a public event.
    expect([...instanceIdsNamedBy({ type: 'choiceAbandoned', sourceInstanceId: 77, reason: 'x' } as GameEvent)]).toEqual(
      [77],
    );
    expect([...instanceIdsNamedBy({ type: 'legendRuleApplied', player: 'A', name: 'x', keptInstanceId: 5 })]).toEqual([
      5,
    ]);
    expect(
      [...instanceIdsNamedBy({ type: 'continuousEffectExpired', targetInstanceId: 1, sourceInstanceId: 2, duration: 'endOfTurn' })].sort(),
    ).toEqual([1, 2]);
  });

  it('reads BOTH halves of an id-keyed map — the keys are cards too', () => {
    const ids = instanceIdsNamedBy({
      type: 'attackersDeclared',
      attackers: [11, 12],
      attackTargets: { 11: 90 },
    } as GameEvent);
    expect([...ids].sort((a, b) => a - b)).toEqual([11, 12, 90]);
  });

  it('reads ids out of nested pair lists and choice answers', () => {
    expect(
      [...instanceIdsNamedBy({ type: 'blockersDeclared', blocks: [{ blocker: 3, attacker: 4 }] } as GameEvent)].sort(),
    ).toEqual([3, 4]);
    expect([
      ...instanceIdsNamedBy({
        type: 'choiceAnswered',
        choiceId: 1,
        chooser: 'A',
        choiceKind: 'selectCards',
        answer: { kind: 'selectCards', instanceIds: [42, 43] },
        summary: '',
      } as GameEvent),
    ]).toEqual([42, 43]);
  });

  it('does NOT mistake a look-alike number for a card', () => {
    // `replacementExpired.id` is a floating-effect id and `choiceId` is a
    // question's — both indistinguishable from an instance id at runtime, which
    // is precisely why this is driven by the declarations and not by `typeof`.
    expect([...instanceIdsNamedBy({ type: 'replacementExpired', id: 999, source: 4 } as GameEvent)]).toEqual([4]);
    expect([...instanceIdsNamedBy({ type: 'lifeChanged', player: 'A', delta: -3, to: 17 } as GameEvent)]).toEqual([]);
  });

  it('treats a seat in an `InstanceId | PlayerId` field as a seat, not a card', () => {
    const ids = instanceIdsNamedBy({ type: 'damageDealt', source: 8, target: 'B', amount: 2, combat: true } as GameEvent);
    expect([...ids]).toEqual([8]);
  });

  it('THROWS on an event type nobody classified, rather than reporting no ids', () => {
    // The difference between "I checked and found nothing" and "I did not
    // check". A scan that silently returns an empty set for an unknown type is
    // the failure mode this whole file exists to close.
    expect(() => instanceIdsNamedBy({ type: 'somethingNobodyClassified' })).toThrow(/unclassified/);
  });
});
