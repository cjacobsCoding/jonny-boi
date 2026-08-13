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

### 3.4 AI pilots — ✅ done
The `chooseAction` interface + read-only game view + legal-action generator; a `random` baseline and a
`heuristic` pilot good enough to play the meta decks competently. Tested against scripted scenarios.

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
[--games N] [--cut "Card"] [--max-candidates K] [--pilot id]`.

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
Six curated, distinct 60-card meta decks (data) define the baseline gauntlet, each a well-constructed
archetype built only from fully-supported pool cards (no fully-stubbed card is a deck's core): Mono-Red
Aggro (burn), Izzet Prowess (spell-velocity go-wide), Mono-Green Ramp (resilient midrange), UW Control
(removal + counters + a flying finisher), Golgari Midrange (discard + removal attrition), and Boros Aggro
(removal-backed beatdown). Each passes `validateDeck` (legal size, 4-of, pool membership) and is
registered in `SAMPLE_DECKS`. A heuristic-pilot round-robin (40 games/matchup) confirms no deck is
degenerate — overall win-rates span ~27%–79% with no ~0%/~100% list. The decks double as the swap-candidate
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

**Engine gaps this surfaced** (the honest to-do list; each blocks real decks today):
- *mana abilities that produce a chosen color* — core's `produces` adds one of **each** listed color,
  so "add one mana of any color" cannot be expressed. **This is also a live bug in the curated pool:**
  Birds of Paradise is authored `['W','U','B','R','G']` and therefore taps for **five** mana.
- *permanents entering tapped* — blocks nearly every nonbasic dual land.
- *hybrid / Phyrexian / {X} mana costs* — Kitchen Finks is authored as `{1}`, dropping `{G/W}{G/W}`.
- *player choice during resolution* — modal spells, targeted discard, "you may".
- *activated abilities with costs*, *library search*, *dynamic P/T*, *planeswalker loyalty*,
  *transform/DFC*, *alternative costs* (suspend, spectacle).

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
