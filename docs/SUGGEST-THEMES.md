# The Suggest tab — themes, seed decks, and mana bases (§SUG)

> **Status: durable reference. NOT STARTED.** Raised by Caleb on **2026-09-14**.
> This file is the single source of truth for the scope. **Do not re-scope from memory.**
> Three requests, recorded 2026-09-14: themes (§1-4), building out from a seed deck (§5), and
> mana bases (§6).
> Companion to [MTGA-UX-OVERHAUL.md](MTGA-UX-OVERHAUL.md) (play surface) and
> [OFFLINE-AND-DISTRIBUTION.md](OFFLINE-AND-DISTRIBUTION.md) (delivery).

## 0. The request, verbatim

> make it so in the Lab -> Suggest tab of the app, it can determine what the strong themes or
> focus are in the deck and try to prefer cards for the deck that work will with, extend, or
> strengthen that theme. For example, in the Selesnya Blink deck, cards should be preferred that
> blink creatures, especially ones that can keep doing so (like Conjurer's closet!), as well as
> creatures with enter/leave battlefield effects. If the deck were considered weak on removal, it'd
> want to target cards for suggesting that do removal AND/OR reinforce that theme, ect ect.

## 1. MEASURED FIRST: half of this already exists, and the half that does is the *second* half

Read this before designing anything — the request reads as one feature and is two, and one of them
is largely built.

### 1.1 "If the deck were considered weak on removal…" — LARGELY BUILT

The suggestion engine already models **roles** and already steers toward gaps:

- `packages/sim/src/card-role.ts` — a `CardRole` taxonomy (`removal`, `threat`, `draw`, `dig`,
  `counterspell`, `damage`, `token`, …) derived from a card's **effect primitives** through the
  closed table `PRIMITIVE_ROLE` (`destroyTarget → removal`, `exileTarget → removal`, …). This is
  already rule-2 shaped: adding a primitive is a ROW.
- `packages/sim/src/deck-shape.ts` — `shapeOf()`, `ArchetypeFamily` (aggro / midrange / control /
  tempo), `referenceProfile()` built from a cohort, and `findRoleGaps()` returning
  `GapKind = 'missing' | 'thin' | 'heavy'`.
- `packages/sim/src/suggest-candidates.ts` — already imports `familyOf`, `findRoleGaps`, `roleOf`;
  builds `gapRoles` / `surplusRoles` (~:200-206) and feeds them into `scoreCandidate` as the
  pre-rank that decides **what gets scouted first**.

So "weak on removal ⇒ prefer removal" is **already the shipped behaviour**. The work here is to
*verify it does what Caleb thinks it doesn't*, and improve it only where measurement says so — not
to rebuild it. **If it is working, say so and spend the effort on §1.2 instead.**

### 1.2 "…prefer cards that work with, extend, or strengthen that theme" — DOES NOT EXIST

`grep -ni "synerg|theme|combo|etb|blink"` over `suggest-candidates.ts` returns **nothing**. The
engine has no notion of cards interacting with *each other*.

That is the real gap, and it is a genuinely different axis:

| | roles (built) | themes (missing) |
| --- | --- | --- |
| question | what does this card **do**? | what does this card do **with the others**? |
| unit | one card in isolation | a pair, or a card against a deck's profile |
| existing home | `PRIMITIVE_ROLE` table | nothing |

Caleb's own example is exactly the distinction: Conjurer's Closet is not "a removal card" or "a
threat" — it is valuable **because the deck is full of creatures with enter-the-battlefield
effects**, and worthless in a deck without them. No role taxonomy can express that.

## 2. Design constraints (from CLAUDE.md and the canon rules)

- **Rule 2 — a TABLE, not branches.** Themes must be data: a closed table of theme definitions, each
  naming the primitives/keywords that *constitute* it and those that *pay it off*. Adding "sacrifice
  matters" or "graveyard recursion" must be a ROW.
- **Rule 2 — closed tables REPORT.** A deck whose theme matches no row is reported as
  *no detected theme*, and the suggester falls back to the existing role behaviour. **Never guess a
  nearest theme** — a wrong theme silently biases every suggestion, which is worse than none.
- **Rule 3 — one answer to one question.** Theme detection must read the SAME primitive vocabulary
  `PRIMITIVE_ROLE` reads. Two parallel card-classification tables that drift is the exact failure
  rule 3 names. If the theme table needs a fact the primitive table already knows, derive it.
- **Rule 4 — measure before building.** Before writing a theme table, MEASURE against the real pool:
  how many of the 6,000+ cards carry each candidate theme's constituent primitives? A theme matching
  4 cards is not worth a row. Commit the script; report the honest number, and if it shrinks the
  plan, follow the measurement.
- **Rule 7 / perf.** `buildCandidates` runs over the whole pool inside a worker. Theme scoring joins
  that hot loop. Measure candidate-build time before and after and report both.

## 3. The acceptance question, made falsifiable

Vague ("suggestions feel more thematic") is untestable. The falsifiable version, using Caleb's own
example:

> Given the **Selesnya Blink** sample deck, the pre-rank must place repeatable-blink and
> ETB-creature cards **above** cards of equal role-fit and curve-fit that do not interact with the
> deck's contents — and Conjurer's Closet specifically must rank above a vanilla creature of the
> same cost and colour.

That is a unit test over the pure candidate layer (no games, no RNG, no clock — which is exactly why
`suggest-candidates.ts` was built pure). Ship it with the feature.

A second guard worth having: **the inverse**. In a deck with no ETB creatures, Conjurer's Closet must
NOT be promoted. A theme bonus that fires everywhere is not a theme bonus.

## 4. Where the seams are

- Theme table + detection: a new pure module beside `deck-shape.ts` (it answers a deck-shaped
  question, and `shapeOf` is its natural neighbour).
- Scoring: `scoreCandidate` in `suggest-candidates.ts` already takes a `deckProfile` and
  `HeuristicWeights` — the theme contribution is a new weighted term there, with its weight named in
  `suggest-config.ts` like every other (`DEFAULT_HEURISTIC_WEIGHTS`), never inlined.
- UI: Lab → Suggest should *say* which theme it detected and that it is steering by it. A suggester
  that silently changes its ranking is indistinguishable from a broken one — and per rule 60, a
  fallback (no theme detected) must REPORT that it fired.


---

## 5. Building a deck out from a SEED — "just two creatures that work well together"

### 5.1 The request, verbatim

> make it so that a deck with less than 60 cards can still be suggested for somehow - ideally, I
> could make a deck with just two creatures that work well together, and use the Suggest tab to
> build out a deck that works well with and reinforces the concept.

### 5.2 MEASURED: this is not "lower the minimum", and the reason matters

`minDeckSize: 60` is already a named field on `DeckRules` (`config.ts:87`), not a literal — so
lowering it is a one-line change. **That change alone would not work**, and would quietly produce
nonsense:

**The entire suggestion engine is 1-for-1 SWAP, and deck size is invariant by construction.**
`swap.ts` exports `CardSwap`, `applySwap`, `copiesSwappedBy`, `evaluateSwap`,
`summarizePairedSwap` — and nothing else. `applySwap` splices out *n* copies and splices in exactly
*n* (`swap.ts:146-153`). There is **no add operation and no remove operation anywhere**.

That invariance is load-bearing, not incidental: `evaluateSwap` is a PAIRED comparison — the base
deck and the variant play the *same seeds and the same games*, which is what makes the A/B
statistically honest (and what the Pocock sequential boundaries in `sequential.ts` are built on).
Two decks of different sizes shuffle and draw differently; the pairing stops being a controlled
comparison.

### 5.3 The design that reuses the engine instead of forking it (rule 3)

Do **not** add a parallel "grow" pipeline beside the swap pipeline — that is two answers to
"is this deck better?", and they will diverge.

**Express the seed as a legal deck and let the existing engine iterate.** Take the 2-card seed, fill
to `minDeckSize` with a declared, deliberately-weak FILLER (basic lands in the seed's colours is the
obvious choice), and run the normal suggest loop. Every filler slot is then an ordinary cut
candidate, and the engine's existing machinery — paired games, sequential stopping, role gaps, and
the §1-4 theme steering — does the building. The deck is legal at every step, so nothing downstream
needs to know it began as a seed.

Two things this needs, and both are honest work rather than plumbing:

1. **The filler must be recognisable as filler**, so the suggester prefers cutting it over cutting a
   real card, and so the UI can say "43 slots still filler". A named marker on the deck entry, not a
   guess by card name.
2. **A seeded run wants many iterations, not one swap.** The existing loop suggests one swap at a
   time; building 58 slots means iterating. Whether that is a new "build out" mode over the same
   engine, or just the user pressing Suggest repeatedly, is a UX decision — but the ENGINE should
   not need a second mode.

### 5.4 The falsifiable acceptance test

> Seed a deck with Conjurer's Closet + one ETB creature. After a build-out run, the resulting 60-card
> deck contains **more ETB creatures than the filler baseline would predict by chance**, and the
> report names the theme it built toward.

Without §1-4's theme detection this produces a generically-reasonable deck, not the one Caleb
described — so **§5 depends on §1.2 and should be built after it.**

---

## 6. Mana bases

### 6.1 The request, verbatim

> make it so that the suggest tab in the Lab can also be used to improve mana bases - whether that
> means more lands and less non-lands, vice versa, changing which lands, ect.

### 6.2 MEASURED: the OPERATION already exists; the DIAGNOSIS does not

This is the same shape as §1 — the machinery is there and nothing steers it.

- **Lands are already addable.** `resolveAddables` (`suggest-candidates.ts:321-339`) walks
  `pool.cards` and excludes only copy-limit violations and an explicit allow-list. **It does not
  filter out lands.** A land is a legal `inId` today.
- **Lands are already cuttable**, with a floor: `resolveCuttables` respects `minBasicLandsKept`
  (`suggest-candidates.ts:~101, ~301`).
- Therefore **"more lands, fewer spells" is already expressible** as a swap — cutting a spell for a
  land changes the ratio while keeping the deck at 60. So is "change which lands" (Forest → Mountain).

**What is missing is that nothing ever suggests it.** `scoreCandidate`'s pre-rank is colour match +
curve fit, and `findRoleGaps` classifies by `CardRole` — a taxonomy of what *spells* do. There is no
role for "land", no notion of a mana base being **screwed** (too few / wrong colours) or **flooded**
(too many), so a mana fix is never promoted and, being an unremarkable candidate, is unlikely to be
scouted before the budget runs out.

### 6.3 What to build

A mana diagnosis that sits beside `findRoleGaps` and feeds the same pre-rank:

- **Measure from the games, not from a rule of thumb.** The sim already plays thousands of games and
  the engine records mulligans and land drops. Screw/flood is *observable* — a deck's real
  distribution of "lands in opening hand" and "turns with a land drop missed" beats any
  17-lands-per-deck heuristic, and this project's rule 4 says pick from data. There is already soak
  and bench tooling to hang this off.
- **Colour requirements are a real constraint, not a preference.** A deck wanting `{G}{G}` on turn 2
  needs a different base from one wanting `{1}{G}`. `mana-plan.ts` already models what a cast
  requires; reuse it rather than inventing a second answer (rule 3).
- **Report the diagnosis.** Like every other closed table here: if the mana base looks fine, say so
  and steer normally. A silent mana bias would be indistinguishable from a bug.

### 6.4 The falsifiable acceptance test

> Given a deck deliberately built with 12 lands, a suggest run proposes **adding lands** and the
> report names flooding/screw as the reason. Given the same deck at 26 lands, it proposes **cutting**
> them. A diagnosis that fires in only one direction is not a diagnosis.
