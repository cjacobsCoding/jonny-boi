# The Lab's verdicts and tunables — the 2026-09-20 follow-up wave

Caleb ran the Lab against the build that shipped §3.174 (trim), §3.175 (manabase) and §3.177 (the
joint search) and sent two items. Recorded **verbatim** first, then what was measured about the code
before any design — the house rule, because on this project the measurement has repeatedly changed
the shape of the work.

> TODO:
> -the new trim feature needs to have more tunables - right now it tries to cut one card at a time -
> it should allow you to try to cut more than one at a time.
> -tolerances for trim, manabase, and search may be too tight currently... And should be tunable.
> Testing this, almost every result is showing inconclusive.

> Also TODO:
> -setting the settings in the Trim tool that should keep it looking until it reaches its target
> doesnt actually make it reach its target - it will do a couple waves then stop for some reason

**The three are one story.** Item 3 is a bug, and items 2 and 3 compound into exactly the behaviour
he is describing — read item 3 first.

---

## Item 3 — "keep looking" stops after two rounds. FOUND, and it is not mysterious

### The measurement

`trimDeck` (`packages/sim/src/trim.ts:950`) widens through a closed table:

```ts
export const TRIM_ROUND_KINDS = ['singles', 'pairs'] as const;
```

and `nextWideningStep` returns the next row after the current one, or `undefined`. So under
`keep-looking`:

| round | kind | found nothing → next kind |
|---|---|---|
| 1 | `singles` | `pairs` |
| 2 | `pairs` | **`undefined` → `stopped: 'exhausted'`** |

**"Keep looking" gets exactly two rounds.** That is the "couple waves then stop." The setting is
read by a user — correctly — as *keep looking until it reaches the target*, and the code reads it as
*advance one row in a two-row table*. The table is fine; treating the end of it as the end of the
search is the bug.

### ⚠️ Why item 2 makes it fire every single time

`runTrimRound` sets `verdict: winner ? 'improved' : 'exhausted'` (`trim.ts:752`), and `winner` is a
row whose verdict is `'better'`. By item 2's measurement almost every row is coming back
**inconclusive**, so there is never a winner, so **every** round ends `exhausted`, so the ladder
widens once and the session stops — having cut **zero** cards and reporting the word "exhausted",
which reads as *nothing helps* when what actually happened is *nothing was measured deeply enough to
tell*.

That conflation is the same defect as item 2, one layer up, and it gets the same fix: a round that
ended with every row inconclusive has not learned that nothing helps. It has learned nothing.

### The shape

**`keep-looking` keeps looking, and the lever after the kinds run out is DEPTH, not more kinds.**
When a round ends with no winner and the kind table is exhausted:

- if the round had **inconclusive rows**, re-run the best of them with a larger
  `gamesPerCandidate` (the existing depth parameter, `trim.ts:494` — it is already there and the
  loop simply never changes it), growing by a named factor up to a named cap and the session's
  game budget;
- only when the rows are **conclusive** and none is better is the search genuinely over, and that
  is a different stop reason from "we ran out of budget while still unsure".

**`TrimStopReason` splits.** `'exhausted'` today covers two opposite situations. It becomes a closed
set that says which: nothing left to try and the rows were conclusive · out of budget with rows still
inconclusive · the user's `pause` setting · target reached. The panel prints the one that happened —
and when it is the budget, it prints what raising the budget would buy, using item 2's
games-to-settle estimate.

**A round budget is still a budget.** `keep-looking` is not permission to run forever: the session's
game and time budget is the boundary, and hitting it is a reported stop reason, never a silent one.

### Acceptance

1. A rigged session whose rows are all inconclusive and whose deck is above target does **not** stop
   after two rounds: it deepens, and the test asserts `gamesPerCandidate` actually grew.
2. A rigged session whose rows are conclusively not-better stops immediately with the *conclusive*
   stop reason — deepening a settled question is waste, and this is the check that keeps the fix
   from becoming an infinite loop.
3. The budget boundary stops the session with its own reason, and the deck is returned as it stands.
4. Each stop reason renders its own words in the panel; a test enumerates the reasons and fails if
   one has no wording — the guard against this class returning.
5. **Driven for real, on Caleb's deck**: a `keep-looking` trim session that previously stopped after
   two rounds now either reaches the target or stops with a reason that names the budget.
   Screenshot, and the round count before and after.

Red first: pin `gamesPerCandidate` and watch 1 fail; make every rigged row inconclusive and watch 2
fail; remove one reason's wording and watch 4 fail.

---

## Item 2 — INCONCLUSIVE is three different answers wearing one word

### What was measured

`decideVerdict` is the single funnel every A/B surface in the app reads —
`swap.ts:438` (Suggest and trim), `manabase-reliability.ts:347,361`, `pilot-ab.ts:503`,
`suggest-report.ts:233`, and the web merge at `apps/web/src/lib/sim/merge.ts:167`. It is
seven lines (`packages/sim/src/swap.ts:466`):

```ts
if (nGames < minGames) return 'inconclusive';
if (pValue >= alpha) return 'inconclusive';
if (delta > 0) return 'better';
if (delta < 0) return 'worse';
return 'inconclusive';
```

**Three different situations come out of that function as one word.** A sample too small to say
anything (`n < 30`), an effect that is real-but-unproven at this depth (`p ≥ 0.05`), and a dead heat
(`delta === 0`) are all printed as INCONCLUSIVE. Caleb cannot tell which he is looking at, and the
three want opposite responses: *spend more games*, *the bar is the problem*, *there is nothing here*.

This is the project's own oldest defect class one level down — a check whose failure mode reports
something other than what happened. It is fixed the same way: the funnel reports the reason.

### ⚠️ The honest diagnosis: the tolerance is probably NOT what is binding

In the §3.177 joint run on Thune's Life that shipped with that section, **863 games** were spread
over a land-count table of 5 counts × `PARTNERS TRIED = 4` ≈ **20 arms ≈ 43 paired games each**,
with observed deltas of −4.4% / −8.7% / +3.3% / +6.7%. Forty-three paired games cannot clear
`alpha = 0.05` at those effect sizes under McNemar no matter what — the discordant-pair count is
simply too small. So the leading cause of Caleb's wall of INCONCLUSIVE is **budget spread across too
many arms**, not the 0.05.

That does not make the request wrong; it makes it incomplete. Loosening alpha alone would promote
noise to "better" and the Lab would start recommending swaps that are not improvements — which is
the exact failure the paired A/B exists to prevent. So this wave ships **three things together**,
and the third is the one that actually answers him:

1. **the reason**, so INCONCLUSIVE stops being one word;
2. **the tunable**, because he asked for it and because a 0.10 bar is a legitimate choice for
   exploration as long as the panel says that is what it is;
3. **the number of games that would settle it**, so a dead end becomes an action.

### The shape

**`decideVerdict` returns a verdict and a REASON, in one closed table.** Rows, not branches — a new
reason is a row. The reason vocabulary is closed (`tooFewGames`, `notSignificant`, `deadHeat`,
plus the two conclusive ones), so a value outside the table reports honestly rather than being
widened to the nearest thing that exists.

Every consumer above renders the reason. Nobody re-derives it; the function that decides is the
function that explains, or the two will eventually disagree and the bug will be blamed on neither.

**`alpha` and `minGamesForVerdict` become Lab settings**, persisted like the other Lab settings, with
`DEFAULT_STATS_CONFIG` still the default. `z` is DERIVED from alpha, never entered separately — they
are one confidence level and two fields that can disagree is a bug waiting to be filed. The panel
states the bar it used in words next to the verdict, so a result read at 0.10 can never be mistaken
later for one read at 0.05.

**The games-to-settle number.** For a paired McNemar test the discordant pairs are what carry the
signal, so the estimate is computed from the observed discordant counts, not from the win-rate delta.
Shown as *"~N more paired games at this observed split would clear alpha = 0.05"*, and honestly
absent when the observed split gives no estimate (a zero delta has no N). **It is an estimate and
the panel says so** — it must never be printed as a promise.

### Acceptance

1. Each of the three inconclusive situations is reproduced from a hand-built input and reports its
   own reason: `n = 29` → `tooFewGames`; `n = 400, p = 0.31` → `notSignificant`; `delta = 0` →
   `deadHeat`.
2. A test enumerates the call sites of `decideVerdict` and fails if one renders the verdict without
   the reason — the guard that fails if this class comes back.
3. `alpha` set to 0.10 in the Lab flips a verdict that reads `notSignificant` at 0.05, the panel
   states 0.10, and `z` moves with it (assert the interval width changed).
4. The games-to-settle estimate, on a rigged split with a known answer, lands within a stated
   tolerance of it — and is absent, not zero, when there is no estimate.
5. **Driven for real:** a Lab run whose table previously read all-INCONCLUSIVE now reads a reason on
   every row. Screenshot in the report.

Watch every one go **red** first: collapse the reason to a constant and see 1 and 2 fail; pin `z` and
see 3 fail; return 0 instead of absent and see 4 fail.

---

## Item 1 — trim cuts more than one card at a time

### What was measured

`packages/sim/src/trim.ts` (979 lines) evaluates **single-card removals**: a round's candidate set is
the distinct nonlands plus the distinct lands, and a removal is a swap whose "in" is nothing, so the
whole paired-A/B apparatus is reused rather than re-invented. `landRatioOf(deck, pool)` derives the
base ratio from the deck — **it is not hardcoded**, which is worth stating because a reasonable
reading of the panel's *"target ratio 24/60"* suggests otherwise.

So "cut more than one at a time" is not a new mechanism. A k-card cut is a swap whose "in" is nothing
and whose "out" is k cards — the same fold, one parameter wider. That is the shape to build, and it
is the same move the joint lane made when it widened `applyManabase` to take steps rather than a
whole variant (project rule 12: one funnel, not two).

### The shape

**A tunable cut size k**, persisted with the other trim settings, default 1 so today's behaviour is
unchanged. A round with k > 1 evaluates k-card removals.

⚠️ **The combinatorics are the whole design problem and must not be hidden.** A 63-card deck has
~35 distinct cards; k = 1 is 35 candidates, k = 2 is ~600, k = 3 is ~6,500. Enumerating them all and
running a paired A/B on each would spend the entire budget on a table nobody can read — and by
item 2's measurement, spreading the budget that thin is *already* why everything reads inconclusive.
So a k > 1 round is **seeded, not enumerated**: the candidates are built from the best single cuts
the previous round measured, plus a stated number of pairings, and the panel says **how many of the
possible k-subsets were tried**, e.g. *"48 of 595 two-card cuts tried"* — a denominator with its
source, never a bare count.

The mana-aware prior already in trim (a land cut is due once the drift reaches one whole land) applies
to the k-subset, not to each card in it.

### Acceptance

1. k = 1 reproduces today's behaviour exactly — same candidates, same order, on a fixed seed.
2. k = 2 on a rigged deck containing two cards that are only bad TOGETHER finds that pair, where
   k = 1 finds neither. **This is the whole point of the feature and it is the test that proves it
   is not decoration.**
3. The panel prints tried-of-possible with the denominator's source, and the number is right for a
   known deck (compute the binomial in the test).
4. Deck size arithmetic stays correct: a k-card cut moves the size by k, and the land-ratio prior
   reads the post-cut ratio.
5. Budget: a k = 2 round on the default budget does not spend more games than a k = 1 round of the
   same roster size — assert the games spent, do not assume it.

Red first for each: return the k = 1 candidate set for k = 2 and watch 2 fail; print the count
without the denominator and watch 3 fail.

---

---

## Item 4 — the Lab's progress bar is pinned to the bottom while a lab is working

Recorded verbatim, like the other three:

> TODO:
> -in all the Lab subtabs, make the loading bar get pinned to the bottom of the screen
> while in that area while its working on a lab, so you can scroll around and still watch
> the progress.

### What was measured

**The Lab already has ONE progress bar, owned by the shell.** `RunStatus`
(`apps/web/src/components/RunStatus.tsx`, 45 lines) is rendered once, by
`LabView.tsx:243`, as `{sim.status === 'running' && <RunStatus progress={sim.progress}
onCancel={sim.cancel} />}`. It is **not** per-panel and there is nothing to consolidate:
grepping `sim.progress` across `apps/web/src` returns exactly two call sites, `LabView.tsx:243`
and `MatchView.tsx:170`. **No Lab panel reads progress at all** — each reads only
`sim.status === 'running'` into a local `running` boolean to disable its own buttons.

So the shape the brief called for — one bar the shell owns, that every subtab feeds — **already
exists**. The work is not to build it. The work is that it sits in normal document flow and
scrolls away.

**One progress shape, already universal.** `SimProgress`
(`apps/web/src/lib/sim-protocol.ts:250`) carries `done` / `total` / `gamesRun` /
`elapsedSeconds` / `label`, flows through one `ProgressSink` (`lib/sim/run.ts:128`) into one
React state slot in one hook (`useSimWorker`). Every run kind builds its own `ProgressTally` and
passes a label. There is no second progress vocabulary in the Lab.

⚠️ **What `SimProgress` cannot express, and why two panels grew their own text.** It has no
`phase` and no `round`, and `useSimWorker` resets it to `null` at the start of every run
(`useSimWorker.ts:84`). A trim session and a joint search are each MANY runs, so neither can be
described by it — which is why `TrimPanel` has `StatusLine` (L408–440, "round in progress…",
"N rounds") and `JointPanel` has the `joint-spend` line (L338–353, games/seconds/phases against
their budgets). Those are SESSION readouts, not job readouts, and they render whether or not a
run is in flight. Pinning the job bar does not replace them, and this item should not try to.

**The tab registry exists but is private.** `LAB_TABS` is a real `as const` table at
`LabView.tsx:45` with six rows — but it is `const`, not `export const`, so no test can enumerate
it today. A parallel hand-written `LabTabId` union at `useLabSelection.ts:20` duplicates the same
six ids with **nothing pinning the two together**. Exporting `LAB_TABS` is a precondition of the
brief's "do not hand-list the tabs".

⚠️ **The bottom of the viewport is already contested**, all three mounted in the app shell
(`App.tsx:223–225`) and therefore live on the Lab screen:

| element | file | position | z-index |
|---|---|---|---|
| `.bugreport-launcher` | `components/bug-reporter.css:15` | `fixed; right 12px; bottom 12px` | 900 |
| `.bugreport-lastlink` | `components/bug-reporter.css:49` | `fixed; right 64px; bottom 18px` | 900 |
| `.update-pill` | `components/update-pill.css:14` | `fixed; bottom 12px; centred` | 70 |

and `lib/bugreport/capture-policy.ts:86` documents a dependency on the launcher being the last
bottom-fixed node, with a test at `capture-policy.test.ts:197`. A full-width bar at `bottom: 0`
collides with all three; the dock must choose a z-index between the pill and the launcher, and
must not break that capture policy.

⚠️ **THE VERIFICATION CONSTRAINT, and it is the binding one.** *There is no DOM in this suite.*
Root `vitest.config.ts` sets only `resolve.alias` and `test.include` — **no `environment`, so
tests run in `node`**; there is no setup file anywhere; and jsdom, happy-dom and
`@testing-library` are **not dependencies** (confirmed against both `package.json`s — the only
hits are comments saying so). The idiom is `renderToStaticMarkup` → assert on the HTML **string**
(35 files). `getComputedStyle` and `getBoundingClientRect` do not exist, and **CSS files are
never loaded** — `import './x.css'` returns an empty module.

So the brief's acceptance 1 — *"assert the rendered position, not merely that the element
exists"* — **cannot be met by a unit test**, and saying otherwise would be exactly the
can't-fail check this project has paid for most. It splits three ways, and the split is the
honest form of the requirement:

- **markup + ARIA** via the static render;
- **the `position: fixed; bottom: 0` DECLARATION** via the stylesheet-as-text idiom
  (`styles-regressions.test.ts:28–62`, which strips comments so a declaration named in prose
  cannot satisfy an assertion);
- **real pixel placement** via an out-of-band Puppeteer script under `apps/web/scripts/`
  (`puppeteer-core` is already a root devDependency and four such `verify-*.mjs` scripts
  already exist). This is the only check that can actually see a viewport.

### The shape

`RunStatus` stays exactly where it is and keeps its single owner. It gains a **dock**: the shell
wraps it in a fixed, full-width element at the bottom of the viewport, and gives `.lab` a bottom
padding of the dock's height while a job is running so the last row of content is still
reachable. A subtab that has nothing to report renders nothing at all — **the dock is absent, not
an empty bar** — which falls out of the existing `sim.status === 'running'` guard rather than
being a new state to maintain.

`LAB_TABS` is exported so the guard can enumerate it, and `LabTabId` is derived FROM it rather
than hand-written beside it, so the two lists cannot drift.

### Acceptance

1. The dock declares `position: fixed` and `bottom: 0` in the stylesheet, asserted against the
   parsed CSS text, with the Puppeteer script asserting its real on-screen rectangle after
   scrolling the panel to the bottom AND to the top.
2. It is present for EVERY row of `LAB_TABS` while that tab is working — a test that iterates the
   exported registry, never a hand-written list, so a seventh subtab cannot ship without it.
3. It is absent when no job is running, and `.lab` carries bottom padding while it is visible so
   the last row of content stays reachable.
4. It does not break the bug reporter's capture policy, and sits below the launcher and above the
   update pill in the stacking order — asserted on the z-index values, which are all named.
5. Screenshot, scrolled down, with a job actually running.

Red first: unpin the positioning and watch 1 fail; remove the shell's render and watch 2 fail on
every row; drop the padding and watch 3 fail.

### Ordering

**After items 3 and 2 are green**, as its own commit. It touches `LabView.tsx` and the Lab's
stylesheet — a wide, contended surface — and folding it into the verdict work would mean a
failure in either could not be attributed to one of them.

## Ordering, and why

**Items 3 and 2 ship together, first, as one PR.** They are the same defect — a result that reports
something other than what happened — at two layers of the same file, and fixing either alone leaves
Caleb's session behaving the same way: fix the ladder without fixing the verdict and it deepens
forever against rows it still cannot read; fix the verdict without fixing the ladder and it still
stops after two rounds. They also share `TrimStopReason`, the panel's wording table and the
games-to-settle estimate, so splitting them would mean writing those twice.

**Item 1 stacks on that**, and is the larger build. Its acceptance check 2 (a pair that is only bad
together) is only measurable once verdicts resolve, so it genuinely depends on the first PR rather
than merely following it.

None of the three touches `packages/core`, the pool, or the Play board.

## What was NOT done, said plainly

Caleb's item 2 names "trim, manabase, **and search**". The verdict funnel `decideVerdict` is shared
by all of them, so the reason and the tunable reach all three in one change. The **budget spread**
diagnosis above was measured on the joint search's numbers only; whether Suggest and the manabase
sweep are thin for the same reason is **NOT CHECKED**, and the lane should measure it rather than
assume the joint run generalises.
