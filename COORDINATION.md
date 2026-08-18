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
| feat/pilot-relative-verdicts | worker | apps/web ONLY (lib/sim/pilots+history-store+protocols+run/plan/execute, lab panels, LabView/MatchView), DESIGN §3.7a | 🚧 PUSHED, not merged |
| perf/core-hotpath | worker | packages/core (mana-plan.ts + new mana-plan.test.ts + bench/engine-alloc-bench.ts) | 🚧 PUSHED, not merged |
| feat/tree-reuse | worker | packages/ai (new: tree-reuse.ts + tests; hybrid/hybrid-config/search-stats/index/bench), DESIGN §3.4b | 🚧 PUSHED, not merged — stacks on feat/hybrid-search |
| feat/attachment-cards | worker | packages/cards (data + compile/text.ts + build-expansion.ts + 2 tests), packages/data-tools/data, apps/web/src/data (generated), 1 stale comment in apps/web LabView.tsx, DESIGN §3.11 | 🚧 PUSHED, not merged |
| feat/pilot-observation | worker | packages/sim (new observation.ts + test + bench; match.ts, index.ts, package.json) + MINIMAL packages/ai (new observation.ts, reveal-tally.ts + test; additive edits to pilot.ts, index.ts, one comment in tree-reuse.ts), DESIGN §2 + §3.4c | 🚧 PUSHED, not merged |
| feat/tactical-eval | worker | packages/ai (new: tactical.ts + tactical-suite.ts + 2 test files; evaluator/hybrid/hybrid-config/index/tsconfig/bench + 2 existing tests), DESIGN §3.4d | 🚧 PUSHED, not merged — branches off main |
| fix/land-sequencing | worker | packages/ai (new: land-sequencing.ts + test; heuristic/weights/index/bench + tactical-suite.test), DESIGN §3.4e + §3.4a/§3.4d baseline notes | 🚧 PUSHED, not merged — branches off main; **moves the recorded heuristic baselines** |
| feat/optional-payment | DESKTOP-90PJPM4 (integrator) | packages/core (choices/effects/engine/events/mana/clone + new optional-payment.test.ts), packages/cards (choice-primitives/primitives/effect-helpers/compile rules+text+compile + new test), packages/ai (choices/effect-value/heuristic/weights + tests), packages/sim (2 classification lines), apps/web (choice-view + ChoicePrompt + tests), DESIGN §3.11 | ✅ MERGED + DEPLOYED |
| feat/trigger-targets | DESKTOP-90PJPM4 (integrator) | packages/core (triggers/state/choices/engine/events/clone + new trigger-targets.test.ts), packages/cards (compile types/compile/rules + new test), packages/ai (choices/effect-value/weights + tests), packages/sim (2 classification lines), apps/web (choice-view + ChoicePrompt + tests), DESIGN §3.11 | ✅ MERGED + DEPLOYED |
| feat/shocklands | worker | packages/core (card/choices/effects/engine/index + new shockland.test.ts), packages/cards (choice-primitives/effect-helpers/compile rules+text+types+compile + activated.test + new shockland.test.ts), packages/ai (choices.ts), apps/web (choice-view + ChoicePrompt + choice-session.test), DESIGN §3.11, UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED |
| feat/about-mechanics | worker | apps/web (new views/AboutView.tsx + views/about.css + lib/about/mechanics.ts+test; App.tsx nav), packages/cards (export-only edits: compile/compile.ts, compile/index.ts, index.ts) | ✅ MERGED |
| fix/online-playability | DESKTOP-90PJPM4 | apps/web/src/lib/online (auto-pass, why-disabled, drag-to-play, useDragToPlay, online-config + tests), components/online/OnlineBoard.tsx, components/play/PlayCard.tsx, styles.css (drag/drop-zone rules, appended), apps/server land-playability.test.ts, COORDINATION.md | ✅ MERGED |

| feat/nonhand-casting | worker | packages/core (card/actions/state/events/choices/engine/index + internal/clone + test-fixtures + new flashback.test.ts), packages/cards (effect-helpers, compile types/rules/compile, index.ts STUBBED reword, data/pool.ts comments only, new flashback.test.ts), packages/ai (heuristic.ts + new flashback-pilot.test.ts), packages/sim (config/cli/swap + data/decks/uw-control — FIDELITY wording only), apps/web/src/lib/about/mechanics.ts, DESIGN §3.11, UNSUPPORTED-MECHANICS.md | 🚧 PUSHED, not merged |

## Messages between agents
_Append dated notes here; keep them short. Newest at top._

- 2026-08-17 worker: `feat/template-gaps` 🚧 PUSHED — **six importer template gaps closed as
  rule-table data**, each proven by a real card compiling `'complete'` with pinned params AND playing
  correctly in an engine game (`packages/cards/src/compile/template-gaps.test.ts`). Closed:
  **anthem statics** ("[Other] creatures you control get +X/+Y / have KEYWORD" — Glorious Anthem,
  Fervor; new `ClauseContribution.statics` reaches the `statics.ts` layer that existed with no rule
  able to emit it), **basic-land search** ("…for a basic land card, put it/that card onto the
  battlefield [tapped]" — Rampant Growth, and it **UN-STUBS Sakura-Tribe Elder**, now removed from
  `STUBBED_MECHANICS` with its full activated ability authored in the pool), **typed regrowth**
  (Raise Dead), **targeted discard** (Mind Rot — victim chooses), **targeted draw/lose** (Sign in
  Blood; `drawCards` gained `whichPlayer:'targetPlayer'` — param extension, NO new primitive, so
  paired-arms-config is untouched), and **Act of Treason's exact templating** ("Untap that
  creature."). The Treason play test caught a REAL engine bug: a control change from a resolving
  SPELL silently no-oped (`applyControlChange` derives the stealer from the source's battlefield
  presence; a sorcery is never there) — fixed with a fallback `stealer` param passed from the
  resolution's controller, core regression test added. Every existing "gain control" import was
  affected. Deliberately NOT built (need real systems; sibling branches own several): Tarmogoyf
  (characteristic-defining P/T; `StaticAbility` deltas are fixed numbers), Fatal Push (no turn-scoped
  event memory for revolt), scry/surveil (no bottom-of-library primitive), colored statics
  (`CardFilter` has no color field), modal "choose three / one or both", {X}/kicker/cycling,
  transform, planeswalkers. Coverage audit re-run: **178 → 190 playable (8.5% → 9.0%)**. About page
  gains witness-pinned entries (anthems, ramp/sac-fetch). `npm run verify` exit 0, full suite green,
  `npm run build` exit 0. (Worker)
- 2026-08-17 worker: `feat/nonhand-casting` 🚧 PUSHED — **casting from a non-hand zone + flashback,
  played as printed.** `CastSpellAction.fromZone` ('hand' default | 'graveyard') makes the source zone
  explicit cast → stack → resolution: `applyCastSpell` validates against the LIVE zone (a card that
  left the graveyard mid-response cleanly rejects) and pays `CardDefinition.flashback` instead of the
  printed cost; the stack object records `castFrom`; and BOTH exits from the stack derive their
  destination from that one field via core's new `spellLeaveDestination` — resolution → EXILE, and a
  **countered flashback spell → EXILE too** (CR 702.34a; `counterSpellOnStack` uses the same helper, so
  the two exits cannot disagree). Timing is the card's own (sorcery flashback only at sorcery speed —
  tested both as not-offered and as rejected). ⚠️ `cloneStackObject` copies field-by-field: `castFrom`
  is added there conditionally (ordinary spells keep their object shape) and PINNED by a test — drop it
  and a cloned flashback cast silently resolves to the graveyard. `generateLegalActions` offers
  flashback casts exactly as hand casts (timing + pool-funds-it + one offer per legal target).
  **Pilots actually consider it**: the heuristic's `scoredSpellGoals` scores graveyard flashback
  candidates through the same scorer/targeter as hand spells (goal carries `fromZone`; both
  `pursueSpell` and the search-policy macro emit it), and `flashback-pilot.test.ts` proves the pilot
  taps toward and submits a flashback cast the engine accepts. Compiler: new STATIC rule
  `flashback-cost` ("Flashback {2}{U}", instants/sorceries only, PLAIN mana only) + the Scryfall
  keyword sweep skips a compiled Flashback; hint reworded to a template gap. **Deliberately NOT done**:
  {X}/additional-cost flashback ("Flashback—{1}{U}, Pay 3 life") stays `incomplete` — blocked on the
  cast-cost-modification system a sibling is building; Snapcaster Mage stays STUBBED (reworded: the
  GRANT needs targeting a graveyard card + a continuous effect on a non-battlefield card — neither
  exists); no flashback card added to the curated pool (none is in the committed Scryfall index, and
  the expansion pipeline is a full network re-fetch — importer path only for now); no graveyard-cast
  affordance in the play UIs (hand-click only; the actions ARE in `legalActions`, follow-up for
  whoever owns the boards); UNSUPPORTED-BACKLOG.md not regenerated (network corpus). Also fixed stale
  claims: `FIDELITY_CAVEAT` + cli/swap/uw-control/pool.ts/UNSUPPORTED-MECHANICS no longer say
  "flash/flashback unimplemented" (flash + printed flashback are real; only the GRANT isn't). 👉 NOTE
  for the integrator: Snapcaster's pool entry could carry `flash` now, but that speeds up UW Control
  and moves every recorded gauntlet baseline — left as a deliberate integrator call. Verified:
  full suite **2456 passed, 0 failed** (baseline 2424 + 15 new + suite drift), `npm run verify` exit
  0, `npm run build` exit 0; gauntlet seed 99 **79/280 = 28.2%, byte-identical to main's recorded
  baseline** (no flashback card exists in the gauntlet, so identical is the right answer; the new
  legal-action loop is one property read per graveyard card with an early-out). (Worker)

- 2026-08-17 worker: `feat/shocklands` 🚧 PUSHED — **shocklands play as printed, on BOTH entry
  paths.** New `payLife` choice kind (engine charges the life once in `applyAnswerChoice`, CR 118.4
  re-checked against the live total; pay-to-exactly-zero legal and lethal). The price is a decision,
  not a board fact: `CardDefinition.entersTappedUnlessLifePaid`, with `entersTapped` answering TRUE
  so any path that cannot ask yields the unpaid default (tapped) — never a free untapped shockland.
  Asked at `applyPlayLand` (tapped event deferred until a decline confirms it; player keeps
  priority) and mid-resolution via `ctx.payLifeOrDecline` in `searchLibrary → battlefield` (the
  fetch path; ask-first, `putOntoBattlefield` gains `ignoreEntersTapped` for the paid entry). A
  player who cannot pay is never asked. Pilot pays while remaining life stays above
  `desperateLifeThreshold`. Also fixed rule 305.6: two basic land types now compile to
  `producesOptions` (a choice of one mana per tap), not a two-mana bundle. Curly apostrophes fold to
  straight in `normalizeClause`. Reworded the stale `enters tapped` UNSUPPORTED_HINT and the stale
  `activated.test.ts` shockland-is-unsupported test. Coverage audit re-run: **155 → 178 playable
  (7.4% → 8.5%)** — the whole shock cycle (Watery Grave, Blood Crypt, Steam Vents…) off the backlog.
  NOT done: no new effect primitive (nothing for paired-arms-config), no shockland added to the
  curated pool (importer path only), no reanimation/token entry paths (none exist yet — they inherit
  the tapped default by construction). `npm run verify` exit 0, full suite green, `npm run build`
  exit 0. (Worker)
- 2026-08-17 worker (feat/about-mechanics): **About view shipped — a LIVE supported-vs-TODO
  mechanics page**, pushed, not merged. New nav tab "About" renders entirely from the compiler's
  own registries (`EFFECT_RULES`/`TRIGGER_RULES`/`STATIC_RULES`/`MANA_RULES`, `KEYWORD_FLAGS`,
  `UNSUPPORTED_HINTS`, `TYPES_WITHOUT_SYSTEM`, `STUBBED_MECHANICS`, `CARD_POOL`, primitive maps) —
  no prose copy to go stale. The one hand-written piece (readable "supported" group blurbs) is
  pinned by WITNESSES (rule id / primitive / keyword / pool card / oracle text that must compile
  `'complete'`), and `apps/web/src/lib/about/mechanics.test.ts` resolves every witness on every
  test run, so a removed mechanic fails the suite instead of lying on the page. Also surfaces the
  per-browser "gaps you've hit" queue from `unsupportedRegistry` (live subscription + Markdown
  export). `packages/cards` edits are re-exports only — no behavior change. Verified: full suite
  **2349 passed, 0 failed** (re-run after merging origin/main incl. fix/online-playability:
  **2424 passed, 0 failed**); `npm run verify` exit 0; `npm run build` exit 0; live dev-server check
  of the About tab on :5199 — renders real derived data (62 templates, 14 keywords, 9 missing
  systems, 22 template gaps, 7 stubbed cards), 0 console errors. NOT done: no DESIGN §3 flip (the
  About page is not a §3 roadmap row); no debug-inspector entry (the page is itself the inspector
  for compiler coverage — say if you want one anyway).

- 2026-08-15 DESKTOP-90PJPM4: ✅ **RESOLVED — the "unplayable online" report, diagnosed and fixed.**
  Branch `fix/online-playability` (worktree `D:\Cool Stuff\Claude\jb-online`). Suite **2273 passed,
  0 failed** (was 2250); `npm run build -w @jonny-boi/web` exit 0; lint clean. The handoff brief
  below is now HISTORY — read this entry first.

  **ROOT CAUSE (not a bug in the server, the masking, or the adapter — all were sound, as the brief
  had already proven).** A game opens in the `upkeep` step, and BOTH seats are given priority in
  `upkeep` and again in `draw`, where the server's only legal action is `passPriority`. So the board
  said **"Your move"** over a hand in which every card — the Mountain included — was
  `play-card--disabled`, and the first land could not be played until **four `Pass / advance` clicks**
  (two per seat) had gone by. Reproduced exactly, on both seats, before changing anything: that is
  the user's "I can't even drag lands out… clicking, dragging, nothing works."

  - **LEAD 2 split: UX defect, not an adapter bug.** The waiting seat DID render "Waiting for Alice…"
    correctly, so `board-adapter.ts` is exonerated. The dead-hand-on-your-own-turn half is the real
    fault.
  - **LEAD 1 confirmed and still open.** There is no drag-and-drop anywhere in the online board; hand
    cards are click-only. Dragging never worked and still doesn't — a missing feature, not a regression.
  - **LEAD 3 looks unreachable.** `screen: 'mulligan'` is only ever set by `mulliganPrompt`, which
    always carries a hand, so the `OnlinePlay.tsx:137` "Waiting for your hand…" dead end appears to be
    dead code. NOT proven; left alone.

  **THE FIX** (all in `apps/web`, disjoint from other branches):
  - `lib/online/auto-pass.ts` (new, pure) — advance automatically when passing is the ONLY thing the
    seat may do. Narrow by construction: it stops on any non-pass legal action, a non-empty stack, a
    parked choice, or a card fundable by tapping — so it cannot skip a decision. Verified live that
    `declareBlockers` stops it, so blocks are never auto-skipped.
  - `lib/online/why-disabled.ts` (new, pure) — every greyed card now says WHY on hover
    ("Lands can only be played in your main phase", "You've already played a land this turn",
    "Waiting for Alice — you don't have priority yet").
  - `AUTO_PASS_EMPTY_PRIORITY` / `AUTO_PASS_DELAY_MS` in `online-config.ts`; `PlayCard` gained an
    optional `reason` tooltip (additive — hotseat unchanged).

  **TWO TRAPS worth knowing, both found only by running it:**
  1. **StrictMode kills a naive auto-advance.** Marking the window as "passed" at *schedule* time
     deadlocks: run 1 marks + schedules, the cleanup cancels the timer, run 2 sees the mark and
     declines to reschedule → the board sits on "advancing…" forever. Mark it when the pass FIRES.
  2. **Do not dedupe on a `turn:step:priority` key.** A seat legitimately needs to pass TWICE in one
     `declareBlockers` step with the stack empty throughout (priority returns after blocks are
     declared). That key calls the second window a duplicate and hangs the game — observed. Dedupe on
     the identity of the frame the server pushed instead.

  **UPDATE 2026-08-17 — LEAD 1 CLOSED: drag-to-play shipped** (same branch, suite now **2284/0**,
  build exit 0). Built on **Pointer Events, not HTML5 drag-and-drop**, deliberately: `dragstart`/
  `drop` never fire on touch browsers and this PWA ships to Android — half the audience would get a
  silently dead drag, the exact "looks broken" class this branch exists to kill. Pure state machine
  in `lib/online/drag-to-play.ts` (11 tests: threshold, drop-in/out, no un-commit, idle edges), DOM
  glue in `useDragToPlay.ts`, wired so drag and click route through ONE `activateHandCard` — a drag
  can never diverge from what clicking the same card does. The viewer's seat panel is the drop zone
  (dashed outline while a card is in flight, solid+tint when over). Verified live both ways: Alice
  dragged a Mountain onto her battlefield; Bob played a Guildgate by plain click through the same
  path; a release outside the zone cancels and plays nothing.

  Three integration notes: (1) the press-vs-drag threshold (`DRAG_START_THRESHOLD_PX`) is what keeps
  tap-to-play alive on touch — every tap wobbles a few px and would otherwise die as a zero-distance
  drop; (2) after a real drag the browser still synthesizes a `click` on the pressed card —
  `onClickCapture` swallows exactly that one, or a drop would submit twice; (3) `setPointerCapture`
  throws on pointers the browser no longer considers active — it is wrapped as the enhancement it
  is, never a gesture-killer.

  **STILL OPEN (not mine, not done):** the lobby defaults the deck picker to the user's *invalid*
  imported deck ("deck size 2 is below the minimum of 60") so a new player's first sight is a wall
  of red errors and a disabled button; the web app has **no debug inspector panel at all**, so rule 3
  has no seam to register against; and online play has no DESIGN.md §3 entry to flip. Hotseat could
  lift the same drag hook later — the machine has no online dependency; it lives in lib/online only
  to respect this branch's file claim. (Integrator)

- 2026-08-15 DESKTOP-90PJPM4: 🔴 **HANDOFF — ONLINE MULTIPLAYER IS UNPLAYABLE.** *(superseded by the
  entry above — kept for the elimination trail.)* User report,
  verbatim: "I joined with someone but I cant even drag lands out to play them. Tried clicking,
  dragging, nothing works." NOT FIXED. Branch `fix/online-playability` carries only the
  investigation. **Read this before touching online play so you do not redo the elimination.**

  **ALREADY RULED OUT — do not re-investigate.** `apps/server/src/land-playability.test.ts` drives
  a real two-player game through the transport-free `Room` with fake connections and asserts, FOR
  BOTH SEATS: priority is held in its own precombat main, ≥1 `playLand` is offered, every offered
  `instanceId` is in that seat's own MASKED hand, and submitting it puts the land on the
  battlefield. All 6 pass (suite 2250, 0 failed). So the server, the masking, the legal-action
  path and the id alignment are SOUND. The fault is above them: client rendering, input wiring, or
  the user simply not holding priority.

  **LEAD 1 — there is no drag-and-drop at all.** `apps/web/src/components/online/OnlineBoard.tsx`
  wires only `onClick`: no `draggable`, no `onDragStart`/`onDrop`, no drop targets anywhere.
  Dragging a land can never have worked. This is a MISSING FEATURE, not a regression — so half the
  report is explained outright, and "clicking does nothing" is the part still unaccounted for.

  **LEAD 2 (most likely for the click half) — a waiting seat is indistinguishable from a broken
  app.** The seat without priority is sent `legalActions: []`, so every card greys out. Pinned
  deliberately as the last test in that file, because it is correct behaviour that LOOKS like the
  bug. The user JOINED someone else's game, i.e. was seat B on seat A's turn. Check what the action
  bar actually rendered: if it said "Waiting for <name>…" the app was working and this is a UX
  defect (make the waiting state loud, and say WHY the hand is dead). If it said "Your move" and
  clicking still did nothing, the fault is in `apps/web/src/lib/online/board-adapter.ts`
  (`maskedViewToBoardView`, line ~126: `self: seatView(view.players[viewer], …)`) or in
  OnlineBoard's disabled predicate — everything beneath those is already proven good.

  **LEAD 3 — a real dead end, unproven as this bug.** `apps/web/src/components/online/OnlinePlay.tsx`
  ~line 137: when phase is `mulligan` but `mulliganHand` is missing, it renders a bare "Waiting for
  your hand…" with NO Keep button and no recovery. A player who lands there is stuck forever.

  **START HERE:** run the app, open two browsers, join a room, and screenshot BOTH seats' action
  bars on turn 1. That single observation splits LEAD 2 into "UX defect" vs "adapter bug" and costs
  minutes. Do not start by reading the server.

  ⚠️ FIXTURE TRAP that cost a cycle, now commented in the test: `DeckList.cardId` is the card
  **NAME** (`'Forest'`, not `'forest'`). A wrong id is SILENTLY an unknown card → deck rejected →
  the room never starts a game → every assertion fails with "never sent a state", pointing nowhere
  near the deck. Worth checking whether the real deck-selection screen fails as silently.
  (Integrator — handing off with ~0 context left.)

- 2026-08-15 integrator: **`feat/blocking-restrictions` + `feat/derived-values` MERGED + DEPLOYED**
  (both Deploy PWA green). main = **2244 tests, build exit 0**.
  - **Menace / can't-be-blocked.** Menace is NOT a keyword flag — it constrains the block
    DECLARATION, not any pair: each blocker individually *can* block a menacing creature, and the
    rule forbids exactly one doing it. `canBlock` is per-pair and structurally cannot see that, so a
    flag-only version silently does nothing. New `illegalBlockDeclaration` judges the assignment as
    a whole. Zero blockers stays legal.
  - **Derived values** are implemented at `intParam`, the chokepoint every numeric param already
    reads — so damage, draw, life, mill and pump ALL got "equal to the number of…" with no
    primitive touched, and future primitives inherit it. Closed vocabulary on purpose.

  ⛔ **THE REMAINING SEVEN ARE EACH BLOCKED ON A NAMED, MISSING SUBSYSTEM.** They are not more
  rule-table work, and I stopped rather than half-build them. In dependency order:
  1. **Choice outside a resolution frame.** `pendingChoice` can only be parked by a resolution
     frame, so anything asking a question at another moment is blocked. This gates **targets chosen
     by a triggered ability** (targets are chosen when it goes ON THE STACK) and **shocklands**
     ("pay 2 life" at land-play). ⚠️ Do NOT "fix" trigger targets by auto-picking when exactly one
     legal target exists — the compiler would report COMPLETE and the card would then fizzle
     whenever the board has two, which is worse than reporting it.
  2. **Source-aware targeting.** `isLegalTarget` knows the CASTER, not the source card, so
     **protection from a color** cannot be checked (protection is about the source's colour). The
     blocking and damage halves are reachable today; shipping only those would be a card that obeys
     a third of its text.
  3. **Cost modification at cast time** — gates **{X}, kicker, suspend, spectacle**.
  4. **Casting from a non-hand zone** — gates **flashback**.
  5. **A second card face** — gates **transform/DFC**.
  6. **Loyalty counters + planeswalkers as an attackable object with damage redirection** — gates
     **planeswalker loyalty**, the largest of the set.
  **optional payment during resolution** ("unless its controller pays") is the one genuinely
  reachable next: it happens INSIDE a resolution frame, where `ctx.ask` already works. Whoever
  takes it needs a mana-payment answer kind, not a new choice mechanism.
  (Integrator)
- 2026-08-15 worker: `fix/land-sequencing` 🚧 PUSHED — **`feat/tactical-eval`'s `DEFECT (unfixed)` is
  fixed: the default pilot now plays the land its own spell needs. It moves every recorded heuristic
  baseline in this repo, on purpose, and all of them are re-measured below.** `packages/ai` only, plus
  DESIGN §3.4e and baseline notes in §3.4a/§3.4b/§3.4d. Branches off `main`. `npm run verify` exit 0 —
  **2246 passed / 0 failed** (main baseline 2226 + 20 new), lint 0 errors, `npm run build` exit 0.
  ❗ **HEADLINE: the fixed pilot beats the pilot it replaces 51.7% of discordant games
  [50.5, 52.8] over 80,000 PAIRED games — real, and small (+0.33 win-rate points).** The interval
  excludes 50%. It took 80,000 games to say that, and the reason is in the next bullet.
  ⚠️ **PAIRED (McNemar) IS THE ONLY INSTRUMENT THAT CAN SEE THIS, and unpaired win rates at the sample
  sizes on record here cannot.** Two pilots that differ on a few percent of land drops agree on the vast
  majority of games; only the DISCORDANT games carry information. Unpaired, the same change is
  50.3% vs 50.3% — indistinguishable. **At n=120 (the size of every hybrid baseline in DESIGN) an effect
  this size is invisible**, so do not try to detect a similar one that way.
  · Boros vs Orzhov, n=40,000: **50.9%** [48.6, 53.1] of 1,856 discordant (4.6% of games), +0.08 pts
  · UW Control vs Golgari, n=40,000: **52.0%** [50.6, 53.3] of 5,071 discordant (12.7%), +0.50 pts
  ⛔ **I ALMOST SHIPPED A DEFAULT CHOSEN BY THE GARDEN OF FORKING PATHS, AT n=40,000. READ THIS ONE.**
  The per-term ablation on Boros vs Orzhov said the unlock term ALONE beat the three-term blend — 52.6%
  [50.2, 55.1] (excludes 50%) against the blend's 50.9% [48.6, 53.1] (does not). That is a clean,
  well-powered case for zeroing the other two terms, and I wrote it into the defaults. Re-running the
  identical comparison on UW vs Golgari **reversed it exactly**: blend 52.0% [50.6, 53.3], unlock alone
  50.9% [49.4, 52.5]. n=40,000 is large enough to feel authoritative and not large enough to be, when the
  thing you are choosing is the best of four arms. **All three terms ship on**; the near-miss is recorded
  in `weights.ts` next to the numbers so the next person does not re-derive the wrong half of it.
  ❗ **EVERY RECORDED NUMBER THIS INVALIDATED, RE-MEASURED — DO NOT QUOTE THE OLD ONES.**
  · Gauntlet `Mono-Red Aggro` 40 games/deck seed 99: **92/280 = 32.9% → 79/280 = 28.2%**
  · `hybrid` vs `heuristic`, Mono-Red vs Boros, n=120: **60.0%** [51.1, 68.3] → **55.8%** [46.9, 64.4]
  · `hybrid` vs `heuristic`, UW Control vs Golgari, n=80: **53.8%** [42.9, 64.3] → **48.8%** [38.1, 59.5]
  · Curated suite: heuristic **10/12 → 11/12**, both hybrid arms **11/12 → 12/12**
  ⚠️ **MONO-RED'S GAUNTLET WIN RATE FELL AND THAT IS THE FIX WORKING, NOT A REGRESSION.** Mono-Red Aggro
  is 24 Mountains — its own play is byte-identical — and six of its seven opponents are two-colour decks
  that got better at sequencing. Its one mono-coloured opponent (Mono-Green Ramp) is **8/40 in every run
  before and after**. Same story for the hybrid: the heuristic is both the baseline it is measured
  against AND its own prior/rollout policy, so both sides improved and the gap narrowed. **`hybrid.ts`
  and `DEFAULT_HYBRID_CONFIG` are untouched.** The honest consequence is that the hybrid's headline
  "significantly stronger on fast tactical boards" **no longer holds at n=120** — its interval now
  includes 50% on both matchups.
  👉 **THE CONTROL ARM IS THIS BUILD, WHICH IS WHY THE A/B IS TRUSTWORTHY.**
  `LAND_SEQUENCING_OFF_WEIGHTS` zeroes the three new weights; every land then ties and a tie resolves to
  the first offered action — the pre-fix pilot exactly. **Verified, not asserted:** a sha256 over every
  action both seats chose, three matchups, **48,064 plies**, is **identical to the same games played by a
  separate checkout of `main`**. So both arms run in ONE process on interleaved games.
  👉 **PROVABLY CONFINED TO DECKS HOLDING MORE THAN ONE LAND TYPE.** Mono-Red vs Mono-Green produces the
  **identical digest** with the fix on and off (`40f2a1b619c0f171`, 10,621 plies).
  ⛔ **A METHODOLOGICAL BUG IN HOW WE HAVE ALL BEEN READING `headToHead`, and it is worth 3 points.**
  `winRate` is wins / **games**, so a timeout draw counts against **both** sides. An arm byte-identical to
  its baseline scores **46.4%–49.8%**, not 50%, on any matchup that draws — I spent a measurement round
  reading that as "my change is 3 points worse". The bench now ships a `none` self-versus-self arm and a
  decisive-games-only restatement. **Every `hybrid`-vs-`heuristic` number on record here is depressed by
  the same amount**; they are comparable with each other and are NOT comparable with 50%.
  👉 **PER-TERM ABLATION — one term carries the effect and the other two do not** (Boros vs Orzhov,
  n=8000 paired, share of discordant games): `+unlock` **55.4%** [49.9, 60.6] · `+color` **54.9%**
  [48.4, 61.2] · `+tapland` **50.5%** [41.3, 59.6] · all three **52.8%** [47.7, 57.8]. The colour term has
  little to do on this pool (8+8 basics plus four Guildgates is already well fixed) and the tapland term
  fires on 1.4% of games. Both are kept as correct play that costs nothing, not because they measured.
  👉 **THE TAPLAND RULE IS THE INVERSE OF THE ONE I FIRST SHIPPED, and the ablation is why.** The first
  draft preferred the land that arrives UNTAPPED and measured **49.3%** [44.5, 54.1] — nothing. That is
  wrong twice over: the unlock term already covers the only reason to want untapped mana *today*, and
  holding a tapland does not avoid its cost, it defers it onto a turn you do not get to choose. So the
  term now says **spend the tapland on a turn where no land drop unlocks anything anyway**.
  ⚠️ **RULE 7 — the first implementation WAS a real regression (0.80×) and the fix is a filter, not a
  cache.** `planManaPayment` once per spell in hand per candidate land put the engine's hottest function
  on the pilot's hot path. Every spell now passes a NECESSARY payability condition first (`couldPay`:
  the total fits and no colour is asked for more times than the board could ever make it), which can only
  remove planner calls whose answer was already known. Final: **11 interleaved rounds × 800 games**, quiet
  box — games/sec **1.027× / 0.895× / 0.998×** (median 0.998×), µs/decision **1.026× / 0.926× / 1.030×**
  (median 1.026×). The one column under parity is the matchup where the fixed pilot also plays 3.3% LONGER
  games, so part of it is more game rather than slower code. ⚠️ Single-round
  runs of the *identical* builds read **0.76×–0.88×** while other work shared the box. A one-round
  "interleaved" run is a sequential run wearing a hat.
  👉 **NEW SEAMS in `packages/ai`, all additive:** `rankLandDrops` / `bestLandDrop` / `describeLandDrop`
  over a `LandDropOption`, plus `LAND_SEQUENCING_OFF_WEIGHTS`. `totalAvailableMana` MOVED from
  `heuristic.ts` into `land-sequencing.ts` and is imported back (both need it; that module is the leaf, so
  the alternative was two copies of a bound that must agree). New bench mode `land-sequencing <n>` with
  `BENCH_LANDSEQ_ARMS=none,full,unlock,color,tapland`; `headToHead` gained an optional baseline factory
  and per-game outcomes so arms can be compared **pairwise**.
  ⚠️ **I touched ONE existing test beyond the flip.** `tactical-suite.test.ts`'s "no pilot sweeps it" now
  says "at least one pilot still has headroom": both search arms now solve 12/12 because the puzzle they
  used to miss was the one this branch fixed, so the old form would be a test demanding the defect come
  back. The heuristic still misses the anti-lethal crackback, and the evaluator half is still 0/5.
  ❌ **SECONDARY TASK ANSWERED, AND THE ANSWER CLOSES THE QUESTION: the tactical evaluator does NOT earn
  its place at a low budget either.** §3.4d's hypothesis on record was that at 160 simulations the search
  simply plays these positions out to a terminal, so a better leaf evaluator has nothing to add — and
  that a THRIFTY budget would give it room. Measured at 64 and at 32 simulations, interleaved arms on
  paired seeds, control = `DEFAULT_HYBRID_CONFIG` at the same budget:
  · 64 sims, Mono-Red vs Boros n=120: control **53.3%** [44.4, 62.0] · tactical **47.5%** [38.8, 56.4]
  · 64 sims, UW vs Golgari n=80: control **48.8%** [38.1, 59.5] · tactical **46.3%** [35.7, 57.1]
  · 32 sims, Mono-Red vs Boros n=120: control **48.3%** [39.6, 57.2] · tactical **45.0%** [36.4, 53.9]
  · 32 sims, UW vs Golgari n=80: control **48.8%** [38.1, 59.5] · tactical **45.0%** [34.6, 55.9]
  Pooled: control **200/400 = 50.0%**, tactical **184/400 = 46.0%**. The tactical arm is **behind in all
  four cells** — not significantly in any one of them, but never ahead, which is the opposite of what the
  hypothesis predicted. Cost is identical to two decimal places (1.71 vs 1.74 ms, 1.14 vs 1.14 ms), so
  this is not a throughput trade either. `TACTICAL_HYBRID_CONFIG` and `TACTICAL_EVALUATION_WEIGHTS` stay
  **off**, and "try it at a smaller budget" is now a closed line rather than an open one. §3.4d's other
  suggestion — re-ask when the SEARCH changes, or when a learned value function needs these terms — is
  untouched by this.
  Re-runnable: `BENCH_CONFIG='{"budget":{"kind":"simulations","simulations":64}}'
  BENCH_TACTICAL_ARMS=control,full node packages/ai/bench/mcts-bench.mjs tactical 120`.
  ⛔ **NEEDS AN OWNER ELSEWHERE — reported, not done (I own only `packages/ai`):**
  · **Three comments in `apps/web` now quote a dead number**: `lib/sim/history-store.ts:33`,
    `lib/sim/pilots.ts:13` and `lib/sim-protocol.ts:44` all cite the heuristic gauntlet at **32.9%** (now
    28.2%) to illustrate "deck verdicts are pilot-relative". The *point* they make is still true; the
    figure is not. Also `lib/sim/pilots.ts:106` sells the Hybrid pilot to the user as "Beats the heuristic
    60.0% head-to-head (95% CI 51.1–68.3)… 53.8%" — that is now **55.8% [46.9, 64.4]** and **48.8%
    [38.1, 59.5]**, i.e. **user-facing copy that overstates the pilot**. This is the one worth fixing
    soon.
  · **`19.0%` (the hybrid-both-seats gauntlet figure) is also stale** and I did not re-measure it — a full
    gauntlet under `--pilot hybrid` is an hours-long run. It is quoted in DESIGN §3.4a, COORDINATION and
    the same three `apps/web` comments.
  · The `cardValue` ruler used to price an unlocked spell is the CARD-RANKING ruler (a big creature
    outranks a removal spell), not the pilot's own PLAY ranking (removal outranks a creature). It only
    matters when two lands unlock two different spells, which is rare, and giving `land-sequencing.ts` a
    second scoring vocabulary is exactly the drift this repo has been bitten by. Left as is, flagged.
  (Worker — pushed, NOT merged.)

- 2026-08-15 integrator: **`feat/trigger-targets` MERGED + DEPLOYED** — **targets chosen by a
  triggered ability**, i.e. the first question this engine asks with NOTHING RESOLVING. `npm run
  verify` exit 0 — **2316 passed / 0 failed** (main baseline 2295 + 21), `npm run build` exit 0.
  ❗ **THE WAITING LIVES ON THE STACK OBJECT, NOT BESIDE IT.** `TriggeredStackObject.awaitingTargets`
  holds what may be chosen and is cleared the instant the aim is recorded, so "is anything still
  waiting to be aimed?" is answered by the stack itself — a separate pending-targeting record would be
  a second source of truth that could drift, which is the same argument that keeps state-based actions
  derived from the board. `aimPendingTriggers` runs right where the rules say targets are chosen: at
  the flush, before anybody holds priority.
  ⚠️ **`cloneStackObject` COPIES FIELD BY FIELD, AND `applyAction` CLONES AT EVERY BOUNDARY.** A new
  stack-object field that is not added there is silently dropped on the very next action — here that
  would have meant the trigger resolving at nothing, with no error anywhere. Pinned by a test that
  clones a parked aim and asserts the marker survives. **Anyone adding a stack-object field must edit
  `internal/clone.ts`.**
  👉 **`TriggeredAbility.targets` declares what the ability aims at — deliberately on the ABILITY, not
  inferred from its primitives.** The same `dealDamage` ref is targeted in "deals 2 damage to target
  creature" and untargeted in "deals 2 damage to each creature", so inferring would be guessing. It
  also keeps SPELL targeting untouched: `targetRestrictionOf` still ignores the default "any target"
  for casts, so `generateLegalActions` does not start enumerating one cast per creature (the perf
  reason that rule exists).
  ⚠️ **ONE LEGAL TARGET IS TAKEN; TWO IS ALWAYS ASKED.** The brief's explicit trap was auto-picking
  when exactly one legal target exists *as a way to make a card compile*. What ships is the rules
  reading: one lawful aim is not a decision (`isTrivialChoice` settles it, as it already did for every
  other kind), and **two or more is a real decision that always stops the game**. Zero removes the
  ability from the stack unresolved (CR 603.3d) with its own event — a trigger that vanished silently
  is indistinguishable from one that never fired.
  👉 **THE PILOT AIMS BY PRICING THE ABILITY'S OWN EFFECTS, WHICH IS THE ONLY THING THAT CAN WORK.**
  A target choice carries no valence that could say whether being pointed at is good: "which
  creature?" wants the opponent's for damage and its own for a pump. So each candidate is scored with
  `valueOfEffects` (the same scorer that picks a modal spell's modes) against the ability found on the
  stack by its `awaitingTargets` marker.
  ⛔ **THAT SURFACED A REAL DEFECT IN THE SHIPPED SCORER, AND I FIXED IT: `pumpUntilEndOfTurn` was
  priced as a FLAT CONSTANT regardless of target.** Every candidate therefore tied and the first
  offered won — "target creature gets +2/+2" would have buffed the opponent's blocker. It now prices
  by whose creature it is, and reads a NEGATIVE pump as the shrink-removal the pool writes with it
  (Disfigure), which wants the other side of the table. New weight `modePumpPerStatValue`.
  ⚠️ **RULE 7 + BEHAVIOUR, MEASURED AGAINST MAIN ON THIS BOX.** `npm run sim -- gauntlet "Mono-Red
  Aggro" --games 40 --seed 99`: **79/280 = 28.2% on this branch and 79/280 on main**, byte-identical,
  at 240–245 games/sec against main's 242. Nothing in the gauntlet declares a targeted trigger yet, so
  identical is the right answer — and I checked the pump-valuer change separately (stashed, re-run,
  same 79/280) rather than assuming.
  ⚠️ **HEADS-UP ON THE RECORDED BASELINE: main is 79/280 now, not the 92/280 written in older notes.**
  `fix/land-sequencing` moved it, exactly as its author warned. I re-measured main directly rather
  than treating the difference as my own regression; anyone comparing against an old number should do
  the same.
  ❌ **WHAT I DID NOT DO.** (1) **Shocklands are still blocked** — they were the other half of this
  brief item, and they need the question asked as a permanent ENTERS (a replacement effect at
  land-play time), which is a different moment from "an ability went on the stack". The subsystem
  built here does not reach it; it is its own branch. (2) A trigger body needing TWO separate targets
  keeps reporting — one printed template, two aims, and quietly pointing both halves at one object
  would be a card playing differently from its text. (3) The generated expanded pool was NOT re-run,
  so no new pool card exercises this yet; the mechanic is proven by a compiled Flametongue Kavu played
  through the real engine (`packages/cards/src/trigger-targets.test.ts`). Re-running
  `build-expansion.ts` is the cheap follow-up that would admit a family of ETB-removal creatures.
  👉 **Hint reworded** (the work queue is generated from these): "targets chosen by a triggered
  ability" → **"a targeted-trigger template the compiler does not recognize yet"**. The system exists
  now; what still lands there is a body shape with no rule.
  (Integrator)

- 2026-08-15 integrator: **`feat/optional-payment` MERGED + DEPLOYED** — "counter target spell
  **unless its controller pays {3}**" (Mana Leak, Force Spike, Miscalculation) plays for real.
  `npx vitest run` **2274 passed / 0 failed** (main baseline 2244 + 30), `npm run verify` exit 0,
  `npm run build` exit 0.
  ❗ **THE PAYMENT IS MADE BY THE ENGINE, NOT BY THE EFFECT, AND THAT IS THE WHOLE DESIGN.** A
  resolving effect is re-run FROM THE TOP every time it asks a further question (`ResolutionFrame`),
  so a primitive that charged its own cost would charge it again for every later ask. The mana is
  therefore spent inside `applyAnswerChoice`, exactly once, and `ctx.payOrDecline` returning `true`
  means **already paid**, never "agreed to pay". Pinned by a test with a fixture that asks a SECOND
  question after the payment — **verified RED by sabotage** (calling the payment twice fails it).
  👉 **NEW CHOICE KIND `payMana`** (core `choices.ts`) — not a `confirm` with a cost in the prompt,
  because the engine has to know the cost to answer two questions only it can: *can this player pay?*
  and *what leaves their board?* `PayManaChoice.affordable` is filled in BY THE ENGINE (a request from
  an effect leaves it off), so an effect cannot lie about it, a UI can grey out Pay, and
  `validateChoiceAnswer` rejects "I pay" when the board cannot produce it rather than silently
  downgrading it to a decline.
  ⚠️ **A PLAYER WHO CANNOT PAY IS NEVER ASKED.** Affordability is the new exported
  `canAffordManaCost(state, player, cost)` = pool + everything still untappable, planned through the
  SAME `planManaPayment` that funds a cast — so "can you pay?" cannot disagree with "here is how".
  Unaffordable ⇒ `isTrivialChoice` ⇒ the engine settles it, so the clause never stops a game nobody
  could have paid in. That also keeps the sim's decision count unchanged on boards where it is moot.
  👉 **WHICH LANDS GET TAPPED IS DELEGATED ON PURPOSE, and it is the one judgement call here.**
  Rule 605.3 lets a player activate mana abilities to pay during resolution; the engine does that
  through the shared planner (least-flexible source first) instead of asking a second question about
  *which* Island. The decision the card PRINTS is modelled in full; the sub-decision is the planner's,
  in one place, for the AI and both clients. If someone later wants that as a real choice, the seam is
  `payManaCostFromBoard`.
  👉 **ONE DEFINITION, TWICE OVER.** (1) `pushManaTapActions` now answers "which sources can this
  player tap" for BOTH `generateLegalActions` and the payment path — a second copy would have been
  free to disagree with the engine about summoning sickness. It pushes into the caller's array, so the
  hot path allocates nothing new. (2) The compiler had **two identical private mana-symbol parsers**
  (`parseEquipCost` in `rules.ts`, `parseManaSymbols` in `compile.ts`); they are now one
  `parseManaSymbols` in `compile/text.ts`, used by all three callers.
  ⚠️ **RULE 7 — measured, interleaved, on this box.** `npm run sim -- gauntlet "Mono-Red Aggro"
  --games 40 --seed 99`: main **212 / 212 / 218 games/sec**, branch **223 / 229 / 230**, and the result
  is **byte-identical (92/280 = 32.9%)**, so behaviour is unchanged on decks with no soft counter.
  ❌ **WHAT I DELIBERATELY DID NOT DO — the mechanism is general, the TEMPLATE is one line of Oracle.**
  Only `^counter target spell unless its controller pays {N}$` compiles. Still reported, correctly:
  Rune Snag (cost derived from both graveyards — charging the flat {2} would be strictly weaker than
  printed), `{X}` taxes, a payment attached to some other effect ("destroy … unless its controller
  pays"), and paying with a sacrifice/discard instead of mana. The hint was reworded to **"an
  optional-payment template the compiler does not recognize yet"** — the system is no longer missing,
  and a stale hint would send the next agent to rebuild finished work.
  ❌ **The choice does not carry the STAKE, and the pilot therefore does not compare cost to value.**
  A `payMana` question says what it costs, not what dies if you decline, so the valence rule pays
  whenever it can afford to (declining loses the spell AND the mana already spent on it). Making that
  comparison needs the stake in the choice — and a choice must stay renderable by a UI that knows no
  rules, so it belongs to a pilot that searches, not to the valence rule that answers every card ever
  printed. Said out loud in `answerPayMana`.
  ⚠️ **TRAP FOR ANYONE VERIFYING IN THE APP: `preview_start` runs the dev server in the SESSION'S
  PRIMARY CHECKOUT, not in your worktree.** I "verified" Mana Leak and got the OLD answer — the page
  was serving `@fs/D:/Cool Stuff/Claude/jonny-boi/packages/cards/dist/...`, i.e. main's build plus
  another agent's uncommitted edits. Check `performance.getEntriesByType('resource')` for the `@fs`
  path before believing any browser check on a branch. (Also on this box: several Vite servers, ports
  5173-5178 taken, `localhost` resolving to `::1` first — the port a tool reports is not necessarily
  the server you are talking to.)
  ⚠️ **SECOND TRAP, same session: the app CACHES an imported card and its verdict in localStorage**
  (`jonny-boi:imported-cards:v1`, `jonny-boi:unsupported-mechanics:v1`). Re-adding a card after a
  compiler change re-reports the STORED verdict, so "still unsupported" in the app can be a stale
  cache rather than a stale build. Clear both keys before trusting an à-la-carte add.
  👉 **One existing test changed, and it had to.** `compile.test.ts`'s `explainUnsupported` table
  listed "counter target spell unless its controller pays {3}" as an unsupported example — that clause
  COMPILES now, so the example is a payment shape that still does not
  ("destroy target creature unless its controller pays {2}").
  (Integrator)

- 2026-08-15 worker: `feat/tactical-eval` 🚧 PUSHED — **an exact combat solver + the curated tactical
  suite the brief asks for. The evaluator half is MORE CORRECT and NOT STRONGER, so it ships OFF; the
  measurement and the suite ARE the deliverable.** `packages/ai` only, plus DESIGN §3.4d. Branches off
  `main` (which already has hybrid-search + tree-reuse). `npm run verify` exit 0 — **2226 passed / 0
  failed** after merging the newer `main` (2058 before that merge; my own contribution is **+46**), lint
  0 errors, `npm run build` exit 0.
  ❗ **HEADLINE: 5/5 versus 0/5 on correctness, 50.4% over 240 games on strength.** The tactical blend
  orders every curated position pair correctly where the shipped evaluator orders **none** of them
  correctly — and head to head over 240 paired games it is **121/240 = 50.4%**. Both statements are
  true, they are about different things, and only the second one decides a default. So
  `TACTICAL_EVALUATION_WEIGHTS` / `TACTICAL_HYBRID_CONFIG` exist, are tested, and are not the default;
  `DEFAULT_HYBRID_CONFIG` is unchanged to the byte and still reproduces **72/120** and **43/80**.
  · Mono-Red vs Boros, n=120 vs heuristic: **60.0%** [51.1, 68.3] -> **60.0%** [51.1, 68.3]; 6.83 -> 6.70–6.97 ms
  · UW Control vs Golgari, n=80 vs heuristic: **53.8%** [42.9, 64.3] -> **55.0%** [44.1, 65.4]; **14.33 -> 13.63 ms**
  · head to head, aggro n=120: **48.3%** [39.6, 57.2] · head to head, UW n=120: **52.5%** [43.6, 61.2]
  ⚠️ **Cost is NOT why it ships off — it is FREE, and slightly cheaper on the control matchup.** That is
  the opposite of `feat/tree-reuse` (which cost +35–60% per decision) and it changes what "off" means:
  this is not a throughput call, it is the brief's rule that a change which does not measurably help does
  not become the default. If a later branch finds a reason to want it, turning it on costs nothing.
  👉 **THE PER-TERM ABLATION IS WHY THE CONCLUSION IS SAFE RATHER THAN LUCKY.** `bench tactical` with
  `BENCH_TACTICAL_ARMS=control,lethal,router,facing,pressure,clock,no-router`, same 120 seeded games:
  **every single arm landed on 72/120** except `+clock` (71). So this is not one good term cancelling one
  bad one — there is no winning subset hiding inside the blend, and nobody needs to re-tune the weights
  hoping to find it.
  👉 **TWO REAL DEFECTS IN THE SHIPPED EVALUATOR, FOUND AND DOCUMENTED (still live on `main`).** The
  second one has a SIGN, which is why it is worth knowing even though the fix did not pay:
  · `lethalThreatWeight` fires on *summed untapped power ≥ their life* and **ignores blockers entirely** —
    15 power behind three 0/4 walls reads as a kill, and scores ABOVE a board with 6 unblockable damage.
  · **Attackers TAP when declared**, so the bonus is paid for the board that has not swung yet and
    withdrawn the instant it does: `evaluateState` scores **taking a proven kill (0.9047) BELOW declining
    it (0.9399)**. The evaluator actively prices attacking as *losing* the lethal bonus.
  ⚠️ **WHY §39's COMBINATORIAL TRAP DOES NOT APPLY HERE, and it is structural rather than clever.** Two
  facts collapse it: (1) **damage assignment is not a decision in this engine** (`internal/combat.ts`
  assigns lethal in declared order and tramples the rest), and (2) **block legality is NESTED** — core's
  `canBlock` refuses exactly one thing, a flier blocked by a non-flying non-reach creature. So the
  feasible attacker sets form a **matroid** and greedy by damage-prevented descending is *exactly*
  optimal with no matching algorithm at all. A test pins that legality claim against the real engine, not
  against the comment. Attacker subsets are not searched either: adding an attacker can never lower
  guaranteed damage, so "swing with everything eligible" is optimal by construction.
  ⚠️ **Every bound over-estimates the DEFENCE, on purpose**, so `guaranteedDamage` is a lower bound and a
  claimed lethal is never one that is not there. It can miss a kill; it cannot invent one. That asymmetry
  is what makes `takeProvenLethal` (brief §45's router branch) safe to *act* on rather than merely score.
  A first-striking blocker that kills a trampler stops ALL of its damage — that one is easy to get wrong
  in the unsafe direction and is the only place the bound is not "generous by default".
  👉 **THE SUITE HAS TWO HALVES BECAUSE ONE WAS NOT ENOUGH, and finding that out is itself a result.**
  12 pilot puzzles (lethal · anti-lethal · combat · removal · sequencing · mana) score heuristic 10/12 and
  BOTH hybrid arms 11/12 — **a pilot-level puzzle cannot isolate a leaf evaluator**, because on any board
  small enough to state as a puzzle a 160-simulation search just plays it out and reaches the terminal
  whatever its evaluator believes. So the second half grades `evaluateState` DIRECTLY on 5 position PAIRS
  that are both reachable successors of one decision. There: **default 0/5, tactical 5/5** — three pairs
  the default cannot tell apart at all (identical to 4 d.p.) and two it orders backwards.
  👉 **That also explains the null result and says when to re-ask it.** These terms describe positions
  near a terminal, which is exactly where the search does not need help. **Re-ask when the SEARCH
  changes, not when the weights do** — `THRIFTY_HYBRID_CONFIG`, a shallower `maxTreeDepth`, or decks whose
  games are decided further from a terminal all move that balance. A learned value function (§31) is the
  other consumer these terms were built for.
  ⛔ **A LIVE DEFECT THE SUITE CAUGHT IN THE *DEFAULT* PILOT — reported, deliberately NOT fixed.** Given a
  Mountain in play and a Mountain, a Swamp and a `{1}{B}` removal spell in hand, **every pilot plays the
  Mountain** and leaves its own removal uncastable for a turn: `heuristic.ts`'s land-drop candidates score
  each land on its own merits and never ask what a land UNLOCKS. Fixing it changes `heuristic`, which is
  `DEFAULT_PILOT_ID`, so it invalidates every recorded baseline in DESIGN §3.4a and every A/B verdict
  measured against them — that needs its own branch and its own measurement. Pinned as an explicit
  `DEFECT (unfixed)` test that FAILS the day someone fixes it.
  ⚠️ **RULE 7 — the heuristic path is untouched and provably so.** `heuristic.ts`, `weights.ts`,
  `card-value.ts`, `effect-value.ts`, `choices.ts` are **byte-identical to `main`** (`git diff` empty),
  the heuristic never calls `evaluator.ts`/`tactical.ts`, and `npm run sim -- gauntlet "Mono-Red Aggro"
  --games 40 --seed 99` reproduces **92/280 = 32.9%** at 113 games/sec — inside the recorded 109–118 band
  *while two benchmarks were running on the same box*. The hybrid default is unchanged too: with the
  tactical weights at zero the solver is never called, proven by a behavioural test rather than by
  inspection (two boards that differ only in something only the solver can see must score identically).
  👉 **NEW SEAMS in `packages/ai`, all additive:** `assessAttack` / `assessPosition` / `lethalAttackers`
  over a `CombatAssessment` (`maxDamage`, `guaranteedDamage`, `lethal`, `turnsToKill`), plus
  `AttackHorizon` — `'now'` vs `'next'`, which is the seam that lets an evaluator see a crack-back. Two
  bench modes: `tactical <n>` (interleaved arms + the ablation via `BENCH_TACTICAL_ARMS`) and
  `tactical-duel <n>` (the two evaluators playing each other — the sensitive form, since everything they
  share then cancels per game rather than only in expectation).
  ⚠️ **I touched TWO existing tests, both because they were over-specified, not because behaviour
  regressed.** `evaluator.test.ts`'s "zeroing the blend" now zeroes the new weights too. And
  `tree-reuse.test.ts`'s maxNodes-cap test asserted `reuseHitRate === 0`, which is a claim about which
  tree SHAPES one particular game happens to produce — a matched node with no children is one node and
  legitimately fits under a cap of one. It now states the intent as a COLLAPSE against an uncapped arm on
  the same seeded game (>0.5 vs <0.1), which is the property the test was actually for.
  ❌ **NOT done, and not mine:** burn-to-face lethal is not in the router (it needs `effect-value` to say
  how much damage a card in hand deals to a face — a different question with different failure modes; the
  policy already scores lethal burn at the top of its range). No belief model, no determinization
  (§13–17) — those are now UNBLOCKED by `feat/pilot-observation`'s seam, which landed on `main` while this
  branch was measuring, and they are a branch of their own.
  🔀 **Merged `origin/main` in** (which had gained the observation seam + the attachment cards). Three
  conflicts, all resolved in main's favour plus my addition: **my DESIGN section is renumbered §3.4c →
  §3.4d** because `feat/pilot-observation` took §3.4c first, and the two COORDINATION blocks are simple
  appends. `packages/ai/src/index.ts` auto-merged — the two branches added disjoint export blocks — and
  `pilot.ts`'s new optional `TObserver` type parameter has a default, so nothing here needed changing.
  `npm run verify` re-run after the merge, still exit 0.
  (Worker — pushed, NOT merged.)
- 2026-08-15 worker: `feat/attachment-cards` 🚧 PUSHED — **the attachment seam is no longer inert: the
  pool went from ZERO Auras and ZERO Equipment to 14 + 14.** `npm run verify` exit 0 — **2156 passed /
  0 failed** (main baseline 2117 + 39 new), lint 0 errors, `npm run build` exit 0. Pool **156 → 191**;
  both card indexes regenerated, never hand-edited.
  👉 **NOTHING WAS HAND-WRITTEN INTO EITHER INDEX.** Names → `expansion-candidates.json` →
  `build-expansion.ts --fetch` → `build-expansion.ts` → `npm run fetch -w @jonny-boi/data-tools` →
  `npm run cards:index -w @jonny-boi/web`. Every accepted card is the OUTPUT of the real Oracle
  compiler on its real Scryfall text, so `fidelity.test.ts` (which re-compiles every pool card and
  demands an exact match) covers the new cards automatically. **Art verified live with GET, not HEAD**
  — Scryfall's CDN answers 400 to HEAD — all 35 new rows resolve.
  ❗ **THE RE-RUN CAUGHT UP A STALE POOL: 7 NON-ATTACHMENT CARDS CAME IN FOR FREE, and that is the
  finding worth acting on.** `expanded-pool.ts` had not been regenerated since several compiler
  branches landed, so the pool was behind the COMPILER, not behind Scryfall. Re-running the generator
  admitted **Shivan Dragon, Mind Stone, Guttersnipe, Pyroclasm, Thragtusk, Night's Whisper, Unsummon**
  — all faithful, all checked by eye against the printed text committed above each definition.
  ⚠️ **So `build-expansion.ts` should be re-run whenever a compile rule lands, not only when the
  candidate list changes.** Nothing enforces that today and nothing failed while the pool was stale:
  the generator's output is committed, so a compiler that got smarter is invisible until someone
  re-runs it. Verified this re-run drifted NOTHING else: of the 156 existing index rows, **0 changed
  id, 0 changed art, 0 changed oracle text**, and every one of the 124 previously-compiled definitions
  is byte-identical.
  👉 **OBSERVED PLAYING, not just green.** Real games, real heuristic pilot, real pool definitions:
  · `Serra's Embrace` onto Savannah Lions — **2/1 → 4/3**, `flying`+`vigilance` granted; a second copy
    stacks it to **6/5** (so my first assertion of a flat +2/+2 was wrong and the ENGINE was right).
  · `Dead Weight` aimed at the opponent — 2/2 Walking Corpse becomes a 0/0, **dies to an SBA**, the Aura
    unattaches and is **put into the graveyard** (CR 704.5m).
  · `Bonesplitter` — Equip {1} **activated** by the pilot, host **2/2 → 4/2**; when the host dies the
    Equipment **unattaches and STAYS on the battlefield** (CR 704.5n, the whole difference from an Aura)
    and is then re-equipped onto a new creature. Three copies stack to 8/2.
  · `Loxodon Warhammer` — host **2/2 → 5/2** with `trample` and `lifelink`.
  ⛔ **NEEDS AN OWNER IN `packages/ai` (reported, not fixed — that package is live for two branches).
  The pilot PING-PONGS an Equipment between two creatures.** Measured, one game, seed 4242, two
  IDENTICAL vanilla 2/2s: Loxodon Warhammer was equipped **5 times, hosts 1 → 13 → 1 → 13 → 1**, i.e.
  **3 of the 5 activations returned it to the host it had just left**, paying {3} each time for a board
  it already had. The existing guard in `attachments-play.test.ts` only covers the ONE-creature case
  ("does NOT re-equip the creature it is already on"), which is why this survived. The equip heuristic
  needs hysteresis — a move should have to beat staying put by a margin, not merely tie.
  👉 **ONE COMPILER FIX, and it is a normalization gap rather than a new template** (`compile/text.ts`):
  `SELF_PHRASES` folded "this creature/permanent/artifact/enchantment/land/card" into `~` but **not
  "this Aura" / "this Equipment"** — the subtype is how Oracle templates an attachment's self-reference.
  Without it "When this Aura enters, draw a card" survived normalization and looked like an ability
  about some other object. Two words unlocked **Angelic Gift** and **Dark Favor**, and it also makes
  Rancor/Claustrophobia report a clean `~`-normalized clause instead of a raw one. Blast radius is
  confined to Aura/Equipment-typed cards, of which the pool previously had none.
  ⚠️ **`paired-arms-config.ts` NOT touched and did not need to be** — every new card compiles to
  primitives that already exist (`attachToTarget` was classified LIBRARY_SAFE by `feat/attachments`,
  and the ETB triggers reuse `drawCards`/`loseLife`). No new primitive, no classification decision.
  ❌ **Rejected on fidelity grounds, deliberately** (each named in `expansion-report.json` with the
  system it needs): **Pacifism** (can't attack or block), **Rancor** (returns itself from the graveyard),
  **Spirit Mantle** (protection), **Ethereal Armor** (dynamic P/T), **Firebreathing** / **Shiv's
  Embrace** / **Gaea's Embrace** (an ability granted to the HOST), **Aqueous Form** / **Whispersilk
  Cloak** / **Madcap Skills** (can't-be-blocked and menace), **Skullclamp** / **Elephant Guide** /
  **Armadillo Cloak** (triggers on the equipped/enchanted creature), **Flayer Husk** (living weapon),
  **Ghostfire Blade** (a conditional equip cost — the plain half compiles, the narrowed half must keep
  reporting or it would be cheaper than printed), **Darksteel Axe** (indestructible), **Silverskin
  Armor** / **Sinister Strength** (type/colour changes), **Hyena Umbra** / **Snake Umbra** (totem armor).
  ⚠️ **Green has no mono-green Aura and that is a real gap, not a shortfall of effort.** Nearly every
  green Aura in Magic is an umbra, a regenerate-granter or dynamic. The single highest-value engine
  work for Auras is **"can't attack or block"** — it alone unlocks Pacifism and its whole family.
  👉 Two small leave-it-better fixes: `build-expansion.ts` emitted `{  }` for an empty record (my
  cards were the first to print one — a modification granting no keywords), now `{}`; and the stale
  "Both lists are 156 cards today" comment in `apps/web/src/views/LabView.tsx` is replaced with a
  count-free sentence so it cannot go stale again. **That LabView line is my only edit outside my
  owned files** — expect at most a one-line conflict there.
- 2026-08-15 worker: `feat/pilot-observation` 🚧 PUSHED — **the blocker `feat/tree-reuse` reported is
  gone: a pilot can now see the half of the game it does not play.** `npm run verify` exit 0 — **2027
  passed / 0 failed** (baseline 2012 + 15), lint 0 errors, card-index clean, `npm run build` exit 0.
  DESIGN §2 + new §3.4c.
  👉 **THE SEAM IS SPECTATOR-LEVEL, NOT PER-SEAT, AND THAT IS THE WHOLE ANTI-CHEAT ARGUMENT.** An
  `Observation` carries only what someone beside the table holding no cards would know, so **there is no
  seat whose entitlement could be computed wrongly** — the failure mode of a per-seat feed is a masking
  bug, and the failure mode here is nothing, because nothing in the feed is anybody's secret. It also
  makes the feed **one projection per event instead of one per seat**, which is where the cost went.
  A pilot combines it with the view it is already lent (which holds its own hand), so no seat loses
  anything it is entitled to.
  ⚠️ **THE WORST LEAK IN THE UNION IS `gameStart.seed`, AND IT READS LIKE BOOKKEEPING.** It is the number
  both libraries were shuffled from — a pilot holding it has perfect information about the entire game,
  not "a bit extra". Also redacted: `drawCard` (that a draw happened, never which card), `zoneChange`
  (the instance id survives only when the card came to rest somewhere **public** — the test is the
  DESTINATION, since a bounce is watched by everyone and then vanishes), and the three choice events (an
  effect authors its own prompt and may name the cards it is asking about — the same reasoning
  `@jonny-boi/protocol`'s `RedactedPendingChoice` already uses; the two redactions agreeing is deliberate).
  35 of core's 41 event types pass through untouched.
  ⚠️ **THREE GATES, AND ONLY ONE OF THEM IS WORTH ANYTHING ON ITS OWN.** (1) `OBSERVATION_POLICY` is a
  mapped type over `GameEvent['type']`, so a new core event breaks the sim build until classified —
  same shape as `paired-arms-config.ts`. (2) `'public'` is **unspellable** for the six redacted types:
  each replacement shape declares its dropped field `?: never`, so the raw event is not assignable, and
  `REDACTION_IS_UNSPELLABLE` fails to compile if any is weakened (verified by deleting one). (3) The
  real one: `observation.test.ts` plays real games and scans every delivered observation with protocol's
  `collectInstanceIds` against the cards **actually in a hand or library at that instant**. **Verified
  RED by sabotage** — un-redacting `drawCard`, then `zoneChange`, each makes the scan name the exact
  leaked cards. A green anti-cheat test that cannot go red is worse than none.
  ❗ **`REDACTION_IS_UNSPELLABLE` LIVES IN SHIPPED SOURCE, NOT IN THE TEST FILE, AND THIS IS A TRAP
  EVERYONE SHOULD KNOW ABOUT.** `packages/*/tsconfig.json` **excludes `src/**/*.test.ts`** and Vitest
  strips types without checking them, and eslint here is not type-aware. **A `@ts-expect-error` written
  in a test file in this repo is evaluated by NOTHING.** I wrote six of them, then checked, then moved
  the guarantee into a compiled file. Anyone writing a type-level assertion here must do the same.
  👉 **PER-GAME ISOLATION IS STRUCTURAL BY CHOOSING THE OTHER SEAM SHAPE.** The obvious design is
  `Pilot.observe(obs)`, and it is the wrong one: it forces per-game state onto an object that is reused
  across hundreds of games. The seam is `Pilot.createGameObserver(info)` — the harness creates one per
  game, hands it back on every `DecisionContext`, and drops it at the end, so **a pilot has nowhere to
  put cross-game state**. This is not tidiness: every real consumer builds ONE pilot and runs MANY games
  through it, and the Lab shards the grid across workers by range, so a belief that outlived a game would
  make a paired A/B verdict **depend on the worker count**. Pinned by a test that plays one game
  standalone and again after three others through the same pilot and demands a byte-identical transcript.
  ⚠️ **DETERMINISM — digested, not asserted.** sha256 over the FULL chosen-action sequence, **131,524
  plies** (`heuristic`, `random` AND `hybrid` × three matchups): **all nine digests identical** before and
  after, measured by building the pre-seam sources in the same worktree. `npm run sim -- gauntlet
  "Mono-Red Aggro" --games 40 --seed 99` diffs **byte-identical except the throughput line**. None of the
  four built-ins implement the seam, so `observers` is `null` and the loop is the old loop.
  👉 **COST: public events are delivered BY REFERENCE; only redacted ones allocate.** Measured over 20
  games — 1,128 events/game, **96.9% by reference, 3.1% (35/game) copied**. Interleaved **in-process** A/B
  with the pre-seam and post-seam harness both loaded (alternating which arm runs first, because this box
  warms up over a run): 21 rounds × 250 games → **paired median 0.989×**, i.e. parity, against a per-round
  spread of **0.79–1.18**. An 11-round run of the same code said 0.956× — quote the paired median of the
  longer run, and never a single round. Feed **ON at both seats**: **0.963×**, n=15.
  👉 **Proof of life, deliberately NOT a belief model:** `createOpponentRevealObserver` tallies what the
  opponent has publicly revealed this game (cards drawn, lands, spells by name, mana by colour, ids that
  entered public view — the raw material for §16 known cards, §32–33 archetype and §35–37 represented
  mana). `createRevealTrackingPilot(base)` wraps any pilot and delegates the decision unchanged, which is
  what lets a test prove observing costs no change in play. Re-runnable:
  `node packages/sim/bench/observation-bench.mjs digest | throughput | plain | volume`.
  ⛔ **NEEDS AN OWNER ELSEWHERE — reported, not done:**
  · **`DecisionContext.view` is the FULL, UNMASKED `GameState`.** A pilot can read
    `view.players.B.hand` and `view.players.B.library` today, and `view.seed`. This seam does not make
    that worse (it is the reason the feed had to be provably clean), but the honest statement is
    "observations cannot leak; the VIEW already does". `PILOTS_THAT_READ_HIDDEN_LIBRARY` in
    `paired-arms-config.ts` exists precisely because `mcts` exploits it. Masking the view is a
    cross-package decision (`packages/ai` + `packages/sim` + every pilot) and belongs on its own branch —
    a belief model built against an unmasked view would be measuring nothing.
  · **`apps/server` and `apps/web/src/lib/replay-build.ts` call `chooseAction` themselves** and do not
    drive the seam. That is safe and by design (`ctx.observer` is optional and the wrapper tolerates its
    absence — tested), but a pilot that ever needs observations *in online play* would need the same
    ~10 lines in `apps/server`'s room loop. Not touched.
  · `packages/sim` gained `@jonny-boi/protocol` as a **devDependency** (test-only, for
    `collectInstanceIds`). Deliberate: re-implementing "does this mention that card?" is exactly the drift
    the room-code bug taught us about.
  ⚠️ **For `feat/tactical-eval` / whoever else is in `packages/ai`:** my footprint there is 2 new files
  (`observation.ts`, `reveal-tally.ts` + its test), an additive block in `index.ts`, and `pilot.ts` —
  where `Pilot` and `DecisionContext` gained an optional `TObserver` type parameter **with a default**, so
  every bare `Pilot` / `DecisionContext` annotation in the repo is unchanged. Plus one stale comment
  corrected in `tree-reuse.ts` (it said the observation channel does not exist). `evaluator.ts`,
  `hybrid.ts` and `mcts.ts` are untouched.

- 2026-08-15 worker: `feat/pilot-relative-verdicts` 🚧 PUSHED — **every result now says which pilot
  produced it, and the suggestion engine refuses to pool two pilots' evidence.** `apps/web` ONLY; nothing
  in `packages/*` touched. Suite **1969 passed / 0 failed** (baseline 1939 + 30), `npm run lint` 0 errors,
  card-index `--check` clean, `npm run build` exit 0. DESIGN §3.7a added.
  👉 **THE HEADLINE IS THE ONE `feat/hybrid-search` LEFT BEHIND.** Its own note said "deck verdicts are
  pilot-relative — worth stating in the Lab UI at some point". Doing it turned out not to be a label job:
  a win rate is a measurement of a deck AS PLAYED BY a pilot, so the pilot had to become a first-class
  field on the request, the shard context, the result payload and the stored record. `pilotId` is
  **REQUIRED** on `SimRequest`, not optional-with-a-default — an optional field is one a call site can
  forget, and the call site that forgot it would silently answer a different question than the screen
  displays. (Same lesson as the room-code bug: a value two layers each default separately is a bug
  waiting.)
  ⚠️ **THE STATISTICALLY LOAD-BEARING PART IS THE HISTORY PARTITION, and "invalidate on change" would
  have been wrong.** `lib/sim/history-store.ts` accumulates cross-run evidence, and TWO of its fields make
  pooling across pilots invalid rather than untidy: (1) `settled`/`provenNotBetter` retire a candidate
  from future runs, and "not better" is a claim about a LEVEL OF PLAY — a card whose value is punishing
  bad blocks is settled-as-useless under one pilot and a real gain under another; (2) `candidates.length`
  IS the Holm–Bonferroni family size, so pooling both inflates the family and corrects a family that mixes
  two different hypotheses. **Chosen: partition by pilot in the storage key, keep every record side by
  side.** Deleting on change was rejected outright — a record can be hours of compute and "you moved a
  dropdown, so your afternoon is gone" is not a trade to make on a user's behalf. The UI PROVES the
  partition is not a deletion ("Kept separately: Heuristic (3 runs). Switch pilot to resume."), because a
  partition nobody can see is indistinguishable from losing the data, and a user who believes it is gone
  will hit Reset and make it true.
  👉 **Pre-partition records are ADOPTED, not dropped.** Everything written before this branch was played
  by `DEFAULT_PILOT_ID` — nothing else could be run — so the old key is read once, re-filed under the
  default pilot's key, and only then removed. If the migration WRITE fails (quota), the old key is kept:
  a migration is the one moment a storage failure could destroy evidence rather than merely fail to add
  to it. Both paths are unit-tested.
  ⚠️ **THE COST WARNING HAD TO COME BEFORE THE RUN, AND MY FIRST CALIBRATION WAS 4× TOO OPTIMISTIC.**
  Hybrid is ~1400× the heuristic, so the same gauntlet is 3 seconds or an hour on one dropdown. Each panel
  now shows its planned game count and a wall-clock estimate NEXT TO the Run button before it is pressed.
  I first calibrated `REFERENCE_GAMES_PER_SECOND_PER_WORKER` from the headless figures on this board
  (110–206 games/sec on one core) and the estimate came out ~4× short of what the Lab actually did. **The
  browser numbers are the only honest calibration for a browser estimate:** a real 700-game gauntlet in
  the running Lab reported **192 games/sec on 11 workers** (~17.5/worker), so the constant is 20 — the
  pessimistic end, because an estimate that runs short is the one that gets somebody to start an overnight
  run by accident. If you re-measure, measure END TO END (games/sec), not per decision: under the
  heuristic the ENGINE dominates a game's cost, so scaling a whole game by a per-DECISION ratio overstates
  a search pilot badly.
  👉 **Verified in the running app, not just in tests** (dev server on the worktree, `localStorage`
  inspected): a 700-game heuristic gauntlet renders the provenance stamp + "· pilot heuristic"; a
  suggestions run files itself under `jonny-boi.suggest-history.v1.heuristic.<fingerprint>`; switching to
  Hybrid shows a FRESH search plus "Kept separately: Heuristic (1 run)"; switching back restores "Run 2 ·
  28 candidates carried over"; the Hybrid estimate reads "~780 games · estimated 1 hour on 11 workers —
  this is a long run".
  ⛔ **ONE CHANGE WANTED OUTSIDE `apps/web`, reported not made** (`packages/sim` is live for other
  branches): `SuggestionHistory` has `version` + `deckFingerprint` but no `pilotId`, so the sim's own
  `acceptHistory` cannot reject a cross-pilot record — only this web layer can. It works because the web
  layer wraps the record in an envelope carrying the pilot and checks it, but the CLI's `--history <file>`
  has **no such guard**: `npm run sim -- suggest deck --pilot hybrid --history h.json` will happily accept
  a file gathered with `--pilot heuristic`. The right fix is a `pilotId` field on `SuggestionHistory` and
  a third clause in `acceptHistory`; then the web envelope becomes belt-and-braces instead of the only
  belt.
  ⚠️ Also for whoever owns `packages/ai`: adding a pilot to `SELECTABLE_PILOT_IDS` will fail ONE assertion
  in `apps/web/src/lib/sim/pilots.test.ts` ("has display copy and a measured cost for every selectable
  pilot"). That is deliberate and the fix is two rows in `lib/sim/pilots.ts` — the app already runs
  without them (unknown pilots are shown, priced as "not measured", and treated as costly), so it is a
  reminder, not a blocker.
  ❌ **Not done:** no hook/component tests — `apps/web` still has no `@testing-library/react`/jsdom, and
  adding that stack is the separate decision the board already flagged. All new logic is pure and unit
  tested instead (`pilots.test.ts`, the rewritten `history-store.test.ts`, `estimateSuggestionGames`).
  The pilot choice is also NOT persisted across a reload (it lives in `useLabSelection`, like the seed).
- 2026-08-15 worker: `perf/core-hotpath` 🚧 PUSHED — **`planManaPayment` is 1.9–2.7x faster and allocates
  86% less; the "kill the clone" ceiling is NOT 1.53x and the reason is that the clone is already gone.**
  `packages/core` only (`mana-plan.ts`, new `mana-plan.test.ts`, a new section in
  `bench/engine-alloc-bench.ts`). `npm run verify` exit 0 — **1957 passed / 0 failed** (baseline 1939 + 18
  new), lint 0 errors, `npm run build` exit 0.
  👉 **THE COST WAS THE OBJECT SHAPE, NOT THE SCAN — and the brief's suggested fix is the one thing that
  makes it slower.** Building a `Map` index of the battlefield per call measured **0.92–0.98x at 2,272
  B/call** against 1,854 for the linear scan, on 600 real mid-game positions. The 20-odd `===` the scan
  performs are nearly free; what was NOT free is that a `ManaCost` and a `ManaProduction` are SPARSE
  partial records (`{R:1}`, `{generic:2,W:1}`), so **every card in a deck presents a different hidden
  class and `cost[color]` in the ranking loop is a MEGAMORPHIC load** — six of them per candidate tap per
  step of the plan. Reading each sparse record ONCE into a dense `Int32Array` and ranking against that is
  where the whole win lives. The scan stayed; the old comment defending it was right and is kept (with
  the re-measured numbers).
  👉 **Measured, in-process, interleaved A/B of seven variants** (600 real positions, Mono-Red vs Boros,
  old implementation copied verbatim as the control so both run in one process):
  linear scan → allocation-free indexed scan **1.08–1.14x**; + array-of-groups instead of
  `Map.values()` **1.19–1.38x**; + dense reused buffers **1.77–2.73x at 262 B/call vs 1,854 (−86%)**.
  Re-measured on `packages/core/bench/engine-alloc-bench.ts`, interleaved, core-only: **4.03 → 2.13
  µs/call (1.89x median, 1.95x best-of)**, with actions/sec and ns/clone at parity.
  `packages/ai/bench/mcts-bench.mjs instrument`: **8.21 → 6.36 µs and 5.32 → 0.34 KB per call (−94%)**,
  allocation/decision 19.75 → 16.25 MB. End to end, interleaved by swapping `packages/core/dist`:
  heuristic gauntlet **+5% median**, hybrid match **1.12x best-of / 1.24x median**.
  ⚠️ **DETERMINISM, proved four ways, not asserted.** (1) A full-decision-sequence sha256 over **28,108
  plies** — heuristic on two matchups (20 games each) and the HYBRID pilot on two matchups — is
  **identical** before and after. (2) `npm run sim -- gauntlet "Mono-Red Aggro" --games 40 --seed 99` and
  `-- match … --pilot hybrid` diff **byte-identical except the throughput line**. (3) The seven variants
  were required to return the identical plan on all 600 positions. (4) `selfplay-lock.test.ts` unchanged.
  👉 **NEW: `packages/core/src/mana-plan.test.ts` (18 tests) — the hottest function in the engine had NO
  direct test.** It is public API for both pilots, the hotseat auto-tap and the online client, and it was
  only ever exercised indirectly. The tests pass against the OLD implementation too (checked), so they
  are a real equivalence guard rather than a rubber stamp for the new one. They pin the two tie-breaks,
  "a source's modes are alternatives", grouping when the offered modes are **non-contiguous** (the online
  client filters its own action list, so grouping must not depend on engine ordering), and the three ways
  the new reused module-level buffers could leak between calls.
  ❗ **THE CLONE ANSWER IS "ALREADY DONE", AND ANYONE QUOTING 1.53–1.58x IS QUOTING A DEAD NUMBER.**
  `DEFAULT_SIM_CONFIG.applyActionsInPlace` is **true**, so `match.ts` already runs `applyActionInPlace`;
  MCTS and the hybrid roll out in place too. **There is no remaining hot-path caller of the cloning
  `applyAction` in this repo** — the others are `apps/web` session + replay-build and `apps/server` room,
  all one action per human/network event, all genuinely needing the previous state. So the spike's ~1.58x
  ceiling (correct for clone-per-ACTION) no longer describes the code.
  👉 **What IS left is one clone per SIMULATION in the search, and I measured its real ceiling:**
  the hybrid's budget is 160 simulations = 160 clones per decision, which is **19.0% (median) / 16.9%
  (best-of) of a decision** → **ceiling 1.23x / 1.20x if cloning were FREE**, on 10 real positions,
  9 interleaved rounds.
  👉 **The one structural lever, measured but deliberately NOT taken: 85% of the instances a clone copies
  are LIBRARY cards.** Sharing library instances instead of copying them makes the clone **3.3x cheaper**
  (2.61 vs 8.66 µs, 4.12 vs 14.70 KB) — but that is worth only **1.15x** on a hybrid decision and NOTHING
  on the Lab's default heuristic gauntlet, and it buys that by introducing an invariant ("no `CardInstance`
  is mutated while it sits in a library") that is unenforced today, whose violation aliases two states and
  corrupts the search's root **silently**. That trade needs its own branch with the invariant made
  mechanical (a dev-mode freeze + a sabotage test), not the tail of a perf branch. ⚠️ Note the byte
  counters in that comparison are distorted by V8 escape analysis on the inlinable control arm; the time
  ratio, the byte ratio and the 85% instance share agree, which is why it is quoted as "3–4x".
  ❌ Also NOT done and NOT mine: `packages/ai` could reuse ONE state buffer across simulations
  (refresh-in-place instead of `cloneState` per simulation) — that removes the ALLOCATION without removing
  the copying, and it is a `hybrid.ts`/`mcts.ts` change. Reported, not made.
  ⚠️ **Measurement discipline:** sequential runs "showed" this change as a 17% SLOWDOWN (143 → 119
  games/sec) — pure drift; the interleaved run of the same builds showed +5%. Every number above is
  interleaved inside one process or by alternating `packages/core/dist` between two prebuilt copies.
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
