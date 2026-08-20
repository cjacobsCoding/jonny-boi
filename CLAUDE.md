# jonny-boi — agent guide

> The engineering rules below are **committed here on purpose** so they travel to every clone on
> every machine. Do **not** rely on a per-machine `~/.claude/CLAUDE.md` to carry shared standards —
> it is not shared and may be absent. The repo is the only thing every contributor (human or agent)
> sees. Read this file and `DESIGN.md` at the start of every session.

**jonny-boi** — A Magic: The Gathering deck-tuning lab. Build a deck, let AI pilots play it hundreds
of games against the meta gauntlet, swap a single card, and get a **statistically definitive** verdict
on whether the deck got better — then let the engine suggest the next improvement. Real MTG cards and
Scryfall art, in a polished PWA that runs on PC, Android, and the browser.

Stack: **TypeScript monorepo** (npm workspaces) — a pure, DOM-free `core` rules engine + `cards` data
pool + `ai` pilots + `sim` harness + `data-tools` (Scryfall fetch/cache) + a React/Vite **PWA** in
`apps/web`. **Read [DESIGN.md](DESIGN.md) first — it is the single source of truth** for requirements,
architecture seams (§2), the roadmap (§3), and the parallel-development rules (§6). Integrate through
the seams; do not edit the core engine loop or shared scaffolding to bolt a feature on.

## Engineering rules (non-negotiable — every contributor, every machine)

1. **Clean, self-documenting code — no magic numbers.** Names explain intent; comments explain
   *why*, not *what*. Any constant that affects behavior or feel is named/derived from config,
   never an inline literal. (Card costs, life totals, sim counts → data, not literals.)
2. **Data-driven & designer-tunable.** Cards, decks, AI weights, and sim parameters live in data
   (JSON/TS data modules) with safe defaults — not hard-coded. Adding a card or a meta deck is a
   **data edit, not an engine change**.
3. **Ship debug tooling with every new system — in the debug/inspector panel.** A system isn't done
   until you can observe and drive it at runtime: a game-state inspector, a step-through-priority
   control, forced draws/mulligans, a sim-log viewer. Expose controls through the shared **debug
   inspector** (data-driven: a registry entry + a context seam + a toggle/stepper). **Do NOT add
   standalone debug key bindings per feature.** (Normal app inputs are fine; this is about
   debug/cheat controls.)
4. **Composition over inheritance.** A card is **data** that references small, composable effect
   primitives — never a subclass per card. AI strategies, sim reporters, and effects are assembled
   from small focused modules, not a class tree.
5. **Leave the codebase better than you found it.** Fix the small thing you touch; don't add mess.
6. **Code extensibly and robustly.** Graceful fallbacks (missing card data, an unimplemented
   mechanic, a Scryfall miss → safe defaults + a clear "unsupported" signal, never a silent crash).
7. **Watch performance — no regressions.** The sim runs **thousands of games**; the engine hot path
   must stay allocation-light and fast. Instrument sim throughput (games/sec). A change that
   regresses it must be optimized back to at-least-parity BEFORE moving on. The core must run both
   in Node and in a browser Web Worker.
8. **Don't collide with other agents.** Multiple agents (possibly on different machines) work this
   repo. Own a **disjoint set of files / a disjoint package** (DESIGN.md §6), and **claim work on the
   coordination board ([COORDINATION.md](COORDINATION.md)) before starting.** Workers push
   `feat/<slug>` branches and do not merge to `main`; the integrator merges and ships.
9. **Always deliver a build to test.** Whenever a feature is added or a bug is fixed, produce a
   runnable build (the web app and/or a CLI sim command) for the user to try — "tests pass" is not
   "done."

Plus two cross-cutting disciplines:
- **Pure-core + mandatory tests.** All rules/AI/sim/stats logic lives in pure, dependency-free units
  (no DOM, no network, no `fetch` at call time) and is unit-tested. A change that breaks an existing
  test is a regression and must be fixed before merge.
- **Integrate through seams.** Features self-register and plug into defined seams (the effect-primitive
  registry, the AI-strategy registry, the sim-reporter registry, data registries, the event log).
  They never edit the core engine loop to integrate.

## Build & test

```
npm install          # once, at repo root (workspaces)
npm run build        # build all packages + the web app
npm test             # run the full workspace test suite (Vitest)
npm run dev          # launch the web PWA locally (Vite)
npm run sim -- ...    # headless gauntlet/A-B sim from the CLI
npm run verify       # OFFLINE pre-push gate: lint + generated-data check + BUILD (type-check) + full tests
```

> `npm run verify` at the **root** is offline and safe in CI. Do not confuse it with
> `npm run verify -w @jonny-boi/data-tools`, which re-fetches from Scryfall over the **network** and
> must never run in `npm test`/CI.

**Generated data is generated — never hand-copied.** `apps/web/src/data/card-index.json` is derived
from the card pool by `apps/web/scripts/build-card-index.mjs`; a test re-derives it and fails if they
diverge. If you need card names/art in the web app, regenerate — do not edit the JSON.

⚠️ **Stale comments are bugs with a blast radius.** A wrong doc-comment here has already caused an
agent to file and work a headline defect that did not exist (three comments claimed a 32-card index
long after it became 156). If you change what a comment describes, fix the comment in the same commit.

⚠️ **CRLF trap (Windows):** committed JSON is CRLF on disk, LF in git, and the repo has no
`.gitattributes`. Any guard that byte-compares a generated file **must normalize newlines** or it
false-alarms on every Windows checkout.

> Refine these as the build system fills in. The shippable PWA build is `npm run build`; tests run in
> Node via Vitest. Judge the suite green by the "N passed, 0 failed" summary line.

## Finishing a feature (definition of done — §7 of DESIGN.md)

1. **Tests green** — the feature ships with tests and the full suite passes.
2. **Marked off** — flip the feature's status in DESIGN.md §3 to ✅ done.
3. **Committed** — stage *your* feature's files (explicit paths, **never `git add -A`**) + the §3
   flip, with a clear message.
4. **Pushed** — push the branch so the work isn't stranded. Workers do **not** merge to `main`;
   the integrator does (see COORDINATION.md).
5. **Build delivered** — a runnable build (web app or `npm run sim`) for the user to test.
