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

### Rules engine — `packages/core`
The pure, deterministic MTG engine. Everything here runs without DOM or network.

| Suite | What it guards |
|---|---|
| `engine.test.ts` | Game setup, turn/step machine, priority, the stack |
| `engine-regressions.test.ts` | Specific past engine bugs, pinned |
| `combat.test.ts` | Attack/block legality, damage assignment, evasion |
| `combat-declaration.test.ts` | Declaring **no** attackers/blockers still advances the step |
| `sba.test.ts` | State-based actions (lethal damage, 0 toughness, life ≤ 0) |
| `triggers.test.ts` | Triggered abilities: matching, ordering, resolution |
| `continuous.test.ts` | "Until end of turn" effects apply then genuinely expire |
| `mana.test.ts` / `mana-abilities.test.ts` | Cost payment; **summoning sickness gates `{T}`**; one tap = one mode |
| `hybrid-and-tapped.test.ts` | Hybrid pips; permanents that enter tapped |
| `targeting.test.ts` | A spell may only point at what it is printed to point at |
| `choices.test.ts` / `choice-cards.test.ts` | Player choice during resolution |
| `rng.test.ts` | Seeded RNG determinism (the whole sim rests on this) |

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
reaches the action cap; no stack object survives a turn; state-based actions leave no 0-toughness
creature, 0-loyalty walker or 0-defense battle; an instance is in exactly one zone and says so; life,
counters and mana pools stay in range; no card in a hidden zone reaches an observation;
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
   the pre-action state reports every land drop in the game as a leak.

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

---

## Unsupported mechanics

Cards whose printed text needs an engine system that does not exist yet are
**never** silently approximated — the compiler refuses them and the app files the
gap on a work queue. See [UNSUPPORTED-MECHANICS.md](UNSUPPORTED-MECHANICS.md) for
what is outstanding and how to pick it up.
