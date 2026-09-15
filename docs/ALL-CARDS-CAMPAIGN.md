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

## 6. Joke sets

Excluded per the mandate — Unglued, Unhinged, Unstable, Unsanctioned and kin. **Verify how the
candidate list is built and confirm they are already filtered**; if they are not, filter them and say
so rather than assuming.

## 7. Caleb's own decks are the first acceptance case

`docs/decks/` holds two real decks transcribed from photos. Between them, 17 distinct cards are
blocked across 9 families — so they are a good end-to-end test of whether the campaign is reaching
cards people actually own, rather than only the cards that happen to be easy.

## 8. Progress log

| date | accepted | delta | what landed |
| --- | --- | --- | --- |
| 2026-09-14 | 5,619 | — | baseline at mandate |
| 2026-09-15 | 6,500 | +57 | the {X}/derived-value amount vocabulary (DESIGN §3.149) — measured on the 32,341-card corpus against fork point `51919f7`, set-diffed (0 lost). **Kessig Wolf Run compiles; Trostani still needs Populate.** |

> ⚠️ **The 953-card row was the §2 trap for the third time: 954 cards, 880 shapes, 1.08 cards per
> shape.** And its NAME points at the wrong half — `xvalue-blame.mjs` shows **70% of it is a SENTENCE
> with no rule**, in this row only because its text contains the words "equal to". The amount
> vocabulary, which is what the row is actually about, is ~132 winnable cards. Run the two committed
> scripts before taking a headline from the table above.
