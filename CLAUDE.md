# jonny-boi — agent guide

> **The universal engineering rules are not restated here.** They live in Caleb's canon
> (`~/.claude/rules/`, from the private repo `cjacobsCoding/claude-canon`), which is
> version-controlled, synced to every machine, and auto-loads in every session *before*
> this file.
>
> This file carries **only what those rules mean in this repo** — the MTG-specific
> instantiation, the scripts, the seams, the budgets.
>
> That split is deliberate. When the universal rules were copied in full into this file,
> it forked: **29 copies in 4 versions** across the worktrees, 14 of them missing rules
> that had since been promoted. A project `CLAUDE.md` loads *after* the canon and wins on
> conflict, so a stale copy does not reinforce a rule — it silently overrides it.
>
> If a machine lacks the canon, install it once:
> `gh repo clone cjacobsCoding/claude-canon "$env:TEMP/canon-boot" -- -q; pwsh -File "$env:TEMP/canon-boot/bootstrap/install.ps1"`
>
> Read this file and `DESIGN.md` at the start of every session.

**jonny-boi** — A Magic: The Gathering deck-tuning lab. Build a deck, let AI pilots play it hundreds
of games against the meta gauntlet, swap a single card, and get a **statistically definitive** verdict
on whether the deck got better — then let the engine suggest the next improvement. Real MTG cards and
Scryfall art, in a polished PWA that runs on PC, Android, and the browser.

Stack: **TypeScript monorepo** (npm workspaces) — a pure, DOM-free `core` rules engine + `cards` data
pool + `ai` pilots + `sim` harness + `data-tools` (Scryfall fetch/cache) + a React/Vite **PWA** in
`apps/web`. **Read [DESIGN.md](DESIGN.md) first — it is the single source of truth** for requirements,
architecture seams (§2), the roadmap (§3), and the parallel-development rules (§6). Integrate through
the seams; do not edit the core engine loop or shared scaffolding to bolt a feature on.

## What the canon's rules mean here

Each heading names the canon rule; the text is the jonny-boi-specific part, which the canon
does not and should not know about.

**No magic numbers** (`50-engineering.md` §2, §5) — card costs, life totals and sim counts are
data, never inline literals.

**Data-driven & designer-tunable** (`50-engineering.md` §2) — cards, decks, AI weights and sim
parameters live in data (JSON/TS data modules) with safe defaults. Adding a card or a meta deck
is a **data edit, not an engine change**. The canon's closed-table rule is load-bearing here:
`TARGET_NOUN_RESTRICTIONS` and `MANA_COST_NOUNS` are closed, and a value outside them must
report honestly rather than be widened to the nearest existing entry.

**Debug tooling in the debug menu** (`60-project-defaults.md`) — here that menu is the **debug
inspector**: a game-state inspector, step-through-priority, forced draws/mulligans, a sim-log
viewer. Register through the inspector's registry + context seam. No per-feature key bindings.

**Composition over inheritance** (`60-project-defaults.md`) — a card is **data** referencing small
composable effect primitives, never a subclass per card. AI strategies, sim reporters and effects
are assembled from small focused modules, not a class tree.

**Robust fallbacks, never silent** (`60-project-defaults.md`) — a missing card, an unimplemented
mechanic, or a Scryfall miss degrades to a safe default **plus a clear "unsupported" signal**.

**No performance regressions** (`60-project-defaults.md`) — the sim runs **thousands of games**, so
the engine hot path stays allocation-light. Instrument sim throughput (games/sec) and restore
at-least-parity before moving on. The core must run in **both** Node and a browser Web Worker.

**Pure core + mandatory tests** (`60-project-defaults.md`) — all rules/AI/sim/stats logic lives in
pure, dependency-free units: no DOM, no network, no `fetch` at call time.

**Integrate through seams** (`60-project-defaults.md`) — features self-register into the
effect-primitive registry, the AI-strategy registry, the sim-reporter registry, the data
registries, or the event log. They never edit the core engine loop to integrate.

**Systemic, never one-off** (`50-engineering.md` §1) — the guard shipped with the fix is the
point. `compile/rule-coverage.test.ts` and `scripts/dead-rule-sweep.mjs` are the model: they
exist because a rule written from a *remembered* wording matched no real card, and no test
could see it.

**Measure before building** (`50-engineering.md` §4) — `scripts/near-miss-report.mjs` ranks the
cards that are ONE clause from playable by the shape of the clause blocking them;
`scripts/coverage-audit.mjs` ranks systems by cards unblocked. Measure a candidate family
**before** writing it.

**DRY — one answer to one question** (`50-engineering.md` §3) — one funnel per operation: one
zone-change path, one replacement site, one legality check. One table read by every consumer,
so a row added for one verb is understood by all of them in the same edit.

**Don't collide with other agents** (`40-orchestration.md`) — own a disjoint **package** where
possible (DESIGN.md §6) and claim work on [COORDINATION.md](COORDINATION.md) before starting.
Workers push `feat/<slug>` branches and never merge to `main`; the integrator merges and ships.

**Always deliver a build** (`30-delivery.md`) — the web app and/or a CLI sim command, runnable.

## Project-specific rules

<!-- Constraints true of jonny-boi ONLY - things the canon does not cover. -->

- **Every bug fixed ships a test that would have caught it.** A standing owner rule for this
  repo, and stricter than the canon: `50-engineering.md` §1 asks for a guard when you fix a
  *class*; here it is required for **every** fix, including a one-off.

(The generated-data and CRLF rules are below, with the build commands they belong to.)

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
