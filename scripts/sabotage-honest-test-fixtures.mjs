/**
 * SABOTAGE HARNESS for the two §3.143 honesty guards: the AI test-fixture registry
 * (`test-support-registry.test.ts`) and applyAction's third-argument refusal
 * (`apply-action-arguments.test.ts`). Each row names the suite its break must be
 * seen by, so a sabotage caught by the WRONG test counts as an escape.
 *
 * A test that cannot fail is this repo's most-recorded defect shape, and the guard
 * added in §3.143 exists precisely to catch a fixture that stops checking. So the
 * guard itself has to be shown to fail: each row below breaks one thing the guard
 * claims to protect, runs `test-support-registry.test.ts`, and requires RED.
 *
 * ⚠️ THIS SCRIPT CANNOT FAIL SILENTLY, and that is deliberate — the repo's own
 * catalogue of verification failures is full of harnesses that reported something
 * other than "I didn't check". Every row must either (a) apply its edit, or (b) be
 * reported as NOT APPLIED and counted as an escape. A row whose `find` text is
 * missing is a CHANGED SOURCE, not a passing sabotage.
 *
 * Usage: node scripts/sabotage-honest-test-fixtures.mjs
 * Exit 0 iff every row went RED. Restores every file it touched, always.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUPPORT = join(ROOT, 'packages/ai/src/test-support.ts');
const GUARD = join(ROOT, 'packages/ai/src/test-support-registry.test.ts');
const ENGINE = join(ROOT, 'packages/core/src/engine.ts');
const ARGS_GUARD = join(ROOT, 'packages/core/src/apply-action-arguments.test.ts');

/** Which suite a row's `expect` should be looked for in. Defaults to the fixture guard. */
const SUITES = { fixture: GUARD, args: ARGS_GUARD };

/**
 * One sabotage: `file`, the exact text to replace, what to replace it with, and the
 * guard test whose failure proves the break was seen. `expect` is matched against
 * the vitest output so a row cannot be satisfied by some OTHER test failing — which
 * is how a sabotage silently stops testing what it names.
 */
const SABOTAGES = [
  {
    name: 'the original defect: get() returns undefined for an unknown id',
    file: SUPPORT,
    find: '      throw new Error(unregisteredPrimitiveMessage(id, registry.ids));',
    replace: '      return undefined;',
    expect: 'THROWS on an unregistered primitive',
  },
  {
    name: 'the failure message stops naming the buildRegistry escape',
    file: SUPPORT,
    find: "      const registry = createTestRegistry(buildRegistry());',",
    replace: "      const registry = createTestRegistry(SOMETHING);',",
    expect: 'names the primitive and both one-line escapes',
  },
  {
    name: 'has() claims to know every id',
    file: SUPPORT,
    find: '    has: (id) => registry.has(id),',
    replace: '    has: () => true,',
    expect: 'keeps has() and ids honest',
  },
  {
    name: 'register() silently drops the caller body',
    file: SUPPORT,
    find: '      registry.register(id, primitive);',
    replace: '      void id, primitive;',
    expect: 'accepts a body registered by the caller',
  },
  {
    name: 'the supplied real bodies are ignored',
    file: SUPPORT,
    find: '  if (bodies) {',
    replace: '  if (false && bodies) {',
    expect: 'layers real bodies underneath',
  },
  {
    // Both files move together on purpose: sabotaging the helper ALONE also breaks
    // the table-consistency test, and a row that is caught by a different test than
    // the one it names has not shown that test works.
    name: 'a fixture helper invents vocabulary no real card registers',
    edits: [
      {
        file: SUPPORT,
        find: "    effects: [{ primitive: 'destroyTarget', params: { what: 'creature' } }],",
        replace: "    effects: [{ primitive: 'destroy', params: { what: 'creature' } }],",
      },
      {
        file: GUARD,
        find: "{ helper: 'destroyDef', primitive: 'destroyTarget', def: destroyDef('D') },",
        replace: "{ helper: 'destroyDef', primitive: 'destroy', def: destroyDef('D') },",
      },
    ],
    expect: 'every primitive a fixture helper mints',
  },
  {
    name: 'the primitives table goes stale against its helpers',
    file: GUARD,
    find: "{ helper: 'sweeperDef', primitive: 'destroyAll', def: sweeperDef('W') },",
    replace: "{ helper: 'sweeperDef', primitive: 'dealDamage', def: sweeperDef('W') },",
    expect: 'the table matches what the helpers actually declare',
  },
  {
    name: 'the local-body set grows without a parity case',
    file: SUPPORT,
    find: "const LOCAL_PRIMITIVE_IDS = ['dealDamage'] as const;",
    replace: "const LOCAL_PRIMITIVE_IDS = ['dealDamage', 'loseLife'] as const;",
    expect: 'writes exactly one primitive body of its own',
  },
  {
    name: 'the copied dealDamage stops marking creature damage',
    file: SUPPORT,
    find: '    perm.damageMarked += amount;',
    replace: '    perm.damageMarked += 0;',
    expect: 'lethal damage to a creature',
  },
  {
    name: 'the copied dealDamage gets the face sign wrong',
    file: SUPPORT,
    find: '      p.life -= amount;',
    replace: '      p.life += amount;',
    expect: 'damage to the face',
  },
  {
    name: 'the copied dealDamage stops refusing a zero amount',
    file: SUPPORT,
    find: '    if (amount <= 0) return;',
    replace: '    if (amount < 0) return;',
    expect: 'zero damage changes nothing and says nothing',
  },
  {
    name: 'the copied dealDamage stops refusing a negative amount',
    file: SUPPORT,
    find: '    if (amount <= 0) return;',
    replace: '    if (amount < -99) return;',
    expect: 'negative damage changes nothing and says nothing',
  },
  {
    name: 'the copied dealDamage hits the face when its target has already left',
    file: SUPPORT,
    find: '    if (!perm) return; // target fizzled — safe no-op',
    replace: '    if (!perm) { ctx.state.players.B.life -= amount; return; }',
    expect: 'a fizzled target changes nothing and says nothing',
  },
  {
    name: 'the copied dealDamage invents a victim when given no target',
    file: SUPPORT,
    find: '    if (target === undefined) return;',
    replace: "    if (target === undefined) { ctx.state.players.B.life -= amount; return; }",
    expect: 'no target at all changes nothing and says nothing',
  },
  {
    name: 'the registry stops wiring its body into a real cast',
    file: SUPPORT,
    find: "  registry.register('dealDamage', (ctx) => {",
    replace: "  registry.register('dealDamage_typo', (ctx) => {",
    expect: 'is the body a real cast actually resolves',
  },

  // --- the applyAction third-argument refusal (§3.143, the neighbouring trap) ---
  {
    name: 'applyAction stops refusing a non-config third argument',
    suite: 'args',
    file: ENGINE,
    find: '  assertIsRulesConfig(config);',
    replace: '  void 0;',
    expect: 'throws on the `{ registry }` mis-call',
  },
  {
    name: 'the refusal stops naming the call that fixes it',
    suite: 'args',
    file: ENGINE,
    find: "      'always `{ registry }` — pass `applyAction(state, action, undefined, registry)` instead. ' +",
    replace: "      'always a registry. ' +",
    expect: 'names the correct call in the failure',
  },
  {
    name: 'the refusal over-fires and rejects a legitimate custom config',
    suite: 'args',
    file: ENGINE,
    find: "  if (typeof (config as { startingLife?: unknown }).startingLife === 'number') return;",
    replace: '  if (false) return;',
    expect: 'accepts a CUSTOM config',
  },
];

const originals = new Map();
function snapshot(file) {
  if (!originals.has(file)) originals.set(file, readFileSync(file, 'utf8'));
}
function restoreAll() {
  for (const [file, text] of originals) writeFileSync(file, text);
}

/** Run one guard suite. Returns { red, output }. A crash counts as RED only if the expectation appears. */
function runGuard(suite) {
  try {
    const out = execFileSync('npx', ['vitest', 'run', SUITES[suite ?? 'fixture'], '--reporter=basic'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    return { red: false, output: out };
  } catch (error) {
    return { red: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

let escapes = 0;
const rows = [];
try {
  for (const s of SABOTAGES) {
    const edits = s.edits ?? [{ file: s.file, find: s.find, replace: s.replace }];
    for (const e of edits) snapshot(e.file);
    const missing = edits.filter((e) => !readFileSync(e.file, 'utf8').includes(e.find));
    if (missing.length > 0) {
      // NOT a pass. The source moved and this row tested nothing.
      rows.push({ name: s.name, verdict: 'NOT APPLIED — `find` text missing (source changed?)' });
      escapes++;
      continue;
    }
    for (const e of edits) {
      writeFileSync(e.file, readFileSync(e.file, 'utf8').replace(e.find, e.replace));
    }
    const { red, output } = runGuard(s.suite);
    const named = output.includes(s.expect);
    if (red && named) {
      rows.push({ name: s.name, verdict: 'CAUGHT' });
    } else if (red) {
      rows.push({ name: s.name, verdict: `RED, but not by "${s.expect}" — the sabotage was seen by the WRONG test` });
      escapes++;
    } else {
      rows.push({ name: s.name, verdict: 'ESCAPED — stayed green' });
      escapes++;
    }
    for (const e of edits) writeFileSync(e.file, originals.get(e.file));
  }
} finally {
  restoreAll();
}

console.log('\nsabotage — AI test-fixture registry guard');
for (const r of rows) console.log(`  ${r.verdict === 'CAUGHT' ? 'ok  ' : 'FAIL'}  ${r.name}\n        ${r.verdict}`);
console.log(`\n${rows.length - escapes}/${rows.length} caught, ${escapes} escaped`);
process.exit(escapes === 0 ? 0 : 1);
