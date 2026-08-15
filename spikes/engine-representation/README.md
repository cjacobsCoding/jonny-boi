# Engine representation spike — is the hot path's cost the DATA or the LANGUAGE?

**Answer: it is the LANGUAGE, not the data — and neither of them is the thing to do first.**

Three findings, each measured with all arms playing byte-identical games:

1. **Flattening the representation in TypeScript is a LOSS for forward simulation** — 0.61–0.70×
   (a 30–39% slowdown), stable across every run. It wins only where it replaces *cloning* with
   *undo*: 1.7–2.8× at rollout depth 1, break-even around depth 8, and a loss beyond that.
   **This is the control the earlier WASM spike never ran, and it comes back negative.**
2. **The language is worth 2.1–3.5×, with the representation held exactly constant.** That is the
   clean A/B the previous spike could not make, and it is much larger than the +0.4% it reported.
3. **The algorithmic change already in flight beats both, on today's object engine, with no port
   at all: 12.2–15.5× measured.** A language port is worth **5.6–5.8×** *on top of* that — real,
   but second.

**Recommendation: do NOT port the engine now.** Land the algorithmic change, then kill the
per-action clone in plain TypeScript. Revisit WASM only if the product is still short of what it
needs after both — and if it is revisited, it must be an **all-in whole-engine port**, never a
hybrid, for reasons in §6.

> This directory is a **spike**, not product code. It sits outside the npm `workspaces` globs and
> outside the root `vitest` include, so `npm run build` and `npm test` neither build nor run it.
> Nothing in `packages/` or `apps/` was modified.

---

## 1. Why this spike exists, and how it differs from `spikes/wasm`

The earlier spike ([`spikes/wasm/README.md`](../wasm/README.md)) returned **NO-GO at +0.4%** and that
result is correct — but it answered a narrower question than the one now being asked. It took the
**existing JS object-graph design** and recompiled one *kernel* (mana payment) into WASM. Same data
layout, different runtime, on the only 10.9% slice of the profile with a numeric boundary. It even
observed the real obstacle in passing: *"outside mana payment, this engine has no kernel with a
boundary you could pass numbers across."*

That leaves the actual question open. `applyActionInPlace` + `generateLegalActions` are called
**~8 million times per game** and are ~80% of MCTS cost, and the suspicion was that their cost is the
**object graph itself** rather than JavaScript. Testing that needs the *same rules* implemented with
*different representations* — which no existing artefact provides.

### The experimental design

| arm | representation | language | what it isolates |
|---|---|---|---|
| **A** | object graph: instance objects, ordered zone arrays, allocated action objects, deep `cloneState` | TypeScript/JS | today's design |
| **B** | flat: one `Int32Array` arena, struct-of-arrays, packed i32 actions, **delta undo journal** | TypeScript/JS | **representation alone** (A→B) |
| **B+** | arm B with the biggest remaining indirection removed | TypeScript/JS | a steelman, so the conclusion rests on the best flat JS measured |
| **C** | *identical* to arm B | AssemblyScript → **WASM** | **language alone** (B→C) |

Arm B is the essential control. **A→B holds the language constant and changes only the data.
B→C holds the data constant and changes only the runtime.** Neither comparison was available before.

Arm D (a native binary, to price the WASM tax) **could not be measured**: this box has no `emcc`,
`clang`, `rustc`, `cargo`, `wasm-pack`, `g++` or `zig`, and installing one is a large external
download. §7 says what that costs the conclusion and why arm C is still a *lower* bound on native.

### Equivalence is the precondition, not a footnote

A speed number for a prototype that plays a different game is worse than no number, because it looks
like evidence. Borrowing the technique from `packages/ai/bench/mcts-bench.mjs`, every arm folds a
transcript digest over **every decision** — action kind, card, target, declaration variant, step,
priority holder, both life totals, battlefield size — plus the winner and turn count. Two engines can
agree on who won while disagreeing about every move in between; a transcript digest cannot be fooled
that way.

`src/verify.mjs` gates the whole report and currently passes:

```
1. full-game transcripts  60 games x 4 arms byte-identical, 60/60 decided, 308 actions/game
2. search workload        leaf checksums + transition counts agree at all 8 rollout depths
3. microbenchmarks        all four return identical values across all four arms
4. the wasm module        no garbage collector; 3 __new call sites, all in the start function
```

The benchmark itself refuses to print a timing until the gate passes.

---

## 2. Results — full-game playout (forward simulation, no search)

150 seeded games, best-of-9 **interleaved** rounds. Three independent runs are quoted
(run1 / run2 / run3) because absolute times on this box move by up to 1.7x between runs while the
ratios do not.

| arm | games/sec | ns/action | vs A |
|---|---|---|---|
| **A** objects (TS) | 2471 / 2742 / 4236 | 1286 / 1159 / 750 | 1.00× |
| **B** flat (TS) | 1584 / 1907 / 2815 | 2006 / 1666 / 1129 | **0.64× / 0.70× / 0.66×** |
| **B+** flat tuned (TS) | — | — | **0.61×** |
| **C** flat (WASM) | 4896 / 6495 / 6866 | 649 / 489 / 463 | **1.98× / 2.37× / 1.62×** |
| | | **C vs B** | **3.09× / 3.40× / 2.45×** |

Absolute throughput moves by a factor of 1.7 between run 1 and run 3; **B vs A moves by 0.06×**. The
ratio is the durable quantity here and the absolute games/sec is not — quote the former, never the
latter.

GC events during each 150-game playout: **A 0, B 0, C 0**; heap delta A 0.45–2.32 MB, B and C 0.01 MB.
The flat arms genuinely allocate nothing — and it does not save them.

> **One measurement that did NOT resolve, reported rather than dropped:** the cost of the undo journal
> on a forward-only playout came out at 1.08×, 1.54× and 0.92× across the three runs. That one is
> taken outside the interleaved loop and the spread swamps the effect, so **the journal's forward-only
> cost is not resolvable at this noise floor**. It is kept in the report because arm B pays it in every
> other number above, so any error it carries is against arm B, never for it.

### Arm B+ — the steelman that failed, and why it matters

Arm B losing invites "your flat arm is just badly written". Two rounds of tuning were done and both
are reported:

- **Storing the card row as a pre-multiplied offset** instead of a card index (removing a multiply
  from every card-field read) — kept in arm B; worth ~1.0–1.35×.
- **Giving every instance its own copy of its card row** at a power-of-two stride, so `cardOf(id)` is
  a shift with no memory load at all — this is **arm B+, and it made things WORSE (0.81× of arm B)**.
  The shared 19-card table is 912 bytes and lives permanently in L1; duplicating it per instance
  grew it to 7.5 KiB and lost more to cache than it saved in indirection.

So the flat-TypeScript result is not a first draft. **The obvious optimisation is negative.**

### Why flat TypeScript loses — the mechanism

`inst.def.power` is two pointer loads that V8's inline caches make nearly free. The flat equivalent is
two **bounds-checked** `Int32Array` loads. JavaScript has no way to spell "I have already proved this
index is in range", so flattening trades free property loads for checked array loads on the engine's
single most common operation.

This is measurable directly. Compiling arm C **with bounds checks left in** (`build/engine-checked.wasm`,
generated by stripping every `unchecked()`) splits the language win in two:

| step | playout | search (depth 1) |
|---|---|---|
| B (JS flat) → WASM **with** bounds checks | **2.00×** | **1.92×** |
| … → WASM **without** bounds checks | **1.43×** | **1.97×** |
| **B → C total** | **2.86×** | **3.78×** |

Half the language win is codegen that JavaScript could in principle match; the other half is an
optimisation JavaScript **cannot express**. Note this also confirms the earlier spike's own trap
finding ("*use typed arrays*" is not the optimisation — "*stop allocating*" is) and supplies the
mechanism it lacked.

---

## 3. Results — per-operation cost

Fixed mid-game position, 60,000 iterations, best-of-9 interleaved. Two runs.

| operation | A ns | B ns | C ns | B vs A | C vs A | C vs B |
|---|---|---|---|---|---|---|
| legal-action generation | 406 / 268 | 525 / 273 | 162 / 97 | 0.77× / 0.98× | 2.51× / 2.77× | 3.24× / 2.83× |
| leaf evaluation | 183 / 101 | 295 / 177 | 102 / 65 | 0.62× / 0.57× | 1.80× / 1.55× | 2.90× / 2.74× |
| **undoable state transition** | 3896 / 2398 / 2988 | 559 / 352 / 428 | 135 / 102 / 102 | **6.98× / 6.81× / 6.98×** | **28.8× / 23.4× / 29.4×** | 4.13× / 3.44× / 4.21× |
| policy decision (score menu) | 1363 / 866 | 2086 / 1230 | 618 / 352 | 0.65× / 0.70× | 2.20× / 2.46× | 3.37× / 3.49× |

The transition row is the most reproducible number in the spike: **B vs A came out 6.98×, 6.81× and
6.98× on three separate runs.**

**Every row is a loss for flat TypeScript except the transition** — and the transition is a 7× win
purely because an object graph has no undo. Arm A's 3896 ns decomposes as **3908 ns of `cloneState`**
(32.6 ns × 120 instances) plus the apply; arm B rewinds a journal instead, and arm C does it in 135 ns.

That single row is the entire case for the flat representation, and §5 shows exactly when it pays.

---

## 4. Results — search, the shape the real MCTS bottleneck has

Rollouts from a fixed position; arm A must **clone the root per rollout** because an object graph
cannot undo, while B and C **rewind a journal**. ~12,000 transitions per cell, best-of-9 interleaved.

| depth | rollouts | A ms | B ms | C ms | B vs A | C vs A | C vs B |
|---|---|---|---|---|---|---|---|
| 1 | 12000 | 54.8 | 19.6 | 5.8 | **2.79×** | **9.53×** | 3.41× |
| 2 | 6000 | 32.7 | 18.1 | 5.0 | 1.80× | 6.61× | 3.67× |
| 4 | 3000 | 23.2 | 17.7 | 4.8 | 1.31× | 4.79× | 3.65× |
| 8 | 1500 | 16.3 | 16.4 | 4.6 | **0.99×** | 3.55× | 3.59× |
| 16 | 750 | 12.2 | 15.5 | 4.4 | 0.79× | 2.80× | 3.55× |
| 32 | 375 | 10.7 | 13.3 | 4.2 | 0.80× | 2.53× | 3.15× |
| 64 | 188 | 9.2 | 15.5 | 4.7 | **0.59×** | 1.96× | 3.31× |

**The flat representation's advantage is entirely the clone, and it decays with rollout depth**,
crossing into a loss at about depth 8. Arm C's advantage is flat across every depth (3.1–3.7×),
because it is a property of the runtime rather than of the amortisation.

---

## 5. The three levers, ranked on one workload

The choice on the table is not only "which language". Holding the **rollout budget** fixed at 400
rollouts per decision (a search budget is "how many rollouts", not "how many transitions") and
sweeping depth turns all three levers into one grid. Cost of ONE decision, in µs:

| depth | A objects | B flat TS | C flat WASM | B vs A | C vs A | C vs B |
|---|---|---|---|---|---|---|
| 1 | 1893 | 726 | 338 | 2.61× | 5.61× | 2.15× |
| 2 | 3128 | 1564 | 487 | 2.00× | 6.42× | 3.21× |
| 4 | 2465 | 1567 | 516 | 1.57× | 4.78× | 3.04× |
| 8 | 2893 | 2709 | 1337 | 1.07× | 2.16× | 2.03× |
| 16 | 4028 | 5712 | 1552 | 0.71× | 2.60× | 3.68× |
| 32 | 6671 | 9408 | 2958 | 0.71× | 2.25× | 3.18× |
| 64 | 15010 | 18620 | 6378 | 0.81× | 2.35× | 2.92× |
| 120 | 29328 | 35440 | 13809 | 0.83× | 2.12× | 2.57× |

Reading the grid — **moving DOWN a column is the algorithmic change; moving ACROSS a row is the port**:

Across two independent runs of this grid:

| lever | measured | what it costs to get |
|---|---|---|
| **ALGORITHM alone** (terminal rollout → depth-1 leaf eval, arm A, no port at all) | **12.2–15.5×** | `packages/ai` only; already in flight on `feat/hybrid-search` |
| REPRESENTATION alone (A→B, TypeScript both) | 1.66–2.61× at depth 1, **0.62–0.83× at depth 120** | rewrite `packages/core`'s state model; **negative for forward sim** |
| LANGUAGE alone (B→C, identical flat algorithm) | **2.15–3.49×** | a second toolchain and a second language |
| **PORT on top of the algorithm (A@1 → C@1)** | **5.6× / 5.8×** | the whole rewrite |
| everything (A@120 → C@1) | 70.5–86.9× | — |

The marginal value of the port — the row the decision actually turns on — is the **steadiest number
in the grid (5.6× and 5.8×)**, which is worth knowing given how much else here moves.

The algorithmic lever is the biggest *and* the cheapest *and* it is already being built by another
agent. The port's honest marginal value is the **5.6×** row — worth having, not worth having first.

Note the interaction, because it is the one genuinely pro-WASM finding here: **the algorithmic change
makes the port MORE attractive, not less.** Shallow rollouts are exactly the regime where clone cost
dominates and where flat+undo wins biggest (2.79× at depth 1 vs 0.59× at depth 64). The two levers
compound rather than overlapping.

---

## 6. The boundary, the bundle, and the product constraint

`CLAUDE.md` and `DESIGN.md` require the core to run **in the browser (PWA on PC + Android) inside a
Web Worker**, so a native-only core cannot serve the product — WASM is the only native option. What
that costs:

| item | measured |
|---|---|
| trivial JS→WASM call | **6.64 ns** (an identical JS call is 3.30 ns → **~3.3 ns marginal**) |
| copy the whole game state out of linear memory | **334 ns** for 6,864 bytes |
| `.wasm` module size | **18.6 KiB** uncompressed |
| one crossing for 150 games vs 150 crossings | 30.2 ms vs 30.6 ms — **immaterial** |

**The boundary is not the blocker, provided state stays inside the module.** At arm C's 489–649 ns per
action, one boundary call per action adds ~1%, and batching removes even that. But **one state
copy-out per action adds 51–68%** — and the product genuinely needs state in JavaScript for the match
viewer, the replay log, the event stream, the debug inspector (rule 3) and the online server. Those
consumers are all fine at *batch* granularity (per game, per decision) and fatal at *per-action*
granularity. Any port must be designed so that nothing reads state per action from JS.

Bundle cost is small (18.6 KiB against a main chunk of 642 kB raw / 170 kB gzip). Toolchain burden on
this Windows box is real but not prohibitive: AssemblyScript is an npm devDependency, no native SDK.

### If WASM is ever done, it must be ALL-IN — never a hybrid

The tempting shape is "WASM for the sim, TypeScript for interactive play". **That should be refused.**
This product's entire value proposition is a *statistically definitive* A/B verdict, and the sim's
paired common-random-numbers design assumes one engine with one behaviour. Two rules engines in two
languages, maintained in parallel, is two ways for the verdict to drift — and the drift would appear
as a card evaluation being subtly wrong, which is the failure mode this repo can least afford to ship.
Either the rules engine moves wholly to WASM (with the TS engine deleted, not kept), or it stays.

That also prices the port honestly: it is not "add a fast path", it is **re-homing the engine that
`packages/cards`' Oracle-text compiler, the effect-primitive registry, the choice system, the
attachment seam and 1,856 tests are all built around.**

---

## 7. What the prototypes did NOT implement, and how that biases the numbers

The model game ("MicroMTG", `src/spec.mjs`) is structurally faithful but small: 19 cards, 2 fixed
60-card two-colour decks, and a full turn structure with ordered zones, a stack, priority passes,
mana payment, targeting, combat with flying/lifelink/deathtouch/vigilance/haste, state-based actions,
and a separate until-end-of-turn continuous-effect list that effective P/T is layered over.

**Not implemented at all:** triggered abilities · activated abilities · the choice system ·
attachments (auras/equipment) · layered static effects · modal spells · {X} and derived values ·
replacement effects · hybrid/Phyrexian mana · planeswalkers · transform/DFC · alternative costs ·
the Oracle-text card compiler · the event log and replay · serialization · mulligans · tokens ·
multi-blocker damage-assignment ordering. Attack and block declarations are a fixed two-option menu
rather than subset enumeration.

### Calibration — measured, not asserted

`src/calibrate.ts` runs the **real `packages/core`** and the model in the same process:

Two runs, quoted run1 / run2:

| | REAL core | model | real/model |
|---|---|---|---|
| instances in a mid-game state | 120 | 120 | **1.00×** |
| actions per game | 761 | 300 | 2.53× |
| **branching factor** | **2.00** | **3.17** | **0.63×** |
| ns per `generateLegalActions` | 343 / 410 | 238 / 243 | **1.44× / 1.69×** |
| ns per `cloneState` | 4368 / 5522 | 2567 / 2606 | 1.70× / 2.12× |
| ns per cloned instance | 36.4 / 46.0 | 21.4 / 21.7 | 1.70× / 2.12× |
| ns per action (whole game) | 11533 / 15248 | 860 / 1142 | **13.42× / 13.35×** |
| clone as a multiple of one action | **0.38× / 0.36×** | 2.99× / 2.28× | — |
| real core: one undoable transition | 13500 / 11842 ns | — | — |

**Where the extrapolation is strong.** The instance count is *identical* (120) and the per-instance
clone cost is within 1.7×, so the clone-versus-undo result — the entire case for the flat
representation — is well calibrated. The model's branching factor is *higher* than the real engine's
and its `generateLegalActions` is within 1.44×, so action generation is if anything over-represented,
not under-represented.

A useful cross-check falls out of this: the clone is **36–38% of a real action's cost**, so removing
it has a ceiling of about **1.58×** — and the earlier spike measured that same end-to-end ceiling
independently at **1.53×**, by playing 240 identical games through `applyAction` and
`applyActionInPlace`. Two unrelated methods agreeing to within 3% is the strongest evidence in this
report, and it is what licenses trusting the clone/undo result at all.

**Where the extrapolation is weak, and which way it bends.**

- **Biases the language win UPWARD (the main risk).** The model's per-action work is 13.4× cheaper
  than the real engine's, and what it omits is disproportionately the work that does *not* flatten
  cleanly: effect-primitive dispatch through function references, string zone names, `Record<PlayerId,…>`
  and `Map` lookups in `indexContinuous`, heterogeneous action objects. The model's remaining work is
  almost pure integer/array manipulation — precisely WASM's best case. **Treat 2.1–3.5× as an
  optimistic bound on what a real port would deliver.**
- **Biases the flat/WASM win DOWNWARD.** Arm A produced *zero* GC events in this workload, whereas the
  real heuristic profile shows 6.3% GC (and the MCTS profile 69.5%, though the repo has already
  established that figure was largely a profiler artefact). The model's baseline therefore allocates
  less than the real engine does, understating the allocation advantage of the flat arms.
- **Arm C is a lower bound on native.** AssemblyScript is not clang: no autovectorisation, weaker
  instruction selection and loop optimisation. A real C++ or Rust port would be somewhat faster than
  arm C, not slower. What arm C *does* faithfully capture is the absence of a managed runtime — the
  emitted `.wat` contains no garbage collector and only three start-up allocations, and `verify.mjs`
  checks this rather than assuming it.

The net of those three: the **direction** of every finding is safe, the **magnitude** of the language
win is the number most likely to shrink on contact with the real engine, and the clone/undo finding is
the one that transfers most reliably.

---

## 8. Recommendation

### NO-GO on porting the engine now. The conclusion is about the REPRESENTATION, and it is negative.

**What to do FIRST, in order:**

1. **Land the algorithmic change (`feat/hybrid-search`) and measure it.** **12.2–15.5×** on today's engine,
   in `packages/ai` alone, with zero portability cost and no new toolchain. Nothing else in this
   report competes with it on value-per-unit-effort. Do not start any port before this lands.
2. **Kill the per-action clone in the sim's match loop.** Plain TypeScript; `applyActionInPlace`
   already exists. Two independent methods agree the ceiling is **1.53–1.58×**.
3. **Do NOT flatten `packages/core` into TypedArrays.** Measured **0.61–0.70×** on forward simulation,
   and the obvious tuning made it worse. The only part of the flat design worth having is the **undo**,
   and only for search — and search already has exclusive state ownership, so it can get most of that
   benefit without a representation rewrite.

**On WASM specifically — a qualified change to the earlier NO-GO.** The earlier spike's +0.4% was
right about a *kernel*; it is not the right number for a *whole-engine flat port*, which this spike
measures at **2.1–3.5× over the same design in JavaScript** and **5.6–5.8× over today's engine once
the algorithmic change lands**. That is a real, reproducible, boundary-inclusive number, not noise. It is
still not worth doing yet, because:

- the algorithmic lever is roughly 2.5× larger and costs a fraction as much;
- the win requires the state to live in linear memory, i.e. the full rewrite the earlier spike already
  identified — there is still no kernel with a numeric boundary to carve off incrementally;
- it must be all-in (§6), so it is a decision about where the rules engine *lives*, not an optimisation.

**What would change this recommendation:** if, after the algorithmic change and the clone removal, the
Lab's suggestion search is still short of the throughput the product needs, then the remaining
**5.6–5.8×** is the largest lever left and the port becomes the right call. At that point the first
concrete step is not to start porting — it is to build arm C's equivalent for **one real subsystem**
(the continuous-effects layering plus SBA scan, which are already close to flat) and check whether the
2.1–3.5× survives contact with the real rules surface, since §7 flags that as the number most likely
to shrink.

---

## 9. Running it

The spike keeps its own `node_modules` (AssemblyScript only) and is not part of the root install.

```bash
cd spikes/engine-representation
npm install                     # AssemblyScript, spike-local (came from the npm cache; no new download)
node codegen-layout.mjs         # regenerate assembly/generated.ts from src/layout.mjs + src/spec.mjs
npm run build:wasm              # compile build/engine.wasm + build/engine.wat

node --expose-gc src/verify.mjs # THE GATE — run this before believing any timing
node src/bench.mjs              # the three-arm benchmark (playout, GC, per-op, search, boundary)
node src/algorithmic.mjs        # the algorithm-vs-representation-vs-language grid

# calibration needs the repo's tsx, from the ROOT checkout's node_modules:
../../node_modules/.bin/tsx src/calibrate.ts
```

Captured outputs are in `results/` so the tables above can be checked without re-running anything.

### Files

| file | what it is |
|---|---|
| `src/spec.mjs` | the model game: constants, card table, decks, action encoding, RNG, digest |
| `src/layout.mjs` | the flat arena layout — the single source for arms B and C |
| `codegen-layout.mjs` | emits `assembly/generated.ts` so arms B and C cannot drift |
| `src/arm-a-objects.mjs` | arm A — object graph, `cloneState`, allocated action objects |
| `src/arm-b-flat.mjs` | arm B — flat arena, delta undo journal, zero hot-path allocation |
| `src/arm-b2-tuned.mjs` | arm B+ — the steelman that turned out slower (kept as evidence) |
| `assembly/engine.ts` | arm C — line-for-line port of arm B to AssemblyScript |
| `assembly/engine-checked.ts` | arm C with `unchecked()` stripped, to price bounds-check elision |
| `src/arm-c-wasm.mjs` | arm C host + boundary and state-copy microbenchmarks |
| `src/verify.mjs` | the equivalence gate (transcripts, search checksums, wasm has no GC) |
| `src/bench.mjs` | the three-arm benchmark |
| `src/algorithmic.mjs` | the three-lever grid |
| `src/calibrate.ts` | real `packages/core` vs the model, same process |

Measured on Windows 11, Node v24.17.0, 12 logical cores. Wall clock on this box drifts ~25% between
runs of identical code; every number above is a best-of-9 from interleaved rounds, and two independent
runs (three for the main benchmark) are quoted wherever they differ.
