# Agent coordination (multiple agents, multiple machines)

**jonny-boi** is built by several Claude agents — **including agents on different machines** that all
push to one repo. This file is the **shared cross-machine channel**: the repo is the only thing every
agent sees. Read it at the start of a session; update your section before you push.

## Hard rules (prevent two agents clobbering each other)
1. **`git fetch` before you integrate or push.** Never `git push --force` to `main`. Integrate by
   merging the latest `origin/main` first.
2. **One feature per branch, each in its own git worktree** (`feat/<slug>` / `fix/<slug>`), owning a
   **disjoint package** (DESIGN.md §6). Check this file's in-flight table + `git branch -r` before
   claiming work so two agents don't grab the same files.
2b. **Pick a unique branch slug.** If a `feat/<slug>` already exists on the remote, choose another.
3. **Workers push branches; they do NOT merge to `main`.** One **integrator** merges reviewed green
   branches to `main`, ships, and publishes the build.
4. **Know your build configs.** `npm test` (Vitest) judges green by "N passed, 0 failed"; the shippable
   artifact is `npm run build`.
5. **Definition of done** (DESIGN.md §7): feature + tests, full suite green, DESIGN §3 flipped,
   committed with **explicit paths** (never `git add -A`), pushed.

## Ship / release process (integrator)
Per landed feature/batch: merge → `npm run build` + `npm test` green → publish a verified build (deploy
the PWA / tag a `latest`) so collaborators and other machines get it. Keep sim throughput (games/sec)
from regressing.

## Roles
- **Integrator** — `DESKTOP-90PJPM4` (supervisor on this machine merges to `main` + ships).
- **Workers** — _(other machines / dispatched agents; add your hostname + branch when you join)_

## In-flight / ownership  (update when you start or finish)

| branch | owner / machine | files owned | status |
|--------|-----------------|-------------|--------|
| feat/scaffold | DESKTOP-90PJPM4 | root configs + all package skeletons | ✅ INTEGRATED |
| feat/core-engine | DESKTOP-90PJPM4 (worker) | packages/core | ✅ INTEGRATED |
| feat/cards-pool | DESKTOP-90PJPM4 (worker) | packages/cards | ✅ INTEGRATED |
| feat/ai-pilots | DESKTOP-90PJPM4 (worker) | packages/ai | ✅ INTEGRATED |
| feat/sim-harness | DESKTOP-90PJPM4 (worker) | packages/sim | ✅ INTEGRATED |
| feat/web-foundation | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/data-tools-scryfall | DESKTOP-90PJPM4 (worker) | packages/data-tools | ✅ INTEGRATED |

## Messages between agents
_Append dated notes here; keep them short. Newest at top._

- 2026-06-20 DESKTOP-90PJPM4: `sim` (§3.5) + `web` (§3.7 foundation) INTEGRATED. Full main suite = **216
  tests, build exit 0**, and now runs from pure src with NO build-before-test (fixed root vitest.config to
  alias all packages → src). `npm run sim -- swap` gives real paired-McNemar verdicts (~210-260 games/sec);
  e.g. Mono-Red Aggro: Goblin Guide→Sol Ring = WORSE (-3.2%, p=0.003). Web = pro card browser + deck builder
  with real Scryfall art (PWA), screenshot-verified. §3.7 still 🚧 (lab/match-viewer/suggestions remain).
  NOTE for integrators: scope `dist` cleanup to package roots — a recursive `dist` delete nukes
  node_modules/*/dist (broke vite); `npm ci` repairs. Next: §3.9 engine v2, §3.6 suggestion engine, wire web→sim.
- 2026-06-20 DESKTOP-90PJPM4: `ai` (§3.4) INTEGRATED — full main suite = 165 tests, build exit 0. random +
  heuristic pilots (seeded, tunable `HeuristicWeights`). `sim` drives: `createDefaultAiRegistry()` →
  `getPilot(id)` → loop `generateLegalActions → chooseAction({view,legalActions,rng}) → applyAction`.
  FOUNDATION COMPLETE (engine+cards+ai+data-tools). Wave 3 = `feat/sim-harness` (§3.5) — the heart.
  (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `cards` (§3.2) INTEGRATED — 134 tests on main. All 32 staples load+play, ids
  joined to Scryfall by UUID. SURFACED ENGINE GAP: MVP core has no triggered-ability system, no
  until-EOT/continuous-effects layer, no planeswalker/transform/dynamic-P-T. Several meta cards stubbed;
  `pumpUntilEndOfTurn` doesn't wear off (sim-combat bias). New roadmap item §3.9 "Core engine v2" added —
  needed before meta-deck sims are trustworthy. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `core` (§3.1) INTEGRATED to main — 62 core tests (incl. adversarial-review
  fixes: blocked double-strikers no longer leak face damage; effect registry threaded explicitly, no
  module global). Full main suite = 102 tests green. Wave 2 dispatched: `feat/cards-pool` (§3.2) +
  `feat/ai-pilots` (§3.4), both build on core's seams (CardDefinition/EffectRegistry; generateLegalActions/
  applyAction), disjoint packages, parallel. `ai` tests against its own minimal fixtures (does NOT depend on
  `cards`) to stay parallel. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `data-tools` (§3.3) INTEGRATED — 47 tests green, 32/32 starter cards resolved
  live from Scryfall, text card-index.json committed (image bytes gitignored). Card data now available to
  `cards`/`web` at `packages/data-tools/data/card-index.json`. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: Wave 1 dispatched — `feat/core-engine` (§3.1) + `feat/data-tools-scryfall`
  (§3.3) in parallel; disjoint packages, no cross-dependency. core blocks cards/ai/sim, so it's the
  keystone. data-tools is independent. (Supervisor/integrator)
- 2026-06-20 DESKTOP-90PJPM4: Scaffold (§3.0) INTEGRATED to main — `npm install/test/build` all green,
  PWA build emits sw.js + manifest. Other packages branch off `origin/main`. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: Repo seeded with rules + this board + DESIGN. Stack = TS npm-workspaces
  monorepo (core/cards/ai/sim/data-tools + apps/web PWA), Scryfall art, curated card pool. Node 24 LTS
  installed on this machine. Scaffold (§3.0) goes first and blocks all other work. (Supervisor)
