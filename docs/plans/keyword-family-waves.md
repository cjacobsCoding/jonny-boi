# The keyword-family waves — the work queue, and how a wave is run

**Measured 2026-09-03 against the whole printed corpus** (32,276 paper non-joke cards),
at 5,623 playable. Every number here comes from one command:

```bash
npm run build   # the scripts read dist, never src
node packages/cards/scripts/keyword-gap-report.mjs <corpus.json> --top 60
```

`sole` is the work-picking column: the card's ONE missing clause is this keyword's
printed line, so implementing the keyword makes the card playable. `blocked` is cards
that carry the keyword and also need something else; they come along free when their
other gap closes.

> ⚠️ **Pick from THIS report, not from `UNSUPPORTED-BACKLOG.md`.** The audit ranks by the
> compiler's refusal message, so its top row is a bucket of hundreds of unrelated
> sentences rather than one work item — DESIGN §3.120 has the measurement. A keyword is
> exactly one implementation, which is why the `sole` column predicts the delta: every
> family below that has shipped hit its prediction almost exactly.

---

## Why a FAMILY and not a keyword

A family is a set of keywords that share one engine shape. Implementing the shape once
and adding a row per keyword is what turns a 1-card fix into a 250-card one, and it is
the difference between the §3.10x results and the two-cards-for-nine-systems result the
August census recorded.

The shipped families, with what each cost and bought:

| family | keywords | cards | the shape that made it one job |
|---|---|---:|---|
| §3.102 evasion | fear, intimidate, horsemanship | +36 | "can't be blocked except by creatures that ARE something" — one `blockerMustMatchAnyOf` closed union |
| §3.103 combat declaration | bushido | +18 | a `blocksOrBecomesBlocked` trigger event; the siblings then needed only payloads |
| §3.104 devoid | devoid | +12 | `colors: []` already meant "printed colourless" |
| §3.105 poison | infect, wither, toxic | +57 | one CR 120.3 damage-result funnel, which also fixed noncombat lifelink and deathtouch |
| §3.106 upkeep costs | echo, cumulative upkeep, suspend, vanishing, fading | +104 | "at the beginning of your upkeep, bill or tick" + time/age counters |
| §3.107 combat keywords | exalted, rampage, flanking, landwalk, shadow, split second, myriad | +267 | subject-targeting trigger bodies, count-scaled pumps, and an attack-requirement solver mirroring the block solver |
| §3.109 anomalies | (protection, affinity, flying, trample) | +25 | the keyword was implemented; the printed LINE around it was not |

---

## Wave 2 — in flight (2026-09-03)

Branches are pushed; each holds a checkpoint commit made while the API was unstable.
None has run its gate yet.

| branch | family | sole | DESIGN § |
|---|---|---:|---|
| `feat/counter-keyword-family` | modular, undying, evolve, renown, bloodthirst, fabricate, unleash, backup, mentor, amass, riot, outlast, devour, bolster, reinforce, afterlife, dethrone, explore | ~156 | 3.110 |
| `feat/graveyard-cast-family` | unearth, scavenge, retrace, embalm, eternalize, encore, escape, jump-start, non-mana flashback costs | ~78 | 3.111 |
| `feat/cast-alternative-family` | evoke, dash, channel, foretell, prototype, blitz, plot, warp, entwine, replicate, conspire, surge, casualty, assist, splice, transmute, cipher, bloodrush, ninjutsu | ~168 | 3.112 |
| `feat/spell-count-family` | storm, cascade, ripple, learn, investigate, double, and the mill/scry shapes that still report | ~97 | 3.113 |

---

## Wave 3 — measured and ready to dispatch

### 3a. Face-down permanents and vehicles — the biggest single block left

| keyword | sole | blocked |
|---|---:|---:|
| morph | 49 | 153 |
| crew | 21 | **180** |
| megamorph | 11 | 31 |
| living weapon | 10 | 19 |
| equip (a subtype-restricted equip line, "Equip Human {1}") | 8 | 41 |
| ward (a non-mana ward cost, "Ward—Pay 3 life") | 7 | 48 |
| disguise | 7 | 43 |
| umbra armor | 7 | 16 |

**The shape:** face-down is a new state every characteristic read must honour, and the
honest way to get that is a DEFINITION SWAP — the instance's visible definition becomes
the 2/2 blank while the real card is remembered — so every existing consumer stays
correct without a second code path. Turning face up is a special action (CR 116.2b), not
a spell or ability. The observation seam must project a face-down card as hidden, because
it is hidden information. Crew is an activation cost that taps creatures whose power sums
to N, plus an until-end-of-turn type change; an uncrewed Vehicle is not a creature and
must not be one for any filter. Ward's payload widens from a number to a closed cost
union, folded by its own merge rule (two ward abilities charge both costs).

Crew's 180 `blocked` is the largest such column in the report: every Vehicle in the corpus
is waiting behind it.

### 3b. The recent-set keywords

| keyword | sole | | keyword | sole |
|---|---:|---|---|---:|
| power-up | 27 | | warp | 8 |
| soulshift | 18 | | sneak | 8 |
| exhaust | 14 | | waterbend | 8 |
| boast | 14 | | renew | 8 |
| vivid | 12 | | infusion | 8 |
| descend | 10 | | enlist | 8 |
| heal | 9 | | mayhem | 7 |
| repartee | 9 | | offspring | 7 |
| opus | 9 | | | |

⚠️ **These are newer than any model's training data. Do not implement them from memory.**
The printed reminder text in each card's Oracle text IS the rule; `keyword-cards.mjs`
prints it. Derive the rule from the reminder, cite the reminder in the comment rather than
a CR number you cannot verify, and when a keyword's reminder names a system this engine
does not have, leave it reporting and say so.

Check first whether each is a keyword or an ABILITY WORD (a label with the rule printed
after the dash) — the shipped ability-word machinery already strips those, so several may
be rows rather than systems.

### 3c. The older leftovers

| keyword | sole | note |
|---|---:|---|
| banding | 10 | the one genuinely gnarly old rule; damage assignment by the banding player |
| rebound | 9 | cast from exile on your next upkeep — the delayed-cast seam |
| extort | 8 | a cast trigger with an optional mana payment |
| regenerate | 8 | the shield exists; these are the printed forms the table misses |
| partner | 8 | 130 blocked, but partner needs a commander — see the out-of-scope report |
| cumulative upkeep | 8 | the non-mana cost forms §3.106 deliberately left reporting |

### 3d. The template sweep

Not keywords: printed sentences no rule matches, ranked by
`near-miss-report.mjs --top 200`. Work it only after the keyword queue thins, and skip
any shape a family owns. Use `gap-clauses.mjs` to find rows whose shapes CONCENTRATE —
a row of 605 one-offs is not a work item, a row where one shape covers 45 cards is.

### 3e. Delivery, which gates further pool growth

At 5,623 cards the display-index chunk is ~5.4 MB and the engine-pool chunk ~1.5 MB, both
bundled and both precached. The same design at 32,276 cards is a ~34 MB index that nobody
finishes installing on a phone. Sharding the index and loading the engine pool per deck
has to land before the pool grows much further. See §6 of the completion plan.

---

## How a wave is run

1. **Measure first.** Predict the delta from the `sole` column and write the prediction
   into the brief. After implementing, rebuild and re-measure; if the actual differs,
   explain why. A family that lands +36 against a prediction of 36 is evidence the tool
   works; one that lands +267 against 181 needs its surplus attributed (§3.107's was two
   class-level fixes that reached cards outside the measured shapes).
2. **One branch per family, one worktree per branch.** `feat/<family>-family`. The
   integrator merges; workers never merge to main and never merge main into their branch
   mid-flight.
3. **Ground truth, not memory.** `keyword-cards.mjs <corpus> <keyword>… --all` prints
   every sole-blocked card with its full Oracle text. Implement against those printed
   lines and pin real card names in tests. This exists because a rule written from a
   remembered wording matched no real card and no test could see it.
4. **Contiguous, labelled blocks in shared files.** `rules.ts` is 8k lines and every
   worker adds to it; a family-labelled contiguous block merges mechanically, a scattered
   diff does not. Never reformat or reorder existing code. New logic goes in new files.
5. **The compiler never approximates.** A card compiles only when every printed line is
   genuinely implemented; otherwise it reports the clause. A card that plays stronger OR
   weaker than printed biases the A/B verdicts this project exists to produce.
6. **The pilot must be able to play it.** A mechanic that introduces a choice needs a
   heuristic answer, and any new legality rule needs its mirror — one illegal pair makes a
   whole declaration illegal, and the pilot then loses everything else in it.
7. **Commit and push in small chunks.** Learned the hard way on 2026-09-03: the API spent
   hours returning 500/529 and killed every worker within a tool call or two. A worker that
   commits only at the end loses a whole session's context to one 529. Commit after each
   keyword or rule-table batch.
8. **The gate, in the foreground.** Full `npx vitest run --minWorkers=1 --maxWorkers=2`
   plus lint, build, and the card-index check. Judge by the file AND test counts, not just
   "0 failed" — a crashed worker silently drops files and still prints 0 failed. Stop any
   dev server first.
9. **The soak is the merge gate.** It plays randomised legal decks from the WHOLE pool and
   checks every invariant on every action, which is how it caught a defect that lived
   *between* two branches that were each green alone (§3.118). Run it after merging, before
   regenerating the pool.
