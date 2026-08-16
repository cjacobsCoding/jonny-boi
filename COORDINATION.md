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
2c. **NEVER `git checkout` in the primary checkout `D:\Cool Stuff\Claude\jonny-boi`.** It belongs to the
   integrator and must stay on `main`. Work ONLY inside the worktree your brief names. This has now
   broken three times, and the failure is silent and expensive: your commits land on whatever branch
   you switched to, `git push origin main` then pushes the *stale local* `main` ref, and git reports
   `non-fast-forward` / "branch tip is behind" while `git rev-list HEAD..origin/main` says you are 0
   behind — a contradiction that wastes a long debug. **Before committing anywhere, run
   `git rev-parse --abbrev-ref HEAD` and confirm it is the branch your brief assigned.** If you find
   the primary checkout on the wrong branch, say so in your report; do not "fix" it mid-task.
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
| (net-protocol) | DESKTOP-90PJPM4 (integrator) | packages/protocol (new) | ✅ INTEGRATED (committed direct to main) |
| feat/online-server | DESKTOP-90PJPM4 (worker) | apps/server (new) + root cfg | ✅ INTEGRATED |
| feat/online-client | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/match-viewer | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/mcts-ai | DESKTOP-90PJPM4 (worker) | packages/ai (+sim wiring) | ✅ INTEGRATED (selectable, not default) |
| feat/hotseat-play | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/meta-decks | DESKTOP-90PJPM4 (worker) | packages/sim (data) | ✅ INTEGRATED |
| feat/suggestion-engine | DESKTOP-90PJPM4 (worker) | packages/sim | ✅ INTEGRATED |
| feat/data-tools-scryfall | DESKTOP-90PJPM4 (worker) | packages/data-tools | ✅ INTEGRATED |
| feat/deck-import | DESKTOP-90PJPM4 (worker) | packages/cards/src/compile + apps/web import | ✅ INTEGRATED |
| fix/ai-play-quality | DESKTOP-90PJPM4 (worker) | packages/core + packages/ai + sim/cli + apps/web hover | ✅ INTEGRATED |
| fix/rules-audit | DESKTOP-90PJPM4 (worker) | packages/core mana-plan + apps/web play/online | 🚧 PUSHED, not merged |
| feat/activated-abilities | DESKTOP-90PJPM4 (worker) | packages/core + cards/compile + ai/heuristic | ✅ INTEGRATED (via feat/card-mechanics) |
| feat/conditional-taplands | DESKTOP-90PJPM4 (worker) | packages/core card.ts/engine.ts + cards/compile | ✅ INTEGRATED (via feat/card-mechanics) |
| feat/card-mechanics | DESKTOP-90PJPM4 (worker) | packages/cards primitives+compile, core targeting | ✅ INTEGRATED |
| feat/pool-adaptive-wire | worker | apps/web + packages/sim | ✅ INTEGRATED |
| feat/card-index-truth | worker | apps/web/src/data + apps/web/scripts + web card docs | ✅ INTEGRATED |
| perf/mcts-usable | worker | packages/ai | ✅ INTEGRATED (NO-GO: mcts slower AND weaker) |
| feat/attachments | worker | packages/core (attachments+SBA+layers), packages/cards (primitive+compile), packages/ai (heuristic), +1 line in packages/sim/paired-arms-config | 🚧 PUSHED, not merged |
| spike/engine-representation | worker | spikes/engine-representation (new) + 2 narrow eslint.config.js additions | 🚧 PUSHED, not merged — DECISION SPIKE, no product code |
| feat/hybrid-search | worker | packages/ai (new: search-stats/evaluator/hybrid/hybrid-config + heuristic policy seam + bench), DESIGN §3.4a | 🚧 PUSHED, not merged |
| feat/tree-reuse | worker | packages/ai (new: tree-reuse.ts + tests; hybrid/hybrid-config/search-stats/index/bench), DESIGN §3.4b | 🚧 PUSHED, not merged — stacks on feat/hybrid-search |

## Messages between agents
_Append dated notes here; keep them short. Newest at top._

- 2026-08-15 worker: `feat/tree-reuse` PUSHED — **brief §21–22 built, measured, and shipped OFF. The
  measurement IS the deliverable; read the numbers before turning it on.** `packages/ai` only, plus
  DESIGN §3.4b. Stacks on `feat/hybrid-search` (merge that first). Suite **1961 passed / 0 failed**
  (baseline 1939 + 22), `npm run verify` exit 0, `npm run build` exit 0, lint 0 errors.
  👉 **THE MATCH IS BY POSITION, NOT BY ACTION, AND THAT IS FORCED.** The brief says "promote the child
  matching the real action". You cannot: `Pilot.chooseAction` is called ONLY when we hold priority, so a
  pilot **never observes the opponent's actions at all** — §22 is not implementable on action matching
  without a new observation callback on `DecisionContext`, i.e. a change in `packages/sim`. A pilot also
  cannot know how many engine actions passed (forced windows are compressed inside the search, our own
  macros span plies, a committed macro can abort half-way). So every node records a 64-bit
  `fingerprintPosition` of the whole state and the live position is LOOKED UP. Our move, the opponent's
  moves and any forced run in between all collapse to one mechanism, and `packages/sim` stays untouched.
  👉 **`actionEquivalenceKey` is the WRONG key for that and the RIGHT key for what it already does.**
  It answers "are these two offered actions the same DECISION" and deliberately merges actions whose
  STATES differ (Island #7 vs #12 tapped for {U}). Re-rooting on it would adopt a search of a position
  that is not the one on the table. It IS still used to line a retained edge up against the freshly
  derived candidate list — the same question asked *within one position*.
  ⚠️ **DETERMINISM — the conclusion, and it is structural rather than careful.** Reuse makes a decision
  depend on what this pilot instance searched EARLIER. That is safe because `GameState.seed` is mixed into
  the fingerprint and the retained tree records its deciding seat, so a tree can only ever be reused
  **inside the one game and the one seat it was built in** — where the sequence of positions is itself a
  function of the seed. This is not decoration: every real consumer (`sim/cli.ts`,
  `apps/web/lib/sim/execute.ts`, the harness) builds ONE pilot and runs MANY games through it, and the Lab
  shards the game grid across workers by range (`RunOptions.range`, `playSlice`). A tree that survived a
  game boundary would make a paired A/B verdict **depend on the worker count**. Pinned by a test that
  plays two other games through a pilot and then asserts a byte-identical transcript for the target game.
  Nothing here reads the clock or `Math.random`.
  ❗ **HEADLINE: IT WORKS, AND IT DOES NOT HELP.** Interleaved arms on identical seeds; the reuse-OFF arm
  **reproduced BOTH recorded baselines exactly** (72/120 and 43/80), which is what makes the rest
  trustworthy:
  · Mono-Red vs Boros, n=120: OFF **60.0%** [51.1, 68.3] -> ON **60.0%** [51.1, 68.3]; **6.49 -> 8.76 ms**
    mean, p95 59 -> 83 ms.
  · UW Control vs Golgari, n=80: OFF **53.8%** [42.9, 64.3] -> ON **56.3%** [45.3, 66.6]; **10.52 ->
    16.71 ms** mean, p95 97 -> 136 ms.
  The mechanism is emphatically not broken: the live position is found on **94.6% / 95.5%** of decisions
  and carries **217 / 284 inherited visits** into a 160-simulation budget. The search really is ~2.4x
  deeper in information and plays the same. **That is exactly what `feat/hybrid-search`'s own plateau
  finding predicts** (256->1024 sims bought +1.7 points): this pilot is limited by its EVALUATOR, not by
  how much it searches, and reuse only buys more searching. So `DEFAULT_HYBRID_CONFIG.reuse` ships
  **off** — enabling it would be a rule-7 throughput regression bought with a strength gain that is not
  there — and a test pins that with the table attached.
  👉 **WHAT IT DOES BUY, and it is worth having: the same play for HALF the decision time.**
  `THRIFTY_HYBRID_CONFIG` = reuse ON at 64 simulations. Head to head against the 160-simulation default,
  n=120 each: **64 sims -> 46.7%** [38.0, 55.6] at **44%** of its decision time; **96 sims -> 48.3%**
  [39.6, 57.2] at **74%**. Both intervals include 50%, so the honest claim is **"no measurable loss at
  half the cost"**, NOT "stronger" — both point estimates sit just under 50%. It is the beginning of the
  throughput case a search pilot needs before it could ever become the default. `DEFAULT_PILOT_ID` is
  untouched and still `heuristic`.
  ⚠️ **WHY REUSE COSTS MORE PER DECISION — non-obvious, and worth knowing before anyone "optimises"
  it.** In-tree engine plies per simulation go **56 -> 78** (aggro) and **82 -> 119** (control). An
  inherited tree is DEEPER, and every simulation re-applies every macro from the root down to its leaf, so
  a deeper tree makes each simulation cost more. The extra time is the search going deeper, not
  bookkeeping — fingerprints are computed only for nodes within `maxDepth` (4) edges of the root.
  👉 **Stale statistics: measured, not guessed.** `decay: 1` (inherit as they stand) vs `decay: 0.5`
  (visits and reward scaled TOGETHER, so every mean is preserved exactly and only confidence shrinks) over
  the identical 120 games: **72/120 vs 73/120** — one game apart. Knob kept, default 1; re-ask it when the
  evaluator changes, since the evaluator is what is actually binding.
  👉 **Memory: bounded by construction, and measured.** Promotion prunes every sibling subtree, and a
  retained tree over `maxNodes` (8192) is dropped WHOLE rather than trimmed — a partly-trimmed tree is one
  whose visit counts no longer add up. Measured peak over full games: **294 / 353 nodes**. The cap is a
  guard, not a working limit, and a test drives the drop path with `maxNodes: 1`.
  👉 **NEW SEAMS in `packages/ai`, all additive:** `fingerprintPosition` / `fingerprintsEqual` /
  `findNodeByFingerprint` / `decayAndCountSubtree` over a structural `ReusableNode` — deliberately
  search-agnostic, because brief §18 (transposition tables) and §11 (a tactical solver) want the same
  position key, and two different answers to "is this the same position" is exactly the kind of drift this
  repo has already been bitten by. `DecisionStats` gains
  `reuseAttempts` / `reuseHits` / `reusedNodes` / `reusedVisits`. Two new bench modes: `reuse <n>`
  (interleaved OFF/ON arms on PAIRED seeds; `BENCH_DECAYS=1,0.5`) and `reuse-duel <n>`
  (`BENCH_ON_SIMS=<k>` — the arms playing EACH OTHER, the sensitive form of the question, because
  everything the two arms share then cancels per game rather than only in expectation).
  ⚠️ **MEASUREMENT NOTE.** Win rates needed no interleaving and are exactly comparable with the numbers
  already on record — the sim is deterministic in the seed, so an arm's win count is the same whenever it
  runs. Interleaving is purely for the MILLISECONDS. Do NOT compare decision times ACROSS runs: the OFF
  arm measured 7.69 ms in one duel and 5.04 ms in another on identical config, because decision cost is
  board-size dependent and the two runs faced different opponents. Only within-run ratios are quotable.
  ⛔ **NEEDS AN OWNER OUTSIDE `packages/ai`** (reported, not done — I own only `packages/ai`):
  · **`DecisionContext` gives a pilot no way to observe what the OPPONENT did.** Not needed for this
    branch (position matching sidesteps it entirely), but every belief-model / opponent-model item in the
    brief (§13–17, §32–33) needs it, and it is a `packages/sim` seam change.
  · The `planManaPayment` O(sources x battlefield) rescan that `feat/hybrid-search` reported in
    `packages/core` is still the hottest thing the policy does; reuse does not touch it.
  (Worker — pushed, NOT merged.)

- 2026-08-15 integrator: **`fix/room-code-length` MERGED + DEPLOYED** (Deploy PWA success).
  main = **1887 tests, build exit 0**. USER-REPORTED: PC hosted, phone entered the code, Join stayed
  greyed and did nothing.
  🐛 **Online play has never been joinable.** `ROOM_CODE_LENGTH` was declared TWICE — **5** in
  `apps/server/src/config.ts`, **6** in `apps/web/src/lib/online/online-config.ts` — and the Join
  button gates on the client copy. Every genuine code is 5 chars, so the button could never enable.
  Neither side was wrong alone, which is why nothing caught it: each package tested itself and
  agreed with itself. **The bug lived in the gap between two packages.**
  ✅ Fix: the room-code shape (length, alphabet, wire bound) now lives ONCE in
  `@jonny-boi/protocol` — the shared contract is exactly where a value the server ISSUES and the
  client TYPES BACK belongs. Both sides re-export; neither declares. Plus `normalizeRoomCode` /
  `isPlausibleRoomCode` so a lowercase or space-padded code still works on a phone.
  🧪 Guards at both ends AND across the seam: 200 server-generated codes must each pass the
  CLIENT validator, and both configs must re-export rather than re-declare. **Verified live**, not
  just in unit tests — created room "MJT4G" on a local server and joined it from a second socket
  with the code lowercased; both seats appeared.
  👉 **NO NAS REDEPLOY NEEDED** — the server already issued 5-char codes and its behaviour is
  unchanged. The fix ships with the web app.
  👉 Lesson worth generalising: **a constant both packages need is a contract, not a config.** If
  you find yourself typing the same name in two packages, it belongs in `protocol` (or `core`).
  Also: a disabled control must say why — this one silently refused valid input for its whole life,
  which is indistinguishable from broken.

- 2026-08-15 integrator: **NAS server is now LIVE on protocol v2, and backward compatible.** Verified
  against `wss://jonnyboi.duckdns.org:8443` after the restart: v1 ACCEPTED, v2 ACCEPTED, v3 and v0 both
  REJECTED. Rollback bundle is on the NAS at `/docker/jonny-boi/backup/server.cjs` (361,992 bytes, the
  previous build); live is 402,745.
  👉 **Do not ship a server bundle without checking `Room.protocolMatches` first.** It was strict
  equality (`version === PROTOCOL_VERSION`), which made `MIN_COMPATIBLE_PROTOCOL_VERSION` dead code and
  compatibility ONE-directional — a new client could talk down to an old server, but an old client was
  locked out of a new one, with no downgrade logic to recover with. Restarting onto v2 would have
  blacked out every stale cached PWA. Fixed + tests pin both directions.
  👉 **Deploying to the NAS: drive the DSM *webapi*, not the DSM desktop UI.** Loading the desktop
  wedges the Chrome renderer (screenshots and JS both time out, and it starves sibling tabs). Get the
  CSRF token from `/webman/login.cgi` on the existing session, send it as `X-SYNO-TOKEN`, then use
  `SYNO.FileStation.Upload` / `SYNO.Docker.Container`. NAS is **10.0.0.28**.
  ⚠️ A single-file Docker bind mount **pins the inode** — replacing `server.cjs` is invisible to the
  running container until it restarts. Always back up to `backup/` and confirm the new size/mtime
  before restarting.

- 2026-08-15 DESKTOP-90PJPM4: **`fix/hint-accuracy` MERGED + DEPLOYED** (Deploy PWA green, live
  site HTTP 200). main = **1864 tests, build exit 0**.
  👉 **The unsupported queue was advertising TWELVE solved systems.** UNSUPPORTED-MECHANICS.md is
  generated from the `missingEngineSystem` strings, so a stale one sends the next agent to rebuild
  finished work. These had all shipped since the text was written: activated abilities, sacrifice
  costs, enters-tapped, chosen-colour mana, modal spells, counters, library look/reorder, graveyard
  retrieval, filtered targeting, leaves-the-battlefield triggers, compound draw/lose, static buffs.
  A hint fires only when NO rule matched, so once a system exists the honest message is **"a <kind>
  template the compiler does not recognize yet"** — the engine can do it, the compiler just cannot
  read that sentence. **Treat the hint text as part of shipping a mechanic**: implement the system,
  reword its hint in the same commit, and update the assertion in `compile.test.ts`.
  📋 **The real remaining queue** (these keep their original wording because they are genuinely
  missing): planeswalker loyalty · transform/DFC · flashback · ward and protection-from ·
  alternative/additional costs ({X}, kicker, suspend, spectacle) · variable {X} and derived values ·
  blocking restrictions beyond evasion · gaining control · targets chosen by a triggered ability ·
  optional payment during resolution · named keyword subsystems.
  ⛔ Still-open blocker noted earlier: **gaining control** needs an `effectiveController()` threaded
  through combat/priority/legality before it can be done safely — not a corner of another branch.
  (Integrator)

- 2026-08-15 DESKTOP-90PJPM4: `fix/hero-validation` ✅ INTEGRATED to main (apps/web only).
  One `lib/heroValidation.ts` now serves both the Lab and the Match viewer. `validateHero` was
  defined twice and the copies had DRIFTED: the Lab named the unsupported imported cards, the Match
  viewer did not, so watching a game with an imported deck answered `unknown card "<uuid>"` — an id
  shown nowhere in the UI. Reproduced live in the running app with a real Modern Boros list before
  fixing, not argued from the code.
  ⚠️ For whoever integrates next: this branch predated main's refactor of these views, so the merge
  was resolved to MAIN's version of LabView/MatchView and the extraction re-applied on top. The
  shared module is main's LabView implementation moved verbatim; the only wording change is
  "swap them out to run the Lab" -> "run it", since the Match viewer shows the same string now.
  Two things the lint gate caught that tsc did not: an unused `Deck` import, and a stale comment in
  gauntletDecks.test.ts pointing at "LabView's validateHero". Run `npm run verify`, not just
  `npm test` — lint is part of the gate again.
  STILL OPEN, deliberately not taken: `deckHealth.ts` and `unsupportedCardNames` answer overlapping
  questions from two mechanisms; unifying them touches DeckBuilder + Lab + Match at once, all live
  for other agents. And a compiler defect found while reproducing this — a split card
  ("Wear // Tear") is mis-diagnosed as needing a `"//"` card TYPE and as transform/DFC; only Fuse and
  the targeting clause are genuine. That is `packages/cards/src/compile`, owned by feat/card-mechanics.
- 2026-08-15 worker: `spike/engine-representation` 🚧 PUSHED — **"build the hot path in whatever is
  fastest, possibly C++" — answered with measurements. Full write-up:
  [spikes/engine-representation/README.md](spikes/engine-representation/README.md).**
  **NO product code touched.** New dir `spikes/engine-representation/` (outside the workspaces globs
  and outside the vitest `include`) + **two narrow additions to `eslint.config.js`** — expect a
  trivial conflict there only if someone else edits that file.
  👉 **THE HEADLINE IS NOT WHAT THE BRIEF EXPECTED. The cost is the LANGUAGE, not the data — and
  neither is the thing to do first.** Four arms, all playing **byte-identical games** (transcript
  digest over every decision, `packages/ai/bench/mcts-bench.mjs`'s technique):
  · **A** object graph TS (today's design) · **B** flat `Int32Array` arena + delta undo journal, TS ·
  **B+** a tuned steelman of B · **C** arm B ported line-for-line to WASM.
  **A→B changes only the DATA. B→C changes only the RUNTIME.** Neither comparison existed before.
  ⚠️ **THE FLAT-REPRESENTATION ARM LOSES, and that is the most useful result here.** Flat TypeScript
  is **0.61–0.70× on forward simulation** (a 30–39% SLOWDOWN), stable across three runs. It wins ONLY
  where it replaces *cloning* with *undo* — 1.7–2.8× at rollout depth 1, break-even at ~depth 8,
  a loss beyond. **Mechanism:** `inst.def.power` is two pointer loads V8's inline caches make nearly
  free; the flat equivalent is two BOUNDS-CHECKED `Int32Array` loads, and JS cannot spell "this index
  is already proved in range". This is the same trap `spikes/wasm` hit ("use typed arrays" is not the
  optimisation) — now with the mechanism attached. **Do NOT flatten `packages/core`.**
  👉 **I tried to make the flat arm faster and it got SLOWER — arm B+ is kept in the repo as
  evidence.** Giving every instance its own copy of its card row (removing a load) cost 0.81×: the
  shared 19-card table is 912 bytes and lives in L1, and duplicating it per instance grew it to
  7.5 KiB. The flat result is not a first draft.
  👉 **The LANGUAGE win is real and much bigger than the previous spike's +0.4%: B→C is 2.1–3.5×**
  with the representation held exactly constant. Decomposed by compiling a second WASM with bounds
  checks left IN: **2.0× is codegen alone**, a further **1.43×** is unchecked access. The earlier
  +0.4% was correct *for a kernel*; it is not the number for a whole-engine flat port.
  ❗ **BUT THE ALGORITHMIC LEVER BEATS BOTH AND IS ALREADY IN FLIGHT.** Holding the rollout budget
  fixed and sweeping depth: **terminal rollout → depth-1 leaf eval is 12.2–15.5× on the CURRENT object
  engine with no port at all** (`feat/hybrid-search`). The port's honest marginal value *on top of
  that* is **5.6× / 5.8×** — the steadiest number in the whole spike. **Recommendation: land the
  algorithmic change, then kill the per-action clone in plain TS; revisit WASM only after both.**
  👉 The two levers COMPOUND rather than overlap — shallow rollouts are exactly where clone cost
  dominates and flat+undo wins biggest. The algorithmic change makes a future port *more* attractive.
  👉 **Independent cross-check worth knowing:** calibration says `cloneState` is **36–38% of a real
  action's cost**, so removing it has a ceiling of ~**1.58×** — and `spikes/wasm` measured that same
  ceiling end-to-end at **1.53×** by a completely different method. Two methods agreeing to 3% is the
  strongest evidence in the report.
  ⚠️ **If WASM is ever done it must be ALL-IN, never a hybrid.** "WASM for the sim, TS for play" means
  two rules engines in two languages in the path of a *statistically definitive* A/B verdict — two
  ways for the verdict to drift, showing up as a card being subtly mis-evaluated. Either the engine
  moves wholly, or it stays. The boundary itself is NOT the blocker (~3.3 ns marginal per call,
  18.6 KiB module, batching makes per-call cost immaterial) — but **one state copy-out per action
  costs +51–68%**, and the match viewer / replay / online server / debug inspector all read state
  from JS. Any port must keep those at batch granularity.
  ⚠️ **Arm D (native binary) was NOT measured:** this box has no emcc/clang/rustc/cargo/wasm-pack/g++/
  zig and installing one is a large external download. AssemblyScript came from the npm cache
  (`spikes/wasm` had already fetched it). Arm C is a **lower** bound on native — no autovectorisation
  — but `verify.mjs` proves the emitted `.wat` contains **no garbage collector** and only 3 start-up
  allocations, so it is not paying managed-runtime overhead.
  ⚠️ **HONEST BIAS, stated because it cuts against my own headline:** the model game omits triggered/
  activated abilities, the choice system, attachments, layered statics, modal spells, {X}, and the
  Oracle-text compiler. What it omits is disproportionately the work that does NOT flatten cleanly
  (registry dispatch through function refs, string zone names, `Map` in `indexContinuous`), while what
  it keeps is nearly pure integer/array work — WASM's best case. **Treat 2.1–3.5× as an optimistic
  bound.** Calibration is in the README: instance count is *identical* (120/120) and branching is
  *higher* in the model (3.17 vs 2.00), so the clone/undo result transfers well; ns/action is 13.4×
  apart, so the language result transfers worst.
  ⚠️ **Measurement note for whoever re-runs this:** absolute times moved by a factor of **1.7** between
  runs of identical code, while the key ratios moved by <0.1×. Everything is best-of-9 interleaved
  A/B/C inside one process, three independent runs quoted. One number did NOT resolve and is reported
  as unresolved rather than dropped: the undo journal's cost on a forward-only playout came out 1.08×,
  1.54× and 0.92× — the spread swamps it. Captured outputs are in `spikes/engine-representation/results/`.
  👉 **eslint.config.js — two additions, both generalizable, not spike-specific:** `spikes/**/assembly/**`
  is now IGNORED (AssemblyScript files carry a `.ts` extension but are not TypeScript — `@inline` is a
  decorator in a position tsc forbids, so typescript-eslint fails to PARSE them rather than finding
  anything; this also covers the existing `spikes/wasm/assembly/`), and `WebAssembly` joins the Node
  globals for `spikes/**`. `npm run verify` exit 0, `npm run build` exit 0, suite unchanged.
  (Worker — pushed, NOT merged. Spike only: nothing to integrate, a decision to take.)
- 2026-08-15 worker: `feat/hybrid-search` 🚧 PUSHED — **the MCTS NO-GO is reversed, and the reversal is
  measured.** Phases 1–4 of `docs/plans/superhuman-ai-program.md` §58. `packages/ai` only, plus DESIGN §3.4a.
  👉 **HYBRID beats the heuristic 60.0% over 120 seeded games, 95% CI [51.1%, 68.3%]** on Mono-Red Aggro
  vs Boros Aggro — seat AND play rotated, the *identical* protocol that measured vanilla MCTS at **40.8%
  [32.5%, 49.8%]**. Both intervals exclude 50%, in opposite directions. `DEFAULT_PILOT_ID` is untouched.
  ⚠️ **BUT A SECOND MATCHUP IS INCONCLUSIVE AND YOU SHOULD QUOTE BOTH.** UW Control vs Golgari Midrange,
  n=80: **53.8%, 95% CI [42.9%, 64.3%]** — the interval INCLUDES 50%. The point estimate still favours the
  hybrid, but on grindy boards the win is not proven. The honest one-liner is *significantly stronger on
  fast tactical boards, unproven on slow ones*. Anyone quoting only the 60% is overclaiming.
  ⚠️ **Decision cost is BOARD-SIZE dependent, not a constant:** 7.07 ms mean / 66 ms p95 on aggro boards,
  27.7 ms / 155 ms p95 on control boards, because the policy scores every castable card and plans its
  funding at every node. Budget accordingly.
  👉 **IT SCALES, which is the property that makes it a search rather than a constant.** Same matchup,
  same seeded games, only the budget varied: **16 sims → 48.3%** [39.6, 57.2] · **64 → 53.3%** [44.4, 62.0]
  · **256 → 60.0%** [51.1, 68.3] (all n=120) · **1024 → 61.7%** [49.0, 72.9] (n=60). Monotone throughout.
  That the tiny budget lands at ~50% is the right sanity check, not a failure: with almost no search a
  policy-guided search should reproduce its own policy, and it does.
  ⚠️ **IT ALSO PLATEAUS, AND THAT IS THE MORE ACTIONABLE HALF.** 16→256 buys **+11.7 points** for 16× the
  compute; 256→1024 buys **+1.7** for another 4× (and 88 ms/decision, p95 791 ms). Past a few hundred
  simulations the binding constraint stops being search depth and becomes **evaluator accuracy** — the
  search converges on the best line *its evaluation function can see*. **So do not spend the next branch
  raising the budget.** The next real gain is brief §11–12 (a tactical solver for lethal / anti-lethal /
  combat) and §31 (a learned value function).
  👉 **METHODOLOGICAL FINDING FOR THE LAB.** Running the gauntlet with `--pilot hybrid` on BOTH seats moved
  Mono-Red Aggro from **32.9% → 19.0%**. That is not a bug: when both sides play better, aggro's edge
  shrinks because much of it was punishing weak blocking. **Deck verdicts are pilot-relative** — an A/B
  swap answers "is this card better *at this level of play*". Worth stating in the Lab UI at some point.
  ⚠️ **The old NO-GO was correct about naive MCTS and wrong as a verdict on search.** Do not cite it as
  "search doesn't work here". What was broken was the QUESTION: the search's action space.
  👉 **PHASE 1 FIRST, and the numbers redirected the plan** (`bench/mcts-bench.mjs instrument`, and the
  search now reports its own shape through the optional `SearchStatsSink` — zero cost when absent):
  root branching mean **4.8** / max **9** (branching was never the problem); **105.8 engine plies per
  simulation of which 100.8 are ROLLOUT** — 95% of all work; only **25% of rollouts reach a terminal**, so
  three-quarters pay 100 plies and then fall back on a positional guess anyway; cost **linear** in rollout
  depth (0.75 MB/decision at 1 → 18.9 MB at 120); **41.6%** of offered actions are strategically duplicate
  (42,806 → 25,015 over 20 real games); **25.7%** of decisions have a single legal action.
  👉 **THE FIX IS STRUCTURAL, NOT A TUNING.** A search candidate is now an ATOMIC funded play — the taps
  *and* the cast, planned through core's `planManaPayment` (the same planner the heuristic pays with). A
  naked `tapForMana` is **not in the search space at all**, so the recorded tap-and-don't-spend failure has
  no representation to express. `MctsConfig.evalWastedManaPenalty` priced that symptom and cost 11.6 points
  of win rate; removing the representation costs nothing and gains 19.
  ⚠️ **Atomicity inside the tree is only HALF the fix and this trap is easy to miss.** The engine still
  asks one action at a time, so a pilot that re-searched after each tap could pick a *different* macro next
  time and strand the mana it just made — the same bug, re-entering through the front door. The pilot
  therefore COMMITS to its chosen macro and carries it out, re-validating every ply against the live legal
  actions (and turn/step/priority) before playing it, so a stale plan can never be forced through. It is
  also a ~4× speedup: a three-mana spell costs one search instead of four.
  👉 **NEW SEAMS other agents can use** (all additive, `packages/ai`): `policyCandidates(view, legal,
  weights)` — the heuristic's own scoring exposed as candidate STRATEGIC actions, which is the reusable
  form of "the heuristic knows MTG things the search doesn't"; `StateEvaluator` = `evaluateState` /
  `evaluatePolicy` (brief §30), heuristic-backed today so a learned model is a different ARGUMENT, not a
  different search; `actionEquivalenceKey` / `countEquivalentActions`, which both MEASURE redundancy and
  REMOVE it, so a claimed saving can't be fiction; `SearchStatsSink` for any future search.
  ⚠️ **TWO BUDGET POLICIES, DELIBERATELY NOT UNIFIED — do not "simplify" this.** `SearchBudget` is a
  discriminated union: `simulations` (deterministic, the ONLY kind the Lab's evaluation path may use) and
  `millis` (`PLAY_HYBRID_CONFIG`, interactive play only). A wall-clock budget makes the search
  machine-dependent, so the base and variant arms of a paired A/B swap can get DIFFERENT budgets on the
  same seed and the common-random-numbers premise dies. Making the kind explicit means nobody can become
  time-based by accident. Pinned by a test, including one that freezes `performance.now` and asserts the
  default budget's answer is unchanged.
  👉 **The evaluator is deliberately NOT "life + card count"** (brief §9): life, board stats, body count,
  card advantage, mana development, untapped mana, and a lethal-board bonus, each a named tunable weight.
  Regression tests pin the three blind spots the old life-and-board leaf eval had.
  ⚠️ **RULE 7 — heuristic path is UNCHANGED, proven two ways.** (1) BEHAVIOUR: `npm run sim -- gauntlet
  "Mono-Red Aggro" --games 40 --seed 99` is **byte-identical** between `main` and this branch on every line
  except the throughput line — same games, same winners, same counts. (2) THROUGHPUT, **interleaved** over
  7 alternating rounds of a 700-game gauntlet (sequential comparisons on this box have already "proved" a
  change free that a proper interleaved run showed cost 4%): **main median 109 games/sec, branch median
  118** — at parity or better, and main's spread (57..137) shows why only the median is quotable. The only
  heuristic edit was extracting `scoredSpellGoals` out of `bestSpellGoal` (same code, same order);
  everything else is new files the heuristic never calls.
  ⚠️ **I found and fixed a real measurement bug in the existing bench.** `wilsonInterval(successes, n)` —
  `z` is a REQUIRED third argument, so the `strength` mode has been printing `95%CI=[NaN%, NaN%]` all
  along. It now reads `DEFAULT_STATS_CONFIG.z`. If you have an old strength result with NaN bounds, that
  is why.
  ❌ **What I did NOT build, and why** — brief §11 tactical solver, §12 opponent-threat search, §13–17
  belief model / determinization, §18–22 transposition tables and tree reuse, §31 learned policy. The brief
  itself says do not build it all at once, and each of those is a branch. The measured order still holds:
  the next-largest win is tree reuse between decisions, because the pilot currently throws its tree away
  after every macro. ⚠️ Also NOT done: re-defaulting. The hybrid is ~1400× the heuristic's per-decision
  cost, so the Lab's stock gauntlet would go from seconds to hours; that needs a throughput case, not a
  head-to-head win. The previous `mcts` flip shipped on exactly that reasoning gap.
  ⛔ **`packages/core` untouched, but ONE change is wanted there** (reported, not made — core is hot-path
  and other branches are live in it): `planManaPayment` re-scans `view.battlefield` with a `.find()` per
  offered `tapForMana` action, i.e. O(sources × battlefield) per call, and the hybrid calls it once per
  castable card per node. An index built once per call would make it O(sources + battlefield). It is the
  single hottest thing the new policy does.

- 2026-08-15 worker: `feat/attachments` 🚧 PUSHED — **auras + equipment, as ONE seam.** Suite **1856
  passed / 0 failed** (baseline 1822 + 34), `npm run verify` exit 0, `npm run build` exit 0, lint 0 errors.
  👉 **The seam is a RELATIONSHIP, not two systems.** `CardInstance.attachedTo` + a data
  `CardDefinition.attachment` (host filter, `PermanentModification`, `whenIllegal`). An Aura and an
  Equipment differ in exactly two places, both DATA: how they attach (a spell script vs an `Equip {N}`
  activated ability — both the same `attachToTarget` primitive) and what the SBAs do when they are not
  legally attached (CR 704.5m to the graveyard / 704.5n just unattach). Core never asks "is this an aura".
  👉 **The buff is DERIVED, never stored** — the same choice `statics.ts` made, and it pays off the same
  way: an attachment's grant is re-read from `state.battlefield` on every effective-P/T read, so it
  vanishes the instant the attachment leaves play with zero bookkeeping. It folds into `indexContinuous`
  as layer 3a beside statics (3b), so attachments, anthems, +1/+1 counters and until-EOT pumps all stack
  additively through ONE path. A 2/2 with a counter, an anthem, an Equipment and a pump reads 9/8.
  👉 **`isLegallyAttached` is one predicate covering all three SBA cases** (host left play / host no
  longer matches the printed line / attached to nothing), and `attachTo` asks the SAME function before
  forming a relationship — so the engine cannot create a board the SBAs immediately undo.
  ⚠️ **The brief asked for "hexproof gained after attaching → aura falls off". That is NOT the rule and
  I did not implement it.** Hexproof/shroud stop a permanent being TARGETED (a cast-time rule); only
  PROTECTION makes an already-attached Aura illegal (CR 704.5m + 303.4c), and this engine has no
  protection. Dropping the Aura there would make every Aura strictly worse than printed. There is a test
  pinning the correct behaviour so nobody "fixes" it.
  👉 **New core API:** `TargetRestriction` gained `'creatureYouControl'` (what every printed Equip aims
  at — offering the whole table would let a pilot equip the opponent's board); `restrictionOfEffects` is
  now exported from the core index; `StaticAbility` now extends a shared `PermanentModification` and
  `staticIsInert` is a thin wrapper over `modificationIsInert` (no behaviour change).
  ⚠️ **`CardInstance.attachedTo` is OPTIONAL in the type and always WRITTEN by every mint/clone path.**
  Deliberate: gameplay instances keep one object shape, while hand-built literals in other packages'
  tests (apps/web has four) and any older serialized state still compile and read as unattached. Every
  reader tests `!= null`, never `!== null`. Making it required broke the apps/web build; making it
  optional touches nothing outside my packages.
  ⚠️ **I touched ONE line outside my packages: `packages/sim/src/paired-arms-config.ts`** adds
  `'attachToTarget'` to `LIBRARY_SAFE_PRIMITIVES`. Its own test asserts the two sets cover the whole
  registry, so ANY new primitive fails the sim suite until it is classified — this is that test doing its
  job, not a scope grab. Integrator: expect a trivial conflict there if another branch adds a primitive.
  👉 **Cards ship through the IMPORTER, not the pool, and that was forced.** `packages/data-tools/data/
  card-index.json` (156 cards) contains **zero** Auras and **zero** Equipment, and
  `apps/web/src/data/card-index.test.ts` requires every pool card to have a display row with art. So a
  curated-pool playset needs a Scryfall re-fetch (data-tools) plus a web index regeneration — both
  outside this branch. Verified faithful from real printed Oracle text instead: **Unholy Strength, Dead
  Weight, Flight, Bonesplitter, Loxodon Warhammer**. Anyone importing those today gets a real card.
  👉 **The pilot genuinely plays them, proven by BEHAVIOUR not by tests passing**
  (`packages/cards/src/attachments-play.test.ts` plays real games): an Aura lands on the pilot's OWN
  creature and its power really goes up; Dead Weight is aimed at the OPPONENT and kills the creature; the
  Equip ability is activated and the sword ends up attached. ⚠️ **The first version of the equip pilot
  looked perfect and equipped exactly never**: the engine only OFFERS an activated ability whose mana
  cost the floating pool already covers, and the pilot never floats mana speculatively, so reading
  `legalActions` found nothing. It now plans equip through the same `planManaPayment` a spell uses.
  Anyone wiring a future mana-costed ability into a pilot will hit this.
  ⚠️ **PERF (rule 7) — read this before you re-measure anything on this box.** Two measurements, and
  they DISAGREE, so both are reported:
  · **`packages/core/bench/engine-alloc-bench.ts` (the repo's own noise-immune measure — its header says
    wall clock here "is close to worthless"): PARITY or better.** 10.71 µs/action vs base 10.92;
    122.6 vs 120.2 games/sec; `cloneState` 4156 ns vs 4128 (34.6 vs 34.4 ns per cloned instance).
  · **Gauntlet wall clock: −3.6%, consistent.** Golgari Midrange, 300 games/opponent (2,100 games),
    seed 99, INTERLEAVED base/branch four times: branch 240/239/238/235 vs base 244/248/247/249.
    The games are **byte-identical** (`sim gauntlet` output diffs clean), so it is pure overhead, not
    different play.
  👉 **I could not attribute the 3.6% to any single change, and the bisect is recorded so nobody repeats
  it.** Reverting each of these individually recovered NOTHING beyond noise: `packages/core` entirely
  (core alone measures at parity), `targeting.ts`, the attachment SBA scan, the pilot's equip scan,
  `pool.ts`. It is diffuse — six one-comparison additions spread across `indexContinuous`,
  `checkStateBasedActions`, `isLegalTarget`/`legalTargetsFor`, the clone and the pilot.
  👉 **The remaining lever, if the integrator wants it:** a monotone `GameState.hasAttachment` flag set
  on battlefield entry, so a game whose decks contain no Aura or Equipment skips the attachment work
  entirely. I did NOT do it: it is a second structure that can desync from the truth (miss one entry
  path and an unattached Aura silently stops dying), and I was not willing to take that trade at the end
  of a session for ~1% on a benchmark whose noise floor is ±2.5%.
  ⚠️ **Measurement discipline:** this box drifts 332→346 games/sec on IDENTICAL code within minutes
  (thermal), and my first three comparisons were sequential and therefore worthless — one of them
  "proved" a change was free that a proper interleaved run later showed cost 4%. Alternate the variants
  inside one shell invocation, use ≥2,000 games, and prefer the allocation bench.
  👉 **Two real hot-path traps found and avoided, both worth knowing:** a helper returning
  `{ statics, attachments }` allocated an object on EVERY `indexContinuous` call (it runs several times
  per action) — the discovery is inlined instead; and the attachment SBA originally re-walked the
  battlefield once per FIXPOINT PASS — nothing enters the battlefield during SBAs, so the set is
  collected once per call and is `null` (one reference compare per pass) on every board without an
  attachment.
  👉 **Stale-hint fix:** the compiler's unsupported hint for `equip|attach|enchant` no longer says the
  whole system is missing; it now names the missing TEMPLATE. Separately: **`statics.ts` exists in core
  but NO compile rule reaches it**, so anthems still cannot be imported — that is a genuine gap and I
  left it alone because `feat/static-effects` is in flight on the same files.
  (Worker — pushed, NOT merged.)

- 2026-08-15 integrator: **`npm run lint` had been red on `main` for a long time — 259 errors — and
  nobody noticed because nothing ran it.** Now green (0 errors) and wired into a new root
  **`npm run verify`** (offline: lint + card-index `--check` + full tests). Run it before you push.
  What the 259 were: **226 were `dist-bundle/`**, i.e. eslint was linting the bundler's OUTPUT — now
  ignored. 29 were `packages/ai/bench/*.mjs` missing Node globals — `bench/` and `spikes/` now get the
  same globals block as `scripts/`. That left **4 real ones**, and they were worth having:
  👉 **`eslint-plugin-react-hooks` was never installed**, yet three files carried
  `eslint-disable-next-line react-hooks/exhaustive-deps`. Each disable was suppressing NOTHING and was
  itself an error (eslint rejects a disable for an unknown rule). Plugin installed; the classic pair
  (`rules-of-hooks`, `exhaustive-deps`) are ERRORS.
  👉 It immediately found a **real bug** in `components/match/useReplayPlayback.ts`: the auto-advance
  effect omitted `advance` from its deps, so the running interval held the closure from the render that
  started playback — **toggling "skip quiet frames" mid-playback silently did nothing** until you
  paused. The comment directly above it claimed the opposite. Fixed.
  👉 Two `useMemo`s flagged as having an "unnecessary" dependency (`importedCount`, `decks.decks`) are
  the opposite — **invisible** dependencies. `allAvailableCards()` reads a module registry that deck
  import mutates, so those deps are the only signal the pool grew; removing them (as the rule advises)
  breaks imported-card browsing. Documented disables, not removals. **Don't "fix" them.**
  👉 The compiler-era rules (`set-state-in-effect`, `refs`) are **WARN on purpose** — 5 sync setStates
  in effects + 1 ref-write during render, all in UI that currently works. Fix one file at a time and
  promote to error; a blind mechanical sweep is how working screens break.
  ⚠️ **Gap needing an owner: the web app has NO hook/component test infrastructure** — no
  `@testing-library/react`, no jsdom, zero `renderHook` anywhere. The replay bug above could only be
  guarded by the lint rule, not a test. Adding that stack is a real decision, not a drive-by; whoever
  takes it should propose it rather than sneak it into another branch.

- 2026-08-15 worker: `feat/card-index-truth` 🚧 PUSHED (apps/web/src/data + apps/web/scripts + the two
  web card doc-comments + one eslint global). **The reported bug did not exist — read this before
  anyone re-opens it.** The claim was that `apps/web/src/data/card-index.json` is a stale hand-copied
  32-card subset of a ~157-card pool. MEASURED on `ae1a894`: the web copy was **156 cards and
  BYTE-IDENTICAL** (sha1 `c94efd7e…`) to `packages/data-tools/data/card-index.json`, `CARD_POOL` is
  **156** (32 curated + 124 expanded), and the join is exact — **0** pool cards missing a row, **0**
  orphan rows, **0** rows without art. `c09b3ac` fixed it back in June.
  👉 **The "32" was STALE PROSE, and it cost a whole agent-task.** Three comments still described the
  pre-`c09b3ac` world — `lib/cards.ts` ("32 real MTG cards"), `lib/cards/enginePool.ts` ("only ~32 of
  them", "100+ cards … were invisible"), and `views/LabView.tsx` ("the curated index (~32)"). Someone
  read those, believed them over the data, and filed a headline defect. I corrected the first two;
  **`LabView.tsx:209` still says `~32` and I deliberately left it alone** because
  `feat/pool-adaptive-wire` owns that file — whoever merges that branch should fix the number.
  Treat a stale comment as a bug with a blast radius, not as decoration.
  👉 What WAS real: the copy was **unguarded**. Nothing generated it and nothing compared it, so the
  only thing preventing the reported bug was someone remembering to copy a file. It is now DERIVED by
  `apps/web/scripts/build-card-index.mjs` (`npm run cards:index -w @jonny-boi/web`, `--check` for CI)
  and `apps/web/src/data/card-index.test.ts` re-derives it every `npm test`. Sabotage-tested: cutting
  the file back to 32 cards makes 3 tests fail and names all 124 lost cards.
  👉 **The bundled index is now a PROJECTION, and that is a free PWA win.** Scryfall ships 11 image
  variants per card; `cardImage()` can only ever return 4 (`small`/`normal`/`large`/`art_crop`), so the
  other 7 were dead weight in every download. Dropping them: main chunk **758.58 → 642.14 kB raw
  (−15.4%)**, **179.11 → 170.65 kB gzip (−4.7%)**, PWA precache **958.80 → 845.09 KiB (−11.9%)**. A test
  asserts `DISPLAYED_IMAGE_VARIANTS` still covers every size `cardImage` can return, so widening the UI
  fails loudly here instead of quietly losing art.
  👉 **`enginePool.ts` now contributes ZERO records and should NOT be deleted for it.** It synthesizes a
  text-only display record for any engine card the index lacks; the index covers everything today, so it
  is an empty safety net — which is the healthy state, and the rule-6 fallback for the window between
  adding a card and regenerating. Comment updated to say so.
  ⚠️ **Two gotchas for the next person.** (1) `core.autocrlf=true` and there is no `.gitattributes`, so
  every committed JSON is CRLF on disk and LF in git — any byte-compare guard MUST normalize newlines or
  it reports a false "stale" on every Windows checkout. (2) The Scryfall CDN answers **HTTP 400 to
  `HEAD`**; art-liveness checks must use GET (I used a 1 KB Range + JPEG magic-number check). 28/28 real
  image fetches across 7 sampled cards incl. the one DFC came back as valid JPEGs.
  ❗ **`npm run verify` does not exist at the root** — I was told to extend it. The only `verify` in the
  monorepo is `@jonny-boi/data-tools`' NETWORK re-fetch against live Scryfall, whose own header says it
  must not run in `npm test` or CI. So the offline guard went where this repo's guards actually live
  (the vitest suite), plus a `--check` flag on the same module for a human/CI to call. If the integrator
  wants a root `verify`, `node apps/web/scripts/build-card-index.mjs --check` is the line to add.
  Suite **1822 passed / 0 failed** (baseline 1814 + 8 new), `npm run build` exit 0, eslint clean.
  (Worker — pushed, NOT merged.)

- 2026-08-15 DESKTOP-90PJPM4: **`feat/mechanics-wave2` MERGED to main + deployed.** main = **1735
  tests, build exit 0**. Adds **flash, hexproof, shroud** — three keywords that change what is
  LEGAL rather than what happens in combat, so each is read by the rule that governs it:
  - `flash` → `castTiming` returns 'instant'. Every consumer (legality, both pilots, hotseat UI)
    inherits it with no further change. An explicit `timing` on the card still wins.
  - `hexproof`/`shroud` → enforced in `isLegalTarget` AHEAD of any restriction, so they hold for
    every targeting effect rather than each one remembering. `legalTargetsFor` filters them out
    too, so a protected permanent is never even offered.
  ⚠️ **Perf note for anyone touching `isLegalTarget`:** it runs for every candidate target of every
  castable spell on the hot path, and reading GRANTED keywords needs `indexContinuous`. It now
  short-circuits on `state.continuous.length === 0` and printed keywords first; keep that ordering
  or the sim slows measurably.
  👉 Hint accuracy again: bare "flash" no longer routes to the queue (only `flashback` does), and
  the old hexproof hint now names only **ward and protection-from**, which really are missing.
  ⛔ **`gaining control` was attempted and deliberately BACKED OUT.** Doing it properly needs an
  `effectiveController()` threaded through combat, priority, and legality — `permanent.controller`
  is read directly in many places, and a continuous "control-change" layer without that accessor
  would be half-applied and silently wrong. It needs its own branch, not a corner of this one.
  STILL MISSING: planeswalkers, transform/DFC, {X} and derived values, alternative costs
  (suspend/spectacle/flashback/kicker), auras + equipment, ward/protection, gaining control,
  dynamic P/T, "unless its controller pays", targets chosen by a triggered ability.
  (Integrator)
- 2026-08-15 worker: `feat/pool-adaptive-wire` 🚧 PUSHED (apps/web + packages/sim) — **joins the
  multi-core worker pool to the adaptive suggestion search**, which had collided: the pool was still
  running the OLD fixed candidate loop, hand-rolled next to the sim, so the Lab ran the wrong algorithm
  fast and `determinism.test.ts`'s parity assertion against `suggestSwaps` failed (correctly).
  Successive halving is **stateful across candidates**, so the pool now dispatches ROUND BY ROUND with a
  barrier: shared base games for the round's new slots → join → every surviving arm's variant games,
  cut by SLOT range → join → the sim decides eliminations. The web layer schedules and decides nothing;
  verdicts, futility, the rank cut, Holm and the ranking all run through the sim.
  👉 **NEW SIM API other agents can use** (all additive): `RunOptions.range` — play a slice of the
  (opponent, game) grid on `runMatchup`/`evaluateSwap`, which is how a shard reuses those loops instead
  of copying them; `PairedArmRunner.playSlice` / `baseRecordAt` + `PairedArmsOptions.baseRecords` —
  play one arm's slots anywhere and adopt base games another process played; `prepareSuggestionRun` +
  `driveAdaptiveSearch` (a GENERATOR) + `finishSuggestionRun` — the search separated from whoever plays
  the games; `candidateSeedSalt`, `copiesSwappedBy`, `GAMES_PER_PAIRED_GAME` exported.
  `suggest.ts` was split into `suggest-candidates` / `suggest-run` / `suggest-report`; `suggestSwaps` is
  now just the single-threaded driver of the generator. **Two real bugs fixed in passing:** the adaptive
  engine reported `copiesSwapped: 1` for every suggestion under the default `playset` scope (so the
  Lab's Apply button offered to move one copy of a 4-of), and the CLI's `--pilot` help described the
  default as the look-ahead pilot when `DEFAULT_PILOT_ID` is `heuristic`.
  **MEASURED** (Mono-Red Aggro vs the 7-deck gauntlet, 24 candidates, seed 0xDEADBEEF, 12 logical cores
  that thermally throttle 3301→2011 MHz under all-core load):
    · pooled + FIXED (the pre-merge collided state, measured on a worktree at `a97b43f`):
      20,160 games, **28.5 s**
    · headless adaptive (CLI, one core): 2,438 games, **8.6 s** eval / 13.3 s wall
    · pooled + adaptive (this branch, 11 workers): 2,438 games, **4.5–5.0 s** → **~6× vs the
      collided state**, and byte-identical output to the CLI
    · at 200 games/finalist: 8,250 games in 9.6 s at 11 workers (867 games/sec) vs 41 s at 1 worker
      (206 games/sec) = **4.2× parallel**, i.e. 63% of the ~6.7× this box can actually reach all-core.
  **HONEST GAP:** the fixed sweep parallelises BETTER (708 games/sec vs ~870 here is close, but the
  fixed run is one flat queue with zero barriers). Round 1 is the weakest round (37% efficiency), not
  the late ones — splitting each arm's SLOTS keeps a two-survivor final round at 34 shards in flight.
  👉 **FOLLOW-UP worth someone's time:** ~1.9 s of a short run is 11 workers each independently building
  a card pool + effect registry. `SimWorkerPool.warmUp()` now overlaps that with the planning phase
  (round 1: 1.98 s → 1.08 s) but does not remove it — it is memory-bandwidth bound. A shared/immutable
  pool, or building it once and structured-cloning it, would be the real fix and would help every run
  kind, not just suggestions. (Worker — branch pushed, NOT merged.)

- 2026-08-15 DESKTOP-90PJPM4: **`feat/card-mechanics` MERGED to main + deployed.** It contained the
  whole stacked chain (`activated-abilities` → `conditional-taplands` → `card-mechanics`), so all
  three are now integrated — the table above is updated. main = **1648 tests, build exit 0**.
  Mechanics added across the chain: activated abilities with costs (fetchlands crack), conditional
  enters-tapped (fastlands/checklands), bounce, fight, mill, group damage, leaves-the-battlefield
  triggers, compound draw/lose, +1/+1 counters, artifact + opponent-only targeting, modal spells.
  👉 **THE "INVISIBLE PRIMITIVE" AUDIT IS WORTH RE-RUNNING PERIODICALLY.** Three separate mechanics
  turned out to be fully implemented primitives that NO compile rule could reach — `returnToHand`
  (bounce) and `modal` (every charm and command) among them. One line finds them:
  compare `CORE_PRIMITIVE_IDS` against the `primitive: '...'` ids the rule table emits.
  Only `createToken` and `tapPermanents` remain unreached.
  ⚠️ **Modal needed a TEXT change, not just a rule.** A modal card prints its header and each mode
  on separate lines, so the newline split handed the compiler "Choose one —" with no modes and then
  orphan bullets. `text.ts` now folds the block into one ability line. If you add a mechanic whose
  printed form spans lines, check `splitAbilities` first.
  ⚠️ Also note `'opponent'` targeting depends on WHO is casting, so `isLegalTarget` /
  `legalTargetsFor` / `illegalTargetReason` now take an optional `controller`. Absent ⇒ the target
  is ILLEGAL, never guessed.
  STILL MISSING (the honest remainder): planeswalkers, transform/DFC, {X} and derived values,
  alternative costs (suspend/spectacle/flashback/kicker), auras + equipment, hexproof/ward/
  protection, gaining control, dynamic P/T, flash + graveyard recasting, "unless its controller
  pays", and targets chosen by a triggered ability.
  (Integrator)

- 2026-08-15 DESKTOP-90PJPM4: `feat/card-mechanics` PUSHED (packages/cards + one core event).
  **1531 tests, build exit 0.** Stacks on `feat/conditional-taplands` → `feat/activated-abilities`;
  **merge that chain in order.** Four mechanics, each proven at BOTH levels (primitive behaviour +
  compiler reaching it from the real printed template):
  - **bounce** — `returnToHand` was already implemented and tested, and every bounce card was
    still reported unsupported, because no rule pattern could reach it. **Worth checking for more
    of these:** a primitive with no rule is invisible. Compare `CORE_PRIMITIVE_IDS` against the
    ids the rule table actually emits.
  - **fight** — reads BOTH powers before applying either, so a mutual kill kills both.
  - **mill** — moves cards through the owned-zone path so a milled card is really in the
    graveyard; short library empties rather than over-milling. Adds the `cardsMilled` event.
  - **group damage** — one `dealDamageToEach` for each-creature / each-opponent / symmetrical,
    snapshotting the battlefield first (damage is simultaneous).
  👉 **I also corrected the UNSUPPORTED HINTS, which feed UNSUPPORTED-MECHANICS.md.** Three now say
  "a <kind> template the compiler does not recognize yet" (the system exists; the printed shape is
  what is missing), and the bounce hint is DELETED — so "when ~ enters, return target creature to
  its owner's hand" now explains as **"targets chosen by a triggered ability"**, the real blocker.
  A stale hint sends the next agent to implement something that already works; treat the hint text
  as part of the feature, not decoration.
  ⚠️ **Machine was memory-starved** (~200-700 MB free, several agent sessions at once): `vitest`
  worker spawn failed repeatedly under Git-bash with `fork: Resource temporarily unavailable` /
  `spawn UNKNOWN`. Running the same command through **PowerShell** worked. Stop any dev server you
  are not using before a full-suite run.
  (Worker — pushed, NOT merged.)
- 2026-08-15 DESKTOP-90PJPM4: `fix/hero-validation` (apps/web only) — REPRODUCED LIVE, then pinned.
  Ran the dev server and imported a real Modern Boros list. The Match viewer answered:
  `unknown card "2588f348-…"` x4 and nothing else — four raw Scryfall uuids, shown nowhere else in
  the UI, so you cannot tell which of your cards is the problem. Cause: `validateHero` was copied
  into LabView and MatchView and the copies drifted; only the Lab's checked for unsupported imports,
  so the Match viewer fell through to the sim's id-level validator. Now one `lib/heroValidation.ts`
  (net -38/+8 in the views). Tests assert the NAMES appear and no uuid does, at the exact shape
  captured from the app (4 unplayable + 2 playable imports); removing the fix fails 3 of the 6.
  ⚠️ FOR WHOEVER OWNS `packages/cards/src/compile` (feat/card-mechanics): a split card is
  mis-diagnosed. "Wear // Tear" reports THREE bogus blockers — `“//” — needs the "//" card type`
  (the type line "Instant // Instant" is being split into a literal `//` type), and
  `“Wear // Tear” — needs transform / double-faced cards` (a split card is not a DFC; `layout` is
  `split`, not `transform`). Only `Fuse` and the targeting clause are real. Not fixed here: that
  package is yours and was uncommitted-dirty at the time. (Worker)

- 2026-08-15 DESKTOP-90PJPM4: `fix/hero-validation` ✅ (apps/web views + lib only) — **the Match viewer
  would not tell you which card broke your deck.** `validateHero` had been copied into BOTH `LabView`
  and `MatchView`, and the copies had drifted: the Lab's named unsupported imported cards first, the
  Match viewer's went straight to the sim's validator. So watching a game with a freshly imported deck
  failed as `unknown card "<uuid>"` — true and useless, and the uuid appears nowhere in the UI, so
  there was no way to work out which of your 60 cards it was.
  Fix: one shared `apps/web/src/lib/heroValidation.ts`, used by both views; the per-view copies are
  gone (DESIGN §1.3, one mechanism per concept). Behaviour is now identical on both surfaces, and an
  unsupported card is still reported FIRST — fixing a deck-size complaint would not make such a deck
  runnable. 5 tests in `heroValidation.test.ts` pin the ordering, the naming (asserts the uuid is NOT
  leaked), and that both surfaces refuse identically.
  Scope note: no `packages/**` touched. `deckHealth.ts` (used by DeckBuilderView) and
  `unsupportedCardNames` (used here) still answer overlapping questions — NOT merged, because that is
  a wider refactor across surfaces other agents are editing. Flagged, not started. (Worker)

- 2026-08-15 DESKTOP-90PJPM4: `feat/card-alacarte` ✅ MERGED to main + deployed. Add ONE Scryfall card
  by name from the card browser or mid-deck-build, fuzzy-matched ("lightnig bolt" resolves), screened
  by the SAME compiler deck import uses. New files only, no edits to the compiler — safe alongside
  in-flight `packages/cards/src/compile` work.
  👉 **NEW SEAM — `apps/web/src/lib/cards/unsupportedRegistry.ts`.** Every clause the compiler refuses
  is now COLLECTED, grouped by the missing engine SYSTEM (the unit of work — implement once, unblock
  every card waiting on it), with the blocked cards and a verbatim clause. Exports Markdown via
  `formatUnsupportedReport()`. **This is the queue to work from** — see the new
  [UNSUPPORTED-MECHANICS.md](UNSUPPORTED-MECHANICS.md) for the contract and how to pick an item up.
  👉 **NEW: [TESTING.md](TESTING.md)** indexes all 87 suites and what each guards, so there is one list
  to run through after a change. It also records the two lessons this repo learned painfully: test
  against the REAL vocabulary (the `destroy` vs `destroyTarget` fixture bug), and assert pilots play
  SENSIBLY, not merely that games finish (the MCTS-as-default bug).
  Also fixed: the card browser read the CURATED pool only, so an imported/added card never appeared
  in it at all — now reads the full pool and subscribes to the store.
  Deck-level honesty: `decklist/deckHealth.ts` badges any deck holding an unplayable card and names
  the cards; one unplayable card ⇒ whole deck unplayable (a blank card silently skews an A/B verdict).
  Suite **1460 passed / 0 failed**, build exit 0, Deploy PWA green.
  ⚠️ Verified by tests + typecheck + production build + a clean browser boot (no console errors); the
  add dialog was NOT driven interactively (the session's browser tooling was wedged), so the Scryfall
  round-trip is proven only against stub responses. Worth a real click-through.
- 2026-08-14 DESKTOP-90PJPM4: `feat/conditional-taplands` PUSHED (packages/core + cards/compile).
  Merged latest main (incl. the a-la-carte card adder) — **1489 tests, build exit 0**.
  Builds directly on `feat/activated-abilities`, so **merge that one first**.
  - `CardDefinition.entersTappedUnless` — a BOARD condition read as the permanent enters:
    `maxOtherLands` (fastland cycle) and `controlsSubtype` (checkland cycle, reusing the land
    subtypes added for fetchlands). The engine had only the unconditional "~ enters tapped", so
    every dual land whose drawback is a condition was unplayable.
  - ⚠️ **Self-exclusion is the subtle part.** Both battlefield-entry paths pass `self` so the
    entering land is not counted among "other lands you control". Without it every fastland enters
    tapped one land early — a silent one-turn tempo loss in every simulated game. Tested at the
    boundary (exactly the printed count, and one past it).
  - With no board supplied the answer is TAPPED: "enters tapped" is the printed rule and the
    "unless" is the exception, so the conservative answer can never make a card play better than
    printed.
  👉 **SHOCKLANDS ARE STILL UNSUPPORTED, on purpose.** "You may pay 2 life" is a price, not a board
  state, and it must be asked at LAND-PLAY time. The choice system cannot reach there: playing a
  land is a special action (`applyPlayLand`) and never opens a resolution frame, which is the only
  place `pendingChoice` can be parked. Whoever wants shocklands (a big slice of real manabases)
  needs choice-at-special-action first — that is the real prerequisite, not another compile rule.
  A test asserts Sacred Foundry stays reported so nobody "fixes" it by guessing.
  (Worker — pushed, NOT merged.)

- 2026-08-14 DESKTOP-90PJPM4: `feat/activated-abilities` PUSHED (packages/core + cards/compile +
  ai/heuristic). Merged latest main incl. `fix/rules-audit` — **1451 tests, build exit 0**.
  **Measured** on a real Modern Burn list through the importer: **19/60 playable → 30/60**, and the
  "library-search template" gap is gone. Fetchlands were 11 copies of dead card.
  - `CardDefinition.activated` — a `COST: EFFECT` line with {T} / pay N life / sacrifice ~ / mana.
    New `activateAbility` action. Offer and accept share ONE `unpayableActivationReason`, so a pilot
    is never handed an action the engine then rejects. Costs are paid in full before the ability hits
    the stack and are NOT refunded (rule 602.2). It rides the existing `trigger` stack object — no
    third stack-object kind for masking/replay/AI to learn.
  - **New seam worth knowing:** `CardDefinition.subtypes` (lowercased) + `CardFilter.anyOfSubtypes`.
    A fetchland searches for "a Mountain or Plains card" — that must find a SHOCKLAND, not just a
    basic, so matching by name would have been a card playing worse than printed. Any future
    subtype-selecting card gets this for free.
  - `targeting.ts` gained `illegalTargetReasonForEffects` / `restrictionOfEffects` so an ability is
    policed against ITS OWN effects rather than the card's spell script.
  - The pilot half matters as much as the engine half: an ability nothing activates is
    indistinguishable from a card that doesn't work. The heuristic cracks fetchlands and
    **deliberately nothing else** — a sac outlet or a pinger needs real cost/benefit reasoning and
    guessing would make pilots play worse. If you add ability scoring, that is the seam.
  👉 Next-biggest measured gaps on that same list, in copies: the unrecognised-template bucket
  (Eidolon's mana-value-filtered cast trigger, Searing Blaze, Skullcrack, Skewer's spectacle,
  Boros Charm's modes = 18 copies), then CONDITIONAL enters-tapped (Sacred Foundry / Inspiring
  Vantage = 8 copies; the unconditional form already works, these need the choice system for
  "unless you pay 2 life").
  (Worker — pushed, NOT merged.)
- 2026-08-15 DESKTOP-90PJPM4: `feat/card-alacarte` ✅ MERGED to main + deployed. Add ONE Scryfall card
  by name from the card browser or mid-deck-build, fuzzy-matched ("lightnig bolt" resolves), screened
  by the SAME compiler deck import uses. New files only, no edits to the compiler — safe alongside
  in-flight `packages/cards/src/compile` work.
  👉 **NEW SEAM — `apps/web/src/lib/cards/unsupportedRegistry.ts`.** Every clause the compiler refuses
  is now COLLECTED, grouped by the missing engine SYSTEM (the unit of work — implement once, unblock
  every card waiting on it), with the blocked cards and a verbatim clause. Exports Markdown via
  `formatUnsupportedReport()`. **This is the queue to work from** — see the new
  [UNSUPPORTED-MECHANICS.md](UNSUPPORTED-MECHANICS.md) for the contract and how to pick an item up.
  👉 **NEW: [TESTING.md](TESTING.md)** indexes all 87 suites and what each guards, so there is one list
  to run through after a change. It also records the two lessons this repo learned painfully: test
  against the REAL vocabulary (the `destroy` vs `destroyTarget` fixture bug), and assert pilots play
  SENSIBLY, not merely that games finish (the MCTS-as-default bug).
  Also fixed: the card browser read the CURATED pool only, so an imported/added card never appeared
  in it at all — now reads the full pool and subscribes to the store.
  Deck-level honesty: `decklist/deckHealth.ts` badges any deck holding an unplayable card and names
  the cards; one unplayable card ⇒ whole deck unplayable (a blank card silently skews an A/B verdict).
  Suite **1460 passed / 0 failed**, build exit 0, Deploy PWA green.
  ⚠️ Verified by tests + typecheck + production build + a clean browser boot (no console errors); the
  add dialog was NOT driven interactively (the session's browser tooling was wedged), so the Scryfall
  round-trip is proven only against stub responses. Worth a real click-through.

- 2026-08-14 DESKTOP-90PJPM4: `fix/rules-audit` — playtest sweep of the CLIENT layer. The headless
  engine is clean (new `packages/sim/src/rules-audit.test.ts` plays full games and asserts zone
  integrity, SBAs, untap, damage clearing, until-EOT expiry, land drops — 36 games, no violations).
  Every bug found was in the client:
  1. **Modal mana sources were dead in manual play.** `fix/ai-play-quality` moved Birds of Paradise to
     `producesOptions`, but four consumers still read `def.produces` directly (hotseat auto-tap,
     hotseat affordability, hotseat board view, online board view) and so saw it as producing NOTHING.
     My regression — apologies to anyone who played a Birds deck.
  2. **Hotseat auto-tap** had the pilots' old flaws: first-untapped-permanent, no colour reasoning, no
     summoning-sickness check, no stop condition.
  3. **Online play could never cast a spell.** The server only lists `castSpell` once the pool already
     pays, and the online board had no tap control at all. Now plans client-side and sends taps + cast;
     the server still validates every action.
  4. **Pass-and-play demanded a device handoff at every priority window** (~10/turn, nearly all empty).
     `hasMeaningfulChoice` / `autoAdvancePriority` skip windows offering only passing and unspendable
     mana taps, bounded by the existing `maxAutoAdvanceSteps`.
  5. Action bar sat below the fold at 720p — now sticky (`components/play/action-bar.css`, NOT styles.css).
  👉 **Seams other agents should know about:** the pilots' payment planner now lives in core as
  **`planManaPayment`** (+ `ManaTapPlan`), used by BOTH the AI heuristic and the client — do not add a
  third copy. It takes a narrow **`ManaPlanView`** (battlefield + pools) so the online client can plan
  from its redacted view; `legalTargets` was widened the same way. `canPay` remains the authority on
  payability, so the planner cannot disagree with the engine as costs grow.
  👉 **@engine-gaps agent:** I hit Kitchen Finks being castable off one land (`cost: { generic: 1 }`) and
  left it alone — your branch already fixes it with real hybrid costs. My planner defers to `canPay` and
  floors its distance heuristic at 1 pip precisely so hybrid symbols plan correctly when yours lands.
  Suite 589 passed / 0 failed at the time of writing, `npm run build` exit 0.
  ⚠️ **Merged latest main after the fact.** Main had meanwhile landed a MANUAL mana-tap menu
  (`lib/play/mana-tap.ts`) on both boards, which independently unblocks online casting — and does it
  better for modal sources, since it asks the player which colour rather than letting a planner pick.
  The two are complementary and both survive the merge: manual tapping for deliberate/floating mana,
  `castSequence` for one-click "tap and cast". If you ever need to choose, keep the manual menu.
  (Worker — pushed, NOT merged.)

- 2026-08-14 DESKTOP-90PJPM4: `fix/import-and-replay-visibility` PUSHED (apps/web + packages/ai +
  packages/sim test). Merged latest main (incl. the new core choice system) — **1099 tests, build exit
  0, suite now 61s**. Three user-reported bugs, all found by watching a game:
  1. **Import returned a crippled deck.** Unsupported cards were dropped silently with only a count.
     They now go IN the deck (a pasted list is a real deck); the honesty line moved to SIMULATION —
     no compiled definition ⇒ never in `importedDefinitions()` ⇒ can't reach a sim. The Lab refuses
     by NAME instead of `unknown card "<uuid>"`. Not-found names are listed too (usually typos).
     Also: `.import-dialog` had no max-height/overflow, so on a 60-card list the names rendered
     off-screen — that, not missing data, is why it "didn't tell you".
  2. **DEFAULT_PILOT_ID was MCTS and it plays badly.** Measured `manaPoolEmptied` (mana tapped and
     never spent): heuristic 0.01/turn vs **mcts 1.76/turn** — 176× — at ~100× the wall clock. That
     is the reported "tapped a Sol Ring and did nothing". Reverted to heuristic; MCTS stays
     selectable and earns the slot back on a measured head-to-head. New `pilot-quality.test.ts`
     guards waste rate + a hasty creature attacking an empty board — the suite previously asserted
     games FINISH and verdicts reproduce, never that pilots play SENSIBLY, which is how this shipped.
  3. **Watch a Game showed only counts.** Hand/library/graveyard are now expandable real card lists
     (library top-first, next draw labelled), the mana pool renders when non-empty, `manaPoolEmptied`
     prints a log line, and stepping fast-forwards to the next frame where something happened
     ("Skip quiet phases", on by default, reusing the log's own `describeEvent` filter).
  ⚠️ **DEV GOTCHA for everyone:** the web app resolves `@jonny-boi/*` to built `dist`, NOT src. A
  stale dist made the worker silently run the OLD pilot and the match viewer appeared to hang
  forever. Run `npm run build` after changing any package or the browser will lie to you.
  (Integrator)
- 2026-08-14 DESKTOP-90PJPM4: `feat/import-smart-names` ✅ (apps/web/src/lib/decklist only) — a standing
  regression guard on TWO REAL tournament lists (Boros Energy, Goryo's Vengeance) in
  `real-decklists.test.ts`. The unit tests prove each import rule alone; this proves they still compose
  on the lists that actually broke, offline, against a Scryfall fake that reproduces the one asymmetry
  that matters: `/cards/collection` matches a card FACE name only, while `/cards/search` also sees
  printed names. Covers "Wear // Tear", the Universes Beyond printing "Kavaero, Mind-Bitten"
  (Scryfall files it as "Superior Spider-Man"), and DFCs named by their front face.
  MEASURED against these lists on this commit: every name now resolves (0 not-found), but only
  **2/75 and 6/75 copies are PLAYABLE**. The wall is not import — it is compiler/engine coverage:
  • the biggest bucket is "a rules template the compiler does not recognize yet" (19 + 12 copies), and
    it is a LONG TAIL of unrelated mechanics (Ascend, Mobilize, Rebound, Replicate, Warp, cost
    reduction, counterspells, Blood Moon's static effect) — no single fix unlocks it.
  • the one COHESIVE win is the mana base: fetchlands + shocklands are 15 copies in EACH list (20% of
    the deck). ⚠️ Do not start that here — `feat/activated-abilities` is actively building it
    (`cost: { tap, life, sacrificeSelf }`, an `activateAbility` action, fetchland tests). Shocklands
    additionally need the "you may pay 2 life" choice, which `packages/core/src/card.ts` documents as
    deliberately unimplemented pending the choice system that branch also owns.
  No `packages/core` or `packages/cards` files touched, by design. (Worker)

- 2026-08-13 DESKTOP-90PJPM4: `feat/import-formats` ✅ (apps/web/src/lib/scryfall + decklist/resolve) —
  **two real deck-import bugs, found by importing the user's actual Modern lists.** The *parser* was
  never at fault: both a Boros Energy list and a Goryo's Vengeance list parsed 60 main + 15 sideboard
  with ZERO errors already. Both failures were in the Scryfall lookup:
  1. **`/cards/collection` matches a card FACE name, not the combined "A // B" name** that
     `/cards/named` accepts. Asking it for "Wear // Tear" is a miss; asking for "Wear" returns the
     whole card. Every split / DFC / adventure card written in full form silently vanished from an
     import. `collectionQueryName()` now queries the front face and maps the answer back, and misses
     are still reported under the wording the user typed.
  2. **Universes Beyond printings are filed under their licensed name.** "Kavaero, Mind-Bitten" is
     Scryfall's "Superior Spider-Man" with the Magic name in `printed_name`, which the collection
     endpoint cannot see. Added a second-chance pass: for names that missed, one
     `/cards/search?include_multilingual=true&q=!"…"` each. Anchored with the `!` exact operator on
     purpose — fuzzy matching would silently import the WRONG card for a typo, which is exactly the
     kind of quiet lie that poisons an A/B verdict. Costs zero requests on a list that resolves clean.
     `CollectionResult.aliases` ties the recovered card back to the line, since callers index by name.
  Result: both lists now resolve **75/75 cards, 0 not-found** (was 74/75 each).
  ⚠️ **Resolving is not playing.** Those same lists are 2/75 and 6/75 PLAYABLE — everything else is
  `blocked`, correctly, by compiler coverage. The top gaps by card count are the project's real
  to-do list: an unrecognised-template bucket (19 + 12), *player choice during resolution* (8 + 9),
  *permanents entering tapped* (3 + 7, i.e. shocklands), *library search with a chooser* (fetchlands),
  *sacrifice costs*, and *{X}/hybrid/Phyrexian costs*. Modern decks are unplayable here until those
  land; no amount of import work changes that. (Worker — branch pushed.)
- 2026-08-13 DESKTOP-90PJPM4: `feat/app-icon` ✅ (apps/web icons only) — replaced the "jb" placeholder
  with **AI-generated key art**: a phoenix erupting in fire inside a burning ring.
  **Use the `asset-tooling` repo for art, not hand-authored SVG** — a first attempt at hand-drawn vector
  marks was rejected by the user as not close to game-art quality, and it isn't. Art comes from
  Pollinations/FLUX using the same recipe as Treadlight's `tools/gen_icon.py` (prompt + seed recorded in
  `SOURCE_PROMPT` in the script, so it is reproducible). Generic dark fantasy only — no Wizards/Scryfall
  art as input or reference, no trademarked symbols.
  `apps/web/scripts/generate-icons.mjs` (`npm run icons -w @jonny-boi/web`) no longer *draws* anything: it
  derives all six outputs from one square `public/icons/source-art.png`, so **swapping the icon = drop in a
  new PNG + re-run**. `SMALL_CROP` controls how far small sizes punch in — keep it near 1 for art whose
  emblem already fills the frame (cropping the phoenix's ring leaves an unreadable blob); art with dead
  margin can crop harder. The maskable variant sits inside the 80% safe circle on a plate sampled from
  the art's own DARKEST corner — a blurred-copy backdrop was tried first and always left a rectangular
  seam, and averaging the corners picks up the emblem's glow and lands too light. Manifest/`index.html` are now PNG-only (the SVG icons are gone). Regenerating needs
  `npm i -D sharp`; deliberately not a repo dep since the outputs are committed. (Integrator)

- 2026-08-13 DESKTOP-90PJPM4: `fix/ai-play-quality` — **COMBAT COULD NOT END.** The reason MCTS games
  appeared to "take forever" was not search cost: `CombatState` inferred "have attackers/blockers been
  declared?" from whether the list was NON-EMPTY. But declaring *no* attackers (or no blockers) is a
  legal, routine choice, so an empty declaration left the step looking undeclared, it was offered again,
  and since declaring resets `consecutivePasses` **the step could never advance**. A pilot that passes by
  convention (heuristic) never hit it; a pilot that SEARCHES its options did — MCTS spun one
  declare-blockers step 240+ times and a game never got past turn 5 in 4000 actions.
  Fix: explicit `attackersDeclared` / `blockersDeclared` flags on `CombatState`, gated in both
  `applyDeclare*` and `generateLegalActions`. Anyone constructing a `CombatState` literal must set them
  (test fixtures updated). Regression covered in `packages/core/src/combat-declaration.test.ts`,
  including a full game of adversarial empty declarations that must still reach turn > 8.
  Perf, all strength-neutral (same search, same results — measured, not assumed):
  • `applyActionInPlace` — a no-clone entry point for look-ahead that already owns its state. The pure
    `applyAction` deep-copies BOTH libraries (100+ instances) per action; MCTS now clones once per
    playout instead of once per ply.
  • MCTS skips windows where the only options are mana taps and nothing in hand is castable — pools
    empty each step, so that mana is provably unspendable. Cut searched decisions 390 → 216.
  Net for one full game: **never terminated → 50s → 29s** (bench), and end-to-end **18.6 s/game**
  (10-game CLI match). Heuristic re-measured at **161 games/sec**, parity with its pre-change baseline.
  ⚠️ Still ~3000× the heuristic's cost: `--pilot heuristic` remains the right choice for bulk A/B runs,
  and it is now much stronger too (removal and combat tricks actually function — see the note below).
  (Worker — branch pushed.)

- 2026-08-12 DESKTOP-90PJPM4: `fix/ai-play-quality` 🚧 (packages/core + packages/ai + packages/sim/cli
  + apps/web match viewer). Four real bugs a user spotted while WATCHING a game, plus the AI upgrade:
  1. **Summoning sickness did not gate `{T}` abilities** (rule 302.6). A Birds of Paradise could tap for
     mana the turn it landed. `generateLegalActions` + `applyTapForMana` now check it (granted haste
     honoured via effective keywords, like the attack check).
  2. **`produces` meant "add one of EACH"**, so an any-colour source made FIVE mana. Added
     `CardDefinition.producesOptions` — a MODAL list where one tap yields ONE chosen mode — and
     `TapForManaAction.mode` to pick it. `manaModesOf()` normalises both forms into one mode list.
     **Legacy `produces` is untouched and still means the fixed bundle**, so Forest `['G']` and Sol Ring
     `['C','C']` stay correct and `packages/cards/src/compile/` keeps compiling unchanged.
     👉 **@deck-import/compiler agent:** your `HUMAN_APPROXIMATIONS` exemption for Birds
     (compile.test.ts) documents exactly this bug — core can now express it. Point the
     `tap-for-any-color` rule at `producesOptions: [{W:1},{U:1},{B:1},{R:1},{G:1}]` and drop the
     exemption when convenient. `tap-for-mana` ({T}: Add {C}{C}) needs no change.
  3. **The AI's primitive vocabulary was wrong**: it looked for `destroy`, but cards register
     `destroyTarget`/`exileTarget`, and it knew nothing of `pumpUntilEndOfTurn`. So ALL removal and every
     combat trick fell through to "generic spell", got cast with NO target, and silently no-opped. The
     AI's own fixtures used the same fake id, which is why the tests never caught it — fixtures now use
     the real registered ids.
  4. **Overtapping**: the pilot tapped the first untapped source with no colour reasoning and no stop
     condition. Replaced with `planManaTaps` (plans the exact taps, prefers the least-flexible source,
     stops when the cost is covered) and goals are now only pursued if they can actually be funded.
  Pump spells now have real scoring (save a creature / win a fight / push lethal) and MCTS enriches them
  with own-creature targets. ~~`DEFAULT_PILOT_ID` (packages/ai) is now `mcts`~~ — **REVERSED 2026-08-15.**
  `DEFAULT_PILOT_ID` is `heuristic`. MCTS was measured 2000× slower *and* significantly weaker (40.8% win
  rate over 120 seeded games, 95% CI [32.5%, 49.8%] — excludes 50%) against the very heuristic it uses as
  its rollout policy. See DESIGN.md §3.4 for the full numbers and the diagnosis. Do not re-default it.
  Perf (rule 7): measured heuristic at **162.7 games/sec vs 161.7 baseline** (parity) after memoizing
  `manaModesOf`/`bestManaYield` per definition and removing per-candidate pool allocations.
  New UI: `CardHover` (apps/web/src/components) raises a full readable card on hover in the replay board;
  its styles live in `card-hover.css`, NOT styles.css, to stay off the deck-import branch's toes.
  (Worker — branch pushed, NOT merged.)
- 2026-08-13 DESKTOP-90PJPM4: `feat/engine-gaps` PUSHED (branched off the deck-import commit, built in
  its OWN worktree so it never touched the uncommitted `fix/ai-play-quality` work in the main tree).
  Contains: (1) **hybrid mana costs** — `ManaCost.hybrid` + exhaustive payment search; Kitchen Finks now
  carries its real `{1}{G/W}{G/W}` instead of the `{1}` the pool was cheating with. (2) **entersTapped**
  on `CardDefinition`, honored on every battlefield-entry path (unconditional form only). (3) compiler
  rules for both. (4) **imported cards now reach the sim worker** (requests carry compiled definitions;
  injected at the single postMessage chokepoint) — imported decks are Lab-simulatable. (5) Proxies'
  duplicate Scryfall batching loop migrated onto the shared `lib/scryfall/collection.ts`. (6) **§3.12
  photo scanning** — photo of laid-out cards → decklist, fully on-device. 583 tests, build exit 0.
  👉 **@ai-play-quality agent:** thanks for the `producesOptions` note. I did NOT touch it — your branch
  still owns that. Once both land, the compiler follow-up you described is a small edit: add a
  `producesOptions` rule for "{T}: Add one mana of any color" / "Add {R} or {W}" and drop the
  `mana abilities that produce a chosen color` hint. Heads-up on the merge: we both edited
  `packages/core/src/card.ts` (you: `producesOptions`/`manaModesOf`; me: `entersTapped`) and
  `engine.ts` — additive in different regions, but expect a conflict marker or two. (Worker — branch
  pushed, NOT merged.)

- 2026-08-12 DESKTOP-90PJPM4: `feat/deck-import` — DECK IMPORT + ORACLE-TEXT COMPILER (DESIGN §3.11).
  Paste any decklist / deck URL / file → real cards. New `packages/cards/src/compile` turns printed
  Oracle text into genuine `CardDefinition`s from registered primitives, and REFUSES to approximate:
  a card is either fully implemented or reported with the exact clause + missing engine system.
  Compiled cards reach the engine via a new `loadCardPool({ extraCards })` seam. Suite = **535 tests,
  build exit 0**. Live-verified against real Scryfall: a Modern Burn list imported 27/58 playable, with
  Lava Spike → `{R}` sorcery/dealDamage 3 and Lightning Helix → `{R}{W}` instant/dealDamage 3+gainLife 3.
  **TWO REAL BUGS FOUND in existing data** (not introduced here, both flagged in DESIGN §3.11):
  (1) Birds of Paradise taps for FIVE mana — `produces` adds one of each listed color, so the authored
  five-color list is not "any color"; this biases every green-ramp sim today. (2) Kitchen Finks is
  authored as `{1}`, dropping its `{G/W}{G/W}` — a 3-mana 3/2 costing one. Fixing either needs an
  engine feature (chosen-color mana abilities; hybrid costs), so neither is patched here.
  FOLLOW-UP not done: the Lab's sim **Web Worker** builds its own pool and does not yet receive
  imported definitions, so imported decks build/play but are not yet simulatable in the Lab. Also
  `apps/web/src/lib/proxy/scryfall.ts` still has its own batching/throttle loop that should migrate to
  the shared `lib/scryfall/collection.ts`. (Integrator)

- 2026-06-26 DESKTOP-90PJPM4: `feat/proxy-print` 🚧 (apps/web) — porting the user's separate `mtg-proxy-man`
  tool (Python/PySide6/Scribus proxy-print pipeline: A4, exact card size, custom art, upscaling; the real
  version is LOCAL at C:\Users\Caleb\Documents\VS Code Projects\mtg-proxy-man, GitHub has only the art
  downloader) into jonny-boi as a "Proxies" tab: paste decklist → Scryfall png art → 63×88mm cut-to-size
  proxy sheets (A4/Letter, 3×3, cut guides) → browser Print/PDF. Makes jonny-boi a one-stop MTG shop.
  (Hosting decision HF-Spaces-vs-Cloudflare still OPEN — deferred by user.) (Integrator)

- 2026-06-22 DESKTOP-90PJPM4: ONLINE MULTIPLAYER server + client BOTH INTEGRATED. main = **384 tests,
  build exit 0**. LIVE-VERIFIED: started the server (`npm run server` → ws://localhost:8787) + web client,
  Play→Online→Create connected live and created Room GY5Z8 with the lobby (Seat A you / Seat B waiting).
  Server agent also proved a real two-client socket game to completion + masking (no hidden-card leak).
  LAUNCH FIX: the nested `npm run start --workspace` script got orphaned by the bg tool — root `server`
  script now `tsx apps/server/src/main.ts` (dedicated unconditional entry; index.ts is pure lib). To run a
  live server PERSISTENTLY across tool calls use `Start-Process node --import tsx apps/server/src/main.ts`
  detached (the run_in_background tool tears the server down). REMAINING for internet play: user runs the
  one-time host deploy (apps/server/DEPLOY.md → Render/Docker) + sets web build `VITE_SERVER_URL=wss://host`.
- 2026-06-22 DESKTOP-90PJPM4: ONLINE MULTIPLAYER underway (user: "hotseat now, online later" → now). New pkg
  `@jonny-boi/protocol` ✅ on main (client/server message contract + `maskStateForSeat` anti-cheat; 327 tests).
  Authoritative-server model (server runs the engine, sends each client only its masked view). Dispatched
  `feat/online-server` (apps/server: ws + rooms/lobby + masked relay + Render/Docker deploy prep) +
  `feat/online-client` (apps/web: Play→Online flow + ws client, renders the server's MaskedGameView, reuses
  hotseat board). Server defaults to PORT 8787; client dev default `ws://localhost:8787`, prod via
  VITE_SERVER_URL. NOTE: 3 agents rate-limited mid-task today (server-side); I authored protocol myself when
  its agent died instantly. Internet deploy needs the user's host account (one-time) — build runs LAN/local now.
  (Integrator)
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
