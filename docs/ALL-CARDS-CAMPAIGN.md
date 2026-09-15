# Every MTG card, playable (§ALL)

> **Status: standing campaign. Mandated 2026-09-14.** Caleb: *"but we NEED to be able to support
> them so do it!"* — after being told the 26,625 rejected cards are blocked by engine support, not by
> fetching. This file is the measured plan. **Do not re-scope from memory; re-run the numbers.**

## 0. The mandate

> import all those cards, then finish importing all mtg cards except for unglued, unhinged and other
> stupid sets

## 1. The measured baseline (2026-09-14)

From `packages/cards/data/expansion-report.json`, which is GENERATED — re-run it rather than
trusting this table:

```
candidates 32,276    accepted 5,619 (17.4%)    rejected 26,625    blocking families 103
```

**Nothing is missing for want of fetching.** A card enters the pool only when the Oracle compiler
reports every printed ability is implemented by a registered effect primitive. The generated pool
states the rule it exists to protect:

> *Nothing is approximated into the pool — an almost-right card would silently bias every A/B verdict
> the lab produces.*

That rule is the whole reason this app can be trusted, so the campaign raises the number by
**implementing mechanics**, never by loosening acceptance.

## 2. The trap at the top of the table

The largest row — *"a rules template the compiler does not recognize yet"*, **10,801 cards, 31% of
the backlog** — is an **aggregation artifact, not a system**. DESIGN §3.120 established this and it
must not be re-learned: it conflates thousands of distinct one-off sentences, and implementing the
single largest SHAPE inside it moves the playable count **by at most ~45 cards**.

So the backlog is not "six big systems". Pick work by SHAPE with `scripts/near-miss-report.mjs` and
`scripts/gap-clauses.mjs`, never by an audit row headline. In §3.120's own words: a 730-card headline
is not a 730-card lever.

## 3. Where the cheap cards actually are

Several rows carry an annotation saying **the hard half is already built**. Those are the
near-misses — the best cards-per-unit-work in the table, and the campaign should eat them first:

| cards | family | why it is cheap |
| --- | --- | --- |
| 730 | block restriction whose selector compares creatures / reads effective P/T | the CR 509.1c/d requirement solver itself is built |
| 531 | "at the beginning of..." trigger BODY | the trigger itself — every printed scope, the "you may" form, the intervening "if" — is implemented |
| 299 | copy-creating templates outside the closed tables | the copy system, token copies and delayed sacrifice tails are ALL implemented; three named selectors remain |
| 231 | "the chosen ..." READER | the named value IS stored on the permanent; this printed line has no rule that reads it |
| 215 | additional-cost wording on a mana ability | life and mana costs themselves are implemented |

That is roughly **2,000 cards sitting behind work that is mostly done**.

## 4. The ranked families (top 20 of 103)

| cards | cumulative | family |
| --- | --- | --- |
| 10,801 | 31.3% | a rules template — **aggregation artifact, see §2** |
| 5,640 | 47.6% | "you may / choose" template |
| 2,480 | 54.8% | counters template |
| 1,927 | 60.4% | graveyard template |
| 1,506 | 64.7% | sacrifice template |
| 1,449 | 68.9% | activated-ability template — **in flight** |
| 953 | 71.7% | {X} or derived-value template |
| 888 | 74.2% | targeted-trigger template |
| 788 | 76.5% | static-buff template |
| 730 | 78.6% | block-restriction selector — **near-miss, §3** |
| 556 | 80.2% | aura/equipment template |
| 531 | 81.8% | "at the beginning of..." body — **near-miss, §3** |
| 446 | 83.1% | filtered-targeting template |
| 432 | 84.3% | modal template |
| 431 | 85.6% | library-search template |
| 421 | 86.8% | library-look/reorder template |
| 312 | 87.7% | group-damage template |
| 300 | 88.6% | loyalty-ability template |
| 299 | 89.4% | copy-creating selectors — **near-miss, §3** |
| 244 | 90.1% | transform/double-faced template |

The tail is long: 103 families, and past roughly 90% the rows are tens of cards each.

## 4a. THE MANDATED ORDER (2026-09-14) — this overrides picking by family size

Caleb, setting the sequence explicitly:

> fix the stupid speed problem then import the missing cards from those two decks and implement all
> the new behaviors needed for them, then start importing all cards starting with newest and moving
> backwards

So the campaign runs in three phases, in this order:

**Phase 1 — the card browser must be fast first.** A pool heading toward 32,276 cards is unusable
in a grid that renders every tile; fixing the browser is a PREREQUISITE, not a parallel nicety. See
`DECKBUILDER-AND-ART.md`. (In flight.)

**Phase 2 — Caleb's own two decks, completely.** 17 distinct blocked cards across 9 families
(`docs/decks/`). This is deliberately NOT the cheapest work — it spans nine families to deliver two
decks — and it is the right call anyway: a lab that cannot play the owner's own deck is not yet a
lab. Every card listed in `docs/decks/*.txt` with a ✗ must compile, or the residue must be named
card by card.

**Phase 3 — the whole corpus, NEWEST SET FIRST, working backwards.** Not by family size.

⚠️ **This reorders everything in §4 and the near-misses in §3 — read those as a map of COST, not
as a running order.** A newest-first sweep will hit families in whatever order recent sets happen to
use them, so a wave's size is no longer predictable from the table. What the table still tells you
is which families are cheap when you reach them, and which single row (§2) is a trap whatever order
you arrive from.

**What phase 3 needs that does not exist yet:** the report groups by BLOCKING FAMILY, not by set or
release date. A newest-first sweep needs the candidate list ordered by set release, and progress
reported per set (“Dominaria United: 271 of 281 playable”). That is a change to
`scripts/build-expansion.ts` and the report shape, and it is the first task of phase 3 — measure the
axis before sweeping along it (rule 11).

## 4b. The phase-3 axis, measured (2026-09-15) — there is no date in the data

Measured before designing, per rule 11. **A newest-first sweep cannot be ordered today, and the
reason is one missing field rather than a missing report.**

| file | carries | verdict |
| --- | --- | --- |
| `packages/cards/data/expansion-report.json` | `{ name, missing[] }` per rejected card — **26,625 records, no set, no date** | cannot order |
| `packages/data-tools/data/card-index.json` | `set`, `collectorNumber`, `rarity` — but only for the **5,651 ACCEPTED** cards | wrong population: it is the cards already done |
| the fetched corpus (`fetch-full-corpus.mjs`) | `set`, `set_name`, `collector_number`, `rarity` — and **not `released_at`** | has the set, not the date |

So the join that phase 3 needs runs **corpus → set code → release date**, and only the last hop is
missing. Two ways to get it, and they are not equally good:

1. ❌ **Add `released_at` to the corpus projection.** One line in `fetch-full-corpus.mjs` — but the
   field it adds is the release date of *whichever printing Scryfall picked for that Oracle name*,
   and the header of that same file already records what that choice cost: for Black Knight, Capsize
   and Weakness it picks an MTGO-only reprint. A per-printing date would therefore file Alpha cards
   under a modern set, silently, which is the same defect wearing a different hat.
2. ✅ **A closed SET → RELEASE-DATE table**, fetched once from Scryfall's `/sets` endpoint (~1,000
   rows, small) and committed. Joining on `set` makes "newest first" a **sort over a table**, adding
   a set is a **row**, and a set code that is not in the table **reports** instead of being bucketed
   into the nearest thing that exists (rule 2). It also survives a corpus refetch unchanged.

**Phase 3, task 1 is therefore: commit the set table, join it in `build-expansion.ts`, and emit a
per-set section — `released`, `candidates`, `accepted`, `playable %`, and the top blocking families
*within that set*.** The last part is what makes the sweep pickable: §2 says a global family headline
is an aggregation artifact, and a family restricted to one set is a genuinely smaller, honest number.

⚠️ **Do not order sets by set code, collector number, or the order Scryfall returns them.** None of
those is chronological, and all three look chronological on a sample.

## 5. How the campaign runs

Established practice on this repo (DESIGN §6, and the keyword-family waves that closed whole
columns):

- **One family per worktree agent**, up to the box's safe concurrency (3-4 heavy lanes; this machine
  OOMs above that).
- Each brief: measure the family into shapes FIRST, implement the top shapes as closed-table
  templates, prove them against **real printed cards from the corpus**, regenerate the pool, and
  report the accepted-count **delta**.
- **The delta is the deliverable.** An honest small delta beats an inflated one, and a family that
  measures smaller than its headline is a finding worth reporting — §3.120 is exactly that finding.
- `compile/rule-coverage.test.ts` and `scripts/dead-rule-sweep.mjs` exist because a rule written from
  a remembered wording once matched no real card and no test could see it. Every new template is
  proven against the corpus or it does not ship.

## 5a. THE DELIVERY STEP — a compiled card is not a playable card

⚠️ **Nothing this campaign compiles reaches the app until the pool is REGENERATED.** The pool is
generated data; the compiler gaining a family changes nothing a player can see. That gap is this
project's signature failure — *built, tested, green and unreachable*, nine times — and the campaign
manufactures it by design, because every lane is told not to commit generated files (so that lanes
do not fight over one enormous file). **The regeneration is therefore a scheduled step, not a
side effect, and it is the only step Caleb can actually feel.**

### The whole pipeline is OFFLINE — verified by reading the scripts, not assumed

```
npx tsx packages/cards/scripts/build-expansion.ts --corpus <corpus.json>   # fills the scratch index
npx tsx packages/cards/scripts/build-expansion.ts                          # writes the three outputs
npm run fetch -w @jonny-boi/data-tools -- --corpus <corpus.json> --no-art  # refreshes card-index.json
```

Writes `packages/cards/data/expanded-pool.ts`, `packages/cards/data/expansion-report.json`,
`packages/data-tools/data/starter-cards.json`, then `packages/data-tools/data/card-index.json` — and
`apps/web/src/data/card-index.json` is DERIVED from that last one by
`apps/web/scripts/build-card-index.mjs`, with a test that re-derives it and fails on drift.

⚠️ **`npm run verify -w @jonny-boi/data-tools` is NETWORK** and must never run in a test or CI. The
`--corpus` form above is the offline one. They are one word apart and do very different things.

**All three artifacts move together or the app lies.** A pool ahead of the index renders bare ids and
blank art; an index ahead of the pool offers cards the engine will not play.

### State of the refresh (2026-09-15)

| ref | pool | canonical index | web index |
| --- | ---: | ---: | ---: |
| `origin/main` | 5,651 | 5,651 | 5,651 |
| `origin/fix/pool-refresh-3147` | **6,323** | **6,323** | **6,323** |

The second is a **complete and internally consistent** regeneration — all three artifacts in step —
plus four soak-defect fixes that took a wider pool from **754 violations to 4**. The session that
made it **ended before pushing**, so it existed only on one disk; it is now on the remote.

`origin/salvage/pool-refresh-3147` carries that session's **uncommitted** last change — the
diagnosis *and* fix for those final 4 violations. Whoever finishes the refresh starts from the
diagnosis instead of rediscovering it. Its reasoning is worth reading: a milled card is public the
instant it lands face up, but Sudden Reclamation mills three and returns one to **hand** inside one
resolution, so the card is public and hidden again with no decision boundary in between, and an audit
that can only compare settled states reads the engine's own `zoneChange` as a leak.

### Two corrections the refresh must carry

1. **The counters lane left an instruction that can only land WITH a regeneration**: add
   `if (!sourceCanHoldCounters(ctx)) return null;` to `put-counters-on-self` and delete the pinning
   test in `named-counters.test.ts`. **The accepted count falls by exactly 2** — Big Play and
   Miraculous Recovery, both rules-defective in the shipped pool — **and that fall is a correction.**
   `pool-mechanics.test.ts` is absolute by design: *a card dropped from the pool to make a test pass
   is the failure mode this guards*, which is why the fix cannot land alone.
2. Acceptance is **a card the app can find**, not a number in a report. Launch it, search the browser
   for the deck cards §7a marks ✅, and look. Every one of this project's nine unreachable-feature
   failures was caught by a harness or a screenshot, and none of them by a test.

## 6. Joke sets

Excluded per the mandate — Unglued, Unhinged, Unstable, Unsanctioned and kin. **Verify how the
candidate list is built and confirm they are already filtered**; if they are not, filter them and say
so rather than assuming.

## 7. Caleb's own decks are the first acceptance case

`docs/decks/` holds two real decks transcribed from photos. Between them, **16 distinct cards** are
blocked across 9 families — so they are a good end-to-end test of whether the campaign is reaching
cards people actually own, rather than only the cards that happen to be easy.

(The earlier "17" was a miscount: `Arbor Elf` appears in both lists and was counted twice. The 16
names are the `// ✗` lines in `docs/decks/*.txt`, deduplicated.)

### 7a. The acceptance board — one row per blocked card

Each ✅ is the acceptance test its own lane ran and pinned; the consolidated set-verified recount
waits on the pool refresh (§8 note). A card is ✅ only when **every** printed ability compiles.

| card | family | state |
| --- | --- | --- |
| Arbor Elf | activated ability | ✅ §3.147 |
| Doorkeeper | activated ability | ✅ §3.147 |
| Oblivion Ring | targeted trigger | ✅ §3.148 — was a near-miss on built machinery |
| Scavenging Ooze | counters | ✅ §3.149a |
| Luminarch Ascension | counters | ✅ §3.149a |
| Kessig Wolf Run | {X} / derived value | ✅ §3.149 |
| Selesnya Charm | target bound | ✅ §3.150 — **two of its three modes always compiled.** The blocker was never modal: `Exile target creature with power 5 or greater` is a printed BOUND on a target. |
| Trostani, Selesnya's Voice | Populate | ✅ — and it was a **near-miss with zero `packages/core` changes**: `proliferate` already asked a resolution-time choice over battlefield permanents, and the token-copy primitive already existed. |
| Jace, Architect of Thought | **three** clauses, three systems | ⛔ **well-evidenced NO-GO.** None of its three abilities is a loyalty problem: a duration-scoped delayed trigger, **opponent pile separation**, and the 5,640-card "you may / choose" row. Tests assert the counts (2 and 3), so a card quietly starting to compile one of them also fails. |
| Tamiyo, the Moon Sage | loyalty + emblem | ⛔ `+1` compiles; two residues pinned by name. The `−2` needs a derived count with a **subject-player axis `DerivedCountName` has no row for at all** — widening to `creaturesOpponentControls` would change the card. The `−8`'s second ability needs a *"put into your graveyard from anywhere"* trigger: 23 corpus cards print it, **1** prints this body. |
| Axebane Guardian | variable mana production | ⬜ `{T}: Add X mana in any combination of colors, where X is the number of creatures you control with defender.` **Two problems, not one**: a variable AMOUNT (`ManaAbility.produces` is a fixed mode list, `TapForManaAction.mode` an index) **and** *"in any combination of colors"*, which is a player choice at resolution. |
| Primal Surge | ⚠️ **misfiled** | ⬜ `Exile the top card of your library. If it's a permanent card, you may put it onto the battlefield. If you do, repeat this process.` The row calls it *"you may / choose"*; **the actual blocker is `repeat this process`** — an unbounded iteration. The "you may" half is ordinary. |
| Rhox Faithmender | life-change replacement | ⬜ `If you would gain life, you gain twice that much life instead.` The replacement layer watches damage, counters and draws; **life gain/loss is one more event kind** on a layer that already exists. |
| Fog Bank | damage prevention | ⬜ `Prevent all combat damage that would be dealt to and dealt by ~.` A two-directional prevention shield. |
| Craterhoof Behemoth | mass pump + keyword grant | ⬜ `When ~ enters, creatures you control gain trample and get +X/+X until end of turn, where X is the number of creatures you control.` The derived count is the family §3.149 landed — **re-blame; the residue may be only the mass keyword grant.** |
| Fiendslayer Paladin | targeting restriction | ⬜ `~ can't be the target of black or red spells your opponents control.` Hexproof-from-a-quality, by colour and by controller. |

**8 of 16 lane-verified · 2 evidenced NO-GOs · 6 unstarted.** Acidic Angels is down to **2** blocked
names (Fiendslayer Paladin, Rhox Faithmender); Defender Ramp still has **6**.

⛔ is not a shelf. It means the residue has been **named and pinned by a test**, so the card enters
the pool the moment the family that actually holds it lands — and a card that starts compiling while
its residue is supposedly unbuilt makes that test fail rather than sliding in unnoticed.

### 7b. What blaming the residue clause by clause showed (2026-09-15)

Each row above now carries **the printed clause the compiler actually refused**, read from
`expansion-report.json` rather than inferred from the family name. Doing that for ten cards produced
four findings that change how the next wave is picked — and none of them were visible from the
family column:

1. ⚠️ **`UNSUPPORTED_HINTS` first-match misfiles cards, and it is not rare.** `Populate` and
   `Axebane Guardian` are both filed under *"an activated-ability template"* — matched on the
   `{1}{G}{W}, {T}:` and `{T}:` prefixes, not on anything about the effect. The activated-ability
   lane merged (§3.147) and unblocked neither. **A row is a bag of cards whose text matched a regex
   first, not a family.** Cross-check a family by TEXT as well as by hint, or you measure the wrong
   population in both directions.
2. ⚠️ **The row name pointed at the wrong half a fourth and fifth time** — Primal Surge is filed as
   *"you may / choose"* when the blocker is `repeat this process`, and Axebane Guardian is filed as
   an activated ability when the blocker is a variable mana amount. §8a item 2 is not an anecdote
   about three lanes; it is the normal case.
3. ✅ **Two cards may be cheaper than their row says, because §3.149 already landed.** Trostani's
   lifegain clause and Craterhoof's `+X/+X` are both derived-value amounts. **Re-blame before
   scoping** — the honest number may have shrunk while nobody was looking.
4. ⚠️ **A multi-clause card is only as reachable as its hardest clause.** Jace needs three families
   and one of them is the 5,640-card row; Tamiyo's single emblem needs two different seams. A lane
   that takes such a card as its acceptance test should be told up front that a **well-evidenced
   NO-GO naming the residue is a successful outcome**, or it will be tempted to widen a template to
   swallow the clause it cannot do — which is the one thing the pool rule forbids.

## 8. Progress log

**Read the DELTA column, not an absolute.** Each lane measures its own delta by compiling one fixed
corpus twice with its sources reverted in between, and set-diffs the result. Absolute pool sizes from
different days are **not comparable** — the corpus itself was refreshed (32,276 → 32,341 candidates)
and the shipped pool lags the compiler. Any absolute below is annotated with the corpus it came from.

| date | delta | lane | what landed |
| --- | --- | --- | --- |
| 2026-09-14 | — | — | baseline at mandate: **accepted 5,619 of 32,276 candidates** |
| 2026-09-15 | **+106** | activated ability (PR #31) | DESIGN §3.147 — Arbor Elf ✅, Doorkeeper ✅ |
| 2026-09-15 | **+122** | targeted trigger (PR #32) | DESIGN §3.148 — Oblivion Ring ✅, a near-miss on machinery that was already built |
| 2026-09-15 | **+25** | counters (PR #33) | DESIGN §3.149a — Scavenging Ooze ✅, Luminarch Ascension ✅ |
| 2026-09-15 | **+57** | {X} / derived value (PR #34) | DESIGN §3.149 — 32,341-card corpus against fork point `51919f7`, set-diffed (0 lost). **Kessig Wolf Run ✅** |
| 2026-09-15 | **+43** | loyalty, emblem, untap (PR #39) | 32,341-card corpus against `fd1ca31`, set-diffed (0 lost). Attributed 36 freeze / 7 `and`-verb, **0 unattributed**. ⚠️ **Jace ✗ and Tamiyo ✗ — both honest NO-GOs**, residues pinned by name. |
| 2026-09-15 | **+175** | printed TARGET BOUND (DESIGN §3.150) | 32,414-card corpus against `fd1ca31`, set-diffed (0 lost). **Selesnya Charm ✅.** ⚠️ Only **28** of the +175 are modal — the CLASS was fixed, not the instance. |

⚠️ **These deltas do not add up, and must not be added.** Each was measured against its own fork
point on its own corpus, so the arithmetic sum (+528) is an upper bound, not a count. **The campaign
total is a set diff of the final `main` against the mandate baseline, run once after the wave lands**
— and if it is smaller than the sum, the smaller number is the one that goes in this table (rule 11).

### 8a. What five consecutive lanes proved — do not re-derive this

1. **Every family measured so far was an aggregation artifact** — **1.20, 1.18, 1.13, 1.08, 1.05 and
   1.04** cards per distinct shape, and one row measured at **1.00: every card in it prints a sentence
   no other card prints.** §2 is not a caveat about one row; it is the shape of the whole table.
   Measure into shapes first, and **report the smaller honest number** when it shrinks.
2. **The row's own NAME pointed at the wrong half in five of six lanes.** That is why each lane now
   ships a committed `*-blame.mjs` — `activated-`, `targeted-`, `counters-`, `xvalue-`, `loyalty-`,
   `modal-`, `copysel-`. Two rows turned out to name a half that **does not exist**: `modal-blame`
   reports **MODE-ONLY = 0** and `loyalty-blame` reports **COST-unknown = 0**. A lane taking either
   row at its name would have rebuilt a finished system.
3. ⚠️ **`UNSUPPORTED_HINTS` is FIRST-MATCH, and the leakage is large, not marginal.** The modal hint
   is anchored `^choose`, so **every modal TRIGGER** falls through to another row. Selecting the copy
   family by clause TEXT instead of by hint found **691 cards against 498 by hint — 193 cards of that
   shape sat in other rows.** **Assume every row in §4 is a bucket; the burden of proof is on anyone
   claiming otherwise.**
4. ⚠️ **Verify a delta as a SET, not a count** (`scripts/playable-set.mjs`). The {X} lane read "+55"
   while eight cards had silently left the pool, with every test green.
5. ⚠️ **`DERIVED_COUNTS` spread order is load-bearing** — `...FILTERED_DERIVED_COUNTS` then
   `...NAMED_DERIVED_COUNTS`, named last so it wins. `rules.ts` auto-merges **without a conflict**
   while reversing it, which costs 8 cards silently. Pinned by `xvalue-templates.test.ts:348`.
6. ⚠️ **A row moving barely at all is not a failed lane.** The loyalty row went 668 → 665 clauses
   while the lane gained 43 cards, and the copy row did not move at all while its lane gained 34.
   Cards come from fixing a CLASS wherever it appears; the row is where the class was *noticed*.

> ⚠️ **The 953-card row was the §2 trap for the third time: 954 cards, 880 shapes, 1.08 cards per
> shape.** And its NAME points at the wrong half — `xvalue-blame.mjs` shows **70% of it is a SENTENCE
> with no rule**, in this row only because its text contains the words "equal to". The amount
> vocabulary, which is what the row is actually about, is ~132 winnable cards. Run the two committed
> scripts before taking a headline from the table above.

### 8b. In flight (wave 5, dispatched 2026-09-15)

Three concurrent lanes — the box OOMs above three heavy builds, so three is the cap, not a
preference. All three edit `packages/cards/src/compile/rules.ts` in separate regions and expect a
real merge.

| worktree | branch | family | acceptance card |
| --- | --- | --- | --- |
| `jb-modal` | `feat/modal-templates` | modal (432) | Selesnya Charm |
| `jb-walker` | `feat/loyalty-emblem` | planeswalker loyalty (~300) + emblem | Jace, Architect of Thought · Tamiyo |
| `jb-copysel` | `feat/copy-selectors` | copy selector / Populate (299) | Trostani, Selesnya's Voice |

None of them may commit a regenerated pool: the local corpus trips a masking defect owned by the
live `fix/pool-refresh-3147` lane. They measure, report, and leave generated files alone.
