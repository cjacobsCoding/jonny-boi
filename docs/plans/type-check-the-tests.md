# No test file in `packages/` is type-checked — 228 errors, 26 of them wrong argument counts

Found on 2026-09-20 by PR #82 (infinite combos, stage 1), which went red in CI for a reason that had
nothing to do with infinite combos.

## How it surfaced

Stage 1 added one line to the engine's action tail:

```ts
if (config.comboDetectionSeats.length > 0) noteComboAction(state, action, config, emit);
```

CI failed with `TypeError: Cannot read properties of undefined (reading 'length')` in **two** test
files that had nothing to do with the feature. `applyAction` is **positional** —
`(state, action, config, registry)` — and both files were passing an options bag in the **config**
slot:

| file | spelling | calls |
|---|---|---|
| `packages/ai/src/copy-target-pilot.test.ts` | `{ registry }` | 3 |
| `packages/core/src/copy.test.ts` | `{ registry, config: undefined }` | 6 |

So nine tests had been driving the Clone pipeline with **a rules config that had none of its fields
and no effect registry at all**, and passing. They were not broken by the new line; they were
*exposed* by it. Both are fixed on `feat/infinite-combos`.

⚠️ **The first sweep for the shape missed the second file and was reported as complete**, because the
grep required the `{ registry }` shorthand. A search for the wrong name returns exactly what a
genuine absence returns — which is why the fix below is a type-checker and not a grep. **The
type-checker is the only sweep here that cannot miss a spelling.**

## The cause, and it is one line per package

Every package's `tsconfig.json` excludes its own tests:

```json
"exclude": ["src/**/*.test.ts"]
```

`core`, `cards`, `sim`, `ai` and `protocol` all do it. `npm run build` type-checks `src` and never
sees a test file, and vitest does not type-check at all — so a test can pass a wrongly-typed
argument to anything, forever, and both gates stay green.

**`apps/web` is NOT affected** and is the proof the fix is viable: its tsconfig includes
`src/**/*.ts` and `src/**/*.tsx` with no exclude, and its build runs `tsc -p tsconfig.json`. Its
tests are type-checked today and its build is green.

## The measurement — take the number seriously before planning the work

Run per package with a `tsconfig.tests.json` that extends the real one and empties `exclude`
(committed beside this plan, so the next person re-measures rather than trusting this table):

```
npx tsc --noEmit -p packages/<pkg>/tsconfig.tests.json
```

| package | errors | files |
|---|---|---|
| cards | 136 | 39 |
| core | 42 | 23 |
| ai | 28 | 11 |
| sim | 20 | 6 |
| protocol | 2 | 1 |
| **total** | **228** | **80** |

By error code, across all five:

| code | count | what it is |
|---|---|---|
| TS2322 | 100 | wrong type assigned |
| **TS2554** | **26** | **wrong argument count — today's defect, 26 more of them** |
| TS2353 | 21 | object literal has properties the type does not |
| TS2339 | 19 | property does not exist on the type |
| TS2345 | 11 | wrong argument type |
| TS18048 | 11 | possibly `undefined` |
| others | 40 | casts, missing exports, unused, one rootDir config issue |

**The 26 `TS2554` are the reason this is not cosmetic.** Every one is a call whose arguments do not
match its function, which is exactly the shape that just shipped nine silently-wrong tests to `main`.
A `TS2322` or `TS2339` in a test is usually a sloppy fixture; a wrong argument count is a test that
may be exercising a different code path than the one it names.

⚠️ One of the errors is **not** a real defect: `TS6059` in
`packages/core/src/conformance/test-collection.test.ts` — it imports `vitest.config.ts` from the repo
root, which is outside the package's `rootDir`. That is a tsconfig shape problem, not a bad call, and
it needs a different `rootDir`/`composite` answer rather than a code change. **Do not "fix" it by
deleting the import**; that test reads the vitest config on purpose.

## The shape of the work

**Triage by code, not by file.** Fix the 26 `TS2554` first and report what each one turned out to be
— a harmless extra argument, or a test that was not testing what it claimed. That answer is the
whole value of this lane, and it should be in the report as a count of each.

Then the rest, package by package, smallest first (`protocol` 2 → `sim` 20 → `ai` 28 → `core` 42 →
`cards` 136), committing per package so a partial lane still lands value.

**The guard is the point.** The lane is not done when the errors are zero; it is done when the
exclude is gone and CI fails if it comes back:

- drop `"exclude": ["src/**/*.test.ts"]` from each package's `tsconfig.json`, so the ordinary
  `npm run build` type-checks tests the way `apps/web` already does;
- if any package genuinely cannot include its tests in the emitting build, it gets a
  `tsconfig.tests.json` **wired into `npm run verify`** — not a file that exists and nobody runs.

## Acceptance

1. `npm run build` at the root type-checks every `packages/*/src/**/*.test.ts` and exits 0.
2. Re-adding one of the original bad calls (`applyAction(state, action, { registry })`) makes the
   build **fail**. Watch it go red — a check that cannot fail is not a check, and this whole lane
   exists because two gates could not fail.
3. The full suite stays green: `529+` files, no drop in the test count. A type fix that quietly
   changes what a test asserts is a regression, so report any test whose behaviour changed and why.
4. The 26 `TS2554` are reported individually: harmless, or a real defect found. Give the count of
   each.
5. Numbers with provenance. If a closer measurement is smaller than the 228 above, **report the
   smaller number** — that table was produced by the command in this file and nothing else.

## Scope

- **Owned:** `packages/*/tsconfig.json`, `packages/*/tsconfig.tests.json`, and any
  `packages/**/*.test.ts` the type-checker names.
- **Off-limits:** non-test source, `apps/web` (already correct), the pool and its generated
  artifacts, `main`.
- ⚠️ **Collision:** this lane touches test files across every package, so it will conflict with any
  lane adding tests. Land it between waves, not beside one. Check the board first.
