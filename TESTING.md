# Testing — the regression net

**Run everything before you push:**

```bash
npm test
```

Green means the summary line reads `N passed, 0 failed`. That one command runs
every suite listed below; there is no separate step to remember and no suite that
lives outside it.

The build is a second, independent gate — a change can be type-broken while every
test passes, because tests run through Vitest's transform rather than `tsc`:

```bash
npm run build
```

> **Dev gotcha:** the web app resolves `@jonny-boi/*` to built `dist`, not `src`.
> After changing any package, run `npm run build` or the browser will keep running
> the old code and lie to you.

---

## How to add to the net

When you fix a bug, add the test that would have caught it — in the suite that
owns that layer (below), not a new top-level file. A bug without a regression test
is a bug that comes back.

Two rules that this project learned the hard way:

1. **Test against the REAL vocabulary.** The AI's tests once used a fabricated
   primitive id (`destroy` instead of `destroyTarget`). Every test passed while
   every removal spell in the game silently fizzled. If a test invents an id, a
   name, or a shape, it proves nothing about the real system.
2. **Assert that things behave SENSIBLY, not merely that they finish.** The sim
   suite asserted games terminate and verdicts reproduce, never that a pilot
   played well — so a pilot that tapped mana and did nothing shipped as the
   default. `pilot-quality.test.ts` exists because of that.

---

## The suites

### Rules conformance — `packages/core/src/conformance` ⭐ **indexed by RULE, not by feature**

Every other suite in this document is organised by FEATURE, and each was written
by whoever built that feature, asserting what that author believed the rule was.
That arrangement answers "do our tests pass?". It cannot answer the question the
lab actually rests on: **which Comprehensive Rules do we implement, and which do
we only think we do?** A rule that no feature happened to need is invisibly
absent — there is nowhere its absence shows up.

This directory is that somewhere.

| File | What it guards |
|---|---|
| `rules-manifest.ts` | **The manifest.** Every CR section in scope, classified `covered` / `cited` / `not-applicable` (with a reason) / `gap` (with what the engine does instead) |
| `manifest-types.ts` | The entry shapes and the compile-time proofs that keep the manifest from going stale |
| `manifest.test.ts` | The manifest's own net: reasons are real reasons, gaps say what the engine does, nothing is claimed twice — and it prints the coverage totals |
| `harness.ts` | `crTest(rule, title, fn)` and the real-engine drivers. No simulated board, no helper that reimplements a rule |
| `cr1xx-2xx-objects.test.ts` | Starting/ending the game, mana, {X}, tokens, targets, priority, damage, counters, creatures, lands, walkers |
| `cr4xx-zones.test.ts` | Zone change as a new object (400.7), library/graveyard order, the stack, exile |
| `cr5xx-turn-and-combat.test.ts` | The turn's steps, untap/draw, land + sorcery timing, declare attackers/blockers, combat damage, cleanup |
| `cr6xx-spells-and-abilities.test.ts` | Casting, activating, triggering, loyalty abilities, resolution, "enters tapped" |
| `cr7xx-sba-keywords-copy.test.ts` | State-based actions, ward's trigger, and the layer model's honest boundary |

**Read the manifest first.** It is the index: go from a rule number to the test
that proves it, or to the sentence explaining why there isn't one.

#### The manifest cannot be left stale by accident

This repo has learned this lesson three times already — `packages/sim`'s
`OBSERVATION_POLICY`, `paired-arms-config.ts`, and `internal/continuous.ts`'s
`KEYWORD_KEYS`, which was hand-maintained until it silently ate a granted
hexproof and a granted indestructible. A coverage manifest that can drift is
**worse than none**, because it reads like an answer. So four guards, three of
them the compiler's:

1. **An unclassified section fails the build.** `RULES_MANIFEST` is a mapped type
   over `CrSection`.
2. **A citation cannot point into the void.** `CrRule` is a template-literal type
   over `CrSection`, so `'702.9a'` type-checks only while `'702'` is in scope.
3. **The engine growing forces the manifest to grow.** `KEYWORD_RULES`,
   `STEP_RULES`, `ZONE_RULES` and `ACTION_RULES` are mapped over `KeywordFlags`,
   `Step`, `ZoneName` and `GameAction['kind']`. **Add a keyword, a zone, a step
   or an action kind to core and this package stops compiling until the manifest
   names the rule it answers to.** A separate proof,
   `MODIFICATION_IS_PURELY_ADDITIVE`, fails the build if a *setting* field is
   added to `PermanentModification` — the moment CR 613's layer system stops
   being optional.
4. **Claims and reality must match.** Each file ends with
   `assertFileMatchesManifest`, comparing the tests it actually collected against
   the tests the manifest claims for it, in both directions. That is the half a
   type cannot check: a claimed test that was deleted, renamed or `.skip`ped.

> These proofs live in ordinary `.ts` source, never in a `*.test.ts`.
> `packages/core/tsconfig.json` excludes test files and Vitest strips types
> without checking them, so a `@ts-expect-error` written in a test is evaluated by
> nothing at all — an assertion nobody runs, which reads like one.

#### How to add a rule to the index

1. Write the test in the right `cr*.test.ts`, using
   `crTest('704.5g', 'what the rule requires', () => { … })`. Drive the **real
   engine** — `createGame` / `generateLegalActions` / `applyAction`. A test that
   checks a rule against a model of the rule agrees with itself and proves
   nothing.
2. Add `{ rule, title }` to that section's entry in `rules-manifest.ts`, matching
   the `crTest` arguments **exactly**. If the section was `gap` or
   `not-applicable`, change its status and delete the stale prose.
3. Run `npx vitest run packages/core/src/conformance`. Steps 1 and 2 are checked
   against each other; missing either one is red.

**Verify the rule number.** Twenty-four citations in this repo were wrong before
this suite existed — priority is CR 117 and not 116, the mana pool empties in
500.5 and not 500.4, copying is 707 and not 706, layer 7's sublayers are 613.4
and not 613.3. An index that cites the wrong rule is worse than no index: it is
confidently wrong. Check against the published Comprehensive Rules text, not
memory.

#### Gap pins

Two entries assert what the engine does **today** where that differs from the CR
(CR 704.5q's missing counter annihilation; CR 613's additive-only model). They
are titled as pins and filed under the section's `gap`, never counted as
coverage. When somebody implements the rule the pin goes red — which is the
signal to reclassify. The idiom is the repo's own: `pool-mechanics.test.ts`
asserts absent mechanics absent with their reasons, "so whoever closes one gets
told by the suite".

#### Not a substitute for, and not duplicated by

`test/full-pool-soak` plays randomized whole-pool games; `test/interaction-matrix`
crosses systems pairwise; `packages/sim`'s `rules-audit.test.ts` asserts basic law
across full games. This suite is the **index**: one named rule per test. Where an
existing per-feature suite already affirms a rule properly, the manifest CITES it
rather than copying it — 42 sections are covered that way, and a manifest that
points at a good test is better than a second copy of it.

#### Every claim here has been seen to fail

33 sabotages: break the rule in the engine, confirm the suite goes RED, restore.
33 caught, 0 escapes. **Four sabotages came back green on the first attempt and
every one was a bad anchor rather than a weak test** — one patched a branch the
test never reaches, one changed only a TYPE (Vitest strips types, so a type edit
can never fail a test), two named fields that do not exist. If a sabotage stays
green, suspect the sabotage first.

### Rules engine — `packages/core`
The pure, deterministic MTG engine. Everything here runs without DOM or network.

| Suite | What it guards |
|---|---|
| `engine.test.ts` | Game setup, turn/step machine, priority, the stack |
| `engine-regressions.test.ts` | Specific past engine bugs, pinned |
| `combat.test.ts` | Attack/block legality, damage assignment, evasion |
| `combat-declaration.test.ts` | Declaring **no** attackers/blockers still advances the step |
| `sba.test.ts` | State-based actions (lethal damage, 0 toughness, life ≤ 0) |
| `poison.test.ts` | Infect / wither / toxic through the one CR 120.3 damage-result funnel; ten poison loses (CR 704.5c); poison survives clone/serialize (§3.105) |
| `triggers.test.ts` | Triggered abilities: matching, ordering, resolution |
| `continuous.test.ts` | "Until end of turn" effects apply then genuinely expire |
| `mana.test.ts` / `mana-abilities.test.ts` | Cost payment; **summoning sickness gates `{T}`**; one tap = one mode |
| `hybrid-and-tapped.test.ts` | Hybrid pips; permanents that enter tapped |
| `targeting.test.ts` | A spell may only point at what it is printed to point at |
| `choices.test.ts` / `choice-cards.test.ts` | Player choice during resolution |
| `rng.test.ts` | Seeded RNG determinism (the whole sim rests on this) |
| `instance-ids.test.ts` | **Where an instance id can hide** — the enforced answer to "does this value name a card?", checked against core's own source |

### Cards — `packages/cards`
| Suite | What it guards |
|---|---|
| `compile/compile.test.ts` | Oracle-text compiler reproduces the hand-authored pool |
| `primitives.test.ts` | Each effect primitive does what its name says |
| `engine-cards.test.ts` | Real pool cards resolve through the real engine |
| `pool.test.ts` / `expanded-pool.test.ts` | Pool integrity; no card references a missing primitive |
| `fidelity.test.ts` | Cards play as printed, or are honestly reported as not implemented |
| `choice-cards.test.ts` | Cards that ask questions mid-resolution |

### AI pilots — `packages/ai`
| Suite | What it guards |
|---|---|
| `heuristic.test.ts` | Land drops, removal targeting, combat tricks, **mana tapped only as needed** |
| `mcts.test.ts` | Determinism, legality, strength vs the other pilots |
| `hybrid.test.ts` | The hybrid search: determinism, the **atomic** action space (a naked mana tap is not a searchable option), macro commitment, forced-decision compression, progressive widening, and the **two budget policies** — only the interactive config may read the clock |
| `evaluator.test.ts` | The `evaluateState`/`evaluatePolicy` seam is zero-sum and symmetric, and sees card advantage / mana development / lethal boards that a life-and-board evaluator cannot |
| `search-stats.test.ts` | Action equivalence (five Islands are one decision, a Bird is not an Island) and that instrumentation never changes what a search chooses |
| `targeting.test.ts` | Pilots only construct legal targets |
| `choices.test.ts` | Pilots answer parked choices |
| `random.test.ts` | The baseline pilot stays legal |

### Simulation — `packages/sim`
| Suite | What it guards |
|---|---|
| `harness.test.ts` | Match/matchup/gauntlet determinism, Wilson CIs, A/B swap unbiasedness |
| `rules-audit.test.ts` | **Full games asserting basic MTG law** — zone integrity, untap, damage clearing, card conservation |
| `pilot-quality.test.ts` | Pilots play sensibly (mana-waste rate, obvious attacks) |
| `gauntlet-health.test.ts` | The gauntlet stays healthy |
| `stats.test.ts` | The statistics themselves |
| `suggest.test.ts` | Swap suggestions rank correctly and reproduce |
| `suggest-adaptive.test.ts` | Successive halving, futility/rank cuts, the cross-run record |
| `paired-arms.test.ts` | Shared base arm, provably-identical games, **and slicing an arm across workers changing nothing** |
| `harness.test.ts` (`RunOptions.range`) | A run split into slices reassembles into exactly the whole |
| `soak.test.ts` | **THE FULL-POOL SOAK, fast tier** — randomised legal decks from the whole 357-card pool, every invariant on every settled state, and every mechanic the pool prints required to FIRE |
| `soak-deep.test.ts` | The same soak at thousands of games. Skipped unless `JB_SOAK_GAMES` is set (below) |
| `loop-runaway.test.ts` | **A game that could not END, and the ruling it needs.** Drives a real soak game into a runaway and requires the soak to REPORT it; pins a CR 104.4b MANDATORY loop and a pilot-that-will-not-stop side by side, and asserts the two read differently (DESIGN §3.140) |
| `observation.test.ts` | **The hidden-information guarantee** — the pilot feed, scanned over mechanic-anchored full-pool games (below) |
| `masking.test.ts` | The same guarantee on the ONLINE side: every `maskStateForSeat` / spectator view over full-pool games |

### The hidden-information guarantee

Two independent chokepoints promise the same thing, and both are proved here rather than asserted:
`packages/sim/src/observation.ts` (what a **pilot** may learn) and `@jonny-boi/protocol`'s
`maskStateForSeat` (what an **online client** may be sent — where a leak is a cheating vector, not
just a biased pilot).

**What is actually promised** — and the loose version of this sentence is itself a bug, because it
reads true and is not:

> An observation names a card only if that card was on **public display at the instant the
> observation was produced**. Equivalently: the feed never reveals the identity of a card the table
> has not seen. It may say a card everybody watched is now somewhere hidden; it may never say what an
> unseen card is.

Two things that look like leaks and are not, both live: a **buyback** spell resolves back into its
owner's hand, so `stackResolved` names a card that is hidden by the time anyone looks (it was on the
stack when it was named, and the pump it leaves behind names it AGAIN at cleanup, turns later); and a
card the table watched leave a public zone — a creature that died and was regrown into a hand.
Dropping those ids would leave a pilot knowing *less* than a spectator, which corrupts the
represented-mana reasoning the feed exists for.

**"Which cards does this name?" is not a key-name guess.** The scan asks core's `instanceIdsNamedBy`,
driven by `EVENT_ID_FIELDS` in `packages/core/src/instance-ids.ts` — a **mapped type over every field
of every `GameEvent`**, so adding a field (including an *optional* one, which is the shape that hid
last time) fails the build until somebody says whether it can name a card. The scan used to collect
keys named exactly `instanceId`; the engine names cards under `sourceInstanceId`, `targetInstanceId`,
`keptInstanceId`, `hostInstanceId`, `copiedInstanceId`, `source`, `target`, `targets`, `attackers`,
`attackTargets`, `blocks`, `instanceIds`, `ref` and `attachedTo`, and **every one of those walked
straight past it**. Two real leaks were found through that blind spot and neither could ever have been
caught by the test that claimed to own the guarantee. `INSTANCE_ID_FIELD_NAMES` (what the structural
walker in `@jonny-boi/protocol` scans by) is derived from the same table, and
`packages/core/src/instance-ids.test.ts` re-derives it by reading core's own source — so an id field
on a *state* type fails a test even though no event changed.

**And it runs over decks that play the mechanics.** `observation.test.ts` used to scan three curated
gauntlet matchups. It passed on every build since it was written, and the card list is exactly why:
no curated deck plays a
buyback spell, so the interesting case never occurred. It now runs `runSoak` over the soak's
**mechanic-anchored** generated decks with the leak scan on **every** game, and asserts that every
mechanic the pool prints actually fired — if the generator stops reaching buyback, this fails rather
than quietly narrowing. `masking.test.ts` does the same for the online side.

### The full-pool soak

`npm test` covers each system where it lives. The soak covers what happens when they meet.

Twelve systems shipped in three days — planeswalkers, battles, the legend rule, emblems, transform,
modal casting, flashback + graveyard grants, protection/ward, indestructible, {X}/kicker,
cycling/buyback/madness, scry/surveil, counters, CDA P/T, turn facts, the mana-ability model — and
**each was tested only in isolation, by the agent that built it.** The eight curated gauntlet decks
never put a planeswalker, an Equipment, a protection creature, a modal spell and a flashback spell in
the same game. The soak builds decks that do, from the whole pool, seeded.

```bash
npm test                                                   # the FAST tier runs here, always

JB_SOAK_GAMES=2000 npx vitest run packages/sim/src/soak-deep.test.ts     # the DEEP tier
npm run sim -- soak --games 2000                                         # the same run, from the CLI
```

> On a loaded box the Vitest worker pool sometimes times out fetching a module before any test runs
> (`[vitest-worker]: Timeout calling "fetch"`). That is the runner, not the soak — **use the CLI form
> for long runs**; it needs `npm run build` first, and it exits non-zero on any finding.
>
> **And do not edit the working tree while a long run is in flight.** Vitest reads each module once,
> at collection, so a source file you touch mid-run may or may not be the one being tested — a
> `npm run verify` here failed on a test that passes, purely because a sabotage-check edit was live
> for part of the run. Finish the run, then edit.

**What it asserts** (`packages/sim/src/soak-config.ts` → `SOAK_INVARIANTS`, one constant per claim):
every action a pilot submits is legal; **the engine never rejects an action it offered**; no game
ends on a RUNAWAY BOUND — neither the game-wide action cap nor the per-TURN bound that draws it by
CR 104.4b, asked through the one `runawayGames` funnel because this invariant spent its whole life
watching only the first of them and the per-turn bound is a third of the cap, so every runaway left
by the door nobody was looking at (§3.140); no stack object survives a turn; state-based actions leave no 0-toughness
creature, 0-loyalty walker or 0-defense battle; an instance is in exactly one zone and says so; life,
counters and mana pools stay in range; no card the table has never seen reaches an observation
(scanned on EVERY game — measured at 6,125 ms CPU against 5,845 ms at the old 1-in-31 stride, paired
in one process over the same 90 games);
`applyActionInPlace` stays bit-identical to `applyAction`; no pool card resolves an unregistered
effect as a silent no-op.

**And it fails when a mechanic never fires.** `SOAK_MECHANICS` is an inventory; the run FAILS if a
mechanic the pool prints was not witnessed in any game — a soak that never casts a flashback spell
proves nothing about flashback. It is the sim-side twin of `packages/cards/src/pool-mechanics.test.ts`
(which fails when a mechanic loses its last CARD). Witnesses are labelled `action`, `event` or `state`
so the weaker claim reads as the weaker claim.

**A new engine event breaks the build.** `SOAK_EVENT_WITNESS` is a mapped type over
`GameEvent['type']`, the same idiom as `OBSERVATION_POLICY` — so the next system to ship has to say
whether the soak should now require it, instead of quietly going untested.

**Every failure reproduces.** Decks and games are pure functions of a seed, and a violation prints the
seed **and both decklists**; paste them into a test.

**Never gate a soak on wall clock.** Ten agents share this box and the same build has measured
39–87 games/sec inside an hour. The tiers are sized in GAMES and the cost signal is
`process.cpuUsage`.

Two traps the soak itself fell into first, both worth knowing before you add an invariant:
1. **State-based actions are not checked mid-resolution** (CR 704.3, 608.2). Magma Jet deals 2 damage
   and then asks a scry question; the dead creature legally stays on the battlefield until that
   question is answered. Assert SBAs only when `pendingChoice` and `resolution` are both null.
2. **A leak scan must ask the state the action LANDED IN.** A land played from hand is named by
   `landPlayed` and by a public `zoneChange`, and it was in a hand a moment earlier — scanning against
   the pre-action state reports every land drop in the game as a leak. The equal and opposite mistake
   is scanning at the END of the game: a creature bounced to hand later retro-actively turns an honest
   `spellCast` into one.
3. **"Hidden before the window as well as after" is not enough either.** That is a one-window
   approximation and a bought-back spell walks straight through it: Elvish Fury resolves into its
   owner's hand and the pump it left behind expires at CLEANUP, naming it many windows later with the
   card still sitting in that hand. The scan tracks the ids that have **never once** been out of a
   hand or a library — which is what the promise above actually says — and needs no exemption list as
   a result.

### Web app — `apps/web`
| Suite | What it guards |
|---|---|
| `lib/play/session.test.ts` | Hotseat session: legal actions advance, illegal ones don't corrupt |
| `lib/play/mana-sources.test.ts` | **Modal sources (Birds) usable in manual play**; auto-tap picks colours and stops |
| `lib/play/auto-advance.test.ts` | Empty priority windows are skipped; real decisions never are |
| `lib/play/mana-tap.test.ts` | Manual tap menu, modal colour choice |
| `lib/play/targeting.test.ts` | Target inference + legal target enumeration |
| `lib/play/choice-session.test.ts` / `choice-view.test.ts` | Choice prompts in hotseat |
| `lib/online/auto-tap.test.ts` | **The online seat can actually cast a spell** |
| `lib/online/*.test.ts` | Connection, reducer, masked-view adapter, choice masking |
| `lib/cards/addSingleCard.test.ts` | **À-la-carte add**: fuzzy lookup, fidelity screening, mechanic queue |
| `lib/decklist/deckHealth.test.ts` | **A deck with an unplayable card is marked as such** |
| `lib/decklist/*.test.ts` | Decklist parsing, Scryfall resolution, deck building |
| `lib/scryfall/collection.test.ts` | Bulk name resolution (split cards, licensed names) |
| `lib/scan/*.test.ts` | Card scanning pipeline |
| `lib/proxy/*.test.ts` | Proxy sheet: printings, pagination, upscaling, overrides |
| `lib/sim/determinism.test.ts` | **THE parallel proof**: every run kind byte-identical at 1 worker and 12, unaffected by completion order, and equal to the sim's own single-threaded function — including the adaptive suggestions search, rank for rank |
| `lib/sim/plan.test.ts` | Shard plans TILE a run exactly; rounds split by slot so late waves still fill the machine |
| `lib/sim/pool.test.ts` | A dead worker doesn't hang a run; Cancel stops everything; warm-up |
| `lib/sim/history-store.test.ts` | The tuning record survives, and a record from another deck is REJECTED with a reason |
| `lib/replay-*.test.ts` | Match replay building, folding, formatting, quiet-phase skipping |
| `components/card-hover-position.test.ts` | Hover preview stays on screen |

### Server — `apps/server`
| Suite | What it guards |
|---|---|
| `server.test.ts` | Room lifecycle, action relay |
| `security.test.ts` | A client may only act for its own seat; hidden info never leaks |
| `choice-flow.test.ts` | Choices over the wire |

### Data tools — `packages/data-tools`, `packages/protocol`
Scryfall fetch/normalize/parse pipeline, and the masked-view protocol.

`packages/protocol/src/index.test.ts` pins masking on hand-built fixtures — including that
`collectInstanceIds` finds an id under **every** name the engine spells it with, and reads the KEYS of
an id-keyed map (`attackTargets`, `blocks`) and not only its values. It is fixtures only, by design:
protocol cannot depend on the card pool, so the full-pool proof lives in
`packages/sim/src/masking.test.ts`.

---

## The interaction matrix — `packages/cards/src/interaction`

Every suite above tests ONE system. This directory tests PAIRS of them, because
that is where a rules engine actually breaks: twenty-three systems landed here in
four days, each built by a different agent and each tested in isolation by its
own author, and an interaction has no author at all.

**The matrix is a test, not a document.**
[`interaction-matrix.test.ts`](packages/cards/src/interaction/interaction-matrix.test.ts)
holds a table with one line per *unordered pair* of shipped systems and the suite
refuses to let it be convenient:

| status | means | the suite enforces |
|---|---|---|
| `covered` | a test in this directory plays the pair in a real game | the named file exists |
| `elsewhere` | an existing suite already plays it | the named file exists |
| `gap` | the pair is genuinely wrong or unimplemented | it carries a **CR reference** and an entry in the GAP register |
| `n/a` | the two systems cannot interact | it carries a real reason |
| `untested` | they *can* interact and nobody has proved it | it carries what a test would need |

`untested` exists on purpose. Calling an unproved pair "not applicable" is how a
matrix becomes a claim instead of a measurement, so the honest category is a
first-class one and it is the biggest column.

**How to read it**

1. Open the table. Find the two systems you are about to touch.
2. `covered` → the named file is the test that will catch you.
3. `gap` → read the GAP register at the top of the same file. Every gap names the
   CR rule it violates, the reproduction that pins the **honest current
   behaviour**, and *why it was recorded rather than fixed*. A gap's reproduction
   is green today and goes **red the day somebody fixes the rule** — that is the
   signal to move the cell to `covered`.
4. `untested` → the note says what a test would need. Writing it is a good
   afternoon.

**How to add a system.** Add it to `SYSTEMS` with a WITNESS — a name `core` must
still export, and (where the shipped pool prints one) a card predicate. The
completeness test then fails and tells you *exactly which pairs you owe*: a new
system cannot land without stating what it does to every system already here.

**The house rules for a cell**, learned from the bugs in this repo:

- **Play a real game.** Every board comes from `createGame`, and every permanent
  reaches the battlefield by being cast (`harness.ts`'s `resolvePermanent` /
  `castCard` / `playLand`). A hand-built `CardInstance` carries its own
  `counters: {}` and so is structurally unable to see the frozen-`NO_COUNTERS`
  class of bug; a hand-built board is how three of these systems' defects hid.
- **Use real printed cards.** Pool cards by name where the pool prints one; a
  real Oracle record through the real compiler (`compiled()`) where it does not.
  Authoring a `CardDefinition` is authoring the answer.
- **Assert both halves of a legality claim.** The menu (`legal()`) keeps a pilot
  honest; the rejection (`rejectionOf()`) keeps a hand-built action honest. A
  guard proved only by an absent menu entry is decoration.
- **Sabotage-check it.** Break the rule the cell claims to guard and watch the
  cell go red. A test that cannot fail is this repo's single most-recorded
  defect shape.

---

## Unsupported mechanics

Cards whose printed text needs an engine system that does not exist yet are
**never** silently approximated — the compiler refuses them and the app files the
gap on a work queue. See [UNSUPPORTED-MECHANICS.md](UNSUPPORTED-MECHANICS.md) for
what is outstanding and how to pick it up.
