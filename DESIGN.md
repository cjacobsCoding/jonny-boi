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

- **Speed:** ~0.09 games/sec vs the heuristic's ~176 — a **2000×** gap. It is structural (`sims × depth`
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
| Mono-Red Aggro vs Boros Aggro, n=120 | **`hybrid`** | **60.0%** | **[51.1%, 68.3%]** | 7.07 ms (p95 66 ms) |
| UW Control vs Golgari Midrange, n=80 | `hybrid` | 53.8% | **[42.9%, 64.3%]** | 27.7 ms (p95 155 ms) |

On the aggro matchup the interval **excludes 50%** — the hybrid is genuinely stronger than the policy it
takes its prior from, which is what vanilla MCTS failed to be. On the slower control matchup the point
estimate still favours the hybrid but the interval **includes 50%**: at n=80 that result is
**inconclusive**, not a win. Do not quote the 60% as "the" number. The honest summary is *significantly
stronger on fast, tactical boards; unproven on grindy ones*, and closing that needs more games (and,
per §11–12 of the brief, a tactical solver the search does not yet have).

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
trustworthy:

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
behavior persists the buff and biases combat sims), and later **planeswalkers**, **transform/DFC**, and
**dynamic P/T** (e.g. Tarmogoyf). Tracked here because §3.2 cards stubbed these mechanics against the MVP.
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
  ⚠️ **Not yet in the curated pool.** The canonical Scryfall index (`packages/data-tools/data`) contains
  no Aura or Equipment, and a pool card must have a display row with art there — so these cards arrive
  through the DECK IMPORTER (the Oracle compiler), not `CARD_POOL`. Adding a playset to the pool is a
  data-tools re-fetch + a web card-index regeneration, and belongs to whoever owns those.
Still open, roughly by how often they block a real decklist:
- *activated abilities with costs* — `{T}`/mana/sacrifice abilities; unlocks a large slice of the card
  pool (fetchlands, mana rocks, sac outlets).
- *static / "anthem" continuous effects* — the engine layer EXISTS (`statics.ts`, aggregated with
  everything else), but no compiler rule reaches it yet, so an anthem still cannot be imported. Without
  it a go-wide deck's tokens can never scale, so "wide" strategies are structurally weaker in every meta
  the lab measures — a bias in the verdicts themselves, not just missing cards.
- *alternative and additional costs* (suspend, spectacle, kicker), *{X} and Phyrexian costs*,
  *dynamic P/T*, *planeswalker loyalty*, *transform/DFC*, *flash + casting from the graveyard*,
  *revolt-style "a permanent left the battlefield this turn" trackers*.

### 3.12 Scan a deck from a photo — ✅ done
Lay the physical cards out, take one photo, get a decklist — entirely on-device, no upload.
Cards are located by **variance profiling** (a laid-out deck is busy card faces separated by a flat
surface, so per-column/row variance yields the grid) rather than a contour/perspective pipeline: no CV
library, and pure array work that is unit-tested against synthetic images. A manual rows × columns
fallback covers photos the detector can't read. Only each card's **title strip** is OCR'd (greyscaled,
contrast-stretched, upscaled) — the biggest accuracy win, since art and rules text otherwise generate
confident nonsense. Raw OCR is never trusted: card names are a **closed vocabulary**, so the text is
corrected against Scryfall's full name catalog by edit distance, which turns recognition into cheap
spelling correction. A **review grid** shows each card's own crop with its match, flags anything
unconfident, and lets any guess be re-picked or cleared; only then does the list flow into §3.11's
importer, so scanned cards get the same Oracle-compiler treatment as typed ones. Tesseract is
dynamically imported so its WASM core stays off the initial bundle.

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
