# Superhuman MTG decision engine — the user's program brief

> **Status: user-authored source material, preserved verbatim in substance.** Saved 2026-08-15 at the
> user's explicit request ("save off all these resources so you dont lose anything from compaction").
> This file is the durable record. Do **not** delete, summarize away, or "tidy" it — later sessions and
> worker agents read this instead of the chat transcript, which does not survive.
>
> Two briefs are recorded. **Brief B is the governing one** (newer, and it supersedes Brief A's framing).
> Brief A is kept because its four pillars are still the right vocabulary for the hidden-information work.
>
> **Our measured evidence is in [§ Measured baseline](#measured-baseline-what-we-actually-know) at the
> bottom — read it before acting on either brief.** It confirms the user's central thesis and it also
> contradicts a couple of the briefs' assumptions. Both matter.

---

## Brief B (GOVERNING) — "Build a Superhuman Magic: The Gathering Decision Engine"

You are working on an existing MTG AI engine that already has heuristic-based decision making and an
initial MCTS implementation. The current implementation is concluding that MCTS is too slow and often
weaker than the existing heuristic engine. **Do not take that conclusion as evidence that search is
fundamentally unsuitable for MTG.** Instead, assume our current search architecture is probably asking
the wrong question of MCTS.

Redesign the decision architecture so the existing heuristic engine and search engine **complement**
each other. The objective is a superhuman MTG player capable of consistently defeating extremely strong
human players — not merely an agent that beats random or mediocre opponents.

**Do not optimize for "maximum MCTS simulations per second." Optimize for maximum playing strength per
millisecond of decision time.**

### 1. First principle: do NOT build "pure MCTS MTG"
MTG has enormous action branching, compound actions, priority windows, hidden information, random draws,
unknown opponent hands, unknown future draws, triggered abilities, replacement effects, stack
interactions, combat decisions, sequencing decisions, bluffing, information leakage, long-term resource
planning, matchup-dependent strategy, and vast numbers of semantically equivalent action sequences.

Naïve MCTS spends enormous computation distinguishing obviously inferior actions. Build a **hybrid
hierarchical decision system**:

```
                 CURRENT GAME STATE
                        │
                        ▼
              ┌───────────────────┐
              │ Fast Policy Engine│
              │ / Heuristics      │
              └─────────┬─────────┘
                        ▼
              Candidate Action Set
                        │
                        ▼
              ┌───────────────────┐
              │ Search Controller │
              │ "Is search useful │
              │  here?"           │
              └─────────┬─────────┘
             ┌──────────┴───────────┐
        Low complexity         High uncertainty /
        / obvious move         tactical importance
             │                      │
             ▼                      ▼
       Use policy          Selective search
                                    │
                                    ▼
                         Tactical / strategic verification
                                    │
                                    ▼
                              FINAL ACTION
```

Search should be **selective**.

### 2. Before changing code: audit the existing architecture
Inspect: the decision pipeline; the heuristic evaluation function; action generation; the MCTS
implementation; game-state representation; whether states are immutable / copy-on-write / mutated;
caching & transposition; self-play infrastructure; timing & profiling infrastructure. **Determine exactly
what makes the current MCTS slow. Do not assume the bottleneck — instrument it.**

Measure: decision generation time · state cloning time · state mutation/undo time · legal-action
generation time · heuristic evaluation time · rollout time · tree-selection time · node allocation time ·
hashing time · transposition lookup time · opponent-action generation time · simulations/sec · average
branching factor · maximum branching factor · tree depth · unique states/sec.

Identify whether MCTS is slow because of: too many actions · expensive state copies · poor action
representation · expensive rules simulation · expensive evaluation · redundant states · pathological
branching · insufficient pruning · poor rollout policy · excessive depth · poor parallelization · bad
cache locality · repeated evaluation of equivalent situations.

### 3. Most important change: separate "decision search" from "game simulation"
The search tree should not treat every engine operation as a node. MTG has long chains of forced or
strategically equivalent actions (choose target / mode / X / ordering / payment / replacement effect /
trigger ordering / attack declaration / blocker assignment / damage assignment / priority pass).

Represent these as **structured decisions**:

```
Decision { DecisionType type; CandidateAction action; ActionMetadata metadata; }
```

with the pipeline `Strategic Action → Action Resolution → Forced/Mechanical Decisions → Next Strategic
Decision`. Search reasons about **strategically meaningful decisions**; the rules engine still resolves
everything correctly.

### 4. Hierarchical action abstraction
- **Level 0 — Forced actions**: mandatory triggers, deterministic resolution, forced sacrifices, forced
  draws, mandatory effects with one legal target. Resolve automatically; never spend iterations on them.
- **Level 1 — Equivalent actions**: group actions with equivalent strategic consequences via
  canonicalization. Key ≈ resulting relevant state characteristics + resource changes + card information
  changes + stack consequences. **Do not blindly merge if hidden information or future consequences differ.**
- **Level 2 — Strategic actions**: the decisions that deserve search — cast removal now / cast threat now
  / hold interaction / attack / don't attack / develop board / represent interaction / spend vs preserve
  mana / fetch land A vs B / sequence A before B / commit to combat trick.

### 5. Candidate generation: never search everything equally
`Generate legal actions → fast heuristic scoring → rank → keep top K → search those`. **K must be
dynamic**: 3–8 normally; 10–20 when evaluation disagreement is high, tactical stakes are high, opponent
has strong interaction, lethal is possible, combat is complicated, stack interaction is complicated, or a
major resource decision is occurring. Keep them tunable, not hard-coded.

### 6. Search trigger — "should I think hard?" (one of the most important components)
```
SearchValue = TacticalRisk + EvaluationUncertainty + ActionDisagreement
            + GameStateImportance + OpponentThreat + InformationValue + ReversibilityPenalty
```
Search more when **TacticalRisk** is high (lethal attack, potential lethal against us, removal decision,
counterspell decision, combat trick, sacrifice, board wipe, planeswalker decision, combo interaction);
when **EvaluationUncertainty** is high; when **ActionDisagreement** is high (A=0.72 / B=0.70 / C=0.69 is a
perfect reason to search — A=0.96 / B=0.42 / C=0.11 is not); and when **GameStateImportance** is high
(early-game high-information decisions, critical midgame, combat, pre-lethal, endgame, combo turns,
resource bottlenecks). Do not waste huge budgets on trivial decisions.

### 7. Progressive widening
Do not expand every candidate immediately. Start with the top 2–4 and widen as confidence grows —
e.g. visits 0–25 → 2 actions, 25–100 → 4, 100–300 → 6, 300–1000 → 10, 1000+ → 15+. Use an adaptive
function `numChildren = C * visits^alpha`; tune C and alpha empirically. Especially important in MTG
because the action space is highly nonuniform.

### 8. Heuristic engine as the MCTS policy prior
Never start a node uniform. `P(action) ∝ exp(score(action) / temperature)` from the existing fast policy.
**Retain exploration** — a bad heuristic must never permanently eliminate an action unless it is provably
illegal or strategically dominated.

### 9. A leaf evaluator MUCH stronger than a random rollout
Random MTG play is almost useless as a measure of position strength. Evaluate positions directly. The
evaluator should include at least: life totals · board presence · card advantage · card quality · mana
advantage · available mana · future mana · tempo · removal availability · interaction availability · stack
advantage · combat potential · lethal probability · opponent lethal probability · hand quality · known
opponent cards · unknown-card probabilities · deck composition · graveyard resources · exile resources ·
planeswalker value · equipment/aura value · synergy · combo potential · counterplay · inevitability ·
position volatility · information advantage. **Do NOT reduce MTG to life total + card count.**

### 10. Evaluate future potential, not just current state
```
V(state) = W1*immediate_board + W2*resource_position + W3*tactical_position
         + W4*future_draw_quality + W5*inevitability + W6*matchup_value
```
Design so these weights can eventually be **learned from self-play**, not hand-tuned forever.

### 11. Tactical search outside MCTS
Build a dedicated tactical solver for: can we kill this turn? can opponent kill us this turn / next turn?
can this spell safely resolve? what happens if opponent has interaction? strongest combat line? what if
they block optimally? Use deeper **deterministic** search (minimax/alpha-beta over a restricted action
set) — do not force MCTS to solve tactical puzzles a specialized search solves far more efficiently.

### 12. Opponent threat search
Ask not only "what is my best move?" but "what is the strongest thing my opponent can do in response?"
For each candidate: `My Action → Opponent Best Response → My Best Continuation → Opponent Best
Counterplay`, estimating BestCase / ExpectedCase / WorstCase. **A strong player often chooses slightly
lower EV when the downside is dramatically smaller** — model Expected Value + Risk + Variance, not EV alone.

### 13. Imperfect information is fundamental
Do NOT let search reveal the opponent's hand to itself. Build an opponent belief model over
`P(card in hand)`, `P(card in deck)`, `P(card drawn next)`, `P(held vs already used)`, `P(has
interaction)`, `P(has lethal)`, `P(has combat trick)`. Update after every observed action.

### 14. Determinization, carefully
Sample possible worlds (World 1: has Counterspell; World 2: has Removal; …). Search across an **ensemble**;
never let the tree memorize one invented hand as reality. Aggregate `expected_value[action]`,
`worst_case_value[action]`, `variance[action]`, `probability[action is best]`, then select with a
risk-aware criterion. (Prior MTG MCTS research investigated ensemble determinization and found it useful,
alongside specialized rollout and pruning methods.)

### 15. Maintain multiple belief states
Keep a distribution, not just the most likely world. Focus on worlds that are high-probability **and/or**
high-impact — a 2% opponent card still matters if it creates an immediate loss.

### 16. Explicit "what could they have?" model
Track per opponent: likely cards · potential interaction · likely combat tricks · likely removal · likely
counterspells · potential sweepers · likely bombs · known archetype · known cards · inferred cards · cards
ruled out. Update from observed behavior.

### 17. Think in information sets
The tree represents what the player **knows**, not what the simulator secretly knows. Distinguish known /
inferred / possible / perfect-simulator information — the agent may use only the first three.

### 18. Transposition tables are mandatory
Hash: battlefield · legally-known hands · graveyards · exile · life · poison · mana · counters · phases ·
turn · priority · stack · continuous effects · attachments · known hidden information · library
composition · random state where necessary. **Be extremely careful with hidden information** — a state
identical to the simulator may not be identical from the player's information perspective. You may need
separate `PerfectStateHash`, `InformationSetHash`, `PublicStateHash`.

### 19. Cache evaluations aggressively
Cache evaluation(state), action rankings, candidate actions, belief state, threat analysis. Bounded
caches; measure hit rates.

### 20. Move ordering
Order by policy prior · tactical relevance · forcingness · potential lethal · interaction · historical
search success · transposition statistics. Good ordering dramatically increases effective depth.

### 21–22. Search reuse between decisions, and after opponent actions
Do not destroy the tree each action. Promote the child matching the real action to the new root; create a
fresh root only when no match exists. Applies to opponent actions too.

### 23. Allocate search dynamically
easy 0–50 sims · normal 100–500 · interesting 500–5,000 · critical tactical 5,000–50,000+ · near-lethal /
combo: nearly the whole budget. **Compute is a resource — spend it where the result matters.**

### 24. Time-based, not simulation-count-based
`Search(state, milliseconds)`. Continually ask: which additional simulation has the highest expected
information gain?

### 25. Early termination
Stop when one action has overwhelming confidence, or all plausible actions converged, or further search
is unlikely to change the decision. Don't spend 90% of the budget separating +4.17 from +4.12 EV.

### 26. Root action confidence
Track visits · mean · variance · lower/upper confidence bounds · prior · win probability. **Do not simply
pick the highest mean** — a high-EV low-confidence action deserves more investigation.

### 27. Progressive bias from heuristic knowledge
`Q(s,a) + heuristic_bias(s,a)`, with the bias **decaying as visits increase** — good instincts that search
is still allowed to contradict.

### 28. PUCT rather than plain UCT
```
U(s,a) = Q(s,a) + c_puct * P(s,a) * sqrt(N(s)) / (1 + N(s,a))
```
with `P(s,a)` from the fast policy / policy network.

### 29–31. Learned policy, learned value, training from own search
Keep an interface — `float EvaluateState(state)` / `Policy EvaluatePolicy(state)` — initially backed by
the heuristic evaluator and ranking, later by neural models. **A big neural net must not be a prerequisite
for the first implementation.** Long term: `Current Policy → Self Play → Search → Improved Decisions →
Training Dataset → New Policy → …`. Train against previous versions, strong heuristic versions,
search-heavy versions, specialized archetype bots, and human game records — not just random opponents.

### 32–33. Specialized opponents & matchup knowledge
Archetypes: aggro · midrange · control · combo · tempo · ramp · prison · value · go-wide · graveyard ·
sacrifice · burn · voltron. Infer the opponent's strategic family and modify card probabilities, threat
probabilities, search priorities, evaluation weights, risk tolerance. Matchup knowledge is a **data-driven
layer**, not hard-coded.

### 34. Strategic objectives
Maintain goals: develop board · protect key threat · reach lethal · stabilize · trade resources · preserve
interaction · force opponent to spend a resource · create inevitability · assemble combo · deny combo ·
generate card advantage · exploit tempo. Search should know the current objective.

### 35–37. Tempo, mana efficiency, represented information
Model who dictates the game / forces responses / spends mana reactively / holds initiative. Model available
vs unused vs future mana, colored mana, instant-speed mana, **mana represented to the opponent**,
bottlenecks, curve efficiency — "4 mana" and "4 mana with two untapped blue" differ enormously. Add
`InformationLeakage(action)` and `InformationGain(action)`: an opponent leaving 2 open should raise
`P(Counterspell)` / `P(Removal)` / `P(Combat Trick)`.

### 38. Prefer forcing lines
Prioritize actions that force a block / removal choice / counterspell / sacrifice / discard / life-total
decision / stack interaction. They cut the opponent's freedom and carry higher information value.

### 39. Combat is its own specialized search domain
Never blindly search all attacker subsets × all blocker assignments × all damage assignments. First
classify: obviously bad attacks · obviously good attacks · trades · profitable attacks · forced blocks ·
possible tricks · lethal attacks — then deeply search only the ambiguous assignments. The combat evaluator
must understand trades, double blocks, first strike, deathtouch, trample, lifelink, tricks, removal, pump,
protection, indestructible, regeneration, death triggers, sacrifice effects.

### 40. Stack interaction must be search-aware
Compress strategically irrelevant priority passes; represent respond / don't respond / hold priority /
retain interaction. **The rules engine stays exact — the abstraction must never change game legality.**

### 41–44. Sampling, draw probabilities, outs, threat horizon
Use stratified / importance sampling, common-outcome prioritization, and rare-but-game-ending-outcome
detection. Maintain `P(draw land / removal / lethal / interaction / threat / specific answer)`. Compute
`MyOuts` / `OpponentOuts` and feed them into evaluation. Define horizons — immediate (next action/stack),
tactical (this turn), strategic (next 1–3 turns), long (inevitability) — and spend search accordingly.

### 45–46. Hybrid, not ideological — the decision router
Support: heuristic only · heuristic + tactical · heuristic + MCTS · heuristic + deterministic · heuristic +
MCTS + tactical · deep tactical. Choose at runtime:
```
if (IsForced) FORCED;  if (IsImmediateLethal) DEEP_TACTICAL;  if (IsCombatCritical) COMBAT_SEARCH;
if (IsStackCritical) STACK_SEARCH;  if (EvaluationIsHighlyCertain) HEURISTIC;
if (HighUncertainty) MCTS;  if (HighOpponentThreat) MCTS;  else LIGHT_SEARCH;
```
Ask "which reasoning mechanism produces the strongest answer per unit of computation *here*?" — never
"which algorithm are we committed to?" **This router is likely the most important component in the AI.**

### 47–51. Measure strength, not speed
Test every change against: old heuristic · new heuristic · vanilla MCTS · hybrid · search-heavy · previous
best. Measure win rate · ELO · average decision time · 95th-percentile decision time · resource efficiency ·
game length · misplays · tactical blunders · avoidable losses. Build **curated tactical test suites**
(lethal, anti-lethal, combat, removal, counterspell, sequencing, mana, sacrifice, stack, bluff, resource
puzzles) so aggregate win rate can't hide tactical regression. Turn every discovered "genius move" into a
permanent regression test. Record every heuristic-vs-search disagreement — that dataset shows where the
heuristic is wrong. Expose search explanations for debugging.

### 52–55. Parallelism and cost
Investigate parallel simulations, virtual loss, lock-free statistics, per-thread trees, tree sharing, root
parallelization, batch evaluation — **but profile single-threaded first; a fast bad search is still bad.**
Avoid excessive allocation: object pools, arena allocation, compact state representations, copy-on-write,
undo/redo, state deltas, transposition caches. Track ns per state transition / action generation /
evaluation. Give the **root** more computation than interior nodes.

### 56. Keep the layers separate
`Rules Core → Game State → {Policy, Belief, Evaluator} → Decision Router → {Heuristic, Tactical, MCTS} →
Final Action`. Do not let the search tree become the game state.

### 57. Do NOT remove the current heuristic engine
It may contain valuable MTG knowledge. Ask what parts represent domain knowledge search lacks — card
evaluation, mana evaluation, combat knowledge, threat recognition, removal priority, tempo, deck strategy —
and turn those into reusable policy/evaluation components.

### 58. Implementation order (do NOT build it all at once)
1. **Instrumentation** — profiling, branching factors, throughput.
2. **Action abstraction** — forced-action compression, compound actions, candidate ranking, progressive widening.
3. **Policy-guided search** — heuristic prior, PUCT, top-K, dynamic budget.
4. **Strong leaf evaluation** — replace random rollouts with the existing evaluator.
5. **Tactical search** — lethal, anti-lethal, combat, stack.
6. **Information model** — belief state, opponent hand probabilities, determinized worlds, ensemble search.
7. **Tree infrastructure** — transpositions, tree reuse, caching, parallelism.
8. **Self play** — AI vs AI tournament engine with automated ELO tracking.
9. **Learned policy** — only after the search architecture works.

### 59–61. Baselines & the metric that matters
Selectable modes: `HEURISTIC · RANDOM · VANILLA_MCTS · POLICY_MCTS · HYBRID · HYBRID_PLUS_TACTICAL · FULL`.
Run HEURISTIC vs HYBRID over thousands of games, then VANILLA_MCTS vs HYBRID, then PREVIOUS_BEST vs
CURRENT_BEST. Record ELO delta, win rate, decision latency. **Do not accept "MCTS feels better."**
Optimize `StrengthEfficiency = ELO / average_decision_time`. The best architecture may end up **95%
heuristic decisions + 5% extremely deep search** — substantially stronger than 100% MCTS.

### 62–64. Search as a heuristic-debugger; the real target; don't overfit
Use search to find the policy's blind spots: when search strongly disagrees, store and classify the
position (tactical / sequencing / evaluation / opponent-model / combat / resource / information mistake)
and improve the policy from those examples. Success is **strong tournament-quality humans**, eventually
top-tier professional decision quality — not "beats its old version." And the framework must stay generic
across decks, formats, archetypes, and matchups; deck-specific knowledge belongs in deck policy, card
metadata, matchup model, and strategic objectives — never inside the core search algorithm.

### 65 / 68. What is expected BEFORE major code
Report: current architecture · current MCTS algorithm · current heuristic architecture · main **measured**
bottleneck · current branching factor · simulations/sec · average decision time · largest sources of
redundant search · what can be reused · what must be redesigned. Then propose a concrete plan against the
existing codebase. **Do not blindly rewrite the project.**

Immediate deliverable: profile MCTS · profile the heuristic · measure branching factors · measure
state-transition cost · measure evaluation cost · identify redundant decisions · implement candidate-action
ranking · progressive widening · heuristic-guided PUCT · replace random rollouts with the existing
evaluator · dynamic search triggering · automated HEURISTIC vs HYBRID benchmark · report measured strength
and performance differences.

### 66. Design philosophy
Prefer fewer smarter simulations over more dumber ones · search only where uncertainty matters · domain
knowledge + search over search without it · specialized tactical search over MCTS-for-everything · belief
distributions over one guessed hand · **measured strength over simulation count**.

### 67. Final objective
> Do not try to turn MCTS into the entire MTG brain. Turn MCTS into the part of the brain that says:
> *"The obvious answer isn't obvious here. Let me investigate this position much more deeply than my
> normal intuition can."*

---

## Brief A (earlier, retained) — ISMCTS pillars

Write the structural architecture and core implementation for a highly optimized, pro-level MCTS engine
tailored for MTG, scaling past standard MCTS limits by explicitly solving hidden information, massive
action branching (especially combat and priority), and chance events.

- **A. Information Set MCTS (ISMCTS)** — *Determinization*: before each search iteration the root
  "determinizes" — clone the true state but shuffle all unrevealed zones (opponent hand, library) into a
  random **valid** configuration consistent with known constraints (cards seen via disruption, known
  scries). *Root-node merging*: store statistics (visits N, total reward W) on **information sets** (what
  the active player can actually see), not on specific determinized states, so the AI cannot cheat or be
  poisoned by hidden cards.
- **B. Chance nodes** — card draws, coin flips, and random triggers are **not** deterministic player
  actions. Add an explicit `ChanceNode`; when backpropagating through it, weight the value by the
  **probability** of that outcome (expectiminimax), not a plain average or max.
- **C. Action-space pruning & tapping heuristics** — a strict domain filter during `expand()`. **Mana
  equivalence**: five identical Islands must collapse to one action key. Immediate alpha-beta-style
  pruning of strictly dominated moves (holding priority for a sorcery when illegal; attacking a 1/1 into a
  first-strike 5/5 with no mana open).
- **D. NN-guided selection & evaluation (AlphaZero style)** — replace UCB1 with PUCT
  `U(s,a) = Q(s,a) + c_puct * P(s,a) * sqrt(N(s)) / (1 + N(s,a))`. Instead of expensive, inaccurate random
  playouts to the end of a 20-turn game, call a PV-net returning `P(s,a)` (prior policy over legal actions)
  and `V(s) ∈ [-1, 1]` (predicted win probability).

Components requested: game-state mocks (`Card`, `Player`, `MTGGameState` with hands, libraries,
battlefields, stack, priority, `get_legal_actions()`); tree nodes (`MCTSNode`, `ChanceNode`); and an
`ISMCTSEngine` with `select()`, `expand()`, `simulate_via_pvnet()`, `backpropagate()` — clean handling of
priority changes and documentation of how PUCT balances exploitation and exploration.

> **Language note:** Brief A is written in Python and Brief B shows C++ snippets. **This project is
> TypeScript** (`packages/core`, `packages/ai`, `packages/sim`). Translate the ideas; do not import the
> languages. And a "mock neural network" is not a starting point for us — per Brief B §30 the interface
> starts backed by our **real heuristic evaluator**, which already exists and already encodes MTG knowledge.

---

## Brief C (third source) — hybrid + learned prior

You previously concluded that pure/vanilla MCTS is too slow compared with the existing heuristics. **That
assessment is correct for naive MCTS, but incomplete.** Build a hybrid substantially stronger than either
pure heuristics or naive MCTS, with a clear path to pro-level play and beyond.

**Core direction**
- Keep and improve the fast heuristic / rule-based policy as a **baseline, rollout policy, and data generator**.
- Implement a strong **neural policy + value network** — transformer or graph architecture over sparse
  card/permanent tokens preferred.
- Use **Information-Set MCTS / Multi-Observer ISMCTS**, or carefully engineered Perfect-Information Monte
  Carlo (determinization), guided by the neural prior via **PUCT**.
- **Hierarchical / abstracted action space** to tame branching: stage decisions as *type → card →
  targets/modes*.
- Leaf evaluation primarily by the **value network** once trained; limited-depth expansion + progressive
  widening.
- **Belief tracking / particle filter** over opponent hand and library.
- **Self-play training loop** that improves both the network and the search.

**Immediate engineering priorities, in order**
1. Fast, correct, vectorized or highly optimized rules engine / state representation supporting rapid
   simulation **and belief states**.
2. Hierarchical action generation and pruning.
3. Determinization / ISMCTS skeleton that can already use the **existing heuristic as rollout policy**.
4. Neural net architecture + training pipeline — start supervised on heuristic or human data if available,
   then self-play.
5. Integration: MCTS uses the net for prior and value; the net trains on MCTS-improved targets.
6. Profiling and speed: aim for useful search budgets (**hundreds of guided simulations**) under realistic
   time controls.

> Do not abandon MCTS. Treat the heuristic as the current **policy prior** and bootstrap a learned prior
> that makes search both faster (better focus) and stronger (better evaluation). **Document every major
> design decision, especially how imperfect information and the stack are handled.**

**Success metrics**
- Win rate vs the current strongest heuristic **under equal time**.
- Ability to find **non-obvious lines** the pure heuristic misses.
- **Scaling**: more search time → measurably stronger play.
- A path to full self-play improvement.

**Requested first output:** outline the concrete next 3–5 implementation steps, the exact search variant to
implement first, and how to measure whether the hybrid is already better than pure heuristics — then implement.

---

## Measured baseline — what we actually know

Everything below was measured in this repo, not assumed. **Read it before acting on the briefs above.**

### The user's central thesis is supported by our own data
The NO-GO we recorded was on **vanilla MCTS as a drop-in replacement pilot** — not on search as an idea.
Its diagnosed failure mode is *precisely* what Brief B §3–4 describes: the search's action space is
malformed. The pilot taps a land in one action and casts in another, so the tree values "tap" through
rollouts in which the *heuristic* later spends that mana, while the real next mover treats it as sunk and
declines. That is textbook "asking the wrong question of MCTS."

### Numbers on record (see DESIGN.md §3.4)
| metric | value |
|---|---|
| heuristic throughput | **~176 games/sec** |
| MCTS throughput | **~0.087 games/sec** (≈2000× gap) |
| MCTS win rate vs heuristic, 120 seeded games, seat+play rotated | **40.8%**, 95% CI **[32.5%, 49.8%]** |
| wasted mana | MCTS **0.71/turn** vs heuristic **0.00/turn** |
| allocation per decision (40-position set) | 17.90 MB → **14.50 MB** after optimization (−19%) |
| allocation per game | 7.14 GB → **6.04 GB** (−15%) |
| wall-clock gain from that −19% allocation | **inside run-to-run noise** |

### Three findings that should steer the plan
1. **The "69.5% GC" figure was a profiler artifact.** Cutting 15% of real allocation moved wall clock by an
   amount indistinguishable from noise. Do not re-derive a plan from that number.
2. **Rollout depth is the cost driver, and it is linear.** Allocation goes 1.07 MB at `rolloutDepth` 1 →
   14.8 MB at 120. **~80% of remaining cost is `packages/core`'s `applyActionInPlace` +
   `generateLegalActions`, called ~8 million times per game.** This is why Brief B §9 (strong leaf
   evaluator instead of playing to terminal) is the single highest-leverage change available to us —
   it attacks the multiplier, not the constant.
3. **`MctsConfig.maxDecisionMillis` is NOT a valid throughput knob here**, despite Brief B §24 preferring
   time-based search in general. A wall-clock budget makes the search machine-dependent and destroys the
   **common-random-numbers** property that the Lab's paired A/B verdict depends on. If we adopt time-based
   search for *play*, the Lab's *evaluation* path must stay deterministic — these are two different
   consumers and they need two different budget policies. Do not unify them casually.

### An open methodological question the briefs don't cover
This project is a **deck-tuning lab**, so both decklists are known by construction — which makes Brief B
§13–17's determinization far better constrained than in general MTG AI (the user's own observation, and it
is correct). But it cuts both ways: **if both pilots have perfect deck knowledge, the A/B verdict
systematically undervalues cards whose worth comes from opponent uncertainty** (bluffs, representing
interaction, cards that punish misplay). So a hidden-information mode is not a nice-to-have — it is
arguably the methodologically correct default for *card evaluation*, while perfect information remains
fine for *strength testing*. Decide this deliberately; do not let it be settled by whichever is easier.

### Existing assets to reuse (Brief B §57 — do not discard the heuristic)
- Heuristic pilot: spell-goal scoring, combat-trick evaluation (save / win fight / push lethal), threat
  recognition, and `planManaPayment` — a **funding plan** that already solves the tap-and-cast problem for
  the heuristic. Making the search's action space atomic almost certainly means routing it through this.
- `MctsConfig.evalWastedManaPenalty` — ships **off**; it fixed the symptom (0.71 → 0.22 waste/turn) at a
  cost of ~11.6 points of win rate. Kept because the diagnosis is worth keeping. The real fix is atomic
  tap-and-cast, per Brief B §3.
- `packages/ai/bench/mcts-bench.mjs` — allocation-based harness, reproducible to **0.05%**, and it
  fingerprints the whole chosen-action sequence so "pure speedup" can be *proven* rather than asserted.
  Wall clock on this box swings ±19% between runs of the same build; use the allocation metric.
- `packages/sim` — seeded, deterministic, CRN-paired game running with Wilson intervals, McNemar tests,
  and Holm–Bonferroni correction. **The strength-measurement harness Brief B §47 asks for largely exists.**
