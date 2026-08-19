# jonny-boi — Canonical Design

A Magic: The Gathering **deck-tuning lab**. Build a deck, let AI pilots play it hundreds of games
against a meta gauntlet, swap a single card, and get a **statistically definitive** verdict on whether
the deck got better — then let the engine **suggest the next improvement**. Real MTG cards and Scryfall
art, in a polished **PWA** that runs on PC, Android, and the browser.

This document is the **single source of truth** for requirements and architecture. Every contributor
(human or agent) reads this before touching code.

---

## 1. Engineering principles (non-negotiable)
1. **Data-driven.** Cards, decks, AI weights, sim params live in data with safe defaults. Adding a card
   or a meta deck = editing/adding a data file, never an engine change.
2. **Composition over inheritance.** A card = data referencing small composable **effect primitives**.
   No subclass-per-card. AI strategies / sim reporters / effects are small registered modules.
3. **DRY & self-documenting.** One mechanism per concept. Names explain intent; comments explain *why*.
   No magic numbers — costs, life totals, sim counts are named/derived.
4. **Fully tested.** Every pure-logic unit (rules, AI, sim, stats) ships with automated tests. A change
   that breaks an existing test is a regression and must be fixed before merge.
5. **Debug tooling.** Every new system is observable/drivable at runtime via the shared **inspector**
   (game-state dump, step priority, force draws, sim-log viewer) — not ad-hoc key bindings.
6. **Performance.** The sim runs thousands of games; the core hot path stays fast and allocation-light,
   and runs in both Node and a browser Web Worker. Instrument games/sec; no regressions.

## 2. Architecture seams (the contract all features plug into)
Features must NOT edit the core engine loop to integrate. They plug into these seams.

- **Card & effect-primitive registry** — a card is a **data record** (cost, types, P/T, keyword flags,
  an ordered list of effect references). Effect primitives (`dealDamage`, `drawCards`, `gainLife`,
  `createToken`, `pumpUntilEOT`, …) are small pure functions that **self-register** by id. New card =
  new data record (+ a new primitive only if a genuinely new mechanic). The engine resolves cards by
  looking up primitives — it never knows about specific cards.
- **Game state & event log** — all runtime state in plain-data structures (players, zones, the stack,
  mana pool, turn/phase). Every mutation emits a typed **event** to an append-only log; systems and the
  AI observe events without coupling to each other. This log is also the replay/inspector source.
- **AI-strategy registry** — an AI pilot implements `chooseAction(view, legalActions) → action` against
  a **read-only game view**. Strategies self-register by id (e.g. `random`, `heuristic`, `mcts`) and are
  selected by data (deck/match config), never hard-wired. `chooseAction` runs only while that pilot holds
  priority, so a pilot that also needs to watch the opponent implements the optional **observation seam**
  (`createGameObserver`, §3.4c): the harness feeds it a spectator-level projection of every event for the
  duration of ONE game. The projection is the harness's job — the pilot is the untrusted side, exactly as
  an online client is, and `packages/sim/src/observation.ts` is its single chokepoint.
- **Sim harness & reporter registry** — the harness plays `runMatch(deckA, deckB, aiA, aiB, n)` headless
  and streams results to **reporters** (win-rate, mana-curve stats, A/B significance). Reporters
  self-register; adding a metric doesn't touch the match loop.
- **Data registries** — load every `data/<kind>/*` (cards, decks, ai-profiles, sim-presets); new content
  = drop a file, no code.
- **Card-art / data pipeline** — `data-tools` fetches card data + art from **Scryfall** for the curated
  pool and caches it locally (respecting Scryfall's API guidelines: rate limit, attribution, no bulk
  re-hosting). The engine and UI consume the cached, normalized card index — they never call Scryfall at
  play time.
- **Debug inspector** — data-driven runtime controls (the one home for debug/cheat tooling): state dump,
  step-through priority, forced draw/mulligan, event-log scrubber, live sim log.
- **Test framework** — Vitest; pure units auto-discovered. `npm test` must end `0 failed`.

### 2.1 State discipline
Keep all runtime state in small, owned, plain-data structures threaded through an explicit `GameState`
(+ typed event log) — never scattered module globals. The core is pure: no DOM, no network, no `Date.now`
in the hot path (seeded RNG for reproducible sims).

## 3. Roadmap
**Status legend:** ✅ done (implemented, tested, committed) · 🚧 in progress · ⬜ not started.
Keep markers honest — a feature is ✅ only once tests pass **and the work is committed/pushed**.

### 3.0 Monorepo scaffold + tooling — ✅ done  *(foundational — blocks everything)*
npm workspaces, TypeScript (strict), Vitest, ESLint/Prettier, Vite PWA shell, a `core` smoke test, and
`npm run build` / `npm test` / `npm run dev` wired. One owner; everyone branches off this.

### 3.1 Core rules engine — MVP — ✅ done
GameState + zones + event log; turn structure (untap/upkeep/draw/main/combat/end), priority & the stack,
mana pool & paying costs, playing lands, casting creatures/instants/sorceries, the combat step, state-based
actions, win/loss by life/decking. Seeded RNG. Pure + fully tested.

### 3.2 Card model + effect primitives + curated pool — ✅ done
The card data schema, the effect-primitive registry + a starter set of primitives, and an initial curated
card pool sufficient to express the meta decks. Each card is data; each primitive is tested.

### 3.3 Scryfall data-tools pipeline — ✅ done
Fetch + cache card data and art for the curated pool; produce a normalized card index the engine/UI use.
Robust to misses; respects Scryfall guidelines.
The PWA's bundled copy (`apps/web/src/data/card-index.json`) is **derived**, not authored:
`apps/web/scripts/build-card-index.mjs` projects it from the canonical index, keeping only the fields
the UI renders. Regenerate with `npm run cards:index -w @jonny-boi/web`; never hand-edit it.
`apps/web/src/data/card-index.test.ts` re-derives it on every `npm test` and fails on any drift, and
also asserts that every card the engine can play has a display row that resolves to art.

### 3.4 AI pilots — ✅ done
The `chooseAction` interface + read-only game view + legal-action generator; a `random` baseline and a
`heuristic` pilot good enough to play the meta decks competently. Tested against scripted scenarios.
**`DEFAULT_PILOT_ID` is `heuristic`.** The look-ahead **`mcts`** pilot (UCB1 + engine rollouts, tunable
`MctsConfig`) remains *selectable* but is a research option, not a recommendation — and this paragraph
used to claim the opposite, which is why the numbers are recorded here rather than an impression:

- **Speed:** ~0.09 games/sec vs the heuristic's ~176 — a **2000×** gap. (Both are wall clock on a quiet
  box. This machine is now shared, and the same heuristic build reads anywhere from 39 to 87 games/sec
  depending on what else is running — see §3.4f on why every throughput claim here should be paired.) It is structural (`sims × depth`
  engine plies per decision), not garbage, so allocation work does not reach it: a measured 19% cut in
  MCTS-side allocation moved wall clock within run-to-run noise.
- **Strength:** measured *worse*, not better. Over 120 seeded games with seat and play rotated it won
  **40.8%** (95% CI **[32.5%, 49.8%]** — the interval excludes 50%) against the very heuristic it uses as
  its rollout policy. It still wastes 0.71 mana/turn against the heuristic's 0.00.
- **Diagnosis on file:** the search values tapping a land through rollouts where the *heuristic* later
  spends that mana, while the real next mover treats it as sunk. `MctsConfig.evalWastedManaPenalty` fixes
  the symptom (0.71 → 0.22/turn) but costs ~11.6 points of win rate, so it ships **off**. The real fix is
  making tap-and-cast atomic in the search's action space via `planManaPayment`.

⚠️ Do **not** re-default it without a fresh head-to-head; that has already shipped once and made the Lab's
stock run a multi-hour job. Pinned by guard tests in `packages/ai`. Note also that lowering
`MctsConfig.maxDecisionMillis` is NOT a valid throughput knob: a wall-clock budget makes the search
machine-dependent and destroys the common-random-numbers property the paired A/B test rests on.
*Play-quality fixes (2026-08):* pilots read effect primitives by **registered id** — a mismatched id
(`destroy` vs `destroyTarget`) silently degrades a spell to an untargeted "generic" cast that no-ops, so
`test-support.ts` fixtures must use the real ids. Pumps are scored as combat tricks (save / win the fight
/ push lethal) rather than cast blind, and mana is tapped from a **funding plan** so the pilot stops
tapping once a cost is covered.

### 3.4a The `hybrid` search pilot — ✅ done  *(Phases 1–4 of the superhuman-AI program)*
`docs/plans/superhuman-ai-program.md` §58 phases 1–4, built **on measurement, not on intuition**. The
NO-GO above was about *naive MCTS as a drop-in pilot*, not about search. Re-asking the question properly
reverses the result.

**Phase 1 — instrumented first** (`packages/ai/src/search-stats.ts`, `bench/mcts-bench.mjs instrument`).
The vanilla search reports its own shape now; the numbers said where the problem was:

| measured on vanilla `mcts`, 24 real mid-game positions | value |
|---|---|
| root branching, mean / max | **4.8 / 9** — branching was never the problem |
| engine plies per simulation | **105.8** = 5.0 in-tree + **100.8 rollout** → **95% of all work is rollout** |
| rollouts that reach a terminal | **25%** — the other 75% pay 100 plies and get a positional guess anyway |
| cost vs `rolloutDepth` | **linear**: 0.75 MB/decision at 1 → 18.9 MB at 120 |
| offered actions that are strategically duplicate | **41.6%** (42,806 → 25,015 over 20 real games) |
| decisions with a single legal action | **25.7%** |
| decision time, mean / p95 | **39 ms / 160 ms** |

**Phases 2–4 — what changed, each aimed at a measured number.**
- **Atomic action space** (`policyCandidates` in `heuristic.ts`). A search candidate is a whole funded
  play — the taps *and* the cast — planned through core's `planManaPayment`, the same planner the
  heuristic pays with. A naked `tapForMana` is **not in the search space at all**, so the recorded
  tap-and-don't-spend failure has no representation. Equivalent actions collapse via
  `actionEquivalenceKey` (five Islands ⇒ one option), and a position whose policy offers one option is
  auto-resolved with no search node.
- **PUCT + progressive widening + policy prior** (`hybrid.ts`). `P(s,a) ∝ exp(score/temperature)` from the
  heuristic's own scoring, with a **floor prior** so the heuristic can make an option unlikely but never
  impossible. Rewards back up **adversarially** — an opponent node minimises them, where vanilla MCTS
  maximised the decider's reward at every node.
- **Leaf evaluation instead of playouts** (`evaluator.ts`, the brief's §30 `evaluateState` /
  `evaluatePolicy` seam, initially heuristic-backed so a learned model drops in later). Life, board, card
  advantage, mana development, untapped mana, body count and lethal-board, each a named tunable weight —
  explicitly *not* "life total + card count".

**Measured result — HYBRID vs HEURISTIC, seat and play both rotated** (the identical protocol that
produced the 40.8% above). ⚠️ **Two matchups were measured, and they do not agree — read both:**

| matchup | pilot | win rate vs heuristic | 95% CI | mean decision |
|---|---|---|---|---|
| Mono-Red Aggro vs Boros Aggro, n=120 | `mcts` (vanilla) | 40.8% | [32.5%, 49.8%] | 39 ms |
| Mono-Red Aggro vs Boros Aggro, n=120 | **`hybrid`** *(pre-§3.4e)* | **60.0%** | **[51.1%, 68.3%]** | 7.07 ms (p95 66 ms) |
| UW Control vs Golgari Midrange, n=80 | `hybrid` *(pre-§3.4e)* | 53.8% | **[42.9%, 64.3%]** | 27.7 ms (p95 155 ms) |
| Mono-Red Aggro vs Boros Aggro, n=120 | **`hybrid`** *(pre-§3.4f)* | **55.8%** | **[46.9%, 64.4%]** | 6.13 ms (p95 52.7 ms) |
| UW Control vs Golgari Midrange, n=80 | `hybrid` *(pre-§3.4f)* | 48.8% | **[38.1%, 59.5%]** | 9.05 ms (p95 88.2 ms) |
| Mono-Red Aggro vs Boros Aggro, n=120 | **`hybrid`** *(current)* | **55.0%** | **[46.1%, 63.6%]** | 14.97 ms (p95 117 ms) |
| UW Control vs Golgari Midrange, n=80 | `hybrid` *(current)* | 45.0% | **[34.6%, 55.9%]** | 20.95 ms (p95 154 ms) |

⚠️ **The `(current)` rows were re-measured on 2026-08-19 after §3.4f** (the pilots could not see the
board). Both intervals still include 50% and both still overlap the pre-§3.4f rows, so nothing about the
hybrid's standing changed — which is expected for the reason this section already gives twice: the
heuristic is simultaneously the baseline and the hybrid's own prior. ⚠️ **Do NOT read the decision-time
columns across those two pairs of rows.** They are wall clock on a box shared by six agents, and the
same build measured 2× apart on this machine within an hour; the throughput claim that IS defensible is
§3.4f's paired CPU-time and allocation comparison.

⚠️ **THE MARGIN SHRANK BECAUSE THE OPPONENT GOT BETTER, AND THAT IS NOT A REGRESSION IN THIS PILOT.**
§3.4e fixed land sequencing in the `heuristic`, which is simultaneously the **baseline this table
measures against** and this pilot's own **prior and rollout policy**. Both sides therefore improved and
the *difference* between them narrowed. Nothing in `hybrid.ts` or `DEFAULT_HYBRID_CONFIG` changed.

The honest current summary: **on the aggro matchup the interval now INCLUDES 50%**, so the pre-§3.4e
claim "significantly stronger on fast tactical boards" no longer holds at n=120 and would need either
more games or a real gain to restore. On the control matchup the point estimate no longer favours the
hybrid either. Read against §3.4a's own plateau finding this is consistent rather than surprising: the
search is limited by its **evaluator**, so a better prior helps the pilot it is a prior *for* less than
it helps the pilot that *is* the prior. Do not quote the 60% as "the" number — it is a historical
measurement against a weaker baseline.

Note also that decision cost is **board-size dependent**: 7 ms on aggro boards, 28 ms on control boards,
because the policy scores every castable card and plans its funding at every node.

**It SCALES — the property that says this is a search and not a constant.** Same matchup, same 120 seeded
games, only the simulation budget varied (`bench/mcts-bench.mjs scaling`):

| budget | n | win rate vs heuristic | 95% CI | mean decision |
|---|---|---|---|---|
| 16 sims | 120 | 48.3% | [39.6%, 57.2%] | 0.29 ms |
| 64 sims | 120 | 53.3% | [44.4%, 62.0%] | 2.26 ms |
| 256 sims | 120 | **60.0%** | **[51.1%, 68.3%]** | 16.8 ms |
| 1024 sims | 60 | 61.7% | [49.0%, 72.9%] | 88.0 ms |

Monotone in the budget. At 16 simulations the pilot is indistinguishable from its own prior, which is the
correct sanity check — with almost no search a policy-guided search should reproduce the policy, and it
does.

⚠️ **It also PLATEAUS, and that is the more useful finding.** 16→256 buys **+11.7 points** for 16× the
compute; 256→1024 buys **+1.7** for another 4×. Beyond a few hundred simulations the binding constraint
stops being search depth and becomes **evaluator accuracy** — the search converges to the best line *its
evaluation function can see*. So the next real gain is not a bigger budget: it is the brief's §11–12
(tactical solver for lethal / anti-lethal / combat) and §31 (a learned value function), not more
iterations of what is here.

`DEFAULT_PILOT_ID` **stays `heuristic`** — the hybrid is ~1400× the heuristic's per-decision cost, and
re-defaulting is a separate decision that needs a gauntlet-wide throughput case, not a head-to-head win.

⚠️ **A methodological finding for the Lab, worth knowing before anyone tunes a deck.** Running the whole
gauntlet with `--pilot hybrid` (both seats) moved Mono-Red Aggro's win rate from **32.9% → 19.0%**. That
is not a pilot bug and it is not a strength claim: when *both* sides play better, the aggro deck's edge
against the field shrinks, because a large part of it was punishing weak blocking. **Deck verdicts are
pilot-relative.** An A/B swap result is a statement about that card *at that level of play*.

⚠️ **Two budget policies, deliberately not unified** (`SearchBudget`). `simulations` is deterministic and
is the **only** kind the Lab's evaluation path may use; `millis` (`PLAY_HYBRID_CONFIG`) is for interactive
play only. A wall-clock budget makes the search machine-dependent and destroys the common-random-numbers
property the paired A/B verdict rests on — the same trap `MctsConfig.maxDecisionMillis` documents. Pinned
by a test.

### 3.4f The pilots could not see the board — ✅ fixed  *(the highest-value known correctness bug)*
`packages/ai/src/board-stats.ts`. Core's stat accessors take an `AggregatedMod` that **defaults to
"nothing modifies this"**. In core that default means "I have already established no modification can
apply". In `packages/ai` it meant nothing of the kind: ~40 call sites simply never passed one, so every
pilot evaluated the **printed card**.

What that cost, all of it live on `main` until this branch:
- a **characteristic-defining `*` P/T evaluated as 0/0** — a Tarmogoyf was the least threatening object
  on the board to every pilot, because its real numbers arrive ONLY as `AggregatedMod.basePower` (§3.11);
- **every anthem was invisible** — a pilot with a lord out attacked, blocked, traded and priced removal
  on numbers its own board had already changed;
- **Auras and Equipment were invisible the same way**, so the whole attachment seam was unseen by
  evaluation, including the pilot's own decision about which creature should carry a sword;
- **granted keywords were read two different ways**: the rules path read the granted set, while the AI's
  `canBlockByEvasion` read `def.keywords`, so the pilot proposed blocks the engine then rejected.

**The fix is a seam, not 40 edits.** `board-stats.ts` wraps the accessors with the index **required**, the
package no longer imports the bare-defaulting ones at all, and `bare-stats.test.ts` reads the package's
own source and fails the build if a single-argument call reappears. That is the repo's standing
discipline — make the wrong thing unspellable rather than remember not to spell it — applied to the one
accessor that silently lies. One `ContinuousIndex` is built per decision and threaded; `tactical.ts`'s
`index` parameter and `assessPosition`'s went from optional to **required**, which is what closed the
evaluator's own "no continuous index, deliberately" hole.

**Guards that FAIL on the old behaviour** (`packages/sim/src/pilot-quality.test.ts`, verified red against
a separate `origin/main` checkout and green here): removal is aimed at the creature an anthem made
biggest rather than the biggest printed one; a `*` P/T creature is valued above zero; a 4/4 does not
attack into an anthem-boosted 3/3 that is really a 6/6. The third carries an explicit precondition that
the engine offered the attack at all — without it, "declared no attackers" and "was never offered one"
are the same observation, which is the recurring failure shape in this repo.

⚠️ **MEASURED: MORE CORRECT, NOT MEASURABLY STRONGER — and it ships anyway, because it is a bug fix.**
Fixed heuristic vs the OLD heuristic head to head, one process, seat and play rotated, paired seeds, the
old pilot loaded from a separate `origin/main` worktree built at the same commit: measured at
origin/main `8152d7f`, before this branch merged the indestructible/menace-blocking work that
landed after it — that work touches both arms' successors equally and is not in either arm here.

| matchup | n | fixed wins | 95% CI |
|---|---|---|---|
| Mono-Red Aggro vs Boros Aggro | 3,000 | **50.5%** | [48.7%, 52.3%] |
| Mono-Green Ramp vs Rakdos Goblins | 3,000 | **51.3%** | [49.5%, 53.1%] |
| UW Control vs Golgari Midrange | 3,000 | 47.8% (129 draws) | [46.0%, 49.6%] |
| **pooled** | **9,000** | **49.9%** | **[48.9%, 50.9%]** |

The pooled interval **straddles 50%**: on this card pool the fix is worth nothing measurable. Read the
control row with §3.4e's warning in hand — `winRate` is wins/**games**, so its 129 timeout draws count
against the challenger; on **decisive games only that matchup is 1,435–1,436, i.e. 49.98%**. Nothing here
says the pilot got worse.

That is not surprising and it is not a reason to hold the fix. This pool contains **no anthem** and few
attachments, so most of what the fix corrects has nothing to act on — the behaviour that does change is
combat tricks, Equipment hosts and granted evasion. The value is that **the moment a pool gains an anthem
or a lord, every pilot and every A/B verdict is already correct**, instead of silently pricing the board
wrong. The repo's own precedent (§3.4d) shipped a more-correct evaluator OFF because it was not stronger;
this one is different in kind — a wrong reading of the game state is a defect, not a tuning choice.

**Baselines re-measured on this branch (2026-08-19), because the fix moves the pilot every one of them
is measured with or against.** Machine note: this box is shared by six agents and its wall clock drifts
~2× between runs, so the paired ratios below are **CPU time**, and the raw games/sec figures are recorded
only for shape.

| measurement | before (origin/main, same box, same seeds) | after |
|---|---|---|
| Gauntlet, Mono-Red Aggro, 200 games/deck, seed 4242 | 419/1400 = **29.9%** [27.6, 32.4] | 432/1400 = **30.9%** [28.5, 33.3] |
| — its UW Control cell (the biggest single move) | 55/200 = **27.5%** | 65/200 = **32.5%** |
| — its Mono-Green Ramp cell (mono vs mono) | 33/200 = **16.5%** | 33/200 = **16.5%** — unchanged |
| `hybrid` vs `heuristic`, Mono-Red vs Boros, n=120 | **55.8%** [46.9, 64.4] | **55.0%** [46.1, 63.6] |
| `hybrid` vs `heuristic`, UW vs Golgari, n=80 | **48.8%** [38.1, 59.5] | **45.0%** [34.6, 55.9] (4 draws) |

The hybrid rows barely move, and for the reason §3.4a already gives: the heuristic is simultaneously the
baseline the hybrid is measured against **and** the hybrid's own prior and rollout policy, so both sides
of that comparison moved together.

**Throughput (rule 7) — parity, measured three ways because wall clock on this box is worthless.**
- **Allocation** (the machine-independent metric `mcts-bench.mjs` documents — semi-space pinned to 1 MB,
  scavenges counted): **93 scavenges over 60 games vs the old pilot's 96**, i.e. 3.14e-3 vs 3.17e-3
  scavenges per action. The fix allocates marginally **less**, not more.
- **CPU time per decision**, both pilots answering the **identical 4,000 captured positions**, 20
  interleaved passes, three independent runs: **0.978× / 1.009× / 0.990×**.
- End-to-end games/sec, paired and interleaved: within the CPU clock's 15.6 ms resolution of parity.

Parity is not free and was not assumed: the first implementation built the index at the top of every
decision and a second one inside `cardValueContext`. Three changes paid for it — the index is built
**after** the three early returns that never read a stat (a parked question, no legal actions, only-pass),
`cardValueContext` accepts a prebuilt index instead of building its own, and the battlefield selectors
(`creaturesControlledBy`, `findInstance`, …) became closure-free indexed loops like the action predicates
beside them.

### 3.4b Tree reuse between decisions — ✅ built, measured, shipped OFF  *(brief §21–22)*
The hybrid used to throw its whole search away after every macro. It can now **re-root onto the tree it
built last time** instead. It is implemented, tested, and instrumented — and the honest headline is that
**it did not make the pilot play measurably better, and at the same budget it makes every decision cost
appreciably more**, so `DEFAULT_HYBRID_CONFIG.reuse` ships **off**. Pinned by a test. `packages/ai` only.

**The match is by POSITION, not by action, and that is forced rather than stylistic** (`tree-reuse.ts`).
`Pilot.chooseAction` is called only when *we* hold priority, so a pilot **could not observe the
opponent's actions at all** — §22 ("reuse after opponent actions") was not implementable on action
matching. (That gap is now closed by the observation seam, §3.4c, but position matching remains the right
mechanism here and tree reuse is unchanged: the seam reports *events*, not the opponent's chosen
`GameAction`, and the reasons below are independent of it.) Nor does a pilot know how many engine actions passed: forced
windows are compressed away inside the search, our own macros span several plies, and a committed macro
can be abandoned half-way. So each node records a 64-bit `fingerprintPosition` of the whole game state
and the live position is looked up in the retained tree. Our move, the opponent's moves, and any run of
forced actions in between all reduce to "the position moved from here to there".

`actionEquivalenceKey` is the **wrong** key for that and the **right** key for the job it already does.
It answers "are these two offered actions the same DECISION", which is what collapsing five
interchangeable Islands needs — and it deliberately merges actions whose *states* differ. It is still used
to line a retained edge up against the freshly-derived candidate list, which is the same question asked
*within one position*.

**Determinism — the property the Lab's paired A/B verdict rests on.** Reuse makes a decision depend on
what the pilot searched earlier, which is safe here for a structural reason, not a careful one:
`GameState.seed` is mixed into the fingerprint and the retained tree records its deciding seat, so a tree
can only ever be reused **inside the one game and the one seat it was built in**, where the whole
sequence of positions is itself a function of the seed. That matters because every real consumer builds
ONE pilot and runs many games through it, and the Lab shards the game grid across workers by range — a
tree that survived a game boundary would make a verdict depend on the worker count. Three tests pin it,
including "a pilot that already played two other games plays this one byte-identically".

Statistics are inherited **as they stand** (`decay: 1`); visits and reward would decay together so a mean
is preserved and only confidence shrinks, and `decay: 0.5` finished one game apart over the identical 120
seeded games. Memory is bounded by construction: promotion prunes every sibling subtree, and a retained
tree over `maxNodes` is dropped whole rather than trimmed. Measured peak over full games: **294–353
nodes** against a cap of 8192.

**Measured — HEURISTIC vs HYBRID, same protocol, interleaved arms on identical seeds.** The reuse-OFF arm
**reproduced both recorded baselines exactly** (72/120 and 43/80), which is what makes the comparison
trustworthy. ⚠️ **Both columns are PRE-§3.4e numbers**: they are a comparison of reuse against no-reuse
at a fixed opponent, and the opponent (the heuristic, which is also this pilot's own prior) has since got
stronger. The OFF/ON *comparison* stands; the absolute 60.0% / 53.8% do not — see §3.4a's re-measured
table and §3.4e.

| matchup | reuse OFF | reuse ON | mean decision | p95 | reuse hit rate |
|---|---|---|---|---|---|
| Mono-Red vs Boros, n=120 | **60.0%** [51.1, 68.3] | **60.0%** [51.1, 68.3] | 6.49 → 8.76 ms | 59 → 83 ms | 94.6% |
| UW Control vs Golgari, n=80 | **53.8%** [42.9, 64.3] | **56.3%** [45.3, 66.6] | 10.52 → 16.71 ms | 97 → 136 ms | 95.5% |

The tree is found on ~95% of decisions and carries **217–284 inherited visits** into a 160-simulation
budget, so the mechanism plainly works — the search really is ~2.4× deeper in information. It buys no
measurable strength. That is consistent with §3.4a's own plateau finding (256→1024 simulations was worth
+1.7 points): **this pilot is limited by its evaluator, not by how much it searches**, and reuse only
buys more search.

**What it DOES buy — a cheaper search** (`THRIFTY_HYBRID_CONFIG`). Head to head against the 160-simulation
default over the same 120 games:

| reuse ON budget | vs the default | its share of the default's decision time |
|---|---|---|
| 64 simulations | 46.7% [38.0%, 55.6%] | 44% |
| 96 simulations | 48.3% [39.6%, 57.2%] | 74% |

Both intervals include 50%: at 40% of the budget it is **not measurably weaker** for roughly half the
decision time. Read that as "no measurable loss at half the cost", **not** as "stronger" — the point
estimates sit just under 50%. It is the beginning of the throughput case a search pilot needs before it
could ever become `DEFAULT_PILOT_ID`, which it still does not have.

⚠️ **Why reuse costs more per decision, since it is not obvious:** in-tree engine plies per simulation go
from **56 → 78** (aggro) and **82 → 119** (control). An inherited tree is deeper, and every simulation
re-applies every macro from the root to its leaf, so a deeper tree is a more expensive simulation. The
extra cost is the search going deeper, not overhead — the position fingerprint is computed only for nodes
within `maxDepth` edges of the root and is a small part of it.

Re-runnable: `node packages/ai/bench/mcts-bench.mjs reuse <n>` (interleaved OFF/ON arms on paired seeds,
`BENCH_DECAYS=1,0.5` to re-ask the decay question) and `... reuse-duel <n>` with `BENCH_ON_SIMS=<k>` (the
two arms playing each other, which is the sensitive form of the question).

### 3.4c The pilot observation seam — ✅ done  *(brief §13–17, §32–33, §37 — the unblocker)*
`Pilot.chooseAction` is called **only while that pilot holds priority**, so until now a pilot never saw
the opponent act at all. That single gap blocked the whole imperfect-information half of the program: an
opponent belief model, `P(card in opponent hand)`, "what could they have?", archetype inference and
reading represented mana are all **update rules applied to evidence**, and there was no evidence channel.
There is one now. `packages/sim` owns the channel; `packages/ai` owns the vocabulary.

**The feed is SPECTATOR-LEVEL, not per-seat, and that is the anti-cheat argument.** An `Observation`
carries only what someone standing beside the table holding no cards would know, so there is no seat whose
entitlement could be computed wrongly — and it is therefore projected **once per event rather than once
per seat**. A pilot combines it with the view it is already lent, which contains its own hand, so nothing
a seat is entitled to is lost. Six of core's 41 event types carry a secret and are replaced by narrower
shapes: `gameStart` (**the seed — the whole shuffle**, the least obvious leak in the union and the
worst), `drawCard` (that a draw happened, never which card), `zoneChange` (the instance id survives only
when the card came to rest somewhere **public**), and the three choice events (an effect authors its own
prompt and may name the cards it is asking about — the same reason `@jonny-boi/protocol` redacts it).

**Default-deny, three independent gates.** (1) `OBSERVATION_POLICY` is a mapped type over
`GameEvent['type']`, so a new core event breaks the build until it is classified — the same shape as
`paired-arms-config.ts`'s primitive classification. (2) `'public'` is *unspellable* for the six redacted
types: each redacted shape declares its dropped field as `?: never`, so the raw event is not assignable
to it, and `REDACTION_IS_UNSPELLABLE` in `observation.ts` fails to compile if any of them is weakened
(it lives in shipped source, not a test, because `tsconfig` excludes `*.test.ts` and Vitest does not
type-check — a `@ts-expect-error` in a test file here is evaluated by nothing). (3) The one that actually
proves it: `observation.test.ts` plays real games and scans every delivered observation with
`@jonny-boi/protocol`'s `collectInstanceIds` against the cards **actually sitting in a hand or library at
that instant**. Verified red by sabotage — un-redacting `drawCard` and `zoneChange` each make the scan
name the exact leaked cards.

**Per-game isolation is structural, not a convention.** The seam is `Pilot.createGameObserver`, **not**
`Pilot.observe`: the harness creates one observer per game, hands it back on every `DecisionContext`, and
drops it when the game ends, so a pilot has *nowhere* to put cross-game state. This is load-bearing —
every real consumer builds ONE pilot and runs MANY games through it, and the Lab shards the game grid
across workers by range, so a belief that outlived a game would make a paired A/B verdict **depend on the
worker count**. Pinned by a test that plays a game standalone and again after three other games through
the same pilot and demands a byte-identical transcript.

**Determinism: proved, not asserted.** A sha256 over the FULL chosen-action sequence — **131,524 plies**
across `heuristic`, `random` and `hybrid` on three matchups — is **identical** before and after, all nine
digests. `npm run sim -- gauntlet "Mono-Red Aggro" --games 40 --seed 99` is **byte-identical except the
throughput line**. The seam is optional: none of the four built-in pilots implement it, so `observers` is
`null` and the loop runs exactly as before.

**Cost.** Public events are delivered **by reference**; only the redacted ones allocate. Measured over 20
games: 1,128 events per game, **96.9% passed by reference, 3.1% (35 per game) copied**. Interleaved
in-process A/B of the pre-seam and post-seam harness, 21 rounds × 250 games, alternating which arm runs
first: **paired median 0.989×** — parity, against a per-round spread of 0.79–1.18 that shows why only the
paired median is quotable. With the feed **ON at both seats** (the proof-of-life tracker doing real work
on every observation): **paired median 0.963×**, n=15.

**Proof of life, deliberately not a belief model.** `createOpponentRevealObserver` tallies what the
opponent has publicly revealed this game — cards drawn, lands, spells by name, mana by colour, the
instance ids that have entered public view. It is the *evidence* every §13–17 system consumes, not the
inference. `createRevealTrackingPilot(base)` wraps any pilot with it and delegates the decision unchanged,
which is what lets a test prove observation costs no change in play.

Re-runnable: `node packages/sim/bench/observation-bench.mjs digest | throughput | plain | volume`.

### 3.4d Tactical solver + curated tactical suite — ✅ built, measured, **evaluator ships OFF**  *(brief §11–12, §39, §48)*
`packages/ai/src/tactical.ts` answers three combat questions **exactly** instead of sampling them, and
`packages/ai/src/tactical-suite.ts` is the curated position suite §48 asks for. `packages/ai` only.

❗ **HEADLINE, and read it before turning anything on: the solver makes the evaluator measurably MORE
CORRECT and not measurably STRONGER.** It scores **5/5** on the curated ordering suite against the
default evaluator's **0/5** — including two answers the default gets actively *backwards* — it is free
or slightly cheaper, and on every strength measurement taken it is a wash. So it lands as a named,
tested, exported blend (`TACTICAL_EVALUATION_WEIGHTS` / `TACTICAL_HYBRID_CONFIG`) and
`DEFAULT_HYBRID_CONFIG` is **unchanged, to the byte**. Same shape as §3.4b: the measurement is the
deliverable.

**Why here.** §3.4a and §3.4b both landed on the same conclusion from opposite directions: 256 → 1024
simulations bought **+1.7 points**, and tree reuse ran a search **2.4× deeper in information** (95% hit
rate, 217–284 inherited visits into a 160-simulation budget) and produced **identical play**. Search
depth is not the binding constraint; the leaf evaluation is.

**What the solver computes, and why it is cheap.** Two structural facts collapse the §39 combinatorial
trap so nothing has to be enumerated:
1. **Damage assignment is not a decision in this engine** — `internal/combat.ts` assigns lethal in
   declared order and tramples the remainder. That dimension does not exist.
2. **Block legality is *nested*.** core's `canBlock` refuses exactly one thing: a flier blocked by a
   creature with neither flying nor reach. So the blockers eligible for a flier are a **subset** of those
   eligible for a ground creature, a set of attackers is blockable iff `fliers(S) ≤ evasion-capable
   blockers` and `|S| ≤ blockers` (Hall's condition, two tight sets), and the feasible sets form a
   **matroid** — greedy by damage-prevented descending is exactly optimal, with no matching algorithm.
   Pinned against the real engine by a test rather than by this paragraph.

And the attacker subset is not searched either: adding an attacker adds power on one side and a blocking
constraint on the other, so "attack with everything eligible" maximises guaranteed damage by
construction. The interesting attack question — which subset *trades* best when the kill is not there —
stays with the policy and the search.

⚠️ **Every bound is conservative in ONE direction, deliberately.** Prevention is over-estimated (a
trampler is priced as if every legal blocker could gang up on it; a first-striking blocker that kills it
stops *all* of its damage), so `guaranteedDamage` is a **lower** bound and a claimed lethal is never a
lethal that is not there. It can miss one; it cannot invent one. That asymmetry is what makes it safe for
the pilot to **act** on the answer rather than merely score it (`takeProvenLethal`, the brief's §45
router branch: a proven-unblockable kill is played, not searched).

**Two real defects in the default evaluator that this found**, both pinned in the suite:
- `lethalThreatWeight` fires on *summed untapped power ≥ their life*, which **ignores blockers entirely**
  — 15 power behind three 0/4 walls reads as a kill, and is scored ABOVE a board with 6 genuinely
  unblockable damage.
- Worse, and this one has a sign: **attackers TAP when they are declared**, so the bonus is paid for the
  board that has not swung yet and withdrawn the instant it does. The default evaluator scores **taking a
  proven kill (0.9047) BELOW declining it (0.9399)**. The solver reads the *declared* attackers once
  combat has begun, so the signal is stable across the step.

**The four new terms**, each a named weight, each zeroable, all zero by default: blocker-aware
`lethalThreatWeight` (`useTacticalLethal`), `facingLethalWeight` (the evaluator has **no** term of any
kind for being dead on board — the §11 anti-lethal / §12 opponent-threat question, and the term that can
see a player tapping out into a lethal crack-back), `pressureWeight` (guaranteed-damage differential —
two 0/6 walls and two 3/3s are the same 12 points of `boardWeight` and are not the same board), and
`clockWeight` (§10 inevitability, saturated at `TacticalConfig.maxClockTurns` so a board that cannot
break through is "slow", never infinite).

**Measured — interleaved arms in one process, paired seeds.** The control is the shipped default, whose
zeroed weights make it skip the solver entirely, so "before" pays none of the new cost and the
millisecond comparison is as honest as the win rate. The control arm reproduced **both** recorded
baselines exactly (72/120 and 43/80), which is what makes the rest trustworthy. ⚠️ **PRE-§3.4e numbers**,
for the same reason as §3.4b's: the *comparison* between the two evaluators stands, the absolute win
rates against the heuristic do not, because §3.4e made the heuristic stronger.

| measurement | default | tactical |
|---|---|---|
| Mono-Red vs Boros, n=120, vs heuristic | **60.0%** [51.1, 68.3] | **60.0%** [51.1, 68.3] |
| UW Control vs Golgari, n=80, vs heuristic | **53.8%** [42.9, 64.3] | **55.0%** [44.1, 65.4] |
| head to head, Mono-Red vs Boros, n=120 | — | **48.3%** [39.6, 57.2] |
| head to head, UW vs Golgari, n=120 | — | **52.5%** [43.6, 61.2] |
| mean decision, aggro / control | 6.83 / 14.33 ms | 6.70–6.97 / **13.63** ms |
| p95 decision, aggro / control | 56.8 / 114.3 ms | 56.5 / **111.6** ms |

Pooled over the two head-to-head runs the tactical arm is **121/240 = 50.4%** — dead even. Cost is *not*
the reason it ships off; it is free or slightly cheaper on both matchups. The reason is the brief's own
rule: a change that does not measurably help does not become the default.

❗ **The per-term ablation is what makes that conclusion safe rather than lucky.** Each term alone, on the
same 120 seeded aggro games (`BENCH_TACTICAL_ARMS=control,lethal,router,facing,pressure,clock,no-router`):

| arm | wins | mean decision |
|---|---|---|
| control (default, no solver) | 72/120 | 6.83 ms |
| + solver lethal read | 72/120 | 6.74 ms |
| + take proven lethal | 72/120 | 6.70 ms |
| + facing lethal | 72/120 | 6.85 ms |
| + pressure | 72/120 | 6.95 ms |
| + clock | 71/120 | 6.77 ms |
| full eval, no router | 72/120 | 6.97 ms |

**Every arm lands on the identical 72/120.** This is not one good term cancelling one bad one — no term
moves that matchup at all, so there is no winning subset hiding inside the blend.

👉 **The most likely explanation, and it says when to re-ask the question.** The pilot half of the
curated suite showed the same thing directly: on any board small enough to state as a puzzle, a
160-simulation search simply **plays the position out and reaches the terminal**, whatever its leaf
evaluator believes. These terms describe positions near a terminal, which is exactly where the search
does not need help. Re-ask when the SEARCH changes, not when the weights do — a cheaper budget
(`THRIFTY_HYBRID_CONFIG`), a shallower `maxTreeDepth`, or decks whose games are decided further from a
terminal would all move that balance. A learned value function (§31) is the other consumer these terms
were built for.

❌ **THE "SMALLER BUDGET" HALF OF THAT HYPOTHESIS HAS SINCE BEEN TESTED, AND IT IS REFUTED.** Same
protocol, same interleaved arms on paired seeds, control = `DEFAULT_HYBRID_CONFIG` at the same budget:

| budget | matchup | control | tactical |
|---|---|---|---|
| 64 sims (`THRIFTY`) | Mono-Red vs Boros, n=120 | **53.3%** [44.4, 62.0] | 47.5% [38.8, 56.4] |
| 64 sims | UW vs Golgari, n=80 | **48.8%** [38.1, 59.5] | 46.3% [35.7, 57.1] |
| 32 sims | Mono-Red vs Boros, n=120 | **48.3%** [39.6, 57.2] | 45.0% [36.4, 53.9] |
| 32 sims | UW vs Golgari, n=80 | **48.8%** [38.1, 59.5] | 45.0% [34.6, 55.9] |

Pooled: control **200/400 = 50.0%** against tactical **184/400 = 46.0%**. The tactical arm is behind in
**all four** cells — not significantly in any single one, but never ahead, which is the opposite of what
"the evaluator should matter most where the search is shallowest" predicts. Cost is identical to two
decimal places, so this is not a throughput trade either. **"Try it at a smaller budget" is now a closed
line.** What remains open is the other half: re-ask when the SEARCH itself changes, or when a learned
value function (§31) needs these terms as features.

**The curated suite (§48) is a deliverable in its own right, and it has two halves because one was not
enough.** `packages/ai/src/tactical-suite.ts`, run by `tactical-suite.test.ts`:
- **12 pilot puzzles** across lethal · anti-lethal · combat · removal · sequencing · mana, each graded by
  a *predicate over the chosen action* rather than one blessed move (several positions have more than one
  strong line, and a suite that raises false alarms gets ignored). Scores when this section was written:
  heuristic **10/12**, both hybrid arms **11/12**. ⚠️ **§3.4e moved them to 11/12 and 12/12** by fixing the
  land-sequencing puzzle below, so the suite's own "no pilot sweeps it" assertion had to be relaxed — see
  §3.4e. The headroom that is left lives in the evaluator half.
- ⚠️ **The pilot half cannot isolate a leaf evaluator** — see above. So the second half grades
  `evaluateState` **directly**, on **5 position PAIRS** that are both reachable successors of one decision,
  exactly the comparison a search performs when it backs a reward up. There the two evaluators are not
  close: **default 0/5, tactical 5/5**, and the 0/5 breaks down into **three pairs it cannot tell apart at
  all** (identical scores to four decimal places) and **two it orders backwards**.

👉 **The suite immediately caught a live defect nobody had noticed, in the DEFAULT pilot.** Given a
Mountain in play and a Mountain, a Swamp and a `{1}{B}` removal spell in hand, **every** pilot plays the
Mountain and leaves its own removal uncastable for a turn: `heuristic.ts`'s land-drop candidates score
each land on its own merits and never ask what a land *unlocks*. **Not fixed here, deliberately** — that
code feeds the default pilot, so changing it invalidates every recorded baseline in §3.4a and every A/B
verdict measured against them. It was pinned as an explicit "DEFECT (unfixed)" test that would fail the
day someone fixed it. ✅ **Fixed in §3.4e**, which is what that test was for; it is now a permanent
regression test asserting the correct behaviour, and the baselines it invalidated were re-measured there.

**Rule 7 — the heuristic path is untouched by THIS branch, and provably so.** `heuristic.ts`,
`weights.ts`, `card-value.ts`, `effect-value.ts` and `choices.ts` are **byte-identical to `main`**, the
heuristic pilot never calls `evaluator.ts` or `tactical.ts`, and `npm run sim -- gauntlet "Mono-Red Aggro"
--games 40 --seed 99` reproduces the recorded **92/280 = 32.9%** at 113 games/sec — inside the recorded
109–118 band while two benchmarks were running on the same box. The hybrid default is unchanged too: with
the tactical weights at zero the solver is never called, which a test proves by behaviour rather than by
inspection. ⚠️ **That 92/280 is a pre-§3.4e number and no longer reproduces** — §3.4e changed the default
pilot on purpose and re-measured it; see there for the current figure.

Re-runnable: `node packages/ai/bench/mcts-bench.mjs tactical <n>` (interleaved arms; `BENCH_TACTICAL_ARMS`
= `control,lethal,router,facing,pressure,clock,no-router,full` runs the per-term ablation) and
`... tactical-duel <n>` (the two evaluators playing each other, the sensitive form of the question).

### 3.4e Land sequencing — the default pilot plays the land its own spell needs — ✅ done  *(§3.4d's defect)*
`packages/ai/src/land-sequencing.ts`. The `heuristic` pilot scored "play a land" once, at
`weights.playLandScore`, and then took the **first offered** `playLand` action. §3.4d's curated suite
pinned what that costs: a Mountain in play, a Mountain, a Swamp and a `{1}{B}` removal spell in hand, and
**every pilot played the Mountain**, leaving its own removal uncastable for a turn. A land drop is now
scored by what it **unlocks**, and the `DEFECT (unfixed)` test is flipped into a permanent regression
test that every pilot must pass. Suite scores move heuristic **10/12 → 11/12** and both hybrid arms
**11/12 → 12/12**.

**Three terms, all named `HeuristicWeights` fields**, in the order they matter:
1. `landUnlocksSpellWeight` — the `cardValue` of the best spell in hand this land makes payable **and
   that is not payable without it**. Castability is asked of core's own `planManaPayment`, given a
   hypothetical battlefield with the land added and the `tapForMana` actions it would offer, so there is
   exactly ONE answer to "which lands fund this" in the repo and the pilot and the search cannot drift.
2. `landFixesNeededColorScore` — a colour the **hand** is asking for that no permanent we control can
   make yet. The future-turn half ("don't strand a colour").
3. `landTaplandFreerollScore` — spend a land that arrives **tapped** on a turn where no land drop unlocks
   anything anyway. ⚠️ This is the **inverse** of what the first draft shipped ("prefer the untapped
   land"), and inverting it is a real finding: preferring untapped is wrong twice over, because term 1
   already covers the only reason to want untapped mana *today*, and holding a tapland does not avoid its
   cost — it defers it onto a turn you do not get to choose. The first draft measured **49.3% of
   discordant games [44.5, 54.1]**, i.e. nothing, which is what prompted looking at it again rather than
   leaving it in on plausibility.

❗ **ALL THREE SHIP ON — AND THE NEAR-MISS THAT ESTABLISHED THAT IS THE MOST TRANSFERABLE THING IN THIS
SECTION.** On Boros vs Orzhov the unlock term ALONE measured better than the blend (52.6% of discordant
games [50.2, 55.1], which excludes 50%, against the blend's 50.9% [48.6, 53.1], which does not). That is
a clean-looking, well-powered case for zeroing the other two, and it was written into the defaults for a
while. Re-running the same comparison on UW vs Golgari **reversed it exactly**: blend 52.0%
[50.6, 53.3], unlock alone 50.9% [49.4, 52.5]. Picking the default from the first matchup would have been
choosing the best of four arms on one sample — the garden-of-forking-paths error, at n=40,000, which is
large enough to feel authoritative and not large enough to be. **Pool the two and neither is separable
from the other**, so the default keeps all three terms and this paragraph keeps the near-miss.

**The best land keeps exactly `playLandScore`; only worse ones are discounted.** That shape is
deliberate and load-bearing: it reorders lands against **each other** (the defect) and leaves
land-versus-**spell** ordering — the assumption under every recorded baseline — untouched.

**THE CONTROL ARM IS THIS BUILD, AND THAT IS WHAT MAKES THE MEASUREMENT TRUSTWORTHY.**
`LAND_SEQUENCING_OFF_WEIGHTS` zeroes the three weights, which makes every land drop tie and a tie resolve
to the first offered action — bit-for-bit the pre-fix pilot. Verified rather than asserted: a sha256 over
every action both seats chose, on three matchups and **48,064 plies**, is **identical to the same games
played by a separate checkout of `main`** (`44f56fd0f338b4a8` / `835482945c7f38c8` / `45952cd3f020a54c`).
So both arms run in ONE process on interleaved games, and "did you rebuild the other branch" is not a
failure mode that exists here.

**THE CHANGE IS CONFINED TO DECKS THAT HOLD MORE THAN ONE LAND TYPE, provably.** Mono-Red Aggro (24
Mountains) versus Mono-Green Ramp (24 Forests) produces the **identical digest** with the fix on and off
(`40f2a1b619c0f171`, 10,621 plies), and that deck pair's gauntlet cell is **8/40 in every run before and
after**. Six of the eight sample decks are two-colour with four Guildgates, which is where all of the
behaviour change lives.

⚠️ **A METHODOLOGICAL BUG IN HOW THIS REPO'S HEAD-TO-HEAD NUMBERS ARE READ, found while measuring.**
`headToHead`'s `winRate` is wins / **games**, so a timeout draw counts against *both* sides: an arm that
is byte-identical to its baseline scores **46.4%–49.8%**, not 50%, on matchups that draw. Reading that as
"3 points worse" is exactly the mistake a `none` (self-versus-self) arm exists to stop, and the bench now
ships one, plus a decisive-games-only restatement. Every recorded `hybrid`-vs-`heuristic` number in this
document is a wins/games figure and is depressed by the same amount.

**Measured — PAIRED (McNemar) against the self-versus-self control, same seeded games.** Paired is the
right instrument on a deterministic sim: two arms that differ on a few percent of land drops agree on the
vast majority of games, and only the **discordant** games carry information about which is better.

**THE HEADLINE — the shipped pilot against the pilot it replaces**, paired over **80,000 games** on two
matchups: it wins **3,579 and loses 3,348 of 6,927 discordant games = 51.7%, 95% CI [50.5%, 52.8%]**. The
interval **excludes 50%**, so the fix is a real improvement — and it is a *small* one, worth about
**+0.33 win-rate points**. Both halves of that sentence matter, and the second is why it took 80,000
games to establish the first.

| matchup | n | discordant | share won | 95% CI | win-rate delta |
|---|---|---|---|---|---|
| Boros Aggro vs Orzhov Lifegain | 40,000 | 4.6% of games | 50.9% | [48.6%, 53.1%] | +0.08 pts |
| UW Control vs Golgari Midrange | 40,000 | 12.7% | **52.0%** | **[50.6%, 53.3%]** | +0.50 pts |
| **pooled** | **80,000** | 8.7% | **51.7%** | **[50.5%, 52.8%]** | **+0.33 pts** |

⚠️ **AT n=8,000 THE SAME ARM READ 52.8% ON ONE MATCHUP AND ITS BEST TERM READ 55.4%; BOTH SHRANK.** Five
times the sample pulled them to 50.9% and 52.6%. An effect this size is **invisible at the sample sizes
every other measurement in this document uses** (n=80–120) — worth knowing before anyone tries to detect
a similar change with one.

**Per-term ablation** — each arm is the OFF pilot with exactly one term restored, against the same
self-versus-self control on the same seeds:

| arm | matchup | n | share won | 95% CI |
|---|---|---|---|---|
| `+unlock` | Boros vs Orzhov | 40,000 | **52.6%** | **[50.2%, 55.1%]** |
| `+unlock` | UW vs Golgari | 40,000 | 50.9% | [49.4%, 52.5%] |
| `+color` | Boros vs Orzhov | 8,000 | 54.9% | [48.4%, 61.2%] |
| `+tapland` | Boros vs Orzhov | 8,000 | 50.5% | [41.3%, 59.6%] |

👉 **The unlock term is the one with a mechanism you can point at**, and it is the only arm that has
cleared 50% on its own at a serious sample size. The other two are correct MTG reasoning that has little
to do on *this* pool — 8+8 basics plus four dual Guildgates is already well fixed — and the honest
statement is that they are not separable from zero here, not that they are worthless.

**Other recorded numbers this branch moved** (all re-measured here, none estimated):

| measurement | before | after |
|---|---|---|
| Gauntlet, Mono-Red Aggro, 40 games/deck, seed 99 | 92/280 = **32.9%** | 79/280 = **28.2%** |
| `hybrid` vs `heuristic`, Mono-Red vs Boros, n=120 | **60.0%** [51.1, 68.3] | **55.8%** [46.9, 64.4] |
| `hybrid` vs `heuristic`, UW vs Golgari, n=80 | **53.8%** [42.9, 64.3] | **48.8%** [38.1, 59.5] |

⚠️ **Mono-Red Aggro's gauntlet win rate FELL, and that is evidence the fix works rather than against it.**
Mono-Red is mono-coloured, so its own play is byte-identical — six of its seven opponents are two-colour
and got better at sequencing. Its one mono-coloured opponent (Mono-Green Ramp) is unchanged at 8/40. The
hybrid's margin shrank for the same reason: the heuristic is both the baseline it is measured against and
its own prior. **Neither is a regression, and neither should be quoted as one.**

**Throughput (rule 7) — parity.** Interleaved self-play, 11 rounds × 800 games per arm, on a quiet box,
Mono-Red-Boros / UW-Golgari / Boros-Orzhov: games/sec **1.027× / 0.895× / 0.998×** (median 0.998×) and
µs/decision **1.026× / 0.926× / 1.030×** (median 1.026×). The one arm under parity is the matchup where
the fixed pilot also plays **3.3% longer games** (19,071 vs 18,462 plies over the same 20 games), so part
of that column is more game, not slower code. ⚠️ Single-round runs of the identical builds read
**0.76×–0.88×** while other work shared the box — the ±19% drift this repo documents, and a reminder that
a one-round "interleaved" run is a sequential run wearing a hat.

**Rule 7 — the first implementation WAS a throughput regression, which is why the filter exists.**
Asking `planManaPayment` once per spell in hand per candidate land measured **0.80× gauntlet
throughput**. Every spell now passes a NECESSARY condition first (`couldPay`: the total fits, and no
colour is demanded more times than the board could ever make it) — pure arithmetic over dense per-colour
ceilings, which can only remove planner calls whose answer was already known, never change one. Two
further gates keep the common case free: the scorer runs **only when two genuinely different lands are on
offer**, and the hypothetical board is not built until a spell survives the filter.

Re-runnable: `node packages/ai/bench/mcts-bench.mjs land-sequencing <n>`, with
`BENCH_LANDSEQ_ARMS=none,full,unlock,color,tapland` for the per-term ablation.

### 3.5 Sim harness + statistics — ✅ done
Headless `runMatch`/`runMatchup`/`runGauntlet`; win-rate with **Wilson confidence intervals**; the **A/B
single-card-swap** test (paired / common-random-numbers + **McNemar's test**) that returns a significance
verdict ("card X is better/worse/inconclusive at N games"). Reporter registry (§2 seam), sample-deck data
gauntlet, and the `npm run sim` CLI (`decks`/`match`/`gauntlet`/`swap`). Provisional pending §3.9 fidelity.

### 3.6 Suggestion engine — ✅ done
Given a deck + the gauntlet, propose candidate single-card swaps, evaluate each via the sim, and rank by
win-rate delta + significance. The signature "make my deck better" loop. `suggestSwaps(deck, options) →
SuggestionReport`: generates legal candidates (focused or bounded-auto top-K by a cheap color/curve
heuristic), evaluates each through the §3.5 paired `evaluateSwap` (common random numbers + McNemar, reused
not reinvented), and ranks proven-better → inconclusive → proven-worse (by delta, then p-value). Honest
coverage (capped/illegal candidates recorded, no silent truncation), deterministic per seed, throughput
instrumented, and the §3.9 provisional caveat carried through. CLI: `npm run sim -- suggest <deck>
[--games N] [--cut "Card"] [--max-candidates K] [--pilot id] [--history <file>] [--no-adaptive]`.
*The search is now adaptive, progressive and parallel.* Successive halving (`suggest-schedule.ts`)
scouts every candidate cheaply, then halves the field and doubles the budget so only finalists reach
full depth; the base arm is played ONCE for the whole run and variant games that provably could not
differ are not replayed (`paired-arms.ts`); verdicts are Holm-corrected over every candidate ever
tested on the deck; and a run returns a plain-JSON record that makes the NEXT run explore new ground
instead of repeating the shortlist (`suggest-history.ts`). Because that search is **stateful across
candidates**, it is exposed as a *generator* (`driveAdaptiveSearch`) plus a resumable arm runner
(`PairedArmRunner.playSlice` / `baseRecordAt` / `PairedArmsOptions.baseRecords`), so the headless
engine drives it inline and the Lab drives it over a worker pool from the SAME elimination rule.
Measured on Mono-Red Aggro vs the 7-deck gauntlet at 24 candidates / 60 games per finalist:
2,438 games instead of the fixed sweep's 20,160 — **8.3× fewer games, 6.8× less wall-clock** headless.

### 3.7 Web PWA — deck builder + card browser + lab + match viewer — ✅ done
Professional React/Vite UI: browse cards (Scryfall art), build/edit decks, run the gauntlet and see
win-rate deltas, accept suggestions, watch/replay a match from the event log. Installable PWA (offline
shell), responsive for phone + desktop.
*Foundation landed:* a polished card browser (real Scryfall art, search/color/type filters, mana-value
sort, detail view) and a deck builder (4-of rule, type-grouped list, mana-curve chart, localStorage
persistence, sim-compatible JSON import/export).
*The Lab landed:* an in-browser Lab view running the sim in a **dedicated Web Worker** (cancellable,
with live progress + games/sec, never freezing the main thread): pick a saved deck as the hero (sim
`validateDeck` gates illegal decks with a guided message), choose gauntlet opponents, then run a
**gauntlet** (per-opponent win-rate + 95% CI bars + overall), the signature **A/B single-card-swap**
test (BETTER/WORSE/INCONCLUSIVE verdict with base→variant win-rate, delta, McNemar p-value, paired 2×2
table), and ranked **suggestions** (tunable games-per-candidate + max-candidates, honest
evaluated/total + capped/illegal coverage), with the §3.9 provisional caveat surfaced near every
verdict and a fixed/editable seed for reproducibility. Build stays installable (PWA artifacts emitted;
the sim ships in the worker chunk, off the main bundle).
*The Lab runs on every core.* `lib/sim/` plans a request into shards, spreads them over a pool of
long-lived workers (`browserPoolWorkerCount()`, `?simWorkers=N` to override), and merges the results
in canonical order. Pool size can never move a verdict — `determinism.test.ts` pins every run kind
byte-identical at 1 worker and at 12, unaffected by completion order, and equal to the sim's own
single-threaded function. Shards are the sim's functions with a `RunRange`, not copies of them.
The **suggestions** path drives §3.6's adaptive search *round by round with a barrier*: each round
plays the shared base games for the slots it newly needs, joins, plays every surviving arm's variant
games (cut by slot range, so a two-survivor final round still fills the machine), joins, and lets the
sim decide who survives. Cross-run history is persisted per deck in `localStorage`, keyed by the
record's deck fingerprint **and the pilot that played it** (§3.7a), and surfaced ("Run 3 · 26 candidates
carried over", with a Reset); a record from another decklist, another pilot, or an older version is
rejected with a reason on screen.
*The match viewer landed:* a **"Watch a Game"** surface plays ONE traced AI-vs-AI game in the sim
Web Worker (new `match` protocol request; `runMatch(..., {recordTrace:true})` composed with the same
core primitives to capture a serializable per-action board snapshot) and replays it with a
**timeline scrubber + Play/Pause/Step/Restart + named-config speeds**: both players' life totals,
turn/phase, each board (permanents with effective P/T + tapped/summoning-sick state), hand/library/
graveyard counts, and a scrolling event log built from one shared event→text formatter. Key moments
(a creature dies, a player crosses into lethal range, the winner) are marked on the scrubber. The pure
event→state fold, the formatter, and the playback config are unit-tested; long games are capped with an
honest truncation note; an illegal deck / worker error lands in a friendly state, never a blank screen.


### 3.7a Pilot-relative verdicts — the pilot is part of every result — ✅ done
**The problem, stated plainly:** every win rate, swap verdict and suggestion this app produces is a
measurement of a deck *as played by one pilot on both seats*. It is not a property of the deck. §3.4a
measured how large that is — running the gauntlet with `hybrid` on both seats moved Mono-Red Aggro from
**32.9% → 19.0%**, because when both sides block better an aggro deck loses the edge it got from
punishing weak blocking. Both numbers are correct; they answer different questions. Until now the UI
presented them as if they were absolute, so a user could change the pilot and get a different verdict
with nothing on screen explaining why.

*Recorded.* `pilotId` is a **required** field on every `SimRequest` and is echoed on every
`SimResultPayload`; it rides in the `ShardContext`, so every shard of a run is played by the same pilot
and a worker resolves it through `@jonny-boi/ai`'s registry (an unknown id fails loudly instead of
falling back to the default). Replay traces record it per seat.

*Shown.* A pilot picker sits in the Lab's config bar beside the hero and the seed — because it changes
what the numbers MEAN, not merely how long they take — with the options and their measured relative cost
derived from `SELECTABLE_PILOT_IDS` (never a second hand-kept list). Every finished result carries a
provenance stamp above it, present for the default pilot too. Changing the picker clears the result, the
same as changing the hero.

*Priced before the run, not after.* The hybrid pilot is ~1400× the heuristic's cost, so the identical
gauntlet is seconds or an hour depending on one dropdown. Each panel shows its own planned game count and
an honest wall-clock estimate next to the Run button *before* it is pressed
(`estimateRunSeconds`, calibrated from a real in-Lab measurement: 700 games at 192 games/sec on eleven
browser workers). An unmeasured pilot reads "run time not measured" and is treated as costly — unknown is
not the same as cheap.

*Refuses to mix.* ⚠️ The suggestion engine's cross-run record accumulates evidence and its `candidates`
list is the **Holm–Bonferroni family** every verdict is corrected against, so pooling two pilots' runs
into one record would be statistically invalid twice over: a candidate one pilot settled as "not better"
would be skipped under a pilot that would love it, and the correction would cover a family mixing tests of
two different hypotheses. `localStorage` records are therefore **partitioned by pilot**, not invalidated —
switching the picker starts a fresh search and leaves the other pilot's exactly where it was, with a line
on screen naming what is kept ("Kept separately: Heuristic (3 runs). Switch pilot to resume."), because a
partition the user cannot see is indistinguishable from a deletion. Records written before the pilot was
selectable carry no pilot; they were all played by `DEFAULT_PILOT_ID`, so they are adopted into its slot
and re-filed rather than dropped, and the old key is only removed once the new one holds the record.

### 3.8 Meta-deck gauntlet content — ✅ done
**Eight** curated, distinct 60-card meta decks (data) define the baseline gauntlet, each a
well-constructed archetype built only from fully-supported pool cards (no fully-stubbed card is a deck's
core): Mono-Red Aggro (burn), Boros Aggro (removal-backed beatdown), Rakdos Goblins (swarm), Izzet
Prowess (spell-velocity go-wide), Golgari Midrange (discard + removal attrition), Orzhov Lifegain
(lifelinking fliers + premium removal), Mono-Green Ramp (resilient midrange), and UW Control (removal +
counters + a flying finisher). Each passes `validateDeck` (legal size, 4-of, pool membership) and is
registered in `SAMPLE_DECKS`.

The gauntlet was **retuned** after the engine-correctness wave (livelock fix, faithful Brainstorm / Path
to Exile / Cryptic Command, target restrictions): the old lists were calibrated against a game that was
quietly easier, and their spread had drifted to ~26%–75%. A heuristic-pilot round-robin (60
games/matchup) now spans **~37%–60%** with no runaway deck, every list holding both a good and a bad
matchup, and a **1.6% timeout-draw rate** (a high rate means games aren't finishing and the numbers are
junk). `gauntlet-health.test.ts` pins those usability properties. The decks double as the swap-candidate
baseline the §3.6 suggestion engine tunes against.

### 3.9 Core engine v2 — triggered abilities + continuous effects — ✅ done  *(quality gate for trustworthy sims)*
The §3.1 MVP resolves spells/ETB scripts only. To faithfully simulate real meta decks it needs: a
**triggered-ability system** (ETB/attack/cast/death triggers → the stack), a **continuous-effects / "until
end of turn" layer** with proper cleanup-step expiry (so `pumpUntilEndOfTurn` and similar wear off — current
behavior persists the buff and biases combat sims), and later **planeswalkers** (✅ landed — see §3.11),
**transform/DFC**, and
**dynamic P/T** (e.g. Tarmogoyf — ✅ landed as characteristic-defining P/T in layer 7a; see §3.11).
Tracked here because §3.2 cards stubbed these mechanics against the MVP.
Prioritize triggers + EOT-expiry before leaning on §3.5/§3.6 verdicts; the rest can follow.

### 3.10 Hotseat pass-and-play — two humans, one device — ✅ done
A **"Play"** surface where two people play a full game of MTG on one device, taking turns at the
keyboard. Built entirely on top of the existing pure core (drives `applyAction`/`generateLegalActions`
on the main thread — no worker), it adds **no rules of its own**: a thin immutable `GameSession`
controller (`lib/play/session.ts`) wraps the engine, exposes the priority-holder's legal actions, and
offers client conveniences that decompose into legal engine actions (auto-tap-to-pay a cast; London
mulligan bottoming). Setup picks two decks (saved decks and/or the six `SAMPLE_DECKS`), validated with
the sim's `validateDeck` (illegal deck → friendly structured message, never a throw). A
**`SeatTransport` seam** (`lib/play/seat.ts`) abstracts who controls a seat and when a handoff is
needed, so the SAME UI can later host online play (a networked transport would gate `localControls` to
the peer's own seat and drop the handoff). Hidden information is enforced at one chokepoint — the
`buildBoardView` view-model masks the opponent's hand to a count — and a **pass-the-device handoff
screen** covers the board between turns so no secret leaks. Targeting is inferred from card effect
primitives (data table, not per-card code): lands, creatures, burn-with-target, combat (declare
attackers/blockers), instant-speed responses on the stack, and a winner. The session controller,
targeting, deck setup, and hidden-info masking are unit-tested, including a full game driven to a
winner through the public session API (proving the loop has no dead-end).

### 3.11 Deck import + the Oracle-text card compiler — ✅ done
Getting a real deck into the app is now one paste. The **Import deck** dialog in the deck builder
accepts a decklist in any mainstream export flavour (plain, MTG Arena with set + collector number,
Moxfield foil markers, Archidekt categories, `SB:` sideboard markers, CSV from Deckbox/Delver Lens,
and the app's own deck JSON), a **deck URL** (Moxfield / Archidekt / MTGGoldfish / TappedOut), or a
dropped/chosen file. One parser (`apps/web/src/lib/decklist/parse.ts`) backs both this and the
Proxies view, so a format learned once works everywhere.

The part that makes imported cards *real* is the **Oracle-text compiler** (`packages/cards/src/compile`):
a data-driven rule table that turns a Scryfall card's printed rules text into a genuine
`CardDefinition` built from registered effect primitives — cost, types, P/T, keyword flags, mana
production, triggered abilities and spell scripts. Its contract is strict: a card either compiles to
something the engine plays **exactly as printed**, or it is reported `incomplete` with the precise
clause and the engine system it would need. Nothing is approximated, because a card that "sort of"
works would silently bias every §3.5/§3.6 verdict. Compiled cards join the pool through the
`loadCardPool({ extraCards })` seam and persist locally, so an imported card browses, builds,
validates, prints and plays exactly like a curated one.

Ground truth: the compiler is tested by re-deriving all 32 hand-authored pool cards from nothing but
their real Scryfall text and asserting it independently reaches the same definitions — and by
asserting it reports `incomplete` for every card the humans flagged in `STUBBED_MECHANICS`.

**Engine gaps this surfaced** — the honest to-do list. Two are now closed:
- ✅ *colour/colour hybrid costs* — `ManaCost.hybrid` + an exhaustive payment search. Kitchen Finks
  carries its real `{1}{G/W}{G/W}` instead of the `{1}` the pool used to cheat with.
- ✅ *permanents entering tapped* — `CardDefinition.entersTapped`, honored on every battlefield-entry
  path. (Only the unconditional printed form; conditional/pay-to-untap variants need player choice.)
- ✅ *mana abilities that produce a chosen colour* — closed separately by `producesOptions` (§3.4
  play-quality work), which also fixed Birds of Paradise tapping for five mana.
- ✅ *player choice during resolution* — closed end-to-end. `GameState.pendingChoice` parks a typed
  question and an `answerChoice` action resumes the resolution; four composable kinds (`selectCards`,
  `selectPlayers`, `chooseModes`, `confirm`) cover modal spells, targeted discard, "you may" and
  library search. Deliberately **serializable state, not a callback**, so the same mechanism serves an
  AI pilot, a hotseat human and a network peer: the AI answers by valence (`gain`/`loss` — on a forced
  choice it sheds its *worst* card), the hotseat UI renders a prompt, and the server relays it as a
  per-seat-masked `pendingChoice` (protocol v2 — the non-chooser gets a summary with no candidates,
  because Thoughtseize's candidates ARE the opponent's hand). Brainstorm, Ponder, Thoughtseize,
  Eternal Witness, Cryptic Command and Path to Exile now play as printed.
- ✅ *library search* — closed with the above (`searchLibrary`, filtered, optional, with a seeded shuffle).
- ✅ *targets chosen by a triggered ability* — "when ~ enters, **it deals 2 damage to target
  creature**" (Flametongue Kavu). The first question this engine asks with **nothing resolving**:
  targets are chosen as the ability is put on the stack (CR 603.3d), where there is no resolution
  frame to park a question in. So the waiting is a marker on the STACK OBJECT
  (`TriggeredStackObject.awaitingTargets`) rather than a bookkeeping record beside it — "is anything
  still waiting to be aimed?" is then answered by the stack itself and cannot drift out of step with
  it, the same reason state-based actions are derived from the board. `TriggeredAbility.targets`
  declares what may be chosen (a property of the ABILITY, not of a primitive: the same `dealDamage`
  ref is targeted here and untargeted in "deals 2 damage to each creature"), and the compiler sets it
  from the printed body. Three outcomes, all rules-mandated: **no legal target** removes the ability
  from the stack unresolved; **exactly one** is taken without stopping the game (one lawful aim is not
  a decision); **two or more is always asked** — auto-picking there is exactly the shortcut that makes
  a card report as playable and then aim itself the moment a board grows a second creature. The pilot
  aims by pricing the ability's own effects against each candidate (`valueOfEffects`), which is what
  lets one rule point damage at the opponent's board and a pump at its own.
- ✅ *optional payment during resolution* — "counter target spell **unless its controller pays {3}**"
  (Mana Leak, Force Spike, Miscalculation). A fifth choice kind, `payMana`, rather than a `confirm`
  with the cost written into the prompt: the engine has to know the cost to decide whether paying is
  possible at all, and to spend the mana itself. Three consequences worth knowing:
  **(1) the engine pays, not the effect** — a resolving effect is re-run from the top whenever it asks
  a further question, so a primitive that paid for itself would pay again for every later ask; the
  charge happens once, in `applyAnswerChoice`, and what the effect is then told is what actually
  happened. **(2) a player who cannot pay is never asked** — affordability is `canAffordManaCost`
  (pool + everything still untappable, via the same `planManaPayment` that funds a cast), and an
  unaffordable payment is a trivial choice the engine settles itself, so the clause never stops a game
  nobody could have paid in. **(3) which lands get tapped is delegated, deliberately** — rule 605.3
  lets a player activate mana abilities to pay during resolution, and the shared planner picks the
  least-flexible source, exactly as it does for a cast. The *decision the card prints* is modelled in
  full; the sub-decision of which Island is the planner's, in one place, for every seat.
  The pilot holds a soft counter like a hard one and prices it by asking whether the victim can pay
  (`softCounterPayableFactor`); the hotseat prompt renders "Pay {3}" / "Don't pay".
- ✅ *shocklands — a pay-life price on entry* — "As ~ enters, you may **pay 2 life**. If you don't, it
  enters tapped" (Blood Crypt and the cycle; both templatings). A sixth choice kind, `payLife`, kept
  separate from `payMana` for the same reason `payMana` is separate from `confirm`: the engine charges
  the price, so it must know it — the life is deducted once, in `applyAnswerChoice`, re-checked against
  the live total (CR 118.4: down to exactly zero, which is legal, the player's call, and promptly
  lethal via the SBAs). The price is a DECISION, not a board fact, so it lives in its own
  `CardDefinition.entersTappedUnlessLifePaid` rather than `entersTappedUnless` — and `entersTapped`
  answers TRUE for it, so **every entry path that does not ask produces the unpaid default (tapped),
  never a free untapped shockland**. Two paths ask and override with the answer: `applyPlayLand`
  (a question asked with nothing resolving; the land is on the battlefield while the question stands,
  its tapped event deferred until a decline confirms it) and a fetch effect's
  `searchLibrary → battlefield` (asked mid-resolution through `ctx.payLifeOrDecline`, before anything
  moves). A player who cannot pay is never asked. The pilot pays while the remaining total stays above
  its existing `desperateLifeThreshold`; the hotseat prompt renders "Pay 2 life" / "Enter tapped".
  Compiling the cycle also fixed rule 305.6 fidelity: a land with TWO basic land types now offers a
  choice of one mana per tap (`producesOptions`), not both at once.
- ✅ *target restrictions* — a card narrows its own aim with the reserved `targets` param
  (`'any'|'creature'|'player'|'spell'`), enforced at offer, at cast, and again at resolution. A
  fidelity audit of all 156 definitions found **19 cards that did not play as printed** and fixed them:
  Lava Spike and Flame Slash were unrestricted damage, Absorb/Dismiss were castable into an empty stack
  (a free cantrip), fifteen removal/pump spells were castable with no legal target, and Monastery
  Swiftspear's prowess missed every noncreature spell that wasn't an instant or sorcery.
- ✅ *auras + equipment (attachment)* — ONE relationship, not two systems. `CardInstance.attachedTo`
  plus `CardDefinition.attachment` (a host filter, a `PermanentModification`, and what the state-based
  actions do when it is not legally attached) covers both printed forms; they differ only in HOW they
  attach — an Aura's spell script vs an `Equip {N}` activated ability — and in `whenIllegal`
  (CR 704.5m an Aura dies, CR 704.5n an Equipment falls off). The grant is **derived, never stored**, so
  it is aggregated by the same `indexContinuous` pass as anthems and until-EOT pumps and layers with
  them additively; the SBAs handle host-left-play, illegal-host and attached-to-nothing in one predicate
  (`isLegallyAttached`). `Equip` needed one new target restriction, `'creatureYouControl'`. The compiler
  reads "Enchant creature", "Enchanted/Equipped creature gets …", and "Equip {N}", and the heuristic
  pilot casts Auras on a sensible creature (its own for a buff, the opponent's for a shrink) and
  activates Equip, funding it through the same `planManaPayment` a spell uses.
  ✅ **In the curated pool** — 14 Auras + 14 Equipment, so the seam is reachable from the deck builder,
  the Lab's suggestions and every sim, not only through the deck importer. They came in as a DATA edit
  (names → `packages/cards/data/expansion-candidates.json` → `build-expansion.ts` → a data-tools
  re-fetch → the web card-index regeneration); nothing was hand-written into either index.
  `attachment-cards-in-pool.test.ts` plays the shipped definitions with the real pilot and asserts a
  floor on how many of each form the pool carries, so it cannot silently regress to the empty state it
  started in. The colour spread is W/U/B/R/G plus colourless Equipment (playable in any deck).
  ⚠️ Green has **no mono-green Aura in the pool and that is not an oversight**: essentially every green
  Aura is an umbra (totem armor), a regenerate-granter, or dynamic (`+1/+1 for each Forest`), none of
  which the engine models. Green is served by Unflinching Courage ({1}{G}{W}) and by the Equipment.
- ✅ *source-aware targeting + protection from [quality] + ward {N}* — `isLegalTarget` /
  `legalTargetsFor` and the primitives' resolution re-checks now carry the SOURCE card's definition,
  which is what protection is keyed on. **Protection** enforces all four printed halves against
  sources with the named quality (color from cost pips incl. hybrid, colorless, multicolored,
  artifacts, creatures, everything): can't be targeted (offer + accept + resolution re-check, no
  hexproof-style own-controller escape), can't be dealt damage (combat and noncombat — prevented,
  with a `damagePrevented` event so the log says why a swing did nothing), can't be
  enchanted/equipped (`isLegalHost` + the SBA, so an Aura falls off the moment its host gains
  protection from it), and can't be blocked (`canBlock`). An UNKNOWN source is treated as blocked —
  the same conservative direction as hexproof's unknown caster. **Ward {N}** is raised by the engine
  itself ("becomes the target" is a moment no data trigger can watch): targeting an opponent's
  warded permanent stacks a trigger whose one effect is core's reserved `wardCounterUnlessPaid`
  primitive (a seam convention like `TARGET_RESTRICTION_PARAM`; `cards` registers the
  implementation), which asks the payment through the SAME `payMana` optional-payment machinery as
  Mana Leak — a player who cannot pay is never asked — and counters the spell (or removes the
  targeting ability from the stack) on a decline. Fires on spells, activated abilities and aimed
  triggers alike; never on the controller's own targeting. Granted protection/ward layer through
  the continuous fold (protection lists UNION, ward costs ADD — `mergeKeywordGrant`), and the
  compiler reads `Ward {N}`, `Protection from [quality][ and from …]` and "Target creature gains
  protection from [quality] until end of turn"; non-generic ward costs ("Ward—Pay 3 life") and
  qualities outside the closed table ("protection from Demons") keep reporting. ⚠️ Two deliberate
  limits: an attachment/static may NOT grant ward/protection (the compiler refuses — the targeting
  fast path reads printed keywords when `state.continuous` is empty, and a grant it cannot see
  would be a silently ignored ability), and — matching the long-standing hexproof shape — an
  unrestricted "any target" spell is not policed at cast, so aiming it at a protected creature is
  accepted and fizzles at resolution instead of being refused.
- ✅ *the template-gap pass* — wordings the engine could already play that only lacked a rule-table
  entry, closed as table data plus one 3-line core fix. **Statics/anthems**: "[Other] creatures you
  control get +X/+Y / have KEYWORD" (Glorious Anthem, Fervor) now compiles onto the existing
  `statics.ts` layer via a new `ClauseContribution.statics` field — the layer existed with no
  compiler rule able to reach it, the exact go-wide bias the previous revision of this list called
  out. **Basic-land search**: "Search your library for a basic land card, put it/that card onto the
  battlefield [tapped]" (Rampant Growth) — which also **un-stubbed Sakura-Tribe Elder** (its
  sacrifice-self cost already parsed; only the search body was missing). **Typed regrowth**: "Return
  target TYPE card from your graveyard to your hand" (Raise Dead). **Targeted discard**: "Target
  player/opponent discards N cards" (Mind Rot — the victim chooses, unlike the Thoughtseize form).
  **Targeted draw/lose**: "Target player draws N cards and loses M life" (Sign in Blood; `drawCards`
  gained a `whichPlayer: 'targetPlayer'` mode). **Act of Treason's exact templating** ("Untap that
  creature.") — and its play test exposed that a control change from a resolving SPELL silently
  no-oped (`applyControlChange` read the stealer from the source's battlefield presence; a sorcery is
  never there), fixed by passing the resolving controller as the fallback stealer, with a core
  regression test. Every closure is proven by a real card compiling `'complete'` with pinned params
  AND playing correctly in an engine game (`compile/template-gaps.test.ts`).
- ✅ *casting from a non-hand zone — flashback* — "Flashback {2}{U}" (Think Twice, Firebolt: cast the
  card from your graveyard for that cost; **then exile it**). The design decision that carries the whole
  mechanic: the SOURCE ZONE is explicit end to end. `CastSpellAction.fromZone` names it (omitted =
  `'hand'`), `applyCastSpell` validates against the live zone and pays `CardDefinition.flashback`
  instead of the printed cost, the stack object records `castFrom` (cloned field-by-field — the
  `cloneStackObject` trap is pinned by a test), and every exit from the stack derives its destination
  from that one field via `spellLeaveDestination`: resolution puts the card in EXILE, and a flashback
  spell that is **countered** is exiled too (CR 702.34a — being countered is leaving the stack), which
  `counterSpellOnStack` reaches through the same helper so the two exits cannot disagree. Timing is the
  card's own (a sorcery flashes back only at sorcery speed); a card that left the graveyard in response
  cleanly rejects; the same card cast from HAND still resolves to the graveyard. `generateLegalActions`
  offers the cast (per legal target, pool-funded) exactly as it offers hand casts, and the heuristic's
  `scoredSpellGoals` scores graveyard flashback candidates through the same scorer as hand spells — so
  the hybrid search's policy candidates inherit the consideration and the mechanic is never
  pilot-inert. Only the PLAIN mana-cost form compiles (`flashback-cost` rule); {X}/additional-cost
  flashback stays reported against the cast-cost-modification system. Flashback GRANTED by another
  card is no longer a gap — see the graveyard-grants entry below, which un-stubs Snapcaster Mage.
- ✅ *effects that target and modify cards in graveyards* — the two systems Snapcaster Mage was
  stubbed on, built together because neither is worth anything alone. **(1) Targeting a graveyard
  card.** `TargetRestriction` gained `'instantOrSorceryInYourGraveyard'`, threaded through the
  same three enforcement points every other restriction uses — offered by `legalTargetsFor`,
  accepted (or refused) by `isLegalTarget`, and re-checked by the primitive at resolution, so a
  card that leaves the graveyard in response makes the ability FIZZLE rather than grant into the
  void. Like `'opponent'` and `'creatureYouControl'` it reads "your" off the ACTING player, and an
  absent controller makes every candidate illegal rather than guessed. Hexproof/shroud/protection
  are correctly not consulted: those read "this permanent", and a card in a graveyard is not one
  (CR 110.1). **(2) Continuous effects on non-battlefield cards** live in a NEW list,
  `GameState.cardGrants` (core's `card-grants.ts`) — deliberately NOT the continuous layer, whose
  index is keyed on battlefield permanents, whose statics radiate from battlefield sources, and
  whose orphan-pruning would delete a graveyard grant on sight. A grant is instance-scoped, expires
  in cleanup like any until-end-of-turn effect, and is DROPPED the moment its card changes zones
  (CR 400.7 — a new object) at every zone-move chokepoint, core's and `cards`'s alike. The one
  exception mirrors CR 400.7g and needs no storage: casting on the grant reads the cost at
  announcement, and the exile-on-leaving-the-stack replacement rides the stack object's own
  `castFrom` (`spellLeaveDestination`), so pruning the grant as the card leaves the graveyard
  loses nothing. **The cast path reads printed and granted flashback through ONE accessor**
  (`flashbackCostOf`), so `generateLegalActions`, `applyCastSpell` and both pilots cannot
  disagree about what a graveyard card costs. ⚠️ **Performance**: `cardGrants` is OPTIONAL and
  absent in every game that grants nothing, and every reader and pruning hook starts with the same
  one-property empty check (`hasCardGrants`) that `isLegalTarget`'s fast path uses — measured
  allocation-identical to main (534 vs 533 median scavenges, inside the alloc bench's documented
  ±2) with byte-identical play (30,466 actions / 63,782 events) and a byte-identical seed-99
  gauntlet. **Snapcaster Mage is UN-STUBBED**: flash, the ETB aimed as it goes on the stack, the
  grant priced at the target's own mana cost, the recast, and the exile after it all play as
  printed, and the heuristic pilot casts it, aims it at the BEST spell in its graveyard
  (`valueOfEffects`'s `grantFlashback` entry prices the grant off the card it names) and takes
  the recast it just bought.
- ✅ *cost modification / choice at cast time — {X} costs and kicker* — the cast-time question
  step. Casting a spell with an `{X}` cost or a kicker parks a question with NOTHING resolving
  (the same moment a shockland's pay-life and a trigger's aiming use): a new choice kind,
  `chooseNumber`, for "choose a value for X", and the existing `payMana` for "pay the kicker?".
  Three design rules carry the whole thing. **(1) The engine charges the extra cost, once, as it
  accepts the answer** — `X × xCost` generic mana (or the kicker cost) is paid through the same
  `payManaCostFromBoard` as an optional payment, so the base cost stays in `CardDefinition.cost`
  (X is 0 everywhere but the stack, CR 107.3) and no mana function learned a new symbol.
  **(2) A question with one fundable answer is never asked**: the X range is bounded by what the
  SAME payment planner says the board can produce (`maxAffordableX`), so an unpayable X is never
  on offer, X capped at 0 is recorded silently, and an unaffordable kicker casts the spell
  unkicked without stopping the game. **(3) The chosen values ride the stack object into the
  resolution** (`SpellStackObject.xValue`/`kicked` → `ResolutionFrame` → `EffectContext`), so
  "deals X damage" and "if this spell was kicked" read what was actually paid for — including
  after the spell has left the stack. The waiting lives ON the stack object
  (`awaitingCastChoice`, cleared as each answer is recorded — same argument as a trigger's
  `awaitingTargets`), and `internal/clone.ts` copies all three new fields. The compiler reads
  `{X}` cost symbols into `xCost`, "Kicker {COST}" into `kicker`, and these templates: "deals X
  damage / draw X cards / gain X life" (gated on the cost actually printing {X}), the
  Burst-Lightning "deals M instead" switch (`{ base, kicked }` amounts), and "If this spell was
  kicked, RIDER" (an `ifKicked` branch primitive enqueuing the rider into the same resolution).
  The heuristic pilot scores an X burn at the X this board could fund and answers with the
  maximum affordable; the hotseat/online prompt renders one button per fundable value.
  §3.16 then closed two of this entry's deferrals: MULTIKICKER (the pay-count question) and
  KICKED ETB CLAUSES on permanents (the count now survives onto the instance as `timesKicked`).
  Still deliberately NOT done: X divided among targets, and "where X is …" definitions (those X's
  are not the cast-time X and are refused).
- ✅ *planeswalkers + loyalty* — walkers are real attackable permanents. A walker enters with its
  printed loyalty as COUNTERS (`counters['loyalty']`, `CardDefinition.loyalty`); its `[+N]/[−N]` lines
  compile to activated abilities with a SIGNED `cost.loyalty`, sorcery-speed, engine-enforced once per
  walker per turn (CR 606) and never payable below zero (CR 118.5). Combat gained the GENERIC
  attackable-object seam battles will reuse: `DeclareAttackersAction.attackTargets` maps attacker →
  attacked permanent (gated on `isAttackable`, today = planeswalker), combat damage to a walker removes
  loyalty (CR 120.3c), trample past a walker's loyalty carries to its controller (CR 702.19i), and a
  walker whose attacked object left the battlefield deals no combat damage — the 2017 rules REMOVED
  damage redirection, so none is modelled. 0 loyalty is death by state-based action (CR 704.5i).
  Targeting gained `'playerOrPlaneswalker'` and `'creatureOrPlaneswalker'`; "any target" includes
  walkers. **Liliana of the Veil is un-stubbed** — the +1 each-player discard (APNAP, both answers
  collected before either card moves), the −2 edict (`sacrificeChosen` — the VICTIM picks), and the −6
  pile split (`pileSplitSacrifice`: controller splits, victim picks the pile) all play as printed. The
  heuristic pilot activates loyalty abilities (priced by `valueOfEffects`), diverts attackers to kill a
  finishable walker (never chips one it cannot kill, never over a lethal race), and burns a killable
  walker. NOT built, on purpose: emblems (ultimates that need them stay reported), the legend rule
  (the engine has none for legendary creatures either — walkers get the same treatment), battles.
- ✅ *scry & surveil — looking at the top of a library, and the bottom-of-library placement it
  needed* — "Scry N" (CR 701.18) and "Surveil N" (CR 701.42) play as printed, plus the rider forms
  ("Scry 2, then draw a card") and the enters-the-battlefield form that makes the Temple and
  surveil-land cycles real cards. No new choice KIND was needed: the look is one ordered
  `selectCards` over the top N with `min: 0` and a new `keepOnTop` marker — offering the candidates
  IS the look (the choice travels to its chooser alone), the chosen cards stay on top in the chosen
  order, and every unchosen one leaves (scry to the bottom, surveil to the graveyard). The
  bottom-of-library placement the previous revision of this list named as the blocker is
  `moveOwnedCard`'s existing `'bottom'` position — the same funnel every zone move already used —
  so scry needed no new movement machinery, only the question. Scry asks a SECOND question for the
  bottom order, and only when two or more cards are going down (one is not a decision).
  **Both primitives obey the ask-first-then-mutate contract in full**: every answer is collected
  before a single card moves, which is what makes a parked scry safe to replay.
  ⚠️ **The look is hidden information, and the redaction is the interesting part.** A new
  `cardsLookedAt` event carries a player and a COUNT and nothing else — exactly what a spectator
  sees when somebody picks up two cards — so it is public *as printed*, while the identities never
  leave the choice (whose `choiceAsked` observation was already redacted to an option count). The
  consequences arrive on their own: a surveilled card's `zoneChange` into a graveyard is public,
  a bottomed or kept card's library → library move is anonymised by the existing hidden-zone rule.
  Both primitives are classified LIBRARY_READING in `paired-arms-config` — they read the top of a
  library and BRANCH on what they saw, the same dangerous shape as `revealTopCard`.
  **The AI is not inert and not random**: one documented rule with one weight
  (`scryKeepValueThreshold`) — keep every looked-at card whose `cardValue` clears the bar, bottom
  or bin the rest, survivors best-first because the answer is ordered. That is not arbitrary:
  `cardValue` already prices a land by whether its controller still NEEDS lands, so the threshold
  sitting between `choiceLandValue` and `choiceLandShortValue` makes the pilot bottom lands exactly
  when it is flooded and keep them while it is short — the decision that carries most of a scry's
  real value. It deliberately does not reason about the curve or about what the opponent represents;
  both belong to the searching pilots. The hotseat prompt needed no new component — a keep-on-top
  choice is an ordered card selection, which the prompt already numbers — only its own copy.
  Also closed alongside it: *"Counter target spell unless its controller pays {X}"* (Condescend),
  where the payment asked is the X the caster chose and paid for at cast time, and an X of zero is
  a cost everybody pays, so the spell simply resolves.
- ✅ *characteristic-defining P/T (the star box)* — a creature whose printed P/T is a FORMULA
  (`CardDefinition.characteristicPT`) over the closed derived-count vocabulary. It is applied in
  **CR 613.3 layer 7a**, as the creature's BASE: the continuous layer (which is the only layer
  holding the state a formula needs) computes it into `AggregatedMod.basePower`/`baseToughness`,
  and the stat accessors use it in place of `def.power` — so +1/+1 counters (7d), anthems and
  pumps (7c) all add ON TOP of it, never the other way round. Nothing is stored, so nothing goes
  stale: it re-derives on every read, and a graveyard filling MID-COMBAT changes the creature's
  size before state-based actions run. **Tarmogoyf is un-stubbed** (power = card types among cards
  in all graveyards, toughness that number plus one). ⚠️ The bare `effectivePower(inst)` call —
  no aggregate — answers 0 for a star creature, because a formula is a function of the whole game
  and that accessor holds only the instance. Every RULES path passes an aggregate, and since
  §3.4f **so does every AI path** — `packages/ai` no longer imports the bare-defaulting accessors
  at all, and a test fails the build if one reappears.
- ✅ *turn-scoped fact memory (revolt)* — `core/turn-facts.ts`: a NAMED CLOSED vocabulary
  (`permanentLeftBattlefield` = revolt, `creatureDied` = morbid, `youGainedLife`), not a general
  event query, so the compiler can only pattern-match what it genuinely understands. Fed from the
  engine's emit chokepoint (no new `GameEvent` — every fact derives from events already published),
  stored as two per-player BITMASKS as flat numbers on the state (a nested record cost ~3% of sim
  throughput on the clone path), and cleared as each turn BEGINS, so "this turn" still reads true
  during the previous turn's end step. **Fatal Push is un-stubbed**: its `{ base: 2, revolt: 4 }`
  mana-value switch is read at RESOLUTION, so a permanent leaving in response turns revolt on.
- ✅ *coloured/filtered statics* — the shared `CardFilter` gained `anyOfColors`, read from cost
  pips (hybrid included) by `colorsOfDefinition`, the same reader protection uses, so "white"
  cannot mean two things. Honoured by `matchesCardFilter` itself, so it reaches EVERY consumer
  (statics, library searches, discards, sacrifices, attachment hosts), not just anthems.
- ✅ *the "you may" + trigger-timing pass* — the optional-trigger and trigger-vocabulary families,
  measured against the most-played corpus and closed in `sole`-descending order (193 → 248 playable,
  +55 cards; re-run `coverage-audit.mjs --input <corpus>` to check). What landed:
  **The printed word "you may"** is now one composable wrapper, `mayEffects`: ask, then run the
  nested clause only on a yes. It makes "When ~ enters, you may BODY" the ETB trigger the table
  already knew plus one real question, instead of a primitive per optional card. **The option is
  never assumed** — compiling a "you may" as its yes-half is a different card (a Reclamation Sage
  that MUST destroy your own artifact), so both answers are legal, both are play-tested, and
  `valence` only steers the pilot. It is ordered AFTER the plain ETB rule so a body that implements
  its own option (Eternal Witness's `optional: true`) keeps the rule that knows most about it.
  **Enters-tapped** gained the two remaining board cycles — slowlands ("two or more other lands")
  and battlelands ("two or more **basic** lands", which needed `CardDefinition.basic`, because a
  nonbasic dual prints the same land SUBTYPES and would otherwise be counted as a basic) — and one
  new decision: **reveal-lands** ("you may reveal an Island or Swamp card from your hand"), modelled
  exactly like the shockland, a real confirm raised at land-play time with the same unasked-default
  rule (tapped) and no question at all for a controller with nothing to show.
  **Trigger timing** grew from upkeep alone to draw step, first main phase and end step, as one rule
  over a closed table of step words. **Board-watching triggers** ("whenever a creature you control
  [with power 3 or greater] enters/dies") arrived as two events scoped by the shared `CardFilter`;
  `triggers.ts` stays a pure matcher, with the permanent an event is about resolved by the runtime
  and handed down at most once per event.
  **Filtered tutors**: "search your library for a TYPE card with mana value / power / toughness N
  [or less | or greater], reveal it, put it into your hand" — `CardFilter` gained printed P/T bounds,
  where an ABSENT box matches no bound, so a `*` P/T is never a legal find for "toughness 2 or less".
  Two refusals are load-bearing and deliberate: **"each player's <step>"** still reports (a
  `who: 'any'` trigger would run its body for the source's controller every time, so "that player
  draws an additional card" would draw for the wrong seat), and **"another creature you control"**
  still reports (these conditions have no self-exclusion).
- ✅ *the keyword sweep no longer double-reports Scry / Surveil / Mill* — a **defect**, not a feature,
  and the highest-yield single fix in the census. The compiler runs a keyword sweep after the rule
  table: anything in Scryfall's `card.keywords` it did not consume is reported. The sweep carried
  "already handled" guards for ward, protection, enchant/equip, kicker, flashback and ability words —
  but not for the three keywords this compiler models as effect **primitives** matched by rules
  (`scry-n`, `surveil-n`, `scry-then-effect`, `self-mill`, `target-player-mills`). So Opt's entire text
  compiled and the card was still `incomplete`, on the strength of the word "Scry" being reported
  twice. The guard is shaped like the flashback one and is **evidence-based**: skip the sweep entry
  only when the compiled assembly actually contains the backing primitive — deep-walked, because a
  scry can sit inside an ETB trigger (the Theros temples), inside an activated ability (Castle
  Vantress) or inside another primitive's params. A wording the rule table does *not* match compiles no
  primitive and keeps reporting through its own clause, which is the honest half and is tested as
  such. **Measured: 193 → 227 of the 2100-card most-played corpus (9.2% → 10.8%).**
- ✅ *modal mana with a multiplier* — `{T}: Add three mana of any one color` is five modes of three
  (Gilded Lotus), which `producesOptions` expresses exactly. "One color" is what makes it a choice of
  mode; a free per-mana mix is refused rather than flattened.

Still open, roughly by how often they block a real decklist:
- *aiming a trigger body at the player whose step or turn it is* ("At the beginning of each player's
  draw step, **that player** draws an additional card" — Howling Mine, Kami of the Crescent Moon,
  Font of Mythos). The trigger itself is expressible (`who: 'any'`); what is missing is the
  triggering player riding the resolution the way `xValue` and `kicked` do, so a body can say "that
  player" rather than "the controller",
- ***the mana model itself* — the largest engine lever left in the corpus, and it was mis-filed as
  cheap template data.** Core models a mana source as a fixed list of colour bundles: one tap, no
  stack, no cost beyond the tap, no rider, no condition. Four printed shapes need it to grow, and the
  compiler now names each one instead of calling it "a template we don't recognize yet"
  (**83 sole-blocked corpus cards** between them): an **additional cost** on a mana ability (35 —
  `{T}, Pay 1 life:`, the filter lands' `{R/W}, {T}:`, `{T}, Tap an untapped creature`), a **rider**
  (22 — every pain land and the whole Talisman cycle: "{T}: Add {U} or {B}. ~ deals 1 damage to you"),
  an **activation restriction** (15 — the Verge cycle, Nimbus Maze, Mox Opal), a **spend restriction**
  (4 — Cavern of Souls; the pool records colour, not what each mana may pay for), and **colours derived
  from board state** at activation time (7 — Reflecting Pool, Exotic Orchard; commander identity is
  refused for good). Lands are 24 cards of every deck, so this is the highest card-per-hour engine
  work on the board.
- *alternative and additional costs still open* — **cycling, buyback and madness landed in §3.17**;
  what remains is *suspend*, *spectacle*, *evoke*, an **{X} in a cycling cost** (Shark Typhoon: an
  activation cost has no answer-and-charge step the way a casting cost does) and a **madness cost
  printed in words** ("Madness—Pay six {C}"). *Phyrexian costs*,
  *split / adventure* (two castable halves on ONE object — modal DFCs landed in §3.16, but those
  are two FACES, which is a different shape),
  *flashback riders that are not mana or life* ("Flashback—{1}{U}, Discard a card" — the cast
  pipeline can charge mana and life, and nothing else, so a discard or sacrifice rider reports),
  *P/T formulas outside the closed count vocabulary* (a star box counting something the
  `DerivedCountName` table does not name, or whose two halves count different things, still
  reports — it is never guessed),
  *damage divided among targets* ("deals X damage divided as you choose among any number of
  targets" — needs a division the targeting layer cannot express: one spell, several targets, each
  with its own share).
### 3.12 Scan a deck from a photo — ✅ done
Lay the deck out, take one photo, get a decklist — entirely on-device, no upload.

The unit is a **fanned pile**, not a card, because that is how a deck actually gets photographed: the
copies of a card go in a pile slid apart so every title bar peeks out, and the piles go in rows. One
photo then carries the names *and the quantities*. Piles are located by **variance profiling** (busy
card faces separated by a flat surface, so per-column/row variance yields the layout) rather than a
contour/perspective pipeline: no CV library, and pure array work unit-tested against synthetic images.

Two pieces of fixed geometry carry the rest. A pile is exactly **one card wide**, so the column bands
give the card width and the card's fixed 63:88 shape gives its height for free — which is what lets the
detector cut apart cards laid **touching**, as a gap-hunting detector cannot. And each pile is read down
**its own column**, because piles in a row are different depths and a shared row band would give a pile
of one its tall neighbour's overhang.

Down a pile's column, **where** the pile is comes from busyness (its stripes of content, split from the
next pile by the flat cloth between them), but **how many** copies it holds comes from **brightness** —
and that split was learned from a real photo, not chosen up front. Busyness cannot count sleeved copies:
with glare and jpeg noise, the dark line between two copies is every bit as "busy" as the title bars
around it, and the stripe-rhythm counter this section used to describe misread nearly every pile of a
real deck. What IS invariant is that every fanned copy shows the pale **title plate** its name is
printed on, and that plate is the brightest thing in its sliver on every kind of card — dark art or
pale, white border or black. So copies are counted as bright plate bands in the pile's brightness
profile, one per copy, bottom card included, with three guards (all measured off the real photo): a band
too close below another on the photo's fan pitch is the same copy's pale **art**, not a copy — unless a
deep dark valley proves a card edge between two nearly-**flush** copies; a deep valley within the glare
cap of the pile's top marks sleeve-rim **glare** above the first copy; and a plate cannot start lower
than the pile's height minus a card (plus slack for a black border sunk into dark cloth). The fan pitch
is measured across the whole photo — every pile was fanned by the same hand. A plain grid of loose cards
is read as piles of one; a manual rows × columns fallback covers photos neither reader can make sense
of.

Only each card's **title strip** is OCR'd (greyscaled, contrast-stretched, **bilinearly** upscaled to a
target height — nearest-neighbour blocks defeated Tesseract on a real photo's ~10px text) — the biggest
accuracy win, since art and rules text otherwise generate confident nonsense. The crop comes from the
**detected plate** rather than from a fraction of a card rect, because a fanned copy's true top edge is
buried under the copy above it, and is capped at a title bar's printed height. The bottom card is read
first; when a read is weak, each band is retried shifted down a little (a tilted photo puts the glyphs
at the plate's lower edge) and the fanned copies above are read too, best match winning: every copy in a
pile is the same card, so extra looks are free accuracy paid for only where needed. Tesseract runs in
text-**block** mode, not single-line mode — a tilted crop with a sliver of the neighbouring title in it
makes single-line mode return nothing at all. Raw OCR is never trusted: card names are a **closed
vocabulary**, so the text is corrected against Scryfall's full name catalog by edit distance — each OCR
line and each contiguous word run competes separately, so a name flanked by junk words still wins, with
score ties broken toward the longer-evidence query. A **review grid** shows each pile's own crop with
its match and its count, flags anything unconfident, and lets the name *and the quantity* be corrected;
only then does the list flow into §3.11's importer, so scanned cards get the same Oracle-compiler
treatment as typed ones. Tesseract is dynamically imported so its WASM core stays off the initial
bundle. **The acceptance gate is a real photo**: `apps/web/src/lib/scan/fixtures/user-deck-photo.jpg`
(16 sleeved piles, 59 cards, dark cloth, glare) is decoded by `real-photo.test.ts` to its exact per-pile
counts, with real-Tesseract OCR required to resolve ≥14/16 names and to flag every miss unconfident —
synthetic-only verification is what let this feature ship broken the first time.

### 3.13 Transforming double-faced cards — ✅ done
A second card face, and the mechanic it gates: **transform** (Innistrad-style DFCs — front face
castable, back face never castable, transform instructions flip which face's characteristics apply).

The seam is deliberately ONE swap, not a parallel read path: a front-face `CardDefinition` nests its
complete back face (`backFace`, marked `isBackFace`, id `<frontId>#back`), and **which face is up is
per-permanent state** — `CardInstance.def` IS the active face, with `printedDef` holding the front to
revert to (definitions stay acyclic, so the generated pool module still writes them as literals).
Because every consumer already reads characteristics through `inst.def`, the swap routes name, types,
P/T, keywords, triggers, statics, mana production, targeting, the AI's evaluation and the renderer's
art lookup through the active face with **no second code path anywhere**. `transformPermanent`
(core `transform.ts`) is the only writer; it emits a dedicated `transformed` event.

CR 712 is the contract: transforming is **not** a zone change — counters, marked damage, attachments,
tapped state and continuous effects persist, no `zoneChange` is emitted (so no ETB/leaves trigger can
fire off a flip) — and a permanent that leaves the battlefield turns front-face-up again in the same
`resetInstanceForNewZone` chokepoint every leave path runs (a bounced Aberration is a Delver in hand).
The trigger collector re-checks the active face's trigger list identity per event, so a permanent that
transforms mid-action stops/starts triggering with the face it actually shows. Back faces are refused
by cast/play (CR 712.8b) and never appear in the deck-builder pool; the web resolves `<id>#back`
through per-face Scryfall data, so the board and CardHover show the active face's own art.

Compiler: a `layout: 'transform'` (or `Transform`-keyword) record compiles BOTH faces through the full
rule table and links them; it is `'complete'` only when every printed ability of both faces compiled —
a half-modelled back face is worse than reporting it. Scryfall's card-level keyword union is attributed
to faces by their own text, never guessed. **Delver of Secrets is un-stubbed**: the upkeep
look/may-reveal/transform body is one primitive (`transformRevealTop`, classified library-reading for
paired arms), asked as a single top-of-library selection whose valence follows the top card, with a
constant public prompt so the log cannot leak a declined reveal. **Modal DFCs landed in §3.16** (a
back face marked `backFaceCastable`, cast or played as its own half); split and adventure cards still
report `SECOND_CASTABLE_FACE_GAP` (as do Sieges), because a half reached by its own cast path is
not a second face.

### 3.14 Online UI parity — every shipped mechanic reachable online — ✅ done
The rule this section exists to enforce: **a mechanic the engine plays and the online board cannot
reach is not done.** Three shipped systems had failed it — planeswalkers (attackable, loyalty
abilities), flashback (casting from the graveyard) and cast-time costs ({X}/kicker/pay-life) were all
in the server's `legalActions` with no affordance in `OnlineBoard`, so networked players could not use
them at all.

Parity is achieved by SHARING, not by re-implementing. The online board now renders the same
`SeatPanel`/`ChoicePrompt`/`AbilityPrompts`/`GraveyardPanel` components the hotseat board does, and
derives its affordances from three pure modules both boards call: `legal-actions.ts`
(`castChoices` → hand casts, `graveyardCastChoices` → flashback casts, `abilityChoices` → the
loyalty menu, all grouped from server offers alone, so a menu can hold no dead button),
`auto-tap.ts` (`castSequence`/`graveyardCastableWithTaps`, which plan against the FLASHBACK cost for a
graveyard cast) and `graveyard-cast.ts` (`graveyardPanelView`, the panel's whole view-model including
its why-disabled copy). Casting flows through ONE chokepoint per board (`activateCard(id, zone)`), so
click, drag-to-play and the graveyard panel cannot diverge.

Three seams worth remembering:
- **`CastSpellAction.fromZone` must survive the round trip.** The board groups casts BY ZONE and echoes
  the zone back on submit; a graveyard cast that forgets it is looked for in the hand and rejected.
- **Walkers are public, so masking needs nothing new.** Loyalty lives in the instance's counters and
  `maskStateForSeat` copies the battlefield wholesale — pinned by a protocol test that asserts the
  walker, its loyalty and its ability list survive for BOTH seats and for a spectator.
- **Auto-pass must count graveyard plays.** A fundable flashback is a real play; without it in
  `tapCastableCount` the board advances past the only windows the card is castable in.

Proven live, not merely unit-tested: `apps/server/src/online-ui-parity.test.ts` drives the real `Room`
with two fake-connection clients through real games and asserts the CLIENT functions the board renders
from — a walker attacked via `buildDeclareAttackersAction` (loyalty drops, the defender's life does
not), a flashback cast built by `castSequence(…, 'graveyard')` (card ends in EXILE, CR 702.34a), and an
{X} question surfaced by `onlineChoiceView` to the caster while the opponent gets only the redacted
waiting line. All four sabotage-checked RED→GREEN.

### 3.15 Battles, the legend rule, and emblems — three walker-adjacent objects — ✅ done
Three objects that sit beside planeswalkers in the rules and had no representation in the engine.

**Battles (CR 310)** reuse the attackable-object seam planeswalkers built rather than reworking
combat: `isAttackable` now answers for battles too, and `DeclareAttackersAction.attackTargets` needed
no change at all. A battle enters with its printed **defense counters**
(`CardDefinition.defense` -> `DEFENSE_COUNTER`, applied by `applyEnteringDefense` on every
battlefield-entry path, exactly as loyalty is). The one genuinely new question is **who defends it**:
a battle is protected by its controller's OPPONENT (CR 310.11), so attack legality asks
`protectorOf(object)` rather than comparing controllers - which is what makes attacking your OWN
Siege the printed play pattern, and lets the protector's creatures block. Combat damage and
"any target" burn alike strip defense counters (CR 120.3d); trample carries the excess past the last
counter to the defending player; zero defense is defeat by state-based action (`battleDefeated`).
"Any target" reaches battles (CR 115.4) while "creature or planeswalker" deliberately does not.

> **The battle SUBSYSTEM is complete; battle CARDS are still reported, and the two are different
> claims.** Every printed battle is a Siege whose reward is *casting its back face*, which needs the
> castable-second-face system (`SECOND_CASTABLE_FACE_GAP`, §3.13). `TYPES_WITHOUT_SYSTEM` is now
> empty - every printed card TYPE has a system - but a real Siege still imports as `'incomplete'`,
> naming that gap per card. Shipping the reward as a silent no-op was the alternative, and it is
> exactly the infidelity the compiler contract exists to prevent.

**The legend rule (CR 704.5j)** is ONE state-based action shared by every legendary permanent kind -
creatures, planeswalkers, battles alike - keyed on the printed **Legendary** supertype, which the
compiler now parses onto `CardDefinition.legendary` (supertypes were parsed and discarded before
this). Three details make it unlike every other SBA, and all three are pinned by tests: it applies
**per player**, not globally (each player may hold their own copy of a legend quite legally); the
**controller chooses** which copy survives, so the rule parks a question instead of deciding, marked
`PendingChoice.context: 'legendRule'` so the answer routes to the rule rather than to a resolution;
and the losers go to their **owners'** graveyards, not the chooser's. Answering re-runs the SBAs, so
a second duplicated name settles before anyone regains priority. `grantPriority` now declines to
stomp a parked chooser, since state-based actions can raise a question from inside the turn machine.

**Emblems (CR 114)** are command-zone objects with statics and triggers that **nothing can remove** -
and that property needs no enforcement code, deliberately: every removal path in the engine
(targeting, destroy, exile, board wipes, state-based actions) reaches only `state.battlefield`, so an
object that never enters it is unremovable *by construction* rather than by a list of exceptions
somebody has to keep complete. Their abilities are live from the command zone because
`indexContinuous`/`aggregateFor` and the trigger collector both discover command-zone sources
alongside permanents - one path, no emblem special case. The compiler's `emblem-with-ability` rule
compiles an ultimate's emblem body through the ORDINARY static and trigger tables, so an emblem can
only carry abilities the engine genuinely runs; a body with no rule leaves the line reported rather
than creating an object that provably does nothing.

⚠️ **The hot-path lesson, measured not assumed.** Wiring emblems into the continuous layer and the
trigger collector cost a real **~9% throughput regression** (paired same-box quiet rounds 0.907 /
0.919) before it was fixed - from `for (const pid of PLAYER_IDS)` allocating an iterator per call for
a two-element list, and from the trigger collector re-walking the command zone on *every emitted
event*. Both now read `state.players.A/.B` directly behind a `.length` guard, and the collector walks
only when the zone's size changed (sound for emblems specifically: one can never leave, and its
abilities come from an immutable definition). Re-measured paired: **quiet rounds 1.011 / 1.010,
median ratio 1.010** - parity. Gauntlet seed 99 stays **byte-identical at 79/280** throughout.

AI is not inert: one attack planner weighs walkers AND battles against the same power budget, finds
battles by `protectorOf` (a controller-based search would never consider your own Siege), and buys
chip damage on neither - on a battle it buys literally nothing, since the reward pays only on the
last counter. The hotseat and online boards render a defense badge beside the loyalty one, in a
different colour token because both sit in the same slot and "3 loyalty" must not read as "3 defense".

### 3.16 Cast-time choices, part two — modal spells, modal DFCs, multikicker, flashback {X} — ✅ done
Four mechanics, one seam: **every decision a caster makes while ANNOUNCING a spell**, asked before
anybody gets priority to respond. §3.11's {X}/kicker system opened that seam; this section fills it in.

**Why the timing is the whole feature.** Modes are chosen as the spell is cast (CR 601.2b) and each
chosen mode is aimed at cast too (CR 601.2c). A modal spell whose modes were picked on RESOLUTION
would let its controller watch the opponent's response first and only then decide whether to counter
it — strictly better than the printed card, and nothing would look broken. That is exactly what the
old resolution-time `modal` primitive did, so it is **deleted**, not kept alongside: two rival modal
systems is the failure this seam exists to prevent.

The data is `CardDefinition.modal` (`ModalSpec`: `min`, `max`, `allowRepeats`, and `SpellMode[]`),
where each mode carries its own `effects` AND its own `targets` restriction — because two chosen modes
point at two DIFFERENT objects, which one stack-object target list cannot express. `packages/core/modal.ts`
answers the two cast-time questions purely (which modes may be announced on this board; what each
resolves into), and the SAME helpers are read by `generateLegalActions` (the offer) and
`applyCastSpell` (the accept), so offer and accept cannot disagree. A mode with no legal target is not
on the menu; a modal spell that can announce nothing cannot be cast at all.

The announcement rides the stack object as `modePicks` (one entry per PICK — a repeated mode appears
once per time it was chosen, each with its own aim), and resolution flattens it in PRINTED order via
`picksToResolution` into the frame's `effects` plus a **parallel** `effectTargets` array. That parallel
array is the one sharp edge: `enqueueEffects` splices both in lockstep, and a test pins it — splicing
one without the other shifts every later mode's target silently.

- **Modal DFCs** (`backFaceCastable` beside `backFace`): both halves are really cast or played, each
  with its own cost, timing, targets and script. `CastSpellAction.face`/`PlayLandAction.face` name the
  half; the face swap is the same one a transform makes (`def` IS the active face, `printedDef` the way
  back), so leaving for a hidden zone reverts to the front (CR 712.8a) through the existing chokepoint.
  A transforming DFC's back face stays uncastable (CR 712.8b) — the difference between the two layouts
  is exactly that one flag. Split, adventure and Siege cards still report `SECOND_CASTABLE_FACE_GAP`:
  each reaches its second half by a cast path of its own (one object with two costs; a card exiled and
  re-cast later; a face unlocked by defeating a battle), and none of those is a second FACE.
- **Multikicker** (`CardDefinition.multikicker`): the answer is a COUNT, so the question is a
  `chooseNumber` bounded by `maxAffordableKicks` — the same planner that will charge it, planning
  against `repeatCost` (three copies of a hybrid symbol are three symbols, not a mana-value multiply).
  Charged once; any positive count also sets `kicked`, so an "if this spell was kicked" rider reads
  multikicker correctly. The count rides into resolution and then onto the PERMANENT
  (`CardInstance.timesKicked`), which is how an ETB trigger reads it after the frame is gone.
  "For each time it was kicked" is a derived count (`timesThisWasKicked`), so damage, draw, life,
  counters and token counts all learned it at once with no primitive changed.
- **Flashback {X} and the life rider**: `flashbackXCost` and `flashbackLifeCost`. The X question reads
  the FLASHBACK cost's count, not the printed cost's (a card may print both); the life is charged with
  the mana as a mandatory cost, so a caster who cannot pay it is neither offered the cast nor accepted.
  A non-life rider (a discard, a sacrifice) still reports — the engine has no cast-time cost of that kind.

**Cryptic Command is un-stubbed**, and it was the LAST entry in `STUBBED_MECHANICS` — every
hand-authored pool card now plays as printed, so `fidelity.test.ts` audits the whole pool with no
exemptions. All four modes are real; the bounce mode needed core's new `'permanent'` target
restriction, because flattening "target permanent" to "target creature" would be a card that cannot
bounce a land. The compiler reads every printed header ("choose one / two / one or both / up to N",
plus "You may choose the same mode more than once") and compiles each mode through
`compileTriggerBody`, which is the right compiler precisely because a mode, like a trigger, must
DECLARE what it may be aimed at rather than inherit a target the caster already named.

Both seats: the AI prices each mode by its BEST legal target (`valueOfMode`), which is what stops it
choosing "counter target spell" when the only spell on the stack is its own — a spell is a legal
target for its own counter mode, and being faithful there means the pilot, not the engine, must be the
one that declines. Humans answer through the existing `ChoicePrompt`, with repeated modes rendered as
a count (`×2`) rather than a toggle.

### 3.17 Indestructible + the blocking restrictions — ✅ done
Two small engine systems the mechanic census named together (`docs/plans/mechanic-completion-plan.md`
§3c), sharing one lesson: **a rule belongs where it is expressible, and nowhere else.**

**Indestructible is not a shield, it is an exemption from exactly two rules.** CR 702.12b removes
the permanent from destruction — an effect that says "destroy", and lethal marked damage (CR 704.5g),
with deathtouch's "any nonzero damage is lethal" (CR 702.2b) riding along. Everything else still
works, and each is a *different* rule: **0 or less toughness** puts it into the graveyard by
CR 704.5f, which the keyword does not mention; **sacrifice** is a cost, not destruction; **exile**
moves it by another path. So the state-based-action pass asks the two creature-death questions
separately and gates only the damage one on the flag — collapsing them into one guarded expression is
the classic wrong implementation and makes a creature with no toughness immortal. The destroy
exemption itself lives in `destroyPermanent`, the single function every printed "destroy" in the pool
already passed through (single target, board wipe, modal destroy mode), so there is no per-caller
check to forget.

**A latent bug this exposed, worth more than either feature.** The continuous layer's `KEYWORD_KEYS`
is a hand-maintained list of the boolean flags a GRANT may set. A flag added to `KeywordFlags` and not
to that list works when printed and does *nothing* when granted — silently, and in one direction only.
It had already eaten a granted hexproof once. Both new booleans are in it, `minBlockers` folds by MAX
(two blocking requirements are both in force; the stricter decides, and summing would invent a third),
and granted-not-printed cases are now covered by tests in both systems.

**Blocking restrictions are split by what a check can SEE**, following the menace precedent:
- **per pair** (`canBlock`): "can't be blocked", "~ can't block", flying/reach, protection. Each
  disqualifies one specific attacker/blocker pairing.
- **per declaration** (`illegalBlockDeclaration`): menace, and its general form "can't be blocked
  except by N or more creatures" (`minBlockers`, of which menace is the N = 2 printing). Every
  blocker is individually legal and only the *count* is not, so a per-pair check cannot express it.

⛔ **Block REQUIREMENTS are NOT implemented, deliberately.** "Must be blocked if able" and "all
creatures able to block ~ do so" are the other half of CR 509.1c/d, which resolves requirements and
restrictions *together* — maximise satisfied requirements without violating any restriction. That is
a solver, not a check, and half of it would be a card playing differently from its text. The compiler
reports those cards by name, and the unsupported hint says which of the two things is missing.

Also reported rather than approximated: a restriction whose SELECTOR compares the two creatures
(skulk; Delney's "power 2 or less can't be blocked by power 3 or greater"), and a filtered set the
static layer cannot read — `statics.ts` matches PRINTED characteristics only, on purpose, so
Tetsuko's "power or toughness 1 or less" has no faithful filter and keeps reporting.

**Both seats.** The pilot no longer "kills" an indestructible creature: destroy and exile are split
into one intent flag, a destroy looks past indestructible creatures and holds the card if the whole
enemy board is one, and a sweeper's value counts neither side's indestructible creatures. It also
never proposes a declaration the engine would refuse — it assigns one blocker per attacker, so it
declines to block a menacing attacker at all rather than voiding every other block in the same action.

**Measured yield:** the top-2100 corpus went **229 → 252 playable** (10.9% → 12.0%) on the same cached
corpus, via the keyword itself plus four rule-table entries it unlocked: the mass until-end-of-turn
grant ("permanents you control gain hexproof and indestructible"), the anthem static generalised past
"creatures" to any permanent noun (Darksteel Forge, Avacyn), the printed PHRASES "can't be blocked" /
"can't block" as keyword names, and "target creature can't be blocked this turn". Gauntlet seed 99 is
byte-identical to `origin/main` (79/280) with throughput at parity.

### 3.18 The in-game bug reporter — ✅ done
Ported from the same tool in Treadlight and Lightwalker, where it has been the single most effective
route from "it did something weird" to a fixed defect. Press **B** — or tap the ⛬ button, which is the
one that matters, because the live PWA is used on a phone with no keyboard — and from ANY view the
screen freezes on the frame the problem is on. You scribble on that frame, type and/or **speak** what
went wrong, and Submit hands over `bugreport_<stamp>.zip`.

**The bundle is the same set of entries all three projects write**, so one habit reads a report from
any of them: `report.md` (the same field lines), `screenshot.png`, `annotated.png`, `state_dump.txt`,
`voice.webm` + `transcript.txt`. A browser cannot write a folder, so the web one is a zip — built by
`lib/bugreport/zip.ts`, a ~150-line STORE-only writer, rather than a dependency, since the payloads
(PNG, WebM) are already compressed.

**A GLOBAL OVERLAY, not a view** (`components/BugReporter.tsx`, mounted once in `App.tsx`). A view
would have to be navigated to, which loses the screen being reported about — the whole point of the
tool. No view contains a line of code about bug reporting.

**`console.txt` takes video's place.** The two games record the last N seconds of frames because a
rendering bug has to be SEEN. Here the equivalent evidence is textual, and arguably better: the
console/error ring (installed at app load, not at report time, or it has already missed the thing you
opened it for) carries the warning that fired, the unsupported-mechanic signal and the thrown stack. A
screenshot of a card grid rarely says why a verdict was wrong; the log usually does.

**`state_dump.txt` is a REGISTRY, not a hardcoded list** (`lib/bugreport/state-dump.ts`). Any surface
registers a named section with `registerStateSection` and it appears in every future report — the same
seam the games' dumps use, and the reason theirs never go stale. Built-in sections: build (the commit
is compiled in by `vite.config.ts`, so a report from the live PWA names the build it came from),
environment (including installed-PWA vs browser, which changes which bugs are even possible) and
storage. `App.tsx` registers the view, the decks and the pool size.

**Three defects found by running it, each now pinned by a test in `capture-policy.test.ts`:**
- Rasterising `document.body` captures the whole SCROLLABLE page while the reporter draws in VIEWPORT
  coordinates, so every stroke lands somewhere else. Fixed by sizing the raster to the viewport and
  translating the clone by the scroll offset. (Lightwalker's port hit the identical bug for the
  equivalent reason — a framebuffer bigger than the window.)
- `html-to-image` fetches and base64-inlines every `<img>` it clones. With ~190 card tiles the capture
  ran past 30 s and timed out; off-screen images are now skipped, which cannot change a visible pixel.
- The frame and the ink canvas were each fitted with `object-fit: contain`, so the canvas ELEMENT
  filled the stage while its BITMAP was letterboxed inside it — every stroke scaled and offset. They
  now share one aspect-ratio box, verified in the running app as `scaleX === scaleY`.

⚠️ **What is NOT verified automatically, stated rather than glossed:** that the rasteriser produces a
faithful picture. It needs a real, VISIBLE browser — in a backgrounded tab `toPng` never resolves at
all, even for a single header element. Everything around it is tested (region, skip rule, the finite
budget that turns a hang into a note, the zip, the report, the dump), and the whole submit path was
driven end-to-end in the running app: two strokes, a typed note, a real zip read back out of its own
central directory. The picture itself wants one human look.
### 3.19 Alternative and additional casting costs — cycling, buyback, madness — ✅ done
The third answer to "what does this card cost?", after §3.11's {X}/kicker and §3.16's modal/multikicker
work. These three are one section because they are one question asked three ways: what a card costs,
and **where it goes**, when it is played by some route other than "pay the printed cost from your hand".

- **Cycling** (`CardDefinition.cycling`, the `cycleCard` action) — an activated ability of a card in
  **hand**: pay the cost, **discard the card as the rest of that cost**, put the ability on the stack.
  It is deliberately NOT an entry in `activated`: that list is activated from the battlefield by a
  permanent, and folding the two would teach every battlefield-shaped check (summoning sickness, tap
  costs, `findOnBattlefield`) about a zone it has never had to consider. The discard being a **cost**
  is what makes cycling a madness card exile it, what makes a "whenever you cycle or discard" trigger
  fire, and what makes countering the ability not give the card back. Instant speed, so a cycling land
  becomes a card on an opponent's turn — which is the whole reason to play one over a tapland.
- **Typecycling and landcycling** fold into cycling completely: same list, same action, same code
  path, with the ability's effects being a **library search instead of a draw**. The searchable words
  are a closed table (the five basic land types plus the generic "land") because each has to name
  something `CardFilter` can genuinely select; a cycling word outside it reports rather than fetching
  approximately the right card.
- **Buyback** (`CardDefinition.buyback`) — an optional additional cost asked at cast time exactly as a
  kicker is, whose answer changes not the spell's script but its **exit from the stack**. That exit is
  one shared answer: `spellLeaveDestination(spell, reason)` in `state.ts`, which flashback already
  owned. The `reason` argument is the whole design — a flashback card is exiled however it leaves the
  stack, while a bought-back spell returns to hand only when it **resolves** and goes to the graveyard
  when it is **countered** (CR 702.27a). Two exits that can disagree about where a card goes is
  precisely the bug that helper exists to prevent, so countering asks the same function.
- **Madness** (`CardDefinition.madness`) — not a cast-time cost at all but a **replacement on the
  discard**, plus a cast that follows. Both discard funnels in this repo (core's `moveToZone` and the
  cards package's `moveOwnedCard`) ask the shared `discardDestination`, so a card discarded as a cost
  and a card discarded by an effect cannot disagree about being exiled. The exile opens a **madness
  window** on the game state, and while it stands the legal-action generator offers exactly: mana
  sources, the cast (`fromZone: 'exile'`, paying the madness cost, ignoring the card's printed
  timing), and **pass — which declines**, dropping the card into the graveyard the discard would have
  used. Modelling the window as state rather than as a trigger on the stack is what lets every seat
  play madness with no new transport: the pilots, the hotseat UI and the online server all already
  enumerate actions and submit one.

**Both seat kinds actually use them, which is the rule against inert mechanics.** The heuristic pilot
cycles a surplus land once it is **flooded** (`floodedLandCount` lands in play, so a further land is
worth less than an unknown card) and cycles anything at the **end step**, where the mana would empty
unused anyway — and it funds both through the same `planManaPayment` a spell goal uses, which is
load-bearing: the engine offers `cycleCard` only once the pool already covers the cost, so a pilot
that did not plan its taps would never see the action and the mechanic would be inert on a board of
untapped lands. Madness is a one-sided judgement on purpose: the card is *already discarded*, so
declining does not keep it, and casting is right whenever the mana exists. Humans get a hand-card menu
when a card has more than one way to be played (a cycling land is a land drop **and** a cycling
ability) and a prompt for the madness window, because a player who did not know the window was open
would stall against a board that refuses every other move.

**Measured** against the cached 2100-card most-played corpus with
`packages/cards/scripts/coverage-audit.mjs --input <corpus>`: **+21 playable cards** (229 → 250
against the main this landed on; re-measured 307 → 328 against a later one), which is
the census's predicted yield for this system (20 sole-blocked cards) plus one. The forms that still
report, by name: an **{X} cycling cost** (Shark Typhoon — an activation cost has no answer-and-charge
step), a **madness cost printed in words** ("Madness—Pay six {C}"), a **cycling word with no
expressible filter**, and **aftermath**, which is a split card and needs the `//` type rather than
anything in this section.

## 4. Ways this project is distinctive (keep extending)
- **Iterative, statistically-grounded deck tuning** — not just "play vs humans," but a controlled A/B
  lab: swap one card, run the gauntlet, get a significance-tested verdict.
- **Engine-suggested improvements** — the app proposes the next card swap and proves it helped.
- **Real MTG cards + art** via Scryfall, with a fully-correct curated rules subset.
- **One pure engine, three surfaces** — Node CLI sims, browser Web-Worker sims, and the PWA all share
  the same deterministic core.

## 5. Tooling
- Build/test: see CLAUDE.md (`npm run build`, `npm test`, `npm run dev`, `npm run sim`). Tests run on
  every feature via Vitest.
- A one-command way to launch the PWA (`npm run dev`) and to run a gauntlet from the CLI (`npm run sim`).

## 6. Parallel-development rules (so agents don't collide)
- The monorepo packages are the **disjoint ownership boundaries**:
  `packages/core`, `packages/cards`, `packages/ai`, `packages/sim`, `packages/data-tools`, `apps/web`.
  Each feature owns its package's `src/` + `data/`.
- New content (a card, a deck, an AI profile) goes in a feature-owned data file — never a shared one.
- Integrate only through the §2 seams. Do not edit another package's internals or the core engine loop.
- Every feature adds tests and leaves the full suite green.
- Claim work on `COORDINATION.md` before starting; pick a unique `feat/<slug>` branch.

## 7. Definition of done
Tests green · status flipped in §3 · committed with explicit paths · pushed · a build delivered to test.
Workers push branches; the integrator merges + ships (COORDINATION.md).
