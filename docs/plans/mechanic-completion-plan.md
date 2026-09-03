# The mechanic-completion plan — what "all MTG mechanics functional" actually means

**Status:** re-measured **2026-09-03** against the WHOLE printed corpus (32,276 paper
non-joke cards). The August census below was measured against a 2,100-card most-played
sample; §1 and §7 are current, and §2–§4 are kept as the historical snapshot they are
(see the banner over §2).
**Scope of this document:** define the finish line with numbers, say what kind of work
actually moves it, and state honestly which cards are *not* worth chasing.

§1 comes from one offline measurement over the cached full corpus — every command that
reproduces it is in §7. The compiler is the only judge: a card counts as playable when
every printed line on it compiles to something the engine genuinely runs, never when it
compiles to an approximation.

---

## 1. Where we actually are

| | cards | share |
|---|---:|---:|
| Fully playable today | **5,623** | **17.4%** |
| Blocked by at least one gap | 26,653 | 82.6% |
| Compiler threw (a bug) | 0 | 0% |

Measured over all 32,276 printed paper non-joke cards, and every one of the 5,623 is
SHIPPED — the pool the app carries is generated from this same verdict, so the number
here and the number in the card browser cannot drift (§3.71, §3.118).

**Of the 26,653 blocked cards, 18,022 (67.6%) are blocked by exactly ONE clause.**
That is the shape of the remaining work: not a wall, a very long queue.

### What actually moves the number, measured

The August census recorded that nine engine systems moved the playable count by two
cards, and concluded the bottleneck was the rule table rather than the engine. That
conclusion was right, and the last two days put a number on the corollary: work picked
by MECHANIC moves the count, and each family hit its prediction almost exactly.

| family (DESIGN §) | cards |
|---|---:|
| the combat keyword family — exalted, rampage, flanking, landwalk, shadow, split second, myriad, attack requirements (§3.107) | **+267** |
| upkeep costs and time counters — echo, cumulative upkeep, suspend, vanishing, fading (§3.106) | **+104** |
| poison — infect, wither, toxic (§3.105) | **+57** |
| the keyword anomalies — protection from types/subtypes, semicolon keyword lines, affinity subtypes (§3.109) | **+25** |
| devoid (§3.104) | **+12** |

⚠️ **And the counter-lesson, which is why the ranked queues below are historical.** The
coverage audit ranks by the compiler’s REFUSAL MESSAGE, so its top row ("a block
restriction whose SELECTOR…, blocks 730 cards") is one bucket holding 605 distinct
printed sentences, the largest of which is 11 cards. `gap-clauses.mjs` measures that
split; `keyword-gap-report.mjs` ranks by mechanic, and a mechanic is exactly one
implementation, so its `sole` column is the one that predicts a delta. The full
argument, with the table, is DESIGN §3.120 — read it before picking work off an audit
row.

### Why nine systems bought two cards

A card is playable only when **every** printed line compiles. So the metric that
predicts progress is not "how many cards mention this mechanic" but "how many cards
have *nothing else* wrong with them".

Gaps blocking each of the 1907 blocked cards:

| gaps on the card | cards |
|---:|---:|
| 1 | 1070 |
| 2 | 576 |
| 3 | 190 |
| 4 | 60 |
| 5 | 8 |
| 6 | 3 |

1070 cards are exactly one gap from playable. But those 1070 cards are spread across
**670 different sole-blocking gaps** — a mean of 1.6 cards per gap. There is no single
lever. Getting to a high playable percentage is a grind of many small closures, and
the plan has to be built for that shape rather than hunting for another headline
system.

The headline system work is, in fact, nearly done:

| | distinct gaps | card-blocks |
|---|---:|---:|
| **Engine systems** (real work) | **21** | 259 |
| **Template gaps** (rule-table entries) | **1665** | 2831 |

**The engine is close to complete; the compiler's rule table is the bottleneck.**
Only 21 named engine systems remain in the entire most-played corpus, and they account
for 8% of the card-blocks. The other 92% is text the compiler has no rule for yet.

---

---

> ⚠️ **§2, §3 and §4 below are the 2026-08-18 snapshot, kept for the record.** Every
> number in them is against the 2,100-card most-played sample, and the queues they rank
> are ranked by refusal message (see the warning at the end of §1). Most of their
> "build" verdicts have since shipped — indestructible, blocking restrictions,
> alternative costs, modal DFC faces, the `//` type, Kindred, landwalk, battles,
> multikicker, typecycling, aftermath, emblems. Read them for the REASONING, which
> still holds; take the numbers from §1 and the live tools in §7.

## 2. The one thing to do first: a bookkeeping bug worth 34 cards

`packages/cards/src/compile/compile.ts` runs a **keyword sweep** after the rule table:
anything Scryfall lists in `card.keywords` that the compiler did not consume gets
reported as `the "X" keyword ability`. The sweep carries explicit "already handled"
guards for `ward`, `protection`, `enchant`/`equip`, `kicker`, `flashback`, and ability
words — but **not for scry, surveil, or mill**, which are implemented as effect
*primitives* matched by rules (`scry-n`, `surveil-n`, `scry-then-effect`, and the mill
rules) rather than as keyword flags.

So the rule fires, the line compiles correctly, and then the sweep reports the bare
keyword anyway. Measured:

```
### Opt -> incomplete
   oracle: "Scry 1. (Look at the top card of your library...)\nDraw a card."
   MISSING: the "Scry" keyword ability || text: "Scry"
```

Opt's *entire* text compiled. The only thing standing between it and playable is the
word "Scry" being reported twice.

**34 cards in the corpus are blocked by nothing but this** — 17 by Scry alone, 14 by
Surveil alone, 3 by Mill alone. Fixing it takes the playable count from **193 → 227
(9.2% → 10.8%)**, a 17.6% relative gain, for what should be three guard lines shaped
exactly like the existing `flashback` guard (skip the sweep entry only when the printed
line actually compiled, so a form the rules *don't* match still reports honestly).

Cards recovered include Opt, Preordain, Serum Visions, Consider, Read the Bones, all
ten Theros scry-Temples, Castle Vantress, Zhalfirin Void, and the Ravnica surveil-lands.

> **✅ FIXED on `fix/keyword-sweep-and-mana-templates` (2026-08-18).** The guard is
> evidence-based, like the flashback one: the sweep entry is skipped only when the
> compiled assembly actually contains the backing primitive, deep-walked (a scry can
> sit inside an ETB trigger, an activated ability, or another primitive's params).
> A wording the rule table does not match compiles no primitive and still reports.
> **Re-measured offline against the cached corpus: 193 → 227 playable, exactly the
> prediction below.**

---

## 3. The ranked queue

### 3a. Ranked by cards blocked (top 18)

`blocks` = cards naming this gap. `sole` = cards for which this is the **only** gap, i.e.
cards that become playable the moment it closes. **`sole` is the number that moves the
metric**; `blocks` tells you how much of the format touches the mechanic.

| # | gap | kind | blocks | sole |
|---|---|---|---:|---:|
| 1 | casting either face of a modal DFC / split card | **system** | 60 | 4 |
| 2 | alternative casting costs (cycling, buyback, madness) | **system** | 40 | 20 |
| 3 | the `//` card type | **system** | 38 | 0 |
| 4 | rules template: `At the beginning of your…` | template | 38 | 14 |
| 5 | rules template: `Indestructible` | template | 30 | 9 |
| 6 | you-may template: `As ~ enters, choose a…` | template | 27 | 0 |
| 7 | you-may template: `When ~ enters, you may…` | template | 25 | 16 |
| 8 | enters-tapped template: `~ enters tapped unless you…` | template | 24 | 15 |
| 9 | the "Scry" keyword ability | **system**\* | 22 | 17 |
| 10 | mana template: `{}: Add one mana of…` | template | 21 | 9 |
| 11 | blocking restrictions beyond evasion keywords | **system** | 20 | 9 |
| 12 | mana template: `{}: Add {} or {}…` | template | 20 | **20** |
| 13 | rules template: `At the beginning of each…` | template | 20 | 7 |
| 14 | search template: `Search your library for a…` | template | 16 | 10 |
| 15 | rules template: `Whenever a creature you control…` | template | 16 | 8 |
| 16 | the "Surveil" keyword ability | **system**\* | 16 | 14 |
| 17 | you-may template: `At the beginning of your…` | template | 14 | 8 |
| 18 | rules template: `This spell can't be countered…` | template | 14 | 1 |

\* Rows 9 and 16 are the keyword-sweep bug from §2, not real systems. The audit reports
them as systems because the sweep names them that way.

> **✅ ROW 6 CLOSED on `feat/as-enters-choices` (2026-08-20)** — `As ~ enters, choose a…`
> is a real system now, not a template: a `chooseValue` choice kind, the answer
> REMEMBERED on the permanent (`CardInstance.chosenAsEntered`), and four readers that
> consume it (an anthem, the permanent's own type line, a mana ability and a cast
> trigger). Its `sole` of 0 was honest — every one of those 27 cards prints a second
> line that reads the value back, which is why the readers had to ship with the naming.
> **Re-measured offline against the cached corpus: 408 → 414 playable.** What still
> blocks the rest is listed in DESIGN §3.23 by clause, and those lines now report as
> `a "the chosen …" READER the compiler does not recognize yet` rather than as a
> you-may template — the value IS stored; what is missing is the sentence that reads it.

Two rows deserve calling out. **Row 12** — `{T}: Add {U} or {R}` — is one rule-table
entry that alone unblocks **20 cards** (the dual-mana lands), the best
cards-per-hour ratio in the whole census. **Row 3**, the `//` type, has a `sole` of 0:
every split card also needs row 1, so shipping it alone changes nothing.

### 3b. Ordered for maximum yield

Closing gaps in raw-rank order is not optimal, because high-`blocks` rows overlap. The
greedy-optimal ordering (each step picks whatever newly unblocks the most cards):

| step | gap | kind | +cards | cumulative |
|---:|---|---|---:|---:|
| 1 | alternative casting costs (cycling/buyback/madness) | system | +20 | 20 |
| 2 | mana template `{}: Add {} or {}` | template | +20 | 40 |
| 3 | Scry (the §2 sweep fix) | bug | +17 | 57 |
| 4 | you-may `When ~ enters, you may…` | template | +16 | 73 |
| 5 | enters-tapped `~ enters tapped unless you…` | template | +15 | 88 |
| 6 | rules `At the beginning of your…` | template | +14 | 102 |
| 7 | Surveil (the §2 sweep fix) | bug | +14 | 116 |
| 8 | search `{}, Sacrifice ~: Search your…` | template | +12 | 128 |
| 9 | activated `{}: Add {}. Activate only…` | template | +11 | 139 |
| 10 | mana `{}: Add one mana of…` | template | +10 | 149 |
| … | | | | |
| 20 | the `//` card type | system | +11 | 244 |
| 30 | rules `Whenever ~ deals combat damage…` | template | +5 | 311 |
| 40 | search `When ~ enters, search your…` | template | +4 | 354 |

**Closing the best 40 gaps takes the corpus from 193 → 547 playable (9.2% → 26.0%).**
Of those 40 steps, 34 are template entries and 6 are engine systems. The yield curve is
already flat by step 30 (+5/step) and reaches +4/step by step 40 — after that it is a
long tail of ones and twos, which is what 670 sole-blocking gaps implies.

### 3c. The 21 remaining engine systems, in full

This is the complete list of named engine work left in the most-played 2100 cards.

| system | blocks | sole | verdict |
|---|---:|---:|---|
| modal DFC / split-card face choice at cast time | 60 | 4 | **build** — pairs with `//` |
| alternative casting costs (cycling, buyback, madness) | 40 | 20 | **build** — best system-tier yield |
| the `//` card type | 38 | 0 | **build, but only with the face-choice system** |
| the "Scry" keyword | 22 | 17 | **bug fix** (§2) |
| blocking restrictions beyond evasion | 20 | 9 | **build** — small combat-declaration hook |
| the "Surveil" keyword | 16 | 14 | **bug fix** (§2) |
| named keyword subsystems (evoke, affinity, …) | 12 | 3 | **build incrementally**, one keyword at a time |
| the "Mill" keyword | 12 | 3 | **bug fix** (§2) |
| Phyrexian / monocolour hybrid mana | 8 | 2 | **build** — cost-parsing + a pay-life option |
| the "Kindred" card type | 8 | 0 | **build** — a type-line word, near-free, but 0 sole |
| emblems | 7 | 0 | **defer** — 0 sole; every emblem card needs loyalty templates too |
| aura/equipment with no attach line | 3 | 0 | **defer** |
| multikicker | 2 | 0 | **defer** — kicker exists; this is the repeat-count variant |
| landwalk | 2 | 0 | **defer** |
| "Heal" keyword | 2 | 0 | **defer** |
| typecycling | 2 | 0 | **defer** — folds into cycling |
| aftermath | 1 | 0 | **defer** |
| landcycling | 1 | 0 | **defer** — folds into cycling |
| battles (siege / defense counters) | 1 | 0 | **do not build** (§5) |
| a card type the engine can represent (Battle) | 1 | 0 | **do not build** (§5) |
| "Explore" keyword | 1 | 0 | **defer** |

Two more items belong on this list that the audit files as templates, because they are
genuinely engine work rather than rule-table entries:

- **`Indestructible`** — 30 blocks, 9 sole. `KeywordFlags` in `packages/core/src/card.ts`
  has flying, menace, hexproof, shroud, ward, protection… and **no `indestructible`**.
  It needs a flag plus state-based-action and destruction-effect exemptions. Small
  engine change, 30 of the format's cards.
- **Counters-matter templates** — 153 blocks, 57 sole, across 117 variants. The engine
  *already* has counters (`CardInstance.counters`, honoured in the stat pipeline at CR
  613.3 layer 7d) and the `addCounters` primitive exists. So this is **not** a missing
  system: it is 117 rule-table entries against machinery that already works. It is the
  single largest template family with real machinery behind it, and the best
  medium-sized project on the board.

### 3d. Template gaps rolled up to their 32 families

1665 individual template gaps is too granular to plan against. Rolled up to the
compiler's own hint families (top 15 of 32):

| family | blocks | sole | variants |
|---|---:|---:|---:|
| a rules template (the general catch-all) | 865 | 447 | 617 |
| a "you may / choose" template | 453 | 200 | 261 |
| a counters template | 153 | 57 | 117 |
| an activated-ability template | 143 | 86 | 99 |
| a library-search template | 103 | 53 | 45 |
| a sacrifice template | 100 | 41 | 83 |
| a graveyard template | 95 | 30 | 77 |
| a mana-ability template | 86 | 52 | **24** |
| an {X}/derived-value template | 65 | 28 | 49 |
| a filtered-targeting template | 50 | 32 | 38 |
| a static-buff template | 45 | 12 | 36 |
| an enters-tapped template | 41 | 26 | **8** |
| a modal template | 39 | 29 | 22 |
| a targeted-trigger template | 36 | 12 | 24 |
| a loyalty-ability template | 27 | 3 | 38 |

Read the **variants** column as the cost and **sole** as the payoff. Two families are
dramatically underpriced:

- **mana-ability templates** — 52 cards unblocked for 24 rule entries (2.2 cards/entry).
- **enters-tapped templates** — 26 cards for 8 entries (3.3 cards/entry), the best ratio
  on the board.

Both are lands. Lands are the highest-yield work in the corpus because they are short,
formulaic, repeat across cycles, and every deck plays 24 of them.

> **⚠️ CORRECTION (2026-08-18, `fix/keyword-sweep-and-mana-templates`): the
> mana-ability row above is wrong, and it is wrong in the expensive direction.**
> It is not 52 cards for 24 rule entries. The plain forms this document points at —
> `{T}: Add {U} or {R}` (row 12) and `{T}: Add one mana of any color` (row 10) — had
> **already landed on `main`** (`tap-for-mana-choice`, `tap-for-any-color`) before this
> census was written; the audit still ranked them because the *remaining* wordings share
> their hint bucket. Everything left in that family needs **core's mana model to grow**,
> not a rule-table entry: core models a mana source as a fixed list of colour bundles —
> one tap, off the stack, no cost beyond the tap, no rider, no condition
> (`CardDefinition.produces`/`producesOptions`, `pushManaTapActions`, `applyTapForMana`).
>
> The compiler now names each shape as engine work, which moves **83 sole-blocked cards**
> out of the template column into five named systems:
>
> | mana gap (now a SYSTEM) | sole | blocks | examples |
> |---|---:|---:|---|
> | an ADDITIONAL COST on a mana ability | 35 | 52 | `{T}, Pay 1 life:` (Mana Confluence, the Horizon lands), the filter lands' `{R/W}, {T}:`, `{T}, Tap an untapped creature` |
> | a RIDER effect on a mana ability | 22 | 22 | every pain land + the whole Talisman cycle |
> | an ACTIVATION RESTRICTION on a mana ability | 15 | 17 | the Verge cycle, Nimbus Maze, Mox Opal |
> | mana COLOURS DERIVED FROM BOARD STATE | 7 | 11 | Reflecting Pool, Exotic Orchard, Fellwar Stone |
> | a SPEND RESTRICTION on produced mana | 4 | 15 | Cavern of Souls, Delighted Halfling |
>
> One genuine template remained and is closed: `{T}: Add three mana of any one color`
> (Gilded Lotus, +1). **Do not queue rule-table work against the other five** — there is
> no machinery behind them. Extending the mana model is instead the single highest
> card-per-hour ENGINE item on the board, ahead of alternative casting costs (20 sole).
>
> **✅ SHIPPED on `feat/mana-ability-model` (2026-08-19): four of these five are now real.**
> Core carries `CardDefinition.manaAbilities` — a per-ability additional cost, rider, activation
> restriction and board-derived colours. **Re-measured offline against this same cached corpus,
> PAIRED against the same-day `main`: 328 → 384 playable (15.6% → 18.3%), +56 cards** — the largest single-branch move the census has
> recorded, and comfortably ahead of alternative casting costs. The **spend restriction** (4 sole)
> is NOT shipped and is the one that is genuinely a different system: it colours the MANA rather
> than the source, so `ManaPool` would have to carry it and every payment path honour it. Two
> smaller residuals also still report by name: a cost that taps another permanent (Springleaf Drum)
> and a colour derived from a commander's identity (refused for good, §5).
>
> **✅ SHIPPED on `feat/mana-spend-restrictions` (2026-08-20): the fifth one too.** The POOL now
> carries the restriction (`ManaAbility.spendRestriction` → `ManaPool.restricted`), and `canPay`,
> `payCost`, the payment planner, the event log, the debug snapshot, the masked protocol view and
> the AI all honour it. **Re-measured on this same cached corpus against the matched `origin/main`
> (068be3d): 485 → 491 playable, +6, 0 regressions**, and the 15-card gap is gone. Six cards became
> playable — including Unclaimed Territory and Secluded Courtyard, whose "of the chosen type" clause
> reads the creature type `feat/as-enters-choices` already stores on the permanent — and the rest now
> report what they ACTUALLY need ("that spell can't be countered"; a production wording). The commander residual stands refused per §5, and the six
> cards that used to share its gap name were split out: they need a tapped-for-mana TRIGGER
> (Mirari's Wake, Zendikar Resurgent, Vorinclex, Kinnan, Extraplanar Lens, Incubation Druid), which
> is ordinary engine work and was invisible while it shared a name with a format decision.
>
> The same caution applies to §4's wave 1 ("Land templates: mana-ability (24) +
> enters-tapped (8) families, ≈305 playable"). The enters-tapped half is real template
> work; the mana-ability half is the engine work above.

By contrast **loyalty-ability templates** cost 38 entries for 3 sole cards — planeswalkers
each print three unique abilities and share almost nothing.

---

## 4. The path to done, as a sequence

| wave | content | est. cost | corpus playable after |
|---|---|---|---|
| **0** | The keyword-sweep guards (§2) — ✅ **DONE, measured 227** | hours | 193 → **227** (10.8%) |
| **1** | Land templates: mana-ability (24) + enters-tapped (8) families | days | ≈ **305** (14.5%) |
| **2** | Alternative casting costs (cycling/buyback/madness) + typecycling/landcycling as riders; `Indestructible` flag | days | ≈ **355** (16.9%) |
| **3** | Counters-matter: 117 rule entries against existing machinery | 1–2 weeks | ≈ **410** (19.5%) |
| **4** | Split / modal-DFC cast-time face choice + the `//` type together | 1 week | ≈ **475** (22.6%) |
| **5** | The "you may / choose" family (261 variants, 200 sole) | weeks | ≈ **675** (32%) |
| **6** | The general rules-template catch-all (617 variants, 447 sole) | the long grind | ≈ **1120** (53%) |
| **7** | The remaining ~600 one-off variants | open-ended | asymptotic to ~99.7% |

Wave counts after wave 4 are **projections from the measured `sole` figures**, not
measurements — a family's sole-count is exactly what it unblocks *if nothing else on
those cards is also broken*, and later waves overlap. Re-run the audit after every wave;
the projections are there to size the work, and the audit is what settles it.

**Waves 0–2 are the whole near-term program.** They are cheap, they are mostly data, and
they nearly double the playable corpus.

---

## 5. Where the line is — what we will not build

"All mechanics functional" should mean **every mechanic a deck a user could actually
build needs**. Stating that boundary explicitly rather than leaving it implied:

Measured against the 2,100-card sample this document was first written for, the
genuinely-unrepresentable set was **7 cards, 0.3%** — the categories below. The
full-corpus recount is at the end of this section.

| category | blocked cards | why not |
|---|---:|---|
| Commander colour-identity references | 4 | `Command Tower`, `Arcane Signet`, `Tome of Legends`, `Overpowering Attack` read a **commander**, an object this engine has no concept of and never will — it simulates 60-card 1v1. Modern-legal on paper, unplayable in any deck this app builds. |
| Sideboard / "outside the game" access | 1 | `Karn, the Great Generator` wishes for cards outside the deck. Requires a sideboard model *and* a tournament rule about what "outside the game" means; the sim has neither. |
| Dice rolling | 1 | `Delina, Wild Mage`. Implementable, but it injects a second RNG stream into an engine whose entire value proposition is **statistically comparable A/B runs**. Not worth the variance. |
| Coin flips | 1 | `Invert Polarity`. Same reasoning. |

That is the entire "never" list. It is worth being clear about how small it is:
**there is no large class of MTG mechanics this engine is structurally unable to
represent.** The 99.7% that remains is finite, named, and ranked — it is a grind, not a
wall.

Three further categories are **deferred, not refused** — they are buildable and would be
built if a user's deck needed one:

- ~~**Emblems**~~ and ~~**Battles**~~ — both were deferred here and both have since
  SHIPPED (see DESIGN "battles, legends and emblems"): the reasoning was that each
  unblocked nobody alone, and what changed is that their companion systems landed, so
  the pairing became cheap. The lesson to keep is the pairing test, not the verdict.
- **Multiplayer-only mechanics** (monarch, initiative, dungeons) — **0 cards in the
  corpus**. There is nothing to build; noted only so nobody goes looking.

### The success criterion, at full-corpus scale (2026-09-03)

The categories above were counted against the 2,100-card sample and came to 7 cards.
Re-counted against all 32,276 printed cards, the out-of-scope set is larger but still
small:

| category | cards | why not |
|---|---:|---|
| commander / colour identity / partner | 385 | reads a **commander**, an object a 60-card 1v1 engine has no concept of |
| multiplayer-only (monarch, initiative, dungeons, teammates, "each other player") | 244 | there is no third seat to model |
| dice | 69 | a second RNG stream, against an engine whose value is comparable A/B runs |
| coin flips | 67 | same reasoning |
| outside the game / sideboard / wishes | 57 | needs a sideboard model *and* a tournament rule for "outside the game" |
| **total** | **822** | **2.5% of the corpus** |

> **Done** = every printed paper non-joke card is either fully playable or falls in the
> 822 above. That is **31,454 / 32,276 = 97.5%**, and `keyword-gap-report.mjs` settles
> the numerator on demand. Today: **5,623 (17.4%)**.

⚠️ **822 is an UPPER bound on "never", and deliberately reported as one.** It is a
text-pattern count, so it over-counts in two known ways. Some of these cards are
already handled: **myriad** falls in the multiplayer bucket and §3.107 implements it
exactly — with one opponent the ability has no other opponent and does nothing, which is
the printed rule rather than an approximation. And some are merely deferred rather than
refused: a card whose only multiplayer clause is vacuous in 1v1 is playable the moment
someone writes the row. The honest reading is "at most 822 cards are out of scope, and
the real never-list is smaller" — the opposite direction from the one that flatters the
project, which is why it is stated this way.

The structural claim the sample-scale version made survives the rescaling, which is the
point worth keeping: **there is no large class of MTG mechanics this engine is unable to
represent.** What is left is 18,022 cards that are ONE clause from playable (§1) — a
grind, not a wall.

---

## 6. The other half of the problem: the shipped pool — ✅ SOLVED

This section used to be the most important one in the document. It recorded that the
compiler could read thousands of cards while the app SHIPPED 191, so ten landed systems
were unreachable for a player and six more existed on exactly one card each — "work is
landing that nobody can see".

**That constraint is gone.** The pool is generated from the corpus by the compiler's own
`complete` verdict (§3.71, re-run at §3.118), so every card the engine can genuinely
play is a card the app ships:

| | cards |
|---|---:|
| the pool this section was written against | 191 |
| after the candidate-list expansion (§3.71) | 5,097 |
| after the keyword families of 2026-09-02 (§3.118) | **5,623** |

Re-running this section's own probe — every shipped definition, asked for each landed
mechanic — gives the numbers it was written to shame:

| landed mechanic | was | shipped now |
|---|---:|---:|
| scry | 0 | 139 |
| protection | 0 | 105 |
| landwalk (§3.107) | — | 79 |
| surveil | 0 | 76 |
| mill | 0 | 69 |
| printed flashback | 0 | 61 |
| transform / DFC | 1 | 58 |
| modal ("choose one") | 1 | 54 |
| infect / wither / toxic (§3.105) | — | 54 |
| echo / cumulative upkeep / vanishing / fading (§3.106) | — | 51 |
| exalted / rampage / flanking (§3.107) | — | 40 |
| kicker / multikicker | 0 | 28 |
| `{X}` costs | 0 | 26 |
| suspend (§3.106) | — | 24 |
| characteristic-defining P/T | 1 | 23 |
| shadow / split second (§3.107) | — | 21 |
| ward | 0 | 15 |
| devoid (§3.104) | — | 12 |
| planeswalkers | 1 | 3 |

Every entry clears the rule of thumb this section set — *"the pool should contain at
least a playset's worth of cards for every landed system, or the system is not
deliverable"* — except planeswalkers, which stands at three and is the one row still
worth watching (loyalty abilities compile; the corpus's walkers mostly print a second
line the rule table has not matched yet).

The shopping list that used to live here is obsolete by construction: there is nothing
to shop for, because the pipeline admits every card that compiles. What replaced the
list is a pipeline invariant — **the index owns ids, the corpus owns everything else**
(§3.71) — and a test that re-derives the web display index and fails if the committed
bytes disagree.

⚠️ **The next constraint on this axis is DELIVERY, not coverage.** Measured off the LIVE
deploy at 5,651 cards with `npm run verify:deploy` — which fetches the deployed `index.html`,
reads the content-hashed chunk names out of it and sizes each one:

| live chunk | KB |
|---|---:|
| the display index | 5,821 |
| the engine pool | 1,603 |
| the app shell | 1,038 |
| **total JavaScript** | **8,462** |

The display index alone is ~1 KB per card, so the same design at 32,276 cards is a ~33 MB
download — an install nobody finishes on a phone, and it is all precached. Sharding the index
and loading the engine pool per deck is the open piece of work, and it has to land before the
pool can grow much further.

---
## 7. Reproducing every number here

```bash
# The corpus (network, once). The whole printed paper non-joke pool, ~14 MB, gitignored.
node packages/cards/scripts/fetch-full-corpus.mjs --out full-corpus.json

# Everything below is OFFLINE against that file, and is what §1 reports.

# how many cards compile, and which KEYWORDS block the rest (the work-picking tool)
node packages/cards/scripts/keyword-gap-report.mjs full-corpus.json --top 60

# the cards one keyword blocks, with full Oracle text (the ground truth for a brief)
node packages/cards/scripts/keyword-cards.mjs full-corpus.json morph crew --all

# the ranked backlog by refusal message, and the printed SHAPES behind any one row
node packages/cards/scripts/coverage-audit.mjs --input full-corpus.json --top 25 \
  --out UNSUPPORTED-BACKLOG.md --json audit.json
node packages/cards/scripts/gap-clauses.mjs full-corpus.json "you may / choose" --top 40

# one-clause-away shapes across all systems, and rules that match no real card
node packages/cards/scripts/near-miss-report.mjs full-corpus.json --top 200
node packages/cards/scripts/dead-rule-sweep.mjs full-corpus.json

# the finish line: how many cards are out of scope, and why (an UPPER bound)
node packages/cards/scripts/out-of-scope-report.mjs full-corpus.json
```

⚠️ **Every one of these reads `dist`, not `src`.** Run `npm run build` between any
source change and any measurement, reverts included — a stale `dist` has produced a
confident, plausible number for a tree that no longer existed.

`audit.json` carries the **complete** ranked tally — all 1686 gaps, each with its full
blocked-card list and a `kind` of `system` or `template`. The Markdown backlog is a
top-25 summary of it. The sole-blocker counts, the gaps-per-card histogram, the greedy
ordering, and the family roll-up in this document are all derived from that JSON by
inverting gap→cards into card→gaps.

⚠️ Re-run the audit after landing anything, and put the before/after in the commit.
"Blocks 153 cards" is a claim that expires.
