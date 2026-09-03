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

> 📌 **THIS FIGURE HAS SINCE MOVED, and the move is in this table's own spirit.** The 79/280 above
> was superseded by 81/280 as later branches landed, and CR 514.1 (the cleanup discard, §3.29) took
> it back down. Measured against `origin/main` at `ab0e41a`, the CURRENT recorded baseline for seed
> 99 is **79/280 = 28.2%**, and switching the rule off in the same build gives **82/280 = 29.3%** —
> so the hand-size rule is worth **three games in 280** to Mono-Red on this gauntlet. It moved
> because the engine got MORE correct, not less: an unbounded hand was making card draw and
> held-back reactive spells worth more than they are. §3.29 has the isolation and names the two
> matchups it came from.
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

### 3.76 The suggestion report no longer needs the host to have played the games — ✅ done

A prerequisite landed, and a shortcut measured and rejected. Both matter; the rejection more.

**What changed.** `runAdaptiveSearch` built each candidate's verdict with `runner.summarize(handle)`,
which reads the tally held *inside the host's runner*. It now builds the same verdict from the arm's
own accumulated tally through `summarizePairedSwap` — the identical pure function `summarize` calls
internally, given the identical inputs, so every number is unchanged (19,369 tests green).

Why that is worth doing at all: **a pooled run plays an arm's slots on workers**, so the host's
runner never sees those games and `summarize` would report zeros. This is precisely why the web
Lab's parallel search is not a thin wrapper around the sequential one. Decoupling the report from
host-side arm state is the first thing any unification needs.

⚠️ **THE SHORTCUT THAT DID NOT SURVIVE MEASUREMENT.** COORDINATION.md proposed a cheap partial win:
the shared BASE arm parallelises trivially (a base slot is a pure function of its index), so pre-play
it on workers, hand it to the search through the `baseRecords` seam that already exists, and leave
the round loop alone. It was built, and it worked — output **byte-identical** to the sequential run,
accounting corrected so games played on workers were counted rather than reported as "saved".

Then it was timed:

| run | sequential | base arm on 6 workers |
|---|---|---|
| 40 games/candidate, 4 candidates (1,028 games) | **10.40s** | 13.46s |
| 200 games/candidate, 8 candidates (7,326 games) | 62.85s | **59.15s** |

**1.06× at a realistic size, and SLOWER at a small one.** The arithmetic says why, and the estimate
on the board was wrong: the base arm is **1,600 of 7,326 games — 22%**, not the ~31% a smaller run
suggested, so even perfect parallelism caps the whole command at 1.23×. Worker startup (six processes
each loading a 5,065-card pool) eats most of what is left, and at small sizes it eats more than the
whole prize.

So it is not shipped. A job kind, a worker handler, a cached per-worker runner, host-side accounting
corrections and a new failure surface, for 6% — that is complexity bought at a bad price. The
`baseRecords` forward went with it: a seam with no consumer is speculative generality, and the real
implementation will add exactly what it needs.

⚠️ **What this corrects for whoever does the full job**: the value is in the VARIANT arms (78% of the
work), not the base arm, and there is no cheap version. The full unification — an injectable arm
executor so one loop serves both a synchronous handle and sharded slices — is the only shape that
pays, and this section removes its first obstacle.

### 3.77 `suggest` fans out — one search, two transports — ✅ done

The full unification §3.76 said was "the only shape that pays". It pays: **2.89× on search time**,
**2.51× wall clock**, and a report that is **byte-identical** to the sequential one.

**Why this command needed a design and the others did not.** `match`, `gauntlet`, `swap`, `pilot-ab`
and `soak` are flat: cut the games, play the pieces, add up integers. The suggestion search is not.
Its adaptive ladder advances a *shrinking* field of arms to *growing* depths, and every arm is paired
against the *same* base games. That gives two failure modes the other commands cannot have, and both
produce a report that still looks perfectly well-formed:

- a slot played by the wrong shard — a silently different run;
- the shared base arm replayed once per candidate — the right answer, at ~1.8× the work.

**The shape.** One generator, `driveSuggestionArms`, holds everything that decides an *answer*:
opening arms, recording the ones that fail to build, the progress callbacks, and building each
verdict from the arm's own tally. It yields a whole round's requests and is resumed with the played
arms. Two transports supply the games and nothing else:

| | plays games on | usage counted from |
|---|---|---|
| `suggestSwaps` | the calling thread, via `PairedArmRunner.advance` | the host's runner |
| `suggestSwapsWith` | wherever `ArmTransport` says | what the workers reported |

The wave ladder, the elimination rules, the multiplicity correction, the ranking and the report are
shared code, so a pooled run is a **transport** choice rather than a second search with its own
answers. `--workers` on `suggest` is now the same flag it is everywhere else.

**The base phase — the part that makes it worth doing.** Each round first plays whatever base slots
the ladder newly reached, then hands those records to every variant slice through the `baseRecords`
seam. Without it each of C candidates would replay the base games itself. The accounting proves it
did not: the same run reports **6,691 games (1,600 base + 5,091 variant)** sequentially and pooled.

**Measured** (`suggest "Mono-Red Aggro"`, 6 workers, 6 physical cores):

| run | sequential | 6 workers | speedup |
|---|---|---|---|
| 40 games/candidate, 4 candidates (891 games) | 9.15s | 5.31s | 1.72× |
| 200 games/candidate, 8 candidates (6,691 games) | **54.19s** | **18.73s** | **2.89×** |

123 → 357 games/sec. Wall clock including startup: 58.1s → 23.11s (2.51×). The small run keeps less
of the win because six workers each loading a 5,065-card pool is a fixed cost the short run cannot
amortise — the same effect that killed §3.76's shortcut.

**Why not more than 2.89× on six cores.** A round is a barrier: the ladder cannot schedule wave N+1
until it has seen wave N. Late waves have few arms left, so the pool is not full at the end of a
search — that is inherent to successive halving, not a scheduling defect.

**Proof, not assertion** (`suggest-parallel.test.ts`): the pooled search is compared to the
sequential one at shard widths 1, 2 and 5 with slices executed in deliberately **reversed** order,
and the whole report must match — `toEqual` *and* `JSON.stringify` equality, so key order and float
bit-patterns match too. Only the two wall-clock fields are normalised; nothing else is excluded.

⚠️ **The trap this shipped with a test for.** `runSeed` equals the caller's `baseSeed` only on a
deck's **first** run — a run continuing a history plays on `gameSeedFor(baseSeed, runsCompleted)` so
it draws different games. A transport that derived the seed itself would agree with the host exactly
once and then silently play a *different set of games* on every run after, reporting it as if
nothing were wrong. Hence `ArmTransport.begin`: the search **tells** the transport its seed and no
one recomputes it. The regression test runs a continued search and was confirmed to fail — alone,
with the other four still passing — when `begin` is fed `baseSeed` instead.

A second guard, in the transport: an arm slice that reports `baseGamesPlayed !== 0` throws. That
value is zero exactly when the base phase supplied every record the slice needed, so a non-zero one
means the schedule under-supplied and the run quietly did duplicate work.

**What did not change.** `--no-adaptive` stays sequential: the fixed-budget sweep is the control the
adaptive search is measured against, not something anyone runs for speed. The web Lab keeps its own
round-by-round fan-out — it carries replay capture, cancellation and progress concerns the CLI does
not — but both now go through the same `driveAdaptiveSearch` and the same `summarizePairedSwap`, so
the two cannot disagree about a verdict however they schedule the games.

### 3.78 The engine profile is FLAT — and that is the answer to "make it 10× faster" — ✅ done

A measurement, committed as tooling, that closes a question this repo kept re-opening by hand.

**The tool.** `packages/sim/bench/prof-report.mjs` turns a `.cpuprofile` into a **self-time** table.
Self time, not total: a total-time table always makes the outermost frame look like the problem,
which is how an afternoon gets spent optimising a loop that is only expensive because of everything
it calls. It prints a verdict line — FLAT or PEAKED — so the reader gets the decision, not just
numbers. Pair it with `pilot-bench.mjs`, still the only harness worth profiling (the CLI plays its
games in a worker, so `--cpu-prof` on it profiles a parent that is 99% idle).

```
node --cpu-prof --cpu-prof-dir prof packages/sim/bench/pilot-bench.mjs --games 1500
node packages/sim/bench/prof-report.mjs prof --top 12 --min 1
```

**The measurement** (1,500 games, heuristic pilot, 5,421 samples):

| self time | function |
|---|---|
| 6.12% | `generateLegalActions` |
| 6.07% | `runMatch` |
| 4.89% | `rememberSources` |
| 4.10% | `planManaPayment` |
| 3.65% | `scoredSpellGoals` |
| 3.50% | `heuristicWillPass` |
| 2.79% | `willPassPriority` |
| 2.40% | `emit` |

**Heaviest single function: 6.1%. Top ten together: 38.4%.**

**What that means, stated plainly.** There is no hotspot. Deleting the single most expensive function
in the engine outright — not optimising it, deleting it — would buy **6%**. A 10× speed-up requires
removing 90% of all work, and this profile says that work is spread across the whole engine, not
pooled anywhere a fix could reach it. **Single-thread 10× is not available by optimisation.** It
would take a different state representation (flat typed arrays, no per-action event objects, no
per-action collector), which would discard the byte-identical replays, the seeded determinism and
the 19,000-test correctness net that make this project worth anything.

**And the two biggest targets are load-bearing.** `rememberSources` + `createTriggerCollector` = 6.9%
is the per-action trigger snapshot. It looks like pure waste on the ~82% of windows that are passes —
but it is what makes **last-known-information** work: a permanent that dies during an action is gone
from `state.battlefield` by the time the `zoneChanged` event is scanned, so the pre-action walk is the
only reason its dies-trigger fires at all (CR 603.10). Deferring it to first use would trade a rules
bug for 5%. Recorded here so the next reader does not re-derive the idea and ship it.

**What IS available, and was taken.** Throughput came from the two places the profile does not
govern: cutting the number of decisions (the fast-pass gate, §3.62 — 82% of windows never build a
menu at all) and cutting wall clock across cores (§3.53, §3.77). That is +48% single-thread and
2.89× on `suggest`, not 10×, and this section exists so nobody spends a week rediscovering why.

### 3.79 The step census — only 18% of what the engine does is a play — ✅ done

§3.78 showed there is no hotspot to attack, which leaves the other axis: not "make each action
cheaper" but "perform fewer actions". `packages/sim/bench/step-census.mjs` measures that directly —
over real games, how many applied actions are a pass in a window where **nothing could have
happened**, broken down by step so the answer says *where* the dead windows are, not merely how many.

**Measured** (200 games, Mono-Red Aggro vs UW Control, 109,159 actions — 546 per game):

| band | share | what it is |
|---|---|---|
| dead passes | **23.8%** | the menu offered only the pass; empty stack, no parked choice |
| live passes | **58.0%** | the pilot *could* have acted and chose not to |
| real plays | **18.2%** | the pilot actually did something |

Dead windows by step: `beginCombat` / `combatDamage` / `endCombat` / `postcombatMain` / `end` all
38%, `declareAttackers` 29%, `draw` 20%, `upkeep` 19%, `precombatMain` 10%.

**The two bands are different problems, and must never be reported as one "passes" number.**

- **Dead passes are a SPEED question.** The pilot had no decision, so the round-trip bought nothing.
  The fast-pass gate (§3.62) already skips menu-building for most of them — but it *refuses* to judge
  `declareAttackers`/`declareBlockers` cheaply and returns `false` there by construction, so the
  4,414 dead combat windows pay `generateLegalActions` in full. That is **4.0% of all actions**, and
  it is the largest single piece of dead work still on the table. A cheap combat pre-check ("no
  untapped creature I control, no attacker legal") would take most of it — worth ~2–3% of wall clock.
- **Live passes are a STRENGTH question**, and this is the more useful finding. **58% of everything
  the engine does is the pilot declining an option it had.** Every misplay of omission lives in that
  band, and it is more than three times the size of the band where the pilot actually acts. Strength
  work that samples "what did the pilot do?" is looking at 18% of the decisions; the interesting ones
  are the 58% it *didn't*. `missed-plays.mjs` already mines exactly that band — this section is the
  measurement that says why it is the right band to mine.

**What this settles about the speed target.** Removing *every* dead pass — all 23.8%, an unreachable
ceiling since most are already cheap — would not reach 1.35×. Together with §3.78's flat profile,
both axes are now measured: per-action cost has no hotspot, and action count has no large removable
share. **10× single-thread is not reachable in this architecture**, and the two measurements that say
so are committed tooling rather than assertions, so the next person can re-run them in a minute
rather than re-deriving them over a week.

**Follow-up: the 4.0% was attempted, proved safe, measured, and NOT shipped.** The obvious fix for
the dead combat windows — "this seat controls no untapped creature, so it has nothing to declare" —
was written, along with `bench/gate-check.mjs` to prove it safe. It was not safe:

| step | windows handed to normal reasoning | of which UNSAFE |
|---|---|---|
| `declareAttackers` | 10,860 | **0** |
| `declareBlockers` | 10,226 | **3,179** |

⚠️ **The trap: "declare NO blockers" is itself a declaration the engine offers**, so a defending seat
with nothing untapped is still being asked something, and no creature count can rule that window out.
Narrowing the rule to the attacking seat made it safe (17,907 windows, 0 unsafe) and left outcomes
byte-identical (A won 806/2000 either way) — but the wall clock did not move: **196 games/sec against
a 197–204 spread on IDENTICAL code**. Under 1% of actions were affected, below this machine's noise
floor. Fifteen lines of special case in a correctness-critical function for nothing measurable is not
an improvement, so it was reverted rather than shipped on the strength of a plausible story.

`gate-check.mjs` stays, because the trap is permanent and a timing run cannot see it — skipping a
live window makes the pilot silently **weaker**, not wrong.

That is now three speed hypotheses these measurements have killed, and it is the point of having
them: testing an idea here costs minutes, and every one of them looked good first.

### 3.80 The pilot leaves nothing obvious on the table — the strength band, mined — ✅ done

§3.79 found the promising lead: **58% of everything the engine does is the pilot declining an option
it had**, three times the band where it acts. Every misplay of omission lives there. This is that
band mined, and the honest result is that the obvious value is already being taken.

**What the miner says** (`missed-plays.mjs`, 120 games × 3 matchups, 7,435 turns):

| omission | count |
|---|---|
| land drop left unused | **0** (0.0%) |
| main-phase pass with a castable spell on offer | **0** |
| attack windows declined | 1,103 of 8,130 (13.6%) |

The first two are the ones that would be flatly wrong, and they are zero. The pilot never skips a
land drop and never passes a main phase holding a castable spell. That leaves the attack band, which
is not a defect by itself — §3.74 already took the guaranteed-lethal swing and §3.75 already refuted
holding attackers back for defence.

**Splitting the declines** (`bench/declined-attacks.mjs`, new, 4,602 attack windows):

| band | count | what it means |
|---|---|---|
| FREE — defender has no untapped creature | 17 | |
| UNBLOCKED — an attacker survives every block | 154 | |
| CONTESTED — a genuine judgement call | 927 | |

⚠️ **Both "defect" bands are OVER-COUNTS, and the tool now says so in its own header.** FREE is almost
entirely 0-power mana creatures ("5 attackers for 2 power") that the pilot correctly keeps untapped
for mana — the script reads printed power and the pilot knows better. UNBLOCKED reads printed
power/toughness and ignores evasion and continuous effects, so it is not the question
`attackIsProfitable` actually asks.

**The hypothesis this killed.** UNBLOCKED suggested a clean rule: *a creature the defender cannot kill
should attack whatever its power, because `attackValueThreshold` is guarding against a loss that
cannot happen*. It was implemented behind a `safeAttacker` flag and A/B'd on matched slots:

```
safeAttacker ON vs OFF — 9 decks, 2880 games
  slots: ahead A 0 · ahead B 0 · level 1440
```

**Not one game in 2,880 differed** — the strongest possible refutation, and a more useful one than a
p-value: the pilot **already does it**. `attackValueThreshold` is 1, `faceDamageValue` is 1, and a
0-power attacker is rejected earlier, so any attacker with no profitable block against it clears the
bar by construction. The rule was dead code and was reverted.

**What this settles about the strength target.** The 58% band is large but it is not full of mistakes.
The three omissions a rules-based pilot is normally guilty of — missed land drops, unspent mana,
declined free damage — are at zero, zero, and "already handled". Combined with the earlier finding
that `lookahead` (real engine rollouts, the strongest play available in this engine) beats this pilot
only **42 slots to 10 with 88% of slots level**, and that the two agree on **99.0% of all decisions**:
the headroom between this pilot and near-optimal play is single-digit percent. **10× smarter is not
available**, because there is not 10× of anything left to take.

That is now three speed hypotheses and three strength hypotheses killed by measurement (`trimForDefence`
§3.75, the combat fast-pass §3.79, `safeAttacker` here). The two that survived — the alpha strike
§3.74 and the fast-pass gate §3.62 — shipped. The ratio is the point: ideas are cheap to test here
and most of them are wrong, which is exactly why they get tested instead of argued about.

### 3.81 The pilot, measured on its own — 177k decisions/sec, and that profile is flat too — ✅ done

The goal this work serves says "make **the heuristics** 10× faster", and every measurement so far had
been of games/sec — the engine *plus* the pilot. A change that made the decision function twice as
fast would move that number a few percent and read as noise, which is exactly what happened twice.
So: an instrument that measures only the decision function.

**The tool.** `packages/sim/bench/pilot-decide-bench.mjs` plays real games once and **records** every
`(state, legalActions)` the pilot was asked about, then replays only `chooseAction` over that corpus,
timed. Recording first matters — timing decisions inside a live game measures the engine advancing
between them. The corpus is the pilot's real workload in its real proportions, cheap fast-passed
windows included, because making the rare expensive decision faster while the common cheap one
dominates is how an optimisation wins a microbenchmark and loses the sim.

Two traps it now documents, both of which cost time here:

- **Warm up first.** Measured cold, seven identical reps spread **56%** — wide enough to hide any
  real change. Two discarded passes bring it to ~17%, and the reported figure is the **median**
  (the best-of-N drifts upward with N; the worst catches whatever else the machine was doing).
- **Profile with a SMALL corpus and MANY reps** (`--games 8 --reps 40`). `--cpu-prof` covers the whole
  process, and the recording phase calls `applyAction` once per decision. Profiled the other way
  round, the table says "the pilot spends 14% of its time cloning state" — it does not; the heuristic
  pilot never clones, only `hybrid` and `mcts` do. That misreading was one edit away from being acted
  on.

**The baseline: 177,459 decisions/sec — 5.64 µs per decision.**

**The pilot's own profile** (small corpus, 40 reps, so the decision loop dominates):

| self time | function |
|---|---|
| 8.41% | `indexContinuous` |
| 6.36% | `scoredSpellGoals` |
| 5.31% | `choosePriorityAction` |
| 5.10% | `planManaPayment` |
| 3.93% | `bestSpellGoal` |
| 3.22% | `totalAvailableMana` |

Heaviest single function **8.4%**; top ten together **48.4%**. **Flat, like the engine's.**

And the heaviest item is already optimised: `indexContinuous` is a single battlefield pass with lazy
allocation and a shared `EMPTY_INDEX` for the common case of a board that modifies nothing — the
guard I went looking for was already there, in the one funnel, benefiting every caller.

**What this settles.** The speed question is now measured three independent ways, and all three agree:

1. **Engine per-action cost** — flat, heaviest 6.1% (§3.78).
2. **Action count** — no large removable share; the unreachable ceiling is under 1.35× (§3.79).
3. **Pilot decision cost** — flat, heaviest 8.4%, and that function is already tuned (here).

There is no 10× in any of them. It is not hiding in the engine, not in the number of decisions, and
not in the heuristics themselves.

**The instrument outlives the question**, which is why it is committed rather than run once: rule 7
says a change must not regress the hot path, and a new *strength* feature costs **decision** time.
This is the number to quote for one — games/sec hides it behind the engine.

### 3.82 A single-seed A/B reports flukes — the two-seed protocol, and the map of what is left — ✅ done

> ⚠️ **CORRECTED BY §3.88: "100% of the disagreements are in `declareAttackers`" is a TAUTOLOGY.**
> `lookahead` delegates every decision to the heuristic except the attack step, so the two
> can only ever disagree about attacks. That result describes the composition, not the
> pilot. The seed-protocol half of this section stands unchanged.

The most important thing found in this whole run of strength work, and it is not a pilot change: **the
measurement method this repo uses to decide whether a pilot change is an improvement was wrong**, and
it nearly shipped one.

**How it surfaced.** `bench/disagreement.mjs` (new) asks both the heuristic and `lookahead` about
every recorded decision and classifies where they differ. The result is sharp enough to be worth
stating on its own:

> **100% of the two pilots' disagreements are in `declareAttackers`.** Not one anywhere else — not
> casting, not blocking, not activating, not land drops. Of those: 59.8% the heuristic attacks and
> lookahead passes, 36.2% both attack with a **different set**, 4.1% the heuristic passes and
> lookahead attacks.

So the entire measurable gap to the strongest policy available here is attack selection. Two
hypotheses followed, both tested with `bench/weight-ab.mjs` (new — the tuning-knob sibling of
`feature-ab.mjs`):

| change | result |
|---|---|
| `attackValueThreshold` 1 → 3 (attack less) | 22 / 65 — **clearly worse**, p = 6.7e-6 |
| `outnumber` (send the surplus the defence has no body for) | 81 / 79 at 11,520 games — **neutral**, p = 0.94 |
| `ownCreatureLossPerStat` 1 → 1.5 (value own creatures more) | 285 / 215 — **"stronger", p = 2.03e-3** |

⚠️ **That third row is the trap.** It is 11,520 games, 500 decided slots, p = 0.002 — by the standard
this repo had been using, a finding. Two nearby values agreed (1.25: p = 0.029; 2.0: p = 0.017), which
felt like corroboration. It was not: they were **the same games**. Re-run on an independent seed set,
the identical change measured **250 / 247, p = 0.93**. Nothing about it was real.

**The contrast that makes the rule obvious.** The alpha strike (§3.74, shipped) on that same
independent seed: **158 ahead, 0 behind.** A real improvement is *one-sided*. A 285/215 split with a
good p-value is what a coin looks like when you test it enough ways.

**The fix, as a guard rather than a note.** `bench/ab-protocol.mjs` (new) runs every A/B **twice on
independent seeds** and judges replication; `feature-ab.mjs` and `weight-ab.mjs` both go through it,
so there is one answer to "is this better?" and neither tool can drift from it. Every combination of
outcomes is named — `CONFIRMED STRONGER`, `CONFIRMED WEAKER`, `CONTRADICTORY`, `NOT REPLICATED`,
`INCONCLUSIVE`, `NO EFFECT` — because the first draft printed "only the second seed set showed an
effect" for a pair where *neither* had. Only `CONFIRMED STRONGER` is grounds to ship.

Verified in both directions before shipping: alphaStrike reports `CONFIRMED STRONGER` (37/0 then
36/0); `ownCreatureLossPerStat` reports `INCONCLUSIVE`.

**What was checked as a result.** The already-shipped features were re-run on the independent seed to
make sure nothing in the tree rests on a fluke. The alpha strike replicates overwhelmingly (158/0).
Nothing needed reverting.

**What this costs and why it is worth it.** Every strength claim now takes two runs instead of one.
That is the difference between a measurement and a story, and this section is the receipt: without it
`ownCreatureLossPerStat: 1.5` would have shipped with "measured stronger, p = 2.03e-3" in its commit
message, and every later result built on that pilot would have inherited the error.

**Standing note for whoever continues the strength work.** The map is `disagreement.mjs`: the gap is
entirely in attack selection, and specifically in *which bodies go*, since aggression itself is
measured to be at a local optimum (attacking less is worse; attacking more is neutral or already
done — §3.80). That is a set-level blocking-assignment problem, not another independent per-attacker
rule, and it must clear the two-seed bar.

### 3.83 Blockers are a shared resource — attacking judged as a SET — ✅ done

> ⚠️ **CORRECTED BY §3.88: this improves the `heuristic` pilot, which is NOT the default.**
> `DEFAULT_PILOT_ID` is `lookahead`, and lookahead replaces the attack step this section
> changes. The gain is real and confirmed, and it reaches `--pilot heuristic` runs and the
> rollout policy inside `hybrid`/`mcts` — but not the attack decision the default pilot makes.

The first confirmed strength gain since the alpha strike, and the one the map in §3.82 pointed at.

**The defect.** `attackIsProfitable` judges every attacker **independently**, each against the *full*
set of enemy blockers — as though each one could be met by all of them. That is true of the first
attacker and false of every one after: a defender with one body cannot answer four attackers, however
badly each fares alone. The pilot was declining attacks a defender had no way to punish.

**Where the measurement pointed.** `bench/disagreement.mjs` (§3.82): 100% of this pilot's
disagreements with `lookahead` are in `declareAttackers`, and **36.2% of those are both pilots
attacking with a different SET** — not a different appetite, a different roster. Aggression tuning was
already measured to be at a local optimum (attacking less is clearly worse, p = 6.7e-6; attacking more
is neutral or already done, §3.80), so the roster was what was left.

**The fix.** Score whole candidate attacks against the defence's best answer, and send the one that
comes out ahead. Candidates are the greedy per-attacker roster, the all-in roster, and each single
add/remove from greedy — O(n) scored sets rather than 2^n. The defender model is greedy (best block
first) and is **deliberately the same model the per-attacker code already uses**: if this scored
attacks against a sharper defender than the rest of the pilot assumes, the two halves would disagree
about the same board.

**Measured, on two independent seed sets as §3.82 requires:**

```
setAttack ON vs OFF — 9 decks, 2880 games per run
  run 1 (seed 4242):  ahead A 58 · ahead B 21 · level 1361 · p 5.12e-5
  run 2 (seed 90210): ahead A 60 · ahead B 23 · level 1357 · p 7.77e-5
  VERDICT: CONFIRMED STRONGER — both seed sets agree.
```

Same direction, near-identical magnitude, both far past threshold. This is what a real improvement
looks like next to the fluke §3.82 caught (285/215 then 250/247).

**Rule 7, paid before moving on.** The first version cost **11% of sim throughput** — it recomputed
`power`/`toughness`/`canBlockByEvasion` inside every candidate's scoring loop. Two fixes brought it
down, both measured on a fixed corpus with `bench/pilot-decide-bench.mjs --feature setAttack`:

| version | decision cost |
|---|---|
| naive | +6.9% |
| board facts pre-computed once into flat arrays, candidates scored as bitmasks | +3–4% |
| attachment sweep hoisted out of the per-attacker loop | **+2.7%** |

The last one is the interesting fix and it was not in the new code: `saboteurTriggerCount` walks the
whole battlefield looking for things attached to its argument, so calling it per eligible attacker is
O(attackers × battlefield). One sweep now collects hosts up front. Behaviour is byte-identical across
that optimisation (A won 851/2000 before and after; the A/B numbers are unchanged to the slot).

**+2.7% of decision time is a cost, not parity, and it is stated rather than rounded away.** Decisions
are roughly a quarter of sim runtime, so it is well under 1% of throughput — bought with a
double-confirmed strength gain, which is the trade this project exists to make.

⚠️ **Two traps this shipped with, both found by measuring rather than reasoning:**

- **`games/sec` cannot compare two pilots of different strength.** A stronger pilot plays *different
  games* (851 wins vs 806 on the same 2,000 seeds), so throughput moves for reasons that are not
  cost. Only a fixed recorded corpus answers "what does this cost?".
- **Timing two arms back-to-back is order-biased, and largely so.** Timed sequentially, the arm doing
  strictly *more* work measured **9.9% faster** — the second arm inherits a JIT-warmed process. The
  bench now interleaves reps and alternates which arm goes first within each rep.

**Guard:** `packages/ai/src/set-attack.test.ts` pins both halves — it sends the bodies the defence
cannot answer (four 2/2s into one 4/4, and the control asserts the old rule refused exactly that
attack), and it still declines when every attacker has a blocker waiting, when a lone attacker would
simply die, and it does not swallow the attack in the no-blockers case the refiner deliberately skips.

### 3.84 The search is not the bottleneck — the scoring is — ✅ done

A round of four measurements, no code shipped, and one result that redirects every future attempt at
the attack decision. Recorded because "we already tried that, here is the number" is the cheapest
thing this file can give the next person.

**1. The map moved, which is the first evidence §3.83 worked outside its own A/B.** Re-running
`bench/disagreement.mjs` against `lookahead` after the set-attack rule shipped:

| | before §3.83 | after |
|---|---|---|
| disagreements | 271 (**0.80%**) | 191 (**0.54%**) |
| heuristic attacks, lookahead passes | 162 (59.8%) | 78 (40.8%) |
| both attack, **different set** | 98 (36.2%) | 93 (48.7%) |
| heuristic passes, lookahead attacks | 11 (4.1%) | 20 (10.5%) |

A 29% drop in total disagreement, and the band §3.83 targeted is the one that shrank. What remains is
dominated by *which set*.

**2. Attacking less is definitively wrong — now replicated.** `attackValueThreshold` 1 → 2, on both
seed sets: **15 / 95 (p = 5.0e-14)** and **6 / 93 (p ≈ 0)**. `CONFIRMED WEAKER`, about as
one-sided as this repo has measured anything. The 40.8% of disagreements where lookahead declines an
attack the heuristic makes are **not** misplays by the heuristic; that direction is closed.

**3. THE RESULT THAT MATTERS: the local search is already effectively exact.** `bestAttackSet`
considers the greedy roster, the all-in roster, and each single add/remove — a local move set, which
invites the obvious objection that the best attack could be two moves away. So it was made exhaustive
for boards small enough to afford it (≤ 6 attackers ⇒ every one of the 64 subsets scored):

```
exactAttack ON vs OFF — 2880 games per run
  run 1: ahead A 2 · ahead B 1 · level 1437
  run 2: ahead A 4 · ahead B 3 · level 1433
  VERDICT: INCONCLUSIVE   (cost: +3.5% of decision time)
```

Out of 1,440 matched slots, **three** and **seven** differed at all. Enumerating every subset almost
never finds a better attack than the local moves do — so the local search is not what stands between
this pilot and a better one, and a smarter *search* is wasted effort.

⚠️ **The corollary, and the standing direction for this work: the remaining gap is in the SCORING
FUNCTION, not the search.** `scoreAttackSet` models the defence as a greedy single-blocker
assignment; it has no gang blocks, no chump blocks, and no notion that attacking taps a creature out
of the next turn's defence. If the attack decision is to improve further, that valuation is where it
has to happen — and it must clear the two-seed bar (§3.82).

**4. Valuing damage more does not help.** `faceDamageValue` 1 → 2: 24/39 then 25/20 — `INCONCLUSIVE`.
Naming it here so it is not re-run.

**Tally after this round: two confirmed strength gains shipped (§3.74, §3.83), ten hypotheses killed
by measurement.** That hit rate is the argument for the harness, not against it: each of these cost
minutes to test and would have cost days to argue about, and two of them (`ownCreatureLossPerStat`,
§3.82) would have shipped on a single-seed p-value.

### 3.85 Two seeds are not enough if you tuned on them — the held-out battery — ✅ done

§3.82 made every A/B run twice on independent seeds. This is the round that found the hole in that
rule, by falling through it.

**Where the idea came from — reading the positions, not the histogram.** `bench/disagreement.mjs`
gained `--show N`, which prints disagreements as readable boards instead of counting them. Eight of
them told a story a histogram could not:

```
[1] life: me 4, them 20   mine: Air Elemental 4/4 (flying)   theirs: Monastery Swiftspear 1/2 (haste)
    heuristic: declareAttackers   lookahead: passPriority
[8] life: me 3, them 11   mine: Kalonian Tusker 3/3, Kitchen Finks 3/2, Kitchen Finks 3/2
    theirs: ... Deadly Recluse 1/2 (reach/deathtouch) ...
    heuristic: declareAttackers atk[83,84,90]   lookahead: passPriority
```

At 3, 4 and 11 life the heuristic taps its board out and the search declines. Attacking removes our
blockers, and at low life that is the whole game.

**The hypothesis, and why it was not §3.75 again.** `trimForDefence` (§3.75, measured weaker and
deleted) was **unconditional** — hold back until a pessimistic counter-swing is survivable, on every
board — and it dropped the **biggest** attacker first, which is usually the best attacker as well as
the best blocker. `defensiveReserve` fired only when the opponent's whole board could actually kill
us, and held back the creature that **absorbs** most per point of offence given up.

**What happened, in order, because the order is the lesson:**

| step | result |
|---|---|
| one-swing horizon, 2,880 games/seed | 20/17 and 22/17 — inconclusive, but positive on both |
| two-swing horizon (widened trigger) | 22/41 and 24/30 — worse; §3.75 re-confirmed |
| back to one-swing, 11,520 games/seed | **94/67 (p=0.041) and 95/64 (p=0.017) — "CONFIRMED STRONGER"** |
| two seeds it had never seen | **77/78 and 68/68 — dead level** |

⚠️ **The one-swing variant was CHOSEN over the two-swing variant by those same two seeds.** The
development set then validated the thing it had selected, which is overfitting with extra steps. On
held-out seeds the effect is 145 / 146 — nothing. **Not shipped.**

**The fix: the battery, and the held-out seeds decide.** `bench/ab-protocol.mjs` now runs four
independent seeds — two to develop against, two that decide — and pools the held-out slots into one
McNemar. `--seed S` shifts the whole battery, so a genuinely fresh set of four is one flag away,
which is what you want after tuning against the defaults. The development seeds are printed but
carry no weight in the verdict: their agreement is not evidence, it is the thing being tested.

**The shipped features were re-validated against the stricter bar**, since a rule that would have
rejected them would matter far more than one that rejects a candidate:

```
setAttack ON vs OFF
  dev      (4242):   58/21   dev      (90210):  60/23
  HELD-OUT (555001): 51/23   HELD-OUT (777003): 43/29
  CONFIRMED STRONGER — held-out 94/52 (chi2 11.51); all seeds pooled 212/96.
```

All four seeds lean the same way. §3.83 is real. (§3.74's alpha strike is 158/0 on a fresh seed —
never in doubt.)

⚠️ **A second trap caught in the same round: the benches import from `dist`.** Reverting a source file
and re-running an A/B without rebuilding measures the OLD code and says nothing about the tree. It
produced a plausible-looking 46/21 for a feature whose real number is 58/21 — plausible enough that
it was nearly written down. **Rebuild between a revert and a measurement, every time.**

**Tally: two confirmed strength gains shipped, twelve hypotheses killed by measurement.** Two of the
twelve had already cleared the bar in force at the time, which is the entire argument for raising it.

### 3.86 Five ways to make the pilot more cautious, all measured worse — the aggression question is closed — ✅ done

> ⚠️ **SCOPE, per §3.88: these five all concern the `heuristic` pilot.** The conclusion holds
> for the default pilot too and from the other side — measured against `hybrid`, `lookahead`
> is too PASSIVE (it passes where hybrid attacks 60 times to 6).

The strength work has kept returning to one place: `lookahead` declines attacks this pilot makes, and
that looks like a defect. It is not, and this section is the point at which the evidence becomes
strong enough to stop re-testing it.

**The last two attempts, both from reading positions rather than histograms.**
`bench/disagreement.mjs --show N --band set` prints only the band where *both* pilots attack with a
different roster — the largest remaining band (48.7%). Seven of them:

```
[3] me 20, them 16   mine: ... Llanowar Elves 1/1, Craw Wurm 6/4, Giant Spider 2/4 ...
    heuristic: atk[21,31]   lookahead: atk[31]
[7] me 20, them 22   mine: Birds 0/1, Giant Spider 2/4, Llanowar Elves 1/1, Craw Wurm 6/4 ...
    heuristic: atk[23,29]   lookahead: atk[29]
```

In four of the seven, the extra body the heuristic sends is a **mana creature** — Llanowar Elves,
Birds of Paradise, Eternal Witness — going in for one or two damage. Attacking taps it, so the mana
it would have made in the second main phase is gone: a cost the combat maths never saw. That is a
real and specific hypothesis, and it was wrong.

| cost charged per mana creature | held-out result |
|---|---|
| 1 (equal to one damage) | 5/8 — `NOT REPLICATED`, and it barely fired: at parity the score is unchanged and ties keep the incumbent |
| 2 (a recurring source is worth more than one hit) | **7/18, chi² 4.00 — `CONFIRMED WEAKER`** |

**The pattern, across five independent attempts.** Every rule that makes this pilot attack *less* has
now been measured, and every one of them is worse or nothing:

| rule | verdict |
|---|---|
| `trimForDefence` — hold back until a counter-swing is survivable (§3.75) | weaker (18/39) |
| `attackValueThreshold` 1 → 3 (§3.82) | weaker (22/65) |
| `attackValueThreshold` 1 → 2 (§3.84) | **CONFIRMED WEAKER** (15/95, 6/93) |
| `defensiveReserve` — keep a blocker when the crack-back can kill us (§3.85) | not replicated (held-out 145/146) |
| `manaCreatureCost` — price the mana a tapped attacker would have made | **CONFIRMED WEAKER** (7/18) |

And the one rule that *did* confirm — `setAttack` (§3.83) — makes the pilot attack **more precisely,
usually with more bodies**, by noticing the defence cannot block them all.

⚠️ **The conclusion, and it is now well earned: the disagreements with `lookahead` are not misplays.**
§3.75 guessed this ("copying a searching pilot's conclusion is not the same as having its reasons")
from one experiment. Five now say it. `lookahead` is more cautious than is correct in this engine,
and a rule shaped like its caution throws away races this pilot is winning. **The attack step is at a
local optimum for this architecture, and further caution rules should not be attempted** — the next
person's idea in this direction has almost certainly already been measured above.

**What that means for "make the pilot smarter".** The remaining disagreement is 0.54% of decisions
(§3.84), it is entirely in attack selection, the *search* over attack sets is already exact (§3.84),
and every *valuation* change that makes it more cautious is worse. What is left is not a rule this
pilot is missing; it is a different class of pilot — one that evaluates positions rather than
scoring them, which is what `lookahead` and `mcts` already are, and which this engine measures as
only modestly stronger (42 slots to 10, 88% level, agreeing on 99% of decisions).

**Tally: two confirmed strength gains shipped (§3.74, §3.83), fourteen hypotheses killed by
measurement.** The two that survived both make the pilot act *more*, not less.

### 3.87 The fourth speed axis: how many games the verdict actually needed — ✅ done

Three axes of "why is it not faster" were already measured, and all three are about making the work
cheaper. This is the fourth and last one available: **how much of the work was needed at all.**

**The tool.** `bench/early-stop.mjs` replays a real paired A/B slot by slot and finds the earliest
point at which the verdict was already the final one *and* already significant — the game count a
sequential stopping rule could have used. An arm that never reaches significance is charged the full
budget, which is the honest accounting: an inconclusive answer needs every game by definition.

**Measured** (Mono-Red Aggro, 15 legal swaps, 8 opponents, 20 games/matchup = 160 paired slots each):

| swap | final p | settled at |
|---|---|---|
| Beetleback Chief → Lightning Helix | 2.0e-7 | **27** / 160 |
| Lightning Bolt → Swords to Plowshares | 3.6e-5 | 31 / 160 |
| Goblin Guide → Savannah Lions | 6.0e-3 | 51 / 160 |
| Searing Spear → Boros Guildgate | 1.2e-2 | 137 / 160 |
| Goblin Guide → Krenko's Command | 3.3e-1 | **160** / 160 (never settles) |
| Monastery Swiftspear → Goblin Instigator | 1.0e+0 | **160** / 160 (never settles) |

**Slots played 2,400; slots a perfectly-calibrated test would need 1,204 — an upper bound of 1.99×.**

⚠️ **And "upper bound" is doing real work in that sentence.** Stopping at the first `p < 0.05` while
peeking after every game inflates the false-positive rate badly — it is the same error as §3.82's
seed-shopping, in the time dimension. A sound group-sequential design spends games buying that error
back, so it delivers materially less than 1.99×. On a first pass the honest expectation is ~1.4×.

**Why it is measured and NOT built.**

- `suggest` — the command where this would matter most — **already realises most of it**. Its adaptive
  ladder eliminates candidates between waves, which is the same saving applied at the candidate level
  rather than the slot level (§3.6). The remaining value is for `swap` and `pilot-ab`.
- ~1.4× on two commands is real but modest, and it buys that by adding sequential-testing machinery
  to a codebase that has just learned two expensive lessons about exactly this kind of statistics
  (§3.82, §3.85). The rule here is measure first and follow the measurement; the measurement says the
  prize is small and the failure mode is one this project has already paid for twice.

**So the speed question is now closed on all four axes, with a number for each:**

| axis | finding |
|---|---|
| per-action cost (§3.78) | flat — heaviest function 6.1% self time, top ten 38.4% |
| action count (§3.79) | no large removable share — the unreachable ceiling is under 1.35× |
| decision cost (§3.81) | flat — heaviest 8.4%, and that function is already tuned |
| games needed (§3.87) | upper bound 1.99×, mostly already realised by the adaptive search |

None of them contains a 10×, and together they account for essentially all of the work the sim does.
**The throughput that was won — +48% single-thread (§3.62) and 2.89× on `suggest` (§3.77) — came from
the two things this table does not measure: doing fewer decisions, and doing them on more cores.**

### 3.88 A correction: the pilot we ship is `lookahead`, and the strength map was measuring the wrong one — ✅ done

⚠️ **This section corrects §3.82–§3.86.** The strength work in those sections is not wrong, but it was
aimed at a pilot that is **not the default**, and one of its headline findings was a tautology. Both
are worth more than another tuning round.

**The facts.** `DEFAULT_PILOT_ID` is `LOOKAHEAD_PILOT_ID`, not the heuristic — in the CLI, and in the
web Lab, where the pilot list names it "Lookahead (default)". `lookahead` (§3.47) delegates every
decision to an unmodified heuristic **except the attack declaration**, which it decides with
`combat-forecast.ts`.

**What that means for what was measured:**

1. **`setAttack` (§3.83) does not change the default pilot.** It improves `heuristic.chooseAttack` —
   which lookahead replaces. The gain is real and confirmed (held-out 94/52) and it does reach the
   `--pilot heuristic` runs and the rollout policy inside `hybrid`/`mcts`, but §3.83 said "the pilot"
   without saying which, and a reader would reasonably assume the default.
2. **"100% of the disagreements are in `declareAttackers`" (§3.82) was a TAUTOLOGY.** Comparing
   heuristic to lookahead can only surface attack disagreements: the two share every other decision
   by construction. That result described the shape of the composition, not a property of the pilot,
   and it steered four sections of work into one step.

**The measurement that should have been run — the DEFAULT pilot against a much stronger searcher**
(`bench/disagreement.mjs --base lookahead --pilot hybrid`, 18 games, 9,366 decisions with a real
choice):

> **175 disagreements (1.87%)** — and spread across the whole game, not one step:

| band | share |
|---|---|
| attacks (`pass→attack` 34.3%, different set 22.3%, `attack→pass` 3.4%) | **60%** |
| blocking (`block→pass` 7.4%, `pass→block` 6.3%, different blocks 0.6%) | **14.3%** |
| land choice (`playLand→playLand`) | **9.7%** |
| spell choice (`castSpell→castSpell` and friends) | **7.5%** |
| mana sequencing (`tapForMana→…`) | **5.7%** |

⚠️ **And the direction reverses.** Against the heuristic, lookahead is the cautious one. Against
`hybrid`, **lookahead is too passive**: hybrid attacks where lookahead passes in **60** cases and the
reverse in **6**. That is the same conclusion §3.86 reached from the other side — this pilot family
wants to attack *more*, not less — now confirmed for the pilot that actually ships.

**New tool: `bench/forecast-ab.mjs`**, the A/B for the shipped pilot's own `ForecastWeights`
(`weight-ab.mjs` tunes the heuristic, which is not the default). Same four-seed held-out battery.

**First hypothesis from the new map, and it did not survive.** `crackBackPerPoint` (the penalty for
exposing yourself to a counter-swing — the aggression dial) 0.5 → 0.25, matching hybrid's greater
appetite:

```
  dev      4242:   31/24      dev      90210:  30/25
  HELD-OUT 555001: 18/21      HELD-OUT 777003: 35/15
  NOT REPLICATED — held-out 53/36 (pooled chi2 2.88, needs > 3.84)
```

Pooled over all four seeds it reaches 114/85 (chi² 3.94) — which is exactly the marginal, seed-dependent
shape §3.85 was written to reject. Not shipped.

**The standing direction, corrected.** The default pilot's headroom is **not** concentrated in attack
selection: blocking (14%), land choice (10%) and spell choice (8%) together are a third of it, and
none of them has ever been examined — every strength section before this one looked only at attacks,
because the comparison chosen could not show anything else. `disagreement.mjs --base lookahead
--pilot hybrid --show N --band …` is how to look at them.

### 3.89 The blocking band, examined — and a diagnostic that was lying — ✅ done

§3.88 opened three bands of the default pilot's headroom that had never been looked at. This works the
largest of them, blocking (14.3% of the gap), and reports what it found — including a bug in the tool
that found it.

⚠️ **First, the tool was lying.** `disagreement.mjs` printed every position with the labels
`heuristic:` and `lookahead:` **hardcoded**, so under the `--base` flag §3.88 added it attributed the
base pilot's move to "heuristic" and the rival's to "lookahead" regardless of what was actually run.
A mislabelled diagnostic is worse than no diagnostic: every conclusion drawn from it is backwards for
half the runs. Fixed to print the pilot ids it was given.

**What the blocking disagreements look like** (`--base lookahead --pilot hybrid --band block`): with
one exception the shape is always the same — **`hybrid` blocks where the shipped pilot passes**,
spending a small creature to stop a large hit at healthy life (16, 12, 14).

**The mechanism is already in the pilot, and it is one number.** `chooseBlock` computes
`desperate = facingLethal || myLife <= weights.desperateLifeThreshold` and chump-blocks only when
desperate; otherwise blocks are value-judged. `desperateLifeThreshold` ships at **10**, so a defender
at 16 taking 6 is not desperate and declines the chump — exactly the positions above.

**New capability:** `bench/forecast-ab.mjs --heuristic <field>` now varies a **HeuristicWeights**
field on the **lookahead** pilot. This matters because lookahead *delegates* blocking, land sequencing
and spell choice to the heuristic — so those are testable on the shipped pilot, which `weight-ab.mjs`
(heuristic-only) cannot do.

**Measured, both directions of the dial:**

| `desperateLifeThreshold` | held-out | verdict |
|---|---|---|
| 10 → **16** (block far more readily) | **32 / 92**, chi² 28.07 | **CONFIRMED WEAKER** |
| 10 → **5** (block less readily), battery A | 45 / 29, chi² 3.04 | not replicated |
| 10 → **5**, **fresh battery** at 3× games | 113 / 89, chi² 2.62 | not replicated |

The 16 result is decisive and useful: **blocking more is clearly wrong**, which is the defensive twin
of §3.86's five aggression findings. The 5 result leans positive in three of four seeds across two
*independent* batteries and never crosses the bar — the signature of an effect too small to matter, or
of nothing. Either way it is not shipped.

⚠️ **Note the discipline that cost the second run.** Having tested 16 and then 5, choosing 5 and
confirming it on the *same* held-out seeds would have repeated §3.85's error exactly: the seeds that
select a variant cannot also validate it. `--seed S` shifts the whole battery, and the fresh four
agreed with the first four — which is the only reason the "not replicated" verdict here can be
trusted.

**What this leaves.** The blocking gap is **not a threshold problem** — the one dial governing it is at
or near its optimum in both directions. Whatever `hybrid` sees in those positions is in the *value*
judgement of a specific block, not in when the pilot is willing to chump. Land choice (9.7%) and
spell choice (7.5%) remain unexamined, and are now reachable with `forecast-ab.mjs --heuristic`.

**Tally: two confirmed strength gains shipped, seventeen hypotheses killed by measurement.**

### 3.90 A disagreement must be about a CARD, not an instance id — and the land band, sized — ✅ done

A tool correction that guards a whole class of misreading, and the measurement that closes the third
of §3.88's unexamined bands.

⚠️ **The bug: `disagreement.mjs` compared actions by bare instance id.** Two copies of one card hold
different ids, so a pilot playing the *second* Island where another played the *first* was recorded as
a disagreement about land choice. Every band whose action names a card — `playLand`, `castSpell`,
`tapForMana`, `activateAbility` — was therefore inflated with choices that are not choices, and the
land band is mostly land drops from a deck full of duplicates. The signature now resolves the id to a
**card name** across every zone the pilot can see, and falls back to the id only when it cannot.

**Measured after the fix, and the honest result: the totals did not move.** 175 disagreements (1.87%)
before and after, and the land band is still 17 of them. Looking at the positions says why:

```
[1] mine: Wall of Omens   lookahead: playLand "Island"   hybrid: playLand "Plains"
[2] mine: Wall of Omens ×2  lookahead: playLand "Plains"   hybrid: playLand "Island"
```

These are a UW deck choosing **which colour to commit** — a real decision, not two copies of one land.
So the band survives its own audit. That is worth recording precisely *because* the fix changed
nothing: the guard is now in place for every future band, and the number it was checking is confirmed
rather than merely unchallenged.

**Sizing it honestly.** The land band is 9.7% of a 1.87% disagreement rate — **0.18% of all decisions
the pilot makes**. Spell choice is 7.5% of 1.87%, or 0.14%. For comparison, the two shipped strength
gains came from bands an order of magnitude larger. There is no cheap tunable here either: "which
basic to play" is a function of the hand, the curve and the colours still needed, which is what
`land-sequencing.ts` already computes — not a threshold with a wrong value in it.

**So all three of §3.88's bands are now sized, and none is a threshold problem:**

| band | share of the gap | share of ALL decisions | finding |
|---|---|---|---|
| attacks | 60% | 1.12% | §3.86: five caution rules worse; the one gain makes it attack *more* |
| blocking | 14.3% | 0.27% | §3.89: the one dial is at its optimum in both directions |
| land choice | 9.7% | 0.18% | here: real, but a hand-dependent judgement, not a dial |
| spell choice | 7.5% | 0.14% | unexamined; same shape as land choice |

**What that means, stated plainly.** The shipped pilot disagrees with a searcher costing ~550× more on
**1.87% of decisions**, and every part of that gap is either measured to be the searcher's error
(attacks) or a judgement with no tunable behind it. Further strength work on this pilot is not a
matter of finding the right constant; it needs the searcher's *method* — evaluating positions instead
of scoring them — at a cost this project has already measured and rejected for the default pilot.

### 3.91 A core is not worth a core — the machine's real parallel ceiling — ✅ done

The last unexamined speed question, and the one that reframes §3.77: **`suggest` reaching 2.56× on six
workers is not 43% efficiency. It is 71% of everything this machine can give.**

**How the question came up.** The scaling curve for `suggest --workers N` (100 games/candidate, 6
candidates, search time only):

| workers | 1 | 2 | 4 | 6 | 8 | 12 |
|---|---|---|---|---|---|---|
| search | 26.9s | 15.6s | 11.0s | **10.5s** | 11.9s | 13.3s |
| speed-up | 1.00× | 1.72× | 2.44× | **2.56×** | 2.26× | 2.02× |

It plateaus at the physical core count and then degrades — expected, since SMT siblings slow this
workload (§3.53). But 2.56× from six cores looked like a lot of waste, so the phases were traced
(`JB_SUGGEST_TRACE=1`, kept — it is how this was found):

```
base  18 jobs, slots   0..200, 2061ms      arms  108 jobs over 6 arms, 4180ms
base  18 jobs, slots 200..400,  508ms      arms   54 jobs over 3 arms, 2032ms
base  18 jobs, slots 400..800,  852ms      arms   36 jobs over 2 arms, 1440ms
```

11,073ms traced against an 11.19s run: **every millisecond is inside a batch — the host contributes
nothing.** A CPU profile of the host agrees: **98.6% idle.** And the obvious suspects are not there
either — `loadCardPool` is 13ms, `buildRegistry` 1ms, and `openArm` (which builds and legality-checks a
variant deck out of a 5,065-card pool) is **0.2ms**. The first base batch is slow purely because six
worker threads are booting inside it.

**So the workers themselves are slow, and the decisive test uses none of this code.** Run the plain
single-threaded `pilot-bench` alone, then run six copies of it as separate processes — no shared
state, no barriers, no coordination of any kind:

```
one process alone:      182 games/sec
6 processes at once:    110, 109, 110, 108, 109, 110   →  656 aggregate
per-process efficiency: 60% of solo speed
CEILING: 3.60x from 6 processes
```

⚠️ **A core is worth ~60% of itself once its neighbours are busy.** The workload is memory-heavy and
all-core clocks sit below single-core boost, so **embarrassingly parallel work does not scale
linearly here** — 3.6×, not 6×. Committed as `bench/parallel-ceiling.mjs` so the number can be
re-measured on any machine rather than assumed.

**Re-judged against the real ceiling:** `suggest` 2.56 / 3.60 = **71% of achievable**. The missing 29%
is worker boot (~1.5s, amortising on longer runs) and the round barriers the ladder requires. That is
a decent result, not the poor one the core count implied — and §3.77's headline 2.89× was closer to
optimal than it was reported as.

**What this finally lets us say about "10× faster", with numbers rather than an opinion.** Every axis
now has a measured ceiling, and they multiply:

| axis | best available | source |
|---|---|---|
| single-thread engine | **1.48×** (achieved) | §3.62, §3.78–§3.81 — profile flat, no hotspot |
| parallel hardware | **3.60×** (ceiling; 2.56× achieved) | here |
| fewer games needed | **1.99×** (upper bound, mostly already taken) | §3.87 |

Stacking all three at their *absolute* ceilings — perfect parallel efficiency, a perfectly calibrated
sequential test — gives **1.48 × 3.60 × 1.99 ≈ 10.6×**, and every one of those factors is an
optimistic bound that no real implementation reaches. Realistically achieved today: **1.48 × 2.89 ≈
4.3×** on `suggest` versus where this work started.

**10× is therefore not "hard" on this machine — it is at the edge of what the hardware, the profile
and the statistics permit combined, and only if every ceiling were reached exactly.** That is the
honest end of the speed question.

### 3.92 `--until-decided` — a swap that stops when the answer is in — ✅ done

§3.87 measured this axis (upper bound 1.99×) and deliberately did **not** build it, because the naive
version — peek after every game, stop at the first `p < 0.05` — is the same error as §3.82's
seed-shopping in the time dimension. This is the version that is sound, and it ships.

**The mechanism: a pre-registered Pocock boundary.** Fix the number of looks *in advance*, and require
every look to clear the same, tighter threshold. `sequential.ts` holds the constants as a **closed
table** — a look count that is not tabulated is refused rather than interpolated, because an
interpolated boundary is an unknown error rate wearing a number's clothes. At the default K = 4 each
look is judged at **0.0182**, so the run-wide false-positive rate is still the 0.05 the report quotes.

**The enabler: windows are prefixes.** `planPairedSlices` gained an optional `window`, and because
every game seeds off its **absolute** (opponent × game) index, playing `[0,G)` then `[G,2G)` yields
exactly the games `[0,2G)` would. Stopping early therefore plays *fewer* games, never *different*
ones — `sequential.test.ts` pins that against `evaluateSwap` with `JSON.stringify` equality.

**Measured** (`swap Mono-Red Aggro`, 200 games/matchup, 6 workers):

| swap | mode | games | search | verdict |
|---|---|---|---|---|
| Bolt → Swords (decisive) | full | 3,200 | 10.77s | WORSE |
| Bolt → Swords | `--until-decided` | **800** | **5.75s** | WORSE — *stopped after 1 of 4 looks, 75% of budget unspent* |
| Goblin Guide → Krenko's (marginal) | full | 3,200 | 10.55s | BETTER |
| Goblin Guide → Krenko's | `--until-decided` | 3,200 | 10.79s | BETTER — *ran the full budget* |

**Both halves matter.** A decisive swap costs **a quarter of the games**; a marginal one runs the full
budget at **the same wall clock** (14.1s either way) — the feature is free when it cannot help.

⚠️ **And one bug found by measuring rather than assuming.** The first implementation called
`runJobsOnWorkers` per window — which is pool-*run*-close, so every window hired six fresh worker
threads. Worker boot dominates a short run, and a 4× cut in *games* came out as only a 1.95× cut in
*wall clock*. Holding one `createWorkerPool` across the windows is what makes saved games show up as
saved time, and it is also why the marginal case now costs nothing.

**What this is worth against the goal.** §3.91 priced the speed ceilings as
1.48 × 3.60 × 1.99 ≈ 10.6× stacked at their absolute bounds. This converts part of that third factor
from a bound into a shipped feature: **4× fewer games on a decisive `swap`**, which is the command a
user runs while waiting. It does not apply to `suggest` — the adaptive ladder already eliminates
candidates between waves, which is the same saving one level up (§3.6).

**Extended to `pilot-ab`.** It is structurally the same experiment — a paired comparison read with
McNemar — so it takes the same boundary and the same window property, with no new statistics.
`planPilotAbSlices` gained the same optional `window`, and it holds ONE pool across windows rather
than repeating the pool-per-window mistake above.

| | games | search | verdict |
|---|---|---|---|
| `pilot-ab` heuristic vs lookahead, full | 4,320 | 14.02s | WEAKER, p 3.99e-3 |
| the same, `--until-decided` | **2,160** | **9.19s** | WEAKER, p 4.07e-3 — *2 of 4 looks, 50% unspent* |

⚠️ It took **two** looks, not one: the first look-s p did not clear the tighter Pocock threshold.
That is the boundary doing its job rather than stopping at the first encouraging number — the exact
failure this design exists to prevent.

### 3.93 The Lab stops when the answer is in — early stopping reaches the UI — ✅ done

§3.92 shipped group-sequential stopping for the CLI's `swap` and `pilot-ab`. This puts it where the
user actually waits: the Lab's **A/B Swap Test** panel.

**One boundary, not two.** `planSequentialLooks` is now exported from `@jonny-boi/sim` and the web
imports it. The Lab and the CLI therefore stop on the *same* rule at the *same* thresholds — two
stopping rules would be two answers to one question, and the second one would be the one nobody
re-derived when the first changed. `LAB_SEQUENTIAL_LOOKS` is named next to the CLI's default so the
two cannot silently drift apart.

**The same window property.** `planPairedShards` gained the optional `window` its CLI counterpart has,
and for the same reason: every game seeds off its absolute index, so `[0,G)` then `[G,2G)` is exactly
`[0,2G)`. Stopping early plays **fewer** games, never **different** ones.

⚠️ **The progress bar still counts the WHOLE budget.** It is planned from the full run even when
stopping early is on. A bar sized to what the run turned out to need would either reach 100% and keep
going, or leap to the end when a window closed — reporting the stopping rule as progress. The user
asked for N games; the bar shows N, and the result says how many were actually needed.

⚠️ **And the result SAYS SO.** When a run stops early the panel prints how many of the four checks it
took, how many games of the budget it played, and the tighter alpha each check used. A smaller `n`
with no explanation would leave the reader to infer that something went wrong — "told, never implied"
is the whole reason the field exists on the payload rather than living only in the worker.

**Default on.** A decided swap finishes in a fraction of the games; an undecided one runs the whole
budget and costs nothing (§3.92 measured both). The only reason to turn it off is wanting the tightest
possible *estimate of the delta* rather than the verdict, and the checkbox says exactly that.

⚠️ **A verification note worth keeping.** The first attempt to check this in the browser looked at the
wrong tree: the Browser pane's dev server runs from the session's **primary working directory**, not
from the worktree the edit was made in. The panel rendered without the new control and the obvious
conclusion — "the change did not work" — was wrong. A second wrong turn on the way: `section-label`
is uppercased by CSS, so `innerText` searches for the label text must be case-insensitive. Both cost
real time; both are cheap to avoid once written down.

### 3.94 `--until-precise` — a gauntlet that plays until the interval is tight enough — ✅ done

The last fixed-budget command. `swap` and `pilot-ab` got group-sequential stopping (§3.92); the
gauntlet needs something different, and getting that difference right is most of this section.

⚠️ **A gauntlet ESTIMATES; it does not TEST.** "Is A better than B?" is a hypothesis test, where
peeking inflates the false-positive rate and the fix is a stricter bar per look. "What IS this deck's
win rate?" has no null to reject — what is being controlled is the WIDTH of the interval. Applying the
Pocock boundary here would be answering the wrong question with the right-looking machinery, and the
result would have looked perfectly reasonable.

**So: Stein's two-stage rule.** Play a small pilot, estimate `p`, compute how many games that implies
for the requested half-width, play up to that many (capped by the budget). One decision, no peeking —
a rule that stopped the instant the interval looked narrow enough would stop preferentially on runs
where the sample happened to be lucky, biasing the estimate toward whatever the early games said.

**Measured** (`gauntlet Mono-Red Aggro`, 8 opponents, 6 workers):

| | games | interval | search |
|---|---|---|---|
| `--games 100` | 800 | 35.3% (32.0–38.6) — **±3.3%** | 5.26s |
| `--games 100 --until-precise 0.05` | **360** | 35.3% (30.5–40.3) — **±4.9%** | **3.78s** |

**2.2× fewer games for the precision that was actually asked for.** The full run *over*-spent: it
bought ±3.3% when the caller wanted ±5%. Same point estimate either way.

⚠️ **Two things the tests caught before this shipped**, and the first was a real design flaw:

- **The pilot was a quarter of the budget.** On a generous budget that pilot is enormous (2,500 games
  of a 10,000 budget), so it dominates the decision and the run can never spend less than a quarter
  however lopsided the deck turns out to be — capping the whole saving at 4× and usually at 1×. The
  pilot is now a modest absolute size (8–40 games): it only has to estimate `p(1-p)` well enough to
  size stage two.
- **A freak pilot must not end the run.** `p(1-p)` is zero at the extremes, so an unfloored estimate
  from a 20-for-20 pilot asks for ~0 further games. A variance floor stops a lucky pilot cutting the
  run short, and a test pins it.

⚠️ **The interval printed is always the one EARNED, never the target.** When the budget runs out first
the report says so explicitly — "the budget, not the target, was the limit, so the interval above is
wider than ±H". A precision run that quietly reported the requested width would be inventing
confidence it had not paid for.

**All four fixed-budget commands now stop when their answer is in**: `swap` and `pilot-ab` on a
pre-registered boundary (§3.92), the Lab's A/B panel through the same one (§3.93), and the gauntlet on
a two-stage width rule here. Each uses the statistics its own question calls for, which is the part
that took the care.

**And in the Lab.** `planPrecision`/`decidePrecision` are exported from `@jonny-boi/sim` and the
Gauntlet panel uses them — the same rule, not a second one, exactly as §3.93 did for the A/B
boundary. The Lab reaches for the RIGHT one of the two: the A/B panel takes the group-sequential
boundary, the gauntlet takes this width rule. Same-looking machinery, different question.

Verified end to end in the browser on the branch that matters most — the one where the budget runs
out first:

> Pilot measured 30% and sized the run to 10 of 10 games per opponent. **Your game budget ran out
> before ±5% was reached — the interval below is wider than that.**

A precision run that quietly reported the requested width would be inventing confidence it had not
paid for, so the budget-limited path says so in as many words.

### 3.95 Auditing the shipped pilot's own constants — not overfit, and one of them is a guard rail — ✅ done

§3.82 and §3.85 both caught a "measured stronger" result that was really a seed fluke. That raises an
obvious question nobody had asked: **the default pilot's own `ForecastWeights` were tuned at some
point — were they tuned on one seed?** If so, the pilot everyone gets by default would be running on
lucky constants, and no amount of careful A/B work on new features would fix it.

Audited with `bench/forecast-ab.mjs` on the four-seed held-out battery (§3.85):

| weight | change | held-out | verdict |
|---|---|---|---|
| `crackBackPerPoint` 0.5 | → 0.25 | 53/36, chi² 2.88 | not replicated (§3.88) |
| `racePerTurn` 1.5 | → 1.0 | 19/17, chi² 0.03 | **no effect** |
| `racePerTurn` 1.5 | → 6.0 | 19/46, chi² 10.40 | **CONFIRMED WEAKER** |
| `crackBackLethalPenalty` 100 | → 25 | 0/0, all 5,760 slots level | **NO EFFECT AT ALL** |
| `crackBackLethalPenalty` 100 | → 0 | 1/11, chi² 6.75 | **CONFIRMED WEAKER** |

**Two findings, and both are reassuring rather than actionable — which is the point of an audit.**

**1. `racePerTurn` sits at a BROAD optimum.** A 33% cut does nothing measurable; a 4× rise is clearly
worse. That is the profile of a well-chosen weight, not a knife-edge fit to one seed — a value tuned
into a fluke is fragile in *both* directions, and this one is flat nearby and punishing far away.

**2. `crackBackLethalPenalty` is a GUARD RAIL, and it is saturated.** 100 → 25 changes literally
nothing: **0 decided slots out of 5,760**, on all four seeds. But 100 → 0 is confirmed weaker (1 ahead,
25 behind — it never wins a slot on three of the four seeds). So the term is genuinely load-bearing —
removing it loses games — while its exact magnitude is irrelevant above ~25.

⚠️ **That is the correct shape for what it expresses**, and worth stating so nobody "tunes" it: the
penalty exists to make "do not tap out into your own death" absolute, not to be traded off against
face damage at the margin. A number large enough to dominate is the whole requirement. A future
tuning sweep that includes it will find a flat plateau and learn nothing; the same sweep would find a
cliff at zero, which is the only thing about it worth knowing.

**What this closes.** The default pilot is not running on overfit constants. Combined with §3.88's
re-validation of `setAttack` (held-out 94/52) and §3.74's alpha strike (158/0 on a fresh seed),
everything the shipped pilot's strength rests on has now been checked against seeds it was not built
on. That was worth doing precisely because it found nothing: the alternative was carrying an unchecked
assumption under every later measurement.

### 3.96 Why `suggest` does NOT get early stopping — the saving is the product — ✅ done

`swap`, `pilot-ab` and the gauntlet all now stop when their answer is in (§3.92–§3.94). `suggest` is
the obvious next candidate and the one command a user waits longest on, so this records why it is
deliberately left alone — because the saving is real, visible, and taking it would quietly degrade the
thing the command exists to produce.

**Where the saving appears to be.** A real run (`--games 200 --max-candidates 8`) spends its budget:

| wave | candidates | slots each | dropped |
|---|---|---|---|
| 1 | 8 | 400 | 5 futile |
| 2 | 3 | 800 | 1 outranked |
| 3 | 2 | 1,600 | — |

The two finalists finish at **p = 0** and **p = 5.5e-13**. Both were decisively better than the base
deck long before the final wave — almost certainly by wave 2. Stopping them there would save the
1,600 extra slot-games the final wave costs: **~27% of the whole run.**

⚠️ **And it would be the wrong 27%.** The question `swap` answers is "is this change better than the
base?", and once that is decided, more games buy nothing. The question `suggest` answers is **"which
of these is best?"** — its output is a RANKED list. The two finalists here are +10.1% and +6.8%; the
final wave is what separates them. Stopping both once each is decided *against the base* leaves the
comparison *against each other* exactly as uncertain as it was, and the top-line recommendation — the
one thing a user acts on — gets less reliable while the run gets faster.

**And the ladder already takes the part that IS free.** `selectSurvivors` eliminates on two rules:
`futile` (the optimistic bound cannot reach break-even — it can never be worth playing) and
`outranked` (it is not in contention for the top places). Between them, every candidate whose extra
games could not change the ANSWER is already dropped — five at wave 1 and one at wave 2 in the run
above. What survives to full depth is exactly the set whose precision decides the ranking.

**So the correct stopping rule for `suggest` is not "is this decided against the base?" but "is the
leader decided against the runner-up?"** — a comparison the paired design does not currently make,
since each arm is paired against the base and not against the others. That is a real piece of work,
not a flag, and it is the only version of this that would not cost the ranking.

**Recorded because the naive version is tempting and looks like a 1.4× win.** A future contributor
measuring "games spent on already-decided candidates" will find that 27% and reach for it. The number
is right; the conclusion is not.

### 3.97 Candidates can be compared against EACH OTHER, for free — ✅ done

§3.96 declined a visible 27% saving on `suggest` because the comparison it needed did not exist: each
arm is paired against the BASE, so "decided against the base" says nothing about "better than the
runner-up", and stopping on the former would have cost the ranking. This builds the missing
comparison — and it turns out to cost no games at all.

**The observation.** Every arm of a run plays the **same slots from the same seeds**: slot *i* is the
same opponent, the same game index and the same shared base game for all of them. So "did A win slot
*i*?" and "did B win slot *i*?" are two answers about ONE game. Cross-tabulating them is a proper
**paired** comparison of A against B, built entirely from games already played.

**Why the existing tally could not do it.** `paired` is a 2×2 of (base won, variant won) — it has
already summed each arm against the base and thrown the slot away. Two arms that both beat the base by
10% are indistinguishable in it whether they win the *same* games or *opposite* ones. The information
was being computed and discarded, one slot at a time, in `tallySlot`.

**What changed.** `tallySlot` now records `variantWonBySlot[slot]`, `SwapArm` and `PairedSlice` carry
it, the pooled transport splices each slice in at its absolute offset, and `pairedBetweenArms(a, b)`
cross-tabulates two arms over their **common prefix** — arms sit at different depths once one is
eliminated, and counting the shallower arm's missing slots as losses would invent games nobody played.

**Guards** (`arm-vs-arm.test.ts`):

- an arm compared with **itself** puts every slot on the diagonal, and its recorded wins equal
  `bothWon + variantOnly` from the runner's own 2×2 — the record cannot drift from the tally;
- the comparison spans **6** slots, not 14, when a 6-slot arm meets a 14-slot one;
- it is **symmetric**: swapping the arguments swaps the advantage and leaves McNemar's *p* identical;
- ⚠️ **a SLICED arm compares identically to a locally-played one.** This is the one that matters: the
  parallel `suggest` builds arms from slices, and a per-slot record that differed by a single slot
  would make the pooled run **rank candidates differently** from the sequential run — a divergence no
  existing byte-identity test would catch, because the 2×2 totals would still match exactly.

**What this unlocks.** The stopping rule §3.96 said was the only correct one — *is the leader decided
against the runner-up?* — is now answerable from data in hand. Wiring it into the ladder is the next
step and is deliberately a separate change: this one is a foundation that stands on its own, adds no
behaviour, and is verified against both transports.

### 3.98 `suggest` stops when the LEADER is settled — the 27%, taken correctly — ✅ done

> ⚠️ **CORRECTED BY §3.100: as shipped, this rule downgraded the top pick from BETTER to**
> **INCONCLUSIVE** — it preserved WHICH swap is recommended but not whether it was proven.
> The leader must also be settled against the BASE. The saving is larger after the fix (62%).

§3.96 found a 27% saving on `suggest` and refused it. §3.97 built the comparison that makes refusing
unnecessary. This takes it.

**The rule.** After each wave's cut, cross-tabulate the leader against the runner-up
(`pairedBetweenArms`, §3.97) and test it. If the leader is decided against the runner-up, stop: no
further wave can change **which candidate is recommended**, so the games it would cost buy nothing.

⚠️ **Why this is the only stopping rule that does not cost the ranking.** Stopping on "decided against
the base" — the tempting version §3.96 measured — leaves the comparison a user actually acts on
exactly as uncertain as it was. Stopping on "decided against the runner-up" cannot, because that *is*
the comparison. The difference is the whole of §3.96 and §3.97.

**The waves are the looks**, so the boundary is the Pocock constant for the wave count (§3.92) — the
same discipline `swap` uses. The table is closed, so a wave count it has no constant for is **clamped
upward** to the nearest tabulated value: more looks means a stricter per-look bar, so the run stops
later, never sooner. Conservative in the direction that matters.

**Measured** (`suggest "Mono-Red Aggro" --games 200 --max-candidates 8 --workers 6`, same seed):

| | games | waves | #1 | #2 |
|---|---|---|---|---|
| full ladder | 6,691 | 3 | Piker → Playful Shove **+10.1%** | Guide → Playful Shove +6.8% |
| leader-settled | **4,643** | 2 | Piker → Playful Shove **+9.8%** | Guide → Playful Shove +6.0% |

**30.6% fewer games — and the same recommendation, in the same order.** That is the 27% §3.96
predicted, taken without the cost it warned about.

**Guards** (`leader-settled.test.ts`) — the justification is "the recommendation is unchanged", so
that is what is tested, across four deck/seed combinations rather than the one run it was developed
on:

- the **top pick is identical** with the rule on and off, for two decks at two seeds each;
- it never plays **more** games than the full ladder;
- every candidate is still **reported**, at the depth it reached — stopping the ladder must not drop
  candidates from the output, only shorten them.

**Default on.** It cannot change the answer — that is the property the tests pin — and it removes
roughly a third of the work from the command a user waits longest on.

### 3.99 The Lab gets the settled-leader stop too — and the guard that proves it — ✅ done

§3.98 shipped the leader-settled stop and made it the default. It fired in the CLI. It did **not** fire
in the Lab, and nothing in the suite noticed.

**The gap.** The web's suggest driver shares `driveAdaptiveSearch`, so it inherited the rule — but the
rule is guarded on `leader.variantWonBySlot && runnerUp.variantWonBySlot`, and the web's shards never
carried the per-slot record §3.97 added. The guard failed silently on every round, so the Lab kept
playing the full ladder while the CLI stopped early.

**The fix.** `VariantSliceShardResult` carries `variantWonBySlot`; `execute.ts` returns what `playSlice`
already produces; `run.ts` splices each slice in at its absolute offset (a sparse write **by index**,
so out-of-order shards compose into the array a locally-played arm would have built) and hands it to
the driver.

⚠️ **Why this was invisible — and the shape of guard it needed.** §3.98's rule is designed to
**preserve the ranking**. So a Lab that never stops early still returns the same recommendation, in
the same order, with the same verdicts. The existing "equals the sim's own `suggestSwaps`, rank for
rank" test passed with the plumbing removed. The only observable difference is the **number of games**,
and nothing was comparing that.

The new guard compares game counts — total and per candidate — and it had to be pointed at a
configuration where the rule actually fires. That took measuring:

| games | candidates | opponents | settled | full | saved |
|---|---|---|---|---|---|
| 16–64 | 6–8 | 2 | — | — | **0%** (never fires) |
| 50 | 6 | 4 | 794 | 794 | **0%** |
| 50 | 6 | **8** | 1,167 | 1,643 | **29%** |
| 100 | 6 | **8** | 1,094 | 3,132 | **65%** |
| 100 | 8 | 8 | 3,568 | 3,568 | 0% |

⚠️ **The rule needs the discordant pairs a FULL gauntlet produces.** At two opponents it never fires at
any size — so a guard written against the two-opponent lists the other tests share would have passed
whether the plumbing was connected or not. That is the trap this section is really about: the first
version of the guard did exactly that, and only measuring where the rule fires exposed it.

**Verified by removing the plumbing:** the Lab plays **1,494 games where the engine plays 1,001**, and
the guard fails on the count. With it, they match exactly.

**And an honest note on the rule's reach.** It saves 29–65% *when it fires*, nothing when it does not,
and never changes the recommendation. It is config-dependent, not universal — `100 games × 8
candidates` saves nothing while `100 × 6` saves 65%. Worth having in both surfaces; not worth
describing as a flat speed-up.

### 3.100 §3.98 was wrong — an early stop must keep the VERDICT, not just the pick — ✅ done

⚠️ **This corrects §3.98, which shipped a defect.** The rule stopped the ladder once the leader beat
the runner-up, reasoning that no further wave could change *which* swap is recommended. That is true.
It is also incomplete, and the gap was measurable in the command's own output.

**How it surfaced.** Adding `--full-ladder` — the control for the rule, added so a run can be *compared*
against it rather than trusted — and running both at the default gauntlet:

| | games | delta | verdict |
|---|---|---|---|
| `--full-ladder` | 800 | +3.1% | **BETTER** (p 6.2e-3) |
| default (§3.98) | 400 | +3.5% | **INCONCLUSIVE** (adjusted p 0.11) |

**Same recommendation. No longer proven.** A user asks two questions at once — *which of these is
best?* and *is it actually better than doing nothing?* — and §3.98 preserved only the first.

⚠️ **And the tests passed.** `leader-settled.test.ts` compared the top pick's IDENTITY
(`outName -> inName`). It did not compare the verdict, so a run that downgraded BETTER to
INCONCLUSIVE sailed through every case. That is the same shape of hole as §3.99's game-count gap,
found the same way: by measuring the shipped thing rather than re-reading the reasoning.

**The fix.** The leader's own verdict against the base must also be settled. It faces a Holm
correction over the roster at report time, and Holm judges the smallest p against `alpha / m`, so
that is the bar applied — **the one the printed verdict will actually have to clear**. Testing against
a looser `alpha` would let the ladder stop on a verdict the report then declines to print.

**Extracted, because a rule this subtle should not live inline in a loop.** `leaderIsSettled` is now a
named, exported, documented predicate. Its five unit tests run in **10ms** and pin both halves —
including the defect (leader separated but unproven ⇒ do NOT stop) and the family-corrected bar
(p = 1.6e-2 stops at `familySize: 1`, does not at `8`). The end-to-end alternative costs ~50s, because
the rule only fires on runs of ~1,600 slots.

**Re-measured after the fix** (200 games × 8 candidates × 8 opponents):

| | games | top pick | verdict |
|---|---|---|---|
| full ladder | 7,132 | Playful Shove | BETTER |
| settled | **2,696** | Playful Shove | BETTER |

**62% fewer games, identical answer** — a larger saving than §3.98 claimed, because the old rule was
stopping in the wrong place. And it now correctly saves *nothing* where the answer is still
inconclusive: measured 0% at 50 and 100 games/candidate, where more games are exactly what is needed.

**The honest shape of this feature:** it fires on big runs with a decisive winner, saves ~62% there,
and stands aside otherwise. `--full-ladder` remains as the control.

### 3.101 The composed `suggest` number, and a start-up saving worth its honest size — ✅ done

Two measurements and one small tool, all about reporting what a user actually experiences rather than
multiplying components together.

**THE COMPOSED NUMBER.** Every piece of this work is now in `suggest`, so it can finally be measured
end to end instead of estimated. Same command, same seed, same machine, **same recommendation**:

| | total wall clock | leader's games | verdict |
|---|---|---|---|
| sequential + `--full-ladder` | **57.7s** | 1,600 | Goblin Piker → Playful Shove, BETTER |
| parallel + settled leader (default) | **18.7s** | 800 | Goblin Piker → Playful Shove, BETTER |

**3.1× end to end**, from parallelism (§3.77) and the settled-leader stop (§3.98/§3.100) together, on
an engine that is itself ~1.48× faster than at the start of this work (§3.62, §3.78–§3.81). Both runs
include ~5s of `tsx` start-up, so the search itself improves by more than 3.1× — but 3.1× is the
number a user's clock shows, and that is the one worth quoting.

**THE START-UP SAVING, AND WHY THE HEADLINE FIGURE IS NOT THE ONE REPORTED.** `npm run sim` runs the
CLI through `tsx`, which compiles TypeScript on every invocation:

| | |
|---|---|
| `node packages/sim/dist/src/cli.js decks` | **0.61s** |
| `npx tsx packages/sim/src/cli.ts decks` | **3.40s** |

A 2.8s difference — and the tempting thing to write down. But through `npm run`, npm's own overhead
(~1.7s) absorbs most of it, and what a user actually sees is:

| | |
|---|---|
| `npm run sim:fast -- decks` | **2.4–2.6s** |
| `npm run sim -- decks` | **3.2s** |

**~0.7s, or 22% of a short command** — worth having, ~4% of a large `suggest`, and nothing like 2.8s.

⚠️ **`npm run sim` is deliberately NOT switched to the built output.** `tsx` is correct by
construction: it always runs current source. `dist` can be stale, and this repo has already paid for
exactly that — a benchmark run against an out-of-date `dist` reported *"a confident, plausible number
for a tree that no longer exists"*. A CLI that silently answered from last week's engine would be the
same trap pointed at the user.

So `sim:fast` earns the speed by **proving the build is current first**: it compares the newest `.ts`
mtime across *every* package (a stale `core` is as wrong as a stale `sim`) against the **oldest** build
output (a half-finished build is as stale as an absent one), and refuses — naming the newer file —
rather than running. A refusal is cheap; a wrong answer delivered quickly is not.

### 3.102 Three evasion keywords — fear, intimidate, horsemanship — ✅ done

⚠️ **And a correction to what this project has been assuming.** The speed and strength work of §3.62–
§3.101 proceeded on the belief that the card side was finished. It is not, and the repo's own tooling
says so plainly. `packages/cards/scripts/coverage-audit.mjs`, over the 2,100 most-played Modern-legal
non-joke cards:

> **Fully playable today: 676 (32.2%). Blocked by a missing system: 1,424 (67.8%).**

The "5,097 cards" figure is the CURATED POOL — the cards that *do* compile. The corpus is 32,277 paper
non-joke cards, of which **17,916 are blocked by exactly ONE clause**. That is a work queue, and
`keyword-gap-report.mjs` orders it by cards-per-keyword.

**Picked as a FAMILY, not a keyword.** Three of the top entries share one shape — *"can't be blocked
except by creatures that ARE something"*:

| keyword | CR | exception names | sole-blocked |
|---|---|---|---|
| fear | 702.36a | artifact creatures and/or **black** creatures | 14 |
| intimidate | 702.13a | artifact creatures and/or creatures **sharing a colour** | 8 |
| horsemanship | 702.31a | creatures **with horsemanship** | 14 |

`BlockRestriction.blockerMustHaveAnyOf` already covered exceptions naming a KEYWORD. These name a
**colour or a card type**, so folding them into that list would have meant inventing keyword flags for
"artifact" and "black". Instead `blockerMustMatchAnyOf` takes a closed `BlockerQuality` union —
`artifact`, `color`, `sharesColorWithAttacker` — and horsemanship gets a real flag so its restriction
can NAME it, exactly as `flying`/`reach` pair up.

**Measured: 5,097 → 5,133 complete cards. +36, precisely the 14 + 8 + 14 predicted.**

⚠️ **The repo's guards did their job, twice.** Adding one `KeywordFlags` field stopped `tsc` in two
places until it was classified — `KEYWORD_RULES` (its CR reference) and `KEYWORD_KEYS` (the
exhaustiveness witness). Neither is something a person would have remembered.

And a third guard fired as a TEST failure: *"reports an unmodelled keyword rather than dropping the
ability"* has used menace, then ward, then indestructible, then skulk, then horsemanship as its
stand-in — each moved on the day it was implemented. Horsemanship is now implemented, so the stand-in
moved again, to **cumulative upkeep**. That test is a small monument to the rule it protects.

⚠️ **A limit written where it will be read.** `blockerHasQuality` reads PRINTED colour and card type,
not the continuous index, because core does not model colour- or type-changing effects in its layer
system yet. That is the honest approximation only because it is also what the rest of core does today
— and the comment says so, so that when either becomes layer-aware this moves with it rather than
quietly letting a creature that only LOOKS black block a Fear attacker.

**Mirrored in the pilot**, because a single illegal pair makes the whole `declareBlockers` action
illegal: the defender would lose every other block in the same declaration and take the entire attack.
That is not a hypothetical — it is what §3.45's Black Knight bug did.


### 3.103 The combat-declaration trigger, and bushido — ✅ done

Second pick off the §3.102 queue, and the same discipline: measure, pick the SHAPE, implement, and
check the count moved by exactly the predicted amount.

`keyword-gap-report.mjs` ranks four keywords that are all *"a combat declaration pumps a creature"*:

| keyword | CR | reads | sole | blocked |
|---|---|---|---|---|
| exalted | 702.90a | a creature you control **attacks alone** → that creature +1/+1 | 20 | 34 |
| bushido N | 702.45a | this **blocks or becomes blocked** → it +N/+N | 18 | 36 |
| rampage N | 702.23a | **blocked by 2+** → +N/+N per blocker beyond the first | 8 | 9 |
| flanking | 702.24a | **blocked by a creature without flanking** → that blocker −1/−1 | 7 | 27 |

**The class-level fix is the EVENT.** Core had `attacks` (from `attackersDeclared`) and nothing for
the other side of combat, so all four were blocked on the same absence. `blocksOrBecomesBlocked` is
now a `TriggerEvent` with a row in `TRIGGER_EVENT_SOURCES` — the closed table `tsc` forces complete —
matching on `blockersDeclared`. Both halves are one event because no printed card separates them: an
object either took part in a block or it did not.

⚠️ **One declaration is ONE fire.** CR 509.1h makes "becomes blocked" a single event however many
creatures were declared, so the matcher answers a BOOLEAN per (source, ability), never a count. A
triple-blocked attacker firing three times would make bushido scale with the defender's board — a card
playing *stronger* than printed, which biases an A/B verdict exactly as badly as one playing weaker.
`blocks-trigger.test.ts` pins it.

**Measured: 5,133 → 5,151 complete cards. +18, precisely the number predicted for bushido.**

**Bushido rides the event as a compiler ROW, and nothing else was needed.** `triggerFrom` hands the
body back to the compiler as the Oracle sentence it stands for, so the pump resolves to the existing
`self-pump-until-eot` primitive rather than a second answer to the same question. It is a pattern rule
and not a `KEYWORD_ABILITY_BUILDERS` entry because those builders take no argument and bushido's whole
payload is its number.

**The sweep guard became the TABLE it should always have been.** Scryfall lists the bare word
("Bushido") while the printed line carries the payload ("Bushido 1"), so the keyword sweep reported it
as unmodelled one line after implementing it — the same false report Kicker, Flashback, Affinity,
Modal, Buyback and Madness each carry a hand-written `if (word === … && evidence) continue;` for. That
branch chain is exactly what rule 2 says belongs in a table, so `TRIGGER_BACKED_KEYWORDS` is one:
adding the next trigger-implemented keyword is a ROW. It is keyed on the compiled trigger's LABEL, not
its condition — flanking and rampage watch the SAME event, and a condition key would let one that
compiled absolve a sibling that did not. A `Bushido X` the rule table cannot match compiles no trigger
and still reports honestly; the test asserts that directly.

⚠️ **What this round did NOT do, and what each sibling actually costs.** The event unblocks all four
keywords only in the sense that none of them needs a *new event* now. Each still needs one distinct
piece of machinery that does not exist:

- **rampage** — a pump that SCALES with a count. `pumpUntilEndOfTurn` takes fixed power/toughness.
- **flanking** — the effect targets the BLOCKER, and trigger bodies have no subject-targeting seam.
- **exalted** — both an "attacks alone" qualifier on the `attacks` condition and that same subject seam.

So the honest number for this round is 18, not 53. The next of them is a row plus one payload, not a
row plus an event, which is the part that was worth doing once.

### 3.104 Devoid — printed colourlessness, and the tool that lists a keyword's cards — ✅ done

Third pick off the §3.102 queue, and the smallest: **devoid** (CR 702.114a) is "this card has no
color", printed on Eldrazi that still cost coloured pips. It matters because colour is DERIVED from
the cost when `CardDefinition.colors` is absent, so a devoid card costing {3}{B} that merely compiled
would play as a BLACK creature — a legal target for "destroy target black creature", stopped by
protection from black, counted by every `anyOfColors` filter. `colors: []` already meant "printed
colourless" (the explicitly colourless token, §3.71), so devoid needed no new concept, only a
`KEYWORD_ABILITY_BUILDERS` row that sets it. A builder and not a `KeywordFlags` boolean for the reason
changeling is one: a characteristic-defining ability changes what the object IS in every zone.

The test asserts the DERIVED colour and carries a control — the same cost without devoid reads black
— because asserting only `status === complete` would pass on exactly the broken card.

**Measured: 5,151 → 5,163 complete cards. +12, precisely the sole-blocked count.** 121 more devoid
cards wait on something else and come along when that closes.

**A fourth measurement tool, committed.** `keyword-gap-report.mjs` says HOW MANY cards a keyword
blocks; the next question is always WHICH cards, and what their whole text says, because the shape of
a mechanic's implementation is decided by the printed lines around it (crew sits on cards with
cycling, equip and mana abilities; a keyword that looks like one row may need three). NEW
`packages/cards/scripts/keyword-cards.mjs <corpus> <keyword>… [--all]` prints every card SOLE-blocked
by each named keyword with its full Oracle text (`--all` adds the multi-blocked ones with their other
gaps). It is the ground-truth input for a worker brief, so a family is implemented against real cards
rather than a remembered wording — the failure `rule-coverage.test.ts` exists to catch.

⚠️ **The scripts read `dist`, not `src`.** The first run of the gap report this round said 5,097 —
the figure from two commits ago — because `dist` was stale. `npm run build` between any source change
and any measurement, reverts included (build-gate memory).

### 3.109 The keyword anomalies — a keyword the engine HAS was still blocking cards — ✅ done

`keyword-gap-report.mjs` listed **flying** (10 sole-blocked), **protection** (10), **trample** (5) and
**affinity** (6) among the unimplemented keywords. All four have been implemented for months, which
made the rows the most informative in the table: the keyword was never the problem, the printed LINE
around it was. `keyword-cards.mjs` (§3.104) showed three shapes:

| shape | printed on | cards |
|---|---|---|
| a keyword line joined with **semicolons** ("Trample; haste; shroud") — Oracle switches separator when a keyword carries a comma of its own | Giant Solifuge, Teeka's Dragon, 28 more | 30 lines |
| a protection quality outside the colour/artifact/creature table — a **card type** ("from enchantments", "from lands", "from instants and from sorceries"), **"monocolored"**, **"each color"**, or a **subtype** ("from Dragons", "from Demons and from Dragons", "from Vampires, from Werewolves, and from Zombies") | Azorius First-Wing, Horizon Drake, Sword of Wealth and Power, Guardian of the Guildpact, Iridescent Angel, Dragonstalker, Baneslayer Angel, Elite Inquisitor | ~25 |
| **affinity for a subtype** ("Affinity for Slivers", "for outlaws", "for Equipment") | Thrumming Hivepool, Hellspur Brute, Oxidda Finisher | ~25 lines, 6 sole |

**The protection table grew by the corpus, not by guesswork.** A tally of every "protection from …"
quality printed on a real card (the script is in the commit message) gave the closed lists: seven
card-type words, `monocolored`, and twenty-three subtype plurals. A subtype quality is the STRING
`subtype:<Name>` — a string and not a record, so every list union, comparison and serialisation that
already uses `includes`/`===` keeps working — and it is read through `hasSubtype`, the one funnel every
subtype question goes through, so a changeling is a Dragon for Dragonstalker exactly as it is for a
lord. "Each color" expands to the five colour qualities (CR 702.16j) rather than becoming a sixth
colour word. A plural→singular RULE was rejected on purpose: "protection from haste", "from snow" and
"from spells" are all printed and would all have passed it while meaning nothing to the engine.

**Still honestly refused**, with real cards as the test stand-ins now that "from Demons" compiles:
"protection from mana value 3 or less" (Reaver Titan), "from the chosen color" (Voice of All, 30
printings of the until-end-of-turn form), "from each of your opponents", and "Affinity for Dwarves"
(not printed anywhere).

⚠️ **A second separator bug was hiding behind the first.** `PROTECTION_SEPARATOR` stripped the
"from" after "and" but not after a comma, so every THREE-quality line (Elite Inquisitor, Oversoul of
Dusk) was refused even once its words were in the table — and the keyword-line compiler had no
`joinPayloadKeywords` at all, so the same line split into "from werewolves" fragments before the
protection parser ever saw it. Both fixed; the joiner is now shared by the printed line and the
granted form, so an Equipment and a creature cannot disagree about which lines are real.

**Measured: 5,163 → 5,188 complete cards, +25.** The remaining flying/trample rows are banding and
rampage cards, which are those keywords' own gaps (§3.107 takes rampage; banding stays open).
### 3.105 Poison — infect, wither, toxic — ✅ done

Picked as a FAMILY off the §3.102 queue: three keywords that are one SHAPE — *damage whose RESULT
changes* — plus the player resource none of them can exist without.

| keyword | CR | reads | sole |
|---|---|---|---|
| infect | 702.90 | to a creature as −1/−1 counters; to a player as **poison counters** | 26 |
| wither | 702.80 | infect's creature half only (and printed on a SPELL — Puncture Blast) | 13 |
| toxic N | **702.164** | combat damage to a player ALSO gives N poison | 12 |

⚠️ **Toxic is 702.164, not 702.181** (that is Mobilize). Checked against the 2026-08-19 text, which
also moved the battle row of CR 120.3 from `d` to `h` — a stale manifest note said `d`, and is fixed.

**The class-level fix is the RESULT FUNNEL, not a replacement effect.** CR 120.3 is a closed table —
what damage DOES, keyed on the recipient and the source's keywords (life or poison, loyalty, defense,
marks or −1/−1 counters, lifelink, toxic) — and it was answered in FIVE places: combat in core and
`dealDamage`/`dealDamageToEach`/`fight` in the cards package, each with its own copy. Three copies had
already drifted: noncombat damage from a lifelink or deathtouch source neither gained life nor
destroyed (CR 702.15b / 702.2b both say *damage*). `applyDamageResult` in `core/src/internal/
damage-result.ts` is now the one answer, and infect and wither are rows in it — which is what makes an
infect creature that FIGHTS land counters exactly as one that attacks (CR 702.90e). Prevention and
protection still run first at each call site; the funnel trusts what lands.

**Poison is a player resource with life's discipline** (`core/src/poison.ts`): one reader, one
writer, a `poisonChanged` event shaped like `lifeChanged`, CR 704.5c in the SBA pass beside 704.5a,
and an OPTIONAL `PlayerState.poison` for the reason `turnFactsA` is — every serialized or hand-built
state before this has no field, and absent must read as zero. The golden state digests never moved:
`serializeState` omits it at zero, exactly as `manaRestricted`. `markedByDeathtouch` now stands alone
in the SBA check, because deathtouch-infect damage lands with NO marked damage and CR 702.2b still
destroys. Proliferate (CR 701.34 — the repo's `701.27` was stale) asks its player question second,
under the choice seam's ask-everything-first contract, and only when somebody is poisoned.

**Measured: 5,151 → 5,208 complete cards. +57 against 51 predicted.** The three keywords now
sole-block 0. The six extras are grant forms that came free from the `KEYWORD_FLAGS` row feeding
`KEYWORD_TOKEN`: Tainted Strike, Phyresis, Blight Sickle, Prosthetic Injector, Corrosive Mentor,
Carrion Call. Toxic's payload parses beside ward's (`parsePayloadKeyword`) and merges by ward's SUM
rule (CR 702.164b "total toxic value"); the keyword sweep's ward/protection branches became the
`PAYLOAD_KEYWORD_EVIDENCE` table with toxic as its third row.

**The pilot plays two clocks, kept apart** (`ai/src/poison-pressure.ts`). Incoming damage is a PAIR
— life damage and poison — and lethal is asked of EACH clock; the blended life-equivalent (poison ×
`startingLife / 10`, derived, a weight) is used only to RANK, because a false "lethal" throws a game
where a false "not lethal" only delays one. `lethalAlphaStrike` judges each group alone with every
blocker charged against it (conservative), blocks sort by face threat so an infect 3/3 is blocked
before a vanilla one, desperation triggers at nine poison, and the forecast races on the shorter of
the opponent's two clocks. `poison-pilot.test.ts` pins two infect 1/1s attacking into a 2/2 at nine
poison and NOT at zero.

**Gate:** pilot bench 116 → 147 games/sec with identical outcomes (A won 851/2000 both runs — the lock
decks print no poison). Sabotage: the first toxic anchor stayed GREEN — it tested the creature row —
and the fixed anchor (noncombat toxic at a player) went red, exactly TESTING.md's "suspect the
sabotage first".

⚠️ **Deliberately not done.** *Corrupted* (an opponent has three or more poison counters) is mostly a
STATIC condition ("as long as"), which the layer system has no intervening-if for — not a cheap row.
"Gets a poison counter" primitives (Ichor Rats, Phyrexian Vatmother) are one `playersForParam` verb
away and were left for the measured next pick. The pilot does not price a spell's *own* infect
(Tainted Strike as burn-to-lethal), and `effect-value` prices infect damage on creatures as the
removal it already is through `toughnessLeft`, not as the permanent shrink it also is.
### 3.107 The combat keyword family — exalted, rampage, flanking, landwalk, shadow, split second, provoke, myriad, and the attack-requirement solver — ✅ done

Third pick off the §3.102 queue, and the first taken as a whole FAMILY: every keyword and one-clause
template whose rule lives in the declare-attackers or declare-blockers step. Measured before building
(`probe.mjs --keyword`, `near-miss-report.mjs`): exalted 20, rampage 10, flanking 7, landwalk 16 (13
islandwalk + legendary + nonbasic), shadow 9, split second 8, myriad 12, provoke 4; templates "attacks
each combat if able" 24, "can block only creatures with flying" 20, "attacks, it gets +0/+2" 17, "can't
attack unless defending player controls an Island" 10, "more than one creature" 8, "blocks, it gets" 7,
"becomes blocked, it gets" 7, "blocks a creature with flying" 6, "block an additional creature" 8.
**Predicted ≈ 181 (provoke and the additional-blocker template deliberately excluded).**

**Measured: 5,151 → 5,418 complete cards. +267.** More than predicted, and the excess is accounted for:
two of the fixes were CLASS-level and reached cards outside the measured shapes — keyword lines split on
`;` as well as `,` ("Flying; trample; rampage 4", "Vigilance; horsemanship" — Oracle's separator when a
keyword carries a parameter), and a self-referential trigger body opening with "it" ("whenever ~ attacks,
**it** gains flying") now compiles through the same self rule "~ gets" does. Both are rows, not branches.

**The seam that unblocked three keywords at once is `triggeringInstances`** — "that creature" / "the
blocking creature" — carried from the declaration event through `PendingTrigger`, the stack object, the
clone, the resolution frame and into `EffectContext`, exactly the road `triggeringPlayer` already travels.
`pumpUntilEndOfTurn` reads it through `params.subject: 'triggering'` (one reader, `subjectCreatures`);
no second pump primitive. Four `TriggerEvent` rows sit beside `blocksOrBecomesBlocked`, each with its own
printed firing count: `creatureAttacksAlone` (exalted, CR 506.5 "alone" = exactly one attacker; the
source may be a land — Cathedral of War), `blocks`, `becomesBlocked` (ONE fire per declaration, CR
509.1h), and `becomesBlockedByCreature` (ONE fire PER BLOCKER, CR 702.25b — the matcher fans out one
pending ability per blocker, `FIRES_PER_TRIGGERING_INSTANCE`). Flanking's "without flanking" and "blocks a
creature with flying" are `counterpartLacksKeyword` / `counterpartHasKeyword` on the CONDITION, judged
by the runtime against EFFECTIVE keywords — a flier by anthem counts — so `triggers.ts` stays pure.

**Rampage is a scaled pump, not a primitive:** `DerivedValue.times` ("+N/+N for each") on the one
`intParam` reader, and a `creaturesBlockingThisBeyondFirst` count read off the live block map as the
ability resolves (CR 702.23b — calculated once, on resolution). `TRIGGER_BACKED_KEYWORDS` gained its row.

**The pair rules are rows in `canBlock`:** shadow as one inequality (CR 702.28b is symmetric, and the
half an evasion-only implementation forgets is that a Soltari cannot block a Bear); `blockOnly` as the
blocker's own restriction; landwalk reading the DEFENDER's lands through `land-conditions.ts`, the one
reader of the closed `LandCondition` table (`subtype | legendary | nonbasic`) that "can't attack unless
defending player controls an Island" also reads. Landwalk is the one evasion rule that needs the board,
so `canBlock` and the solver take a `battlefield` parameter; a caller that omits it is asserting the
defender has no lands, and every live caller passes the real one. `maxBlockers` is the dual of
`minBlockers`, judged at the same declaration-level site.

**Attack requirements are the mirror of the block solver** (`attack-requirements.ts`, CR 508.1c/d): ONE
reader (`attackDeclarationProblem`) for the offer path, the apply path and the requirement half; a
declaration that leaves a Goblin Brigand home is rejected. ⚠️ Passing the step used to mean "no
attackers"; with a required creature able, that is not a legal declaration, so `advanceStep` performs the
forced minimum ITSELF through the same `commitAttackDeclaration` the action path uses (taps, event,
exalted triggers) — refusing the pass would deadlock every pilot that answers "pass" to a step it does not
understand. No search is needed yet: every expressible requirement is per-creature and unconditional, and
the module comment says where a solver would start.

**Split second** is a flag like flash, read from both sides: the offer pass withdraws casts, cyclings
and non-mana activations while it holds (one filter, paid only then), and the three apply paths refuse
them with one wording. Mana abilities are `tapForMana` and are never touched (CR 702.61b).

**Myriad compiles to a RECORDED vacuity.** Two players means "each opponent other than defending
player" is the empty set; the flag stays on the definition and `CompileResult.vacuous` carries the
reason (`MYRIAD_VACUOUS_REASON`), so a third seat finds these twelve cards by grep rather than by surprise.

**Mirrored in the pilot**, for the reason §3.102 gives: `canBlockByEvasion` reads shadow/blockOnly/
landwalk off the same board; every roster-building site (heuristic, policy candidates, hybrid's proven
lethal, lookahead's forecast) runs through `withRequiredAttackers`, which asks core's
`requiredAttackerIds` rather than restating the rule.

⚠️ **Left out, and why.** Provoke (4 cards) needs a requirement that a SPECIFIC blocker block a SPECIFIC
attacker plus an untap — a per-blocker row the block solver's DP does not carry yet; its cards keep
reporting. "Can block an additional creature each combat" (8) needs `combat.blocks` to stop being a
blocker→attacker map, which is a damage-assignment change, not a keyword. Exalted/rampage/flanking are
not yet priced by the attack forecaster — legal play was the bar this round, not valuation.

⚠️ **The bench number, honestly.** The first after-run read 105 games/sec against a 146 baseline taken
earlier in the day — a 28% "regression" that a CPU profile could not find (no new function in the top
40; `generateLegalActions` still the flat 6% it was). The machine was at 65% load from three sibling
agents. An INTERLEAVED A/B — stash the family, rebuild, bench; restore, rebuild, bench, same minute —
read 113/93 (baseline) vs 149/150 (family) games/sec with identical game outcomes (A won 628/1500 in
both). So: no measurable hot-path cost, and a reminder that a single bench number under shared load is
not a measurement. Gate: full suite green; lint 0 errors.
### 3.106 Upkeep costs and time counters — echo, cumulative upkeep, suspend, vanishing, fading — ✅ done

Picked as a FAMILY off the §3.102 queue: five keywords and two printed templates that are all *"at the
beginning of your upkeep, a bill or a tick"*, measured with `keyword-cards.mjs` BEFORE building:

| keyword / template | CR | sole | predicted | shipped |
|---|---|---|---|---|
| echo {cost} | 702.30a | 28 | 25 (3 print a non-mana cost) | **25** |
| cumulative upkeep {cost} / —Pay N life | 702.24a | 19 | 12 (7 print sacrifice/counter/card costs) | **12** |
| suspend N—{cost} | 702.62a | 22 | 22 | **22** |
| vanishing N | 702.63a | 5 | 5 | **5** |
| fading N | 702.32a | 5 | 5 | **5** |
| "sacrifice ~ unless you pay {COST} / N life", "sacrifice ~" | — | 8 (one shape) | 8 | **19** |
| "draw a card at the beginning of the next turn's upkeep" | 603.7 | 12 | 12 | **16** |

**Measured: 5,151 → 5,255 complete cards. +104 against 89 predicted**, and every keyword landed on its
number — the surplus is the two templates, which the near-miss report counts per exact cost string
({U}{U} was 8) and per exact sentence (the Aura form "when this Aura enters, draw a card at …" rides
the same rule). The remaining sole-blocked echo (3) and cumulative upkeep (7) are the cost forms
outside the CLOSED table — "Echo—Discard a card", "Cumulative upkeep—Sacrifice a land" — which report
rather than compile, exactly as rule 2 requires.

**Nothing here needed a new engine loop.** Every keyword is an `upkeep` trigger the compiler builds
from the existing vocabulary, plus the two ENTRY-TIME facts no resolving effect is around to record:

- **"came under your control since the beginning of your last upkeep"** — a `controlledSinceTurn`
  stamp written by ONE helper (`markBattlefieldEntry`, the `applyEnteringLoyalty` pattern) at the three
  entry funnels and by the one control-change site, read by a new intervening-"if" kind. Written ONLY
  on definitions that ask (a memoised scan for the condition), so the ordinary permanent keeps the
  object shape `cloneInstance` was measured on.
- **"enters with N time/fade counters"** — `CardDefinition.entersWithCounters`, applied by the same
  helper through the one counter-replacement site. A definition field and not an ETB-script entry
  because the script only a CAST spell runs: a reanimated Blastoderm with no fade counters would never
  be sacrificed — a card playing STRONGER than printed, which biases an A/B verdict as badly as one
  playing weaker. Omenpath to Naya (a LAND with vanishing) compiles because of this.

**Suspend is a special action plus the madness window.** `suspendCard` (CR 702.62a, `ACTION_RULES`
forced the manifest row) pays, exiles with N time counters and creates a DELAYED ability whose body is
the cards package's `suspendTick` — handed over as `SuspendAbility.upkeep` exactly as a cycling body
is, so core names no primitive. The exile-side abilities ride `GameState.delayedTriggers` rather than
the trigger collector because that collector reads the battlefield and command zone, and walking exile
on every event would tax the hottest path for a mechanic most games never see. The free cast is the
existing `MadnessWindow` with `kind: 'suspend'`: a WINDOW, not a card-grant permission, because "you
may cast it … if you don't, it remains exiled" is a decision made at that moment, and a standing free
permission would let a pilot hold Rift Bolt for the perfect turn. Haste "until you lose control" is the
stack object's `hasteOnEntry` → an unsick entry, since haste in this engine IS `!summoningSick` and
every control change re-sets it — no continuous effect to expire.

⚠️ **The clone trap fired a fifth time.** `hasteOnEntry` rode the stack object and vanished at the
first action boundary, because `cloneStackObject` copies a fixed field list; `suspend.test.ts` caught
a Baloth entering sick. The row is in clone.ts with the others.

⚠️ **A pre-existing gap the family exposed, fixed at the class.** `toCoreCost` folds a printed `{0}`
and NO mana cost into one absent `cost`, and the engine read absent as free — so the day Profane Tutor
compiled it was castable from hand for nothing. `parseManaCost` now keeps the difference
(`ManaCost.absent`), the compiler marks `CardDefinition.noManaCost`, and the offer loop, the cast path
and the pilot's goal builder all refuse it (CR 202.1b). Ornithopter is untouched.

**The pilot plays it.** `payManaOrElse` marks a bill with its STAKE (`stakeInstanceId`), and the
heuristic prices the bill against the permanent — pay when the mana is spare (this turn's best castable
spell still affordable) or the `cardValue` is worth `upkeepBillWorthPerMana` per mana; a 3/3 pays
{1}{G}, Deranged Hermit lets {3}{G}{G} go. `bestSuspend` suspends only a card the pilot cannot cast this
turn, after every real play. `cardValue` discounts a vanishing/fading permanent by its upkeeps left.

**Not done, and why:** the non-mana cost kinds (discard, sacrifice, counters) — no cost seam beyond
mana and life; "Suspend X"; the cards that give the exiled card extra abilities; and vanishing's
"when the last counter is removed" as a SEPARATE trigger (it resolves with the tick — the only thing the
window could change ends with the permanent gone either way, and the comment says so).
### 3.108 The pilot, made stronger and faster by measurement — ✅ done

The target was "100× smarter and 100× faster". Neither exists (§3.78–§3.90 measured why, three ways
each); this is what the instruments could find, judged by the repo's own protocol, and the honest
multiple at the end. Every number below is from `bench/` tooling committed with this section.

**Speed — two seams and a cheaper gate, all transcript-identical.** Guard: `packages/sim/src/
action-plan.test.ts` plays 72 games per pilot with the seams on and off and requires the decision
trace to match action for action (the §3.73 discipline), for the heuristic AND for `lookahead`.

| change | what it does |
|---|---|
| the fast pass, widened | The old gate refused every combat step, every non-empty stack, and any instant in hand. Now it refuses only a declaration this seat has not yet made, reasons about the stack the way the pilot does (a counter needs a target, a sorcery cannot be cast into it), and rules an instant out by INTENT where `scoreSpell` provably holds it (counter/copy on an empty stack, trick or fog outside combat, removal with no creature to aim at). Gate fires on **75% of windows, up from 50%**. It also now reads the engine's own land-drop count and extra land zones, and refuses a madness window and a two-faced card — three holes the old gate had that no sample deck reached. |
| `Pilot.chooseActions` — the plan seam | The pilot hands back its decision AND the remaining taps of the funding plan it is pursuing; `runMatch` applies them without a menu or a re-decision, and drops the queue the moment the state is not the one planned against. Takes **4.8% of windows** — the cast is deliberately NOT promised, because core's planner cannot fund a hybrid pip from an empty pool and the pilot then re-scores and casts something else (see `pursueSpell`; filed as a core task). |
| `lookahead` delegates both seams | The DEFAULT pilot never fast-passed at all: it built a menu for every one of its ~550 windows a game. Safe by construction — the only window it decides itself is the one the gate refuses. |
| the gate, memoised | With 75% of windows gated the gate became the heaviest function in the match-loop profile (14% self time). Every per-card fact it reads is now one `WeakMap` lookup per card (`gateFactsOf`). |

Measured **interleaved in one process** against a copy of the old build (`--old`, new on both
benches — on this box two runs of identical code differ by a third, so back-to-back is not a
comparison), CPU-time medians:

| instrument | old | new | ratio |
|---|---|---|---|
| `pilot-decide-bench` (chooseAction on every recorded window) | 193k/s | 201k/s | 1.04× — the decision function itself is unchanged |
| `pilot-decide-bench --harness` heuristic (windows/s as the loop drives it) | 188k | 223k | **1.18×** |
| `pilot-decide-bench --harness --pilot lookahead` | 68k | 77k | 1.13× |
| `pilot-bench --off gangBlock` heuristic, games/CPU-sec, identical games (A won 851 both arms) | 133 | 191 | **1.43×** (1.39× wall) |
| `pilot-bench --off gangBlock --pilot lookahead`, identical games (867 both) | 132 | 175 | **1.33×** (1.33× wall) |

Two runs of the games/sec pair an hour apart read 1.20×/1.25× and 1.43×/1.33× — the box's noise
floor even interleaved, so the honest figure is **1.2–1.4× games/sec**, not one number. It is larger
than the decision gain because a gated window skips `generateLegalActions` too, which the decision
bench cannot see. The remaining hotspot is the forecast: on the recorded corpus `lookahead` costs
13.7 µs a window against the heuristic's 4.3, and 73% of that is `chooseAttackPlan` (~0.75 ms per
attack decision on a wide board) — the next speed lever, not taken here.

**Strength — every hypothesis, both pilots, four-seed battery (§3.85), held-out seeds decide.**
`forecast-ab.mjs --feature` (new) judges a `HeuristicFeatures` flag on the shipped pilot, which
`feature-ab.mjs` cannot; `pilot-vs-pilot-ab.mjs` (new) compares two registered pilots.

| hypothesis | pilot | dev seeds | HELD-OUT | verdict |
|---|---|---|---|---|
| `gangBlock` — two blockers kill what one cannot; a menace attacker is blockable | heuristic | 49/20, 29/26 | **85/50**, chi² 8.56 | **CONFIRMED STRONGER**; at 80 games held-out **172/104** (chi² 16.26) |
| `gangBlock` | lookahead | 54/21, 58/22 | **110/45**, chi² 26.43 | **CONFIRMED STRONGER** — the largest confirmed gain on record; at 80 games/orientation held-out **223/87** (chi² 58.79), pooled 448/174 |
| `attackFaceLifeReference` 0 → 24 — face damage priced by `reference/life`, the burn curve applied to combat | heuristic | 30/30, 25/20 | 76/28, chi² 21.24 | "confirmed" — then **NOT REPLICATED on a fresh battery at 80 games: 108/89** (chi² 1.64). The §3.85 shape exactly: level dev seeds, a held-out pair that happened to agree, nothing on seeds it had never seen |
| `attackFaceLifeReference` 24 | lookahead | 28/21, 27/14 | 55/25, chi² 10.51 | confirmed on the default battery; fresh battery at 80 games **100/76, chi² 3.01 — NOT REPLICATED**. Ahead on all eight seeds, over the bar on none it was not tuned against: the §3.89 "too small to matter, or nothing" signature. Deleted |
| `persistPricing` — a persisting body's death priced as its returning counter | heuristic | 8/9, 11/2 | 22/6, chi² 8.04 | confirmed on the default battery (58 decided slots in 11,520 games — the case is rare); fresh battery at 80 games **25/16 — NOT REPLICATED**. Same signature; deleted |
| `persistPricing` | lookahead | 5/13, 9/4 | 10/10 | NOT REPLICATED — nothing for the default pilot |
| `clockChump` — chump by the opponent's proven crack-back instead of a fixed life total | heuristic | 9/15, 7/10 | 24/43, chi² 4.84 | **CONFIRMED WEAKER** — deleted |
| `attackValueThreshold` 1 → 0 as the forecast's margin over holding | lookahead | 9/7, 7/3 | 14/9, chi² 0.70 | NOT REPLICATED |
| `lookahead` vs `heuristic` head to head (`pilot-vs-pilot-ab.mjs`, both with `gangBlock`) — is the forecast still ahead of §3.83's set attack? | — | 90/57, 87/48 | **178/98**, chi² 22.61 | lookahead CONFIRMED STRONGER: the forecast's attack step is worth keeping as the default, and the heuristic's attack scoring is not where its remaining gap closes |

Where the ideas came from: `disagreement.mjs --base lookahead --pilot hybrid --band block` showed
`hybrid` blocking Craw Wurms with Kitchen Finks and the shipped pilot never gang-blocking a single
attacker (a defender with two 3/3s took a 5/5 every turn); `--band attack` showed the shipped pilot
holding a 2/2 back against an opponent at four life because a point of damage was worth one, at four
life as at twenty. The gang-block boards are pinned in `packages/ai/src/blocking-features.test.ts`, the
gate's new rules in `fast-pass-gate.test.ts`.

**What ships ON:** the widened gate, the plan seam, lookahead's seams, and `gangBlock` (default
`true` in `resolveFeatures`; the flag stays as the A/B seam). **Deleted with their code:**
`clockChump`, `persistPricing`, `attackFaceLifeReference`. Two of those three "confirmed" on the
default battery and died on a fresh one — the third time §3.85's rule has earned its keep, and the
reason every winner here was confirmed at 80 games before its default flipped.

**The honest multiple.** Speed: **1.2–1.4× games/sec** (1.18× per window), on top of §3.73's +48%.
Strength: ONE confirmed rule, one-sided on every seed at every size — held-out 223/87 at 80 games on
the pilot that ships. Neither is 100×, and §3.78–§3.90 say why nothing in this architecture is. What
this section adds to those is that the strength band was NOT empty: the blocking band §3.89 called
"not a threshold problem" was a missing capability, found in an afternoon once the right pilot was
measured — and the default pilot still beats the heuristic 178/98, so the forecast's attack step, at
0.75 ms a decision, is both the next strength ceiling and the next speed lever.

### 3.110 The counter keyword family — modular, undying, evolve, renown, bloodthirst, fabricate, unleash, backup, amass, riot, outlast, devour, bolster, afterlife, dethrone, explore — ✅ done

Picked as a FAMILY off the §3.102 queue: every keyword and printed template whose whole payload is
**+1/+1 counters placed by a keyword or a templated trigger**, measured with `keyword-cards.mjs`
BEFORE building.

| keyword | CR | sole | shipped | keyword | CR | sole | shipped |
|---|---|---|---|---|---|---|---|
| modular N | 702.43 | 14 | **12** | amass [type] N | **701.47** | 14 | **8** |
| bloodthirst N | 702.54 | 14 | **13** | backup N | 702.165 | 12 | **11** |
| undying | 702.93 | 13 | **13** | fabricate N | **702.123** | 12 | **12** |
| renown N | 702.112 | 11 | **11** | unleash | 702.98 | 10 | **10** |
| evolve | 702.100 | 8 | **8** | outlast {cost} | **702.107** | 8 | **8** |
| devour [noun] N | 702.82 | 7 | **7** | riot | 702.136 | 6 | **6** |
| afterlife N | 702.135 | 5 | **5** | dethrone | 702.105 | 5 | **5** |
| bolster N | **701.39** | 4 | **2** | explore (template) | **701.44** | 15 | **15** |

**Measured: 5,623 → 5,813 complete cards. +190** against 156 + ~52 predicted. Nine keywords landed
exactly on their sole-blocked count; every shortfall is a printed form OUTSIDE a closed table, which
reports rather than compiles — "Modular—Sunburst" and a LAND with modular (Power Depot: `dies` fires
for creatures only), "Bloodthirst X", Thromok's squared devour, "Amass Elves", "Bolster X, where X
is …", and a backup whose "following ability" is an activated one (Scorn-Blade Berserker).

⚠️ **Four of the brief's rule numbers were wrong, and checking them found a fifth problem in the
code.** `bolster` is 701.39 (not .37), `explore` 701.44 (not .42 — that is surveil, which this repo
cites correctly elsewhere), `fabricate` 702.123 (702.122 is **crew**) and `outlast` 702.107 (702.108
is **prowess**). Amass and bolster being 701.x at all is structural rather than a lookup — 701 is
keyword ACTIONS, 702 keyword ABILITIES — and the brief's "bolster 702.111" collided with this repo's
own long-standing `menace: '702.111'`, which is the contradiction that started the check.

**Four new intervening-"if" kinds carry the family**, because in each case the printed condition is
what makes the card fair, and CR 603.4 checks it twice:

- `sourceDiedWithoutCounter` — undying's "if it had no +1/+1 counters on it". "Had" is LAST-KNOWN
  information (CR 603.10a): the graveyard card's counters are already wiped, so the runtime
  SNAPSHOTS the count as the death event is emitted and carries it as `triggeringAmount`. Opt-in per
  condition (`TriggerCondition.snapshotsCounters`), so every other `dies` trigger is pushed
  byte-for-byte as before. Modular's death half reads the same snapshot to know how many to move.
- `triggeringCreatureLargerThanSource` — evolve's "greater power or toughness", both sides EFFECTIVE
  (CR 702.100c). "That creature" rides as `triggeringInstances` through the opt-in `carriesSubject`.
- `sourceNotRenowned` — renown's once-only designation, `CardInstance.renowned`. A DESIGNATION and
  not a counter: nothing proliferates it, and it is lost with the object (CR 400.7).
- `opponentHasMostLife` — dethrone, exact in a two-player game.

⚠️ **A death-ordering bug the family exposed, fixed at the class.** Two of the three death funnels
(`internal/sba.ts`, `sacrificePermanent`) emit `creatureDied` BEFORE the zone move; the cards
package's `destroyPermanent` emitted it AFTER. Nothing had ever depended on the order — until a
trigger needed the counters the move wipes, and a **Murdered** Young Wolf stopped coming back while
one that died in combat did. Three funnels, one ordering, pinned by a test.

⚠️ **A fourth entry funnel §3.106 missed.** `markBattlefieldEntry` was wired into core's three entry
paths but not the cards package's `putOntoBattlefield`, so a **reanimated** Arcbound Worker (a 0/0
that enters with a counter) arrived with none and died to a state-based action on arrival — exactly
the shape §3.106 fixed for Blastoderm on the other three. Undying's own return travels that funnel,
which is what made the fix load-bearing rather than tidy.

⚠️ **Fabricate was a MODAL and should not have been.** The printed line is "you may put N +1/+1
counters on it. **If you don't**, create N Servos" — a choice made as the ability RESOLVES, while a
`ModalSpec` is chosen as it goes on the STACK (CR 603.3c). Both shapes offer the same two outcomes,
which is why the modal looked faithful; what it did was lock the answer a full response window
early. It is now one `fabricateChoice` primitive asking the printed question at resolution, and the
test asserts `trigger.modal` is undefined so the shape cannot drift back.

**Everything else is a row.** `KEYWORD_ABILITY_BUILDERS` gains the five argument-less members
(undying, evolve, riot, unleash, dethrone); eight PATTERN rules carry the parametrised ones for
bushido's reason (a builder takes no argument, and each of these carries a number, a cost or a noun);
`TRIGGER_BACKED_KEYWORDS` gains four rows and a new `ACTIVATED_BACKED_KEYWORDS` twin carries outlast,
whose evidence is a compiled activation rather than a trigger. Riot and unleash are ENTRY-SCRIPT
questions beside "~ enters with N counters"; afterlife hands its body to the compiler as the Oracle
sentence it stands for, so its Spirits come from the same token rule every printed token line uses.
Unleash's "can't block as long as it has a +1/+1 counter" is `StaticAffects.onlySource` — the mirror
of `excludeSource`, because an unscoped self-static hands the restriction to the whole team. Modular's
death half needed one new `TargetRestriction`, `artifactCreature`: the printed line is a CONJUNCTION,
and `artifactOrCreature` would let an Arcbound Ravager hand its counters to a Sol Ring.

**The pilot plays it** (`ai/src/choices.ts`, `counter-keyword-pilot.test.ts`): riot takes haste only
when the swing is PROFITABLE this turn (a tapped blocker deters nothing), unleash takes the counter
while racing, devour feeds a body worth less than the counters it becomes, fabricate compares its two
halves — and every counter-placing body is priced on ONE ruler (`counterStatValue`, the arithmetic
`addCounters` already uses). ⚠️ Two of those answers come out as a CONSTANT on the default weights,
and both say so rather than being tuned: **explore always keeps** (it only ever asks about a nonland,
every nonland prices over the keep threshold, and this value model prices no graveyard synergy) and
**fabricate always takes the Servos** (N 1/1 bodies price above 2N stat points — which is also how
the mechanic plays). Each test proves the reader is a comparison by moving the one weight that
separates the two answers, rather than asserting the constant.

**Left out, and why:** **mentor** (8) needs a target restricted RELATIVE to the source — "attacking
creature with lesser power" — and `TargetRestriction` is a flat string union read at 67 sites;
**reinforce** (5) is a targeted activation from HAND, a zone only cycling reaches and cycling targets
nothing; amass beyond the three printed Army types; the two "bolster X" forms; and modular on a land.
All report.

**Gate:** full suite green; lint 0 errors; `build-card-index --check` clean. Pilot bench at parity —
162 → 163 games/sec (137 → 136 games/CPU-sec) with **identical outcomes**, A won 845/2000 in both
runs, which is the honest reading for lock decks that print no counters.

### 3.75 A refuted hypothesis, kept on the record — holding attackers back is WORSE — ✅ done

Not every measured idea survives, and this is the write-up of one that did not. It is recorded
because the evidence that motivated it was good, the reasoning was plausible, and the next person to
have the same idea deserves the numbers rather than the argument.

**Where the idea came from.** NEW `bench/oracle-diff.mjs` drives a real game with the cheap pilot and
asks the SEARCHING pilot for a second opinion at every window — so both judge the same reachable
positions, on-policy. Over 2,457 windows with a genuine choice:

> The two agree on **99.0%** of decisions. **Every single disagreement is about attacking** — none
> about casting, blocking, land drops or abilities — and `lookahead` PASSES where the heuristic
> swings in **15 of 24** cases.

That is a sharp result: the whole remaining gap between a one-ply policy and real engine rollouts
sits in the attack step, and search is the more cautious of the two.

**The hypothesis.** A one-ply policy scores each attacker against the blockers in front of it and
cannot see the turn after, so it sends creatures it needed at home. `trimForDefence` dropped
attackers — biggest first, since the biggest blocks the biggest — until whatever stayed home could
survive a pessimistic counter-swing.

📊 **The verdict: WEAKER.** Same harness as §3.74 (9 decks × 36 pairs × 60 games × both
orientations = 4,320 games), the feature against the pilot without it:

| | |
|---|---|
| matched slots | 2,160 |
| ahead (hold back) | 18 |
| **ahead (attack freely)** | **39** |
| level | 2,103 |
| McNemar p | 8.1 × 10⁻³ |
| verdict | **weaker** |

So the code is gone. ⚠️ **The lesson is not "lookahead was wrong" — it is that COPYING A SEARCHING
PILOT'S CONCLUSION IS NOT THE SAME AS HAVING ITS REASONS.** `lookahead` declines those attacks
because it evaluated *those* positions; a rule that declines attacks *shaped like* them throws away
races that the pilot was winning. Caution is a judgement, not a policy, and the evidence pointed at
the right STEP while saying nothing about the right RULE.

⚠️ **This is also why the A/B seam is worth its weight.** The hypothesis was plausible enough to ship
on argument alone, and it would have made the pilot quietly worse in a way no test would have caught
— every unit test still passed, and the win rate would have drifted where nobody was looking. The
flag cost one parameter and one bench run to refute.

**What survives**: `bench/oracle-diff.mjs`, which found the signal, and `bench/feature-ab.mjs`
(generalised from §3.74's harness — it now takes `--feature <name>`, so the next hypothesis is one
flag and one command away).

**Still open, and now known to be where the value is**: the attack step, and specifically WHICH
attacks search declines. The shortlist is 24 windows; reading them one by one is the next honest
step, rather than another rule guessed from their shape.

### 3.74 The pilot takes a win it can prove — lethal before profit — ✅ done

**The first MEASURED strength gain**, and the method matters as much as the change.

Where to look came from data, not taste. `bench/missed-plays.mjs` asks the ENGINE what a seat could
still legally have done at the end of each turn, so a "missed play" is one the menu really offered:

- land drop left unused: **0.0%** — mana development is already clean;
- main-phase passes with a castable spell on offer: **0** — it never sits on a spell it can cast;
- **attack windows declined: 15.0%** — combat was the only open surface.

**The bug: `chooseAttack` judged every attacker independently and never asked about lethal.** Three
2/2s facing one 4/4 each individually lose the trade, so all three were declined — while the 4/4 can
only block ONE, two connect, and at 4 life that is the game. A pilot that can win this turn and does
not is not being careful, it is misplaying.

`lethalAlphaStrike` assumes the defender's best case throughout, so a `true` is a guarantee: each
untapped enemy creature blocks one attacker (CR 509.1), they block the BIGGEST ones, and only the
remainder connects. ⚠️ It deliberately under-claims — an untapped creature that could not legally
block is still counted as a blocker, and tricks, prevention and lifegain are ignored. Every one of
those makes it refuse an attack that was in fact lethal: a missed win, never a thrown game.

📊 **THE VERDICT, head-to-head against the pilot exactly as it was before**
(`bench/alpha-strike-ab.mjs` — 9 decks × 36 pairs × 60 games × both orientations = **4,320 games**):

| | |
|---|---|
| matched slots | 2,160 |
| **ahead (new)** | **64** |
| **ahead (old)** | **0** |
| level | 2,096 |
| McNemar p | **3.6 × 10⁻¹⁵** |
| verdict | **stronger** |

Read it correctly: the two arms play the *same game* in 2,096 of 2,160 slots, because the case is
rare — and in every single one of the 64 slots where it arose, the new behaviour converted it. The
raw win share (51.4%) is the *wrong* number to quote for exactly that reason: it is diluted by
thousands of identical games.

⚠️ **THIS IS WHY THE FEATURE IS BEHIND A FLAG.** Two BUILDS of one pilot cannot be compared across
branches — both hold the same id, only one can load, and the same-id control is 50% on both branches
by construction. `HeuristicFeatures.alphaStrike` lets both behaviours sit in one process and play
matched seeds against each other. The flag stays so the claim stays re-checkable when the pilot
changes; it is an A/B seam, not a configuration knob.

⚠️ **AND THE CONTROL HAS TO BE REAL.** The first version of `alpha-strike.test.ts` built its board
without initialising `state.combat`, so the engine offered no `declareAttackers` at all: every arm
"declined to attack", and the control passed while proving nothing. The fixture now asserts the menu
really offers the attack before asking what the pilot does with it.

📊 Context for how much room is left: `lookahead`, which searches real engine rollouts, beats the
heuristic — but on matched slots by 42 to 10, with **88% of slots level**. The heuristic is already
close to what this engine's search finds, so strength gains come one proven case at a time.

### 3.73 The fast pass — not building a menu nobody reads — ✅ done

Measured first, and the measurement is the design. `bench/window-stats.mjs` over 60 games:

> **592 decision windows per game. The pilot passes 81.7% of them.** `tapForMana` is **73% of every
> action ever offered** (128,349 of 174,963), and only 27.4% of windows offer nothing but a pass.

So four windows in five, the engine enumerated a full legal menu — dominated by mana taps that exist
only to fund a spell nobody is casting — the pilot scored it, and it was thrown away.

**`Pilot.willPassPriority` is a PROMISE, not a hint.** A pilot may answer, from the state alone,
*"whatever that menu holds, I am passing"* — and the harness then applies the pass **without calling
`generateLegalActions` at all**. That is the entire saving and the entire danger: nothing checks the
answer afterwards, so a wrong `true` would make the pilot play worse in every recorded win rate,
silently. The contract is therefore one-sided — `false` is always safe and means "ask me properly",
and every line of the gate is a *refuse when unsure*.

**What the gate can prove**, cheaply, without a menu:
- a parked question, a non-empty stack or a combat declaration → never (each is a real decision);
- a live card grant → never (granted flashback is not visible on the card);
- otherwise: the cheapest thing playable **in this window** — respecting timing, cycling, flashback's
  own speed, and whether a land drop is still available — against an **upper bound** on mana
  (floating pool + untapped sources). ⚠️ The bound over-estimates deliberately: over-estimating can
  only ever make the gate answer `false` and build the menu that would have been built anyway, while
  under-estimating would skip a window the pilot could really have acted in.

⚠️ **THE GUARD IS THE POINT** (`packages/sim/src/fast-pass.test.ts`): whole games are played with the
seam on and off across three archetypes × 12 seeds × both seats, and the **decision traces must be
identical action for action** — not just the same winner, which two different games can share. A
second test checks the promise window by window against the pilot's actual choice, and requires the
gate to fire at least a hundred times, because "it never lied" is a claim about nothing if it never
speaks.

📊 **Honest numbers.** The gate fires on **49.8%** of windows (a first version managed 1.6% — it
refused whenever the graveyard was non-empty, which is 85% of the time, so the useful condition was
"is there an instant-speed flashback card there", not "is it empty").

| | before | after |
|---|---|---|
| single-thread (`bench/pilot-bench.mjs`, 3,000 games) | 174/sec | **195–204/sec** |
| auto path, 3,000-game match | 469/sec | **485/sec** |
| auto path, 6,000-game match | 598/sec | **622/sec** |
| auto path, 20,000-game match | 764/sec | **795/sec** |

Cumulative with §3.72, on the run size the tool is actually used at: **327 → 485 games/sec, +48%.**

⚠️ **STILL NOT 10×, and the profile says why.** Pilot `decide` 33.9%, `applyActionToDraft` 32.7%,
`generateLegalActions` 19.9% — roughly 87% of the run in three blocks. This removes half of one of
them. An order of magnitude needs the other two restructured as well: an apply cheaper than a draft
clone, and legal actions generated incrementally rather than rebuilt per decision.

### 3.72 The sim was hiring workers that made it slower — ✅ done

Measured before anything was touched, and the measurement is the whole story. On the reference box
(12 hardware threads, **6 physical cores**), a 6,000-game match under the heuristic pilot:

| workers | 2 | 3 | 4 | 5 | **6** | 8 | 11 |
|---|---|---|---|---|---|---|---|
| games/sec | 343 | 463 | 551 | 575 | **593** | 559 | 516 |

Throughput **peaks at the physical core count and falls off after it** — and auto mode was hiring
**11**, for 516 games/sec where 6 gives 593. At 3,000 games it was far worse: 327 against 451.

**Two stale constants, both calibrated against a machine that no longer exists.**

- `availableParallelism()` reports HARDWARE THREADS, and the policy spent them as if they were cores.
  This workload is compute- and allocation-bound — every worker holds its own copy of a 5,000-card
  pool and churns game states — so SMT siblings contend for the same execution ports instead of
  overlapping stalls. `HARDWARE_THREADS_PER_CORE` folds the count down, with the measured curve
  written next to it.
- `AUTO_GAMES_PER_WORKER = 150` claimed 150 games "comfortably more" than a worker's startup, quoting
  "double-digit games/sec" and "~1–2s" of startup. Both were true when written. Today startup is
  **~0.35s** (292ms of it importing `@jonny-boi/cards`) against **~180 games/sec** single-threaded, so
  150 games is 0.8s of work — auto mode was hiring workers that could not pay for themselves. Now 400.
- `HOST_RESERVED_CORES` is **deleted**. Folding by SMT already leaves the dispatching host a thread,
  and taking a whole core off on top measured strictly worse (5 workers 575 vs 6 workers 593 at 6,000
  games; 723 vs 765 at 20,000) — the host spends the run waiting on messages, not working.

📊 **The honest numbers, auto path, before → after:**

| run | before | after | |
|---|---|---|---|
| 3,000 games | 327/sec | **469/sec** | +43% |
| 6,000 games | 516/sec | **598/sec** | +16% |
| 20,000 games | 758/sec | **764/sec** | +1% |

A win at every size, and biggest exactly where the tool is used most — a gauntlet or a swap test is
thousands of games, not tens of thousands.

**NEW: `packages/sim/bench/pilot-bench.mjs`,** because the numbers above could not be got otherwise.
⚠️ `npm run sim -- match` plays its games in a WORKER, so `node --cpu-prof` on it profiles a parent
process that is **99% idle** — a profile whose top entries are the module loader. The bench runs the
games on the main thread, so the profiler sees the engine and the pilot. **NEW
`bench/window-stats.mjs`** answers the other question, and its answer is where the next work is:

> **592 decision windows per game. The pilot passes 81.7% of them. `tapForMana` is 73% of every
> action ever offered (128,349 of 174,963), and only 27.4% of windows offer nothing but a pass.**

⚠️ **THIS IS NOT 10× AND IS NOT CLAIMED TO BE.** The in-process profile says pilot `decide` 33.9%,
`applyActionToDraft` 32.7%, `generateLegalActions` 19.9% — about 87% of the run in three blocks, so
an order of magnitude needs all three restructured, not tuned. The window statistics above name the
shape of that work: the engine builds a full menu, dominated by mana taps, for a pilot that passes
four times in five.

### 3.71 The whole printed card pool — 573 → 5,065 shippable cards — ✅ done

Compiling a card and SHIPPING it are different things. The compiler could read 4,863 of the pool;
the app shipped **573**, because the pool was generated from a 1,009-name candidate list. It is now
generated from the corpus itself: **5,065 compiled cards + 32 hand-authored = 5,097 playable**, each
still admitted only on the compiler's own `complete` verdict. Nothing is approximated in.

⚠️ **THE CORPUS FILTER WAS LYING, and that matters more than the count.** `fetch-full-corpus.mjs`
decided "is this a paper card?" from the ONE printing `oracle-cards` happens to carry — and Scryfall
picks that printing. For **Black Knight, Capsize and Weakness** it picks an MTGO-only reprint, so the
record reads `digital: true`, `games: ['mtgo']` for cards that have been in paper since Alpha. The
search-API version of the same mistake (`is:digital -is:paper` — a PRINTING predicate) matched an
MTGO printing of **Plains** and removed the basic land from the corpus. `in:` is the card-level
prefix: `-in:paper` gives **874** cards never printed on cardboard, not 7,369. Corpus 31,091 →
**32,276**, so every coverage number reported before this was computed against a corpus missing
~1,185 real cards.

**One bulk download now builds both artefacts, offline.** `build-expansion.ts --corpus` and
`npm run fetch -w @jonny-boi/data-tools -- --corpus` replace thousands of paged requests, and the
corpus carries `set`/`rarity`/`image_uris` for exactly that reason. The invariant that keeps them
consistent: **the index owns ids, the corpus owns everything else.** A bulk corpus carries one
arbitrary printing, so re-picking would rewrite Plains' id out from under `pool.ts`; and preserving
whole ROWS — the first attempt — made the index and the pool compile from different Oracle text,
which the ground-truth test caught immediately.

📊 **Seven latent bugs the bigger pool exposed, every one fixed here.** This is the real value of the
change; the card count is the side effect.

| bug | why it survived |
|---|---|
| `tap: true` written into `ManaAbilityCost`, a field that does not exist | the generated array literal had no contextual type, so TS never excess-property-checked the data. TS2590 forced chunking, chunking gave the literal a type, the type found the phantom key |
| `Number.parseInt('-0')` is **negative zero**, and `JSON.stringify(-0)` is `"0"` | Befuddle's "-4/-0" could never round-trip through the generated pool. One `parseSignedInt` now serves all twenty parse sites |
| the heuristic **built** `activateAbility` itself, without `costInstanceIds` | every sacrifice-cost ability the pilot chose was rejected unpayable. It now takes the engine's own offer |
| `planManaPayment` dropped the additional-cost payer | five call sites rebuilt `tapForMana` from `{instanceId, mode}`, so Springleaf Drum and Phyrexian Tower were refused mid-game. One `tapActionFor` builder now owns the shape |
| **token-ness treated as a copiable value** (CR 707.2) | a Glasspool Mimic copying a Thopter token inherited `isToken`, and `ceaseToExistIfToken` then deleted **a real card from every zone** when it died. Surfaced as "original instance #61 is in no zone on turn 37" |
| the land-drop audit compared against `maxLandsPerTurn` | Exploration makes a second land drop legal; the audit now asks `maxLandPlaysFor`, the engine's own answer |
| two compile rules superseded by the §3.60 conjunction helper | they matched no card at all, while naming cards they claimed to compile |

**Guards were re-tiered, never dropped.** Three of them assumed a hand-picked pool and would have
become permanently red — which is no guard at all:

- **attachments** kept their human transcription for named cards; every other attachment must match a
  reading taken independently from its Oracle text. 200 attachments, 3 disagreements, all three the
  second reader misreading a granted ability.
- **mana sources** were capped at "2 per tap, except two cards by name". The ceiling is now read off
  each card's own printed "Add …" line — a stricter check on 5,065 cards than on two exceptions.
- **`uncounterable`** went inert because the opponent deck ROTATES and the rotation moved off
  counterspells. `enablerBelongsToOpponent` declares the pairing instead of leaving it to the length
  of a list.

⚠️ **PWA weight, stated rather than hidden.** The pool and the index are their own rollup chunks so
the shell still paints before 5,065 definitions parse, and workbox's 2 MiB precache cap is raised to
cover the pool: an offline-first deck lab that cannot open a card offline has precached the wrong
things. Precache total 5.7 MB.

📊 Throughput unchanged: 2,000-game single-worker match (Mono-Red vs UW Control, seed 7, heuristic)
reads **179/180 games/sec**, against 169/170 measured on this same branch before the engine fixes.
Verify: 19,362 passed, 5 skipped, 0 failed.

### 3.70 Cost assistance — Convoke, Improvise and Delve are one mechanic (CR 702.51/126/66) — ✅ done

Convoke was the #1 item on the honest backlog by BOTH independent measures — 46 cards by mechanic and
46 by clause shape, the two tools agreeing for the first time (§3.68). It was built as a class rather
than a card: Convoke, Improvise and Delve are one shape wearing three names.

- a RESOURCE the caster owns — an untapped creature, an untapped artifact, a card in the graveyard;
- CONSUMED in a particular way — tapped, tapped, exiled;
- each paying **one mana** toward this spell.

The only real difference is what one resource may pay for: a convoking creature pays "{1} or one mana
of that creature's color" and so can cover a coloured pip, while an improvising artifact and a delved
card pay generic only. That is one boolean in `COST_ASSISTS`, not a branch in the planner — and a
fourth mechanic of this shape is a ROW.

📊 **+70 cards: 4,793 → 4,863 of 31,091** — 46 + 12 + 12, exactly what the report predicted, because
all three printed lines are bare keywords with the mechanic in stripped reminder text.

⚠️ **THE ASSIST IS THE MINIMUM THAT MAKES THE SPELL PAYABLE, NEVER THE MAXIMUM.** Every one of these
mechanics is optional, so tapping fewer is always legal — and the resources are anything but free: a
convoked creature cannot block this turn and a delved card is gone for good. A planner that consumed
everything it legally could would be obeying the rules while throwing the game. So the planner asks
`canPay` after **every** step and stops the moment the cost is covered, and it returns `undefined`
when the pool already pays, because acting there would tap creatures for a spell that needed no help.

⚠️ **Coloured pips are assigned FIRST.** Only a resource of that exact colour can pay one, so spending
a green creature on generic and then finding the {G} unpayable is the ordering bug this is written to
avoid. Generic is filled afterwards, one at a time, from whatever is left.

**Offer and pay share the planner.** `pushCastOffers` asks only on the branch that was about to
refuse — a board with no assist card pays one property read for the question — and `applyCastSpell`
re-plans from the live board before charging any mana. Nothing is tapped for a cast that is then
rejected, because the mana half is checked against the plan's own `remaining` first.

⚠️ **Honest limits, both of them legal choices rather than approximations.** A hybrid pip really can
be paid by a convoking creature of either colour and this planner leaves it to real mana; and a card
printing "Convoke, delve" (there is exactly one) **reports** rather than compiling to one of the two.
Declining to convoke a pip is something the caster is always allowed to do, so the engine plays a
legal game that is occasionally more conservative than a perfect pilot — it can never play *better*
than the printed card, which is the direction that matters.

📊 Throughput unchanged: 2,000-game single-worker match (Mono-Red vs UW Control, seed 7, heuristic)
reads 169/170 games/sec on this branch against 158/159 on `main`. The two were measured in different
worktrees, so the honest claim is **no regression**, not a speed-up.

### 3.69 Affinity — a spell that costs less for each permanent you control (CR 702.40) — ✅ done

Picked from the backlog the moment §3.68 made the backlog honest: with ability-word labels folded
away, both independent reports agreed Affinity was the largest unimplemented mechanic that needs no
new payment machinery. Predicted 28 cards; **delivered 22** (4,771 → 4,793 of 31,091). The smaller
number is the real one — the rest carry a second gap as well.

**A separate field from the reduction that already existed, on purpose.** `castCostReduction` is a
grant a PERMANENT makes to its controller's matching spells, and the engine finds it by walking the
battlefield. Affinity is printed on the SPELL and scales with a board count. Folding the two
together would mean either walking the battlefield for a reducer that is never there, or reading a
spell in hand as though it were on the battlefield — and the second is how a card ends up reducing
its own cost from inside the graveyard. So `castCostReductionPerPermanent` is its own field, applied
in `castManaCostFor`, which is the ONE place a cast cost is computed and therefore the one place
both reductions can ever disagree.

⚠️ **The early return was the trap.** `castManaCostFor` bailed out when the caster controlled no
reducing permanent — correct for a grant, fatal for affinity, which applies on a board with no
reducer at all. A version that kept that bail-out would have made every affinity card cost full
price on exactly the empty-ish boards where affinity is the reason you are casting it.

**One rule, two printings.** Scryfall prints the keyword line and puts the whole mechanic in reminder
text, which is stripped before the rule table sees it — so `affinity-cost-reduction` matches both
"Affinity for artifacts" and the longhand "This spell costs {1} less to cast for each artifact you
control", and a test asserts the two compile to identical data. `amount` is named rather than
assumed 1, so the longhand "costs {2} less for each…" wording has somewhere honest to go.

⚠️ **"Affinity for Slivers" REPORTS.** The noun goes through `permanentNounFilter`, the same closed
table every other selector reads. A creature-type affinity this engine cannot express is refused
rather than widened to "for each creature" — which would make the spell dramatically cheaper than
printed. That is the closed-table discipline (CLAUDE.md §2) doing exactly what it is for.

### 3.68 An ability word is a label, not an ability (CR 207.2c) — ✅ done

**Found by fixing the measurement, not by reading code.** The keyword gap report claimed 412 cards
were blocked by a missing "Enchant" — a mechanic this engine has had for as long as it has had
Auras. It was substring-matching Scryfall's keyword list against the blocking clause, so every Aura
whose grant BODY was unsupported ("Enchanted creature can't attack or block") was filed under
`Enchant`. Two more attributions were tried and were wrong in the opposite direction before the
honest one landed; all three are written up in the script's own header, because each is the natural
thing to reach for.

With the attribution fixed, the top of the backlog was **ability words** — landfall 59, domain 44,
heroic 37, raid 37, constellation 26 — and CR 207.2c says an ability word has *no rules meaning at
all*. Probing one said why:

> `Flying. Revolt — When ~ enters, if a permanent left the battlefield under your control this turn, you gain 5 life.`

`joinRevoltRiders` glued **every** ability-word line onto the line above it. That is right for Fatal
Push, whose Revolt line says "Destroy **that** creature … **instead**" and is meaningless alone —
and wrong for the hundreds of cards whose labelled line is a complete triggered ability. The glued
sentence can never match any rule, so those cards were unreachable through a gap that looked, in
every report, like a missing mechanic.

**A rider is now detected by being unable to stand alone**, not by wearing a label: a dangling
demonstrative ("Destroy *that* creature"), or an "instead" **in the line's own first sentence** on a
line that does not open an ability of its own. Akoum Hellkite is why that last qualifier exists —
its "deals 2 damage instead" replaces its *own* first sentence, and reading the word alone glued a
complete landfall trigger to the word `Flying`. Every other labelled line has the label folded away
and meets the rule table as the ability it always was.

The ability-word vocabulary is a **closed table derived from the corpus** (not from memory — every
entry is a label seen at the head of a real printed line), and what it leaves out is the point: a
Saga's `I`/`II`/`III`, `Channel`, `Exhaust`, `Boast`, `Bloodrush`, `Forecast`, `Companion`,
`Max speed`, `To solve`/`Solved` and `Eminence` all print in the same italic-word-then-dash shape
while carrying real rules. Folding those away would delete the ability instead of revealing it, so
they stay out and keep reporting honestly.

📊 **The honest number is small: 4,757 → 4,771 playable of 31,091 — +14 cards**, not the ~450 the old
attribution implied. Stripping the label exposes the BODY, and most of those bodies are still
unimplemented. The change is kept because the backlog now names the body instead of the label, so
every future measurement is honest — the 14 cards are a side effect, not the case for it. Proof that
it worked: the two independent tools now agree on what is next (Convoke, 46 cards, ranked #1 both by
mechanic and by clause shape), where before they disagreed by a factor of thirty.

### 3.67 Regeneration — the shield that replaces destruction (CR 701.15) — ✅ done

Picked from data, not intuition: `keyword-gap-report.mjs` ranked **Regenerate at 129 cards blocked
by it alone** — the top unimplemented *named* mechanic once Enchant/Equip/Flying were discounted as
already-modelled statics. Delivered **4,702 → 4,757 playable of 31,091** (+55 whole cards; the other
74 need a second missing system as well, and the report says which).

**A regeneration shield is a REPLACEMENT effect, not a heal.** CR 701.15: the next time this
permanent would be destroyed this turn, instead remove all damage from it, tap it, and remove it
from combat. Every clause of that is load-bearing and each is pinned by a test — a "shield" that
merely cleared damage would let a regenerating blocker keep blocking, which is the exact thing the
tap-and-remove-from-combat clause exists to prevent.

**One funnel, two death routes.** A creature reaches destruction two ways — the lethal-damage state
based action and the `destroy` primitive — and if only one consumed shields, half of Magic would
regenerate and the other half would not. Both now call the SAME exported helper,
`consumeRegenerationShield` in `internal/sba.ts`; the primitive calls it immediately after the
indestructible check, because indestructible is a *different* replacement that wins outright and
must not burn a shield it never needed.

**Shields are a COUNT, not a flag.** "Regenerate ~" twice before blockers means two shields, and
using one must leave the other. Storing a boolean would silently discard the second activation — the
kind of approximation this codebase reports rather than makes. The count is cleared in the CLEANUP
step, not on use, because the shield lasts "this turn" and no longer.

⚠️ **The compile rule earns its keep only because the primitive is real.** `regenerate-self`
(`/^regenerate ~$/`) is one row; the keyword is listed in `PRIMITIVE_BACKED_KEYWORDS` so the
compiler stops calling it unsupported. Cards whose regeneration is a *cost-bearing activated
ability* already compiled through the existing activated-ability parser once this primitive existed
— which is why 55 cards flipped for one primitive and one rule. Verified live: Darkling Stalker,
Troll Ascetic, Wall of Pine Needles and Thrun, the Last Troll all compile COMPLETE.

### 3.67 The AI co-pilot — what the pilot would do in your seat, and why — ✅ done

Asked for as: *"an 'AI co-pilot' mode that tells you what it would do if it were you playing the deck —
by highlighting the input controls of what it would do. You can do what it says, or not. Once you
make a move it should recalculate... Each time the AI suggests its next move, it should explain why."*

**A thin module, not a new brain.** The pilot already answers exactly this question — `chooseAction`
takes a view and returns the move it would make — and it already knows WHY: the heuristic emits a
`DecisionTrace` (`{action, reason, score}`) whenever a caller supplies a `trace` sink, and skips
building the string entirely when nobody is listening. So the co-pilot (`lib/play/copilot.ts`) is:
ask the SAME pilot the Lab uses, as if it held the human's seat, keep the trace, and hand both to the
board. ⚠️ **That is why the explanation can be trusted** — it is the pilot's own stated reason for the
move it actually chose, not prose written about a move after the fact, which is what an explanation
invented at the UI layer would be and which would eventually describe a decision made for another
reason. A live hint reads, verbatim from the pilot: *"Play Forest — develop mana — play Forest
(unlocks 18 vs Blossoming Sands 0, Plains 18)"*.

**Highlighting is a table, not a chain of ifs.** `suggestionTarget` maps an action to what the board
should outline — the card for `playLand` / `castSpell` / `activateAbility` / `tapForMana`, the action
bar for everything whose control is a button (pass, declare attackers, confirm blocks). Adding the
next highlightable action is a ROW. The mark is a dashed outline, never a disabled control or a forced
path: the co-pilot advises, the player decides.

**Recalculation is free because the suggestion is DERIVED, not stored.** It is a `useMemo` over the
live session, so every committed change — yours, the opponent's, a trigger resolving — re-asks the
question; a stored answer could only ever be aged. It is asked from a FIXED seed
(`COPILOT_ADVICE_SEED`) so the advice for a given board is the same every time it is drawn — advice
that flickered between renders would be impossible to act on — and that seed is advice-only: it
takes no part in the game's own determinism, and the preference is deliberately NOT in the resume
record (a saved game must replay identically whether hints were on or off).

**It advises only on YOUR decision.** No suggestion on the opponent's turn, none once the game is
over. The pilot sees the whole state, so advice at any other moment would be a hidden-information
leak dressed as help. Off by default; the toggle sits in the action bar beside the mana one because it
is the same kind of setting — a thing players switch on mid-game when a board gets hard.

📊 Verified live: toggling on outlined the Guildgate the pilot named; following the advice moved the
game on; the hint vanished during the computer's turn (correct — not our decision) and returned on
turn 3 with a fresh recommendation; across the drive two distinct hints were seen ("Pass — no
profitable play — passing", then the Forest line above). 11 unit tests, the load-bearing one being
that a suggested action is SUBMITTED to the engine and accepted — "legal" is not taken on trust.

### 3.66 The game library — every game kept, scrubbable, and forkable — ✅ done

Asked for as: *"any games we start that aren't ended can be resumed easily later — regardless of why
they weren't finished... all games played should be held on record so they could be reviewed whenever
but should come with a delete button... I want to be able to scrub forward and backward through any
of the saved games and take the game at any point, and fork it by playing it right from where I
scrubbed to. Any forked games should obviously share the same seed. And should have some kind of UI
connection to each other."*

**An entry wraps §3.58's `PlayRecord` rather than replacing it.** That record is already the exact,
complete input to a game — resolved decklists, base seed, starting player, mulligan transcript,
accepted-action script — and `rebuildFromRecord` already replays one back into a live session. A
library entry therefore adds only what a LIBRARY needs and a single save slot did not: identity,
outcome, and lineage. One record shape, one replay path, no second codec to drift from the first.

**A fork is that record with its action log cut short.** The engine is deterministic in (seed,
decklists, actions), so "play on from turn 6" is literally `setup + actions.slice(0, k)` — which is
why a fork **shares its parent's seed by construction** rather than as a feature that had to be
built. Two forks of one game are the same shuffle explored two ways, which is the only thing that
makes "what if I had played differently here" a fair question in a tuning lab.

**Scrubbing is the ordinary board, not a bespoke replay view** — same tiles, same log, same hand,
with only the source of the state differing. `rebuildFromRecord` gained an optional stop-at-action;
that is not the partial replay it refuses elsewhere, because it stops where the caller ASKED, so the
result is an exact earlier state of the same game.

⚠️ **A reviewed game is read-only, and this is load-bearing.** While the scrubber is engaged the
session is an earlier state of a real game, so the autosave is suppressed: saving it would file that
game with its own future deleted, and scrubbing back through a game would destroy the very thing
being reviewed. Writing resumes only when the player takes it over — by which point a fork id is
already in place if they rewound.

**One entry per GAME, not per autosave.** The surface carries a library id for the game's whole life,
and a resumed or forked game arrives with its id already set. Rows are ordered BY LINEAGE rather than
recency, so a fork sits directly under the game it came from and says where it split; sorting purely
by time scattered a playthrough and its forks among unrelated games. Pruning drops the oldest
FINISHED games only — a game you could still return to is not the library's to forget.

📊 Verified live end to end, not just in unit tests: a Solo game filed ONE row that grew 149 → 202
actions across a resume (no duplicate row); Review opened the real board with the scrubber at
37 of 37; scrubbing to 20/5/0/12 walked the board back through the states that game actually passed
through; "Fork and play from here" at action 12 produced a second entry with `forkedAt: 12` and
**the same seed 12345**, leaving the parent untouched at 37 actions; the menu then showed "1 fork
from this game" on the parent and an indented "⑂ forked from … at action 12" on the child; Delete
removed a row from both the list and storage. 38 unit tests cover the record, list, lineage and the
scrub/fork equivalence — the last of those replays a real engine game and asserts every scrub point
reproduces the exact fingerprint that game had at the time.

### 3.65 The gauntlet table says whose win rate it is — ✅ done

Reported as *"figure out why the Selesnya Blink deck is so bad against the Gauntlet — even though when
I play it manually, I beat those decks most of the time"*. **Measured first, and the premise does not
hold for the sample deck**: Selesnya Blink is the STRONGEST list in the gauntlet — **615/800 = 76.9%**
at seed 99, **226/320 = 70.6%** at the Lab's own default seed. Its engine is not broken either; a
probe over 30 games against its worst opponent counted 225 enters-triggers, 205 Thragtusk life gains,
182 Thragtusk leave-tokens and 143 Conjurer's Closet end-step triggers. And the frightening row —
Mono-Green Ramp at 42.5% over 40 games — is noise: the same matchup over **200 games is 50.5%
(CI 43.6–57.4)**.

**What was actually broken is the table.** Every number in the gauntlet result is the HERO's, per
opponent — but the header said a bare "Win rate (95% CI)" beside a column of OPPONENT names, and the
win-rate bar was labelled with the opponent's name. So a row reading

> `Selesnya Blink · 13/100 · 13.0%`

is the hero winning 13% AGAINST Selesnya Blink, and reads exactly like Selesnya Blink scoring 13%.
That is how the strongest deck in the meta comes to be reported as the worst. The columns now name
the hero (`<deck> record`, `<deck> win rate (95% CI)`) and the bar is labelled `<hero> vs <opponent>`.

⚠️ Worth keeping in mind whenever a run result grows a column: a measurement of A-against-B rendered
next to B's name is ambiguous by default, and the reader has no way to tell which way round it is.

Pinned by `components/lab/gauntlet-row-owner.test.ts` (static render, the `jail-tile.test.ts` idiom —
this is about what the markup SAYS, which no engine test can see). Sabotage-checked: reverting the
panel reddens 3 of its 4 cases.

### 3.64 A double-faced card is two type lines, not one — ✅ done

Handed over by §3.61, which worked around this at the web seam rather than fixing it: `parseTypeLine`
parsed a COMBINED Scryfall line — "Creature — Minotaur Warrior // Land" — as a single type line. The
result was in the committed data for **all 50 double-faced cards in the pool**: a literal `"//"` sat
in `types` or `subtypes`, and the back face's words were filed under the front's. Akoum Warrior
claimed **Land as a subtype of a creature**, which any rule matching on subtypes would believe;
"Assault // Battery" claimed two Sorcery types; `//` was a card type you could count.

**The fix is the reading that makes the card level self-consistent.** A combined line now describes
the FRONT face only — which is what every other card-level field already means (`power`, `toughness`,
`oracleText` all read `raw.X ?? frontFace.X`), and each back face carries its own clean `type_line`
in `faces[]`, so nothing is lost, only correctly filed.

⚠️ The fix had to go in the PARSER, not the caller: `invariants.ts` re-parses each card's stored
`rawTypeLine` and demands it equal the stored `typeLine`, so a normalizer-side fix would have made
the committed data fail its own round-trip invariant. It duly did fail on the old data, which is how
the migration below announced itself.

**The committed data was re-derived, not re-fetched.** `typeLine` is a pure function of the
`rawTypeLine` each card already stores, so the 50 rows were recomputed offline and
`apps/web/src/data/card-index.json` regenerated from them by its script — no Scryfall round trip, and
the newline convention preserved so the CRLF guard stays quiet.

📊 **Nothing else moved.** Seed-99 gauntlet rows re-measured after the migration: Mono-Red
**257/800**, Selesnya Blink **615/800** — byte-identical, so the correction is a data fix and not a
behaviour change. §3.61's `filterableTypes` (which unions every face for the Cards page chips) stays
correct and complementary: the card level is deliberately the front face, and the chips deliberately
want both.

### 3.63 Flip for who goes first — ✅ done

Reported alongside the mulligan question (triage found mulligan present in all three playable modes,
so only this half was real): the setup screen let you PICK a seat but never let you flip for it,
which is how the first turn is actually decided at a table.

**Where the flip happens is the whole design.** The engine is deterministic — seed + decklists +
actions replay a game exactly, which is what §3.58's saved games and the Lab both stand on. A
"random" starting player left unresolved inside the game would break that: the saved record would
say `random` and every resume would re-flip into a different game wearing the same clothes. So the
flip resolves ONCE, at the setup screen (`lib/play/first-player.ts`), and everything downstream —
the created game, the persisted record, the replay — only ever sees a concrete `PlayerId`. The unit
test asserts exactly that property, not just the 50/50 split.

⚠️ **Not derived from the game seed**, which would be the natural trick in a codebase this
deterministic. The seed field defaults to a FIXED value, so a seed-derived flip would hand the first
turn to the same seat every game until the player thought to change a number they have no reason to
touch. A coin that always lands heads is not a coin. Entropy is real (`crypto.getRandomValues`, with
a `Math.random` fallback because some embedded webviews have no `crypto` and a missing global must
not be able to break starting a game); its RESULT is what gets recorded.

**A rematch flips again.** `GameConfig` carries both this game's resolved `startingPlayer` and the
`starterPreference` behind it, so "Random" does not mean "random once, then fixed forever". Honest
limit: a game RESUMED from a saved record inherits its starter as an explicit seat, because the
record stores who actually started (it must, for the replay to be exact) rather than what was picked
to get there — so rematch-after-resume keeps that seat. Versioning §3.58's record for that nicety
would be the wrong trade.

📊 Verified live as well as in unit tests: ten Solo games started with "Random" on the same fixed
seed produced A,B,A,A,B,B,A,A,B,A — both seats reached, and the persisted record held a concrete
seat every time, never the word `random`.

⚠️ **Online is NOT covered.** The online surface has no first-player control at all — `startingPlayer`
does not cross the wire — and adding one is a protocol + server change, not a web one. Left open
deliberately rather than half-built.

### 3.62 The board fits the window — a canvas that scales, not a document that grows — ✅ done

Reported plainly: *"the game board should fit without scrolling"*. It did not, and the gap was not a
tuning gap — at 1280x800 the board asked for **871px of a 600px slot**. Measured before touching
anything: status 55, opponent seat 205 + their card backs 88, your seat 207 + your hand 168, action
bar 63, gutters 64. Even a 1440x1100 window scrolled.

**Why the obvious fix is the wrong one.** A first attempt made the shell fixed-height and let the
seats absorb the slack. The page stopped scrolling and the player's own HAND went below the fold —
technically the reported bug, practically worse. It was reverted unshipped. What replaced it is the
arrangement every digital MTG client converges on, asked for by the user in exactly those terms
("how does MTGA manage it?"): the board is a **canvas that scales**, and readability is bought by
**zoom**, not by size (every card here was already click/right-click zoomable — §3.54/§3.57 — which
is what makes shrinking legitimate rather than merely smaller).

Five rules, all in one file (`components/play/board-fit.css`) so the whole idea can be read — or
reverted — in one place:

1. **One scale knob.** `--play-card-w` / `--play-tile-w` are `clamp()`s on viewport height; hand
   faces, battlefield tiles and card backs all derive from them. A tall window resolves to exactly
   the 148px/96px the app shipped with, so this bought the small window without taxing the large one.
2. **The hand fans instead of wrapping.** A slot may shrink below the card it holds, so cards spread
   out when there is room and slide over each other when there is not — no card count, no JS, no
   breakpoint. Hover raises one clear. The opponent's hidden hand had fanned this way since it was
   written; this generalises that idiom (and lifts its `-2.2rem` literal into a token) instead of
   inventing a second one.
3. **The shell owns the height.** Scoped with `:has()` to frames that actually mount a board, so
   every other view keeps ordinary document flow and a browser without `:has()` degrades to today's
   scrolling page rather than a broken layout.
4. **The seat's identity sits BESIDE its battlefield, not above it.** The single biggest win: name,
   life and zone counters move into a narrow rail to the left of the creature and land rows. Stacked,
   those two strips cost ~59px of height per seat for information that occupies almost no width.
   Pure CSS over the existing three children, so the reading order a screen reader gets is untouched.
5. **Nothing shrinks.** Three attempts made the seats flexible and each failed identically: a box free
   to shrink shrinks THROUGH its own contents, and the first squeeze cut "Computer ♥ 20" off mid-line
   — a seat hiding the life total it exists to show, on a board with no permanents. So the seats are
   sized by their content, the one region with unbounded content (the battlefield strip) is CAPPED and
   scrolls inside that cap, and the log is the only thing that stretches or yields. Deterministic beat
   clever: with nothing shrinking there is no squeeze to get wrong.
6. **A phone gets a phone's budget.** Below the rail's width the seat stacks again — a side rail trades
   horizontal space for vertical, which is only the right trade while horizontal is the plentiful axis;
   at 375px the counters wrapped inside the rail and it grew TALLER than the stacked version. The
   narrow window finds its height elsewhere: the opponent's fanned card backs (whose only content is a
   number their ✋ counter already states), a shorter battlefield strip, tighter chrome. That last one
   is where a phone's space actually goes — the status line and action bar wrap to three lines each at
   that width, 204px of a 600px board, more than any card costs.

⚠️ Two cascade traps this hit, both invisible to the test suite and worth knowing before editing:
the rules must be scoped under `.play-board` to **win** against `styles.css` (equal specificity means
module import order decides, and it decided against this file first); and the battlefield renders
`.perm`, **not** `.play-card` — the first version scaled the wrong class and moved nothing while the
tokens resolved perfectly.

📊 Proven by measurement in a real browser, because jsdom has no viewport, no flexbox and no `dvh`:
`node apps/web/scripts/verify-board-fits.mjs` (build first) drives the SHIPPING bundle and asserts
**31 checks** — page and board both non-scrolling, the status line, your hand and the action bar all
FULLY on screen, and NO SEAT CLIPPED (added after the first version fitted the window by cutting a
seat's own life line), at 1280x800 on turn one, at 1280x800 with a crowded battlefield played out
through the real UI, at 1440x1100 (where cards must still measure 148px), and at 375x812. Commenting
out the stylesheet import fails 9 of them, including the page scrolling and the hand off-screen at
every size. Every tuning value below — the row cap, the card clamps, the phone budget — was set by
running this harness, not by eye. Drag-to-play was re-verified by hand through real pointer events after the change, since
the seats became scroll containers.

### 3.61 Four reports off the non-Play surfaces: a filter that half-worked, two identical play buttons, art per deck slot, and a deck that could not name its own broken card — ✅ done

Four in-app bug reports, triaged against `main` before anything was written, because a report filed
several sessions ago is a claim about a build that no longer exists.

**The Cards type chips (report 211945) — the literal claim did not reproduce; the real defect did.**
Selecting Instant *does* narrow the browser, and always did: every one of the seven chips was driven
in a real browser and measured (605 → 207 / 95 / 75 / 110 / 34 / 2 / 125), alone and intersected with
a live name search. What the chips did not do was find every card of the type they name. They matched
`card.typeLine.types`, which `parseTypeLine` derives from the *combined* type line, so only the FRONT
face survives it — and whether a back face's type survives at all depends on whether the front face
happens to carry a subtype dash:

```
"Sorcery // Land"              → types ['Sorcery', '//', 'Land']   ✔ answers the Land chip
"Creature — Elephant // Land"  → types ['Creature']                ✘ does not
```

So `Bala Ged Recovery` was under Land and `Kazandu Mammoth`, the same kind of card, was not. Twenty of
the pool's fifty multi-face cards had a face no chip could reach, the three `Battle — Siege // …`
Invasions matched **no chip at all**, and the literal `//` separator was itself offered as a card type.
Fixed at the display seam with a new pure `filterableTypes(card)` in `lib/filter.ts` — the union of the
card's own types and every face's, minus `//`. Counts after: 209 / 103 / 86 / 110 / 35 / 2 / 130.
⚠️ Deliberately NOT fixed in `data-tools`: `parseTypeLine` feeds the card compiler, deck grouping and
the mana curve, so its blast radius is the engine. The underlying parse bug is logged in COORDINATION
for whoever owns that package. Nine tests in `filter.test.ts` fail without the fix.

**The Watch-a-Game transport (report 211032) — reproduced exactly.** The bar rendered
`⏮ ◀ ▶ ▶`: Play and Step-forward were both U+25B6, two identical play triangles side by side, with
nothing to say which advanced one frame. Nothing was wrong with either button alone — the defect
existed only BETWEEN them, which is why review missed it and why the fix makes the bar **data**:
`TRANSPORT_BUTTONS` in `lib/replay-config.ts`, one list `PlaybackControls` maps over, so "no two
controls look alike" is a property one test can check instead of four literals in four JSX blocks.
Restart gives up `⏮` (which reads as "skip to the start" — Step-back's actual job) for `↺`, freeing
`⏮`/`⏭` for the step pair and leaving the bare triangle meaning play and nothing else.

**Alternate printings per deck slot (report 210919) — built, honestly scoped.** The printing data is
**not** local: `card-index.json` carries exactly one printing per card, and alternates come from
Scryfall on demand. That client already existed for Proxies (`lib/proxy/prints.ts` + `usePrints`, with
a TTL cache), so a deck slot reuses it wholesale rather than opening a second client for the identical
question. `DeckEntry` gains an optional `printing` — art only; `cardId` still decides what the card
IS, so legality, the curve and everything the sim reads are untouched. The chosen printing's image URL
is written onto the entry (exactly as the Proxies overrides already do) so the choice renders after a
reload with no network. It survives storage, export and re-import, and loading the deck into **Proxies**
carries the choices with it — art you cannot print would be a joke of a feature, and the sheet is the
only place art is actually printed. The two models stay separate at a seam (`deckPrintingOverrides`)
rather than sharing a store: a deck entry is keyed by card id and belongs to one deck, a Proxies
override is keyed by name and applies to whatever list is pasted in.

**A deck that could not name its own broken card (reported live off the deployed build).** Solo setup
refused to start with `unknown card "f413a83d-a40d-434c-b20a-4c707c0527fa" … deck size 56 is below the
minimum of 60`. The id is a real Scryfall uuid for a card outside the 605-card pool, and the saved
record was `{ cardId, count }` and nothing else — so neither the player nor we could learn which of
the sixty cards had gone missing, and nothing said anything was wrong until a game was started.

The out-of-pool id is not the root cause. **The name was known at every point the entry could have
been created, and was thrown away anyway** — `buildDeck.ts`'s `toEntries` held the whole resolved
`NormalizedCard` and kept only `card.id`. So `DeckEntry` gains an optional `name`: a tombstone, not a
second source of truth, read only when `cardId` stops resolving. It is recorded by every construction
site that knows it (`addCard`, the importer's `toEntries`, `copyGauntletDeck`, `applySwapToDeck`),
carried through export/import, and **backfilled from the pool on load** — so a deck saved before the
field existed becomes self-describing the moment it is opened on a build that still has the card,
rather than only from its next edit onward. `validateDeck` now leads with the name and keeps the id in
brackets for a bug report; with no name recorded it says the name is unrecoverable and points at
re-import instead of inventing one. Pinned by `deck-entry-names.test.ts`, 7 of whose 11 cases fail
without the change.

⚠️ Two parts of that report are deliberately NOT done here and are still open: the `unknown card
"<uuid>"` string itself comes from `packages/sim/src/deck.ts`, whose wire `DeckEntry` is
`{ cardId, count }` — carrying the name there is a cross-package contract change, and the Play-side
"Not ready" text that surfaces it lives in `lib/play/setup.ts`, which a concurrent agent owns. Note
`resolveCard` there already does `pool.get(ref) ?? pool.getByName(ref)`, so passing the recorded name
as the ref would let out-of-pool-by-id cards resolve BY NAME and fix the deck rather than just
explaining it — the obvious next move, in `lib/sim-format.ts` plus the sim's payload type.
Import-time refusal of an out-of-pool card is also not done (the importer's review step reports
`notFound`/`blocked`, but not "resolved to an id our pool lacks").

Also fixed in passing: `storage.ts` used to `filter()` stored deck entries and hand the RAW objects
back typed as `{ cardId, count }`, so anything else riding on a stored entry entered the deck model
untyped. Entries are now rebuilt field by field.

Files: `lib/filter.ts`, `lib/replay-config.ts`, `components/match/PlaybackControls.tsx`,
`lib/deck.ts`, `lib/storage.ts`, `lib/useDecks.ts`, `lib/decklist/buildDeck.ts`,
`lib/decklist/gauntletDecks.ts`, `lib/decklist/applySwapToDeck.ts`,
NEW `lib/printings/entryPrinting.ts`, NEW `components/DeckEntryPrinting.tsx`,
`views/DeckBuilderView.tsx`, `views/ProxiesView.tsx`, `styles.css` (own appended section).
Tests: `filter.test.ts` (+13), NEW `replay-transport.test.ts` (6),
NEW `printings/entryPrinting.test.ts` (24), NEW `storage.test.ts` (6),
NEW `deck-entry-names.test.ts` (11).

### 3.60 Which mana pays — spare the useful source, and let the player choose — ✅ done

Two reports, one subject: *"when I drag a spell out to cast, if there are multiple options for mana and
its going to auto-select for me, it should be choosing the least useful mana cards — like basic lands
for example. Right now it's like auto choosing mana-elfs when it could have chosen basic lands."* and
*"There should also be an easy way to make the game have you specify which mana to use when you
actually have unique options."*

**The defect was a missing rung, not a wrong one.** `planManaPayment` already ranked candidate taps
`distance → pain → restrictedRank → flexibility → size`, and for `Llanowar Elves` versus `Forest`
paying `{G}` every one of those ties: same colour, same size, one mode each. The ladder therefore fell
through to the engine's **enumeration order**, and the elf paid. Nothing in it knew that tapping a
Forest costs its controller nothing while tapping a creature costs a blocker.

**COLLATERAL UTILITY is the new rung** (`packages/core/src/mana-source-preference.ts`): what tapping a
source costs BEYOND the mana. A creature body (`creatureBody`, the dearest — an attacker this turn and
a blocker until it untaps), a printed `{T}` ability the tap would spend (`tapAbility`, cheaper because
it returns on the next untap), zero for a basic land. Both are named weights, and the price is read
off `CardInstance.def` — the face that is up and the card a copy is copying — so a permanent that is
not a creature **right now** is not charged for a body it does not have.

**⚠️ It is a named, DEFAULTED POLICY PARAMETER, not a behaviour change.** This planner is shared with
both AI pilots and the sim's seeded baselines are pinned byte-identical (engineering rule 7), so
changing the ranking for everyone would silently change how the AI plays in every measurement ever
recorded. `planManaPayment` therefore takes a `ManaSourcePreference`:

| preset | ladder | who uses it |
|---|---|---|
| `MANA_SOURCE_PREFERENCE_DEFAULT` | `distance → pain → restricted → flexibility → size` | **the default** — pilots, the engine's own auto-tap, everything that does not opt in |
| `SPARE_USEFUL_MANA_SOURCES` | `… → flexibility → **collateral** → size` | the hotseat + online **human** cast paths |
| `SPARE_USEFUL_MANA_SOURCES_FIRST` | `… → restricted → **collateral** → flexibility → size` | the measurement arm (see below) |

⚠️ Both human paths are PINNED, one per path. The hotseat pin (`mana-sources.test.ts`, "taps the
Forest, not the Llanowar Elves") shipped with the feature; the ONLINE pin
(`online/auto-tap.test.ts`, §3.60) was added at integration after an ablation found the online half
had none — the preference was wired into `castSequence` and nothing would have gone red if it
regressed. Both are sabotage-checked: replacing the path's preference with the engine default
reddens that path's test and only that one.

Both live placements sit strictly BELOW `pain` and `restrictedRank`: keeping a blocker must never
outrank "this tap does not kill me", nor strand a restricted mana that would otherwise go unspent.
The shipped human placement is the conservative one — it can only ever decide a tie the old ladder
decided by enumeration order, which is exactly the reported bug and nothing else.

The `better` comparison was rewritten from a flat disjunction (`d < bd || (d === bd && p < bp) || …`)
into a short-circuiting lexicographic chain. Same answer, **strictly fewer comparisons** (7 rather
than 15 in the all-tied case), and adding a rung no longer means re-stating every rung above it.
Collateral is priced ONCE per source at collection time into a scratch row, never inside the ranking
loop, and is `0` for every source under the default policy — where both of its branches are dead.

**📊 THE PILOT'S DEFAULT STAYS OFF, and that is the measurement's verdict, not an omission.**
`HeuristicWeights.spareUsefulManaSources` (default `false`) is the one-knob switch, threaded through
all nine `planManaPayment` call sites in `heuristic.ts` + `land-sequencing.ts` via
`manaPreferenceOf(weights)` — one policy per pilot, so the "would this land unlock that spell?" probe
can never be answered under a different policy from the payment that follows.

> **`runPilotAb`, spare-mana (A) vs shipped (B), nine sample decks, 36 pairs × 2 orientations ×
> 100 games = 7,200 games, seed 99:** **3535 – 3530** (135 draws) · matched slots **7 A-ahead /
> 4 B-ahead / 3,589 SPLIT of 3,600** · McNemar p = **0.55** (11 decided) · **VERDICT: INCONCLUSIVE**
> · 95.1 games/sec.

Every deck row lands within 0.2% of level. **3,589 of 3,600 matched slots are byte-identical play** —
the gauntlet meta simply does not present the tie often enough to matter, and when it does the game
does not turn on it. So the result *permits* the flip (it is neutral, not worse) and there is no
reason to take it: flipping a shared default would move **every recorded seed-99 baseline** — the
numbers say Mono-Green Ramp 566↔562 and UW Control 382↔379 — in exchange for +5 games in 7,065, which
is noise. Per §3.50's standing rule for `DEFAULT_PILOT_ID`, a shared default moves on evidence of a
gain, never on the theory that it ought to. **Recommendation: leave it off; revisit if the pool ever
grows a mana-creature-dense archetype.**

**⚠️ Recorded seed-99 gauntlet baselines: UNMOVED, byte-identical** — Mono-Red **257/800**,
Selesnya Blink **615/800**, UW Control **377/800**, Mono-Green Ramp **552/800** (the §3.50/§3.52 rows
exactly), which is what the defaulted parameter guarantees by construction.

Reproducibility: `SPARE_MANA_SOURCES_WEIGHTS` is exported from `@jonny-boi/ai` beside
`LAND_SEQUENCING_OFF_WEIGHTS` and `LEDGER_PRICING_OFF_WEIGHTS`, so both arms re-run in ONE process
any time. **Honest gap:** `SPARE_USEFUL_MANA_SOURCES_FIRST` (the promoted placement) is implemented
and unit-tested but NOT pilot-measured — the pilot does not adopt the preference at all, so there was
nothing to measure it against. It exists so the placement stays falsifiable rather than argued.

**THE PICKER — "let me choose my mana", and only when there is something to choose.** The heart of the
feature is the gate, so it is a pure, directly-tested core predicate rather than a UI heuristic:
`manaPaymentChoiceExists` plans the payment, then re-plans with each planned source excluded, and
answers `true` only when some alternative spends a **different multiset of CARDS**. Two untapped
Forests are not a decision (you lose a Forest either way) and it says so; `Forest + Forest` where a
Llanowar Elves could take one of the slots **is** two, and it says that too. Unpayable and
already-covered-by-the-pool both answer `false`, so a picker can never open with one button in it —
not even on an explicit per-cast request (`shouldAskForMana`'s hard gate).

The hotseat picker (`lib/play/mana-picker.ts` + `PlayBoard`) is a paused cast holding a **private
working `GameSession`**: taps fold into it, the board renders from it (so tapped lands, the pool
readout and the live `Still needed: {1}{G}` line all come off the one derivation a committed tap
uses), Confirm casts through `castWithAutoTap` — which taps nothing more, because the pool already
covers the cost — and **Cancel is `setManaPicker(null)`**. Dropping the working session IS the
rollback: it carries its own taps and its own §3.58 action-log entries away with it, so a cancelled
cast leaves no trace, no untap loop and no compensating action. Sources are clickable on the board or
in the prompt's list, whose rows follow the §3.57 owner conventions (`Forest (yours) — G`); a modal
source collapses to one "any colour" row that hands off to the existing which-colour prompt. Two ways
in: a persisted `Choose mana` toggle in the action bar (localStorage, default off) and a per-cast `⛁`
chip that appears **only** on a hand card whose cast has a genuine choice.

**📌 The ONLINE seat gets half of this, and the split is deliberate.** Its auto-tap plans under the
same `SPARE_USEFUL_MANA_SOURCES`, so an online player's elf is spared exactly as the hotseat's is.
The PICKER is hotseat-only: it wants a private working session to fold taps into and discard on
cancel, and the online seat has none — it holds a redacted view and every tap is a server round trip,
so cancelling there means un-tapping *through the server*, a different mechanism rather than a
re-render of this one. The gate when it is built is the same `manaPaymentChoiceExists`; a wrapper for
it is deliberately NOT parked in `auto-tap.ts` in the meantime, because an exported helper with no
caller is dead code wearing a green checkmark (the §3.52 rule, applied to my own work).

**Tests (47 new).** The literal report is pinned twice — in core (`Llanowar Elves` offered FIRST, the
shape that made the bug reachable, must tap the Forest) and end-to-end through the real pool and a
real `GameSession` (`mana-sources.test.ts`), where ablating the preference back to the default makes
it fail with "the Forest should have paid: expected false to be true". Plus: the byte-identity
contract (default policy still answers with the elf), the ordering rules (body dearer than `{T}`
ability; flexibility still outranks collateral), sparing is a preference and never a refusal, the
current-face/current-copy read, and nine cases on the choice predicate including the two-Forests
nag guard.

**📸 Proved in a real browser, not only in vitest.** `node apps/web/scripts/verify-mana-choice.mjs`
drives the BUILT app in headless Chrome through a real Mono-Green Ramp solo game — lands played, a
mana creature cast, no state poked — and asserts the two promises where they actually live:
**19/19 checks, exit 0.** With an Elvish Mystic and a Forest both untapped, the auto-tap *"spent a
Forest"* and *"did NOT spend the mana creature — it can still block"*; the `⛁` chip appeared on the
cast with a genuine choice and on 4 of 9 cards, not all of them; the picker read `Still needed:
{3}{G}` → `{3}` → `Fully paid — confirm to cast` as sources were clicked, with Confirm disabled until
the pool covered the cost; and **Cancel left every source untapped and the hand unchanged**.
Screenshots in `apps/web/verify-out/mana-choice/`.

**Files.** `packages/core` (NEW `mana-source-preference.ts` + test; `mana-plan.ts` the rung + the
predicate, `mana-plan.test.ts`, `index.ts` exports), `packages/ai` (NEW `mana-preference.ts`;
`weights.ts` one flag, `heuristic.ts` + `land-sequencing.ts` call sites, `index.ts` export),
`apps/web` (NEW `lib/play/mana-picker.ts` + `mana-choice-pref.ts` + `mana-picker.test.ts` +
`components/play/mana-picker.css`; `lib/play/session.ts` opts in + `manaChoiceForCast`,
`lib/online/auto-tap.ts` opts in (auto-tap only — no online picker, see above), `components/play/PlayBoard.tsx` the picker,
`lib/config.ts` + `lib/play/play-config.ts` named keys/knobs, `lib/play/mana-sources.test.ts`;
NEW `scripts/verify-mana-choice.mjs` — the browser harness, 19 checks), `eslint.config.js` (the
existing puppeteer-harness globals block gains the new harness + `Event`).
### 3.59 The blocking half of the combat-hint bug — ✅ done

Found by playing the SHIPPED build rather than a dev server: with §3.57 deployed, a Solo game at
Turn 2 declare-blockers, defending an attacking Goblin Guide with an empty battlefield, still read
*"Tap an attacker, then your creature, to block."* — copy naming a creature the player does not
have. It is the same defect §3.57 fixed one step earlier in combat, surviving because that fix
treated the attack branch as the bug rather than as one instance of a shape.

The rule now has one shape for both combat steps: **am I the seat DECLARING** (a defender who is not
in their own block window is merely responding, exactly as `isAttackWindow` already handled the
attacker's side) **and do I have anything to declare WITH** (else say so plainly). `HintContext`
gained `isBlockWindow` + `hasBlockers`; both boards feed them from state they already computed
(`inBlockStep` IS the window on both — hotseat derives it from priority + defender, online from the
server's `declareBlockers` template being offered at all).

The copy names the **"No blocks" button**, not "pass": both boards render that button for the whole
block step, including this case — which is why the old wording was actively misleading rather than
merely unhelpful. ⚠️ The tests pin the SYMMETRY, not just the two strings: one case asserts that with
nothing to declare, *neither* combat step ever tells a seat to use what it lacks, and that a
responding seat in *either* step gets response copy. A future edit to one branch cannot silently
re-open the other. Sabotage-checked: reverting the rule reddens exactly the three new behavioral
tests.
### 3.58 Games survive everything — state persistence, exact resume, and updates that wait their turn — ✅ done

The requirement, verbatim: *"I want the games to save off their state and when an update applies,
it should come in without breaking or interrupting things, and remember exactly what screen you
were on, where your view was on the screen, and what state the game was exactly in."*

**Persist the inputs, replay the game.** The engine is deterministic — the RNG cursor lives inside
`GameState` — so `createGame(seed, decks)` plus the ordered list of accepted actions rebuilds the
exact state, bit for bit. The persisted record (`apps/web/src/lib/play/persist.ts`, one versioned
localStorage key) is therefore the game's INPUTS: the RESOLVED decklists (a builder edit must not
rewrite history under a live game), the base seed, starting player, AI seat + pilot, the mulligan
transcript, `GameSession.actions`, and screen hints ({revealed viewer, scrollY, turn}). `GameState`
itself is never serialized — its card definitions are huge and its shape moves with every engine
feature, so a snapshot would eventually resurrect a game the rules disagree with. Restore replays
the record through the SAME calls the live view makes, and the suite pins the result down to the
serialized state snapshot, the RNG cursor, and every zone's instance ids — then drives live and
restored sessions 40 further pilot steps in lockstep to prove the restored game IS the game, not a
lookalike.

**Two flows live outside the action log, so they ride their own transcript.** A mulligan re-creates
the whole game from a derived seed, and a keep bottoms cards via `bottomCards` — a pre-game library
manipulation, not an action. The reshuffle-seed formula moved INTO persist.ts (`mulliganReseed`) and
PlayView now imports it: one formula, two callers, zero drift. `GameSession` grew the `actions` log
itself (appended only on ACCEPTED submits), which makes the auto-tap rollback correct for free — a
failed cast returns the pre-tap session, and the discarded taps carry their log entries away.

**Saves are debounced, flushed, and cleared.** Every committed change (action, mulligan step,
reveal, scroll) debounce-writes one record (250 ms, named in config.ts); pagehide/visibility-hidden
and surface unmount force-flush, so navigating away mid-game now SAVES the game instead of killing
it (the Play menu offers "Resume game" with a discard option). Game over, concede, discard and new
game clear the record. Storage is best-effort everywhere — quota, private mode, corrupt, oversized
or alien blobs all degrade to a clean fresh start (pinned by tests, including "never write what
decode would refuse").

**Updates wait their turn.** `main.tsx` no longer reloads on `controllerchange`. The PWA registers
with `registerType: 'prompt'` — REQUIRED, not stylistic: the 'autoUpdate' worker `skipWaiting()`s
itself on install, and once it controls the page it can purge the old build's lazy chunks out from
under the running app, so autoUpdate cannot defer safely. The whole policy is one pure function
(`lib/update/update-decision.ts`): no waiting build → nothing; waiting build + no live game → apply
NOW; waiting build + live game → show a small non-blocking pill ("Update ready — applies when this
game ends") and apply the moment the game is left. "Live" includes the end screen on purpose —
yanking the results away at the instant of victory is still an interruption — and the ONLINE surface
defers the same way (its reconnect flow is untouched; we simply never reload while it is mounted).
Before any update-triggered reload the coordinator (`lib/update/updater.ts`) force-flushes the
persisted game and writes a sessionStorage resume flag {view, scrollY}; the reloaded app returns to
that view, restores the viewport, and — for the Play view — auto-resumes the game with no menu stop.
The flag is written ONLY on the update path (pinned), so user navigation can never fake a restore,
and it is consumed once per load (StrictMode-safe memo) so tomorrow's launch starts normally.

**What resume deliberately does NOT promise.** (1) The AI's rng stream restarts on resume: the
restored STATE is exact, but the pilot's future tie-breaks may differ from the unreloaded
counterfactual — future choices are not part of "restore exactly". (2) One record slot: starting a
new game supersedes the saved one. (3) Online games are server-authoritative and out of scope for
state persistence (the update pill still defers during them). (4) A record that no longer replays —
a deleted imported card, an action an older rules build accepted — fails WHOLE with a reason and is
cleared; a partially replayed game would be a different game wearing the same clothes.

📊 Proven in a real browser, not only in vitest: `node apps/web/scripts/verify-game-resume.mjs`
(build first) drives the SHIPPING bundle in Chrome — real service worker, real reload, real
localStorage — and asserts 18 checks: a Solo game driven to a PARKED CHOICE (the cleanup discard
question), hard reload, resume via the menu banner → the rendered board text, the re-presented
question, and scrollY all EXACTLY equal; then a rebuild mid-game → the pill defers (page provably
not reloaded), leaving the game applies the update (bundle hash changes), returns to the Play view
with the flag consumed, and the game resumes exactly on the NEW build. Screenshots land in
`apps/web/verify-out/game-resume/`.

### 3.57 Play clarity — whose card is it, where is it, and what just happened — ✅ done

Four reports from one Solo session, all the same underlying complaint: the board KNOWS more than it
SAYS. All UI-side (`apps/web` only), all built on data the engine already carried.

**Owner + zone on every picker row (reports: Angel of Serenity, Acidic Slime).** Every candidate row
in every picker now says WHOSE it is — "yours" / "Computer’s", from the CHOOSER's perspective — and
WHERE it sits when that isn't obvious. The rules live in one pure module, `lib/play/option-labels.ts`:
`selectCards` rows read owner off the choice's own `CardOption.controller` and show the zone when the
candidate set SPANS zones (Angel of Serenity mixes battlefield + both graveyards; a single-zone list
leaves the zone to the requirement line that already says it); `selectTargets` rows read
`TargetOption.controller` (the old note printed the raw seat id — "(A)" — which is exactly what the
report complained about) and resolve zones through a `RefIndex` built ONLY from public zones + the
viewer's own hand, so an id the wire never sent degrades to `#id` and can never leak. The same index
annotates ability-target prompts and the online cast prompt's target sets; the hotseat cast prompt
labels through `describeCastTarget`. Both boards thread the same components — hotseat and online
render identical copy. ⚠️ The discipline to keep: labels are a pure function of the candidate
snapshot (or the public-zone index) — never resolve a label through anything that can see a hidden
zone.

**Jailed cards sit under their jailer (report: Banisher Priest / Angel of Serenity).** An exile with
`exiledUntilLeavesBy` (§3.56's core field) renders TUCKED under the jailer's battlefield tile, top
edge peeking out (art, chain-tag, hover to raise, click/right-click zooms via the shared
`CardZoomOverlay`). The grouping is pure and tested (`lib/play/jail-view.ts`): exile lists + links in
→ per-jailer stacks out; a link whose jailer is gone falls back to the plain exile count rather than
inventing a stack. Works on BOTH boards — the exile zones are public in the hotseat state and the
online masked view alike.

**Zone-change animations + blocker lines (report: "no animation... can't tell what is going on").**
A pure fold (`lib/play/animations.ts`, tested) turns freshly-appended session events into sprite
descriptors: `drawCard` → a card BACK flying library→hand for EITHER seat (a draw descriptor carries
NO identity — hidden info stays hidden even in flight); `zoneChange` library→graveyard → a mill,
hand→graveyard → a discard (face art — public by then); battlefield→graveyard/exile → a death ghost
fading/shrinking where the tile stood (positioned by rects captured the commit BEFORE removal, with
identities for ceased tokens remembered from the battlefield). `prefers-reduced-motion` derives
NOTHING at the source and the CSS kills transitions besides; every timing is a named knob in
`play-config.ts` (`ANIMATION_CONFIG`), and one batch is capped so a board wipe doesn't spawn twenty
ghosts. Blocker lines: an SVG overlay connects each blocker tile to the attacker it blocks — dashed
while the defender is still assigning, solid once declared, on both boards; WHICH lines exist is the
tested `blockerLinePairs` rule. Scope note, honestly: the ONLINE board draws the combat lines and the
jail stacks, but not the draw/mill/death sprites — frames carry pre-formatted log lines, not
`GameEvent`s, so the event fold has nothing to read there (future work: ship events in the frame).

**The no-attackers hint (report 4).** The declare-attackers hint promised "or attack with none" while
the only button on screen was "Pass priority" — the engine offers no declare-attackers action for a
seat with no eligible attackers. The per-step hint is now ONE tested rule for both boards
(`lib/play/action-hints.ts`): the active player with an absent/empty attack template reads "You have
no attackers — pass to continue."; a defender holding priority in the same step reads the response
copy, not attack copy.

### 3.55 Two identical Acidic Slimes in the card library — ✅ done

Reported directly: the Cards browser showed the same card twice. The static data
is clean — 587 cards, no duplicate name or id in the bundled index or the merged
engine pool (both checked) — so the second Slime lives in the PERSISTED
imported-card store as a different PRINTING: same name, different Scryfall id.

**An id names a printing, not a card.** Every display join is by Scryfall id,
and the store legitimately acquires a second printing of a curated card two
ways: "+ Add card" resolves through Scryfall's FUZZY endpoint, which returns
Scryfall's default printing — almost never the printing the pool ships — so the
by-id "already known?" check waved it in as new (reproducible today); and a deck
imported before its cards joined the curated pool keeps whatever printing was
fetched then, which collides the day the pool absorbs the card (the pool has
been growing by hundreds of compiled cards).

Fixed at both ends, deliberately WITHOUT touching the store:
`allAvailableCards()` dedupes by normalized name with the curated record winning
— the store entry survives because a saved deck may reference the imported
printing's id and `getCard` must keep resolving it, or that deck goes blank; and
`addCardByName` now answers `alreadyKnown` by id OR by name (new
`getCardByName` in `lib/cards.ts`), returning the record we already have.
Side benefit: `copyGauntletDeck`'s by-name index previously let an imported
printing shadow the curated record; the curated printing now wins
deterministically.

Pinned by `apps/web/src/lib/duplicate-printings.test.ts` (one row per name, the
curated id wins, the imported id still resolves, novel imports still appear) and
a new addSingleCard case adding a different printing of Lightning Bolt.
⚠️ Trap for the next agent: never name a test fixture after a real card. The
addSingleCard fixture was 'Grizzly Bears', which is now a REAL pool card — the
moment the pool absorbed it, the "adds a new card" test started (correctly)
answering `alreadyKnown`. It is 'Grizzled Test Bears' now.
### 3.56 Two silent no-ops: the jail link the clone dropped, and the search OR that intersected — ✅ done

Two user-reported Solo bugs, both "the card consented and then nothing happened", both engine-real and
reproduced end to end before fixing.

**The jail link died in the clone.** Angel of Serenity jailed two creatures; a Closet blink removed and
returned the Angel; the release trigger fired — and freed nothing. `exiledUntilLeavesBy` was an ad-hoc
property the cards package wrote onto instances, and core's pure `applyAction` path deep-clones state
through `cloneInstance`'s FIXED field list: the link survived exactly one action and vanished on the
next clone. It is now a real `CardInstance` field, cloned beside `timesKicked`/`chosenAsEntered`.

⚠️ **The class is guarded, not just the case.** `clone-completeness.test.ts` builds an instance with
EVERY optional field populated and requires an action-path clone to round-trip the full own-key set —
add a per-object field without teaching the clone and it goes red before any card misbehaves.

**The search OR that was an AND.** Gatecreeper Vine's "search for a basic land card OR a Gate card"
was encoded as a Gate-subtype filter INTERSECTED with a basic-name list — the empty set. Zero
candidates meant the picker auto-answered an empty selection ("only one legal answer"), so the user
said yes to searching and the search silently found nothing. §3.38's claim that the primitive "unions
a name list with a filter" was never true; Path to Exile only worked because basics ⊂ lands.
`CardFilter` now carries `anyOf` — a real disjunction, evaluated as one more AND clause so sibling
fields still constrain — and the rule emits `{ anyOf: [basic land, gate] }`. Pinned end to end:
consent → picker with real candidates → the fetched card in hand; and negatively: Temple Garden
(nonbasic, non-Gate, land types galore) is NOT offered.

**Banisher Priest's "didn't exile":** the engine was correct — with no legal target the trigger leaves
the stack by rule (CR 603.3d), silently. The fix is VISIBILITY: the game log now prints
"<label> — nothing happens (no legal target …)" so a rules-correct fizzle stops reading as a bug.

**And one census lesson about seeds.** `token-count-replacement` became must-witness the moment
Doubling Season entered — and its witness is an ORDERED TWO-CAST SEQUENCE (resolve a five-drop, then
resolve any token spell), which the default six anchored attempts fire on one committed base seed and
miss on the other, both runs fully deterministic. The remedy is not a bigger global knob:
`SoakMechanic.extraAnchorAttempts` runs overtime attempts ONLY for a still-unfired mechanic that
declares them, on a SALTED SEED LANE — so opting in cannot re-roll any other mechanic's already-green
witness, and a healthy lane pays for none of them (the loop stops at first fire). Probed healthy at
28 fires across 20 anchored games before wiring.

**The refresh's guards then caught two more real things.** (1) Kiki-Jiki exposed OFFERED-ACTIVATION
BLINDNESS: §3.40's partition (land-fetch / loyalty / Equip / funded-by-tapping) owned every activation
shape EXCEPT a tap-cost value ability the engine offers outright — the pilot never activated Kiki
once, and the soak's inert-mechanic guard reported `delayed-trigger` dead the day the card entered
the pool. `bestOfferedActivation` closes the hole with the same `valueOfEffects` ruler, aimed by the
engine's own enumerated targets; pinned by `kiki-offered-activation.test.ts` (the engine offers it,
the pilot takes it). (2) Helm of the Host is the pool's first attachment with NO modification line, so
the attachment census gained a first-class PURE_TRIGGER shape — asserting the modification is ABSENT
(a phantom +0/+0 would hide a compiler regression) and the printed trigger present — and the coverage
sweep now unions both tables. The new `exiledUntilLeavesBy` field is classified in the instance-id
vocabulary, so the leak scanner walks it.

📊 Regenerating the pool under current templates brought in 18 cards that now compile (Doubling
Season, Kiki-Jiki, Naturalize, Momentary Blink, …) — the pipeline working as designed; pool 555 → 573,
gated by the same suite as always.

### 3.54 Native image-drag ate the game — ✅ done

Bug reports 20260827_205353 and _205443, five days after §3.51 shipped full-card
faces: "I still cant drag and release cards onto the battlefield" and "I cant
play lands by click on them in my hand anymore either - so theres literally no
way to advance."

**One cause, both symptoms.** §3.51 filled each hand card with an <img>, and an
image is natively draggable by default. Press a card and move a few pixels — the
natural motion of someone who has been TRYING to drag — and the browser starts
its own image ghost-drag: the pointer stream gets pointercancel (our drag
machine never commits) and the mouseup is swallowed (the click never fires). The
reporter's clip is unambiguous: three mousedowns on a hand card, zero mouseups,
zero clicks — against a working control click on a button seconds earlier.

⚠️ **Synthetic pointer tests cannot catch this class.** Dispatched PointerEvents
never start a native drag, which is why every drag test stayed green while real
mice failed. The pin is STRUCTURAL instead (no-native-drag.test.ts): render the
real PlayCard both ways through renderToStaticMarkup and require
draggable="false" on every <img> it emits. Sabotage-checked red/green.

Fix: draggable={false} on both card images, user-drag/user-select CSS guards,
and onDragStart preventDefault on all three hand containers (PlayBoard,
OnlineBoard, MulliganScreen) as belt-and-braces.

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
- ✅ *the mana model grew four of its five shapes* — the largest engine lever the census found, and
  it had been mis-filed as cheap template data. Core used to model a mana source as a fixed list of
  colour bundles: one tap, no stack, no cost beyond the tap, no rider, no condition. It now carries
  `CardDefinition.manaAbilities` — a list of separately-printed abilities, each with its own
  **additional cost** (`{T}, Pay 1 life:` — Mana Confluence, the horizon lands; the filter lands'
  hybrid `{W/U}, {T}:`), **rider** (every pain land and Ancient Tomb: the damage happens as part of
  the ability's own resolution, is NOT a cost, and so the land still works at 1 life and can kill
  you), **activation restriction** ("Activate only if you control an Island / a red permanent /
  three or more artifacts" — Nimbus Maze, the Verge cycle, Mox Opal), and **board-derived colours**
  (Reflecting Pool's "any type", Exotic Orchard's "any color", which differ by that one printed
  word). Four properties make it faithful rather than approximately right:
  - **It is not an activated ability.** A mana ability does not use the stack (CR 605.3a) and is
    asked during payment planning; expressing one as an `ActivatedAbility` that adds mana would make
    a pain land respondable and would deliver its mana one stack resolution too late to fund
    anything.
  - **The restriction gates the OFFER, not the apply.** An unmet "Activate only if…" makes the mode
    invisible to `generateLegalActions` and therefore to `planManaPayment` — a planner that counts a
    source it cannot use funds spells that cannot be cast. `manaModeBlockedReason` is the single
    answer both paths ask.
  - **Derived colours are recomputed per query, never stored.** The mode LIST is fixed (six entries,
    so `TapForManaAction.mode` means the same thing to the generator, the planner and the apply
    path); which of them is *available* is a function of the live board. A derived source
    contributes nothing to another's derivation, so two Reflecting Pools read each other as empty
    rather than looping.
  - **The hot path pays one property read.** `manaExtrasOf` returns `undefined` for every plain land
    and rock, and `planManaPayment` — the engine's hottest function, deliberately built on dense
    `Int32Array` buffers — keeps its cost/rider apparatus behind two `anyTapCost`/`anyTapPain` flags
    that stay false on an ordinary board. The planner also now prefers the painless source when two
    taps close the same shortfall, and refuses to plan a payment that kills its own controller.
  **Measured PAIRED against the same cached corpus on the same day's `main`: 328 → 384 of 2100
  (15.6% → 18.3%), +56 cards.** (Against the 229 baseline the brief was written from, the same +56.)
- ✅ ***the fifth mana shape: a SPEND RESTRICTION on produced mana*.** The other four shapes
  decorate the SOURCE; this one colours the MANA, and that is the whole of why it needed a different
  design. `ManaPool` was `Record<ManaColor, number>`, so a restricted mana became indistinguishable
  from an unrestricted one the moment it landed in the pool. **The pool carries it now**, and
  `canPay`, `payCost`, the payment planner, the event log, the debug snapshot, the masked protocol
  view and the AI all honour it. `ManaAbility.spendRestriction` is DATA — a disjunction of clauses
  over the object being paid for (purpose, types, subtypes, colour/colourless, legendary) — so no
  card has a branch, and "cast artifact spells **or** activate abilities of artifacts" is two
  clauses rather than a Power Depot case.
  **Measured on the cached 2100-card corpus against the matched `origin/main` (a6419e5): 510 → 516
  playable, +6 cards, 0 regressions, and the 15-card "spend restriction" gap is gone** — dissolved
  into six newly playable cards (Ancient Ziggurat, Somberwald Sage, Eldrazi Temple, Maelstrom of the
  Spirit Dragon, Unclaimed Territory, Secluded Courtyard) and three precisely-named residuals, each
  of which is a different system.
  Five properties make it faithful rather than approximately right:
  - **It is a SUBTRACTION, not a matching problem.** One `payCost` call funds ONE thing, so every
    pip in it shares the same purpose and each mana is either usable for the whole payment or for
    none of it. Hide what this purpose may not touch, run the existing algorithm on the rest: linear
    in the number of restricted parcels, no search, and — because it is the same algorithm — no
    second opinion about what a hybrid symbol or a generic pip costs.
  - **`purpose === undefined` means NO.** A caller that asks "can this pool pay {2}{G}?" without
    saying what for cannot be told yes about restricted mana. A forgotten purpose therefore produces
    a PESSIMISTIC answer (a cast the engine could have offered), never an ILLEGAL one — which is the
    failure that would poison a verdict. It is also why a "unless its controller pays {3}" tax
    cannot be paid with Ancient Ziggurat mana, correctly and with no special case.
  - **Mana you cannot spend is still mana.** `pool[color]` stays the TOTAL, restricted included, so
    `poolTotal`, the seat panel, the replay format and the end-of-step empty are unchanged and still
    true — a restriction changes legality, not quantity. Restricted mana that can never be spent
    drains at end of step with its `manaPoolEmptied` event, and never earlier.
  - **The hot path pays one property read.** `restricted` is ABSENT on every pool in a game with no
    restricted source, and `canPay` / `payCost` / the planner each short-circuit on that `undefined`
    before doing anything else. The planner takes the card DEFINITION and resolves the purpose
    LAZILY — gating it on the live pool was a real bug caught by the pilot tests, because at
    planning time the pool is empty and the restricted mana does not exist yet, so the planner
    refused to tap Ancient Ziggurat at all and a castable creature read as uncastable.
  - **"…of the chosen type" reads the PERMANENT, and reads it once.** Cavern of Souls, Unclaimed
    Territory and Secluded Courtyard name a creature type as they enter, which core's as-enters seam
    already stores on the instance (`CardInstance.chosenAsEntered`) — so this branch reads that value
    rather than tracking a second copy of the same answer. The clause on the shared definition is a
    DECLARATION (`subtypeChosenBySource`); the value is substituted when the mana is MADE, which is
    the only moment both the source and its choice are in hand. The pool therefore only ever holds
    CONCRETE restrictions, no payment path has to find a permanent, and clone/serialization stay
    unchanged. A permanent that named NOTHING makes mana that pays for nothing — never for
    everything, which is the direction that would hand it the best mana on the board. The compiler
    refuses the clause outright on a card whose text never names a type, because mana that can never
    be spent is as much a lie as mana that pays for anything.
  - **Restricted mana is spent FIRST.** It is the least flexible resource on the board, and the
    planner's existing "least flexible source first" ordering could not see it (Ancient Ziggurat
    offers five colours, so `flexibility` ranked it LAST). A `restrictedRank` term joins that same
    ordering — below `pain`, because "least flexible" must never outrank "does not kill me" — and
    `payCost` drains restricted parcels first within a colour and prefers colours holding them when
    paying the generic portion.
  **A restriction on public mana is PUBLIC.** Mana in a pool is open information in this engine
  (`sim/observation.ts`), and the restriction was printed on a permanent every seat can read, so it
  travels on the `manaAdded` event and in the masked protocol view. Redacting it would be the worse
  error: an opponent watching mana float off an Ancient Ziggurat and unable to see the restriction
  would read the board as represented interaction that is not there.
  📌 **KNOWN REACH LIMIT, pinned in the planner's comments:** a plan will not chain a restricted
  source into ANOTHER source's mana cost (Power Depot's "activate abilities of artifacts" mana
  paying for an artifact filter land). Same shape as the filter-land reach limit already recorded
  above, and it can only ever decline a payment, never make an illegal one.
  ⛔ **NOT shipped, and reported by name rather than faked: the COMMANDER.** "Add one mana of any
  color in your commander's color identity" (Command Tower, Arcane Signet) needs a commander, a
  command zone holding one, and a format that has both. This engine has none of them, and a fake
  commander — any seat's "best" card, or a colour identity guessed from the decklist — would
  silently set those two cards' output in every game the lab plays, corrupting exactly the A/B
  verdicts they appear in. The general seam it would need ("colours derived from a named object the
  engine tracks") is deliberately NOT built either: with one hypothetical consumer it would be a
  guess at an interface, and the six cards previously grouped with it turned out to need something
  else entirely (a tapped-for-mana trigger), which is now reported under its own name.

Still open, roughly by how often they block a real decklist:
- *aiming a trigger body at the player whose step or turn it is* ("At the beginning of each player's
  draw step, **that player** draws an additional card" — Howling Mine, Kami of the Crescent Moon,
  Font of Mythos). The trigger itself is expressible (`who: 'any'`); what is missing is the
  triggering player riding the resolution the way `xValue` and `kicked` do, so a body can say "that
  player" rather than "the controller",
- *two smaller mana gaps that are cost/vocabulary rather than system*: a mana-ability cost that
  **taps another permanent** (Springleaf Drum — a third cost component AND a choice of which
  permanent, which nothing asks), and a spend restriction naming a creature type **chosen as the
  permanent enters** (Cavern of Souls, Secluded Courtyard, Unclaimed Territory — the restriction
  itself works now; what is missing is a per-INSTANCE remembered choice).
- *a spell that **cannot be countered*** ("…and that spell can't be countered" — Cavern of Souls and
  Delighted Halfling print it after a spend restriction, and 15 more print it on the spell itself).
  Counterspells are real in this engine, so the clause is not vacuous and is never dropped.
- *the two colour-derivation families this engine has no object for*, now reported separately
  because they are not the same work: a **commander's colour identity** (Command Tower, Arcane
  Signet) needs a format this engine does not implement and will not fake — see below — while
  **"add one mana of any type that land produced"** (Mirari's Wake, Zendikar Resurgent, Vorinclex,
  Kinnan, Extraplanar Lens, Incubation Druid) is an ordinary triggered ability watching a permanent
  being tapped for mana, and is engine work somebody can simply do.
- *the payment planner cannot CHAIN into a filter land inside one plan.* The mana half of a mana
  ability's cost is gated on the FLOATING pool, exactly as `unpayableActivationReason` gates every
  other activated ability, so a filter land is offered once its input is floating and not before —
  which never offers an illegal action, and is how the land is played in paper (tap the funding
  source, then filter). What is lost is only the planner's ability to SEE that line while answering
  "can I afford this?" from an empty pool. Pinned as a KNOWN REACH LIMIT test rather than left to be
  rediscovered.
- *alternative and additional costs still open* — **cycling, buyback and madness landed in §3.17**;
  what remains is *suspend*, *spectacle*, *evoke*, an **{X} in a cycling cost** (Shark Typhoon: an
  activation cost has no answer-and-charge step the way a casting cost does) and a **madness cost
  printed in words** ("Madness—Pay six {C}"). *Phyrexian costs*,
  *fuse* (CR 702.102 — **split, aftermath, adventure and the Siege reward all landed in §3.22**;
  what is left of that family is casting BOTH halves as one spell, and the Room/door system CR 714),
  *flashback riders that are not mana or life* ("Flashback—{1}{U}, Discard a card" — the cast
  pipeline can charge mana and life, and nothing else, so a discard or sacrifice rider reports),
  *P/T formulas outside the closed count vocabulary* (a star box counting something the
  `DerivedCountName` table does not name, or whose two halves count different things, still
  reports — it is never guessed),
  *damage divided among targets* ("deals X damage divided as you choose among any number of
  targets" — needs a division the targeting layer cannot express: one spell, several targets, each
  with its own share).
- ✅ *the "At the beginning of…" family* — **§3.21**. The audit's biggest template cluster, and its
  blocker was an engine seam rather than a rule table: a trigger's resolution did not carry the
  player its event was about, so every printed "that player" had nothing to point at and every
  "each player's / each opponent's" scope reported. `EffectContext.triggeringPlayer` closes it, and
  the printed **intervening "if"** (CR 603.4, checked at both of the moments the rules check it)
  landed with it. 408 → 428 playable. What still reports is named in §3.21.
- ✅ *counters-matter templates* — the census (docs/plans/mechanic-completion-plan.md §3c) measured
  **117 counters templates blocking 153 cards while the counters machinery was already complete**:
  `CardInstance.counters`, the layer-7d stat pipeline, and the `addCounters` primitive all worked;
  no printed template could reach them. Closed as rule-table data plus five small seam extensions:
  the **group form** of `addCounters` (`each` + a controller `scope` + the shared `CardFilter`, so
  "put a +1/+1 counter on each creature you control" counts exactly the printed set and a phrase the
  filter cannot express — "each **attacking** creature" — rejects the line instead of widening it);
  three new **trigger conditions** (`beginCombat`, `gainLife`, `combatDamageToPlayer`); cast triggers
  with `who` = any/opponent; and `StaticAffects.hasCounterKind`, the one non-printed characteristic a
  static filter may read (counters are instance state no static can change, so there is no
  layer-dependency loop). The two BOARD-WATCHING conditions this family needed — an arrival and a
  death — are `permanentEnters` / `permanentDies`, the names §3.17's you-may/trigger work introduced;
  both branches invented their own names for them and they were **unified to one name per concept at
  merge time**, with this branch's capabilities kept under those names: `excludeSelf` (the printed
  word "another"), a colour word in the `permanentFilter`, an absent controller tail meaning
  `who: 'any'` (Soul Warden), the landfall/constellation ability-word dresses, and the
  "~ or another creature dies" phrasing. `packages/cards/src/counters-templates.test.ts` plays one
  game in which a card from each branch watches the same event and asserts both fire, so a re-split
  of the vocabulary goes red. It also uncovered a real defect: **"~ enters with N +1/+1 counters on it"
  put on no counters at all** — they are applied as the permanent enters (CR 614.1c), while its own
  spell is resolving and before the instance reaches the battlefield, and the primitive only looked
  at the battlefield — so every 0/0 body printed that way (Stonecoil Serpent, Walking Ballista) died
  on arrival. Measured on the cached 2100-card corpus: **193 → 217 playable** against the census baseline this
  branch started from, and **328 → 352 (15.6% → 16.8%)** re-measured against `origin/main` (364a4f1) after
  merging the siblings that landed meanwhile — the counters family itself going from 116 variants /
  180 card-blocks / 46 sole to 106 / 146 / 38.
  ⚠️ Still reported, by name: phasing (Slip Out the Back), doubling counters,
  proliferate (needs a chooser over every permanent and player with a counter), counter kinds the
  stat layer does not read (charge/quest/time/growth/keyword counters), "each **attacking** creature",
  "**nontoken**" filters (instances carry no token flag), once-per-turn trigger limiters, granting a
  triggered ability until end of turn, and counter-removal activation costs (`ActivationCost` has no
  counter component).
- ✅ *the tutor family + mandatory additional cast costs* — the two halves of "pay something to go
  get something", closed together because the cards that print them are the same cards
  (Diabolic Intent, Harrow, Eldritch Evolution all print both).
  **THE TUTORS.** One primitive (`searchLibrary`) already read a library; what it lacked was
  destinations and rule-table entries. It now takes a found card to **hand, the battlefield (tapped
  or not) or the graveyard** through one closed `SEARCH_DESTINATIONS` table, and the rules reach it
  for: the unrestricted tutor ("for a card"), any card TYPE, a **type/subtype union** ("an instant or
  sorcery card"), a **colour** ("a blue instant card" — `CardFilter.anyOfColors`), the printed
  mana-value/power/toughness bounds, a **land-type list of any length** (Farseek prints four, and
  because it omits the word "basic" it finds a DUAL — the rule that reads it is deliberately separate
  from the one that reads "a **basic** Swamp, Forest, or Island card", which selects the basics BY
  NAME), and **"up to N"** counts.
  The interesting one is the **MULTI-DESTINATION search** — Cultivate's "put one onto the battlefield
  tapped **and the other into your hand**". It compiles to a `route` param: an ordered list of steps,
  one per card the search may find, and **the answer's ORDER is the routing**. That is not a
  shortcut; it means the decision is answered by the same `selectCards` a UI, an AI and a network
  peer already know, instead of a second bespoke question — and a library holding fewer matches than
  steps simply leaves the trailing steps unused, because "up to two" is a maximum and a search may
  always fail to find. Both are played in real games in
  `packages/cards/src/tutors-and-additional-costs.test.ts`, including the zero-match case.
  **THE ADDITIONAL COST.** `CardDefinition.additionalCost` — "As an additional cost to cast this
  spell, sacrifice a creature / discard a card" — and the reason it is NOT another `kicker` is the
  whole feature: **an optional cost may be declined, so a caster who cannot pay it casts the spell
  without it; this one cannot.** CR 601.2h makes an unpayable cost an ILLEGAL CAST, so a Village Rites
  with an empty board is **not offered by `generateLegalActions` and is rejected by the cast path**,
  from the ONE shared `unpayableAdditionalCostReason` — three opinions about "can this be paid" is
  exactly how a spell becomes offerable and un-castable. Treating it as declinable would have printed
  a free two-card draw.
  It rides the EXISTING cast-question pipeline (`askCostChoices`, after X → kicker → multikicker →
  buyback, which is the printed announcement order), the payment is performed by the engine as the
  answer is accepted — through the SAME `moveToZone` funnel every other sacrifice and discard uses,
  which is why **discarding a madness card to pay for Thrill of Possibility exiles it** rather than
  burying it — and the answer rides the stack object as `additionalCostPaid` (a new
  `internal/clone.ts` field; without it the question re-asks and the caster pays twice).
  🧠 **The AI is not inert.** A tutor answered on raw card value alone fetches the deck's biggest bomb
  on turn two and sits on it — noise in every A/B verdict, which is the one thing a search must not
  be. `packages/ai/src/choices.ts` now discounts a searched card the pilot could not cast within
  `tutorReachableManaLead` of its current lands by `tutorUncastablePenalty` — a DISCOUNT, not a ban,
  so an unreachable card is still fetched when it is the only thing that qualifies. Paying a cost is
  the same one ranking read from the other end: the pilot gives up its WORST qualifying permanent.
  **Measured** on the cached 2100-card corpus, same-day `origin/main` baseline: **408 → 446 / 2100
  playable (19.4% → 21.2%)**.
  ⚠️ Still reported, by name: a search whose restriction no `CardFilter` can say (**"a nonlegendary
  card"** — there is no supertype field; **"with mana value X or less"** — X is a cast-time value no
  filter reads, which is what blocks Green Sun's Zenith and Chord of Calling; "an artifact card with a
  mana ability"), a **union mixing a type with a subtype** (the filter would AND them, so it could
  never find, and mixing is refused rather than guessed), a destination outside the closed table
  ("shuffle and **put that card on top**" — Sterling Grove), a **rider on the find** ("then if you
  control four or more lands, untap that land" — Fabled Passage), a **derived count**
  ("up to X basic lands, where X is the number of tapped creatures you control" — Harvest Season),
  and, on the cost side, an additional cost that is a **choice of payments** ("sacrifice an artifact
  **or** discard a card", "discard a card **or** pay 3 life"), an **optional** one ("you may sacrifice
  one or more creatures"), a cost the engine cannot perform (exile, pay life), and any value
  **derived from what was sacrificed** (Fling, Life's Legacy, Eldritch Evolution, Neoform).
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

**Defects found by RUNNING it, each now pinned by a test in `capture-policy.test.ts`:**
- Rasterising `document.body` captures the whole SCROLLABLE page while the reporter draws in VIEWPORT
  coordinates, so every stroke lands somewhere else. Fixed by sizing the raster to the viewport and
  translating the clone by the scroll offset. (Lightwalker's port hit the identical bug for the
  equivalent reason — a framebuffer bigger than the window.)
- The frame and the ink canvas were each fitted with `object-fit: contain`, so the canvas ELEMENT
  filled the stage while its BITMAP was letterboxed inside it — every stroke scaled and offset. They
  now share one aspect-ratio box; the harness asserts `scaleX === scaleY`.
- **The capture took 8–11 seconds on the two views people actually use.** The cost is not images and
  not CSS: the rasteriser serialises the cloned DOM into an intermediate SVG, and on the Deck Builder
  that string is **41 MB**. Nearly all of it is scrolled off the bottom. The capture now drops the
  trailing run of children that renders below the fold — per parent, because the Deck Builder's long
  grid is followed in DOM order by a short side panel, which defeated a document-wide version.
  **Deck Builder 10.4 s → 0.8 s, Cards 7.3 s → 0.8 s**, with the two images compared pixel for pixel.
- **That pruning then ate the sort dropdown's label.** `<option>` elements have no bounding box, and
  the first rule dropped everything after the last *measurable* child — so the capture came back with
  a blank box where "Name" should be. "Cannot anchor the run" and "may be pruned" are different
  properties: the reporter's own launcher is `position: fixed` at the bottom of the viewport and is
  the last node in the body, and while it anchored, nothing anywhere was pruned. Both regressions are
  now unit tests.

**The rolling clip — what happened in the seconds BEFORE `b` was pressed.** The two games read their
framebuffer ten times a second into a ring and dump the last N seconds as video. A browser cannot:
rasterising the DOM costs ~0.8 s a frame even optimised, and `getDisplayMedia` is a permission prompt
Android Chrome does not implement — so on the phone this app actually ships on, screen recording is
not available at all. The clip is therefore a **DOM session recording** (rrweb), always on from app
load, and the report carries `replay.html`: one self-contained page, player inlined, that plays those
seconds back with a scrubber and fetches nothing. For a bug report that is better than video — the
replay carries the real DOM, so text is selectable and layout is inspectable. `clip.json` ships beside
it so the events survive even if the player does not.

The ring keeps whole CHUNKS, never a sliced window: a replay can only start from a full snapshot, so
"the last 30 seconds" rounds outward to the snapshot boundary (a floor, never a ceiling). Recording
stops the instant the reporter opens, so the clip ends where the bug is and never contains the
overlay's own frozen frame. The submit-time stepper dials it to zero — the games' rule, kept.

**That clip is what forced the archive to compress.** A full rrweb snapshot of a 95-node page is 3 MB,
because it carries every inline style and the whole stylesheet; the first bundle with a clip in it was
**15.7 MB**, which is a report a phone will not upload. The ZIP writer now deflates the text entries
through the browser's own `CompressionStream` (raw deflate, method 8) and leaves already-compressed
images alone: **clip.json 6020 KB → 189 KB, replay.html 6503 KB → 294 KB, the bundle 15.7 MB → 3.7 MB.**
The harness inflates what it reads back, so the compressed archive is proven readable, not assumed.

**How the picture itself is verified — `npm run verify:reporter -w @jonny-boi/web`.** No unit test can
check a third-party rasteriser's pixels, and the in-app browser pane cannot either: in a backgrounded
tab `toPng` never resolves at all, even for one header element. So the harness drives the SHIPPING
bundle in the Chrome already installed on the machine (puppeteer-core, no browser download): it opens
the reporter on the worst-case view, and asserts the frame is a real PNG the size of the viewport with
thousands of distinct colours, that a dragged stroke lands within a couple of pixels of the pointer,
and that the submitted zip contains what `report.md` says it does. It writes `frame.png` and
`annotated.png` so a human can LOOK. `--view <label>` picks a view; `--fidelity` additionally captures
with and without pruning and compares every pixel — the check that caught the `<option>` defect, where
the delta was 207 against an anti-aliasing floor of 7.

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

### 3.20 The pool a player can actually SEE — every shipped mechanic represented — ✅ done
Sixteen engine systems shipped in two days and the built-in card pool printed almost none of them: no
card with flashback, {X}, kicker, scry, surveil, mill, protection or ward, and exactly one
planeswalker. Every one of those systems was reachable only by importing a decklist — which is
another way of saying a player using the app as shipped could not see the work at all. That is the
rule this section closes: **a feature nobody can see is not done.**

The pool is **191 → 309 cards**, and the growth is a DATA edit, not an engine change: names go into
`packages/cards/data/expansion-candidates.json`, `scripts/build-expansion.ts --fetch` resolves them
against Scryfall, and the second (offline) pass admits only the ones the Oracle compiler reports
`'complete'`. Nothing was hand-authored to fill a gap, because a hand-authored card would have to
match the compiler anyway — `fidelity.test.ts` re-derives every pool card from its printed text.

What the pool now shows, per mechanic: **scry** (Opt, Preordain, Serum Visions, ten Theros temples,
Castle Vantress, Zhalfirin Void), **surveil** (Consider, Notion Rain, the ten Ravnica surveil lands),
**mill** (Tome Scour, Glimpse the Unthinkable), **printed flashback** (21 cards — Think Twice,
Firebolt, Lingering Souls, Call of the Herd — including Devil's Play, whose flashback cost prints
its own {X}), **{X}** (Blaze, Mind Spring, Condescend, Death Grasp), **kicker** (Firebending Lesson,
Tolarian Geyser), **modal spells** (15, the charm cycle), **protection** (the knights: White, Black,
Silver, Blood, Paladin en-Vec, Mirran Crusader), **ward** (Tomakul Honor Guard, Waterfall Aerialist,
Archive Dragon), **+1/+1 counters** (Sprite Dragon, Electrostatic Infantry, Unspeakable Symbol), and
a **second planeswalker** (Samut, Tyrant Smasher — the only other walker in all of Magic whose every
printed line compiles today).

`packages/cards/src/pool-mechanics.test.ts` is the guard: an executable inventory that FAILS when a
mechanic loses its last card, plus a real seeded game per mechanic proving the card plays it (Firebolt
is recast from the graveyard and then exiled; Blaze deals the X that was paid; Abrade's mode is chosen
at cast; Path to Exile cannot be aimed at Black Knight; ward taxes the caster and counters the spell
when they decline).

**Six systems still have no honest card, each with a measured reason** (every printed card carrying the
mechanic was compiled; the accept count is zero): **multikicker** (0/19 — every one spends the kick
COUNT, a derived value with no template), **emblems** (0/90 — the wrapper compiles, no emblem BODY
does), **modal DFCs** (0/100 — the land face's "enters tapped unless you pay 3 life" has no
template), **battles** (0/36 — Sieges are cast by a path the engine lacks), **indestructible** and
**alternative costs** (both still in flight). They are listed in the test with their reasons and
asserted ABSENT, so the day one becomes representable the suite says so.

Two defects fell out of actually playing the new cards, which is the point of the exercise:
- **`addCounters` threw on every real permanent.** It wrote into `CardInstance.counters` in place, and
  that record is the shared FROZEN `NO_COUNTERS` object for anything with no counters — so the first
  +1/+1 counter on a permanent the ENGINE created died with "object is not extensible". Nine counter
  tests were green because they all built their instances by hand (each with its own `{}`). No pool
  card had ever put a counter on an engine-created permanent.
- **The fidelity audit kept its own copy of core's target-restriction list**, which had gone stale:
  it failed "Destroy target artifact" for declaring `'artifact'`, a restriction core has enforced
  since the attachment work. It now asks core's own `isTargetRestriction`.

The corpus measurement is stated for honesty, because this section did not move it: the pool grew by
using rules the compiler already had. Measured on the same cached corpus, it was **229 / 2100 (10.9%)**
when this branch started and is **307 / 2100 (14.6%)** after merging §3.17's indestructible work and
the you-may/trigger templates — all of that is compiler width, none of it is this section. This section
widened what the SHIPPED POOL shows; widening the compiler is §3.11's backlog.

Each sibling branch that landed while this one was out widened the pool again on the same one-line
rule — names in, `'complete'` verdicts out. §3.17 gave indestructible its cards (the Darksteel family
and the ten artifact Bridges, pool 309 → 331); §3.19 gave the alternative costs theirs (the cycling
lands, Fiery Temper's madness, Capsize's buyback, 331 → **357**). Of the twenty-two mechanics the
inventory audits, four still have no honest card. On the same cached corpus, compiler coverage went
229 → 307 → **328 / 2100 (15.6%)** across those merges; none of that movement is this section's, which
adds no compiler rule.

Two more defects surfaced doing it — the generator serialized any string too long for one line as a
character-indexed object (nothing had printed a label that long until the fetchlands compiled), and
that broke `npm run build` while `npm run verify` stayed green, because verify lints and tests but
never type-checks.

#### The second run — pool **357 → 530**, and the three FETCH-PATH bugs that were hiding most of it
Six more engine systems shipped after the first run (the split/aftermath/adventure/Siege second face,
the as-enters naming, the intervening "if" and the step-trigger family, mandatory additional costs and
multi-destination searches, the mana-ability model, and — while this branch was out — replacement
effects and equipped-creature triggers), and every one of those branches signed off with "whoever next
runs the pipeline gets these free." **They were not free.** Eleven systems printed ZERO pool cards,
and three of them were blocked in the FETCH PATH rather than by the compiler, so re-running the
generator on the old pipeline would have produced almost none of them.

⚠️ **`/cards/collection` does NOT resolve a combined `"A // B"` name.** Posting
`{ name: 'Fire // Ice' }` comes back in `not_found`; posting `{ name: 'Fire' }` returns the whole
`Fire // Ice` record. Every split and aftermath candidate was failing to resolve, silently.
`frontFaceName` (data-tools `verify.ts`) is now the one place that answer lives, and both the expansion
fetch and the regenerated `starter-cards.json` go through it — the starter list is a list of things to
ASK SCRYFALL FOR, so it carries front-face names while the index keeps the card's real name.

⚠️ **A Siege's printed defense is on `card_faces[0].defense`, not at the card level.** §3.15 captured
`defense` and the split-card work said a re-fetch would unblock battles; it did not, because
`normalizeCard` read only `raw.defense` and every battle in Magic therefore normalized to `null`
anyway. The front-face fallback the cost/type/text lines already took now covers `defense` and
`loyalty` too. This is the same shape as the missing `layout` field that turned out to be twelve of
the split-card branch's thirteen cards: **if you are measuring coverage, check the normalizer is not
dropping the field your detector reads.**

⚠️ **CR 715.2 — an ADVENTURER's mana cost is the creature's, not the two halves added up.** Scryfall
prints `"{B} // {2}{B}"` at the top level for Foulmire Knight and reports `cmc: 1`; summing the string
produced a four-pip cost that contradicted the card's own mana value and tripped the index's
pip↔mana-value invariant on every adventurer at once. A SPLIT card is the opposite — CR 709.4 makes
the combined object's cost the SUM and Scryfall's `cmc` agrees — so the fix is narrowed to the one
layout where the printed top-level string is not the card's cost.

**Every one of the eleven now has real cards. The count is the compiler's verdict, not a judgement:**

| mechanic | before | after | representative cards |
|---|---:|---:|---|
| split cards (CR 709.4) | 0 | 5 | Assault // Battery, Integrity // Intervention, Road // Ruin, Spring // Mind, Start // Finish |
| aftermath | 0 | 3 | Road // Ruin, Spring // Mind, Start // Finish |
| adventure | 0 | 18 | Foulmire Knight, Order of Midnight, Rimrock Knight, Beanstalk Giant, Merfolk Secretkeeper… |
| modal DFCs | 0 | 21 | the ten Pathway lands, plus Bala Ged Recovery, Jwari Disruption, Kazandu Mammoth… |
| "as ~ enters, choose a…" | 0 | 8 | Adaptive Automaton, Patchwork Banner, Heraldic Banner, Vanquisher's Banner, Coldsteel Heart… |
| mandatory additional costs | 0 | 9 | Village Rites, Thrill of Possibility, Bone Splinters, Altar's Reap, Cathartic Reunion… |
| a search with TWO destinations | 0 | 2 | Cultivate, Kodama's Reach |
| the mana-ability model | 0 | 50 | ten pain lands, ten filter lands, ten Talismans, ten Signets, Mox Opal, Ancient Tomb, Reflecting Pool… |
| battles (Sieges) | 0 | 3 | Invasion of Moag, Invasion of Belenon, Invasion of Dominaria |
| the printed intervening "if" | 0 | 3 | Howling Mine, Dragonmaster Outcast, Colossal Majesty |
| "at the beginning of…" step triggers | 1 | 12 | Underworld Dreams, Font of Mythos, Temple Bell, Kami of the Crescent Moon… |
| equipment with a TRIGGERED ability | 0 | 4 | Sword of Fire and Ice, Skullclamp, Sword of the Animist, Argentum Armor |
| damage prevention (the Fog family) | 0 | 4 | Fog, Holy Day, Darkness, Moment's Peace |
| replacement effects (CR 614/615) | 0 | 2 | Hardened Scales, Torbran, Thane of Red Fell |

The last three rows are the ones this branch did NOT expect to close: `feat/replacement-effects` and
`feat/combat-damage-and-equipment` merged to `main` while it was out, and re-running the same
candidate list on the merged compiler admitted fifteen more cards with no edit at all. That is the
pipeline working as designed — **names in, `'complete'` verdicts out** — and it is the argument for
re-running it after every compiler branch rather than once every four.

**Still no honest card, both MEASURED by compiling every printed card that carries the mechanic:**
**multikicker** 0/19 (12 of the 19 blocked on the counters template alone) and **emblems** 0/90 — and
for emblems the loyalty ULTIMATE that would make the emblem is the bigger blocker, 108 unreadable
loyalty clauses across those 90 against 77 unreadable emblem bodies. Everything else the inventory
audits now has a card **and a seeded game proving it plays**: `pool-mechanics.test.ts` grew from 22
inventory entries and 11 play tests to 35 and 26.

The other measured counts, for whoever picks up the next template family: battles **3/36**, modal DFCs
**22/98**, split cards **5/124** (28 of the residual are Rooms and 17 are FUSE), aftermath **3/27**,
adventure **18/152**, damage prevention **11/123**, equipment-with-a-trigger **13/145**, replacement
on counters **3/17**, replacement on damage **4/32**.

⚡ **Rule 7 / §3.4a: the gauntlet at seed 99 is byte-identical to the same-box `origin/main`** this
branch merged (`b5752b2`) — **80/280**, rows 12 · 13 · 17 · 7 · 9 · 7 · 15, every one equal. ⚠️ The
recorded 81/280 moved to 80/280 while this branch was out, and it is **not this branch's**: a
baseline worktree at `b5752b2` with no pool change reads 80/280 too, so the one game belongs to
`feat/block-requirements-and-statics`. **No meta deck was touched here**, deliberately: adding a card
to a gauntlet deck moves every recorded A/B baseline and is a separate, measured decision. The
pool-only cards that WOULD be gauntlet-worthy are named on the coordination board.

📊 **The corpus number does not move, and that is the honest result: 533 / 2100 (25.4%) on
`origin/main` at `b5752b2` and 533 / 2100 here**, measured on the same cached corpus in two worktrees
on the same box (and 524 / 524 against the earlier `78e3299`, so it has held across two baselines). This section adds no compiler rule, and the three fetch-path fixes do not
reach the audit's population (the top-2100 modern corpus holds exactly one battle, itself blocked on
a "you may" template, and nine adventurers whose compile status the cost fix does not change). The
width is in the SHIPPED POOL: **357 → 530 cards, 325 → 498 compiled**, and every card in it still
round-trips through the compiler from its printed text.

#### Three defects the bigger pool found, none of them in the pool
`test/full-pool-soak` builds its theme decks FROM the shipped pool, so tripling the pool is also a
much wider soak — and it broke three ways, all of them pre-existing and all of them invisible while
the pool had no card that could reach them.

⚠️ **THE PILOT PROPOSED A SPELL IT COULD NOT CAST, AND THEN PROPOSED IT AGAIN FOREVER.** The
heuristic builds its cast actions itself rather than picking one off `generateLegalActions` — it has
to, because it taps for mana first and the cast is not on the menu until the mana is floating. That
makes every legality gate core applies at the OFFER a gate the pilot must apply too, and the
mandatory additional cost (CR 601.2h) was missing: Altar's Reap with an empty board became a
`castSpell` the engine rejected, nothing about the board changed, and the same cast came back on the
next priority. Three soak games burned the 6000-action cap without ending. Goals are now filtered at
`scoredSpellGoals`' single exit through core's own `unpayableAdditionalCostReason` (exported for
this), so both consumers inherit it and there is still exactly ONE reader of the rule.

⚠️ **A FREE EQUIP COST WAS AN INFINITE LOOP.** `bestEquipHost` excludes the creature the Equipment is
already on, which stops it re-equipping the same body — but with TWO hosts and Equip {0} the pilot
moved it A → B, found A was again the best non-host, and moved it back, at no cost, with nothing else
on the menu ever outscoring it. `equipIsAnUpgrade` requires the destination to STRICTLY beat the host
it is on, which makes the move monotone in `scoreEquip` so the cycle cannot close. Lightning Greaves
was in all three capped games.

⚠️ **THE SOAK'S OWN `transform-dfc` PREDICATE WENT STALE THE MOMENT THE POOL GREW.** It was
`hasKey('backFace')` — and FOUR printed layouts hang a second half off that field (split, aftermath,
adventure, modal DFC), none of which ever transforms. The theme deck for the mechanic was therefore
drafted almost entirely out of cards that cannot flip, and the soak reported transform-dfc INERT
while its one real card, Delver of Secrets, was never dealt into a game. A transforming DFC is the
one whose back face is **not separately castable**. Same failure shape as every other stale
predicate in this repo: it did not start wrong, it *became* wrong when the data underneath it grew.


### 3.21 The triggering player + the intervening "if" — the "At the beginning of…" family — ✅ done
The biggest template cluster in the coverage audit (~65 corpus cards) had ONE thing standing in front
of it, and it was not a template: **a trigger's resolution did not know which player set it off.**

`who: 'any'` fires an ability on both players' turns, but the ability resolves under its SOURCE's
controller — so "at the beginning of **each player's** draw step, **that player** draws an additional
card" would have drawn for Howling Mine's own controller on every turn, which is a strictly different
(and strictly better) card. The compiler was right to refuse it, and `trigger-step-begins` carried an
explicit `if (who !== 'you') return null;` saying so.

**The fix follows the seam cast-time choices already use, rather than inventing one.** A chosen `{X}`
rides `SpellStackObject → ResolutionFrame → EffectContext` so "deals X damage" can read it after the
spell has left the stack. The triggering player now rides exactly the same three hops:

    matchTriggers → PendingTrigger.triggeringPlayer      (answered from the EVENT, not the source)
                  → TriggeredStackObject.triggeringPlayer (survives the clone at every action boundary)
                  → ResolutionFrame.triggeringPlayer      (the resolution outlives the stack object)
                  → EffectContext.triggeringPlayer        (what a body's "that player" reads)

`triggeringPlayerFor` is the single place the answer is decided — the active player for a step, the
drawer for a draw, the life-gainer for a life gain, the caster for a cast, the permanent's controller
for an arrival or a death, and `undefined` for the events that are about no player at all. It is
called only for triggers that actually FIRED, so the per-event scan pays nothing for it.

`packages/cards` reads it through **one shared "whichPlayer" vocabulary** (`playersForParam`):
`'controller'` · `'opponent'` · `'targetPlayer'` · `'triggering'` · `'each'` (both seats, active player
first — APNAP, fixed here so the effect is reproducible from a seed rather than dependent on which
seat the source sits in). `drawCards`, `loseLife` and `dealDamage` all
speak it, so "each player", "that player" and "each opponent" mean one thing each wherever printed.

**The printed intervening "if" landed with it** (`packages/core/src/intervening.ts`), because half the
family prints one. It is part of the trigger CONDITION, not the body, because CR 603.4 checks it
**twice**: a false condition stops the ability reaching the stack at all (nobody may respond to it),
and one that has lapsed by resolution removes it doing nothing (`triggerFizzled`). Compiling it as an
`if` wrapper inside the effects would have implemented only the second check. Two condition kinds
ship — `sourceUntapped` (Howling Mine) and `controlCount` (a `CardFilter` plus a count bound, `max: 0`
being the printed word "no") — and a `minPower` bound is read as **EFFECTIVE** power, since counters
and anthems are what make a creature "power 4 or greater" on the board in front of the player. A
condition outside that closed vocabulary makes its card REPORT: `splitInterveningIf` distinguishes "no
clause" from "a clause I cannot read", and Felidar Sovereign's "if you have 40 or more life, you win
the game" must never become "you win the game".

**Also shipped:** the `drawsCard` trigger event ("whenever a player / an opponent draws a card"), the
scope table grew `each opponent's` and the bare `each`, `combat` joined the step table, and the
redundant `trigger-upkeep` rule was deleted — `trigger-step-begins` subsumes it and also handles the
"you may" wrapper and the intervening "if", which `trigger-upkeep` silently could not.

📊 **Measured on the cached 2100-card corpus, same file, before and after: 408 → 428 playable
(19.4% → 20.4%), +20 cards, 0 regressions.** The twenty: Howling Mine, Kami of the Crescent Moon,
Dictate of Kruphix, Font of Mythos, Teferi's Puzzle Box, Spiteful Visions, Scrawling Crawler,
Stormfist Crusader, Dragonmaster Outcast, Colossal Majesty, Underworld Dreams, Fate Unraveler,
Temple Bell, Mikokoro Center of the Sea, Forced Fruition, Corpse Knight, Kambal Consul of Allocation,
Marauding Blight-Priest, Poison-Tip Archer, Elas il-Kor. Ten of them were never in the audit's
"At the beginning of…" buckets at all — the draw watcher and the "each player draws" body reach them.

⚡ **Rule 7:** the gauntlet at seed 99 is byte-identical to the same-box `origin/main`, and the added
work is off the hot path by construction — `triggeringPlayerFor` runs only for a trigger that matched,
the intervening check only for a condition that exists, and both new stack-object fields are copied
CONDITIONALLY in `internal/clone.ts` so an ordinary trigger clones byte-for-byte as it always did.

⛔ **Reported by name rather than approximated** (each is a different system, not a missing rule):
"you win / you lose the game"; a DELAYED trigger ("at the beginning of your NEXT upkeep" — Pact of
Negation); ~~blink (exile then return)~~ — **the immediate-return half SHIPPED in §3.35**; the
DELAYED-return half (Flickerwisp, Eerie Interlude, Ghostway) still needs delayed triggers; token
COPIES of a permanent (Extravagant Replication, Mechanized Production); the city's
blessing / ascend; amass; discover; the Ring; "no maximum hand size"; a spell-cost increase or
decrease static (God-Pharaoh's Statue, The Immortal Sun); "players can't activate loyalty abilities";
DOUBLING power and toughness (Unnatural Growth, Zopandrel); "life lost this turn" (Wound Reflection);
and a count derived from a REVEALED card's mana value (Dark Confidant, Twilight Prophet).

⚠️ **One pre-existing infidelity this work ran into and did NOT fix, named so it is not rediscovered:
a created token has no COLOUR.** `makeToken` builds a `CardDefinition` with no cost, and
`colorsOfDefinition` derives colour from cost pips — so "a 1/1 **black** Faerie Rogue token" and "a
5/5 **red** Dragon token" both enter colourless, invisible to a "black creatures you control" anthem
or a protection-from-red. It predates this branch (every token card in the pool has it) and closing it
needs a `colors` field on `CardDefinition` plus the colour reader honouring it — a small system, and
one that belongs to whoever owns `makeToken`, not to a trigger branch.
### 3.22 The second castable half — split, aftermath, adventure and the Siege reward — ✅ done
The coverage audit's #1 and #2 gaps were one system: *casting the second half of a split, adventure or
Siege card* (60 card-blocks) and *the "//" card type* (38). Four printed layouts, four different cast
paths, and — as it turned out — one model.

**A card may carry a second half that is really cast, plus the list of ZONES that half may be cast
from, plus (for the two halves you earn rather than hold) a per-instance PERMISSION.** That is the
whole design, and each layout is one configuration of it:

| layout | the card's own definition | second half | cast from | pays |
|---|---|---|---|---|
| modal DFC (§3.16) | the front face | `backFace` | hand | its own cost |
| **split** (CR 709) | the **combined object** (`frontFace` present) | `backFace` | hand | its own cost |
| **aftermath** (CR 702.127a) | the combined object | `backFace` | **graveyard only** | its own cost |
| **adventure** (CR 715) | the **creature** | `backFace` (`adventure: true`) | hand → then the creature from **exile** | its own cost |
| **Siege** (CR 310.4) | the battle | `backFace` | **exile**, once defeated | **nothing** |

**The one judgement worth reading twice: a SPLIT card's own definition is the CR 709.4 COMBINED
object, and an ADVENTURER's is not.** A split card in a hand, graveyard or library is *neither half* —
it has both names, the union of the type lines, and a mana value equal to the sum — while an
adventurer card in every zone but the stack is *just the creature* (CR 715.2). Every characteristic
read in the engine goes through `card.def`, so modelling a split card as its left half would have
silently mis-answered every discard filter, cost reduction and "mana value 3 or less" clause. Making
the combined object the definition, with the halves hanging off it as `frontFace`/`backFace`, makes
all of that correct with no reader changed: `playableFaceOf` answers "which object am I casting?" for
a split card, a modal DFC and an ordinary spell alike, so the cast path has one shape.

**The permission is a card GRANT, not a new field.** "You may cast the creature later from exile" and
"exile it, then you may cast it transformed" are the same sentence with different nouns, and both need
exactly what `card-grants.ts` already provides: a record attached to one instance in one zone that is
pruned the moment the card moves. CR 400.7 — the permission dies with the object — therefore falls
out for free, and so does the clone (`cloneCardGrant` spreads, and `split-cards.test.ts` pins it).

**Aftermath needed almost nothing, because the exit was already right.** `castFrom: 'graveyard'` makes
a spell exile itself however it leaves the stack — written for flashback (CR 702.34a), and word for
word what aftermath's "then exile it" asks for. The only new thing is the zone list, and the one
deliberate exception in the cast path: a graveyard-legal BACK half pays its own printed cost rather
than a flashback cost it does not print.

**An adventure exiles on RESOLVE and not on COUNTER**, which is exactly the distinction
`spellLeaveDestination(spell, reason)` exists to force a caller to state. A countered adventure goes
to the graveyard like any other countered spell and the creature half is gone for good.

**A `playLand` may now name a source zone**, for the one land play that does not come from a hand:
a Town // Adventure card waiting in exile under its own permission.

**Both seats play it.** The heuristic pilot walks the castable HALVES of every card in hand (a shallow
synthetic instance whose `def` IS the half, so the scorer, the target-legality check and the mana
planner all see the right cost with no second code path), plus an aftermath offer in the graveyard
loop and an exile loop for permission casts — without which the pilot would cast Stomp and never take
the Giant, which is strictly worse than not owning the card. The hotseat board returns one cast option
per half, each labelled with that half's own name and cost and keyed `instanceId:face`, because the
failure it replaces was not a missing button but a WRONG one: a single button showing the combined
cost that cast the left half for a different price.

**Reported, never approximated, each with its own named gap:** **FUSE** (CR 702.102 — one spell that
is both halves at once, with a combined cost, two scripts and per-half targets: a second shape of
spell, not a flag on this one) and **ROOMS** (CR 714 — Scryfall files them under the `split` layout and
they share nothing else: a permanent whose second door is unlocked on the battlefield). Four of the
six split-layout cards in the 2100-card corpus are Rooms. `SECOND_CASTABLE_FACE_GAP` is reworded to
the residual it now names: a record carrying the combined `A // B` name with no per-face data to
compile from, or a layout with no cast path at all (meld, flip).

**Measured on the cached 2100-card corpus: 408 → 421 playable (19.4% → 20.0%).** Twelve of the
thirteen come from a single missing FIELD: `normalizeCard` dropped Scryfall's `layout`, so every modal
DFC in a fetched corpus fell through the compiler's face detection and reported this very gap. The
layout is the only unambiguous statement of what a two-faced record means — a split card and a modal
DFC both print two faces with two costs — and the compiler refuses to guess it from the name.

⚠️ **The committed card index predates the `layout` field, so no pool card compiles as a split card
yet.** The fetch pipeline captures it from now on; a re-fetch of the index is what puts these layouts
in front of a player who has not imported a decklist, and that file belongs to the pool branch.
### 3.23 "As ~ enters, choose a…" — a value NAMED as a permanent enters, and remembered — ✅ done
The replacement-effect naming of CR 614.1c: **"As Cavern of Souls enters, choose a creature type."**
The corpus audit named it as one gap of 27 cards, but the prompt was never the hard half. **The crux
is that the answer has to stick to the permanent and still be readable ten turns later** — by the
card's own anthem ("creatures you control **of the chosen type** get +1/+1"), by its own mana ability
("add one mana **of the chosen color**"), by its own type line ("this creature **is the chosen type**
in addition to its other types") and by its own cast trigger ("whenever you cast a spell **of the
chosen type**"). A chosen value nothing can READ is a half-card, so this section is one choice kind
plus **four readers**, not one prompt.

**Measured, paired, on the same cached 2100-card corpus against the `origin/main` this branched from:
408 → 414 playable (19.4% → 19.7%).** Six cards became fully playable — Adaptive Automaton, Patchwork
Banner, Heraldic Banner, Coldsteel Heart, Vanquisher's Banner, Chronicle of Victory — and one more
(Cloud Key) had its naming line implemented while its cost-reduction line still reports.

#### The shape
- **`ChooseValueChoice`** — a ninth choice kind. Not a `chooseModes`: nothing RUNS when it is
  answered. It carries a `subject` (`color` / `creatureType` / `cardType` / `basicLandType` /
  `player`) because the *answering policy* differs per subject and a list of one-letter strings is
  otherwise indistinguishable from a list of seats.
- **`CardInstance.chosenAsEntered`** — the memory, and the whole system. Copied by `cloneInstance`
  (conditionally, like `attachedTo`), cleared by `resetInstanceForNewZone` (CR 400.7 — a permanent
  that leaves is a new object and names again), and announced by a new **public** `chosenAsEnters`
  event.
- **`CardDefinition.asEntersChoice`** — one declaration read by every consumer: the engine, the AI's
  policy, the UI and the About page.

#### Where it is asked, and the ONE inert default
The naming happens *while* the permanent is entering — the same moment "enters with N +1/+1 counters"
applies — so it is raised by the two paths that hold a permanent mid-entry and can still park a
question:
- **playing a land** — `raiseLandEntryChoice` in `engine.ts`, beside the shockland's `payLife`;
- **a permanent spell resolving** — the compiler puts the `chooseAsEnters` primitive FIRST in the
  card's script, so it runs against `ctx.source` before `finishSpellResolution` puts it on the
  battlefield. (The same seam `addCounters { self: true }` uses, and for the same reason.)

**Every other entry path — reanimation, another card's "put it onto the battlefield", a token, a
hand-built test instance — records NOTHING, and nothing named matches nothing.** That is the
shockland's rule applied to a naming: the unasked default is explicit (`NOTHING_CHOSEN`), it is the
same value on every path, and it is the one that can never grant an advantage, because *every* reader
treats an absent value as the empty set rather than as "no filter". A reanimated Adaptive Automaton
is an anthem over nobody, never over the whole board. `defaultAnswerFor` therefore names NOTHING
rather than the first option — an arbitrary pick dressed up as a default would hand the degraded path
a working creature type.

⚠️ **A LAND CAN OWE TWO QUESTIONS AND ONLY ONE CAN BE PARKED.** Multiversal Passage names a basic land
type and *then* offers to pay 2 life; Temple of the Dragon Queen offers a reveal and names a colour.
`raiseLandEntryChoice` is therefore a STEP function — it asks the first unanswered question and is
called again from the answer handler — rather than three independent branches, which would silently
drop the second. The `tapped` event stays deferred until every question is settled, so a replay never
shows a land flickering tapped→untapped.

#### The four readers (this is the part that makes it a card)
1. **`StaticAffects.ofChosenSubtype` / `ofChosenColor`** — an anthem narrowed by the source's own
   naming. Safe against a layer loop (CR 613.8) for exactly the reason `hasCounterKind` is: the value
   is instance STATE written once on entry, and no continuous effect in this model can change it.
2. **`CardDefinition.isChosenSubtype`** — "this creature is the chosen type in addition to its other
   types". Read through `permanentHasSubtype`, the instance-aware form of `hasSubtype`, which the
   shared `CardFilter` now uses — so a lord that named Goblin genuinely IS a Goblin and the next
   lord's filter sees it. (Two Adaptive Automatons pump each other, which is the printed behaviour.)
3. **`ManaAbility.chosenColor`** — "{T}: Add one mana of the chosen color", modelled exactly like
   `derivedColors`: the mode LIST is a fixed five (the mode index must mean the same thing to the
   action generator, the planner and the apply path) and WHICH mode is available is the per-instance
   question, answered by `manaModeBlockedReason`. A permanent that named nothing offers no mode and
   taps for nothing.
4. **`TriggerCondition.spellSubtypeIsChosen`** — "whenever you cast a creature spell of the chosen
   type". The SPELL is resolved from the stack through the existing `TriggerSubject` seam rather than
   by widening the `spellCast` EVENT with a subtype list — which matters, because the event is the
   log, and widening it changed every replay's bytes and broke the self-play behaviour lock for a
   fact the object already carried.

#### Both seats
- **The pilot names deliberately, and it is documented policy, not a shrug.** A pilot that named at
  random would still play legal Magic — it would just play a Cavern of Souls that taps for nothing and
  an Automaton that pumps nobody, and **the lab would then report "no measurable difference" about a
  card that is in fact a lord**. `answerChooseValue` names the type that appears on the most of the
  chooser's OWN cards (their deck's tribe), the colour their own cards demand most counted in
  coloured PIPS (one triple-black bomb outweighs two cantrips), and the OPPONENT for a player naming.
  It reads only the chooser's own zones — a player knows their decklist — and is deterministic, ties
  breaking on core's fixed option order.
- **Humans get a radio group** in `ChoicePrompt` (`chooseValue` is a scalar draft, undecided until a
  value is clicked — deliberately distinguishable from "named nothing", which is a legal answer), with
  the menu scrolling inside the prompt so Confirm is always reachable. Both event-log formatters print
  the naming out loud.
- **The option list for a creature type is DERIVED from the game**, not from a thousand-entry table:
  the subtypes on cards the chooser owns, plus everything on the battlefield. That is information the
  seat genuinely has, and it never touches the opponent's hidden zones.

#### Enforced tables
`OBSERVATION_POLICY` classifies `chosenAsEnters` as **public**, and the reasoning is deliberate rather
than convenient: a choice ANSWER is private to its chooser (which is why the three choice events are
redacted), but a value named as a permanent enters is announced at the table and stays legible on the
card for as long as it is there. What is *not* public — the option list, whose length is a weak read
on the chooser's decklist — never leaves the choice, whose `choiceAsked` observation is already
redacted to a count. `paired-arms-config.ts` classifies `chooseAsEnters` as **library-reading**, and
conservatively: it moves no card and reveals no card, but its creature-type menu is built from the
chooser's library, so a swapped card can change what is on offer and therefore what gets named — the
exact divergence the identical-game skip claims cannot happen.

#### Throughput (rule 7): parity, measured
The 24-game **self-play behaviour lock is byte-identical** — same winner, same turn count, same action
count, same event-log hash and same final-state hash on every seed — so the engine plays the same
games. Allocation, by the scavenge probe (nursery pinned at 1 MB, 40 seeded games, 29,899 actions
either way): branch **561 / 560** vs `origin/main` **561 / 561** on paired runs, with wider single
runs of 578 and 576 showing the run-to-run band. Parity, not a claim of improvement. Wall clock on
this box is worthless (several agents), which is why neither number here is a time.

#### Deferred, each with a named blocker
The naming is stored and readable; these are printed lines that would READ it and have no rule, and
they now report as `a "the chosen …" READER the compiler does not recognize yet` rather than as a
missing you-may template:
- **a spend restriction on produced mana** (Cavern of Souls, Secluded Courtyard, Unclaimed Territory)
  — unchanged, and still the mana-pool system §3.11's census named: the pool records colour, not what
  each mana may pay for;
- **cost reduction by the named type** (Urza's Incubator, Morophon, Cloud Key) — the cast-cost
  modification system, in flight on its own branch;
- **counter formulas over the named type** (Door of Destinies, Banner of Kinship — "+1/+1 for each
  charge counter") and **a replacement effect on OTHER permanents entering** (Metallic Mimic);
- **copying a spell** (Reflections of Littjara), **an extra instance of a triggered ability**
  (Roaming Throne), **an additional mana when a land is tapped** (Caged Sun, Gauntlet of Power,
  Utopia Sprawl);
- **"choose a NUMBER between 1 and 10"** (Talion) — a subject this engine could store, deliberately
  left out of the closed subject table because no printed line can yet read it, and a naming nothing
  consumes is exactly the half-card this contract forbids;
- **fear** (Cover of Darkness) — an evasion keyword the engine does not model;
- **Multiversal Passage's "this land is the chosen type"** — a type-changing effect that would have to
  grant the named basic land type's mana ability.
### 3.24 Copy effects — layer 1, beneath everything — ✅ done
The engine had never had a copy effect, and an earlier branch was told to skip clones for exactly that
reason. `You may have ~ enter as a copy of any creature on the battlefield` now plays as printed.

**The mechanism is one swap, and it is the transform system's.** A copy is applied by swapping
`CardInstance.def` — every characteristic read in the codebase already routes through it (combat's
P/T, targeting's types, the trigger collector's ability list, mana production, the AI's evaluation,
the renderer's art), so the swap IS the routing and there is no second code path anywhere.
`CardInstance.uncopiedDef` is the way back, restored by `resetInstanceForNewZone` when the permanent
leaves (CR 400.7 — a bounced Clone is a Clone in hand). It is a **separate field from `printedDef`**
and not redundant with it: `printedDef` answers "which FACE is up", `uncopiedDef` answers "which CARD
is this really", and a copy of a DFC that then transforms needs both answers at once.

**LAYER 1 IS THE WHOLE FEATURE (CR 613.2).** A copy is applied beneath everything, so counters (7d),
anthems (7c), Auras and until-end-of-turn pumps all apply **on top of** the copied characteristics —
which falls out for free, because those layers are computed from `inst.def` plus the instance's own
state. And **you copy the printed card (CR 706.2)**: a 1/1 wearing three +1/+1 counters is copied as a
**1/1**, a transformed permanent is copied by its **front face**, and a permanent that is itself a copy
is copied by what it copies — and an ADVENTURER on the battlefield is copied as its creature half,
which needs no special case because the cast path already put that half in `def` (CR 715.2).
`copiableDefOf` is the single answer to that question and every path asks it. `copy.test.ts` pins all of it, including a copier that keeps its own counters and its own pump.

**It is an as-enters REPLACEMENT, and it joins the existing one.** `CardDefinition.copyAsEnters` sits
beside `asEntersChoice` (§3.23's CR 614.1c naming) and the `entersTapped*` family because it is the
same kind of thing, and it deliberately reuses §3.23's machinery rather than growing a rival:
`'copyAsEnters'` is a second `PendingChoice.context`, and the answer applies to
`appliesToInstanceId` exactly as a naming's does.

For a **permanent spell** the engine raises it in `resolveTopOfStack`, before `stackResolved` and
before a single effect runs — the stack object goes straight back on the stack untouched while the
question stands, and `SpellStackObject.copyAsEntersDecided` is what makes a DECLINE stick (a decline
leaves no trace on the instance, so without the marker the resolution would re-ask forever). Asking
there is what lets the COPIED card decide summoning sickness, starting loyalty and starting defense.

For a **land**, `applyPlayLand` asks it **once, ahead of §3.23's `raiseLandEntryChoice` ladder**,
and it is not another rung of that ladder for a precise reason: it does not answer a question about
this land, it decides *which land the ladder is then asking about* — a Vesuva that copies Cavern of
Souls owes Cavern's naming, one that copies a Temple owes nothing. Asking from the single call site
also means it can never be re-asked. The answer re-reads `entersTapped` off the copied card (nothing
can observe the intermediate value: the `tapped` event is deferred to the end of the ladder, and
answering is the only legal action while a question stands) and then hands control back to the
ladder.

**Compiler: two closed tables, and a card outside them reports.** `copy-as-enters` owns the whole
printed clause including its tapped-ness and its "except …" tail — an added card type or creature
subtype, a kept name, legendary on or off, Spark Double's extra +1/+1 and loyalty counters, Vesuva's
"enters tapped". **Measured PAIRED against the same-day `origin/main` on the cached
2100-card corpus: 485 → 493 playable, nothing lost** — Sculpting Steel, Mirrormade, Copy Enchantment,
Clever Impersonator, Spark Double, Vesuva, Echoing Deeps (which copies a land card in a **graveyard**)
and Glasspool Mimic, whose copy clause sits on a modal-DFC face and so needed §3.22's work too.
Throughput is at parity, measured rather than assumed: 562 vs 562 scavenges over 40 identical seeded
self-play games (29,899 actions, byte-identical in both arms).

**The AI has a policy, and it needed one.** The generic `selectCards` path prices candidates with
`cardValue`, which reads EFFECTIVE stats — so a pilot would copy the 1/1 wearing three counters over
the printed 4/4 beside it and end up a 1/1. `copyTargetValue` prices what the copy WOULD BE from
PRINTED characteristics (body, abilities, keywords, mana source), and the decline bar is the copier's
own printed body scored the same way — usually zero, because a Clone's own body is a 0/0 that dies to a
state-based action on arrival. Proven against the real heuristic pilot in real games.

**`Kindred` (CR 308) became a real card type.** Its entire rules content is that the card's subtypes
are creature types without the card being a creature, and that it counts as a card type in a graveyard
(Tarmogoyf) — so it is a member of `CardType`, has a bit in `CARD_TYPE_BIT`, and `TYPES_WITHOUT_SYSTEM`
stays honestly empty. A record whose ONLY type is Kindred still reports: CR 308.1 requires a second.

> ✅ **The first two of these SHIPPED in §3.31** — copying a spell on the stack and token copies.
> The paragraph below is left as written because it is the record of what this section reported and
> WHY, and its diagnosis was exactly right; what it lists is no longer the open work. (Its "CR 706"
> citations are also corrected to CR 707 in the source — copying objects is section 707.)

**Reported by name, not half-built:** copying a SPELL on the stack (Reverberate, Narset's Reversal) and
TOKEN copies (Rite of Replication, Kiki-Jiki) need a stack object that is **not a card** and ceases to
exist as it resolves (CR 707.10 — `resolvesTo` has only battlefield/graveyard/exile/hand, and any of
them would leave a phantom card in a zone that delirium, flashback and Tarmogoyf all count), plus an
aiming moment for "you may choose new targets for the copy" and the copy carrying the original's X and
modes (CR 706.10). Also reported: a copy that GRANTS an ability printed in quotes (Phantasmal Image's
"becomes the target" sacrifice, Sakashima's delayed return), a copy bounded by **the amount of mana
spent** to cast it (Mockingbird — nothing records that number), and "becomes a copy" applied by an
activated ability rather than as the permanent enters (Mirage Mirror, Thespian's Stage).


### 3.25 Replacement and prevention effects — a layer the engine never had — ✅ done
CR 614/615/616. A replacement effect never goes on the stack and never "happens": it watches for an
event that *would* happen and changes what happens instead. Three printed families that looked like
three template buckets are **one system underneath**, and this ships as one layer that damage,
counters and draws all consult — `packages/core/src/replacement.ts` (what a card DECLARES) and
`packages/core/src/internal/replacement.ts` (what the layer DOES), beside `internal/continuous.ts`
and `internal/combat.ts`.

**What plays as printed now.**
- **Counter multipliers** — "If one or more +1/+1 counters would be put on a creature you control,
  that many **plus one** are put on it instead" (Hardened Scales, Conclave Mentor, Ozolith, Kami of
  Whispered Hopes) and "**twice** that many" (Corpsejack Menace, Branching Evolution, Doubling
  Season's counter half).
- **Damage scaling** — "If a **red** source **you control** would deal damage to **an opponent or a
  permanent an opponent controls**, it deals that much damage **plus 2** instead" (Torbran) and the
  doubling/tripling forms (Gratuitous Violence, Fiery Emancipation, Angrath's Marauders, Twinflame
  Tyrant, Dictate of the Twin Gods, Gisela). All three restrictions are kept: a colour read off the
  cost pips by the same reader protection uses, a source TYPE ("a creature you control"), and whose
  objects may be hit. A clause with no controller tail is the symmetric card and is **not** quietly
  read as "yours".
- **Prevention** — the one-shot form ("Prevent all combat damage that would be dealt this turn" —
  Fog, Darkness, Spore Frog's sacrifice ability) registers a floating effect that expires in cleanup;
  the STATIC form ("Prevent all combat damage that would be dealt to **attacking** creatures you
  control" — Dolmen Gate) is card data whose lifetime is derived from the battlefield. The two are
  separated by the printed tail "this turn" and by a permanent check, because compiling a Fog as a
  static would prevent damage for the rest of the game. "Prevent **half** that damage, rounded up"
  (Gisela's second clause) is its own outcome, since halving produces a prevented amount the log must
  report and the rounding direction is printed.
- **Draw replacement** — "If you would draw a card **except the first one you draw in each of your
  draw steps**, draw two cards instead" (Teferi's Ageless Insight) and "…**while your library has no
  cards in it, you win the game** instead" (Laboratory Maniac). The printed exception is EXACT, not
  approximated: core records a `drewInOwnDrawStep` turn fact as the draw-step draw happens, so the
  second and every later draw in that step really is replaced.

**⚠️ THE THREE THINGS THAT ARE EASY TO GET WRONG HERE, and what this branch did instead.**

**1. CR 614.5 — an effect applies AT MOST ONCE to a given event.** This is the rule that makes a
doubling effect terminate. After a replacement modifies the event the engine re-asks which effects
apply *to the modified event*, and Doubling Season still matches its own output. The applicable set
is therefore a **bitmask over the candidate list**, so an effect already applied is never offered
again and the loop runs at most `candidates.length` times **by construction** — no recursion, no
depth counter to tune. Two doublers on one event give ×4; one doubler gives ×2 and logs exactly one
application.

**2. CR 616.1 — the ORDER is the affected player's, and it is a real choice.** Hardened Scales then
Corpsejack Menace puts **4** counters; the other order puts **3**. This engine settles that
decision **deterministically, in one place, for every seat and every call site**: it enumerates the
orders (exhaustively up to `ORDER_SEARCH_MAX_CANDIDATES = 4`, canonical order beyond) and takes the
one the affected player would take — least damage, most `+1/+1` counters, fewest counters of any
other kind (`affectedPlayerPrefersMore`, one named objective) — with ties broken by a canonical
order that is a function of the state alone, so a paired A/B run cannot diverge on it.

⚠️ **It is settled rather than ASKED, and the reason is structural, not laziness.** The hottest call
site is the combat damage step, which is a synchronous batch inside the turn machine: `resolveCombatDamage`
applies every assignment before priority exists again, so there is no resolution frame to park a
`pendingChoice` in. A layer that asked a question for a Lightning Bolt and decided silently for a
combat hit would be exactly the drift this repo keeps having to unwind. This is the same class of
delegated sub-decision as "which lands get tapped to pay this cost", which core's shared payment
planner has always answered on the player's behalf (§3.11) — every order it can produce is legal, and
the decision the CARD prints is modelled in full.

**3. A prevention SHIELD is consumed, and cannot resurrect.** "Prevent the next N damage" carries
`remaining` on its floating record; it is decremented by exactly what it prevented, written back
*and* spliced out of `GameState.replacements` the moment it hits zero. Both writes are deliberate:
an index built earlier **in the same damage step** still holds a reference to the record, so the
write is what stops the second attacker in one combat re-using a spent shield, and the removal is
what stops any later index seeing it at all. A shield declared as a PRINTED ability is refused by the
layer outright — it would have nowhere to keep its count and would prevent N *every time, forever*,
which is a different and much better card.

**⚡ THE LAYER IS INERT AND ALLOCATION-FREE WHEN NOTHING REPLACES ANYTHING.** This sits on the damage
and counter paths, the hottest in the game, so `indexReplacements` returns the **shared frozen empty
array by reference** unless some permanent, emblem or floating record actually declares a
replacement; the guard at every call site is `index.length === 0`. The discovery loop is the same
shape as `indexContinuous`'s — an indexed `for` over `state.battlefield`, one property read per
permanent, no iterator, no output array unless something is found — and `GameState.replacements` is
OPTIONAL and **absent** in every game that never makes one, exactly like `cardGrants`.

**Measured three ways, because wall clock on this box is worthless** (the same build read 39 and then
108 games/sec within one session):
| measurement | origin/main | this branch |
|---|---|---|
| **Allocation** — scavenges over 40 seeded self-play games, semi-space pinned to 1 MB, median of 3 | **560** | **561** (identical 29,899 actions) |
| **The added work itself** — `indexReplacements` calls / permanent property reads over 120 games | — | **4,324 calls / 60,530 reads, zero allocation** |
| **Gauntlet, Mono-Red Aggro, 40 games/deck, seed 99** | **81/280** | **81/280 — every matchup row equal** |
| **CPU time**, `process.cpuUsage`, paired and interleaved, 8 pairs | median 1844 ms | median 1851 ms (**1.004×**) |

⚠️ Read the CPU row with its own caveat: the BASE arm alone swung 1421–2109 ms run to run (48%) on
this shared box, so anything under ~10% there is below the machine's resolution. The allocation row
and the byte-identical gauntlet are the load-bearing evidence.

**The AI is not blind to it, and that was two separate fixes.** `packages/ai/src/tactical.ts`
re-prices every attacker's damage through the layer (`projectDamage`), so `maxDamage`, the guaranteed
damage after optimal blocks, the **lethal** flag and the clock all read the doubled swing — a pilot
that owned a Gratuitous Violence and still attacked on printed power would decline a lethal attack.
`totalIncomingDamage` does the same for the blocking decision. Both go through `projectDamage`, which
runs the **identical** loop with the identical ordering rule and **writes nothing** — there is no
second copy of the arithmetic, and a pilot weighing its options cannot spend the prevention shield it
is weighing. A new `fog` spell intent is priced by exactly what it prevents (zero in a main phase,
`lethalBurnScore` in front of a lethal swing, with a named floor so a poke does not buy a card).

⚠️ **A REAL PILOT DEFECT FELL OUT OF IT, and it was not about fogs.** `chooseBlock` used to `return`
a pass when no block was worth making, which made **every instant-speed response in the
declare-blockers step unreachable** for a pilot that had declined to block — a fog, a combat trick, a
burn spell to finish the turn. "Nothing is worth blocking" is an answer to WHICH BLOCKS, not to what
to do with priority; it now falls through to the priority logic, which ends in the same pass when
nothing is worth casting. **Gauntlet seed 99 is unchanged** (81/280, every row equal), because the
shipped pool contains no instant the pilot wants in that window — the fix is what makes the pool's
next one work.

**Measured PAIRED against the same-day `origin/main` (`068be3d`) on the same cached corpus:
485 → 501 of 2100 playable (23.1% → 23.9%), +16 cards.** The same +16 was measured against the
pre-merge main this branch started from (408 → 424), which is the useful cross-check: the families
that landed meanwhile moved the baseline, not this work's contribution. Re-run with
`node packages/cards/scripts/coverage-audit.mjs --input <corpus.json> --top 0`.

The 16, by shape: **counter multipliers** (Hardened Scales, Branching Evolution, Corpsejack Menace),
**damage scaling** (Torbran, Gratuitous Violence, Fiery Emancipation, Angrath's Marauders, Twinflame
Tyrant, Dictate of the Twin Gods, Gisela), **prevention** (Fog, Darkness, Spore Frog, Dolmen Gate)
and **draws** (Laboratory Maniac, Teferi's Ageless Insight). Several more cards in these families
compile their replacement clause correctly and stay `incomplete` on a DIFFERENT line — Conclave
Mentor on "gain life equal to its power", City on Fire on convoke, Iroas on devotion — which is the
contract working, not a gap in this system.

**Still reported, by name, never approximated** (each is now its own `UNSUPPORTED_HINTS` entry, so
the audit names the residual rather than a solved system):
- a **TOKEN-count** replacement ("twice that many of those tokens are created instead" — Doubling
  Season's other half, Parallel Lives, Anointed Procession): the layer scales a NUMBER, and creating
  extra objects is a different outcome;
- a **ZONE-CHANGE** replacement ("if it would die, exile it instead" — Rest in Peace, Dauthi
  Voidwalker): the layer changes quantities, not destinations;
- a **LIFE-CHANGE** event (Alhammarret's Archive, Rhox Faithmender, Bloodletter of Aclazotz) — one
  more event kind on this same layer, blocked on nothing but a chokepoint at `changeLife`;
- a prevention **RIDER** ("prevent that damage AND put a +1/+1 counter on it for each 1 prevented" —
  Vigor, The Mindskinner): prevention itself is implemented, the rider is not;
- a shield bound to **a source of your choice** (Deflecting Palm) — choosing a source is a question
  nothing asks;
- a draw replacement whose result is a different **ACTION** (Notion Thief's skip-and-redirect,
  Abundance's reveal-until).

⚠️ **NOT YET IN THE SHIPPED POOL.** Every card above is reachable through the deck importer and plays
as printed, but none is in `packages/cards/data/expanded-pool.ts` yet, so a player browsing the pool
cannot see the mechanic. Closing that is a DATA edit on the §3.20 path (add the names to
`expansion-candidates.json`, re-run `build-expansion.ts`, re-fetch data-tools, regenerate the web card
index) — it needs the network and it rewrites three generated files, so it is deliberately left to
whoever next runs that pipeline rather than done from this branch.
### 3.26 The full-pool soak — proving the shipped systems work TOGETHER — ✅ done
Twelve engine systems shipped in three days (§3.13–§3.20) and the pool went 191 → 357 cards. Every one
of them was tested **in isolation by the agent that built it**, and almost none were ever tested
together. The gauntlet decks in `packages/sim/data/decks` are eight curated archetypes: they exercise a
fraction of the pool and essentially none of the collisions. No test in the repo had ever put a
planeswalker, an Equipment, a protection creature, a modal spell and a flashback spell in one game.

The soak does. `packages/sim/src/soak*.ts` plays thousands of seeded games with **randomised-but-legal**
decks drawn from the whole pool, deliberately mixing mechanic families, and asserts INVARIANTS — not
"it finished", which is the exact check this repo has been burned by (a combat-declaration bug once made
games unable to END while the whole suite stayed green).

**Three things it does that the existing suites do not.**
1. **Invariants on every settled state** (`SOAK_INVARIANTS`): every action a pilot submits is legal;
   the engine never REJECTS an action it offered; no game reaches the action cap; no stack object
   survives a turn; state-based actions leave no dead creature, 0-loyalty walker or 0-defense battle;
   an instance is in exactly one zone; no card in a hidden zone leaks into an observation;
   `applyActionInPlace` stays bit-identical to `applyAction`; and no pool card resolves an
   `effectUnsupported` no-op.
2. **Occurrence, not coverage.** `SOAK_MECHANICS` is an inventory and the run **fails when a mechanic
   the pool prints never fires** — the sim-side twin of `pool-mechanics.test.ts`, which fails when a
   mechanic loses its last card. Between them, "shipped but unreachable" has nowhere to hide. Witnesses
   are labelled `action` / `event` / `state` so a weaker claim reads as a weaker claim.
3. **A NEW ENGINE EVENT BREAKS THE BUILD.** `SOAK_EVENT_WITNESS` is a mapped type over
   `GameEvent['type']` (the `OBSERVATION_POLICY` idiom), so the next system to ship cannot go untested
   by simply not being thought of.

**Two tiers.** The FAST tier (`soak.test.ts`) runs in the ordinary suite every time — one anchored
matchup per mechanic plus a block of mixed games, every invariant on every decision: **104 games,
2,210 turns, 64,657 actions, ~17 s CPU.** The DEEP tier (`soak-deep.test.ts`, `JB_SOAK_GAMES=N`, or
`npm run sim -- soak --games N`) plays thousands — the run that found the last defect was **5,064
games, 106,099 turns, 3,203,620 actions, 498 s CPU**, with a 1.1% turn-cap draw rate and zero
action-cap games. Both tiers are sized in GAMES and report CPU: wall clock on this box is worthless
(the same build has measured 39–87 games/sec inside an hour).

**What it found.** Four real defects, fixed here, and three reported. Two of the four are
state-based-action gaps in `applyCastSpell`, and neither is reachable by any gauntlet deck — which
is precisely why nothing before this had seen them.
- ✅ **FIXED (core) — state-based actions did not run when a spell was CAST, only when one
  RESOLVED.** The caster receives priority the instant a spell is announced, which is an SBA check
  point (CR 704.3) — and casting MOVES A CARD BETWEEN ZONES, which characteristic-defining P/T reads.
  A flashback cast takes the last instant out of a graveyard, every Tarmogoyf loses a point of
  toughness, and one already shrunk by a Weakness is at 0 and must die; the engine handed priority
  back to a player looking at a creature that should already be in a graveyard. Turn 8 of seed
  1727114651 — **once in 5,064 games and 3.2 million actions.**
- ✅ **FIXED (core) — paying a flashback LIFE cost did not end the game.** `applyCastSpell` charges
  "Flashback—{1}{B}, Pay 3 life" and never ran the state-based-action pass, so a caster who paid
  itself to exactly 0 kept holding priority and casting spells (turn 20 of seed 3856639351 — once in
  4,000 games). Paying yourself to 0 is legal (CR 118.4); surviving it is not (CR 704.3 / 704.5a). One
  `checkStateBasedActions` call — the third copy of a rule `applyTapForMana` and the shockland
  pay-life choice already apply.
- ✅ **FIXED (AI) — the pilot tapped five lands toward a flashback cast it could never make.** Its
  candidate loop checked mana and not the life rider, so below the threshold it committed the taps,
  found no cast, and passed — floating the whole pool and wasting the turn at exactly the moment it
  was about to die. Seed 3329123684.
- ✅ **FIXED (AI) — the pilot proposed blocks the rules forbid.** `canBlockByEvasion` in
  `packages/ai/src/heuristic.ts` mirrored core's `canBlock` **minus its protection clause**
  (CR 702.16e), so a white creature kept being assigned to block a Black Knight. One illegal pair
  invalidates the WHOLE `declareBlockers` action, so the engine refused it and the harness passed
  priority after three rejections — **the defender took the entire attack unblocked, every combat.**
  Nothing isolated could see it: the protection tests never asked a pilot to block, and the pilot tests
  never put a protection creature on the other side. `needsMultipleBlockers` was reading `def.keywords`
  bare in the same function, so a GRANTED menace was invisible too. Both fixed; both regression tests
  fail without the fix, with the engine's own message.
- ⚠️ **REPORTED — the rich mana-ability model has no card in the pool.** §3.11's `manaAbilities`
  (a tap cost, a rider, an activation restriction, board-derived colours) is matched by **0 of 357**
  pool cards, so nothing a player can see exercises it. That is rule 10's inert feature; it needs a
  pool regeneration, not an engine change.
- ⚠️ **REPORTED — the redaction guarantee is narrower than it reads.** A buyback spell returns
  itself to its owner's HAND as it resolves, so the public `stackResolved` observation names an
  instance now in a hidden zone. Not an exploitable leak (the table watched that card go back), but
  "no observation ever names a card in a hand or library" is false as stated, and
  `observation.test.ts` passes only because none of its curated matchups plays a buyback card.
- ⚠️ **REPORTED — no maximum hand size.** `RulesConfig` has no `maxHandSize` and the cleanup step
  performs no discard (CR 514.1), so hands grow without bound. Adding it would move every recorded
  win-rate baseline in §3.4a, so it is a decision, not a patch.

**What the merge with the four 2026-08-20 branches showed.** Two things, and the second is a finding
in its own right. First, **the event manifest earned its keep immediately**: `chosenAsEnters` and
`triggerFizzled` were new `GameEvent` members, so `soak-config.ts` stopped compiling until they were
classified — nobody had to remember to widen the soak, the build asked. Second, and worse:
**all four systems are unreachable from the shipped pool.** Measured on the merged tree, the pool is
still 357 cards and prints 0 split/adventure/aftermath cards, 0 modal DFCs, 0 as-enters choices, 0
mandatory additional costs, 0 intervening-"if" triggers and 0 multi-destination searches. The compiler
got wider and the generated pool was never regenerated — §3.20's failure, four systems later. The soak
watches all five and says "not in the pool (not required)" out loud, and will start failing without an
occurrence the day one card appears.

**And two false alarms worth writing down, because both are the harness's own recorded failure shape.**
Asserting state-based actions on a state that is MID-RESOLUTION reports Magma Jet ("2 damage, then
scry 2") as leaving a dead creature on the battlefield — it does, legally, until the scry is answered
(CR 704.3 / 608.2). And scanning an observation against the state the action STARTED from reports every
land drop in the game as a hidden-zone leak. `soak.ts` carries both traps as comments beside the code
that avoids them.
### 3.27 Combat damage, and what the EQUIPPED creature does — ✅ done
The two seams the ~38-card corpus family shares, and they are one idea seen twice: **a trigger has a
watched object, and it is not always the card it is printed on.**

**`TriggerCondition.watches` is a SCOPE, not a new event.** "Whenever equipped creature deals combat
damage to a player" is the *same game occurrence* as the creature's own printed line — a creature
dealt combat damage to a player — watched on a different object. So the vocabulary grew by one
optional field (`'self' | 'attachedHost'`, absent meaning `'self'`), not by an
`equippedDealsCombatDamage` event sitting beside `combatDamageToPlayer`. Two event names for one
occurrence is how a matcher ends up with two answers to the same question, and every existing trigger
is byte-identical data. The scope applies uniformly to the five self-referential events, so
`attacks`, `dies` and the combat-damage line all read it through one `watchedInstanceId` helper.

Three properties, each of which fails silently if it is got wrong:
- **The SOURCE is still the attachment.** A Sword's trigger is controlled by the Sword's controller,
  ordered by the Sword's battlefield position, and its "~ deals 2 damage" means the Sword. Only the
  watched object moves — which is exactly why this is a field on the condition and not a different
  `sourceInstanceId`.
- **Attached to nothing matches NOTHING.** A Sword lying loose on the battlefield has an ability that
  can never fire. A fallback to "watch myself" would be the Sword swinging on its own.
- **The answer is the CURRENT attachment.** The trigger runtime caches one `TriggerSource` per
  permanent and rebuilds it only when the controller or the ability list changes — so a copied
  `attachedTo` would answer with the attachment the Equipment had when it was first seen this action.
  `TriggerSource.permanent` is therefore a LIVE reference (one narrowly-typed field), which is what
  makes an Equipment correct when its host dies to first-strike damage between the two damage steps,
  and when the Equipment itself leaves the battlefield (`resetInstanceForNewZone` nulls `attachedTo`).
  `equipped-triggers.test.ts` changes the attachment between two events of ONE action, which is the
  case a copy gets wrong and nothing else would notice.

**"When equipped creature dies" (Skullclamp) fires because of the state-based-action ORDER**, and the
order is now pinned by a test rather than assumed: the SBA fixpoint checks attachments first and
deaths second, so a pass emits `creatureDied` while the Equipment is still attached and only the pass
after that unattaches it. Reversing those two would make the rule compile a trigger that silently
never fires.

**The compiler.** Six new trigger rules (`combatDamageToPlayer` and `attacks`/`dies` scoped to the
host, each with its "you may" sibling), built on the existing `mayEffects` wrapper through a shared
`optionalTriggerFrom` that compiles only the INNER body — the `trigger-etb-you-may` shape, so a body
that implements its own option is not asked twice. The **assembly refuses a host-watching trigger on
a card with no "Equip {N}"/"Enchant …" line**, for the same reason it already refused a lone
modification: attached to nothing, forever, it could never fire.

**The static half now carries the payload keywords.** "Equipped creature gets +2/+2 and has
protection from black and from green" and "gets +1/+0 and has haste and ward {1}" reach core's
`protectionFrom`/`ward` through `parseProtectionOrWard` — the *same* parser the printed keyword line
uses, so an Equipment and a creature cannot disagree about which forms are real. The conjunction that
separates two keywords is the same word that separates two protection qualities, so the split is
re-joined before parsing. "Protection from instants and from sorceries" (Sword of Wealth and Power)
still reports: core has no check for that quality.

**Both seats, because an Equipment nothing equips is inert.** Two AI defects fell out, and both were
invisible in a win rate:
- the equip search gated on `attachment.modifies`, so an Equipment whose whole text is a host-watching
  trigger (Skullclamp, Sword of the Animist) scored `undefined` and was **never equipped in any game
  ever simulated**. It now gates on `attachment`, and `attachPerHostTrigger` prices the triggers;
- an attacker's value counted the face damage and nothing else, so a Ragavan-shaped 1/1 was priced at
  one point and held back. `attackSaboteurTriggerValue` counts every `combatDamageToPlayer` trigger
  connecting would set off — the creature's own AND the ones its attachments watch it with — in the
  branch where the attack is expected to CONNECT only, since a blocked attacker collects nothing. And
  the walker diversion now sends the *vanilla* at the planeswalker: "combat damage to a player" pays
  nothing there, and two same-size attackers are otherwise interchangeable, which is exactly when
  diverting the wrong one is invisible.

**Measured yield, PAIRED against the merged `origin/main` on the same cached corpus: 485 → 494
playable (23.1% → 23.5%), +9 cards, ZERO regressions** (the two playable sets were dumped and
diffed, not just counted). The nine: Sword of Fire and Ice, Sword of the Animist, Argentum Armor,
Lavaspur Boots, Mask of Memory, Spirit Mantle, Aqueous Form, Akroma's Memorial and Vindicate.
Skullclamp compiles too and is already a pool candidate.

Measured alone at the branch point it was 408 → 421 (+13); four of those thirteen — Corpse Knight,
Marauding Blight-Priest, Poison-Tip Archer, Elas il-Kor — were independently unblocked by §3.21's
step-trigger work while this branch was out, so the paired figure is the honest one.

Gauntlet seed 99 was **byte-identical** to the same-day `origin/main` (81/280, every matchup row
equal) — the shipped pool contains no card of this family yet — and min-of-12 `process.cpuUsage` was
2625 ms on the branch vs 2702 ms on `main`, i.e. parity inside a noise band of ±15% on a box running
ten agents.


⚠️ **A DEFECT THIS EXPOSED, worth more than the feature.** `keywordsParam` — the reader every
until-end-of-turn keyword grant goes through — kept only `=== true` values, so the three PAYLOAD
keywords were silently dropped on the way in: `protectionFrom` is a list, `ward` and `minBlockers` are
numbers. **"Target creature gains protection from red until end of turn" has been compiling
`'complete'` and doing nothing at all**, since the day that rule landed. Its test asserted the compiled
EFFECT REFS and never played the card, which is exactly why the suite stayed green. Widening
`parseKeywordList` to the payload keywords would have routed three more rule-table entries through the
same hole, so the reader is fixed here and the new test resolves the grant through core's own
`applyEffectRef` and reads it back through `indexContinuous` — a hand-built context passes while the
real spell does nothing, which is the shape of the original mistake.

⛔ **Still reported, by name and by clause.** Treasure tokens (Goldvein Pick, Beamtown Beatstick,
Sword of Wealth and Power); **proliferate** (Sword of Truth and Justice, Thrummingbird, Bloated
Contaminator); **"that player"** — the player the damage was dealt to, which no effect can be aimed at
yet (Sword of Feast and Famine, Fallen Shinobi, Nashi); **"that many"** — the damage amount as a
derived value (Cold-Eyed Selkie, Lathril, Gishath, The Key to the Vault); **"to a player or
planeswalker"** and **"or battle"**, which are wider watched-object sets (Psychic Frog, Grateful
Apparition, Beamtown Beatstick); **"up to one target"**, an optional target chosen at announcement
(Sword of Light and Shadow, Sword of Hearth and Home); and the narrowed equip costs ("Equip legendary
creature {3}", "Equip {4}. This ability costs {1} less…"), bestow, reconfigure and living weapon.

⚠️ **The shipped POOL still contains none of these cards**, and cannot until someone runs
`scripts/build-expansion.ts --fetch` — the generator's scratch index is a gitignored cache and the
committed `card-index.json` has none of the Swords in it, so the regeneration is a NETWORK step that
must not run in a gate. Skullclamp is already in `expansion-candidates.json` and now compiles, so the
next `--fetch` picks it up for free. Until then the family is reachable by deck import only, and
`equipped-triggers.test.ts` plays it end to end from real printed Oracle text.

### 3.25 Block requirements + four rules statics — ✅ done
The half of declare-blockers §3.17 deliberately left, and the four standalone rules statics the
coverage audit listed as separate template buckets. One lesson runs through both: **a rule that only
sometimes fires is worse than a rule that reports itself missing**, because the first one lies in a
statistic and the second one shows up in a backlog.

**CR 509.1c/d is a SOLVER, and the previous branch was right to say so.** A block RESTRICTION says
what the defender may not do, and two creatures are all it needs to look at. A block REQUIREMENT says
what they MUST do, and the rule is "satisfy the **maximum possible number** of requirements without
violating any restriction" — a statement about *every legal declaration*, not about this one. So
`internal/block-solver.ts` compares the declaration in hand against the best one available:

- **It is inert when nothing requires anything.** One pass over the attackers reading a keyword, no
  allocation, no board walk, no map — the same empty-check discipline `isLegalTarget` and
  `manaExtrasOf` use. Every ordinary combat in a sim pays exactly that and nothing more.
- **The search is small by construction.** Only the defender's creatures that could block a
  requirement-carrying attacker are enumerated; everything else contributes nothing to any
  requirement and is never considered. The state is the vector of "creatures committed to attacker A
  so far, **capped at the minimum A needs**" — 1 for almost every creature, at most a small printed
  count (menace is 2, Pathrazer of Ulamog 3). A rolling DP over the involved creatures gets the exact
  maximum.
- **The scoring trick that keeps the state that small:** a creature assigned to an attacker that has
  not yet met its minimum scores nothing *yet*, and the whole group scores together the moment the
  minimum is reached. That is precisely what "able to block" means once restrictions are accounted
  for, and it means the state never has to remember counts beyond the minimum.
- **The one bound is written down.** The state space is `2^n` for `n` attackers that each simply
  require a blocker, capped at `1 << 20`; past the cap the solver maximises over the attackers that
  fit and the rest require nothing. Reaching it takes twenty simultaneous requirement-carrying
  attackers, which no card in this pool can print — nothing grants a requirement to a group, and the
  compiler is the gate on what may print one. A limit nobody wrote down is a limit nobody can check.

**"If able" is real, and it is where the two halves meet.** An attacker nobody can legally block
generates no requirement at all; a **menacing lure facing one untapped creature** requires nothing,
because that creature could not legally block it in any declaration. An implementation that checked
the requirement without the restriction would demand an illegal declaration and wedge the combat —
which is why requirements are resolved AFTER restrictions, in the same function, and why that exact
case has its own test.

**Comparing restrictions are a payload, not a flag.** `KeywordFlags.blockRestriction` carries
"except by creatures with haste" (Gingerbrute), a power or toughness bound, and skulk's comparison
against the attacker's OWN power. It is the fourth payload keyword and merges like the other three —
field by field to the strictest of each, because two printed restrictions are both in force. Every
bound reads EFFECTIVE stats through the index `canBlock` already threads: a 1/1 pumped by an anthem
really has stopped being a legal blocker for "power 2 or less", and a skulking creature pumped this
turn really is harder to block.

**The AI blocks through core's own solver.** `forcedBlockAssignment` returns the creatures whose
block was not a free choice, and the pilot assigns the rest as it likes — so the pilot and the engine
cannot disagree about what the rule demands. It matters more here than anywhere else in combat: a
declaration that satisfies fewer requirements than it could is rejected **wholesale**, so a pilot
that picked its favourites first and noticed the lure second would lose every block in the action and
be re-offered the same decision. And **a lure is a threat, not a gift** — `blockRequirementThreatValue`
adds to a creature's effective power when the pilot ranks removal targets, so it kills the 1/1 lure
over the 4/4 bear (and still prefers a 9/9, pinned so a later tuning pass has to decide that
deliberately).

**Four rules statics, each proven twice — once that it compiles, once that the game plays differently.**
That second test is the whole point: a rules static is exactly the shape of feature that can compile
`'complete'` and then do nothing.

- **Changeling** is a definition flag, not a keyword flag, because it is a characteristic-defining
  ability that applies in EVERY zone — a Changeling Outcast in a graveyard is a Zombie there. It is
  answered inside `hasSubtype`, the one funnel every subtype question already goes through, so lords,
  typal searches, the checkland condition and "non-Goblin" exclusions all see it without knowing the
  keyword exists. The non-creature subtype vocabulary is an EXCLUSION list, because that is the half
  that is closed: every set prints new creature types, and an inclusion list would silently stop a
  changeling being a Cephalid the day Cephalids mattered.
- **"This spell can't be countered"** is enforced where a spell actually leaves the stack, never as a
  targeting restriction. The classic wrong implementation makes the spell an illegal target, which
  hands the caster their counterspell back; the printed rule lets Counterspell target Supreme
  Verdict, resolve, and do nothing. One enforcement point means the plain counterspell, "unless its
  controller pays", every modal counter mode and the ward trigger all inherit it. The permanent-side
  printing ("creature spells you control can't be countered") lives in `countering.ts` beside it,
  with its lifetime derived from the board, so destroying the source in response really does work.
- **"You have no maximum hand size"** could not ship as a flag, because ⚠️ **the engine had no maximum
  hand size to lift** — CR 514.1 did not exist. It does now: the cleanup step discards down to
  `RulesConfig.maximumHandSize`, and **the active player chooses which cards to keep**, through the
  same `selectCards` machinery every other "choose N cards" uses (so the pilots, hotseat and online
  already know how to answer it). The turn waits on that answer — accepting it is what calls
  `passTurn` — so nothing ever observes a hand over the limit.
- **"You may play lands from your graveyard"** is `CardDefinition.playLandsFrom`, a list of zones
  rather than a boolean, so Courser of Kruphix's "from the top of your library" is the same field with
  a different value. Playing a land from anywhere is still a LAND PLAY: it costs the turn's land drop,
  needs an empty stack and a main phase, which is why it is a field on the existing action rather than
  a second action kind. The permission is re-derived from the board at play time and never trusted
  from the action, so a hostile client cannot ask its way into its own graveyard.
- Plus the **general enters-tapped condition**: `controlsMatching` over the shared `CardFilter`
  subsumes "unless you control a legendary creature" (the LOTR lands), "a basic land" and "three or
  more other Swamps" in one entry. `CardFilter` grew `legendary` and `basic` — printed SUPERTYPES,
  layer-safe, and reusable by every other filter consumer.

⚠️ **THREE THINGS FOR WHOEVER TOUCHES THIS NEXT.**
1. **The maximum-hand-size rule MOVES EVERY RECORDED BASELINE.** Decks that hoarded cards now discard,
   so the self-play behaviour lock is re-pinned (`packages/core/bench/selfplay-digests.ts`) and any
   gauntlet number measured before this is not comparable. It is a fidelity fix, not a tuning choice,
   but it is not free and it is not silent.
2. **A test helper that only ever passes priority now wedges.** Eleven of them did. A parked question
   outranks priority, so a loop that walks turns has to ANSWER — `defaultAnswerFor(state.pendingChoice)`
   — not only pass. Every helper in the suite does now, which also makes them robust against the legend
   rule and shocklands, both of which could already have hit them.
3. **`cloneState` now always writes `pendingChoice`/`resolution`, even as `null`.** `applyAction` is
   `applyActionInPlace` over a clone, and `selfplay-lock.test.ts` compares the two as SERIALIZED TEXT,
   so the paths must agree on key ORDER. A conditional key diverges the moment a choice survives an
   action boundary — the pure path re-inserts it mid-object while the in-place path appends it — and
   the two states stringify differently while being identical. `createGame` carries the same fields in
   the same place for the same reason. It costs no allocation, and it closed a trap that had been
   waiting for the first rule to park a question during self-play.

⛔ **Deliberately NOT built, each with its blocker named.** The compiler reports them, and the
unsupported hint now names the SHAPE that is missing rather than claiming the whole system is:
- **Tetsuko Umezawa** and **Delney, Streetwise Lookout** — a static whose filter would have to read
  EFFECTIVE power or toughness. `statics.ts` matches PRINTED characteristics by design; that is what
  keeps the continuous pass single-pass with no CR 613.8 layer loop, and an effective-P/T filter needs
  a fixpoint.
- **Champion of Lambholt** — a restriction whose threshold is ANOTHER permanent's power, recomputed
  from its source at declare-blockers time.
- **Fighter Class** ("up to one target creature blocks it this combat if able") — a per-combat
  TARGETED requirement, which is combat state rather than a characteristic.
- **Archangel of Tithes** — a COST to block, which neither a restriction nor a requirement can express.
- **Void Winnower** ("your opponents can't block with creatures with even mana values") and **Odric**.
- **Access Tunnel / Secret Tunnel** — a filtered or two-target aim core's `TargetRestriction` cannot
  express (still §3.17's blocker, unchanged).
- **Typal anthem nouns** — "Other Squirrels you control have menace" needs the anthem rule's noun to
  accept a creature SUBTYPE, and the compiler's subtype tables are closed on purpose (an unrecognised
  word compiled as a subtype is a lord that buffs nothing, silently). It is the natural next step for
  making changeling visible in play, and it is a rule-table edit rather than engine work.
- **"Spells you control can't be countered THIS TURN"** (Veil of Summer) — a duration on a static.
- **"Each opponent's maximum hand size is reduced by seven"** (Jin-Gitaxias) — the mirror of the flag
  this section added, and a different field: it lowers a limit rather than removing one.

**Measured yield:** **+9 playable cards** on the cached 2100-card corpus, measured PAIRED against a
same-box `origin/main` worktree — and the SAME +9 against FOUR successive main baselines as this
branch merged forward: **408 → 417**, **485 → 494**, **510 → 519**, **524 → 533 / 2100**. Four
sibling branches landed in between and each moved the baseline; the delta did not, which is what a
paired measurement is for. **Zero regressions:** the two playable sets were dumped and diffed, not counted.
The nine are Supreme Verdict, Reliquary Tower, Spellbook, Crucible of Worlds, Ramunap Excavator,
Universal Automaton, Changeling Outcast, Gingerbrute and Abandoned Air Temple. It comes from the
solver plus ten rule-table entries — and the +9 UNDERSTATES what closed, which is worth reading before
anyone judges the work by it. Five whole template buckets are now empty (`This spell can't be
countered` 14, `Changeling` 9, `You may play lands from …` 12, `~ enters tapped unless you control …`
9, `You have no maximum hand size` 8 — 52 card-blocks), but most of those cards carry a SECOND gap:
Dovin's Veto still needs "counter target noncreature spell", Abrupt Decay still needs "destroy target
nonland permanent with mana value 3 or less", Minas Tirith still needs an "activate only if you
attacked with two or more creatures" condition. A blocked card is only playable when its LAST gap
closes, so a branch that clears a bucket cleanly can still move the headline by single digits — and
the next branch to close filtered targeting will collect the rest of this one's yield.

**Throughput (rule 7), measured with `process.cpuUsage` and paired against the same `origin/main`
worktree — wall clock on this box is worthless and was not used.** The solver is the one thing here
that could have cost anything, so it was measured directly
(`packages/core/bench/block-requirement-cost.ts`, five interleaved rounds, best-of):

| `illegalBlockDeclaration`, 4 attackers / 5 blockers | cost per call |
| --- | --- |
| `origin/main` — no requirement half at all | 70 ns |
| this branch — ordinary board, nothing requires a block | **133 ns** |
| this branch — one "must be blocked" on the board | 4.9 µs |

The inert path costs **+63 ns per call**, about 16 ns per attacker for two boolean reads, and the
call happens ONCE per declare-blockers action — roughly **+2 µs per game**. It is that cheap because
the empty check rides the keyword read the RESTRICTION check already had to make: one
`effectiveKeywords` per attacker answers both halves of CR 509.1, which is what the fused loop in
`illegalBlockDeclaration` buys. Allocation is at parity too — **582 scavenges over 30,600 actions vs
562 over 29,899** on `origin/main` (0.0190 vs 0.0188 per action). The action counts differ because
the games genuinely differ now: the maximum-hand-size rule adds a discard answer per over-full
cleanup, which is also why a byte-identical gauntlet is not available as evidence for this branch and
the self-play lock was re-pinned instead.

### 3.29 A token keeps its printed face — colour, creature types, token-ness — ✅ done
**Every token in the game entered COLOURLESS, with no creature type, and not knowing it was a token.**
`makeToken` built a `CardDefinition` carrying a name and a P/T and nothing else; `colorsOfDefinition`
reads colour off cost PIPS; a token has no mana cost. So "a 1/1 **black** Faerie Rogue creature token"
and "a 5/5 **red** Dragon token" both arrived as colourless, typeless objects — invisible to a coloured
anthem, to protection from a colour, to "destroy target nonblack creature", to every typal lord and to
every `CardFilter.anyOfColors` query. The cards printing them still compiled `'complete'` and every
test still passed. This is the project's signature failure shape — the card plays as something subtly
different from what is printed — and it predated all recent work: **every** token card in the pool had
it.

**Measured, paired, on the same cached 2100-card corpus against the `origin/main` this merges into:
533 → 545 playable (25.4% → 26.0%), +12 cards, 0 regressions** — the two full playable SETS were
diffed, not just the counts. The shipped pool is 545 cards.

#### The shape
- **`CardDefinition.colors`** — the colour stated in WORDS, for an object that has no pips to read it
  off. `colorsOfDefinition` **prefers it and falls back to pips**, so every printed card in the pool
  still walks its cost exactly as before and nothing that worked changes. An **empty array is
  meaningful**: `[]` is the printed word "colorless" (Third Path Iconoclast's Soldier), absent means
  "read my pips". The reader normalises to canonical WUBRG and de-duplicates, so `['B','U']` and
  `['U','B']` are one answer.
- **`CardDefinition.isToken`**, beside `isEmblem` — on the DEFINITION rather than the instance, and
  for a reason worth keeping: a token definition is MINTED by the effect that creates it and is never
  shared with a card, and `cloneInstance` shares `def` **by reference**, so the flag cannot be dropped
  by the field-by-field clone that has silently lost four fields on this project. There is no line to
  forget. `packages/core/src/token-clone.test.ts` pins both that guarantee and its other half — the
  cloned instance is still exactly the ten-property object it always was.
- **`CardFilter.isToken`** — one tri-state for both printed words ("token" / "nontoken") rather than
  two fields that could disagree.
- **CR 704.5d** — a token that has left the battlefield **ceases to exist**, applied by BOTH
  leave-the-battlefield funnels (core's `moveToZone` and the cards package's `movePermanentTo`)
  through one shared `ceaseToExistIfToken`, and applied **after** the `zoneChange` event so every
  "dies" / "leaves" trigger still fires exactly as it does for a card. Done at the MOVE rather than as
  an SBA pass, because the SBA form would walk both players' graveyards, exiles, hands and libraries
  after every resolution, every draw and every combat-damage step hunting for something that is nearly
  never there. Without it a dead token sat in a graveyard for the rest of the game, inflating every
  graveyard count the engine derives and standing there as a legal target for anything returning a
  creature CARD.
- **`parseTokenFace`** reads the printed descriptor's strictly ordered grammar — **colours, then
  subtypes, then card types** — so "colorless Thopter artifact creature" and "blue and black Faerie"
  are both read exactly. CR 111.3 names a token by its subtype LINE ("Faerie Rogue"), not by the last
  word of it. A descriptor it cannot read completely **refuses the whole clause** rather than dropping
  the part it missed.
- **Typal anthems**, because token creature types with no consumer would be decoration: the anthem
  rule now reads a subtype noun in both printed shapes — "Other **Goblin** creatures you control get
  +1/+1 and have haste" and the bare "**Goblins** you control have haste". The bare form deliberately
  adds **no** card type, because a Kindred Enchantment (Bitterblossom) genuinely IS a Faerie without
  being a creature. Both read the closed `SEARCHABLE_SUBTYPES` table, which is now the compiler's
  subtype vocabulary generally rather than only a search's.
- **The Kindred card type** (CR 308), with its own graveyard type bit, because something counts card
  types and leaving it out would make that count quietly one short.
- **A symmetric anthem** prints no scope tail at all ("Black creatures get +1/+1"), so the tail is
  optional — reading its absence as "you control" would be a strictly better card than the one printed.

#### A second colour reader, found on the way
`passesDestroyFilter` (the `nonblack` half of Doom Blade) walked `def.cost` **itself** rather than
asking `colorsOfDefinition`. That second opinion about what "black" means was wrong twice over: it
could not see a HYBRID pip, and it could not see a printed colour with no cost behind it — so Doom
Blade happily destroyed a black Faerie token the printed card cannot even target. There is now one
colour reader in the codebase.

#### Cards un-reported
Bitterblossom, **Bitterbloom Bearer** (whose token is the two-colour "blue and black" form) and
Ophiomancer — the three the previous branch left reporting *specifically* because of this — plus
Goblin Chieftain, Lyra Dawnbringer, Diregraf Captain, Blood Artist, Falkenrath Noble, Hornet Queen,
Seraph Sanctuary, Harvester of Souls and Soul of the Harvest. Twelve cards this branch is solely responsible for, measured against the main it merges into.

#### Enforced tables
`OBSERVATION_POLICY` classifies the new `tokenCeasedToExist` as **public** — both seats watched the
token hit the graveyard and both watch it stop existing, and its name was already announced by
`tokenCreated`. `paired-arms-config.ts` needed no change: `makeToken` was already classified, and this
branch adds no primitive. `internal/clone.ts` needed no new line, and now says so out loud, because
that is the structural reason token-ness lives on the definition.

#### Throughput (rule 7), measured properly
Wall clock on this box is worthless — a dozen agents run concurrently, and the same build measured
1422 ms and 1907 ms ten minutes apart. Paired `process.cpuUsage`, min-of-5 over the same in-process
gauntlet (Mono-Red Aggro, 40 games, seed 99), branch and main measured back to back: **1875 ms vs
1844 ms (1.02×)**, inside that spread — and an earlier interleaved A/B/A had the branch FASTER than
main (1422 ms vs 1578 ms), which is what "inside the spread" means. The deterministic gauntlet output
is **identical in six of seven matchup rows**; UW Control moves 15/40 → 14/40. That one game is a real
behaviour change, not noise: the hero deck runs Young Pyromancer, whose Elemental tokens are now red
Elementals that cease to exist when they die instead of accumulating in a graveyard the evaluator
reads.
#### Reported by name, not approximated
- **Token COPIES** ("create a token that's a copy of target creature", "except it's a 4/4 black Zombie
  Snake Druid with no mana cost"). This is the copy-effect system; copy effects LANDED while this branch was in
  flight (`copy.ts`, CR 706 layer 1), so the missing half is now only the token-copy PRIMITIVE: a rule
  that reads "create a token that's a copy of target creature", picks a source, and hands
  `copyResultDef` to `ctx.createToken`. The trap it must not fall into is already disarmed — core
  stamps token-ness in `createTokenInState`, so a copy built from `copiableDefOf` (which returns the
  copied CARD and carries no token flag) is still a token.
- **The predefined artifact tokens** (Treasure, Clue, Food) — they print no P/T in the clause and carry
  an activated ability the token rule does not build.
- **A token that enters TAPPED and/or ATTACKING** (mobilize, Anim Pakal, Myrel) — `createToken` has no
  way to express either, so the whole clause reports rather than creating an untapped one.
- **A token count that is derived** ("create X 1/1 Goblins, where X is Krenko's power").
- **"Destroy all nontoken creatures"** (Hour of Reckoning) — `destroyAll` takes no `CardFilter` at all,
  so the token flag has nothing to narrow there; that is a `destroyAll` gap, not a token one.

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

### 3.28 Rules conformance — a CR-indexed suite with an enforced manifest — ✅ done

Every other suite in this repo is organised BY FEATURE, each written by the agent that built that
feature, asserting what that agent believed the rule was. That answers "do our tests pass?" It cannot
answer **"which rules do we actually implement, and which do we only think we do?"** — which is the
difference between a green suite and playing Magic correctly. A rule no feature happened to need was
invisibly absent: there was nowhere its absence showed up.

`packages/core/src/conformance` is that somewhere. **89 tests, each naming the Comprehensive Rules
reference it affirms**, plus a manifest classifying **147 CR sections**: 35 covered here, 42 cited to
an existing per-feature suite, 64 not-applicable *with a stated reason*, and **6 honest gaps** — with
32 of the covered/cited sections additionally declaring an unmet remainder, because "covered" with a
silent shortfall is the exact dishonesty this manifest exists to prevent.

**The manifest is enforced four ways, three of them by the compiler** — the same default-deny shape
as `OBSERVATION_POLICY`, `paired-arms-config.ts` and `KEYWORD_KEYS`, and for the same reason: a
coverage manifest that can be left stale is worse than none, because it reads like an answer.
`RULES_MANIFEST` is a mapped type over the section list, so an unclassified section fails `tsc`;
`CrRule` is a template literal over it, so a citation cannot point out of scope; and
`KEYWORD_RULES` / `STEP_RULES` / `ZONE_RULES` / `ACTION_RULES` are mapped over `KeywordFlags`,
`Step`, `ZoneName` and `GameAction['kind']`, so **adding a keyword, zone, step or action to core
stops the build until the manifest says which rule it answers to.** The fourth is a runtime one: each
file's collected tests must equal the manifest's claims, both directions.

⚠️ **Twenty-four CR citations in this repo were wrong**, in tests AND in engine source comments —
priority is 117 not 116, the mana pool empties in 500.5 not 500.4, copying is 707 not 706, layer 7's
sublayers are 613.4 not 613.3, `115.2b` does not exist. All were corrected against the published
Comprehensive Rules text. An index that cites the wrong rule is confidently wrong.

**The six gaps, honestly** — ⚠️ **two of which have since been CLOSED; see §3.29.** CR 402/514.1 —
*there was no maximum hand size*; nobody ever discarded at cleanup, which changed the value of card
draw in every recorded gauntlet baseline (**closed**). CR 704 — state-based actions were checked at
~a dozen explicit mutation sites, not at the priority boundary CR 704.3 names (latent: every path
that existed then did hit a site), and CR 704.5q's counter annihilation was absent (**both closed**).
CR 613 — there is no layer system, only additive P/T deltas and keyword ORs, which is *exact*
for everything the engine can express and is now held there by a compile-time proof. CR 615/616 —
no prevention effects (`feat/replacement-effects` owns this). CR 707 — no copying
(`feat/copy-effects` owns this). Also recorded as shortfalls on otherwise-covered sections: no
mulligans (103.5), no attacker damage assignment order (510.1a), no block requirements (509.1c),
tokens do not cease to exist (111.7).

**Every claim was sabotage-checked** — the rule broken in the engine, the suite confirmed RED, the
break reverted. **33 sabotages, 33 caught, 0 escapes**, including all four compile-time proofs and
four attempts to corrupt the manifest itself (delete a claimed test, drop a section's
classification, gut a not-applicable reason, empty a gap's description). A test that cannot fail is
this repo's most-recorded defect shape — and four of the four sabotages that first came back GREEN
were bad ANCHORS of mine, not weak tests: one patched a code path the test never enters, one changed
a TYPE (Vitest strips types, so it cannot fail a test), and two named fields that do not exist. That
is worth knowing: **a sabotage that stays green is a claim about your sabotage before it is a claim
about the test.**

**Today's four new systems are indexed too**, each sabotage-checked through its own suite: CR 603.4
(the intervening "if", checked TWICE — a false condition must stop the ability reaching the stack,
not merely fizzle it), CR 709.4 (a split card is the COMBINED object in every zone but the stack),
CR 715.2/715.3d (an adventurer is defined by its creature half; the exile is a RESOLUTION
replacement, so a countered adventure goes to the graveyard), CR 400.7 (a value a permanent NAMED
dies with the object), CR 601.2h (an unpayable mandatory additional cost makes the cast illegal and
leaves nothing half-paid) and CR 310.4 (a defeated Siege's reward cast from an EMPTY mana pool,
which is what makes "without paying" a real claim).

### 3.29 State-based actions at the priority boundary, and what the hand-size rule cost — ✅ done

Two CR-conformance gaps, one measurement, and a hidden-information leak found while reviewing a
third gap that a sibling branch had just closed.

#### CR 704.3 — the game looks whenever a player WOULD get priority

`checkStateBasedActions` was called from about a dozen explicit mutation sites and never from
`onPassPriority`. Every path that existed hit one of the sites, so it was **latent, not live** — but
it is the wrong SHAPE: CR 704.3 makes the answer independent of how the board became illegal, while a
per-site discipline makes it depend on whoever writes the next mutation path remembering. The
interaction matrix recorded it as GAP `sba-on-priority` with a reproduction; a sibling closed the
announcement half (`applyCastSpell`), and this closes the priority-pass half. **Both reproductions
are now positive tests.**

⚠️ **Rule 7 is the whole difficulty.** This is the single hottest loop the sim has — a 280-game
gauntlet passes priority **125,753 times** — and the full check walks the battlefield three times and
can rebuild the continuous index. So the call sits behind `stateBasedActionsPossible`, a gate that is
**conservative in one direction only**: it may say yes on a board with nothing to do (one wasted
check), and must never say no on one that has something (a silently deferred rule).

**The narrowing that made it affordable.** The first gate treated any modifier at all — an anthem, an
until-end-of-turn pump, any `state.continuous` entry — as a reason to run the full check, and let
**6.3%** of those 125,753 passes through. The fix is a piece of reasoning the engine can afford to
make: `PermanentModification` is **purely additive** (the rules manifest pins that as a compile-time
proof), so a modifier that can only ADD toughness cannot kill a creature — it can only keep one
alive. A board whose modifiers are all positive can therefore be judged on printed base plus counters,
which is exactly what `effectiveToughness` with no aggregate computes, and being wrong in that
direction is safe by construction. Only a modifier that can SUBTRACT toughness sends the board to the
real check. Pass rate **6.3% → 0.1%** (7,910 extra full checks → 96).

**What it costs, measured three ways, none of them the wall clock.** ⚠️ A cross-build gauntlet
comparison on this box read anywhere from 1.02× to 1.41× for a change that allocates nothing — that
is noise wearing a result's clothes, and it is why the evidence below is what it is:

| evidence | reading |
|---|---|
| **Allocation** — `scavenge-probe.ts`, nursery pinned at 1 MB both bounds | ON **587 / 584**, OFF **588 / 583** — inside the documented ±2 floor, i.e. **it allocates nothing** |
| **Paired CPU** — both engines in ONE process, 9 interleaved rounds, 8 repeats of 24 seeded games per round, min-of-N | ON **2157 ms**, OFF **2156 ms** → **1.0005×** |
| **Direct cost** — `packages/core/bench/sba-gate-cost.ts` | **~30 ns per permanent**: 125 / 258 / 851 ns at 4 / 8 / 16 permanents. At 125,753 boundary passes on an eight-permanent board, **~30 ms across 280 games** — against a gauntlet costing roughly 1.9 s of CPU |

The workload is **proved** identical rather than assumed: the two arms play the same 24 seeded
self-play games and their digests are compared before any timing is reported.

#### CR 704.5q — the counters annihilate as a STATE-BASED ACTION now

`+1/+1` and `-1/-1` counters were removed in pairs inside the `addCounters` primitive, which is right
for the one route that calls it and wrong for every other. It was **reachable**, which the gap
register had believed it was not: **persist** returns a creature carrying a `-1/-1` counter without
going near `addCounters` — and it wrote a NEGATIVE `+1/+1` tally, so nothing could even ask whether
the creature had a `-1/-1` counter on it, which is persist's own printed condition. The rule now
lives in the state-based-action pass, the primitive no longer does it at all (one implementation of
one rule), and persist writes a real `-1/-1` counter. The arithmetic never moved; what moved is
whether the STATE tells the truth.

#### The CR 514.1 review — and the leak

The cleanup discard landed on `main` from `feat/block-requirements-and-statics` while this branch was
building its own. Reviewed against the brief that owned it:

- ✅ the maximum is a **named `RulesConfig.maximumHandSize`**, not a literal seven;
- ✅ a player **at or under** the maximum is never asked;
- ✅ the pilot discards **by value** through the existing `'loss'` policy — now with that policy
  written out on `answerSelectCards` and four tests behind it, including the one that matters: an
  unbuilt board keeps its LAND and pitches the creature, a built one does the reverse;
- ⚠️ **CR 514.3a was half-implemented.** The madness window correctly kept the turn open, but the
  turn then simply ended. The rule says **another cleanup step begins**. It is now re-entrant, and
  needs no new state: reaching the turn machine's step advance *while the step is still cleanup* can
  only mean a priority window was opened during it. (The rule's two other clauses are unreachable
  rather than unimplemented, and the manifest says why: no `TriggerEvent` watches a card leave a
  hand, and nothing a cleanup step does can make a state-based action applicable.)
- 🔴 **The question named a card in the discarding player's HAND as its source** — `hand[0]`, chosen
  to keep the field a real instance id. `choiceAsked` carries `sourceInstanceId` **unredacted** into
  every pilot's observation feed, and instance ids are minted sequentially from the pre-shuffle
  library, so it published a read on the decklist. The protocol's own leak scan cannot catch it
  either: `collectInstanceIds` only looks at keys named `instanceId`. It now uses
  `NO_ASKING_OBJECT`, the sentinel a source-less question carries.

**The self-play behaviour lock is the proof of exactly that.** Regenerating it moved **only the event
LOG hashes**: every seed keeps its winner, turn count, action count, **event count** and final-state
hash. One field inside one event changed — and putting the old value back reproduces the previous
hashes exactly, which is how the attribution was checked rather than assumed. The unchanged event
counts are the second measurement in there: the new CR 704.3 check **fires nothing at all** across 24
full games, which is what a backstop should do.

#### What CR 514.1 did to the recorded baseline — isolated, not estimated

The rule is a **named config value**, so it can be switched off in the same build, on the same seed,
with the same decks, and nothing else moving. That is the measurement:

| `maximumHandSize` | Mono-Red Aggro, 40 games/deck, seed 99 |
|---|---|
| **999** (the rule OFF — the engine as it was) | **82/280 = 29.3%** |
| **7** (the rule ON — the engine as it should be) | **79/280 = 28.2%** |

**Three games, in two matchups.** Every row is identical except **Golgari Midrange 8/40 → 7/40** and
**UW Control 16/40 → 14/40** — the two grindy decks in the gauntlet, which is precisely where a
hand-size limit should bite and where an aggro deck's opponent was quietly banking cards it could
never have kept. Reproduced across two interleaved rounds, and the win counts are deterministic, so
these are exact rather than noisy.

📌 **Measured twice, and the delta GREW.** Against `origin/main` at `b5752b2` the same isolation read
**81/280 → 80/280**, one game in one matchup. The token-characteristics fix (`ab0e41a`) then gave
every token its real colour and creature types, the grindy decks' boards got better, and the
hand-size rule became worth three games instead of one. Both readings are true of the engine they
were taken on; the second is the current one.

**79/280 = 28.2% is the recorded baseline for seed 99 from here on** (`origin/main` at `ab0e41a`,
which this branch reproduces byte-for-byte, every matchup row equal). It moved because the engine got
MORE correct, not less: an unbounded hand overvalues card draw and held-back reactive spells, which
is exactly the quantity this product exists to measure.

⛔ **CR 704.5b — a SPELL-driven draw from an empty library does not lose the game — is DEFERRED by
decision, not by omission.** It is real, and it stays recorded (`spell-draw-decking`, cited from the
matrix). It was not taken here for one reason: it ends games earlier and therefore moves the gauntlet
baselines again, and measuring it in the same branch as CR 514.1 would produce one number that could
be attributed to neither. It wants its own branch and its own isolation, and the fix belongs in
`packages/cards/src/primitives.ts` rather than in the engine.

**Sabotage-checked: 11 breaks, 11 caught, 0 escapes** — including the one that first came back GREEN
and was the useful result of the whole pass: CR 514.3a's "another cleanup step" had NO test until the
sabotage said so.

### 3.30 The hidden-information guarantee — closing the CLASS, not the two instances — ✅ done

Two agents in a row found a hidden-information leak that the scan owning that guarantee could not
have seen. Both times the instance was fixed and the scan was not, which left the class open. This
closes the class, states what the guarantee actually promises, and deletes one mechanism that turned
out to be asserting nothing.

#### The blind spot: the scan recognised ONE key name

`collectInstanceIds` — the structural "does this message mention that card?" used by the pilot feed,
by the masked online view and by the server's adversarial tests — collected the values of keys named
exactly **`instanceId`**. The engine names cards under **eighteen other keys**: `sourceInstanceId`,
`targetInstanceId`, `keptInstanceId`, `hostInstanceId`, `copiedInstanceId`, `appliesToInstanceId`,
`source`, `target`, `targets`, `attackers`, `attackTargets`, `blocks`, `blocker`, `attacker`,
`instanceIds`, `ref`, `attachedTo`, `recipientIs`, `effectTargets`. Every one of them walked straight
past it — which is why the CR 514.1 cleanup discard could point `choiceAsked.sourceInstanceId` at a
card in the discarding player's HAND, travel unredacted to every pilot, and leave the anti-cheat suite
green. Instance ids are minted sequentially from the pre-shuffle library, so publishing one is
publishing a read on that decklist.

**A key-name PATTERN would not have fixed it either.** "Ends in `InstanceId`" still misses `source`,
`target`, `targets`, `attackers`, `blocks` and `ref` — most of combat and all of targeting.

#### What replaced it: a table the compiler will not let you skip

`packages/core/src/instance-ids.ts`:

- **`EVENT_ID_FIELDS`** — a mapped type over **every field of every `GameEvent`** (67 events, 187
  fields), each classified `'none' | 'id' | 'idList' | 'idKeyedMap' | 'idPairList' | 'answer'`. Adding
  a field to an event fails the build until somebody says whether it can name a card. Verified by
  sabotage in the shape that actually hid last time: an **optional** field added to `tapped` broke
  exactly one file — this one — and nothing else. `CHOICE_ANSWER_ID_FIELDS` does the same one level
  down, for the most card-naming value in the engine.
- **`instanceIdsNamedBy(event)`** — the exact extractor the table drives. It reads BOTH HALVES of an
  id-keyed map (`attackTargets` is attacker-id → attacked object; a scan reading only the values
  publishes exactly half of a leak), and it **throws** on an event type nobody classified rather than
  returning an empty set, because "I checked and found nothing" and "I did not check" must not be the
  same answer.
- **`INSTANCE_ID_FIELD_NAMES`** — derived from those tables, and what the structural walker in
  `@jonny-boi/protocol` now scans by. Classifying a new field as an id extends the walker for free.
- **`instance-ids.test.ts`** re-derives the same set by **reading core's own source**: every property
  in `packages/core/src` whose declared type mentions `InstanceId` must be recognised, and every name
  in the vocabulary must still be declared somewhere. That is the half a type cannot do — `InstanceId`
  is a bare `number`, so no conditional type distinguishes it from a life total, and an id field added
  to a STATE type changes no event at all. It fails on exactly that.

#### What the guarantee actually promises — and the sentence that was wrong

The tempting one-liner is "no observation ever names a card in a hidden zone". **It is not true, has
never been true, and writing it down is worse than the leak it describes**, because the next reader
trusts it.

> An observation names a card only if that card was on **public display at the instant the observation
> was produced.** Equivalently: the feed never reveals the identity of a card the table has not seen.

⚠️ **Hole 2, decided: the event keeps the id.** A buyback spell (Capsize, Elvish Fury) returns ITSELF
to its owner's hand, so the public `stackResolved` names a card that is hidden by the time anyone
looks. `stackResolved` fires while the object is still ON THE STACK — a public zone (CR 405.1) the
whole table watched it reach when it was cast (CR 601.2a) — and the move to hand is a *separate*
`zoneChange` that the policy already anonymises. Dropping the id would leave a pilot knowing **less
than a spectator at a paper table**, which is the opposite failure and corrupts the represented-mana
reasoning in `superhuman-ai-program.md` §35–37. Both the promise and the reasoning now live in
`observation.ts`, not in a commit message.

#### The wider net found a third leak the two known ones did not cover

Over 300 full-pool games with the wider scan: **`continuousEffectExpired` names a card in a hidden
zone, 10 times.** Traced to seed 3246281276, instance #70 — Elvish Fury, bought back into B's hand,
whose until-end-of-turn pump expires at **cleanup, many actions later**, naming
`sourceInstanceId: 70` while the card really is sitting in that hand.

This is what killed the previous rule. The soak scanned "hidden BEFORE the window as well as after",
which is a **one-window approximation** of "the table has not seen it" — and this walks straight
through it. The scan now tracks the ids that have **never once** been anywhere but a hand or a
library. It is deliberately more permissive, and the difference is exactly the cards the table has
already watched; it is not more permissive about the thing that matters, and the CR 514.1 leak is
caught by it unchanged (there is a test that reintroduces that bug and watches the scan fail).

#### One mechanism deleted for asserting nothing

The old scanner carried an exemption — "`stackResolved` may name a bought-back spell". Measured over
200 full-pool games / 457,536 observations, removing it changed **nothing**, and the reason is
structural: a spell sits on the STACK, which is not a hidden zone, for at least one whole decision
between being cast and resolving, so the never-seen rule has already recorded it. An exemption that
cannot fire is worse than none — it reads like the thing keeping the scan honest. Deleted, with a
positive control that pins WHY it is unnecessary: delete the window in which the card was on the stack
and the same three observations are reported.

#### Two copies of the check became one, and the weak copies were the believed ones

The scanner now lives once, in `observation.ts`, used by the soak and by `observation.test.ts`. It had
been written twice, and the copies disagreed in the dangerous direction — the soak's already knew
about buyback and about window timing, while the one in the file whose NAME owns the guarantee knew
neither. `apps/server/src/security.test.ts` carried a **third**, weaker still (it stopped descending
once it matched a key), on the one path where a leak is a cheating vector rather than a biased pilot.
It now imports the shared one.

#### And it runs over decks that PLAY the mechanics

`observation.test.ts` scanned three curated gauntlet matchups. It passed on every build since it was
written and the card list
is precisely why: **no curated deck plays a buyback spell.** It now drives `runSoak` over the
mechanic-anchored generated decks with the leak scan on **every** game, and asserts that every mechanic
the pool prints actually fired — so "the decks never played it" fails the test instead of hiding under
it. Leak sampling went **1-in-31 → every game**: measured, paired in ONE process over the same 90
games (wall clock on this box is worthless), **6,125 ms CPU against 5,845 ms**, about 5%.

#### `maskStateForSeat`: same class checked, no hole found

The online half is the twin chokepoint and the more dangerous one. `packages/sim/src/masking.test.ts`
plays full-pool decks anchored on buyback, madness, mill/scry, flashback/surveil and cycling, and
scans **every** masked seat view and spectator view with the widened net: no card in the opponent's
hand and no card in either library reaches a view, at any depth, under any key name. The chooser's own
`pendingChoice` is lifted out — Thoughtseize showing the caster the victim's hand is the printed card,
not a bug — and the other direction (a non-chooser or spectator seeing any of it) is asserted in the
same pass. Three sabotages confirm it goes red.

**Sabotage-checked: 16 breaks, 16 caught, 0 escapes**, plus one deliberate CONTROL — reintroducing the
CR 514.1 leak *with the old narrow scan restored* comes back **GREEN**, which is the direct measurement
of what the widening buys.

⛔ **Deferred, with its blocker.** The 450-game hunt turned up one unrelated finding: an SBA violation
at seed 4222011655 (`#34 Blood Artist has toughness 0`), in `packages/core`'s state-based-action pass.
It is not a redaction bug, it does not reproduce inside the fast soak's game range, and fixing it here
would put an engine change in a branch whose diff is meant to be readable as one argument. Recorded
for its own branch with a reproducing seed. → **Closed in §3.32**: it was neither the gate nor a
stale toughness but a mutation site with no pass behind it — paying a spell's additional cost — and
the handoff was right, because the fix is an engine change in `applyActionToDraft`.

### 3.35 Blink — exile a permanent you control and return it — ✅ done

Blink was on §3.21's ⛔ named-unsupported list, which meant a Selesnya Blink deck could not exist:
not "played badly", but *unbuildable* — the mechanic had no primitive and the pool had no enabler.
It is now playable end to end, and **`Selesnya Blink` is the ninth sample deck**, selectable in the
online lobby and in the gauntlet.

**The whole mechanic is CR 400.7 taken seriously** — what returns is a NEW OBJECT. That is the
payoff (the enters trigger fires again) and the cost (counters, damage and Auras do not come back;
it returns untapped and summoning-sick), and it is why this is one primitive rather than a card
script. `blinkTarget` composes the package's two EXISTING zone funnels — `movePermanentTo` out and
`putOntoBattlefield` back — rather than opening a third opinion about what a zone change does;
`effect-helpers.ts` already carries a scar comment about the last time those drifted.

One shared funnel gained one option: `putOntoBattlefield` now takes an optional `controller`,
because a card always goes to its OWNER's exile (CR 400.3) while a blink returns it under the
BLINKER's control. For a creature you control but do not own those genuinely differ — which is the
classic way a temporary control effect is made permanent.

**One compile rule unlocked two cards**, because the wrappers already existed: the step-trigger
prefix makes it Conjurer's Closet and the `you may` wrapper makes it optional, while the bare clause
is Cloudshift. The pool regeneration was surgical — exactly 2 cards added, 0 changed.

⚠️ **The pilot half is not optional, and the measurement is why.** With the engine working but no
pilot valuation, Conjurer's Closet blinked **94 times across 20 games** (it is a `you may` trigger,
which the pilot already accepts) while Cloudshift — the one-mana instant doing the same thing — was
cast **zero times**, because an unclassified primitive scores as a "generic spell" and a generic
spell is only offered into an empty stack. A mechanic half-played is worse than one that is absent:
the deck looks functional while its best card rots in hand. Adding the `blink` goal took Cloudshift
to **45 casts** and the deck from **55.9% → 61.9%**.

A blink is priced as *what re-running the target's triggers is worth*, through the same
`valueOfEffects` ruler everything else uses — and it counts the `leaves` trigger too, which is what
makes Thragtusk (leaves: a 3/3; enters: 5 life) the best blink target in the pool by a distance. A
creature with no such trigger scores nothing and is never chosen, so the spell is held rather than
spent blinking a vanilla body.

**Deck-order note that is easy to get wrong.** A gauntlet matchup is seeded by the opponent's INDEX
(`gameSeedFor(baseSeed, i)`), so inserting a deck mid-list reseeds every deck after it. Slotting
Selesnya Blink into the curve order moved UW Control's recorded row from 14 to 12 while changing
nothing about how either deck plays. It is APPENDED instead, and all seven recorded rows stay
byte-identical (12 · 13 · 17 · 7 · 9 · 7 · 14) with an eighth added.

**Still out, named so it is not rediscovered.** The delayed-return half of the archetype —
Flickerwisp, Eerie Interlude, Ghostway, and Charming Prince's third mode — needs DELAYED TRIGGERS
("return it at the beginning of the next end step"), which the engine still does not have.
Ephemerate needs rebound as well, and its blink half also prints "under its **owner's** control",
a wording this rule does not yet match. Teleportation Circle needs "up to one target artifact or
creature". All are left in the candidate list on purpose, so `expansion-report.json` keeps counting
what delayed triggers would unblock.

#### The pinned soak rows broke, and that is the interesting part

Adding two cards re-sampled every generated deck, so **three of §3.33's four pinned rows started
replaying a different match** and their `mustContain` guards fired. That guard worked exactly as its
author intended — it is there so pool churn is a *finding* rather than a silent vacuous pass — but it
left the regressions with nowhere to live: the bugs are still fixed, the positions simply are not
dealt any more. **An 8,000-game hunt with the copy fix reverted did not re-deal the mirror once.**
Re-pinning onto fresh seeds would only buy time until the next card is added.

So a pinned row now carries its own DECKLISTS (`soak-pinned-decks.ts`), and
`replaySoakMixedGame` takes an optional `decks` that wins over the generated pair. Card ids are
Scryfall UUIDs and are stable across churn — only the sampling ever moved. A row is now
self-describing and replays the exact game its bug came from for ever.

⚠️ **This could easily have destroyed the coverage it was protecting**, so it was checked the only
way that means anything: sabotage. Reverting the copy chain walk still turns all three copy rows red
("burned the 6000-action cap", turns 11/20/18), and disabling the CR 704.3 end-of-action check still
turns the SBA row red with its *original* violation text, `#34 Blood Artist has toughness 0`.
`mustContain` keeps earning its place too — it now proves the pinned decklist is the right one,
which is what a copy-paste between rows would break.

📊 The deck is the strongest in the gauntlet at **61.9%** (95% vs Mono-Red, 100% vs Rakdos Goblins —
eight 0/4 walls and a great deal of lifegain), and its bad matchups are real: 27.5% into Mono-Green
Ramp and 37.5% into Izzet Prowess, neither of which cares about blocking. Whether the meta wants a
62% deck is a TUNING question for the integrator, not a correctness one.

### 3.33 The copy mirror — a game that could not end — ✅ done

§3.32 handed off three full-pool soak games that burned the 6,000-action cap without ending
(`gameCanEnd`): seeds **3434778477**, **1390617766**, **113343071**. They are one defect, and it is
**not** the copy-spell engine §3.31 shipped — it is what the pilot thinks a copy is WORTH, plus a
CR 707.10 "may" the engine had quietly made mandatory.

**The position**, verbatim from the instrumented replay — stack bottom-to-top
`[2: Dream Twist, 17: Twincast → 2]`, with a copy of the Twincast resolving above them. That copy
inherits the Twincast's aim at the Dream Twist and may be re-aimed (CR 707.10), and its two
candidates are exactly those two objects. Re-aim it at **17** and it copies the Twincast again,
producing another copy with the same two candidates. Neither 2 nor 17 ever reaches the top of the
stack. The instrumented replay of seed 1390617766 counted **1,891
`spellCopied` events in one game** against 8 `castSpell`s — 1,894 re-aim questions asked, every
sampled answer naming the same Twincast.

**Why the pilot always chose it.** `EFFECT_VALUE.copySpell` priced a copy at `cardValue` of the
copied CARD. A Twincast is a pricier card than a Dream Twist, so "copy the Twincast" outscored "copy
the real spell underneath it" every single time — and the thing it bought was another copy of a
Twincast. The valuation was self-reinforcing.

The fix prices a copy by **what the copy will actually deliver**: the chain is walked to the non-copy
spell it bottoms out at, and each extra link costs `modeCopyChainPenalty`. Copying
`Twincast → Bolt` is therefore worth a Bolt minus one wasted resolution — correctly just *below*
copying the Bolt directly. A chain that leads to a spell already gone from the stack is worth **0**
(it would be countered on resolution, CR 608.2b), and `MAX_COPY_CHAIN_LINKS` stops the walk.

⚠️ **The penalty is not what fixes the loop; the chain walk is.** With the penalty at 0 the three
seeds still pass, because the two candidates then score EQUAL and the tie happens to fall to the
real spell. That is correctness by candidate ordering, and it would come back the day the ordering
changes — so the penalty makes the preference strict, and `copy-chain-pilot.test.ts` asserts
`bolt > mirror` rather than only the configured gap (with the penalty zeroed, `0 === 0` passes while
the loop is wide open).

**The rules half.** `retargetCopy` asked for an EXACT number of targets, justified as "declining is
re-choosing the same object". That holds only while the inherited target is still legal. Once the
copied spell's own target has left the stack it is not offered, and an exact-count question then has
no way to express "leave it alone" — CR 707.10's *may* had become *must*. Worse than forced: with
exactly one other candidate the count made the question auto-answerable, so the engine silently
aimed the copy at the only other copy spell without asking anyone. It now asks with `min: 0` in that
case, and an empty answer keeps the dead aim so the copy is countered on resolution.

**Verified.** All three seeds are pinned in `soak.test.ts` (named by their cards, as that file
requires) and each reproduces in ~200 ms. Sabotage-checked three ways — reverting the chain walk
turns all 4 pilot tests and all 3 pinned seeds red; zeroing the penalty turns 2 pilot tests red;
reverting the CR 707.10 `min` turns the optionality tests red. Gauntlet seed 99 **byte-identical**
at 79/280, rows 12 · 13 · 17 · 7 · 9 · 7 · 14 — no curated deck holds a copy spell, so curated play
cannot reach this code at all. Full suite 5060 passed / 0 failed, `verify` 0.

⚠️ **The deep tier's `gameCanEnd` is now GREEN — 0 action-cap hits in 2,000 games, where it was 3.**
The tier stayed red for a different, pre-existing defect this change made reachable; that is §3.34,
now also fixed.

### 3.52 Pricing the §3.49 ledger — fourteen blind spots opened, and what the yardstick could not see — ✅ done

§3.49 left twenty registered primitives on an enforced unpriced ledger, each scoring the flat
`modeUnknownEffectScore` — the §3.42 class: every candidate ties, the first offered wins, and a
wrapper's nested body is never read. This section prices **fourteen** of them (every pool-reachable
row but one), through the same rulers everything else already uses — `valueOfEffects` recursion,
`cardValue`, `removalValue`, the continuous board index — by **params shape only** (no card names in
`packages/ai`). Highlights of what each price fixes, with the honest caveat stated at the entry:

- **`scry` / `surveil`** — selection deepened per look, CAPPED at a draw's value; an empty library
  prices zero. Surveil deliberately prices *identical* to scry: the graveyard upside needs a synergy
  model this vocabulary does not have, and a guessed bonus is exactly what §3.45 warns about.
- **`addCounters`** — the `pumpUntilEndOfTurn` sign logic (ours/buff, theirs/shrink, lethal shrink =
  removal via `toughnessLeft`) at a new PERMANENT-stat rate (`modeCounterPerStatValue`, between the
  pump that wears off and the Equipment grant), all three printed forms (aimed / `self` / `each`).
- **`ifKicked`** — a WRAPPER that now recurses (§3.49's generic wrapper property enforces it): full
  body when `state.resolution.kicked` says paid, zero when it says unpaid, and
  `kickedClauseValueShare` of the body before the pilot has agreed to pay (the `createTokenCopy`
  "not yet paid for" caution).
- **`exileUntilLeaves`** — the jail aimed as the card is played: an opponent's permanent prices as
  removal, our own graveyard card as a banked half-card (`modeJailOwnYardShare` — Angel of Serenity
  returns it to HAND when she leaves), their graveyard card as the wash it is (the tuck-to-their-hand
  rider cancels the denial), and our own permanent as the self-harm mistake. **`returnExiledByThis`**
  (the release half) prices ZERO — what it would free is written in a cards-package-private stamp
  this package refuses to read, and zero at least stops a release counting as UPSIDE in a blink score.
- **`gainControl`** — theft-for-the-turn at `modeTheftPerPowerValue` per power: above tapping the
  same body, far below killing it. **`grantKeywordToYoursUntilEndOfTurn`** — per body it actually
  reaches, ZERO on an empty board (where the flat constant used to outbid drawing a card).
  **`mill`** — small pressure per card, the near-win (`lethalBurnScore`) when it empties a library,
  negative for self-mill and `modeSelfDeckPenalty` when it would empty our own.
  **`dealDamageToEach`** — `destroyAll`'s two-sided trade gated by `toughnessLeft` per body plus
  `dealDamage`'s face pricing (lethal wins; "each player" charges our life at the `loseLife` rate).
  **`chooseAsEnters`** ZERO (the naming is free; the static that reads it is priced where statics
  live), **`handToBottomThenDraw`** ±selection by whose hand wheels, **`persistReturn`** a
  creature-return floor shrunk by its -1/-1 counters, **`transformRevealTop`** a selection-sized look.

**The "up to N" clamp the prices unlock.** `answerSelectTargets` took `choice.max` targets always —
as good as anything while every candidate tied at the flat constant, and a measurable blunder once
real prices exist (an Angel of Serenity filling "up to three" with its controller's own creatures).
It now takes every target worth more than not aiming, never fewer than `choice.min` —
`answerChooseModes`' exact rule — and keeps the old take-the-cap behaviour when the effects cannot
be priced at all (an unknown ability is probably still doing something: the `modeUnknownEffectScore`
presumption, kept consistent).

**⚠️ `attachToTarget` (42 pool cards) STAYS on the ledger, and that is the measured finding, not an
omission.** The brief-level claim was "42 cards of Auras/Equipment aimed by a pilot that scores every
host identically". The code says otherwise: every live decision that aims this ref goes AROUND the
value table — the 24 Equip activations through `bestEquipPlay` (host-aware: `scoreEquip` +
`equipIsAnUpgrade`), the 18 Aura casts through the `attachment` intent (`biggestThreat` host, the
grant's own sign choosing whose board) — and no pool trigger, mode, or funded activation carries the
ref where `valueOfEffects` would read it. The ref also CANNOT be priced honestly by params shape:
its value IS the source card's `attachment.modifies`, and `EffectValueContext` does not carry the
source. A price here would be dead code wearing a green checkmark; the sharpened ledger row says so,
and the parity sweep holds the row up for re-judging the day a trigger or mode ever carries it. The
five pool-unreachable rows (`createEmblem`, `fight`, `returnChosenToHand`, `wardCounterUnlessPaid`,
`blinkSelf`) stay ledgered unchanged. **Ledger: 20 rows → 6.**

**📊 The yardstick could not see this change — and proving WHY is the finding.** On §3.46's committed
yardstick (`pilot-ab`, new pricing vs the exact pre-§3.52 model as a second registered id, §3.46
protocol #1, 7,200 games): **3530–3530, every one of the nine deck rows EXACTLY level, 3,600 of
3,600 matched slots split, 0 decided, p = 1** — not "no significant difference" but **byte-identical
play**, the same shape as the same-id control. The reason is structural: across all nine sample
decks exactly ONE card (Kitchen Finks, Orzhov) references ANY newly priced primitive, and its
`persistReturn` sits in a dies trigger no decision ever aims. The gauntlet meta simply never
consults these prices. That is simultaneously the strongest possible **neutral-safe** result (the
change cannot regress what it cannot touch) and an honest statement that the nine-deck matrix is
blind to pool-facing pilot improvements — Lab-built decks, imports, and the suggestion engine are
where they bite.

**📊 So the strength proof ran the same committed harness on a deck that DOES consult them**
(`runPilotAb` with a fourth deck built from pool cards — Banisher Priest, Fiend Hunter, Angel of
Serenity, Youthful Valkyrie, Restoration Angel — against three unmodified sample decks, 6 pairs ×
2 orientations × 150 games = 1,800 games, matched seeds):

> **priced 1013 – 768 pre-§3.52** (19 draws) · matched slots **132 A-ahead / 10 B-ahead** of 142
> decided · McNemar p ≈ 0 (< 1e-16) · **VERDICT: STRONGER** · 59.3 games/sec

| deck driven | priced wins | pre-§3.52 wins | priced share |
|---|---|---|---|
| Serenity Jail (the aim-heavy fixture) | 332 | 208 | **61.5%** |
| Mono-Green Ramp | 313 | 234 | 57.2% |
| UW Control | 241 | 208 | 53.7% |
| Mono-Red Aggro | 127 | 118 | 51.8% |

The priced pilot wins driving EVERY deck — including the unmodified sample decks, because the games
they gain are the ones where the OLD pilot mis-aims the jail across the table (its Banisher Priest
exiling its own board is a win handed to whoever is opposite).

**📊 Throughput (the §3.50-era directive: smarter must not mean slower).** Interleaved best-of-5,
one process, 60 games per burst per arm, alternating order so box drift cancels:

| matchup | priced (ON) best / median | pre-§3.52 (OFF) best / median | reading |
|---|---|---|---|
| Mono-Red vs Boros (identical play) | 129.4 / 125.7 g/s | 131.7 / 125.7 g/s | −1.7% best, 0.0% median — noise |
| Selesnya vs UW (identical play) | 59.8 / 58.4 g/s | 60.6 / 58.8 g/s | −1.4% best, −0.7% median — noise |
| Serenity Jail vs Mono-Green (prices ACTIVE) | **52.6 / 51.9 g/s** | 48.2 / 45.9 g/s | ON is **9–13% FASTER** |

The first two rows isolate the pricing layer's pure overhead (their games are byte-identical between
arms): nothing measurable. The third conflates per-decision cost with game length — and lands on the
right side anyway, because correct aiming ends games sooner (§3.45's "longer games, not slower code"
caveat, in reverse). The gate itself costs previously-priced ids NOTHING by construction: the
`priceLedgeredEffects` boolean is read only on a first-table miss. Yardstick mixed run: 72.6 g/s on
a box also running another agent's builds (§3.50 recorded 75.7 quiet).

**⚠️ Recorded seed-99 baselines: UNMOVED, byte-identical** — Mono-Red **257/800**, Selesnya Blink
**615/800**, UW Control **377/800**, Mono-Green Ramp **552/800** (the §3.50 rows exactly), which is
what the byte-identical yardstick predicts: no sample-deck decision routes through the new prices.

**Reproducibility.** The pre-§3.52 value model stays reachable forever as data:
`LEDGER_PRICING_OFF_WEIGHTS` (exported beside `LAND_SEQUENCING_OFF_WEIGHTS`, same pattern) makes
every §3.52 entry score the flat constant again with wrapper bodies unread — so both the strength
and throughput comparisons above re-run in ONE process from a registered second id, any time.

**Files.** `packages/ai` ONLY: `effect-value.ts` (the `LEDGERED_EFFECT_VALUE` table + the one-read
gate + the preset), `weights.ts` (seven named weights, each with its ordering argument),
`choices.ts` (the up-to-N clamp + `countPositive`), `effect-value-parity.test.ts` (ledger 20 → 6,
`attachToTarget` reason rewritten to the measured one), NEW `ledger-pricing.test.ts` (32 tests:
per-entry §3.42-style pairs — right aim wins, self-harm negative, dead aims zero — the Angel of
Serenity real-consumer aim through `answerChoiceHeuristically`, and the OFF-switch contract pinned
in both directions).

### 3.50 The default pilot is now `lookahead` — ✅ done

§3.47 shipped the pilot as a candidate and left the flip as "the integrator's measured call". Taken,
with the measurement re-run rather than inherited: **pilot-ab 3754–3274 over 7,200 games (STRONGER,
McNemar p < 1e-16), every deck row ≥ 51%, 75.7 games/sec mixed** — and the guard test on
`DEFAULT_PILOT_ID` changed deliberately, per its own contract, with the evidence in its body.

Also in this batch: the live hexproof divergence §3.49 pinned (`isLegalTarget`'s two-zone battlefield
half skipped `isTargetableBy`) is FIXED in core, and the `it.fails` pin promoted to a plain test in
the same commit, exactly as the pin's doc demanded.

⚠️ **Recorded seed-99 baselines MOVED with the default** (that is what flipping the default means) —
new rows: Mono-Red Aggro **257/800 (32.1%)**, Selesnya Blink **615/800 (76.9%)**, UW Control
**377/800 (47.1%)**, Mono-Green Ramp **552/800 (69.0%)**. The old heuristic rows remain reproducible
with `--pilot heuristic`.

### 3.53 The whole simulation runs faster — a parallel CLI host, and the engine's event path cut — ✅ done

The goal, sharpened by the user mid-build: **bank enough raw speed to pay for the pilot getting
smarter, and then some.** Two levers, measured separately so that claim stays checkable: a
`worker_threads` host that fans the CLI's grid commands out over cores (multiplies whatever the
single thread does), and profiled single-thread cuts on the engine's hottest per-event/per-action
paths (pays everywhere — CLI, the Lab's Web Workers, Solo).

#### Lever 1 — the parallel CLI host (`--workers`, byte-identical by construction and by test)

The sim's loops were built for a parallel host from the start — every seed and on-the-play
assignment is a function of a game's ABSOLUTE (opponent × game) indices (`RunRange`), which is the
seam the web Lab has fanned out on since §3.5. The CLI never grew that host; now it has one:

- `packages/sim/src/parallel-slices.ts` — the PURE layer: slice plans (`planMatchupSlices`,
  `planPairedSlices`, `planPilotAbSlices`, `planSoakMixedSlices`), the per-slice executors both the
  worker and the tests call, and the mergers that reassemble results **byte-identically** (integer
  counts summed in canonical order; every CI/p-value/verdict computed once at the end by the same
  functions the sequential path calls — `wilsonInterval`, `summarizePairedSwap`, `finishPilotAb`,
  `finishSoak`).
- `packages/sim/src/parallel-host.ts` + `parallel-worker.ts` — the only Node-only files: a
  long-lived worker pool fed one slice at a time from a shared queue (AI game lengths vary hugely;
  over-partitioning per `SLICES_PER_WORKER` keeps the tail from stranding cores). Any worker error
  is fatal to the whole run — a gauntlet quietly missing one slice would print numbers that look
  complete.
- `packages/sim/src/parallel-config.ts` — the policy numbers, none inline: `--workers N` forces a
  pool (capped by how finely the run can usefully be cut); absent, AUTO hires
  `min(cores − 1, units, games/150)` workers and stays sequential when hiring cannot pay for the
  ~1–2 s/worker startup (pool + engine load). `--workers 1` forces the plain sequential path.
- Wired to **`gauntlet`, `match`, `swap`, `pilot-ab`, and `soak`** (the mixed half; the anchored
  half's game indices depend on each mechanic's retry count, so it is sequential by nature and runs
  on the host WHILE the workers boot, hiding their startup). To make the pilot-ab cut shareable,
  `runPilotAb` was refactored into slice → fold → finish (`playPilotAbPairSlice` /
  `foldSliceTallies` / `finishPilotAb`); the sequential runner and the merge run the SAME three
  functions, so they cannot disagree. Both orientations of a pair always live in one slice — a
  matched slot needs both of its games.
- **`suggest` is NOT fanned out** (honest negative): the adaptive search is stateful across rounds
  (`driveAdaptiveSearch` yields round → barrier → round). The CLI would need the web Lab's
  round-by-round host (`apps/web/src/lib/sim/run.ts`, base-slot + variant-slice phases) ported onto
  this pool — mechanical but large, and out of this change's blast radius. The CLI says so out loud
  when `--workers` is passed to it rather than silently running sequential.

**Proof, not promise:** `parallel.test.ts` runs small grids both ways — plan → execute (in
deliberately scrambled completion order) → merge vs. the sequential functions — and requires
`toEqual` AND `JSON.stringify` equality (key order, float bits) for gauntlet, match, swap
(self-swap sanity case included), pilot-ab (control stays EXACTLY balanced; a real contest with an
odd game count merges identically) and soak (mechanics-map insertion order and the PRINTED report
compared). `parallel-host.test.ts` spawns the real pool — the engine had only ever been proven in
browser Web Workers; this is the `worker_threads` proof — and checks byte-identity through actual
threads, warm-pool reuse across batches, and that a worker failure rejects the run loudly. CLI-level
diffs of full outputs (seq vs `--workers N`) come out identical to the byte for every command,
timing line aside. **Seed-99 baselines replayed through the host: Mono-Red 257/800 · Selesnya Blink
615/800 · UW Control 377/800 · Mono-Green 552/800 — byte-identical, sequential and parallel.**

Measured on the reference box (Ryzen 5 5600H — **6 physical cores / 12 threads**, ~7.3 GB RAM,
shared with other agents; quiet window, arms interleaved in one session, BEST of 2 passes per arm
because background load only ever subtracts; default `lookahead` pilot, seed 99):

| command (games) | 1 worker | 2 workers | 4 workers | 11 workers |
|---|---|---|---|---|
| `gauntlet Mono-Red --games 100` (800) | 89.6 g/s | 137 (1.53×) | 149 (1.66×) | 96 (1.07×) |
| `pilot-ab` (7,200, the §3.46 control) | 95.5 g/s | 160 (1.68×) | **236 (2.47×)** | 187 (1.96×) |
| `soak --games 600` (656) | 60.3 s wall | — | 35.1 s (1.72×) | — |

The headline: **the 7,200-game pilot-ab drops from ~75–112 s to ~30 s** (`--workers 4`), control
still EXACTLY 3532–3532 with 3600/3600 slots split at every worker count. Two real walls, with
numbers so nobody re-derives them: (1) **short runs pay the startup** — the 800-game gauntlet is
~9 s of work, so 11 pool loads eat the win (1.07×, WORSE than 4 workers); AUTO's `games/150` cap
exists precisely to stop that hire. (2) **11 workers oversubscribe 6 physical cores** — even on the
long run, 11 workers (187 g/s) LOSE to 4 (236 g/s): SMT siblings and the host fight for the same
execution units, and the parallel soak's total CPU roughly doubles (67 s → 142 s) for its 1.72×
wall win. On this box the sweet spot is `--workers 4`; `min(cores−1, …)` is the DEFAULT, not the
optimum, and the flag is there to beat it.

Worker memory is real: each worker holds its own card pool (~150 MB) — the help text says so, and
on a memory-tight box `--workers 2..4` is the sane call. Progress lines survive parallelism with the
same text (milestones are printed as the cumulative count crosses them; pilot-ab counts a pair done
when its last slice lands).

#### Lever 2 — the single-thread engine cuts (profiled first, then cut; every pin byte-identical)

`node --cpu-prof` over a 400-game seed-99 gauntlet under the default pilot, before → after
(self-time, same workload):

| hot spot | before | after | what changed |
|---|---|---|---|
| `rememberSources` (trigger collector) | 4.6% | 2.3% | re-walked the battlefield on EVERY emitted event to keep the trigger-source set current; now re-walks only on events that can coincide with the set changing — `SOURCE_SET_EVENTS`, a TOTAL `Record<GameEvent['type'], boolean>` classification (the `KEYWORD_KEYS` default-deny shape: a new event type stops the build until classified; the safe direction is `true`). The remaining 2.3% is the per-action construction scan — see the honest negative below. |
| `matchTriggers` + per-event scan | 1.7% | off the profile | a per-event **watch-mask prefilter**: `TRIGGER_EVENT_SOURCES` (in `triggers.ts`, next to `conditionMatches`) declares which event types each trigger kind can EVER match; the collector ORs per-def masks (memoised on the immutable trigger list, `RESTRICTION_MEMO` pattern) and drops non-watched events with one AND. `trigger-event-prefilter.test.ts` fires every condition kind's canonical event through the REAL `conditionMatches` and asserts the matched type is listed — the direction that catches a case rewritten onto a new event type. |
| `stateBasedActionsPossible` (§3.32's end-of-action gate) | 3.7% | ~1.5% | the def-derived half of its per-permanent question (attachment / `*` P/T / shrinking static / legendary / kind / printed toughness) memoised per `CardDefinition` in a WeakMap; the counter-free creature — nearly every permanent — now answers CR 704.5f/g in two integer reads. Staleness impossible: the key IS the identity the answers derive from (a transform swaps to a different def object and simply memoises the other face). |
| `watchedEventTypesOf` (transient) | (new) 1.5% | gone | first draft rebuilt a `Set` per collector; replaced by the integer masks above. Left here because a "fix" that shows up as a new hot line is a finding worth recording. |

Single-thread throughput delta — five rounds alternating BUILDS in one session (arm A = main's
core, arm B = this branch's, rebuilt each swap; 800-game seed-99 gauntlet, sequential): best-of-5
**88.6 → 106.0 g/s (+19.6%)**, medians 76.1 → 96.6; the two cleanest same-round pairs read +13.9%
and +19.6%. Call it **≈ +15–20% single-thread** — the profile deltas above account for it, and it
compounds with the worker multiplier (95.5 g/s × 2.47 ≈ 236 measured). That, plus the four seed-99
gauntlet rows, the `selfplay-lock` full-event-log digests, `match-inplace` exactness pins, the
pilot-ab control identity, the interaction matrix and the soak all green and byte-identical, is
what "faster with no behaviour change" means here.

**Honest negatives** (measured or reasoned, so nobody re-derives them):
- The remaining `rememberSources` cost is the ONCE-PER-ACTION construction scan (the collector must
  know what was on the battlefield at action start for CR 603.6d last-known-info). Killing it needs
  a cross-ACTION source cache keyed on the `GameState`, whose staleness blast radius (any direct
  state surgery between in-place actions goes silently unseen) was judged not worth ~2% on this
  repo's history of silent-trigger bugs. If it is ever attempted: `WeakMap<GameState, cache>` with
  collector write-back, probed by battlefield length + `nextInstanceId`.
- `runMatch`'s per-decision context literal and per-event fan-out loop measure ~3% self but reusing
  the context object would let a pilot that retained it observe mutation — a contract change, not a
  cut. Declined.
- Wall clock on this box swings >2x with other agents' load (30.3/30.3 GB commit was observed
  mid-build); every number above is from interleaved runs in one quiet session, and the profile
  percentages are of the same workload's own total.

#### Files
`packages/sim`: `parallel-config.ts`, `parallel-slices.ts`, `parallel-host.ts`,
`parallel-worker.ts`, `parallel.test.ts`, `parallel-host.test.ts` (all NEW); `cli.ts` (`--workers`
+ async commands), `pilot-ab.ts` (slice/fold/finish refactor, behaviour pinned unchanged),
`soak.ts` (anchored/mixed-range/finish split, behaviour pinned unchanged).
`packages/core`: `triggers.ts` (`TRIGGER_EVENT_SOURCES`, watch masks), `internal/triggers-runtime.ts`
(`SOURCE_SET_EVENTS`, conditional rescan + mask prefilter), `internal/sba.ts` (gate memo), NEW
`trigger-event-prefilter.test.ts`.

### 3.49 The invariant layer — catching the §3.37–§3.45 classes, not the instances — ✅ done

Eight defects across §3.37–§3.45 (§3.40's validator hole, §3.42's two unpriced primitives, §3.44's
four, §3.37's shadowed pool) were each found by a person, and each got a regression test only
AFTERWARDS; ~5,300 tests saw none of them coming. The postmortem shape is identical every time:
**a rule enforced by a PROXY that usually holds** — a validator that usually lists every word, a
value table that usually prices every primitive, "the id is no longer on the battlefield" standing
in for "it left combat". Example-shaped tests cannot see a proxy fail, because every example was
written by someone who already knew the rule. This layer quantifies over the LIVE REGISTRIES AND
POOL DATA instead, so it scales with the data and catches the class without knowing the instance.

- **Restriction-word completeness** (`packages/core/src/targeting-completeness.test.ts`). A
  restriction word has FIVE homes (§3.40's lesson) and the union is a type — invisible at runtime.
  It now has a runtime form: `ALL_TARGET_RESTRICTIONS`, derived from a record pinned by
  `satisfies Record<TargetRestriction, true>`, which the compiler holds equal to the union in BOTH
  directions — chosen over parsing the source, which drifts with formatting, because this list
  physically cannot drift from the type it mirrors (`npm run verify` type-checks). The sweep: every
  member passes `isTargetRestriction`, round-trips through `restrictionOfEffects` (the exact read
  §3.40 broke), and owns a distinct `describeRestriction` string; and on a ZOO board holding a
  candidate of every kind (both trigger origins, both spell kinds, both graveyards, a walker, a
  battle), the enumerator's OFFER set EQUALS the legality check's ACCEPT set for every member and
  every actor — an unhandled word falls to the creature default on one side but not the other, and
  the sets split.
- **Primitive/value parity** (`packages/ai/src/effect-value-parity.test.ts`). Every id the value
  table prices (now exported as `PRICED_PRIMITIVE_IDS`) must be registered; every registered id
  must be priced **or carried on an enforced ledger** (`KNOWN_UNPRICED`, the §3.28 manifest
  pattern — a stale row fails, a silent gap fails). Every primitive referenced ANYWHERE in pool
  data is registered — including refs NESTED inside another ref's params, which `loadCardPool`'s
  top-level validation never walks. And every WRAPPER primitive the pool uses (discovered
  structurally: any param carrying nested refs) must price a rich body differently from an empty
  one — the exact "flat constant, body never read" failure of §3.42.
- **Zone-leave invariants** (`packages/cards/src/zone-leave-invariants.test.ts`). §3.44's three
  rules restated as state invariants over the event log: after any action whose events say X left
  the battlefield — **I1** (CR 506.4) a same-id RETURN is out of combat; **I2** (CR 704.5m/n)
  nothing attached to X before the leave is still attached after; **I3** (CR 400.7) no continuous
  effect from before the leave still targets X, a gain-control-until-end-of-turn included. The
  funnels are DISCOVERED, not listed: every castable pool card is cast — through the engine's own
  offer menu, so the sweep doubles as offer/apply agreement over real casts — at a rigged board
  (an aura'd, equipped, pumped creature; an enchanted opposing creature; a STOLEN creature), at
  sorcery speed (906 casts, 45 distinct leave-causing cards) and, instants only, inside declared
  combat (150 casts, 25), plus the combat-damage death itself. A new leave funnel added to the
  pool is swept the day it lands, and enforced floors keep the sweep from ever passing vacuously.
- **Pool frame integrity** (`packages/cards/src/pool-frame-integrity.test.ts`). Every pool card's
  printed FRAME against the OFFLINE Scryfall index (`data-tools/data/card-index.json`, never a
  fetch): types (front face, or the faces' union for a split card — CR 708.4), subtypes, the
  legendary flag (the legend rule keys on it), power/toughness, loyalty, defense. The §3.44
  "Serra Angel was not an Angel" class closed on every axis, not just the one that bit: a
  hand-authored 4/5 that is printed 4/4 now fails exactly like a missing Angel line.
- **Offer/apply agreement, whole-menu** (`packages/sim/src/offer-apply-exhaustive.test.ts`). The
  soak already proves the action a pilot CHOSE was offered (`checkActionLegality`) and accepted
  (`noRejectedActions`) — one action per decision; both are reused as-is, not duplicated. This
  completes the quantifier: two seeded random-walk games (the blink deck vs the control deck,
  picked by archetype with index fallbacks), and at EVERY decision point EVERY offered action is
  applied, any `actionRejected` a failure — floors enforce >400 decisions and >2,000 menu
  applications so the walk cannot quietly stop playing. The web half of §3.37 gets the same
  treatment (`apps/web/src/lib/decklist/poolAlwaysPlayable.test.ts`): a poisoned import store
  remembering a FAILED verdict for every pool card, and every card must still read playable.

📊 **The acceptance run — each real fix reverted in turn, the generic layer red every time, and no
test naming the bug, the card, or the rule it was written for** (failure messages name cards the
sweeps DISCOVER from data, which is the point):

| # | defect (the fix reverted) | invariant that went red | result |
|---|---|---|---|
| 1 | §3.40 — `isTargetRestriction` loses `triggeredAbilityYouControl` | validator sweep + `restrictionOfEffects` round-trip | RED, 2 tests |
| 2 | §3.42 — `mayEffects` unpriced | registered⇒priced parity AND wrapper-recursion property | RED, 2 tests |
| 3 | §3.42 — `blinkTarget` unpriced | registered⇒priced parity | RED, 1 test |
| 4 | §3.44 — blinked attacker stays in combat | I1, combat sweep (funnel it found: Cloudshift) | RED, 1 test |
| 5 | §3.44 — Aura/Equipment survive the blink | I2, both sweeps (Cloudshift AND Restoration Angel) | RED, 2 tests |
| 6 | §3.44 — until-EOT effects survive; stolen creature handed back | I3, both sweeps — the pump and the gain-control rows both named | RED, 2 tests |
| 7 | §3.44 — ten hand-authored cards lose `subtypes` (the fix's exact hunk reverse-applied) | frame integrity, subtypes axis — all ten named | RED, 1 test |
| 8 | §3.37 — `unsupportedReason` stops asking the pool first | pool-beats-import for EVERY card — 587 flagged at once | RED, 2 tests |

⚠️ **Built the invariants, found two things on `main` — reported, not papered over:**
- **A real offer/apply divergence** (out of this branch's test-only scope to fix):
  `isLegalTarget('creatureOnBattlefieldOrInGraveyard')` answers the battlefield half WITHOUT the
  `isTargetableBy` gate, so an opponent's HEXPROOF creature is accepted by the apply/resolve path
  while the enumerator correctly never offers it — a hand-built action can aim Angel of Serenity's
  trigger at a creature the printed rules protect (CR 115.1c). Pinned as `it.fails` in
  `targeting-completeness.test.ts` with the one-line fix named (route that branch through
  `isTargetableBy`); the pin flips red the day someone fixes it, forcing promotion into the main
  agreement sweep.
- **Twenty registered primitives have no value entry** — 15 reachable from pool refs (`scry` ×29,
  `attachToTarget` ×42, `addCounters` ×19, `surveil` ×13, `mill` ×6, `ifKicked` ×3 — a WRAPPER
  whose kicked body is never read — and nine more). Each scores the flat `modeUnknownEffectScore`:
  the §3.42 blindness, wider than §3.42 knew. Carried on the ENFORCED `KNOWN_UNPRICED` ledger with
  a reason per row; pricing them is `packages/ai` behaviour work, owned elsewhere at §3.49 time.

**What this layer still cannot catch, plainly:** a restriction word implemented with the SAME
wrong semantics in both behavioural homes (the agreement holds; only a per-word semantics oracle
would see it); a priced primitive whose value is wrong in sign or size (parity is presence, not
correctness); leave funnels no pool card can cast at this rig — loyalty-death, the legend rule
(the pool holds no legendary card today), sacrifice-as-activation-cost paths the rig never offers,
and the delayed-return blinks §3.35 deliberately kept out of the pool; and offer/apply holes in
states two random-walk games never visit. Each is named here rather than half-covered.

📊 Rule 7: no engine change — two EXPORT-ONLY runtime lists (`ALL_TARGET_RESTRICTIONS`,
`PRICED_PRIMITIVE_IDS`), nothing reads them at play time, so games/sec is untouched by
construction. The layer's own test bodies total **969ms** (zone-leave 572, offer/apply 249,
targeting 64, web 45, parity 24, frame 15). Full suite, same box and worker settings:
**5295 → 5320 passed** (+25, exactly this layer), 0 failed, 227.4s before vs 207.3s after — the
wall-clock delta is shared-box noise, not a speedup claim. `npm run verify` exit 0
(lint 0 errors · generated-data check · build · 5320 passed / 5 skipped / 0 failed).
### 3.47 The `lookahead` pilot — combat plans searched ahead, at heuristic speed — ✅ done

The user's ask: *"actual smartness without sacrificing speed … looking ahead several possible
turns."* This lands a new registered pilot id, **`lookahead`** — selectable everywhere
(`--pilot lookahead`, the Lab picker, `SELECTABLE_PILOT_IDS`), **not the default** — that is the
unmodified heuristic at every decision except one: the attack declaration, the decision §3.45
measured the heuristic getting wrong. There it runs a bounded adversarial search over attack
plans, each played forward **in closed form** (no state clone, no engine call):

1. **The defender's answer** — predicted with the defending pilot's OWN code
   (`forcedBlockAssignment`, then `pickBlocker` per attacker, same order, same weights), so the
   model and the modelled defender cannot drift. Who dies is `resolveFight`'s answer. This is the
   ALLOCATION §3.45's first rejected build lacked: one wall deters one attacker, never three.
2. **The crack-back** — the model the ⚠️ on `attackIsProfitable` names: after these attackers
   tap, what can their whole surviving board force through the blockers I have LEFT (vigilance
   keeps a body home; my tapped stay tapped through their turn)? A port of the tactical solver's
   greedy prevention bound, so it is a floor, never a guess.
3. **The race** — both clocks after the exchange, saturated like the solver's: the closed-form
   value of just-keep-attacking, which is the several-turns-ahead question in this engine.

The candidate family is `∅` + singletons + greedy prefixes + all-in + toggle refinement —
`O(n²·m)` integer arithmetic once per attack step. A **proven** kill (`lethalAttackers`, exact)
is taken before any forecast runs. Deterministic: no RNG, fixed tie-breaks, and candidate plans
are normalised to the engine's eligibility order so the stable power-sort ties resolve
identically in the model and at the table.

**📊 The verdict, on §3.46's committed yardstick** (`npm run sim -- pilot-ab --pilot-a lookahead
--pilot-b heuristic`, default 7,200 games, default seed):

> **lookahead 3754 – 3274 heuristic** (53.4%, CI 52.2–54.6; 172 timeout draws vs the control's
> 136) · matched slots **361 A-ahead / 100 B-ahead** of 461 decided · McNemar p < 10⁻¹⁶ ·
> **VERDICT: STRONGER** · **7,200 games in 148 s → 48.5 games/sec**, throughput parity with the
> heuristic on the same box and tool (its own control ran 40–52 g/s; single-matchup
> `match --games 100`: **87.6 vs 88.5 g/s = 99%**).

Per-deck, EVERY row ≥ 51%: Mono-Red 56.3 · Boros 55.6 · Rakdos 54.8 · Mono-Green 54.3 · Selesnya
52.9 · UW 52.8 · Orzhov 52.5 · Izzet 51.7 · Golgari 51.1 — a broad-based gain, not an archetype
tilt (compare §3.45's shipped fix: 51.2% overall). The same-id control (`--pilot-a lookahead
--pilot-b lookahead`) is exactly level — the pilot carries no cross-game state.

**⚠️ The honest attribution, measured so nobody re-derives it.** Two more 7,200-game runs in one
process (§3.46 protocol #1):

| arm | result | reading |
|---|---|---|
| ablation (crack-back + race terms ZEROED) vs `heuristic` | 3772–3278 (53.5%), slots 348/81, p ≈ 0 | the PLAN-LEVEL search alone carries the whole measured gain |
| full vs that ablation, head-to-head | **3542–3541** (50.0%), slots 141/138, p = 0.905 | the crack-back/race terms add nothing measurable **on this meta** |

So why do the terms ship ON? They cost nothing (the full model ran 58 g/s, faster than the
heuristic control), and they are the only guard on the catastrophic line §3.45 documented —
tapping out into a proven lethal counterattack — which the unit tests pin on constructed boards
(`lookahead-pilot.test.ts`: same board, heuristic attacks, lookahead holds) but which is
evidently too rare across these nine decks to move 7,200 games. Both readings are true at once:
the guard works where it fires, and it fires rarely. Why does allocation-only WIN here when
§3.45's allocation build lost 1406–1422? Because that build freed attackers with per-attacker
rules inside `attackIsProfitable`; this one compares WHOLE plans (deaths priced by `resolveFight`
on both sides, trample-through, saboteurs) against the do-nothing plan with a threshold — the
plan-level comparison is itself most of the discipline the crack-back was expected to add.

**⚠️ The search family's wall, verified rather than inherited.** `hybrid` on Mono-Red vs Boros,
seed 42, one session: **0.105 games/sec** against the heuristic's 57.8 — ~550× per game (the web
Solo tile's "~1400×" is the right order but ~2.5× overstated on this box). Strength:
`pilot-ab --pilot-a hybrid --pilot-b heuristic --games 2 --seed 7` reads 77–64 (54.6%, CI
46.4–62.6), slots 7/1, **p = 0.077 — INCONCLUSIVE**, and those 144 games took 905 s; the default
7,200-game yardstick would take **~12.6 hours**. §3.4a's recorded 60.0%/120 games is
directionally consistent and remains unproven at yardstick scale — the throughput is why. `mcts`
(claimed 40.8%) was not re-run: the family's wall is established by its stronger member.

**Baselines: nothing moved.** The default pilot is untouched (`DEFAULT_PILOT_ID` still
`heuristic`, pinned); the only `heuristic.ts` change is `export` on five existing combat helpers
so the forecast predicts blocks with the modelled defender's own functions. Gauntlet seed 99
re-measured, byte-identical: Mono-Red **224/800**, Selesnya Blink **575/800**, UW Control
**413/800**, Mono-Green Ramp **537/800**.

**Files.** `packages/ai/src/combat-forecast.ts` (the forecast + `ForecastWeights`, every knob
named data), `lookahead.ts` (the pilot: intercept one decision, delegate the rest),
`combat-forecast.test.ts` + `lookahead-pilot.test.ts` (18 tests: allocation, the crack-back hold
the heuristic gets wrong, the vigilance pair that isolates the model, proven-kill routing,
determinism, shared-instance statelessness, registration), registration in `index.ts`, one
classification line in `packages/sim/src/paired-arms.test.ts` (reads no hidden zone), and the two
data rows in `apps/web/src/lib/sim/pilots.ts` that its own guard test demands for every
selectable pilot — display copy plus the MEASURED relative game cost (1: 48.5 vs 40–52 g/s on
the yardstick, 87.6 vs 88.5 single-matchup). While there: `hybrid`'s tile still says ~1400×; this
branch measured ~550× on its box — the copy is the web owner's to re-measure, not this branch's
to guess. Flipping the default is the integrator's call: the case is 53.4% at parity cost, one
command re-checks it.
### 3.51 Four bug reports from one Solo session — ✅ done

The in-app reporter earned its keep: one evening of Solo play filed four bundles, each with a clip,
a screenshot and the frozen state. All four fixed, each verified live before shipping.

**The information leak (report 210108).** After the human kept their hand, the mulligan flow rendered
the COMPUTER'S seven face-up for the whole `aiThinkMs` delay — the flow was built for two humans
passing a device, and seat B stopped being a human. Fixed structurally: `mulliganPresentationFor`
(pure, tested) routes the AI's decision window to `AiMulliganScreen`, whose props carry a hand
COUNT — the card identities cannot reach the screen that shows during the think delay, so no future
effect reordering can leak them again. Handoffs addressed to the computer are acknowledged before
paint (`AutoReady`, a layout effect). Verified with a 60 ms DOM sampler across the window: 0 faces,
7 backs, then the board.

**Cut-off card names (205937).** A 96px chip squeezed "Angel of Serenity" plus three pips into one
row; no ellipsis rule wins that fight. Hand and mulligan cards now render the FULL card image
(`face="full"`) — the printed card carries its own name and cost, so there is nothing left to
truncate. Chip fallback names (no-art tokens) wrap instead of ellipsizing.

**"Show me the full card" (210026).** One `CardZoomOverlay` serves every play surface: a 🔍 on each
hand/mulligan slot (a SIBLING of the card, never a nested button — a PlayCard with an onClick is
itself a `<button>`), right-click/long-press on the slot, Escape/click/✕ to close, and a readable
text face for cards with no image.

**Drag-to-play in Solo/pass-and-play (210220).** The online board's drag machinery had no online
dependency — it lived in `lib/online` purely for a file claim — so it moved to `lib/play` and both
boards now share it. The drop routes through the SAME `onHandCardClick` chokepoint as a click
(multi-way menus included), re-looking up affordances on drop so a stale gesture cannot fire.
Verified live: ghost, zone highlight, and a Guildgate played (entering tapped) by drag.

### 3.48 A deck with imported cards could not be played at all — ✅ done

The user scanned a Selesnya Blink deck, the builder called it healthy, and every play path refused to
start it: `unknown card "<uuid>" (not in the pool by id or name)` and `deck size 52 is below the
minimum of 60` — the missing eight being two imported cards that silently failed to resolve.

**The seam existed and was never wired.** `importedDefinitions()`'s own doc-comment says it is "for
`loadCardPool({ extraCards })`" — and `hotseatPool()` (the pool behind Solo, pass-and-play, and lobby
validation) passed nothing. So the app imported the card, compiled it, showed it in the browser, put
it in the deck builder, reported the deck healthy in deck health… and then refused to play it. The
chain was complete except for its last link.

The fix is one argument plus a memo invalidation: `hotseatPool()` now loads
`{ extraCards: importedDefinitions() }` and subscribes to the store so a card imported mid-session is
playable without a reload. Unplayable imports still cannot sneak in — `importedDefinitions()` returns
only entries that COMPILED, and `loadCardPool` drops any extra whose id collides with a curated card.

⚠️ **Online play is deliberately the opposite answer.** The server rebuilds decks from its OWN curated
pool and the wire format carries only `{ cardId, count }` — no definitions travel. Validating the
lobby with the local pool would be a FALSE GREEN: ready locally, `invalidDeck` from the server a
moment later, which is the same failure moved somewhere worse. `validateChoiceForOnline` validates
against the curated pool alone, and rewrites `unknown card "<uuid>"` into the card's NAME with a plain
explanation ("one of your imported cards — online play only supports the built-in pool"), because a
bare UUID at the user is how this bug report started.

Pinned by `imported-deck-playable.test.ts` (7 tests): rejected when never imported (the control),
playable once registered, the GENERAL invariant (everything the store calls playable is in the play
pool), failed-compile imports stay out, an import can never shadow a curated id, mid-session imports
invalidate the memo, and online still refuses by name. Sabotage-checked: reverting the wiring turns
exactly the three wiring tests red.

### 3.46 The deck-neutral pilot A/B — the yardstick §3.45 used, committed as a tool — ✅ done

§3.45 built four combat-math improvements, measured them, and shipped **one**. The evidence that
picked the survivor was a deck-neutral pilot A/B — and that harness was ad hoc. It existed for one
afternoon in one worktree and never reached the repo, which meant the decisive evidence for a shipped
decision could not be reproduced, and the next agent to touch the pilot would be handed the very
number that had already fooled two attempts. This section commits it:

```
npm run sim -- pilot-ab [--pilot-a id] [--pilot-b id] [--games N] [--seed S]
```

**Why a gauntlet row cannot answer "is this pilot stronger?"** `runGauntlet` puts the SAME pilot in
both seats, so a gauntlet win-rate is a property of the **meta**, not of the pilot: a change that
suits one archetype tilts the meta toward it while the pilot is also playing the other side of every
game. The concrete case is §3.45's third row. Teaching `attackIsProfitable` the same combat truth as
the block side, then allocating the defender's blockers, took **Selesnya Blink from 71% to 74%** — a
headline improvement by the only number two earlier attempts were judged on — while **losing the
deck-neutral A/B against `main` 1406–1422**. The 74% build is a *worse* pilot that happens to flatter
a deck built out of walls. The gauntlet row and the pilot's strength moved in opposite directions,
and the row is the one that lies.

**The design.** Pilot A plays pilot B over every unordered pair of the nine sample decks (36 pairs),
in **both orientations**, on **matched seeds**:

- orientation 1 — A drives deck one (seat A), B drives deck two
- orientation 2 — B drives deck one (seat A), A drives deck two

Both orientations of a pair run off the same pair seed, so game *i* of one is game *i* of the other:
same decks, same seats, same shuffle, same player on the play. Three confounders then cancel
**exactly**, not on average:

- **Deck strength** — each pilot drives every deck the same games on the same seeds (800 each at the
  default). A pilot cannot profit from being handed the stronger archetype, because it is handed both.
  The per-deck table is printed, because "the change only helps one archetype" is visible there and
  nowhere else.
- **Seat** — each pilot occupies seat A in exactly half the games.
- **On the play** — `onPlayFor` alternates by game index, which the two orientations share, so A leads
  on even indices in one and odd indices in the other. Exactly half, for any game count, odd or even.

**The control is what makes a reading meaningful, and it is an identity.** Run one pilot id against
itself and the two orientations are not merely comparable, they are *the same game* — identical decks
in identical seats with identical pilots and identical seeds. Every slot must therefore split and the
record must come out exactly level. `npm run sim -- pilot-ab` with no arguments **is** that control:
it prints a CONTROL banner, checks the balance, and **exits non-zero if the record is not level**,
because an unbalanced control means the harness is broken or a pilot carries state across games, and
either way every other number on the page is void. Measured on `main`:

> `heuristic` **3532 – 3532** `heuristic` over **7,200 games** (7,064 decisive, 136 timeout draws),
> **3,600 of 3,600 matched slots split**, 0 decided, McNemar p = 1 — `CONTROL OK`. Every deck is level
> on its own row too: Mono-Red 241–241, Boros 339–339, Rakdos 305–305, Izzet 291–291, Golgari 410–410,
> Orzhov 462–462, Mono-Green 518–518, UW 407–407, Selesnya 559–559.

That exact balance is what makes §3.45's 51.2% evidence rather than noise. (§3.45's ad-hoc run
recorded 3546–3546 on its own seeding; the digits are seeding, the *identity* is the point.)

**Statistics: the matched SLOT is the unit, not the game.** A slot is one (deck pair, game index) —
two games, one per orientation. A slot is either **split** (each pilot took one game, or nobody did)
or **decided** (one pilot took both). Decided slots are precisely the discordant pairs of McNemar's
test, so the significance call reuses `mcNemarTest` and `decideVerdict` — the same functions, the same
alpha and the same minimum sample as the card-swap verdict, not a second statistics stack. The
headline game record also carries a Wilson interval, labelled in the output as **descriptive**: games
arrive in matched pairs, so that interval treats as independent things that are not, and the verdict
is built on the slot table instead.

**⚠️ What it cannot do, said plainly.** It compares two **registered pilot ids** (`heuristic`,
`hybrid`, `mcts`, `random`) — not two **builds** of one id, which is what §3.45 actually needed. A
process can hold only one build of `heuristic`. Two protocols work, and the help text and
`PILOT_AB_BUILD_COMPARISON_NOTE` say so at the point of use:

1. **Register the new behaviour under a second id — the exact method.** `AiRegistry.registerPilot` is
   a public seam and a re-registered id replaces the old one, so a working branch can expose its build
   as e.g. `heuristic-next` beside the old one and run `--pilot-a heuristic --pilot-b heuristic-next`
   in one process. Both builds then play the same matched-seed matrix against each other. Delete the
   temporary id before merge.
2. **A common opponent across branches — weaker, but needs no code.** Run
   `--pilot-a heuristic --pilot-b random --seed S --games N` on each branch and compare the shares.
   This assumes strength is transitive through the yardstick, which is an assumption and not a fact,
   and `random` is a poor yardstick besides. A hint, never a verdict.

What does **not** work, and is the trap worth naming: running the same-id control on two branches and
comparing. It is exactly 50% on every branch by construction and carries no information at all.

**Cost.** Default 100 games per pair per orientation = 36 × 2 × 100 = **7,200 games**, measured at
**137.7 s → 52.3 games/sec** (on a box also running other agents' builds, so a floor rather than a
ceiling) — cheap enough to actually be run, which is the difference between a yardstick and a good
intention.
`--games` scales it; the search pilots are three orders of magnitude slower and are not a sensible
default here.

**Scope, and what is deliberately left open.** This landed as `packages/sim` only — a CLI tool and
one exported function, no pilot behaviour touched, no baseline moved. `runPilotAb` is exported from
the package index precisely so the web Lab's inspector can drive it later without a second copy of
the loop; that wiring is unclaimed and belongs to whoever owns `apps/web` next.

**Verified.** `packages/sim/src/pilot-ab.test.ts` pins the control identity (exactly level, every slot
split, `p = 1`), the design's mirror symmetry (exchanging the contestants must swap every column
exactly — the statement that no seat or ordering bias can leak in), the exposure balance, determinism,
and **power**: `heuristic` vs `random` must read STRONGER, or the harness could not detect a difference
it was built to find. Observed at `--games 20`: **1437–0 over 720 slots**, every deck swept.
Full suite **5295 passed / 0 failed** (5 skipped, 266 files), `npm run verify` exit 0.

### 3.45 The pilot could not see deathtouch — ✅ done  *(and two bigger "fixes" that measured worse)*

The question was *why does the heuristic pilot play Selesnya Blink worse than it should* — 71.0% in the
gauntlet, with three weak rows: Mono-Green Ramp 51, Izzet Prowess 54, Orzhov Lifegain 58.

**What was measured first, before anything was changed.** Replaying the exact seed-99 games with the
pilot wrapped in a probe ruled out the obvious suspects: across 100 games it passed its own main phase
**2,241 times and never once while holding a spell `planManaPayment` could fund** — no unspent mana,
no card stuck in hand. What it did do was mis-read combat:

| the pilot's blind spot, per 100 games | Mono-Green | Orzhov | Boros | the other five |
|---|---|---|---|---|
| attacks priced as safe into an untapped **deathtoucher** | 946 | 242 | — | **0** |
| **first-strike** fights scored as trades | — | — | 146 | **0** |
| attackers left unblocked with a legal untapped blocker | 1,416 (4,203 dmg) | 126 | 279 | — |

Zero in every deck that prints none of those keywords, and the counts land on exactly the weak rows.
`attackIsProfitable` and `pickBlocker` both answered "who dies" with the same two lines —
`blockerPower >= attackerToughness` — which is blind to **deathtouch** (CR 702.2b), **first strike**
(CR 702.7b), **indestructible** (CR 702.12b), **marked damage** and **trample** (CR 702.19b). One
predicate, two call sites, four rules missing. `combat-math.ts` is that predicate written once.

⚠️ **Only the BLOCK decision uses it, and the other three-quarters of the obvious fix are recorded
here because they were built, measured and rejected.** The yardstick is a **deck-neutral pilot A/B**
— since §3.46 a committed command, `npm run sim -- pilot-ab`, rather than the ad-hoc script it was here:
for all 36 pairs of sample decks, new-pilot-on-X vs old-on-Y *and* old-on-X vs new-on-Y on the same
seeds, so deck strength and seat cancel. Its control (main vs main) is exactly **3546–3546** over
7,200 games, which is what makes the rest of the column readable:

| build | deck-neutral A/B vs `main` | what it did to the gauntlet |
|---|---|---|
| **block side only (shipped)** | **3627–3455 = 51.2%** (p ≈ 0.04) | Selesnya 568 → 575, Mono-Red byte-identical |
| + the same fix in `attackIsProfitable` | 1400–1395 = 50.1% | **Selesnya vs Mono-Green 51 → 27**, draws 10 → 29, 43 g/s |
| + allocating the defender's blockers | 1406–1422 = 49.7% | Selesnya → 74%, draws → 1, 63 g/s |
| + "damage prevented" as a block BONUS | 1343–1484 = 47.5% | Selesnya → 74%, Mono-Green-as-hero −40 |

**The gauntlet row and the pilot's strength moved in opposite directions, and the row is the one that
lies.** Both seats run this pilot, so a change that suits one archetype tilts the meta instead of
raising the ceiling — the 74% build is a *worse* pilot that happens to flatter a deck built out of
walls. Teaching the attack decision the truth is correct in isolation and makes both seats refuse
every attack into a Deadly Recluse, at which point the board locks and the lab collects timeout draws;
allocating blockers un-stalls that and then loses, because freeing marginal attackers taps out a pilot
with **no model of the crack-back**. That model, not another pass at the predicate, is the honest next
step, and the ⚠️ on `attackIsProfitable` says so at the call site.

**What shipped** is `resolveFight` in `pickBlocker` plus one weight, `blockTrampleLeakPerPoint`, which
prices trample overflow as a PENALTY on the body chosen — never a bonus for blocking, so it can only
change *which* block is made and never *whether*. The bonus form is the 47.5% row above: a wall that
chump-blocks is a wall that is not there next turn.

📊 Selesnya Blink **568 → 575/800**, Mono-Green Ramp row 51 → 52, Orzhov 58 → 63, Golgari 69 → 72,
Boros 72 → 70, and Izzet Prowess **unmoved at 54** — that row has no keyword this touches and remains
unexplained. ⚠️ **BASELINES MOVE for two decks**: Mono-Green Ramp as hero **491 → 537/800** (it finally
blocks with its own Deadly Recluse) and UW Control **426 → 413/800**. Mono-Red Aggro is **byte-identical
at 224/800**, which is the shape of the whole change: **224 of 433,776 decisions differ, and every one
of them is a block declaration.** Throughput at parity — deterministic engine actions +0.05% (Mono-Red)
to +3.5% (Mono-Green), which is slightly longer games rather than slower code.

### 3.44 The blink audit — three rules that only an id could break, and a type line nobody checked — ✅ done

A card-by-card rules-fidelity audit of **Selesnya Blink**: all 16 distinct cards fetched fresh from
Scryfall and compared, printed line by printed line, against what the engine actually *does* with
them in a played game.

**The 16 cards play as printed.** Thragtusk fires both halves and one blink collects both (5 life
*and* a 3/3 Beast); Conjurer's Closet triggers on its controller's end step and sits still on the
opponent's; Wood Elves' Forest arrives UNTAPPED (the printed card does not say tapped); Eternal
Witness offers every card type, not only creatures; Attended Knight's token is a 1/1 **white**
Soldier; Restoration Angel has flash — it is castable on the opponent's turn where a creature
without flash is not. The lands, the walls and the lifegain creatures are exact.
`fidelity.test.ts` already re-compiles every pool entry from its Oracle text, so the *definitions*
were never in doubt; this audit asked the other question — **does the engine then play them as
printed** — and that is where it found things.

**Three defects, one root cause.** The returned card keeps its INSTANCE ID. That is deliberate (a
blink is not a new card, and every id-keyed reference in the state has to stay sound), but three
rules in this engine were enforced *purely* by an id ceasing to be on the battlefield, and a blink is
the one effect that puts the id straight back before any of them can look:

| what leaked | what it looked like at the table |
|---|---|
| **CR 506.4** — removal from combat | a blinked ATTACKER still connected for full damage **and** came back untapped. Cloudshifting your own attacker in response to removal was pure profit — strictly better than the printed card. A blinked BLOCKER dealt its damage back too. |
| **CR 704.5m/n** — the attachment SBA | an Aura stayed on a creature it had never enchanted, and an Equipment stayed equipped, because `isLegallyAttached` asks "is the host still on the battlefield?" and after a blink the answer is *yes*. |
| **CR 400.7** — floating continuous effects | a Giant Growth survived the blink; so did a "gain control until end of turn", so blinking a **stolen** creature handed it BACK at end of turn — the exact opposite of what §3.35 built the `controller` seam for. |

`blinkOne` now says all three explicitly, immediately after the leave funnel has emitted its
`zoneChange` (so every `leaves`/`dies` trigger still sees the board it left — the same ordering
`ceaseToExistIfToken` relies on). The rules themselves live in core, next to their neighbours:
`combat-removal.ts` (new), `attachments.unattachDependentsOf`, and
`continuous.dropContinuousEffectsFor`.

⚠️ **`combat.attackers` and `combat.blocks` are the DECLARATION and are never rewritten.** Removal is
a live OVERLAY (`CombatState.removedFromCombat`, optional and normally absent) because other rules are
read off the declaration: "was this attacker blocked?" comes from `blocks` alone, so deleting a
removed blocker's entry would silently promote its attacker to **unblocked** — the opposite of
CR 509.1h. Every attacker-side read goes through one accessor, `attackingCreatureIds`, which returns
the declared array itself when nothing was removed so the damage hot path allocates nothing.

Only the LINK is broken for attachments: what each one then does about it — an Aura to its owner's
graveyard, an Equipment merely unattached — stays the `whenIllegal` data the SBA already reads, so
there is exactly one place that decides the consequence.

#### A fourth defect, from the other end of the same card: Serra Angel was not an Angel

Auditing Restoration Angel's "target **non-Angel** creature you control" meant asking what the
engine thinks an Angel is. The restriction is right — it reads the type line through `hasSubtype` —
but **ten hand-authored cards in `data/pool.ts` carried no subtypes at all**, and one of them is
Serra Angel. So the printed exclusion silently did not apply to it: Restoration Angel could blink a
Serra Angel, which the card forbids. §3.41 swept the Angel type 32 deep through the *generated*
pool and this one sat in the curated file the sweep never looked at. The same hole hid a Goblin from
Goblin Chieftain, a Snake from Ophiomancer's intervening "if", and an Elf, a Bird, three Humans, a
Lhurgoyf and an Ouphe from anything that will ever ask.

⚠️ **The audit could not see it, and that is the part worth remembering.** `fidelity.test.ts`
compares a *behaviour signature* — effects, triggers, activated abilities, modes — and says so:
frame data is "covered by the compiler's own ground-truth suite". But that suite tests the
COMPILER, not a definition somebody typed by hand, so a hand-authored frame had no guard at all.
The pool audit now also asserts every card's printed subtypes, front face against the index, which
is what makes this a closed class rather than ten fixed cards.

**Sabotage-checked, one line at a time.** Commenting out each of the three blink calls turns exactly
its own two tests red and nothing else: `removeFromCombat` → the attacker and blocker tests;
`unattachDependentsOf` → the Equipment and Aura tests; `dropContinuousEffectsFor` → the pump and the
stolen-creature tests. Deleting Serra Angel's `subtypes` turns the new type-line guard AND the new
Restoration Angel case red. Full suite **5217 passed / 0 failed** (5 skipped, up from 5201 on
`main`), `npm run verify` clean.

**Nothing measurable moved.** Selesnya Blink's gauntlet at seed 99 is byte-identical to `main` —
58 · 43 · 57 · 32 · 38 · 34 · 31 · 51, overall 344/480 with 6 timeout draws — which is the expected
shape: none of the four defects is reachable by a curated deck. Only a blink into combat, an
attachment or a theft can see the first three, and no gauntlet list runs an Aura or Act of Treason
alongside Cloudshift; the subtype fix needs a typal payoff on the same board as one of the ten
curated cards. Throughput is unchanged (3 interleaved 300-game runs: `main` 30.1/33.5/28.8 games/sec,
branch 31.0/29.0/35.1) — the overlay costs one property read when it is absent, which it always is
outside a blink.

### 3.43 Solo play — a tile for playing the computer — ✅ done

A third tile on the Play tab: **Solo (vs the computer)**, with a picker for WHICH pilot you face —
Heuristic, Hybrid, MCTS or Random, the same four the Lab tests decks with, carrying the same blurbs
and relative-cost hints.

**Built on the seam that was already there.** `SeatTransport` was documented from the start as the
place a non-hotseat mode plugs in, and solo needs exactly two answers from it: `localControls` is true
only for the HUMAN seat (so the pilot's hand is hidden by the same masking an online opponent gets,
with no new hiding logic), and `requiresHandoff` is always false (there is no device to pass).

⚠️ **ONE game component, not a solo fork.** `LocalPlay` takes an optional `ai` config. The two modes
differ in three places — which transport, whether the handoff interstitial appears, and who supplies
seat B's actions — and every other line (mulligans, board, log, rematch, concede) is identical. A
forked `SoloPlay` would have been a second copy of all of it, drifting the first time either was
touched.

**The driver is deliberately thin**, because the engine already presents every AI decision the same
way: a parked question arrives as an `answerChoice` in `legalActions`, exactly as it does for the
headless sim's match loop. So one "ask the pilot for a legal action and submit it" covers casting,
combat, and every card that stops to ask something — rather than a branch per situation that would
drift from how the sim plays the same board. A rejected AI action falls back to passing, the one move
that always advances the game (the same guard `match.ts` keeps, for the same reason).

Seeded from the game seed, so a solo game replays identically — using core's `Rng` rather than a
second generator, since only one of them would be the one the sim uses. `aiThinkMs` is a named knob:
without a pause the pilot resolves its whole turn between two frames and the board appears to
teleport. The computer always KEEPS its opening hand: pilots decide in-game actions, not whether to
ship a seven, so it does not pretend to a judgement it does not make.

Verified in the browser end to end: no handoff screen, the computer's hand hidden behind card backs,
and by turn 5 it had played lands, cast Savannah Lions and Youthful Knight, attacked, and put the
human on 18.

### 3.42 The pilot could not price "you may" — ✅ done

Found by asking a narrow question honestly: *are all 60 cards in Selesnya Blink functional?* They are
— every card resolves, every primitive is registered, and 40 games cast Cloudshift 63 times,
Conjurer's Closet 30 and Restoration Angel 27. But the same measurement showed **171 cards exiled and
only 161 returned**, and the missing ten were the deck's OWN TOKENS: 9 Soldiers and a Beast, blinked
and destroyed (CR 111.7 — a token in exile ceases to exist and nothing returns it).

**The cause was not blink.** `mayEffects` — "you may &lt;body&gt;" — had **no entry in the AI's value
table at all**. An unpriced primitive scores the flat `modeUnknownEffectScore`, and the nested body is
never looked at. So a pilot AIMING an optional trigger scored every candidate identically and fell
through to the FIRST one offered; Conjurer's Closet ate its own Soldier token while a Thragtusk stood
next to it. Ten pool cards route through `mayEffects`, so this was never a blink bug.

Two entries added, both recursing through the same `valueOfEffects` ruler:
- `mayEffects` — worth exactly what its body is worth. Safe in both directions: declining is answered
  elsewhere, so pricing the body cannot force a bad "yes", it only lets the pilot tell candidates apart.
- `blinkTarget` — priced by what re-entering re-triggers (both halves: Thragtusk's leave AND its
  enter). Deliberately NOT routed through `againstTarget`, which penalises aiming at your own board —
  backwards for an effect whose whole point is your own permanents. ⚠️ A TOKEN is priced as a LOSS.

📊 **Tokens blinked away: 10 per 40 games → 1.** Selesnya Blink's gauntlet **63.0% → 71.0%**
(non-overlapping CIs: 59.6–66.3 vs 67.8–74.0), biggest against Mono-Green Ramp (33→51) and Orzhov
Lifegain (41→58). ⚠️ **This MOVES recorded baselines** — Mono-Red is unchanged (224/800) but UW Control
shifts 434→426/800, because its opponents now play their optional cards better.

⚠️ Three fixture bugs while writing the test, each making it disagree with the game for a reason not
in the code under test: a hand-built ETB that omitted the printed `who` param, and a state with an
EMPTY LIBRARY (which prices any draw as decking yourself). The test now uses REAL pool cards and a
real library.

### 3.41 Angel of Serenity, and the Angel type swept — ✅ done

The last card §3.38 left blocked, and the two engine gaps it stood on.

**Multi-target triggers.** Trigger targeting was single-target everywhere:
`TriggeredAbility.targets` named ONE restriction and the engine asked for exactly one. Angel of
Serenity wants "up to three". The fix is small because the engine was already asking a `selectTargets`
choice to aim a trigger — it was just hard-coded `min: 1, max: 1`. `targetCount?: {min, max}` on the
ability now drives it, absent ⇒ exactly one, so no existing trigger changes. **Targets are still
chosen as the ability goes on the stack (CR 603.3d)** — this asks for a range, it does not defer the
choice to resolution.

⚠️ `min: 0` is what makes "UP TO three" different from "three": with no legal targets the ability must
STAY on the stack and resolve doing nothing, where a must-target trigger is removed. Removing it would
silently delete the rest of its text.

**Multi-zone targets.** `creatureOnBattlefieldOrInGraveyard` — the pool's only target list spanning
two zones. One restriction, not two, because "up to three" is three in TOTAL across both. Both
graveyards are in scope: the card does not say "your". A graveyard card is NOT a permanent, so
`exileUntilLeaves` grew a second path — the battlefield leave-funnel does not apply to it.

📊 **The Angel type swept**: every modern-legal Angel offered to the compiler, **6 → 32 playable** —
Avacyn, Akroma, Archangel of Thune, Lyra, Gisela, Angel of Despair, Emeria Angel and the rest. 143 of
the 169 candidates are still rejected, and that is the honest number: they need ~71 DISTINCT templates
between them, a long tail rather than one task.

⚠️ Gauntlet seed 99 byte-identical (224/800) — 26 cards entering the pool must not, and did not, move
a curated-deck baseline.

### 3.40 The pilot pays for its own abilities — ✅ done

Two independent bugs stood between Strionic Resonator and being a real card, and §3.39 named only one
of them — wrongly.

**Bug 1: a one-line hole in a validator.** `isTargetRestriction` is the guard `restrictionOfEffects`
consults before it will believe a `targets` param. The new `triggeredAbilityYouControl` word was added
to the union, the legality check, the enumerator and the description — and not to the validator. So
the restriction read back as `undefined`, the engine offered the activation **never**, and the pilot
scored the ability **zero**. §3.39 measured that as "122 opportunities, 0 offers" and concluded the
pilot could not plan mana. The measurement was right and the conclusion was wrong.

⚠️ **The lesson is the shape, not the line.** A restriction word has FIVE homes — union, validator,
`isLegalTarget`, `enumerateTargets`, `describeRestriction` — and missing the validator fails SILENTLY
and looks exactly like an AI that is not clever enough. If you add a restriction, grep for an existing
one and confirm five hits.

**Bug 2 (real, and the one §3.39 guessed at): the pilot never floats mana for an ability.** The engine
offers an activation only once the pool ALREADY covers its cost, and the pilot never taps
speculatively — so every mana-costed activated ability was invisible to it. `bestEquipPlay` had solved
this for Equip alone, with a comment saying exactly why. `bestFundedActivation` generalises it: walk
the battlefield, score with `valueOfEffects` (the same ruler loyalty, modal spells and triggers use),
fund with `planManaPayment`, emit the next tap or the activation.

Both fixes were needed — with only the validator fixed, `trigger-copy` still reported inert.

The old comment said other abilities were "left unused until they can be scored honestly". This is
that ruler rather than a guess, and an ability it cannot price still scores 0 and still goes unused.
Loyalty, Equip and land-fetch keep their own scorers; two paths bidding for one ability would
double-count it.

📊 **Gauntlet seed 99 byte-identical to main** on both Mono-Red Aggro (224/800) and UW Control
(434/800, 53 timeout draws) — every row, not just the total. The curated decks hold no ability this
path can price, so the new behaviour appears only where such cards exist. `trigger-copy` is now a
registered, FIRING soak mechanic.

⚠️ Its loop-draw test was rewritten too: the first version pinned a soak seed where the heuristic
walked into the Dualcaster/Rite loop, and this very change made the pilot WIN that game instead. A
test that goes red because the pilot got better was measuring the wrong thing — it now pins the
mechanism and the boundary, and asserts only that the copy-mirror board TERMINATES.

### 3.39 Copying a triggered ability, and a game the rules end — ✅ done

Strionic Resonator: "{2}, {T}: Copy target triggered ability you control." The stack holds two kinds
of object and only one of them was copiable. A trigger is already the resolved shape of an ability —
a controller, a source, effect refs and its targets — so copying one is copying that record, which is
why it lives beside the spell copier rather than inside it (the two share no field but an id and a
controller).

**Adding one card to the pool turned the soak red, and the card was not in the failing game.** The
anchored decks are a pure function of the pool, so a 529th card reshuffles every one of them — and the
new pairing dealt **Dualcaster Mage + Rite of Replication**, which is a genuine MANDATORY infinite
loop in paper Magic: neither half is a "may", so no player can decline their way out. It made 2,138
tokens and burned the 6,000-action cap.

⚠️ **The rules already answer this and the engine did not.** CR 104.4b — "if the game somehow enters a
loop of mandatory actions, repeating a sequence of events with no way to stop, the game is a draw."
`SimConfig.maxActionsPerTurn` (2,000 — two orders of magnitude above a real turn) ends such a game as
`{kind: 'loop'}`, which is deliberately NOT `'timeout'`: a timeout means "we gave up and the verdict is
suspect", a loop means "the rules end it here". The soak counts loop-draws and prints them rather than
failing on them — legal, but a rising count is a finding.

⚠️ **This is NOT the §3.33 copy mirror.** That loop produced nothing and was fixed by pricing a copy by
its payload. This one produces a real 2/2 every iteration, so the valuation is right to like it; what
is missing is any way to stop. Do not "fix" it in the pilot.

~~**Known gap: the sim pilot cannot use Strionic Resonator.**~~ **CORRECTED in §3.40 — the diagnosis
here was wrong.** The measurement (122 opportunities, 0 offers) was real, but the cause was not the
pilot's mana planning: `isTargetRestriction` had never been given the new restriction word, so
`restrictionOfEffects` answered `undefined`, the engine never offered the activation and the pilot
scored it zero. A missing line in a validator, wearing the costume of an AI limitation. See §3.40 —
and note that "measured, not assumed" was true of the SYMPTOM and said nothing about the CAUSE.

📊 Pool 528 → 529 compiled.

### 3.38 Exile-until-this-leaves, and imports that never re-compile — ✅ done

A deck builder reporting six cards unplayable. Four of them now play; the fix has two halves and the
first one matters more than the cards.

**Imports were a CACHE that never expired.** A failed import stored the compiler's verdict from the
day it was imported, and nothing ever revisited it — so every template added from here would have had
a dead zone: the card stays broken in your deck until you think to delete and re-import it.
`Cloudshift` demonstrated it, still reading "needs a filtered-targeting template" a whole release
after §3.35 shipped the rule that compiles it. Failed entries are now re-compiled once per session on
load, so a template landing today fixes a deck imported last month. Cheap by construction — only
failed entries, only once, and a card that still does not compile keeps its reasons intact.

**The O-Ring system** (`exile-until-leaves.ts`) — "exile target creature an opponent controls until
this creature leaves the battlefield". Two printings, one machine: Banisher Priest folds both
abilities into one sentence (so that compile rule emits TWO triggers from one clause), while Fiend
Hunter prints them separately and compiles through the existing `trigger-leaves`.

⚠️ **The link is the mechanic.** The exiled card records WHO exiled it, not the reverse — two jailers
on the battlefield have each taken their own prisoner, and killing one must return exactly its own. A
"return everything in exile" implementation passes the obvious test and fails that one, which is why
the two-jailer case is pinned and sabotage-checked.

⚠️ **"ANOTHER target creature" is load-bearing, and is now a FLAG rather than a fourth one-off
restriction.** Let Fiend Hunter name itself and it exiles itself → leaves → returns itself →
triggers again, unbounded (§3.33's shape). §3.37 warned against adding more `nonSomethingSomething`
members to the restriction union, so "another" is `TriggeredAbility.targetsExcludeSelf` — orthogonal
to the restriction, applied once where candidates are enumerated and again in `isLegalTarget`,
because §3.36 is what happens when those disagree.

Two new restrictions were still needed for the printed lines: `creatureAnOpponentControls` (Banisher
Priest) and `artifactEnchantmentOrLand` (Acidic Slime). Both are type-shaped rather than
adjective-shaped, which is the axis the union is actually good at.

**Still blocked, honestly:** `Angel of Serenity` targets "up to three other target creatures from the
battlefield **and/or creature cards from graveyards**" — multi-zone targeting the engine has no
vocabulary for. `Strionic Resonator` copies a TRIGGERED ABILITY, which is a copy system for stack
objects that are not spells. Both are real engine work, not templates.

📊 Pool 524 → 528 compiled (surgical: 4 added, 0 changed).

### 3.37 Restoration Angel, and a curated card reported as broken — ✅ done

Two user-facing defects from one report: a deck builder showing **"⚠ 10 cards not playable"** over a
list that included `Thragtusk`, `Cloudshift` and `Conjurer's Closet`.

**Three of those ten were curated pool cards, playable all along.** `unsupportedReason` consulted only
the IMPORTED-card store, so a card that is BOTH curated and imported was judged by the import — even
though `importedCards.ts` promises the store is "deliberately additive: nothing here can shadow a
curated card" and `deckHealth.ts` promises "cards in the curated pool are always playable". Both were
true as documentation and false as code. It is the ORDINARY case, not a corner: you paste a real
decklist, part of it is already in the pool, and anything the compiler could not read at IMPORT time
was reported broken forever. Thragtusk was named for wanting "leaves-the-battlefield triggers" the
engine has had for months.

The store is also a CACHE of an import-time verdict, which is the same bug's second half: Cloudshift
still read "needs a filtered-targeting template" after §3.35 shipped the rule that compiles it.
Asking the pool first fixes that permanently for curated cards. ⚠️ An UNCURATED failed import still
carries its import-time verdict until re-imported — deliberately, and the third test pins that a
genuinely unreadable card is still reported, because silencing every warning would be the worse bug.

**Restoration Angel now compiles**, which needed the one thing the report called "a filtered-targeting
template": `nonAngelCreatureYouControl`. The exclusion is load-bearing, not flavour — the Angel is
itself a creature you control, so a blink that could name it would re-trigger its own enters ability
for ever, the same shape as §3.33's copy mirror. Both the enumeration site and `isLegalTarget` apply
the filter, because §3.36 is what happens when those two disagree.

⚠️ **Named for the printed line, not generalised — on purpose.** `CardFilter` already spells
"non-Goblin creature" as `noneOfSubtypes`, so the general form is a target restriction that carries a
filter. `TargetRestriction` is a flat string union read at **67 non-test sites**, and giving it a
shape is a change of a different order from adding a member. The comment on the new member names the
trigger for doing it: the second non-<subtype> card.

📊 Selesnya Blink now runs 2× Restoration Angel over the 2× Angel of Mercy (flash makes it the only
instant-speed blink in the deck): **60.9%**, essentially unmoved from 61.9%, and its bad matchups
stay bad (30% into Mono-Green Ramp, 40% into Izzet Prowess).

### 3.36 A granted flashback on a SPLIT card — the menu lied — ✅ done

The last violation keeping the deep tier red, and the third distinct defect the copy-mirror hunt
turned up behind the first. **The tier is now GREEN: 0 violations in 2,000 games.**

Snapcaster Mage grants flashback to a CARD in a graveyard. A split card (CR 709) is one card with
two halves, so casting it from the graveyard resolves to a HALF — and `castDef` is then not
`card.def`. `applyCastSpell` consulted the grant only when those two were the same object and
otherwise read the half's PRINTED flashback, which a split half does not have:

```ts
castDef === card.def ? flashbackCostOf(state, card) : castDef.flashback
```

Meanwhile `generateLegalActions` offers the graveyard cast using `flashbackCostOf(state, card)` —
which DOES find the grant, and even checks affordability against it. So the menu offered a cast the
apply path then refused with "that card has no flashback", for ever. Soak seed **1200969370**, an
`Assault // Battery` already spent as Assault.

Both sides now read the same accessor (`flashbackCostOf(state, card) ?? castDef.flashback`), which
also settles the cost question without needing a ruling: the number the apply path charges is the
number the offer already validated.

⚠️ **The invariant that caught it is worth more than the fix.** "The engine never rejects an action
it offered" is not a rules check — it is an internal-consistency check between two code paths that
must agree, and nothing else in the suite compares them. It failed silently in the sense that
matters: no crash, no wrong result, just an action refused every single time it was offered.

### 3.34 A spell returned to hand kept the face it was cast as — ✅ done

Not a copy-pricing bug and not caused by §3.33: §3.33 changes which games get played in copy-spell
decks, and one of the 2,000 walks into a defect that was already there. §3.35's two new pool cards
then re-dealt every generated match and it surfaced again at a different instance, which is how we
know it is the CLASS and not one unlucky game.

**The violation** (turn 22, draw step; the instance id moves with the pool):

```
✗ every action a pilot submits came from generateLegalActions
    castSpell#7 was never offered (10 legal actions: passPriority, tapForMana)
✗ the engine never rejects an action it offered
    the engine rejected an offered action: the back face of a double-faced card cannot be cast
```

The action is `{kind:'castSpell', instanceId:7, targets:['B'], face:'back'}`, submitted **82 times**
in that one game.

⚠️ **This section first shipped with the WRONG diagnosis, and the way it was wrong is worth keeping.**
It said the pilot was building a `castSpell` for a modal DFC whose back face is a LAND
(`Skyclave Cleric // Skyclave Basilica`), and prescribed a guard in the pilot's
`castableHalvesInHand`. That guard was written, and it fixed nothing: the caller already drops a land
half one line later (`if (isLand(def)) continue;`), so the guard was unreachable. The seed had gone
green for an unrelated reason — §3.35 changed the pool and re-dealt it — and the "fix" was only ever
confirmed against that. **`targets:['B']` was the tell all along: a land does not target a player.**

**What is actually wrong.** Tracing every event naming the instance gives three lines and the whole
story: it is DRAWN, it is CAST as its back half ("Blow Off Steam"), and it moves **stack → hand** —
Narset's Reversal returning it. `returnSpellToHand` pushed the instance into the hand array with
three hand-rolled lines and no CR 400.7 reset, so the card arrived in hand still wearing the
back-face definition. A back face cannot be cast from hand (CR 712.8b), so the engine refused it
every time the pilot offered it, and the card was a dead draw for the rest of the game.

The fix CALLS core's own `resetInstanceForNewZone` (plus `pruneCardGrantsFor`) rather than
re-implementing what a zone change clears — the same discipline `movePermanentTo` states at length,
and the two funnels had drifted for exactly the reason that comment warns about.

**The regression is CONSTRUCTIVE, not a seed.** `returned-spell-face.test.ts` builds the position
directly: cast a modal DFC's back half, bounce it with Narset's Reversal, assert the card in hand is
front-face-up AND castable again. A seed would have been re-dealt by the next pool change — which is
precisely what happened to the first attempt at this section. Sabotage-checked: removing the reset
turns both tests red.

### 3.32 The other doors into the priority boundary — CR 704.3 for every action — ✅ done

§3.29 put `checkStateBasedActions` on the priority boundary and called it a backstop for "the next
mutation path that forgets". It was installed on **one** of the doors into that moment, and the next
path had already forgotten.

**This section is §3.32, not §3.31**: `feat/spell-and-token-copies` published a §3.31 while this
branch was in flight, and renumbering a section other branches already cite would break more than it
tidies.

#### The reproduction

The 450-game redaction hunt (§3.30) filed one unrelated violation and deferred it: seed
**4222011655**, `#34 Blood Artist has toughness 0` while still on the battlefield — CR 704.5f says a
creature at 0 toughness is put into its owner's graveyard. It did not reproduce inside the fast tier
because it is **mixed game 112** and the fast tier plays 40.

Inverting `gameSeedFor` narrowed it to that one index in seconds, and from there to a single game that
replays in **200 ms**. What it shows:

- Turn 8: B enchants A's Blood Artist (a 0/1) with **Weakness** (−2/−1). It does not die, because A's
  **Trusty Machete** is equipped to it. Net: alive, correctly.
- Turn 13, draw step: A casts **Costly Plunder**, whose mandatory additional cost (CR 601.2h) is
  "sacrifice an artifact or creature". Two artifacts qualify, so the cost parks a `selectCards`
  question. A answers it with the Machete.
- The Machete leaves. The Blood Artist is now a −2/0 — and it sits there for the **next five turns**.

#### Which of the three it was

Three candidates were on the table and two of them were wrong, which is worth recording because both
were plausible and both would have been fixed in the wrong place:

- **Not the narrowed gate.** `stateBasedActionsPossible` returned **`true`** on the offending board —
  the Weakness is an attachment and the gate treats either end of an attachment as "always look". The
  §3.29 narrowing is innocent.
- **Not a stale or lazily-computed toughness.** Calling `checkStateBasedActions` **by hand** on that
  exact state killed the creature immediately and emitted the whole correct cascade — `creatureDied`,
  the zone change, the Weakness unattaching and following it to the graveyard.
- **It was a mutation site that changed state and never re-checked.** Instrumenting the engine showed
  the pilot being handed two consecutive views at turn 13's draw step with **no check between them**:
  the first with the Machete and toughness 1, the second without it and toughness 0. Paying the
  additional cost runs through `finishCastChoice`, which hands the floor **straight back to the
  caster** — nobody passed priority, so `onPassPriority` never ran, so nothing looked.

#### The seam

CR 704.3 says state-based actions are checked *whenever a player would receive priority*, and *then*
triggered abilities go on the stack. In this engine a player receives priority at the end of
essentially every action. So the check moved from one action's handler to **where an action ends** —
`applyActionToDraft`, after dispatch, before `collector.flush()` puts triggers on the stack. That
ordering is the rule's own: a death this check causes queues its dies-trigger into the same flush
rather than being stranded in a collector nobody drains again — and Blood Artist's own ability is
exactly that shape. Three guards say "is anybody actually receiving priority": not a decided game, and
not a parked question or a suspended resolution, which mean a spell is still resolving (CR 608.2 — the
case `soak.ts` documents at length, where a creature genuinely does sit dead until the question is
answered).

**The pass is excluded, and that is not a special case in disguise.** A pass is the one action that
already ran this exact check — at its START, in `onPassPriority`, where it must be, because a
state-based action can end the game or park the legend rule's question and so stop the pass happening
at all. What a pass then goes on to change checks at its own site (`resolveTopOfStack`, and the
draw/combat-damage/cleanup arms of `advanceStep`). Enumerating *mutation sites* is what produced this
bug; enumerating *action kinds* is a closed list the compiler checks, and this covers all of it.

#### What it costs

⚠️ **Wall clock is worthless on this box and so, it turns out, is a small number of CPU rounds** — the
first paired attempt returned rounds of 2,484 ms and 5,110 ms **for the same arm**. So the added work
was counted deterministically first, and only then timed.

| workload | extra gate calls | extra FULL checks | cost |
|---|---|---|---|
| seed-99 gauntlet (280 games) | 24,965 | **0** | ~6 ms of ~2.3 s (~0.3%), every row byte-identical |
| full-pool soak (worst case) | 11,328 | 6,227 (24,369 → 30,596, +25.6%) | **+9.5% CPU** |

Of the gauntlet's 151,124 actions, **125,918 are passes** — which is why excluding them is most of the
work rather than a rounding error. The gauntlet reaches **zero** extra full checks because curated
decks rarely hold an attachment; that is also why the gauntlet cannot see this bug and the soak can.
The +9.5% is the minimum over 14 alternating paired rounds in one process, on full-pool boards where
nearly every game has an Aura or an Equipment out and the gate therefore says yes about half the time.
That is the price of the rule holding at the boundary it names.

#### Gauntlet: 79/280, unmoved

Byte-identical per-opponent rows with the check on and off, measured in the same process: Boros 12/40,
Rakdos 13/40, Izzet 17/40, Golgari 7/40, Orzhov 9/40, Mono-Green 7/40, UW 14/40.

#### The sibling hunt — 2,056 games, zero SBA-class violations left

One instance of this shape usually means more, so the deep tier ran at 2,000 games **on the merged
tree**: 2,056 games, 39,116 turns, 1,122,195 actions, 348,608 ms CPU. **Not one state-based-action
violation** — no 0-toughness creature, no 0-loyalty walker, no 0-defense battle, no illegally attached
Aura, no player at 0 life still playing. The class this branch opened is closed.

⚠️ **It did surface three failures, and they are NOT this branch's.** Three games burned the
6,000-action cap without ending (`gameCanEnd`): seeds **3434778477** (turn 20), **1390617766**
(turn 11) and **113343071** (turn 18). Replaying all three through `replaySoakMixedGame` with the new
check toggled ON and OFF in one process gives the **identical** violation set both ways, at both
on-the-play assignments — so they are pre-existing on `origin/main`, not a behaviour change here.
Their decks say why: every one pairs a copy spell (`Reverberate`, `Twincast`, `Narset's Reversal`)
with an extra-draw engine (`Howling Mine`, `Font of Mythos`, `Kami of the Crescent Moon`), which is
§3.31's cards meeting a card-advantage board. **`origin/main`'s deep tier is currently RED for that
reason** and it needs its own branch; closing it here would bury an engine fix under an unrelated
one, which is exactly the call §3.30 made about this bug.

> ✅ **Closed in §3.33.** The extra-draw engines were a coincidence of the decklists, not the cause —
> all three are the same copy-mirror loop, fixed in how the pilot prices a copy (plus a CR 707.10
> "may" the engine had made mandatory). The deep tier is green again.

#### A regression test that could have been green for the wrong reason

`soak-config.ts` promises a violation is "a bug report you can paste into a new test". It was only half
true: the seed and both decklists printed, but the only way to reach the game they describe was to
re-run the whole tier and hope `mixedGames` was large enough to contain it. `replaySoakMixedGame`
closes that — one seed, one game, 200 ms — and `soak.test.ts` gains a PINNED list.

**The sabotage that survived is the finding worth keeping.** Mutating one bit of the replay's
opponent-deck seed left the pinned row **passing**: it replayed a different match, found nothing, and
read exactly like a fix holding. "No violations" is also what the wrong game reports. The replay now
returns both decklists beside the violations, and every pinned row names the cards without which the
position cannot exist (`Blood Artist`, `Trusty Machete`, `Costly Plunder`, `Weakness`) — asserted
*before* the outcome, so the row fails loudly when pool churn stops dealing the position instead of
passing vacuously forever.

**Sabotage-checked: 4 breaks, 3 caught immediately, 1 escape — and the escape was fixed and re-checked
red.**

### 3.31 Copies that are NOT CARDS — a spell copy on the stack, and a token copy — ✅ done
§3.24 shipped copying ONTO an object that already exists: a Clone entering the battlefield swaps its
own `def`, so the copy inherits a card, an owner and a zone to go home to. It reported the other half
of the family **by name rather than half-building it**, and the reason it gave is the whole of this
section: *"a copy of a SPELL needs a stack object that is not a card and ceases to exist as it
resolves — `resolvesTo` has only battlefield/graveyard/exile/hand, and any of them would leave a
phantom card in a zone that delirium, flashback and Tarmogoyf all count."* That is exactly right, and
it is the trap this section had to disarm before anything else.

**CR 704.5e IS THE FEATURE, AND IT IS ASKED IN ONE PLACE.** `spellLeaveDestination` gains a fourth
answer, `'ceaseToExist'`, and it is asked **first** — before flashback's exile, before buyback's
return to hand, before the graveyard. Both exits from the stack already funnel through that one
function, and they live in **two different packages** (resolution in core's `finishSpellResolution`,
countering in the cards package's `counterSpellOnStack`), which is precisely why the answer is a
value in a RETURN TYPE rather than an `if` at each call site: neither caller type-checks without
handling it, and the compiler caught the second one the moment the type widened. Nothing is ever
pushed into a zone, so the phantom does not exist to be cleaned up — the same argument §3.29 makes
for doing CR 704.5d at the MOVE rather than as a state-based sweep.

The one copy that DOES keep an object is a copy of a **permanent spell**, and what it keeps is a
**token** — stamped on the DEFINITION in `makeSpellCopy`, because a definition field survives the
per-action clone by construction (`internal/clone.ts` shares `def` by reference and says so), where a
new instance field is a line a field-by-field copy can forget. It then ceases to exist by the token
rule the moment it leaves the battlefield, so that exit leaves no card either.

**The copy IS a `SpellStackObject`, and that is the design.** A copy of a spell is a spell: it can be
countered, it is a legal "target spell", and it resolves through the very same code — so there is no
second resolution path to keep in step, exactly as swapping `def` gave §3.24's copy no second
characteristic path. Two things differ, both consequences of it not being a card: its `CardInstance`
is **minted** (a fresh id, `zone: 'stack'`, the original's copiable values), and it carries
`isSpellCopy`. `internal/clone.ts` copies that field, with a test, because dropping it would put a
phantom card in a graveyard at the very next action boundary.

**Every decision made for the original comes with it (CR 707.10)** — its targets, the value of X,
whether it was kicked and how many times, and a modal spell's announced modes *with each mode's own
aim*, deep-copied so re-aiming the copy cannot re-aim a spell its controller may not even control.
What deliberately does NOT come across is the bookkeeping of a CAST, because a copy is not cast:
`castFrom` (whose only job is to exile a flashback CARD), `boughtBack`, `additionalCostPaid`,
`awaitingCastChoice`. None could change where the copy goes anyway — `isSpellCopy` outranks them —
so carrying them would only state a falsehood in the state a UI and a replay both read.

**"You may choose new targets for the copy" is an aiming moment the engine did not have.** Targets
are chosen as a spell is CAST or as a trigger goes on the stack; nothing aimed an object the engine
itself had just created. It happens inside the copying spell's RESOLUTION, so it is asked through the
ordinary resolution channel and the existing suspend/resume machinery carries it — no new transport,
and it replays from a seed. `spellCopyAimSlots` is what makes a MODAL copy work: the slots are the
announced modes, each re-aimed on its own, and a slot with no target is never offered (the permission
changes what a target is, never how many there are).

⚠️ **Two latent engine bugs had to be fixed to get there, and both predate this branch.**
- `applyAnswerChoice` routed **every** `selectTargets` answer to `recordTriggerTargets`, with no
  `!state.resolution` guard — the three sibling branches beside it all carry one. A target answer
  raised from inside a resolution would have aimed some unrelated trigger and left the suspended
  resolution parked forever.
- `targetOptionFor` never searched the **stack**, so every counterspell's own target has been
  rendering to the UI and to the AI's target scorer as `#7`. "Target spell" has been a restriction
  since Counterspell; it matters twice over now, because both the copy question and the re-aim
  question are lists OF SPELLS.

**The compiler: two rules, and the residual reports something TRUE.** `copy-target-spell` owns the
whole printed idiom on ONE LINE ("Copy target instant or sorcery spell[, then return it to its
owner's hand]. You may choose new targets for the copy.") rather than sentence by sentence, because
the permission is not an effect of its own — splitting them would make the second sentence a vacuous
rule. `create-token-copy` parses its tails from the END (the kicked count, then the "except …"), so a
selector containing a comma cannot be mistaken for an exception, and it reuses §3.24's
`parseCopyException` unchanged: "except it has haste" means exactly one thing in this codebase.
`instantOrSorcerySpell` is a new target restriction and is deliberately not `'spell'` — flattening it
would let Reverberate copy a Grizzly Bears, which is a card playing WIDER than printed.

The obsoleted hint is replaced by **two precise ones**, because the residual is not one thing: a
**DELAYED triggered ability** ("Sacrifice it at the beginning of the next end step" — CR 603.7, the
single biggest remaining token-copy blocker, and a card compiled without that clause would be a
permanent hasty copy with no drawback, i.e. strictly better than printed), and a **copy-creating
template outside the closed tables** — an activated/triggered ABILITY on the stack, a
"nonlegendary"/"another"/"token" selector, a token that enters tapped, "copy THAT spell" naming the
spell that triggered the ability, a follow-up sentence about the token just created, an "except …"
tail on a SPELL copy (Fork's "except that the copy is red"), or a copy count conditional on the zone
the spell was cast from.

📊 **Measured, paired, same cached 2100-card corpus, against the `origin/main` this merges into:
545 → 550 playable, +5, 0 regressions** — the two full playable SETS were diffed, not the counts.
Reverberate, Reiterate, Narset's Reversal, Rite of Replication, Giant Adephage. The residual copy
family is 29 cards and is still the corpus's #1 gap, but it is now named honestly: almost all of it
is delayed triggers and ability-copying, neither of which is this system.

🃏 **The shipped pool is 545 → 553**, names in and `'complete'` verdicts out, nothing hand-authored:
Reverberate, Twincast, Reiterate, Narset's Reversal, **Dualcaster Mage** (a spell copy from an ETB
TRIGGER, aimed as the trigger goes on the stack), Rite of Replication, Cackling Counterpart and Giant
Adephage. The blocked candidates stay in `expansion-candidates.json` on purpose — they are the
coverage probe for what the family still needs.

⚠️ **THE FULL-POOL SOAK REPORTED THE MECHANIC INERT, AND IT WAS THE PILOT.** The pool printed
`spell-copy` and no soak game ever fired it. Nothing was wrong with the engine: the heuristic
classifies spells by INTENT, `copySpell` was in no intent, so a Reverberate classified as a "generic
spell" — and a generic spell is only ever offered with an **empty stack**. The pilot could not cast
it at all. A `copySpell` intent now holds it up like a counterspell and answers the top of the stack;
the soak going green is the end-to-end proof that the mechanic is reachable in a real game, and it is
the strongest argument yet for §3.26 existing.

**The pilot needed a policy for the re-aim, too, and the failure mode was not subtle.**
`answerSelectTargets` had exactly two cases (a modal cast; a trigger). The copy re-aim is a third,
asked from inside a resolution — and with nothing to price, every candidate scores zero and the pilot
degrades to the FIRST offered, which for a copy of a Lightning Bolt is very often **its own face**.
The copy is not on the stack when the question is asked (the primitive builds it locally and pushes
only once every question is answered, because a parked question re-runs the whole ref), so the pilot
reads the spell being COPIED — named by the resolving frame's own target — from public state.

⚡ **Rule 7, measured rather than assumed.** The gauntlet at seed 99 is **byte-identical** to this
branch's `origin/main`: **79/280**, rows 12 · 13 · 17 · 7 · 9 · 7 · 14. Scavenge probe over 40
identical seeded self-play games (30,600 actions, equal in both arms): **584/583 here vs 584/585 for
the same worktree at HEAD, interleaved** — and 606 at the branch point, so this branch allocates
slightly LESS (`legalTargetsFor`'s `'spell'` branch stopped building two intermediate arrays).

🧪 **21 tests across five packages, and 20 of 21 sabotages RED on the first pass.** The one that
survived is worth reading: nulling ONE of the two `spell-copy` soak witnesses changes nothing,
because they cover each other exactly as `tokenCreated`/`tokenCeasedToExist` do — and the case that
matters (a copy created but never ceasing to exist, i.e. the phantom) fires only the first, so it
would still fail. Nulling both goes red. Two real product bugs were found by the tests rather than by
review: `createTokenCopy` never implemented the `self` selector the compiler emits (so every
self-copying trigger made nothing), and `spellCopyAimRestriction` read `targetRestrictionOf`
literally, which answers `undefined` for the default `'any'` — Lightning Bolt, the most-copied card
in Magic, could never have been re-aimed.

⚠️ **A trap that cost an hour and is now written down in the test that hit it:** `applyAction` takes
`(state, action, CONFIG, REGISTRY)` **positionally**. Passing `{ registry, config }` — which reads
like an options object, and which other suites in this repo do — hands the object to `config` and
leaves the registry undefined, so every primitive degrades to `effectUnsupported` and the test stays
GREEN while proving nothing.

📚 **CR 707, not CR 706.** Copying objects is section **707**; 706 is rolling a die, and no card in
the pool has one. The repo cited 706 in 24 files. `conformance/rules-manifest.ts` already had it
right, and five independent anchors in that same file confirm the numbering (708 face-down, 709
split, 712 DFC, 715 adventurer), so the citation is corrected throughout the source.

**Reported by name, not half-built** (each is a system, not a template): a **delayed triggered
ability** created at resolution (CR 603.7) — Kiki-Jiki, Twinflame, Splinter Twin, The Fire Crystal,
Orthion, Jaxis, Molten Duplication and Mimic Vat are all blocked on this one clause and nothing else;
**copying an activated or triggered ABILITY** (Lithoform Engine, Return the Favor), which needs a
target restriction that can reach a `TriggeredStackObject`; a token that **enters tapped** (Skyclave
Relic, Kambal, Delina); **"whenever you cast a spell, copy THAT spell"** (Reflections of Littjara,
Jin-Gitaxias, Sword of Wealth and Power), where the copy is of the spell that triggered the ability
and a trigger carries its triggering PLAYER but not the stack object; a **follow-up sentence about
the object just created** ("That token gains haste" — Helm of the Host), deliberately not folded into
the copy's keywords because a grant is layer 6 on THAT object and is not among the copiable values a
second copy would take; and an **"except …" tail on a SPELL copy** (Fork's "except that the copy is
red"), for which `CopyExceptions` has no colour field.

**Re-gated after merging `origin/main` at `b01cedf`** (which brought CR 704.3 at the priority
boundary, CR 704.5q and the CR 514.1 cleanup discard). `npm run verify` exit 0, `npm run build`
exit 0, **4981 passed / 0 failed**, and the gauntlet at seed 99 is STILL byte-identical —
**79/280**, rows 12 · 13 · 17 · 7 · 9 · 7 · 14. The corpus measurement is unmoved by the merge and
is properly paired: main’s compiler is untouched since the branch point (the only file it changed
under `packages/cards/src/compile` is a test), so its playable set is still exactly the 545 captured
there, and the merged branch’s 550 differs from it by **five additions and zero removals**. Every
generated pool artefact was diffed against `origin/main` by NAME rather than by count —
`starter-cards.json`, `expanded-pool.ts` and both card indexes are strict supersets, so the merge
dropped nothing of main’s.

**And re-gated a SECOND time after `origin/main` moved again to `98488b2`** (the
hidden-information guarantee, §3.30). That merge brought `packages/core/src/instance-ids.ts` — an
enforced table of WHERE AN INSTANCE ID CAN HIDE, mapped over every field of every event — and it
broke the build until this section’s three new events were classified in it. They are, and all five
of their id fields name objects on the STACK or the BATTLEFIELD, never a card in a hand or a
library, which is the same fact that makes them `'public'` observations.

⚠️ **That table’s own source scan checks a FIELD NAME, not a field of an event** — so declaring
`spellCopied` all-`'none'` leaves it green, because `instanceId` and `copiedInstanceId` are
classified by `becameCopy` and `tokenCreated`. A sabotage found that, and two cases now ask the real
reader (`instanceIdsNamedBy`) per EVENT, which is what makes these entries load-bearing.

**This section is §3.31, not §3.30**: `fix/redaction-guarantee` published a §3.30 while this branch
was out, so the number moved rather than collide. `npm run verify` exit 0, `npm run build` exit 0,
**5007 passed / 0 failed**, gauntlet at seed 99 still **79/280** with the same seven rows.
## 7. Definition of done
Tests green · status flipped in §3 · committed with explicit paths · pushed · a build delivered to test.
Workers push branches; the integrator merges + ships (COORDINATION.md).
