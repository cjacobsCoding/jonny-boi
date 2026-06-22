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
Per landed feature/batch: merge → `npm run build` + `npm test` green → the build auto-publishes. Keep sim
throughput (games/sec) from regressing.

### Live build (always-latest, mobile-accessible)
- **URL: https://cjacobscoding.github.io/jonny-boi-app/** — the PWA, installable on phone + desktop.
- This source repo is **private** (GitHub Pages unavailable on Free plan for private repos), so the built
  static site is mirrored to the **public** repo `cjacobsCoding/jonny-boi-app` (gh-pages branch → Pages).
- **Auto-deploy:** `.github/workflows/deploy-pwa.yml` runs on every push to `main` — `npm ci` →
  `npm run build` (with `DEPLOY_BASE=/jonny-boi-app/`) → mirrors `apps/web/dist` to the public repo via a
  write-scoped SSH deploy key stored as the `ACTIONS_DEPLOY_KEY` secret. No manual step; every merge ships.
- The web app's Vite `base` + PWA manifest scope read `DEPLOY_BASE` (default `/` for local `npm run dev`).

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
| feat/engine-v2-triggers | DESKTOP-90PJPM4 (worker) | packages/core | ✅ INTEGRATED |
| feat/cards-v2 | DESKTOP-90PJPM4 (worker) | packages/cards | ✅ INTEGRATED |
| feat/web-lab | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| fix/fidelity-caveat | DESKTOP-90PJPM4 (worker) | packages/sim | ✅ INTEGRATED |
| feat/match-viewer | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/mcts-ai | DESKTOP-90PJPM4 (worker) | packages/ai (+sim wiring) | ✅ INTEGRATED (selectable, not default) |
| feat/hotseat-play | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/meta-decks | DESKTOP-90PJPM4 (worker) | packages/sim (data) | ✅ INTEGRATED |
| feat/suggestion-engine | DESKTOP-90PJPM4 (worker) | packages/sim | ✅ INTEGRATED |
| feat/data-tools-scryfall | DESKTOP-90PJPM4 (worker) | packages/data-tools | ✅ INTEGRATED |

## Messages between agents
_Append dated notes here; keep them short. Newest at top._

- 2026-06-21 DESKTOP-90PJPM4: `hotseat-play` INTEGRATED — 2 humans play a full MTG game on ONE device
  (pass-and-play). New "Play" tab: setup → hand-hiding device handoff → mulligan → full game (lands, casts
  w/ targeting+auto-tap, combat declare/block, stack responses, win). Main = **321 tests, build exit 0**.
  Screenshot-verified (setup/handoff/mulligan render w/ real art) + headless full-game-to-winner test.
  `GameSession` is transport-agnostic; `seat.ts` SeatTransport seam → online play later = a transport swap
  (set localControls per-peer, drop the handoff), zero session/UI rewrite. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: Polish wave INTEGRATED — `meta-decks` (6 archetypes), `match-viewer`
  ("Watch a Game" replay), `mcts` (selectable pilot, full-fidelity rollouts; registry now threaded into the
  `match.ts` decision loop). Main = **314 tests, build exit 0**. NEW FEATURE dispatched: `feat/hotseat-play`
  — 2 humans play a real MTG game on one device (pass-and-play), architected so online sync can follow.
  Reuses the engine seam (generateLegalActions/applyAction) + cards registry directly in apps/web. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `web Lab` (§3.7) + `cards-v2` INTEGRATED. Main = **279 tests, build exit 0**.
  Lab = in-PWA gauntlet/A-B-swap/suggestions via a Web Worker (screenshot+run verified: real win-rates
  computed in-browser, 0 console errors). cards-v2 = real cards on engine-v2 (prowess/tokens/persist/pumps
  wear off) → verdicts now FAITHFUL (still-stubbed: transform/DFC, dynamic P/T, planeswalker loyalty, flash).
  Full vertical slice live at https://cjacobscoding.github.io/jonny-boi-app/. Dispatched `fix/fidelity-caveat`
  (stale "provisional" note). Match-viewer (replay) is the remaining §3.7 nice-to-have. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `engine v2` (§3.9) INTEGRATED — triggers + until-EOT continuous effects.
  Main = **254 tests, build exit 0**. Adversarial review caught + fixed a combat-bias bug (block/attack
  legality now reads continuous/granted keywords, matching the damage step). BREAKING: `StackObject` is now
  a union (`spell`|`trigger`); fixed `cards` counterSpell + its test to narrow on `kind`. Engine API for
  cards-v2: `CardDefinition.triggers` (etb/attacks/dies/leaves/castSpell/upkeep), `ctx.addContinuousEffect`,
  `ctx.createToken`, `effectivePower/Toughness/Keywords`. Dispatched `feat/cards-v2` to un-stub real cards +
  make pumps wear off. `feat/web-lab` (apps/web) still building. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `suggestion engine` (§3.6) INTEGRATED — 233 tests. `suggestSwaps()` ranks
  candidate single-card swaps via the §3.5 paired test; CLI `npm run sim -- suggest <deck>`. Verified real
  significant rec: Mono-Red Aggro Lightning Bolt→Kitchen Finks = BETTER (+4.1%, p=0.002). Honest budget-cap
  coverage. `engine-v2` (§3.9) still building on feat/engine-v2-triggers. Next after it: cards-v2 (un-stub
  real cards onto triggers/EOT), then wire web Lab→sim (suggestSwaps report is UI-ready). (Integrator)
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
