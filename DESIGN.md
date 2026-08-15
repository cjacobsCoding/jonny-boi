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
  selected by data (deck/match config), never hard-wired.
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

| budget | win rate vs heuristic | 95% CI | mean decision |
|---|---|---|---|
| 16 sims | 48.3% | [39.6%, 57.2%] | 0.29 ms |
| 64 sims | 53.3% | [44.4%, 62.0%] | 2.26 ms |
| 256 sims | **60.0%** | **[51.1%, 68.3%]** | 16.8 ms |

Monotone in the budget, and only the largest budget's interval clears 50%. At 16 simulations the pilot is
indistinguishable from its own prior — which is the correct sanity check: with almost no search, a
policy-guided search should reproduce the policy.

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
record's deck fingerprint, and surfaced ("Run 3 · 26 candidates carried over", with a Reset); a record
from another decklist or an older version is rejected with a reason on screen.
*The match viewer landed:* a **"Watch a Game"** surface plays ONE traced AI-vs-AI game in the sim
Web Worker (new `match` protocol request; `runMatch(..., {recordTrace:true})` composed with the same
core primitives to capture a serializable per-action board snapshot) and replays it with a
**timeline scrubber + Play/Pause/Step/Restart + named-config speeds**: both players' life totals,
turn/phase, each board (permanents with effective P/T + tapped/summoning-sick state), hand/library/
graveyard counts, and a scrolling event log built from one shared event→text formatter. Key moments
(a creature dies, a player crosses into lethal range, the winner) are marked on the scrubber. The pure
event→state fold, the formatter, and the playback config are unit-tested; long games are capped with an
honest truncation note; an illegal deck / worker error lands in a friendly state, never a blank screen.

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
