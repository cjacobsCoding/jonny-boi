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
