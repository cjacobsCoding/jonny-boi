# WASM spike — is compiling the rules-engine hot path to WebAssembly worth it?

**Answer: no. Recommend JS-FLAT instead.** WASM's entire realistic contribution over plain
JavaScript, on the best kernel this engine has, is **+0.4% sim throughput**. The thing the profile
actually points at — the per-action state copy — is worth a **measured 1.53×**, and it is a plain-JS
data-layout change.

This directory is a **spike**, not product code. It is deliberately outside the npm `workspaces`
globs and outside the root `vitest` `include`, so `npm run build` and `npm test` at the repo root
neither build it nor run it. Nothing in `packages/` or `apps/` was modified. Both root commands were
re-run and pass (`98 files, 1597 tests, 0 failed`).

---

## 1. The profile — where the time actually goes

`node --cpu-prof` over a seeded 280-game gauntlet through the real
`runGauntlet → runMatch → generateLegalActions/applyAction` path, on compiled JS (not `tsx` — the
loader's own transpile work landed at the top of the first profile and skewed every ratio).

### Heuristic pilot — 280 games, 53 games/s, 5.56 s of sampled CPU

| Bucket | Self time |
|---|---|
| **`core: cloneState`** | **27.20%** |
| `core: engine` (actions, priority, stack) | 18.80% |
| `core: other` | 11.65% |
| **`core: mana + payment`** | **10.90%** |
| `ai: pilot scoring` | 10.59% |
| `sim: harness` | 7.16% |
| **GC + allocation (V8)** | **6.26%** |
| V8 builtins | 3.01% |
| `core: combat` | 0.95% |
| `core: continuous-effects layering` | 0.79% |

Top single functions: `cloneInstance` 12.04%, `cloneState` 8.50%, `generateLegalActions` 6.00%,
`planManaPayment` 5.95%, `(garbage collector)` 5.65%, `clonePlayer` 4.46%, `payFixedCost` 2.59%.

### MCTS pilot — 14 games, 103 minutes, 1907 s of sampled CPU

| Bucket | Self time |
|---|---|
| **GC + allocation (V8)** | **69.52%** |
| `core: engine` | 9.76% |
| `ai: pilot scoring` | 7.97% |
| `core: other` | 6.00% |
| `core: mana + payment` | 5.44% |
| `core: cloneState` | 0.35% |

Two things follow immediately:

1. **This engine's hot path is allocation, not arithmetic.** Nearly a third of the heuristic sim is
   copying the game state and collecting the result; seven-tenths of the MCTS sim is the garbage
   collector. WASM does not make JavaScript allocate less — it only helps if the state itself lives
   in linear memory, which is a full engine port, not a kernel.
2. **The classic "WASM kernel" candidates are already free.** Continuous-effects layering is 0.79%
   and combat is 0.95%. Even made infinitely fast they are worth under 2%.

`cloneState` is only 0.35% under MCTS because MCTS already uses `applyActionInPlace`; its garbage is
the engine's ordinary per-action allocation (event arrays, action objects, fresh mana pools), not the
clone.

---

## 2. The kernel chosen, and why

**Mana payment + payment planning** (`core/src/mana.ts`, `core/src/mana-plan.ts`) — 10.90% of self
time. It is the **largest slice of the profile with a genuinely narrow, purely numeric interface**:
a 6-int pool, a 7-int cost, and a ragged list of 6-int production modes in, an ordered list of
(source, mode) pairs out.

Everything hotter has no such interface. `cloneState` (27.2%) *is* the object graph. `generateLegalActions`
(6.0%) walks the battlefield and both hands and returns heterogeneous action objects. Pilot scoring
(10.6%) reads card definitions, types, names and registry ids. **That is itself a finding: outside
mana payment, this engine has no kernel with a boundary you could pass numbers across.**

The corpus is 50,675 payment questions **recorded off real gauntlet games**, never synthesised. Its
shape matters as much as the timings:

```
sources per case:   mean 1.41   max 14   (44% of cases have zero untapped sources)
modes per source:   mean 1.22   max 5
mana value of cost: mean 2.68   max 7
cases with hybrid:  2.0%
```

The kernel is called millions of times on inputs of ~1.4 sources. Per-call overhead, not arithmetic
throughput, is what it is made of.

---

## 3. Benchmarks — JS vs WASM vs JS-with-flat-layout

50,675 recorded cases, median of 7 repetitions, warmed, results folded into a checksum so nothing is
optimised away. Representative run (three runs agree within noise):

| Arm | ns/case | vs shipped |
|---|---|---|
| 1. shipped JS (objects, as it runs today) | 4,593 | 1.00× |
| 2. **js-flat, end-to-end** (marshal from the engine's objects each call) | **1,406** | **3.3×** |
| 3. js-flat, kernel only (data already flat) | 498 | 9.2× |
| 4. **wasm, end-to-end** (marshal + cross the boundary each call) | **1,293** | **3.6×** |
| 5. wasm, per-call crossing (data already flat) | 362 | 12.7× |
| 6. wasm, batch ceiling (all cases resident, ONE crossing) | 180 | 25.5× |

GC during each arm: shipped **24–27 ms**; every flat arm **≈ 0 ms**.

**Bit-identical verification:** all three implementations agree on all 50,675 cases — the full ordered
plan (source index *and* mode index per tap) plus the three-way distinction between unpayable /
already-paid / planned. `verify.js` reports `js-flat mismatches: 0, wasm mismatches: 0`.

### Reading the table honestly

- **WASM over JS-flat, both end-to-end: 1,406 / 1,293 = 1.09×.** That is the only comparison a
  shippable integration could realise, because the engine's state is an object graph and any flat
  kernel must marshal into it per call.
- Arms 3, 5 and 6 look impressive and are all unshippable as stated: they assume the data is already
  flat, which is the very thing that is not true today.
- Arm 6 (25×) is included precisely because it is the ceiling. Reaching it requires the engine's
  state to live in WASM linear memory — i.e. porting the whole engine, not a kernel.

### What that is worth to the product

The kernel is 10.9% of sim time, so by Amdahl:

| Change | Sim throughput |
|---|---|
| js-flat mana kernel | **1.084×** (+8.4%) |
| wasm mana kernel | **1.089×** (+8.9%) |
| **WASM's marginal gain over plain JS** | **1.004× (+0.4%)** |
| wasm at the unshippable batch ceiling | 1.117× (+11.7%) |

**+0.4% is the whole prize for adding a second toolchain, a second language, a build step, a
`.wasm` asset in the PWA, and a debugging story where a stack trace stops at the boundary.**

---

## 4. The cheaper adjacent option, measured

### The clone, under three layouts

20,000 clones per pass, states captured from real games (mean 121.9 card instances), median of 11:

| Arm | ns/clone | vs shipped |
|---|---|---|
| A. `cloneState` (shipped object graph) | 8,060 | 1.00× |
| B. flat, 23 separate typed arrays (one per column) | 18,093 | **0.45× — slower** |
| C. flat, ONE arena, fresh allocation per clone | 3,922 | 2.06× |
| D. **flat arena → pooled buffer (0 allocations, memcpy only)** | **312** | **25.8×** |

Both flat mirrors are proved **lossless** by round-tripping back to a `GameState` and comparing a
canonical dump that includes every zone's instance sequence *in order* (library order is the shuffle)
and every mutable field. The engine's own `serializeState` is deliberately not used for this — it
reports zone *sizes*, so it would pass a mirror that reshuffled a library.

Arm B is the trap and is kept in the repo for that reason: **"use typed arrays" is not the
optimisation — "stop allocating" is.** Twenty-three small `slice()` calls lose to a deep copy.
Even one arena allocation per clone (arm C) is only ~2×. The 25× appears only when the destination
buffer is already owned.

### The end-to-end ceiling, measured on the real engine

Not projected. `packages/core` already exports both entry points, so the same 240 games were played
twice — once through `applyAction` (clones every action) and once through `applyActionInPlace` (no
clone at all), which the spike's loop is entitled to use because it owns its state exclusively:

```
applyAction        (clones every action)   2328 ms   103.1 games/s   gc 22 ms
applyActionInPlace (no clone at all)       1524 ms   157.5 games/s   gc  3 ms

CEILING for removing the per-action state copy: 1.53× sim throughput
games diverging between the two loops: 0  → identical games, the comparison is valid
```

Zero divergences across all 240 games (winner, turn count, action count, both final life totals), so
the two loops genuinely played the same games and the ratio is real.

**1.53× from a plain-JS data-layout change, versus +0.4% from WASM.**

---

## 5. Recommendation

### NO-GO on WebAssembly. JS-FLAT instead.

**Why not WASM, in the measured numbers:**

- The best kernel available is 10.9% of the sim, and WASM beats plain-JS-flat on it by 1.09×, worth
  **+0.4% sim throughput**.
- Every hotter part of the profile is object-graph work with no numeric boundary — it cannot be
  handed to WASM one kernel at a time.
- The one path where WASM would genuinely win big (state resident in linear memory, no GC at all) is
  a **full rewrite of the rules engine in a second language**, against a codebase whose §2 seams,
  effect-primitive registry, Oracle-text card compiler and 1,597 tests are all built around the
  TypeScript object model.
- Cost side, honestly: a second toolchain in CI; a `.wasm` asset to ship, version and cache in the
  PWA and instantiate in the sim Web Worker; debugging that stops at the boundary (no source maps
  into AssemblyScript from a Node profile); and a determinism surface that now spans two compilers.
  The engine must stay bit-reproducible in both Node and a browser worker — every extra compiler in
  that path is a new way for the A/B verdicts to drift.

**What to do instead, in priority order (all plain TypeScript):**

1. **Kill the per-action clone.** Measured ceiling **1.53×**, the single largest win available. The
   engine already has `applyActionInPlace`; the work is giving the sim's match loop the same
   exclusive-ownership guarantee MCTS has, or moving `GameState` to an arena with a pooled
   destination buffer (arm D, 25×). Note the ordering trap: a naive column-per-field flat layout is
   *slower* (arm B). The design must be one buffer and a pool.
2. **Put the engine on an allocation diet.** GC is 6.3% of the heuristic sim and **69.5%** of the
   MCTS sim, and under MCTS almost none of it is the clone — it is per-action event arrays, action
   objects and fresh mana pools. This is where MCTS's throughput actually is.
3. **Then, if still wanted, flatten the mana kernel in plain JS.** Worth **+8.4%** on its own,
   bit-identical, no new toolchain, no boundary. `src/kernel-js-flat.ts` is a working, verified
   implementation that can be lifted almost as-is.

For context on item 2: `DEFAULT_MCTS_CONFIG.simulationsPerDecision` is 160 with
`maxDecisionMillis: Infinity`, and the profiled MCTS gauntlet ran **14 games in 103 minutes**
(0.0023 games/s). That is worth a look independently of anything here.

---

## 6. Running it

The spike keeps its own `node_modules` (AssemblyScript only) and is not part of the root install.

```bash
npm install                     # at the repo ROOT, once — the spike imports built packages
npm run build                   # at the repo ROOT — the spike reads packages' dist/

cd spikes/wasm
npm install                     # AssemblyScript, spike-local
npm run build                   # compile the .wasm, then transpile the spike's TS

npm run profile                 # capture results/heuristic.cpuprofile
node build/analyze-profile.js results/heuristic.cpuprofile 35

npm run corpus                  # record results/corpus.json from real games (needed by verify/bench)
npm run verify                  # the bit-identical gate across all three arms
npm run bench                   # the six-arm kernel benchmark
node build/bench-clone.js       # the clone-layout benchmark
node build/bench-noclone.js     # the measured end-to-end no-clone ceiling
```

### Files

| File | What it is |
|---|---|
| `src/workload.ts`, `src/run-workload.ts` | the representative seeded gauntlet, pilot selectable |
| `src/analyze-profile.ts` | `.cpuprofile` → self time by function and by decision-relevant bucket |
| `src/corpus.ts`, `src/capture-corpus.ts` | records real payment questions off real games |
| `src/kernel.ts` | the kernel contract and the flat encoding |
| `src/kernel-js-shipped.ts` | arm 1 — `packages/core`'s planner, unmodified |
| `src/kernel-js-flat.ts` | arm 2 — flat layout, plain JS |
| `assembly/payment.ts`, `src/kernel-wasm.ts` | arm 3 — AssemblyScript kernel + host |
| `src/verify.ts` | the bit-identical gate |
| `src/bench.ts` | the six-arm kernel benchmark |
| `src/flat-state.ts` | the naive column-per-field mirror (arm B — the trap) |
| `src/flat-arena-state.ts` | the one-arena mirror (arms C/D) |
| `src/bench-clone.ts` | the clone-layout benchmark + losslessness gate |
| `src/bench-noclone.ts` | the measured end-to-end no-clone ceiling |

Measured on Windows 11, Node v24.17.0, 12 logical cores.
