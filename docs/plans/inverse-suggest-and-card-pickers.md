# Suggest, run backwards — and card dropdowns everywhere

Two more items from Caleb on 2026-09-20, while he was testing the live Lab. Recorded **verbatim**
first, then what was measured about the code before any design. On this project the measurement has
repeatedly changed the shape of the work, and it changed the shape of **both** of these.

> TODO:
> -in the :Lab -> Suggestions, you can currently suggest a card for cutting in trade of some other
> unknown card. Can you make an alternative mode where you can do the opposite? And cut some card
> from the deck (try different ones) in order to get a different specific card into the deck?
> -anywhere that there is a drop down to choose from a list of magic cards in the whole app, each
> option in the list must be hoverable to show the specific card if you pause over an item for a
> couple seconds without clicking. Also, all such dropdowns should show a text-typable filter that
> optionally allows for fuzzy search if there are more than 10 options in the list - to make it
> easier to find what you are looking for.

---

## Item 5 — "cut something to fit THIS card in"

### ⚠️ The measurement: the engine has done this all along. Nothing reaches it.

`generateCandidates` (`packages/sim/src/suggest-candidates.ts:104`) takes a
`CandidateGenerationOptions` with **two symmetric restrictions**:

```ts
const cutDefs = resolveCuttables(base, pool, rules, config, options.cutOnly);  // line 114
const inDefs  = resolveAddables(base, pool, rules, options.inOnly);            // line 115
```

`inOnly` — *"only consider bringing these cards in"* — is exactly the mode Caleb is asking for. It is
plumbed through `suggest.ts:228` → `suggest-run.ts:192` → `suggest-candidates.ts:83`, and it is
**tested**: six cases in `packages/sim/src/suggest.test.ts` (lines 116, 143, 179, 330, 347, 395) pin
it, and `joint-moves.ts:327` uses it in production to restrict the going-up side of a land-count move
to the deck's basics.

**It is exposed nowhere a person can reach.** `cli.ts:1159` wires `cutOnly: flags.cut` and has no
`--in` flag. `apps/web` contains **zero** occurrences of `inOnly` — the Suggest panel exposes
`cutFocus` → `cutOnly` (§3.136, `SuggestPanel.tsx:90`) and nothing on the other side.

So this is the project's signature failure mode again — built, tested, green, and unreachable by a
player — and the request is **an exposure, not an engine feature.** Report it that way: the honest
number for this item is small, and pretending otherwise would be inventing work.

⚠️ **Verify that before building on it.** The claim "the engine already supports it" is this plan's,
made from a grep and a read. Call `suggest` with `inOnly` set and confirm the ranked table really
does hold the in-card fixed and vary the out-card, on a real deck, before writing any UI. If the
measurement disagrees, follow the measurement and say so.

### The shape

**A focus on each side of the swap, not a "mode".** The panel already has *"Consider cutting"*,
which restricts the OUT side and means "whole deck" when empty. The mirror is an **"Bring in"**
focus that restricts the IN side and means "whole pool" when empty. Two independent restrictions on
one search is one funnel; a "mode" switch would be a second vocabulary for the same question and the
two would eventually disagree (project rule 12).

That also gives Caleb's request for free *and* gives the case he did not ask for: **both** focuses
set at once is "is this specific swap an improvement?", which is a question the Lab cannot currently
be asked.

The panel's summary line already says what the search covers (*"— whole deck, playset"*); it must now
say both sides honestly, and when the IN focus is a single card it should say so in words, because
*"cut something to fit Sol Ring in"* is what the user thinks they asked for.

**The CLI gets the matching flag** in the same change (`--in`, mirroring `--cut`), because the CLI
and the panel reading the same option from two different plumbings is how they drift.

### Acceptance

1. `suggest` with `inOnly` fixed to one card returns a ranked table whose every row has that card as
   the IN and varying OUTs. Prove it on a real deck, not a fixture.
2. The Lab panel's Bring-in focus reaches `inOnly` — **a test that drives the panel and asserts the
   value arrives in the request**, not a test of the option object. This is the check that would have
   caught the gap this plan just found, so it is the one that matters most.
3. Both focuses set at once evaluates exactly the swaps in the cross product, and the summary line
   says so.
4. `--in` on the CLI produces the same candidate set as the panel for the same input.
5. Empty on either side still means "everything", and the existing §3.136 behaviour is unchanged
   (assert on a fixed seed).

Red first: return the unrestricted candidate set for a set `inOnly` and watch 1 and 4 fail; drop the
panel's wiring and watch 2 fail — **if 2 still passes with the wiring removed, the test is testing
the option object and not the reach, and it must be rewritten.**

---

## Item 6 — hover to see the card, and type to find it

### ⚠️ The measurement: half of this shipped in §3.165, and the other half is unmeasured

`apps/web/src/components/lab/CardPicker.tsx` exists on `main` and was built from an **earlier and
nearly identical request** of Caleb's:

> *"Anytime we have a card selector dropdown like this in the app, we must make it one where you can
> type to filter, and expose advanced settings to filter further too - to help you find the one
> card."*

It is a WAI-ARIA combobox — a text input filtering a listbox, arrow keys, Enter, Escape — with the
card browser's own colour and type chips, and pure filtering/ranking in `lib/lab/cardPicker.ts`. So
**"a text-typable filter" already exists** wherever that component is used.

What does **not** exist, on the evidence:

| asked for | state |
|---|---|
| typable filter | **shipped** in `CardPicker` (§3.165) |
| hover a couple of seconds → show the card | **absent** — no dwell/preview anywhere in the component |
| *fuzzy* matching | **NOT CHECKED** — `lib/lab/cardPicker.ts` filters and ranks; whether the match is substring or fuzzy was not read |
| the ">10 options" rule | **absent** as a stated rule — the filter is always shown, which is not the same as a rule the next dropdown will inherit |
| **"anywhere … in the whole app"** | **NOT CHECKED — and this is the item that matters** |

That last row is the real work, and it must not be guessed. `CardPicker`'s own doc-comment claims
*"Every selector that picks ONE card from a list of any size goes through this component"* — and on
this repo a doc-comment has already sent an agent to work a headline defect that did not exist, so
**the claim gets verified, not trusted.**

### ✅ MEASURED 2026-09-20 — the denominator, so the lane starts from the answer

`<CardPicker` appears in **exactly one** component, `components/lab/SwapPanel.tsx`. There is no
`datalist`, no `role="combobox"` and no `role="listbox"` anywhere in `apps/web/src` outside
`CardPicker` itself. The card-from-a-list surfaces are:

| surface | how a card is picked | `CardPicker`? | typable filter | hover preview |
|---|---|---|---|---|
| Lab → Swap (cut / add) | the `CardPicker` combobox | **yes** | yes — `lib/lab/cardPicker.ts` | **no** |
| Lab → Suggest (cut focus) | `cutOptions.map` → checkbox per card (`SuggestPanel.tsx:241`) | no | **none at all** | **no** |
| Deck Builder → **+ Add card** | free text + Scryfall fuzzy, `result.suggestions` as a `<ul>` (`AddCardDialog.tsx:98`) | no | yes — its **own** | **no** |
| Scan dialog → fix a misread card | `matchCardName(text, scanner.nameIndex, 6)` → suggestion buttons (`ScanDeckDialog.tsx:157`) | no | yes — a **third** | **no** |

Card GRIDS (the Cards view, the builder's grid) are out of scope: they are a filtered grid of tiles,
not a list you pick one option out of. Say so in the DESIGN section rather than leaving it implied.

**So the doc-comment is false of the app, while being defensible on its own terms** — the other
three are a multi-select, a free-text fuzzy, and a scan fixer, none of which is "picks ONE card from
a list". That is exactly the stale-comment hazard this repo has already been bitten by, and fixing
the comment is part of the work.

**Three implementations of "find me the card I mean"** — `lib/lab/cardPicker.ts`, Scryfall's fuzzy
via `addSingleCard.ts`, and `matchCardName` in the scan flow — is the rule-12 violation Caleb's
request is really about. **Zero of the four surfaces have the dwell preview.**

⚠️ **The Suggest cut-focus list is the worst one and should go first.** It is a checkbox list of
every distinct card in the deck — around 35 rows — with **no filter whatsoever**, and it is the
control a user reaches for when they want to focus a trim. Whether it should become a multi-select
`CardPicker` or keep checkboxes plus a filter is a design call; make it explicitly, and say which.

⚠️ Still **NOT CHECKED**: whether `lib/lab/cardPicker.ts`'s matching is substring or fuzzy. The other
two are known fuzzy (Scryfall's, and `matchCardName`). Read it before deciding what "optionally
allows for fuzzy search" has to add.

A partial sweep found nine `<select>` elements in `apps/web/src`
(`LabView`, `OnlinePlay`, `SwapPanel`, `SuggestPanel`, `SetupScreen`, `ProxiesView`, `PilotControls`,
`MatchView`, `CardToolbar`); the ones spot-checked list **decks, page sizes, scopes and opponents —
not cards.** That is *consistent* with the claim and does **not** establish it: the sweep searched for
`<select>`, and a card chooser built from buttons, a datalist, a custom listbox or a third-party
combobox would not match. **A search for the wrong name returns exactly what a genuine absence
returns** — this index's own standing lesson.

So the lane's **first** deliverable is the denominator: every place in the app where a person picks a
card from a list, how each one is built, and which already go through `CardPicker`. Report it as
`N of M` with M's source. Only then build.

### The shape

**One picker, and a gate — or the rule rots.** Caleb has now asked for this twice in different
words, which is itself the evidence that prose did not hold. Whatever the sweep finds, the outcome is:

- every card-from-a-list chooser goes through `CardPicker`;
- `CardPicker` gains the **dwell preview** (pause ≈ a couple of seconds over an option without
  clicking → the card itself) and the **>10 rule** as a named constant, not a literal;
- fuzzy matching is offered where the option count crosses that constant, and whether today's
  matching is already fuzzy is **measured and stated** before anything is rewritten;
- a **check fails if a new card chooser appears that does not use the component.** A grep gate over
  `apps/web/src` for the shapes a card list takes, with a narrow, named allowlist. This is the piece
  that makes the rule survive the next feature, and without it this plan is just the §3.165 comment
  again in a different file.

**The dwell is a named constant** (`CARD_PREVIEW_DWELL_MS`), and the preview must be reachable
without a mouse — a keyboard user arrowing onto an option gets the same preview, or the feature is
only for people who use a pointer.

### Acceptance

1. The sweep, committed as a script rather than a one-off count, reporting every card chooser and
   which component it uses. `N of M`, M's source stated.
2. Dwelling over an option for the constant shows that card; leaving before it does not; the
   keyboard path shows it too.
3. A list of ≤ the threshold does not offer fuzzy; one above it does. The threshold is a named
   constant and the test reads the constant, not a literal.
4. The gate fails on a deliberately added raw card dropdown, and passes on the allowlist.
5. Every chooser the sweep found is either through `CardPicker` or on the allowlist **with a reason
   written next to it**.

Red first: shorten the dwell to zero and watch 2 fail; hard-code the threshold in the test and watch
3 stop testing anything (rewrite it); add a raw dropdown and watch 4 fail.

---

## Ordering

Item 5 is small and self-contained and ships first. Item 6's sweep can start in parallel with it,
because the sweep is measurement and touches nothing.

Neither touches `packages/core`, the pool, or the Play board's rules. Item 6 touches the Play board's
**setup** screen only if the sweep finds a card chooser there.

## What was NOT checked, by name

- Whether `lib/lab/cardPicker.ts`'s matching is already fuzzy.
- Whether any card chooser exists outside a `<select>` element — **the central question of item 6**,
  deliberately left to a real sweep rather than answered from a partial grep.
- Whether the Play board's in-game choices (targets, modes) count as "dropdowns" for this rule. They
  are prompts, not dropdowns, so this plan reads them as out of scope — **ask Caleb if the sweep
  finds that they are the bulk of the card-picking surface**, rather than silently widening or
  narrowing his request.
